import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';
import {
  recoverTurns,
  reconstructContextSegment,
  verifyGovernanceRoundTrip,
} from '../src/reversibility.js';
import type { Gist, Message, ContentBlock } from '@strata-ctx/core-types';
import type { ReadResult } from '@strata-ctx/security';
import { createHash } from 'node:crypto';

function makeBlock(text: string, overrides: Partial<ContentBlock> = {}): ContentBlock {
  const { meta: overrideMeta, ...restOverrides } = overrides;
  return {
    type: 'text',
    text,
    meta: {
      origin: 'assistant',
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      tier: overrideMeta?.tier ?? 'episodic',
      bytes: text.length,
      cacheable: false,
      ...overrideMeta,
    },
    ...restOverrides,
  };
}

function makeGovernanceMessage(text = 'governance rule: no secrets'): Message {
  const sha = createHash('sha256').update(text, 'utf8').digest('hex');
  const content: ContentBlock = makeBlock(text, {
    meta: {
      origin: 'system',
      tier: 'governance',
      cacheable: true,
      bytes: text.length,
      sha256: sha,
    },
  });
  return makeMessage({ content: [content] });
}

function makeToolResult(text: string, overrides: Partial<ContentBlock> = {}): ContentBlock {
  return {
    type: 'tool_result',
    text,
    meta: {
      origin: 'tool',
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      tier: 'tool_state',
      bytes: text.length,
      cacheable: false,
      ...(overrides.meta ?? {}),
    },
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    role: 'assistant',
    content: [makeBlock('test message')],
    ts: Date.now(),
    ...overrides,
  };
}

function makeGist(overrides: Partial<Gist> = {}): Gist {
  return {
    v: 1,
    task_id: 'test-task',
    status: 'complete',
    goal: 'Test task',
    source_turn_range: [0, 2],
    changed: [],
    current_values: {},
    decided: [],
    unresolved: [],
    log_gist: {
      ran: [],
      failed: [],
      salient_errors: [],
      salient_warnings: [],
      dropped_count: 0,
      raw_uri: 'artifact://log/abc123',
    },
    artifacts: [],
    next: { question: '', next_command: '', blockers: [] },
    verification: { status: 'untested', tests_run: [] },
    constraints: ['governance rule: no secrets'],
    compressed_by: 'self-gist',
    raw_recoverable: true,
    ...overrides,
  };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeArtifactStore(messages: readonly Message[]): any {
  const transcriptText = messages.map((m) => JSON.stringify(m)).join('\n');

  return {
    async read(uri: string): Promise<ReadResult> {
      await Promise.resolve();
      if (uri === 'artifact://log/abc123') {
        return {
          text: transcriptText,
          stat: {
            uri,
            digest: 'abc123',
            bytes: transcriptText.length,
            kind: 'tool_log',
            writtenAt: Date.now(),
            redacted: false,
            redactionKinds: [],
            sourceDigest: '',
            integrity: 'exact',
            path: '/fake/path',
          },
          integrity: 'exact',
        };
      }
      throw new Error(`artifact not found: ${uri}`);
    },
    async exists(): Promise<boolean> {
      await Promise.resolve();
      return true;
    },
    async put(): Promise<never> {
      await Promise.resolve();
      throw new Error('not implemented');
    },
    async putNamed(): Promise<never> {
      await Promise.resolve();
      throw new Error('not implemented');
    },
    async resolve(): Promise<never> {
      await Promise.resolve();
      throw new Error('not implemented');
    },
    async verify(): Promise<never> {
      await Promise.resolve();
      throw new Error('not implemented');
    },
    async stat(): Promise<never> {
      await Promise.resolve();
      throw new Error('not implemented');
    },
    async list(): Promise<readonly unknown[]> {
      await Promise.resolve();
      return [];
    },
    async remove(): Promise<boolean> {
      await Promise.resolve();
      return false;
    },
    async pruneAliases(): Promise<number> {
      await Promise.resolve();
      return 0;
    },
    acl: {},
    audit: {},
    root: '/fake',
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('recoverTurns', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
let store: any;
  let messages: Message[];

  beforeEach(() => {
    messages = [
      makeGovernanceMessage('governance rule: no secrets'),
      makeMessage({ content: [makeBlock('user request', { meta: { origin: 'user', tier: 'user_intent', sha256: 'x'.repeat(64), bytes: 'user request'.length, cacheable: false } })] }),
      makeMessage({ content: [makeBlock('assistant response')] }),
    ];
    store = makeArtifactStore(messages);
  });

  test('recovers messages in the source turn range', async () => {
    const gist = makeGist({ source_turn_range: [0, 2] });
    const result = await recoverTurns(gist, store);

    assert.equal(result.messages.length, 3);
    const msg0 = result.messages[0];
    const msg1 = result.messages[1];
    const msg2 = result.messages[2];
    assert.ok(msg0 !== undefined);
    assert.ok(msg1 !== undefined);
    assert.ok(msg2 !== undefined);
    const block0 = msg0.content[0];
    const block1 = msg1.content[0];
    const block2 = msg2.content[0];
    assert.ok(block0 !== undefined);
    assert.ok(block1 !== undefined);
    assert.ok(block2 !== undefined);
    assert.equal(block0.text, 'governance rule: no secrets');
    assert.equal(block1.text, 'user request');
    assert.equal(block2.text, 'assistant response');
  });

  test('recovers partial turn range', async () => {
    const gist = makeGist({ source_turn_range: [1, 2] });
    const result = await recoverTurns(gist, store);

    assert.equal(result.messages.length, 2);
    const msg0 = result.messages[0];
    const msg1 = result.messages[1];
    assert.ok(msg0 !== undefined);
    assert.ok(msg1 !== undefined);
    const block0 = msg0.content[0];
    const block1 = msg1.content[0];
    assert.ok(block0 !== undefined);
    assert.ok(block1 !== undefined);
    assert.equal(block0.text, 'user request');
    assert.equal(block1.text, 'assistant response');
  });

  test('verifies governance blocks are intact (bit-identical)', async () => {
    const gist = makeGist({ source_turn_range: [0, 2] });
    const result = await recoverTurns(gist, store);

    assert.equal(result.governanceIntact, true);
  });

  test('detects corrupted governance blocks', async () => {
    const corruptedMessages = [
      makeMessage({
        content: [{
          type: 'text',
          text: 'CORRUPTED: governance rule: no secrets',
          meta: { origin: 'system', sha256: 'b'.repeat(64), tier: 'governance', bytes: 40, cacheable: true },
        }],
      }),
      messages[1] ?? makeMessage(),
      messages[2] ?? makeMessage(),
    ];
    const corruptedStore = makeArtifactStore(corruptedMessages);

    const gist = makeGist({ source_turn_range: [0, 2] });
    const result = await recoverTurns(gist, corruptedStore);

    assert.equal(result.governanceIntact, false);
  });

  test('handles missing raw transcript gracefully in non-strict mode', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const failingStore: any = {
      async put() { await Promise.resolve(); return { uri: '', sha256: '', bytes: 0, kind: 'other', writtenAt: Date.now(), redacted: false, redactionKinds: [], sourceDigest: '', deduped: false }; },
      async exists() { await Promise.resolve(); return false; },
      async read(): Promise<ReadResult> { await Promise.resolve(); throw new Error('not found'); },
      async delete() { await Promise.resolve(); return false; },
      async gc() { await Promise.resolve(); return 0; },
      async addRef() { await Promise.resolve(); },
      async removeRef() { await Promise.resolve(); return false; },
    };

    const gist = makeGist();
    const result = await recoverTurns(gist, failingStore, { strict: false });

    assert.equal(result.messages.length, 0);
    assert.ok(result.missingArtifacts.includes('artifact://log/abc123'), 'should include raw transcript URI');
    assert.equal(result.governanceIntact, true);
  });

  test('throws on missing raw transcript in strict mode', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const failingStore: any = {
      async put() { await Promise.resolve(); return { uri: '', sha256: '', bytes: 0, kind: 'other', writtenAt: Date.now(), redacted: false, redactionKinds: [], sourceDigest: '', deduped: false }; },
      async exists() { await Promise.resolve(); return false; },
      async read(): Promise<ReadResult> { await Promise.resolve(); throw new Error('not found'); },
      async delete() { await Promise.resolve(); return false; },
      async gc() { await Promise.resolve(); return 0; },
      async addRef() { await Promise.resolve(); },
      async removeRef() { await Promise.resolve(); return false; },
    };

    const gist = makeGist();
    await assert.rejects(
      recoverTurns(gist, failingStore, { strict: true }),
      /raw transcript not found/,
    );
  });

  test('throws on invalid turn range (inverted)', async () => {
    const gist = makeGist({ source_turn_range: [5, 2] });
    await assert.rejects(
      recoverTurns(gist, store),
      /invalid source_turn_range/,
    );
  });

  test('resolves artifact references in tool results', async () => {
    const artifactUri = 'artifact://file/' + 'd'.repeat(64);
    const messagesWithArtifact = [
      makeGovernanceMessage(),
      makeMessage({
        content: [makeToolResult(`File content at ${artifactUri}`)],
      }),
    ];
    const artifactStore = makeArtifactStore(messagesWithArtifact);

    const artifactResolver = async (uri: string): Promise<ReadResult | null> => {
      await Promise.resolve();
      if (uri === artifactUri) {
        return {
          text: 'actual file content',
          stat: { uri, digest: 'd'.repeat(64), bytes: 18, kind: 'file_snapshot', writtenAt: Date.now(), redacted: false, redactionKinds: [], sourceDigest: '', integrity: 'exact', path: '/fake' },
          integrity: 'exact',
        };
      }
      return null;
    };

    const gist = makeGist({ source_turn_range: [0, 1] });
    const result = await recoverTurns(gist, artifactStore, { artifactResolver });

    assert.ok(result.resolvedArtifacts.some((a) => a.uri === artifactUri));
  });

  test('records missing artifacts in non-strict mode', async () => {
    const artifactUri = 'artifact://file/' + 'd'.repeat(64);
    const messagesWithArtifact = [
      makeGovernanceMessage(),
      makeMessage({
        content: [makeToolResult(`File at ${artifactUri}`)],
      }),
    ];
    const artifactStore = makeArtifactStore(messagesWithArtifact);

    const gist = makeGist({ source_turn_range: [0, 1] });
    const result = await recoverTurns(gist, artifactStore, { strict: false });

    assert.ok(result.missingArtifacts.includes(artifactUri));
  });
});

describe('JSONL transcript parsing', () => {
  test('parses JSONL format transcript', async () => {
    const messages = [
      makeGovernanceMessage(),
      makeMessage(),
    ];
    const transcriptText = messages.map((m) => JSON.stringify(m)).join('\n');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const store: any = {
      ...makeArtifactStore(messages),
      async read(): Promise<ReadResult> {
        await Promise.resolve();
        return {
          text: transcriptText,
          stat: { uri: 'artifact://log/x', digest: 'x', bytes: transcriptText.length, kind: 'tool_log', writtenAt: Date.now(), redacted: false, redactionKinds: [], sourceDigest: '', integrity: 'exact', path: '/fake' },
          integrity: 'exact',
        };
      },
    };

    const gist = makeGist({ source_turn_range: [0, 1] });
    const result = await recoverTurns(gist, store);

    assert.equal(result.messages.length, 2);
  });

  test('parses JSON array format transcript', async () => {
    const messages = [makeGovernanceMessage(), makeMessage()];
    const transcriptText = JSON.stringify(messages);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const store: any = {
      ...makeArtifactStore(messages),
      async read(): Promise<ReadResult> {
        await Promise.resolve();
        return {
          text: transcriptText,
          stat: { uri: 'artifact://log/x', digest: 'x', bytes: transcriptText.length, kind: 'tool_log', writtenAt: Date.now(), redacted: false, redactionKinds: [], sourceDigest: '', integrity: 'exact', path: '/fake' },
          integrity: 'exact',
        };
      },
    };

    const gist = makeGist({ source_turn_range: [0, 1] });
    const result = await recoverTurns(gist, store);

    assert.equal(result.messages.length, 2);
  });
});

describe('reconstructContextSegment', () => {
  test('builds a context segment from recovered messages', () => {
    const messages = [
      makeGovernanceMessage(),
      makeMessage(),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const segment: any = { messages, resolvedArtifacts: [], missingArtifacts: [], governanceIntact: true };
    const result = reconstructContextSegment(segment, { runId: 'r', turn: 1, policyHash: 'h' });

    assert.equal(result.messages.length, 2);
  });

  test('calculates token estimate from block bytes', () => {
    const messages = [
      makeMessage({ content: [makeBlock('a'.repeat(100))] }),
      makeMessage({ content: [makeBlock('b'.repeat(200))] }),
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const segment: any = { messages, resolvedArtifacts: [], missingArtifacts: [], governanceIntact: true };
    const result = reconstructContextSegment(segment, { runId: 'r', turn: 1, policyHash: 'h' });

    assert.equal(result.tokenEstimate, 300);
  });
});

describe('verifyGovernanceRoundTrip', () => {
  test('passes when all constraints are present and intact', () => {
    const messages = [
      makeGovernanceMessage('rule 1'),
      makeGovernanceMessage('rule 2'),
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const segment: any = { messages, resolvedArtifacts: [], missingArtifacts: [], governanceIntact: true };

    const result = verifyGovernanceRoundTrip(segment, ['rule 1', 'rule 2']);
    assert.equal(result.ok, true);
  });

  test('detects missing constraints', () => {
    const messages = [makeGovernanceMessage('rule 1')];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const segment: any = { messages, resolvedArtifacts: [], missingArtifacts: [], governanceIntact: true };

    const result = verifyGovernanceRoundTrip(segment, ['rule 1', 'rule 2']);
    assert.equal(result.ok, false);
    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0], 'rule 2');
  });

  test('detects extra constraints', () => {
    const messages = [
      makeGovernanceMessage('rule 1'),
      makeGovernanceMessage('rule 2'),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const segment: any = { messages, resolvedArtifacts: [], missingArtifacts: [], governanceIntact: true };

    const result = verifyGovernanceRoundTrip(segment, ['rule 1']);
    assert.equal(result.ok, false);
    assert.equal(result.extra.length, 1);
    assert.equal(result.extra[0], 'rule 2');
  });

  test('detects reordered governance blocks', () => {
    const messages = [
      makeGovernanceMessage('rule 2'),
      makeGovernanceMessage('rule 1'),
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const segment: any = { messages, resolvedArtifacts: [], missingArtifacts: [], governanceIntact: true };

    const result = verifyGovernanceRoundTrip(segment, ['rule 1', 'rule 2']);
    assert.equal(result.ok, true);
  });
});

describe('reconstructContextSegment', () => {
  test('builds a context segment from recovered messages', () => {
    const messages = [
      makeGovernanceMessage(),
      makeMessage(),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const segment: any = { messages, resolvedArtifacts: [], missingArtifacts: [], governanceIntact: true };
    const result = reconstructContextSegment(segment, { runId: 'r', turn: 1, policyHash: 'h' });

    assert.equal(result.messages.length, 2);
  });

  test('calculates token estimate from block bytes', () => {
    const messages = [
      makeMessage({ content: [makeBlock('a'.repeat(100))] }),
      makeMessage({ content: [makeBlock('b'.repeat(200))] }),
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const segment: any = { messages, resolvedArtifacts: [], missingArtifacts: [], governanceIntact: true };
    const result = reconstructContextSegment(segment, { runId: 'r', turn: 1, policyHash: 'h' });

    assert.equal(result.tokenEstimate, 300);
  });
});
