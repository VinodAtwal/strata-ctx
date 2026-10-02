import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactRef, ContextState, Gist, StrataPolicy } from '@strata-ctx/core-types';
import { sha256 } from '@strata-ctx/core-types';
import type { GistEvent, StrataTelemetryEvent } from '@strata-ctx/telemetry';
import { runCompactionTransaction } from '../src/transaction.js';
import type { TransactionArtifactStore } from '../src/transaction.js';
import { isResolvableArtifactUri } from '../src/artifact-uri.js';
import { RAW_URI_UNSTORED } from '../src/draft.js';
import {
  createTestGist,
  createTestPolicy,
  createTestContextState,
  createMockArtifactStore,
  createSystemMessage,
  createUserMessage,
  createToolResultMessage,
  createTelemetryCapture,
  createGistMissingConstraint,
  createGistExtraConstraint,
  createGistReorderedConstraints,
  createGistMissingSha,
  createGistDroppedUnresolved,
  createGistMissingErrors,
  createGistArtifactMissing,
  TEST_TASK_ID,
} from './fixtures.js';

/**
 * Every error message emitted, joined.
 *
 * A refusal whose reason does not name the offending uri is not actionable:
 * the operator is left to guess which of N pointers went missing.
 */
function errorMessages(events: readonly StrataTelemetryEvent[]): string {
  return events.map((e) => (e.type === 'error' ? e.message : '')).join('\n');
}

describe('runCompactionTransaction', () => {
  let baseState: ContextState;
  let basePolicy: StrataPolicy;
  let baseGist: Gist;
  let mockStore: ReturnType<typeof createMockArtifactStore>;
  let telemetry: ReturnType<typeof createTelemetryCapture>;
  let rawTranscript: string;
  let toolLog: string;

  beforeEach(() => {
    baseState = createTestContextState();
    basePolicy = createTestPolicy();
    baseGist = createTestGist();
    mockStore = createMockArtifactStore();
    telemetry = createTelemetryCapture();
    rawTranscript = JSON.stringify(baseState.messages);
    toolLog = 'tool log content';
  });

  describe('validation passes', () => {
    it('returns new state with gist appended, transcript evicted, pins intact', async () => {
      // Pre-populate store with the artifact the gist references
      mockStore.addArtifact('artifact://file/abc123', 'artifact content', 'file_snapshot');

      const result = await runCompactionTransaction({
        state: baseState,
        gist: baseGist,
        policy: basePolicy,
        artifactStore: mockStore,
        emit: telemetry.emit,
        expectedErrorCount: 1,
        trigger: 'task_boundary',
        rawTranscript,
        toolLog,
      });

      assert.ok(result.ok, 'transaction should commit');
      assert.equal(result.gist?.task_id, TEST_TASK_ID);
      assert.ok(result.gist !== null);

      // New state should have the gist
      assert.equal(result.state.gists.length, 1);
      const firstGist = result.state.gists[0];
      assert.ok(firstGist !== undefined);
      assert.equal(firstGist.task_id, TEST_TASK_ID);

      // Turn counter incremented
      assert.equal(result.state.turn, baseState.turn + 1);

      // What survives eviction is exactly: one repinned governance message plus
      // the gist just committed. The transcript is gone, but only because the
      // raw artifact was proven to still hold it.
      assert.equal(result.state.messages.length, 2);
      const [survivor, gistMessage] = result.state.messages;
      assert.ok(survivor !== undefined && gistMessage !== undefined);
      assert.ok(
        survivor.content.every((block) => block.meta.tier === 'governance'),
        'the surviving message must be the repinned governance block',
      );
      assert.equal(
        survivor.content.length,
        2,
        'repin collapses governance into one message carrying both constraints',
      );

      // Pins should be intact (repinned)
      assert.deepEqual(result.state.pinned, ['Never delete user data', 'Always validate input']);

      // Telemetry: gist event then compaction event
      assert.equal(telemetry.events.length, 2);
      const event0 = telemetry.events[0];
      const event1 = telemetry.events[1];
      assert.ok(event0 !== undefined);
      assert.ok(event1 !== undefined);
      assert.equal(event0.type, 'gist');
      assert.equal(event1.type, 'compaction');

      const gistEvent: GistEvent = event0;
      assert.equal(gistEvent.schemaValid, true);
      assert.equal(gistEvent.constraintsIntact, true);
      assert.equal(gistEvent.rawRecoverable, true);
      assert.equal(gistEvent.compressionBy, 'self-gist');
      assert.deepEqual(gistEvent.failed, []);

      const compactionEvent = event1 as { validationPassed: boolean; beforeTokens: number; afterTokens: number; droppedCount: number };
      assert.equal(compactionEvent.validationPassed, true);
      assert.equal(compactionEvent.beforeTokens, baseState.tokenEstimate);
      assert.ok(compactionEvent.afterTokens < compactionEvent.beforeTokens);
      assert.equal(compactionEvent.droppedCount, 4); // user, assistant, tool_result, assistant
    });
  });

  describe('validation fails - constraint mismatch (4c)', () => {
    it('preserves original state, emits violation, telemetry shows validationPassed: false', async () => {
      const gistMissingConstraint = createGistMissingConstraint();
      mockStore.addArtifact('artifact://file/abc123', 'artifact content', 'file_snapshot');

      const result = await runCompactionTransaction({
        state: baseState,
        gist: gistMissingConstraint,
        policy: basePolicy,
        artifactStore: mockStore,
        emit: telemetry.emit,
        expectedErrorCount: 1,
        trigger: 'task_boundary',
        rawTranscript,
        toolLog,
      });

      assert.ok(!result.ok, 'transaction should abort');
      assert.equal(result.state, baseState, 'original state should be preserved');
      assert.equal(result.gist, null);
      assert.ok(result.defects.length > 0);
      assert.ok(result.defects.some((d) => d.step === '4c_constraint_bytes'));

      // Violation emitted for constraint mismatch
      const violations = telemetry.events.filter((e) => e.type === 'violation');
      assert.equal(violations.length, 1);
      const violation = violations[0];
      assert.ok(violation !== undefined);
      assert.equal(violation.kind, 'pin_post_compact_missing');
      assert.equal(violation.blocked, true);

      // Gist event with validation failure
      const gistEvents = telemetry.events.filter((e) => e.type === 'gist');
      assert.equal(gistEvents.length, 1);
      const gistEvent = gistEvents[0];
      assert.ok(gistEvent !== undefined);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gistEventTyped = gistEvent as any;
      assert.equal(gistEventTyped.constraintsIntact, false);
      assert.equal(gistEvent.constraintsIntact, false);
      assert.ok(gistEvent.failed.includes('4c_constraint_bytes'));

      // Compaction event with validationPassed: false
      const compactionEvents = telemetry.events.filter((e) => e.type === 'compaction');
      assert.equal(compactionEvents.length, 1);
      const compactionEvent = compactionEvents[0];
      assert.ok(compactionEvent !== undefined);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const compactionEventTyped = compactionEvent as any;
      assert.equal(compactionEventTyped.validationPassed, false);
      assert.equal(compactionEventTyped.afterTokens, baseState.tokenEstimate);
      assert.equal(compactionEvent.droppedCount, 0);
    });

    it('detects extra constraint in gist', async () => {
      const gistExtraConstraint = createGistExtraConstraint();
      mockStore.addArtifact('artifact://file/abc123', 'artifact content', 'file_snapshot');

      const result = await runCompactionTransaction({
        state: baseState,
        gist: gistExtraConstraint,
        policy: basePolicy,
        artifactStore: mockStore,
        emit: telemetry.emit,
        expectedErrorCount: 1,
        trigger: 'task_boundary',
        rawTranscript,
        toolLog,
      });

      assert.ok(!result.ok);
      assert.ok(result.defects.some((d) => d.step === '4c_constraint_bytes' && d.detail.includes('never declared')));
      assert.equal(result.gist, null);
    });

    it('detects reordered constraints', async () => {
      const gistReordered = createGistReorderedConstraints();
      mockStore.addArtifact('artifact://file/abc123', 'artifact content', 'file_snapshot');

      const result = await runCompactionTransaction({
        state: baseState,
        gist: gistReordered,
        policy: basePolicy,
        artifactStore: mockStore,
        emit: telemetry.emit,
        expectedErrorCount: 1,
        trigger: 'task_boundary',
        rawTranscript,
        toolLog,
      });

      assert.ok(!result.ok);
      assert.ok(result.defects.some((d) => d.step === '4c_constraint_bytes' && d.detail.includes('reordered')));
    });
  });

  describe('validation fails - missing sha (4a)', () => {
    it('aborts and preserves original state', async () => {
      const gistMissingSha = createGistMissingSha();
      mockStore.addArtifact('artifact://file/abc123', 'artifact content', 'file_snapshot');

      const result = await runCompactionTransaction({
        state: baseState,
        gist: gistMissingSha,
        policy: basePolicy,
        artifactStore: mockStore,
        emit: telemetry.emit,
        expectedErrorCount: 1,
        trigger: 'task_boundary',
        rawTranscript,
        toolLog,
      });

      assert.ok(!result.ok);
      assert.equal(result.state, baseState);
      assert.ok(result.defects.some((d) => d.step === '4a_digests' || d.step === '4b_invariants'));
    });
  });

  describe('unresolved threads must round-trip (4b)', () => {
    // A thread is only "dropped" relative to a source. These two tests pin both
    // sides of that distinction, because conflating them made every
    // default-path compaction abort (see transaction.ts 4b).
    it('aborts when the source had an open thread and the gist lost it', async () => {
      const priorGist = createTestGist({ unresolved: ['How to handle edge case X'] });
      const stateWithOpenThread = createTestContextState({ gists: [priorGist] });
      const gistDroppedUnresolved = createGistDroppedUnresolved();
      mockStore.addArtifact('artifact://file/abc123', 'artifact content', 'file_snapshot');

      const result = await runCompactionTransaction({
        state: stateWithOpenThread,
        gist: gistDroppedUnresolved,
        policy: basePolicy,
        artifactStore: mockStore,
        emit: telemetry.emit,
        expectedErrorCount: 1,
        trigger: 'task_boundary',
        rawTranscript: JSON.stringify(stateWithOpenThread.messages),
        toolLog,
      });

      assert.ok(!result.ok, 'a dropped open thread must abort the transaction');
      assert.equal(result.state, stateWithOpenThread);
      assert.ok(
        result.defects.some(
          (d) => d.step === '4b_invariants' && d.detail.includes('How to handle edge case X'),
        ),
        `expected the lost thread to be named in the defect, got: ${JSON.stringify(result.defects)}`,
      );
    });

    it('commits when the source had no open threads and none are invented', async () => {
      mockStore.addArtifact('artifact://file/abc123', 'artifact content', 'file_snapshot');

      const result = await runCompactionTransaction({
        state: baseState,
        gist: createGistDroppedUnresolved(),
        policy: basePolicy,
        artifactStore: mockStore,
        emit: telemetry.emit,
        expectedErrorCount: 1,
        trigger: 'task_boundary',
        rawTranscript,
        toolLog,
      });

      assert.ok(
        result.ok,
        `an empty unresolved[] means nothing was dropped when no prior gist recorded a thread; defects: ${JSON.stringify(result.defects)}`,
      );
      assert.ok(!result.defects.some((d) => d.step === '4b_invariants'));
    });
  });

  describe('validation fails - missing errors (4b)', () => {
    it('aborts when salient_errors count is less than expected', async () => {
      const gistMissingErrors = createGistMissingErrors();
      mockStore.addArtifact('artifact://file/abc123', 'artifact content', 'file_snapshot');

      const result = await runCompactionTransaction({
        state: baseState,
        gist: gistMissingErrors,
        policy: basePolicy,
        artifactStore: mockStore,
        emit: telemetry.emit,
        expectedErrorCount: 1, // Expect 1 error but gist has 0
        trigger: 'task_boundary',
        rawTranscript,
        toolLog,
      });

      assert.ok(!result.ok);
      assert.equal(result.state, baseState);
      assert.ok(result.defects.some((d) => d.step === '4b_invariants' && d.detail.includes('ERROR/FATAL')));
    });
  });

  describe('validation fails - artifact missing (4d)', () => {
    it('aborts when artifact does not resolve in store', async () => {
      const gistArtifactMissing = createGistArtifactMissing();
      // Don't add the artifact to the store

      const result = await runCompactionTransaction({
        state: baseState,
        gist: gistArtifactMissing,
        policy: basePolicy,
        artifactStore: mockStore,
        emit: telemetry.emit,
        expectedErrorCount: 1,
        trigger: 'task_boundary',
        rawTranscript,
        toolLog,
      });

      assert.ok(!result.ok);
      assert.equal(result.state, baseState);
      assert.ok(result.defects.some((d) => d.step === '4d_artifacts' && d.detail.includes('does not resolve')));
    });
  });

  describe('telemetry event order', () => {
    it('emits gist event before compaction event on success', async () => {
      mockStore.addArtifact('artifact://file/abc123', 'artifact content', 'file_snapshot');

      await runCompactionTransaction({
        state: baseState,
        gist: baseGist,
        policy: basePolicy,
        artifactStore: mockStore,
        emit: telemetry.emit,
        expectedErrorCount: 1,
        trigger: 'task_boundary',
        rawTranscript,
        toolLog,
      });

      assert.equal(telemetry.events.length, 2);
      const ev0 = telemetry.events[0];
      const ev1 = telemetry.events[1];
      assert.ok(ev0 !== undefined);
      assert.ok(ev1 !== undefined);
      assert.equal(ev0.type, 'gist');
      assert.equal(ev1.type, 'compaction');
    });

    it('emits gist event before compaction event on validation failure', async () => {
      const gistMissingConstraint = createGistMissingConstraint();
      mockStore.addArtifact('artifact://file/abc123', 'artifact content', 'file_snapshot');

      await runCompactionTransaction({
        state: baseState,
        gist: gistMissingConstraint,
        policy: basePolicy,
        artifactStore: mockStore,
        emit: telemetry.emit,
        expectedErrorCount: 1,
        trigger: 'task_boundary',
        rawTranscript,
        toolLog,
      });

      const eventTypes = telemetry.events.map((e) => e.type);
      assert.ok(eventTypes.indexOf('gist') < eventTypes.indexOf('compaction'), 'gist event should come before compaction event');
      assert.ok(eventTypes.includes('violation'), 'violation event should be emitted');
    });
  });

  describe('flush failure', () => {
    it('aborts and emits error event when artifact store write fails', async () => {
      // Create a mock store that fails on put
      const failingStore: TransactionArtifactStore = {
        async put() { await Promise.resolve(); throw new Error('disk full'); },
        async exists() { await Promise.resolve(); return true; },
        async read() { await Promise.resolve(); throw new Error('not implemented'); },
      };

      const result = await runCompactionTransaction({
        state: baseState,
        gist: baseGist,
        policy: basePolicy,
        artifactStore: failingStore,
        emit: telemetry.emit,
        expectedErrorCount: 1,
        trigger: 'task_boundary',
        rawTranscript,
        toolLog,
      });

      assert.ok(!result.ok);
      assert.equal(result.state, baseState);
      assert.ok(telemetry.events.some((e) => e.type === 'error' && e.code === 'FLUSH_FAILED'));
    });
  });

  describe('gist write failure', () => {
    it('aborts when gist write to artifact store fails', async () => {
      const failingStore: TransactionArtifactStore = {
        async put(content: string | Uint8Array, kind: ArtifactRef['kind']) {
          await Promise.resolve();
          if (kind === 'raw_transcript' && typeof content === 'string' && content.includes('gist')) {
            throw new Error('gist write failed');
          }
          const { sha256 } = await import('@strata-ctx/core-types');
          const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
          const digest = sha256(text);
          return { uri: `artifact://${kind}/${digest}`, sha256: digest, bytes: text.length, kind };
        },
        async exists() { await Promise.resolve(); return true; },
        async read() { await Promise.resolve(); throw new Error('not implemented'); },
      };

      const result = await runCompactionTransaction({
        state: baseState,
        gist: baseGist,
        policy: basePolicy,
        artifactStore: failingStore,
        emit: telemetry.emit,
        expectedErrorCount: 1,
        trigger: 'task_boundary',
        rawTranscript,
        toolLog,
      });

      assert.ok(!result.ok);
      assert.equal(result.state, baseState);
      assert.ok(telemetry.events.some((e) => e.type === 'error' && e.code === 'GIST_WRITE_FAILED'));
    });
  });

  describe('eviction is gated on the raw artifact (step 6)', () => {
    // Eviction is the only irreversible step. These tests pin the gate: the
    // transcript may only be discarded when the artifact can serve it back,
    // and otherwise the commit stands with the transcript intact.
    it('stamps the recoverability claim a builder without a store could not make', async () => {
      // `GistAssembler.assemble` has no artifact store, so it emits a draft
      // whose `raw_uri` is a marker and which makes no recovery claim at all.
      // This is that draft's only remaining path to a committed gist, and the
      // step-1 flush is what earns the claim: the bytes are on disk and the URI
      // names them.
      mockStore.addArtifact('artifact://file/abc123', 'artifact content', 'file_snapshot');
      const { raw_recoverable: _unstamped, ...draft } = baseGist;

      const result = await runCompactionTransaction({
        state: baseState,
        gist: { ...draft, log_gist: { ...draft.log_gist, raw_uri: RAW_URI_UNSTORED } },
        policy: basePolicy,
        artifactStore: mockStore,
        emit: telemetry.emit,
        expectedErrorCount: 1,
        trigger: 'task_boundary',
        rawTranscript,
        toolLog,
      });

      assert.ok(result.ok, `a draft must be completable by the store, not refused: ${JSON.stringify(result.defects)}`);
      assert.equal(
        result.gist?.raw_recoverable,
        true,
        'the claim comes from the transcript put, which is the only put that happened',
      );
      assert.notEqual(
        result.gist?.log_gist.raw_uri,
        RAW_URI_UNSTORED,
        'the placeholder must be replaced by the uri the store returned',
      );
      assert.ok(isResolvableArtifactUri(result.gist?.log_gist.raw_uri ?? ''));
      assert.equal(result.state.messages.length, 2, 'the transcript was provably recoverable, so it goes');
    });

    it('evicts when the raw artifact verifiably holds the dropped run', async () => {
      mockStore.addArtifact('artifact://file/abc123', 'artifact content', 'file_snapshot');

      const result = await runCompactionTransaction({
        state: baseState,
        gist: baseGist,
        policy: basePolicy,
        artifactStore: mockStore,
        emit: telemetry.emit,
        expectedErrorCount: 1,
        trigger: 'task_boundary',
        rawTranscript,
        toolLog,
      });

      assert.ok(result.ok);
      assert.equal(result.state.messages.length, 2, 'transcript dropped, governance and gist kept');
      const gistEvent = telemetry.events.find((e) => e.type === 'gist');
      assert.equal(gistEvent?.rawRecoverable, true);
      assert.deepEqual(gistEvent?.failed, []);
    });

    it('keeps the transcript and reports it when the raw artifact is absent', async () => {
      mockStore.addArtifact('artifact://file/abc123', 'artifact content', 'file_snapshot');

      // A store that has lost the transcript: writes succeed, but the artifact
      // is not there to be read back. This is what an evicted or rotated
      // retention window looks like from the transaction's side.
      const lossyStore = {
        put: mockStore.put.bind(mockStore),
        read: mockStore.read.bind(mockStore),
        // The gist's own file artifact resolves (4d passes); the raw
        // transcript does not, which is exactly the eviction precondition.
        exists: (uri: string) => Promise.resolve(uri === 'artifact://file/abc123'),
      };

      const result = await runCompactionTransaction({
        state: baseState,
        gist: baseGist,
        policy: basePolicy,
        artifactStore: lossyStore,
        emit: telemetry.emit,
        expectedErrorCount: 1,
        trigger: 'task_boundary',
        rawTranscript,
        toolLog,
      });

      assert.ok(result.ok, 'the commit itself is sound, only eviction is deferred');
      assert.ok(
        result.state.messages.length > 2,
        'transcript must be retained when it cannot be proven recoverable',
      );
      const gistEvent = telemetry.events.find((e) => e.type === 'gist');
      assert.equal(gistEvent?.rawRecoverable, false, 'rawRecoverable must not be claimed');
      assert.ok(
        gistEvent?.failed.some((f) => f.startsWith('eviction_skipped')),
        `expected the skip to be reported, got: ${JSON.stringify(gistEvent?.failed)}`,
      );
      assert.ok(
        telemetry.events.some(
          (e) => e.type === 'error' && e.code === 'EVICTION_SKIPPED_UNVERIFIED',
        ),
        'a deferred eviction must be visible in telemetry, not silent',
      );
    });

    it('keeps the transcript when the artifact does not contain the dropped messages', async () => {
      // The artifact exists but holds a different session: resolving it is not
      // enough, its contents have to match what would be discarded.
      const foreign = createTestContextState({
        messages: [createSystemMessage('an entirely different session')],
      });
      mockStore.addArtifact('artifact://file/abc123', 'artifact content', 'file_snapshot');

      const result = await runCompactionTransaction({
        state: baseState,
        gist: baseGist,
        policy: basePolicy,
        artifactStore: mockStore,
        emit: telemetry.emit,
        expectedErrorCount: 1,
        trigger: 'task_boundary',
        rawTranscript: JSON.stringify(foreign.messages),
        toolLog,
      });

      assert.ok(result.ok);
      assert.ok(result.state.messages.length > 2, 'unverifiable transcript must be kept');
      const gistEvent = telemetry.events.find((e) => e.type === 'gist');
      assert.equal(gistEvent?.rawRecoverable, false);
    });

    it('keeps the transcript when a pointer inside a dropped message is not in the store', async () => {
      // A pointerized file read is a message whose payload lives in a *second*
      // artifact. The transcript holds the stub faithfully and the stub says
      // "recoverable verbatim at the uri above", so verifying only the
      // transcript certifies the message as recoverable on the strength of an
      // artifact containing nothing but the pointer to the content. Nothing was
      // ever written under this URI, which is what makes it the regression.
      const fileContent = 'export const answer = 42;\n'.repeat(40);
      const pointerUri = `artifact://file/${sha256(fileContent)}`;
      const stub = [
        '[strata:pointer]',
        'path: src/answer.ts',
        `uri: ${pointerUri}`,
        `sha256: ${sha256(fileContent)}`,
        `chars: ${fileContent.length}`,
      ].join('\n');

      const stateWithPointer = createTestContextState({
        messages: [
          createSystemMessage('Never delete user data'),
          createSystemMessage('Always validate input'),
          createUserMessage('Please add a test function'),
          createToolResultMessage('read', stub, { kind: 'file', ref: 'src/answer.ts' }),
        ],
      });
      mockStore.addArtifact('artifact://file/abc123', 'artifact content', 'file_snapshot');
      // Deliberately *not* mockStore.addArtifact(pointerUri, fileContent, ...).

      const result = await runCompactionTransaction({
        state: stateWithPointer,
        gist: baseGist,
        policy: basePolicy,
        artifactStore: mockStore,
        emit: telemetry.emit,
        expectedErrorCount: 1,
        trigger: 'task_boundary',
        rawTranscript: JSON.stringify(stateWithPointer.messages),
        toolLog,
      });

      assert.ok(result.ok, 'the commit itself is sound, only eviction is deferred');
      assert.ok(
        result.state.messages.length > 2,
        'a dropped message whose payload cannot be re-read must not be discarded',
      );
      const gistEvent = telemetry.events.find((e) => e.type === 'gist');
      assert.equal(gistEvent?.rawRecoverable, false, 'rawRecoverable must not be claimed');
      assert.ok(
        telemetry.events.some(
          (e) => e.type === 'error' && e.code === 'EVICTION_SKIPPED_UNVERIFIED',
        ),
        'the refusal must be visible in telemetry',
      );
      assert.match(
        errorMessages(telemetry.events),
        new RegExp(pointerUri),
        'the refusal must name the unresolvable uri',
      );
    });

    it('evicts when every pointer inside the dropped messages resolves', async () => {
      // The positive half of the test above: the same shape, with the payload
      // actually written, must still compact. Otherwise the gate above is
      // satisfied by refusing everything.
      const fileContent = 'export const answer = 42;\n'.repeat(40);
      const pointerUri = `artifact://file/${sha256(fileContent)}`;
      const stub = [
        '[strata:pointer]',
        'path: src/answer.ts',
        `uri: ${pointerUri}`,
        `sha256: ${sha256(fileContent)}`,
        `chars: ${fileContent.length}`,
      ].join('\n');

      const stateWithPointer = createTestContextState({
        messages: [
          createSystemMessage('Never delete user data'),
          createSystemMessage('Always validate input'),
          createUserMessage('Please add a test function'),
          createToolResultMessage('read', stub, { kind: 'file', ref: 'src/answer.ts' }),
        ],
      });
      mockStore.addArtifact('artifact://file/abc123', 'artifact content', 'file_snapshot');
      mockStore.addArtifact(pointerUri, fileContent, 'file_snapshot');

      const result = await runCompactionTransaction({
        state: stateWithPointer,
        gist: baseGist,
        policy: basePolicy,
        artifactStore: mockStore,
        emit: telemetry.emit,
        expectedErrorCount: 1,
        trigger: 'task_boundary',
        rawTranscript: JSON.stringify(stateWithPointer.messages),
        toolLog,
      });

      assert.ok(result.ok);
      assert.equal(result.state.messages.length, 2, 'transcript dropped, governance and gist kept');
      const gistEvent = telemetry.events.find((e) => e.type === 'gist');
      assert.equal(gistEvent?.rawRecoverable, true);
      assert.deepEqual(gistEvent?.failed, []);
    });

    it('refuses eviction when the store mints a uri the ACL cannot resolve', async () => {
      // The deleted ./artifact-store.ts minted exactly this: a bare
      // `artifact://<digest>` with no bucket, which `parseArtifactUri` refuses
      // because it has no bucket to check the digest against. The old
      // `/^artifact:\/\//` accepted it and then asked a store that speaks
      // `artifact://file/<digest>` whether it existed.
      mockStore.addArtifact('artifact://file/abc123', 'artifact content', 'file_snapshot');
      const bareUriStore = {
        put: async (content: string | Uint8Array, kind: ArtifactRef['kind']) => {
          await Promise.resolve();
          const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
          return { uri: `artifact://${sha256(text)}`, sha256: sha256(text), bytes: text.length, kind };
        },
        read: mockStore.read.bind(mockStore),
        exists: () => Promise.resolve(true),
      };

      const result = await runCompactionTransaction({
        state: baseState,
        gist: baseGist,
        policy: basePolicy,
        artifactStore: bareUriStore,
        emit: telemetry.emit,
        expectedErrorCount: 1,
        trigger: 'task_boundary',
        rawTranscript,
        toolLog,
      });

      assert.ok(result.ok, 'the commit stands; only eviction is deferred');
      assert.ok(result.state.messages.length > 2, 'an unresolvable raw_uri must block eviction');
      const gistEvent = telemetry.events.find((e) => e.type === 'gist');
      assert.equal(gistEvent?.rawRecoverable, false);
      assert.match(
        errorMessages(telemetry.events),
        /content-addressed/,
        'the refusal must say why the uri is unusable',
      );
    });
  });
});
