import type { StrataPolicy, PinnedConstraint, ContextState } from '@strata-ctx/core-types';
import { runId, sha256 } from '@strata-ctx/core-types';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, rmSync } from 'node:fs';

export const TEST_CONSTRAINTS: readonly PinnedConstraint[] = Object.freeze([
  {
    id: 'c1',
    text: 'Never execute rm -rf /',
    sha256: sha256('Never execute rm -rf /'),
    source: 'org_policy',
    kind: 'hard_safety',
    enforcement: 'block',
  },
  {
    id: 'c2',
    text: 'Prefer TypeScript over JavaScript',
    sha256: sha256('Prefer TypeScript over JavaScript'),
    source: 'project',
    kind: 'project_rule',
    enforcement: 'rewrite',
  },
  {
    id: 'c3',
    text: 'Use 2-space indentation',
    sha256: sha256('Use 2-space indentation'),
    source: 'user',
    kind: 'user_preference',
    enforcement: 'log',
  },
]);

export const TEST_POLICY: StrataPolicy = {
  version: 1,
  redaction: { mode: 'log', onFail: 'forward' },
  retention: { rawTranscriptDays: 7, artifactDays: 30, keepPurgeLog: true },
  governance: { pinning: 'required', autoPin: 'on', canaryIntervalTurns: 20 },
  pipeline: {
    stages: ['dedupe', 'truncate', 'triage', 'pin', 'compact', 'compress', 'serialize'],
    compaction: 'off',
    trigger: {
      strategy: 'sawtooth',
      softTriggerFrac: 0.85,
      hardTriggerFrac: 0.95,
      keepRecentTokens: 8192,
      reserveTokens: 8192,
      userMessageTailTokens: 20000,
      taskBoundarySignals: ['result_extracted', 'decision_superseded', 'before_large_read'],
    },
    tokenCompression: 'off',
    tierByteCaps: { tool_state: 20000, episodic: 40000, artifact_ref: 8000, user_intent: 60000 },
  },
  serialization: { machineFormat: 'passthrough', verbosity: 'off' },
  budgets: { contextLimit: 200000, maxOutputTokens: 8192, targetUtilization: 0.7 },
  constraints: [...TEST_CONSTRAINTS],
};

export function createTestContextState(overrides: Partial<ContextState> = {}): ContextState {
  const base: ContextState = {
    messages: [],
    pinned: [],
    tokenEstimate: 0,
    policyHash: sha256(TEST_CONSTRAINTS.map((c) => c.text).sort().join('\n')),
    runId: runId('test-run-123'),
    turn: 1,
    gists: [],
    artifacts: [],
  };
  return { ...base, ...overrides };
}

export const MOCK_PRE_TOOL_USE_BASH = {
  tool: 'Bash',
  parameters: { command: 'ls -la', description: 'List files' },
  sessionId: 'session-123',
  runId: 'run-456',
  turn: 1,
};

export const MOCK_PRE_TOOL_USE_READ = {
  tool: 'Read',
  parameters: { file_path: '/tmp/test.txt' },
  sessionId: 'session-123',
  runId: 'run-456',
  turn: 2,
};

export const MOCK_PRE_TOOL_USE_WRITE = {
  tool: 'Write',
  parameters: { file_path: '/tmp/output.txt', content: 'hello world' },
  sessionId: 'session-123',
  runId: 'run-456',
  turn: 3,
};

export const MOCK_PRE_TOOL_USE_EDIT = {
  tool: 'Edit',
  parameters: { file_path: '/tmp/test.txt', old_string: 'foo', new_string: 'bar' },
  sessionId: 'session-123',
  runId: 'run-456',
  turn: 4,
};

export const MOCK_PRE_TOOL_USE_TASK = {
  tool: 'Task',
  parameters: { description: 'Run tests', prompt: 'npm test' },
  sessionId: 'session-123',
  runId: 'run-456',
  turn: 5,
};

export const MOCK_PRE_TOOL_USE_UNKNOWN = {
  tool: 'UnknownTool',
  parameters: {},
  sessionId: 'session-123',
  runId: 'run-456',
  turn: 6,
};

export const MOCK_POST_TOOL_USE = {
  tool: 'Bash',
  parameters: { command: 'ls -la' },
  result: { stdout: 'file1.txt\nfile2.txt', stderr: '', exit_code: 0 },
  sessionId: 'session-123',
  runId: 'run-456',
  turn: 1,
};

export const TEMP_SETTINGS_DIR = '/tmp/strata-ctx-test-claude';
export const TEMP_SETTINGS_PATH = `${TEMP_SETTINGS_DIR}/settings.json`;

export function createTempSettings(content: Record<string, unknown> = {}): void {
  if (!existsSync(TEMP_SETTINGS_DIR)) {
    mkdirSync(TEMP_SETTINGS_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(TEMP_SETTINGS_PATH, JSON.stringify(content, null, 2), { mode: 0o600 });
}

export function readTempSettings(): Record<string, unknown> {
  if (!existsSync(TEMP_SETTINGS_PATH)) return {};
  return JSON.parse(readFileSync(TEMP_SETTINGS_PATH, 'utf8')) as Record<string, unknown>;
}

export function cleanupTempSettings(): void {
  if (existsSync(TEMP_SETTINGS_PATH)) unlinkSync(TEMP_SETTINGS_PATH);
  if (existsSync(TEMP_SETTINGS_DIR)) rmSync(TEMP_SETTINGS_DIR, { recursive: true });
}