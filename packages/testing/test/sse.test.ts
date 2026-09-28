import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FixtureError, parseSseStream, renderSseEvent, renderSseStream } from '../src/index.js';

import { dataFrame, frame, sseText } from './fixtures.js';

/**
 * The invariant this file exists to hold: what the recorder captured is what the
 * replay writes, byte for byte -- *including* a frame that was still in flight
 * when the connection died.
 *
 * The last part is the one that is easy to get wrong, and getting it wrong is
 * silent. A parser that "helpfully" completes a truncated final frame invents a
 * frame boundary, and a harness that invents one will report a clean
 * `message_stop` for a stream that never finished: the test goes green against a
 * failure the product would have shipped.
 */

const PROVIDER_STREAM = sseText(
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12}}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}',
  'event: message_stop\ndata: {"type":"message_stop"}',
) + '\n\n';

describe('SSE: round trip', () => {
  it('reproduces a provider stream byte for byte', () => {
    const bytes = Buffer.from(PROVIDER_STREAM, 'utf8');
    const parsed = parseSseStream(bytes);
    assert.equal(parsed.eol, '\n');
    assert.equal(parsed.events.length, 3);
    // The load-bearing assertion: same length, same order, same bytes.
    assert.deepEqual(renderSseStream(parsed.events, parsed.eol), bytes);
  });

  it('detects and preserves CRLF', () => {
    // SSE is LF by specification, but a provider behind a proxy can emit CRLF
    // and a replay that silently converted it would break the claim outright.
    const crlf = 'event: ping\r\ndata: {"type":"ping"}\r\n\r\n';
    const parsed = parseSseStream(crlf);
    assert.equal(parsed.eol, '\r\n');
    assert.deepEqual(renderSseStream(parsed.events, parsed.eol), Buffer.from(crlf, 'utf8'));
  });

  it('preserves event boundaries, not just the bytes', () => {
    // Same concatenated text, wrong boundaries, is a different stream: a
    // consumer would dispatch one event where the provider sent two.
    const parsed = parseSseStream(PROVIDER_STREAM);
    assert.deepEqual(
      parsed.events.map((e) => e.event),
      ['message_start', 'content_block_delta', 'message_stop'],
    );
    assert.ok(parsed.events.every((e) => e.complete), 'a well-formed stream has no cut frame');
  });

  it('joins a multi-line data payload and splits it back into data lines', () => {
    // The only way a newline survives a JSON round trip through a fixture is as
    // repeated `data:` lines, which is how the format encodes it.
    const text = 'data: line one\ndata: line two\n\n';
    const parsed = parseSseStream(text);
    assert.equal(parsed.events.length, 1);
    assert.equal(parsed.events[0]?.data, 'line one\nline two');
    assert.equal(renderSseStream(parsed.events, '\n').toString('utf8'), text);
  });

  it('keeps a comment frame rather than discarding it as a blank line', () => {
    const text = ': keep-alive\n\ndata: {"type":"ping"}\n\n';
    const parsed = parseSseStream(text);
    assert.equal(parsed.events.length, 2);
    assert.equal(parsed.events[0]?.comment, 'keep-alive');
    assert.equal(parsed.events[0]?.data, null, 'a comment frame carries no data field at all');
    assert.equal(renderSseStream(parsed.events, '\n').toString('utf8'), text);
  });

  it('distinguishes an empty payload from an absent one', () => {
    // `data:` with nothing after the colon is a real, empty payload. Collapsing
    // it into "no data field" would change what the consumer dispatches.
    const text = 'data:\n\n: only-a-comment\n\n';
    const parsed = parseSseStream(text);
    assert.equal(parsed.events[0]?.data, '');
    assert.equal(parsed.events[1]?.data, null);
    assert.equal(renderSseStream(parsed.events, '\n').toString('utf8'), text);
  });

  it('accepts a field written with no space after the colon', () => {
    const parsed = parseSseStream('event:ping\ndata:{"a":1}\n\n');
    assert.equal(parsed.events[0]?.event, 'ping');
    assert.equal(parsed.events[0]?.data, '{"a":1}');
    // One documented normalisation, disclosed in the module header: the replay
    // writes the spelling every real provider uses. Boundaries, ordering and
    // payload bytes are untouched; only the optional space is canonicalised.
    assert.equal(renderSseStream(parsed.events, '\n').toString('utf8'), 'event: ping\ndata: {"a":1}\n\n');
  });

  it('canonicalises a comment written without its space too', () => {
    const parsed = parseSseStream(':ping\n\n');
    assert.equal(parsed.events[0]?.comment, 'ping');
    assert.equal(renderSseStream(parsed.events, '\n').toString('utf8'), ': ping\n\n');
  });

  it('preserves an empty field value, which is legal SSE', () => {
    // An empty `event:` resets the event type. Rejecting it would make such a
    // stream unrecordable; dropping it would change the bytes.
    const text = 'event:\ndata: {"a":1}\n\n';
    const parsed = parseSseStream(text);
    assert.equal(parsed.events[0]?.event, '');
    assert.equal(renderSseStream(parsed.events, '\n').toString('utf8'), text);
  });

  it('preserves id and retry fields', () => {
    const text = 'id: 42\nretry: 3000\ndata: go\n\n';
    const parsed = parseSseStream(text);
    assert.equal(parsed.events[0]?.id, '42');
    assert.equal(parsed.events[0]?.retry, 3000);
    assert.equal(renderSseStream(parsed.events, '\n').toString('utf8'), text);
  });

  it('skips a leading blank line, which is not a dispatched event', () => {
    // Per the SSE dispatch rule a blank line with an empty buffer is not an
    // event. Recording it would preserve a byte no consumer can observe.
    const parsed = parseSseStream('\n\ndata: only\n\n');
    assert.equal(parsed.events.length, 1);
    assert.equal(parsed.events[0]?.data, 'only');
  });

  it('survives an empty stream', () => {
    const parsed = parseSseStream('');
    assert.deepEqual(parsed.events, []);
    assert.equal(parsed.eol, '\n');
  });
});

describe('SSE: the truncated tail', () => {
  it('marks a final unterminated frame incomplete and replays it without a blank line', () => {
    // The regression this file exists for. A complete stream ends `...\n\n`; a
    // cut stream ends after the last line break with no blank line. Completing
    // that frame would make a dead connection look like a clean `message_stop`.
    const cut = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_delta\ndata: {"type":"mes';
    const parsed = parseSseStream(cut);

    assert.equal(parsed.events.length, 2);
    assert.equal(parsed.events[0]?.complete, true);
    assert.equal(parsed.events[1]?.complete, false, 'the last frame was never terminated');

    const replayed = renderSseStream(parsed.events, parsed.eol);
    // Byte-exact for every complete line, and the cut frame stops short of a
    // terminator. The one byte that cannot be recovered is the frame's own final
    // line break, because a half-written line has no length to record; the
    // consumer's view (an undispatched trailing frame) is identical either way.
    assert.equal(replayed.toString('utf8'), `${cut}\n`);
    assert.ok(!replayed.toString('utf8').endsWith('\n\n'), 'no terminator was invented');
  });

  it('round-trips a stream cut after a complete line with no bytes changed', () => {
    // The common shape of a real cut: the socket died between frames, after the
    // last line break. Here nothing at all has to be reconstructed.
    const cut = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_delta\ndata: {"type":"message_delta"}\n';
    const parsed = parseSseStream(cut);

    assert.equal(parsed.events[1]?.complete, false);
    assert.deepEqual(renderSseStream(parsed.events, parsed.eol), Buffer.from(cut, 'utf8'));
  });

  it('treats a single trailing newline as a cut, not as a terminator', () => {
    // This is the distinction a naive split loses: the final empty segment of
    // `"a\n"` is the artifact of the line break, not a blank line.
    const parsed = parseSseStream('data: a\n');
    assert.equal(parsed.events.length, 1);
    assert.equal(parsed.events[0]?.complete, false);

    const terminated = parseSseStream('data: a\n\n');
    assert.equal(terminated.events[0]?.complete, true);
  });

  it('keeps every frame before the cut intact and in order', () => {
    const cut = sseText('event: a\ndata: 1', 'event: b\ndata: 2', 'event: c\ndata: 3') + '\n';
    const parsed = parseSseStream(cut);
    assert.deepEqual(
      parsed.events.map((e) => e.data),
      ['1', '2', '3'],
    );
    assert.deepEqual(
      parsed.events.map((e) => e.complete),
      [true, true, false],
    );
  });

  it('records a recorded delay without disturbing the bytes', () => {
    // The delay is replay pacing, not payload. It must not reach the wire.
    const slow = frame({ data: '{"a":1}', delayMs: 250, complete: false });
    assert.equal(renderSseEvent(slow, '\n'), 'data: {"a":1}\n');
  });
});

describe('SSE: refusing to lose information', () => {
  it('refuses an unrecognised field rather than dropping it', () => {
    // Dropping an unknown field silently would let a harness claim byte-exact
    // replay of a stream it did not fully understand.
    assert.throws(
      () => parseSseStream('sequence: 12\ndata: {"a":1}\n\n'),
      (err: unknown) => {
        assert.ok(err instanceof FixtureError);
        assert.match(err.message, /unrecognised field 'sequence'/);
        assert.match(err.message, /byte-exactly/);
        return true;
      },
    );
  });

  it('refuses a retry value that could not be written back as a number', () => {
    assert.throws(() => parseSseStream('retry: soon\ndata: x\n\n'), /'retry:soon'/);
    assert.throws(() => parseSseStream('retry: -1\ndata: x\n\n'), /'retry:-1'/);
  });

  it('names the frame index so a bad stream is locatable', () => {
    const text = sseText('data: ok', 'data: ok', 'sequence: 9\ndata: bad') + '\n\n';
    assert.throws(() => parseSseStream(text), /SSE frame 2/);
  });

  it('renders an empty event list to zero bytes', () => {
    assert.equal(renderSseStream([], '\n').byteLength, 0);
  });

  it('is idempotent: rendering a render does not drift', () => {
    const once = renderSseStream(parseSseStream(PROVIDER_STREAM).events, '\n');
    const twice = renderSseStream(parseSseStream(once).events, '\n');
    assert.deepEqual(twice, once);
  });
});

describe('SSE: rendering a recorded fixture frame', () => {
  it('writes the documented field order', () => {
    const rendered = renderSseEvent(
      frame({ event: 'message_stop', id: '7', retry: 100, comment: 'note', data: 'x' }),
      '\n',
    );
    assert.equal(rendered, 'event: message_stop\nid: 7\nretry: 100\n: note\ndata: x\n\n');
  });

  it('omits the data lines entirely for a frame that had no data field', () => {
    assert.equal(renderSseEvent(frame({ event: 'ping', data: null }), '\n'), 'event: ping\n\n');
  });
});

describe('SSE: multi-byte payloads', () => {
  it('keeps a non-ASCII payload intact through the round trip', () => {
    // Byte counts are byte counts. A fixture that re-encoded to a different
    // number of bytes would fail every byte-exactness assertion for a reason
    // that has nothing to do with the code under test.
    const payload = JSON.stringify({ text: 'héllo → 😀' });
    const parsed = parseSseStream(`data: ${payload}\n\n`);
    assert.equal(parsed.events[0]?.data, payload);
    assert.equal(renderSseStream(parsed.events, '\n').byteLength, Buffer.byteLength(`data: ${payload}\n\n`, 'utf8'));
  });
});

describe('SSE: the frame factory agrees with the parser', () => {
  it('round-trips a hand-built frame list', () => {
    const events = [
      frame({ event: 'message_start', data: '{"a":1}' }),
      frame({ comment: 'ping' }),
      frame({ event: 'message_stop', data: '{"b":2}' }),
    ];
    const rendered = renderSseStream(events, '\n');
    assert.deepEqual(parseSseStream(rendered).events, events);
  });

  it('round-trips a data-only frame list the fixtures actually use', () => {
    // `delayMs` is replay pacing, not payload, so the parser -- which only ever
    // sees bytes -- always reads it back as 0. The recorded delay lives in the
    // fixture, and `replay.test.ts` asserts it is honoured there.
    const events = [dataFrame('{"type":"a"}'), dataFrame('{"type":"b"}')];
    assert.deepEqual(parseSseStream(renderSseStream(events, '\n')).events, events);
  });
});
