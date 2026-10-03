import type { SavingsEvent, SavingsGate } from './events.js';

import type { ModelPricing } from './pricing.js';
import type { TokenUsage } from './cost.js';
import { usd } from './cost.js';

/**
 * G-4: savings accounting, and the distinction this stream exists to police.
 *
 * ## Gross flatters. Net tells the truth.
 *
 * E5 §3: "Cost accounting includes us. Gist generation and canary probes are
 * *our* cost. A treatment arm that saves 40% on input but spends 15% on probes
 * has a 25% net win, not 40%." And E5 §7, which is the part vendors skip: "on
 * a short session, probes can exceed the savings."
 *
 * So the arithmetic in this module is deliberately dumb: gross is `baseline -
 * treatment`, overhead is the sum of what we spent computing the saving, and
 * net is the difference. There is no clamp, no floor at zero, no `Math.max(0,
 * ...)`, and no code path anywhere in this package that can make net positive
 * by construction. A product that cannot report a loss is a product whose cost
 * claim is unfalsifiable, and G7 -- the gate -- is on net.
 *
 * ## The three shapes net can take, all of them real
 *
 * 1. **Positive.** The intervention is worth it. Reported as a pass.
 * 2. **Negative.** We spent more than we saved. Reported as a fail, with the
 *    overhead broken out so it is clear *which* overhead did it. This is a
 *    legitimate finding, not an error: E5's anti-cherry-picking rule demands
 *    the worst quartile be reported, and a suite that cannot produce a negative
 *    net number has no way to honour that.
 * 3. **Unknown.** The model is not in the pricing table, or the baseline costs
 *    nothing to divide by. `unknown` is a distinct gate from `pass` and from
 *    `fail`, and it is never silently mapped to either. An unpriceable model is
 *    not a free model.
 *
 * ## What the gate is
 *
 * G7: "Net cost reduction > 0% after gist + probe cost". Strictly greater.
 * A net of exactly zero is not a win; it is the point where the intervention
 * has consumed its entire benefit in overhead, and reporting it as a pass would
 * make a product that does nothing look indistinguishable from one that helps.
 *
 * ## Token attribution
 *
 * E5's five categories, kept as five fields rather than a bag of tokens, so a
 * report can say *where* the overhead went. `input_saved` is signed: a run that
 * grew its input has a negative saving, and that number has to survive into the
 * report or the gross figure becomes unfalsifiable.
 */

export type SpendCategory = 'gist_out' | 'probe_in' | 'probe_out' | 'compaction_out';

/**
 * One line of overhead, priced independently.
 *
 * The per-line `pricing` is what keeps Tier 3 honest. Self-gist narration
 * happens inside the agent's own turn, so it is billed at the frontier rate and
 * belongs in the dollar total. Local-model narration runs on the operator's
 * hardware: it is genuinely not free, but it is not metered by the provider,
 * and pricing it at the frontier rate would inflate overhead, while dropping it
 * without saying so would be the flattering choice made quietly. It is
 * therefore priced, at whatever the caller can defend -- `fixture-local` is a
 * zero rate -- and the caller reports its cost in wall clock instead.
 */
export interface SpendLine {
  readonly category: SpendCategory;
  readonly usage: TokenUsage;
  /** Defaults to the request's own pricing. */
  readonly pricing?: ModelPricing;
}

export interface SavingsInput {
  readonly runId: string;
  readonly model: string;
  /** The control arm: same workload, no transforms, no overhead. */
  readonly baseline: TokenUsage;
  /**
   * The treatment arm's own billable tokens. Overhead is *not* included here;
   * a caller that folds it in gets a `treatment` that already pays for itself
   * and a net that can never be negative, which is the exact bug this module
   * exists to prevent.
   */
  readonly treatment: TokenUsage;
  /** Everything spent computing the saving. Empty means self-gist, Tier 2. */
  readonly overhead?: readonly SpendLine[];
  /** null when the model is not in the table. Unpriceable, not free. */
  readonly pricing: ModelPricing | null;
}

/** The per-category token ledger E5 asks for, plus the signed input saving. */
export type TokenLedger = Readonly<Record<SpendCategory | 'input_saved', number>>;

export const TOKEN_CATEGORIES: readonly (SpendCategory | 'input_saved')[] = Object.freeze([
  'input_saved',
  'gist_out',
  'probe_in',
  'probe_out',
  'compaction_out',
]);

function emptyLedger(): Record<SpendCategory | 'input_saved', number> {
  return { input_saved: 0, gist_out: 0, probe_in: 0, probe_out: 0, compaction_out: 0 };
}

export interface SavingsBreakdown {
  readonly runId: string;
  readonly model: string;
  readonly priceable: boolean;

  readonly baselineUsd: number;
  /** What the same workload costs with no transforms. */
  readonly treatmentUsd: number;
  /** baseline - treatment. Signed. */
  readonly grossSavedUsd: number;
  /** What computing the saving cost. Never negative. */
  readonly overheadUsd: number;
  /** gross - overhead. **Legitimately negative.** */
  readonly netSavedUsd: number;
  readonly grossFraction: number;
  /** null when the baseline cannot be divided by. Not the same as 0. */
  readonly netFraction: number | null;
  readonly tokensByCategory: TokenLedger;
  readonly gate: SavingsGate;
  /** Free text naming the cause of a fail, for the report and the CLI. */
  readonly verdict: string;
  /** Overhead split by category, so a fail says *which* probe was expensive. */
  readonly overheadByCategory: Readonly<Record<SpendCategory, number>>;
}

/**
 * The gate threshold, as a named constant.
 *
 * Exported so the CLI, the report and the tests all quote the same number, and
 * so nobody re-derives "> 0" as ">= 0" somewhere downstream and quietly
 * promotes a wash to a win.
 */
export const NET_SAVINGS_GATE = 0;

export function breakdownSavings(input: SavingsInput): SavingsBreakdown {
  const overhead = input.overhead ?? [];
  const overheadByCategory: Record<SpendCategory, number> = {
    gist_out: 0,
    probe_in: 0,
    probe_out: 0,
    compaction_out: 0,
  };
  const tokensByCategory = emptyLedger();

  // `input_saved` is a difference, not a count, and it is signed on purpose.
  tokensByCategory['input_saved'] = input.baseline.inputTokens - input.treatment.inputTokens;

  // Tokens are accumulated before the priceable branch, deliberately.
  //
  // An unpriceable run still spent tokens, and the count is known exactly --
  // it is the *dollars* that are missing. Returning early on price would have
  // zeroed the whole ledger, so a report would say "savings unknown" and also
  // "this run used no probe tokens", which is two claims and both are false.
  // The token ledger is the one part of this breakdown that does not depend on
  // the price table, so it is the one part a reader can still trust.
  for (const line of overhead) {
    if (line.category === 'gist_out') tokensByCategory['gist_out'] += line.usage.outputTokens;
    if (line.category === 'probe_in') tokensByCategory['probe_in'] += line.usage.inputTokens;
    if (line.category === 'probe_out') tokensByCategory['probe_out'] += line.usage.outputTokens;
    if (line.category === 'compaction_out') {
      tokensByCategory['compaction_out'] += line.usage.outputTokens;
    }
  }

  if (input.pricing === null) {
    // Unpriceable. Every dollar field is reported as 0 *with* `priceable:
    // false` and gate `unknown`, because a zero here that is not marked as
    // unknown is indistinguishable from a genuinely free run, and that is how
    // a gap in the pricing table becomes a win in someone's dashboard.
    const verdict = `model "${input.model}" is not in the pricing table; savings are unknown, not zero`;
    return Object.freeze({
      runId: input.runId,
      model: input.model,
      priceable: false,
      baselineUsd: 0,
      treatmentUsd: 0,
      grossSavedUsd: 0,
      overheadUsd: 0,
      netSavedUsd: 0,
      grossFraction: 0,
      netFraction: null,
      tokensByCategory: Object.freeze({ ...tokensByCategory }),
      gate: 'unknown',
      verdict,
      overheadByCategory: Object.freeze({ ...overheadByCategory }),
    });
  }

  const pricing = input.pricing;
  const baselineUsd = usd(input.baseline, pricing, 'input') + usd(input.baseline, pricing, 'output');
  const treatmentUsd = usd(input.treatment, pricing, 'input') + usd(input.treatment, pricing, 'output');

  let overheadUsd = 0;
  for (const line of overhead) {
    const linePricing = line.pricing ?? pricing;
    const cost =
      usd(line.usage, linePricing, 'input') + usd(line.usage, linePricing, 'output');
    overheadUsd += cost;
    overheadByCategory[line.category] += cost;
  }

  const grossSavedUsd = baselineUsd - treatmentUsd;
  const netSavedUsd = grossSavedUsd - overheadUsd;

  // The guard on the fraction, not on the money. A run that saved a positive
  // amount of money on a baseline that cost nothing has an undefined saving
  // *rate*; reporting `Infinity` (or a huge number) would put a spurious
  // headline on the report. The dollars stay exact.
  const divisible = baselineUsd > 0;
  const grossFraction = divisible ? grossSavedUsd / baselineUsd : 0;
  const netFraction = divisible ? netSavedUsd / baselineUsd : null;

  const gate: SavingsGate = !divisible ? 'unknown' : netSavedUsd > NET_SAVINGS_GATE ? 'pass' : 'fail';

  return Object.freeze({
    runId: input.runId,
    model: input.model,
    priceable: true,
    baselineUsd,
    treatmentUsd,
    grossSavedUsd,
    overheadUsd,
    netSavedUsd,
    grossFraction,
    netFraction,
    tokensByCategory: Object.freeze({ ...tokensByCategory }),
    gate,
    verdict: verdictFor({ baselineUsd, grossSavedUsd, overheadUsd, netSavedUsd, gate, netFraction }),
    overheadByCategory: Object.freeze({ ...overheadByCategory }),
  });
}

function verdictFor(v: {
  readonly baselineUsd: number;
  readonly grossSavedUsd: number;
  readonly overheadUsd: number;
  readonly netSavedUsd: number;
  readonly gate: SavingsGate;
  readonly netFraction: number | null;
}): string {
  switch (v.gate) {
    case 'pass':
      return `net saved $${v.netSavedUsd.toFixed(6)} (${pct(v.netFraction)} of baseline) after ` +
        `$${v.overheadUsd.toFixed(6)} of gist and probe cost`;
    case 'fail': {
      // Break-even is decided at the precision the verdict is printed at, not by
      // the raw float.
      //
      // "Exactly break-even" is 120k output tokens against a $1.80 saving, and
      // in binary floating point that is -2.2e-16, not 0. A strict `net < 0`
      // test would then print "net LOST $0.000000", which is a sentence that
      // contradicts itself and reads as a bug in the tool rather than as a
      // finding. The *gate* above stays a strict `> 0` with no epsilon -- that
      // is the number that decides pass/fail, and a tolerance there would let a
      // run that saved nothing through as a win. Only the prose rounds.
      if (Math.abs(v.netSavedUsd) < HALF_DISPLAY_UNIT) {
        return `net saved exactly $0.000000; the entire gross saving was consumed by gist and probe cost`;
      }
      return `net LOST $${(-v.netSavedUsd).toFixed(6)}: overhead ($${v.overheadUsd.toFixed(6)}) exceeded the ` +
        `gross saving ($${v.grossSavedUsd.toFixed(6)}); this run does not pay for itself`;
    }
    case 'unknown':
      return `baseline cost is $0.000000, so net savings are undefined; this is not a pass`;
  }
}

/** Half of the last digit `verdictFor` prints, i.e. the break-even band. */
const HALF_DISPLAY_UNIT = 0.5e-6;

const pct = (fraction: number | null): string =>
  fraction === null ? 'n/a' : `${(fraction * 100).toFixed(2)}%`;

/** The `savings` event. G4's whole output surface. */
export function savingsEvent(input: SavingsInput): SavingsEvent {
  const b = breakdownSavings(input);
  return {
    type: 'savings',
    runId: b.runId,
    model: b.model,
    baselineUsd: b.baselineUsd,
    grossSavedUsd: b.grossSavedUsd,
    overheadUsd: b.overheadUsd,
    netSavedUsd: b.netSavedUsd,
    grossFraction: b.grossFraction,
    netFraction: b.netFraction,
    tokensByCategory: { ...b.tokensByCategory },
    gate: b.gate,
  };
}

/**
 * The crossover E5 asks for: the session size at which net turns positive.
 *
 * E5 §7: "On a short session, probes can exceed the savings... A product that
 * only wins on long sessions should say so." Probes are the near-fixed cost
 * (they run on a cadence, not per token), so net against a *saving rate per
 * token* has a single crossing point and it is worth naming in a report rather
 * than leaving the reader to infer it from two aggregate numbers.
 *
 * Returns null when there is no crossing to find -- no saving rate, or the
 * fixed overhead is already covered. A null here is not an error: it means
 * "this configuration wins from the first session", which is a different and
 * better answer than an infinity.
 */
export function crossoverSessionLength(v: {
  /** Net saving already banked at session length zero, before any length scaling. */
  readonly savedUsdPerSession?: number;
  /** Marginal saving per additional token of session. */
  readonly savingRateUsdPerToken?: number;
  readonly fixedOverheadUsd: number;
}): number | null {
  const rate = v.savingRateUsdPerToken ?? 0;
  if (rate <= 0) return null;
  const saved = v.savedUsdPerSession ?? 0;
  if (saved >= v.fixedOverheadUsd) return null;
  return (v.fixedOverheadUsd - saved) / rate;
}
