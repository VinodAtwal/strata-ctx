import { toonError } from './errors.js';
import type { JsonObject, JsonValue } from './json-value.js';
import { isJsonArray } from './json-value.js';
import {
  assertFieldName,
  assertTableName,
  decodeRow,
  encodeCell,
  isValidFieldName,
  isValidTableName,
  tableFields,
} from './grammar.js';

/**
 * Framing: the part of the format that differs between TOON and TRON.
 *
 * Both formats are `<magic>[ <name>][<rowCount>]{<columns>}:` followed by one
 * line per record. Everything a reader could lose data on -- field names, cell
 * literals, nested JSON -- is in ./grammar.ts and is shared, so H-2's second
 * format cannot drift from H-1's first. A descriptor is the whole of the
 * difference, which is also the honest description of the difference.
 */

export interface TableFraming {
  readonly magic: string;
  /** Prepended to every data line. Empty for TRON. */
  readonly indent: string;
  /**
   * Whether a data line *must* carry the indent. Only TOON has this rule, and
   * it is what lets TRON omit the indent: the indent is the one byte that marks
   * a line as data, so a reader that accepted unindented lines could not tell a
   * row from a note someone left in the text.
   */
  readonly requiresIndent: boolean;
  readonly label: string;
}

export interface TableOptions {
  /**
   * Omitted entirely when undefined. A table name is worth its bytes -- it is
   * what tells a model what the columns are *of* -- but it must be paid for by
   * the caller who knows it, not invented here.
   */
  readonly name?: string;
}

interface ParsedHeader {
  readonly name: string | undefined;
  readonly rowCount: number;
  readonly fields: readonly string[];
}

const DIGITS = /^[0-9]+$/;

function parseFieldList(inner: string, base: number): readonly string[] {
  if (inner.length === 0) {
    throw toonError('malformed_header', 'the header declares no columns', base);
  }
  const parts = inner.split(',');
  const seen = new Set<string>();
  const fields: string[] = [];
  for (const part of parts) {
    if (part.length === 0) {
      throw toonError('empty_field_name', 'a column name is empty', base);
    }
    if (!isValidFieldName(part)) {
      throw toonError('unsupported_key', `"${part}" cannot be a column name`, base);
    }
    if (seen.has(part)) {
      throw toonError('duplicate_field', `the column "${part}" is declared twice`, base);
    }
    seen.add(part);
    fields.push(part);
  }
  return Object.freeze(fields);
}

function parseHeader(line: string, magic: string, base: number): ParsedHeader {
  if (!line.startsWith(magic)) {
    throw toonError('malformed_header', `expected a header beginning "${magic}"`, base);
  }
  let i = magic.length;
  let name: string | undefined;

  if (line.charAt(i) === ' ') {
    // The name runs to the first `[`. `isValidTableName` forbids `[` in a name,
    // so this cannot run past a name that is itself well formed, and a hostile
    // header with a `[` in the name fails the name check rather than the scan.
    const open = line.indexOf('[', i + 1);
    if (open === -1) {
      throw toonError('malformed_header', 'the table name is not terminated by "["', base + i);
    }
    const candidate = line.slice(i + 1, open);
    if (!isValidTableName(candidate)) {
      throw toonError('malformed_header', `"${candidate}" is not a usable table name`, base + i);
    }
    name = candidate;
    i = open;
  }

  if (line.charAt(i) !== '[') {
    throw toonError('malformed_header', 'expected "[" before the row count', base + i);
  }
  const countEnd = line.indexOf(']', i + 1);
  if (countEnd === -1) {
    throw toonError('malformed_header', 'the row count has no "]"', base + i);
  }
  const digits = line.slice(i + 1, countEnd);
  if (!DIGITS.test(digits)) {
    throw toonError('malformed_header', `"${digits}" is not a row count`, base + i);
  }
  const rowCount = Number.parseInt(digits, 10);
  i = countEnd + 1;

  if (line.charAt(i) !== '{') {
    throw toonError('malformed_header', 'expected "{" before the columns', base + i);
  }
  const columnsEnd = line.indexOf('}', i + 1);
  if (columnsEnd === -1) {
    throw toonError('malformed_header', 'the column list has no "}"', base + i);
  }
  if (line.charAt(columnsEnd + 1) !== ':') {
    throw toonError('malformed_header', 'the header must end with ":"', base + columnsEnd);
  }
  if (line.length !== columnsEnd + 2) {
    throw toonError('malformed_header', 'trailing text after the header', base + columnsEnd + 2);
  }

  return { name, rowCount, fields: parseFieldList(line.slice(i + 1, columnsEnd), base + i + 1) };
}

interface SourceLine {
  readonly text: string;
  /** Character offset of the line in the document, for error positions. */
  readonly start: number;
}

/**
 * Split on newlines, dropping one trailing CR per line.
 *
 * The CR is a line-ending convention, not data: no cell can contain a raw CR
 * (a carriage return inside a string is escaped as `\r` by the writer), so a
 * bare CR at the end of a line carries no information and refusing it would only
 * make CRLF tools fail for no gain. Interior blank lines are kept, because a
 * blank line in the middle of a body is a row with no cells and must be refused.
 */
function splitLines(text: string): readonly SourceLine[] {
  const out: SourceLine[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) {
      if (start < text.length) {
        out.push({ text: stripCr(text.slice(start)), start });
      }
      return out;
    }
    out.push({ text: stripCr(text.slice(start, nl)), start });
    start = nl + 1;
  }
}

const stripCr = (s: string): string =>
  s.length > 0 && s.charAt(s.length - 1) === '\r' ? s.slice(0, -1) : s;

export function headerLine(
  magic: string,
  name: string | undefined,
  rowCount: number,
  fields: readonly string[],
): string {
  return `${magic}${name === undefined ? '' : ` ${name}`}[${rowCount}]{${fields.join(',')}}:`;
}

export function serializeTable(
  value: JsonValue,
  framing: TableFraming,
  options: TableOptions = {},
): string {
  if (!isJsonArray(value)) {
    throw toonError('not_a_table', 'the value is not an array');
  }
  const fields = tableFields(value);
  if (options.name !== undefined) assertTableName(options.name);

  const lines: string[] = [headerLine(framing.magic, options.name, value.length, fields)];
  for (let i = 0; i < value.length; i += 1) {
    const row = value[i];
    if (row === undefined || typeof row !== 'object' || row === null || isJsonArray(row)) {
      throw toonError('not_a_table', `row ${i} is not a plain object`);
    }
    const cells: string[] = [];
    for (const field of fields) {
      const cell = row[field];
      // Unreachable while `tableFields` holds, and load-bearing twice over: it
      // is the narrowing that lets `encodeCell` take a `JsonValue` rather than a
      // `JsonValue | undefined`, and it is the check that stops a future edit to
      // the uniformity rule from writing `undefined` into a cell.
      if (cell === undefined) {
        throw toonError('not_a_table', `row ${i} has no field "${field}"`);
      }
      cells.push(encodeCell(cell));
    }
    lines.push(`${framing.indent}${cells.join(',')}`);
  }
  // A trailing newline, so the document is a text file by every convention that
  // matters for the things this stage produces: the artifact store holds it, a
  // diff of it is reviewed, and `wc -l` counts it. The reader tolerates its
  // absence, since `splitLines` only drops what a newline terminates.
  return `${lines.join('\n')}\n`;
}

export function parseTable(
  text: string,
  framing: TableFraming,
): readonly JsonObject[] {
  const lines = splitLines(text);
  const first = lines[0];
  if (first === undefined) {
    throw toonError('malformed_header', 'the document is empty', 0);
  }
  const header = parseHeader(first.text, framing.magic, first.start);
  // A zero-row table is refused, though it is well formed, and the reason is
  // symmetry rather than taste: the writer cannot produce one (`tableFields`
  // rejects an empty array), so accepting it here would mean parse and serialize
  // disagree about which values exist -- and the disagreement would show up as a
  // document that survives being read once and then cannot be re-emitted.
  if (header.rowCount === 0) {
    throw toonError('not_a_table', 'the header declares no rows', first.start);
  }
  const body = lines.slice(1);
  if (body.length !== header.rowCount) {
    throw toonError(
      'row_count_mismatch',
      `the header declares ${header.rowCount} rows and the body has ${body.length}`,
      first.start,
    );
  }

  const rows: JsonObject[] = [];
  for (const line of body) {
    if (framing.requiresIndent && !line.text.startsWith(framing.indent)) {
      throw toonError(
        'unexpected_line',
        `a data line does not start with "${framing.indent}"`,
        line.start,
      );
    }
    rows.push(decodeRow(line.text.slice(framing.indent.length), header.fields, line.start + framing.indent.length));
  }
  return Object.freeze(rows);
}

/** Re-exported so a framing's writer and reader validate names identically. */
export { assertFieldName };
