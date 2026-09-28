import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { FixtureAmbiguityError, FixtureError, FixtureMatchError } from './errors.js';
import { canonicalBodyHash, type FixtureEntry, type FixtureResponse } from './fixture.js';
import { parseJsonBody, type JsonValue } from './json.js';
import { redactBody } from './redact.js';
import { renderSseEvent, type SseEol } from './sse.js';

/**
 * Deterministic replay.
 *
 * The match key is `hashCanonical` of the request body, computed over the
 * *redacted* body. Two consequences, both intended:
 *
 * - Key order, whitespace and number spelling are irrelevant. A hand-edited
 *   fixture that reorders a key is the same request, and treating it as a
 *   different one would make every fixture a trap.
 * - Credentials are irrelevant. A fixture has to be replayable by someone who
 *   does not have the key it was recorded with; otherwise the eval suites
 *   (docs/evaluation.md §6) could only ever be run by whoever holds a live
 *   secret, and CI could never run them at all.
 *
 * There is no default response. An unmatched request throws, with a diff. A
 * harness that answers an unrecognised request with something plausible is a
 * harness that reports a green suite for a response the provider never sent.
 */

export interface ReplayRequest {
  readonly method: string;
  readonly path: string;
  /** Raw body bytes as received. Parsed and redacted before hashing. */
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ReplayContext {
  readonly method: string;
  readonly path: string;
  readonly canonicalHash: string;
  /** Redacted body, so the error message cannot print a live credential. */
  readonly redactedBody: JsonValue;
}

/** The one definition of "the same request", shared with the recorder. */
export function canonicalizeRequest(req: ReplayRequest, source = 'request'): JsonValue {
  return redactBody(parseJsonBody(req.body, source)).value;
}

export function requestContext(req: ReplayRequest, source = 'request'): ReplayContext {
  const redactedBody = canonicalizeRequest(req, source);
  return {
    method: req.method.toUpperCase(),
    path: req.path,
    canonicalHash: canonicalBodyHash(redactedBody),
    redactedBody,
  };
}

/** Cap on diffs printed for one miss, so a 30-turn session does not bury the cause. */
const MAX_DIFFS = 5;
const PREVIEW_CHARS = 160;

const preview = (value: JsonValue): string => {
  const text = JSON.stringify(value) ?? 'null';
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}...` : text;
};

/**
 * First structural divergence between two bodies, as a dotted path.
 *
 * Only the *first* one is reported on purpose: a whole-tree diff of two large
 * request bodies is unreadable, and the first divergence is nearly always the
 * edit that broke the match.
 */
export function diffJson(expected: JsonValue, actual: JsonValue, path = ''): string | null {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return `${path || '<body>'}: length ${expected.length} (recorded) vs ${actual.length} (received)`;
    }
    for (let i = 0; i < expected.length; i += 1) {
      const at = `${path}[${i}]`;
      // The index is a real position: noUncheckedIndexedAccess means these are
      // `| undefined`, and the length check above has already ruled that out.
      const d = diffJson(expected[i] as JsonValue, actual[i] as JsonValue, at);
      if (d !== null) return d;
    }
    return null;
  }
  if (expected !== null && actual !== null && typeof expected === 'object' && typeof actual === 'object') {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      const a = (expected as Record<string, JsonValue>)[key];
      const b = (actual as Record<string, JsonValue>)[key];
      if (a === undefined) return `${path ? `${path}.` : ''}${key}: missing from the recorded body`;
      if (b === undefined) return `${path ? `${path}.` : ''}${key}: not present in the received body`;
      const d = diffJson(a, b, path ? `${path}.${key}` : key);
      if (d !== null) return d;
    }
    return null;
  }
  if (expected === actual) return null;
  return `${path || '<body>'}: recorded ${preview(expected)} vs received ${preview(actual)}`;
}

/** Deterministic near-miss ordering: most shared top-level keys first, then file order. */
function rankCandidates(candidates: readonly FixtureEntry[], received: JsonValue): FixtureEntry[] {
  const receivedKeys =
    received !== null && typeof received === 'object' && !Array.isArray(received)
      ? new Set(Object.keys(received))
      : new Set<string>();
  return candidates
    .map((entry, index) => {
      const body = entry.request.body;
      const keys =
        body !== null && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
      return { entry, index, overlap: keys.filter((k) => receivedKeys.has(k)).length };
    })
    .sort((a, b) => b.overlap - a.overlap || a.index - b.index)
    .map((c) => c.entry);
}

function describeEntry(entry: FixtureEntry, index: number): string {
  const label = entry.name ?? `entry[${index}]`;
  return `  ${label}: ${entry.request.method} ${entry.request.path} -> ${entry.response.status} ${entry.response.kind} (canonicalHash=${entry.request.canonicalHash.slice(0, 12)})`;
}

/**
 * Finds the one entry that answers this request, or throws explaining why not.
 */
export function matchFixture(entries: readonly FixtureEntry[], ctx: ReplayContext): FixtureEntry {
  const onPath = entries.filter((e) => e.request.path === ctx.path && e.request.method === ctx.method);
  if (onPath.length === 0) {
    const paths = [...new Set(entries.map((e) => `${e.request.method} ${e.request.path}`))].sort();
    throw new FixtureMatchError(
      `no fixture covers ${ctx.method} ${ctx.path} (canonicalHash=${ctx.canonicalHash.slice(0, 12)}).\n` +
        `Fixtures loaded: ${entries.length}${paths.length > 0 ? `, covering ${paths.join(', ')}` : ''}.\n` +
        `Nothing is returned for an unknown request on purpose: a default response would let this test pass\n` +
        `against traffic that was never recorded.`,
    );
  }

  const exact = onPath.filter((e) => e.request.canonicalHash === ctx.canonicalHash);
  if (exact.length === 1) {
    // The single match; the non-null assertion is justified by the length check
    // immediately above, which is the only way an index of length 1 can be out
    // of range.
    return exact[0] as FixtureEntry;
  }
  if (exact.length > 1) {
    // Both are listed rather than one being chosen: two entries with the same
    // canonical body are two different recorded answers, and which one is
    // correct is a question for whoever added the second.
    const names = exact.map((e, i) => describeEntry(e, i));
    throw new FixtureAmbiguityError(
      `${exact.length} fixtures match ${ctx.method} ${ctx.path} with the same canonical body ` +
        `(canonicalHash=${ctx.canonicalHash.slice(0, 12)}):\n${names.join('\n')}\n` +
        `Replay will not pick between them, because an arbitrary choice makes the suite pass or fail\n` +
        `for reasons unrelated to the code under test.`,
    );
  }

  const ranked = rankCandidates(onPath, ctx.redactedBody);
  const shown = ranked.slice(0, MAX_DIFFS);
  const diffs = shown.map((entry) => {
    const label = entry.name ?? 'entry';
    const d = diffJson(entry.request.body, ctx.redactedBody);
    return `  ${label}: ${d ?? 'bodies differ only where diffJson cannot compare them'}`;
  });
  const omitted = ranked.length - shown.length;
  return never(
    new FixtureMatchError(
      `no fixture matches ${ctx.method} ${ctx.path} (canonicalHash=${ctx.canonicalHash.slice(0, 12)});\n` +
        `${onPath.length} fixture(s) cover this path. Closest first:\n${diffs.join('\n')}` +
        `${omitted > 0 ? `\n  ...and ${omitted} more on this path not shown` : ''}\n` +
        `Received body (redacted): ${preview(ctx.redactedBody)}`,
    ),
  );
}

const never = (error: Error): never => {
  throw error;
};

/** What the recorder writes and the replayer reads, in one place. */
export type FixtureFrame =
  | { readonly kind: 'head'; readonly status: number; readonly headers: Readonly<Record<string, string>> }
  | {
      readonly kind: 'chunk';
      readonly bytes: Buffer;
      /** Wait this long before writing. The deliberate pacing of a recorded stream. */
      readonly delayMs: number;
    }
  | { readonly kind: 'end' };

/**
 * Turns an entry into the exact sequence of writes a client would observe.
 *
 * The generator is the single replay path: the HTTP server below only consumes
 * it, so the byte-exactness tests exercise the same code the suite runs rather
 * than a parallel reimplementation.
 */
export function* replayFrames(entry: FixtureEntry): Generator<FixtureFrame> {
  const response: FixtureResponse = entry.response;
  yield { kind: 'head', status: response.status, headers: response.headers };

  if (response.kind === 'json') {
    const body = Buffer.from(JSON.stringify(response.body) ?? 'null', 'utf8');
    if (body.byteLength > 0) yield { kind: 'chunk', bytes: body, delayMs: 0 };
  } else {
    const eol: SseEol = response.eol;
    for (const event of response.events) {
      // Yielded even when empty: an unterminated final frame can legitimately
      // render to zero bytes, and skipping it would swallow the cut.
      yield { kind: 'chunk', bytes: Buffer.from(renderSseEvent(event, eol), 'utf8'), delayMs: event.delayMs };
    }
  }
  yield { kind: 'end' };
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms).unref()) : Promise.resolve();

export interface ReplayServerOptions {
  readonly entries: readonly FixtureEntry[];
  readonly host?: string;
  readonly port?: number;
  /**
   * Called on every miss. The response is a 501 either way, but a test harness
   * that wants the run to *fail* on an unknown request hooks this and throws.
   */
  readonly onUnmatched?: (error: FixtureMatchError) => void;
}

export interface ReplayServer {
  readonly server: Server;
  listen(): Promise<{ readonly origin: string; readonly port: number }>;
  close(): Promise<void>;
}

/**
 * Reads the whole request body before the request is matched.
 *
 * Matching needs the body, and a stream that is still arriving cannot be hashed.
 * The previous version wrapped `req.forEach` in a promise that resolved
 * immediately, which returned a truncated body for every request larger than one
 * TCP segment -- i.e. silently matched against the wrong bytes.
 */
const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

/**
 * A provider stand-in that serves fixtures.
 *
 * Same role as `tools/mock-upstream.ts`, except the answers are recorded ones,
 * so a round trip through the gateway is reproducible instead of merely
 * plausible. The gateway is the intended consumer: point `upstream` here and
 * `x-strata-pinned` becomes assertable.
 */
export function createReplayServer(opts: ReplayServerOptions): ReplayServer {
  const host = opts.host ?? '127.0.0.1';
  const entries = opts.entries;

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const raw = await readBody(req);
        const ctx = requestContext(
          {
            method: req.method ?? 'GET',
            path: req.url ?? '/',
            body: raw,
            headers: flattenHeaders(req.headers),
          },
          `${req.method ?? 'GET'} ${req.url ?? '/'}`,
        );
        const entry = matchFixture(entries, ctx);
        for (const frame of replayFrames(entry)) {
          if (frame.kind === 'head') {
            res.writeHead(frame.status, { ...frame.headers });
          } else if (frame.kind === 'chunk') {
            await sleep(frame.delayMs);
            res.write(frame.bytes);
          } else {
            res.end();
          }
        }
      } catch (err) {
        // A `FixtureError` is already the diagnosis; rewrapping it would flatten
        // "these two fixtures are ambiguous" into "nothing matched", which sends
        // the reader looking for a missing fixture instead of a duplicate one.
        const error =
          err instanceof FixtureError
            ? err
            : new FixtureMatchError(`replay failed: ${err instanceof Error ? err.message : String(err)}`);
        opts.onUnmatched?.(error);
        if (res.headersSent) {
          res.end();
          return;
        }
        res.writeHead(501, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`${error.message}\n`);
      }
    })();
  });

  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port ?? 0, host, () => {
          const address = server.address() as AddressInfo | null;
          if (address === null) {
            reject(new Error('replay server did not bind an address'));
            return;
          }
          resolve({ origin: `http://${host}:${address.port}`, port: address.port });
        });
      }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function flattenHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}
