import type { ToonError } from './errors.js';
import { toonError } from './errors.js';

/**
 * The JSON value domain, defined narrowly enough to be checkable.
 *
 * `unknown` is what arrives off a wire. `JsonValue` is what we are willing to
 * promise is inside it. The gap between the two is where silent data loss lives:
 * `JSON.stringify` turns `undefined` properties into absent ones, `NaN` and
 * `Infinity` into `null`, and a `Date` into a string, all without an error. Every
 * one of those is a field the agent was told about and no longer has.
 *
 * So this module refuses rather than encodes. Refusal is cheap -- the callers
 * fall back to plain JSON, and when the value is not even JSON-representable
 * they fall back to passthrough -- and it is the only option that cannot
 * corrupt anything.
 */

export type JsonPrimitive = string | number | boolean | null;

export type JsonArray = readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

/**
 * Recursion cap for the validator.
 *
 * Flagged, not sourced: nothing in the plan measures a realistic record's
 * nesting depth. The reason to have one at all is that the validator runs on
 * attacker-influenceable text, and an unbounded walk over a 10^6-deep structure
 * is a stack overflow -- which the fail-open callers would turn into a silent
 * passthrough of something they never inspected. 64 is far above any record a
 * tool emits and far below anything that threatens the stack.
 */
export const MAX_JSON_DEPTH = 64;

/** Diagnostic paths are truncated: an error message is not a debugging tool. */
const PATH_LIMIT = 80;

const truncatePath = (p: string): string => (p.length <= PATH_LIMIT ? p : `${p.slice(0, PATH_LIMIT)}...`);

/**
 * `Array.isArray` narrows to `any[]`, which on a `readonly` array type reopens the
 * `any` hole the rest of the package is built to avoid. A local guard with a
 * declared predicate narrows correctly and keeps every value typed.
 *
 * The parameter is `unknown` rather than `object` because the callers that matter
 * most compare two `JsonValue`s, where either side may be a primitive; an
 * `object` parameter would make the comparison unreachable to the type system
 * rather than to the guard.
 */
export const isJsonArray = (v: unknown): v is JsonArray => Array.isArray(v);

const _describe = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'non-plain object' : typeof v;

function walk(v: unknown, path: string, depth: number, seen: Set<object>): ToonError | undefined {
  const reject = (code: Parameters<typeof toonError>[0], what: string): ToonError =>
    toonError(code, `${what} at ${truncatePath(path)}`);

  if (depth > MAX_JSON_DEPTH) {
    return reject('too_deep', `nesting deeper than ${MAX_JSON_DEPTH}`);
  }
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return undefined;

  if (typeof v === 'number') {
    // JSON has no NaN, no infinities, and no negative zero. `JSON.stringify(-0)`
    // is `"0"`, so a negative zero would come back as a different value -- and
    // `Object.is(-0, 0)` is false, so nothing downstream would notice the swap.
    if (!Number.isFinite(v)) return reject('unsupported_value', `${String(v)} is not a JSON number`);
    if (Object.is(v, -0)) return reject('unsupported_value', '-0 is not a JSON number');
    return undefined;
  }
  if (typeof v !== 'object') return reject('unsupported_value', `a ${typeof v} is not a JSON value`);

  const o: object = v;
  if (seen.has(o)) return reject('circular_reference', 'the value contains a cycle');
  seen.add(o);

  try {
    if (isJsonArray(o)) {
      for (let i = 0; i < o.length; i += 1) {
        const bad = walk(o[i], `${path}[${i}]`, depth + 1, seen);
        if (bad !== undefined) return bad;
      }
      return undefined;
    }

    // A Date, a Map, or a class instance all have a prototype that is neither
    // Object.prototype nor null. `JSON.stringify` will happily produce *something*
    // for each -- an ISO string, `{}`, a few enumerable fields -- and that
    // something is not the value.
    const proto = Object.getPrototypeOf(o) as object | null;
    if (proto !== Object.prototype && proto !== null) {
      return reject('not_plain_object', 'the prototype is neither Object.prototype nor null');
    }

    // Non-enumerable and symbol-keyed own properties are dropped by
    // `JSON.stringify` and by `Object.keys`. This is the brief's "unrecognised
    // field" case in the direction that loses data rather than corrupting it.
    if (Object.getOwnPropertyNames(o).length !== Object.keys(o).length) {
      return reject('unsupported_key', 'a non-enumerable own property would be dropped');
    }
    if (Object.getOwnPropertySymbols(o).length > 0) {
      return reject('unsupported_key', 'a symbol-keyed own property would be dropped');
    }

    // The one cast this module needs: an `object` already proven to have a plain
    // prototype, read as a string-keyed bag. The alternative -- `Reflect.ownKeys`
    // plus a narrowing helper per key -- buys nothing, because the two checks
    // above established that every own key is a string and is enumerable.
    const bag = o as Record<string, unknown>;
    for (const key of Object.keys(bag)) {
      const bad = walk(bag[key], `${path}.${key}`, depth + 1, seen);
      if (bad !== undefined) return bad;
    }
    return undefined;
  } finally {
    // Deleted rather than kept, so a value that legitimately appears twice in a
    // tree -- the same frozen record reused across two rows -- is not mistaken
    // for a cycle. Only an edge back into an *ancestor* is a cycle.
    seen.delete(o);
  }
}

/**
 * The single defect check. `undefined` means "inside the JSON domain".
 *
 * Returns the error rather than a boolean so a caller that has to say *why* a
 * block was left alone can: that is the difference between "did not compress" and
 * "did not compress, because a value in row 3 was a Date".
 */
export const jsonDefect = (v: unknown): ToonError | undefined => walk(v, '$', 0, new Set());

/** Predicate form, for the places where the answer is all that is wanted. */
export const isJsonValue = (v: unknown): v is JsonValue => jsonDefect(v) === undefined;

/**
 * Assertion form. A `function` declaration rather than an arrow, because
 * TypeScript only honours `asserts` signatures on declarations whose type it can
 * read.
 */
export function assertJsonValue(v: unknown, where = 'value'): asserts v is JsonValue {
  const defect = jsonDefect(v);
  if (defect !== undefined) {
    throw toonError(defect.code, `${where}: ${defect.message.replace(`${defect.code}: `, '')}`);
  }
}

/**
 * Structural equality over the JSON domain, comparing key *sequences* rather than
 * key sets.
 *
 * Ordered comparison is stricter than JSON semantics and deliberately so. Key
 * order is the one part of a record that a re-serialisation can change without
 * changing any value, and this function is the last check before compressed
 * output reaches a model. If the compressor ever reorders keys, that is a bug
 * worth failing on rather than a difference worth tolerating.
 */
export function jsonEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === null || b === null) return a === b;

  // A container and a scalar can never be equal, and the `typeof` test is the
  // only place that fact is knowable: further down both sides are narrowed to
  // `JsonArray | JsonObject` and the primitive cases are unrepresentable.
  if (typeof a !== 'object' || typeof b !== 'object') return a === b;

  if (isJsonArray(a)) {
    if (!isJsonArray(b)) return false;
    for (let i = 0; i < a.length; i += 1) {
      const left = a[i];
      const right = b[i];
      if (left === undefined || right === undefined) return left === right;
      if (!jsonEqual(left, right)) return false;
    }
    return true;
  }
  if (isJsonArray(b)) return false;

  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i += 1) {
    const key = ka[i];
    if (key === undefined || key !== kb[i]) return false;
    const left = a[key];
    const right = b[key];
    if (left === undefined || right === undefined) {
      if (left !== right) return false;
      continue;
    }
    if (!jsonEqual(left, right)) return false;
  }
  return true;
}
