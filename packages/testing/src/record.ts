import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { hashCanonical } from '@strata-ctx/core-types';

import { RedactionError } from './errors.js';
import {
  FIXTURE_FORMAT_VERSION,
  canonicalBodyHash,
  parseFixtureFile,
  serializeFixtureFile,
  type FixtureEntry,
  type FixtureFile,
  type LoadedFixture,
  type RedactionRecord,
  type SseEvent,
} from './fixture.js';
import { parseJsonBody, type JsonValue } from './json.js';
import { redactBody, redactHeaders, scannableSecrets } from './redact.js';
import { parseSseStream } from './sse.js';

/**
 * The recorder: live provider traffic in, redacted fixture out.
 *
 * Fixtures are committed (docs/evaluation.md §6 -- "the suite runs in CI on
 * fixtures with zero network access and zero cost"), so this module's most
 * important property is not fidelity, it is that **nothing it writes contains a
 * credential**. Three guards, because one guard is one bug:
 *
 * 1. Redaction by field name on the way in (`redactHeaders` / `redactBody`).
 * 2. A post-serialisation scan of the exact bytes headed for the disk
 *    (`assertNoSecretsIn`), which turns "the rules should have caught it" into
 *    "the bytes provably do not contain it".
 * 3. The scan runs *before* `writeFileSync`, so a rejection leaves no file
 *    behind for the next `git add -A` to sweep up.
 *
 * The match key is computed over the **redacted** body. That is not an
 * optimisation, it is the only way a fixture can be replayed by a machine that
 * does not hold the key it was recorded with -- and it is why re-recording the
 * same session with a different key still matches.
 */

export interface ExchangeRequest {
  readonly method: string;
  readonly path: string;
  /** Raw body text. Absent or empty is legal (a GET). */
  readonly body?: string | Buffer;
  readonly headers?: Readonly<Record<string, string>>;
  /** Per-exchange label, e.g. a turn index. Purely for the diff on a miss. */
  readonly name?: string;
}

export interface ExchangeResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Raw response bytes exactly as received. Never a pre-parsed value. */
  readonly body: string | Buffer;
  /** Overrides content-type sniffing. */
  readonly kind?: 'json' | 'sse';
}

export interface RecordOptions {
  readonly provider?: string;
  /** Fixture-level name; also the default file name when writing. */
  readonly name?: string;
  /**
   * ISO-8601 UTC. Injectable so a recorded fixture is reproducible in a test;
   * defaults to now. Metadata only: nothing in matching reads it.
   */
  readonly recordedAt?: string;
}

export interface RecordedExchange {
  /** Schema-valid, credential-free, safe to write. */
  readonly entry: FixtureEntry;
  /**
   * The values that were removed, kept by the caller and never serialised.
   *
   * Returned rather than stashed on `entry` on purpose: the schema is strict, so
   * hiding them there would mean a non-enumerable field, a cast, or an object
   * that validates as a fixture and carries a live key. Making the caller hold
   * them means the write path has to be handed the check explicitly.
   */
  readonly secrets: readonly string[];
}

const asText = (value: string | Buffer | undefined): string =>
  value === undefined ? '' : typeof value === 'string' ? value : value.toString('utf8');

/** True when the response headers say SSE. Used when `kind` is not given. */
export function looksLikeSse(headers: Readonly<Record<string, string>>): boolean {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'content-type' && value.toLowerCase().includes('text/event-stream')) return true;
  }
  return false;
}

/**
 * Redacts an SSE stream's JSON payloads, frame by frame.
 *
 * A provider that echoes the request back -- which `tools/mock-upstream.ts` does,
 * and which is the cheapest possible way to see what actually went on the wire --
 * will stream a credential straight back inside a `data:` payload.
 *
 * Untouched frames are returned **by identity**, not re-serialised. Re-encoding a
 * clean frame would reflow its whitespace and defeat the byte-exactness claim
 * that is the entire point of recording a stream in the first place.
 */
export function redactSseStream(
  events: readonly SseEvent[],
): { readonly events: SseEvent[]; readonly hits: string[]; readonly secrets: string[] } {
  const hits: string[] = [];
  const secrets: string[] = [];
  const out = events.map((event, i) => {
    if (event.data === null || event.data === '') return event;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      // Not JSON, so there is no key to match on and nothing to redact.
      // "Guess at free text" is how a redactor starts eating ordinary output.
      return event;
    }
    const result = redactBody(parsed as JsonValue);
    if (result.hits.length === 0) return event;
    for (const hit of result.hits) hits.push(`response.events[${i}].data.${hit}`);
    secrets.push(...result.secrets);
    return { ...event, data: JSON.stringify(result.value) };
  });
  return { events: out, hits, secrets };
}

/**
 * Turns one captured exchange into a redacted entry plus the credentials that
 * were stripped. Pure: nothing is written and no clock is read unless asked.
 */
export function recordExchange(
  request: ExchangeRequest,
  response: ExchangeResponse,
): RecordedExchange {
  const method = request.method.toUpperCase();
  const path = request.path;
  const source = `${method} ${path}`;

  const rawBody = parseJsonBody(asText(request.body), source);
  // Provenance: what the provider actually received, before we touched it. Never
  // matched on -- a fixture that matched on the pre-redaction hash could not be
  // replayed without the original credential -- but it is what lets a reviewer
  // confirm redaction did not change what the request meant.
  const rawCanonicalHash = hashCanonical(rawBody);

  const requestHeaders = redactHeaders(request.headers ?? {});
  const requestBody = redactBody(rawBody);
  const responseHeaders = redactHeaders(response.headers ?? {});

  const isSse = response.kind === 'sse' || (response.kind === undefined && looksLikeSse(response.headers ?? {}));
  const responseBody: { hits: string[]; secrets: string[] } = { hits: [], secrets: [] };

  const recorded: FixtureEntry['response'] = isSse
    ? recordSseResponse(response, responseBody)
    : recordJsonResponse(response, source, responseBody);

  const headers = [...requestHeaders.hits, ...responseHeaders.hits];
  const bodyPaths = [...requestBody.hits, ...responseBody.hits];
  const redacted: RedactionRecord | undefined =
    headers.length === 0 && bodyPaths.length === 0 ? undefined : { headers, bodyPaths };

  return {
    entry: {
      ...(request.name === undefined ? {} : { name: request.name }),
      request: {
        method,
        path,
        canonicalHash: canonicalBodyHash(requestBody.value),
        rawCanonicalHash,
        headers: requestHeaders.value,
        body: requestBody.value,
      },
      response: recorded,
      ...(redacted === undefined ? {} : { redacted }),
    },
    secrets: [
      ...requestHeaders.secrets,
      ...requestBody.secrets,
      ...responseHeaders.secrets,
      ...responseBody.secrets,
    ],
  };
}

interface RedactionSink {
  hits: string[];
  secrets: string[];
}

function recordJsonResponse(
  response: ExchangeResponse,
  source: string,
  sink: RedactionSink,
): FixtureEntry['response'] {
  const headers = redactHeaders(response.headers ?? {});
  sink.hits.push(...headers.hits);
  sink.secrets.push(...headers.secrets);
  const parsed = parseJsonBody(asText(response.body), `response to ${source}`);
  const redacted = redactBody(parsed);
  for (const hit of redacted.hits) sink.hits.push(`response.body.${hit}`);
  sink.secrets.push(...redacted.secrets);
  return { kind: 'json', status: response.status, headers: headers.value, body: redacted.value };
}

function recordSseResponse(response: ExchangeResponse, sink: RedactionSink): FixtureEntry['response'] {
  const headers = redactHeaders(response.headers ?? {});
  sink.hits.push(...headers.hits);
  sink.secrets.push(...headers.secrets);
  const bytes = Buffer.from(asText(response.body), 'utf8');
  const parsed = parseSseStream(bytes);
  const stream = redactSseStream(parsed.events);
  sink.hits.push(...stream.hits);
  sink.secrets.push(...stream.secrets);
  return {
    kind: 'sse',
    status: response.status,
    headers: headers.value,
    eol: parsed.eol,
    events: stream.events,
  };
}

/**
 * Asserts that none of `secrets` survives in `text`.
 *
 * Runs on the serialised bytes rather than on the object, because the serialiser
 * is exactly where an un-redacted value can reappear -- a header that round-
 * tripped through a different encoder, a nested field the walker never reached.
 * Checking the object would miss that class of bug by construction.
 */
export function assertNoSecretsIn(text: string, secrets: readonly string[]): void {
  const leaks = scannableSecrets(secrets).filter((secret) => text.includes(secret));
  if (leaks.length === 0) return;
  throw new RedactionError(
    `refusing to write a fixture containing ${leaks.length} un-redacted credential(s). A committed ` +
      `fixture is a committed credential. The field-name rules in ./redact.ts did not cover: ` +
      `${leaks.map((s) => `${s.slice(0, 4)}…(${s.length} chars)`).join(', ')}.`,
  );
}

/** Assembles a validated fixture file from entries. */
export function buildFixtureFile(
  entries: readonly FixtureEntry[],
  options: RecordOptions & { readonly name: string },
): FixtureFile {
  const file: FixtureFile = {
    fixtureFormatVersion: FIXTURE_FORMAT_VERSION,
    provider: options.provider ?? 'recorded',
    name: options.name,
    ...(options.recordedAt === undefined ? {} : { recordedAt: options.recordedAt }),
    entries: [...entries],
  };
  // Validated before it is returned, not only when it is written: a caller that
  // serialises `file` itself must not be able to produce an unreadable fixture.
  return parseFixtureFile(file, `fixture ${options.name}`);
}

/**
 * Records, scans, then writes.
 *
 * The scan sits between assembly and `writeFileSync` on purpose: a file that
 * fails the check must not exist on disk even transiently.
 */
export function recordToFile(
  exchanges: readonly RecordedExchange[],
  path: string,
  options: RecordOptions & { readonly name: string },
): LoadedFixture {
  const file = buildFixtureFile(
    exchanges.map((e) => e.entry),
    options,
  );
  const text = serializeFixtureFile(file);
  assertNoSecretsIn(text, exchanges.flatMap((e) => e.secrets));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { encoding: 'utf8' });
  return { path, file };
}
