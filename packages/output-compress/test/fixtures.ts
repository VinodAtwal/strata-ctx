import type {
  ArtifactRef,
  NonGovernanceBlock,
  NonGovernanceMessage,
  NonGovernanceTier,
  Role,
  Severity,
  SubjectKind,
} from '@strata-ctx/core-types';
import { sha256 } from '@strata-ctx/core-types';

import type { JsonObject, JsonValue, MachineFormat, ModelRegistry, OutputCompressPolicy } from '../src/index.js';
import { DEFAULT_MIN_SAVINGS_FRAC, DEFAULT_REGISTRY, registryWith, withSupport } from '../src/index.js';

/**
 * Local fixtures for this package. Rule P2: no cross-stream test fixtures, so
 * nothing here imports another package's test directory.
 *
 * ## Three things in here worth explaining
 *
 * **The builders are narrow, not wide.** `block` returns `NonGovernanceBlock`,
 * never `ContentBlock`. Every lossy operator in this stream is handed one of
 * these, and a fixture that returned the wide type would need a cast at the call
 * site -- which is exactly the hole `NonGovernanceMessage` exists to close. The
 * cast would be in every test file, and it would be in none of the source.
 *
 * **The PRNG is seeded and local.** `rng` is a mulberry32 with a fixed seed, so
 * a property failure is reproducible from the test name alone. Math.random is
 * never used: a suite that fails once in forty runs and cannot be replayed is a
 * suite people delete.
 *
 * **The nasty-string corpus is a list, not a generator.** Enumerated by hand,
 * because the interesting strings are the ones nobody thinks of -- the empty
 * string, a lone surrogate, the literal text `null`, a value that looks like a
 * number but is not. A random string generator produces most of these about
 * never, and "about never" is not a test.
 */

// ---------------------------------------------------------------- determinism

export interface Rng {
  /** Float in [0, 1). */
  readonly next: () => number;
  /** Integer in [0, n). */
  readonly int: (n: number) => number;
  readonly pick: <T>(items: readonly T[]) => T;
  readonly bool: () => boolean;
}

/**
 * mulberry32. Small, fast, and good enough for fixture data; the only property
 * that matters here is that the same seed gives the same sequence on every
 * machine, which the algorithm's integer arithmetic guarantees.
 */
export function rng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: <T,>(items: readonly T[]): T => {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error('rng.pick on an empty list');
      return item;
    },
    bool: () => next() < 0.5,
  };
}

// ------------------------------------------------------------ nasty strings

/**
 * Every string here has broken a real serializer at some point.
 *
 * Kept as data rather than as a loop over a character set, because the failures
 * worth guarding against are *combinations* -- a comma inside quotes, a closing
 * brace that is data, a surrogate that is unpaired. A per-character sweep finds
 * none of them.
 */
export const NASTY_STRINGS: readonly string[] = Object.freeze([
  '',
  ' ',
  'plain',
  ' leading',
  'trailing ',
  'a,b',
  'a{b}c',
  'has "quotes"',
  'has\ttab',
  'has\nnewline',
  'has\r\ncrlf',
  'null',
  'true',
  'false',
  'NaN',
  'Infinity',
  '-0',
  '007',
  '1e5',
  '"quoted"',
  "'single'",
  '`backtick`',
  '#hash',
  '//slash',
  '/*comment*/',
  '{not json}',
  '[not json]',
  '{"looks":"like json"}',
  'ünïcode',
  '日本語',
  'emoji 😀 ok',
  'combining é',
  'lone \ud800 high',
  'lone \udfff low',
  'pair 😀 intact',
  'ends with backslash \\',
  'two\\nbackslash-n',
  'ok\n',
  '\nleading newline',
  '\u0000nul',
  'plain text with words and a full stop.',
]);

/**
 * Values that a naive encoder would emit bare and a strict reader must accept.
 *
 * `-0` is deliberately absent. It is not a JSON number (`JSON.stringify(-0)` is
 * `"0"`), so `json-value.ts` refuses it as `unsupported_value`; listing it here
 * would make every property suite in this package fail for a reason that has
 * nothing to do with the thing under test.
 */
export const PRIMITIVE_VALUES: readonly JsonValue[] = Object.freeze([
  null,
  true,
  false,
  0,
  1,
  -1,
  1.5,
  -2.25,
  1e21,
  1e-7,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  0.1,
  '',
  'x',
  ...NASTY_STRINGS,
]);

/** Composite values, which must travel as compact JSON inside a cell. */
export const COMPOSITE_VALUES: readonly JsonValue[] = Object.freeze([
  {},
  [],
  { a: 1 },
  { a: null, b: [true, false] },
  [1, 2, 3],
  [[1], [2, [3, [4]]]],
  { deep: { deeper: { deepest: [1, null, 'x', { y: [] }] } } },
  { 'weird key': 'v', 'a,b': 2, '': 3 },
  [{ a: 1 }, { a: 2 }],
  { 'quote"key': 'new\nline' },
]);

// ------------------------------------------------------------------- tables

export interface SampleTable {
  readonly name: string | undefined;
  readonly fields: readonly string[];
  readonly rows: readonly JsonObject[];
}

const rows = (count: number, make: (i: number) => JsonObject): readonly JsonObject[] =>
  Object.freeze(Array.from({ length: count }, (_, i) => make(i)));

/** Uniform, non-empty, order-stable: the shape both formats accept. */
export const FILE_ROWS: SampleTable = Object.freeze({
  name: 'files',
  fields: Object.freeze(['path', 'size', 'ok']),
  rows: rows(4, (i) => ({
    path: i % 2 === 0 ? `src/dir${i}/file-${i}.ts` : `ünïcode/😀-${i}.ts`,
    size: i * 1200,
    ok: i % 3 !== 0,
  })),
});

/** Uniform, and every field needs quoting. The case that finds quoting bugs. */
export const AWKWARD_ROWS: SampleTable = Object.freeze({
  name: undefined,
  fields: Object.freeze(['path', 'note', 'extra']),
  rows: rows(3, (i) => ({
    path: `a,b and {braces} ${i}`,
    note: NASTY_STRINGS[(i * 7 + 3) % NASTY_STRINGS.length] ?? '',
    extra: { nested: [i, null, 'x'] },
  })),
});

/** One row. Serializes longer than JSON; the savings floor must catch it. */
export const SINGLE_ROW: SampleTable = Object.freeze({
  name: 'one',
  fields: Object.freeze(['a', 'b']),
  rows: rows(1, () => ({ a: 1, b: 2 })),
});

/** Wide enough to beat JSON comfortably. */
export const WIDE_ROWS: SampleTable = Object.freeze({
  name: undefined,
  fields: Object.freeze(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']),
  rows: rows(6, (i) => ({
    a: `value-${i}`,
    b: i,
    c: i % 2 === 0,
    d: null,
    e: [i],
    f: { k: i },
    g: `g${i}`.repeat(3),
    h: -(i + 1),
  })),
});

/** Ragged: the rows disagree about width. Must be refused, not repaired. */
export const RAGGED_ROWS: readonly unknown[] = Object.freeze([
  { a: 1, b: 2 },
  { a: 3 },
  { a: 4, b: 5, c: 6 },
]);

/** Uniform field names, non-uniform *types*. Still a table: types may vary. */
export const MIXED_TYPE_ROWS: readonly unknown[] = Object.freeze([
  { a: 1, b: 'x' },
  { a: null, b: 2 },
  { a: true, b: [1] },
  { a: { z: 1 }, b: null },
]);

/** A JSON object rather than an array of records. Not a table. */
export const OBJECT_ROWS: unknown = Object.freeze({ a: 1, b: 2 });

// ------------------------------------------------------------------ builders

type NonGovernanceMeta = NonGovernanceBlock['meta'];

export function meta(over: Partial<NonGovernanceMeta> = {}): NonGovernanceMeta {
  return {
    origin: 'tool',
    sha256: sha256(over.subject?.ref ?? `seed-${over.tier ?? 'episodic'}`),
    tier: 'episodic',
    bytes: 100,
    cacheable: false,
    ...over,
  };
}

export function block(over: Partial<NonGovernanceBlock> = {}): NonGovernanceBlock {
  const text = over.text ?? 'hello';
  return { type: 'text', text, meta: meta({ bytes: text.length }), ...over };
}

export function message(
  role: Role,
  content: readonly NonGovernanceBlock[],
  ts = 0,
): NonGovernanceMessage {
  return { role, content, ts };
}

/** A tool result, which is the shape most likely to be machine data. */
export function toolResult(options: {
  readonly text: string;
  readonly ref?: string;
  readonly kind?: SubjectKind;
  readonly tier?: NonGovernanceTier;
  readonly severity?: Severity;
  readonly id?: string;
  readonly toolName?: string;
}): NonGovernanceBlock {
  const text = options.text;
  return block({
    type: 'tool_result',
    text,
    id: options.id ?? 'call-1',
    toolName: options.toolName ?? 'search',
    meta: meta({
      tier: options.tier ?? 'tool_state',
      bytes: text.length,
      ...(options.ref === undefined
        ? {}
        : { subject: { kind: options.kind ?? ('other' as const), ref: options.ref } }),
      ...(options.severity === undefined ? {} : { severity: options.severity }),
    }),
  });
}

/** A block with a subject that is *not* tool state: a file read. */
export function fileRead(text: string, ref: string, tier: NonGovernanceTier = 'tool_state'): NonGovernanceBlock {
  return toolResult({ text, ref, kind: 'file', tier });
}

export function artifact(uri: string, bytes: number, sha = sha256(uri)): ArtifactRef {
  return { uri, sha256: sha, bytes, kind: 'other' };
}

// ------------------------------------------------------------------- policy

export interface PolicyOptions {
  readonly model?: string;
  readonly machineFormat?: MachineFormat;
  readonly registry?: ModelRegistry;
  readonly allowUnverified?: boolean;
  readonly minSavingsFrac?: number;
  readonly tableName?: string;
  readonly referenceEnabled?: boolean;
  readonly maxInlineBytes?: number;
  readonly gateOnCost?: boolean;
  readonly rho?: number;
  readonly k?: number;
}

/**
 * The stage policy, with `allowUnverified` on by default.
 *
 * Deliberate: the default `DEFAULT_POLICY` is conservative, so a test that
 * wanted TOON would otherwise be testing the registry's refusal rather than the
 * serializer. Registry behaviour has its own tests, and there it is the point.
 */
export function policy(options: PolicyOptions = {}): OutputCompressPolicy {
  return {
    model: options.model ?? 'gpt-5',
    machineFormat: options.machineFormat ?? 'toon',
    registry: options.registry ?? DEFAULT_REGISTRY,
    allowUnverifiedFormats: options.allowUnverified ?? true,
    minSavingsFrac: options.minSavingsFrac ?? DEFAULT_MIN_SAVINGS_FRAC,
    ...(options.tableName === undefined ? {} : { tableName: options.tableName }),
    reference: {
      enabled: options.referenceEnabled ?? false,
      maxInlineBytes: options.maxInlineBytes ?? 0,
    },
    cost: { rho: options.rho ?? 4, k: options.k ?? 1 },
    gateOnCost: options.gateOnCost ?? false,
  };
}

// ------------------------------------------------------------------ helpers

export const json = (value: JsonValue): string => JSON.stringify(value);

/** A registry where one model is verified for the formats under test. */
export const verifiedRegistry = (
  model: string,
  formats: readonly MachineFormat[],
): ModelRegistry => registryWith(withSupport(model, { status: 'verified', formats }));
