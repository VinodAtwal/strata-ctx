import { ToonError } from './errors.js';
import type { JsonValue } from './json-value.js';
import { assertJsonValue, jsonDefect, jsonEqual } from './json-value.js';
import { tryTableFields } from './grammar.js';
import type { FormatSavings } from './cost.js';
import { measureFormatSavings } from './cost.js';
import type { MachineFormat, ModelRegistry } from './registry.js';
import { DEFAULT_REGISTRY, supportedFormats, supportsFormat } from './registry.js';
import { TOON_FRAMING, parseToon, serializeToon } from './toon.js';
import { TRON_FRAMING, parseTron, serializeTron } from './tron.js';

/**
 * H-2. Choosing a format.
 *
 * ## What "select" has to decide
 *
 * Three questions, in this order, and the order is the safety argument:
 *
 * 1. **May this model read this format at all?** (H-8's registry.) An answer of
 *    no ends the process with JSON. This is asked first because every other
 *    consideration is irrelevant if the model cannot read the result.
 * 2. **Can this value be written losslessly as a table?** If not, JSON.
 * 3. **Is the machine format actually shorter?** If it is not -- or if it saves
 *    less than the floor -- JSON.
 *
 * ## The round-trip check, and why it is here rather than in the tests
 *
 * Having proven the format lossless once, in a test suite, is a statement about
 * the *current* serializer and the *current* parser. This re-proves it per
 * document, cheaply, at the one place where the answer becomes visible to a
 * model: emit, parse back, compare key sequences and values. A serializer bug
 * therefore costs a fallback to JSON on the affected input rather than a
 * corrupted tool result, and a registry entry that is wrong about a model costs
 * nothing but the tokens the format would have saved.
 *
 * This is the difference between "should be lossless" and "is lossless", and it
 * is cheap enough to leave in production: one extra parse of a block we just
 * wrote, against N2's 50ms budget for 200k tokens.
 */

/**
 * Fractional saving over JSON required before a machine format is used.
 *
 * Flagged, not sourced: the architecture quotes 20-27% for TOON on tool-heavy
 * agent traffic (spec F9) and nothing at all about the small-table tail. 2% is
 * a floor, not a target -- it exists so a one-row, many-column table cannot
 * reformat itself into something longer than the JSON it replaced, which is the
 * case where "TOON-ify it" is pure cost. Tune it against E3.
 */
export const DEFAULT_MIN_SAVINGS_FRAC = 0.02;

export type SelectionCode =
  | 'selected'
  | 'model_unsupported'
  | 'not_a_table'
  | 'out_of_domain'
  | 'no_savings'
  | 'below_savings_floor'
  | 'serialize_failed'
  | 'round_trip_failed'
  /**
   * Viable, but a smaller sibling won.
   *
   * Its own code rather than reusing `selected`, because an attempt log that
   * records two `selected` entries answers the question "which format did we
   * serve" with both, and a log that lies about that is worse than no log.
   */
  | 'superseded';

export interface Candidate {
  readonly format: MachineFormat;
  readonly text: string;
  readonly chars: number;
}

export interface AttemptRecord {
  readonly format: MachineFormat;
  readonly code: SelectionCode;
  readonly detail: string;
}

export interface Selection {
  readonly format: MachineFormat;
  readonly text: string;
  readonly code: SelectionCode;
  readonly reason: string;
  /** Against the JSON text. `undefined` when the answer was JSON. */
  readonly savings: FormatSavings | undefined;
  /** Every format that was measured or refused, in the order they were tried. */
  readonly attempts: readonly AttemptRecord[];
}

export interface SelectionInput {
  /** The payload. Validated, not trusted. */
  readonly value: unknown;
  readonly model: string;
  readonly registry?: ModelRegistry;
  /**
   * A policy choice, not a hint: `SerializationPolicy.machineFormat` in
   * core-types is something a user set, and serving TRON because it was smaller
   * would be quietly serving something they did not ask for. Pinning is honoured
   * whenever the format is supported, and an unsupported pin falls back to JSON
   * rather than to a substitute -- if TOON was not available, plain JSON is a
   * better answer than a different format, because JSON is always available.
   *
   * Omit it (or pass `'json'`) to let the registry choose, using its own
   * best-first order. That is the only mode in which two machine formats are
   * compared against each other.
   */
  readonly preferred?: MachineFormat;
  readonly name?: string;
  readonly allowUnverified?: boolean;
  readonly minSavingsFrac?: number;
  /**
   * The bytes to fall back to. Callers should pass the block's *original* text
   * rather than letting this compute `JSON.stringify`: on any refusal the block
   * must come back exactly as it arrived, and a re-stringified copy is a
   * different copy (key order preserved, but whitespace, escaping and number
   * formatting all rewritten).
   */
  readonly jsonText?: string;
}

const SERIALIZERS: Readonly<
  Record<'toon' | 'tron', (value: JsonValue, options: { name?: string }) => string>
> = Object.freeze({
  toon: (value, options) => serializeToon(value, options),
  tron: (value, options) => serializeTron(value, options),
});

const PARSERS: Readonly<Record<'toon' | 'tron', (text: string) => readonly { [k: string]: JsonValue }[]>> =
  Object.freeze({ toon: parseToon, tron: parseTron });

/**
 * Which machine formats to try, in order.
 *
 * A pin yields exactly one candidate; the registry order yields every supported
 * one, best first. JSON is handled separately and is never in this list, because
 * it is the fallback rather than a candidate.
 */
function orderFor(
  preferred: MachineFormat | undefined,
  model: string,
  registry: ModelRegistry,
  allowUnverified: boolean,
): readonly ('toon' | 'tron')[] {
  if (preferred === 'toon' || preferred === 'tron') return [preferred];
  return supportedFormats(model, registry, { allowUnverified }).filter(
    (format): format is 'toon' | 'tron' => format === 'toon' || format === 'tron',
  );
}

const jsonOf = (value: unknown, provided: string | undefined): string => {
  if (provided !== undefined) return provided;
  // Only reached when a caller omitted the original text, which no production
  // caller does. `jsonDefect` has already admitted the value, so this cannot
  // throw and cannot invent a shape the domain does not have.
  return JSON.stringify(value) ?? 'null';
};

export function selectMachineFormat(input: SelectionInput): Selection {
  const registry = input.registry ?? DEFAULT_REGISTRY;
  const allowUnverified = input.allowUnverified ?? false;
  const floor = input.minSavingsFrac ?? DEFAULT_MIN_SAVINGS_FRAC;
  const jsonText = jsonOf(input.value, input.jsonText);
  const attempts: AttemptRecord[] = [];

  // Built on the way out rather than up front: the JSON answer is the shape
  // every refusal returns, and the attempt log is not known until the candidates
  // have been tried.
  const asJson = (code: SelectionCode, reason: string, savings?: FormatSavings): Selection => {
    const selection: Selection = {
      format: 'json',
      text: jsonText,
      code,
      reason,
      savings,
      attempts: Object.freeze([...attempts]),
    };
    return Object.freeze(selection);
  };

  const defect = jsonDefect(input.value);
  if (defect !== undefined) {
    attempts.push({ format: 'json', code: 'out_of_domain', detail: defect.message });
    return asJson('out_of_domain', defect.message);
  }
  // The one narrowing this function needs. `jsonDefect` returning undefined is
  // exactly the claim that the value is inside the JSON domain, and a value
  // outside it must never be re-serialised by a format that assumes it is. The
  // assertion is a second call rather than a cast because it costs a walk we
  // have already paid for and because a cast here would be a place a future edit
  // could widen without the compiler noticing.
  assertJsonValue(input.value, 'the machine block');
  const value: JsonValue = input.value;

  // Table-ness is a property of the *value*, not of a format, so it is settled
  // once here rather than being rediscovered as a `serialize_failed` by whichever
  // serializer happened to be tried first. Settling it up front is what makes
  // `not_a_table` a reachable code: without this, every non-table value would be
  // reported as a broken serializer, which is both a lie and a much worse thing
  // to read in a report at 3am.
  const table = tryTableFields(value);
  if (!table.ok) {
    attempts.push({ format: 'json', code: 'not_a_table', detail: table.error.message });
    return asJson('not_a_table', table.error.message);
  }

  const options = input.name === undefined ? {} : { name: input.name };
  let best: { format: 'toon' | 'tron'; text: string; savings: FormatSavings } | undefined;

  for (const format of orderFor(input.preferred, input.model, registry, allowUnverified)) {
    if (!supportsFormat(input.model, format, registry, { allowUnverified })) {
      attempts.push({
        format,
        code: 'model_unsupported',
        detail: `${input.model || '(unknown model)'} is not registered for ${format}`,
      });
      continue;
    }

    let text: string;
    try {
      text = SERIALIZERS[format](value, options);
    } catch (error) {
      attempts.push({
        format,
        code: 'serialize_failed',
        detail: error instanceof ToonError ? error.message : String(error),
      });
      continue;
    }

    const savings = measureFormatSavings(jsonText, text);
    if (!savings.worthIt) {
      attempts.push({
        format,
        code: 'no_savings',
        detail: `${savings.tokensSaved} tokens against JSON`,
      });
      continue;
    }

    // Re-read what we just wrote and compare it to what we meant to write. A
    // mismatch is a serializer bug, and the answer is JSON, not a repair.
    //
    // The parse is inside the guard, and that is the whole point of the check
    // existing: a reader that *throws* is a reader that would otherwise take the
    // whole stage down with it, at exactly the moment we were relying on it to
    // prove the output was safe. Failing to read back must cost the candidate,
    // never the request.
    let restored: readonly { readonly [k: string]: JsonValue }[];
    try {
      restored = PARSERS[format](text);
    } catch (error) {
      attempts.push({
        format,
        code: 'round_trip_failed',
        detail: `the text could not be read back: ${
          error instanceof ToonError ? error.message : String(error)
        }`,
      });
      continue;
    }
    if (!jsonEqual(restored, value)) {
      attempts.push({
        format,
        code: 'round_trip_failed',
        detail: 'the text read back, but not as the value that was written',
      });
      continue;
    }

    if (best === undefined || text.length < best.text.length) {
      if (best !== undefined) {
        attempts.push({
          format: best.format,
          code: 'superseded',
          detail: `a shorter candidate saved ${best.text.length - text.length} more characters`,
        });
      }
      best = { format, text, savings };
    } else {
      attempts.push({
        format,
        code: 'superseded',
        detail: `kept the shorter candidate, which saved ${text.length - best.text.length} characters`,
      });
    }
  }

  // The winner is recorded too. An attempt log that lists only the formats that
  // lost answers "what did we try" but not "what did we serve", and a reader
  // checking the second question has to go and look at the verdict.
  if (best !== undefined) {
    attempts.push({
      format: best.format,
      code: 'selected',
      detail: `chosen, saving ${best.savings.tokensSaved} tokens against JSON`,
    });
  }

  if (best === undefined) {
    const first = attempts[0];
    return asJson(
      first?.code ?? 'model_unsupported',
      first === undefined ? 'no machine format is registered for this model' : first.detail,
    );
  }

  if (best.savings.fractionSaved < floor) {
    return asJson(
      'below_savings_floor',
      `${(best.savings.fractionSaved * 100).toFixed(1)}% is below the ${(floor * 100).toFixed(1)}% floor`,
      best.savings,
    );
  }

  return Object.freeze({
    format: best.format,
    text: best.text,
    code: 'selected',
    reason: `${best.format} saves ${best.savings.tokensSaved} tokens (${(best.savings.fractionSaved * 100).toFixed(1)}%) against JSON`,
    savings: best.savings,
    attempts: Object.freeze(attempts),
  });
}

/** The savings a selection achieved, or zero for a passthrough. Zero, not `undefined`. */
export const selectionSaving = (s: Selection): FormatSavings | undefined => s.savings;

export { TOON_FRAMING, TRON_FRAMING };
