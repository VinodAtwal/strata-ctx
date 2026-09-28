import { ToonError, toonError } from './errors.js';
import type { JsonObject, JsonValue } from './json-value.js';
import { MAX_JSON_DEPTH, isJsonArray } from './json-value.js';

/**
 * The one grammar both TOON and TRON are written in.
 *
 * H-1 and H-2 differ only in *framing* -- a magic token, an indent, whether a
 * name is carried. The parts that can lose data (field names, cell literals,
 * nested JSON) are identical, so they live here once. Duplicating a strict
 * parser is how two readers end up disagreeing about the same bytes, and a
 * disagreement in a parser is a silent data-loss bug with a 50% chance of being
 * hit per request.
 *
 * ## The rule this file exists to enforce
 *
 * Every construct has exactly one spelling and no reader is allowed to guess.
 * A value that has two plausible readings -- a string that could be a number, a
 * cell with nothing in it, a nested object with a repeated key -- is *written*
 * in the unambiguous spelling and *rejected* if it arrives in the other one. A
 * lenient reader is not a helpful reader here: it returns less data than it was
 * given, with no error, and the caller has no way to know.
 */

/* -------------------------------------------------------------------------- */
/* names                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Control characters and the three structural characters, plus whitespace at
 * the edges. Deliberately a short list: a field name is written into a
 * comma-separated header and taken back verbatim, so `,` and the braces must be
 * absent and nothing may be invisible. Spaces *inside* a name, quotes, colons
 * and non-ASCII are all legal and round-trip exactly -- a header is not a quoted
 * string, and forbidding half the Unicode range to save a rule would reject
 * ordinary tool output for no gain.
 */
// eslint-disable-next-line no-control-regex -- matching control chars is the point
const UNWRITABLE_NAME = /[,{}\u0000-\u001f\u007f]|\s$|^\s/;

export const isValidFieldName = (name: string): boolean =>
  name.length > 0 && !UNWRITABLE_NAME.test(name);

export const assertFieldName = (name: string): void => {
  if (name.length === 0) {
    throw toonError('empty_field_name', 'a record has an empty key');
  }
  if (!isValidFieldName(name)) {
    throw toonError('unsupported_key', `the field "${name}" cannot be written in a table header`);
  }
};

/**
 * The table name sits between the magic and the row count, so it may not contain
 * whitespace or any of the framing characters. Same class of rule as
 * `isValidFieldName` with a tighter character set, kept separate because the
 * diagnostic is a *caller* problem: the caller can pick a different name,
 * whereas a field name arrives inside the payload and cannot be renamed.
 */
// eslint-disable-next-line no-control-regex -- matching control chars is the point
const UNWRITABLE_TABLE_NAME = /[\s,{}[\]\u0000-\u001f\u007f]/;

export const isValidTableName = (name: string): boolean =>
  name.length > 0 && !UNWRITABLE_TABLE_NAME.test(name);

export const assertTableName = (name: string): void => {
  if (!isValidTableName(name)) {
    throw toonError('unsupported_key', `the table name "${name}" cannot be written in a header`);
  }
};

/* -------------------------------------------------------------------------- */
/* cells                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Characters that force a string to be quoted.
 *
 * `,` ends a cell. Whitespace of any kind is quoted because a space at a cell
 * edge is invisible to a reader. The structural characters and the backslash
 * are quoted because a *model* reading a table cannot distinguish an unquoted
 * `{` from the start of a nested object, and a *machine* reading one will not
 * care -- but the two are not the same reader, and only one of them has a
 * specification to lose data against.
 */
// The characters that force a string to be quoted in TOON/TRON:
// whitespace, comma, braces, brackets, quote, backslash.
// Explicit character enumeration to avoid regex character-class escaping confusion.
const MUST_QUOTE = /[ \t\n\r\f\v,{}[\]"\\]/;

const isParseableJson = (s: string): boolean => {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};

/**
 * Does this string need quotes to survive a round trip?
 *
 * The `isParseableJson` clause is the load-bearing one and is deliberately a
 * *superset* of the scalars this package emits. `"1"`, `"null"`, `"true"`,
 * `"[]"`, `"-0"` and `"1e999"` all parse as JSON, so a reader meeting them bare
 * would hand back a number, a null, a boolean or a parse failure instead of the
 * string it was given. Quoting the whole class costs a couple of tokens per
 * affected cell and removes an entire family of silent type corruption.
 */
export const needsQuoting = (s: string): boolean =>
  s.length === 0 || MUST_QUOTE.test(s) || isParseableJson(s);

const ESCAPES: Readonly<Record<number, string>> = Object.freeze({
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0c: '\\f',
  0x0d: '\\r',
  0x22: '\\"',
  0x5c: '\\\\',
});

const UNESCAPES: Readonly<Record<string, string>> = Object.freeze({
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  '"': '"',
  '\\': '\\',
  '/': '/',
});

const HEX4 = /^[0-9a-fA-F]{4}$/;

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

const hexEscape = (code: number): string => `\\u${code.toString(16).padStart(4, '0')}`;

function encodeQuoted(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    const escape = ESCAPES[code];
    if (escape !== undefined) {
      out += escape;
      continue;
    }
    // A lone surrogate has no UTF-8 encoding, so any copy that passes through
    // bytes destroys it. Escaping both halves of a *valid* pair would double the
    // cost of every emoji in a tool result, so only the unpaired ones are
    // escaped -- which is exactly the condition that makes the round trip exact.
    if (isHighSurrogate(code) && !(i + 1 < s.length && isLowSurrogate(s.charCodeAt(i + 1)))) {
      out += hexEscape(code);
      continue;
    }
    if (isLowSurrogate(code) && !(i > 0 && isHighSurrogate(s.charCodeAt(i - 1)))) {
      out += hexEscape(code);
      continue;
    }
    out += s.charAt(i);
  }
  return `${out}"`;
}

/**
 * Read a quoted string starting at `start`, which must be the opening quote.
 *
 * One scanner serves cells and nested JSON, so the two cannot come to accept
 * different spellings of the same escape. Unknown escapes are refused: a lenient
 * reader that passes `\q` through as `q`, drops the backslash, or guesses the
 * author meant `\"` turns a corrupted document into a plausible one, and the
 * corruption then survives every later stage.
 */
export function readQuotedString(
  text: string,
  start: number,
  base: number,
): { readonly value: string; readonly end: number } {
  let out = '';
  let i = start + 1;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === '"') return { value: out, end: i + 1 };
    if (ch === '\\') {
      const next = text.charAt(i + 1);
      if (next === '') {
        throw toonError('unterminated_string', 'the cell ends inside an escape', base + i);
      }
      const simple = UNESCAPES[next];
      if (simple !== undefined) {
        out += simple;
        i += 2;
        continue;
      }
      if (next === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (!HEX4.test(hex)) {
          throw toonError('malformed_cell', `\\u needs four hex digits, got "${hex}"`, base + i);
        }
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      }
      throw toonError('malformed_cell', `unknown escape \\${next}`, base + i);
    }
    if (ch === '\n' || ch === '\r') {
      throw toonError('malformed_cell', 'a raw line break inside a quoted cell', base + i);
    }
    out += ch;
    i += 1;
  }
  throw toonError('unterminated_string', 'no closing quote', base + start);
}

const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/**
 * One cell, written.
 *
 * Scalars are bare when the grammar is unambiguous and quoted when it is not;
 * composite values are JSON, because the tabular win comes from factoring the
 * *columns* out. A second bespoke grammar for recursion would save few tokens on
 * the rare cell that holds an object while adding a second parser to keep strict
 * forever. `JSON.stringify` is exact over the JSON domain, and every caller runs
 * `jsonDefect` first, so the value is known to be representable.
 */
export function encodeCell(value: JsonValue): string {
  if (typeof value === 'string') return needsQuoting(value) ? encodeQuoted(value) : value;
  return JSON.stringify(value);
}

/* -------------------------------------------------------------------------- */
/* strict JSON, for composite cells                                            */
/* -------------------------------------------------------------------------- */

interface Cursor {
  readonly value: JsonValue;
  readonly end: number;
}

/**
 * Space and tab only. A composite cell lives inside one line, so a line break
 * inside one is not whitespace to be skipped -- it is a document that does not
 * match the grammar, and skipping it would let a row boundary pass for a value
 * boundary.
 */
const isJsonSpace = (ch: string): boolean => ch === ' ' || ch === '\t';

const skipSpace = (text: string, pos: number): number => {
  let i = pos;
  while (i < text.length && isJsonSpace(text.charAt(i))) i += 1;
  return i;
};

function readJsonValue(text: string, pos: number, base: number, depth: number): Cursor {
  if (depth > MAX_JSON_DEPTH) {
    throw toonError('too_deep', `a composite cell nests deeper than ${MAX_JSON_DEPTH}`, base + pos);
  }
  const ch = text.charAt(pos);
  if (ch === '{') return readJsonObject(text, pos, base, depth + 1);
  if (ch === '[') return readJsonArray(text, pos, base, depth + 1);
  if (ch === '"') return readQuotedString(text, pos, base);
  return readJsonScalar(text, pos, base);
}

function readJsonObject(text: string, pos: number, base: number, depth: number): Cursor {
  let i = skipSpace(text, pos + 1);
  const out: Record<string, JsonValue> = {};
  if (text.charAt(i) === '}') return { value: out, end: i + 1 };

  for (;;) {
    if (text.charAt(i) !== '"') {
      throw toonError('malformed_cell', 'an object key must be a quoted string', base + i);
    }
    const key = readQuotedString(text, i, base);
    // The one defect `JSON.parse` cannot see and silently swallows. Two
    // occurrences of a key in one literal is a document that means two different
    // things depending on the reader, and the default reader keeps the last one.
    if (Object.hasOwn(out, key.value)) {
      throw toonError(
        'malformed_cell',
        `the key "${key.value}" appears twice in one object`,
        base + i,
      );
    }
    i = skipSpace(text, key.end);
    if (text.charAt(i) !== ':') {
      throw toonError('malformed_cell', 'expected ":" after an object key', base + i);
    }
    i = skipSpace(text, i + 1);
    const value = readJsonValue(text, i, base, depth);
    out[key.value] = value.value;
    i = skipSpace(text, value.end);

    const next = text.charAt(i);
    if (next === ',') {
      i = skipSpace(text, i + 1);
      continue;
    }
    if (next === '}') return { value: out, end: i + 1 };
    throw toonError('malformed_cell', 'expected "," or "}" in an object', base + i);
  }
}

function readJsonArray(text: string, pos: number, base: number, depth: number): Cursor {
  let i = skipSpace(text, pos + 1);
  const out: JsonValue[] = [];
  if (text.charAt(i) === ']') return { value: out, end: i + 1 };

  for (;;) {
    const value = readJsonValue(text, i, base, depth);
    out.push(value.value);
    i = skipSpace(text, value.end);

    const next = text.charAt(i);
    if (next === ',') {
      i = skipSpace(text, i + 1);
      continue;
    }
    if (next === ']') return { value: out, end: i + 1 };
    throw toonError('malformed_cell', 'expected "," or "]" in an array', base + i);
  }
}

function readJsonScalar(text: string, pos: number, base: number): Cursor {
  // `truex` must not read as `true` followed by a bare `x`. The value ends where
  // the literal ends and the caller's delimiter check decides whether what
  // follows is a separator or corruption, so no lookahead is needed here.
  const ch = text.charAt(pos);
  if (ch === 't' && text.startsWith('true', pos)) return { value: true, end: pos + 4 };
  if (ch === 'f' && text.startsWith('false', pos)) return { value: false, end: pos + 5 };
  if (ch === 'n' && text.startsWith('null', pos)) return { value: null, end: pos + 4 };

  JSON_NUMBER.lastIndex = pos;
  const matched = JSON_NUMBER.exec(text)?.[0];
  if (matched === undefined) {
    throw toonError('malformed_cell', `expected a value, got "${text.charAt(pos)}"`, base + pos);
  }
  const n = Number(matched);
  // `1e999` is syntactically a JSON number and evaluates to Infinity, which JSON
  // cannot represent; `-0` is representable as a JS number and absent from JSON.
  // `jsonDefect` rejects both on the way out, so both must be rejected on the way
  // in or a document could claim a value the domain does not have.
  if (!Number.isFinite(n)) {
    throw toonError('unsupported_value', `${matched} is not a finite number`, base + pos);
  }
  if (Object.is(n, -0)) {
    throw toonError('unsupported_value', '-0 is not a JSON number', base + pos);
  }
  return { value: n, end: pos + matched.length };
}

/**
 * Read a composite cell: `{...}` or `[...]` holding a JSON literal.
 *
 * Hand-rolled rather than `JSON.parse` for one reason. `JSON.parse` accepts a
 * repeated key and keeps the last value, so a tool result of
 * `[{"status":"ok","status":"failed"}]` would come back as `[{"status":"failed"}]`
 * -- a field the agent was told twice, resolved without anyone being asked. That
 * is the exact failure this stream exists to prevent, and it is invisible at the
 * call site, so the reader that can see it has to be the strict one.
 */
export function readComposite(text: string, pos: number, base: number): Cursor {
  const value = readJsonValue(text, pos, base, 0);
  const after = skipSpace(text, value.end);
  const next = text.charAt(after);
  if (next !== '' && next !== ',' && next !== '}' && next !== ']') {
    throw toonError('malformed_cell', 'trailing text inside a composite cell', base + after);
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* rows                                                                        */
/* -------------------------------------------------------------------------- */

const isBareChar = (ch: string): boolean => ch !== ',' && ch !== '"' && ch !== '{' && ch !== '[';

function readBareCell(line: string, pos: number, base: number): Cursor {
  let end = pos;
  while (end < line.length && isBareChar(line.charAt(end))) end += 1;
  const text = line.slice(pos, end);
  if (text.length === 0) {
    // `a,,b` and a cell that opens with a structural character collapse here,
    // and both are unrepresentable. A lenient reader would guess null or "";
    // the guess is the bug, so the document is refused instead.
    throw toonError('empty_cell', 'a cell has no content', base + pos);
  }
  if (/[}\]\\]/.test(text)) {
    throw toonError('malformed_cell', 'an unquoted cell carries a structural character', base + pos);
  }
  // The inverse of `needsQuoting`, and the whole contract in one line: a cell
  // that parses as JSON is read as that value, and a cell that does not is read
  // as the string it visibly is.
  //
  // The consequence, stated because it looks like a bug and is not: a bare cell
  // is never *invalid*, so prose run onto the end of a row is read as a string
  // rather than refused. (`4and here is a summary` is a legal string, and
  // `1st-place.txt` is a legal string, so a rule that refused digit-leading bare
  // cells would refuse real data.) What catches contamination is the row count:
  // a following paragraph arrives as its own line, and the header's count is
  // checked against the body. The guarantee is that the *writer* never produces
  // the ambiguous form -- it quotes anything that could be misread -- not that
  // the reader can detect every hand-edited document.
  if (!isParseableJson(text)) return { value: text, end };
  return { value: readJsonScalar(text, 0, base + pos).value, end };
}

/** Decode the cell that begins at `pos`, and report where it ended. */
export function readCellAt(
  line: string,
  pos: number,
  base: number,
): { readonly value: JsonValue; readonly end: number } {
  const ch = line.charAt(pos);
  if (ch === '"') return readQuotedString(line, pos, base);
  if (ch === '{' || ch === '[') return readComposite(line, pos, base);
  return readBareCell(line, pos, base);
}

/**
 * Decode a whole cell, for callers holding exactly one.
 *
 * Exported because it is the unit the fidelity property is actually about: a
 * round trip of a *value* through a cell, independent of whether the value ever
 * sits inside a table.
 */
export function decodeCell(text: string): JsonValue {
  const { value, end } = readCellAt(text, 0, 0);
  if (end !== text.length) {
    throw toonError('malformed_cell', `unexpected "${text.charAt(end)}" after the cell`, end);
  }
  return value;
}

/**
 * Decode one row against the header's field list.
 *
 * The row's keys are inserted in header order, so every restored record has the
 * header's key *sequence*. That is what makes the round trip exact under
 * `jsonEqual`, which compares sequences rather than sets.
 */
export function decodeRow(line: string, fields: readonly string[], base: number): JsonObject {
  const row: Record<string, JsonValue> = {};
  let pos = 0;
  let seen = 0;
  for (const field of fields) {
    seen += 1;
    if (pos >= line.length) {
      throw toonError(
        'row_width_mismatch',
        `expected ${fields.length} cells, found ${seen - 1}`,
        base + line.length,
      );
    }
    const cell = readCellAt(line, pos, base);
    row[field] = cell.value;
    pos = cell.end;
    if (pos < line.length) {
      if (line.charAt(pos) !== ',') {
        throw toonError(
          'malformed_cell',
          `expected "," after a cell, got "${line.charAt(pos)}"`,
          base + pos,
        );
      }
      pos += 1;
      if (pos === line.length) {
        throw toonError('empty_cell', 'the row ends with a comma', base + pos);
      }
    } else if (seen !== fields.length) {
      throw toonError('row_width_mismatch', `expected ${fields.length} cells`, base + line.length);
    }
  }
  if (pos !== line.length) {
    throw toonError('row_width_mismatch', `expected ${fields.length} cells, found more`, base + pos);
  }
  return row;
}

/* -------------------------------------------------------------------------- */
/* tables                                                                      */
/* -------------------------------------------------------------------------- */

const isPlainRecord = (v: JsonValue): v is JsonObject =>
  typeof v === 'object' && v !== null && !isJsonArray(v);

/**
 * The columns of a value, or the reason it is not a table.
 *
 * Uniformity is demanded *including key order*, and that is stricter than JSON
 * semantics on purpose. Rows that disagree about which fields they have could be
 * encoded by unioning the keys and filling the gaps with null -- and those nulls
 * are inventions the agent would then read as data. Two rows holding the same
 * fields in a different order is the same argument one step smaller. Both fall
 * back to JSON, which costs tokens and is always correct.
 */
export function tableFields(value: JsonValue): readonly string[] {
  if (!isJsonArray(value)) {
    throw toonError('not_a_table', 'the value is not an array');
  }
  if (value.length === 0) {
    throw toonError('not_a_table', 'an empty array declares no columns');
  }
  const first = value[0];
  if (first === undefined || !isPlainRecord(first)) {
    throw toonError('not_a_table', 'row 0 is not a plain object');
  }
  const fields = Object.freeze(Object.keys(first));
  for (const field of fields) assertFieldName(field);

  for (let i = 1; i < value.length; i += 1) {
    const row = value[i];
    if (row === undefined || !isPlainRecord(row)) {
      throw toonError('not_a_table', `row ${i} is not a plain object`);
    }
    const keys = Object.keys(row);
    if (keys.length !== fields.length) {
      throw toonError(
        'not_a_table',
        `row ${i} has ${keys.length} fields, row 0 has ${fields.length}`,
      );
    }
    for (let j = 0; j < keys.length; j += 1) {
      if (keys[j] !== fields[j]) {
        throw toonError('not_a_table', `row ${i} disagrees about the columns or their order`);
      }
    }
  }
  return fields;
}

export function tryTableFields(
  value: JsonValue,
):
  | { readonly ok: true; readonly fields: readonly string[] }
  | { readonly ok: false; readonly error: ToonError } {
  try {
    return { ok: true, fields: tableFields(value) };
  } catch (error) {
    // Only a ToonError is a *verdict* about the value. Anything else is a bug in
    // this package and must not be reported to a caller as "not a table", or a
    // real defect would be silently answered with plain JSON forever.
    if (error instanceof ToonError) return { ok: false, error };
    throw error;
  }
}
