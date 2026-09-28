import type {
  ArtifactRef,
  BlockMeta,
  BlockSubject,
  ContextState,
  Gist,
  Message,
  PinnedConstraint,
  StrataPolicy,
} from '@strata-ctx/core-types';
import { runId, taskId, sha256 } from '@strata-ctx/core-types';

/**
 * Test fixtures for the compaction transaction tests.
 */

// ---- Identifiers ----

export const TEST_RUN_ID = runId('run-test-123');
export const TEST_TASK_ID = taskId('task-test-456');

// ---- Common meta helpers ----

const baseMeta = (overrides: Partial<BlockMeta> = {}): BlockMeta => ({
  origin: 'system',
  sha256: sha256('test'),
  tier: 'episodic',
  bytes: 100,
  cacheable: false,
  ...overrides,
});

const governanceMeta = (overrides: Partial<BlockMeta> = {}): BlockMeta => ({
  ...baseMeta({ tier: 'governance', cacheable: true }),
  ...overrides,
});

const toolResultMeta = (subject: BlockSubject, overrides: Partial<BlockMeta> = {}): BlockMeta => ({
  ...baseMeta({ tier: 'tool_state', subject }),
  ...overrides,
});

// ---- Messages ----

export function createSystemMessage(text: string, meta?: BlockMeta): Message {
  return {
    role: 'system',
    content: [
      {
        type: 'text',
        text,
        meta: meta ?? governanceMeta({ sha256: sha256(text), bytes: text.length }),
      },
    ],
    ts: Date.now(),
  };
}

export function createUserMessage(text: string): Message {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text,
        meta: baseMeta({ sha256: sha256(text), bytes: text.length, tier: 'user_intent' }),
      },
    ],
    ts: Date.now(),
  };
}

export function createAssistantMessage(text: string): Message {
  return {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text,
        meta: baseMeta({ sha256: sha256(text), bytes: text.length }),
      },
    ],
    ts: Date.now(),
  };
}

export function createToolResultMessage(
  toolName: string,
  result: string,
  subject: BlockSubject,
): Message {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool_result',
        id: `call-${toolName}-${Date.now()}`,
        toolName,
        text: result,
        meta: toolResultMeta(subject, { sha256: sha256(result), bytes: result.length }),
      },
    ],
    ts: Date.now(),
  };
}

// ---- Gist helpers ----

export function createTestGist(overrides: Partial<Gist> = {}): Gist {
  const base: Gist = {
    v: 1,
    task_id: TEST_TASK_ID,
    status: 'complete',
    goal: 'Test goal for compaction',
    changed: [
      {
        path: 'src/test.ts',
        what: 'Added test function',
        why: 'To verify compaction works',
        sha: sha256('test content'),
      },
    ],
    decided: [
      {
        id: 'D1',
        choice: 'Use TypeScript',
        why: 'Type safety',
        alternatives_rejected: ['JavaScript'],
      },
    ],
    unresolved: ['How to handle edge case X'],
    current_values: { NODE_ENV: 'test' },
    artifacts: [
      {
        uri: 'artifact://file/abc123',
        sha256: sha256('artifact content'),
        bytes: 100,
      },
    ],
    next: {
      question: 'What next?',
      next_command: 'npm test',
      blockers: [],
    },
    log_gist: {
      ran: ['npm test'],
      failed: [],
      salient_errors: ['Error: test failed'],
      salient_warnings: [],
      dropped_count: 5,
      raw_uri: 'artifact://transcript/raw123',
    },
    verification: {
      tests_run: ['npm test'],
      status: 'passing',
    },
    constraints: ['Never delete user data', 'Always validate input'],
    source_turn_range: [2, 5],
    raw_recoverable: true,
    compressed_by: 'self-gist',
  };
  return { ...base, ...overrides };
}

export function createGistWithConstraints(constraints: string[]): Gist {
  return createTestGist({ constraints });
}

export function createGistMissingConstraint(): Gist {
  return createTestGist({ constraints: ['Never delete user data'] }); // Missing "Always validate input"
}

export function createGistExtraConstraint(): Gist {
  return createTestGist({ constraints: ['Never delete user data', 'Always validate input', 'Extra constraint'] });
}

export function createGistReorderedConstraints(): Gist {
  return createTestGist({ constraints: ['Always validate input', 'Never delete user data'] });
}

export function createGistMissingSha(): Gist {
  return createTestGist({
    changed: [
      {
        path: 'src/test.ts',
        what: 'Added test function',
        why: 'To verify compaction works',
        sha: '', // Invalid - empty sha
      },
    ],
  });
}

export function createGistDroppedUnresolved(): Gist {
  return createTestGist({ unresolved: [] }); // Dropped the scary one
}

export function createGistMissingErrors(): Gist {
  return createTestGist({
    log_gist: {
      ran: ['npm test'],
      failed: [],
      salient_errors: [], // Missing the expected error
      salient_warnings: [],
      dropped_count: 5,
      raw_uri: 'artifact://transcript/raw123',
    },
  });
}

export function createGistArtifactMissing(): Gist {
  return createTestGist({
    artifacts: [
      {
        uri: 'artifact://file/missing123',
        sha256: sha256('missing content'),
        bytes: 100,
      },
    ],
  });
}

// ---- Policy helpers ----

export function createTestPolicy(overrides: Partial<StrataPolicy> = {}): StrataPolicy {
  const baseConstraints: PinnedConstraint[] = [
    {
      id: 'c1',
      text: 'Never delete user data',
      sha256: sha256('Never delete user data'),
      source: 'org_policy',
      kind: 'hard_safety',
      enforcement: 'block',
    },
    {
      id: 'c2',
      text: 'Always validate input',
      sha256: sha256('Always validate input'),
      source: 'project',
      kind: 'soft_policy',
      enforcement: 'rewrite',
    },
  ];

  return {
    version: 1,
    redaction: { mode: 'log', onFail: 'forward' },
    retention: { rawTranscriptDays: 7, artifactDays: 30, keepPurgeLog: true },
    governance: { pinning: 'required', autoPin: 'on', canaryIntervalTurns: 20 },
    pipeline: {
      stages: ['dedupe', 'truncate', 'triage', 'pin', 'compact', 'compress', 'serialize'],
      compaction: 'auto',
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
    constraints: baseConstraints,
    ...overrides,
  };
}

// ---- ContextState helpers ----

export function createTestContextState(overrides: Partial<ContextState> = {}): ContextState {
  const pinned = ['Never delete user data', 'Always validate input'];

  const messages: Message[] = [
    createSystemMessage('Never delete user data'),
    createSystemMessage('Always validate input'),
    createUserMessage('Please add a test function'),
    createAssistantMessage('I will add a test function'),
    createToolResultMessage(
      'edit',
      'File created',
      { kind: 'file', ref: 'src/test.ts', version: '1' },
    ),
    createAssistantMessage('Test function added successfully'),
  ];

  const base: ContextState = {
    messages,
    pinned,
    tokenEstimate: messages.reduce(
      (acc, msg) => acc + msg.content.reduce((sum, block) => sum + block.meta.bytes, 0),
      0,
    ),
    policyHash: sha256(pinned.join('\n')),
    runId: TEST_RUN_ID,
    turn: 5,
    taskId: TEST_TASK_ID,
    gists: [],
    artifacts: [],
    ...overrides,
  };

  return base;
}

export function createContextWithGovernanceMessages(
  governanceTexts: string[],
  otherMessages: Message[] = [],
): ContextState {
  const messages: Message[] = governanceTexts.map((text) => createSystemMessage(text)).concat(otherMessages);
  const pinned = governanceTexts;

  return {
    messages,
    pinned,
    tokenEstimate: messages.reduce(
      (acc, msg) => acc + msg.content.reduce((sum, block) => sum + block.meta.bytes, 0),
      0,
    ),
    policyHash: sha256(pinned.join('\n')),
    runId: TEST_RUN_ID,
    turn: messages.length,
    taskId: TEST_TASK_ID,
    gists: [],
    artifacts: [],
  };
}

export interface MockArtifactStoreState {
  artifacts: Map<string, { content: string; kind: ArtifactRef['kind']; at: number }>;
}

import type { ReadResult, ArtifactStat } from '@strata-ctx/security';

export function createMockArtifactStore(initialState: MockArtifactStoreState = { artifacts: new Map() }) {
  const store: MockArtifactStoreState = { artifacts: new Map(initialState.artifacts) };

  return {
    state: store,
    async put(content: string | Uint8Array, kind: ArtifactRef['kind'], options?: { readonly at?: number }): Promise<ArtifactRef> {
      await Promise.resolve();
      const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
      const digest = sha256(text);
      const uri = `artifact://${kind}/${digest}`;
      const at = options?.at ?? Date.now();
      store.artifacts.set(uri, { content: text, kind, at });
      return { uri, sha256: digest, bytes: text.length, kind };
    },
    async exists(uriOrDigest: string): Promise<boolean> {
      await Promise.resolve();
      if (uriOrDigest.startsWith('artifact://')) {
        return store.artifacts.has(uriOrDigest);
      }
      for (const [uri, _artifact] of store.artifacts) {
        if (uri.endsWith(uriOrDigest)) return true;
      }
      return false;
    },
    async read(uri: string): Promise<ReadResult> {
      await Promise.resolve();
      const artifact = store.artifacts.get(uri);
      if (!artifact) throw new Error(`Artifact not found: ${uri}`);
      const stat: ArtifactStat = {
        uri,
        digest: sha256(artifact.content),
        bytes: artifact.content.length,
        kind: artifact.kind,
        writtenAt: artifact.at,
        redacted: false,
        redactionKinds: [],
        sourceDigest: '',
        integrity: 'exact',
        path: uri,
      };
      return { text: artifact.content, stat, integrity: 'exact' };
    },
    addArtifact(uri: string, content: string, kind: ArtifactRef['kind']): void {
      store.artifacts.set(uri, { content, kind, at: Date.now() });
    },
  };
}

// ---- Telemetry capture ----

import type { StrataTelemetryEvent } from '@strata-ctx/telemetry';

export interface CapturedTelemetry {
  events: StrataTelemetryEvent[];
  emit: (event: StrataTelemetryEvent) => void;
}

export function createTelemetryCapture(): CapturedTelemetry {
  const events: StrataTelemetryEvent[] = [];
  return {
    events,
    emit: (event: StrataTelemetryEvent) => events.push(event),
  };
}
// ---- BudgetView factory ----

import { budgetView } from '@strata-ctx/core-types';

export function createBudgetView(over: Partial<{
  contextLimit: number;
  reserveOutput: number;
  targetUtilization: number;
  softTriggerFrac: number;
  hardTriggerFrac: number;
}> = {}): ReturnType<typeof budgetView> {
  return budgetView(
    over.contextLimit ?? 100_000,
    over.reserveOutput ?? 4_000,
    over.targetUtilization ?? 0.85,
    over.softTriggerFrac ?? 0.85,
    over.hardTriggerFrac ?? 0.95,
  );
}
