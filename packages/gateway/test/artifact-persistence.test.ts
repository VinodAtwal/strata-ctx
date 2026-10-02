import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  partitionForLossy,
  runId,
  sha256,
  StrataPolicySchema,
  type ContextState,
  type ContentBlock,
  type StrataPolicy,
} from '@strata-ctx/core-types';
import { runTier0 } from '@strata-ctx/pipeline';
import { ArtifactStore } from '@strata-ctx/security';

import { persistPending } from '../src/server.js';

/**
 * The invariant under test:
 *
 *   for every `artifact://` URI the pipeline publishes, the store holds the
 *   exact bytes the block used to carry, at that exact URI.
 *
 * Every test here runs against a real `ArtifactStore` on a real temp directory.
 * A stub store would pass against the bug these cover, because the bug is
 * precisely that the URI and the stored object were never the same thing.
 */

const policy: StrataPolicy = StrataPolicySchema.parse({ version: 1, governance: { pinning: 'off' } });

const roots: string[] = [];

const openStore = async (): Promise<ArtifactStore> => {
  const root = await mkdtemp(join(tmpdir(), 'strata-gw-artifact-'));
  roots.push(root);
  return ArtifactStore.open({ root });
};

after(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});

const TS = 1_700_000_000_000;

/** Over the default `tool_state` cap, so stage 2 wants a pointer. */
const OVER_CAP = 'const a = 1;\n'.repeat(4_000);

const fileRead = (text: string, over: { subjectKind?: 'file' | 'command' } = {}): ContentBlock => ({
  type: 'tool_result',
  text,
  toolName: 'Read',
  meta: {
    origin: 'tool',
    // Deliberately the digest of the whole block rather than of `text`, which is
    // what every adapter produces and what `meta.sha256` means.
    sha256: sha256(JSON.stringify({ type: 'tool_result', text })),
    subject: { kind: over.subjectKind ?? 'file', ref: 'src/estimator.ts' },
    tier: 'tool_state',
    bytes: text.length,
    cacheable: false,
  },
});

const stateWith = (block: ContentBlock): ContextState => ({
  messages: [
    {
      role: 'system',
      content: [{ type: 'text', text: 'CLAUDE.md', meta: { origin: 'system', sha256: sha256('CLAUDE.md'), tier: 'episodic', bytes: 9, cacheable: false } }],
      ts: TS,
    },
    { role: 'user', content: [block], ts: TS },
  ],
  pinned: [],
  tokenEstimate: 0,
  policyHash: sha256(''),
  runId: runId('run-1'),
  turn: 1,
  gists: [],
  artifacts: [],
});

test('a published pointer resolves to the bytes the block used to carry', async () => {
  const store = await openStore();
  const tier0 = runTier0(stateWith(fileRead(OVER_CAP)), policy, { durable: true });

  assert.equal(tier0.pending.length, 1, 'the pointerizer must hand its bytes to the caller');

  const outcome = await persistPending(store, tier0.pending);
  assert.deepEqual(outcome, { ok: true });

  const [pending] = tier0.pending;
  assert.ok(pending);

  const read = await store.read(pending.uri);
  assert.equal(read.text, OVER_CAP, 'the stored bytes are the block verbatim');

  // And the reference the gateway would publish is the one that resolves.
  const published = tier0.state.messages[1]?.content[0];
  assert.ok(published?.text?.includes(pending.uri), 'the stub names the uri that now exists');
});

test('the uri is the digest of the text, not of the block that carried it', async () => {
  const store = await openStore();
  const tier0 = runTier0(stateWith(fileRead(OVER_CAP)), policy, { durable: true });
  const [pending] = tier0.pending;
  assert.ok(pending);

  assert.equal(pending.sha256, sha256(OVER_CAP));
  assert.notEqual(
    pending.sha256,
    stateWith(fileRead(OVER_CAP)).messages[1]?.content[0]?.meta.sha256,
    'which is not the block hash, and must not be',
  );

  // The load-bearing consequence: the published URI is the one that resolves,
  // and it only resolves because the digest named the text rather than the block.
  assert.deepEqual(await persistPending(store, tier0.pending), { ok: true });
  assert.equal(await store.exists(pending.uri), true);
  assert.equal(await store.exists(`artifact://file/${sha256('something else')}`), false);
});

test('a pointer whose digest does not match its text is refused, not published', async () => {
  const store = await openStore();
  const tier0 = runTier0(stateWith(fileRead(OVER_CAP)), policy, { durable: true });
  const [honest] = tier0.pending;
  assert.ok(honest);

  // A producer that put the wrong digest on the block, which is exactly the
  // case that used to publish a well-formed URI naming an object nobody wrote.
  const outcome = await persistPending(store, [{ ...honest, uri: `artifact://file/${sha256('a-different-body')}` }]);
  assert.equal(outcome.ok, false, 'the mismatch must be a refusal');
  if (!outcome.ok) assert.match(outcome.reason, /does not name the object that was stored/);
});

test('a store that throws is reported, so the caller can fall back', async () => {
  const store = await openStore();
  const tier0 = runTier0(stateWith(fileRead(OVER_CAP)), policy, { durable: true });
  const closed = await openStore();
  const unreachable: ArtifactStore = Object.create(closed, {
    put: { value: () => Promise.reject(new Error('disk full')) },
  });

  const outcome = await persistPending(unreachable, tier0.pending);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.reason, /artifact write failed.*disk full/s);

  // The real store is untouched by the failed attempt's bookkeeping.
  const [pending] = tier0.pending;
  assert.ok(pending);
  assert.equal(await store.exists(pending.uri), false);
});

// ------------------------------------------------------------------ no writer

test('without a durable writer nothing is pointer-ized and nothing is lost silently', () => {
  const before = stateWith(fileRead(OVER_CAP));
  const tier0 = runTier0(before, policy, { durable: false });

  assert.deepEqual(tier0.pending, [], 'a caller with no store mints no references');
  assert.equal(tier0.reports.truncate?.pointerize.pointerized, 0);
  assert.equal(tier0.reports.truncate?.pointerize.skippedNoWriter, 1, 'and says so in the report');

  const block = tier0.state.messages[1]?.content[0];
  assert.ok(block?.text, 'the block still carries text');
  assert.ok(!block.text.includes('[strata:pointer]'), 'it is not a stub');
  assert.ok(
    block.text.length < OVER_CAP.length,
    'it went through the byte cap instead, which is lossy in a way telemetry can see',
  );
});

test('a non-file subject is not pointer-ized even with a writer', () => {
  const tier0 = runTier0(stateWith(fileRead(OVER_CAP, { subjectKind: 'command' })), policy, {
    durable: true,
  });
  assert.deepEqual(tier0.pending, []);
  // `skippedNoSubject` counts the subjectless system block, not this one, which is
  // the whole reason it is a separate counter from `skippedNoWriter`.
  assert.equal(tier0.reports.truncate?.pointerize.skippedNoSubject, 1);
  assert.equal(tier0.reports.truncate?.pointerize.skippedNoWriter, 0, 'so the writer was never consulted');
  assert.ok(
    !tier0.state.messages[1]?.content[0]?.text?.includes('[strata:pointer]'),
    'a command result is not a file snapshot, so it is never referenced as one',
  );
});

test('partitioning before the stage does not change what is handed back', async () => {
  const before = stateWith(fileRead(OVER_CAP));
  const partitioned = partitionForLossy(before, policy);
  assert.ok(partitioned.messages.length > 0);

  const tier0 = runTier0(before, policy, { durable: true });
  const store = await openStore();
  assert.deepEqual(await persistPending(store, tier0.pending), { ok: true });

  const [pending] = tier0.pending;
  assert.ok(pending);
  assert.equal((await store.read(pending.uri)).text, OVER_CAP);
});