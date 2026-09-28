import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { describe, it } from 'node:test';

import { hashCanonical } from '@strata-ctx/core-types';

import {
  FixtureError,
  createReplayServer,
  recordExchange,
  type FixtureEntry,
  type JsonValue,
} from '../src/index.js';

import { dataFrame, entry, sseText } from './fixtures.js';

/**
 * End to end, over a real socket.
 *
 * The unit tests prove the matcher and the renderer; these prove the two are
 * actually wired to an HTTP server, which is the only way the byte-exactness
 * claim means anything to a consumer. They also cover the two places a socket
 * can lie: a body larger than one TCP segment, and a stream cut mid-flight.
 *
 * Note the deliberate absence of an event-boundary assertion over the wire. Node
 * coalesces `res.write` calls into whatever the socket buffer allows, so chunk
 * *arrival* is not this package's contract. What it guarantees is the byte
 * sequence and the frame structure of the recorded stream, both asserted here.
 */

async function serve(t: TestContext, entries: readonly FixtureEntry[]): Promise<string> {
  const server = createReplayServer({ entries });
  const { origin } = await server.listen();
  t.after(() => {
    void server.close();
  });
  return origin;
}

const jsonPost = async (origin: string, body: unknown): Promise<Response> =>
  fetch(`${origin}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const post = (over: Record<string, JsonValue> = {}): Record<string, JsonValue> => ({
  model: 'claude-sonnet-4',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'hello' }],
  ...over,
});

describe('replay server: JSON', () => {
  it('serves the recorded response', async (t) => {
    const recorded = entry({ status: 201, responseBody: { id: 'msg_1', stop_reason: 'end_turn' } });
    const origin = await serve(t, [recorded]);

    const res = await jsonPost(origin, post());
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.deepEqual(await res.json(), { id: 'msg_1', stop_reason: 'end_turn' });
  });

  it('matches a request whose keys arrive in a different order', async (t) => {
    // The requirement, end to end. Whatever serialiser the client uses, the
    // canonical hash is the same request.
    const origin = await serve(t, [entry({ name: 'turn-1', body: post(), responseBody: { ok: 1 } })]);

    const res = await fetch(`${origin}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Same fields, reversed order, plus whitespace the client happened to add.
      body: JSON.stringify({ messages: [{ content: 'hello', role: 'user' }], max_tokens: 1024, model: 'claude-sonnet-4' }, null, 2),
    });

    assert.equal(res.status, 200, 'a re-serialised request is still the same request');
    assert.deepEqual(await res.json(), { ok: 1 });
  });

  it('matches a request carrying a credential the fixture never saw', async (t) => {
    // Why matching keys on the redacted body: CI has no key. A fixture that
    // matched on the raw body could only be replayed by the machine that
    // recorded it.
    const origin = await serve(t, [entry({ body: post({ api_key: '[REDACTED]' }) })]);

    const res = await jsonPost(origin, post({ api_key: 'sk-ant-ci-has-no-key' }));
    assert.equal(res.status, 200);
  });

  it('reads a body larger than one TCP segment before matching', async (t) => {
    // Regression. The body reader used to resolve its promise as soon as it had
    // *started* reading, so every request bigger than a single segment was
    // matched against a truncated prefix -- and a truncated prefix of a
    // recorded body either misses (confusing) or, worse, matches a different
    // fixture (invisible).
    const filler = 'y'.repeat(200_000);
    const big = post({ messages: [{ role: 'user', content: filler }] });
    const origin = await serve(t, [entry({ name: 'big', body: big, responseBody: { ok: true } })]);

    const res = await jsonPost(origin, big);
    const text = await res.text();
    assert.equal(res.status, 200, `expected a match; the server said: ${text.slice(0, 300)}`);
    assert.deepEqual(JSON.parse(text), { ok: true });
  });

  it('answers 501 with the reason for an unmatched request, and never a default', async (t) => {
    // A harness that answers unrecognised traffic with something plausible
    // reports green for a response nobody recorded.
    const origin = await serve(t, [entry({ name: 'turn-1', body: post(), responseBody: { ok: true } })]);

    const res = await jsonPost(origin, post({ model: 'claude-opus-4' }));
    assert.equal(res.status, 501);
    const text = await res.text();
    assert.match(text, /no fixture matches POST \/v1\/messages/);
    assert.match(text, /model: recorded "claude-sonnet-4" vs received "claude-opus-4"/);
    assert.notEqual(text, '{"ok":true}', 'and definitely not the recorded body');
  });

  it('hands the miss to the hook so a run can fail on it', async (t) => {
    // The response is a 501 either way, which is not enough on its own: a suite
    // that forgets to assert on the status would still be green. A harness that
    // wants the *run* to fail hooks this and throws.
    const seen: FixtureError[] = [];
    const server = createReplayServer({ entries: [entry({ body: post() })], onUnmatched: (e) => seen.push(e) });
    const { origin } = await server.listen();
    t.after(() => {
      void server.close();
    });

    await jsonPost(origin, post({ max_tokens: 1 }));
    assert.equal(seen.length, 1);
    assert.match(seen[0]?.message ?? '', /max_tokens/);

    await jsonPost(origin, post());
    assert.equal(seen.length, 1, 'a served request does not fire the hook');
  });

  it('preserves the ambiguity error rather than reporting it as a miss', async (t) => {
    // Re-wrapping it would send the reader hunting for a missing fixture instead
    // of a duplicate one, which is the opposite of the fix.
    const body = post();
    const seen: FixtureError[] = [];
    const server = createReplayServer({
      entries: [entry({ name: 'first', body }), entry({ name: 'second', body })],
      onUnmatched: (e) => seen.push(e),
    });
    const { origin } = await server.listen();
    t.after(() => {
      void server.close();
    });

    const res = await jsonPost(origin, body);
    assert.equal(res.status, 501);
    assert.match(seen[0]?.name ?? '', /FixtureAmbiguityError/);
    assert.match(await res.text(), /2 fixtures match/);
  });

  it('serves a GET with no body, matching the recorded null', async (t) => {
    const origin = await serve(t, [
      entry({ name: 'models', method: 'GET', path: '/v1/models', body: null, responseBody: { data: [] } }),
    ]);

    const res = await fetch(`${origin}/v1/models`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: [] });
  });
});

describe('replay server: streams', () => {
  it('replays a provider stream byte for byte, cut tail included', async (t) => {
    // The 3am case, reproduced on demand. The cut frame must arrive cut: a
    // consumer that sees a clean `message_stop` here will report a success the
    // product would never have had.
    const cut = sseText(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12}}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hel"}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ) + '\n';

    const recorded = recordExchange(
      { method: 'POST', path: '/v1/messages', body: JSON.stringify(post()) },
      { status: 200, headers: { 'content-type': 'text/event-stream' }, body: cut },
    );
    const origin = await serve(t, [recorded.entry]);

    const res = await jsonPost(origin, post());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.from(cut, 'utf8'));
  });

  it('replays a complete stream with every boundary intact', async (t) => {
    const full = sseText(
      'event: message_start\ndata: {"type":"message_start"}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"mock reply"}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ) + '\n\n';

    const origin = await serve(t, [entry({ events: [dataFrame('{"type":"message_start"}', { event: 'message_start' }), dataFrame('{"type":"content_block_delta","delta":{"text":"mock reply"}}', { event: 'content_block_delta' }), dataFrame('{"type":"message_stop"}', { event: 'message_stop' })] })]);

    const res = await jsonPost(origin, post());
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.from(full, 'utf8'));
  });

  it('replays CRLF streams without converting them', async (t) => {
    const crlf = 'event: ping\r\ndata: {"type":"ping"}\r\n\r\n';
    const origin = await serve(t, [entry({ events: [dataFrame('{"type":"ping"}', { event: 'ping' })], eol: '\r\n' })]);

    const res = await jsonPost(origin, post());
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.from(crlf, 'utf8'));
  });

  it('honours a recorded delay before the next frame', async (t) => {
    // A recorded stream has pacing, and a test that depends on streaming
    // behaviour (a first-token-time assertion, a client that aborts mid-stream)
    // cannot work against a replay that emits everything at once.
    const origin = await serve(t, [
      entry({ events: [dataFrame('{"type":"message_start"}', { delayMs: 0 }), dataFrame('{"type":"message_stop"}', { delayMs: 120 })] }),
    ]);

    const started = Date.now();
    const res = await jsonPost(origin, post());
    const bytes = Buffer.from(await res.arrayBuffer());
    const elapsed = Date.now() - started;

    assert.equal(bytes.toString('utf8'), 'data: {"type":"message_start"}\n\ndata: {"type":"message_stop"}\n\n');
    assert.ok(elapsed >= 100, `the recorded delay was not honoured (took ${elapsed}ms)`);
  });

  it('sends no content-length for a stream, so the client reads it incrementally', async (t) => {
    // A recorded length would be wrong for any fixture whose frames were edited,
    // and the failure mode is a hung client rather than a wrong assertion.
    const origin = await serve(t, [entry({ events: [dataFrame('{"a":1}')] })]);
    const res = await jsonPost(origin, post());
    assert.equal(res.headers.get('content-length'), null);
    assert.equal(res.headers.get('transfer-encoding'), 'chunked');
  });
});

describe('replay server: lifecycle', () => {
  it('binds an ephemeral port and releases it on close', async () => {
    const server = createReplayServer({ entries: [entry({ body: post() })] });
    const { origin, port } = await server.listen();
    assert.ok(port > 0);
    assert.equal(origin, `http://127.0.0.1:${port}`);
    await server.close();
    await assert.rejects(fetch(`${origin}/v1/messages`, { method: 'POST', body: '{}' }));
  });

  it('answers nothing rather than a default for an empty fixture set', async (t) => {
    const origin = await serve(t, []);
    const res = await jsonPost(origin, post());
    assert.equal(res.status, 501);
    assert.match(await res.text(), /Fixtures loaded: 0/);
  });

  it('keys a match on the canonical hash, so a reordered body hits the same entry', async (t) => {
    // Spelled as an end-to-end assertion because it is the property the whole
    // fixture design rests on: a fixture is a reviewable JSON document, and
    // reformatting or reordering one must not turn every test that uses it red.
    const body = post({ metadata: { user_id: 'u1' }, top_k: 5 });
    const origin = await serve(t, [entry({ name: 'turn-1', body, responseBody: { ok: true } })]);

    const reordered: Record<string, JsonValue> = {
      top_k: 5,
      metadata: { user_id: 'u1' },
      model: 'claude-sonnet-4',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hello' }],
    };
    // The premise, stated directly: the bytes on the wire differ, the canonical
    // form does not. Matching on the raw text would miss both of these.
    assert.notEqual(JSON.stringify(body), JSON.stringify(reordered));
    assert.equal(hashCanonical(body), hashCanonical(reordered));

    const res = await jsonPost(origin, reordered);
    assert.equal(res.status, 200, 'and yet the reordered body is the same request');
  });
});
