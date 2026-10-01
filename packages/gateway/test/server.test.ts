import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { after, test } from 'node:test';

import { pinSetText, runId, sha256, StrataPolicySchema, type StrataPolicy, type TelemetryEvent } from '@strata-ctx/core-types';
import { createGateway, type Gateway, type GatewayOptions } from '../src/server.js';
import type { ProviderAdapter } from '../src/routing.js';

const CONSTRAINT = 'never delete production data without explicit approval';
const SYSTEM = 'You are a coding agent.';

const policy: StrataPolicy = StrataPolicySchema.parse({
  version: 1,
  governance: { pinning: 'required' },
  constraints: [{ id: 'c1', text: CONSTRAINT, sha256: sha256(CONSTRAINT), source: 'org_policy', kind: 'hard_safety', enforcement: 'block' }],
});

const requestBody = (text: string): string =>
  JSON.stringify({ model: 'claude-test', max_tokens: 64, system: SYSTEM, messages: [{ role: 'user', content: 'refactor the uploader' }], ...(text ? {} : {}) });

// ------------------------------------------------------------------ harness

interface UpstreamCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

interface Upstream {
  readonly url: string;
  readonly calls: UpstreamCall[];
  close(): Promise<void>;
}

const readAll = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

type Responder = (call: UpstreamCall, res: ServerResponse) => void | Promise<void>;

/**
 * Everything started, so a failing assertion cannot leave a listening socket
 * behind. Node's test runner exits on an empty event loop; one leaked listener
 * is a suite that passes every assertion and then hangs the CI job.
 */
const live: { gateways: Gateway[]; upstreams: Upstream[] } = { gateways: [], upstreams: [] };

after(async () => {
  for (const u of live.upstreams) {
    await u.close();
  }
  for (const g of live.gateways) {
    await g.closeGracefully({ drainMs: 0 });
  }
});

/**
 * `fetch` resolves its connection over several event-loop turns, so a request
 * "sent" is not a request the server has accepted. Anything that races a
 * shutdown has to wait for the state it is asserting on, or it is asserting on
 * a race and will fail on a slow machine instead of explaining itself.
 */
const waitFor = async (what: string, ready: () => boolean, ms = 2_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

const startUpstream = async (responder: Responder): Promise<Upstream> => {
  const calls: UpstreamCall[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v;
      }
      const call: UpstreamCall = { method: req.method ?? '', url: req.url ?? '', headers, body: await readAll(req) };
      calls.push(call);
      await responder(call, res);
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  let closed: Promise<void> | null = null;
  const upstream: Upstream = {
    url: `http://127.0.0.1:${port}`,
    calls,
    // Idempotent, and it destroys the sockets. `server.close` alone waits for
    // every connection, and the gateway's `fetch` keeps one alive in a pool --
    // so a plain close at teardown waits for a client that has already gone.
    close: () =>
      (closed ??= new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      })),
  };
  live.upstreams.push(upstream);
  return upstream;
};

const echoJson: Responder = (_call, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, content: [{ type: 'text', text: 'done' }] }));
};

interface Harness {
  readonly gateway: Gateway;
  readonly url: string;
  readonly events: TelemetryEvent[];
}

const startGateway = async (overrides: Partial<GatewayOptions> = {}, upstreamUrl = 'http://127.0.0.1:1'): Promise<Harness> => {
  const events: TelemetryEvent[] = [];
  const gateway = createGateway({
    port: 0,
    host: '127.0.0.1',
    upstream: upstreamUrl,
    apiKeyEnv: 'STRATA_TEST_KEY',
    policy,
    telemetry: (e) => events.push(e),
    ...overrides,
  });
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
  const address = gateway.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  live.gateways.push(gateway);
  return { gateway, url: `http://127.0.0.1:${port}`, events };
};

const post = (url: string, body: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

const get = (url: string): Promise<Response> => fetch(url);

// ------------------------------------------------------------------- health

test('GET /healthz answers 200 with the provider, sessions and policy hash', async () => {
  const h = await startGateway();
  const res = await get(`${h.url}/healthz`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body['ok'], true);
  assert.equal(body['provider'], 'anthropic');
  assert.equal(body['adapter'], 'anthropic');
  assert.equal(body['sessions'], 0);
  assert.equal(body['inflight'], 1, 'the health request counts itself, and says so');
  assert.equal(body['constraints'], 1);
  assert.equal(body['policyHash'], sha256(pinSetText(policy).join('\n')));
  assert.equal(typeof body['uptimeMs'], 'number');
  assert.equal(body['draining'], false);
  await h.gateway.closeGracefully();
});

test('health counts the session a request created', async () => {
  const up = await startUpstream(echoJson);
  const h = await startGateway({}, up.url);
  await post(`${h.url}/v1/messages`, requestBody(''), { 'x-strata-session': 's1' });
  const body = (await (await get(`${h.url}/healthz`)).json()) as Record<string, unknown>;
  assert.equal(body['sessions'], 1);
  await h.gateway.closeGracefully();
  await up.close();
});

test('health reports a null adapter when the provider has none', async () => {
  // `mock` is the routable provider that still has no built-in adapter; it is a
  // test-only upstream and is always injected by the caller.
  const h = await startGateway({ provider: 'mock' });
  const body = (await (await get(`${h.url}/healthz`)).json()) as Record<string, unknown>;
  assert.equal(body['provider'], 'mock');
  assert.equal(body['adapter'], null);
  assert.equal(body['ok'], true, 'the gateway is up even if it cannot serve ingress');
  await h.gateway.closeGracefully();
});

test('GET /strata/status still answers', async () => {
  const h = await startGateway();
  const res = await get(`${h.url}/strata/status`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body['ok'], true);
  assert.deepEqual(body['policy'], { constraints: 1 });
  await h.gateway.closeGracefully();
});

// ------------------------------------------------------ routing negatives

test('an unknown route is a JSON 404, not a 200 with an empty body', async () => {
  const h = await startGateway();
  const res = await get(`${h.url}/nope`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('content-type'), 'application/json');
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body['error'], 'not_found');
  assert.match(String(body['detail']), /\/nope/);
  await h.gateway.closeGracefully();
});

test('a known route with the wrong method is 405 and carries Allow', async () => {
  const h = await startGateway();
  const res = await post(`${h.url}/healthz`, '{}');
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET');
  assert.equal(((await res.json()) as Record<string, unknown>)['error'], 'method_not_allowed');
  await h.gateway.closeGracefully();
});

test('malformed JSON is a JSON 400 and never reaches the upstream', async () => {
  const up = await startUpstream(echoJson);
  const h = await startGateway({}, up.url);
  const res = await post(`${h.url}/v1/messages`, '{"model": "x",');
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as Record<string, unknown>)['error'], 'bad_request');
  assert.equal(up.calls.length, 0);
  assert.ok(h.events.some((e) => e.type === 'error' && e.code === 'bad_request'));
  await h.gateway.closeGracefully();
  await up.close();
});

test('an empty body is a JSON 400 rather than an unhandled rejection', async () => {
  const h = await startGateway();
  const res = await post(`${h.url}/v1/messages`, '');
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as Record<string, unknown>)['error'], 'bad_request');
  await h.gateway.closeGracefully();
});

// ------------------------------------------------------- provider routing

test('a provider with no adapter is 501 with a JSON error naming it', async () => {
  const h = await startGateway({ provider: 'mock' });
  const res = await post(`${h.url}/v1/messages`, requestBody(''));
  assert.equal(res.status, 501);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body['error'], 'adapter_unavailable');
  assert.equal(body['provider'], 'mock');
  assert.match(String(body['detail']), /mock/);
  assert.ok(h.events.some((e) => e.type === 'error' && e.code === 'adapter_unavailable'));
  await h.gateway.closeGracefully();
});

test('an injected adapter is the seam A-9 and A-10 plug into', async () => {
  const up = await startUpstream(echoJson);
  const seen: unknown[] = [];
  const mock: ProviderAdapter = {
    provider: 'mock',
    supportsStreaming: false,
    toCanonical: (_req) => ({ messages: [], pinned: [], tokenEstimate: 0, policyHash: '', runId: runId('r'), turn: 1, gists: [], artifacts: [] }),
    fromCanonical: (state, req) => {
      seen.push(req);
      return { mock: true, seen: state.messages.length };
    },
  };
  const h = await startGateway({ provider: 'mock', adapters: { mock } }, up.url);
  const res = await post(`${h.url}/v1/messages`, requestBody(''));
  assert.equal(res.status, 200);
  assert.equal(up.calls.length, 1);
  // `seen: 1` is the governance block the pin stage prepended; the point of the
  // assertion is that the adapter saw canonical state, not the wire body.
  assert.deepEqual(JSON.parse(up.calls[0]?.body ?? ''), { mock: true, seen: 1 });
  assert.equal(seen.length, 1);
  assert.equal(res.headers.get('x-strata-pinned'), '1');
  await h.gateway.closeGracefully();
  await up.close();
});

test('an unrecognised provider name falls back to anthropic rather than throwing', async () => {
  const up = await startUpstream(echoJson);
  const h = await startGateway({ provider: 'openai' as never }, up.url);
  const body = (await (await get(`${h.url}/healthz`)).json()) as Record<string, unknown>;
  assert.equal(body['provider'], 'anthropic');
  await h.gateway.closeGracefully();
  await up.close();
});

// ------------------------------------------------------------- governance

test('pinned constraints and the agent system prompt both reach the provider', async () => {
  const up = await startUpstream(echoJson);
  const h = await startGateway({}, up.url);
  await post(`${h.url}/v1/messages`, requestBody(''));
  const sent = JSON.parse(up.calls[0]?.body ?? '{}') as {
    system?: { text: string }[];
    messages: { role: string; content: unknown }[];
  };
  const text = (sent.system ?? []).map((s) => s.text).join('\n');
  assert.ok(text.includes(CONSTRAINT), 'the pin is on the wire');
  assert.ok(text.includes(SYSTEM), 'the agent system prompt was not clobbered');
  assert.equal(sent.messages.length, 1, 'the user turn survived');
  await h.gateway.closeGracefully();
  await up.close();
});

test('the pin count is reported on every governed turn', async () => {
  const up = await startUpstream(echoJson);
  const h = await startGateway({}, up.url);
  const res = await post(`${h.url}/v1/messages`, requestBody(''));
  assert.equal(res.headers.get('x-strata-pinned'), '1');
  const pin = h.events.find((e) => e.type === 'pin');
  assert.equal(pin?.type === 'pin' && pin.constraints, 1);
  assert.equal(pin?.type === 'pin' && pin.missingBefore, 0);
  assert.ok(h.events.some((e) => e.type === 'request_in'));
  // Select the pin stage by name rather than by position. Before Tier 0 was
  // wired, pin was the only stage that reported, so `find` returning it was
  // incidental; the lossy stages now report too, and this test is about the pin
  // count, so it must not depend on what ran before pin.
  const stage = h.events.find((e) => e.type === 'stage' && e.stage === 'pin');
  assert.equal(stage?.type === 'stage' && stage.stage, 'pin');
  assert.equal(stage?.type === 'stage' && stage.changed, true);
  await h.gateway.closeGracefully();
  await up.close();
});

test('pin drift against the previous turn is still measured', async () => {
  const up = await startUpstream(echoJson);
  const h = await startGateway({}, up.url);
  await post(`${h.url}/v1/messages`, requestBody(''));
  await post(`${h.url}/v1/messages`, requestBody(''));
  assert.equal(up.calls.length, 2);
  const violation = h.events.find((e) => e.type === 'violation');
  assert.ok(violation, 'turn 2 is measured against turn 1');
  assert.equal(violation?.type === 'violation' && violation.kind, 'pin_missing_pre_apply');
  assert.equal(violation?.type === 'violation' && violation.blocked, false, 'fail-open, not fail-closed');
  // Turn 1 emitted none: nothing had been sent, so nothing could have drifted.
  assert.equal(h.events.filter((e) => e.type === 'violation').length, 1);
  await h.gateway.closeGracefully();
  await up.close();
});

test('drift telemetry names policy ids, not truncated constraint text', async () => {
  // constraintIds is a field callers join against, so it has to hold ids. It
  // once held the first 40 characters of the constraint text, which matched
  // nothing: not the policy, not another event, not a digest. This pins the
  // field's contents, which the drift test above never checked.
  const up = await startUpstream(echoJson);
  const h = await startGateway({}, up.url);
  await post(`${h.url}/v1/messages`, requestBody(''));
  await post(`${h.url}/v1/messages`, requestBody(''));

  const violation = h.events.find((e) => e.type === 'violation');
  assert.ok(violation, 'turn 2 drifts against turn 1');
  assert.equal(violation?.type === 'violation' && violation.kind, 'pin_missing_pre_apply');

  const ids = violation?.type === 'violation' ? violation.constraintIds : undefined;
  assert.deepEqual(ids, ['c1'], 'the drifted constraint must be identified by its policy id');
  assert.ok(
    !ids?.some((id) => id.includes(' ') || id.length > 8),
    `ids must not be prose: ${JSON.stringify(ids)}`,
  );
  await h.gateway.closeGracefully();
  await up.close();
});

test('the same request twice produces a byte-identical upstream body', async () => {
  const up = await startUpstream(echoJson);
  const h = await startGateway({}, up.url);
  await post(`${h.url}/v1/messages`, requestBody(''));
  await post(`${h.url}/v1/messages`, requestBody(''));
  assert.equal(up.calls[0]?.body, up.calls[1]?.body);
  await h.gateway.closeGracefully();
  await up.close();
});

test('the provider key is forwarded and a client-supplied one is not', async () => {
  const up = await startUpstream(echoJson);
  process.env['STRATA_TEST_KEY'] = 'sk-test-value';
  const h = await startGateway({}, up.url);
  await post(`${h.url}/v1/messages`, requestBody(''), { authorization: 'Bearer client-leak' });
  const headers = up.calls[0]?.headers ?? {};
  assert.equal(headers['x-api-key'], 'sk-test-value');
  assert.equal(headers['authorization'], undefined, 'a caller token must not ride along');
  delete process.env['STRATA_TEST_KEY'];
  await h.gateway.closeGracefully();
  await up.close();
});

// --------------------------------------------------------------- fail-open

test('an adapter that throws yields an unmodified passthrough, not a 502', async () => {
  const up = await startUpstream(echoJson);
  const broken: ProviderAdapter = {
    provider: 'openai-compat',
    supportsStreaming: true,
    toCanonical: () => {
      throw new Error('adapter exploded');
    },
    fromCanonical: () => ({}),
  };
  const body = '{"model":"m","messages":[]}';
  const h = await startGateway({ provider: 'openai-compat', adapters: { 'openai-compat': broken } }, up.url);
  const res = await post(`${h.url}/v1/messages`, body);
  assert.equal(res.status, 200, 'the context still reaches the provider');
  assert.equal(up.calls.length, 1);
  assert.equal(up.calls[0]?.body, body, 'byte-for-byte, not re-encoded');
  assert.equal(res.headers.get('x-strata-fail-open'), '1');
  const err = h.events.find((e) => e.type === 'error');
  assert.equal(err?.type === 'error' && err.failedOpen, true);
  assert.equal(err?.type === 'error' && err.message, 'adapter exploded');
  await h.gateway.closeGracefully();
  await up.close();
});

test('an upstream that cannot be reached is 502 JSON, not a hang', async () => {
  const h = await startGateway({}, 'http://127.0.0.1:1');
  const res = await post(`${h.url}/v1/messages`, requestBody(''));
  assert.equal(res.status, 502);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body['error'], 'upstream_unreachable');
  assert.ok(h.events.some((e) => e.type === 'error' && e.code === 'upstream_unreachable' && e.failedOpen === false));
  await h.gateway.closeGracefully();
});

// --------------------------------------------------------- streaming (N3)

test('an SSE response is forwarded chunk by chunk, never buffered', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const up = await startUpstream(async (_call, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"i":0}\n\n');
    await gate;
    res.write('event: content_block_delta\ndata: {"i":1}\n\n');
    res.end('data: [DONE]\n\n');
  });
  const h = await startGateway({}, up.url);

  const order: string[] = [];
  let firstArrived: () => void = () => undefined;
  const sawFirst = new Promise<void>((resolve) => {
    firstArrived = resolve;
  });
  const complete = new Promise<void>((resolve, reject) => {
    void httpRequest(`${h.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, agent: false }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (chunk.includes('message_start')) {
          order.push('first');
          firstArrived();
        }
        if (chunk.includes('content_block_delta')) {
          order.push('second');
          resolve();
        }
      });
      res.on('error', reject);
    }).on('error', reject).end(requestBody(''));
  });

  // Wait for the first frame rather than sleeping a fixed interval and hoping.
  // The upstream is still holding the second frame, so if the gateway buffered,
  // `complete` would still be pending at this point -- and a buffered proxy
  // passes every other test in this file. A sleep makes this assertion
  // non-deterministic under load: it failed only in full-suite runs, where the
  // event loop is busy enough that the first frame had not been parsed yet, and
  // `order` was still `[]`. The property under test is about ordering, not about
  // how long the machine took, so it is observed rather than waited for.
  //
  // Bounded, and deliberately so: with a genuinely buffering proxy `sawFirst`
  // never resolves, so an unbounded await turns this into a hang rather than a
  // failure. A regression that costs CI a timeout costs more than one that costs
  // it a red line, and the timeout is what keeps the distinction between "slow"
  // and "buffered" visible.
  await Promise.race([
    sawFirst,
    new Promise((_resolve, rejectRace) =>
      setTimeout(() => rejectRace(new Error('the first SSE frame never arrived')), 5_000),
    ),
  ]);
  assert.deepEqual(order, ['first'], 'the first frame arrived before the rest existed');
  release();
  await complete;
  assert.deepEqual(order, ['first', 'second']);
  await h.gateway.closeGracefully();
  await up.close();
});

test('the SSE content type and frames survive the proxy byte for byte', async () => {
  const frames = 'event: message_start\ndata: {"a":1}\n\nevent: x\ndata: {"b":2}\n\ndata: [DONE]\n\n';
  const up = await startUpstream((_call, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(frames);
  });
  const h = await startGateway({}, up.url);
  const res = await post(`${h.url}/v1/messages`, requestBody(''));
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  assert.equal(await res.text(), frames);
  await h.gateway.closeGracefully();
  await up.close();
});

// ------------------------------------------------------- graceful shutdown

test('closeGracefully waits for an in-flight request and then resolves', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const up = await startUpstream(async (_call, res) => {
    await gate;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const h = await startGateway({ drainMs: 5_000 }, up.url);
  const inflight = post(`${h.url}/v1/messages`, requestBody(''));
  // The request must be *on the server* before the drain starts: `close()`
  // stops accepting, so a fetch whose TCP connect has not landed yet is
  // refused, which is correct behaviour and the wrong thing to assert on.
  await waitFor('the request to reach the gateway', () => h.gateway.inflight === 1);

  let closed = false;
  const closing = h.gateway.closeGracefully().then(() => {
    closed = true;
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(closed, false, 'the drain has not given up early');
  assert.equal(h.gateway.draining, true);
  assert.equal(h.gateway.inflight, 1);

  release();
  const res = await inflight;
  assert.equal(res.status, 200, 'the in-flight request completed normally');
  await closing;
  assert.equal(closed, true);
  await up.close();
});

test('closeGracecibly cannot hang: the drain budget force-closes', async () => {
  const up = await startUpstream(() => {
    // Never answers. A client holding a stream open forever is the classic
    // "Ctrl-C does nothing" bug; the budget is what makes it a non-event.
    return new Promise<void>(() => undefined);
  });
  const h = await startGateway({ drainMs: 10_000 }, up.url);
  void post(`${h.url}/v1/messages`, requestBody('')).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.gateway.inflight, 1);

  const started = Date.now();
  await h.gateway.closeGracefully({ drainMs: 100 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3_000, `shutdown took ${elapsed}ms, expected the 100ms budget`);
  const forced = h.events.find((e) => e.type === 'error' && e.code === 'shutdown_forced');
  assert.ok(forced, 'a forced shutdown is reported, not silent');
  assert.match(String(forced?.type === 'error' && forced.message), /1 in-flight/);
  await up.close();
});

test('closeGracefully is idempotent and returns the same promise', async () => {
  const h = await startGateway();
  const a = h.gateway.closeGracefully();
  const b = h.gateway.closeGracefully();
  assert.equal(a, b, 'a second call joins the first shutdown rather than starting one');
  await a;
  await h.gateway.closeGracefully({ drainMs: 0 });
});

test('closeGracefully on a server that never listened resolves instead of throwing', async () => {
  const h = await startGateway();
  const closing = h.gateway.closeGracefully({ drainMs: 50 });
  await closing;
  assert.equal(h.gateway.listening, false);
});

test('a request that arrives after close began is refused with 503', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const up = await startUpstream(async (_call, res) => {
    await gate;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const h = await startGateway({ drainMs: 2_000 }, up.url);
  const port = Number(new URL(h.url).port);
  const sock = connect(port, '127.0.0.1');
  await new Promise<void>((r) => sock.once('connect', () => r()));

  const raw = (body: string): string =>
    `POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  let text = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    text += chunk;
  });
  sock.on('error', () => undefined);

  // A raw socket, because a second `fetch` cannot reach this path: Node
  // destroys idle keep-alive sockets on `close()` and the kernel refuses a new
  // connection, so a fresh client gets ECONNREFUSED rather than a 503. This
  // socket is mid-request when the drain starts, so it stays open -- and a
  // request that arrives on it afterwards is exactly the case the drain flag
  // exists for: serving it would be a gateway that kept taking traffic after
  // it promised it had stopped.
  sock.write(raw(requestBody('')));
  await waitFor('the first request to reach the gateway', () => h.gateway.inflight === 1);
  const closing = h.gateway.closeGracefully();
  assert.equal(h.gateway.draining, true);
  sock.write(raw(requestBody('')));

  release();
  await waitFor('the 503 behind the first response', () => text.includes('HTTP/1.1 503'));

  assert.match(text, /shutting_down/);
  assert.equal(up.calls.length, 1, 'the refused request never reached the provider');

  sock.destroy();
  await closing;
  await up.close();
});

// ------------------------------------------------------------- session cap

test('the session table is bounded', async () => {
  const up = await startUpstream(echoJson);
  const h = await startGateway({ maxSessions: 2 }, up.url);
  for (const id of ['a', 'b', 'c', 'd']) {
    await post(`${h.url}/v1/messages`, requestBody(''), { 'x-strata-session': id });
  }
  const body = (await (await get(`${h.url}/healthz`)).json()) as Record<string, unknown>;
  assert.equal(body['sessions'], 2, 'a client-supplied header cannot grow the map without bound');
  assert.equal(h.gateway.sessions, 2);
  await h.gateway.closeGracefully();
  await up.close();
});

// ------------------------------------------------------------- tier 0 wiring

test('the request path runs the Tier 0 stages, so outbound context is smaller than what arrived', async () => {
  // A tool_result above the default 20_000-char `tool_state` cap. The adapter
  // files tool_result under tool_state, so truncate has a cap to cut against.
  const flood = 'E'.repeat(40_000);
  const body = JSON.stringify({
    model: 'claude-test',
    max_tokens: 64,
    system: SYSTEM,
    messages: [
      { role: 'user', content: 'refactor the uploader' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: flood }] },
    ],
  });

  const up = await startUpstream(echoJson);
  const h = await startGateway({}, up.url);
  const res = await post(`${h.url}/v1/messages`, body);
  assert.equal(res.status, 200);

  // The proof is the bytes that left, not a telemetry event: an event can be
  // emitted for a stage that ran and changed nothing, and asserting on it would
  // pass against a gateway that forwards everything.
  assert.equal(up.calls.length, 1);
  const sent = up.calls[0]?.body ?? '';
  assert.ok(
    sent.length < body.length,
    `expected the outbound request to be smaller than the ${body.length}-byte inbound, got ${sent.length}`,
  );
  assert.ok(!sent.includes(flood), 'the over-cap tool output reached the upstream intact');

  const truncate = h.events.find((e) => e.type === 'stage' && e.stage === 'truncate');
  assert.equal(truncate?.type === 'stage' && truncate.changed, true, 'truncate reported no change');
  await h.gateway.closeGracefully();
  await up.close();
});

test('a pin survives the Tier 0 stages that run after it is computed', async () => {
  const flood = 'P'.repeat(40_000);
  const body = JSON.stringify({
    model: 'claude-test',
    max_tokens: 64,
    system: SYSTEM,
    messages: [
      { role: 'user', content: 'refactor the uploader' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: flood }] },
    ],
  });

  const up = await startUpstream(echoJson);
  const h = await startGateway({}, up.url);
  const res = await post(`${h.url}/v1/messages`, body);
  assert.equal(res.status, 200);

  // Pinning runs after the lossy stages. If it moved earlier, the constraint
  // would be filed under episodic and truncate would be free to cut it, so this
  // is the assertion that keeps the stage order a safety property rather than a
  // preference (docs/architecture.md §4).
  const sent = up.calls[0]?.body ?? '';
  assert.ok(sent.includes('never delete production data'), 'the pin was truncated away');
  assert.equal(res.headers.get('x-strata-pinned'), '1');
  await h.gateway.closeGracefully();
  await up.close();
});

test('with the lossy stages disabled the request is forwarded byte-identical', async () => {
  const flood = 'E'.repeat(40_000);
  const body = JSON.stringify({
    model: 'claude-test',
    max_tokens: 64,
    system: SYSTEM,
    messages: [
      { role: 'user', content: 'refactor the uploader' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: flood }] },
    ],
  });

  const noLossy = StrataPolicySchema.parse({
    ...policy,
    pipeline: { stages: ['pin'] },
  });

  const up = await startUpstream(echoJson);
  const h = await startGateway({ policy: noLossy }, up.url);
  const res = await post(`${h.url}/v1/messages`, body);
  assert.equal(res.status, 200);

  // "Byte-identical" means byte-identical. The pin buffer is re-emitted as a
  // separate system block, so the strict claim is that the flood survived
  // uncut: a stage that ran and found nothing to do would still satisfy a
  // comparison of the overflowed run alone.
  assert.ok((up.calls[0]?.body ?? '').includes(flood), 'truncate cut the block with the stage disabled');
  assert.equal(
    h.events.some((e) => e.type === 'stage' && e.stage === 'truncate'),
    false,
    'truncate reported a stage run that policy had disabled',
  );
  await h.gateway.closeGracefully();
  await up.close();
});
