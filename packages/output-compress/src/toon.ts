import type { JsonObject } from './json-value.js';
import { assertJsonValue } from './json-value.js';
import type { TableFraming, TableOptions } from './table.js';
import { parseTable, serializeTable } from './table.js';

/**
 * H-1. TOON: Token-Oriented Object Notation for arrays of uniform records.
 *
 * ## What the format is
 *
 *     toon1 files[2]{path,size}:
 *       src/a.ts,120
 *       src/b.ts,340
 *
 * A header naming the magic, the row count and the columns, then one indented
 * line per record. The saving is structural rather than lexical: JSON repeats
 * every key on every row, and a table pays for each key exactly once.
 *
 * ## Why the parser is the careful half
 *
 * The brief for this stream is that "a permissive parser that silently drops
 * unrecognised fields will lose data without anyone noticing". Every decision in
 * ./table.ts and ./grammar.ts follows from that. The ones worth naming:
 *
 * - **The row count is load-bearing.** A reader that trusted the body to end
 *   where the rows end would append a stray line as a record. Every line past
 *   the declared count is a `row_count_mismatch`, in both formats.
 * - **The indent is load-bearing.** It is the only thing marking a line as data,
 *   so a line without it is `unexpected_line` rather than a row.
 * - **Nothing is inferred.** An empty cell, a repeated column, a nested object
 *   with a repeated key, a value with two readings: all refused, none guessed.
 *
 * ## Why the two-space indent
 *
 * TOON is the readable, model-facing format and TRON is the terse one, so the
 * indent is only worth paying for if it is visible in a diff of a tool result.
 */

/** Version tag. Bumping it means the framing changed and old readers must refuse. */
export const TOON_MAGIC = 'toon1';

export const TOON_ROW_INDENT = '  ';

export const TOON_FRAMING: TableFraming = Object.freeze({
  magic: TOON_MAGIC,
  indent: TOON_ROW_INDENT,
  requiresIndent: true,
  label: 'toon',
});

/**
 * Serialize an array of uniform flat records.
 *
 * Takes `unknown` because this is a boundary: the value arrives off a wire and
 * the first job is to find out whether it is something this format can represent
 * at all. `assertJsonValue` runs before the shape check, so a `Date`, a `NaN`, a
 * non-enumerable property or a cycle is a typed refusal rather than a table that
 * has quietly become a different thing.
 */
export function serializeToon(value: unknown, options?: TableOptions): string {
  assertJsonValue(value, 'the tool result');
  return serializeTable(value, TOON_FRAMING, options);
}

/**
 * Read a TOON document. Throws `ToonError` on anything it will not accept.
 *
 * The return type is `readonly JsonObject[]` because that is the only shape the
 * format encodes. It is deliberately not a widened `JsonValue`, which keeps a
 * caller from indexing into "maybe an object" and having the type system agree.
 */
export function parseToon(text: string): readonly JsonObject[] {
  return parseTable(text, TOON_FRAMING);
}
