import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hashCanonical } from '@strata-ctx/core-types';

import {
  FixtureAmbiguityError,
  FixtureMatchError,
  REDACTED,
  canonicalizeRequest,
  diffJson,
  matchFixture,
  renderSseStream,
  replayFrames,
  requestContext,
  responseBytes,
  type FixtureEntry,
  type FixtureFrame,
  type JsonValue,
} from '../src/index.js';

import { dataFrame, entry, frame, sseText } from './fixtures.js';

const contextFor = (body: JsonValue, method = 'POST', path = '/v1/messages') =>
  requestContext({ method, path, body: JSON.stringify(body) });

const collect = (frames: Generator<FixtureFrame>): FixtureFrame[] => [...frames];

const chunkText = (frames: readonly FixtureFrame[]): string =>
  frames
    .filter((f): f is Extract<FixtureFrame, { kind: 'chunk' }> => f.kind === 'chunk')
    .map((f) => f.bytes.toString('utf8'))
    .join('');

describe('replay: the match key is the canonical hash', () => {
  it('matches a body whose keys are in a different order', () => {
    // The requirement, and the reason `hashCanonical` is used at all. A fixture
    // is a hand-edited reviewable document; if key order were part of the
    // match, every reformat would be a silent miss and every fixture a trap.
    const recorded: JsonValue = { model: 'claude-sonnet-4', max_tokens: 1024, stream: false };
    const reordered: JsonValue = { stream: false, max_tokens: 1024, model: 'claude-sonnet-4' };
    const nested: JsonValue = { a: { z: 1, y: { q: 2, p: 3 } } };
    const nestedReordered: JsonValue = { a: { y: { p: 3, q: 2 }, z: 1 } };

    const entries = [entry({ body: recorded, name: 'turn-1' }), entry({ body: nested, name: 'turn-2' })];

    assert.equal(hashCanonical(recorded), hashCanonical(reordered), 'the premise, stated directly');
    assert.equal(hashCanonical(nested), hashCanonical(nestedReordered));
    assert.equal(matchFixture(entries, contextFor(reordered)).name, 'turn-1');
    assert.equal(matchFixture(entries, contextFor(nestedReordered)).name, 'turn-2');
  });

  it('ignores whitespace and number spelling in the request', () => {
    const compact = requestContext({ method: 'POST', path: '/v1/messages', body: '{"a":1,"b":[2,3]}' });
    const pretty = requestContext({ method: 'POST', path: '/v1/messages', body: '{\n  "b": [2, 3],\n  "a": 1e0\n}\n' });
    assert.equal(compact.canonicalHash, pretty.canonicalHash);

    // `1` and `1.0` are the same JSON number. If they hashed differently, a
    // re-serialising client would miss every fixture.
    const integral = requestContext({ method: 'POST', path: '/v1/messages', body: '{"n":1}' });
    const decimal = requestContext({ method: 'POST', path: '/v1/messages', body: '{"n":1.0}' });
    assert.equal(integral.canonicalHash, decimal.canonicalHash);
  });

  it('normalises the method so a client library cannot break the match', () => {
    const lower = requestContext({ method: 'post', path: '/v1/messages', body: '{}' });
    const upper = requestContext({ method: 'POST', path: '/v1/messages', body: '{}' });
    assert.equal(lower.method, 'POST');
    assert.equal(matchFixture([entry({ body: {} })], lower).request.canonicalHash, upper.canonicalHash);
  });

  it('matches on the redacted body, so a fixture replays without the key', () => {
    const withKey: JsonValue = { model: 'm', api_key: 'sk-ant-0123456789abcdef' };
    const withOtherKey: JsonValue = { model: 'm', api_key: 'sk-ant-zzzzzzzzzzzzzzzz' };
    const redacted: JsonValue = { model: 'm', api_key: REDACTED };
    const entries = [entry({ name: 'redacted-turn', body: redacted })];

    assert.equal(matchFixture(entries, contextFor(withKey)).name, 'redacted-turn');
    assert.equal(matchFixture(entries, contextFor(withOtherKey)).name, 'redacted-turn');
    assert.notEqual(hashCanonical(withKey), hashCanonical(withOtherKey), 'raw hashing would have missed both');
  });

  it('redacts before hashing, so the request context never holds a credential', () => {
    const ctx = contextFor({ api_key: 'sk-ant-0123456789abcdef', model: 'm' });
    assert.ok(!JSON.stringify(ctx.redactedBody).includes('sk-ant-0123456789abcdef'));
    assert.equal((ctx.redactedBody as Record<string, JsonValue>)['api_key'], REDACTED);
  });

  it('canonicalizes an absent body to null, like JSON does', () => {
    assert.deepEqual(canonicalizeRequest({ method: 'GET', path: '/v1/models', body: '' }), null);
    assert.equal(requestContext({ method: 'GET', path: '/v1/models', body: '' }).canonicalHash, hashCanonical(null));
  });

  it('refuses a body it cannot parse rather than hashing the raw text', () => {
    // Hashing unparsed bytes would make a match depend on the exact serialiser
    // the client happened to use, and would skip redaction entirely.
    assert.throws(() => canonicalizeRequest({ method: 'POST', path: '/v1/messages', body: 'nope' }, 'the request'), /the request: body is not valid JSON/);
  });
});

describe('replay: unmatched requests fail loudly', () => {
  it('throws with a diff naming the field that diverged', () => {
    // A test that passes against the wrong fixture is worse than no test, so an
    // unmatched request must never resolve to something plausible.
    const entries = [entry({ name: 'turn-1', body: { model: 'claude-sonnet-4', max_tokens: 1024 } })];

    assert.throws(
      () => matchFixture(entries, contextFor({ model: 'claude-sonnet-4', max_tokens: 512 })),
      (err: unknown) => {
        assert.ok(err instanceof FixtureMatchError);
        assert.match(err.message, /no fixture matches POST \/v1\/messages/);
        assert.match(err.message, /turn-1/, 'the near miss is named');
        assert.match(err.message, /max_tokens: recorded 1024 vs received 512/, 'and the divergence is located');
        return true;
      },
    );
  });

  it('reports a key that is present in one body and not the other', () => {
    const entries = [entry({ name: 'turn-1', body: { model: 'm', top_p: 0.9 } })];
    // Recorded but not received: the request lost a parameter the capture needs.
    assert.throws(
      () => matchFixture(entries, contextFor({ model: 'm' })),
      /top_p: not present in the received body/,
    );
    // Received but not recorded: this is the more dangerous direction, because
    // it means the code under test sent something nobody ever captured.
    assert.throws(
      () => matchFixture(entries, contextFor({ model: 'm', extra: 1, top_p: 0.9 })),
      /extra: missing from the recorded body/,
    );
  });

  it('reports an array length mismatch rather than indexing past the end', () => {
    const entries = [entry({ name: 'turn-1', body: { messages: [{ role: 'user' }] } })];
    assert.throws(
      () => matchFixture(entries, contextFor({ messages: [] })),
      /messages: length 1 \(recorded\) vs 0 \(received\)/,
    );
  });

  it('says what it does cover when the path is not recorded at all', () => {
    const entries = [entry({ name: 'turn-1' }), entry({ name: 'models', method: 'GET', path: '/v1/models', body: {} })];
    assert.throws(
      () => matchFixture(entries, contextFor({}, 'POST', '/v1/complete')),
      (err: unknown) => {
        assert.ok(err instanceof FixtureMatchError);
        assert.match(err.message, /no fixture covers POST \/v1\/complete/);
        assert.match(err.message, /GET \/v1\/models, POST \/v1\/messages/, 'the covered set is listed');
        assert.match(err.message, /Nothing is returned for an unknown request on purpose/);
        return true;
      },
    );
  });

  it('does not confuse a method mismatch with a body mismatch', () => {
    const entries = [entry({ body: {}, method: 'GET', path: '/v1/models' })];
    assert.throws(() => matchFixture(entries, contextFor({}, 'POST', '/v1/models')), /no fixture covers POST/);
  });

  it('caps the number of near misses so a 30-turn session is still readable', () => {
    const entries = Array.from({ length: 9 }, (_, i) =>
      entry({ name: `turn-${i}`, body: { model: 'm', turn: i } }),
    );
    try {
      matchFixture(entries, contextFor({ model: 'm', turn: 99 }));
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(err instanceof FixtureMatchError);
      assert.match(err.message, /\.\.\.and 4 more on this path not shown/);
      assert.equal((err.message.match(/turn-/g) ?? []).length, 5, 'exactly the cap is shown');
    }
  });

  it('refuses to pick between two fixtures with the same body', () => {
    // A coin flip is not a test: it would make the suite pass or fail for
    // reasons that have nothing to do with the code under test.
    const entries = [entry({ name: 'first', body: { model: 'm' } }), entry({ name: 'second', body: { model: 'm' } })];
    assert.throws(
      () => matchFixture(entries, contextFor({ model: 'm' })),
      (err: unknown) => {
        assert.ok(err instanceof FixtureAmbiguityError);
        assert.match(err.message, /2 fixtures match/);
        assert.match(err.message, /first/);
        assert.match(err.message, /second/);
        return true;
      },
    );
  });

  it('has no default response to fall back on', () => {
    // Stated as an absence: the only outcomes for an unmatched request are a
    // throw and, for a path with no entries at all, a throw.
    assert.throws(() => matchFixture([], contextFor({})), FixtureMatchError);
    assert.throws(() => matchFixture([entry({ path: '/other', body: {} })], contextFor({})), FixtureMatchError);
  });
});

describe('replay: diffJson', () => {
  it('finds nothing between structurally equal values', () => {
    assert.equal(diffJson({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), null);
    assert.equal(diffJson(null, null), null);
    assert.equal(diffJson([1, [2, { a: 3 }]], [1, [2, { a: 3 }]]), null);
  });

  it('locates a divergence at a deep path', () => {
    assert.equal(diffJson({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } }), 'a.b.c: recorded 1 vs received 2');
  });

  it('distinguishes a type change from a value change', () => {
    assert.equal(diffJson({ a: 1 }, { a: '1' }), 'a: recorded 1 vs received "1"');
    assert.equal(diffJson({ a: null }, { a: 0 }), 'a: recorded null vs received 0');
  });

  it('truncates an enormous value so one miss does not bury the cause', () => {
    const huge = 'x'.repeat(500);
    const diff = diffJson({ a: huge }, { a: `${huge}y` });
    assert.ok(diff);
    // Two 160-char previews dominate the message, so the cap is on the order of
    // 2*PREVIEW_CHARS plus the fixed wording. What matters is that a 500-byte
    // body difference does not print 500 bytes of it.
    assert.ok(diff.length < 2 * 160 + 64, `diff was ${diff.length} chars`);
    assert.ok(diff.endsWith('...'), 'and says it was cut');
    assert.ok(diff.includes('recorded "xxx'), 'the start of the value is still shown');
  });
});

describe('replay: the frame generator', () => {
  it('emits head, one chunk, end for a JSON response', () => {
    const frames = collect(replayFrames(entry({ status: 201, responseBody: { ok: true } })));
    assert.deepEqual(
      frames.map((f) => f.kind),
      ['head', 'chunk', 'end'],
    );
    const head = frames[0];
    assert.equal(head?.kind === 'head' ? head.status : 0, 201);
    assert.equal(head?.kind === 'head' ? head.headers['content-type'] : '', 'application/json');
  });

  it('emits one chunk per SSE frame, in order, with the recorded pacing', () => {
    const e = entry({
      events: [
        dataFrame('{"type":"message_start"}', { delayMs: 0 }),
        dataFrame('{"type":"delta"}', { delayMs: 7 }),
        dataFrame('{"type":"message_stop"}', { delayMs: 3, complete: false }),
      ],
    });

    const frames = collect(replayFrames(e));
    assert.deepEqual(
      frames.map((f) => f.kind),
      ['head', 'chunk', 'chunk', 'chunk', 'end'],
    );
    const delays = frames.filter((f): f is Extract<FixtureFrame, { kind: 'chunk' }> => f.kind === 'chunk').map((f) => f.delayMs);
    assert.deepEqual(delays, [0, 7, 3], 'the deliberate pacing of a recorded stream survives');
    assert.equal(chunkText(frames), 'data: {"type":"message_start"}\n\ndata: {"type":"delta"}\n\ndata: {"type":"message_stop"}\n');
  });

  it('emits a truncated final frame without inventing a terminator', () => {
    const text = sseText('event: message_start\ndata: {"type":"message_start"}', 'event: delta\ndata: {"type":"delta"}') + '\n';
    const e = entry({ events: [dataFrame('{"type":"message_start"}', { event: 'message_start' }), dataFrame('{"type":"delta"}', { event: 'delta', complete: false })] });

    const rendered = chunkText(collect(replayFrames(e)));
    assert.equal(rendered, text, 'byte-exact against the capture');
    assert.ok(!rendered.endsWith('\n\n'), 'no message_stop was invented');
  });

  it('still yields a chunk for an unterminated frame that renders to zero bytes', () => {
    // Skipping empty chunks would swallow the cut entirely: the replay would
    // look like a stream that ended cleanly on the previous frame.
    const frames = collect(replayFrames(entry({ events: [dataFrame('a'), frame({ complete: false })] })));
    assert.deepEqual(
      frames.map((f) => f.kind),
      ['head', 'chunk', 'chunk', 'end'],
      'both frames are yielded, even the one that renders to nothing',
    );
    assert.equal(chunkText(frames), 'data: a\n\n', 'and the empty one contributes no bytes');
  });

  it('emits an empty stream as head then end', () => {
    const frames = collect(replayFrames(entry({ events: [] })));
    assert.deepEqual(
      frames.map((f) => f.kind),
      ['head', 'end'],
    );
  });

  it('carries CRLF through the generator unchanged', () => {
    const frames = collect(replayFrames(entry({ events: [dataFrame('{"a":1}')], eol: '\r\n' })));
    assert.equal(chunkText(frames), 'data: {"a":1}\r\n\r\n');
  });

  it('is the single replay path: generator bytes equal the fixture byte count', () => {
    // If these ever diverge, a byte-exactness test could pass against a renderer
    // the HTTP server does not use -- which is exactly how `responseBytes` used
    // to disagree with `sse.ts` on an empty field value.
    const e: FixtureEntry = entry({
      events: [dataFrame('{"a":1}', { event: 'a' }), dataFrame('{"b":2}', { event: 'b', complete: false })],
    });
    const frames = collect(replayFrames(e));
    const response = e.response;
    assert.equal(response.kind, 'sse');
    if (response.kind !== 'sse') return;
    assert.equal(chunkText(frames), renderSseStream(response.events, response.eol).toString('utf8'));
    assert.equal(Buffer.byteLength(chunkText(frames), 'utf8'), responseBytes(response));
  });
});
