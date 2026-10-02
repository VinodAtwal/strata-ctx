import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ArtifactRef, NonGovernanceBlock, NonGovernanceMessage } from '@strata-ctx/core-types';
import { sha256 } from '@strata-ctx/core-types';

import type { CompressResult, OutputCompressPolicy, ReferencePolicy } from '../src/index.js';
import {
  DEFAULT_POLICY,
  REFERENCE_MARKER,
  applyOutputCompression,
  isReferenced,
  referenceOversized,
  referenceUriFor,
} from '../src/index.js';

/**
 * H-6, `referenceOversized`.
 *
 * The operator rewrites an oversized block into a stub plus an `ArtifactRef`, so
 * every test here is really asking one question in a different costume: does the
 * URI it publishes name an object the artifact store could actually hold? Two
 * ways to get that wrong were live in this file before, and both produced a stub
 * that looked perfectly well formed:
 *
 *   1. minting the URI from `meta.sha256`, which hashes the *block* -- the
 *      Anthropic adapter hashes `JSON.stringify(block)`, so it covers the tool
 *      name and the result envelope, none of which are in `text`. `ArtifactStore
 *      .put` digests the *text*. The two can never coincide.
 *   2. removing the bytes and returning no handle on them, so the only copy of
 *      the content is in a variable the caller never receives.
 *
 * The second is why `durable` exists and why it defaults to `false` here and
 * `true` in B-3: the gateway hands Tier 0 a store, this package has no caller
 * and no store, so the safe answer to "is there somewhere to put these bytes" is
 * no.
 */

/** 400 lines, the size class the fixtures elsewhere in this package use. */
const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');

const message = (content: readonly NonGovernanceBlock[]): NonGovernanceMessage => ({
  role: 'user',
  content,
  ts: 0,
});

/**
 * A `tool_state` block with no subject: eligible for H-6, and the shape the
 * operator was written for -- an oversized model response rather than a file read.
 * `meta.sha256` is seeded independently of the text so the two digests differ,
 * which is the property the identity tests turn on.
 */
const oversized = (text: string, over: Partial<NonGovernanceBlock['meta']> = {}): NonGovernanceBlock => ({
  type: 'text',
  text,
  meta: {
    origin: 'tool',
    sha256: sha256(`block-envelope-${text.length}`),
    tier: 'tool_state',
    bytes: text.length,
    cacheable: false,
    ...over,
  },
});

const on = (over: Partial<ReferencePolicy> = {}): ReferencePolicy => ({
  enabled: true,
  maxInlineBytes: 100,
  // Every test that reaches the rewrite path says so out loud; the one that
  // checks the default deliberately omits it.
  durable: true,
  ...over,
});

const run = (
  messages: readonly NonGovernanceMessage[],
  artifacts: readonly ArtifactRef[] = [],
  policy: ReferencePolicy = on(),
) => referenceOversized(messages, artifacts, policy);

const textOf = (result: { messages: readonly NonGovernanceMessage[] }): string =>
  result.messages[0]?.content[0]?.text ?? '';

/** The stub is what a reader recovers from, so the digest is read off the text. */
const stubDigest = (stub: string): string => /sha256: ([0-9a-f]{64})/.exec(stub)?.[1] ?? '';

describe('H-6 reference: the uri names an object the store can hold', () => {
  it('mints the uri from the digest of the text, not of the block', () => {
    const original = lines(400);
    const block = oversized(original);
    const stub = textOf(run([message([block])]));

    assert.equal(stub.startsWith(REFERENCE_MARKER), true);
    assert.ok(
      stub.includes(`uri: ${referenceUriFor(sha256(original))}`),
      'the uri is built from sha256(text), which is what ArtifactStore.put digests',
    );
    assert.notEqual(
      block.meta.sha256,
      sha256(original),
      'the two digests disagree for every block an adapter builds, which is the whole point',
    );
    assert.equal(stub.includes(`uri: ${referenceUriFor(block.meta.sha256)}`), false);
  });

  it('stamps the artifact digest in the stub and leaves meta.sha256 as the dedupe key', () => {
    const original = lines(400);
    const block = oversized(original);
    const { messages, artifacts } = run([message([block])]);
    const stub = messages[0]?.content[0];

    assert.equal(stubDigest(stub?.text ?? ''), sha256(original));
    assert.equal(
      stub?.meta.sha256,
      block.meta.sha256,
      'the hash identifies the content the block represents, so dedupe and staleness keys survive',
    );
    assert.equal(artifacts[0]?.sha256, sha256(original));
    assert.equal(artifacts[0]?.bytes, original.length);
    assert.equal(artifacts[0]?.kind, 'other');
  });

  it('produces the exact uri ArtifactStore.put(text, "other") files', () => {
    // Spelled out rather than imported: this package depends on core-types only
    // (6.3, no new dependencies), so `KIND_BUCKET.other` and `uriFor` are
    // restated here as the literal contract they are
    // (security/src/store.ts:145,160-161) instead of being called across a
    // stream boundary the fixtures rule (P2) keeps closed.
    //
    // What makes this resolvable: `other` is in `ARTIFACT_BUCKETS`
    // (security/src/acl.ts:66) and the segment is 64 lowercase hex, the only
    // content-addressed form `parseArtifactUri` accepts (acl.ts:238-239).
    const original = lines(400);
    const { artifacts } = run([message([oversized(original)])]);
    const uri = artifacts[0]?.uri ?? '';

    assert.equal(uri, `artifact://other/${sha256(original)}`);
    assert.equal(uri, referenceUriFor(sha256(original)), 'the helper and the operator agree');
    assert.deepEqual(
      uri.split('/').slice(0, 3),
      ['artifact:', '', 'other'],
      'a bucket outside ARTIFACT_BUCKETS would be an unknown_bucket rejection',
    );
    assert.match(uri.split('/')[3] ?? '', /^[0-9a-f]{64}$/);
  });

  it('appends one artifact per distinct text, and identical text is one object', () => {
    const body = lines(400);
    const { artifacts, report } = run([
      message([oversized(body)]),
      message([oversized(body)]),
      message([oversized(`${body} b`)]),
    ]);

    assert.equal(report.artifactsAdded, 2, 'two distinct payloads, one object each');
    assert.equal(artifacts.length, 2);
  });

  it('does not mutate the input artifacts array', () => {
    const existing = [referenceUriFor('deadbeef'), 'artifact://log/deadbeef'].map((uri) => ({
      uri,
      sha256: 'deadbeef',
      bytes: 10,
      kind: 'other' as const,
    }));
    const snapshot = structuredClone(existing);
    run([message([oversized(lines(400))])], existing);
    assert.deepEqual(existing, snapshot);
  });
});

describe('H-6 reference: no writer, no reference', () => {
  it('leaves the block inline when there is no durable writer', () => {
    const original = lines(400);
    const { messages, artifacts, pending, report } = run([message([oversized(original)])], [], on({ durable: false }));

    assert.equal(report.referenced, 0);
    assert.equal(report.skippedNoWriter, 1);
    assert.equal(report.artifactsAdded, 0);
    assert.deepEqual(artifacts, [], 'a ref with no object behind it is worse than no ref');
    assert.equal(messages[0]?.content[0]?.text, original);
    assert.equal(messages[0]?.content[0]?.meta.tier, 'tool_state', 'and the tier is not demoted either');
    assert.deepEqual(pending, []);
  });

  it('defaults to no writer, unlike B-3, because this package has no store', () => {
    const original = lines(400);
    const { messages, artifacts, report } = referenceOversized([message([oversized(original)])], [], {
      enabled: true,
      maxInlineBytes: 100,
    });

    assert.equal(report.referenced, 0, 'the safe answer when the caller never says it can store');
    assert.equal(report.skippedNoWriter, 1);
    assert.deepEqual(artifacts, []);
    assert.equal(messages[0]?.content[0]?.text, original);
  });

  it('counts every writer-less block, and not the under-cap ones', () => {
    const { report } = run(
      [message([oversized(lines(400)), oversized(lines(400)), oversized('tiny')])],
      [],
      on({ durable: false }),
    );
    assert.equal(report.skippedNoWriter, 2);
    assert.equal(report.skippedUnderCap, 1, 'the cap is checked first, so a small block is never a writer problem');
  });
});

describe('H-6 reference: pending carries the bytes it removed', () => {
  it('hands back the exact removed text', () => {
    const original = lines(400);
    const { messages, pending } = run([message([oversized(original)])]);
    const stub = messages[0]?.content[0];

    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.text, original, 'verbatim, or recovery is a promise nobody kept');
    assert.equal(pending[0]?.uri, referenceUriFor(sha256(original)));
    assert.equal(pending[0]?.sha256, sha256(original));
    assert.equal(pending[0]?.kind, 'other');
    assert.equal(pending[0]?.tier, 'tool_state', 'needed to put the block back if the write is refused');
    assert.ok((stub?.text ?? '').includes(`uri: ${pending[0]?.uri}`));
  });

  it('hands back one entry per distinct object, not per rewritten block', () => {
    const body = lines(400);
    const { pending, report } = run([
      message([oversized(body)]),
      message([oversized(body)]),
      message([oversized(`${body} b`)]),
    ]);

    assert.equal(report.referenced, 3, 'three blocks were rewritten');
    assert.equal(pending.length, 2, 'but the store is content-addressed, so two identical blocks are one write');
    assert.deepEqual(
      pending.map((p) => p.text),
      [body, `${body} b`],
    );
  });

  it('does not re-hand-back an object the caller already holds', () => {
    const body = lines(400);
    const already: ArtifactRef[] = [
      { uri: referenceUriFor(sha256(body)), sha256: sha256(body), bytes: body.length, kind: 'other' },
    ];
    const { artifacts, pending, report } = run([message([oversized(body)])], already);

    assert.equal(report.referenced, 1);
    assert.equal(report.artifactsAdded, 0);
    assert.equal(artifacts.length, 1, 'and the existing ref is not duplicated');
    assert.deepEqual(pending, [], 'the caller already has this object; a second put is not owed');
  });
});

describe('H-6 reference: the guards that are not about the writer', () => {
  it('does nothing when the stage is off', () => {
    const original = lines(400);
    const { messages, report } = run([message([oversized(original)])], [], on({ enabled: false }));

    assert.equal(report.referenced, 0);
    assert.equal(report.skippedDisabled, 1);
    assert.equal(messages[0]?.content[0]?.text, original);
  });

  it('leaves a block under the cap alone', () => {
    const { report } = run([message([oversized('short')])]);
    assert.equal(report.referenced, 0);
    assert.equal(report.skippedUnderCap, 1);
  });

  it('never compacts a block with no subject and no tool_state tier', () => {
    const { report } = run([message([oversized(lines(400), { tier: 'episodic' })])]);
    assert.equal(report.referenced, 0);
    assert.equal(report.skippedNotEligible, 1);
  });

  it('never touches a producer-declared error, however large', () => {
    const { messages, report } = run([message([oversized(lines(2000), { severity: 'error' })])]);
    assert.equal(report.referenced, 0);
    assert.equal(report.skippedHighSeverity, 1);
    assert.equal(messages[0]?.content[0]?.text, lines(2000));
  });

  it('is idempotent: a reference is not referenced again', () => {
    const first = run([message([oversized(lines(400))])]);
    const second = referenceOversized(first.messages, first.artifacts, on());

    assert.equal(second.report.skippedAlreadyReference, 1);
    assert.equal(second.report.referenced, 0);
    assert.deepEqual(second.messages, first.messages);
  });

  it('keeps the subject, the id and the demoted tier on the stub', () => {
    const block = oversized(lines(400), { subject: { kind: 'file', ref: 'src/a.ts' } });
    const stub = run([message([block])]).messages[0]?.content[0];
    assert.ok(stub !== undefined, 'the block was rewritten at all');

    assert.ok(isReferenced(stub));
    assert.deepEqual(stub.meta.subject, block.meta.subject);
    assert.equal(stub.meta.tier, 'artifact_ref');
    assert.equal(stub.meta.bytes, (stub.text ?? '').length);
    assert.ok((stub.text ?? '').includes('kind: file'));
    assert.ok((stub.text ?? '').includes(`bytes: ${lines(400).length}`));
    assert.ok((stub.text ?? '').includes('lines: 400'));
  });
});

/** The stage policy, with only H-6's switch moved off the defaults. */
const stagePolicy = (reference: Partial<OutputCompressPolicy['reference']>): OutputCompressPolicy => ({
  ...DEFAULT_POLICY,
  reference: { enabled: true, maxInlineBytes: 100, ...reference },
});

const compress = (
  blocks: readonly NonGovernanceBlock[],
  reference: Partial<OutputCompressPolicy['reference']>,
): CompressResult =>
  applyOutputCompression({ messages: [message(blocks)], artifacts: [], policy: stagePolicy(reference) });

describe('H-6 in the stage: the guard survives the boundary above it', () => {
  it('publishes no reference and no artifact through a stage that has no writer', () => {
    // The operator is not the only thing standing between a stub and a published
    // context: `applyOutputCompression` drops whatever `referenceOversized`
    // returns it. A `pending` that stopped here would make the fix cosmetic.
    const original = lines(400);
    const result = compress([oversized(original)], { durable: false });

    assert.equal(result.report.referenced, 0);
    assert.equal(result.report.reference.skippedNoWriter, 1);
    assert.deepEqual(result.artifacts, []);
    assert.deepEqual(result.pending, []);
    assert.equal(result.messages[0]?.content[0]?.text, original);
    assert.equal(result.report.changed, false);
  });

  it('defaults the stage to no writer, so enabling referencing cannot unresolvable URIs', () => {
    const original = lines(400);
    const result = compress([oversized(original)], {});

    assert.equal(result.report.referenced, 0);
    assert.equal(result.report.reference.skippedNoWriter, 1);
    assert.equal(result.messages[0]?.content[0]?.text, original);
  });

  it('surfaces pending for the caller that does have a store', () => {
    const original = lines(400);
    const result = compress([oversized(original)], { durable: true });

    assert.equal(result.report.referenced, 1);
    assert.equal(result.pending.length, 1);
    assert.equal(result.pending[0]?.text, original);
    assert.equal(result.pending[0]?.uri, result.artifacts[0]?.uri);
    assert.equal(result.pending[0]?.sha256, result.artifacts[0]?.sha256);
    assert.equal(result.messages[0]?.content[0]?.meta.tier, 'artifact_ref');
  });

  it('accounts a referenced block as referenced rather than compressing the stub', () => {
    // The stage matches rewritten blocks to the operator's report by the block
    // digest, which is not the artifact digest. Keying it on the wrong one would
    // silently drop the count to zero and let the stub fall through to the
    // serializer.
    const block = oversized(lines(400));
    const result = compress([block], { durable: true });

    assert.equal(result.report.reference.referenced, 1);
    assert.equal(result.report.reference.references[0]?.blockSha256, block.meta.sha256);
    assert.equal(result.report.reference.references[0]?.sha256, sha256(lines(400)));
    assert.deepEqual(
      result.report.decisions.map((d) => d.action),
      ['referenced'],
    );
    assert.equal(result.report.decisions[0]?.charsBefore, lines(400).length);
    assert.equal(result.report.decisions[0]?.charsAfter, (result.messages[0]?.content[0]?.text ?? '').length);
  });

  it('still compresses a block that was left inline for want of a writer', () => {
    // No writer means no reference, not no compression: this stage's actual job
    // is unchanged for the block.
    const result = compress([oversized('{"a":1,"b":2}')], { durable: false, maxInlineBytes: 0 });
    assert.equal(result.report.reference.skippedNoWriter, 1);
    assert.equal(result.report.referenced, 0);
    assert.equal(result.report.decisions[0]?.action !== 'referenced', true);
  });
});