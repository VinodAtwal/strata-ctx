/**
 * E3: output format — fidelity, extraction accuracy, answer diversity, H-3.
 *
 * ## What this file is, and what it is not
 *
 * The suite under test is `../src/suites/e3-output-format.ts`. The **codec and
 * the subject are injected**, and this file supplies both, because
 * `packages/eval` has no dependency on `@strata-ctx/output-compress` and no
 * project reference to it (AGENTS.md §12.1) and cannot call a model. So:
 *
 * - `referenceCodec` below is a **small strict TOON/TRON implementation written
 *   for these tests**, following the real framing (`packages/output-compress/src/table.ts`):
 *   a magic, `[N]{cols}:`, and rows of comma-separated cells with a TOON row
 *   indent that TRON does not need. It is a *reference*, not the product. Its job
 *   is to be a second opinion the suite can be measured against, and a test that
 *   imported the real serializer would be testing the serializer twice.
 * - `readerResponder` is a **subject that actually reads the bytes it is handed**:
 *   it parses the payload in the arm's format and pulls out the requested fields.
 *   It is not a stub that echoes the oracle, because a responder that reads
 *   nothing correctly cannot demonstrate that the harness detects a format that
 *   destroys the payload.
 *
 * ## The negative control is the load-bearing test here
 *
 * `control+` is a truncated payload. If a responder that genuinely reads bytes
 * still scored 100% in that arm, then every accuracy number in the report would
 * be uninterpretable — the harness could not tell a format change from a model
 * change. So there is a test that runs the suite with a *perfect* subject and
 * asserts the degraded arm still scores below 100%.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Arm, EvalFixture } from '../src/types.js';
import {
  E3_ARMS,
  E3_BOUNDARY_BLOCKS,
  E3_BOUNDARY_FALSE_POSITIVE_CEILING,
  E3_CALIBRATION_MIN_DROP_BITS,
  E3_CORPUS,
  E3_DEGRADED_NOTE,
  E3_DEGRADED_PAYLOAD_LINES,
  E3_DIALECTS,
  E3_DIVERSITY_BASELINE,
  E3_DIVERSITY_FORMATS,
  E3_DIVERSITY_SEEDS,
  E3_DIVERSITY_TASKS,
  E3_EMBEDDING_COSINE_THRESHOLD,
  E3_EXTRACTION_TASKS,
  E3_JSON_DIVERSITY_DEFICIT_BITS,
  E3_JSON_LIKE_TOLERANCE_BITS,
  E3_LOSSY_MARKER,
  E3_NULL_EFFECT_BITS,
  E3_REFUSAL_CORPUS,
  E3_WRONG_MARKER,
  E3FixtureError,
  attributeE3Diversity,
  buildE3Document,
  buildE3Fixture,
  calibrateE3Diversity,
  createE3ArmRunner,
  checkE3Rules,
  degradeE3Payload,
  e3AnswerEntropyBits,
  e3EmbeddingEntropyBits,
  e3ExtractionOracle,
  e3NgramEntropyBits,
  evaluateE3Boundary,
  evaluateE3Diversity,
  evaluateE3Fidelity,
  extractE3Answers,
  measureE3Diversity,
  renderE3Csv,
  renderE3FormatDirective,
  renderE3Json,
  renderE3Payload,
  renderE3Yaml,
  runE3CorpusRoundTrip,
  runE3RefusalRoundTrip,
  runE3RoundTrip,
  runE3Suite,
} from '../src/suites/e3-output-format.js';
import { runSuite } from '../src/runner.js';
import type {
  E3BoundaryBlock,
  E3CorpusEntry,
  E3Dialect,
  E3DiversityTask,
  E3OutputFormat,
  E3Request,
  E3Responder,
  E3RoundTripCase,
  ToonCodec,
} from '../src/suites/e3-output-format.js';

// ---------------------------------------------------------------- the codec

class RefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefToonError';
  }
}

const REF_MAGIC: Readonly<Record<E3Dialect, string>> = { toon: 'toon1', tron: 'tron1' };
const REF_INDENT: Readonly<Record<E3Dialect, string>> = { toon: '  ', tron: '' };
const REF_MAX_DEPTH = 8;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const REF_KEY = /[,{}\u0000-\u001f\u007f]|\s$|^\s/u;
const REF_MUST_QUOTE = /[ \t\n\r\f\v,{}[\]"\\]/u;

const refIsPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

const refAssertKey = (key: string, where: string): void => {
  if (key.length === 0) throw new RefError(`${where}: a record has an empty key`);
  if (REF_KEY.test(key)) throw new RefError(`${where}: the field "${key}" cannot be written in a header`);
};

const refIsParseableJson = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/** Quote anything a bare reader could mistake for another type. Mirrors
 *  `needsQuoting` in the real grammar, including the whole-parseable-JSON rule:
 *  `"1"`, `"null"` and `"[]"` are the cases that silently change type. */
const refNeedsQuoting = (text: string): boolean =>
  text.length === 0 || REF_MUST_QUOTE.test(text) || refIsParseableJson(text);

/**
 * The JSON domain, enforced before anything is written.
 *
 * `Date`, `NaN`, the infinities, `-0`, `undefined` and cycles are all refused
 * here rather than coerced, because the whole of `E3_REFUSAL_CORPUS` is values
 * that a lenient writer turns into a *different* value.
 */
const refAssertDomain = (value: unknown, path: string, depth: number): void => {
  if (depth > REF_MAX_DEPTH) throw new RefError(`${path}: nested deeper than ${REF_MAX_DEPTH}`);
  if (value === null) return;
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return;
  if (kind === 'number') {
    const asNumber = value as number;
    if (!Number.isFinite(asNumber)) throw new RefError(`${path}: ${String(asNumber)} is not a JSON number`);
    if (Object.is(asNumber, -0)) throw new RefError(`${path}: -0 has no JSON spelling that reads back as -0`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((inner, index) => refAssertDomain(inner, `${path}[${String(index)}]`, depth + 1));
    return;
  }
  if (refIsPlainObject(value)) {
    for (const [key, inner] of Object.entries(value)) {
      refAssertKey(key, path);
      refAssertDomain(inner, `${path}.${key}`, depth + 1);
    }
    return;
  }
  throw new RefError(`${path}: ${kind} is outside the JSON domain`);
};

const refWriteCell = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return refNeedsQuoting(value) ? JSON.stringify(value) : value;
  return JSON.stringify(value);
};

const refEncode = (value: unknown, dialect: E3Dialect): string => {
  if (!Array.isArray(value)) throw new RefError('not_a_table: only an array of uniform records is a table');
  if (value.length === 0) throw new RefError('not_a_table: an empty array declares no columns');
  value.forEach((record, index) => {
    refAssertDomain(record, `row ${String(index)}`, 0);
    if (!refIsPlainObject(record)) throw new RefError(`row ${String(index)} is not a plain object`);
  });
  const first = value[0] as Record<string, unknown>;
  const fields = Object.keys(first);
  fields.forEach((field) => refAssertKey(field, 'header'));
  for (const record of value) {
    const keys = Object.keys(record);
    if (keys.length !== fields.length || keys.some((key, index) => key !== fields[index])) {
      throw new RefError('not_a_table: rows disagree about their fields or their order');
    }
  }
  const lines = [`${REF_MAGIC[dialect]}[${String(value.length)}]{${fields.join(',')}}:`];
  for (const record of value) {
    lines.push(`${REF_INDENT[dialect]}${fields.map((field) => refWriteCell(record[field])).join(',')}`);
  }
  return `${lines.join('\n')}\n`;
};

const refIsPlainKey = (field: string): boolean => field.length > 0 && !REF_KEY.test(field);

const refParseHeader = (
  line: string,
  magic: string,
): { readonly rowCount: number; readonly fields: string[] } => {
  if (!line.startsWith(magic)) throw new RefError(`malformed_header: expected a header beginning "${magic}"`);
  let index = magic.length;
  if (line[index] === ' ') {
    const open = line.indexOf('[', index);
    if (open === -1) throw new RefError('malformed_header: the table name is not terminated by "["');
    index = open;
  }
  if (line[index] !== '[') throw new RefError('malformed_header: expected "[" before the row count');
  const closeCount = line.indexOf(']', index);
  if (closeCount === -1) throw new RefError('malformed_header: the row count has no "]"');
  const digits = line.slice(index + 1, closeCount);
  if (!/^\d+$/u.test(digits)) throw new RefError(`malformed_header: "${digits}" is not a row count`);
  if (line[closeCount + 1] !== '{') throw new RefError('malformed_header: expected "{" before the columns');
  const closeColumns = line.indexOf('}', closeCount + 1);
  if (closeColumns === -1) throw new RefError('malformed_header: the column list has no "}"');
  const fields = line
    .slice(closeCount + 2, closeColumns)
    .split(',')
    .map((field) => field.trim());
  if (fields.length === 0 || fields.some((field) => !refIsPlainKey(field))) {
    throw new RefError('malformed_header: a column name is empty or unusable');
  }
  if (line[closeColumns + 1] !== ':') throw new RefError('malformed_header: the header must end with ":"');
  if (line[closeColumns + 2] !== undefined) throw new RefError('malformed_header: trailing text after the header');
  return { rowCount: Number(digits), fields };
};

/** Split a row on unquoted commas, tracking string and composite nesting. */
const refSplitCells = (line: string): string[] => {
  const cells: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of line) {
    if (inString) {
      current += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    if (ch === '}' || ch === ']') depth -= 1;
    if (depth < 0) throw new RefError('malformed_cell: unbalanced composite');
    if (ch === ',' && depth === 0) {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (inString) throw new RefError('unterminated_string: the row ends inside a string');
  if (depth !== 0) throw new RefError('malformed_cell: unbalanced composite');
  cells.push(current);
  return cells;
};

/**
 * Read one cell, the exact inverse of `refWriteCell`.
 *
 * The interesting case is a bare cell: it is a number, a boolean, `null` or a
 * string, and the writer has already made that unambiguous by quoting every
 * string that *would* parse as JSON. So a bare cell that does not parse is a
 * string, and a bare cell that does parse is the value — there is no third
 * reading, which is what makes the format lossless rather than merely
 * convenient.
 */
const refParseCell = (text: string): unknown => {
  if (text.length === 0) throw new RefError('malformed_cell: an empty cell has no value');
  if (text.startsWith('"')) {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'string') throw new RefError('malformed_cell: a quoted cell must hold a string');
    return parsed;
  }
  if (text.startsWith('{') || text.startsWith('[')) return JSON.parse(text) as unknown;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const refDecode = (text: string, dialect: E3Dialect): readonly Record<string, unknown>[] => {
  if (text.length === 0) throw new RefError('malformed_header: the document is empty');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const header = refParseHeader(lines[0] ?? '', REF_MAGIC[dialect]);
  if (header.rowCount === 0) throw new RefError('not_a_table: the header declares no rows');
  const body = lines.slice(1);
  if (body.length !== header.rowCount) {
    throw new RefError(
      `malformed_header: the header declares ${String(header.rowCount)} rows and the body has ${String(body.length)}`,
    );
  }
  return body.map((line, index) => {
    if (dialect === 'toon' && !line.startsWith(REF_INDENT.toon)) {
      throw new RefError(`framing: row ${String(index)} does not start with the TOON row indent`);
    }
    const cells = refSplitCells(line.slice(REF_INDENT[dialect].length));
    if (cells.length !== header.fields.length) {
      throw new RefError(
        `malformed_cell: row ${String(index)} has ${String(cells.length)} cell(s) and the header declares ` +
          `${String(header.fields.length)}`,
      );
    }
    const record: Record<string, unknown> = {};
    header.fields.forEach((field, cell) => {
      record[field] = refParseCell(cells[cell] ?? '');
    });
    return record;
  });
};

const referenceCodec: ToonCodec = {
  codecId: 'e3-test-reference-toon',
  encode: (value, dialect) => refEncode(value, dialect),
  decode: (text, dialect) => refDecode(text, dialect),
};

/** What a lenient reader considers a number, and it is wider than JSON's. */
const REF_NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u;

/**
 * A reader that type-coerces: a cell holding the string `"1"` comes back as the
 * number 1, and `"0042"` as 42. This is the single most common serializer bug and
 * the one the `json-lookalikes` and `migrations` tasks exist to catch, so it is
 * the fault the fidelity gate is tested against.
 *
 * **`Number()` semantics, not `JSON.parse` semantics**, and that is the point of
 * the second rule. A reader that coerces only what parses as JSON leaves every
 * zero-padded id alone — `"0042"` is not valid JSON — which is exactly the value
 * a real reader gets wrong and a too-narrow stub would wave through.
 */
const refCoerce = (value: unknown): unknown => {
  if (typeof value === 'string' && REF_NUMERIC.test(value.trim())) {
    return Number(value.trim());
  }
  if (typeof value === 'string' && refIsParseableJson(value)) {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'number' || typeof parsed === 'boolean' || parsed === null
      ? refCoerce(parsed)
      : value;
  }
  if (Array.isArray(value)) return value.map(refCoerce);
  if (refIsPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = refCoerce(inner);
    return out;
  }
  return value;
};

const coercingCodec: ToonCodec = {
  codecId: 'e3-test-coercing-reader',
  encode: (value, dialect) => refEncode(value, dialect),
  decode: (text, dialect) => refCoerce(refDecode(text, dialect)),
};

/**
 * A trailing blank line on every second call.
 *
 * Harmless to the reader and fatal to the diff, which is the whole distinction
 * between `unstable` and `lossy`: the data is intact and the bytes are not
 * reproducible, so the finding is a G11 problem and reporting it as corruption
 * would send the reader looking for data loss that is not there.
 */
let unstableCalls = 0;
const unstableCodec: ToonCodec = {
  codecId: 'e3-test-unstable',
  encode: (value, dialect) => {
    unstableCalls += 1;
    const text = refEncode(value, dialect);
    return unstableCalls % 2 === 0 ? `${text}\n` : text;
  },
  decode: (text, dialect) => refDecode(text, dialect),
};

/** Refuses to write anything, including values it can represent. */
const refusingCodec: ToonCodec = {
  codecId: 'e3-test-refusing',
  encode: () => {
    throw new RefError('refused: this codec writes nothing');
  },
  decode: (text, dialect) => refDecode(text, dialect),
};

/**
 * `JSON.stringify` on the way in, which is how a lenient writer "supports" values
 * it cannot represent: the NaN becomes null, the Date becomes a string, the -0
 * becomes 0, and the encoder never notices because by then the value is already
 * something else.
 */
const coercingWriter: ToonCodec = {
  codecId: 'e3-test-silent-loss-writer',
  encode: (value, dialect) => refEncode(JSON.parse(JSON.stringify(value)), dialect),
  decode: (text, dialect) => refDecode(text, dialect),
};

// ---------------------------------------------------------------- subjects

/** A cell as one answer token, written independently of the suite's oracle. */
const refValueText = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value) ?? 'undefined';

const refReadPayload = (
  rendered: string,
  format: E3OutputFormat,
): readonly Record<string, unknown>[] | null => {
  try {
    if (format === 'json') return JSON.parse(rendered) as Record<string, unknown>[];
    if (format === 'toon') return refDecode(rendered, 'toon');
    if (format === 'tron') return refDecode(rendered, 'tron');
    return null;
  } catch {
    return null;
  }
};

/**
 * A subject that reads the bytes it is handed.
 *
 * It never sees the corpus and never sees the oracle, and on a payload it cannot
 * parse it answers nothing at all — which is what makes `control+` a real
 * negative control rather than a label.
 */
const readerResponder: E3Responder = (request: E3Request) => {
  if (request.kind !== 'extraction') return { answers: [], note: 'reads extraction payloads only' };
  const records = refReadPayload(request.rendered, request.format);
  if (records === null) {
    return { answers: [], note: `could not read the ${request.format} payload it was handed` };
  }
  const task = E3_EXTRACTION_TASKS.find((candidate) => candidate.id === request.taskId);
  if (task === undefined) return { answers: [], note: `unknown task ${request.taskId}` };
  const answers = new Set<string>();
  for (const record of records) {
    for (const field of task.fields) {
      const value = record[field];
      if (value === undefined) continue;
      answers.add(refValueText(value));
    }
  }
  return { answers: [...answers].sort(), note: `read ${String(records.length)} row(s) of ${request.format}` };
};

/**
 * The same reader, but it drops the last answer it found.
 *
 * Used to show that a near miss is graded as a miss: two of three answers is not
 * "mostly right", and the binary verdict says so while `fieldRecall` says how
 * wrong it was.
 */
const partialResponder: E3Responder = (request) => {
  const read = readerResponder(request);
  return { answers: read.answers.slice(0, Math.max(0, read.answers.length - 1)), note: `${read.note}, one dropped` };
};

/** A responder that asserts the payload read back exactly. It never does. */
const selfReportingResponder: E3Responder = (request) => ({
  ...readerResponder(request),
  note: 'I read every field of every row perfectly',
});

/**
 * A subject whose diversity is a function of the format it is asked for.
 *
 * **Deterministic by pattern, not by probability.** `convergedSeeds(weight)`
 * returns the first `weight * E3_DIVERSITY_SEEDS` seeds, and every other seed
 * answers a rival chosen by `seed % rivals.length`. So a subject asked to
 * converge in 75% of its samples produces exactly that many, on every task, in
 * every format — and the measured deficit is a property of the subject's design
 * rather than of how a hash happened to fall in twelve draws. A probabilistic
 * responder would make every verdict assertion in this file a coin flip, which
 * is the same trap the suite's own calibration step is built to avoid.
 *
 * This is what lets the verdict be exercised in **both** directions: a subject
 * that converges in JSON and in TOON must produce
 * `drop_toon_keep_verbosity_directives`, and one that converges only in JSON
 * must produce `retain_toon`.
 */
const convergedSeeds = (weight: number): number => Math.round(weight * E3_DIVERSITY_SEEDS);

const formatSensitiveResponder = (weights: Readonly<Record<string, number>>): E3Responder => {
  return (request) => {
    if (request.kind !== 'open_ended') return { answers: [], note: 'open-ended only' };
    const modal = request.modal === '' ? (request.candidates[0] ?? '') : request.modal;
    const rivals = request.candidates.filter((answer) => answer !== modal);
    if (rivals.length === 0) return { answers: [modal], note: 'one candidate only' };
    const weight = weights[request.format] ?? 0;
    if (request.seed < convergedSeeds(weight)) return { answers: [modal], note: `converged (${request.format})` };
    const rival = rivals[request.seed % rivals.length] ?? modal;
    return { answers: [rival], note: `diverged (${request.format})` };
  };
};

/**
 * H-3, a reference classifier.
 *
 * The structural vetoes are the contract, not the parsing: a thinking block
 * holding a perfect table is still a thinking block, and a governance rule
 * holding a perfect table is still a governance rule. So the vetoes come first
 * and the parse second, and a classifier that only knows "does this parse" is
 * what the corpus is built to catch.
 */
const referenceClassifier = (block: E3BoundaryBlock): boolean => {
  if (block.blockType === 'thinking') return false;
  if (block.origin === 'assistant') return false;
  if (block.blockType === 'cache_control') return false;
  if (block.tier === 'governance') return false;
  if (block.severity === 'fatal' || block.severity === 'error') return false;
  if (block.blockType !== 'tool_result' && block.blockType !== 'tool_use') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(block.text);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  const first = refIsPlainObject(parsed[0]) ? parsed[0] : null;
  if (first === null) return false;
  const keys = Object.keys(first);
  if (keys.length === 0) return false;
  for (const row of parsed) {
    if (!refIsPlainObject(row)) return false;
    const rowKeys = Object.keys(row);
    if (rowKeys.length !== keys.length || rowKeys.some((key, index) => key !== keys[index])) return false;
  }
  return true;
};

// ------------------------------------------------------------------ helpers

const codes = (issues: readonly { readonly code: string }[]): string[] => issues.map((issue) => issue.code);
const safeParse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};
const armRate = (report: Awaited<ReturnType<typeof runE3Suite>>, arm: Arm): number => {
  const entry = report.accuracy.byFormat.find((candidate) => candidate.arm === arm);
  return entry?.rate ?? -1;
};

type SuiteOptions = Parameters<typeof runE3Suite>[0];

const suiteOptions = (overrides: Partial<SuiteOptions> = {}): SuiteOptions => ({
  codec: referenceCodec,
  responder: readerResponder,
  classifier: referenceClassifier,
  classifierId: 'e3-test-reference-classifier',
  ...overrides,
});

/**
 * For the guard tests only, which pass values the type system is right to
 * refuse: the point of those tests is the runtime `TypeError`.
 */
const brokenOptions = (override: Record<string, unknown>): SuiteOptions =>
  ({ ...suiteOptions(), ...override }) as unknown as SuiteOptions;

/** The fixture, as something a test can break. One cast, on purpose. */
interface TamperableFixture {
  cases: {
    id: string;
    arms: string[];
    negativeControl: boolean;
    constraints: { id: string; forbidden: string[] }[];
  }[];
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const tamperable = (): TamperableFixture => clone(buildE3Fixture()) as unknown as TamperableFixture;
const asFixture = (value: unknown): EvalFixture => value as EvalFixture;

const roundTripAll = (codec: ToonCodec, corpus: readonly E3CorpusEntry[] = E3_CORPUS): E3RoundTripCase[] => {
  const out: E3RoundTripCase[] = [];
  for (const dialect of E3_DIALECTS) {
    for (const entry of corpus) out.push(runE3RoundTrip(entry, codec, dialect));
  }
  return out;
};

// ------------------------------------------------------------------ fidelity

test('G10: every in-domain entry round-trips losslessly, in both dialects', () => {
  const cases = runE3CorpusRoundTrip(referenceCodec);
  assert.equal(
    cases.length,
    (E3_CORPUS.length + E3_REFUSAL_CORPUS.length) * E3_DIALECTS.length,
    'every entry is measured in every dialect, refusals included',
  );

  const failures = cases
    .filter((entry) => entry.inDomain && entry.state !== 'lossless')
    .map((entry) => `${entry.corpusId}/${entry.dialect}=${entry.state}`);
  assert.deepEqual(failures, [], 'no in-domain value may be lossy, unstable, or refused');

  for (const entry of cases.filter((candidate) => candidate.inDomain)) {
    assert.equal(entry.state, 'lossless', `${entry.corpusId}/${entry.dialect}`);
    assert.equal(entry.differences.length, 0, 'a lossless case has nothing to report');
    assert.ok(entry.detail.length > 0);
    assert.ok(entry.jsonChars > 0, 'the JSON baseline is measured for the saving figure');
  }
});

test('G10: an out-of-domain value the encoder refuses is the only correct outcome', () => {
  for (const dialect of E3_DIALECTS) {
    for (const entry of E3_REFUSAL_CORPUS) {
      const result = runE3RefusalRoundTrip(entry, referenceCodec, dialect);
      assert.equal(result.state, 'refused', `${entry.id}/${dialect} must be refused, got ${result.state}`);
      assert.equal(result.inDomain, false);
      assert.equal(result.encodedChars, 0, 'a refusal wrote no bytes');
      assert.ok(result.detail.length > 0, 'a refusal says why');
    }
  }
});

test('G10: the gate is observed, blocking, and holds the rate at 100%', () => {
  const gate = evaluateE3Fidelity(runE3CorpusRoundTrip(referenceCodec));
  assert.equal(gate.gate, 'G10');
  assert.equal(gate.status, 'observed');
  assert.equal(gate.blocking, true);
  assert.equal(gate.threshold, 1);
  assert.equal(gate.rate, 1);
  assert.equal(gate.lossless, gate.cases);
  assert.equal(gate.lossy, 0);
  assert.equal(gate.encodeRefusals, 0);
  assert.equal(gate.unstable, 0);
  assert.equal(gate.acceptedOutOfDomain, 0);
  assert.equal(gate.refused, E3_REFUSAL_CORPUS.length * E3_DIALECTS.length);
  assert.deepEqual(gate.failingCaseIds, []);
  assert.ok(
    gate.ciLower < 1,
    '100% over a finite corpus bounds the true rate below 1, and the interval is printed anyway',
  );
  assert.ok(gate.savingFraction !== null && gate.savingFraction > 0, 'table formats save characters over JSON');
});

test('G10: a type-coercing reader fails the gate and names the case', () => {
  const cases = [
    ...roundTripAll(coercingCodec),
    ...E3_DIALECTS.flatMap((dialect) =>
      E3_REFUSAL_CORPUS.map((entry) => runE3RefusalRoundTrip(entry, coercingCodec, dialect)),
    ),
  ];
  const gate = evaluateE3Fidelity(cases);
  assert.equal(gate.status, 'not_observed');
  assert.ok(gate.lossy > 0, 'the coercing reader corrupted something');
  assert.ok(
    gate.failingCaseIds.some((id) => id.startsWith('e3-corpus-json-lookalikes')),
    `the lookalike corpus must be in the failure list, got ${gate.failingCaseIds.join(', ')}`,
  );
  const worst = cases.find(
    (entry) => entry.state === 'lossy' && entry.corpusId === 'e3-corpus-json-lookalikes',
  );
  assert.ok(worst !== undefined);
  assert.ok(worst.differences.length > 0, 'a lossy case says which values changed');
  assert.ok(worst.detail.length > 0);
});

test('G10: bytes that do not re-encode are unstable, not lossy', () => {
  const gate = evaluateE3Fidelity(roundTripAll(unstableCodec));
  assert.equal(
    gate.status,
    'inconclusive',
    'nothing was corrupted, so `not_observed` would be the wrong word: the honest status for a payload ' +
      'that reads back but does not re-encode is that nothing was observed',
  );
  assert.equal(gate.lossy, 0, 'no data was corrupted');
  assert.equal(gate.lossless, 0, 'and nothing is reported as a clean pass either');
  assert.ok(gate.unstable > 0, 'the instability is the finding');
  assert.equal(gate.cases, gate.unstable);
  assert.match(gate.detail, /INCONCLUSIVE|not stable|diff/i);
});

test('G10: refusing a value it can represent is a failure, and not counted as corruption', () => {
  const gate = evaluateE3Fidelity([
    ...roundTripAll(refusingCodec),
    ...E3_DIALECTS.flatMap((dialect) =>
      E3_REFUSAL_CORPUS.map((entry) => runE3RefusalRoundTrip(entry, refusingCodec, dialect)),
    ),
  ]);
  assert.equal(
    gate.status,
    'inconclusive',
    'nothing was corrupted and nothing was observed, and the gate says the honest word for that',
  );
  assert.equal(gate.lossy, 0, 'a refusal is a functional gap, not data corruption');
  assert.ok(gate.encodeRefusals > 0);
  assert.equal(gate.rate, 0, 'and it counts against the rate, so a codec that writes nothing cannot pass');
  assert.equal(
    gate.refused,
    E3_REFUSAL_CORPUS.length * E3_DIALECTS.length,
    'refusing everything still refuses the out-of-domain values correctly',
  );
});

test('G10: silently coercing a value it cannot represent is the worst outcome', () => {
  const cases = E3_DIALECTS.flatMap((dialect) =>
    E3_REFUSAL_CORPUS.map((entry) => runE3RefusalRoundTrip(entry, coercingWriter, dialect)),
  );
  const gate = evaluateE3Fidelity([...roundTripAll(coercingWriter), ...cases]);
  assert.equal(gate.status, 'not_observed');

  // A `JSON.stringify` on the way in rescues the *shape* cases — a ragged table is
  // still ragged afterwards — and silently rewrites the *value* ones, which is
  // the whole hazard: the value cases are exactly the ones a lenient writer
  // cannot detect by looking at the result.
  const shapeIds = new Set([
    'e3-refuse-ragged-keys',
    'e3-refuse-reordered-keys',
    'e3-refuse-scalar-row',
    'e3-refuse-empty-array',
    'e3-refuse-unwritable-key',
  ]);
  const accepted = cases.filter((entry) => entry.state === 'accepted_out_of_domain');
  const stillRefused = cases.filter((entry) => entry.state === 'refused');
  assert.equal(accepted.length, (E3_REFUSAL_CORPUS.length - shapeIds.size) * E3_DIALECTS.length);
  assert.equal(stillRefused.length, shapeIds.size * E3_DIALECTS.length);
  for (const entry of stillRefused) {
    assert.ok(shapeIds.has(entry.corpusId), `${entry.corpusId} is a shape, and a shape survives JSON.stringify`);
  }
  assert.ok(
    accepted.some((entry) => entry.corpusId === 'e3-refuse-nan'),
    'a NaN became a null and the encoder never noticed',
  );
  assert.equal(gate.acceptedOutOfDomain, accepted.length);
  assert.equal(gate.refused, stillRefused.length, 'the shape cases are still refused, and still count as refusals');
  assert.match(accepted[0]?.differences.join(' ') ?? '', /outside the JSON domain/);
  assert.ok((accepted[0]?.encodedChars ?? 0) > 0, 'and it wrote bytes, which is the problem');
});

// ---------------------------------------------------------------- extraction

test('extraction: the oracle is computed from the corpus, never from the response', () => {
  for (const task of E3_EXTRACTION_TASKS) {
    const entry = E3_CORPUS.find((candidate) => candidate.id === task.corpusId);
    assert.ok(entry !== undefined, `${task.id} names a corpus entry that exists`);
    const oracle = e3ExtractionOracle(task, entry.records);
    assert.ok(oracle.length > 0, `${task.id} has a non-empty answer set`);
    assert.equal(
      new Set(oracle).size,
      oracle.length,
      `${task.id}: the answer set is a set, so a value repeated in the payload is one answer`,
    );
  }

  const lookalikes = E3_EXTRACTION_TASKS.find((task) => task.id === 'e3-task-lookalike-values');
  assert.ok(lookalikes !== undefined);
  const entry = E3_CORPUS.find((candidate) => candidate.id === lookalikes.corpusId);
  assert.ok(entry !== undefined);
  const oracle = e3ExtractionOracle(lookalikes, entry.records);
  assert.ok(
    oracle.includes('1') && oracle.includes('true'),
    'a lookalike stays a string in the answer set, so returning the number 1 is a wrong answer',
  );
  assert.ok(!oracle.includes('42'), 'a leading zero survives: 0042 is not 42');
});

test('extraction: a composite cell is one answer, spelled the way the cell spells it', () => {
  const task = E3_EXTRACTION_TASKS.find((candidate) => candidate.id === 'e3-task-owners');
  assert.ok(task !== undefined);
  const entry = E3_CORPUS.find((candidate) => candidate.id === task.corpusId);
  assert.ok(entry !== undefined);
  const oracle = e3ExtractionOracle(task, entry.records);
  assert.ok(
    oracle.includes('["sam","priya"]'),
    'JSON, because String() would turn the array into "sam,priya" and collide with a two-word string',
  );
  assert.ok(oracle.includes('[]'), 'an empty array is an answer, not a missing value');
});

test('accuracy: a subject that reads the payload scores 100% in both intact arms', async () => {
  const result = await runE3Suite(suiteOptions());
  assert.equal(armRate(result, 'control'), 1, 'JSON read exactly');
  assert.equal(armRate(result, 'treatment'), 1, 'TOON read exactly');
  assert.equal(armRate(result, 'control+'), 0, 'a truncated JSON payload reads as nothing');
  for (const entry of result.accuracy.byFormat) {
    if (entry.arm === 'control+') {
      assert.ok(entry.roundTripFailures > 0, 'the truncated payload does not read back, and the report says so');
      continue;
    }
    assert.equal(entry.roundTripFailures, 0, `${entry.arm}'s payload read back exactly every time`);
    assert.equal(entry.meanFieldRecall, entry.rate === 1 ? 1 : 0);
  }
});

test('accuracy: the negative control bites even when the subject is perfect', async () => {
  const result = await runE3Suite(
    suiteOptions({ responder: selfReportingResponder, responderId: 'perfect-lying-subject' }),
  );
  assert.equal(
    armRate(result, 'control+'),
    0,
    'the degraded arm fails on the payload, not on the subject cooperating, so a subject that claims ' +
      'it read everything perfectly still cannot pass it',
  );
  assert.equal(result.accuracy.negativeControl.arm, 'control+');
  assert.equal(result.accuracy.negativeControl.degraded, true);
  assert.equal(result.accuracy.negativeControl.observations, E3_EXTRACTION_TASKS.length);
  assert.ok((result.accuracy.negativeControl.rate ?? 1) < 1);
});

test('accuracy: the harness report fires the negative control and the degraded markers', async () => {
  const result = await runE3Suite(suiteOptions());
  const degraded = result.report.cases.map((entry) => entry.arms.find((arm) => arm.arm === 'control+'));
  assert.equal(degraded.length, E3_EXTRACTION_TASKS.length);
  for (const arm of degraded) {
    assert.ok(arm !== undefined);
    assert.equal(arm.status, 'fail', 'a truncated payload fails its case in the harness report');
    assert.ok(arm.violations.length > 0);
  }
  for (const summary of result.report.negativeControls) {
    assert.equal(summary.fired, true, `${summary.caseId} fired its negative control`);
    assert.ok(summary.failingArms.includes('control+'));
  }
  assert.equal(result.report.negativeControls.length, E3_EXTRACTION_TASKS.length);
  assert.equal(result.report.offline, true);
  assert.equal(result.report.suite, 'E3');
  assert.equal(result.report.totals.errored, 0, 'nothing errored; the arms failed rather than crashed');
});

test('accuracy: a lossy payload is caught in the arm itself, not only in a side number', async () => {
  const result = await runE3Suite(suiteOptions({ codec: coercingCodec }));
  const lossyTasks = new Set(
    result.accuracy.verdicts
      .filter((verdict) => verdict.arm === 'treatment' && !verdict.roundTripLossless)
      .map((verdict) => verdict.taskId),
  );
  assert.ok(lossyTasks.size > 0, 'the coercing reader corrupted at least one payload');
  assert.ok(
    lossyTasks.has('e3-task-lookalike-values') && lossyTasks.has('e3-task-migration-ids'),
    'and the two lookalike tasks are among them, which is what they exist for',
  );

  for (const entry of result.report.cases) {
    const treatment = entry.arms.find((arm) => arm.arm === 'treatment');
    assert.ok(treatment !== undefined);
    if (lossyTasks.has(entry.caseId)) {
      assert.equal(treatment.status, 'fail', `${entry.caseId} failed in the harness report`);
      assert.ok(treatment.violations.some((violation) => violation.marker === E3_LOSSY_MARKER));
      // The subject read those bytes correctly — it has its own reader — so the
      // answers are right and only the round trip is wrong. That is precisely
      // the failure G10 exists to catch and the extraction arm cannot: the
      // corruption is in the bytes on the wire, not in what the model did.
      assert.equal(
        treatment.violations.some((violation) => violation.marker === E3_WRONG_MARKER),
        false,
        'a lossy payload is not automatically a wrong answer, and conflating the two would hide this case',
      );
      assert.ok(extractE3Answers(treatment.response).length > 0, 'the subject still answered');
    } else {
      assert.equal(
        treatment.status,
        'pass',
        `${entry.caseId} has nothing a coercing reader could change, so it is not made to fail`,
      );
    }
  }
  for (const verdict of result.accuracy.verdicts.filter(
    (entry) => entry.arm === 'treatment' && !entry.roundTripLossless,
  )) {
    assert.equal(
      verdict.correct,
      true,
      `${verdict.taskId}: the subject's own reader was right, so a lossy payload costs the round trip and ` +
        'not the answer set — which is why G10 is a gate of its own and not a footnote on the accuracy arm',
    );
  }
  const byFormat = result.accuracy.byFormat.find((entry) => entry.arm === 'treatment');
  assert.equal(byFormat?.roundTripFailures, lossyTasks.size, 'the accuracy report counts the same round-trip failures');
});

test('accuracy: a near miss is wrong, and recall says how wrong', async () => {
  const result = await runE3Suite(suiteOptions({ responder: partialResponder }));
  const treatment = result.accuracy.verdicts.filter((verdict) => verdict.arm === 'treatment');
  assert.ok(treatment.length > 0);
  for (const verdict of treatment) {
    assert.equal(verdict.correct, false, 'two of three answers is not a pass');
    assert.equal(verdict.missing.length, 1);
    assert.deepEqual(verdict.spurious, []);
    assert.ok(verdict.fieldRecall > 0 && verdict.fieldRecall < 1, 'and the partial credit is reported');
  }
  const byFormat = result.accuracy.byFormat.find((entry) => entry.arm === 'treatment');
  assert.equal(byFormat?.exact, 0);
  assert.ok((byFormat?.meanFieldRecall ?? 0) > 0, 'a binary verdict alone would hide the near miss');
});

test('accuracy: the paired tests refuse to call "no difference" out of no data', async () => {
  const perfect = await runE3Suite(suiteOptions());
  assert.equal(perfect.accuracy.paired.discordantPairs, 0, 'both arms were perfect, so nothing disagreed');
  assert.equal(perfect.accuracy.paired.state, 'no_discordant_pairs');
  assert.equal(perfect.accuracy.paired.informative, false, 'an uninformative test is not a passed test');
  assert.equal(perfect.accuracy.nonInferiority.conclusive, false);
  assert.equal(
    perfect.accuracy.nonInferiority.nonInferior,
    true,
    'the interval trivially clears the margin, and the flag reports the interval; `conclusive` is the field ' +
      'that says there were no discordant pairs to base it on',
  );
  assert.ok(
    ['no_discordant_pairs', 'insufficient_discordance'].includes(perfect.accuracy.nonInferiority.state),
    perfect.accuracy.nonInferiority.state,
  );

  const partial = await runE3Suite(suiteOptions({ responder: partialResponder }));
  assert.equal(
    partial.accuracy.paired.discordantPairs,
    0,
    'a systematic failure in one arm is not a discordant pair, and McNemar is the right test to say so',
  );
  assert.equal(partial.accuracy.paired.informative, false);
  assert.equal(partial.accuracy.nonInferiority.conclusive, false);
});

test('accuracy: the arm runner records the verdict, and the report says the same thing', async () => {
  const result = await runE3Suite(suiteOptions());
  const totals = result.report.totals;
  assert.equal(totals.observations, E3_EXTRACTION_TASKS.length * E3_ARMS.length);
  for (const arm of totals.byArm) {
    assert.equal(arm.observations, E3_EXTRACTION_TASKS.length);
    assert.equal(arm.errored, 0);
  }
  const control = totals.byArm.find((arm) => arm.arm === 'control');
  const degraded = totals.byArm.find((arm) => arm.arm === 'control+');
  const treatment = totals.byArm.find((arm) => arm.arm === 'treatment');
  assert.equal(control?.violations, 0);
  assert.equal(treatment?.violations, 0);
  assert.ok((degraded?.violations ?? 0) > 0);
  assert.equal(totals.negativeControls, E3_EXTRACTION_TASKS.length);
  assert.equal(totals.negativeControlsFired, E3_EXTRACTION_TASKS.length);
});

test('accuracy: the arms really do interleave, and the order is a function of the seed', async () => {
  const a = await runE3Suite(suiteOptions());
  const b = await runE3Suite(suiteOptions());
  assert.deepEqual(a.report.executionOrder, b.report.executionOrder, 'same seed, same order');
  assert.equal(a.report.executionOrder.length, E3_EXTRACTION_TASKS.length * E3_ARMS.length);
  const perCase = new Map<string, Set<string>>();
  for (const step of a.report.executionOrder) {
    const arms = perCase.get(step.caseId) ?? new Set<string>();
    arms.add(step.arm);
    perCase.set(step.caseId, arms);
  }
  for (const [caseId, arms] of perCase) {
    assert.deepEqual([...arms].sort(), [...E3_ARMS].sort(), `${caseId} ran all three arms`);
  }
  const firstFew = a.report.executionOrder.slice(0, 12);
  assert.ok(
    new Set(firstFew.map((step) => step.arm)).size > 1,
    'arms are not grouped, or drift in time would line up with the arm variable',
  );
});

// ----------------------------------------------------------------- diversity

test('diversity: entropy behaves like entropy', () => {
  assert.equal(e3AnswerEntropyBits([]), 0);
  assert.equal(e3AnswerEntropyBits(['a', 'a', 'a', 'a']), 0, 'one bucket is zero bits');
  assert.equal(e3AnswerEntropyBits(['a', 'b']), 1);
  assert.equal(e3AnswerEntropyBits(['a', 'b', 'c', 'd']), 2);
  assert.ok(e3AnswerEntropyBits(['a', 'a', 'b', 'b']) < e3AnswerEntropyBits(['a', 'b', 'c', 'd']));
  assert.ok(e3NgramEntropyBits('') >= 0);
  assert.equal(
    e3NgramEntropyBits('a'.repeat(200)),
    0,
    'one distinct 4-gram, so zero bits: a long text repeated is a low-entropy text',
  );
  assert.ok(
    e3NgramEntropyBits('the quick brown fox jumps over the lazy dog and keeps going') > 0,
    'varied wording is many distinct 4-grams, which is the whole reason the proxy cannot see a collapse',
  );
});

test('diversity: the n-gram proxy is a surface proxy, and says so', () => {
  const collapse = 'the deployment failed in staging';
  const restated = [
    'the deploy did not succeed in staging',
    'staging is where the deployment failed',
    'in staging, deployment was broken',
  ];
  assert.ok(
    e3AnswerEntropyBits([collapse, ...restated]) > E3_NULL_EFFECT_BITS,
    'the exact metric sees four answers, so it reports diversity',
  );
  assert.equal(
    e3EmbeddingEntropyBits([collapse, ...restated]),
    0,
    'the embedding proxy sees one meaning and reports none — this is the difference between them',
  );
  assert.ok(
    e3NgramEntropyBits([collapse, ...restated].join('\n')) > E3_NULL_EFFECT_BITS,
    'and the n-gram proxy still reports variety, because the wording changed',
  );
  assert.equal(E3_EMBEDDING_COSINE_THRESHOLD, 0.6);
});

test('diversity: a format condition is measured in every format, with the baseline unforced', () => {
  const responder = formatSensitiveResponder({});
  const measurements = E3_DIVERSITY_FORMATS.map((format) => measureE3Diversity(E3_DIVERSITY_TASKS, format, responder));
  assert.equal(measurements.length, E3_DIVERSITY_FORMATS.length);
  assert.ok(E3_DIVERSITY_FORMATS.includes('prose'), 'there is an unforced condition to measure against');
  assert.equal(
    renderE3FormatDirective('prose'),
    '',
    'the unforced condition hands the responder no format instruction at all',
  );
  for (const format of E3_DIVERSITY_FORMATS.filter((entry) => entry !== E3_DIVERSITY_BASELINE)) {
    assert.notEqual(renderE3FormatDirective(format), '', `${format} names its format in the instruction`);
  }
  assert.equal(renderE3FormatDirective(E3_DIVERSITY_BASELINE), '', 'and the baseline names nothing');
  for (const measurement of measurements) {
    assert.equal(measurement.answers, E3_DIVERSITY_TASKS.length * E3_DIVERSITY_SEEDS);
    assert.equal(measurement.perTask.length, E3_DIVERSITY_TASKS.length);
  }
});

test('diversity: deficits are baseline-relative, so a format is not charged for the task', () => {
  const responder = formatSensitiveResponder({ json: 0.95 });
  const measurements = attributeE3Diversity(
    E3_DIVERSITY_FORMATS.map((format) => measureE3Diversity(E3_DIVERSITY_TASKS, format, responder)),
  );
  const baseline = measurements.find((entry) => entry.format === E3_DIVERSITY_BASELINE);
  const json = measurements.find((entry) => entry.format === 'json');
  assert.ok(baseline !== undefined && json !== undefined);
  assert.equal(baseline.deficit.exact, 0, 'a format is never compared against itself');
  assert.ok(json.deficit.exact > 0, 'JSON converged and the baseline did not');
  assert.ok(json.exactEntropyBits < baseline.exactEntropyBits);
  assert.ok(json.tests.exact.state !== undefined);
  for (const entry of measurements) {
    assert.equal(typeof entry.tests.ngram.pTwoSided, 'number');
    assert.equal(typeof entry.tests.embedding.pTwoSided, 'number');
  }
});

test('calibration: the instrument passes, and reports the noise it measured', () => {
  const calibration = calibrateE3Diversity();
  assert.equal(calibration.passed, true, `calibration failed: ${calibration.failures.join('; ')}`);
  assert.deepEqual(calibration.failures, []);

  const byMetric = new Map(calibration.metrics.map((metric) => [metric.metric, metric]));
  const exact = byMetric.get('exact');
  const ngram = byMetric.get('ngram');
  const embedding = byMetric.get('embedding');
  assert.ok(exact !== undefined && ngram !== undefined && embedding !== undefined);

  for (const metric of [exact, embedding]) {
    assert.equal(metric.convergent, true, `${metric.metric} must see total convergence`);
    assert.equal(metric.surfaceOnly, false);
    assert.ok(
      metric.dropBits >= E3_CALIBRATION_MIN_DROP_BITS,
      `${metric.metric} must see the effect at all, not just its absence`,
    );
    assert.ok(
      metric.maxRiseBits <= metric.noiseBits,
      `${metric.metric} rose ${String(metric.maxRiseBits)} bits, more than the ${String(metric.noiseBits)}-bit ` +
        'spread its own samples show, so it would be a rise rather than noise',
    );
  }

  assert.equal(ngram.surfaceOnly, true, 'the surface proxy must NOT see the collapse');
  assert.equal(ngram.convergent, false);
  assert.ok(ngram.series.every((bits) => bits > E3_NULL_EFFECT_BITS), 'n-gram entropy stays high throughout');
  assert.ok(ngram.dropBits < 0, 'and it never fell, which is the whole point of holding it to the opposite standard');
});

test('calibration: the paraphrase collapse shows the exact metric being fooled', () => {
  const calibration = calibrateE3Diversity();
  const collapse = calibration.paraphraseCollapse;
  assert.equal(collapse.passed, true, `collapse check failed: ${collapse.detail}`);
  assert.ok(collapse.taskIds.length > 0, 'at least one task declares a reworded duplicate');
  assert.equal(collapse.exactIsFooled, true, 'the exact metric reports diversity for one meaning reworded');
  assert.equal(collapse.embeddingSeesCollapse, true, 'the embedding proxy sees through it');
  assert.equal(collapse.ngramStaysHigh, true);
  assert.ok(collapse.point.embeddingEntropyBits <= E3_NULL_EFFECT_BITS);
});

test('calibration: a task set with no paraphrase set cannot demonstrate non-redundancy', () => {
  const noParaphrases = E3_DIVERSITY_TASKS.map((task) => ({ ...task, paraphrases: [] as number[] }));
  const calibration = calibrateE3Diversity(noParaphrases);
  assert.equal(calibration.passed, false);
  assert.ok(
    calibration.failures.some((failure) => failure.includes('paraphrase')),
    `expected the paraphrase condition to be the failure, got: ${calibration.failures.join('; ')}`,
  );
});

// ------------------------------------------------------------------- verdict

const jsonBandResponder = formatSensitiveResponder({
  json: 0.95,
  toon: 0.95,
  tron: 0.95,
  yaml: 0.05,
  csv: 0.05,
});
const distinctResponder = formatSensitiveResponder({
  json: 0.95,
  toon: 0.02,
  tron: 0.02,
  yaml: 0.05,
  csv: 0.05,
});

const measureWith = (responder: E3Responder) =>
  attributeE3Diversity(
    E3_DIVERSITY_FORMATS.map((format) => measureE3Diversity(E3_DIVERSITY_TASKS, format, responder)),
  );

test('verdict: TOON in JSON\'s band drops the feature', () => {
  const verdict = evaluateE3Diversity(measureWith(jsonBandResponder), calibrateE3Diversity());
  assert.equal(verdict.outcome, 'drop_toon_keep_verbosity_directives');
  assert.equal(verdict.jsonLike, true);
  assert.equal(verdict.blocking, false, 'the diversity finding is a decision, not a pre-registered gate');
  assert.equal(verdict.calibrationPassed, true);
  assert.deepEqual(verdict.reasons, []);
  assert.ok(
    verdict.deficits['toon'] !== undefined && verdict.deficits['toon'] >= verdict.deficits['json']! - E3_JSON_LIKE_TOLERANCE_BITS,
  );
  assert.equal(verdict.bands['toon'], 'suppressed');
  assert.equal(verdict.bands['yaml'], 'no_significant_effect', 'YAML is the control that makes the JSON number mean something');
  assert.equal(verdict.bands['csv'], 'no_significant_effect');
  assert.equal(verdict.referenceDeficitBits, E3_JSON_DIVERSITY_DEFICIT_BITS);
  assert.match(verdict.statement, /dropped/i);
  assert.match(verdict.detail, /44 models/);
});

test('verdict: TOON outside JSON\'s band is retained', () => {
  const verdict = evaluateE3Diversity(measureWith(distinctResponder), calibrateE3Diversity());
  assert.equal(verdict.outcome, 'retain_toon');
  assert.equal(verdict.jsonLike, false);
  assert.equal(verdict.bands['toon'], 'no_significant_effect');
  assert.ok(
    verdict.deficits['toon']! < verdict.deficits['json']! - E3_JSON_LIKE_TOLERANCE_BITS,
    `TOON's ${String(verdict.deficits['toon'])}-bit deficit must sit outside JSON's ` +
      `${String(verdict.deficits['json'])}-bit band`,
  );
  assert.match(verdict.statement, /retained/i);
});

test('verdict: the comparison is one-sided, so a hair\'s-breadth in TOON\'s favour still drops it', () => {
  const measurements = measureWith(distinctResponder);
  const jsonDeficit =
    measurements.find((entry) => entry.format === 'json')?.deficit.exact ?? 0;
  assert.ok(jsonDeficit > E3_JSON_LIKE_TOLERANCE_BITS, 'otherwise the tie is not outside the band to begin with');
  const withToonDeficit = (toonDeficit: number) =>
    measurements.map((entry) =>
      entry.format === 'toon' ? { ...entry, deficit: { ...entry.deficit, exact: toonDeficit } } : entry,
    );

  assert.equal(
    evaluateE3Diversity(withToonDeficit(jsonDeficit - E3_JSON_LIKE_TOLERANCE_BITS), calibrateE3Diversity()).jsonLike,
    true,
    'exactly at the tolerance counts as JSON-like: a false keep is the expensive error',
  );
  assert.equal(
    evaluateE3Diversity(
      withToonDeficit(jsonDeficit - E3_JSON_LIKE_TOLERANCE_BITS - 0.001),
      calibrateE3Diversity(),
    ).jsonLike,
    false,
    'and a hair outside it is retained',
  );
  const dropped = evaluateE3Diversity(
    withToonDeficit(jsonDeficit - E3_JSON_LIKE_TOLERANCE_BITS),
    calibrateE3Diversity(),
  );
  assert.equal(dropped.outcome, 'drop_toon_keep_verbosity_directives');
});

test('verdict: a failed calibration makes the verdict inconclusive, whatever the numbers', () => {
  const failed = { ...calibrateE3Diversity(), passed: false, failures: ['the instrument is stuck'] };
  const verdict = evaluateE3Diversity(measureWith(jsonBandResponder), failed);
  assert.equal(verdict.outcome, 'inconclusive', 'an instrument that cannot see the effect cannot rule it out');
  assert.equal(verdict.calibrationPassed, false);
  assert.ok(verdict.reasons.includes('the instrument is stuck'));
  assert.match(verdict.statement, /not established/i);
});

test('verdict: a missing format is inconclusive, and named', () => {
  const partial = measureWith(jsonBandResponder).filter((entry) => entry.format !== 'csv');
  const verdict = evaluateE3Diversity(partial, calibrateE3Diversity());
  assert.equal(verdict.outcome, 'inconclusive');
  assert.ok(verdict.reasons.some((reason) => reason.includes('csv')), verdict.reasons.join('; '));
  assert.equal(verdict.bands['csv'], 'not_measured');
  assert.equal(verdict.deficits['csv'], undefined);
});

test('verdict: no baseline means there is nothing to measure a deficit against', () => {
  const noBaseline = measureWith(jsonBandResponder).filter((entry) => entry.format !== E3_DIVERSITY_BASELINE);
  const verdict = evaluateE3Diversity(noBaseline, calibrateE3Diversity());
  assert.equal(verdict.outcome, 'inconclusive');
  assert.ok(verdict.reasons.some((reason) => reason.includes(E3_DIVERSITY_BASELINE)));
  assert.equal(verdict.jsonLike, false);
});

// ------------------------------------------------------------------ boundary

test('boundary: the reference classifier passes H-3 with no false positives at all', () => {
  const report = evaluateE3Boundary(E3_BOUNDARY_BLOCKS, referenceClassifier);
  assert.equal(report.passed, true, report.detail);
  assert.equal(report.falsePositives, 0);
  assert.equal(E3_BOUNDARY_FALSE_POSITIVE_CEILING, 0, 'the ceiling is absolute, not a rate to trade against');
  assert.ok(report.truePositives >= report.minTruePositives);
  assert.equal(report.degenerate, false);
  assert.equal(report.falseNegativeRate, 0);
  assert.deepEqual(report.falsePositiveIds, []);
  assert.ok(report.machineBlocks > 0 && report.blocks > report.machineBlocks);
});

test('boundary: the negatives include cases whose bytes are perfect', () => {
  const perfectBytes = E3_BOUNDARY_BLOCKS.filter(
    (block) => !block.machineReadable && (() => {
      try {
        return Array.isArray(JSON.parse(block.text));
      } catch {
        return false;
      }
    })(),
  );
  assert.ok(
    perfectBytes.length >= 3,
    'a classifier that only parses would call these machine-readable and corrupt real output',
  );
  for (const block of perfectBytes) {
    assert.equal(referenceClassifier(block), false, `${block.id} must not be rewritten`);
  }
  const machine = E3_BOUNDARY_BLOCKS.filter((block) => block.machineReadable);
  assert.ok(machine.length > 0);
  for (const block of machine) {
    assert.equal(referenceClassifier(block), true, `${block.id} must be detected`);
  }
});

test('boundary: a classifier that never fires is degenerate, not safe', () => {
  const report = evaluateE3Boundary(E3_BOUNDARY_BLOCKS, () => false);
  assert.equal(report.passed, false);
  assert.equal(report.falsePositives, 0, 'a clean 0% false-positive rate, achieved by never opening the gate');
  assert.equal(report.degenerate, true);
  assert.equal(report.truePositives, 0);
  assert.equal(report.falseNegativeRate, 1);
  assert.match(report.detail, /cannot open|never firing/i);
});

test('boundary: rewriting a thinking block or a governance rule fails', () => {
  const parseOnly = evaluateE3Boundary(
    E3_BOUNDARY_BLOCKS,
    (block) => Array.isArray(safeParse(block.text)),
  );
  assert.equal(parseOnly.passed, false);
  assert.ok(parseOnly.falsePositives > 0, 'the bytes parsed, so a parse-only classifier says yes');
  assert.ok(
    parseOnly.falsePositiveIds.some((id) => id.includes('thinking')),
    `the thinking block is the case that matters: ${parseOnly.falsePositiveIds.join(', ')}`,
  );
  assert.match(parseOnly.detail, /must never be/);
});

test('boundary: a classifier that says yes to everything fails', () => {
  const report = evaluateE3Boundary(E3_BOUNDARY_BLOCKS, () => true);
  assert.equal(report.passed, false);
  assert.equal(report.degenerate, false, 'it did fire, on everything');
  assert.equal(report.truePositives, report.machineBlocks);
  assert.equal(report.falsePositives, report.blocks - report.machineBlocks);
});

// ------------------------------------------------------------------- fixture

test('fixture: the authored document validates, with no issues of any kind', () => {
  assert.deepEqual(checkE3Rules(buildE3Fixture()), [], 'the suite ships a fixture its own rules accept');
  const document = buildE3Document();
  assert.equal(document['suite'], 'E3');
  const cases = document['cases'] as { id: string; arms: string[]; negativeControl: boolean }[];
  assert.equal(cases.length, E3_EXTRACTION_TASKS.length);
  for (const entry of cases) {
    assert.deepEqual(entry.arms, [...E3_ARMS], `${entry.id} runs all three arms`);
    assert.equal(entry.negativeControl, true, `${entry.id} is a negative-control case`);
  }
});

test('fixture: a task that asks for a field the payload lacks is refused', () => {
  const broken = [{ ...E3_EXTRACTION_TASKS[0]!, id: 'e3-task-absent', fields: ['not_a_field'] }];
  const issues = checkE3Rules(buildE3Fixture(), E3_CORPUS, broken, E3_DIVERSITY_TASKS);
  assert.ok(codes(issues).includes('missing_field'), issues.map((issue) => issue.code).join(', '));
  assert.throws(() => buildE3Fixture(broken), E3FixtureError);
});

test('fixture: a corpus that is not a table is refused before it can be scored', () => {
  const ragged: E3CorpusEntry[] = [
    ...E3_CORPUS,
    { id: 'e3-corpus-ragged', title: 'Ragged rows', notes: 'Row 2 is missing a field.', records: [{ a: 1 }, { b: 2 }] },
  ];
  const issues = checkE3Rules(buildE3Fixture(), ragged);
  assert.ok(codes(issues).includes('nonuniform_corpus'));
  const empty = checkE3Rules(buildE3Fixture(), [
    ...E3_CORPUS,
    { id: 'e3-corpus-empty', title: 'No rows', notes: '', records: [] },
  ]);
  assert.ok(
    codes(empty).includes('nonuniform_corpus'),
    'an empty array declares no columns, so a refusal there would look like a fidelity failure',
  );
});

test('fixture: payload text that could forge a framing token is refused', () => {
  const forged: E3CorpusEntry[] = [
    ...E3_CORPUS,
    {
      id: 'e3-corpus-forged',
      title: 'A cell that looks like framing',
      notes: '',
      records: [{ body: '#e3 payload-begin', other: E3_WRONG_MARKER }],
    },
  ];
  const issues = checkE3Rules(buildE3Fixture(), forged);
  const collisions = issues.filter((issue) => issue.code === 'payload_collision');
  assert.equal(collisions.length, 2, 'both the delimiter and the marker are caught');
  assert.ok(collisions.some((issue) => issue.message.includes('#e3 payload-begin')));
});

test('fixture: the harness rules fire on a document that cannot support the claim', () => {
  const missingArm = tamperable();
  missingArm.cases[0]!.arms = ['control', 'treatment'];
  assert.ok(codes(checkE3Rules(asFixture(missingArm))).includes('missing_arm'));

  const notNegative = tamperable();
  notNegative.cases[1]!.negativeControl = false;
  assert.ok(codes(checkE3Rules(asFixture(notNegative))).includes('not_negative_control'));

  const ungradeable = tamperable();
  ungradeable.cases[2]!.constraints[0]!.forbidden = [];
  assert.ok(
    codes(checkE3Rules(asFixture(ungradeable))).includes('not_gradeable'),
    'a case with no forbidden marker cannot fail, so control+ cannot fire on it',
  );

  const unknown = tamperable();
  unknown.cases[3]!.id = 'e3-task-invented';
  assert.ok(codes(checkE3Rules(asFixture(unknown))).includes('unknown_task'));
});

test('fixture: a task with no case never runs, and is reported', () => {
  const extra = [...E3_EXTRACTION_TASKS, { ...E3_EXTRACTION_TASKS[0]!, id: 'e3-task-uncased' }];
  const issues = checkE3Rules(buildE3Fixture(), E3_CORPUS, extra);
  assert.ok(codes(issues).includes('uncased_task'));
});

test('fixture: a diversity task that cannot collapse is reported', () => {
  const [first] = E3_DIVERSITY_TASKS;
  assert.ok(first !== undefined);
  const single: E3DiversityTask[] = [{ ...first, answers: [first.answers[0] ?? 'only'] }];
  assert.ok(codes(checkE3Rules(buildE3Fixture(), E3_CORPUS, E3_EXTRACTION_TASKS, single)).includes('no_discriminable_answer'));

  const duplicated = [{ ...first, answers: [first.answers[0] ?? 'a', first.answers[0] ?? 'a'] }];
  assert.ok(
    codes(checkE3Rules(buildE3Fixture(), E3_CORPUS, E3_EXTRACTION_TASKS, duplicated)).includes('duplicate_answer'),
  );

  const badModal = [{ ...first, modal: 99 }];
  assert.ok(codes(checkE3Rules(buildE3Fixture(), E3_CORPUS, E3_EXTRACTION_TASKS, badModal)).includes('bad_modal'));

  const badParaphrase = [{ ...first, paraphrases: [first.modal] }];
  assert.ok(
    codes(checkE3Rules(buildE3Fixture(), E3_CORPUS, E3_EXTRACTION_TASKS, badParaphrase)).includes('bad_paraphrase'),
  );
});

test('fixture: buildE3Fixture throws with the issues attached, not a bare error', () => {
  try {
    buildE3Fixture([{ ...E3_EXTRACTION_TASKS[0]!, fields: ['nope'] }]);
    assert.fail('expected the fixture to be refused');
  } catch (error) {
    assert.ok(error instanceof E3FixtureError);
    assert.ok(error.issues.length > 0);
    assert.ok(codes(error.issues).includes('missing_field'));
    assert.match(error.message, /missing_field|nope/);
  }
});

// ---------------------------------------------------------------- renderers

test('renderers: JSON is the baseline, and the table formats are only prompts', () => {
  const records = E3_CORPUS[0]?.records ?? [];
  assert.equal(renderE3Json(records), `${JSON.stringify(records, null, 2)}\n`);
  assert.ok(renderE3Csv(records).endsWith('\n'));
  assert.ok(renderE3Yaml(records).endsWith('\n'));
  assert.equal(renderE3Payload(records, 'prose', referenceCodec), '', 'the unforced condition has no payload');
  assert.equal(renderE3Payload(records, 'json', referenceCodec), renderE3Json(records));
  assert.match(renderE3Payload(records, 'toon', referenceCodec), /^toon1\[\d+\]\{/u);
  assert.match(renderE3Payload(records, 'tron', referenceCodec), /^tron1\[\d+\]\{/u);
  assert.notEqual(
    renderE3Payload(records, 'toon', referenceCodec),
    renderE3Payload(records, 'tron', referenceCodec),
    'the two dialects differ in framing, which is the only thing H-1 and H-2 are allowed to differ in',
  );
  const csv = renderE3Csv([{ a: 'x,y' }, { a: 'q"q' }]);
  assert.equal(csv, 'a\n"x,y"\n"q""q"\n', 'a comma and a quote in a cell do not shift the columns');
});

test('renderers: the degraded payload is short, and says so', () => {
  const payload = renderE3Json(E3_CORPUS[0]?.records ?? []);
  const degraded = degradeE3Payload(payload);
  assert.ok(degraded.length < payload.length, 'the control+ channel is strictly shorter');
  assert.ok(degraded.includes(E3_DEGRADED_NOTE), 'and it says that it was cut, rather than pretending');
  assert.equal(
    degraded.split('\n').filter((line) => line !== '').length,
    E3_DEGRADED_PAYLOAD_LINES + 1,
    'a few lines, then the note',
  );
  assert.equal(degraded, degradeE3Payload(payload), 'the degradation is a function of the payload alone');
  assert.equal(refReadPayload(degraded, 'json'), null, 'and it does not parse, which is the point');
});

// -------------------------------------------------------------------- the run

test('suite: runE3Suite is deterministic, and reports no clock or network', async () => {
  const a = await runE3Suite(suiteOptions());
  const b = await runE3Suite(suiteOptions());
  // Serialized bytes, not `deepEqual`: the DoD asks for byte-identical output and
  // a report is only diffable as text. A key-order or `undefined`-dropping
  // difference is invisible to `deepEqual` and visible in every review that has
  // to read two reports side by side.
  assert.equal(
    JSON.stringify(a.report, null, 2),
    JSON.stringify(b.report, null, 2),
    'a committed report has to diff cleanly against the next one',
  );
  assert.deepEqual(a.report, b.report);
  assert.deepEqual(a.fidelity, b.fidelity);
  assert.deepEqual(a.accuracy.byFormat, b.accuracy.byFormat);
  assert.deepEqual(a.diversity.outcome, b.diversity.outcome);
  assert.deepEqual(a.boundary, b.boundary);
  const reportText = JSON.stringify(a.report);
  for (const field of ['"generatedAt"', '"timestamp"', '"finishedAt"', '"startedAt"', '"durationMs"', '"Date.now"']) {
    assert.equal(reportText.includes(field), false, `no ${field} leaks into a report that has to be diffed`);
  }
  assert.equal(a.report.offline, true);
  assert.equal(a.report.seed, b.report.seed, 'the seed is in the report, so a run can be reproduced from it');
});

test('suite: provenance names every subject, and admits what it did not measure', async () => {
  const result = await runE3Suite(suiteOptions({ responderId: 'reference-reader' }));
  const provenance = result.provenance;
  assert.equal(provenance.codecId, referenceCodec.codecId);
  assert.equal(provenance.responderId, 'reference-reader');
  assert.equal(provenance.classifierId, 'e3-test-reference-classifier');
  assert.deepEqual([...provenance.arms], [...E3_ARMS]);
  assert.equal(provenance.corpusEntries, E3_CORPUS.length);
  assert.equal(provenance.refusalCorpusEntries, E3_REFUSAL_CORPUS.length);
  assert.equal(provenance.extractionTasks, E3_EXTRACTION_TASKS.length);
  assert.equal(provenance.diversityTasks, E3_DIVERSITY_TASKS.length);
  assert.equal(provenance.diversitySeeds, E3_DIVERSITY_SEEDS);
  assert.equal(provenance.boundaryBlocks, E3_BOUNDARY_BLOCKS.length);
  assert.equal(provenance.roundTripCases, E3_CORPUS.length * E3_DIALECTS.length);
  assert.equal(provenance.modelFamiliesObserved, 0, 'one offline subject, not a model family');
  assert.equal(provenance.diversityBandObserved, 1, 'one diversity band, not a campaign');
  assert.match(provenance.diversityReferenceSource, /44-model/);
  assert.ok(provenance.todos.length >= 3, 'the unsourced numbers are carried as TODOs, not as results');
  assert.ok(provenance.todos.some((todo) => todo.includes('44-model')));
  assert.ok(provenance.todos.some((todo) => todo.includes('unsourced')));
  assert.ok(provenance.todos.some((todo) => todo.includes('E5')));
});

test('suite: the diversity verdict is reported with the same prominence as the gate', async () => {
  const result = await runE3Suite(suiteOptions());
  assert.equal(result.fidelity.gate, 'G10');
  assert.equal(result.fidelity.blocking, true);
  assert.equal(result.diversity.blocking, false, 'not a pre-registered gate, so inventing one would widen the campaign');
  assert.equal(result.diversity.calibrationPassed, true);
  assert.notEqual(result.diversity.outcome, 'inconclusive');
  assert.equal(result.boundary.passed, true);
  assert.equal(result.calibration.passed, true);
  assert.equal(result.accuracy.negativeControl.degraded, true);
});

test('suite: an uncalibrated instrument stops the diversity verdict in the suite too', async () => {
  const result = await runE3Suite(
    suiteOptions({ diversityTasks: E3_DIVERSITY_TASKS.map((task) => ({ ...task, paraphrases: [] })) }),
  );
  assert.equal(result.calibration.passed, false);
  assert.equal(result.diversity.outcome, 'inconclusive');
  assert.equal(result.fidelity.status, 'observed', 'and it does not touch the one blocking gate');
});

test('suite: the arm runner refuses a case it cannot answer rather than scoring it', async () => {
  // The fixture is built from one task list and the runner is built from another,
  // which is the shape of the bug this guard exists for: a case the runner has
  // no records for would otherwise be graded against an empty answer set and
  // pass.
  const fixture = buildE3Fixture();
  const mismatched = createE3ArmRunner(
    E3_EXTRACTION_TASKS.filter((task) => task.id !== fixture.cases[0]!.id),
    E3_CORPUS,
    referenceCodec,
    readerResponder,
  );
  // The harness absorbs a throwing arm into an `errored` observation rather than
  // crashing the run, which is the right behaviour: one broken arm must not cost
  // the other 29 cases. So the contract is that the failure is *visible* in the
  // report, with the guard's own message attached.
  const report = await runSuite(fixture, { runArm: mismatched.run });
  const unanswerable = report.cases.find((entry) => entry.caseId === fixture.cases[0]!.id);
  const broken = unanswerable?.arms.find((arm) => arm.arm === 'control');
  assert.equal(broken?.status, 'error');
  assert.match(broken?.error ?? '', /has no extraction task/);
  assert.equal(
    unanswerable?.arms.every((arm) => arm.status === 'error'),
    true,
    'every arm of an unanswerable case errors rather than one of them quietly passing',
  );
  assert.ok(report.totals.errored > 0, 'and it is counted rather than swallowed');
  const answered = report.cases.find((entry) => entry.caseId === fixture.cases[1]!.id);
  assert.equal(
    answered?.arms.every((arm) => arm.status === 'pass' || arm.status === 'fail'),
    true,
    'the cases the runner does know how to answer still ran, and were graded',
  );

  // And in the other direction: a task with no case is a fixture defect, reported
  // by the review rules rather than by a crash.
  const orphan = [...E3_EXTRACTION_TASKS, { ...E3_EXTRACTION_TASKS[0]!, id: 'e3-task-extra' }];
  assert.ok(codes(checkE3Rules(buildE3Fixture(E3_EXTRACTION_TASKS), E3_CORPUS, orphan)).includes('uncased_task'));
  // Passing the extra task to the suite builds a case for it, so the run is larger
  // rather than broken.
  const result = await runE3Suite(suiteOptions({ tasks: orphan }));
  assert.equal(result.accuracy.byFormat[0]?.observations, orphan.length);
});

test('suite: every subject is required, and the error says why', async () => {
  await assert.rejects(() => runE3Suite(brokenOptions({ codec: undefined })), /codec is required/);
  await assert.rejects(() => runE3Suite(brokenOptions({ codec: { codecId: 'half' } })), /codec is required/);
  await assert.rejects(
    () => runE3Suite(brokenOptions({ codec: { codecId: '', encode: () => '', decode: () => null } })),
    /codec is required/,
  );
  await assert.rejects(() => runE3Suite(brokenOptions({ responder: undefined })), /responder is required/);
  await assert.rejects(() => runE3Suite(brokenOptions({ classifier: undefined })), /classifier is required/);
  await assert.rejects(() => runE3Suite(suiteOptions({ classifierId: '' })), /classifierId is required/);
});

test('suite: a lossy codec fails the blocking gate and the arm report at once', async () => {
  const result = await runE3Suite(suiteOptions({ codec: coercingCodec }));
  assert.equal(result.fidelity.status, 'not_observed');
  assert.equal(result.fidelity.blocking, true);
  assert.ok(result.fidelity.lossy > 0);
  const treatment = result.report.totals.byArm.find((arm) => arm.arm === 'treatment');
  assert.ok((treatment?.violations ?? 0) > 0, 'the same defect shows up in the harness report');
  assert.ok((result.accuracy.negativeControl.rate ?? 1) < 1);
});
