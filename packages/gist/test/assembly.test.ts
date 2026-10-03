import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { GistAssembler, createGistAssembler } from '../src/assembly.js';
import { isResolvableArtifactUri } from '../src/artifact-uri.js';
import { validateGist, RAW_URI_UNSTORED } from '@strata-ctx/core-types';
import type { ContentBlock, BlockMeta, Gist, GistDraft } from '@strata-ctx/core-types';
import { sha256 } from '@strata-ctx/core-types';
import {
  createTestContextState,
  createTestPolicy,
  createBudgetView,
} from './fixtures.js';

/**
 * The draft as the transaction will store it.
 *
 * `assemble` has no artifact store, so it cannot assert `raw_recoverable` and
 * leaves the field off (assembly.ts:353-360). Every other field is final, and
 * this is the shape `runCompactionTransaction` validates (transaction.ts:420),
 * so the schema invariants are checked against it rather than against a draft
 * that could not parse.
 */
function asCommitted(draft: GistDraft): Gist {
  return { ...draft, raw_recoverable: true };
}

/** A resolvable content address, which is what a store would have returned. */
const transcriptUri = (text: string): string => `artifact://transcript/${sha256(text)}`;

function createBlockMeta(overrides: Partial<BlockMeta> = {}): BlockMeta {
  return {
    origin: 'assistant',
    sha256: sha256('test'),
    tier: 'episodic',
    bytes: 100,
    cacheable: false,
    ...overrides,
  };
}

function createContentBlock(overrides: Partial<ContentBlock> = {}): ContentBlock {
  return {
    type: 'text',
    text: 'test content',
    meta: createBlockMeta(),
    ...overrides,
  };
}

function createSelfGistBlock(): ContentBlock {
  const text = `goal: Create a new test file
decided: D1 - Use write tool (why: simplest approach)
unresolved: Need to verify file contents
next_question: How to verify?
next_command: read /tmp/test.txt
blockers: none`;
  return createContentBlock({ type: 'text', text });
}

function createErrorBlock(): ContentBlock {
  return createContentBlock({
    type: 'tool_result',
    toolName: 'write',
    id: 'call-error',
    text: 'Permission denied',
    meta: createBlockMeta({ tier: 'tool_state', severity: 'error', bytes: 50 }),
  });
}

function createFatalBlock(): ContentBlock {
  return createContentBlock({
    type: 'tool_result',
    toolName: 'execute',
    id: 'call-fatal',
    text: 'Process crashed',
    meta: createBlockMeta({ tier: 'tool_state', severity: 'fatal', bytes: 50 }),
  });
}

describe('GistAssembler', () => {
  let assembler: GistAssembler;
  let baseState: ReturnType<typeof createTestContextState>;
  let policy: ReturnType<typeof createTestPolicy>;
  let budget: ReturnType<typeof createBudgetView>;

  beforeEach(() => {
    assembler = createGistAssembler();
    baseState = createTestContextState();
    policy = createTestPolicy();
    budget = createBudgetView();
  });

  test('assembles a valid Gist with all required fields', () => {
    const input = {
      state: baseState,
      policy,
      budget,
      taskId: 'task-456',
      status: 'complete' as const,
      goal: 'Create a test file',
    };

    const gist = assembler.assemble(input);

    assert.ok(gist);
    assert.equal(gist.v, 1);
    assert.equal(gist.task_id, 'task-456');
    assert.equal(gist.status, 'complete');
    assert.equal(gist.goal, 'Create a test file');
    assert.ok(Array.isArray(gist.changed));
    assert.ok(typeof gist.current_values === 'object');
    assert.ok(Array.isArray(gist.decided));
    assert.ok(Array.isArray(gist.unresolved));
    assert.ok(Array.isArray(gist.artifacts));
    assert.ok(gist.next);
    assert.ok(gist.next.question);
    assert.ok(gist.next.next_command);
    assert.ok(Array.isArray(gist.next.blockers));
    assert.ok(gist.log_gist);
    assert.ok(Array.isArray(gist.log_gist.ran));
    assert.ok(Array.isArray(gist.log_gist.failed));
    assert.ok(Array.isArray(gist.log_gist.salient_errors));
    assert.ok(Array.isArray(gist.log_gist.salient_warnings));
    assert.ok(typeof gist.log_gist.dropped_count === 'number');
    assert.ok(gist.log_gist.raw_uri);
    assert.ok(gist.verification);
    assert.ok(Array.isArray(gist.constraints));
    assert.ok(Array.isArray(gist.source_turn_range));
    assert.equal(gist.source_turn_range.length, 2);
    // `baseState` carries no artifact, so there is no transcript to point at
    // and nothing to restore from one. The full assertion is the regression
    // test further down; this one only says the field is not asserted flatly.
    assert.notEqual(gist.raw_recoverable, true, 'a context with no artifact backs no recovery claim');
    assert.ok(['self-gist', 'local-model', 'none'].includes(gist.compressed_by));
  });

  test('Gist passes validateGist with zero defects', () => {
    const input = {
      state: baseState,
      policy,
      budget,
      taskId: 'task-456',
      status: 'complete' as const,
      goal: 'Create a test file',
    };

    const gist = assembler.assemble(input);
    const validation = validateGist(asCommitted(gist), gist.log_gist.salient_errors.length);

    assert.equal(validation.ok, true);
    assert.equal(validation.defects.length, 0);
    assert.ok(validation.gist);
  });

  test('constraints match pinned set byte-for-byte', () => {
    const input = {
      state: baseState,
      policy,
      budget,
      taskId: 'task-456',
      status: 'complete' as const,
      goal: 'Create a test file',
    };

    const gist = assembler.assemble(input);

    const expectedConstraints = ['Always validate input', 'Never delete user data'];
    assert.deepEqual(gist.constraints.sort(), expectedConstraints.sort());
  });

  test('artifact refs resolve from context', () => {
    const stateWithArtifacts = createTestContextState({
      // The uri agrees with the two fields beside it: the bucket is the one
      // `raw_transcript` maps to (store.ts:140-146) and the digest is the
      // content the `sha256` field names. `artifact://test/abc123` was neither
      // -- `test` is not a bucket and `abc123` is not a digest -- so this
      // asserted only that a string starts with a scheme.
      artifacts: [{ uri: transcriptUri('test'), sha256: sha256('test'), bytes: 100, kind: 'raw_transcript' }],
    });

    const input = {
      state: stateWithArtifacts,
      policy,
      budget,
      taskId: 'task-456',
      status: 'complete' as const,
      goal: 'Create a test file',
    };

    const gist = assembler.assemble(input);

    assert.equal(gist.artifacts.length, 1);
    const artifact = gist.artifacts[0];
    assert.ok(artifact !== undefined);
    assert.ok(artifact.uri.startsWith('artifact://'));
    assert.equal(artifact.sha256.length, 64);
    assert.ok(artifact.bytes > 0);
  });

  test('source_turn_range captures first and last turn', () => {
    const input = {
      state: baseState,
      policy,
      budget,
      taskId: 'task-456',
      status: 'complete' as const,
      goal: 'Create a test file',
    };

    const gist = assembler.assemble(input);

    assert.ok(gist.source_turn_range[0] <= gist.source_turn_range[1]);
    assert.ok(gist.source_turn_range[0] >= 0);
    assert.ok(gist.source_turn_range[1] >= 0);
  });

  test('log_gist includes salient errors from context', () => {
    const errorMsg = {
      role: 'tool' as const,
      content: [createErrorBlock()],
      ts: Date.now(),
    };
    const fatalMsg = {
      role: 'tool' as const,
      content: [createFatalBlock()],
      ts: Date.now(),
    };
    const stateWithErrors = createTestContextState({
      messages: [
        ...baseState.messages,
        errorMsg,
        fatalMsg,
      ],
    });

    const input = {
      state: stateWithErrors,
      policy,
      budget,
      taskId: 'task-456',
      status: 'complete' as const,
      goal: 'Create a test file',
    };

    const gist = assembler.assemble(input);

    assert.ok(gist.log_gist.salient_errors.length >= 2);
    assert.ok(gist.log_gist.salient_errors.some((e) => e.includes('Permission denied')));
    assert.ok(gist.log_gist.salient_errors.some((e) => e.includes('Process crashed')));
  });

  test('log_gist ran/failed arrays populated from tool calls', () => {
    const input = {
      state: baseState,
      policy,
      budget,
      taskId: 'task-456',
      status: 'complete' as const,
      goal: 'Create a test file',
    };

    const gist = assembler.assemble(input);

    assert.ok(Array.isArray(gist.log_gist.ran));
    assert.ok(Array.isArray(gist.log_gist.failed));
  });

  test('changed array extracted from file operations', () => {
    const input = {
      state: baseState,
      policy,
      budget,
      taskId: 'task-456',
      status: 'complete' as const,
      goal: 'Create a test file',
    };

    const gist = assembler.assemble(input);

    assert.ok(gist.changed.length >= 1);
    const fileChange = gist.changed.find((c) => c.path === 'src/test.ts');
    assert.ok(fileChange);
    assert.ok(fileChange.sha.length === 64);
  });

  test('self-gist block provides narrative fields', () => {
    const selfGistBlock = createSelfGistBlock();
    const input = {
      state: baseState,
      policy,
      budget,
      taskId: 'task-456',
      status: 'complete' as const,
      goal: 'Fallback goal',
      selfGistBlock,
    };

    const gist = assembler.assemble(input);

    assert.equal(gist.goal, 'Create a new test file');
    assert.ok(gist.decided.length >= 1);
    const d0 = gist.decided[0];
    assert.ok(d0 !== undefined);
    assert.equal(d0.id, 'D1');
    assert.equal(d0.choice, 'Use write tool');
    assert.ok(gist.unresolved.includes('Need to verify file contents'));
    const next = gist.next;
    assert.ok(next !== undefined);
    assert.equal(next.question, 'How to verify?');
    assert.equal(next.next_command, 'read /tmp/test.txt');
  });

  test('defaults to local-model when no self-gist block', () => {
    const input = {
      state: baseState,
      policy,
      budget,
      taskId: 'task-456',
      status: 'complete' as const,
      goal: 'Create a test file',
    };

    const gist = assembler.assemble(input);

    assert.equal(gist.compressed_by, 'local-model');
  });

  test('uses self-gist when provided', () => {
    const selfGistBlock = createSelfGistBlock();
    const input = {
      state: baseState,
      policy,
      budget,
      taskId: 'task-456',
      status: 'complete' as const,
      goal: 'Fallback goal',
      selfGistBlock,
    };

    const gist = assembler.assemble(input);

    assert.equal(gist.compressed_by, 'self-gist');
  });

  test('round-trip serialization preserves Gist', () => {
    const input = {
      state: baseState,
      policy,
      budget,
      taskId: 'task-456',
      status: 'complete' as const,
      goal: 'Create a test file',
    };

    const gist = assembler.assemble(input);
    const json = JSON.stringify(asCommitted(gist));
    const parsed = JSON.parse(json);
    const validation = validateGist(parsed, gist.log_gist.salient_errors.length);

    assert.equal(validation.ok, true);
  });

  test('handles all status values', () => {
    const statuses = ['complete', 'partial', 'blocked', 'abandoned'] as const;

    for (const status of statuses) {
      const input = {
        state: baseState,
        policy,
        budget,
        taskId: 'task-456',
        status,
        goal: 'Test',
      };

      const gist = assembler.assemble(input);
      assert.equal(gist.status, status);
      const validation = validateGist(asCommitted(gist), gist.log_gist.salient_errors.length);
      assert.equal(validation.ok, true);
    }
  });

  test('throws on constraint mismatch', () => {
    const badPolicy = createTestPolicy({
      constraints: [
        {
          id: 'c1',
          text: 'Different constraint text.',
          sha256: sha256('Different constraint text.'),
          source: 'org_policy',
          kind: 'hard_safety',
          enforcement: 'block',
        },
      ],
    });

    const input = {
      state: baseState,
      policy: badPolicy,
      budget,
      taskId: 'task-456',
      status: 'complete' as const,
      goal: 'Test',
    };

    assert.throws(() => assembler.assemble(input), /Constraint byte-equality check failed/);
  });

  test('verification defaults to untested', () => {
    const input = {
      state: baseState,
      policy,
      budget,
      taskId: 'task-456',
      status: 'complete' as const,
      goal: 'Test',
    };

    const gist = assembler.assemble(input);

    assert.equal(gist.verification.status, 'untested');
    assert.deepEqual(gist.verification.tests_run, []);
  });

  test('current_values captures env from command output', () => {
    const envMsg = {
      role: 'tool' as const,
      content: [
        createContentBlock({
          type: 'tool_result',
          toolName: 'execute',
          id: 'call-env',
          meta: createBlockMeta({
            tier: 'tool_state',
            subject: { kind: 'command', ref: 'env:TEST_KEY:test_value', version: '1' },
            bytes: 50,
          }),
        }),
      ],
      ts: Date.now(),
    };
    const stateWithEnv = createTestContextState({
      messages: [
        ...baseState.messages,
        envMsg,
      ],
    });

    const input = {
      state: stateWithEnv,
      policy,
      budget,
      taskId: 'task-456',
      status: 'complete' as const,
      goal: 'Test',
    };

    const gist = assembler.assemble(input);

    assert.equal(gist.current_values.TEST_KEY, 'test_value');
  });

  describe('raw_uri and raw_recoverable (the claim has to point somewhere real)', () => {
    // `log_gist.raw_uri` is the pointer to the untruncated log and
    // `raw_recoverable` says the log can be re-injected from it
    // (core-types/src/gist.ts:60-61,102). So the pair is one claim: if the URI
    // names nothing, the flag is asserting recovery from nothing. Eviction is
    // gated on exactly this pair (transaction.ts:151,165), which is why a
    // builder that fabricates one permanently refuses to compact.

    const input = {
      policy: createTestPolicy(),
      budget: createBudgetView(),
      taskId: 'task-456',
      status: 'complete' as const,
      goal: 'Create a test file',
    };

    test('a context with no artifacts gets no uri and no recoverability claim', () => {
      const state = createTestContextState({ artifacts: [] });

      const gist = assembler.assemble({ ...input, state });

      // The regression: this used to be the literal `artifact://empty`, a
      // bucket the ACL does not have, on a gist that still claimed `true`.
      assert.equal(gist.log_gist.raw_uri, RAW_URI_UNSTORED);
      assert.ok(
        !gist.log_gist.raw_uri.startsWith('artifact://'),
        'a uri nothing stored must not wear the artifact scheme',
      );
      assert.equal(isResolvableArtifactUri(gist.log_gist.raw_uri), false);
      assert.notEqual(gist.raw_recoverable, true, 'nothing was stored, so nothing is recoverable');
    });

    test('a context carrying a resolvable raw transcript keeps both halves of the claim', () => {
      // The positive half, so the fix cannot be satisfied by refusing to build
      // a gist whenever the context is empty.
      const uri = transcriptUri('the untruncated transcript');
      const state = createTestContextState({
        artifacts: [{ uri, sha256: sha256('the untruncated transcript'), bytes: 25, kind: 'raw_transcript' }],
      });

      const gist = assembler.assemble({ ...input, state });

      assert.equal(gist.log_gist.raw_uri, uri);
      assert.equal(isResolvableArtifactUri(gist.log_gist.raw_uri), true);
      assert.equal(gist.raw_recoverable, true);
      assert.deepEqual(gist.artifacts, [
        { uri, sha256: sha256('the untruncated transcript'), bytes: 25 },
      ]);
    });

    test('a file snapshot is not a transcript and cannot carry the claim', () => {
      // `state.artifacts[0]` used to fill `raw_uri` whatever it was, so a
      // context whose first artifact was a file snapshot published the
      // transcript claim against the snapshot's bytes. The eviction gate reads
      // `raw_uri` as the object holding the dropped turns; a snapshot holds
      // neither them nor a message list to recover from.
      const uri = transcriptUri('a file snapshot');
      const state = createTestContextState({
        artifacts: [{ uri, sha256: sha256('a file snapshot'), bytes: 15, kind: 'file_snapshot' }],
      });

      const gist = assembler.assemble({ ...input, state });

      assert.equal(gist.log_gist.raw_uri, RAW_URI_UNSTORED);
      assert.notEqual(gist.raw_recoverable, true);
      assert.deepEqual(
        gist.artifacts.map((a) => a.uri),
        [uri],
        'the artifact is still referenced; only the transcript claim moved',
      );
    });
  });
});