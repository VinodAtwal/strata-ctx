import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ArtifactRef, NonGovernanceBlock, NonGovernanceMessage } from '@strata-ctx/core-types';
import { partitionForLossy, sha256 } from '@strata-ctx/core-types';

import {
  ARTIFACT_SCHEME,
  POINTER_MARKER,
  applyTruncate,
  artifactUriFor,
  capForTier,
  isFileRead,
  isPointerized,
  pointerStub,
  pointerizeBlocks,
} from '../src/index.js';

import { TIER_CAPS, lines, message, policy, state, toolResult, unsubjected } from './fixtures.js';

const run = (
  messages: readonly NonGovernanceMessage[],
  artifacts: readonly ArtifactRef[] = [],
  caps: Readonly<Record<string, number>> = TIER_CAPS,
) => pointerizeBlocks(messages, artifacts, { capFor: (b: NonGovernanceBlock) => capForTier(caps, b.meta.tier) });

describe('B-3 pointerize: eligibility', () => {
  it('pointer-izes a file read over the cap', () => {
    const original = lines(400);
    const read = toolResult({ ref: 'a.ts', kind: 'file', text: original });
    const { messages, report } = run([message('user', [read])]);

    const out = messages[0]?.content[0];
    assert.ok(out);
    assert.ok(isPointerized(out));
    assert.ok((out.text ?? '').startsWith(POINTER_MARKER));
    assert.equal(report.pointerized, 1);
    assert.equal(report.charsFreed, original.length - (out.text ?? '').length);
  });

  it('leaves a file read under the cap alone', () => {
    const { messages, report } = run([message('user', [toolResult({ ref: 'a.ts', kind: 'file', text: 'short' })])]);
    assert.equal(report.pointerized, 0);
    assert.equal(messages[0]?.content[0]?.text, 'short');
  });

  it('leaves command output alone even when it is enormous', () => {
    // A pointer to a command's output is not re-injectable: there is no artifact
    // store for a shell pipeline. The cap handles it instead.
    const { report } = run([message('user', [toolResult({ ref: 'npm test', text: lines(2000) })])]);
    assert.equal(report.pointerized, 0);
  });

  it('never touches a block with no subject', () => {
    const { report } = run([message('user', [unsubjected(lines(400))])]);
    assert.equal(report.pointerized, 0);
  });

  it('never touches a producer-declared error, however large', () => {
    const { messages, report } = run([
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', text: lines(2000), severity: 'error' })]),
    ]);
    assert.equal(report.pointerized, 0);
    assert.equal(report.skippedSeverity, 1);
    assert.equal((messages[0]?.content[0]?.text ?? '').length, lines(2000).length);
  });

  it('is idempotent: a pointer is not pointer-ized again', () => {
    const { messages } = run([message('user', [toolResult({ ref: 'a.ts', kind: 'file', text: lines(400) })])]);
    const second = run(messages, [], TIER_CAPS);
    assert.equal(second.report.skippedAlreadyPointer, 1);
    assert.equal(second.report.pointerized, 0);
    assert.deepEqual(second.messages, messages);
  });

  it('respects a tier with no configured cap', () => {
    const { report } = run(
      [message('user', [toolResult({ ref: 'a.ts', kind: 'file', text: lines(400) })])],
      [],
      {},
    );
    assert.equal(report.pointerized, 0);
    assert.equal(report.skippedNoCap, 1);
  });
});

describe('B-3 pointerize: the stub', () => {
  it('retains enough metadata to re-inject the file', () => {
    const read = toolResult({ ref: 'src/a.ts', kind: 'file', version: 'v3', text: lines(400) });
    const { messages } = run([message('user', [read])]);
    const stub = messages[0]?.content[0];

    assert.ok(stub);
    const text = stub.text ?? '';
    assert.ok(text.includes('path: src/a.ts'), 'the path is in the stub, not only in meta');
    // The artifact digest, not `meta.sha256`. Those are different hashes -- see
    // `artifactDigest` -- and only the artifact one names an object the store
    // can actually hold, so it is the one recovery has to be able to check.
    const digest = sha256(lines(400));
    assert.ok(text.includes(`uri: ${ARTIFACT_SCHEME}file/${digest}`));
    assert.ok(text.includes(`sha256: ${digest}`));
    assert.ok(text.includes(`chars: ${lines(400).length}`));
    assert.ok(text.includes('lines: 400'));
  });

  it('keeps the original content hash and the subject, and demotes the tier', () => {
    const read = toolResult({ ref: 'a.ts', kind: 'file', version: 'v3', text: lines(400) });
    const { messages } = run([message('user', [read])]);
    const stub = messages[0]?.content[0];

    assert.equal(stub?.meta.sha256, read.meta.sha256, 'the hash identifies the file, not the stub');
    assert.notEqual(
      read.meta.sha256,
      sha256(lines(400)),
      'and it is deliberately not the artifact digest: meta.sha256 hashes the block, the URI hashes the text',
    );
    assert.deepEqual(stub?.meta.subject, read.meta.subject);
    assert.equal(stub?.meta.tier, 'artifact_ref');
    assert.equal(stub?.type, read.type);
    assert.equal(stub?.toolName, read.toolName);
    assert.equal(stub?.id, read.id);
  });

  it('accounts bytes as the stub, and records the original size in the artifact', () => {
    const original = lines(400);
    const read = toolResult({ ref: 'a.ts', kind: 'file', text: original });
    const { messages, report } = run([message('user', [read])]);
    const stub = messages[0]?.content[0];

    assert.equal(stub?.meta.bytes, (stub?.text ?? '').length);
    assert.equal(report.artifactsAdded, 1);
    assert.equal(report.pointers[0]?.originalChars, original.length);
    assert.equal(report.pointers[0]?.originalLines, 400);
  });

  it('appends exactly one artifact per distinct content hash', () => {
    const body = lines(400);
    const { artifacts, report } = run(
      [
        message('user', [toolResult({ ref: 'a.ts', kind: 'file', text: body })]),
        message('user', [toolResult({ ref: 'a.ts', kind: 'file', text: body })]),
        message('user', [toolResult({ ref: 'b.ts', kind: 'file', text: `${body} b` })]),
      ],
      [],
    );

    assert.equal(report.artifactsAdded, 2, 'two distinct files, one artifact each');
    assert.equal(artifacts.length, 2);
  });

  it('does not mutate the input artifacts array', () => {
    const existing = [
      {
        uri: artifactUriFor('deadbeef'),
        sha256: 'deadbeef',
        bytes: 10,
        kind: 'file_snapshot' as const,
      },
    ];
    const snapshot = structuredClone(existing);
    run([message('user', [toolResult({ ref: 'a.ts', kind: 'file', text: lines(400) })])], existing);
    assert.deepEqual(existing, snapshot);
  });
});

describe('B-3 pointerize: helpers', () => {
  it('recognises only file reads as subjects', () => {
    assert.ok(isFileRead({ kind: 'file', ref: 'a.ts' }));
    assert.ok(!isFileRead({ kind: 'command', ref: 'a.ts' }));
    assert.ok(!isFileRead(undefined));
  });

  it('derives a stable uri from a hash', () => {
    assert.equal(artifactUriFor('abc123'), 'artifact://file/abc123');
    assert.equal(artifactUriFor('abc123'), artifactUriFor('abc123'));
  });

  it('builds a stub that the classifier reads as bookkeeping, not evidence', () => {
    const stub = pointerStub(toolResult({ ref: 'a.ts', kind: 'file', text: lines(10) }), artifactUriFor('abc'), 'abc');
    assert.ok(stub.startsWith(POINTER_MARKER));
  });
});

describe('B-3 in the stage: pointer-ize wins over head/tail', () => {
  it('replaces an oversized file read with a pointer instead of capping it', () => {
    // A pointer to the whole file is strictly more information than a head and a
    // tail of it, and it is the only route by which the bytes come back.
    const { ctx, report } = applyTruncate(
      partitionForLossy(
        state({ messages: [message('user', [toolResult({ ref: 'a.ts', kind: 'file', text: lines(800) })])] }),
        policy(),
      ),
    );

    assert.equal(report.pointerize.pointerized, 1);
    assert.equal(report.truncatedBlocks, 0, 'nothing left for the cap to do');
    assert.equal(ctx.messages[0]?.content[0]?.meta.tier, 'artifact_ref');
    assert.equal(ctx.artifacts.length, 1);
  });
});
