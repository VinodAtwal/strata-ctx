import { ToonError } from './errors.js';
import type { JsonValue } from './json-value.js';
import { jsonEqual } from './json-value.js';

/**
 * H-7. Bounded repair for first-rollout format errors.
 *
 * ## The failure being repaired
 *
 * A model asked for TOON emits prose, or a JSON object where a table was asked
 * for, or a table with a row missing. One more turn -- "that was not TOON, emit
 * exactly this and nothing else" -- fixes it most of the time. That is the whole
 * feature.
 *
 * ## The one thing this module is really about
 *
 * **It must terminate.** A repair loop that asks a model to try again, and asks
 * again when the answer is still wrong, is a mechanism for spending a session's
 * entire budget on a tool result that will never parse. The bound is therefore
 * not a caller preference:
 *
 * - `MAX_REPAIR_ATTEMPTS` is a module constant and `maxAttempts` is *clamped* to
 *   it. A config file cannot raise it.
 * - A throwing `attempt` counts as an attempt. An exception is not an escape
 *   hatch out of the budget.
 * - Exhaustion returns the original value. There is no "return the best
 *   partial parse", because a partial parse of a table is a table with rows
 *   missing and nothing downstream can tell.
 *
 * Every path out of `repairFormat` terminates: a value, or the original.
 */

export const MAX_REPAIR_ATTEMPTS = 2;

/** What the caller sends the model on each attempt, and what it sent last time. */
export interface RepairPrompt {
  readonly attempt: number;
  /** `undefined` on the first attempt; the code that failed before otherwise. */
  readonly lastCode: RepairFailure | undefined;
  /**
   * The error text, verbatim. Handed to the model rather than paraphrased: a
   * paraphrase is where "the model has no idea what you meant" starts.
   */
  readonly lastMessage: string | undefined;
}

/**
 * Why an attempt failed. The `ToonError` codes plus the two that are not the
 * parser's to raise: something that was not a `ToonError` at all, and a reply
 * that parsed into a *different* value.
 */
export type RepairFailure = ToonError['code'] | 'unknown' | 'not_equal';

export interface RepairRequest {
  /** The value we are trying to reproduce, and the value we will fall back to. */
  readonly original: JsonValue;
  /** Build the prompt for attempt `n`. Called at most `attempts` times. */
  readonly ask: (prompt: RepairPrompt) => string;
  /**
   * Read the model's reply. Throwing a `ToonError` is how it reports a format
   * error; throwing anything else is a bug and is counted as a failed attempt
   * rather than being allowed to escape.
   */
  readonly read: (reply: string) => JsonValue;
  /**
   * Clamped to `[0, MAX_REPAIR_ATTEMPTS]`. Absent means the maximum, because a
   * caller that does not think about the bound should get the safe one.
   */
  readonly maxAttempts?: number;
  /**
   * Local fixups applied to a reply before it is read. The only one shipped is
   * a single enclosing code fence, because that is the overwhelmingly common
   * first-rollout error and because stripping a fence is the one normalisation
   * that cannot invent or discard a *value*.
   */
  readonly normalize?: (reply: string) => string;
}

export interface RepairAttemptLog {
  readonly attempt: number;
  readonly code: RepairFailure | undefined;
  readonly message: string;
  readonly replyChars: number;
}

export interface RepairResult {
  /** `undefined` when the budget ran out. Then `original` is what to use. */
  readonly value: JsonValue | undefined;
  readonly original: JsonValue;
  readonly attempts: readonly RepairAttemptLog[];
  /** True when the value was recovered. */
  readonly ok: boolean;
  /** True when the bound was reached without a usable value. */
  readonly exhausted: boolean;
  readonly detail: string;
}

/**
 * A single enclosing code fence, and nothing else.
 *
 * `^\s*```[a-z]*\n` ... `\n```\s*$` with the language word removed. Two
 * constraints make this safe and they are the reason it is not a general
 * "clean up the model's markdown" pass:
 *
 * 1. The fence must be the *entire* reply. A fenced block followed by a sentence
 *    is not stripped, because the sentence might be the only thing holding the
 *    answer together and there is no way to know.
 * 2. Only one pair, only at the ends. A document that nests fences is a document
 *    this function does not understand, and an unterminated fence is left
 *    alone for `read` to reject.
 *
 * There is no attempt to fix "here is the table you asked for:" or a missing
 * final newline. Those are guesses about intent, and a guess that produces a
 * parseable prefix of the wrong thing is the failure mode this stream is about.
 */
export const stripEnclosingFence = (reply: string): string => {
  const FENCE = /^\s*```[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/;
  const match = FENCE.exec(reply);
  if (match === null) return reply;
  const inner = match[1];
  if (inner === undefined) return reply;
  // A second fence inside means the outer one was not the document's boundary.
  if (inner.includes('```')) return reply;
  return inner;
};

/**
 * A `ToonError` reports its own code; anything else is a bug in a caller's
 * `read` and is reported as `unknown` rather than smuggled into the union, where
 * a `switch` would quietly stop being exhaustive.
 */
const codeOf = (error: unknown): RepairFailure =>
  error instanceof ToonError ? error.code : 'unknown';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Try to recover a value, within a hard bound, or return the original.
 *
 * The returned `value` is only ever set when `read` succeeded *and* the result
 * deep-equals the original. The equality check is the point: a repair that
 * returns a plausible-looking but different table has silently changed a tool
 * result, and "it parsed" is not evidence that it parsed into the right thing.
 */
export function repairFormat(request: RepairRequest): RepairResult {
  const wanted = clampAttempts(request.maxAttempts);
  const normalize = request.normalize ?? stripEnclosingFence;
  const logs: RepairAttemptLog[] = [];
  let lastCode: RepairFailure | undefined;
  let lastMessage: string | undefined;

  for (let attempt = 1; attempt <= wanted; attempt += 1) {
    let reply: string;
    try {
      reply = request.ask({ attempt, lastCode, lastMessage });
    } catch (error) {
      // An exception is still a turn spent and still a failure to recover from.
      lastCode = 'unknown';
      lastMessage = messageOf(error);
      logs.push({ attempt, code: lastCode, message: lastMessage, replyChars: 0 });
      continue;
    }

    try {
      const value = request.read(normalize(reply));
      if (!jsonEqual(value, request.original)) {
        lastCode = 'not_equal';
        lastMessage = 'the reply parsed, but it is not the value that was asked for';
        logs.push({ attempt, code: lastCode, message: lastMessage, replyChars: reply.length });
        continue;
      }
      return Object.freeze({
        value,
        original: request.original,
        attempts: Object.freeze([...logs]),
        ok: true,
        exhausted: false,
        detail: `recovered on attempt ${attempt}`,
      });
    } catch (error) {
      lastCode = codeOf(error);
      lastMessage = messageOf(error);
      logs.push({ attempt, code: lastCode, message: lastMessage, replyChars: reply.length });
    }
  }

  return Object.freeze({
    value: undefined,
    original: request.original,
    attempts: Object.freeze([...logs]),
    ok: false,
    exhausted: wanted > 0,
    detail:
      wanted === 0
        ? 'repair is disabled for this model'
        : `${logs.length} attempt${logs.length === 1 ? '' : 's'} spent without a usable reply; the original is returned`,
  });
}

const clampAttempts = (n: number | undefined): number => {
  if (n === undefined) return MAX_REPAIR_ATTEMPTS;
  if (!Number.isFinite(n)) return MAX_REPAIR_ATTEMPTS;
  return Math.max(0, Math.min(MAX_REPAIR_ATTEMPTS, Math.floor(n)));
};

/** The prompt a caller would actually send, for the built-in directives. */
export const repairInstruction = (code: RepairFailure | undefined): string =>
  [
    'The previous reply was not in the requested format.',
    code === undefined ? '' : `It failed with: ${code}.`,
    'Reply with the format only. No preamble, no explanation, no code fence.',
  ]
    .filter((line) => line !== '')
    .join(' ');
