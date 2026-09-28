import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { hashCanonical } from '@strata-ctx/core-types';

import {
  REDACTED,
  RedactionError,
  assertNoSecretsIn,
  buildFixtureFile,
  canonicalBodyHash,
  loadFixtureFile,
  looksLikeSse,
  recordExchange,
  recordToFile,
  redactSseStream,
  renderSseStream,
  type JsonValue,
} from '../src/index.js';

import {
  RECORDED_AT,
  TEST_API_KEY,
  TEST_BEARER,
  TEST_BODY_SECRET,
  TEST_SESSION_COOKIE,
  dataFrame,
  sseText,
  tempDir,
} from './fixtures.js';

/**
 * The recorder's contract, in one line: whatever it writes, anybody can commit.
 *
 * The assertions that matter are the ones reading the *file bytes* rather than
 * the in-memory entry. An entry that looks redacted is a claim; a file that does
 * not contain the secret is evidence. The second is the one that catches the
 * serialiser, the header encoder, and the field-name rules all at once.
 */

const post = (over: Record<string, JsonValue> = {}): Record<string, JsonValue> => ({
  model: 'claude-sonnet-4',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'hello' }],
  ...over,
});

describe('recorder: credential redaction', () => {
  it('redacts an Authorization header and an api_key body field', () => {
    const recorded = recordExchange(
      {
        method: 'post',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json', authorization: TEST_BEARER, cookie: TEST_SESSION_COOKIE },
        body: JSON.stringify(post({ api_key: TEST_BODY_SECRET })),
      },
      { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' },
    );

    assert.equal(recorded.entry.request.method, 'POST', 'the method is normalised for matching');
    assert.equal(recorded.entry.request.headers['authorization'], REDACTED);
    assert.equal(recorded.entry.request.headers['cookie'], REDACTED);
    assert.equal((recorded.entry.request.body as Record<string, JsonValue>)['api_key'], REDACTED);
    assert.deepEqual([...recorded.entry.redacted?.headers ?? []].sort(), ['authorization', 'cookie']);
    assert.deepEqual(recorded.entry.redacted?.bodyPaths, ['api_key']);
  });

  it('records the same canonical hash regardless of the credential used', () => {
    // The reason matching keys on the redacted body: a fixture has to be
    // replayable by a machine that does not hold the key it was recorded with.
    // Without this the only people who can run the eval suites are the ones
    // holding a live secret, and CI could never run them at all.
    const body = (key: string): string => JSON.stringify(post({ api_key: key }));
    const withA = recordExchange(
      { method: 'POST', path: '/v1/messages', headers: { 'x-api-key': 'sk-a' }, body: body('sk-aaaaaaaaaaaaaaaaaaaa') },
      { status: 200, body: '{}' },
    );
    const withB = recordExchange(
      { method: 'POST', path: '/v1/messages', headers: { 'x-api-key': 'sk-b' }, body: body('sk-bbbbbbbbbbbbbbbbbbbb') },
      { status: 200, body: '{}' },
    );

    assert.equal(withA.entry.request.canonicalHash, withB.entry.request.canonicalHash);
    assert.notEqual(withA.entry.request.rawCanonicalHash, withB.entry.request.rawCanonicalHash);
  });

  it('keeps the pre-redaction hash as provenance and never matches on it', () => {
    const body = post({ api_key: TEST_BODY_SECRET });
    const recorded = recordExchange(
      { method: 'POST', path: '/v1/messages', body: JSON.stringify(body) },
      { status: 200, body: '{}' },
    );

    assert.equal(recorded.entry.request.rawCanonicalHash, hashCanonical(body));
    assert.equal(recorded.entry.request.canonicalHash, canonicalBodyHash({ ...body, api_key: REDACTED }));
  });

  it('redacts a credential echoed back in a streamed data payload', () => {
    // `tools/mock-upstream.ts` echoes the request so a round trip is visible,
    // which is the cheapest way to see what went on the wire -- and it means a
    // provider that echoes will happily stream a credential straight back.
    const text = sseText('event: message_start\ndata: {"type":"message_start"}', 'event: echo\ndata: {"api_key":"' + TEST_BODY_SECRET + '","echo":"ok"}') + '\n\n';
    const recorded = recordExchange(
      { method: 'POST', path: '/v1/messages', body: JSON.stringify(post()) },
      { status: 200, headers: { 'content-type': 'text/event-stream' }, body: text },
    );

    const response = recorded.entry.response;
    assert.equal(response.kind, 'sse');
    if (response.kind !== 'sse') return;
    const echoed = response.events[1]?.data ?? '';
    assert.ok(!echoed.includes(TEST_BODY_SECRET), 'the streamed credential is gone');
    assert.ok(echoed.includes('"echo":"ok"'), 'the rest of the payload survived');
    assert.deepEqual(response.events[0]?.data, '{"type":"message_start"}', 'and the clean frame is untouched');
  });

  it('redacts a credential in a JSON response body', () => {
    const recorded = recordExchange(
      { method: 'POST', path: '/v1/messages', body: JSON.stringify(post()) },
      { status: 200, body: JSON.stringify({ session: { access_token: TEST_BEARER }, ok: true }) },
    );

    assert.ok(!JSON.stringify(recorded.entry.response).includes(TEST_BEARER));
    assert.deepEqual(recorded.entry.redacted?.bodyPaths, ['response.body.session.access_token']);
  });

  it('leaves a clean payload byte-identical rather than re-encoding it', () => {
    // Re-encoding an untouched frame would reflow its whitespace and defeat the
    // byte-exactness claim the whole package rests on.
    const events = [dataFrame('{"a" : 1 ,  "b":2}'), dataFrame('{"type":"message_stop"}')];
    const result = redactSseStream(events);
    assert.deepEqual(result.events, events, 'returned by identity, not rebuilt');
    assert.deepEqual(result.hits, []);
  });

  it('does not attempt to redact a non-JSON data payload', () => {
    // There is no key to match on in free text, and guessing at it is how a
    // redactor starts eating ordinary output.
    const events = [dataFrame('this mentions sk-not-json-12345 in prose')];
    const result = redactSseStream(events);
    assert.deepEqual(result.events, events);
    assert.deepEqual(result.hits, []);
  });
});

describe('recorder: the written file is provably clean', () => {
  it('writes a fixture whose bytes contain neither the header nor the body secret', (t) => {
    const dir = tempDir(t);
    const path = join(dir, 'recorded.json');

    const exchange = recordExchange(
      {
        method: 'POST',
        path: '/v1/messages',
        name: 'turn-1',
        headers: {
          'content-type': 'application/json',
          authorization: TEST_BEARER,
          'x-api-key': TEST_API_KEY,
          cookie: TEST_SESSION_COOKIE,
        },
        body: JSON.stringify(post({ api_key: TEST_BODY_SECRET, token: TEST_BEARER })),
      },
      { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' },
    );

    recordToFile([exchange], path, { name: 'recorded', provider: 'anthropic', recordedAt: RECORDED_AT });

    const bytes = readFileSync(path);
    const text = bytes.toString('utf8');
    // The three secrets, asserted absent from the bytes rather than from the
    // object. This is the test that fails if the serialiser, the header encoder
    // or a field-name rule regresses.
    assert.ok(!text.includes(TEST_BEARER), 'Authorization value is not in the file');
    assert.ok(!text.includes(TEST_API_KEY), 'x-api-key value is not in the file');
    assert.ok(!text.includes(TEST_SESSION_COOKIE), 'cookie value is not in the file');
    assert.ok(!text.includes(TEST_BODY_SECRET), 'api_key body value is not in the file');
    // And the redaction is visible, so a reviewer can see it happened.
    assert.ok(text.includes(REDACTED));
    assert.ok(text.includes('"authorization"'), 'the header name is kept, only the value is gone');

    // The result is a fixture this harness can read back.
    const reloaded = loadFixtureFile(path);
    assert.equal(reloaded.entries.length, 1);
    assert.equal(reloaded.entries[0]?.request.headers['authorization'], REDACTED);
  });

  it('writes nothing at all when the post-write scan finds a secret', (t) => {
    // This is the backstop for the case the field-name rules miss: a credential
    // sitting in a *value* under an innocuous key. The recorder is told which
    // values it removed; if any of them is still in the serialised bytes, the
    // write is refused. The scan sits before `writeFileSync` so a rejected file
    // never exists on disk, not even transiently for the next `git add -A`.
    const dir = tempDir(t);
    const path = join(dir, 'leaky.json');
    const inFreeText = 'sk-ant-0123456789-leaked-in-prose';

    const clean = recordExchange(
      { method: 'POST', path: '/v1/messages', body: JSON.stringify(post({ note: inFreeText })) },
      { status: 200, body: '{"ok":true}' },
    );
    // Simulate a redaction pass that decided this value was credential-shaped:
    // the scan must then find it still in the file and refuse the write.
    const claimed = { ...clean, secrets: [inFreeText] };

    assert.throws(() => recordToFile([claimed], path, { name: 'leaky', recordedAt: RECORDED_AT }), RedactionError);
    assert.equal(existsSync(path), false, 'no file, not even a rejected one');
  });

  it('does not claim to have redacted a value it merely failed to find', () => {
    // The honest limit of this layer, stated as an assertion so it cannot drift:
    // a credential in free text under an innocuous key is NOT caught here, and
    // the recorder says nothing in its audit trail to suggest otherwise. Value-
    // level redaction is `packages/security`'s job (suite E6, gate G9); this
    // package's job is the field-name rules plus the provable-absence scan.
    const inFreeText = 'sk-ant-0123456789-leaked-in-prose';
    const recorded = recordExchange(
      { method: 'POST', path: '/v1/messages', body: JSON.stringify(post({ note: inFreeText })) },
      { status: 200, body: '{"ok":true}' },
    );

    assert.equal(recorded.entry.redacted, undefined, 'no redaction is claimed');
    assert.deepEqual(recorded.secrets, [], 'and no secret is reported as removed');
    assert.ok(JSON.stringify(recorded.entry.request.body).includes(inFreeText), 'the text is genuinely still there');
  });

  it('explains which credential leaked without printing it', () => {
    try {
      assertNoSecretsIn(`{"token":"${TEST_BEARER}"}`, [TEST_BEARER]);
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(err instanceof RedactionError);
      assert.match(err.message, /1 un-redacted credential/);
      assert.ok(!err.message.includes(TEST_BEARER), 'the error must not reprint the secret');
      assert.match(err.message, /Bear|4 chars/);
    }
  });

  it('ignores values too short to prove absence of', () => {
    // Refusing to record because of a three-character value would make the
    // harness unusable; the field-name rules protect short secrets, this only
    // bounds what can be demonstrated.
    assert.doesNotThrow(() => assertNoSecretsIn('{"a":"abc"}', ['abc']));
    assert.doesNotThrow(() => assertNoSecretsIn('anything', []));
  });

  it('creates missing parent directories, because a corpus is nested by task', (t) => {
    const dir = tempDir(t);
    const path = join(dir, 'e1', 'constraint', 'turn-1.json');
    const exchange = recordExchange(
      { method: 'POST', path: '/v1/messages', body: JSON.stringify(post()) },
      { status: 200, body: '{"ok":true}' },
    );
    recordToFile([exchange], path, { name: 'turn-1', recordedAt: RECORDED_AT });
    assert.equal(loadFixtureFile(path).name, 'turn-1');
  });

  it('assembles a file that validates before it is ever written', () => {
    const file = buildFixtureFile([recordExchange({ method: 'POST', path: '/v1/messages', body: JSON.stringify(post()) }, { status: 200, body: '{}' }).entry], {
      name: 'assembled',
      provider: 'anthropic',
      recordedAt: RECORDED_AT,
    });
    assert.equal(file.fixtureFormatVersion, 1);
    assert.equal(file.provider, 'anthropic');
    assert.equal(file.name, 'assembled');
    assert.equal(file.entries.length, 1);
  });
});

describe('recorder: streams', () => {
  it('sniffs text/event-stream and records frames in order', () => {
    assert.equal(looksLikeSse({ 'Content-Type': 'text/event-stream; charset=utf-8' }), true);
    assert.equal(looksLikeSse({ 'content-type': 'application/json' }), false);
    assert.equal(looksLikeSse({}), false);

    const text = sseText(
      'event: message_start\ndata: {"type":"message_start"}',
      'event: content_block_delta\ndata: {"type":"delta","delta":{"text":"hi"}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ) + '\n\n';

    const recorded = recordExchange(
      { method: 'POST', path: '/v1/messages', body: JSON.stringify(post()) },
      { status: 200, headers: { 'content-type': 'text/event-stream' }, body: text },
    );

    const response = recorded.entry.response;
    assert.equal(response.kind, 'sse');
    if (response.kind !== 'sse') return;
    assert.deepEqual(
      response.events.map((e) => e.event),
      ['message_start', 'content_block_delta', 'message_stop'],
    );
    // Byte-exact: recording a stream and replaying it reproduces the capture.
    assert.deepEqual(renderSseStream(response.events, response.eol), Buffer.from(text, 'utf8'));
  });

  it('preserves a truncated tail instead of completing it', () => {
    // The 3am case. A socket that died mid-stream must replay as a stream that
    // died, or a test that consumes it reports a clean `message_stop` for a
    // response that never arrived.
    const cut = sseText('event: message_start\ndata: {"type":"message_start"}', 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}') + '\n';
    const recorded = recordExchange(
      { method: 'POST', path: '/v1/messages', body: JSON.stringify(post()) },
      { status: 200, headers: { 'content-type': 'text/event-stream' }, body: cut },
    );

    const response = recorded.entry.response;
    assert.equal(response.kind, 'sse');
    if (response.kind !== 'sse') return;
    assert.equal(response.events.length, 2);
    assert.equal(response.events[1]?.complete, false, 'no message_stop was invented');
    assert.deepEqual(renderSseStream(response.events, response.eol), Buffer.from(cut, 'utf8'));
  });

  it('records an empty stream as an empty stream', () => {
    const recorded = recordExchange(
      { method: 'POST', path: '/v1/messages', body: JSON.stringify(post()) },
      { status: 200, headers: { 'content-type': 'text/event-stream' }, body: '' },
    );
    assert.equal(recorded.entry.response.kind, 'sse');
    assert.equal(recorded.entry.response.kind === 'sse' ? recorded.entry.response.events.length : -1, 0);
  });

  it('records CRLF streams with their line endings intact', () => {
    const crlf = 'event: ping\r\ndata: {"type":"ping"}\r\n\r\n';
    const recorded = recordExchange(
      { method: 'POST', path: '/v1/messages', body: JSON.stringify(post()) },
      { status: 200, headers: { 'content-type': 'text/event-stream' }, body: crlf },
    );
    const response = recorded.entry.response;
    assert.equal(response.kind === 'sse' ? response.eol : '', '\r\n');
    assert.deepEqual(
      response.kind === 'sse' ? renderSseStream(response.events, response.eol) : Buffer.alloc(0),
      Buffer.from(crlf, 'utf8'),
    );
  });

  it('honours an explicit kind over the content-type', () => {
    // Some providers stream NDJSON or chunked JSON without the SSE header. The
    // override is what makes them recordable at all.
    const recorded = recordExchange(
      { method: 'POST', path: '/v1/messages', body: JSON.stringify(post()) },
      { status: 200, headers: { 'content-type': 'application/x-ndjson' }, body: '{"a":1}\n', kind: 'json' },
    );
    assert.equal(recorded.entry.response.kind, 'json');
  });

  it('refuses a stream it cannot represent rather than dropping a field', () => {
    assert.throws(
      () =>
        recordExchange(
          { method: 'POST', path: '/v1/messages', body: JSON.stringify(post()) },
          { status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'sequence: 1\ndata: {}\n\n' },
        ),
      /unrecognised field 'sequence'/,
    );
  });
});

describe('recorder: refusals', () => {
  it('refuses a request body that is not JSON', () => {
    // A body we cannot parse is a body we cannot redact, and an unredacted body
    // is the one failure mode that must never be papered over.
    assert.throws(
      () =>
        recordExchange(
          { method: 'POST', path: '/v1/messages', body: 'not json at all' },
          { status: 200, body: '{}' },
        ),
      /body is not valid JSON/,
    );
  });

  it('refuses a response body that is not JSON when it is not a stream', () => {
    assert.throws(
      () =>
        recordExchange(
          { method: 'POST', path: '/v1/messages', body: JSON.stringify(post()) },
          { status: 502, headers: { 'content-type': 'text/html' }, body: '<html>bad gateway</html>' },
        ),
      /response to POST \/v1\/messages: body is not valid JSON/,
    );
  });

  it('treats an empty request body as null, the way JSON does', () => {
    // Otherwise the recorder and the replayer disagree about the hash of a GET.
    const recorded = recordExchange(
      { method: 'GET', path: '/v1/models', body: '' },
      { status: 200, body: '{"data":[]}' },
    );
    assert.equal(recorded.entry.request.body, null);
    assert.equal(recorded.entry.request.canonicalHash, hashCanonical(null));
  });

  it('accepts a Buffer body as well as a string', () => {
    const recorded = recordExchange(
      { method: 'POST', path: '/v1/messages', body: Buffer.from(JSON.stringify(post()), 'utf8') },
      { status: 200, body: Buffer.from('{"ok":true}', 'utf8') },
    );
    assert.equal(recorded.entry.request.canonicalHash, hashCanonical(post()));
  });

  it('records a stream with no invented timing', () => {
    // A capture has no timing to preserve, and a synthesised delay would make
    // every replay slower than the recording for no reason. Deliberate pacing
    // is something a fixture *declares* (`replay.test.ts` honours it), never
    // something the recorder invents.
    const text = 'data: {"a":1}\n\nevent: done\ndata: {"b":2}\n\n';
    const recorded = recordExchange(
      { method: 'POST', path: '/v1/messages', body: JSON.stringify(post()) },
      { status: 200, headers: { 'content-type': 'text/event-stream' }, body: text },
    );
    const response = recorded.entry.response;
    assert.equal(response.kind, 'sse');
    if (response.kind !== 'sse') return;
    assert.deepEqual(
      response.events.map((e) => e.delayMs),
      [0, 0],
    );
    assert.deepEqual(renderSseStream(response.events, response.eol), Buffer.from(text, 'utf8'));
  });
});
