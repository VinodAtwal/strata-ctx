import assert from 'node:assert/strict';
import { describe, it, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextState, Message } from '@strata-ctx/core-types';
import { sha256 } from '@strata-ctx/core-types';
import { ArtifactStore } from '@strata-ctx/security';
import { runCompactionTransaction } from '../src/transaction.js';
import { recoverEvictedMessages, recoverTurns } from '../src/reversibility.js';
import {
  createTestGist,
  createTestPolicy,
  createTestContextState,
  createToolResultMessage,
  FIXTURE_ARTIFACT_CONTENT,
} from './fixtures.js';

/**
 * The compensating control for eviction, proven rather than asserted.
 *
 * Eviction is the only irreversible step in the repo, and it is gated on the
 * transcript holding what it drops (`transaction.ts:144-229`). That gate
 * answers "are the bytes in the artifact". It does not answer "can a caller get
 * them back" -- and those were different claims, because the gate locates the
 * dropped run by content while `recoverTurns` returns a turn window
 * (`reversibility.ts:99`, window chosen at `assembly.ts:57-68`). A message
 * outside that window was deleted and unrecoverable through the only function
 * that claimed to undo eviction.
 *
 * So these tests hold the stronger property: whatever `runCompactionTransaction`
 * removes from the context is returned by `recoverEvictedMessages`, matched by
 * digest. "Returns something" is the failure mode this file exists to exclude.
 *
 * A real `ArtifactStore`, not the fixture mock: the mock answers `exists` with
 * a map lookup and never throws, which is the surface the URI defect this file
 * also covers lives on.
 */

const storeRoots: string[] = [];

after(async () => {
  await Promise.all(storeRoots.map((root) => rm(root, { recursive: true, force: true })));
});

const openStore = async (): Promise<ArtifactStore> => {
  const root = await mkdtemp(join(tmpdir(), 'strata-gist-evicted-'));
  storeRoots.push(root);
  return ArtifactStore.open({ root });
};

/** Identity of a message by content, which is what recovery is accountable for. */
const digestOf = (message: Message): string =>
  message.content.map((block) => block.meta.sha256).join(',');

const textOf = (message: Message): string =>
  message.content.map((block) => block.text ?? '').join(' ');

interface Evicted {
  readonly state: ContextState;
  readonly dropped: readonly Message[];
  readonly store: ArtifactStore;
}

/** Run the transaction to a committed eviction and report what it removed. */
const evict = async (state: ContextState): Promise<Evicted> => {
  const store = await openStore();
  await store.put(FIXTURE_ARTIFACT_CONTENT, 'file_snapshot');

  const result = await runCompactionTransaction({
    state,
    gist: createTestGist(),
    policy: createTestPolicy(),
    artifactStore: store,
    emit: () => {},
    expectedErrorCount: 1,
    trigger: 'task_boundary',
    rawTranscript: JSON.stringify(state.messages),
    toolLog: 'tool log content',
  });

  assert.ok(result.ok, `transaction aborted: ${JSON.stringify(result.defects)}`);
  assert.ok(result.gist !== null);

  // What is gone: absent from the committed context by content. Governance is
  // re-materialised by step 5 as one merged system message, so it has a
  // different digest afterwards while still being present -- comparing text
  // keeps repinned governance out of the "lost" set, which is where it belongs.
  const survivingText = result.state.messages.map(textOf).join('\n');
  const dropped = state.messages.filter((message) => !survivingText.includes(textOf(message)));

  assert.ok(dropped.length > 0, 'the fixture must actually lose something, or this file proves nothing');
  return { state: result.state, dropped, store };
};

describe('recovery covers everything eviction removes', () => {
  it('restores every dropped message, matched by digest', async () => {
    const { state, dropped, store } = await evict(createTestContextState());
    assert.ok(state.gists[0] !== undefined);
    const gist = state.gists[0];

    const recovered = await recoverEvictedMessages(gist, store);

    assert.equal(recovered.complete, true, `unresolved pointers: ${recovered.missingArtifacts.join(', ')}`);

    const recoveredDigests = new Set(recovered.messages.map(digestOf));
    const lost = dropped.filter((message) => !recoveredDigests.has(digestOf(message)));

    assert.deepEqual(
      lost.map(textOf),
      [],
      `evicted but not recoverable: ${lost.map((m) => `${m.role} "${textOf(m)}"`).join(' | ')}`,
    );
  });

  it('restores the trailing tool result that the turn window skips', async () => {
    // The shape a turn actually ends in, and the one the window at
    // assembly.ts:57-68 leaves out: `extractTurnRange` keeps only the first
    // through last user/assistant index, so a `tool` message after the final
    // assistant turn is inside the transcript and outside the window.
    const tail = createToolResultMessage('bash', 'exit 0: 3 tests passed', {
      kind: 'other',
      ref: 'shell',
    });
    const base = createTestContextState();
    const { state, dropped, store } = await evict({ ...base, messages: [...base.messages, tail] });
    assert.ok(state.gists[0] !== undefined);
    const gist = state.gists[0];

    // Pinned first: the tail really was deleted, or the rest of this proves
    // nothing about it.
    const survivingText = state.messages.map(textOf).join('\n');
    assert.equal(survivingText.includes('exit 0: 3 tests passed'), false, 'the tail should have been evicted');
    assert.ok(
      dropped.some((m) => textOf(m) === 'exit 0: 3 tests passed'),
      'the tail should be in the dropped set',
    );

    const recovered = await recoverEvictedMessages(gist, store);
    const restored = recovered.messages.find((m) => textOf(m) === 'exit 0: 3 tests passed');

    assert.ok(restored !== undefined, 'the trailing tool result must be recoverable');
    assert.equal(
      restored.content[0]?.meta.sha256,
      tail.content[0]?.meta.sha256,
      'the restored block must be the original bytes, not something that merely fills the slot',
    );

    // The discrimination pair, on one gist and one store: the window-addressed
    // instrument gives the opposite verdict from the identity-addressed one.
    // Without this, the test above could be satisfied by an implementation that
    // returns everything indiscriminately and never has to be right about which
    // messages were actually lost.
    const windowed = await recoverTurns(gist, store);
    assert.equal(
      windowed.messages.some((m) => textOf(m) === 'exit 0: 3 tests passed'),
      false,
      'recoverTurns is expected to miss the out-of-window tail; if this ever passes, the window was widened and the gap this file documents is gone',
    );
  });

  it('is a superset of recoverTurns for the same gist', async () => {
    // The two are reconcilable only if the newer one returns everything the
    // older one does. If this ever fails, `recoverTurns` has become the more
    // complete instrument and the recommendation in the report is wrong.
    const { state, store } = await evict(createTestContextState());
    assert.ok(state.gists[0] !== undefined);
    const gist = state.gists[0];

    const windowed = await recoverTurns(gist, store);
    const complete = await recoverEvictedMessages(gist, store);

    const completeTexts = new Set(complete.messages.map(textOf));
    const missing = windowed.messages.filter((message) => !completeTexts.has(textOf(message)));

    assert.deepEqual(missing.map(textOf), [], 'recoverEvictedMessages dropped something recoverTurns returned');
    // `>=`, not `>`: on this fixture the window happens to span every
    // non-governance message, so the two agree. The strictly-larger case needs
    // an out-of-window message and is demonstrated in the test above.
    assert.ok(
      complete.messages.length >= windowed.messages.length,
      `the non-governance set cannot be smaller than the window: ${complete.messages.length} vs ${windowed.messages.length}`,
    );
  });

  it('does not return governance as recovered, because eviction never removed it', async () => {
    const { state, store } = await evict(createTestContextState());
    assert.ok(state.gists[0] !== undefined);

    const recovered = await recoverEvictedMessages(state.gists[0], store);

    const governance = recovered.messages.filter((message) =>
      message.content.every((block) => block.meta.tier === 'governance'),
    );
    assert.deepEqual(
      governance.map(textOf),
      [],
      'governance is re-pinned by step 5, so reporting it as recovered describes something that was never lost',
    );
  });

  it('reports an unreadable transcript as incomplete rather than as an empty recovery', async () => {
    const { state } = await evict(createTestContextState());
    assert.ok(state.gists[0] !== undefined);
    const gist = state.gists[0];

    const empty = await ArtifactStore.open({ root: await mkdtemp(join(tmpdir(), 'strata-gist-void-')) });
    storeRoots.push(empty.root);
    const recovered = await recoverEvictedMessages(gist, empty);

    assert.deepEqual(recovered.messages, []);
    assert.equal(recovered.governanceIntact, false, 'an unread transcript was never consulted, so nothing is verified');
    assert.equal(recovered.complete, false, 'total loss must never read as a successful recovery');
    assert.deepEqual(recovered.missingArtifacts, [gist.log_gist.raw_uri]);
  });

  it('digests the restored bytes so a caller can verify rather than eyeball', async () => {
    const { state, dropped, store } = await evict(createTestContextState());
    assert.ok(state.gists[0] !== undefined);

    const recovered = await recoverEvictedMessages(state.gists[0], store);

    assert.equal(
      recovered.digests.length,
      recovered.messages.reduce((n, m) => n + m.content.length, 0),
      'one digest per block, in order',
    );
    const droppedDigests = dropped.flatMap((m) => m.content.map((b) => sha256(b.text ?? '')));
    assert.deepEqual(
      recovered.digests.slice().sort(),
      droppedDigests.slice().sort(),
      'every digest of every evicted block must appear among the recovered digests',
    );
  });
});