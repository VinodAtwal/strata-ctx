import type { ContentBlock } from '@strata-ctx/core-types';
import { isHighSeverity } from '@strata-ctx/core-types';

import type { ToonError } from './errors.js';
import { toonError } from './errors.js';
import type { JsonValue } from './json-value.js';
import { jsonDefect } from './json-value.js';
import { tryTableFields } from './grammar.js';

/**
 * H-3. Is this block machine-readable?
 *
 * ## The asymmetry that makes this safe
 *
 * A false positive rewrites prose a model wrote, and the model then answers
 * about data that is not what it said. A false negative leaves a tool result as
 * JSON. One corrupts output, the other spends a few tokens. So the classifier
 * is built to be *embarrassingly reluctant*, and every uncertain case resolves
 * to passthrough:
 *
 * 1. **Structural vetoes first, from the canonical model, not from the text.**
 *    A `thinking` block, anything from the `assistant`, anything at tier
 *    `governance`: never machine-readable, whatever the bytes say. These are
 *    facts about *where the text came from*, and they are the strongest signal
 *    available -- a regex cannot tell reasoning that happens to be valid JSON
 *    from structured output that happens to read like reasoning.
 * 2. **A syntactic floor, not a heuristic.** `machine` requires the whole text
 *    to be one JSON value *and* an array of at least one uniform plain object --
 *    the exact shape H-1 can write and read back losslessly. Anything else is
 *    prose, code, a log, a markdown table, or a value we would refuse to
 *    re-serialize, and in every one of those four cases the right answer is the
 *    same: do not touch it.
 * 3. **Round-trip check at the point of use.** "Machine-readable" is defined
 *    here as "we can put it back exactly", and ./select.ts re-proves it by
 *    parsing the emitted text and comparing, so a classifier that was wrong
 *    about the shape costs a fallback rather than a corruption.
 *
 * ## The adversarial cases this is built against
 *
 * A markdown table that looks tabular; a JS/TS object literal that looks like
 * data; a JSON payload wrapped in a ``` fence; a code block that happens to
 * start with `{`; a tool result that is a single number. All of them fail the
 * syntactic floor, and the test suite in ./classify.test.ts asserts each one by
 * name so a future relaxation cannot quietly admit one back.
 */

export type MachineReason =
  /** The one reason that means "yes". */
  | 'json_table'
  | 'no_text'
  | 'empty_text'
  | 'strata_marker'
  | 'code_fence'
  | 'not_json'
  | 'not_an_array'
  | 'empty_array'
  | 'not_records'
  | 'not_uniform'
  | 'out_of_domain'
  | 'thinking_block'
  | 'governance_tier'
  | 'assistant_origin'
  | 'high_severity'
  | 'text_block'
  | 'other_block_type';

export interface MachineClassification {
  /** The only field a caller should branch on. `false` means pass through. */
  readonly machine: boolean;
  readonly reason: MachineReason;
  /** Number of records, or 0 when `machine` is false. */
  readonly rows: number;
  /** Why in prose, for telemetry. Never parsed. */
  readonly detail: string;
  /**
   * The defect that stopped a JSON-shaped value, when there was one. `undefined`
   * for the structural vetoes and for the parse failures, which are not defects
   * in the value so much as a statement about it.
   */
  readonly defect: ToonError | undefined;
}

const PASSTHROUGH = (
  reason: MachineReason,
  detail: string,
  defect?: ToonError,
): MachineClassification =>
  Object.freeze({ machine: false, reason, rows: 0, detail, defect });

const MACHINE: MachineClassification = Object.freeze({
  machine: true,
  reason: 'json_table',
  rows: 0,
  detail: 'the text is a JSON array of uniform records',
  defect: undefined,
});

/**
 * Bookkeeping this package and the pipeline write into block text.
 *
 * `[strata:` is the namespace Tier 0 already reserves for its own markers
 * (`[strata:pointer]`, `[strata:truncated]`). Re-compressing a stub is how a
 * pointer becomes a pointer to a pointer to a table, so the marker is checked
 * before the parse and costs nothing when absent.
 */
const STRATA_MARKER = /^\s*\[strata:/;

/**
 * A fence at the *start* of the content. Only the start, on purpose: a fenced
 * block is a message *about* data, and its first characters are the fence
 * rather than the payload. A `~~~` or ``` ``` ```` appearing in the middle of a
 * string value is data, and matching it would refuse a legitimate table.
 */
const LEADING_FENCE = /^\s*(?:```|~~~)/;

function isFenceAt(text: string): boolean {
  return LEADING_FENCE.test(text);
}

function classifyParsed(value: JsonValue): MachineClassification {
  if (!Array.isArray(value)) {
    return PASSTHROUGH('not_an_array', 'the payload is a JSON value, not an array of records');
  }
  if (value.length === 0) {
    return PASSTHROUGH('empty_array', 'the payload is an empty array: nothing to factor out');
  }
  // `jsonDefect` first: a `Date` or a `NaN` inside a record is a reason to
  // refuse the whole table, not a reason to lose that field.
  for (let i = 0; i < value.length; i += 1) {
    const defect = jsonDefect(value[i]);
    if (defect !== undefined) {
      return PASSTHROUGH('out_of_domain', `row ${i} is not inside the JSON domain`, defect);
    }
  }
  // The record check and the uniformity check are separate steps, on purpose.
  // `tableFields` reports both as `not_a_table`, and mapping that one code onto
  // one reason would make `not_uniform` unreachable -- a telemetry counter that
  // can never fire is worse than no counter, because it looks like a category
  // that has never happened. "This is not a table" and "this is a table with
  // ragged rows" are different diagnoses with different fixes, and the second is
  // the one an adapter author needs to hear.
  for (let i = 0; i < value.length; i += 1) {
    const row: unknown = value[i];
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      const detail = `row ${i} is not a plain object`;
      return PASSTHROUGH('not_records', detail, toonError('not_a_table', detail));
    }
  }
  const fields = tryTableFields(value);
  if (!fields.ok) {
    return PASSTHROUGH('not_uniform', fields.error.message, fields.error);
  }
  return Object.freeze({ ...MACHINE, rows: value.length });
}

/**
 * Classify raw text. Exported on its own because the same question is asked
 * about strings that have not been through an adapter yet: a hook body, a
 * proposed directive's example, an eval fixture.
 */
export function classifyMachineText(text: string): MachineClassification {
  if (text.length === 0) return PASSTHROUGH('no_text', 'the block has no text');
  if (text.trim().length === 0) {
    return PASSTHROUGH('empty_text', 'the block is whitespace only');
  }
  if (STRATA_MARKER.test(text)) {
    return PASSTHROUGH('strata_marker', 'the block already carries a [strata: marker');
  }
  if (isFenceAt(text)) {
    return PASSTHROUGH('code_fence', 'the payload is inside a code fence, not bare');
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return PASSTHROUGH(
      'not_json',
      `the text is not one JSON value: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return classifyParsed(value as JsonValue);
}

/**
 * The structural vetoes, in order.
 *
 * Ordered cheapest-and-most-certain first. `type` and `origin` are literal
 * comparisons the type system already guarantees are one of a small set;
 * `tier` is a closed union, so `governance` cannot be misspelled into or out of
 * the check.
 */
function vetoFor(block: ContentBlock): MachineClassification | undefined {
  if (block.type === 'thinking') {
    return PASSTHROUGH('thinking_block', 'a thinking block is reasoning by definition');
  }
  if (block.meta.tier === 'governance') {
    // Unreachable through the type system -- a lossy stage is handed
    // `NonGovernanceMessage` -- and kept anyway because this function takes a
    // `ContentBlock` and therefore cannot enforce that for the caller. The
    // runtime check is the whole reason the guarantee survives a cast.
    return PASSTHROUGH('governance_tier', 'governance is never re-serialised');
  }
  if (block.meta.origin === 'assistant') {
    return PASSTHROUGH('assistant_origin', 'the model wrote this; its output is not a payload');
  }
  if (block.type === 'text') {
    return PASSTHROUGH('text_block', 'a text block is prose until an adapter says otherwise');
  }
  if (block.type !== 'tool_result' && block.type !== 'tool_use') {
    return PASSTHROUGH(
      'other_block_type',
      `a ${block.type} block carries no machine payload`,
    );
  }
  if (isHighSeverity(block)) {
    // Consistency with B-3 and H-6, which both leave a high-severity block alone,
    // and the reason is the same in all three: a producer-declared `is_error` is
    // a failure report, and a failure report is something to be *read*. Shrinking
    // it is lossless in the strict sense and still the wrong thing to do, because
    // the reader of an error is usually a person or a model in the middle of
    // working out what went wrong, and TOON is not the format you want that in.
    // "No operator in this stream rewrites a failure report" is a rule worth more
    // than the tokens.
    return PASSTHROUGH('high_severity', 'an error or fatal block is a failure report');
  }
  return undefined;
}

/**
 * The whole decision, for a block.
 *
 * `machine` is false unless *both* halves agree: the block is a plausible place
 * for a payload to live, and the bytes are a losslessly re-serialisable table.
 */
export function classifyMachineBlock(block: ContentBlock): MachineClassification {
  const veto = vetoFor(block);
  if (veto !== undefined) return veto;
  return classifyMachineText(block.text ?? '');
}

/** Predicate form, for the places where the boolean is the whole question. */
export const isMachineBlock = (block: ContentBlock): boolean =>
  classifyMachineBlock(block).machine;

/** Every reason other than `json_table`, for telemetry counters and for tests. */
export const PASSTHROUGH_REASONS: readonly MachineReason[] = Object.freeze([
  'no_text',
  'empty_text',
  'strata_marker',
  'code_fence',
  'not_json',
  'not_an_array',
  'empty_array',
  'not_records',
  'not_uniform',
  'out_of_domain',
  'thinking_block',
  'governance_tier',
  'assistant_origin',
  'high_severity',
  'text_block',
  'other_block_type',
]);

/**
 * The error a caller would have got from serializing a non-table. Exported so the
 * report can say *which* uniform-record rule was broken without every caller
 * re-deriving it from the reason.
 */
export const classificationDefect = (c: MachineClassification): ToonError | undefined =>
  c.defect ?? (c.machine ? undefined : toonError('not_a_table', c.detail));
