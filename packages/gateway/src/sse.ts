import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/**
 * A-12. SSE passthrough, plus the bounded tail a self-gist is read out of.
 *
 * ## The one promise this module makes
 *
 * Whatever the client receives is byte-identical to what the provider sent.
 * Not "equivalent", not "re-serialised with the same fields": the same bytes,
 * in the same order, with the same line endings, arriving as they arrive. That
 * is stronger than a normal passthrough guarantee, and it is stronger on
 * purpose. A `text/event-stream` is a sequence of *framing* decisions that a
 * provider and an SDK have already agreed on -- `\r\n` vs `\n`, a `retry:` that
 * some clients honour and some ignore, a `data:` value with a leading space
 * that is not part of the payload, a lone `\r` inside a payload that is not a
 * line break at all. Re-serialising means re-deciding all of it, and every
 * re-decision is a way to hand a client a stream its SDK mis-parses. A gateway
 * that cannot transform a response cannot corrupt one either.
 *
 * So the rules this file follows are all consequences of that:
 *
 * - **Never decode.** The chunk `Buffer` a provider produced is the chunk
 *   object that reaches `write()`. No `toString('utf8')`, no re-`Buffer.from`,
 *   no `StringDecoder` in the forward path. A code point split across two TCP
 *   chunks survives, because nothing ever looked at the text.
 * - **Never buffer.** The forward path is a `write()` per upstream chunk. There
 *   is no "wait for a frame" step anywhere, because a frame boundary is
 *   something the *sender* knows and the gateway does not.
 * - **Never re-frame.** Not a `retry:`, not a comment, not a `:` line, not a
 *   `data:` continuation. The only thing this file knows about framing is what
 *   it must *not* disturb.
 *
 * ## Where the observation happens instead
 *
 * Reading the stream is still necessary -- the self-gist block (B-8) is written
 * by the model inside its own response, so somebody has to look for it, and the
 * architecture (§9) is explicit that a turn which never emits one must cost
 * nothing. The resolution is that observation is a *torn read* of a copy:
 *
 * - `ByteRingTail` keeps the last N **bytes** and drops the oldest when it is
 *   full. N is a bound, not a window: a response that runs to 40 MB leaves 8 KB
 *   retained, because the ring drops from the front and the front is old.
 * - The frame parser reads that copy. It is `parseSseFrames`, and it is a
 *   correct incremental parser, which matters more than it sounds: a naive
 *   `split('\n\n')` is wrong on CRLF, wrong on a `\r\n` inside a payload, and
 *   wrong on a frame that straddles a chunk boundary, and a self-gist detector
 *   built on one of those misses the block it exists to find.
 *
 * The two paths share nothing. The tail is written before the forward write and
 * is read by nobody the client can observe; the forward path never reads the
 * tail. There is no buffer, no "wait for enough bytes" decision, and no
 * reordering between them, so the ring cannot be the reason a token is late.
 *
 * ## Failure is toward more context
 *
 * N5, and the same posture as the rest of the gateway. An upstream error ends
 * the pipe and is *reported* in `SseResult.error`; it is never thrown at a
 * caller that may not be ready for it, and `done()` never rejects, because a
 * rejected promise nobody is currently holding is an unhandled rejection and
 * an unhandled rejection in a proxy is a process that exits mid-stream. The
 * bytes already forwarded stay forwarded -- a partial response that the client
 * can still parse beats a 500 it cannot.
 *
 * ## Handoff to B-8
 *
 * `SsePipeline.tailText()` is the string to hand to
 * `parseSelfGistDirective` when a turn ends. It is not imported here: rule P1
 * makes `core-types` the only cross-stream contract, and the pipeline package is
 * not a contract. The bound is duplicated as a number, deliberately, for the
 * same reason.
 */

/* -------------------------------------------------------------------------- */
/* The frame parser                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Event names a provider may declare on an `event:` line.
 *
 * The wire format does not have an enum here -- the spec says the field value
 * is whatever the sender chose, and a sender we have not met is not an error.
 * These three are what the provider adapters in this package emit and what
 * `event: unknown` degrades to. A name outside the set is reported as
 * `null`/`'message'` rather than passed through verbatim, because the *value*
 * is the client's business and this file's job is to say whether it can be
 * trusted as one of the three the rest of the gateway reasons about.
 */
export type SseEventType = 'message' | 'completion' | 'error';

export const SSE_EVENT_TYPES: readonly SseEventType[] = Object.freeze([
  'message',
  'completion',
  'error',
]);

export const isSseEventType = (v: string): v is SseEventType =>
  (SSE_EVENT_TYPES as readonly string[]).includes(v);

/**
 * One dispatched event.
 *
 * `data` is the *joined payload*, with the framing removed: the single leading
 * space after `data:` is stripped from each line and the lines are joined with
 * `\n`, which is what makes a multi-line `data:` block one string. `raw` is the
 * bytes the frame occupied on the wire, terminator included, for the
 * self-gist path where the fenced block has to be found *inside* the payload
 * with its own sentinels intact.
 */
export interface SseFrame {
  /**
   * The declared `event:` name when it is one we recognise. `null` when the
   * frame declared none, which the spec makes equivalent to `message`.
   */
  readonly type: SseEventType | null;
  /** False when the frame carried no `data:` line at all, so `data` is empty. */
  readonly hasData: boolean;
  /** `data` lines joined with `\n`, one leading space stripped from each. */
  readonly data: string;
  /**
   * The frame's own bytes. A frame dispatched by a blank line carries its
   * terminator; a flushed one carries everything it has, which cannot include a
   * terminator because none arrived. This is the field the self-gist path reads,
   * because the fenced block has to be found inside the payload with its own
   * sentinels intact.
   */
  readonly raw: string;
  /**
   * True when the frame was produced by end-of-stream rather than by a blank
   * line: a provider that closed the connection mid-frame. The bytes are real
   * and are reported, because a partial final frame is ordinary in a stream
   * that got cut short and dropping it would lose the last thing the model
   * said.
   */
  readonly flushed: boolean;
}

export interface ParseSseResult {
  /** Frames dispatched by this call, in order. */
  readonly frames: readonly SseFrame[];
  /**
   * Bytes of an unterminated frame the caller must prepend to the next call.
   * Empty when the text ended on a frame boundary. Note this is *decoded* text,
   * which is the one place in this module where a split code point can be lost;
   * the forward path is unaffected and that is the path the client is on.
   */
  readonly carry: string;
  /**
   * True when `carry` holds a frame that has fields but no terminator yet, as
   * opposed to a partial line that is not a frame at all. A caller bounding its
   * own memory uses this to tell "keep accumulating" from "the sender is
   * streaming one very long line".
   */
  readonly pending: boolean;
}

export interface ParseSseOptions {
  /** Unterminated text from a previous call. Prepended before parsing. */
  readonly carried?: string;
  /**
   * Dispatch a frame that the text ends in the middle of. Default true, which
   * is the end-of-stream case: the stream is finished, so "not terminated yet"
   * is no longer true of anything. A streaming caller that wants to hold the
   * open frame until a later chunk passes false and reads `pending` instead.
   */
  readonly dispatchUnterminated?: boolean;
}

const CR = 13;
const LF = 10;
const COLON = 58;
const SPACE = 32;

/**
 * The index just past the line ending that starts at `i`, or -1.
 *
 * All three terminators, because the spec allows all three and a `\r` on its own
 * is a real thing on the wire: it is what a naive `\n` splitter leaves glued to
 * the front of the next line's payload, which turns `data: a\rdata: b` into
 * `data: a\rdata: b` -- one field, value `a\rdata: b` -- and quietly corrupts
 * every multi-line payload sent with CR endings.
 *
 * A `\r` in the *last* position is deliberately reported as -1. It may be the
 * first half of a `\r\n` whose `\n` is in the next chunk, and that is not a
 * distinction the parser can be allowed to get wrong by guessing: treating it as
 * complete reports the frame one byte early, puts a lone `\r` in the frame's
 * `raw`, and -- if the next chunk does start with `\n` -- makes that `\n` look
 * like a blank line on its own. Leaving it for the next call costs nothing and
 * is the only answer that is right for both readings.
 */
function endOfLine(source: string, i: number): number {
  const c = source.charCodeAt(i);
  if (c === CR) {
    if (i + 1 >= source.length) return -1;
    return source.charCodeAt(i + 1) === LF ? i + 2 : i + 1;
  }
  return c === LF ? i + 1 : -1;
}

interface FrameFields {
  type: SseEventType | null;
  data: string[];
  hasData: boolean;
}

const emptyFields = (): FrameFields => ({ type: null, data: [], hasData: false });

/**
 * Fold one line into the fields of the frame being assembled.
 *
 * Written as a switch on the field name rather than as a set of `if`s so that
 * "ignore unknown fields" is the *default* branch. That is the spec's rule and
 * it is the important one: `id:`, `retry:` and whatever a provider invents next
 * year must all land somewhere harmless, and the only harmless place is a
 * branch that does nothing.
 */
function consumeLine(line: string, fields: FrameFields): void {
  // A leading colon is a comment. It is not a field with an empty name, and
  // treating it as one is how a heartbeat turns into a frame with no data.
  if (line.charCodeAt(0) === COLON) return;

  const colon = line.indexOf(':');
  const field = colon === -1 ? line : line.slice(0, colon);
  if (colon === -1) {
    // `data` with no colon is a field with an empty value, per spec. It still
    // counts as a data line, so it dispatches an event with an empty payload.
    if (field === 'data') {
      fields.hasData = true;
      fields.data.push('');
    }
    return;
  }

  const after = line.slice(colon + 1);
  // Exactly one leading space is part of the framing. Not `.trim()`: a payload
  // that legitimately starts with a space loses exactly one of its two.
  const value = after.charCodeAt(0) === SPACE ? after.slice(1) : after;

  switch (field) {
    case 'event':
      // An empty value resets to the default rather than setting an empty
      // event type, which is what the spec's dispatch step then does anyway.
      if (value.length > 0) fields.type = isSseEventType(value) ? value : 'message';
      return;
    case 'data':
      fields.hasData = true;
      fields.data.push(value);
      return;
    // `id` and `retry` are stream-level state, not frame content. Last-one-wins
    // per spec; keeping only the last is what a correct parser owes them, and
    // dropping them here is what stops a reconnect hint from being mistaken
    // for a payload. The id is not surfaced because the forward path does not
    // re-emit it and the self-gist reader has no use for it.
    case 'id':
    case 'retry':
      return;
    default:
      return;
  }
}

function makeFrame(raw: string, fields: FrameFields, flushed: boolean): SseFrame {
  return {
    type: fields.type,
    hasData: fields.hasData,
    data: fields.hasData ? fields.data.join('\n') : '',
    raw,
    flushed,
  };
}

/**
 * Parse every complete event in `text`, leaving an unterminated remainder in
 * `carry`.
 *
 * Incremental by construction: the only state is the carry the caller gets
 * back, so feeding the same bytes one chunk at a time and all at once produce
 * the same frames. The frame parser in `sse.test.ts` sweeps every split offset
 * to keep that true, because the alternative is a self-gist detector that finds
 * the block at chunk size 64 and misses it at 65.
 *
 * Cost is linear in `text` and the only allocation is the frame list: the scan
 * is an index walk and each `slice` is over a substring of the input.
 */
export function parseSseFrames(text: string, options: ParseSseOptions = {}): ParseSseResult {
  const carried = options.carried ?? '';
  const source = carried + text;
  const dispatchUnterminated = options.dispatchUnterminated ?? true;
  const frames: SseFrame[] = [];

  let fields = emptyFields();
  let lineStart = 0;
  let frameStart = 0;

  for (let i = 0; i < source.length; i += 1) {
    const end = endOfLine(source, i);
    // Not a line terminator: the scan is an index walk over the whole string
    // and the overwhelmingly common byte here is ordinary payload, so this is
    // the hot branch and it has to be a skip rather than a `break`.
    if (end === -1) continue;
    const line = source.slice(lineStart, i);
    lineStart = end;
    // Resume at the byte *after* the terminator, not at the next index. A
    // `\r\n` is one line ending that occupies two indices, and stepping to
    // `i + 1` would find the `\n` and report a second, empty line -- which
    // splits every CRLF frame in half and turns one blank-line separator into
    // two dispatches. A lone `\r` sets `i` to where it already was, so this is
    // correct for all three terminators.
    i = end - 1;
    if (line.length === 0) {
      // A blank line dispatches, but only if there is a payload: a frame whose
      // data buffer is empty is discarded by the spec, and dispatching it would
      // turn every `: ping` heartbeat into an event.
      if (fields.hasData) frames.push(makeFrame(source.slice(frameStart, end), fields, false));
      fields = emptyFields();
      frameStart = end;
      continue;
    }
    consumeLine(line, fields);
  }

  const trailing = source.slice(frameStart);
  if (trailing.length === 0) return { frames, carry: '', pending: false };

  // The stream ended inside a frame. Either it is a partial line (nothing has
  // been assembled yet) or it is a frame that will never be terminated. The
  // second case is reported rather than dropped, because the most recent thing
  // a model said is usually in it.
  const pending = fields.hasData;
  const emitted = pending && dispatchUnterminated ? [makeFrame(trailing, fields, true)] : [];
  return {
    frames: emitted.length === 0 ? frames : [...frames, ...emitted],
    carry: trailing,
    pending,
  };
}

/* -------------------------------------------------------------------------- */
/* The ring buffer                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Retained bytes when a caller does not say.
 *
 * 8 KiB, matching the "one small ring buffer" of architecture §9 and the
 * retain budget B-8 uses for an in-flight block: a self-gist fits in it, a
 * runaway response does not grow the gateway's memory on the strength of one
 * turn. Copied as a literal rather than imported, because a frozen cross-stream
 * contract does not currently carry it (see the note in the module header).
 */
export const DEFAULT_TAIL_BYTES = 8192;

/**
 * The last `cap` bytes of a stream, byte-bounded.
 *
 * Bounded in **bytes**, not chunks, and the distinction is the whole design. A
 * chunk-counted ring (`push(); if (len > 32) shift()`) is a memory bound that
 * depends on how the provider happened to fragment its response: 32 chunks of
 * 64 KiB is 2 MB and 32 chunks of 40 bytes is 1 KB, and the same code would be
 * called "bounded" in both cases. Counting bytes makes the bound the number in
 * the config and makes "the gateway holds at most 8 KB of a response" a
 * statement that is true regardless of what the model emitted.
 *
 * Eviction is from the front, always. The tail is where the self-gist is: the
 * architecture has the model write its gist at the *end* of its turn, so the
 * bytes that matter are the ones that arrive last, and a buffer that dropped
 * from the back would drop precisely the thing it exists to keep.
 */
export class ByteRingTail {
  readonly #cap: number;
  #chunks: Buffer[] = [];
  #bytes = 0;
  #dropped = 0;

  constructor(cap: number) {
    // A negative or fractional cap is a config error, and clamping beats
    // throwing: this is a memory bound, and a bad bound must not fail a request
    // the gateway can otherwise serve. Non-integers floor, because a partial
    // byte is not a thing.
    this.#cap = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 0;
  }

  /** The configured bound. Never changes over the buffer's life. */
  get capacity(): number {
    return this.#cap;
  }

  /** Bytes currently retained. Always `<= capacity`. */
  get size(): number {
    return this.#bytes;
  }

  /**
   * Bytes discarded over the buffer's whole life, cumulative across `clear()`.
   *
   * Cumulative on purpose: it answers "did this response ever exceed the tail",
   * which is the question a self-gist observer needs before it trusts what it
   * found, and that question is only meaningful as a running total.
   */
  get dropped(): number {
    return this.#dropped;
  }

  /** Whether anything has been evicted. The cheap "is my tail complete?" flag. */
  get truncated(): boolean {
    return this.#dropped > 0;
  }

  push(chunk: Buffer): void {
    if (this.#cap === 0) {
      this.#dropped += chunk.byteLength;
      return;
    }

    // A single chunk at least as large as the whole ring: everything retained
    // so far is older than this chunk, so the ring is exactly its own last
    // `cap` bytes. Handled as one case because it is the only place the
    // retained window can be established without a loop, and it is the common
    // shape for a small ring against a provider that sends 64 KB chunks.
    if (chunk.byteLength >= this.#cap) {
      this.#chunks = [Buffer.from(chunk.subarray(chunk.byteLength - this.#cap))];
      this.#dropped += this.#bytes + chunk.byteLength - this.#cap;
      this.#bytes = this.#cap;
      return;
    }

    this.#chunks.push(chunk);
    this.#bytes += chunk.byteLength;

    // At most one partial eviction per push: the loop exits as soon as
    // `#bytes <= #cap`, and the only branch that can leave a chunk partly
    // consumed is the last one, which brings the total to exactly `#cap`.
    while (this.#bytes > this.#cap) {
      const oldest = this.#chunks[0];
      if (oldest === undefined) break;
      const excess = this.#bytes - this.#cap;
      if (oldest.byteLength <= excess) {
        this.#chunks.shift();
        this.#bytes -= oldest.byteLength;
        this.#dropped += oldest.byteLength;
      } else {
        // Copied rather than subarray'd: a view would keep the whole upstream
        // chunk alive to hold `#cap` useful bytes, which is exactly the
        // unbounded-memory failure this class exists to rule out.
        this.#chunks[0] = Buffer.from(oldest.subarray(excess));
        this.#bytes -= excess;
        this.#dropped += excess;
      }
    }
  }

  /** The retained bytes. A copy, so a caller cannot mutate the ring. */
  toBuffer(): Buffer {
    if (this.#chunks.length === 0) return Buffer.alloc(0);
    return Buffer.concat(this.#chunks, this.#bytes);
  }

  /**
   * The retained bytes as UTF-8 text, for `parseSseFrames` and B-8.
   *
   * May start and end with U+FFFD when eviction or truncation cut a multi-byte
   * sequence in half. That is a property of the *tail*, not of the response:
   * the forward path never decodes, so the client always gets the whole code
   * point. A self-gist is fenced prose and a replacement character at either
   * seam does not change whether the sentinels were found, which is why the
   * lossy convenience is acceptable here and nowhere else in the module.
   */
  toString(): string {
    return this.toBuffer().toString('utf8');
  }

  /** Drops the retained bytes. The cumulative `dropped` count is not reset. */
  clear(): void {
    this.#chunks = [];
    this.#bytes = 0;
  }
}

/* -------------------------------------------------------------------------- */
/* The pipe                                                                    */
/* -------------------------------------------------------------------------- */

export interface SseResult {
  /** Bytes accepted by the downstream writable, after backpressure. */
  readonly bytesWritten: number;
  /**
   * The error that ended the stream, upstream or downstream. Null on a clean
   * finish. Reported rather than thrown: the gateway is a proxy in the middle
   * of a client that has already committed to a stream, and a thrown error here
   * becomes a truncated response with no explanation.
   */
  readonly error: Error | null;
  /** True when `close()` ended the stream before the upstream finished. */
  readonly closedEarly: boolean;
}

export interface SsePipelineOptions {
  /** Bytes retained for the self-gist observer. `0` disables the ring. */
  readonly tailBytes?: number;
  /**
   * Called once per observed frame, in order, on the ring-buffer copy. Errors
   * thrown here are swallowed: an observer that cannot read a frame is a lost
   * gist, and a lost gist must not take a live response down with it.
   */
  readonly onFrame?: (frame: SseFrame) => void;
  /**
   * Called once, with the first chunk of the stream, for the caller's own
   * bookkeeping. The one legitimate use is the provider's opaque stream id,
   * which rides in `message_start` and is needed to join the request to a log
   * line; the buffer is the caller's to keep and this file does not retain it.
   */
  readonly onFirstBytes?: (chunk: Buffer) => void;
  /**
   * Cap on the frame parser's carry, so a provider streaming one enormous line
   * cannot make the observer grow without bound. Default 64 KiB. Enforced on
   * the carry string's UTF-16 length, which is what the carry actually costs,
   * so a multibyte frame trips it at fewer bytes than the nominal budget --
   * never more. Exceeding it drops the in-flight frame and stops observing for
   * the rest of the stream: resuming at the next boundary would hand the
   * self-gist scanner half a block, and a gist missing its closing sentinel is
   * worse than a turn with no gist. The forward path is untouched either way.
   */
  readonly maxFrameBytes?: number;
}

const DEFAULT_MAX_FRAME_BYTES = 65_536;

interface Deferred<T> {
  readonly promise: Promise<T>;
  /** A property rather than a method: it is captured and called bare. */
  readonly resolve: (value: T) => void;
}

/** A promise that this module only ever fulfils. See `SseResult.error`. */
function deferred<T>(): Deferred<T> {
  // The initial no-op is unreachable -- `new Promise` calls the executor
  // synchronously -- but it gives `resolve` a type without a non-null
  // assertion or a `let x!`.
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A `text/event-stream` pipe: forward, tail, observe, close.
 *
 * ## Why this does not use `readable.pipe()`
 *
 * `pipe()` is the right tool and it is deliberately not used, for one reason:
 * it registers its own `data` handler, and this class needs a `data` handler
 * too -- to feed the tail and the observer *before* the bytes go out. Two
 * `data` handlers on one source means two `write()` calls per chunk and every
 * response the gateway serves is silently duplicated. So the four things
 * `pipe()` does that this needs are done here explicitly, and they are small:
 * write the chunk, pause the source when `write()` returns false, resume it on
 * `drain`, and `end()` the destination on source `end`. That is the whole
 * contract, and owning it means the listener set is exactly what `#detach`
 * names -- five handlers, no hidden ones, nothing left on the source after the
 * stream is over.
 *
 * The `drain` handler is registered *lazily*, on the first `write()` that
 * returns false, and removes itself on the first `drain`. A response that never
 * applies backpressure never acquires the listener at all, and one that applies
 * it once does not keep it.
 *
 * ## Why `done()` never rejects
 *
 * A rejected promise with no handler is an unhandled rejection, and an
 * unhandled rejection in a long-lived proxy takes the process down -- taking
 * every other in-flight request with it. `SseResult.error` carries the failure
 * instead. The upstream keeps an `error` handler for its whole lifetime, so an
 * upstream failure that arrives *after* `close()` is a no-op rather than a
 * crash; a caller that wants those should attach its own.
 */
export class SsePipeline {
  readonly #upstream: Readable;
  readonly #downstream: Writable;
  readonly #tail: ByteRingTail;
  readonly #onFrame: ((frame: SseFrame) => void) | null;
  readonly #onFirstBytes: ((chunk: Buffer) => void) | null;
  readonly #maxFrameChars: number;
  readonly #decoder = new StringDecoder('utf8');
  readonly #chain: Promise<SseResult>;
  readonly #resolve: (result: SseResult) => void;

  #carry = '';
  #frameChars = 0;
  #observerOverflow = false;
  #firstBytesSeen = false;
  #paused = false;
  #closed = false;
  #settled = false;
  #bytesWritten = 0;
  #error: Error | null = null;

  constructor(upstream: Readable, downstream: Writable, options: SsePipelineOptions = {}) {
    this.#upstream = upstream;
    this.#downstream = downstream;
    this.#tail = new ByteRingTail(options.tailBytes ?? DEFAULT_TAIL_BYTES);
    this.#onFrame = options.onFrame ?? null;
    this.#onFirstBytes = options.onFirstBytes ?? null;
    this.#maxFrameChars = Math.max(0, options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES);
    const box = deferred<SseResult>();
    this.#chain = box.promise;
    this.#resolve = box.resolve;

    upstream.on('data', this.#onChunk);
    upstream.once('end', this.#onStreamEnd);
    upstream.once('error', this.#onUpstreamError);
    downstream.once('finish', this.#onFinish);
    downstream.once('error', this.#onDownstreamError);
  }

  /** The ring. Read-only from the outside: a `push` on it would break the count. */
  get tail(): ByteRingTail {
    return this.#tail;
  }

  /** What to hand to `parseSelfGistDirective` when a turn ends. */
  get tailText(): string {
    return this.#tail.toString();
  }

  /**
   * True once the frame parser gave up on an over-long frame. The self-gist
   * observer must treat this as "the tail is not parseable" rather than "no
   * gist this turn": the difference is a turn that does not compact versus a
   * turn that compacts on a half-frame.
   */
  get observerOverflowed(): boolean {
    return this.#observerOverflow;
  }

  /** Resolves when the downstream has been fully flushed. Never rejects. */
  done(): Promise<SseResult> {
    return this.#chain;
  }

  /**
   * Tear the pipe down: detach, stop reading, end the destination, settle.
   *
   * Idempotent, and safe before the first chunk -- a client that disconnects
   * during connection setup has produced no data at all, and that is the case
   * most likely to leak a listener in a server that recycles request objects.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach();
    this.#upstream.destroy();
    if (!this.#downstream.writableEnded) this.#downstream.end();
    this.#settle({ bytesWritten: this.#bytesWritten, error: this.#error, closedEarly: true });
  }

  #detach(): void {
    this.#upstream.off('data', this.#onChunk);
    this.#upstream.off('end', this.#onStreamEnd);
    this.#upstream.off('error', this.#onUpstreamError);
    this.#downstream.off('drain', this.#onDrain);
    this.#downstream.off('finish', this.#onFinish);
    this.#downstream.off('error', this.#onDownstreamError);
  }

  #settle(result: SseResult): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolve(result);
  }

  /* --- forward path: no decoding, no buffering, no re-framing ------------ */

  /**
   * One upstream chunk, forwarded.
   *
   * The order is load-bearing and is the only place in this file that a
   * non-obvious sequence appears: tail first, then observe, then forward. Not
   * because the client can see the difference -- it cannot, and it must not --
   * but because the tail is a *copy* of the chunk and the observer reads text
   * decoded from it, so taking both before the write means nothing downstream
   * can be holding a reference that the buffer is still growing into. It also
   * means a frame the observer sees is a frame that was on the wire, which is
   * the claim `raw` makes.
   */
  readonly #onChunk = (chunk: Buffer): void => {
    // Binary mode is the contract. A string here means somebody called
    // `setEncoding` on the upstream, which cannot be undone and has already
    // lost byte-exactness upstream of us; re-encoding keeps the pipe running
    // instead of throwing inside a stream handler.
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;

    this.#tail.push(buf);
    this.#observe(buf);
    this.#bytesWritten += buf.byteLength;

    // `write` returning false is not a failure, it is the destination asking
    // for less. Pausing the source here is the whole of backpressure: an
    // unbounded copy of a 40 MB response into a client that has stopped
    // reading is a memory leak with a `Content-Length` on it, and N5's
    // fail-open does not extend to ignoring a full socket buffer.
    if (this.#downstream.write(buf)) return;
    if (this.#paused) return;
    this.#paused = true;
    this.#upstream.pause();
    this.#downstream.on('drain', this.#onDrain);
  };

  readonly #onDrain = (): void => {
    this.#paused = false;
    this.#downstream.off('drain', this.#onDrain);
    this.#upstream.resume();
  };

  readonly #onStreamEnd = (): void => {
    this.#flushObserver();
    if (!this.#downstream.writableEnded) this.#downstream.end();
  };

  /**
   * The source is done, so the destination is finished by the time this fires.
   * Settling here rather than on upstream `end` is what makes `done()` mean
   * "the client has the bytes", which is the only reading a caller can use to
   * close a response cleanly.
   */
  readonly #onFinish = (): void => {
    this.#detach();
    this.#settle({ bytesWritten: this.#bytesWritten, error: this.#error, closedEarly: this.#closed });
  };

  readonly #onUpstreamError = (err: Error): void => {
    this.#error = err;
    this.#detach();
    this.#upstream.destroy();
    // The bytes already forwarded stay forwarded. Ending the destination
    // rather than destroying it lets the client see a truncated but
    // well-formed end of stream, which an SDK can report; destroying it leaves
    // it with a reset connection and nothing to report.
    if (!this.#downstream.writableEnded) this.#downstream.end();
    this.#settle({ bytesWritten: this.#bytesWritten, error: err, closedEarly: false });
  };

  readonly #onDownstreamError = (err: Error): void => {
    this.#error = err;
    this.#detach();
    this.#upstream.destroy();
    this.#settle({ bytesWritten: this.#bytesWritten, error: err, closedEarly: false });
  };

  /* --- observer path: a torn read of the tail, or rather of the stream --- */

  #observe(bytes: Buffer): void {
    if (!this.#firstBytesSeen) {
      this.#firstBytesSeen = true;
      this.#onFirstBytes?.(bytes);
    }
    if (this.#onFrame === null || this.#observerOverflow) return;
    const text = this.#decoder.write(bytes);
    if (text.length === 0) return;
    this.#feed(text);
  }

  #feed(text: string): void {
    const onFrame = this.#onFrame;
    if (onFrame === null) return;
    // `dispatchUnterminated: false` is the whole reason the parser has the
    // option. Mid-stream, a chunk that happens to end mid-frame is not a
    // finished frame, and dispatching it would report the same block twice --
    // once per chunk boundary -- and hand the self-gist scanner a gist with a
    // truncated body. End-of-stream is the only place the frame is really
    // unterminated, and `#flushObserver` is where that is decided.
    const result = parseSseFrames(text, { carried: this.#carry, dispatchUnterminated: false });
    this.#carry = result.carry;
    for (const frame of result.frames) {
      try {
        onFrame(frame);
      } catch {
        // An observer that throws is a lost gist, not a failed response.
      }
    }
    if (result.carry.length === 0 && !result.pending) {
      this.#frameChars = 0;
      return;
    }
    this.#frameChars += text.length;
    if (this.#frameChars > this.#maxFrameChars) {
      this.#carry = '';
      this.#frameChars = 0;
      this.#observerOverflow = true;
    }
  }

  #flushObserver(): void {
    const onFrame = this.#onFrame;
    if (onFrame === null || this.#observerOverflow) return;
    const result = parseSseFrames(this.#decoder.end(), { carried: this.#carry });
    this.#carry = '';
    this.#frameChars = 0;
    for (const frame of result.frames) {
      try {
        onFrame(frame);
      } catch {
        // Same posture as #feed: never let the observer end the response.
      }
    }
  }
}

/**
 * Pipe a `text/event-stream` from `upstream` to `downstream`, byte for byte.
 *
 * Returns the pipeline rather than a promise so that the caller keeps a handle
 * for `close()`; `await pipeSseUpstream(...).done()` is the ordinary ending and
 * `pipeSseUpstream(...).close()` is the early one. A function that returned
 * `Promise<SseResult>` would have to pick one of those and could not offer the
 * other, and the early one is the one a server needs on client disconnect.
 *
 * The upstream must be in binary mode (no `setEncoding`), which is the default
 * for `http.IncomingMessage` and for `fetch`'s `ReadableStream`. The
 * destination is expected to be an `http.ServerResponse` with the SSE headers
 * already written; this module does not set headers, because the adapter that
 * knows the provider's `content-type` and the session's `x-strata-*` counters is
 * the one that should.
 */
export function pipeSseUpstream(
  upstream: Readable,
  downstream: Writable,
  options: SsePipelineOptions = {},
): SsePipeline {
  return new SsePipeline(upstream, downstream, options);
}
