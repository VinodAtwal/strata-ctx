import { FixtureError } from './errors.js';
import type { SseEvent } from './fixture.js';

/**
 * SSE framing. The invariant this module exists to hold: what the recorder
 * captured is what the replay writes, byte for byte, including a frame that
 * was still in flight when the connection died.
 *
 * That last part is the one that is easy to get wrong. A parser that "helpfully"
 * completes a truncated final frame has silently invented a frame boundary, and
 * a harness that invents one is a harness that will report a clean
 * `message_stop` for a stream that never finished. The frame is therefore
 * carried with `complete: false` and written *without* its terminating blank
 * line, so the consumer sees exactly what the provider sent.
 *
 * One documented normalisation: a single space is inserted after a field colon
 * (`data: x`, not `data:x`), which is the spelling the SSE examples and every
 * real provider use. Frame boundaries, ordering, payload bytes, CRLF vs LF and
 * the truncated tail are all preserved exactly. A stream truncated *inside* a
 * field line replays with that line's own line break restored, because a
 * half-written line has no length to record.
 */

export type SseEol = '\n' | '\r\n';

export interface ParsedSseStream {
  readonly eol: SseEol;
  readonly events: readonly SseEvent[];
}

/** One optional space after the colon, omitted entirely for an empty value. */
function field(name: string, value: string, eol: SseEol): string {
  return `${name}:${value === '' ? '' : ` ${value}`}${eol}`;
}

export function renderSseEvent(event: SseEvent, eol: SseEol): string {
  let out = '';
  if (event.event !== undefined) out += field('event', event.event, eol);
  if (event.id !== undefined) out += field('id', event.id, eol);
  if (event.retry !== undefined) out += `retry: ${event.retry}${eol}`;
  if (event.comment !== undefined) out += `:${event.comment === '' ? '' : ` ${event.comment}`}${eol}`;
  if (event.data !== null) {
    // A multi-line payload is emitted as repeated `data:` lines, which is how
    // the format encodes one, and which is the only way the newlines survive a
    // round trip.
    for (const line of event.data.split('\n')) out += field('data', line, eol);
  }
  if (event.complete) out += eol;
  return out;
}

export function renderSseStream(events: readonly SseEvent[], eol: SseEol): Buffer {
  return Buffer.from(events.map((e) => renderSseEvent(e, eol)).join(''), 'utf8');
}

/**
 * Detects the line ending and splits frames.
 *
 * SSE frame delimiters are a blank line, so splitting on the end-of-line unit
 * and treating every empty segment as a frame boundary is the format's own
 * model. A run of text with no trailing blank line ends in an unterminated
 * frame -- that is the truncation, and it is reported, never repaired.
 */
export function parseSseStream(bytes: Buffer | string): ParsedSseStream {
  const text = typeof bytes === 'string' ? bytes : bytes.toString('utf8');
  // A stream that mixes line endings is not representable in this format; the
  // detected form wins and is recorded, so the common case stays exact.
  const eol: SseEol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol);
  const events: SseEvent[] = [];

  // An empty frame is skipped: per the SSE dispatch rule a blank line with an
  // empty buffer is not an event. It carries nothing, so recording it would only
  // mean preserving a byte that no consumer can observe.
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    // A trailing empty segment is the artifact of a final line break, not a
    // blank line, so it must not be read as an empty frame.
    if (line === '') {
      i += 1;
      continue;
    }
    const chunk: string[] = [];
    let complete = false;
    while (i < lines.length) {
      const current = lines[i] ?? '';
      if (current === '') {
        complete = i < lines.length - 1;
        i += 1;
        break;
      }
      chunk.push(current);
      i += 1;
    }
    events.push(parseFrame(chunk, complete, events.length));
  }

  return { eol, events };
}

function parseFrame(chunk: readonly string[], complete: boolean, index: number): SseEvent {
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  let comment: string | undefined;
  const dataLines: string[] = [];
  let sawData = false;

  for (const line of chunk) {
    if (line.startsWith(':')) {
      comment = stripLeadingSpace(line.slice(1));
      continue;
    }
    const colon = line.indexOf(':');
    const name = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? '' : stripLeadingSpace(line.slice(colon + 1));
    switch (name) {
      case 'event':
        event = raw;
        break;
      case 'id':
        id = raw;
        break;
      case 'retry': {
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 0) {
          // A retry value that is not a number cannot be written back as one,
          // so dropping it would change the stream. Fail instead.
          throw new FixtureError(
            `SSE frame ${index}: 'retry:${raw}' is not a non-negative integer and cannot be replayed byte-exactly`,
          );
        }
        retry = parsed;
        break;
      }
      case 'data':
        dataLines.push(raw);
        sawData = true;
        break;
      default:
        throw new FixtureError(
          `SSE frame ${index}: unrecognised field '${name}' cannot be replayed byte-exactly`,
        );
    }
  }

  return {
    ...(event !== undefined ? { event } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(retry !== undefined ? { retry } : {}),
    ...(comment !== undefined ? { comment } : {}),
    data: sawData ? dataLines.join('\n') : null,
    delayMs: 0,
    complete,
  };
}

const stripLeadingSpace = (value: string): string => (value.startsWith(' ') ? value.slice(1) : value);
