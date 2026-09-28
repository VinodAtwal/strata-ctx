import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactRef, ContextState, Gist, StrataPolicy } from '@strata-ctx/core-types';
import type { GistEvent } from '@strata-ctx/telemetry';
import { runCompactionTransaction } from '../src/transaction.js';
import type { TransactionArtifactStore } from '../src/transaction.js';
import {
  createTestGist,
  createTestPolicy,
  createTestContextState,
  createMockArtifactStore,
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

      // Original transcript range [2, 5] evicted, but gist message added
      // Original had 6 messages (indices 0-5), evict 2-5 (4 messages), add 1 gist message = 3 messages
      assert.equal(result.state.messages.length, 3);

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
      assert.equal(compactionEvent.droppedCount, 4); // turns 2,3,4,5
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

  describe('validation fails - unresolved dropped (4b)', () => {
    it('aborts when unresolved array is empty', async () => {
      const gistDroppedUnresolved = createGistDroppedUnresolved();
      mockStore.addArtifact('artifact://file/abc123', 'artifact content', 'file_snapshot');

      const result = await runCompactionTransaction({
        state: baseState,
        gist: gistDroppedUnresolved,
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
      assert.ok(result.defects.some((d) => d.step === '4b_invariants' && d.detail.includes('dropped')));
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
});