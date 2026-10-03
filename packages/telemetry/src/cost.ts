import type { CostTelemetry } from '@strata-ctx/core-types';
import { breakevenOk, costTelemetry } from '@strata-ctx/core-types';

import type { ModelPricing } from './pricing.js';
import { priceRatio } from './pricing.js';

/**
 * G-2: the token/cost engine. `r`, `eps`, `rho`, `k`.
 *
 * ## The definitions, taken from the doc
 *
 * `docs/architecture.md` §8 defines exactly these four, and every one of them
 * is stated here as the code implements it, because a cost claim whose
 * parameters are informally defined is not a cost claim.
 *
 * | | §8 | here |
 * |---|---|---|
 * | `r` | "input token reduction fraction" | `1 - actual.in / baseline.in` |
 * | `eps` | "output token expansion factor" | `actual.out / baseline.out` |
 * | `rho` | "provider price ratio output:input, ~4-5 for frontier models" | `out price / in price`, from the table |
 * | `k` | "fraction of total spend attributable to this intervention" | input spend / total spend, on the baseline |
 *
 * `baseline` is always the **control arm**: the same workload with no
 * transforms. Not the previous turn, not a model of what it would have cost,
 * not this arm's own counterfactual. E5 §2 makes the point -- a weak baseline
 * manufactures a fake win, and the control has to be the strongest
 * uncompressed configuration or every saving here is an artefact of having
 * built a straw man to compress.
 *
 * ## On `k`, and the one place the doc is ambiguous
 *
 * `k` is the share of the request's spend that sits on the input side, because
 * that is the only reading of "fraction of total spend attributable to this
 * intervention" under which the frozen breakeven rule has the right sign. §8
 * solves for `eps`, and the solution widens as `k` grows; a larger `k` must
 * therefore mean *more* headroom, which is true of the input share and false of
 * every other candidate (an overhead share, the obvious other reading, moves it
 * the wrong way and would reward spending more).
 *
 * ## The frozen bound and the arithmetic bound disagree, and §8 disagrees with itself
 *
 * §8: "`eps` must clear `1 + (1-r)/(rho*k)` or we are losing money while
 * reporting a win... a generous budget, but it is a budget". The bound is
 * implemented here as `breakevenOk` from the frozen contract, unchanged, because
 * G7 and E5 are written against it and the contract is hash-locked.
 *
 * It is not the same number as the arithmetic breakeven, and the gap is large
 * enough to change a verdict. Straight from the price definitions, a run is
 * break-even when the input saving covers the extra output:
 *
 * ```text
 *   r * in * pin  ==  (eps - 1) * out * pout
 *   eps            ==  1 + r * in / (out * rho)        (the "exact" budget)
 * ```
 *
 * With `k = in / (in + rho * out)` -- the input share of spend -- that rearranges
 * to `exact = 1 + r*k / (1 - k)`, with no `rho` in it at all. `rho` is already
 * inside `k`; the frozen rule divides by `rho` *again*, as though it had not
 * been.
 *
 * The two differ in a way that is not a rounding question:
 *
 * | `r` | `rho` | `k` | frozen `1+(1-r)/(rho*k)` | exact `1+r*k/(1-k)` |
 * |---|---|---|---|---|
 * | 0.5 | 4.5 | 0.9 | 1.123 | 5.500 |
 * | 0.5 | 4.5 | 0.5 | 1.222 | 1.500 |
 * | 0.5 | 4.5 | 0.1 | 2.111 | 1.056 |
 * | 0.5 | 4.5 | 0.05 | 3.222 | 1.026 |
 *
 * The last two rows are §8's own worked example ("a 50% input cut allows ~2x
 * output expansion"), and the frozen number reproduces the doc's ~2x exactly.
 * The `k = 0.1` row is where the doc's *prose* stops agreeing with the doc's
 * *formula*: §8 goes on to say "on output-heavy workloads the same cut permits
 * almost none", and output-heavy means small `k`, but under the frozen rule a
 * smaller `k` buys *more* headroom, not less. The exact budget behaves the way
 * the prose describes (1.056x) and the frozen rule does not.
 *
 * They coincide at exactly one `r` per `(rho, k)` pair -- `r = (1-k)/((1-k)+rho*k^2)`,
 * so `r = 0.952` for the doc's `rho = 4.5, k = 0.1` and `r = 0.286` for
 * `rho = 5, k = 0.5`. There is no `r` at which they agree in general, and in
 * particular not at `r = 0.5`.
 *
 * So the two candidate errata are independent, and both are proposed rather than
 * applied:
 *
 * 1. `(1-r)` should be `r`. The exact budget is `1 + r*k/(1-k)`.
 * 2. `k` should not divide the budget at all, because the `k` it is given here is
 *    the input share -- already a `rho`-derived quantity.
 *
 * Applying (1) alone still leaves the direction of the `k` term inverted versus
 * §8's prose. Both numbers are exported, the report carries both, and E5 is told
 * to quote the exact one. The contract is frozen at 1.0.0 and this package does
 * not edit it.
 *
 * ## Degenerate denominators are reported, not divided through
 *
 * A baseline of zero tokens has no ratio. The functions below return a finite
 * number and raise a flag, because the alternative -- `NaN` into a JSONL line
 * that later round-trips to `null` -- produces a report that looks like data.
 * Each fallback is the one that does *not* flatter: no input to reduce means
 * `r = 0`, and output produced where the control produced none means `eps >= 1`.
 */

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export const ZERO_USAGE: TokenUsage = Object.freeze({ inputTokens: 0, outputTokens: 0 });

export function usage(inputTokens: number, outputTokens: number): TokenUsage {
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens) || inputTokens < 0 || outputTokens < 0) {
    throw new CostError(`token counts must be finite and non-negative, got ${inputTokens}/${outputTokens}`);
  }
  return Object.freeze({ inputTokens, outputTokens });
}

export class CostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CostError';
  }
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * `r`: the fraction of input tokens the intervention removed.
 *
 * Clamped to `[0, 1]` because `CostTelemetry.r` is declared over that range
 * and a breakeven verdict computed from an out-of-range `r` is not the verdict
 * the gate means. The clamp is *reported* -- `inputExpanded` -- so a run that
 * grew its input cannot hide a `r = 0` behind a rounding, and E5's
 * "report the worst quartile" rule has something to sort on.
 */
export function inputReduction(baseline: TokenUsage, actual: TokenUsage): number {
  if (baseline.inputTokens <= 0) return 0;
  return clamp01(1 - actual.inputTokens / baseline.inputTokens);
}

/**
 * `eps`: output tokens per baseline output token. `1` means the intervention
 * changed nothing about how much the model says.
 *
 * A zero output baseline with a non-zero actual has no defined ratio. It floors
 * at 1 rather than 0: reporting 0 would claim the model got *less* verbose,
 * which is the one direction that is certainly false.
 */
export function outputExpansion(baseline: TokenUsage, actual: TokenUsage): number {
  if (baseline.outputTokens <= 0) return actual.outputTokens > 0 ? 1 : 0;
  return actual.outputTokens / baseline.outputTokens;
}

/** `k`: input spend over total spend, on the control arm. See the module doc. */
export function spendShare(baseline: TokenUsage, pricing: ModelPricing): number {
  const inputUsd = usd(baseline, pricing, 'input');
  const outputUsd = usd(baseline, pricing, 'output');
  const total = inputUsd + outputUsd;
  if (total <= 0) return 0;
  return inputUsd / total;
}

/** Cost of `n` tokens at a per-million rate. Exact integer arithmetic, no drift. */
function rate(tokens: number, usdPerMillion: number): number {
  return (tokens * usdPerMillion) / 1_000_000;
}

export function usd(u: TokenUsage, pricing: ModelPricing, side: 'input' | 'output' = 'input'): number {
  return side === 'input'
    ? rate(u.inputTokens, pricing.usdPerMillionInputTokens)
    : rate(u.outputTokens, pricing.usdPerMillionOutputTokens);
}

export interface CostAnalysis {
  readonly baseline: TokenUsage;
  readonly actual: TokenUsage;
  readonly r: number;
  readonly eps: number;
  readonly rho: number;
  readonly k: number;
  /** The frozen contract's verdict, `eps < 1 + (1-r)/(rho*k)`. */
  readonly breakevenOk: boolean;
  /** The frozen rule's output-expansion budget, `1 + (1-r)/(rho*k)`. */
  readonly epsBudget: number;
  /**
   * The same budget from the price definitions: `1 + r*in/(out*rho)`, which is
   * `1 + r*k/(1-k)` in terms of this module's `k`.
   *
   * The two coincide at exactly one `r` per `(rho, k)` pair and disagree
   * sharply elsewhere; see the module doc. Lower means less output expansion is
   * affordable, so the smaller of the two is the honest number to gate on.
   */
  readonly exactEpsBudget: number | null;
  readonly inputUsd: number;
  readonly outputUsd: number;
  readonly totalUsd: number;
  /** Degeneracies, so a caller can exclude the row rather than average it in. */
  readonly inputBaselineEmpty: boolean;
  readonly outputBaselineEmpty: boolean;
  readonly inputExpanded: boolean;
  readonly telemetry: CostTelemetry;
}

/**
 * The whole of G-2 in one call, from two token counts and a price row.
 *
 * `k` is deliberately *not* taken as a parameter. It is derived here, because
 * the only way it goes wrong is a caller passing a number that has drifted from
 * the bill it is supposed to describe, and the honest report of that drift is
 * nil -- a cost engine whose `k` cannot disagree with its own `baseline` is a
 * cost engine that cannot flatter itself. A caller with a more specific notion
 * of `k` than "the input share" should not be using this function; the
 * parameter exists in the contract for whoever owns the eval harness (F1-9).
 */
export function analyseCost(
  baseline: TokenUsage,
  actual: TokenUsage,
  pricing: ModelPricing,
): CostAnalysis {
  const r = inputReduction(baseline, actual);
  const eps = outputExpansion(baseline, actual);
  const rho = priceRatio(pricing);
  const k = spendShare(baseline, pricing);
  const epsBudget = k <= 0 ? Number.POSITIVE_INFINITY : 1 + (1 - r) / (rho * k);

  // The derivation needs out/in, and out/in is 0/0 whenever the control
  // produced no output -- there is no output:input ratio to be exact about.
  const outOverIn = baseline.inputTokens > 0 ? baseline.outputTokens / baseline.inputTokens : null;
  const exactEpsBudget =
    outOverIn !== null && outOverIn > 0 && rho > 0 ? 1 + r / (rho * outOverIn) : null;

  const telemetry = costTelemetry(r, eps, rho, k);
  return Object.freeze({
    baseline,
    actual,
    r,
    eps,
    rho,
    k,
    // The frozen guard, called directly as well as through `costTelemetry`, so
    // that a future core-types change to `costTelemetry` cannot quietly change
    // which function this module claims to be implementing.
    breakevenOk: breakevenOk(r, eps, rho, k) && telemetry.breakevenOk,
    epsBudget,
    exactEpsBudget,
    inputUsd: usd(baseline, pricing, 'input'),
    outputUsd: usd(baseline, pricing, 'output'),
    totalUsd: usd(baseline, pricing, 'input') + usd(baseline, pricing, 'output'),
    inputBaselineEmpty: baseline.inputTokens <= 0,
    outputBaselineEmpty: baseline.outputTokens <= 0,
    inputExpanded: baseline.inputTokens > 0 && actual.inputTokens > baseline.inputTokens,
    telemetry,
  });
}

export interface CostBreakevenView {
  readonly r: number;
  readonly eps: number;
  readonly rho: number;
  readonly k: number;
  readonly breakevenOk: boolean;
  readonly epsBudget: number;
  readonly exactEpsBudget: number | null;
  /**
   * Why the verdict came out the way it did, in one line. `epsilon` names the
   * real cause when both could apply, because "breakeven failed" without a
   * reason is a number nobody acts on.
   */
  readonly reason: 'within_budget' | 'output_expansion' | 'no_reduction' | 'k_zero' | 'degenerate';
}

export function breakevenView(analysis: CostAnalysis): CostBreakevenView {
  const { r, eps, rho, k, breakevenOk, epsBudget, exactEpsBudget } = analysis;

  const reason: CostBreakevenView['reason'] = (() => {
    if (analysis.inputBaselineEmpty && analysis.outputBaselineEmpty) return 'degenerate';
    if (k <= 0) return 'k_zero';
    if (r <= 0 && eps >= 1) return 'no_reduction';
    return eps >= epsBudget ? 'output_expansion' : 'within_budget';
  })();

  return Object.freeze({ r, eps, rho, k, breakevenOk, epsBudget, exactEpsBudget, reason });
}

/** The `cost` event, built from an analysis rather than from four loose numbers. */
export function costEvent(runId: string, analysis: CostAnalysis): CostTelemetry & {
  readonly type: 'cost';
  readonly runId: string;
} {
  return { type: 'cost', runId, ...analysis.telemetry };
}
