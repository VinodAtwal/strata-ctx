import { EVAL_FIXTURE_FORMAT_VERSION, parseFixture, validateFixture } from '../fixture.js';
import { runSuite, type RunOptions } from '../runner.js';
import { unitValue } from '../mock-arm.js';
import {
  DEFAULT_ALPHA,
  DEFAULT_BOOTSTRAP_RESAMPLES,
  DEFAULT_BOOTSTRAP_SEED,
  percentile,
} from '../statistics.js';
import {
  type Arm,
  type ArmObservation,
  type EvalFixture,
  type RunReport,
  type SuiteId,
  type SyncArmRunner,
} from '../types.js';

/**
 * F1-9 — E5, cost and breakeven. Gross and net, and the gap between them.
 *
 * docs/evaluation.md §E5 is the only suite whose subject is money, and it is the
 * one place in this repo where a number is allowed to be *negative*. Everything
 * else in eval reports a rate that clears a floor; this suite reports a dollar
 * saving, and a dollar saving can be a loss. So the design here is shaped by a
 * single rule:
 *
 * > Gross flatters. Net tells the truth.
 * > (packages/telemetry/src/savings.ts, module header)
 *
 * ## Why E5 cannot be a rate
 *
 * "Input tokens fell 30%" is not a cost claim. It is a claim about one side of
 * a bill whose other side costs 4-5× more per token, plus a set of requests the
 * intervention itself made. §E5 §3: *"Gist generation and canary probes are our
 * cost. A treatment arm that saves 40% on input but spends 15% on probes has a
 * 25% net win, not 40%."* And §E5 §7, the part vendors skip: *"on a short
 * session, probes can exceed the savings."*
 *
 * So the headline is **gross** — the number a dashboard would show — and the
 * gate **G7** is on **net**, strictly `> $0`. Both are always in the report, both
 * are named `gross*`/`net*` in every field, and the two are never allowed to
 * collapse into one number called "savings". A product that cannot report a loss
 * has an unfalsifiable cost claim, which is the exact failure this file exists
 * to make impossible.
 *
 * ## The two ways a number here is manufactured, and the tripwires for each
 *
 * 1. **Attribution.** An arm that under-reports `billed` hides overhead. The
 *    suite therefore requires closure — `billed == treatment + overhead`, per
 *    side — and reports the residual rather than the difference. A non-zero
 *    residual is `unattributedTokens`, it makes the audit incomplete, and it
 *    makes **G7 `inconclusive`**. Never `0`, never silently absorbed into gross:
 *    an arm that reports fewer tokens than it spent gets a flattering net
 *    exactly when it is cheating, and "we did not check" reads as "there was
 *    nothing to find".
 * 2. **The baseline.** A weak control manufactures a fake win (§E5 §2). The
 *    control's usage is therefore **suite-owned**: the corpus declares the
 *    uncompressed workload and the control arm's bill is computed from it. An
 *    arm that reports a different control bill is an **error**, not a
 *    disagreement, because there is no honest reading in which the
 *    uncompressed cost of a fixed workload is up for negotiation.
 *
 * ## The two breakeven rules, which do not agree
 *
 * The frozen contract (`packages/core-types/src/telemetry.ts`, hash-locked at
 * 1.0.0) says `eps < 1 + (1-r)/(rho*k)`. `packages/telemetry/src/cost.ts`
 * documents at length that this is not the arithmetic break-even, and derives
 * the one that is: `1 + r*k/(1-k)`. The two coincide at exactly one `r` per
 * `(rho, k)` pair and can disagree on a verdict.
 *
 * E5 does not pick a winner. It reports **three** budgets side by side —
 * frozen, exact, and net — plus `grossNetDisagreement`, so a reader can see
 * which rule produced which verdict. The frozen one is included because G7 and
 * §8 are written against it and the contract is frozen; the exact one because
 * arithmetic is arithmetic; and net because it is the only one that includes
 * what computing the saving cost, which is the point of the suite. Silently
 * preferring the flattering rule is the failure mode, so all three ship.
 *
 * ## Injected, never imported
 *
 * AGENTS.md §12.1: `eval` depends on nothing, not even `telemetry`. So the
 * pricing table here **mirrors** `packages/telemetry/src/pricing.ts` rather than
 * importing it, and there are two separate injected things because they answer
 * two separate questions:
 *
 * - `E5CostModel` — how the *product* meters a request. This is the subject
 *   under test's own billing path, and it is injected so a real deployment can
 *   be measured with its real numbers.
 * - `E5Clock` — the current date, needed for the 90-day pricing staleness rule
 *   and for nothing else. `Date.now()` is never called, so a report is a pure
 *   function of its inputs (G11, determinism).
 *
 * The pricing *table* is a third, declared input, and it exists so the suite can
 * do two things the cost model cannot be trusted to do for itself: apply the
 * staleness rule, and re-price every line **independently** as an audit. An arm
 * that computes its own bill and also grades it has marked its own homework;
 * the audit re-derives every dollar from the table and reports disagreements.
 *
 * ## Why the arms are only `control` and `treatment`
 *
 * `control+` is E1's negative control — a deliberately degraded configuration
 * used to prove the harness can *detect* failure. Running it here would
 * produce cost numbers for a configuration that is not meant to be shipped, and
 * G7 aggregates: a deliberately wasteful arm in the average is a way to make
 * net look good. E5's negative controls are its own, and they are cost
 * accounting failures, not constraint losses. See `E5NegativeControl`.
 */

export const E5_SUITE_ID: SuiteId = 'E5';
export const E5_SUITE_NAME = 'e5-cost-breakeven';
export const E5_DESCRIPTION =
  'Does token compression pay for itself? Gross and net cost, output-expansion ' +
  'breakeven against the frozen contract and against arithmetic, latency overhead, ' +
  'cache behaviour, and the session size at which the intervention stops paying.';

/** docs/evaluation.md §E5. Deliberately excludes `control+`; see the module header. */
export const E5_ARMS: readonly Arm[] = Object.freeze<Arm[]>(['control', 'treatment']);

/** The suite's arms, typed so a `control+` cannot be passed by accident. */
export type E5Arm = (typeof E5_ARMS)[number];

// ---------------------------------------------------------------- the gates

export type E5GateId = 'G6' | 'G7' | 'G8' | 'G12';

/**
 * G7. Net cost reduction after gist + probe cost.
 *
 * Strictly greater than zero. A net of exactly 0 is not a wash to be rounded in
 * our favour: it is the point where the intervention has consumed its entire
 * benefit in overhead, and calling that a win makes a product that does nothing
 * indistinguishable from one that helps. `packages/telemetry/src/savings.ts`
 * exports the same threshold as `NET_SAVINGS_GATE` for the same reason.
 */
export const G7_NET_SAVINGS_FLOOR_USD = 0;

/**
 * G8. p95 of the *paired* latency overhead, in milliseconds.
 *
 * A ceiling, so `pass` means strictly below. The pairing matters: the two arms
 * run the same session back to back, so the difference cancels the machine's
 * mood. Comparing two independent p95s would charge the treatment arm for every
 * case that happened to run while the laptop was busy.
 */
export const G8_P95_LATENCY_OVERHEAD_CEILING_MS = 50;

/**
 * G12. Fraction of transforms that invalidate a reusable prompt prefix.
 *
 * A ceiling, so `pass` means strictly below. docs/decisions.md R4: an
 * intervention that rewrites the head of the prompt defeats the provider's
 * prefix cache, and the saving it books is paid back on every subsequent turn
 * at full input price. This is a *revenue* metric, not a cost metric, and it is
 * the reason E5 measures cache behaviour at all.
 */
export const G12_PREFIX_INVALIDATION_CEILING = 0.05;

/**
 * Pricing staleness. A quarter is roughly the cadence at which a frontier price
 * list is re-checked, and a stale table is not detectably wrong — it is just
 * wrong, so the only defence is refusing to quote it.
 * Mirrors `PRICING_STALE_AFTER_DAYS` in `packages/telemetry/src/pricing.ts`.
 */
export const E5_PRICING_STALE_AFTER_DAYS = 90;

/**
 * The shipped activation threshold, mirrored from
 * `docs/integrations.md` (`token_compression.min_tokens: 5000`).
 *
 * E5's job is to say whether the product turns on at the right session size.
 * The crossover — the input size at which net saving crosses zero — is
 * reported next to this number, and `crossoverBelowShippedThreshold` is the
 * finding: an intervention that only pays above 8k tokens, switched on at 5k,
 * loses money on every session between those two numbers.
 */
export const E5_SHIPPED_MIN_TOKENS = 5000;

/** Mirrors `SpendCategory` in `packages/telemetry/src/savings.ts`. */
export const E5_SPEND_CATEGORIES = [
  'gist_out',
  'probe_in',
  'probe_out',
  'compaction_out',
] as const;
export type E5SpendCategory = (typeof E5_SPEND_CATEGORIES)[number];

/**
 * The five ledger categories of docs/evaluation.md §E5, credit first.
 *
 * `input_saved` is a signed *difference*, not a count: a session whose input
 * grew contributes a negative saving, and that number has to survive into the
 * report or the gross figure becomes unfalsifiable. The four charge categories
 * are always present, even at zero, so a report can say *where* the overhead
 * went instead of only that there was some.
 */
export const E5_LEDGER_CATEGORIES = ['input_saved', ...E5_SPEND_CATEGORIES] as const;
export type E5LedgerCategory = (typeof E5_LEDGER_CATEGORIES)[number];

/**
 * Tolerance for the price audit, in USD per line.
 *
 * Half a micro-dollar. Rates are quoted per million tokens and lines are
 * thousands of tokens, so real arithmetic lands far inside this; the tolerance
 * exists to absorb floating-point representation error and nothing else. A
 * rounding slack wide enough to hide a real discrepancy would let the audit
 * pass a bill that is wrong by a visible amount, which is the failure the audit
 * is for.
 */
export const E5_PRICE_AUDIT_TOLERANCE_USD = 5e-7;

/** Thrown for anything E5 refuses to paper over. */
export class E5Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'E5Error';
  }
}

// ---------------------------------------------------------- injected inputs

/**
 * The current time, injected. `Date.now()` is never called in this package, so
 * the same fixture + strategy + pricing table produce a byte-identical report on
 * any machine (G11).
 */
export interface E5Clock {
  /** Epoch milliseconds. Only ever read to compute pricing age. */
  readonly nowMs: () => number;
}

/** A fixed clock, for a report that names the day it was taken. */
export const fixedE5Clock = (nowMs: number): E5Clock => Object.freeze({ nowMs: () => nowMs });

export type E5PriceDirection = 'input' | 'output';

/**
 * How the product meters a request. The subject under test's own billing path,
 * injected rather than imported so a real deployment can be measured with real
 * numbers and a test can be measured with pinned ones.
 *
 * Returning `null` means **unpriceable**, which is a third outcome and not a
 * synonym for zero: a model missing from the price table did not cost nothing,
 * it cost an unknown amount, and mapping that to 0 is how a gap in a pricing
 * table becomes a win in someone's dashboard.
 */
export interface E5CostModel {
  /** USD per million tokens, or `null` when the model is unpriceable. */
  readonly usdPerMtok: (model: string, direction: E5PriceDirection) => number | null;
  /** How this billing path is named in a report. Required: it is the finding. */
  readonly costModelId: string;
}

/**
 * A pricing row. `verifiedOn` and `source` are required, not optional metadata:
 * a rate with no date cannot be checked for staleness and a rate with no source
 * is folklore, which AGENTS.md §8.5 forbids.
 */
export interface E5Pricing {
  readonly model: string;
  readonly inputUsdPerMtok: number;
  readonly outputUsdPerMtok: number;
  /** `YYYY-MM-DD`, UTC. */
  readonly verifiedOn: string;
  /** Where the rate came from. A URL, a quote id, or `TODO(owner)`. */
  readonly source: string;
}

/** A whole table. `version` is in the staleness message so a fix is nameable. */
export interface E5PricingTable {
  readonly version: string;
  /** `YYYY-MM-DD`, UTC. Age is measured from here. */
  readonly verifiedOn: string;
  readonly rows: readonly E5Pricing[];
}

export type E5PricingFreshnessReason = 'fresh' | 'stale' | 'verified_in_the_future' | 'malformed';

export interface E5PricingFreshness {
  readonly verifiedOn: string;
  /** Whole UTC days between `verifiedOn` and the injected clock. */
  readonly ageDays: number;
  /** Strictly greater than the threshold, so exactly 90 days is fresh. */
  readonly stale: boolean;
  readonly reason: E5PricingFreshnessReason;
  readonly message: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` to epoch ms at UTC midnight. NaN for anything else. */
export const e5EpochMs = (date: string): number => {
  if (!ISO_DATE.test(date)) return Number.NaN;
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isNaN(ms) ? Number.NaN : ms;
};

/** Whole UTC days from `from` to `to`, truncated toward zero. */
export const e5DaysBetween = (from: string, to: string): number => {
  const a = e5EpochMs(from);
  const b = e5EpochMs(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  return Math.trunc((b - a) / 86_400_000);
};

/** The clock's date as `YYYY-MM-DD`, UTC. */
export const e5Today = (clock: E5Clock): string => {
  const ms = clock.nowMs();
  if (!Number.isFinite(ms)) {
    throw new E5Error(`e5: the injected clock returned ${String(ms)}, which is not a finite epoch`);
  }
  return new Date(ms).toISOString().slice(0, 10);
};

/**
 * The staleness rule, applied to a table.
 *
 * Two ways to be unfalsifiable are refused rather than clamped. A `verifiedOn`
 * in the future is reported as `verified_in_the_future`, because a future date
 * makes a table permanently and silently exempt from the staleness rule. A
 * malformed date is `malformed` rather than "epoch zero", which would read as
 * ancient and therefore correctly stale for the wrong reason — and would be
 * unfixable without noticing.
 */
export function e5PricingFreshness(
  table: E5PricingTable,
  today: string,
  thresholdDays: number = E5_PRICING_STALE_AFTER_DAYS,
): E5PricingFreshness {
  const ageDays = e5DaysBetween(table.verifiedOn, today);
  if (Number.isNaN(ageDays)) {
    return Object.freeze({
      verifiedOn: table.verifiedOn,
      ageDays: Number.NaN,
      stale: true,
      reason: 'malformed' as const,
      message:
        `pricing table v${table.version} has verifiedOn="${table.verifiedOn}", which is not a ` +
        'YYYY-MM-DD date; its age is unknown, and an unknown age is not fresh',
    });
  }
  if (ageDays < 0) {
    return Object.freeze({
      verifiedOn: table.verifiedOn,
      ageDays,
      stale: true,
      reason: 'verified_in_the_future' as const,
      message:
        `pricing table v${table.version} claims verifiedOn=${table.verifiedOn}, which is ` +
        `${-ageDays} day(s) in the future (today is ${today}); a future date is permanently exempt ` +
        'from the staleness rule, which is the failure the rule exists to prevent',
    });
  }
  const stale = ageDays > thresholdDays;
  return Object.freeze({
    verifiedOn: table.verifiedOn,
    ageDays,
    stale,
    reason: stale ? ('stale' as const) : ('fresh' as const),
    message: stale
      ? `pricing table v${table.version} was verified ${ageDays} days ago (${table.verifiedOn}), past ` +
        `the ${thresholdDays}-day threshold; a stale price table silently turns a cost win into a ` +
        'cost loss, so no dollar or breakeven verdict is issued against it'
      : `pricing table v${table.version} is fresh: verified ${ageDays} day(s) ago ` +
        `(${table.verifiedOn}), within the ${thresholdDays}-day threshold`,
  });
}

/** A cost model that reads straight off a table. Explicit, never a silent default. */
export const fixedRateCostModel = (table: E5PricingTable, costModelId = `fixed-rate:${table.version}`): E5CostModel => {
  const byModel = new Map(table.rows.map((row) => [row.model, row]));
  return Object.freeze({
    costModelId,
    usdPerMtok: (model: string, direction: E5PriceDirection): number | null => {
      const row = byModel.get(model);
      if (row === undefined) return null;
      return direction === 'input' ? row.inputUsdPerMtok : row.outputUsdPerMtok;
    },
  });
}

/** USD for a usage line. `null` propagates: unpriceable is not zero. */
export const e5Usd = (
  usage: E5Usage,
  model: string,
  direction: E5PriceDirection,
  usdPerMtok: number,
): number => (direction === 'input' ? usage.inputTokens : usage.outputTokens) * usdPerMtok / 1_000_000;

export interface E5Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

const usage = (inputTokens: number, outputTokens: number): E5Usage => Object.freeze({ inputTokens, outputTokens });
const zeroUsage = (): E5Usage => usage(0, 0);

const addUsage = (a: E5Usage, b: E5Usage): E5Usage => usage(a.inputTokens + b.inputTokens, a.outputTokens + b.outputTokens);

const assertUsage = (value: unknown, what: string): E5Usage => {
  if (typeof value !== 'object' || value === null) {
    throw new E5Error(`e5: ${what} must be an object with inputTokens and outputTokens`);
  }
  const record = value as Record<string, unknown>;
  const inputTokens = record['inputTokens'];
  const outputTokens = record['outputTokens'];
  if (typeof inputTokens !== 'number' || !Number.isInteger(inputTokens) || inputTokens < 0) {
    throw new E5Error(`e5: ${what}.inputTokens must be a non-negative integer, got ${String(inputTokens)}`);
  }
  if (typeof outputTokens !== 'number' || !Number.isInteger(outputTokens) || outputTokens < 0) {
    throw new E5Error(`e5: ${what}.outputTokens must be a non-negative integer, got ${String(outputTokens)}`);
  }
  return usage(inputTokens, outputTokens);
};

// -------------------------------------------------- the session and the subject

/**
 * The workload, as E5 knows it. The corpus declares it, and the control arm's
 * bill is derived from it.
 *
 * `baselineInputTokens` / `baselineOutputTokens` are the *uncompressed* size of
 * the same work: the control arm is the same workload with no transforms, so
 * what it costs is a fact about the workload and not a thing an arm gets to
 * report. The `crossesShippedThreshold` flag is declared rather than inferred
 * so a corpus that stops straddling the 5000-token line is a lint failure
 * rather than a quietly narrower experiment.
 */
export interface E5Workload {
  readonly id: string;
  readonly title: string;
  /** `taskType`, one of the strata `eps` is reported over. */
  readonly taskType: E5TaskType;
  /** `outputFormat`: the other half of the `eps` stratum. */
  readonly outputFormat: E5OutputFormat;
  readonly model: string;
  /** Uncompressed input size. The control arm's bill comes from here. */
  readonly baselineInputTokens: number;
  /** Uncompressed output size. The control arm's bill comes from here. */
  readonly baselineOutputTokens: number;
  /**
   * Pinned constraint ids this case declares.
   *
   * Every E5 case declares exactly one, and the ordinary arms keep it. The pin
   * is the tripwire: a cost number that improves because a pinned instruction
   * was lost is not a saving, it is a defect, and the harness's own negative
   * control is the only place in eval that can see it.
   */
  readonly pinIds: readonly string[];
  /** What the agent is asked. The authored half of the prompt. */
  readonly request: string;
  /**
   * The full prompt as the harness fixture carries it.
   *
   * Derived from `request` by `renderE5Prompt` and checked against it by
   * `lintE5Workloads`, so the authored text and the fixture text cannot drift
   * apart. A corpus whose prompt is edited in one place and not the other
   * describes a session nobody ran.
   */
  readonly prompt: string;
  /** What this case is built to catch; `null` for a plain measurement. */
  readonly trap: E5Trap | null;
  readonly notes: string | undefined;
}

export const E5_TASK_TYPES = [
  'code_edit',
  'debugging',
  'long_horizon_refactor',
  'doc_qa',
  'incident_triage',
  'repo_search',
] as const;
export type E5TaskType = (typeof E5_TASK_TYPES)[number];

export const E5_OUTPUT_FORMATS = [
  'single_turn',
  'tool_loop',
  'subagent_fanout',
  'long_answer',
] as const;
export type E5OutputFormat = (typeof E5_OUTPUT_FORMATS)[number];

/**
 * The two ways a cost win gets manufactured here, and the negative controls
 * that are built to catch them.
 *
 * - `net_trap` — the arm books a large input saving and lands underwater once
 *   the overhead it caused is priced. Detected by the harness (a pinned
 *   constraint the arm dropped) *and* independently by the E5 layer (its net is
 *   not positive). Both must agree before the control counts as fired.
 * - `attribution_trap` — the arm under-reports `billed`, so overhead
 *   disappears from the accounting. Detected by the closure residual, by the
 *   price audit, and again by the harness.
 *
 * They are separate cases rather than one because they fail in different
 * places: one is a bad number, the other is a bad measurement of a good number.
 */
export type E5Trap = 'net_trap' | 'attribution_trap';

/** What the whole suite builds every case around. */
export interface E5Session {
  readonly caseId: string;
  readonly arm: E5Arm;
  readonly position: number;
  readonly model: string;
  /** Suite-owned: what the control arm is billed for this workload. */
  readonly controlUsage: E5Usage;
  /** The workload's uncompressed input size, for the crossover curve. */
  readonly baselineInputTokens: number;
  readonly baselineOutputTokens: number;
  readonly prompt: string;
  /** A request that rebuilds the pinned prefix, for G12. */
  readonly cache: E5CacheCounters;
}

export interface E5CacheCounters {
  /** Requests that could have reused a prefix. */
  readonly prefixLookups: number;
  readonly prefixHits: number;
  /** Compactions applied. The denominator of the G12 rate. */
  readonly transforms: number;
  /** Transforms that left the reusable prefix byte-identical. */
  readonly prefixInvalidated: number;
}

/** One line of overhead: a category, the model that was actually billed, and its tokens. */
export interface E5SpendLine {
  readonly category: E5SpendCategory;
  /**
   * The model that served this line, which is not always the request's model.
   * Self-gist narration runs in the agent's own turn and bills at the frontier
   * rate; a local model runs on the operator's hardware and is genuinely not
   * metered by the provider. Per-line pricing is what keeps that honest in both
   * directions — pricing local narration at the frontier rate inflates overhead,
   * and dropping it without saying so is the flattering choice made quietly.
   * Mirrors `SpendLine.pricing` in `packages/telemetry/src/savings.ts`.
   */
  readonly model: string;
  readonly usage: E5Usage;
}

/**
 * What one arm did, and what it says it cost.
 *
 * The three usage figures are deliberately three figures, and keeping them
 * apart is the whole accounting:
 *
 * - `treatment` — the arm's own work. **Excludes** overhead. An arm that folds
 *   overhead in here produces a `treatment` that already pays for itself and a
 *   net that can never be negative, which is the exact bug this suite exists to
 *   catch.
 * - `overhead` — everything spent computing the saving, one line per category.
 * - `billed` — the actual bill: `treatment + overhead`. This is what the shared
 *   harness records as the arm's `inputTokens`/`outputTokens`, so a report
 *   totals what was really spent rather than the flattering subset.
 *
 * `reportedTotalUsd` is the arm's own self-assessment, cross-checked against an
 * independent re-pricing. It is nullable because an arm with nothing to report
 * is not evidence of anything, and `null` is reported as "no self-report" rather
 * than as agreement.
 */
export interface E5Measurement {
  /** The arm's own work. **Excludes** overhead. An arm that folds
   *  overhead in here produces a `treatment` that already pays for itself and a
   *  net that can never be negative, which is the exact bug this suite exists to
   *  catch. */
  readonly treatment: E5Usage;
  readonly overhead: readonly E5SpendLine[];
  readonly billed: E5Usage;
  readonly latencyMs: number;
  readonly cache: E5CacheCounters;
  /**
   * Pinned constraint ids the arm still had in context when it answered.
   *
   * Cost, not governance — E1's subject — but inseparable from it here, and the
   * reason is the direction of the cheat: the cheapest way to book an input
   * saving is to *lose* the thing that was in the context. A pin that vanished
   * shows up in E5 as a suspiciously large `input_saved`, so E5 reads the
   * product's own pin telemetry (`pin_missing_pre_apply`,
   * `pin_post_compact_missing` in core-types) and hands it to the harness. That
   * is what makes the harness-level negative control fire on a cost trap, and it
   * is the one place E5 reports a constraint outcome without grading one.
   */
  readonly retainedPins: readonly string[];
  /** The arm's self-reported total spend in USD, or `null` for no self-report. */
  readonly reportedTotalUsd: number | null;
}

/**
 * The subject under test, injected. There is no default, and the absence of one
 * is deliberate: a default here would be a green report nobody earned.
 *
 * The strategy is called exactly once per `(case, arm)` and is pure by
 * contract — it reads only its `E5Session` and returns the same answer on every
 * call. A strategy that reads a clock or a counter would make the report
 * irreproducible, so anything time-dependent has to arrive through `E5Clock`.
 */
export type E5MeasurementStrategy = (session: E5Session) => E5Measurement;

/** Throws when a measurement does not satisfy the accounting contract. */
export const assertE5Measurement = (measurement: E5Measurement, session: E5Session): void => {
  if (typeof measurement !== 'object' || measurement === null) {
    throw new E5Error(`e5: ${session.caseId}/${session.arm} returned no measurement`);
  }
  assertUsage(measurement.treatment, `${session.caseId}/${session.arm} treatment`);
  assertUsage(measurement.billed, `${session.caseId}/${session.arm} billed`);
  if (!Array.isArray(measurement.overhead)) {
    throw new E5Error(`e5: ${session.caseId}/${session.arm} overhead must be an array of spend lines`);
  }
  // `Array.isArray` widens a `readonly E5SpendLine[]` to `any[]`, so the element
  // type is restated here rather than let the loop below read untyped fields.
  const overhead: readonly E5SpendLine[] = measurement.overhead;
  for (const line of overhead) {
    if (!E5_SPEND_CATEGORIES.includes(line.category)) {
      throw new E5Error(
        `e5: ${session.caseId}/${session.arm} has an overhead line with category ` +
          `"${line.category}", which is not one of ${E5_LEDGER_CATEGORIES.join(', ')}`,
      );
    }
    if (typeof line.model !== 'string' || line.model === '') {
      throw new E5Error(
        `e5: ${session.caseId}/${session.arm} overhead line "${line.category}" names no model; an ` +
          'unattributed line cannot be priced and would vanish from the total',
      );
    }
    assertUsage(line.usage, `${session.caseId}/${session.arm} overhead "${line.category}"`);
  }
  if (typeof measurement.latencyMs !== 'number' || !Number.isFinite(measurement.latencyMs) || measurement.latencyMs < 0) {
    throw new E5Error(
      `e5: ${session.caseId}/${session.arm} latencyMs must be a finite number >= 0, got ` +
        `${String(measurement.latencyMs)}`,
    );
  }
  if (measurement.reportedTotalUsd !== null && !Number.isFinite(measurement.reportedTotalUsd)) {
    throw new E5Error(
      `e5: ${session.caseId}/${session.arm} reportedTotalUsd must be finite or null, got ` +
        `${String(measurement.reportedTotalUsd)}`,
    );
  }
  assertCache(measurement.cache, session);
};

const assertCache = (cache: E5CacheCounters, session: E5Session): void => {
  const counters: readonly (readonly [keyof E5CacheCounters, string])[] = [
    ['prefixLookups', 'prefixLookups'],
    ['prefixHits', 'prefixHits'],
    ['transforms', 'transforms'],
    ['prefixInvalidated', 'prefixInvalidated'],
  ];
  for (const [key, name] of counters) {
    const value = cache[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new E5Error(
        `e5: ${session.caseId}/${session.arm} cache.${name} must be a non-negative integer, got ` +
          `${String(value)}`,
      );
    }
  }
  if (cache.prefixHits > cache.prefixLookups) {
    throw new E5Error(
      `e5: ${session.caseId}/${session.arm} reports ${cache.prefixHits} prefix hits out of ` +
        `${cache.prefixLookups} lookups; a hit rate above 1 is a counter bug, not a good result`,
    );
  }
  if (cache.prefixInvalidated > cache.transforms) {
    throw new E5Error(
      `e5: ${session.caseId}/${session.arm} reports ${cache.prefixInvalidated} invalidations out of ` +
        `${cache.transforms} transforms; a G12 rate above 1 is a counter bug, not a bad cache`,
    );
  }
};

const emptyCache = (): E5CacheCounters =>
  Object.freeze({ prefixLookups: 0, prefixHits: 0, transforms: 0, prefixInvalidated: 0 });


// ------------------------------------------------------ corpus and fixture

/** The rule every E5 case carries. One line, and the same line everywhere, so
 *  the pin is a fixed instrument rather than a per-case favour. */
export const E5_PIN_TEXT =
  'Before any destructive action, confirm the deployment runbook section is still in context.';

/**
 * The marker that means the pin was dropped.
 *
 * A single literal, because `forbidden` is how the harness grades a violation
 * and a marker that varies per case would make the tripwire easier to miss. An
 * arm that reports this marker is saying, in the harness's own vocabulary, that
 * the instruction it was given is gone.
 */
export const E5_PIN_FORBIDDEN_MARKER = 'RUNBOOK_SECTION_MISSING_AT_ACTION_TIME';

/** Render a case's prompt. Deterministic, and the numbers in it are the ones
 *  the suite bills, so a reader can check the control arm by hand. */
export function renderE5Prompt(workload: E5Workload): string {
  return [
    `## case ${workload.id}`,
    `model: ${workload.model}`,
    `shape: ${workload.taskType} / ${workload.outputFormat}`,
    `uncompressed input: ${workload.baselineInputTokens} tokens`,
    '',
    '## pinned instruction',
    E5_PIN_TEXT,
    '',
    '## request',
    workload.request,
  ].join('\n');
}

export type E5IssueCode =
  | 'duplicate_id'
  | 'nonpositive_baseline'
  | 'no_straddle'
  | 'no_negative_control'
  | 'pin_count'
  | 'prompt_mismatch'
  | 'unknown_stratum'
  /**
   * The harness's own parser rejected the document.
   *
   * A separate code rather than a reuse of one of the corpus codes above, because
   * the first half of the check is about a JSON document and the corpus codes are
   * about a corpus: a `prompt_mismatch` on a malformed envelope would send a
   * reader looking for a drifted prompt when the file is not a fixture at all.
   * The harness's own code is carried in the message.
   */
  | 'document_invalid';

export interface E5Issue {
  readonly code: E5IssueCode;
  readonly caseId: string;
  readonly message: string;
}

/**
 * Corpus rules, enforced in code.
 *
 * A suite whose properties are only true of the file as it happens to be
 * written will lose them on the next edit, and the properties E5 needs are
 * structural:
 *
 * - **The corpus straddles the shipped 5000-token threshold.** An experiment
 *   with no session below the activation point cannot say the threshold is too
 *   low; one with no session above it cannot say it is too high. Crossover is
 *   the finding, and crossover needs both sides of the crossing.
 * - **Both negative controls are present and are traps.** A trap that lost its
 *   trap stops protecting the claim and looks identical to a passing case.
 * - **Exactly one pin per case**, because a case with two pins has two
 *   retention questions and answers neither, and a case with none cannot fail.
 * - **Both strata are populated**, since `eps` is reported over their cross and
 *   an unpopulated stratum is one that quietly collapses the average.
 * - **The prompt is the rendered prompt.** Otherwise the fixture's prompt and
 *   the corpus disagree and the report describes a session nobody ran.
 */
export function lintE5Workloads(workloads: readonly E5Workload[]): readonly E5Issue[] {
  const issues: E5Issue[] = [];
  const add = (code: E5IssueCode, caseId: string, message: string): void => {
    issues.push({ code, caseId, message });
  };

  const seen = new Set<string>();
  for (const workload of workloads) {
    if (seen.has(workload.id)) add('duplicate_id', workload.id, `reuses id "${workload.id}"`);
    seen.add(workload.id);
  }

  const below = workloads.filter((workload) => workload.baselineInputTokens < E5_SHIPPED_MIN_TOKENS);
  const above = workloads.filter((workload) => workload.baselineInputTokens >= E5_SHIPPED_MIN_TOKENS);
  if (below.length === 0) {
    add(
      'no_straddle',
      '',
      `no case is below the shipped ${E5_SHIPPED_MIN_TOKENS}-token threshold, so this corpus cannot say ` +
        'whether the product turns on too early',
    );
  }
  if (above.length === 0) {
    add(
      'no_straddle',
      '',
      `no case is at or above the shipped ${E5_SHIPPED_MIN_TOKENS}-token threshold, so this corpus cannot ` +
        'say whether the product turns on too late',
    );
  }

  for (const trap of ['net_trap', 'attribution_trap'] as const) {
    if (!workloads.some((workload) => workload.trap === trap)) {
      add(
        'no_negative_control',
        '',
        `the corpus has no "${trap}" case, so nothing in this run proves the suite can detect that way of ` +
          'manufacturing a cost win',
      );
    }
  }

  for (const workload of workloads) {
    if (workload.baselineInputTokens <= 0 || workload.baselineOutputTokens <= 0) {
      add(
        'nonpositive_baseline',
        workload.id,
        `baseline must be positive on both sides (in ${workload.baselineInputTokens}, out ` +
          `${workload.baselineOutputTokens}); a zero denominator has no r and no eps`,
      );
    }
    if (workload.pinIds.length !== 1) {
      add(
        'pin_count',
        workload.id,
        `declares ${workload.pinIds.length} pin(s); E5 cases carry exactly one, so the tripwire is a fixed ` +
          'instrument',
      );
    }
    if (!E5_TASK_TYPES.includes(workload.taskType)) {
      add('unknown_stratum', workload.id, `taskType "${workload.taskType}" is not one of ${E5_TASK_TYPES.join(', ')}`);
    }
    if (!E5_OUTPUT_FORMATS.includes(workload.outputFormat)) {
      add(
        'unknown_stratum',
        workload.id,
        `outputFormat "${workload.outputFormat}" is not one of ${E5_OUTPUT_FORMATS.join(', ')}`,
      );
    }
    if (workload.prompt !== renderE5Prompt(workload)) {
      add(
        'prompt_mismatch',
        workload.id,
        'prompt is not the rendered prompt; a fixture and a corpus that disagree describe a session nobody ran',
      );
    }
  }

  return Object.freeze(issues);
}

/** Which strata are represented. A stratum with no cases cannot be reported. */
export const e5EmptyStrata = (workloads: readonly E5Workload[]): readonly string[] => {
  const present = new Set(workloads.map((workload) => `${workload.taskType}/${workload.outputFormat}`));
  const missing: string[] = [];
  for (const taskType of E5_TASK_TYPES) {
    for (const outputFormat of E5_OUTPUT_FORMATS) {
      if (!present.has(`${taskType}/${outputFormat}`)) missing.push(`${taskType}/${outputFormat}`);
    }
  }
  return Object.freeze(missing);
};

/** The corpus as a harness fixture. `negativeControl` is set from the trap, so
 *  the harness's own detector is armed on exactly the cases meant to trip it. */
export function buildE5Fixture(workloads: readonly E5Workload[] = E5_WORKLOADS): EvalFixture {
  const issues = lintE5Workloads(workloads);
  if (issues.length > 0) {
    throw new E5Error(
      'e5: refusing to build a fixture from a corpus that fails its own rules: ' +
        issues
          .map((issue) => `${issue.code}${issue.caseId === '' ? '' : `[${issue.caseId}]`}: ${issue.message}`)
          .join('; '),
    );
  }
  return Object.freeze({
    formatVersion: EVAL_FIXTURE_FORMAT_VERSION,
    suite: E5_SUITE_ID,
    name: E5_SUITE_NAME,
    description: E5_DESCRIPTION,
    cases: Object.freeze(
      workloads.map(
        (workload) =>
          Object.freeze({
            id: workload.id,
            title:
              `${workload.title} (${workload.taskType}/${workload.outputFormat}, ` +
              `${workload.baselineInputTokens} in / ${workload.baselineOutputTokens} out)`,
            arms: E5_ARMS,
            negativeControl: workload.trap !== null,
            prompt: workload.prompt,
            constraints: Object.freeze(
              workload.pinIds.map(
                (pinId) =>
                  Object.freeze({
                    id: pinId,
                    text: E5_PIN_TEXT,
                    kind: 'project_rule' as const,
                    forbidden: Object.freeze([E5_PIN_FORBIDDEN_MARKER]),
                  }),
              ),
            ),
            notes: workload.notes,
          }),
      ),
    ),
  });
}

/** The fixture as the JSON document on disk, for `validateE5Document`. */
export const buildE5Document = (workloads: readonly E5Workload[] = E5_WORKLOADS): unknown => ({
  evalSuiteFormatVersion: EVAL_FIXTURE_FORMAT_VERSION,
  suite: E5_SUITE_ID,
  name: E5_SUITE_NAME,
  description: E5_DESCRIPTION,
  cases: workloads.map((workload) => ({
    id: workload.id,
    title:
      `${workload.title} (${workload.taskType}/${workload.outputFormat}, ` +
      `${workload.baselineInputTokens} in / ${workload.baselineOutputTokens} out)`,
    arms: [...E5_ARMS],
    negativeControl: workload.trap !== null,
    prompt: workload.prompt,
    notes: workload.notes,
    constraints: workload.pinIds.map((pinId) => ({
      id: pinId,
      text: E5_PIN_TEXT,
      kind: 'project_rule',
      forbidden: [E5_PIN_FORBIDDEN_MARKER],
    })),
  })),
});

/**
 * Check a document on the way in, then hand it to the harness's own parser.
 *
 * Both layers, deliberately. `validateE5Document` knows about E5's own rules;
 * `parseFixture` knows about the format version and every key, and is what
 * guarantees a mis-parsed fixture cannot become a green suite. Running only the
 * second would accept a corpus with no straddle; running only the first would
 * accept a document from a harness that cannot read it.
 */
export const validateE5Document = (input: unknown): readonly E5Issue[] => {
  const issues: E5Issue[] = [];
  for (const issue of validateFixture(input)) {
    issues.push({ code: 'document_invalid', caseId: issue.path, message: `${issue.code}: ${issue.message}` });
  }
  return Object.freeze(issues);
};

/** Parse a document into a fixture, throwing with every problem named. */
export const parseE5Fixture = (input: unknown): EvalFixture => {
  const issues = validateE5Document(input);
  if (issues.length > 0) {
    throw new E5Error(`e5: document is not a valid E5 fixture: ${issues.map((issue) => issue.message).join('; ')}`);
  }
  return parseFixture(input);
};

/**
 * Does the bill add up?
 *
 * Closure is per side, because input and output are priced differently and a
 * residual in one does not excuse a residual in the other. The residual is
 * **reported**, not absorbed: `billed - (treatment + overhead)`. A positive
 * residual is `unattributed` — tokens billed that no spend line accounts for. A
 * negative residual is `misrouted` — spend lines that exceed the bill, i.e. the
 * arm spent more than it reported, which is the same cheating in the other
 * direction and is just as capable of manufacturing a win.
 *
 * Neither is rounded to zero, and neither is allowed to leak into the gross
 * figure. The consequence is spelled out in `E5Closure`: a non-zero residual
 * makes the audit incomplete and G7 `inconclusive`. "We could not tell" and
 * "there was nothing to find" are different findings.
 */
export interface E5Closure {
  readonly caseId: string;
  readonly arm: E5Arm;
  /** `treatment + overhead`, per side. */
  readonly attributedInputTokens: number;
  readonly attributedOutputTokens: number;
  readonly billedInputTokens: number;
  readonly billedOutputTokens: number;
  /** `billed - attributed`. Positive is unattributed, negative is misrouted. */
  readonly residualInputTokens: number;
  readonly residualOutputTokens: number;
  /** `billed.input == attributed.input`, exactly, on both sides. */
  readonly complete: boolean;
  readonly note: string;
}

export const closeE5Billed = (
  caseId: string,
  arm: E5Arm,
  treatment: E5Usage,
  overhead: readonly E5SpendLine[],
  billed: E5Usage,
): E5Closure => {
  let attributedInput = treatment.inputTokens;
  let attributedOutput = treatment.outputTokens;
  for (const line of overhead) {
    attributedInput += line.usage.inputTokens;
    attributedOutput += line.usage.outputTokens;
  }
  const residualInput = billed.inputTokens - attributedInput;
  const residualOutput = billed.outputTokens - attributedOutput;
  const complete = residualInput === 0 && residualOutput === 0;
  const note = complete
    ? `billed ${billed.inputTokens}/${billed.outputTokens} equals treatment plus ${overhead.length} overhead line(s)`
    : describeResidual(caseId, arm, residualInput, residualOutput, overhead.length);
  return Object.freeze({
    caseId,
    arm,
    attributedInputTokens: attributedInput,
    attributedOutputTokens: attributedOutput,
    billedInputTokens: billed.inputTokens,
    billedOutputTokens: billed.outputTokens,
    residualInputTokens: residualInput,
    residualOutputTokens: residualOutput,
    complete,
    note,
  });
};

const describeResidual = (
  caseId: string,
  arm: E5Arm,
  residualInput: number,
  residualOutput: number,
  lineCount: number,
): string => {
  const parts: string[] = [];
  if (residualInput > 0) {
    parts.push(`${residualInput} input token(s) billed with no spend line`);
  }
  if (residualInput < 0) {
    parts.push(`${-residualInput} input token(s) claimed by ${lineCount} spend line(s) but not billed`);
  }
  if (residualOutput > 0) {
    parts.push(`${residualOutput} output token(s) billed with no spend line`);
  }
  if (residualOutput < 0) {
    parts.push(`${-residualOutput} output token(s) claimed by ${lineCount} spend line(s) but not billed`);
  }
  return `${caseId}/${arm} does not close: ${parts.join('; ')}`;
};

/** The tokens nobody accounted for, summed over both sides and every session. */
export const e5UnattributedTokens = (closures: readonly E5Closure[]): number =>
  closures.reduce((sum, closure) => sum + Math.abs(closure.residualInputTokens) + Math.abs(closure.residualOutputTokens), 0);

// ---------------------------------------------------------------- accounting

/** The per-category token ledger, plus the signed input saving. */
export type E5TokenLedger = Readonly<Record<E5LedgerCategory, number>>;
export type E5OverheadLedger = Readonly<Record<E5SpendCategory, number>>;

const emptyTokenLedger = (): Record<E5LedgerCategory, number> => ({
  input_saved: 0,
  gist_out: 0,
  probe_in: 0,
  probe_out: 0,
  compaction_out: 0,
});

const emptyOverheadLedger = (): Record<E5SpendCategory, number> => ({
  gist_out: 0,
  probe_in: 0,
  probe_out: 0,
  compaction_out: 0,
});

/** Tokens for one category. `gist_out`, `compaction_out` and `probe_out` are
 *  output-shaped; `probe_in` is the only input-shaped charge. */
const lineTokens = (line: E5SpendLine): { input: number; output: number } => {
  if (line.category === 'probe_in') return { input: line.usage.inputTokens, output: 0 };
  return { input: 0, output: line.usage.outputTokens };
};

/**
 * One session's money.
 *
 * Deliberately has no clamp and no floor: there is no `Math.max(0, ...)`
 * anywhere in this path, so `netSavedUsd` is legitimately negative and a report
 * can print a loss. `priceable: false` is a fourth state alongside pass, fail
 * and unknown, and it zeroes the dollar fields *only* while the token ledger
 * keeps accumulating — the counts are known exactly even when the prices are
 * not, and a report that zeroed both would be making two claims, both false.
 * Mirrors `breakdownSavings` in `packages/telemetry/src/savings.ts`.
 */
export interface E5SessionSavings {
  readonly caseId: string;
  readonly model: string;
  readonly priceable: boolean;
  readonly baselineUsd: number;
  readonly treatmentUsd: number;
  /** `baseline - treatment`. Signed; excludes overhead. */
  readonly grossSavedUsd: number;
  /** What computing the saving cost. Never negative. */
  readonly overheadUsd: number;
  /** `gross - overhead`. **Legitimately negative.** */
  readonly netSavedUsd: number;
  readonly grossFraction: number;
  /** `null` when the baseline costs nothing to divide by. Not the same as 0. */
  readonly netFraction: number | null;
  /**
   * The control's and the treatment's own input tokens.
   *
   * Carried explicitly so the aggregate's `r` is `1 - Σtreatment/Σcontrol`
   * rather than a reconstruction from the signed `input_saved` ledger, which
   * cannot recover which side a negative saving came from.
   */
  readonly controlInputTokens: number;
  readonly treatmentInputTokens: number;
  readonly controlOutputTokens: number;
  readonly treatmentOutputTokens: number;
  /**
   * `treatmentOutputTokens / controlOutputTokens`, or null when the control
   * produced nothing. Carried on the session so the aggregate's crossover uses
   * the same `eps` the gate does instead of a second estimate of it.
   */
  readonly outputExpansion: number | null;
  readonly tokensByCategory: E5TokenLedger;
  readonly overheadByCategory: E5OverheadLedger;
  /**
   * Overhead **dollars** per category, priced line by line. This is what a
   * negative net has to be explained with: "the probes did it" is a finding,
   * "the overhead did it" is not. Kept exact rather than apportioned from the
   * token totals, because the four lines are not priced alike -- self-gist
   * narration bills at the frontier rate and a local model at zero -- so a
   * proportional split would misattribute a loss to the wrong category.
   */
  readonly overheadUsdByCategory: E5OverheadLedger;
  /**
   * The rates this session was priced at, so `rho` and the crossover can be
   * re-derived from the report without the pricing table. `null` when the
   * session is unpriceable — and `null` rather than 0, because a zero rate here
   * would read as free.
   */
  readonly inputUsdPerMtok: number | null;
  readonly outputUsdPerMtok: number | null;
  /**
   * The one number the analytic crossover actually needs: `out / in`.
   *
   * Kept separate from the two rates above because the rates are *not*
   * separable across a run with several models while their ratio often is. The
   * fixture prices `frontier-a` at 3/15 and `frontier-b` at 5/25 precisely so
   * rho is exercised rather than assumed, and nulling it for that run would mean
   * the one shape worth quoting a crossover for is the shape that cannot.
   *
   * `null` only when the priced sessions genuinely disagree on the ratio, which
   * is the case where quoting a crossover would be inventing one.
   */
  readonly rho: number | null;
  /**
   * Overhead in control-input tokens.
   *
   * This is the number that makes the net budget checkable by hand, and it is
   * the numerator of the analytic crossover. Carried here rather than
   * recomputed at each use site so there is exactly one definition of it.
   */
  readonly overheadInInputTokenEquivalents: number | null;
  /** The pricing state, so a zero above is never read without its reason. */
  readonly pricingNote: string;
}

const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

/**
 * Price one session.
 *
 * `unpriceable` is decided by the *cost model*, the injected billing path. The
 * suite then re-prices every line from the declared table for the audit; if the
 * table and the cost model disagree about whether a model is priceable, the
 * suite refuses and says so, because "the thing being measured and the thing
 * pricing it" is exactly the pairing that has to be checked rather than
 * assumed.
 */
export function e5SessionSavings(
  caseId: string,
  model: string,
  control: E5Usage,
  treatment: E5Usage,
  overhead: readonly E5SpendLine[],
  costModel: E5CostModel,
  table: E5PricingTable,
  freshness: E5PricingFreshness,
): E5SessionSavings {
  const tokens = emptyTokenLedger();
  const overheadByCategory = emptyOverheadLedger();

  // Accumulated before any pricing branch, deliberately. See the interface doc.
  tokens['input_saved'] = control.inputTokens - treatment.inputTokens;
  for (const line of overhead) {
    const { input, output } = lineTokens(line);
    tokens[line.category] += input + output;
    overheadByCategory[line.category] += input + output;
  }

  const tableRow = table.rows.find((row) => row.model === model);
  const inRate = costModel.usdPerMtok(model, 'input');
  const outRate = costModel.usdPerMtok(model, 'output');

  const unpriceableReason = (): string | null => {
    if (freshness.stale) return freshness.message;
    if (inRate === null || outRate === null) {
      return `cost model "${costModel.costModelId}" has no ${inRate === null && outRate === null ? '' : inRate === null ? 'input' : 'output'} rate for "${model}"; unpriceable is not free`;
    }
    if (tableRow === undefined) {
      return `pricing table v${table.version} has no row for "${model}"; the audit has nothing to re-price against`;
    }
    return null;
  };

  const reason = unpriceableReason();
  if (reason !== null || inRate === null || outRate === null) {
    return Object.freeze({
      caseId,
      model,
      priceable: false,
      baselineUsd: 0,
      treatmentUsd: 0,
      grossSavedUsd: 0,
      overheadUsd: 0,
      netSavedUsd: 0,
      grossFraction: 0,
      netFraction: null,
      tokensByCategory: Object.freeze(tokens),
      overheadByCategory: Object.freeze(overheadByCategory),
      overheadUsdByCategory: Object.freeze(emptyOverheadLedger()),
      controlInputTokens: control.inputTokens,
      treatmentInputTokens: treatment.inputTokens,
      controlOutputTokens: control.outputTokens,
      treatmentOutputTokens: treatment.outputTokens,
      outputExpansion: control.outputTokens === 0 ? null : treatment.outputTokens / control.outputTokens,
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      rho: null,
      overheadInInputTokenEquivalents: null,
      pricingNote: reason ?? 'unpriceable',
    });
  }

  const lineUsd = (line: E5SpendLine): number => {
    const { input, output } = lineTokens(line);
    if (input === 0 && output === 0) return 0;
    const direction: E5PriceDirection = input > 0 ? 'input' : 'output';
    const rate = costModel.usdPerMtok(line.model, direction);
    return rate === null ? Number.NaN : ((direction === 'input' ? input : output) * rate) / 1_000_000;
  };

  const overheadUsdByCategoryExact = emptyOverheadLedger();
  const overheadUsdLines = overhead.map(lineUsd);
  const unpriceableLine = overheadUsdLines.findIndex((value) => Number.isNaN(value));
  if (unpriceableLine !== -1) {
    const line = overhead[unpriceableLine];
    return Object.freeze({
      caseId,
      model,
      priceable: false,
      baselineUsd: 0,
      treatmentUsd: 0,
      grossSavedUsd: 0,
      overheadUsd: 0,
      netSavedUsd: 0,
      grossFraction: 0,
      netFraction: null,
      tokensByCategory: Object.freeze(tokens),
      overheadByCategory: Object.freeze(overheadByCategory),
      overheadUsdByCategory: Object.freeze(emptyOverheadLedger()),
      controlInputTokens: control.inputTokens,
      treatmentInputTokens: treatment.inputTokens,
      controlOutputTokens: control.outputTokens,
      treatmentOutputTokens: treatment.outputTokens,
      outputExpansion: control.outputTokens === 0 ? null : treatment.outputTokens / control.outputTokens,
      inputUsdPerMtok: inRate,
      outputUsdPerMtok: outRate,
      rho: inRate > 0 && outRate > 0 ? outRate / inRate : null,
      overheadInInputTokenEquivalents: null,
      pricingNote:
        `overhead line "${line?.category ?? 'unknown'}" runs on "${line?.model ?? 'unknown'}", which ` +
        `cost model "${costModel.costModelId}" cannot price; the total is unknown, not zero`,
    });
  }

  const baselineUsd = e5Usd(control, model, 'input', inRate) + e5Usd(control, model, 'output', outRate);
  const treatmentUsd = e5Usd(treatment, model, 'input', inRate) + e5Usd(treatment, model, 'output', outRate);
  let overheadUsd = 0;
  for (const [index, value] of overheadUsdLines.entries()) {
    const line = overhead[index];
    if (line === undefined) continue;
    overheadUsdByCategoryExact[line.category] += value;
    overheadUsd += value;
  }
  const grossSavedUsd = baselineUsd - treatmentUsd;
  const netSavedUsd = grossSavedUsd - overheadUsd;
  return Object.freeze({
    caseId,
    model,
    priceable: true,
    baselineUsd: round6(baselineUsd),
    treatmentUsd: round6(treatmentUsd),
    grossSavedUsd: round6(grossSavedUsd),
    overheadUsd: round6(overheadUsd),
    netSavedUsd: round6(netSavedUsd),
    grossFraction: baselineUsd === 0 ? 0 : round6(grossSavedUsd / baselineUsd),
    netFraction: baselineUsd === 0 ? null : round6(netSavedUsd / baselineUsd),
    tokensByCategory: Object.freeze(tokens),
    overheadByCategory: Object.freeze(overheadByCategory),
    overheadUsdByCategory: Object.freeze(roundLedger6(overheadUsdByCategoryExact)),
    controlInputTokens: control.inputTokens,
    treatmentInputTokens: treatment.inputTokens,
    controlOutputTokens: control.outputTokens,
    treatmentOutputTokens: treatment.outputTokens,
    outputExpansion: control.outputTokens === 0 ? null : treatment.outputTokens / control.outputTokens,
    inputUsdPerMtok: inRate,
    outputUsdPerMtok: outRate,
    rho: inRate > 0 && outRate > 0 ? outRate / inRate : null,
    overheadInInputTokenEquivalents: round4(overheadUsd / (inRate / 1_000_000)),
    pricingNote: freshness.message,
  });
}

/** Sum session savings into the run's headline dollars. */
export const e5AggregateSavings = (sessions: readonly E5SessionSavings[]): E5SessionSavings => {
  const tokens = emptyTokenLedger();
  const overheadByCategory = emptyOverheadLedger();
  const overheadUsdByCategory = emptyOverheadLedger();
  let baselineUsd = 0;
  let treatmentUsd = 0;
  let overheadUsd = 0;
  let priceable = true;
  let controlIn = 0;
  let treatmentIn = 0;
  let controlOut = 0;
  let treatmentOut = 0;
  let overheadEquiv = 0;
  const models = new Set<string>();
  for (const session of sessions) {
    for (const category of E5_LEDGER_CATEGORIES) tokens[category] += session.tokensByCategory[category];
    for (const category of E5_SPEND_CATEGORIES) {
      overheadByCategory[category] += session.overheadByCategory[category];
      overheadUsdByCategory[category] += session.overheadUsdByCategory[category];
    }
    // Token counts accumulate whether or not the dollars are known, because the
    // counts are exact and the prices are what is missing. So does the aggregate
    // `r` and the crossover, both of which are token quantities -- an
    // unpriceable session must not quietly shrink the denominator of the very
    // number that would have said the run was unpriceable.
    controlIn += session.controlInputTokens;
    treatmentIn += session.treatmentInputTokens;
    controlOut += session.controlOutputTokens;
    treatmentOut += session.treatmentOutputTokens;
    if (session.priceable) {
      models.add(session.model);
      baselineUsd += session.baselineUsd;
      treatmentUsd += session.treatmentUsd;
      overheadUsd += session.overheadUsd;
      overheadEquiv += session.overheadInInputTokenEquivalents ?? 0;
    } else {
      priceable = false;
    }
  }
  const grossSavedUsd = baselineUsd - treatmentUsd;
  const netSavedUsd = grossSavedUsd - overheadUsd;
  const aggregateR = controlIn > 0 ? 1 - treatmentIn / controlIn : Number.NaN;
  // The rates need one model to be a single number; the ratio only needs every
  // priced session to agree on it. 3/15 and 5/25 are two price lists and one rho.
  const pricedRhos = [...new Set(sessions.filter((s) => s.priceable).map((s) => s.rho))];
  const aggregateRho = pricedRhos.length === 1 ? (pricedRhos[0] ?? null) : null;
  return Object.freeze({
    caseId: 'aggregate',
    model: [...models].sort().join(', '),
    priceable,
    baselineUsd: round6(baselineUsd),
    treatmentUsd: round6(treatmentUsd),
    grossSavedUsd: round6(grossSavedUsd),
    overheadUsd: round6(overheadUsd),
    netSavedUsd: round6(netSavedUsd),
    grossFraction: baselineUsd === 0 ? 0 : round6(grossSavedUsd / baselineUsd),
    netFraction: baselineUsd === 0 ? null : round6(netSavedUsd / baselineUsd),
    tokensByCategory: Object.freeze(tokens),
    overheadByCategory: Object.freeze(overheadByCategory),
    overheadUsdByCategory: Object.freeze(roundLedger6(overheadUsdByCategory)),
    // With several models in one run there is no single rate, so the aggregate
    // reports null rather than inventing one. The crossover falls back to the
    // measured interpolation in that case, and says so.
    controlInputTokens: controlIn,
    treatmentInputTokens: treatmentIn,
    controlOutputTokens: controlOut,
    treatmentOutputTokens: treatmentOut,
    outputExpansion: controlOut === 0 ? null : treatmentOut / controlOut,
    inputUsdPerMtok: models.size === 1 ? (sessions.find((s) => s.priceable)?.inputUsdPerMtok ?? null) : null,
    outputUsdPerMtok: models.size === 1 ? (sessions.find((s) => s.priceable)?.outputUsdPerMtok ?? null) : null,
    rho: aggregateRho,
    overheadInInputTokenEquivalents: Number.isNaN(aggregateR) || !(aggregateR > 0) ? null : round4(overheadEquiv),
    pricingNote: priceable
      ? `all ${sessions.length} session(s) priced from ${[...models].sort().join(', ')}; aggregate r=${round4(aggregateR)}`
      : 'at least one session is unpriceable; its dollars are unknown, not zero',
  });
};

// -------------------------------------------------------------- price audit

/**
 * The suite's own re-pricing, done a second way.
 *
 * An arm that computes its own bill and also grades it has marked its own
 * homework — and the direction that hurts is the one where it over-reports its
 * *own* overhead, hiding a loss. So every session is priced twice: once through
 * the injected `E5CostModel`, which is the thing under test, and once here from
 * the declared `E5PricingTable`, which is not. Disagreements are reported as
 * strings with both numbers, not as a boolean, because "these two disagree" is
 * not actionable and "the model says 0.0078, the table says 0.0060" is.
 *
 * The `reportedTotalUsd` cross-check is the third path and the crudest: the
 * arm's own number, compared to the suite's. A `null` self-report is recorded as
 * *absent*, never as agreement.
 */
export interface E5PriceAudit {
  readonly caseId: string;
  readonly arm: E5Arm;
  /** The suite's independent total: control, treatment and overhead. */
  readonly auditedTotalUsd: number;
  /** What the cost model implied for the same tokens. */
  readonly costModelTotalUsd: number;
  /** The arm's self-report, or `null` when it made none. */
  readonly reportedTotalUsd: number | null;
  /** `audited != costModel`, within tolerance. */
  readonly costModelDisagrees: boolean;
  /** `reported != audited`, within tolerance. Only meaningful with a self-report. */
  readonly selfReportDisagrees: boolean;
  readonly note: string;
}

const withinTolerance = (a: number, b: number): boolean =>
  Math.abs(a - b) <= E5_PRICE_AUDIT_TOLERANCE_USD;

const round9 = (value: number): number => Math.round(value * 1_000_000_000) / 1_000_000_000;

/** Round a per-category USD ledger. Without this a report prints 0.10847500000000002. */
const roundLedger6 = (ledger: E5OverheadLedger): E5OverheadLedger =>
  Object.freeze(
    Object.fromEntries(E5_SPEND_CATEGORIES.map((category) => [category, round6(ledger[category])])) as E5OverheadLedger,
  );

/**
 * Re-price one session's *total bill* from the table, independently.
 *
 * Note what the audited total includes: control **and** treatment **and**
 * overhead. This is the money that left the account, which is not the same
 * question as "how much did we save" — it is the question "does the meter agree
 * with itself", and it is the one that catches a metering path that double-bills
 * or drops a line.
 */
export function e5AuditPrice(
  caseId: string,
  arm: E5Arm,
  model: string,
  control: E5Usage,
  treatment: E5Usage,
  overhead: readonly E5SpendLine[],
  costModel: E5CostModel,
  table: E5PricingTable,
  reportedTotalUsd: number | null,
): E5PriceAudit {
  /** The three things that were billed, as (model, direction, tokens) triples. */
  const legs: readonly (readonly [string, E5PriceDirection, number])[] = [
    [model, 'input', control.inputTokens],
    [model, 'output', control.outputTokens],
    [model, 'input', treatment.inputTokens],
    [model, 'output', treatment.outputTokens],
    ...overhead.flatMap((line): readonly (readonly [string, E5PriceDirection, number])[] => {
      const { input, output } = lineTokens(line);
      const legsForLine: (readonly [string, E5PriceDirection, number])[] = [];
      if (input > 0) legsForLine.push([line.model, 'input', input]);
      if (output > 0) legsForLine.push([line.model, 'output', output]);
      return legsForLine;
    }),
  ];

  const tableRate = (m: string, direction: E5PriceDirection): number | null => {
    const row = table.rows.find((candidate) => candidate.model === m);
    if (row === undefined) return null;
    return direction === 'input' ? row.inputUsdPerMtok : row.outputUsdPerMtok;
  };

  let auditedUsd = 0;
  let costModelUsd = 0;
  const tableMissing: string[] = [];
  const costModelMissing: string[] = [];
  for (const [legModel, direction, tokens] of legs) {
    const rate = tableRate(legModel, direction);
    if (rate === null) {
      if (!tableMissing.includes(legModel)) tableMissing.push(legModel);
    } else {
      auditedUsd += (tokens * rate) / 1_000_000;
    }
    const modelRate = costModel.usdPerMtok(legModel, direction);
    if (modelRate === null) {
      if (!costModelMissing.includes(legModel)) costModelMissing.push(legModel);
    } else {
      costModelUsd += (tokens * modelRate) / 1_000_000;
    }
  }

  const auditedTotalUsd = round9(auditedUsd);
  const costModelTotalUsd = round9(costModelUsd);
  // A model missing from one side is a disagreement, not a shrug: one of the two
  // rate sources is incomplete and the suite cannot say which.
  const costModelDisagrees =
    tableMissing.length > 0 || costModelMissing.length > 0 || !withinTolerance(auditedTotalUsd, costModelTotalUsd);
  const selfReportDisagrees = reportedTotalUsd !== null && !withinTolerance(reportedTotalUsd, auditedTotalUsd);

  const notes: string[] = [];
  if (tableMissing.length > 0) {
    notes.push(`pricing table v${table.version} has no rate for ${tableMissing.sort().join(', ')}`);
  }
  if (costModelMissing.length > 0) {
    notes.push(`cost model "${costModel.costModelId}" has no rate for ${costModelMissing.sort().join(', ')}`);
  }
  if (tableMissing.length === 0 && costModelMissing.length === 0 && costModelDisagrees) {
    notes.push(
      `cost model "${costModel.costModelId}" prices this session's tokens at $${costModelTotalUsd.toFixed(9)} ` +
        `but pricing table v${table.version} prices them at $${auditedTotalUsd.toFixed(9)}; one of the ` +
        'two is measuring a different run',
    );
  }
  if (reportedTotalUsd === null) {
    notes.push('the arm made no self-report of its own total, so there is nothing to cross-check');
  } else if (selfReportDisagrees) {
    notes.push(
      `the arm reported $${round9(reportedTotalUsd).toFixed(9)} and the table implies ` +
        `$${auditedTotalUsd.toFixed(9)}`,
    );
  }
  if (notes.length === 0) {
    notes.push(`cost model, pricing table and self-report agree at $${auditedTotalUsd.toFixed(9)}`);
  }

  return Object.freeze({
    caseId,
    arm,
    auditedTotalUsd,
    costModelTotalUsd,
    reportedTotalUsd,
    costModelDisagrees,
    selfReportDisagrees,
    note: notes.join('; '),
  });
}

// ---------------------------------------------------------------- breakeven

/**
 * `r`, `eps`, `rho`, `k` and the three budgets.
 *
 * Definitions are taken from `docs/architecture.md` §8 as implemented in
 * `packages/telemetry/src/cost.ts`, and are mirrored here rather than imported
 * because `eval` depends on nothing (AGENTS.md §12.1):
 *
 * | | meaning | here |
 * |---|---|---|
 * | `r` | input token reduction fraction | `1 - treatment.in / control.in` |
 * | `eps` | output token expansion factor | `treatment.out / control.out` |
 * | `rho` | provider price ratio output:input | `out price / in price` |
 * | `k` | fraction of total spend on the input side | `in spend / total spend`, on the control |
 *
 * And the three budgets, which do not agree:
 *
 * ```text
 *   frozen  1 + (1-r)/(rho*k)      the frozen contract, packages/core-types/src/telemetry.ts
 *   exact   1 + r/(rho*O_c/I_c) = 1 + r*k/(1-k)     arithmetic, packages/telemetry/src/cost.ts
 *   net     1 + (r*I_c - overhead_equiv)/(rho*O_c)   what G7 is actually on
 * ```
 *
 * `rho` is already inside `k`, so the frozen rule divides by it *again*; the two
 * coincide at exactly one `r` per `(rho, k)` pair and disagree on a verdict
 * otherwise. E5 publishes all three rather than choosing, and sets
 * `grossNetDisagreement` when the frozen rule says a session is fine and the net
 * budget says it is a loss — which is the finding, not an inconsistency to be
 * smoothed over.
 *
 * Refusals are refusals, not fallbacks. A session with no control input has no
 * `r`; one with no control output has no `eps`; an unpriceable model has no
 * `rho`. Each returns `available: false` with a reason, and each of those makes
 * G7 `inconclusive` rather than `pass`.
 */
export interface E5Breakeven {
  readonly caseId: string;
  readonly available: boolean;
  readonly reason: string;
  readonly r: number | null;
  readonly eps: number | null;
  readonly rho: number | null;
  readonly k: number | null;
  /** Overhead expressed in control-input tokens, so the net budget is checkable. */
  readonly overheadInInputTokenEquivalents: number | null;
  readonly frozenBudget: number | null;
  readonly exactBudget: number | null;
  readonly netBudget: number | null;
  readonly frozenOk: boolean | null;
  readonly exactOk: boolean | null;
  readonly netOk: boolean | null;
  /**
   * The frozen rule clears this session's `eps` and the net budget does not.
   *
   * This is the case the whole three-budget design exists for: a session that
   * passes the contract's headline check while losing money.
   */
  readonly grossNetDisagreement: boolean;
  readonly note: string;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

const unavailableBreakeven = (caseId: string, reason: string): E5Breakeven =>
  Object.freeze({
    caseId,
    available: false,
    reason,
    r: null,
    eps: null,
    rho: null,
    k: null,
    overheadInInputTokenEquivalents: null,
    frozenBudget: null,
    exactBudget: null,
    netBudget: null,
    frozenOk: null,
    exactOk: null,
    netOk: null,
    grossNetDisagreement: false,
    note: `no breakeven verdict for ${caseId}: ${reason}`,
  });

export function e5Breakeven(
  caseId: string,
  control: E5Usage,
  treatment: E5Usage,
  overheadUsd: number,
  inputUsdPerMtok: number,
  outputUsdPerMtok: number,
  priceable: boolean,
): E5Breakeven {
  if (!priceable) {
    return unavailableBreakeven(caseId, 'the session is unpriceable, so rho is unknown');
  }
  if (control.inputTokens <= 0) {
    return unavailableBreakeven(caseId, 'the control sent no input tokens, so there is no r to reduce');
  }
  if (control.outputTokens <= 0) {
    return unavailableBreakeven(caseId, 'the control produced no output tokens, so eps is undefined');
  }
  if (!(inputUsdPerMtok > 0) || !(outputUsdPerMtok > 0)) {
    return unavailableBreakeven(
      caseId,
      `prices must both be positive (in $${inputUsdPerMtok}/Mtok, out $${outputUsdPerMtok}/Mtok)`,
    );
  }

  const r = 1 - treatment.inputTokens / control.inputTokens;
  const eps = treatment.outputTokens / control.outputTokens;
  const rho = outputUsdPerMtok / inputUsdPerMtok;
  const controlInUsd = (control.inputTokens * inputUsdPerMtok) / 1_000_000;
  const controlOutUsd = (control.outputTokens * outputUsdPerMtok) / 1_000_000;
  const k = controlInUsd / (controlInUsd + controlOutUsd);
  const overheadInInputTokenEquivalents = overheadUsd / (inputUsdPerMtok / 1_000_000);

  // k === 1 would mean the control spent nothing on output, already refused above.
  const frozenBudget = k <= 0 ? Number.POSITIVE_INFINITY : 1 + (1 - r) / (rho * k);
  const exactBudget = 1 + (r * k) / (1 - k);
  const netBudget = 1 + (r * control.inputTokens - overheadInInputTokenEquivalents) / (rho * control.outputTokens);

  const frozenOk = frozenBudget === Number.POSITIVE_INFINITY || eps < frozenBudget;
  const exactOk = eps < exactBudget;
  const netOk = eps < netBudget;
  const grossNetDisagreement = frozenOk && !netOk;

  const note = grossNetDisagreement
    ? `${caseId}: the frozen rule (${round4(frozenBudget)}) clears eps=${round4(eps)} but the net budget ` +
      `(${round4(netBudget)}) does not -- ${round4(overheadInInputTokenEquivalents)} input-token-equivalents ` +
      'of overhead exceed what the input saving was worth'
    : `${caseId}: r=${round4(r)} eps=${round4(eps)} rho=${round4(rho)} k=${round4(k)}; budgets frozen ` +
      `${round4(frozenBudget)} exact ${round4(exactBudget)} net ${round4(netBudget)}`;

  return Object.freeze({
    caseId,
    available: true,
    reason: '',
    r: round4(r),
    eps: round4(eps),
    rho: round4(rho),
    k: round4(k),
    overheadInInputTokenEquivalents: round4(overheadInInputTokenEquivalents),
    frozenBudget: round4(frozenBudget),
    exactBudget: round4(exactBudget),
    netBudget: round4(netBudget),
    frozenOk,
    exactOk,
    netOk,
    grossNetDisagreement,
    note,
  });
}

/**
 * The session size at which net saving crosses zero, analytically.
 *
 * Net per unit of input price is
 *
 * ```text
 *   in*r  -  rho*O_c*(eps-1)  -  overheadInInputTokenEquivalents
 * ```
 *
 * and the suite's model is that **overhead scales with the input, at the rate
 * this session measured, while the answer stays the same size** — a longer
 * session is more history for the same question. Writing `p` for the measured
 * overhead per input token, `p = equiv / I_c`, net is zero at
 *
 * ```text
 *   I* = rho*O_c*(eps-1) / (r - p)
 * ```
 *
 * which needs `r > p`. When `r <= p` there is no crossover: the input saved per
 * token never exceeds what computing that saving cost per token, so the
 * intervention is underwater at *every* session size and grows worse with size.
 * That is a different and stronger finding than a large `I*`, so it is reported
 * as `analyticCrosses: false` rather than as a large number or as `null`.
 *
 * The earlier form of this, `equiv / r`, is the special case `eps = 1` and is
 * wrong whenever the treatment makes the model more verbose — which is the
 * entire situation the frozen contract exists to catch.
 */
export const e5AnalyticCrossover = (
  breakeven: E5Breakeven,
  controlInputTokens: number,
  controlOutputTokens: number,
): number | null => {
  if (!breakeven.available) return null;
  if (breakeven.r === null || breakeven.rho === null || breakeven.eps === null) return null;
  if (breakeven.overheadInInputTokenEquivalents === null) return null;
  if (controlInputTokens <= 0 || controlOutputTokens <= 0) return null;
  const overheadPerInputToken = breakeven.overheadInInputTokenEquivalents / controlInputTokens;
  const denominator = breakeven.r - overheadPerInputToken;
  if (!(denominator > 0)) return null;
  const numerator = breakeven.rho * controlOutputTokens * (breakeven.eps - 1);
  return numerator / denominator;
};

/** The measured overhead per input token, which is the `p` above. */
export const e5OverheadPerInputToken = (breakeven: E5Breakeven, controlInputTokens: number): number | null =>
  breakeven.available && breakeven.overheadInInputTokenEquivalents !== null && controlInputTokens > 0
    ? breakeven.overheadInInputTokenEquivalents / controlInputTokens
    : null;

export interface E5Crossover {
  /** Control input size at which the measured net crosses zero, interpolated. */
  readonly measuredInputTokens: number | null;
  /** The two sessions the interpolation is between, for auditing the shape. */
  readonly bracket: readonly [number, number] | null;
  /** `rho*O_c*(eps-1) / (r - overheadPerInputToken)` for this session. */
  readonly analyticInputTokens: number | null;
  /**
   * False when `r` does not exceed the measured overhead per input token.
   *
   * A separate outcome from "the crossover is very large": there is no
   * crossover at all, the intervention is underwater at every session size, and
   * it gets worse as sessions grow.
   */
  readonly analyticCrosses: boolean;
  /** The measured overhead per input token, `equiv / I_c`. */
  readonly overheadPerInputToken: number | null;
  /** What the product ships. Mirrors `docs/integrations.md`. */
  readonly shippedMinTokens: number;
  /** The analytic crossover is below where the product actually turns on. */
  readonly analyticBelowShippedThreshold: boolean | null;
  /** Interpolated or analytic, whichever is available. */
  readonly bestEstimateInputTokens: number | null;
  readonly note: string;
}

/** Interpolate the sign change in net across sessions ordered by input size. */
export function e5MeasuredCrossover(
  points: readonly (readonly [controlInputTokens: number, netSavedUsd: number])[],
): { inputTokens: number; bracket: readonly [number, number] } | null {
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < sorted.length; i += 1) {
    const low = sorted[i - 1];
    const high = sorted[i];
    if (low === undefined || high === undefined) continue;
    const lowNet = low[1];
    const highNet = high[1];
    if (lowNet === 0) return { inputTokens: low[0], bracket: Object.freeze([low[0], high[0]] as const) };
    // A strict sign change, or a rise to exactly zero. Anything else is a
    // monotone run and contributes no crossing.
    if (lowNet < 0 !== highNet < 0 || highNet === 0) {
      if (lowNet === highNet) continue;
      const t = (0 - lowNet) / (highNet - lowNet);
      return {
        inputTokens: Math.round(low[0] + t * (high[0] - low[0])),
        bracket: Object.freeze([low[0], high[0]] as const),
      };
    }
  }
  return null;
}

// -------------------------------------------------------------- the measures

/**
 * One (case, control, treatment) triple, as the summaries consume it.
 *
 * Built only from sessions whose closure was complete. A session whose bill
 * does not add up has no honest `r`, `eps` or net, so including it would put a
 * fabricated number in a median -- and a median is exactly where a fabricated
 * number hides best. The excluded cases are counted and named in
 * `E5RunResult.incomplete`, never quietly dropped.
 */
export interface E5PairedObservation {
  readonly caseId: string;
  readonly taskType: E5TaskType;
  readonly outputFormat: E5OutputFormat;
  readonly model: string;
  readonly control: E5Usage;
  readonly treatment: E5Usage;
  readonly controlLatencyMs: number;
  readonly treatmentLatencyMs: number;
  readonly controlCache: E5CacheCounters;
  readonly treatmentCache: E5CacheCounters;
  readonly trap: E5Trap | null;
}

const medianOf = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const mid = n >> 1;
  const upper = sorted[mid];
  const lower = sorted[n % 2 === 0 ? mid - 1 : mid];
  if (upper === undefined || lower === undefined) return Number.NaN;
  return (upper + lower) / 2;
};

const quantile = (values: readonly number[], probability: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, probability);
};

/**
 * `n` below which a median is thin, and is reported as thin rather than as
 * precise. E5's corpus is small by design -- the point is to straddle the
 * 5000-token crossover, not to have a sample size -- and a median over six
 * sessions is a description, not an estimate.
 */
export const E5_THIN_N = 8;

export interface E5Interval {
  readonly n: number;
  readonly point: number;
  readonly lower: number;
  readonly upper: number;
  readonly alpha: number;
  readonly resamples: number;
  readonly seed: number;
  readonly method: 'paired-percentile-bootstrap';
  readonly thin: boolean;
  readonly note: string;
}

export interface E5BootstrapOptions {
  readonly alpha?: number;
  readonly resamples?: number;
  readonly seed?: number;
}

/**
 * Paired percentile bootstrap of the **median** difference, on continuous pairs.
 *
 * ## Why this is not `pairedBootstrap` from `../statistics.js`
 *
 * That function is deliberately binary — its pairs are `boolean | 'pass' |
 * 'fail'`, it `asPass`es each side to 0/1, and its difference is therefore in
 * `{-1, 0, 1}`. E5's pairs are token counts and dollar figures, so a binary
 * difference is not a rounding question but the wrong statistic: it would
 * quantise `r = 0.30` and `r = 0.28` to the same thing and report the interval
 * on a quantity nobody asked about.
 *
 * The resampling machinery is the same and is reproduced rather than imported
 * for the same reason the pricing table is mirrored (AGENTS.md §12.1): the
 * measuring apparatus must not be able to drift with the thing it measures.
 * Pairs are resampled **as units**, never the two arms independently, so the
 * case-to-case difficulty cancels -- which is the whole reason the runner
 * interleaves the arms per case in the first place.
 *
 * Draws come from `unitValue(seed, key)`, the same deterministic hash the mock
 * arm and the runner's shuffle use, so the interval is reproducible byte for
 * byte without a PRNG and without a clock (G11).
 *
 * **TODO(WS-F, F2):** widen `pairedBootstrap` to accept continuous pairs and
 * delete this. Until then the two implementations must be kept in agreement by
 * hand, and this comment is the record of that.
 */
export function e5PairedMedianInterval(
  control: readonly number[],
  treatment: readonly number[],
  options: E5BootstrapOptions = {},
): E5Interval {
  const alpha = options.alpha ?? DEFAULT_ALPHA;
  const resamples = options.resamples ?? DEFAULT_BOOTSTRAP_RESAMPLES;
  const seed = options.seed ?? DEFAULT_BOOTSTRAP_SEED;
  const n = control.length;

  if (control.length !== treatment.length) {
    throw new RangeError(
      `e5: paired series must be the same length, got control ${control.length} and treatment ${treatment.length}`,
    );
  }
  if (!Number.isInteger(resamples) || resamples < 1) {
    throw new RangeError(`e5: resamples must be an integer >= 1, got ${resamples}`);
  }
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new RangeError(`e5: alpha must lie in (0, 1), got ${alpha}`);
  }

  const differences: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const difference = (treatment[i] ?? 0) - (control[i] ?? 0);
    if (!Number.isFinite(difference)) {
      throw new RangeError(`e5: pair ${i} produced a non-finite difference`);
    }
    differences.push(difference);
  }

  if (n === 0) {
    return Object.freeze({
      n: 0,
      point: Number.NaN,
      lower: Number.NaN,
      upper: Number.NaN,
      alpha,
      resamples,
      seed,
      method: 'paired-percentile-bootstrap' as const,
      thin: true,
      note: 'no pairs, so there is no interval to report; this is not the same as an interval of zero',
    });
  }

  const medians: number[] = [];
  for (let b = 0; b < resamples; b += 1) {
    const draw: number[] = [];
    for (let i = 0; i < n; i += 1) {
      draw.push(differences[Math.floor(unitValue(seed, `e5|bootstrap|${b}|${i}`) * n)] ?? 0);
    }
    medians.push(medianOf(draw));
  }
  medians.sort((a, b) => a - b);
  const lower = percentile(medians, alpha / 2);
  const upper = percentile(medians, 1 - alpha / 2);
  const point = medianOf(differences);
  const thin = n < E5_THIN_N;
  return Object.freeze({
    n,
    point: round4(point),
    lower: round4(lower),
    upper: round4(upper),
    alpha,
    resamples,
    seed,
    method: 'paired-percentile-bootstrap' as const,
    thin,
    note: thin
      ? `median of ${n} paired differences, resampled ${resamples}×; n=${n} is below ${E5_THIN_N}, so read ` +
        'this as a description of these sessions rather than an estimate of a population'
      : `median of ${n} paired differences, resampled ${resamples}×`,
  });
}

/** Input reduction `r = 1 - treatment.in/control.in`, per session. */
export const e5InputReduction = (observation: E5PairedObservation): number | null =>
  observation.control.inputTokens <= 0
    ? null
    : 1 - observation.treatment.inputTokens / observation.control.inputTokens;

/** Output expansion `eps = treatment.out/control.out`, per session. */
export const e5OutputExpansion = (observation: E5PairedObservation): number | null =>
  observation.control.outputTokens <= 0 ? null : observation.treatment.outputTokens / observation.control.outputTokens;

/**
 * Percentile interval on the median of one series, resampling **units**.
 *
 * Distinct from `e5PairedMedianInterval` on purpose. A per-session ratio like
 * `r = 1 - treatment.in/control.in` is already a paired quantity — the pairing
 * happened when the ratio was formed — so there is no second series to
 * difference. Resampling the `r` values as units is the correct instrument, and
 * differencing them against anything would be arithmetic on a statistic.
 */
export function e5MedianInterval(values: readonly number[], options: E5BootstrapOptions = {}): E5Interval {
  const alpha = options.alpha ?? DEFAULT_ALPHA;
  const resamples = options.resamples ?? DEFAULT_BOOTSTRAP_RESAMPLES;
  const seed = options.seed ?? DEFAULT_BOOTSTRAP_SEED;
  const n = values.length;
  if (!Number.isInteger(resamples) || resamples < 1) {
    throw new RangeError(`e5: resamples must be an integer >= 1, got ${resamples}`);
  }
  if (n === 0) {
    return Object.freeze({
      n: 0,
      point: Number.NaN,
      lower: Number.NaN,
      upper: Number.NaN,
      alpha,
      resamples,
      seed,
      method: 'paired-percentile-bootstrap' as const,
      thin: true,
      note: 'no values, so there is no interval to report; this is not the same as an interval of zero',
    });
  }
  const medians: number[] = [];
  for (let b = 0; b < resamples; b += 1) {
    const draw: number[] = [];
    for (let i = 0; i < n; i += 1) {
      draw.push(values[Math.floor(unitValue(seed, `e5|median|${b}|${i}`) * n)] ?? 0);
    }
    medians.push(medianOf(draw));
  }
  medians.sort((a, b) => a - b);
  const thin = n < E5_THIN_N;
  return Object.freeze({
    n,
    point: round4(medianOf(values)),
    lower: round4(percentile(medians, alpha / 2)),
    upper: round4(percentile(medians, 1 - alpha / 2)),
    alpha,
    resamples,
    seed,
    method: 'paired-percentile-bootstrap' as const,
    thin,
    note: thin
      ? `median of ${n} values, resampled ${resamples}×; n=${n} is below ${E5_THIN_N}, so read this as a ` +
        'description of these sessions rather than an estimate of a population'
      : `median of ${n} values, resampled ${resamples}×`,
  });
}

export interface E5ReductionSummary {
  readonly n: number;
  readonly median: number;
  /** Q1 and Q3 of the per-session reductions. */
  readonly iqr: readonly [number, number];
  /**
   * Interval on the median **reduction fraction**.
   *
   * `r` is a per-session ratio, so this is a single-series interval over units
   * of `r` — not a difference of two series, which is what `tokenInterval` is.
   * The two are in different units and are never combined.
   */
  readonly fractionInterval: E5Interval;
  /** Interval on the median `control.input - treatment.input`, in tokens. */
  readonly tokenInterval: E5Interval;
  readonly thin: boolean;
  readonly note: string;
}

/**
 * Flip an interval's sign, and nothing else.
 *
 * `e5PairedMedianInterval` differences as `treatment - control`, which is the
 * right convention for a *cost* — more tokens, more latency, more money — and
 * the wrong one for a *saving*. The token interval is documented as tokens saved
 * and sits beside a median reduction that is also a saving, so the sign is
 * flipped here rather than left to the reader: a report that prints a negative
 * "tokens saved" next to a positive `r` is read as a regression.
 *
 * Endpoints swap with the sign, and the lower bound is recomputed as the smaller
 * of the two rather than assumed, so the interval stays ordered.
 */
const negateInterval = (interval: E5Interval): E5Interval => {
  const a = -interval.point;
  const b = -interval.lower;
  const c = -interval.upper;
  return Object.freeze({
    ...interval,
    point: a,
    lower: Math.min(b, c),
    upper: Math.max(b, c),
  });
};

/** docs/evaluation.md §E5 requires the distribution, not just the median. */
export function e5ReductionSummary(
  observations: readonly E5PairedObservation[],
  options: E5BootstrapOptions = {},
): E5ReductionSummary {
  const control: number[] = [];
  const treatment: number[] = [];
  const reductions: number[] = [];
  for (const observation of observations) {
    const r = e5InputReduction(observation);
    if (r === null) continue;
    control.push(observation.control.inputTokens);
    treatment.push(observation.treatment.inputTokens);
    reductions.push(r);
  }
  const q1 = quantile(reductions, 0.25);
  const q3 = quantile(reductions, 0.75);
  const median = reductions.length === 0 ? Number.NaN : medianOf(reductions);
  const n = reductions.length;
  return Object.freeze({
    n,
    median: round4(median),
    iqr: Object.freeze([round4(q1 ?? Number.NaN), round4(q3 ?? Number.NaN)] as const),
    fractionInterval: e5MedianInterval(reductions, options),
    tokenInterval: negateInterval(e5PairedMedianInterval(control, treatment, options)),
    thin: n < E5_THIN_N,
    note:
      n === 0
        ? 'no session had control input tokens, so reduction is unmeasured rather than zero'
        : `input reduction over ${n} session(s): median ${round4(median)}, IQR ` +
          `[${round4(q1 ?? Number.NaN)}, ${round4(q3 ?? Number.NaN)}]`,
  });
}

export interface E5EpsStratum {
  readonly taskType: E5TaskType;
  readonly outputFormat: E5OutputFormat;
  readonly n: number;
  readonly medianEps: number;
  readonly maxEps: number;
  readonly minEps: number;
  /** Sessions in this stratum clearing the frozen budget. */
  readonly sessionsClearingFrozen: number;
  /** Sessions in this stratum clearing the net budget. */
  readonly sessionsClearingNet: number;
  /** Sessions where the two disagree. The finding, not an inconsistency. */
  readonly disagreements: number;
  readonly thin: boolean;
  readonly note: string;
}

/**
 * `eps` over `(taskType, outputFormat)`.
 *
 * The stratification is the requirement: a suite that reports one pooled `eps`
 * lets an output-heavy format hide inside an average dominated by short answers,
 * and §8's whole claim is that the output budget is workload-dependent.
 */
export function e5EpsStrata(
  observations: readonly E5PairedObservation[],
  breakevens: readonly E5Breakeven[],
): readonly E5EpsStratum[] {
  const breakevenByCase = new Map(breakevens.map((b) => [b.caseId, b]));
  const keys = new Map<string, { taskType: E5TaskType; outputFormat: E5OutputFormat; items: E5PairedObservation[] }>();
  for (const observation of observations) {
    const key = `${observation.taskType}|${observation.outputFormat}`;
    const bucket = keys.get(key);
    if (bucket === undefined) keys.set(key, { taskType: observation.taskType, outputFormat: observation.outputFormat, items: [observation] });
    else bucket.items.push(observation);
  }

  return Object.freeze(
    [...keys.values()]
      .sort((a, b) => a.taskType.localeCompare(b.taskType) || a.outputFormat.localeCompare(b.outputFormat))
      .map((bucket): E5EpsStratum => {
        const epsValues = bucket.items
          .map(e5OutputExpansion)
          .filter((value): value is number => value !== null);
        const n = epsValues.length;
        let clearingFrozen = 0;
        let clearingNet = 0;
        let disagreements = 0;
        for (const observation of bucket.items) {
          const breakeven = breakevenByCase.get(observation.caseId);
          if (breakeven?.frozenOk === true) clearingFrozen += 1;
          if (breakeven?.netOk === true) clearingNet += 1;
          if (breakeven?.grossNetDisagreement === true) disagreements += 1;
        }
        return Object.freeze({
          taskType: bucket.taskType,
          outputFormat: bucket.outputFormat,
          n,
          medianEps: n === 0 ? Number.NaN : round4(medianOf(epsValues)),
          maxEps: n === 0 ? Number.NaN : round4(Math.max(...epsValues)),
          minEps: n === 0 ? Number.NaN : round4(Math.min(...epsValues)),
          sessionsClearingFrozen: clearingFrozen,
          sessionsClearingNet: clearingNet,
          disagreements,
          thin: n < E5_THIN_N,
          note:
            `${bucket.taskType}/${bucket.outputFormat}: ${n} session(s), median eps ` +
            `${n === 0 ? 'unmeasured' : round4(medianOf(epsValues))}; ${clearingFrozen} clear the frozen budget, ` +
            `${clearingNet} clear the net budget`,
        });
      }),
  );
}

export interface E5LatencySummary {
  readonly n: number;
  readonly controlP50Ms: number | null;
  readonly controlP95Ms: number | null;
  readonly treatmentP50Ms: number | null;
  readonly treatmentP95Ms: number | null;
  /** `treatment - control` per session. The quantity G8 is actually on. */
  readonly overheadP50Ms: number | null;
  readonly overheadP95Ms: number | null;
  /** Sessions where the treatment was faster. A negative overhead is possible. */
  readonly sessionsFaster: number;
  readonly thin: boolean;
  readonly note: string;
}

/**
 * G8, on the **paired** difference.
 *
 * The overhead is computed per session before any quantile is taken, so a
 * machine that was busy for two of twelve cases moves two differences rather
 * than both arms' p95s. Comparing two independent p95s would charge the
 * treatment arm for the whole distribution, and would make G8 a measurement of
 * the machine.
 */
export function e5LatencySummary(observations: readonly E5PairedObservation[]): E5LatencySummary {
  const control = observations.map((observation) => observation.controlLatencyMs);
  const treatment = observations.map((observation) => observation.treatmentLatencyMs);
  const overhead = observations.map((observation) => observation.treatmentLatencyMs - observation.controlLatencyMs);
  const n = observations.length;
  const overheadP95 = quantile(overhead, 0.95);
  return Object.freeze({
    n,
    controlP50Ms: round2OrNull(quantile(control, 0.5)),
    controlP95Ms: round2OrNull(quantile(control, 0.95)),
    treatmentP50Ms: round2OrNull(quantile(treatment, 0.5)),
    treatmentP95Ms: round2OrNull(quantile(treatment, 0.95)),
    overheadP50Ms: round2OrNull(quantile(overhead, 0.5)),
    overheadP95Ms: round2OrNull(overheadP95),
    sessionsFaster: overhead.filter((value) => value < 0).length,
    thin: n < E5_THIN_N,
    note:
      n === 0
        ? 'no sessions, so latency overhead is unmeasured'
        : `paired overhead p50 ${round2OrNull(quantile(overhead, 0.5)) ?? 'n/a'}ms, p95 ` +
          `${round2OrNull(overheadP95) ?? 'n/a'}ms over ${n} session(s); G8 ceiling is ` +
          `${G8_P95_LATENCY_OVERHEAD_CEILING_MS}ms`,
  });
}

const round2OrNull = (value: number | null): number | null =>
  value === null || !Number.isFinite(value) ? null : Math.round(value * 100) / 100;

export interface E5CacheSummary {
  readonly prefixLookups: number;
  readonly prefixHits: number;
  readonly transforms: number;
  readonly prefixInvalidated: number;
  /** `prefixHits / prefixLookups`, or null when nothing was looked up. */
  readonly hitRate: number | null;
  /** `prefixInvalidated / transforms`, or null when nothing was transformed. */
  readonly invalidationRate: number | null;
  /** Hit rate over transforms that did *not* invalidate, for contrast. */
  readonly hitRateWhenPreserved: number | null;
  readonly note: string;
}

/**
 * G12, plus the hit rate that gives it meaning.
 *
 * A high invalidation rate is a cost figure, not a cache figure: every
 * invalidated prefix is re-billed at full input price on every later turn, so
 * the saving E5 booked is handed back by the provider's cache. docs/decisions.md
 * R4 is the risk; this is its measurement.
 */
export function e5CacheSummary(observations: readonly E5PairedObservation[]): E5CacheSummary {
  const totals = { prefixLookups: 0, prefixHits: 0, transforms: 0, prefixInvalidated: 0 };
  let preservedLookups = 0;
  let preservedHits = 0;
  for (const observation of observations) {
    for (const cache of [observation.controlCache, observation.treatmentCache]) {
      totals.prefixLookups += cache.prefixLookups;
      totals.prefixHits += cache.prefixHits;
      totals.transforms += cache.transforms;
      totals.prefixInvalidated += cache.prefixInvalidated;
    }
    const preservedTransforms = observation.treatmentCache.transforms - observation.treatmentCache.prefixInvalidated;
    const preserved = Math.max(0, preservedTransforms);
    preservedLookups += preserved;
    preservedHits += Math.min(observation.treatmentCache.prefixHits, preserved);
  }
  const invalidationRate =
    totals.transforms === 0 ? null : round4(totals.prefixInvalidated / totals.transforms);
  return Object.freeze({
    ...totals,
    hitRate: totals.prefixLookups === 0 ? null : round4(totals.prefixHits / totals.prefixLookups),
    invalidationRate,
    hitRateWhenPreserved: preservedLookups === 0 ? null : round4(preservedHits / preservedLookups),
    note:
      `prefix hit rate ${totals.prefixLookups === 0 ? 'n/a' : round4(totals.prefixHits / totals.prefixLookups)}, ` +
      `invalidation ${totals.prefixInvalidated}/${totals.transforms} ` +
      `(${invalidationRate === null ? 'n/a' : invalidationRate}); G12 ceiling is ` +
      `${G12_PREFIX_INVALIDATION_CEILING}`,
  });
}

export interface E5WorstQuartile {
  /** Sessions considered. */
  readonly n: number;
  /** `ceil(n/4)`, floored at 1. */
  readonly quartileSize: number;
  /** The bottom quartile by net saving fraction. */
  readonly worstNetFractionMedian: number;
  readonly worstNetFractionMax: number;
  /** The bottom quartile by input reduction, reported separately (§E5 anti-cherry-picking). */
  readonly worstInputReductionMedian: number;
  readonly worstInputReductionMin: number;
  readonly sessionsClearingFrozen: number;
  readonly sessionsClearingNet: number;
  /** The session with the least net headroom, by name. */
  readonly worstSessionId: string;
  readonly thin: boolean;
  readonly note: string;
}

/**
 * The worst quartile, by net saving and by input reduction, separately.
 *
 * §E5's anti-cherry-picking rule, and it is a rule about *this* file: an
 * aggregate net that clears G7 while the bottom quartile is underwater is a
 * number that would not survive review, and the only defence is to print the
 * bottom quartile every time. Two quartiles, not one, because they can select
 * different sessions — an arm can hold median reduction up while losing money
 * on its short sessions, and averaging the two rankings would hide exactly that.
 */
export function e5WorstQuartile(
  observations: readonly E5PairedObservation[],
  netFractions: ReadonlyMap<string, number>,
  breakevens: readonly E5Breakeven[],
): E5WorstQuartile {
  const breakevenByCase = new Map(breakevens.map((b) => [b.caseId, b]));
  const n = observations.length;
  const quartileSize = n === 0 ? 0 : Math.max(1, Math.ceil(n / 4));

  const byNet = observations
    .filter((observation) => netFractions.has(observation.caseId))
    .map((observation) => ({ observation, net: netFractions.get(observation.caseId) ?? 0 }))
    .sort((a, b) => a.net - b.net);
  const byReduction = observations
    .map((observation) => ({ observation, r: e5InputReduction(observation) }))
    .filter((entry): entry is { observation: E5PairedObservation; r: number } => entry.r !== null)
    .sort((a, b) => a.r - b.r);

  const netWorst = byNet.slice(0, quartileSize);
  const reductionWorst = byReduction.slice(0, quartileSize);
  const netValues = netWorst.map((entry) => entry.net);
  const reductionValues = reductionWorst.map((entry) => entry.r);
  const worstSession = byNet[0];

  let clearingFrozen = 0;
  let clearingNet = 0;
  for (const observation of observations) {
    const breakeven = breakevenByCase.get(observation.caseId);
    if (breakeven?.frozenOk === true) clearingFrozen += 1;
    if (breakeven?.netOk === true) clearingNet += 1;
  }

  const worstSessionId = worstSession?.observation.caseId ?? '';
  return Object.freeze({
    n,
    quartileSize,
    worstNetFractionMedian: netValues.length === 0 ? Number.NaN : round4(medianOf(netValues)),
    worstNetFractionMax: netValues.length === 0 ? Number.NaN : round4(Math.max(...netValues)),
    worstInputReductionMedian: reductionValues.length === 0 ? Number.NaN : round4(medianOf(reductionValues)),
    worstInputReductionMin: reductionValues.length === 0 ? Number.NaN : round4(Math.min(...reductionValues)),
    sessionsClearingFrozen: clearingFrozen,
    sessionsClearingNet: clearingNet,
    worstSessionId,
    thin: n < E5_THIN_N,
    note:
      n === 0
        ? 'no sessions, so the worst quartile is unmeasured'
        : `bottom ${quartileSize} of ${n} session(s): net fraction median ` +
          `${netValues.length === 0 ? 'n/a' : round4(medianOf(netValues))}, input reduction median ` +
          `${reductionValues.length === 0 ? 'n/a' : round4(medianOf(reductionValues))}; ` +
          `${clearingFrozen} session(s) clear the frozen budget and ${clearingNet} clear the net budget; ` +
          `least headroom is ${worstSessionId || 'n/a'}`,
  });
}


// ------------------------------------------------------------ gate machinery

export interface E5GateVerdict {
  readonly gate: E5GateId;
  /** `inconclusive` is a real outcome, not a soft pass (docs/evaluation.md §4). */
  readonly status: 'observed' | 'not_observed' | 'inconclusive';
  readonly blocking: boolean;
  readonly statement: string;
  readonly detail: string;
  readonly observed: number | null;
  readonly threshold: number | null;
  readonly note: string;
}

export interface E5GateInput {
  readonly freshness: E5PricingFreshness;
  readonly aggregate: E5SessionSavings;
  readonly closures: readonly E5Closure[];
  readonly audits: readonly E5PriceAudit[];
  readonly latencies: E5LatencySummary;
  readonly cache: E5CacheSummary;
  readonly priceableSessions: number;
  readonly totalSessions: number;
}

/**
 * The four gates E5 reports: G6, G7, G8, G12.
 *
 * ## On two of these ids, which collide with docs/evaluation.md §5
 *
 * **G6** is the input-reduction floor in §5 — "G6: token compression achieves
 * at least 20% input token reduction on the E4 corpus" — and §E5 uses the same
 * id for pricing freshness. Both are real, they are different measurements, and
 * this file's G6 is the pricing one, because the floor belongs to E4's corpus
 * and E5 does not run it. The collision is reported here rather than resolved
 * by renaming, because renaming would break the reference in §E5 and the id is
 * what the document says.
 *
 * **Blocking** marks the two gates that withhold a release: G6, because a stale
 * price table makes every dollar figure in this report untrustworthy, and G7,
 * because the product's cost claim is G7 and nothing else. G8 and G12 are
 * reported as `blocking: false` and are real findings — a treatment that wins on
 * dollars while tripling p95 latency or destroying the prefix cache is not a
 * ship, but it is a *separate* argument, and folding latency into the cost gate
 * would make the cost gate unfalsifiable in the other direction.
 */
export function evaluateE5Gates(input: E5GateInput): readonly E5GateVerdict[] {
  const gates: E5GateVerdict[] = [];

  // ---- G6: the price table is fresh enough to quote
  const g6 = input.freshness.stale;
  gates.push(
    Object.freeze({
      gate: 'G6' as const,
      status: g6 ? ('not_observed' as const) : ('observed' as const),
      blocking: true,
      statement: 'Pricing is fresh enough to support a dollar verdict (90-day rule)',
      detail: input.freshness.message,
      observed: Number.isFinite(input.freshness.ageDays) ? input.freshness.ageDays : null,
      threshold: E5_PRICING_STALE_AFTER_DAYS,
      note: g6
        ? 'a stale price table silently turns a cost win into a cost loss, so no dollar or breakeven ' +
          'verdict is issued while this fails; refresh the table and re-run'
        : 'prices are current, so the dollar figures below are quotable',
    }),
  );

  // ---- G7: net saving, strictly positive
  const brokenClosures = input.closures.filter((closure) => !closure.complete);
  const brokenAudits = input.audits.filter((audit) => audit.costModelDisagrees);
  let g7Status: E5GateVerdict['status'];
  let g7Detail: string;
  if (g6) {
    g7Status = 'inconclusive';
    g7Detail = 'withheld: the price table is stale, so net cannot be computed from these numbers';
  } else if (brokenClosures.length > 0) {
    g7Status = 'inconclusive';
    g7Detail =
      `withheld: ${brokenClosures.length} session(s) do not close, leaving ` +
      `${e5UnattributedTokens(brokenClosures)} unattributed token(s); ` +
      `${brokenClosures[0]?.note ?? ''}. A bill that does not add up cannot be netted, and a net that ` +
      'ignores the unattributed part is a net that chose its own denominator';
  } else if (brokenAudits.length > 0) {
    g7Status = 'inconclusive';
    g7Detail =
      `withheld: the cost model and the pricing table price the same tokens differently; ` +
      `${brokenAudits[0]?.note ?? ''}`;
  } else if (input.priceableSessions === 0) {
    // The dangerous one. Zero priced sessions sums to a net of exactly 0, and 0
    // is not above a floor of 0, so without this branch a run where every arm
    // errored would report G7 as a *fail* of a gate it never measured — and a
    // fail invites a fix, while the truth is that there was nothing to fix.
    g7Status = 'inconclusive';
    g7Detail =
      `withheld: none of the ${input.totalSessions} session(s) produced a priceable bill, so net is 0 ` +
      'because nothing was measured, not because the run was free';
  } else if (!input.aggregate.priceable) {
    g7Status = 'inconclusive';
    g7Detail = `withheld: ${input.aggregate.pricingNote}; an unpriceable model is not a free model`;
  } else {
    const pass = input.aggregate.netSavedUsd > G7_NET_SAVINGS_FLOOR_USD;
    g7Status = pass ? 'observed' : 'not_observed';
    g7Detail = pass
      ? `net saved $${input.aggregate.netSavedUsd.toFixed(6)} across ${input.priceableSessions} priced ` +
        `session(s), above the $${G7_NET_SAVINGS_FLOOR_USD.toFixed(6)} floor; gross was ` +
        `$${input.aggregate.grossSavedUsd.toFixed(6)} and overhead cost ` +
        `$${input.aggregate.overheadUsd.toFixed(6)}`
      : `net is $${input.aggregate.netSavedUsd.toFixed(6)}, not above the ` +
        `$${G7_NET_SAVINGS_FLOOR_USD.toFixed(6)} floor: gross saved ` +
        `$${input.aggregate.grossSavedUsd.toFixed(6)} and overhead cost ` +
        `$${input.aggregate.overheadUsd.toFixed(6)}`;
  }
  gates.push(
    Object.freeze({
      gate: 'G7' as const,
      status: g7Status,
      blocking: true,
      statement: 'Net cost reduction > $0 after gist and probe cost',
      detail: g7Detail,
      // Null whenever the verdict is withheld, not only when the aggregate is
      // unpriceable. A bill that does not close still has an arithmetic net, and
      // publishing it beside "inconclusive" is how a withheld number gets quoted
      // as a measured one -- the reader takes the figure and drops the status.
      observed: g7Status === 'inconclusive' ? null : input.aggregate.netSavedUsd,
      threshold: G7_NET_SAVINGS_FLOOR_USD,
      note:
        input.aggregate.priceable && input.aggregate.netSavedUsd <= G7_NET_SAVINGS_FLOOR_USD
          ? `overhead by category (USD): ${E5_SPEND_CATEGORIES.map(
              (category) => `${category} $${input.aggregate.overheadUsdByCategory[category].toFixed(6)}`,
            ).join(', ')}`
          : 'gross and net are both reported; G7 is on net, and the gross figure is the one a dashboard would show',
    }),
  );

  // ---- G8: paired p95 latency overhead
  const overheadP95 = input.latencies.overheadP95Ms;
  gates.push(
    Object.freeze({
      gate: 'G8' as const,
      status:
        overheadP95 === null
          ? ('inconclusive' as const)
          : overheadP95 < G8_P95_LATENCY_OVERHEAD_CEILING_MS
            ? ('observed' as const)
            : ('not_observed' as const),
      blocking: false,
      statement: 'Paired p95 latency overhead stays under 50ms',
      detail: input.latencies.note,
      observed: overheadP95,
      threshold: G8_P95_LATENCY_OVERHEAD_CEILING_MS,
      note:
        'the overhead is differenced per session before quantiling, so a busy machine moves two ' +
        'differences rather than both arms' + "'" + ' p95s',
    }),
  );

  // ---- G12: prefix invalidation
  const invalidationRate = input.cache.invalidationRate;
  gates.push(
    Object.freeze({
      gate: 'G12' as const,
      status:
        invalidationRate === null
          ? ('inconclusive' as const)
          : invalidationRate < G12_PREFIX_INVALIDATION_CEILING
            ? ('observed' as const)
            : ('not_observed' as const),
      blocking: false,
      statement: 'Fewer than 5% of transforms invalidate a reusable prompt prefix',
      detail: input.cache.note,
      observed: invalidationRate,
      threshold: G12_PREFIX_INVALIDATION_CEILING,
      note:
        'every invalidated prefix is re-billed at full input price on each later turn (docs/decisions.md ' +
        'R4), so this is a cost gate dressed as a cache metric',
    }),
  );

  return Object.freeze(gates);
}

// -------------------------------------------------------- negative controls

/**
 * E5's own negative controls.
 *
 * Two detectors, and a control only counts as fired when **both** agree. The
 * harness's detector is the one in `../runner.js`: did the arm drop a declared
 * pinned constraint. E5's is independent of the arm entirely — did the money
 * come out wrong. Requiring corroboration is stricter than either check alone
 * and it catches the failure that matters: a detector that fires for a reason
 * unrelated to the trap has been measuring something else, and a suite that
 * cannot tell the difference between "the trap worked" and "the instrument was
 * broken" is not a negative control at all.
 *
 * `corroborated: false` with one side having fired is therefore reported as
 * loudly as a trap that did not fire, because it means an instrument is
 * miscalibrated.
 */
export interface E5NegativeControl {
  readonly caseId: string;
  readonly trap: E5Trap;
  /** The harness saw the arm drop a declared constraint. */
  readonly harnessFired: boolean;
  /** E5's own cost detector saw the accounting fail. */
  readonly e5Fired: boolean;
  /** Both. Only this counts as fired. */
  readonly fired: boolean;
  readonly e5Detail: string;
  readonly note: string;
}

export const e5TrapExpectation = (trap: E5Trap): string =>
  trap === 'net_trap'
    ? 'net saving must not be positive'
    : 'the bill must not close, or the price audit must disagree';

// ------------------------------------------------------------- the arm runner

export interface E5RecordedMeasurement {
  readonly caseId: string;
  readonly arm: E5Arm;
  readonly position: number;
  readonly session: E5Session;
  readonly measurement: E5Measurement;
}

export interface E5ArmRunnerHandle {
  /** Pass to `runSuite` as `runArm`. */
  readonly run: SyncArmRunner;
  /**
   * What each arm returned, kept so the accounting is done a second time from
   * the arm's own numbers rather than from the report's summary of them.
   */
  readonly recorded: () => readonly E5RecordedMeasurement[];
}

/** The control's bill, derived by the suite. Not reportable by an arm. */
export const e5ControlUsage = (workload: E5Workload): E5Usage =>
  Object.freeze({ inputTokens: workload.baselineInputTokens, outputTokens: workload.baselineOutputTokens });

/**
 * Adapt an injected strategy to the harness's `ArmRunner`.
 *
 * Two things happen here that are worth stating plainly, because both are ways
 * a cost suite gets to report whatever it likes:
 *
 * 1. **The control arm is checked against the corpus, not trusted.** The
 *    strategy is asked for a control measurement like any other, and then the
 *    suite verifies it is exactly the workload's uncompressed size with no
 *    overhead. An arm that reports a different control bill raises, because
 *    "the uncompressed cost of a fixed workload" has no honest reading in which
 *    it is negotiable — and a self-reported baseline is the cheapest way to
 *    manufacture a 90% saving, since the saving is a ratio.
 * 2. **The harness totals the bill, not the flattering subset.** `inputTokens`
 *    and `outputTokens` on the returned `ArmObservation` are the arm's `billed`
 *    figures, overhead included, so the shared `ArmTotals` in `RunReport` add up
 *    to what was actually spent.
 *
 * The pin is the arm's own declaration, and that is a real limitation rather than
 * a shortcut: the suite cannot see the product's context, only the telemetry it
 * emits. It is exactly why the E5-side detectors in `E5NegativeControl` are
 * independent of the pin — an arm that lies about keeping its pin can still be
 * caught on the money, and one that tells the truth can still be caught by the
 * harness.
 */
export function createE5ArmRunner(
  workloads: readonly E5Workload[] = E5_WORKLOADS,
  strategy: E5MeasurementStrategy,
): E5ArmRunnerHandle {
  const byCase = new Map(workloads.map((workload) => [workload.id, workload]));
  const log: E5RecordedMeasurement[] = [];

  const run = (invocation: Parameters<SyncArmRunner>[0]): ArmObservation => {
    const workload = byCase.get(invocation.case.id);
    if (workload === undefined) {
      throw new E5Error(
        `e5: case "${invocation.case.id}" has no workload; the fixture and the strategy must be built from ` +
          'the same corpus or the suite is billing a session that was never held',
      );
    }
    if (invocation.arm !== 'control' && invocation.arm !== 'treatment') {
      throw new E5Error(
        `e5: arm "${invocation.arm}" is not one of ${E5_ARMS.join(', ')}; see the module header on why ` +
          'control+ is not part of this suite',
      );
    }
    const arm: E5Arm = invocation.arm;
    const declaredPins = [...workload.pinIds].sort();
    const controlUsage = e5ControlUsage(workload);
    const session: E5Session = Object.freeze({
      caseId: workload.id,
      arm,
      position: invocation.position,
      model: workload.model,
      controlUsage,
      baselineInputTokens: workload.baselineInputTokens,
      baselineOutputTokens: workload.baselineOutputTokens,
      prompt: invocation.case.prompt,
      cache: emptyCache(),
    });

    const measurement = strategy(session);
    assertE5Measurement(measurement, session);

    const undeclared = measurement.retainedPins.filter((pinId) => !declaredPins.includes(pinId));
    if (undeclared.length > 0) {
      throw new E5Error(
        `e5: ${workload.id}/${arm} reports retaining pin(s) ${[...undeclared].sort().join(', ')} that the case ` +
          `does not declare; declared pins are ${declaredPins.join(', ')}`,
      );
    }
    const retained = declaredPins.filter((pinId) => measurement.retainedPins.includes(pinId));
    const dropped = declaredPins.filter((pinId) => !measurement.retainedPins.includes(pinId));

    if (arm === 'control') {
      const problems: string[] = [];
      if (measurement.overhead.length > 0) {
        problems.push(
          `reported ${measurement.overhead.length} overhead line(s); the control arm runs no transforms, so its ` +
            'overhead is structurally zero and a non-zero figure means the baseline was built to lose',
        );
      }
      if (
        measurement.treatment.inputTokens !== controlUsage.inputTokens ||
        measurement.treatment.outputTokens !== controlUsage.outputTokens
      ) {
        problems.push(
          `reported ${measurement.treatment.inputTokens}/${measurement.treatment.outputTokens} but the suite's ` +
            `control bill for this workload is ${controlUsage.inputTokens}/${controlUsage.outputTokens}`,
        );
      }
      if (
        measurement.billed.inputTokens !== controlUsage.inputTokens ||
        measurement.billed.outputTokens !== controlUsage.outputTokens
      ) {
        problems.push(
          `billed ${measurement.billed.inputTokens}/${measurement.billed.outputTokens} but the suite's control ` +
            `bill is ${controlUsage.inputTokens}/${controlUsage.outputTokens}`,
        );
      }
      if (problems.length > 0) {
        throw new E5Error(
          `e5: ${workload.id}/control disagrees with the suite's own baseline, which is the one thing in this ` +
            `suite that is not negotiable: ${problems.join('; ')}`,
        );
      }
    }

    const overheadUsage = measurement.overhead.reduce((sum, line) => addUsage(sum, line.usage), zeroUsage());
    const response = [
      `[arm=${arm} case=${workload.id} pos=${invocation.position} model=${workload.model}]`,
      `treatment ${measurement.treatment.inputTokens}/${measurement.treatment.outputTokens}`,
      `billed ${measurement.billed.inputTokens}/${measurement.billed.outputTokens}`,
      ...measurement.overhead.map(
        (line) => `overhead ${line.category} ${line.model} ${line.usage.inputTokens}/${line.usage.outputTokens}`,
      ),
      `overhead_total ${overheadUsage.inputTokens}/${overheadUsage.outputTokens}`,
      `latency ${measurement.latencyMs}ms`,
      `cache ${measurement.cache.prefixHits}/${measurement.cache.prefixLookups} hits, ` +
        `${measurement.cache.prefixInvalidated}/${measurement.cache.transforms} invalidated`,
      `retained_pins ${retained.join(',') || 'none'}`,
    ].join('\n');

    log.push(
      Object.freeze({
        caseId: workload.id,
        arm,
        position: invocation.position,
        session,
        measurement: Object.freeze({ ...measurement, overhead: Object.freeze([...measurement.overhead]) }),
      }),
    );

    return {
      arm: invocation.arm,
      position: invocation.position,
      caseId: workload.id,
      ok: true,
      error: null,
      response,
      retainedConstraintIds: retained,
      droppedConstraintIds: dropped,
      // A pin that is gone at answer time *is* the prohibited effect, so the
      // marker the harness looks for is the drop itself. Stated here because it
      // is the one place in eval where a cost observation turns into a
      // constraint verdict, and it is why `retainedPins` is on `E5Measurement`.
      violatedConstraintIds: dropped,
      inputTokens: measurement.billed.inputTokens,
      outputTokens: measurement.billed.outputTokens,
      latencyMs: measurement.latencyMs,
    };
  };

  return { run, recorded: () => Object.freeze([...log]) };
}

// ------------------------------------------------------------- running a suite

/** Where a number in a report came from. Not decoration: claims audit needs it. */
export interface E5Provenance {
  /** The caller's name for the injected strategy. Opaque here by design, so
   *  without this a report cannot say what it measured. */
  readonly strategyId: string;
  readonly costModelId: string;
  readonly pricingTableVersion: string;
  readonly pricingVerifiedOn: string;
  readonly pricingAgeDays: number;
  /** The injected clock's date. The only clock read in this package. */
  readonly today: string;
  readonly workloadCount: number;
  readonly belowShippedThreshold: number;
  readonly atOrAboveShippedThreshold: number;
  readonly arms: readonly Arm[];
  readonly models: readonly string[];
  /** The narrative model, priced at zero because the provider does not meter it. */
  readonly localNarrationModel: string;
  readonly shippedMinTokens: number;
  /** `(taskType, outputFormat)` pairs with no case. `eps` cannot speak for them. */
  readonly emptyStrata: readonly string[];
  readonly todos: readonly string[];
}

export interface E5RunOptions extends Omit<RunOptions, 'runArm'> {
  readonly workloads?: readonly E5Workload[];
  /** Required. There is no default; see the module header. */
  readonly strategy: E5MeasurementStrategy;
  /** What to call the strategy in the provenance. Required for the same reason. */
  readonly strategyId: string;
  /** Required. The billing path is the subject under test's own. */
  readonly costModel: E5CostModel;
  /** Required. Also the independent re-pricing path for the audit. */
  readonly pricingTable: E5PricingTable;
  /** Required. The 90-day staleness rule needs "today" and nothing else does. */
  readonly clock: E5Clock;
  /** Resample count for the interval. Lower only to keep a test fast. */
  readonly bootstrap?: E5BootstrapOptions;
}

export interface E5RunResult {
  readonly report: RunReport;
  readonly fixture: EvalFixture;
  readonly gates: readonly E5GateVerdict[];
  readonly negativeControls: readonly E5NegativeControl[];
  readonly pricing: E5PricingFreshness;
  /** Only sessions whose closure was complete. */
  readonly observations: readonly E5PairedObservation[];
  /**
   * Cases that ran but are not in `observations`, each with the reason.
   *
   * Present so a smaller denominator is always visible. A suite that silently
   * drops the sessions it could not measure reports a median over the easy ones
   * and nothing in the output says so.
   */
  readonly excluded: readonly string[];
  readonly reductions: E5ReductionSummary;
  readonly strata: readonly E5EpsStratum[];
  /** Per-session money, in corpus order. */
  readonly perCase: readonly E5SessionSavings[];
  /** The run's headline dollars. */
  readonly ledger: E5SessionSavings;
  readonly breakevens: readonly E5Breakeven[];
  readonly closures: readonly E5Closure[];
  readonly audits: readonly E5PriceAudit[];
  readonly latencies: E5LatencySummary;
  readonly cache: E5CacheSummary;
  readonly worst: E5WorstQuartile;
  readonly crossover: E5Crossover;
  readonly provenance: E5Provenance;
}

/**
 * Run E5 end to end.
 *
 * Deliberately not a second runner. The interleaved seeded order, the
 * interleaving claim, the per-arm totals and the negative-control section all
 * come from `../runner.js`, because a suite that ran its own arms would have its
 * own ideas about what "interleaved" means and there would be no way to check
 * them against the harness.
 *
 * A **throwing arm is not a zero**. `runSuite` catches it and records an
 * `error`, this case is dropped from `observations`, and the drop is named in
 * `excluded` — which is also why G7 has an explicit "no priced session" branch:
 * an empty run sums to a net of 0, and 0 must not be mistaken for a measurement.
 */
export async function runE5Suite(options: E5RunOptions): Promise<E5RunResult> {
  if (typeof options.strategy !== 'function') {
    throw new TypeError(
      'e5: a measurement strategy is required. The subject under test is injected, not imported -- this ' +
        'package cannot bill a provider, and a default here would be a cost report nobody earned.',
    );
  }
  if (typeof options.strategyId !== 'string' || options.strategyId === '') {
    throw new TypeError('e5: strategyId is required; a report that cannot name what it measured is not evidence');
  }
  if (
    typeof options.costModel !== 'object' ||
    options.costModel === null ||
    typeof options.costModel.usdPerMtok !== 'function'
  ) {
    throw new TypeError(
      'e5: a costModel is required. The billing path is the thing under test, so it is injected rather than ' +
        'imported; an unpriceable run is reported as unknown, not as free.',
    );
  }
  if (typeof options.costModel.costModelId !== 'string' || options.costModel.costModelId === '') {
    throw new TypeError('e5: costModel.costModelId is required, for the same reason strategyId is');
  }
  if (typeof options.pricingTable !== 'object' || options.pricingTable === null) {
    throw new TypeError('e5: a pricingTable is required; the 90-day staleness rule and the price audit need it');
  }
  if (typeof options.clock !== 'object' || options.clock === null || typeof options.clock.nowMs !== 'function') {
    throw new TypeError('e5: a clock is required; Date.now() is never called in this package (G11)');
  }

  const workloads = options.workloads ?? E5_WORKLOADS;
  const fixture = buildE5Fixture(workloads);
  const handle = createE5ArmRunner(workloads, options.strategy);
  const report = await runSuite(fixture, {
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    runArm: handle.run,
  });

  const recorded = handle.recorded();
  const today = e5Today(options.clock);
  const freshness = e5PricingFreshness(options.pricingTable, today);
  const costModel = options.costModel;
  const table = options.pricingTable;

  // Pair by case. Both arms must be present and ok: a case with one arm has no
  // comparison, and comparing a treatment against nothing is how a suite ends
  // up reporting a reduction of 100%.
  const byCase = new Map<string, { control?: E5RecordedMeasurement; treatment?: E5RecordedMeasurement }>();
  for (const entry of recorded) {
    const bucket = byCase.get(entry.caseId) ?? {};
    if (entry.arm === 'control') bucket.control = entry;
    else bucket.treatment = entry;
    byCase.set(entry.caseId, bucket);
  }

  const observations: E5PairedObservation[] = [];
  const closures: E5Closure[] = [];
  const audits: E5PriceAudit[] = [];
  const perCase: E5SessionSavings[] = [];
  const breakevens: E5Breakeven[] = [];
  const excluded: string[] = [];

  for (const workload of workloads) {
    const pair = byCase.get(workload.id);
    const control = pair?.control;
    const treatment = pair?.treatment;
    if (control === undefined || treatment === undefined) {
      const missing = control === undefined ? 'control' : 'treatment';
      excluded.push(
        `${workload.id}: the ${missing} arm produced no measurement, so there is nothing to pair it with; ` +
          'an arm that throws is an error, not a zero',
      );
      continue;
    }

    const controlClosure = closeE5Billed(
      workload.id,
      'control',
      control.measurement.treatment,
      control.measurement.overhead,
      control.measurement.billed,
    );
    const treatmentClosure = closeE5Billed(
      workload.id,
      'treatment',
      treatment.measurement.treatment,
      treatment.measurement.overhead,
      treatment.measurement.billed,
    );
    closures.push(controlClosure, treatmentClosure);

    audits.push(
      e5AuditPrice(
        workload.id,
        'control',
        workload.model,
        control.measurement.treatment,
        treatment.measurement.treatment,
        treatment.measurement.overhead,
        costModel,
        table,
        treatment.measurement.reportedTotalUsd,
      ),
    );

    if (!controlClosure.complete || !treatmentClosure.complete) {
      excluded.push(
        `${workload.id}: ${[
          ...(controlClosure.complete ? [] : [controlClosure.note]),
          ...(treatmentClosure.complete ? [] : [treatmentClosure.note]),
        ].join('; ')}`,
      );
      continue;
    }

    const savings = e5SessionSavings(
      workload.id,
      workload.model,
      control.measurement.treatment,
      treatment.measurement.treatment,
      treatment.measurement.overhead,
      costModel,
      table,
      freshness,
    );
    perCase.push(savings);
    breakevens.push(
      e5Breakeven(
        workload.id,
        control.measurement.treatment,
        treatment.measurement.treatment,
        savings.priceable ? savings.overheadUsd : 0,
        savings.inputUsdPerMtok ?? 0,
        savings.outputUsdPerMtok ?? 0,
        savings.priceable,
      ),
    );
    observations.push(
      Object.freeze({
        caseId: workload.id,
        taskType: workload.taskType,
        outputFormat: workload.outputFormat,
        model: workload.model,
        control: control.measurement.treatment,
        treatment: treatment.measurement.treatment,
        controlLatencyMs: control.measurement.latencyMs,
        treatmentLatencyMs: treatment.measurement.latencyMs,
        controlCache: control.measurement.cache,
        treatmentCache: treatment.measurement.cache,
        trap: workload.trap,
      }),
    );
  }

  const ledger = e5AggregateSavings(perCase);
  const latencies = e5LatencySummary(observations);
  const cache = e5CacheSummary(observations);
  const netFractions = new Map(
    perCase.filter((session) => session.netFraction !== null).map((session) => [session.caseId, session.netFraction ?? 0]),
  );
  const worst = e5WorstQuartile(observations, netFractions, breakevens);
  const crossover = e5CrossoverFrom(ledger, perCase, freshness);

  const gates = evaluateE5Gates({
    freshness,
    aggregate: ledger,
    closures,
    audits,
    latencies,
    cache,
    priceableSessions: perCase.filter((session) => session.priceable).length,
    totalSessions: workloads.length,
  });

  return Object.freeze({
    report,
    fixture,
    gates,
    negativeControls: e5NegativeControls(workloads, report, perCase, closures, audits),
    pricing: freshness,
    observations: Object.freeze(observations),
    excluded: Object.freeze(excluded),
    reductions: e5ReductionSummary(observations, options.bootstrap ?? {}),
    strata: e5EpsStrata(observations, breakevens),
    perCase: Object.freeze(perCase),
    ledger,
    breakevens: Object.freeze(breakevens),
    closures: Object.freeze(closures),
    audits: Object.freeze(audits),
    latencies,
    cache,
    worst,
    crossover,
    provenance: Object.freeze({
      strategyId: options.strategyId,
      costModelId: costModel.costModelId,
      pricingTableVersion: table.version,
      pricingVerifiedOn: table.verifiedOn,
      pricingAgeDays: freshness.ageDays,
      today,
      workloadCount: workloads.length,
      belowShippedThreshold: workloads.filter((workload) => workload.baselineInputTokens < E5_SHIPPED_MIN_TOKENS).length,
      atOrAboveShippedThreshold: workloads.filter((workload) => workload.baselineInputTokens >= E5_SHIPPED_MIN_TOKENS)
        .length,
      arms: E5_ARMS,
      models: Object.freeze([...new Set(workloads.map((workload) => workload.model))].sort()),
      localNarrationModel: E5_LOCAL_NARRATION_MODEL,
      shippedMinTokens: E5_SHIPPED_MIN_TOKENS,
      emptyStrata: e5EmptyStrata(workloads),
      todos: Object.freeze([
        'TODO(WS-F, F2): every token, latency and cache number in this report is produced by the injected ' +
          'strategy. E5 measures the real ones only when run against a live gateway, which needs credentials ' +
          'this package deliberately does not have.',
        'TODO(WS-F, F1-9): e5PairedMedianInterval duplicates statistics.ts pairedBootstrap because that one ' +
          'is boolean-only. Widen it to continuous pairs and delete the local copy.',
        'TODO(WS-F, F1-9): G6 is the pricing-staleness gate in docs/evaluation.md §E5 and the 20% ' +
          'input-reduction floor in §5. The floor belongs to E4 and is not evaluated here; the id collision is ' +
          'reported rather than renamed.',
      ]),
    }),
  });
}

// ----------------------------------------------------------------- crossover

const analyticCrossoverFromAggregate = (aggregate: E5SessionSavings): number | null => {
  if (!aggregate.priceable) return null;
  if (aggregate.controlInputTokens <= 0) return null;
  // `rho`, not the two rates: the crossover is a ratio of prices, so a run with
  // two price lists that share a rho (3/15 and 5/25) still has one crossover.
  const rho = aggregate.rho;
  if (rho === null || !(rho > 0)) return null;
  const r = 1 - aggregate.treatmentInputTokens / aggregate.controlInputTokens;
  const equiv = aggregate.overheadInInputTokenEquivalents;
  if (equiv === null || !(r > 0)) return null;
  // Built from the aggregate's own r, eps and rho, so the crossover comes from
  // the same numbers the gate is on rather than from a second estimate of them.
  const synthetic: E5Breakeven = {
    caseId: 'aggregate',
    available: true,
    reason: '',
    r,
    eps: aggregate.outputExpansion,
    rho,
    k: null,
    overheadInInputTokenEquivalents: equiv,
    frozenBudget: null,
    exactBudget: null,
    netBudget: null,
    frozenOk: null,
    exactOk: null,
    netOk: null,
    grossNetDisagreement: false,
    note: '',
  };
  return e5AnalyticCrossover(synthetic, aggregate.controlInputTokens, aggregate.controlOutputTokens);
};

function e5CrossoverFrom(
  aggregate: E5SessionSavings,
  perCase: readonly E5SessionSavings[],
  freshness: E5PricingFreshness,
): E5Crossover {
  const measured = e5MeasuredCrossover(
    perCase
      .filter((session) => session.priceable)
      .map((session) => [session.controlInputTokens, session.netSavedUsd] as const),
  );
  const analytic = analyticCrossoverFromAggregate(aggregate);
  const best = measured?.inputTokens ?? analytic;
  const overheadPerInputToken =
    aggregate.controlInputTokens > 0 && aggregate.overheadInInputTokenEquivalents !== null
      ? round4(aggregate.overheadInInputTokenEquivalents / aggregate.controlInputTokens)
      : null;
  const aggregateBreakevenR =
    aggregate.controlInputTokens > 0 ? 1 - aggregate.treatmentInputTokens / aggregate.controlInputTokens : null;
  const analyticBelow = analytic === null ? null : analytic < E5_SHIPPED_MIN_TOKENS;
  // Whether a crossover *exists* is a question about the denominator alone -- is
  // r above the overhead per input token -- and both are in input tokens, so it
  // is answerable with several models in one run even when the numerator's rho
  // is not. Conflating the two would report "no crossover" for a run that simply
  // has two price lists.
  const crosses =
    aggregateBreakevenR !== null && overheadPerInputToken !== null
      ? aggregateBreakevenR > overheadPerInputToken
      : false;
  const withheld = freshness.stale;

  // Ordered so each outcome can only be reached by its own condition. The
  // quotability check sits on `crosses`, not against it: a run whose prices
  // disagree on rho still crosses, it just cannot say where.
  const note = withheld
    ? `crossover withheld: ${freshness.message}`
    : !crosses && aggregateBreakevenR !== null && overheadPerInputToken !== null
      ? `no crossover exists: input reduction r=${round4(aggregateBreakevenR)} does not exceed the ` +
        `${overheadPerInputToken} overhead per input token, so the intervention is underwater at every ` +
        'session size and gets worse as sessions grow'
      : analytic === null
        ? 'a crossover exists but its position is not quotable: the run spans more than one price list, ' +
          'so rho is not a single number. Use the measured interpolation above.'
        : analyticBelow === true
          ? `net crosses zero near ${round4(analytic)} input tokens, below the ${E5_SHIPPED_MIN_TOKENS}-token ` +
            `point at which the product turns on, so every session between them loses money`
          : best === null
            ? 'no priced session in this corpus has both a positive input reduction and non-zero overhead, so ' +
              'there is no crossover to locate'
            : `net crosses zero near ${round4(best)} input tokens against a shipped threshold of ` +
              `${E5_SHIPPED_MIN_TOKENS}`;

  return Object.freeze({
    measuredInputTokens: measured?.inputTokens ?? null,
    bracket: measured?.bracket ?? null,
    analyticInputTokens: analytic === null ? null : round4(analytic),
    analyticCrosses: crosses,
    overheadPerInputToken,
    shippedMinTokens: E5_SHIPPED_MIN_TOKENS,
    analyticBelowShippedThreshold: analyticBelow,
    bestEstimateInputTokens: best === null ? null : round4(best),
    note,
  });
}

// --------------------------------------------------------- negative controls

const e5NegativeControls = (
  workloads: readonly E5Workload[],
  report: RunReport,
  perCase: readonly E5SessionSavings[],
  closures: readonly E5Closure[],
  audits: readonly E5PriceAudit[],
): readonly E5NegativeControl[] => {
  const savingsByCase = new Map(perCase.map((session) => [session.caseId, session]));
  return Object.freeze(
    workloads
      .filter((workload): workload is E5Workload & { trap: E5Trap } => workload.trap !== null)
      .map((workload): E5NegativeControl => {
        const caseResult = report.cases.find((candidate) => candidate.caseId === workload.id);
        const harnessFired = (caseResult?.arms ?? []).some((arm) => arm.status !== 'pass');
        const trap: E5Trap = workload.trap;

        let e5Fired = false;
        let e5Detail: string;
        if (trap === 'net_trap') {
          const savings = savingsByCase.get(workload.id);
          e5Fired = savings === undefined ? true : !savings.priceable || savings.netSavedUsd <= 0;
          e5Detail =
            savings === undefined
              ? `${workload.id} produced no priced session at all`
              : `net $${savings.netSavedUsd.toFixed(6)} (gross $${savings.grossSavedUsd.toFixed(6)} minus ` +
                `overhead $${savings.overheadUsd.toFixed(6)})`;
        } else {
          const broken = closures.filter((closure) => closure.caseId === workload.id && !closure.complete);
          const disputed = audits.filter((audit) => audit.caseId === workload.id && audit.costModelDisagrees);
          e5Fired = broken.length > 0 || disputed.length > 0;
          e5Detail =
            broken.length > 0
              ? broken.map((closure) => closure.note).join('; ')
              : disputed.length > 0
                ? disputed.map((audit) => audit.note).join('; ')
                : `${workload.id} closed and both price paths agreed, so the attribution trap did not fire`;
        }

        const fired = harnessFired && e5Fired;
        const note = fired
          ? `${workload.id} (${trap}): the harness saw a dropped pin and E5 saw the accounting fail, so the trap ` +
            'is confirmed and this suite can detect that way of manufacturing a cost win'
          : harnessFired && !e5Fired
            ? `${workload.id} (${trap}): the harness fired but the money came out right (${e5Detail}); one of the ` +
              'two detectors is measuring something other than this trap, which invalidates the control rather ' +
              'than confirming it'
            : !harnessFired && e5Fired
              ? `${workload.id} (${trap}): the money came out wrong (${e5Detail}) but the harness saw no dropped ` +
                'pin; the two detectors disagree, so neither can be trusted on its own'
              : `${workload.id} (${trap}): neither detector fired (${e5Detail}); the trap did not reproduce, so ` +
                'every other number in this report is uninterpretable';
        return Object.freeze({
          caseId: workload.id,
          trap,
          harnessFired,
          e5Fired,
          fired,
          e5Detail,
          note,
        });
      }),
  );
};

// ------------------------------------------------------------------- corpus

/**
 * The narration model overhead runs on.
 *
 * Self-gist narration happens in the agent's own turn and bills at the frontier
 * rate. Compaction narration can run on a local model: genuinely not free, but
 * not metered by the provider either, and priced at whatever the caller can
 * defend. It must appear in the pricing table with a real `0` even so, because
 * a line the table cannot price is a line the audit cannot check, and the audit
 * would (correctly) call the whole session unpriceable.
 */
export const E5_LOCAL_NARRATION_MODEL = 'local-narrator';

const workload = (init: Omit<E5Workload, 'prompt'>): E5Workload => {
  const draft: E5Workload = { ...init, prompt: '' };
  return Object.freeze({ ...draft, prompt: renderE5Prompt(draft) });
};

/**
 * Fourteen hand-authored sessions. Nothing here is generated.
 *
 * **The shape is the experiment.** Three cases sit below the shipped
 * 5000-token activation point and eleven sit at or above it, because the
 * finding E5 exists to produce is the *crossover* — the input size at which net
 * saving crosses zero — and a crossover cannot be located from one side. The
 * short sessions are where §E5 §7 says probes can exceed the savings, so they
 * are the ones most likely to lose money, and they are deliberately present
 * rather than absent.
 *
 * **Strata are spread deliberately.** `eps` is reported over
 * `(taskType, outputFormat)` and a pooled average would let a
 * `subagent_fanout` hide inside a pile of `single_turn`. The
 * `long_answer`/`doc_qa` cases are the most output-heavy in the corpus on
 * purpose: output expansion is the failure mode the frozen contract exists to
 * catch, so the corpus has to contain cases that can trip it.
 *
 * **The two traps are real cases, not annotations.** `e5-net-trap` is a short
 * debugging session where an input saving is real and the overhead exceeds it;
 * `e5-attribution-trap` is a mid-sized edit session where the bill under-reports
 * its own overhead. Both are marked `negativeControl`, so the harness's own
 * detector is armed on them, and both have an independent E5-side detector.
 *
 * Two models appear so `rho` is exercised rather than assumed, and both are in
 * the pricing table that `e5FixturePricingTable` returns.
 */
export const E5_WORKLOADS: readonly E5Workload[] = Object.freeze<E5Workload[]>([
  workload({
    id: 'e5-code-edit-small',
    title: 'Rename an exported symbol across three files',
    taskType: 'code_edit',
    outputFormat: 'single_turn',
    model: 'frontier-a',
    baselineInputTokens: 3200,
    baselineOutputTokens: 260,
    pinIds: ['pin-e5-runbook'],
    request: 'Rename `fetchUser` to `loadUser` in the api client and its two call sites.',
    trap: null,
    notes: 'Below the shipped threshold: the product should not have touched this one.',
  }),
  workload({
    id: 'e5-debug-small',
    title: 'Explain a failing assertion in a short test',
    taskType: 'debugging',
    outputFormat: 'single_turn',
    model: 'frontier-a',
    baselineInputTokens: 4100,
    baselineOutputTokens: 380,
    pinIds: ['pin-e5-runbook'],
    request: 'The `parses_offsets` test fails only on the third fixture. Explain why.',
    trap: null,
    notes: 'Still below 5000, and the most likely place for probe cost to exceed the saving.',
  }),
  workload({
    id: 'e5-doc-qa-small',
    title: 'Answer a question from the API reference',
    taskType: 'doc_qa',
    outputFormat: 'long_answer',
    model: 'frontier-b',
    baselineInputTokens: 2600,
    baselineOutputTokens: 700,
    pinIds: ['pin-e5-runbook'],
    request: 'What are the rate limits on the batch endpoint, and what does exceeding them do?',
    trap: null,
    notes: 'Short input, long output: the shape most exposed to eps.',
  }),
  workload({
    id: 'e5-search-mid',
    title: 'Find every caller of a scheduler function',
    taskType: 'repo_search',
    outputFormat: 'single_turn',
    model: 'frontier-a',
    baselineInputTokens: 5600,
    baselineOutputTokens: 220,
    pinIds: ['pin-e5-runbook'],
    request: 'List every call site of `scheduleNext` and the file it lives in.',
    trap: null,
    notes: 'First case above the shipped threshold.',
  }),
  workload({
    id: 'e5-triage-mid',
    title: 'Triage a latency alert from a service',
    taskType: 'incident_triage',
    outputFormat: 'single_turn',
    model: 'frontier-b',
    baselineInputTokens: 6200,
    baselineOutputTokens: 300,
    pinIds: ['pin-e5-runbook'],
    request: 'p99 on checkout-api jumped to 4s. What are the first three things to check?',
    trap: null,
    notes: undefined,
  }),
  workload({
    id: 'e5-refactor-mid',
    title: 'Move a module across package boundaries',
    taskType: 'long_horizon_refactor',
    outputFormat: 'tool_loop',
    model: 'frontier-a',
    baselineInputTokens: 7400,
    baselineOutputTokens: 640,
    pinIds: ['pin-e5-runbook'],
    request: 'Move `packages/legacy/http` to `packages/core/http` and fix every import.',
    trap: null,
    notes: 'A tool loop over a large input: the case where prefix reuse matters most.',
  }),
  workload({
    id: 'e5-code-edit-large',
    title: 'Add pagination to a list endpoint',
    taskType: 'code_edit',
    outputFormat: 'tool_loop',
    model: 'frontier-a',
    baselineInputTokens: 11000,
    baselineOutputTokens: 420,
    pinIds: ['pin-e5-runbook'],
    request: 'Add cursor pagination to GET /orders, including the client and the tests.',
    trap: null,
    notes: undefined,
  }),
  workload({
    id: 'e5-search-large',
    title: 'Map the authentication surface of the repo',
    taskType: 'repo_search',
    outputFormat: 'single_turn',
    model: 'frontier-b',
    baselineInputTokens: 8600,
    baselineOutputTokens: 260,
    pinIds: ['pin-e5-runbook'],
    request: 'Map every place a request is authenticated, and say which one is bypassed in tests.',
    trap: null,
    notes: undefined,
  }),
  workload({
    id: 'e5-doc-qa-large',
    title: 'Summarise a migration guide for a new team',
    taskType: 'doc_qa',
    outputFormat: 'long_answer',
    model: 'frontier-b',
    baselineInputTokens: 9800,
    baselineOutputTokens: 1500,
    pinIds: ['pin-e5-runbook'],
    request: 'Summarise the v1-to-v2 migration guide for a team that has never used v1.',
    trap: null,
    notes: 'The most output-heavy case in the corpus; the one most able to break the frozen eps budget.',
  }),
  workload({
    id: 'e5-debug-large',
    title: 'Find the cause of an intermittent test failure',
    taskType: 'debugging',
    outputFormat: 'tool_loop',
    model: 'frontier-a',
    baselineInputTokens: 12400,
    baselineOutputTokens: 520,
    pinIds: ['pin-e5-runbook'],
    request: '`integration.spec.ts` fails about one run in six. Find out why.',
    trap: null,
    notes: undefined,
  }),
  workload({
    id: 'e5-triage-fanout',
    title: 'Correlate four alerts into one incident',
    taskType: 'incident_triage',
    outputFormat: 'subagent_fanout',
    model: 'frontier-b',
    baselineInputTokens: 14200,
    baselineOutputTokens: 1100,
    pinIds: ['pin-e5-runbook'],
    request: 'Correlate the checkout, payments, redis and gateway alerts from the last hour.',
    trap: null,
    notes: 'A fan-out: the case with the most overhead opportunity and the most output.',
  }),
  workload({
    id: 'e5-refactor-large',
    title: 'Split a monolith into services',
    taskType: 'long_horizon_refactor',
    outputFormat: 'subagent_fanout',
    model: 'frontier-a',
    baselineInputTokens: 16800,
    baselineOutputTokens: 900,
    pinIds: ['pin-e5-runbook'],
    request: 'Propose and apply a service split for `apps/legacy-billing`.',
    trap: null,
    notes: 'The largest case; the best session to see whether r improves with size.',
  }),
  workload({
    id: 'e5-net-trap',
    title: 'A short session whose overhead exceeds its saving',
    taskType: 'debugging',
    outputFormat: 'single_turn',
    model: 'frontier-a',
    baselineInputTokens: 3800,
    baselineOutputTokens: 300,
    pinIds: ['pin-e5-runbook'],
    request: 'What does this stack trace from the deploy job say?',
    trap: 'net_trap',
    notes:
      'NEGATIVE CONTROL. The input saving is real and the gross figure is positive; the overhead the ' +
      'intervention caused is larger. A suite that only reports gross reads this as a win.',
  }),
  workload({
    id: 'e5-attribution-trap',
    title: 'A mid-sized session that under-reports its own bill',
    taskType: 'code_edit',
    outputFormat: 'tool_loop',
    model: 'frontier-b',
    baselineInputTokens: 6800,
    baselineOutputTokens: 400,
    pinIds: ['pin-e5-runbook'],
    request: 'Add a `--dry-run` flag to the migration script.',
    trap: 'attribution_trap',
    notes:
      'NEGATIVE CONTROL. The tokens are spent and the bill reports fewer of them, so overhead disappears from ' +
      'the accounting without any number being obviously wrong.',
  }),
]);

/**
 * The pricing table this corpus is designed against.
 *
 * The `verifiedOn` dates are in the past relative to any plausible run, and
 * that is the point: a table that is fresh on the day it is written goes stale
 * three months later, and the suite is required to notice. Pass a `clock` to
 * `runE5Suite` and a stale table withholds every dollar verdict.
 *
 * `local-narrator` carries a real `0.0` for both directions. It is not free —
 * it is not metered by the provider — and pricing it at the frontier rate would
 * inflate overhead while dropping it without saying so would be the flattering
 * choice made quietly. It is in the table so the audit can check the line rather
 * than call the whole session unpriceable.
 */
export const e5FixturePricingTable = (verifiedOn = '2026-06-01'): E5PricingTable =>
  Object.freeze({
    version: 'e5-fixture-2026-06',
    verifiedOn,
    rows: Object.freeze<E5Pricing[]>([
      Object.freeze({
        model: 'frontier-a',
        inputUsdPerMtok: 3,
        outputUsdPerMtok: 15,
        verifiedOn,
        // TODO(owner): replace with the provider's published sheet when this suite
        // runs against a live gateway. See docs/architecture.md §8.
        source: 'fixture placeholder modelled on a published frontier price list (rho = 5)',
      }),
      Object.freeze({
        model: 'frontier-b',
        inputUsdPerMtok: 5,
        outputUsdPerMtok: 25,
        verifiedOn,
        source: 'fixture placeholder; a second model so rho is exercised rather than assumed',
      }),
      Object.freeze({
        model: E5_LOCAL_NARRATION_MODEL,
        inputUsdPerMtok: 0,
        outputUsdPerMtok: 0,
        verifiedOn,
        source: 'operator hardware; not metered by the provider, reported as wall clock instead',
      }),
    ]),
  });
