import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';
import { Readable, Writable } from 'node:stream';

import { runId, sha256, taskId } from '@strata-ctx/core-types';
import type { ContextState, TaskId } from '@strata-ctx/core-types';

import {
  MCPError,
  MCP_PROTOCOL_VERSION,
  MCPServer,
  TOOL_NAMES,
  createInMemoryContext,
  createStrataMcpServer,
  parseArtifactRef,
  scoreText,
  serveStdio,
  snippetFor,
  tokenize,
  validateArgs,
} from '../src/mcp-server.js';
import type {
  InMemoryContextStore,
  JSONRPCFailureResponse,
  JSONRPCSuccessResponse,
  MemorySeed,
  StatusReport,
} from '../src/mcp-server.js';

/* ------------------------------------------------------------------ *
 * Inline fixtures. Deliberately local: the shared fixtures module is
 * owned elsewhere and this file must not depend on its shape.
 * ------------------------------------------------------------------ */

const BASE_STATE: ContextState = {
  messages: [],
  pinned: ['Never execute rm -rf /', 'Prefer TypeScript over JavaScript'],
  tokenEstimate: 1234,
  policyHash: sha256('policy'),
  runId: runId('run-fixture-1'),
  turn: 7,
  gists: [],
  artifacts: [],
};

const TASK_UPLOADER = taskId('T-100');
const TASK_TELEMETRY = taskId('T-200');

function seed(): MemorySeed {
  return {
    state: BASE_STATE,
    tasks: [
      {
        id: TASK_UPLOADER,
        title: 'Migrate uploader to streaming',
        goal: 'Stop buffering whole uploads in memory',
        status: 'in_progress',
        tags: ['backend', 'perf'],
        createdAt: 1000,
        updatedAt: 5000,
        turns: [
          { turn: 1, role: 'user', text: 'the uploader buffers the whole body', tokens: 12 },
          { turn: 2, role: 'assistant', text: 'uploader should stream to disk', tokens: 10 },
          { turn: 3, role: 'tool', text: 'uploader: wrote 1.2GB to tmp', tokens: 8 },
          { turn: 4, role: 'assistant', text: 'added backpressure to uploader', tokens: 9 },
        ],
      },
      {
        id: TASK_TELEMETRY,
        title: 'Fix flaky telemetry test',
        goal: 'telemetry aggregate test must not race',
        status: 'blocked',
        tags: ['testing'],
        createdAt: 2000,
        updatedAt: 9000,
        turns: [
          { turn: 1, role: 'user', text: 'telemetry test fails on CI', tokens: 11 },
          { turn: 2, role: 'tool', text: 'telemetry: assertion on ordering', tokens: 7 },
        ],
      },
    ],
    notes: [
      {
        id: 'note-1',
        text: 'Gateway always binds 127.0.0.1:8787 in local mode',
        tags: ['gateway'],
        source: 'agent',
        ts: 3000,
      },
    ],
    facts: [
      {
        id: 'fact-1',
        key: 'deploy.target',
        value: '127.0.0.1:8787',
        tags: ['deploy'],
        source: 'user',
        ts: 4000,
        durable: true,
      },
    ],
    telemetry: {
      turns: 3,
      inputTokensGross: 12_000,
      inputTokensNet: 4_000,
      outputTokens: 900,
      outputTokensBaseline: 800,
      cachePrefixHits: 7,
      cachePrefixInvalidations: 3,
      lookups: 4,
      lookupHits: 3,
    },
  };
}

const ARTIFACT_TEXT = 'diff --git a/uploader.ts b/uploader.ts\n+stream(body)\n';

/**
 * `callTool` plus the payload as an MCP client would actually read it: parsed
 * back out of the wire content. The in-process `data` field is deliberately
 * not used here, so every assertion exercises the serialised form too.
 */
async function callData(srv: MCPServer, name: string, args: Record<string, unknown> = {}) {
  const result = await srv.callTool(name, args);
  assert.equal(result.isError, undefined, `expected ${name} to succeed`);
  return { result, data: JSON.parse(result.content[0]?.text ?? '{}') };
}

/** A writable that records newline-delimited responses. */
class Collector extends Writable {
  readonly lines: string[] = [];

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    for (const line of String(chunk).split('\n')) {
      if (line.trim() !== '') this.lines.push(line);
    }
    callback();
  }

  parsed<T>(): T[] {
    return this.lines.map((l) => JSON.parse(l) as T);
  }
}

function rpc(id: number | string, method: string, params?: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`;
}

/** A standalone schema for exercising the validator outside the tool layer. */
const TOOLSCHEMA = {
  type: 'object',
  properties: {
    q: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
  },
  required: ['q'],
  additionalProperties: false,
} as const;

/* ------------------------------------------------------------------ */

describe('mcp-server: registry', () => {
  let memory: InMemoryContextStore;
  let server: MCPServer;

  beforeEach(() => {
    memory = createInMemoryContext(seed());
    server = createStrataMcpServer(memory);
  });

  test('publishes exactly the six strata-ctx tools', () => {
    const names = server.listTools().map((t) => t.name);
    assert.deepEqual(names, [...TOOL_NAMES]);
  });

  test('every published tool has a description and an object input schema', () => {
    for (const tool of server.listTools()) {
      assert.ok(tool.description.length > 10, `${tool.name} needs a description`);
      assert.equal(tool.inputSchema.type, 'object');
    }
  });

  test('required arguments are declared in the published schema', () => {
    const search = server.listTools().find((t) => t.name === 'ctx_search');
    assert.deepEqual(search?.inputSchema.required, ['q']);
    const remember = server.listTools().find((t) => t.name === 'remember');
    assert.deepEqual(remember?.inputSchema.required, ['key', 'value']);
  });

  test('hasTool resolves both canonical names and docs aliases', () => {
    assert.equal(server.hasTool('get_task'), true);
    assert.equal(server.hasTool('ctx_get_task'), true);
    assert.equal(server.hasTool('ctx_status'), true);
    assert.equal(server.hasTool('nope'), false);
  });

  test('registerTool rejects a duplicate name', () => {
    assert.throws(
      () => server.registerTool('status', { description: 'dup', inputSchema: { type: 'object' } }, () => ({
        content: [],
      })),
      (err: unknown) => err instanceof MCPError && /already registered/.test(err.message),
    );
  });

  test('registerTool rejects a malformed name', () => {
    assert.throws(
      () => server.registerTool('Bad Name', { description: 'x', inputSchema: { type: 'object' } }, () => ({
        content: [],
      })),
      (err: unknown) => err instanceof MCPError && /invalid tool name/.test(err.message),
    );
  });

  test('registerTool rejects a non-object input schema', () => {
    assert.throws(
      () => server.registerTool('odd', { description: 'x', inputSchema: { type: 'string' } }, () => ({
        content: [],
      })),
      (err: unknown) => err instanceof MCPError && /must be "object"/.test(err.message),
    );
  });
});

describe('mcp-server: ctx_search', () => {
  let memory: InMemoryContextStore;
  let server: MCPServer;

  beforeEach(() => {
    memory = createInMemoryContext(seed());
    server = createStrataMcpServer(memory);
  });

  test('ranks matches and returns snippet, uri and tokens', async () => {
    const { result, data } = await callData(server, 'ctx_search', { q: 'uploader' });
    assert.equal(result.content[0]?.type, 'text');
    assert.equal(data.query, 'uploader');
    assert.ok(data.total > 0);
    const top = data.hits[0];
    assert.equal(top.kind, 'task');
    assert.equal(top.uri, 'ctx://task/T-100');
    assert.ok(top.score > 0);
    assert.ok(top.tokens > 0);
    assert.ok(String(top.snippet).length > 0);
  });

  test('order is deterministic across identical queries', async () => {
    const first = await callData(server, 'ctx_search', { q: 'telemetry' });
    const second = await callData(server, 'ctx_search', { q: 'telemetry' });
    assert.deepEqual(first.data.hits, second.data.hits);
  });

  test('honours limit', async () => {
    const { data } = await callData(server, 'ctx_search', { q: 'telemetry', limit: 2 });
    assert.equal(data.hits.length, 2);
    assert.equal(data.truncated, true);
  });

  test('filters by kind', async () => {
    const { data } = await callData(server, 'ctx_search', { q: 'deploy', kinds: ['fact'] });
    assert.equal(data.total, 1);
    assert.equal(data.hits[0].kind, 'fact');
    assert.equal(data.hits[0].id, 'fact-1');
  });

  test('scopes to a single task', async () => {
    const { data } = await callData(server, 'ctx_search', { q: 'telemetry', task_id: 'T-100' });
    assert.equal(data.total, 0);
  });

  test('applies the declared default limit when none is given', async () => {
    const { data } = await callData(server, 'ctx_search', { q: 'telemetry' });
    assert.equal(data.hits.length, 3);
    assert.ok(data.hits.length <= 10);
    assert.equal(data.truncated, false);
  });

  test('an unmatched query returns an empty result set, not an error', async () => {
    const { data } = await callData(server, 'ctx_search', { q: 'zzzznotpresent' });
    assert.equal(data.total, 0);
    assert.deepEqual(data.hits, []);
  });
});

describe('mcp-server: get_task', () => {
  let memory: InMemoryContextStore;
  let server: MCPServer;

  beforeEach(() => {
    memory = createInMemoryContext(seed());
    server = createStrataMcpServer(memory);
  });

  test('returns the task and its full turn list', async () => {
    const { data } = await callData(server, 'get_task', { task_id: 'T-100' });
    assert.equal(data.task_id, 'T-100');
    assert.equal(data.status, 'in_progress');
    assert.equal(data.turn_count, 4);
    assert.equal(data.returned_turn_count, 4);
    assert.deepEqual(data.range, { from: 1, to: 4 });
  });

  test('from_turn/to_turn narrow the returned range', async () => {
    const { data } = await callData(server, 'get_task', {
      task_id: 'T-100',
      from_turn: 2,
      to_turn: 3,
    });
    assert.equal(data.returned_turn_count, 2);
    assert.deepEqual(data.range, { from: 2, to: 3 });
    assert.deepEqual(data.turns, [
      { turn: 2, role: 'assistant', text: 'uploader should stream to disk', tokens: 10 },
      { turn: 3, role: 'tool', text: 'uploader: wrote 1.2GB to tmp', tokens: 8 },
    ]);
  });

  test('returns only what the task record holds, and says so', async () => {
    // Compaction drops evicted turns from `task.turns`. The handler reads that
    // array and nothing else -- no artifact lookup, no `recoverTurns` -- so a
    // dropped turn is unreachable through this tool. The description used to
    // promise the opposite ("the reversibility escape hatch: it returns the
    // original turns that compaction dropped"), which a client would read as a
    // guarantee and then treat a short result as a bug.
    const turnsBefore = memory.getTask(taskId('T-100'))?.turns.length ?? 0;
    assert.ok(turnsBefore > 0, 'precondition: the seed has turns to lose');

    // Drop the first two turns the way an eviction would, then ask for them back.
    const task = memory.getTask(taskId('T-100'));
    assert.ok(task !== undefined);
    const dropped = task.turns.slice(0, 2);
    (task.turns as unknown as { splice: (...args: unknown[]) => unknown }).splice(0, 2);

    const { data } = await callData(server, 'get_task', {
      task_id: 'T-100',
      from_turn: dropped[0]?.turn,
      to_turn: dropped[dropped.length - 1]?.turn,
    });
    assert.equal(data.returned_turn_count, 0, 'evicted turns are not recoverable here');

    const description = server
      .listTools()
      .find((t) => t.name === 'get_task')
      ?.description.toString();
    assert.match(description ?? '', /NOT a reversibility escape hatch/);
    assert.doesNotMatch(description ?? '', /This is the reversibility escape hatch/);
  });

  test('an inverted range is a tool error, not a protocol error', async () => {
    const result = await server.callTool('get_task', { task_id: 'T-100', from_turn: 4, to_turn: 1 });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /from_turn 4 is after to_turn 1/);
  });

  test('an unknown task id is a tool error', async () => {
    const result = await server.callTool('get_task', { task_id: 'T-999' });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /task not found: T-999/);
  });
});

describe('mcp-server: get_artifact', () => {
  let memory: InMemoryContextStore;
  let server: MCPServer;
  let digest: string;

  beforeEach(() => {
    memory = createInMemoryContext(seed());
    server = createStrataMcpServer(memory);
    digest = memory.putArtifact({ text: ARTIFACT_TEXT, kind: 'patch' }).sha256;
  });

  test('resolves an artifact:// uri to its content', async () => {
    const { data } = await callData(server, 'get_artifact', { ref: `artifact://file/${digest}` });
    assert.equal(data.sha256, digest);
    assert.equal(data.kind, 'patch');
    assert.equal(data.content, ARTIFACT_TEXT);
    assert.ok(data.bytes > 0);
  });

  test('resolves a bare sha256 digest as well', async () => {
    const { data } = await callData(server, 'get_artifact', { ref: digest });
    assert.equal(data.uri, `artifact://file/${digest}`);
  });

  test('a malformed ref is rejected before any lookup', async () => {
    const result = await server.callTool('get_artifact', { ref: 'artifact://nope' });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /not an artifact ref/);
  });

  test('an unknown digest is a tool error', async () => {
    const missing = sha256('never stored');
    const result = await server.callTool('get_artifact', { ref: missing });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /artifact not found/);
  });

  test('parseArtifactRef normalises bucket uris and rejects everything else', () => {
    const d = sha256('x');
    assert.equal(parseArtifactRef(d)?.uri, `artifact://file/${d}`);
    assert.equal(parseArtifactRef(`artifact://tool_log/${d}`)?.digest, d);
    assert.equal(parseArtifactRef('artifact://file/short'), undefined);
    assert.equal(parseArtifactRef('https://example.com/x'), undefined);
  });
});

describe('mcp-server: note', () => {
  test('records a durable note that search can immediately find', async () => {
    const memory = createInMemoryContext(seed());
    const server = createStrataMcpServer(memory);

    const { data } = await callData(server, 'note', {
      text: 'uploader regression: backpressure missing in v2',
      tags: ['uploader', 'regression'],
    });
    assert.equal(data.text, 'uploader regression: backpressure missing in v2');
    assert.deepEqual(data.tags, ['uploader', 'regression']);
    assert.equal(data.source, 'agent');
    assert.ok(Number.isInteger(data.ts));

    const found = await callData(server, 'ctx_search', { q: 'backpressure', kinds: ['note'] });
    assert.equal(found.data.total, 1);
    assert.equal(found.data.hits[0].id, data.id);
    assert.equal(memory.status().notes, 2);
  });

  test('honours an explicit source', async () => {
    const server = createStrataMcpServer(createInMemoryContext(seed()));
    const { data } = await callData(server, 'note', { text: 'user asked for tabs', source: 'user' });
    assert.equal(data.source, 'user');
  });
});

describe('mcp-server: remember', () => {
  test('persists a fact into durable memory', async () => {
    const memory = createInMemoryContext(seed());
    const server = createStrataMcpServer(memory);

    const { data } = await callData(server, 'remember', {
      key: 'uploader.max_bytes',
      value: '1048576',
      tags: ['uploader'],
    });
    assert.equal(data.key, 'uploader.max_bytes');
    assert.equal(data.value, '1048576');
    assert.equal(data.durable, true);

    const found = await callData(server, 'ctx_search', { q: 'max_bytes', kinds: ['fact'] });
    assert.equal(found.data.hits[0].id, data.id);
  });

  test('re-remembering a key updates in place rather than duplicating', async () => {
    const memory = createInMemoryContext(seed());
    const server = createStrataMcpServer(memory);

    const first = await callData(server, 'remember', { key: 'uploader.max_bytes', value: '1' });
    const second = await callData(server, 'remember', { key: 'uploader.max_bytes', value: '2' });

    assert.equal(second.data.id, first.data.id);
    assert.equal(second.data.value, '2');
    assert.equal(memory.status().facts, 2);
  });
});

describe('mcp-server: status', () => {
  let memory: InMemoryContextStore;
  let server: MCPServer;

  beforeEach(() => {
    memory = createInMemoryContext(seed());
    server = createStrataMcpServer(memory);
  });

  test('reports numeric gross and net savings', async () => {
    const { data } = await callData(server, 'status');
    const report = data as StatusReport;

    assert.equal(report.inputTokensGross, 12_000);
    assert.equal(report.inputTokensNet, 4_000);
    assert.equal(report.tokensSavedGross, 8_000);
    assert.equal(report.tokensSavedNet, 7_900);
    assert.equal(report.savingsRatio, 0.666667);
    assert.equal(report.expansionFactor, 1.125);
    assert.equal(report.breakevenOk, true);

    // Every savings/telemetry field is a number, so a consumer can chart it
    // without a type guard. The two exceptions are the run label and the
    // boolean recoverability flag, both asserted below.
    const numeric: Array<keyof StatusReport> = [
      'turn',
      'turns',
      'tasks',
      'notes',
      'facts',
      'artifacts',
      'inputTokensGross',
      'inputTokensNet',
      'outputTokens',
      'outputTokensBaseline',
      'tokensSavedGross',
      'tokensSavedNet',
      'savingsRatio',
      'expansionFactor',
      'tokenEstimate',
      'searches',
      'lookups',
      'lookupHits',
      'lookupMisses',
      'hitRate',
      'cachePrefixHits',
      'cachePrefixInvalidations',
      'cacheHitRate',
      'constraintsPinned',
      'constraintsMissing',
    ];
    for (const key of numeric) {
      assert.equal(typeof report[key], 'number', `${key} must be numeric`);
    }
    assert.equal(typeof report.runId, 'string');
    assert.equal(typeof report.breakevenOk, 'boolean');
    assert.equal(typeof report.rawRecoverable, 'boolean');
  });

  test('net savings go negative when output expansion exceeds input savings', () => {
    const fat = createInMemoryContext({
      telemetry: {
        inputTokensGross: 1000,
        inputTokensNet: 100,
        outputTokens: 5000,
        outputTokensBaseline: 1000,
      },
    });
    const report = fat.status();
    assert.equal(report.tokensSavedGross, 900);
    assert.equal(report.tokensSavedNet, -3100);
    assert.equal(report.breakevenOk, false);
  });

  test('hit rate reflects lookups, including misses', async () => {
    await callData(server, 'get_task', { task_id: 'T-100' });
    await server.callTool('get_task', { task_id: 'T-NOPE' });
    const { data } = await callData(server, 'status');
    assert.equal(data.lookups, 6);
    assert.equal(data.lookupHits, 4);
    assert.equal(data.lookupMisses, 2);
    assert.equal(data.hitRate, 0.666667);
    assert.equal(data.cacheHitRate, 0.7);
  });

  test('reports the cache prefix and pin posture from context state', async () => {
    const { data } = await callData(server, 'status');
    assert.equal(data.constraintsPinned, 2);
    assert.equal(data.constraintsMissing, 0);
    assert.equal(data.rawRecoverable, true);
    assert.equal(data.runId, 'run-fixture-1');
    assert.equal(data.turn, 7);
    assert.equal(data.tasks, 2);
  });

  test('records a request and moves the savings figures', () => {
    memory.recordRequest({ grossTokens: 1000, netTokens: 100, outputTokens: 50, baselineOutputTokens: 50 });
    const report = memory.status();
    assert.equal(report.turns, 4);
    assert.equal(report.inputTokensGross, 13_000);
    assert.equal(report.inputTokensNet, 4_100);
    assert.equal(report.tokensSavedGross, 8_900);
  });

  test('a zero-token run reports zeros rather than NaN', () => {
    const empty = createInMemoryContext().status();
    assert.equal(empty.savingsRatio, 0);
    assert.equal(empty.expansionFactor, 0);
    assert.equal(empty.hitRate, 0);
    assert.equal(empty.cacheHitRate, 0);
    assert.equal(empty.breakevenOk, true);
  });
});

describe('mcp-server: errors and validation', () => {
  let server: MCPServer;

  beforeEach(() => {
    server = createStrataMcpServer(createInMemoryContext(seed()));
  });
  test('an unknown tool is a -32602 MCPError', async () => {
    await assert.rejects(
      () => server.callTool('ctx_teleport'),
      (err: unknown) => {
        assert.ok(err instanceof MCPError);
        assert.equal(err.code, -32602);
        assert.match(err.message, /unknown tool: ctx_teleport/);
        return true;
      },
    );
  });

  test('a missing required argument is reported with a per-path issue', async () => {
    await assert.rejects(
      () => server.callTool('ctx_search', {}),
      (err: unknown) => {
        assert.ok(err instanceof MCPError);
        assert.equal(err.code, -32602);
        const data = err.data as { issues: Array<{ path: string; message: string }> };
        assert.ok(data.issues.some((i) => i.path === 'q' && i.message === 'is required'));
        return true;
      },
    );
  });

  test('a wrongly typed argument is rejected', async () => {
    await assert.rejects(
      () => server.callTool('ctx_search', { q: 42 }),
      (err: unknown) => {
        assert.ok(err instanceof MCPError);
        const data = err.data as { issues: Array<{ path: string; message: string }> };
        assert.ok(data.issues.some((i) => i.path === 'q' && /expected string/.test(i.message)));
        return true;
      },
    );
  });

  test('an empty required string is rejected', async () => {
    await assert.rejects(
      () => server.callTool('note', { text: '' }),
      (err: unknown) => err instanceof MCPError && err.code === -32602,
    );
  });

  test('an out-of-range number is rejected at both ends', async () => {
    await assert.rejects(
      () => server.callTool('ctx_search', { q: 'x', limit: 0 }),
      (err: unknown) => err instanceof MCPError && err.code === -32602,
    );
    await assert.rejects(
      () => server.callTool('ctx_search', { q: 'x', limit: 1000 }),
      (err: unknown) => err instanceof MCPError && err.code === -32602,
    );
  });

  test('an unknown argument is rejected (additionalProperties: false)', async () => {
    await assert.rejects(
      () => server.callTool('ctx_search', { q: 'x', nope: true }),
      (err: unknown) => {
        assert.ok(err instanceof MCPError);
        const data = err.data as { issues: Array<{ path: string; message: string }> };
        assert.ok(data.issues.some((i) => i.path === 'nope' && i.message === 'unknown argument'));
        return true;
      },
    );
  });

  test('a value outside an enum is rejected', async () => {
    await assert.rejects(
      () => server.callTool('note', { text: 'x', source: 'martian' }),
      (err: unknown) => err instanceof MCPError && err.code === -32602,
    );
  });

  test('status takes no arguments at all', async () => {
    await assert.rejects(
      () => server.callTool('status', { verbose: true }),
      (err: unknown) => err instanceof MCPError && err.code === -32602,
    );
  });

  test('a throwing handler becomes isError rather than a thrown MCPError', async () => {
    const custom = createStrataMcpServer(createInMemoryContext(seed()));
    custom.registerTool(
      'explode',
      { description: 'always fails', inputSchema: { type: 'object', properties: {} } },
      () => {
        throw new Error('backend unavailable');
      },
    );
    const result = await custom.callTool('explode');
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /explode: backend unavailable/);
  });

  test('validateArgs applies declared defaults', () => {
    const result = validateArgs(TOOLSCHEMA, { q: 'x' });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value['limit'], 10);
  });

  test('validateArgs returns issues for non-object arguments', () => {
    const result = validateArgs(TOOLSCHEMA, 'nope');
    assert.equal(result.ok, false);
  });
});

describe('mcp-server: JSON-RPC dispatch', () => {
  let server: MCPServer;

  beforeEach(() => {
    server = createStrataMcpServer(createInMemoryContext(seed()));
  });

  test('initialize reports the protocol version and server info', async () => {
    const res = (await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    })) as JSONRPCSuccessResponse;
    const result = res.result as {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
    };
    assert.equal(result.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.equal(result.serverInfo.name, 'strata-ctx');
  });

  test('tools/list returns every published tool', async () => {
    const res = (await server.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as JSONRPCSuccessResponse;
    const tools = (res.result as { tools: Array<{ name: string }> }).tools;
    assert.deepEqual(tools.map((t) => t.name), [...TOOL_NAMES]);
  });

  test('tools/call returns content and hides the in-process data field', async () => {
    const res = (await server.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'ctx_search', arguments: { q: 'telemetry' } },
    })) as JSONRPCSuccessResponse;
    const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
    assert.equal(result.isError, undefined);
    assert.ok(JSON.parse(result.content[0]?.text ?? '{}').total > 0);
  });

  test('tools/call propagates a tool-level failure as isError', async () => {
    const res = (await server.handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_task', arguments: { task_id: 'T-999' } },
    })) as JSONRPCSuccessResponse;
    const result = res.result as { isError?: boolean };
    assert.equal(result.isError, true);
  });

  test('tools/call surfaces an unknown tool as -32602', async () => {
    const res = (await server.handleRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'nope' },
    })) as JSONRPCFailureResponse;
    assert.equal(res.error.code, -32602);
  });

  test('tools/call requires a params.name', async () => {
    const res = (await server.handleRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {},
    })) as JSONRPCFailureResponse;
    assert.equal(res.error.code, -32602);
  });

  test('an unknown method is -32601', async () => {
    const res = (await server.handleRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'resources/list',
    })) as JSONRPCFailureResponse;
    assert.equal(res.error.code, -32601);
  });

  test('a malformed envelope is -32600 with a null id', async () => {
    const res = (await server.handleRequest(['not', 'an', 'object'])) as JSONRPCFailureResponse;
    assert.equal(res.error.code, -32600);
    assert.equal(res.id, null);
  });

  test('a wrong protocol version is -32600', async () => {
    const res = (await server.handleRequest({ jsonrpc: '1.0', id: 8, method: 'ping' })) as JSONRPCFailureResponse;
    assert.equal(res.error.code, -32600);
  });

  test('a notification produces no response at all', async () => {
    assert.equal(await server.handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.equal(await server.handleRequest({ jsonrpc: '2.0', method: 'anything/unknown' }), null);
  });

  test('a non-string, non-numeric id is normalised to null', async () => {
    const res = (await server.handleRequest({
      jsonrpc: '2.0',
      id: { bad: true },
      method: 'ping',
    })) as JSONRPCSuccessResponse;
    assert.equal(res.id, null);
    assert.equal(res.jsonrpc, '2.0');
  });
});

describe('mcp-server: stdio transport', () => {
  let memory: InMemoryContextStore;
  let server: MCPServer;

  beforeEach(() => {
    memory = createInMemoryContext(seed());
    server = createStrataMcpServer(memory);
  });

  async function roundTrip(lines: string[]): Promise<Collector> {
    const out = new Collector();
    const io = serveStdio(Readable.from(lines), out, server);
    await io.done;
    return out;
  }

  test('answers a request with a matching id and no extra output', async () => {
    const out = await roundTrip([rpc(1, 'initialize')]);
    assert.equal(out.lines.length, 1);
    const res = out.parsed<JSONRPCSuccessResponse>()[0];
    assert.equal(res?.jsonrpc, '2.0');
    assert.equal(res?.id, 1);
  });

  test('handles several requests, one per line, in order', async () => {
    const out = await roundTrip([
      rpc(1, 'ping'),
      rpc(2, 'tools/list'),
      rpc(3, 'ping'),
    ]);
    assert.deepEqual(out.parsed<JSONRPCSuccessResponse>().map((r) => r.id), [1, 2, 3]);
  });

  test('a tool call survives the round trip and mutates the store', async () => {
    const out = await roundTrip([
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'note', arguments: { text: 'uploader needs a retry budget' } },
      })}\n`,
    ]);
    const res = out.parsed<JSONRPCSuccessResponse>()[0];
    const body = JSON.parse((res?.result as { content: Array<{ text: string }> }).content[0]?.text ?? '{}');
    assert.equal(body.text, 'uploader needs a retry budget');
    assert.equal(memory.status().notes, 2);
  });

  test('buffers a request split across chunk boundaries', async () => {
    const out = new Collector();
    const io = serveStdio(Readable.from(['{"jsonrpc":"2.0","id":', '11,"method":"ping"}\n']), out, server);
    await io.done;
    assert.equal(out.parsed<JSONRPCSuccessResponse>()[0]?.id, 11);
  });

  test('handles several requests arriving in one chunk', async () => {
    const out = new Collector();
    const io = serveStdio(Readable.from([rpc(1, 'ping') + rpc(2, 'ping')]), out, server);
    await io.done;
    assert.deepEqual(out.parsed<JSONRPCSuccessResponse>().map((r) => r.id), [1, 2]);
  });

  test('a final line without a trailing newline is still answered', async () => {
    const out = new Collector();
    const io = serveStdio(Readable.from(['{"jsonrpc":"2.0","id":12,"method":"ping"}']), out, server);
    await io.done;
    assert.equal(out.parsed<JSONRPCSuccessResponse>()[0]?.id, 12);
  });

  test('blank lines produce no output', async () => {
    const out = await roundTrip(['\n', '   \n', rpc(1, 'ping')]);
    assert.equal(out.lines.length, 1);
  });

  test('malformed JSON is a -32700 with a null id and the stream survives', async () => {
    const out = await roundTrip(['{ not json\n', rpc(2, 'ping')]);
    const parsed = out.parsed<JSONRPCFailureResponse & JSONRPCSuccessResponse>();
    assert.equal(parsed[0]?.error.code, -32700);
    assert.equal(parsed[0]?.id, null);
    assert.equal(parsed[1]?.id, 2);
  });

  test('a notification on the wire writes nothing', async () => {
    const out = await roundTrip(['{"jsonrpc":"2.0","method":"notifications/initialized"}\n']);
    assert.equal(out.lines.length, 0);
  });

  test('an unknown tool on the wire is a -32602 error response', async () => {
    const out = await roundTrip([rpc(1, 'tools/call', { name: 'ctx_teleport' })]);
    assert.equal(out.parsed<JSONRPCFailureResponse>()[0]?.error.code, -32602);
  });

  test('close() stops the transport from answering further input', async () => {
    const out = new Collector();
    const io = serveStdio(Readable.from([rpc(1, 'ping')]), out, server);
    io.close();
    await io.done;
    assert.equal(out.lines.length, 0);
  });
});

describe('mcp-server: search scoring helpers', () => {
  test('tokenize lowercases, strips punctuation and dedupes', () => {
    assert.deepEqual(tokenize('The Uploader, the uploader!'), ['the', 'uploader']);
    assert.deepEqual(tokenize('   '), []);
  });

  test('scoreText is 0 for no match and rewards the exact phrase', () => {
    assert.equal(scoreText('nothing here', ['uploader']), 0);
    assert.equal(scoreText('uploader', ['uploader']), 1.5);
    assert.equal(scoreText('the uploader streams', ['the', 'uploader']), 1.5);
    assert.equal(scoreText('the uploader streams', ['the', 'nope']), 0.5);
  });

  test('scoreText on an empty term list is 0, never NaN', () => {
    assert.equal(scoreText('anything', []), 0);
  });

  test('snippetFor centres the first match and elides the rest', () => {
    const text = `${'x'.repeat(200)}the uploader is here${'y'.repeat(200)}`;
    const snippet = snippetFor(text, ['uploader'], 10);
    assert.match(snippet, /the uploader/);
    assert.ok(snippet.startsWith('…'));
    assert.ok(snippet.endsWith('…'));
  });

  test('snippetFor falls back to the head when nothing matches', () => {
    assert.equal(snippetFor('abcdefghij', ['zzz'], 3), 'abcdef');
  });
});

describe('mcp-server: fixture typing', () => {
  test('seeded task ids are branded TaskIds', () => {
    const memory = createInMemoryContext(seed());
    const found = memory.getTask('T-100' as TaskId);
    assert.equal(found?.title, 'Migrate uploader to streaming');
  });

  test('a default store is empty and still answers status', () => {
    const memory = createInMemoryContext();
    assert.equal(memory.status().tasks, 0);
    assert.deepEqual(memory.search({ q: 'anything' }), []);
  });
});
