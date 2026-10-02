import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';
import {
  recoverTurns,
  reconstructContextSegment,
  verifyGovernanceRoundTrip,
} from '../src/reversibility.js';
import type { RecoveredSegment, RecoveryArtifactStore } from '../src/reversibility.js';
import type { ArtifactRef, BlockSubject, Gist, Message, ContentBlock } from '@strata-ctx/core-types';
import type { ReadResult } from '@strata-ctx/security';
import { bucketForKind } from '@strata-ctx/security';
import { createHash } from 'node:crypto';

const digestOf = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The address `put(rawTranscript, 'raw_transcript')` mints, byte for byte
 * (security/src/store.ts:157-161). Recovery fixtures that used
 * `artifact://log/abc123` described an object the store would refuse to parse,
 * so nothing exercised the URI handling they were nominally about.
 */
const RAW_URI = `artifact://transcript/${'a'.repeat(64)}`;

function makeBlock(text: string, overrides: Partial<ContentBlock> = {}): ContentBlock {
  const { meta: overrideMeta, ...restOverrides } = overrides;
  return {
    type: 'text',
    text,
    meta: {
      origin: 'assistant',
      sha256: digestOf(text),
      tier: overrideMeta?.tier ?? 'episodic',
      bytes: text.length,
      cacheable: false,
      ...overrideMeta,
    },
    ...restOverrides,
  };
}

function makeGovernanceMessage(text = 'governance rule: no secrets'): Message {
  const sha = digestOf(text);
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
      sha256: digestOf(text),
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

/**
 * A block that is standing in for content held elsewhere.
 *
 * `representedSha` is the digest of the content the block represents, which is
 * what B-3 and H-6 promise `meta.sha256` stays (pointer.ts:22-28) -- not the
 * digest of the stub now in `text`.
 */
function pointerBlock(
  type: ContentBlock['type'],
  stubText: string,
  representedSha: string,
  subject?: BlockSubject,
): ContentBlock {
  return {
    type,
    text: stubText,
    meta: {
      origin: 'tool',
      sha256: representedSha,
      tier: 'artifact_ref',
      bytes: stubText.length,
      cacheable: false,
      ...(subject === undefined ? {} : { subject }),
    },
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
      raw_uri: RAW_URI,
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

interface StubArtifactStore extends RecoveryArtifactStore {
  readonly exists: (uri: string) => Promise<boolean>;
  readonly put: (
    content: string | Uint8Array,
    kind: ArtifactRef['kind'],
    options?: { readonly at?: number },
  ) => Promise<ArtifactRef>;
}

/**
 * A store with a working writer.
 *
 * `put` used to throw 'not implemented' and `exists` used to answer `true` to
 * everything, so no test in this package could have caught a URI that resolves
 * to nothing. Both now describe the same map.
 */
function makeArtifactStore(messages: readonly Message[]): StubArtifactStore {
  const objects = new Map<string, { text: string; kind: ArtifactRef['kind']; at: number }>();
  objects.set(RAW_URI, {
    text: messages.map((m) => JSON.stringify(m)).join('\n'),
    kind: 'raw_transcript',
    at: Date.now(),
  });

  return {
    async read(uri: string): Promise<ReadResult> {
      await Promise.resolve();
      const object = objects.get(uri);
      if (!object) throw new Error(`artifact not found: ${uri}`);
      return {
        text: object.text,
        stat: {
          uri,
          digest: digestOf(object.text),
          bytes: object.text.length,
          kind: object.kind,
          writtenAt: object.at,
          redacted: false,
          redactionKinds: [],
          sourceDigest: '',
          integrity: 'exact',
          path: uri,
        },
        integrity: 'exact',
      };
    },
    async exists(uri: string): Promise<boolean> {
      await Promise.resolve();
      return objects.has(uri);
    },
    async put(
      content: string | Uint8Array,
      kind: ArtifactRef['kind'],
      options?: { readonly at?: number },
    ): Promise<ArtifactRef> {
      await Promise.resolve();
      const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
      const digest = digestOf(text);
      const uri = `artifact://${bucketForKind(kind)}/${digest}`;
      objects.set(uri, { text, kind, at: options?.at ?? Date.now() });
      return { uri, sha256: digest, bytes: text.length, kind };
    },
  };
}

const makeSegment = (messages: readonly Message[], overrides: Partial<RecoveredSegment> = {}): RecoveredSegment => ({
  messages,
  resolvedArtifacts: [],
  missingArtifacts: [],
  governanceIntact: true,
  ...overrides,
});

describe('recoverTurns', () => {
  let store: StubArtifactStore;
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

  test('does not claim governance intact when the raw transcript is gone', async () => {
    const emptyStore: RecoveryArtifactStore = {
      async read(uri: string): Promise<ReadResult> {
        await Promise.resolve();
        throw new Error(`artifact not found: ${uri}`);
      },
    };

    const result = await recoverTurns(makeGist(), emptyStore, { strict: false });

    assert.equal(result.messages.length, 0);
    assert.ok(result.missingArtifacts.includes(RAW_URI), 'should include raw transcript URI');
    // Nothing round-tripped, so nothing was verified. `true` here was a false
    // green that reported total loss of the transcript as a clean recovery.
    assert.equal(result.governanceIntact, false);
  });

  test('throws on missing raw transcript in strict mode', async () => {
    const emptyStore: RecoveryArtifactStore = {
      async read(uri: string): Promise<ReadResult> {
        await Promise.resolve();
        throw new Error(`artifact not found: ${uri}`);
      },
    };

    await assert.rejects(
      recoverTurns(makeGist(), emptyStore, { strict: true }),
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

  test('substitutes resolved artifact content back into a tool result', async () => {
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
    // The bytes were resolved, so they must be in the messages. Reporting the
    // URI as resolved while handing back the stub that says the content was
    // elided is the shape this test used to accept.
    const restored = result.messages[1]?.content[0];
    assert.ok(restored !== undefined);
    assert.equal(restored.text, 'File content at actual file content');
    assert.equal(restored.meta.bytes, 'File content at actual file content'.length);
  });

  test('restores a pointerized block from the store it points at', async () => {
    const fileContent = 'const answer = 42;\n'.repeat(50);
    const artifactUri = 'artifact://file/' + digestOf(fileContent);
    const pointerStub = [
      '[strata:pointer]',
      'path: src/answer.ts',
      `uri: ${artifactUri}`,
      `sha256: ${digestOf(fileContent)}`,
      `chars: ${fileContent.length}`,
      'content elided; recoverable verbatim at the uri above (artifact store)',
    ].join('\n');

    const pointerized = [
      makeGovernanceMessage(),
      // `meta.sha256` stays the digest of the content the block represents, not
      // of the stub (pipeline/src/pointer.ts:22-28), which is what lets recovery
      // tell "this stub stands for that artifact" from "this text mentions it".
      makeMessage({ content: [pointerBlock('tool_result', pointerStub, digestOf(fileContent))] }),
    ];
    const artifactStore = makeArtifactStore(pointerized);
    await artifactStore.put(fileContent, 'file_snapshot');

    const result = await recoverTurns(makeGist({ source_turn_range: [0, 1] }), artifactStore);

    const restored = result.messages[1]?.content[0];
    assert.ok(restored !== undefined);
    assert.equal(
      restored.text,
      fileContent,
      'meta.sha256 is the digest of the content the block represents, so the whole stub is replaced',
    );
    assert.equal(restored.meta.bytes, fileContent.length);
    assert.equal(result.missingArtifacts.length, 0);
  });

  test('resolves a reference carried by a block that is not a tool result', async () => {
    // H-6 references anything with a subject or tool_state tier, which includes
    // plain `text` blocks (output-compress/src/reference.ts:105-106). Reading
    // only `tool_result` blocks made those references invisible to recovery.
    const payload = '{"rows":[1,2,3]}';
    const artifactUri = 'artifact://other/' + digestOf(payload);
    const referenceStub = `[strata:reference]\nkind: text\nuri: ${artifactUri}\nsha256: ${digestOf(payload)}\nbytes: ${payload.length}`;

    const referenced = [
      makeGovernanceMessage(),
      makeMessage({
        content: [
          pointerBlock('text', referenceStub, digestOf(payload), { kind: 'other', ref: 'src/report.json' }),
        ],
      }),
    ];
    const artifactStore = makeArtifactStore(referenced);
    await artifactStore.put(payload, 'other');

    const result = await recoverTurns(makeGist({ source_turn_range: [0, 1] }), artifactStore);

    assert.deepEqual(result.resolvedArtifacts.map((a) => a.uri), [artifactUri]);
    assert.equal(result.messages[1]?.content[0]?.text, payload);
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
    assert.equal(result.messages[1]?.content[0]?.text, `File at ${artifactUri}`);
  });
});

describe('JSONL transcript parsing', () => {
  test('parses JSONL format transcript', async () => {
    const messages = [
      makeGovernanceMessage(),
      makeMessage(),
    ];
    const transcriptText = messages.map((m) => JSON.stringify(m)).join('\n');

    const store: RecoveryArtifactStore = {
      async read(): Promise<ReadResult> {
        await Promise.resolve();
        return {
          text: transcriptText,
          stat: { uri: RAW_URI, digest: digestOf(transcriptText), bytes: transcriptText.length, kind: 'tool_log', writtenAt: Date.now(), redacted: false, redactionKinds: [], sourceDigest: '', integrity: 'exact', path: '/fake' },
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

    const store: RecoveryArtifactStore = {
      async read(): Promise<ReadResult> {
        await Promise.resolve();
        return {
          text: transcriptText,
          stat: { uri: RAW_URI, digest: digestOf(transcriptText), bytes: transcriptText.length, kind: 'tool_log', writtenAt: Date.now(), redacted: false, redactionKinds: [], sourceDigest: '', integrity: 'exact', path: '/fake' },
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
    const segment = makeSegment(messages);
    const result = reconstructContextSegment(segment, { runId: 'r', turn: 1, policyHash: 'h' });

    assert.equal(result.messages.length, 2);
  });

  test('calculates token estimate from block bytes', () => {
    const messages = [
      makeMessage({ content: [makeBlock('a'.repeat(100))] }),
      makeMessage({ content: [makeBlock('b'.repeat(200))] }),
    ];

    const segment = makeSegment(messages);
    const result = reconstructContextSegment(segment, { runId: 'r', turn: 1, policyHash: 'h' });

    assert.equal(result.tokenEstimate, 300);
  });

  test('carries the identity of the context the segment is grafted into', () => {
    const segment = makeSegment([makeMessage()]);
    const result = reconstructContextSegment(segment, {
      runId: 'run-7',
      turn: 12,
      taskId: 'task-3',
      policyHash: 'ph',
    });

    assert.equal(result.runId, 'run-7');
    assert.equal(result.turn, 12);
    assert.equal(result.taskId, 'task-3');
    assert.equal(result.policyHash, 'ph');
  });

  test('returns the restored messages rather than the recovered array itself', async () => {
    const payload = 'the original file body';
    const artifactUri = 'artifact://file/' + digestOf(payload);
    const pointerized = [
      makeMessage({ content: [makeToolResult(`see ${artifactUri} for details`)] }),
    ];
    const artifactStore = makeArtifactStore(pointerized);
    await artifactStore.put(payload, 'file_snapshot');

    const recovered = await recoverTurns(
      makeGist({ source_turn_range: [0, 0] }),
      artifactStore,
    );
    const result = reconstructContextSegment(recovered, { runId: 'r', turn: 1, policyHash: 'h' });

    assert.notEqual(result.messages, recovered.messages);
    assert.equal(result.messages[0]?.content[0]?.text, `see ${payload} for details`);
    assert.equal(result.tokenEstimate, `see ${payload} for details`.length);
  });
});

describe('verifyGovernanceRoundTrip', () => {
  test('passes when all constraints are present and intact', () => {
    const messages = [
      makeGovernanceMessage('rule 1'),
      makeGovernanceMessage('rule 2'),
    ];

    const result = verifyGovernanceRoundTrip(makeSegment(messages), ['rule 1', 'rule 2']);
    assert.equal(result.ok, true);
  });

  test('detects missing constraints', () => {
    const messages = [makeGovernanceMessage('rule 1')];

    const result = verifyGovernanceRoundTrip(makeSegment(messages), ['rule 1', 'rule 2']);
    assert.equal(result.ok, false);
    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0], 'rule 2');
  });

  test('detects extra constraints', () => {
    const messages = [
      makeGovernanceMessage('rule 1'),
      makeGovernanceMessage('rule 2'),
    ];

    const result = verifyGovernanceRoundTrip(makeSegment(messages), ['rule 1']);
    assert.equal(result.ok, false);
    assert.equal(result.extra.length, 1);
    assert.equal(result.extra[0], 'rule 2');
  });

  test('detects reordered governance blocks', () => {
    const messages = [
      makeGovernanceMessage('rule 2'),
      makeGovernanceMessage('rule 1'),
    ];

    const result = verifyGovernanceRoundTrip(makeSegment(messages), ['rule 1', 'rule 2']);
    assert.equal(result.ok, true);
  });
});