import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PassThrough } from 'node:stream';

import {
  ByteRingTail,
  DEFAULT_TAIL_BYTES,
  SSE_EVENT_TYPES,
  SsePipeline,
  isSseEventType,
  parseSseFrames,
  pipeSseUpstream,
  type SseFrame,
  type SsePipelineOptions,
  type SseResult,
} from '../src/sse.js';

/**
 * A-12. SSE passthrough + self-gist ring-buffer tail.
 *
 * Fixtures are inline (development §2, rule P2: nothing here reaches into
 * another package's test directory, and no second fixture file is added to
 * this one). They are built as explicit strings with explicit line terminators
 * rather than by joining with `'\n'`, because the terminator *is* the subject:
 * a fixture assembled with the wrong one would assert nothing.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The reference stream: CRLF, a comment, a typed event, a multi-line `data:`
 * payload, an unknown field, unicode, an empty data value, a comment-only
 * frame, and a final frame the provider never terminated.
 */
const CRLF_FIXTURE = [
  ': ping',
  '',
  'event: message_start',
  'data: {"type":"message_start","id":"msg_01ABC"}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta",',
  'data: "index":0,',
  'data: "delta":{"text":"héllo 日本語 😀"}}',
  'x-vendor-trace: 7f3a',
  '',
  'data:',
  '',
  'data: {"type":"message_stop"}',
  '',
  'data: a frame the provider never te',
].join('\r\n');

/** The same content, LF-terminated. */
const LF_FIXTURE = CRLF_FIXTURE.replaceAll('\r\n', '\n');

/** The same content, bare-CR-terminated. The case a `split('\n\n')` breaks. */
const CR_FIXTURE = CRLF_FIXTURE.replaceAll('\r\n', '\r');

/** Small enough to sweep every split offset without a slow suite. */
const SWEEP_FIXTURE = [': hb', '', 'data: one', 'data: two', '', 'event: ping', 'data: 日本語', ''].join(
  '\r\n',
);

/**
 * Bytes that are not valid UTF-8. A passthrough that decoded and re-encoded --
 * even correctly, with a `StringDecoder` -- would replace these and the
 * response would differ, so this fixture is the direct test of "never decode".
 */
const BINARY_FIXTURE = Buffer.concat([
  Buffer.from('event: content_block_delta\r\n', 'utf8'),
  Buffer.from([0x00, 0xff, 0xfe, 0xc3, 0x28, 0x80, 0xed, 0xa0, 0x80]),
  Buffer.from('\r\ndata: done\r\n\r\n', 'utf8'),
]);

/* -------------------------------------------------------------------------- */
/* Harness                                                                      */
/* -------------------------------------------------------------------------- */

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Run {
  readonly out: Buffer;
  readonly result: SseResult;
  readonly frames: readonly SseFrame[];
  readonly pipe: SsePipeline;
}

const asParts = (chunks: string | Buffer | readonly Buffer[]): readonly Buffer[] =>
  Buffer.isBuffer(chunks)
    ? [chunks]
    : typeof chunks === 'string'
      ? [Buffer.from(chunks, 'utf8')]
      : chunks;

/**
 * Re-fragment a source into fixed-size pieces, so a single frame straddles many
 * chunks. A fixture delivered whole exercises the parser's happy path; this is
 * the shape a real provider produces, where a chunk boundary lands wherever the
 * socket happened to split.
 */
const trickle = (text: string, size: number): readonly Buffer[] => {
  const buf = Buffer.from(text, 'utf8');
  const parts: Buffer[] = [];
  for (let at = 0; at < buf.byteLength; at += size) parts.push(buf.subarray(at, at + size));
  return parts;
};

/** Feed `chunks` through a real pipe and collect what the client received. */
async function run(
  chunks: string | Buffer | readonly Buffer[],
  options: SsePipelineOptions = {},
): Promise<Run> {
  const upstream = new PassThrough();
  const downstream = new PassThrough();
  const received: Buffer[] = [];
  const frames: SseFrame[] = [];
  downstream.on('data', (c: Buffer) => received.push(c));

  const pipe = pipeSseUpstream(upstream, downstream, {
    onFrame: (f) => frames.push(f),
    ...options,
  });
  for (const part of asParts(chunks)) upstream.write(part);
  upstream.end();
  const result = await pipe.done();
  return { out: Buffer.concat(received), result, frames, pipe };
}

/** The same, but split at one offset. */
const splitAt = (buf: Buffer, at: number): readonly Buffer[] => [buf.subarray(0, at), buf.subarray(at)];

const listenerTotal = (...streams: readonly PassThrough[]): number =>
  streams.reduce(
    (n, s) =>
      n +
      ['data', 'end', 'error', 'drain', 'finish', 'close', 'unpipe', 'pause', 'resume'].reduce(
        (m, event) => m + s.listenerCount(event),
        0,
      ),
    0,
  );

/** Parse a string that must hold exactly one event, and return that event. */
const one = (text: string): SseFrame => {
  const { frames } = parseSseFrames(text);
  assert.equal(frames.length, 1, `expected one frame from ${JSON.stringify(text)}`);
  const frame = frames[0];
  assert.ok(frame !== undefined);
  return frame;
};

/* -------------------------------------------------------------------------- */
/* 1. Byte-exact passthrough                                                    */
/* -------------------------------------------------------------------------- */

describe('A-12 passthrough is byte-exact', () => {
  it('forwards a CRLF stream unchanged, comments, multi-line data and all', async () => {
    const { out } = await run(CRLF_FIXTURE);
    assert.equal(out.toString('utf8'), CRLF_FIXTURE);
    // The CRLF really is in the output. A passthrough that normalised line
    // endings would still pass the string comparison above if the fixture were
    // built by joining with '\n', which is why this one is not.
    assert.ok(out.includes(Buffer.from('\r\n', 'utf8')));
    assert.ok(!out.includes(Buffer.from(':\n', 'utf8')), 'a CRLF comment became an LF comment');
  });

  it('forwards an LF stream unchanged', async () => {
    const { out } = await run(LF_FIXTURE);
    assert.equal(out.toString('utf8'), LF_FIXTURE);
    assert.ok(!out.includes(Buffer.from('\r', 'utf8')), 'an LF stream gained a carriage return');
  });

  it('forwards a bare-CR stream unchanged', async () => {
    const { out } = await run(CR_FIXTURE);
    assert.equal(out.toString('utf8'), CR_FIXTURE);
    assert.ok(!out.includes(Buffer.from('\n', 'utf8')), 'a CR stream gained a newline');
  });

  it('forwards bytes that are not valid UTF-8 unchanged', async () => {
    // The decisive test for "never decode". `0xff`, a lone `0xc3` and a
    // surrogate-half `0xed 0xa0 0x80` all survive a decode/encode round trip as
    // U+FFFD replacements, so a lossy gateway differs from this by nine bytes.
    const { out } = await run(BINARY_FIXTURE);
    assert.deepEqual(out, BINARY_FIXTURE);
  });

  it('forwards a whole response delivered as a single chunk', async () => {
    const { out } = await run(CRLF_FIXTURE);
    assert.deepEqual(out, Buffer.from(CRLF_FIXTURE, 'utf8'));
  });

  it('forwards a response unchanged at every split offset', async () => {
    // Chunk boundaries are where a passthrough leaks: a buffer stitched per
    // chunk, a re-encoded chunk, or a parser that re-frames. Sweeping the
    // offsets is what makes "boundary-independent" a checked claim rather than
    // an assertion about the one offset that happens to work.
    const expected = Buffer.from(SWEEP_FIXTURE, 'utf8');
    for (let at = 1; at < expected.byteLength; at += 1) {
      const { out } = await run(splitAt(expected, at));
      assert.deepEqual(out, expected, `split at byte ${at}`);
    }
  });

  it('survives a multi-byte code point split across a chunk boundary', async () => {
    // Four bytes of UTF-8 for one emoji, cut in half. Decoding each chunk on its
    // own yields two replacement characters; not decoding yields the emoji.
    const body = Buffer.from('data: 😀 done\n\n', 'utf8');
    const at = body.indexOf(Buffer.from('😀', 'utf8')) + 2;
    const { out } = await run(splitAt(body, at));
    assert.deepEqual(out, body);
    assert.ok(!out.toString('utf8').includes('�'));
  });

  it('preserves a blank-line separator, including a doubled one', async () => {
    // `data:` followed by an empty line is a real event with an empty payload,
    // and the blank line after it is the *next* separator. Collapsing the pair
    // is the single most common way a hand-rolled SSE writer corrupts a stream.
    const src = 'data:\n\n\ndata: next\n\n';
    const { out, frames } = await run(src);
    assert.equal(out.toString('utf8'), src);
    assert.equal(frames.length, 2);
    assert.equal(frames[0]?.data, '');
    assert.equal(frames[1]?.data, 'next');
  });

  it('forwards a partial final frame without completing it', async () => {
    // The provider hung up mid-line. Inventing a terminator would put bytes on
    // the wire the client never received and make a truncated response look
    // complete, which is the failure mode that produces a gist nobody wrote.
    const { out, frames } = await run(CRLF_FIXTURE);
    assert.deepEqual(out, Buffer.from(CRLF_FIXTURE, 'utf8'));
    // Five lines, one of which is blank: four events, and the trailing partial
    // line contributes none.
    assert.deepEqual(frames.map((f) => f.data), [
      '{"type":"message_start","id":"msg_01ABC"}',
      '{"type":"content_block_delta",\n"index":0,\n"delta":{"text":"héllo 日本語 😀"}}',
      '',
      '{"type":"message_stop"}',
    ]);
    assert.equal(frames.every((f) => f.flushed === false), true);
  });

  it('reports a frame whose terminator never arrived, rather than losing it', async () => {
    // The provider got as far as the field and the payload and not as far as
    // the terminator. That *is* a frame, and at end of stream it is the last
    // thing the model said.
    const src = 'data: complete\n\ndata: never terminated\n';
    const { out, frames } = await run(src);
    assert.equal(out.toString('utf8'), src);
    assert.equal(frames.length, 2);
    assert.equal(frames[1]?.flushed, true, 'only end-of-stream may report a frame as unterminated');
    assert.equal(frames[1]?.data, 'never terminated');
  });

  it('reports the byte count it forwarded, with no error on a clean stream', async () => {
    const { result } = await run(CRLF_FIXTURE);
    assert.equal(result.bytesWritten, Buffer.byteLength(CRLF_FIXTURE, 'utf8'));
    assert.equal(result.error, null);
    assert.equal(result.closedEarly, false);
  });

  it('handles an empty stream without inventing anything', async () => {
    const { out, result, frames } = await run('');
    assert.equal(out.byteLength, 0);
    assert.equal(result.bytesWritten, 0);
    assert.equal(result.error, null);
    assert.deepEqual(frames, []);
  });

  it('does not forward a single byte twice', async () => {
    // A second `write()` per chunk -- which is what happens if a `data` handler
    // is added on top of `pipe()` rather than instead of it -- doubles the
    // response and looks, from the client's side, like the model repeating
    // itself. The count is the cheapest place to catch it.
    const { out } = await run(CRLF_FIXTURE);
    assert.equal(out.byteLength, Buffer.byteLength(CRLF_FIXTURE, 'utf8'));
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Streaming, not buffering                                                  */
/* -------------------------------------------------------------------------- */

describe('A-12 forwards as it reads', () => {
  it('delivers a chunk to the client before the upstream has ended', async () => {
    // The property architecture §9 names: no transform means time-to-first-
    // token is unaffected. If anything buffered the response to find a frame
    // boundary, `received` would be empty at this point.
    const upstream = new PassThrough();
    const downstream = new PassThrough();
    const received: string[] = [];
    downstream.on('data', (c: Buffer) => received.push(c.toString('utf8')));
    const pipe = pipeSseUpstream(upstream, downstream);

    upstream.write('data: first token\n\n');
    await tick();
    assert.deepEqual(received, ['data: first token\n\n'], 'nothing arrived while the stream was open');
    assert.equal(upstream.readableEnded, false);

    upstream.end('data: last\n\n');
    await pipe.done();
    assert.deepEqual(received, ['data: first token\n\n', 'data: last\n\n']);
  });

  it('delivers each chunk in order, without reordering or coalescing away order', async () => {
    const parts = ['a: 1\n\n', 'b: 2\n\n', 'c: 3\n\n', 'd: 4\n\n'];
    const upstream = new PassThrough();
    const downstream = new PassThrough();
    const received: string[] = [];
    downstream.on('data', (c: Buffer) => received.push(c.toString('utf8')));
    const pipe = pipeSseUpstream(upstream, downstream);
    for (const p of parts) {
      upstream.write(p);
      await tick();
      assert.equal(received.at(-1), p, 'a chunk did not arrive as it was written');
    }
    assert.deepEqual(received, parts);
    upstream.end();
    await pipe.done();
  });

  it('honours backpressure without losing or reordering a byte', async () => {
    // A destination with a one-byte high-water mark and no reader applies
    // backpressure on the very first write. Every byte still has to arrive, in
    // order, once a reader shows up.
    const parts: Buffer[] = Array.from({ length: 200 }, (_, i) =>
      Buffer.from(`data: {"index":${i},"text":"日本語"}\r\n\r\n`, 'utf8'),
    );
    const total = Buffer.concat(parts);
    const upstream = new PassThrough();
    const downstream = new PassThrough({ highWaterMark: 1 });
    const received: Buffer[] = [];
    const pipe = pipeSseUpstream(upstream, downstream);

    for (const p of parts) upstream.write(p);
    assert.equal(received.length, 0, 'nothing reached the client before a reader existed');

    downstream.on('data', (c: Buffer) => received.push(c));
    upstream.end();
    const result = await pipe.done();
    assert.deepEqual(Buffer.concat(received), total);
    assert.equal(result.bytesWritten, total.byteLength);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. The ring buffer                                                           */
/* -------------------------------------------------------------------------- */

describe('A-12 ByteRingTail', () => {
  const pushAll = (ring: ByteRingTail, chunks: readonly string[]): void => {
    for (const c of chunks) ring.push(Buffer.from(c, 'utf8'));
  };

  it('retains a stream that fits inside the bound', () => {
    const ring = new ByteRingTail(64);
    pushAll(ring, ['abc', 'def']);
    assert.equal(ring.toString(), 'abcdef');
    assert.equal(ring.size, 6);
    assert.equal(ring.dropped, 0);
    assert.equal(ring.truncated, false);
  });

  it('retains the last N bytes and evicts the oldest', () => {
    const ring = new ByteRingTail(5);
    pushAll(ring, ['abc', 'def', 'ghi']);
    assert.equal(ring.toString(), 'efghi', 'the front was dropped, not the back');
    assert.equal(ring.size, 5);
  });

  it('evicts across a partial chunk rather than dropping a whole one', () => {
    // A chunk-counted ring would drop all of 'def' here and retain 3 bytes.
    // The bound is bytes, so the bound is bytes.
    const ring = new ByteRingTail(5);
    pushAll(ring, ['abc', 'def', 'ghi']);
    assert.equal(ring.size, 5);
    assert.equal(ring.dropped, 4);
  });

  it('never exceeds its bound, at any point in a long stream', () => {
    const ring = new ByteRingTail(5000);
    const chunk = 'x'.repeat(1000);
    for (let i = 0; i < 200; i += 1) {
      ring.push(Buffer.from(chunk, 'utf8'));
      assert.ok(ring.size <= ring.capacity, `size ${ring.size} after push ${i + 1}`);
    }
    assert.equal(ring.size, 5000);
    assert.equal(ring.toString(), 'x'.repeat(5000));
  });

  it('bounds the same stream identically however it is fragmented', () => {
    // 200 KB of response, four different fragmentations. The retained tail and
    // the drop count are the last 5 KB either way; a chunk-counted ring is not.
    const total = 'abcdefgh'.repeat(25_000); // 200_000 chars
    const expected = total.slice(-5000);
    const fragmentations: readonly (readonly number[])[] = [
      [200_000],
      [1_000, 199_000],
      [7, 199_993],
      Array.from({ length: 400 }, () => 500),
    ];
    for (const sizes of fragmentations) {
      const ring = new ByteRingTail(5000);
      let at = 0;
      for (const size of sizes) {
        ring.push(Buffer.from(total.slice(at, at + size), 'utf8'));
        at += size;
      }
      assert.equal(ring.size, 5000, `sizes ${sizes.length}`);
      assert.equal(ring.toString(), expected, `sizes ${sizes.length}`);
      assert.equal(ring.dropped, 195_000, `sizes ${sizes.length}`);
    }
  });

  it('counts bytes, not characters, for a multibyte payload', () => {
    // '日本語' is 9 bytes and 3 characters, and 'abc' is 3 of each. A
    // `length`-based ring would retain 6 characters -- 12 bytes -- and quietly
    // double the memory it promised to bound.
    const ring = new ByteRingTail(6);
    ring.push(Buffer.from('日本語abc', 'utf8'));
    assert.equal(ring.size, 6);
    assert.equal(ring.toString(), '語abc');
    assert.equal(ring.dropped, 6);
  });

  it('replaces the ring with the tail of a chunk larger than the whole ring', () => {
    const ring = new ByteRingTail(8);
    pushAll(ring, ['keepme!']);
    assert.equal(ring.size, 7);
    ring.push(Buffer.from('0123456789abcdef', 'utf8'));
    assert.equal(ring.size, 8);
    assert.equal(ring.toString(), '89abcdef');
    assert.equal(ring.dropped, 7 + 16 - 8);
  });

  it('retains nothing at a bound of zero, and charges every byte as dropped', () => {
    const ring = new ByteRingTail(0);
    pushAll(ring, ['abc', 'de']);
    assert.equal(ring.size, 0);
    assert.equal(ring.toBuffer().byteLength, 0);
    assert.equal(ring.dropped, 5);
    assert.equal(ring.truncated, true);
  });

  it('clamps a nonsense bound instead of throwing', () => {
    // `tailBytes` comes from config, which is not a typechecked call site. A
    // memory bound that fails a request the gateway could serve is worse than
    // one that is too small.
    assert.equal(new ByteRingTail(-1).capacity, 0);
    assert.equal(new ByteRingTail(10.9).capacity, 10);
    assert.equal(new ByteRingTail(Number.NaN).capacity, 0);
    assert.equal(new ByteRingTail(Number.POSITIVE_INFINITY).capacity, 0);
  });

  it('keeps dropped plus size equal to everything pushed', () => {
    const ring = new ByteRingTail(37);
    let pushed = 0;
    for (let i = 0; i < 50; i += 1) {
      const chunk = `${i}-${'y'.repeat(i)}`;
      pushed += Buffer.byteLength(chunk, 'utf8');
      ring.push(Buffer.from(chunk, 'utf8'));
      assert.equal(ring.size + ring.dropped, pushed, `after push ${i + 1}`);
    }
  });

  it('hands out a copy, so a caller cannot mutate the ring through it', () => {
    const ring = new ByteRingTail(16);
    ring.push(Buffer.from('abcdef', 'utf8'));
    ring.toBuffer().fill(0x2e);
    assert.equal(ring.toString(), 'abcdef');
  });

  it('empties on clear but keeps the cumulative drop count', () => {
    // The drop count answers "did this response ever exceed the tail", which
    // only means anything as a running total over the buffer's life.
    const ring = new ByteRingTail(4);
    pushAll(ring, ['abcdef', 'gh']);
    assert.equal(ring.dropped, 4);
    ring.clear();
    assert.equal(ring.size, 0);
    assert.equal(ring.toString(), '');
    assert.equal(ring.dropped, 4);
    assert.equal(ring.truncated, true);
  });

  it('defaults to a bound that fits a self-gist and a burst of prose', () => {
    assert.ok(DEFAULT_TAIL_BYTES >= 4096, 'too small to hold a gist block');
    assert.ok(DEFAULT_TAIL_BYTES <= 64 * 1024, 'large enough to be a memory concern');
    const ring = new ByteRingTail(DEFAULT_TAIL_BYTES);
    ring.push(Buffer.alloc(DEFAULT_TAIL_BYTES + 1000, 0x61));
    assert.equal(ring.size, DEFAULT_TAIL_BYTES);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. The pipeline's tail                                                       */
/* -------------------------------------------------------------------------- */

describe('A-12 the pipeline tail', () => {
  it('retains the tail of the stream it forwarded', async () => {
    const { pipe, out } = await run(CRLF_FIXTURE, { tailBytes: 40 });
    const source = Buffer.from(CRLF_FIXTURE, 'utf8');
    assert.deepEqual(pipe.tail.toBuffer(), source.subarray(source.byteLength - 40));
    assert.equal(pipe.tailText, CRLF_FIXTURE.slice(-40));
    // The tail is a copy taken alongside the forward path, not a truncation of
    // it: the client got the whole thing.
    assert.deepEqual(out, source);
  });

  it('does not change what the client sees when the tail is far too small', async () => {
    // The whole point of bounding by bytes: a 4 KB tail against a 300 byte
    // response, evicting on nearly every push, is the worst case for the ring
    // and the best case for the guarantee.
    const { out, result } = await run(CRLF_FIXTURE, { tailBytes: 4 });
    assert.deepEqual(out, Buffer.from(CRLF_FIXTURE, 'utf8'));
    assert.equal(result.bytesWritten, Buffer.byteLength(CRLF_FIXTURE, 'utf8'));
  });

  it('retains nothing when the tail is disabled', async () => {
    const { out, pipe } = await run(CRLF_FIXTURE, { tailBytes: 0 });
    assert.equal(pipe.tail.size, 0);
    assert.equal(pipe.tailText, '');
    assert.deepEqual(out, Buffer.from(CRLF_FIXTURE, 'utf8'));
  });

  it('hands the observer a tail that is a parseable self-gist block', async () => {
    // The end-to-end shape A-12 exists to serve: the model writes its gist at
    // the end of the turn, so the block is inside the tail even though the
    // response was an order of magnitude past the bound. The gist rides as
    // multi-line `data:`, which is what the real protocol does and what makes
    // the frame join the interesting case.
    const body = 'data: {"type":"content_block_delta","delta":{"text":"working"}}\r\n\r\n'.repeat(60);
    const bodyBytes = Buffer.byteLength(body, 'utf8');
    const gist = [
      'data: ```ctx-gist',
      'data: goal: ship the parser',
      'data: next_command: npm test',
      'data: ```',
      '',
    ].join('\r\n');
    const { pipe, out, frames } = await run(`${body}${gist}`, { tailBytes: 512 });

    assert.ok(bodyBytes > 512 * 5, 'the fixture has to be well past the bound to mean anything');
    assert.ok(pipe.tail.size <= 512);
    assert.ok(pipe.tailText.includes('```ctx-gist'), 'the open sentinel was evicted');
    assert.ok(pipe.tailText.includes('next_command: npm test'), 'the last field was evicted');
    assert.equal(out.byteLength, bodyBytes + Buffer.byteLength(gist, 'utf8'));
    const gistFrame = frames.find((f) => f.data.includes('```ctx-gist'));
    assert.ok(gistFrame !== undefined, 'the observer never saw the gist frame');
    assert.equal(gistFrame.data, '```ctx-gist\ngoal: ship the parser\nnext_command: npm test\n```');
  });
});

/* -------------------------------------------------------------------------- */
/* 5. The observer                                                              */
/* -------------------------------------------------------------------------- */

describe('A-12 the frame observer', () => {
  it('reports frames in order, with multi-line data joined', async () => {
    // The fixture uses the provider's own event names, and the expectation is
    // that the gateway does *not* pass them through as trusted types. The names
    // are the client's business; the three the rest of the gateway reasons
    // about are what this reports, and an unrecognised one degrades to
    // `message` rather than being passed off as something it is not.
    const { frames } = await run(CRLF_FIXTURE);
    assert.deepEqual(
      frames.map((f) => [f.type, f.hasData, f.data]),
      [
        ['message', true, '{"type":"message_start","id":"msg_01ABC"}'],
        [
          'message',
          true,
          '{"type":"content_block_delta",\n"index":0,\n"delta":{"text":"héllo 日本語 😀"}}',
        ],
        [null, true, ''],
        [null, true, '{"type":"message_stop"}'],
      ],
    );
  });

  it('reports the frame raw, terminator included, for the gist sentinels', async () => {
    const { frames } = await run('event: x\r\ndata: a\r\n\r\n', { tailBytes: 64 });
    assert.equal(frames[0]?.raw, 'event: x\r\ndata: a\r\n\r\n');
    assert.equal(frames[0]?.flushed, false);
  });

  it('sees the same frames however the stream is fragmented', async () => {
    const expected = Buffer.from(SWEEP_FIXTURE, 'utf8');
    const whole = (await run(expected)).frames;
    for (let at = 1; at < expected.byteLength; at += 1) {
      const { frames } = await run(splitAt(expected, at));
      assert.deepEqual(frames, whole, `split at byte ${at}`);
    }
  });

  it('does not let a throwing observer end the response', async () => {
    // An observer that throws is a lost gist. It must not become a 500 on a
    // request the model is halfway through answering.
    const { out, result } = await run(CRLF_FIXTURE, {
      onFrame: () => {
        throw new Error('the gist parser is broken');
      },
    });
    assert.deepEqual(out, Buffer.from(CRLF_FIXTURE, 'utf8'));
    assert.equal(result.error, null);
  });

  it('stops observing a frame that outgrows its budget, and says so', async () => {
    // A provider streaming one enormous line must not be able to grow the
    // observer without bound. Trickled ten bytes at a time, because a frame that
    // arrives whole is dispatched whole and never accumulates a carry -- which
    // is the only reason the guard is not dead code in the common case.
    const src = `data: ${'z'.repeat(500)}\n\ndata: after\n\n`;
    const { out, frames, pipe } = await run(trickle(src, 10), { maxFrameBytes: 64 });
    assert.deepEqual(out, Buffer.from(src, 'utf8'), 'the forward path is untouched');
    assert.equal(pipe.observerOverflowed, true);
    assert.deepEqual(frames, [], 'the oversized frame was dropped, not truncated into a frame');
  });

  it('keeps the observer inert for the rest of the stream once it has overflowed', async () => {
    // Resuming mid-block would report a gist with a missing goal, and B-8 turns
    // a missing goal into a defect that never fires. Half a frame is worse than
    // none: the honest answer is "this turn has no gist".
    const src = `data: ${'z'.repeat(500)}\n\ndata: after\n\n`;
    const { frames, pipe } = await run(trickle(src, 10), { maxFrameBytes: 64 });
    assert.equal(pipe.observerOverflowed, true);
    assert.deepEqual(frames, []);
  });

  it('still observes a frame that fits inside the budget', async () => {
    // The control for the two above: same fragmentation, budget big enough.
    const src = `data: ${'z'.repeat(200)}\n\ndata: after\n\n`;
    const { frames, pipe } = await run(trickle(src, 10), { maxFrameBytes: 4096 });
    assert.equal(pipe.observerOverflowed, false);
    assert.deepEqual(frames.map((f) => f.data.length), [200, 5]);
  });

  it('hands the first chunk to onFirstBytes exactly once', async () => {
    const seen: string[] = [];
    await run(CRLF_FIXTURE, { onFirstBytes: (c) => seen.push(c.toString('utf8')) });
    assert.equal(seen.length, 1);
    assert.ok(CRLF_FIXTURE.startsWith(seen[0] ?? '\u0000'));
  });

  it('runs no observer at all when none is configured', async () => {
    const { out, result } = await run(CRLF_FIXTURE);
    assert.deepEqual(out, Buffer.from(CRLF_FIXTURE, 'utf8'));
    assert.equal(result.error, null);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Lifecycle                                                                 */
/* -------------------------------------------------------------------------- */

describe('A-12 lifecycle', () => {
  it('leaves no listener on either stream after a clean finish', async () => {
    const upstream = new PassThrough();
    const downstream = new PassThrough();
    const before = listenerTotal(upstream, downstream);
    const pipe = pipeSseUpstream(upstream, downstream);
    assert.ok(listenerTotal(upstream, downstream) > before, 'nothing was registered at all');
    upstream.write('data: x\n\n');
    upstream.end();
    await pipe.done();
    // Six requests, two streams, one long-lived server: a listener that
    // survives a stream is a leak that only shows up under concurrency.
    assert.equal(listenerTotal(upstream, downstream), before);
  });

  it('leaves no listener on either stream after close()', async () => {
    const upstream = new PassThrough();
    const downstream = new PassThrough();
    const before = listenerTotal(upstream, downstream);
    const pipe = pipeSseUpstream(upstream, downstream);
    upstream.write('data: x\n\n');
    await tick();
    pipe.close();
    await pipe.done();
    assert.equal(listenerTotal(upstream, downstream), before);
  });

  it('ends the destination on close() so the client sees a finished response', async () => {
    const upstream = new PassThrough();
    const downstream = new PassThrough();
    const received: Buffer[] = [];
    downstream.on('data', (c: Buffer) => received.push(c));
    const pipe = pipeSseUpstream(upstream, downstream);
    upstream.write('data: half\n\n');
    await tick();
    pipe.close();
    const result = await pipe.done();
    assert.equal(Buffer.concat(received).toString('utf8'), 'data: half\n\n');
    assert.equal(downstream.writableEnded, true);
    assert.equal(result.closedEarly, true);
    assert.equal(result.error, null);
  });

  it('closes cleanly before a single chunk has arrived', async () => {
    // A client that disconnects during connection setup is the case most likely
    // to leak, because the pipe was built and never used.
    const upstream = new PassThrough();
    const downstream = new PassThrough();
    const before = listenerTotal(upstream, downstream);
    const pipe = pipeSseUpstream(upstream, downstream);
    pipe.close();
    const result = await pipe.done();
    assert.equal(result.bytesWritten, 0);
    assert.equal(result.closedEarly, true);
    assert.equal(upstream.destroyed, true);
    assert.equal(listenerTotal(upstream, downstream), before);
  });

  it('is idempotent, and settles exactly once', async () => {
    const upstream = new PassThrough();
    const downstream = new PassThrough();
    const pipe = pipeSseUpstream(upstream, downstream);
    pipe.close();
    pipe.close();
    pipe.close();
    const result = await pipe.done();
    assert.equal(result.closedEarly, true);
    // A second settle would be a second resolve on a promise nobody is holding.
    await tick();
    assert.equal(downstream.writableEnded, true);
  });

  it('reports an upstream failure instead of throwing it', async () => {
    // A throw here becomes a truncated response with no explanation and, if it
    // escapes, an unhandled rejection that takes the process down mid-stream.
    const upstream = new PassThrough();
    const downstream = new PassThrough();
    downstream.resume();
    const pipe = pipeSseUpstream(upstream, downstream);
    upstream.write('data: half a respons');
    await tick();
    upstream.destroy(new Error('upstream reset by peer'));
    const result = await pipe.done();
    assert.equal(result.error?.message, 'upstream reset by peer');
    assert.equal(result.closedEarly, false);
  });

  it('stops reading the upstream when the destination fails', async () => {
    const upstream = new PassThrough();
    const downstream = new PassThrough();
    const pipe = pipeSseUpstream(upstream, downstream);
    upstream.write('data: x\n\n');
    await tick();
    downstream.destroy(new Error('client gone'));
    const result = await pipe.done();
    assert.equal(result.error?.message, 'client gone');
    assert.equal(upstream.destroyed, true);
  });

  it('settles a close() on a pipe that later sees an upstream error', async () => {
    // After close() nothing is listening, so an error arriving late has to be a
    // no-op rather than an unhandled 'error' event on a dead stream.
    const upstream = new PassThrough();
    upstream.on('error', () => undefined);
    const downstream = new PassThrough();
    const pipe = pipeSseUpstream(upstream, downstream);
    pipe.close();
    const result = await pipe.done();
    assert.equal(result.closedEarly, true);
    upstream.destroy(new Error('too late'));
    await tick();
  });

  it('surfaces a stream that is constructed and never used', async () => {
    const pipe = pipeSseUpstream(new PassThrough(), new PassThrough(), { tailBytes: 16 });
    const result = await Promise.race([pipe.done(), tick().then(() => 'pending')]);
    assert.equal(result, 'pending', 'done() resolved on an idle pipe');
    pipe.close();
    assert.equal((await pipe.done()).closedEarly, true);
  });
});

/* -------------------------------------------------------------------------- */
/* 7. The frame parser, on its own                                             */
/* -------------------------------------------------------------------------- */

describe('A-12 parseSseFrames', () => {
  it('parses an LF event', () => {
    const frame = one('data: hello\n\n');
    assert.equal(frame.data, 'hello');
    assert.equal(frame.type, null);
    assert.equal(frame.hasData, true);
  });

  it('parses CRLF without leaving a carriage return in the value', () => {
    // A parser that splits on '\n' alone puts '\r' at the end of every value,
    // which is invisible in a terminal and fatal to a JSON.parse downstream.
    const frame = one('data: hello\r\n\r\n');
    assert.equal(frame.data, 'hello');
  });

  it('parses bare-CR line endings', () => {
    const frame = one('data: hello\r\r');
    assert.equal(frame.data, 'hello');
  });

  it('accepts a stream that mixes all three terminators', () => {
    const frame = one('event: completion\rdata: one\ndata: two\r\r');
    assert.equal(frame.type, 'completion');
    assert.equal(frame.data, 'one\ntwo');
  });

  it('joins multi-line data with a newline, not a concatenation', () => {
    assert.equal(one('data: a\ndata: b\ndata: c\n\n').data, 'a\nb\nc');
  });

  it('strips exactly one leading space from a data value', () => {
    assert.equal(one('data:  two spaces\n\n').data, ' two spaces');
    assert.equal(one('data:none\n\n').data, 'none');
  });

  it('ignores comment lines without dispatching them', () => {
    const { frames } = parseSseFrames(': keep-alive\n: ping\n\n');
    assert.deepEqual(frames, [], 'a heartbeat is not an event');
    assert.equal(one(': hb\ndata: real\n\n').data, 'real');
  });

  it('ignores unknown fields but keeps the data around them', () => {
    const frame = one('event: x\nid: 7\nretry: 3000\nx-vendor: 1\ndata: payload\n\n');
    assert.equal(frame.data, 'payload');
  });

  it('ignores id and retry as frame content', () => {
    // They are stream state, not payload. A parser that folds them into the
    // event would hand the self-gist scanner a reconnection hint as prose.
    const frame = one('id: 42\nretry: 2500\ndata: only this\n\n');
    assert.equal(frame.data, 'only this');
  });

  it('treats a colonless data line as an empty value', () => {
    const frame = one('data\n\n');
    assert.equal(frame.hasData, true);
    assert.equal(frame.data, '');
  });

  it('dispatches an empty payload for a bare data line', () => {
    const frame = one('data:\n\n');
    assert.equal(frame.hasData, true);
    assert.equal(frame.data, '');
  });

  it('maps a known event name and degrades an unknown one to message', () => {
    assert.equal(one('event: error\ndata: x\n\n').type, 'error');
    assert.equal(one('event: completion\ndata: x\n\n').type, 'completion');
    assert.equal(one('event: something_new\ndata: x\n\n').type, 'message');
    assert.equal(one('event:\ndata: x\n\n').type, null, 'an empty name is the default, not a type');
  });

  it('parses several frames out of one chunk', () => {
    const { frames, carry } = parseSseFrames('data: a\n\ndata: b\n\ndata: c\n\n');
    assert.deepEqual(frames.map((f) => f.data), ['a', 'b', 'c']);
    assert.equal(carry, '');
    assert.equal(frames.every((f) => f.flushed === false), true);
  });

  it('returns nothing to carry when the text ends on a frame boundary', () => {
    const { carry, pending } = parseSseFrames('data: a\n\n');
    assert.equal(carry, '');
    assert.equal(pending, false);
  });

  it('reports an unterminated frame as flushed, with the bytes it has', () => {
    const { frames, carry, pending } = parseSseFrames('data: a\n\ndata: half\n');
    assert.equal(frames.length, 2);
    assert.equal(frames[1]?.flushed, true);
    assert.equal(frames[1]?.data, 'half');
    assert.equal(frames[1]?.raw, 'data: half\n', 'the raw is the frame without a terminator');
    assert.equal(carry, 'data: half\n');
    assert.equal(pending, true);
  });

  it('carries a partial line as neither a frame nor a pending one', () => {
    // Distinguishing the two is what lets a caller bound its own memory: a
    // partial line is the sender streaming one long line, an unterminated frame
    // is a frame still being filled in, and both are "keep accumulating" while
    // only the second is "there is an event here".
    const { frames, carry, pending } = parseSseFrames('data: a\n\ndata: par');
    assert.equal(frames.length, 1);
    assert.equal(carry, 'data: par');
    assert.equal(pending, false);
  });

  it('carries an unterminated frame when the caller wants to wait', () => {
    // A streaming caller mid-turn: "not terminated yet" is still true, and
    // dispatching would report a frame that a later chunk will still complete.
    const { frames, carry, pending } = parseSseFrames('data: half\n', { dispatchUnterminated: false });
    assert.deepEqual(frames, []);
    assert.equal(carry, 'data: half\n');
    assert.equal(pending, true);
  });

  it('treats a trailing CR as half a terminator rather than guessing', () => {
    // The chunk ended on a `\r` whose `\n` may be in the next one. Consuming it
    // reports the frame a byte early and puts a lone CR in its `raw`; ignoring
    // it when it really was a complete CR loses a line break. The only answer
    // that is right for both is to wait, which is what the carry is for.
    const held = parseSseFrames('data: a\n\ndata: b\r', { dispatchUnterminated: false });
    assert.deepEqual(held.frames.map((f) => f.data), ['a']);
    assert.equal(held.carry, 'data: b\r');

    // The next chunk's `\n` completes the CRLF, so `data: b` and `data: c` turn
    // out to be two lines of one frame. Consuming the CR early would have
    // dispatched `b` with a truncated body and then read the `\n` as a blank line.
    const rest = parseSseFrames('\ndata: c\r\n\r\n', { carried: held.carry });
    assert.deepEqual(rest.frames.map((f) => f.data), ['b\nc']);
    assert.equal(rest.carry, '');
  });

  it('carries a partial line that is not a frame at all', () => {
    const { frames, carry, pending } = parseSseFrames('data: par');
    assert.deepEqual(frames, []);
    assert.equal(carry, 'data: par');
    assert.equal(pending, false, 'no fields have been assembled yet');
  });

  it('resumes from a carry', () => {
    const first = parseSseFrames('data: par', { dispatchUnterminated: false });
    const second = parseSseFrames('tial\n\n', { carried: first.carry });
    assert.equal(second.frames.length, 1);
    assert.equal(second.frames[0]?.data, 'partial');
  });

  it('treats an empty input as no frames and no carry', () => {
    const { frames, carry, pending } = parseSseFrames('');
    assert.deepEqual(frames, []);
    assert.equal(carry, '');
    assert.equal(pending, false);
  });

  it('treats a stream of only blank lines as no events', () => {
    const { frames } = parseSseFrames('\n\n\n\r\n\r\n');
    assert.deepEqual(frames, []);
  });

  it('keeps a comment-prefixed first frame honest', () => {
    // A provider that prefixes a comment to the very first frame must not lose
    // the frame, and a parser that treats the comment as the frame's first line
    // would report an event with no data.
    const frame = one(': provider banner\nevent: completion\ndata: {"a":1}\n\n');
    assert.equal(frame.type, 'completion');
    assert.equal(frame.data, '{"a":1}');
  });

  it('preserves the raw bytes of each frame, terminator included', () => {
    const { frames } = parseSseFrames('event: a\r\ndata: 1\r\n\r\ndata: 2\n\n');
    assert.equal(frames[0]?.raw, 'event: a\r\ndata: 1\r\n\r\n');
    assert.equal(frames[1]?.raw, 'data: 2\n\n');
  });
});

/* -------------------------------------------------------------------------- */
/* 8. The event-type vocabulary                                                */
/* -------------------------------------------------------------------------- */

describe('A-12 event types', () => {
  it('exposes a frozen list the adapters and the parser agree on', () => {
    assert.deepEqual([...SSE_EVENT_TYPES], ['message', 'completion', 'error']);
    assert.ok(Object.isFrozen(SSE_EVENT_TYPES));
  });

  it('recognises exactly the names it lists', () => {
    for (const name of SSE_EVENT_TYPES) assert.equal(isSseEventType(name), true, name);
    for (const name of ['', 'Message', 'ping', 'toString', '__proto__']) {
      assert.equal(isSseEventType(name), false, name);
    }
  });

  it('does not resolve an inherited Object property as an event name', () => {
    // A bare `SSE_EVENT_TYPES.includes(x as SseEventType)` or a set built from a
    // plain object would say `constructor` is an event type.
    assert.equal(one('event: constructor\ndata: x\n\n').type, 'message');
  });
});
