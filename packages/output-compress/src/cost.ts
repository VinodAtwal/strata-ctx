import type { CostTelemetry } from '@strata-ctx/core-types';
import { breakevenOk } from '@strata-ctx/core-types';

/**
 * H-5. Measure the saving, and the verdict.
 *
 * ## Why this is a separate stage and not a report
 *
 * The headline number everybody quotes is gross input reduction, and it is
 * close to meaningless on its own. Compressing a tool result makes the block
 * cheaper, but it also changes what the model *does* with the request: a
 * terser, more structured prompt invites a more verbose or more structured
 * answer, and output is priced at roughly four to five times input. So the
 * number that decides anything is `ε`, the output expansion factor, and the
 * decision is `ε < 1 + (1-r)/(ρk)` (docs/architecture.md §8, spec glossary).
 *
 * `breakevenOk` comes from core-types and is used as-is. Re-deriving it here
 * would be a second copy of the one formula in the project that has to match the
 * docs, and the drift would be invisible until a report contradicted itself.
 *
 * ## What "do not compress" costs
 *
 * Nothing. A verdict of `do_not_compress` is the correct answer whenever the
 * numbers do not clear, and it is a *first-class* answer rather than a fallback:
 * the architecture's own framing of the metric ("Gross input reduction is easy
 * and meaningless if the intervention makes the model verbose") means a
 * compressor that cannot say "no" is not measuring anything. The verdict is
 * therefore reported, counted, and tested as a possible outcome in its own
 * right, including all the way to negative net savings.
 */

/**
 * Bytes per token, matching `BYTES_PER_TOKEN` in core-types' ./tokens.ts.
 *
 * A heuristic and labelled one: we do not know the provider's tokenizer. It is
 * fine for a *comparison*, which is all this is, because the two numbers being
 * compared went through the same estimator. The per-block structural overhead
 * that `estimateBlockTokens` adds is excluded for the same reason -- it is a
 * constant added to both sides and cancels.
 */
const BYTES_PER_TOKEN = 4;

export const estimateTextTokens = (text: string): number => Math.ceil(text.length / BYTES_PER_TOKEN);

export interface TokenMeasure {
  readonly chars: number;
  readonly tokens: number;
}

export const measureText = (text: string): TokenMeasure =>
  Object.freeze({ chars: text.length, tokens: estimateTextTokens(text) });

export interface FormatSavings {
  readonly from: TokenMeasure;
  readonly to: TokenMeasure;
  /** `from.tokens - to.tokens`. Negative when the machine format is longer. */
  readonly tokensSaved: number;
  /** `tokensSaved / from.tokens`, or 0 when the baseline was empty. */
  readonly fractionSaved: number;
  /** False when the machine format costs more than the JSON it replaces. */
  readonly worthIt: boolean;
}

export function measureFormatSavings(fromText: string, toText: string): FormatSavings {
  const from = measureText(fromText);
  const to = measureText(toText);
  const tokensSaved = from.tokens - to.tokens;
  return Object.freeze({
    from,
    to,
    tokensSaved,
    fractionSaved: from.tokens === 0 ? 0 : tokensSaved / from.tokens,
    worthIt: tokensSaved > 0,
  });
}

/* -------------------------------------------------------------------------- */
/* ε and the breakeven verdict                                                 */
/* -------------------------------------------------------------------------- */

export interface EpsInput {
  readonly inputTokensBefore: number;
  readonly inputTokensAfter: number;
  /** Output tokens the model emitted against the uncompressed request. */
  readonly outputTokensBefore: number;
  /** Output tokens it emitted against the compressed request. */
  readonly outputTokensAfter: number;
  /** Output:input price ratio. ~4-5 for frontier models (decisions R3). */
  readonly rho: number;
  /** Fraction of total spend attributable to this intervention. */
  readonly k: number;
}

export type CostVerdict = 'compress' | 'do_not_compress';

export interface EpsReport extends CostTelemetry {
  /** False when the output ratio is not a finite number; the verdict is then "no". */
  readonly epsFinite: boolean;
  /**
   * Net saving in input-token equivalents:
   * `(I_before - I_after) - (O_after - O_before) * rho`.
   * Negative means the intervention cost money.
   */
  readonly netSavings: number;
  readonly verdict: CostVerdict;
  /** Decidable. Telemetry keys off this; a prose string would not be enough. */
  readonly reason:
    | 'within_budget'
    | 'breakeven_failed'
    | 'no_input_saving'
    | 'eps_not_finite'
    | 'input_grew';
  readonly detail: string;
}

const clampNonNegative = (n: number): number => (Number.isFinite(n) ? Math.max(0, n) : 0);

/**
 * `r` is deliberately *not* clamped to `[0,1]`. An intervention that made the
 * input larger is a real and interesting measurement, and a clamped `r` would
 * report it as a small win. `breakevenOk` handles `r > 1` correctly, because
 * `1 + (1-r)/(ρk)` gets tighter as `r` rises.
 */
const inputReduction = (before: number, after: number): number => {
  if (before <= 0) return after <= 0 ? 0 : -1;
  return 1 - after / before;
};

const outputExpansion = (before: number, after: number): { eps: number; finite: boolean } => {
  if (before > 0) {
    const eps = after / before;
    return { eps, finite: Number.isFinite(eps) };
  }
  // No baseline to divide by. Zero output on both sides is a genuine 1; any
  // output at all is an unbounded expansion, which is reported as such rather
  // than as a number that would serialise into a JSON sink as `null`.
  return after <= 0 ? { eps: 1, finite: true } : { eps: Number.POSITIVE_INFINITY, finite: false };
};

export function measureEps(input: EpsInput): EpsReport {
  const before = clampNonNegative(input.inputTokensBefore);
  const after = clampNonNegative(input.inputTokensAfter);
  const outBefore = clampNonNegative(input.outputTokensBefore);
  const outAfter = clampNonNegative(input.outputTokensAfter);
  // rho and k are configuration, not measurements, and a negative price ratio is
  // nonsense rather than an input to be respected. Clamped rather than rejected
  // so a bad config file degrades the verdict instead of taking down the request.
  const rho = Math.max(0, Number.isFinite(input.rho) ? input.rho : 0);
  const k = Math.max(0, Number.isFinite(input.k) ? input.k : 0);

  const r = inputReduction(before, after);
  const { eps, finite } = outputExpansion(outBefore, outAfter);
  const ok = breakevenOk(r, eps, rho, k);
  const netSavings = before - after - (outAfter - outBefore) * rho;

  let reason: EpsReport['reason'];
  let verdict: CostVerdict;
  if (!finite) {
    reason = 'eps_not_finite';
    verdict = 'do_not_compress';
  } else if (after > before) {
    reason = 'input_grew';
    verdict = 'do_not_compress';
  } else if (r <= 0) {
    // No input saving at all: any expansion is a straight loss, whatever the
    // formula says. `breakevenOk` would call `r=0, eps=1` a pass, which is
    // correct arithmetic and the wrong decision -- it means the intervention did
    // nothing, so there is nothing to protect.
    reason = 'no_input_saving';
    verdict = 'do_not_compress';
  } else if (!ok) {
    reason = 'breakeven_failed';
    verdict = 'do_not_compress';
  } else {
    reason = 'within_budget';
    verdict = 'compress';
  }

  return Object.freeze({
    r,
    eps,
    rho,
    k,
    breakevenOk: ok,
    epsFinite: finite,
    netSavings,
    verdict,
    reason,
    detail: `r=${r.toFixed(3)} eps=${finite ? eps.toFixed(3) : 'inf'} rho=${rho} k=${k} -> ${verdict}`,
  });
}

/**
 * The session-level input saving, for the `r` that feeds the verdict.
 *
 * A single block is not the whole request, and quoting `r` from one block
 * overstates what the intervention did. The caller supplies the totals; this
 * only exists so the two numbers are derived the same way everywhere.
 */
export function inputReductionFraction(before: number, after: number): number {
  return inputReduction(clampNonNegative(before), clampNonNegative(after));
}
