import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { JsonObject, JsonValue } from '../src/index.js';
import { jsonEqual } from '../src/index.js';

import { COMPOSITE_VALUES, NASTY_STRINGS, PRIMITIVE_VALUES, type Rng, rng } from './fixtures.js';

/**
 * The round-trip properties, shared by both format suites.
 *
 * ## Why this is a separate file
 *
 * TOON and TRON are the same grammar with a different header and a different row
 * prefix. Everything that can go wrong in a serializer -- quoting, escaping, the
 * bare/composite decision, the number grammar, surrogate pairs, key order -- can
 * go wrong identically in both. Writing the properties twice would mean the two
 * suites drift, and a fix applied to one would quietly not apply to the other.
 * Only the framing differs, so only the framing is tested separately.
 *
 * ## Why a generator and not a fixed corpus
 *
 * A corpus of 40 hand-picked strings catches the bugs those 40 strings describe.
 * A generator with a seed catches the ones nobody thought of, and replays them
 * exactly: `rng(1234)` is the same sequence on every machine, so a failure names
 * its own input.
 */

export interface Format {
  readonly name: string;
  readonly serialize: (value: unknown) => string;
  readonly parse: (text: string) => readonly JsonObject[];
  /** The first line, which every format must begin with. */
  readonly magic: string;
}

/** Enough seeds to cover a lot of value space without making the suite slow. */
const SEEDS = 64;

const _FIELDS = ['a', 'b', 'c'] as const;

const valueFor = (r: Rng, depth: number): JsonValue => {
  const roll = r.next();
  if (depth > 0 && roll < 0.2) return r.pick(COMPOSITE_VALUES);
  return r.pick(PRIMITIVE_VALUES);
};

const stringFor = (r: Rng): string => {
  const roll = r.next();
  if (roll < 0.5) return NASTY_STRINGS[r.int(NASTY_STRINGS.length)] ?? '';
  // Random ASCII, to cover the cases the curated list does not enumerate.
  const length = r.int(12);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(0x20 + r.int(0x5e));
  }
  return out;
};

/**
 * A uniform table: same fields, same order, arbitrary value types.
 *
 * Uniformity is the contract, so the generator honours it by construction -- a
 * generator that produced ragged rows would be testing the refusal path in the
 * round-trip suite, where a failure reads as a serialization bug.
 */
export function randomTable(r: Rng, rowCount: number): readonly JsonObject[] {
  return Object.freeze(
    Array.from({ length: rowCount }, () => ({
      a: valueFor(r, 1),
      b: stringFor(r),
      c: valueFor(r, 0),
    })),
  );
}

/** The single-value path, for the cases that are not tables. */
export function randomValue(r: Rng, depth = 0): JsonValue {
  if (depth > 2) return r.pick(PRIMITIVE_VALUES);
  const roll = r.next();
  if (roll < 0.3) return randomValue(r, depth + 1);
  return valueFor(r, depth);
}

export function checkRoundTrips(format: Format): void {
  describe(`${format.name}: round trip`, () => {
    it('recovers every generated table exactly', () => {
      for (let seed = 1; seed <= SEEDS; seed += 1) {
        const rows = randomTable(rng(seed), 1 + (seed % 5));
        const text = format.serialize(rows);
        const back = format.parse(text);
        assert.ok(
          jsonEqual(back as unknown as JsonValue, rows as unknown as JsonValue),
          `seed ${seed}: round trip changed the value\n${text}`,
        );
      }
    });

    it('recovers values that need quoting, embedded in a table', () => {
      for (let seed = 101; seed <= 101 + SEEDS; seed += 1) {
        const rows = randomTable(rng(seed), 3);
        const text = format.serialize(rows);
        assert.ok(
          jsonEqual(format.parse(text) as unknown as JsonValue, rows as unknown as JsonValue),
          `seed ${seed}: quoting round trip changed the value\n${text}`,
        );
      }
    });

    it('is deterministic: the same input gives byte-identical output', () => {
      const rows = randomTable(rng(7), 4);
      assert.equal(format.serialize(rows), format.serialize(rows));
    });

    it('re-parses its own output to the same value (idempotent)', () => {
      for (let seed = 201; seed <= 201 + 20; seed += 1) {
        const rows = randomTable(rng(seed), 3);
        const once = format.parse(format.serialize(rows));
        const twice = format.parse(format.serialize(once));
        assert.ok(
          jsonEqual(twice as unknown as JsonValue, rows as unknown as JsonValue),
          `seed ${seed}: re-parsing changed the value`,
        );
      }
    });

    it('starts with its own magic', () => {
      const text = format.serialize(randomTable(rng(3), 2));
      assert.ok(text.startsWith(format.magic), `expected ${format.magic} at the start of ${text}`);
    });
  });
}
