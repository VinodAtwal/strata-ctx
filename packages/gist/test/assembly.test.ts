import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { GistAssembler, createGistAssembler } from '../src/assembly.js';
import { validateGist } from '@strata-ctx/core-types';
import type { ContentBlock, BlockMeta } from '@strata-ctx/core-types';
import { sha256 } from '@strata-ctx/core-types';
import {
  createTestContextState,
  createTestPolicy,
  createBudgetView,
} from './fixtures.js';

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
    assert.equal(gist.raw_recoverable, true);
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
    const validation = validateGist(gist, gist.log_gist.salient_errors.length);

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
      artifacts: [{ uri: 'artifact://test/abc123', sha256: sha256('test'), bytes: 100, kind: 'raw_transcript' }],
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
    const json = JSON.stringify(gist);
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
      const validation = validateGist(gist, gist.log_gist.salient_errors.length);
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
});