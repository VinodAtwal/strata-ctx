import type { JsonObject } from './json-value.js';
import { assertJsonValue } from './json-value.js';
import type { TableFraming, TableOptions } from './table.js';
import { parseTable, serializeTable } from './table.js';

/**
 * H-2. TRON: the terse framing, same grammar.
 *
 *     t1 files[2]{path,size}:
 *     src/a.ts,120
 *     src/b.ts,340
 *
 * ## What it actually changes
 *
 * Two bytes per data line (the indent) and one byte in the magic. That is all,
 * and it is worth saying plainly rather than dressing up: the interesting half
 * of H-2 is not TRON, it is the *selector* in ./select.ts, which measures both
 * and takes the shorter. For a 20-row table TRON is worth about 4% of the
 * document; for a 2-row table it is worth nothing and the selector will say so.
 *
 * ## Why the row count is not dropped
 *
 * Obvious terseness: omit the count and let the body end the document. That makes
 * a trailing stray line a perfectly valid extra record, and a reader that
 * cannot tell "the model added a row" from "the model added a line of prose"
 * will take the first reading. Two bytes of header are cheaper than that
 * ambiguity, so the count stays in both formats and the strictness in
 * ./table.ts is shared rather than duplicated.
 */

export const TRON_MAGIC = 't1';

export const TRON_ROW_INDENT = '';

export const TRON_FRAMING: TableFraming = Object.freeze({
  magic: TRON_MAGIC,
  indent: TRON_ROW_INDENT,
  requiresIndent: false,
  label: 'tron',
});

export function serializeTron(value: unknown, options?: TableOptions): string {
  assertJsonValue(value, 'the tool result');
  return serializeTable(value, TRON_FRAMING, options);
}

export function parseTron(text: string): readonly JsonObject[] {
  return parseTable(text, TRON_FRAMING);
}
