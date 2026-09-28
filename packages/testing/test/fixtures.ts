import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { hashCanonical } from '@strata-ctx/core-types';

import { FIXTURE_FORMAT_VERSION } from '../src/index.js';
import type { FixtureEntry, FixtureFile, JsonResponse, JsonValue, SseEvent, SseResponse } from '../src/index.js';

/**
 * Local factories for this package's own suite. Rule P2 (docs/development.md §2):
 * no cross-stream test fixtures, so nothing here reaches into another package's
 * test directory.
 *
 * Two conventions throughout, both forced by the compiler settings rather than
 * chosen:
 *
 * - Optional fields are added with `...(x === undefined ? {} : { x })`. With
 *   `exactOptionalPropertyTypes` an explicit `undefined` is *not* the same type
 *   as an absent key, so `{ event: undefined }` fails to typecheck against
 *   `event?: string`. Spreading is the only spelling that means "absent".
 * - Fixtures carry credentials as obviously-fake constants (`TEST_API_KEY`).
 *   The point of the redaction tests is that a real-looking secret is absent
 *   from the written bytes, which is only a meaningful assertion if the fixture
 *   actually contains one to begin with.
 */

export const TEST_API_KEY = 'sk-ant-rec-0123456789abcdefXYZ';
export const TEST_BEARER = 'Bearer rec-token-9876543210zzzz';
export const TEST_BODY_SECRET = 'sk-live-9f8e7d6c5b4a3210';
export const TEST_SESSION_COOKIE = 'session=rec-cookie-abcdef0123456789';

/** A secret shorter than `MIN_SCANNABLE_SECRET_LENGTH`, for the "not provable" path. */
export const SHORT_SECRET = 'abc';

/** ISO-8601 UTC, fixed so a recorded fixture is byte-reproducible. */
export const RECORDED_AT = '2026-02-11T09:30:00Z';

export interface FrameOptions {
  readonly event?: string;
  readonly id?: string;
  readonly retry?: number;
  readonly comment?: string;
  /** `null` (the default) means the frame carried no `data:` field at all. */
  readonly data?: string | null;
  readonly delayMs?: number;
  /** `false` marks a frame that was never terminated: a captured cut. */
  readonly complete?: boolean;
}

export function frame(options: FrameOptions = {}): SseEvent {
  return {
    ...(options.event === undefined ? {} : { event: options.event }),
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
    ...(options.comment === undefined ? {} : { comment: options.comment }),
    // `??` rather than `||`: an empty payload is a real payload and must survive.
    data: options.data ?? null,
    delayMs: options.delayMs ?? 0,
    complete: options.complete ?? true,
  };
}

/** A `data:`-only frame, the shape the majority of provider traffic takes. */
export function dataFrame(data: string, options: Omit<FrameOptions, 'data'> = {}): SseEvent {
  return frame({ ...options, data });
}

export interface EntryOptions {
  readonly name?: string;
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Match-keyed request body. Defaults to a two-key body. */
  readonly body?: JsonValue;
  readonly rawCanonicalHash?: string;
  readonly status?: number;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  /** JSON response body. Mutually exclusive with `events`. */
  readonly responseBody?: JsonValue;
  /** SSE frames. An empty array is a legal recording of an empty stream. */
  readonly events?: readonly SseEvent[];
  readonly eol?: '\n' | '\r\n';
  readonly redactedHeaders?: readonly string[];
  readonly redactedBodyPaths?: readonly string[];
}

/** The default request body, in this key order. */
export const DEFAULT_REQUEST_BODY: JsonValue = {
  model: 'claude-sonnet-4',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'hello' }],
};

export function entry(options: EntryOptions = {}): FixtureEntry {
  // `null` is a member of `JsonValue`, so `??` is wrong here: it would turn a
  // deliberately-null body (a GET, or an empty request) into the default one and
  // quietly make the fixture describe a different request than intended.
  const body = options.body === undefined ? DEFAULT_REQUEST_BODY : options.body;
  const responseBody = options.responseBody === undefined ? { ok: true } : options.responseBody;
  const redacted =
    options.redactedHeaders === undefined && options.redactedBodyPaths === undefined
      ? {}
      : {
          redacted: {
            headers: [...(options.redactedHeaders ?? [])],
            bodyPaths: [...(options.redactedBodyPaths ?? [])],
          },
        };
  return {
    ...(options.name === undefined ? {} : { name: options.name }),
    request: {
      method: options.method ?? 'POST',
      path: options.path ?? '/v1/messages',
      canonicalHash: hashCanonical(body),
      ...(options.rawCanonicalHash === undefined ? {} : { rawCanonicalHash: options.rawCanonicalHash }),
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
      body,
    },
    response:
      options.events === undefined
        ? {
            kind: 'json',
            status: options.status ?? 200,
            headers: { 'content-type': 'application/json', ...(options.responseHeaders ?? {}) },
            body: responseBody,
          }
        : {
            kind: 'sse',
            status: options.status ?? 200,
            headers: { 'content-type': 'text/event-stream', ...(options.responseHeaders ?? {}) },
            eol: options.eol ?? '\n',
            events: [...options.events],
          },
    ...redacted,
  };
}

export interface FixtureFileOptions {
  readonly name?: string;
  readonly provider?: string;
  readonly recordedAt?: string;
  readonly entries?: readonly FixtureEntry[];
  /** Escape hatch for negative tests that need a malformed document. */
  readonly version?: number;
}

export function fixtureFile(options: FixtureFileOptions = {}): FixtureFile {
  // Written without validation on purpose: the negative tests need documents
  // this harness must *reject* (a stale version, a bad hash, a dropped key), and
  // `parseFixtureFile` is the gate that rejects them. The cast is confined to
  // this one line so the intent cannot leak into the rest of the factory.
  const version = (options.version ?? FIXTURE_FORMAT_VERSION) as typeof FIXTURE_FORMAT_VERSION;
  return {
    fixtureFormatVersion: version,
    provider: options.provider ?? 'anthropic',
    name: options.name ?? 'anthropic-smoke',
    ...(options.recordedAt === undefined ? {} : { recordedAt: options.recordedAt }),
    entries: options.entries === undefined ? [entry({ name: 'turn-1' })] : [...options.entries],
  };
}

/** A bare `FixtureResponse`, for tests about a response rather than an entry. */
export function sseResponse(events: readonly SseEvent[], eol: '\n' | '\r\n' = '\n'): SseResponse {
  return { kind: 'sse', status: 200, headers: {}, eol, events: [...events] };
}

export function jsonResponse(body: JsonValue, status = 200): JsonResponse {
  return { kind: 'json', status, headers: {}, body };
}

/**
 * A temp directory that removes itself when the test ends.
 *
 * Cleanup is registered on the test context rather than left to a `finally`: a
 * failed assertion throws out of the callback, and a fixture file left behind in
 * `os.tmpdir()` is how a later run silently passes against a stale artifact.
 */
export function tempDir(t: TestContext, prefix = 'strata-fixture-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * A stream of SSE text, built from raw lines so a test can state the exact bytes
 * on the wire -- including the absence of a final blank line, which is the whole
 * point of the truncated-tail cases.
 */
export function sseText(...blocks: readonly string[]): string {
  return blocks.join('\n\n');
}
