import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashCanonical } from '@strata-ctx/core-types';
import { z } from 'zod';

import { JsonValueSchema, toJsonText, type JsonValue } from './json.js';
import { renderSseStream } from './sse.js';
import { FixtureExistsError, FixtureValidationError, FixtureVersionError } from './errors.js';

/**
 * The fixture format.
 *
 * A fixture is a recorded provider exchange: one request, one response. Its
 * whole value is that a test can be replayed byte-for-byte with no network, no
 * key, and no cost, which is what lets the eval suites (E1-E6) run in CI
 * (docs/evaluation.md §6, DoD item 7).
 *
 * Two rules are load-bearing and both are about failing loudly:
 *
 * 1. **Versioned.** `fixtureFormatVersion` is checked before anything else, so a
 *    fixture written by an older harness is rejected instead of being parsed
 *    under the wrong assumptions. A silently mis-parsed fixture is the worst
 *    outcome in a test harness: the suite is green and it tested nothing.
 * 2. **Strict.** Every object is `.strict()`. zod strips unknown keys by
 *    default, so a typo would drop a recorded `status` line and the replay
 *    would serve a default instead of what the provider actually said. Same
 *    reasoning as `StrataPolicySchema` in core-types.
 */

export const FIXTURE_FORMAT_VERSION = 1;

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'expected a 64-char lowercase hex digest');

/** ISO-8601 UTC. Metadata only: nothing in matching depends on it. */
const Timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/, 'expected an ISO-8601 UTC timestamp');

const HeaderMapSchema = z.record(z.string(), z.string());

/**
 * How this exchange was requested.
 *
 * `canonicalHash` is the *only* match key. It is `hashCanonical` of the
 * redacted body (see `replay.ts`), so it is insensitive to key order, to
 * whitespace, and to the credential the request carried. That last part is
 * deliberate: a fixture has to be replayable by someone who does not have the
 * key it was recorded with, otherwise the only people who can run the suite are
 * the ones holding a live secret.
 */
export const RecordedRequestSchema = z
  .object({
    method: z.string().min(1).regex(/^[A-Z]+$/, 'expected an uppercase HTTP method'),
    path: z.string().min(1).startsWith('/'),
    canonicalHash: Hex64,
    /** Hash of the body *before* redaction. Provenance only; never matched on. */
    rawCanonicalHash: Hex64.optional(),
    headers: HeaderMapSchema.default({}),
    /** Redacted body, retained so a match miss can print a real diff. */
    body: JsonValueSchema,
  })
  .strict();
export type RecordedRequest = z.infer<typeof RecordedRequestSchema>;

/**
 * One SSE frame.
 *
 * `data: null` means the frame carried no `data:` field at all, which is
 * different from `data: ''` (a `data:` line with an empty payload). The
 * distinction is kept because replaying a stream byte-for-byte means being able
 * to tell those two apart.
 */
export const SseEventSchema = z
  .object({
    // An empty `event:`/`id:` value is legal SSE (it resets the value), so it
    // is recorded rather than rejected: rejecting it would make such a stream
    // unrecordable, and dropping it would change the bytes.
    event: z.string().optional(),
    id: z.string().optional(),
    retry: z.number().int().nonnegative().optional(),
    comment: z.string().optional(),
    data: z.string().nullable(),
    /** Milliseconds to wait *before* writing this frame. Recorded delays are 0. */
    delayMs: z.number().int().nonnegative().default(0),
    /** false => the frame was never terminated by a blank line: a truncated tail. */
    complete: z.boolean().default(true),
  })
  .strict();
export type SseEvent = z.infer<typeof SseEventSchema>;

const ResponseBase = {
  status: z.number().int().min(100).max(599),
  headers: HeaderMapSchema.default({}),
};

export const JsonResponseSchema = z
  .object({
    kind: z.literal('json'),
    ...ResponseBase,
    /**
     * Stored as a parsed value, not as text, so a fixture is reviewable and a
     * match miss can diff it field by field. The cost is that JSON body bytes
     * are re-serialised on replay: whitespace and number spelling are
     * normalised. SSE frames carry the byte-exactness claim instead, because
     * that is where event boundaries live.
     */
    body: JsonValueSchema,
  })
  .strict();
export type JsonResponse = z.infer<typeof JsonResponseSchema>;

export const SseResponseSchema = z
  .object({
    kind: z.literal('sse'),
    ...ResponseBase,
    /**
     * SSE is LF by specification, but a provider behind a proxy can emit CRLF
     * and a replay that silently converted it would break the byte-exactness
     * claim. So the captured form is recorded and replayed as captured.
     */
    eol: z.enum(['\n', '\r\n']).default('\n'),
    /**
     * Zero frames is a legal recording: a provider that fails before its first
     * event returns a 200 with an empty body, and that response has to be
     * replayable or the interesting case cannot be tested at all.
     *
     * The `min(1)` this replaced was a false guarantee. It could not detect a
     * mis-parsing parser -- the failure it was guarding against is *dropping*
     * frames, not recording an empty stream -- and a round trip through
     * `parseSseStream`/`renderSseStream` is what actually catches that.
     */
    events: z.array(SseEventSchema),
  })
  .strict();
export type SseResponse = z.infer<typeof SseResponseSchema>;

export const FixtureResponseSchema = z.discriminatedUnion('kind', [JsonResponseSchema, SseResponseSchema]);
export type FixtureResponse = z.infer<typeof FixtureResponseSchema>;

/** What was scrubbed on the way in. Recorded so a reader knows it happened. */
export const RedactionRecordSchema = z
  .object({
    headers: z.array(z.string()).default([]),
    bodyPaths: z.array(z.string()).default([]),
  })
  .strict();
export type RedactionRecord = z.infer<typeof RedactionRecordSchema>;

export const FixtureEntrySchema = z
  .object({
    /** Per-exchange label, e.g. a turn index. */
    name: z.string().min(1).optional(),
    request: RecordedRequestSchema,
    response: FixtureResponseSchema,
    redacted: RedactionRecordSchema.optional(),
  })
  .strict();
export type FixtureEntry = z.infer<typeof FixtureEntrySchema>;

export const FixtureFileSchema = z
  .object({
    fixtureFormatVersion: z.literal(FIXTURE_FORMAT_VERSION),
    /** Logical provider the traffic came from, e.g. 'anthropic'. */
    provider: z.string().min(1),
    /** Stable, human-meaningful name. This is what a test refers to. */
    name: z.string().min(1),
    recordedAt: Timestamp.optional(),
    entries: z.array(FixtureEntrySchema).min(1, 'a fixture file with no entries replays nothing'),
  })
  .strict();
export type FixtureFile = z.infer<typeof FixtureFileSchema>;

function renderIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>';
    return `${where}: ${issue.message}`;
  });
}

function readFormatVersion(raw: unknown): number | undefined {
  if (typeof raw !== 'object' || raw === null || !('fixtureFormatVersion' in raw)) return undefined;
  const value = (raw as Record<string, unknown>)['fixtureFormatVersion'];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Validates an untrusted fixture. The version is checked first and separately
 * so that a stale fixture reports "your harness is wrong", not "missing key at
 * root", which is what a bare `safeParse` would say.
 */
export function parseFixtureFile(raw: unknown, source = '<inline>'): FixtureFile {
  const version = readFormatVersion(raw);
  if (version !== undefined && version !== FIXTURE_FORMAT_VERSION) {
    throw new FixtureVersionError(
      `${source}: fixture format version ${version} cannot be read by this harness ` +
        `(it reads version ${FIXTURE_FORMAT_VERSION}). Fixtures are versioned because a ` +
        `silently mis-parsed fixture replays the wrong response and the suite still passes.`,
    );
  }
  const parsed = FixtureFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FixtureValidationError(`${source}: invalid fixture file`, renderIssues(parsed.error));
  }
  return parsed.data;
}

export function loadFixtureFile(path: string): FixtureFile {
  const text = readFileSync(path, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new FixtureValidationError(`${path}: fixture is not valid JSON`, [
      err instanceof Error ? err.message : String(err),
    ]);
  }
  return parseFixtureFile(raw, path);
}

export interface LoadedFixture {
  readonly path: string;
  readonly file: FixtureFile;
}

/**
 * Loads every `.json` fixture in a directory.
 *
 * `readdirSync` order is filesystem-dependent, so the result is sorted: a list
 * that reorders between machines is a list whose diffs are noise, and a replay
 * that depends on it would be order-dependent, which is a flake with extra steps.
 */
export function loadFixtureDir(dir: string): LoadedFixture[] {
  const names = readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort();
  return names.map((n) => {
    const path = join(dir, n);
    if (!statSync(path).isFile()) {
      throw new FixtureValidationError(`${path}: not a file`, ['expected a .json fixture file']);
    }
    return { path, file: loadFixtureFile(path) };
  });
}

export function serializeFixtureFile(file: FixtureFile): string {
  return toJsonText(file);
}

export function writeFixtureFile(path: string, file: FixtureFile, options?: { overwrite?: boolean }): void {
  const overwrite = options?.overwrite ?? false;
  if (!overwrite) {
    let exists = true;
    try {
      statSync(path);
    } catch {
      exists = false;
    }
    if (exists) {
      // Re-recording over a reviewed fixture without a human noticing is how a
      // good fixture becomes a bad one and every test still passes.
      throw new FixtureExistsError(
        `${path}: fixture already exists. Pass { overwrite: true } if you meant to replace a recorded response.`,
      );
    }
  }
  // Validated on the way out as well as on the way in: a caller that built a
  // fixture by hand in TypeScript can still get the shape wrong, and a
  // malformed file on disk is only discovered by whoever runs the suite next.
  writeFileSync(path, serializeFixtureFile(parseFixtureFile(file, path)), { encoding: 'utf8' });
}

export interface FixtureSummary {
  readonly name: string;
  readonly provider: string;
  readonly version: number;
  readonly recordedAt: string | undefined;
  readonly entries: readonly EntrySummary[];
}

export interface EntrySummary {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly canonicalHash: string;
  readonly status: number;
  readonly kind: FixtureResponse['kind'];
  readonly responseBytes: number;
  readonly eventCount: number;
  readonly totalDelayMs: number;
  /** True when the stream ends in an unterminated frame, i.e. a captured cut. */
  readonly truncatedTail: boolean;
  readonly redactedHeaders: number;
  readonly redactedBodyPaths: number;
}

export function summarizeEntry(entry: FixtureEntry, index: number): EntrySummary {
  const response = entry.response;
  const events = response.kind === 'sse' ? response.events : [];
  return {
    name: entry.name ?? `entry[${index}]`,
    method: entry.request.method,
    path: entry.request.path,
    canonicalHash: entry.request.canonicalHash,
    status: response.status,
    kind: response.kind,
    responseBytes: responseBytes(response),
    eventCount: events.length,
    totalDelayMs: events.reduce((sum, e) => sum + e.delayMs, 0),
    truncatedTail: events.length > 0 && events[events.length - 1]?.complete === false,
    redactedHeaders: entry.redacted?.headers.length ?? 0,
    redactedBodyPaths: entry.redacted?.bodyPaths.length ?? 0,
  };
}

export function summarizeFixtureFile(file: FixtureFile): FixtureSummary {
  return {
    name: file.name,
    provider: file.provider,
    version: file.fixtureFormatVersion,
    recordedAt: file.recordedAt,
    entries: file.entries.map(summarizeEntry),
  };
}

/**
 * Byte size the replay will emit, so a test can assert it without a socket.
 *
 * Delegated to the same renderer `replayFrames` uses. It was previously a second
 * implementation of the framing rules, and the two disagreed: on an empty field
 * value (`data:` with no payload) this one counted the separating space that
 * `sse.ts` correctly omits, so a test comparing this against a real socket would
 * have failed on a stream that was actually replayed exactly right. A byte count
 * that can disagree with the bytes is worse than no byte count.
 */
export function responseBytes(response: FixtureResponse): number {
  if (response.kind === 'json') return Buffer.byteLength(JSON.stringify(response.body) ?? 'null', 'utf8');
  return renderSseStream(response.events, response.eol).byteLength;
}

/** Canonical hash of a request body. The single definition of "same request". */
export function canonicalBodyHash(body: JsonValue): string {
  return hashCanonical(body);
}
