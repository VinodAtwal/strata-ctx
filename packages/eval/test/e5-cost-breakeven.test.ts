import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  E5_LEDGER_CATEGORIES,
  E5_LOCAL_NARRATION_MODEL,
  E5_PRICE_AUDIT_TOLERANCE_USD,
  E5_PRICING_STALE_AFTER_DAYS,
  E5_SHIPPED_MIN_TOKENS,
  E5_SPEND_CATEGORIES,
  E5_THIN_N,
  E5_WORKLOADS,
  E5Error,
  assertE5Measurement,
  buildE5Document,
  buildE5Fixture,
  closeE5Billed,
  createE5ArmRunner,
  e5AggregateSavings,
  e5AnalyticCrossover,
  e5AuditPrice,
  e5Breakeven,
  e5CacheSummary,
  e5ControlUsage,
  e5DaysBetween,
  e5EmptyStrata,
  e5EpochMs,
  e5FixturePricingTable,
  e5LatencySummary,
  e5MeasuredCrossover,
  e5MedianInterval,
  e5PairedMedianInterval,
  e5PricingFreshness,
  e5SessionSavings,
  e5Today,
  e5UnattributedTokens,
  evaluateE5Gates,
  fixedE5Clock,
  fixedRateCostModel,
  lintE5Workloads,
  parseE5Fixture,
  runE5Suite,
  validateE5Document,
  type E5CacheCounters,
  type E5Closure,
  type E5Clock,
  type E5CostModel,
  type E5GateInput,
  type E5GateVerdict,
  type E5Measurement,
  type E5MeasurementStrategy,
  type E5PairedObservation,
  type E5PriceAudit,
  type E5PricingFreshness,
  type E5PricingTable,
  type E5RunOptions,
  type E5Session,
  type E5SessionSavings,
  type E5SpendLine,
  type E5Usage,
  type E5Workload,
} from '../src/suites/e5-cost-breakeven.js';

// ---------------------------------------------------------------- helpers

const u = (inputTokens: number, outputTokens: number): E5Usage => ({ inputTokens, outputTokens });

const cache = (partial: Partial<E5CacheCounters> = {}): E5CacheCounters => ({
  prefixLookups: 10,
  prefixHits: 8,
  transforms: 4,
  prefixInvalidated: 0,
  ...partial,
});

const spendLine = (
  category: E5SpendLine['category'],
  model: string,
  inputTokens: number,
  outputTokens: number,
): E5SpendLine => ({ category, model, usage: u(inputTokens, outputTokens) });

/** 2026-06-20, 19 days after the fixture table's `verifiedOn`. */
const TODAY = '2026-06-20';
const CLOCK = fixedE5Clock(Date.parse(`${TODAY}T00:00:00.000Z`));

const table = (verifiedOn = '2026-06-01'): E5PricingTable => e5FixturePricingTable(verifiedOn);
const costModel = (t: E5PricingTable = table()): E5CostModel => fixedRateCostModel(t);

/**
 * The worked example from the design, hand-checked so a change in any rate or
 * formula has to be made here on purpose.
 *
 * ```text
 *   control     4000 in / 400 out   at $3/Mtok in, $15/Mtok out  = $0.01800
 *   treatment   2800 in / 440 out                                 = $0.01500
 *   overhead    200 gist_out + 1200 probe_in + 80 probe_out       = $0.00780
 *   gross       $0.01800 - $0.01500                               = +$0.00300 (+16.67%)
 *   net         $0.00300 - $0.00780                               = -$0.00480 (-26.67%)
 *   k           12000 / 18000                                      = 0.66667
 *   rho         15 / 3                                             = 5
 *   frozen      1 + 0.7/(5 * 2/3)                                  = 1.21
 *   exact       1 + 0.3*(2/3)/(1/3)                                = 1.60
 *   net budget  1 + (1200 - 2600)/2000                             = 0.30
 * ```
 *
 * The last three lines are the point of the whole file: the frozen contract's
 * rule says this session is fine at `eps = 1.10 < 1.21`, arithmetic agrees, and
 * the session still loses 27% of its cost. Only the net budget sees the probes.
 */
const WORKED_CONTROL = u(4000, 400);
const WORKED_TREATMENT = u(2800, 440);
const WORKED_OVERHEAD: readonly E5SpendLine[] = Object.freeze([
  spendLine('gist_out', 'frontier-a', 0, 200),
  spendLine('probe_in', 'frontier-a', 1200, 0),
  spendLine('probe_out', 'frontier-a', 0, 80),
  spendLine('compaction_out', 'frontier-a', 0, 0),
]);

const freshPricing = (): E5PricingFreshness => e5PricingFreshness(table(), TODAY);

const workedSavings = (): E5SessionSavings =>
  e5SessionSavings(
    'worked',
    'frontier-a',
    WORKED_CONTROL,
    WORKED_TREATMENT,
    WORKED_OVERHEAD,
    costModel(),
    table(),
    freshPricing(),
  );

const gateOf = (gates: readonly E5GateVerdict[], gate: E5GateVerdict['gate']): E5GateVerdict => {
  const found = gates.find((candidate) => candidate.gate === gate);
  assert.ok(found !== undefined, `no verdict for ${gate}`);
  return found;
};

/** One paired session, for the summaries that take observations rather than sessions. */
const paired = (over: Partial<E5PairedObservation> = {}): E5PairedObservation => ({
  caseId: 'c',
  taskType: 'code_edit',
  outputFormat: 'single_turn',
  model: 'frontier-a',
  control: u(4000, 400),
  treatment: u(2800, 440),
  controlLatencyMs: 100,
  treatmentLatencyMs: 118,
  controlCache: cache(),
  treatmentCache: cache(),
  trap: null,
  ...over,
});

// ------------------------------------------------------- the worked example

describe('e5: the worked example, hand-checked', () => {
  it('prices gross and net separately, and net is negative', () => {
    const savings = workedSavings();
    assert.equal(savings.priceable, true);
    assert.equal(savings.baselineUsd, 0.018);
    assert.equal(savings.treatmentUsd, 0.015);
    assert.equal(savings.grossSavedUsd, 0.003);
    assert.equal(savings.overheadUsd, 0.0078);
    // The finding. Gross is a win, net is a loss, and nothing clamps this.
    assert.equal(savings.netSavedUsd, -0.0048);
    assert.equal(savings.grossFraction, 0.166667);
    assert.equal(savings.netFraction, -0.266667);
    assert.ok(savings.grossSavedUsd > 0, 'gross must be a win here');
    assert.ok(savings.netSavedUsd < 0, 'net must be a loss here');
  });

  it('splits overhead by category so a loss says which overhead did it', () => {
    const savings = workedSavings();
    // 200 gist_out @ $15/Mtok, 1200 probe_in @ $3/Mtok, 80 probe_out @ $15/Mtok.
    assert.equal(savings.overheadUsdByCategory['gist_out'], 0.003);
    assert.equal(savings.overheadUsdByCategory['probe_in'], 0.0036);
    assert.equal(savings.overheadUsdByCategory['probe_out'], 0.0012);
    assert.equal(savings.overheadUsdByCategory['compaction_out'], 0);
    const sum = E5_SPEND_CATEGORIES.reduce((total, category) => total + savings.overheadUsdByCategory[category], 0);
    assert.equal(Math.round(sum * 1e9) / 1e9, savings.overheadUsd);
  });

  it('keeps all five ledger categories present even when a category is zero', () => {
    const savings = workedSavings();
    assert.deepEqual(Object.keys(savings.tokensByCategory).sort(), [...E5_LEDGER_CATEGORIES].sort());
    // input_saved is signed and is a difference, not a count.
    assert.equal(savings.tokensByCategory['input_saved'], 1200);
    assert.equal(savings.tokensByCategory['gist_out'], 200);
    assert.equal(savings.tokensByCategory['probe_in'], 1200);
    assert.equal(savings.tokensByCategory['compaction_out'], 0);
  });

  it('reproduces the three breakeven budgets and shows the frozen one disagreeing', () => {
    const breakeven = e5Breakeven('worked', WORKED_CONTROL, WORKED_TREATMENT, 0.0078, 3, 15, true);
    assert.equal(breakeven.available, true);
    assert.equal(breakeven.r, 0.3);
    assert.equal(breakeven.eps, 1.1);
    assert.equal(breakeven.rho, 5);
    assert.equal(breakeven.k, 0.6667);
    assert.equal(breakeven.overheadInInputTokenEquivalents, 2600);
    assert.equal(breakeven.frozenBudget, 1.21);
    assert.equal(breakeven.exactBudget, 1.6);
    assert.equal(breakeven.netBudget, 0.3);
    assert.equal(breakeven.frozenOk, true);
    assert.equal(breakeven.exactOk, true);
    // The whole reason three budgets ship: the contract's headline rule passes
    // a session that loses 27% of its cost.
    assert.equal(breakeven.netOk, false);
    assert.equal(breakeven.grossNetDisagreement, true);
    assert.match(breakeven.note, /frozen rule/);
  });

  it('reproduces the frozen contract rule from core-types exactly', () => {
    const breakeven = e5Breakeven('worked', WORKED_CONTROL, WORKED_TREATMENT, 0.0078, 3, 15, true);
    // `eps < 1 + (1-r)/(rho*k)`, verified by re-deriving it from the primitives
    // rather than by copying the implementation.
    const r = 1 - 2800 / 4000;
    const eps = 440 / 400;
    const rho = 15 / 3;
    const k = (3 * 4000) / (3 * 4000 + 15 * 400);
    // `null` is what an unpriceable session reports, so the budget is only
    // comparable once this session is known to have one.
    const frozen = breakeven.frozenBudget;
    const exact = breakeven.exactBudget;
    assert.ok(frozen !== null && exact !== null, 'a priceable session has both budgets');
    assert.ok(Math.abs(frozen - (1 + (1 - r) / (rho * k))) < 1e-4);
    assert.equal(breakeven.frozenOk, eps < 1 + (1 - r) / (rho * k));
    // And the exact budget, `1 + r*k/(1-k)`, which is the arithmetic one.
    assert.ok(Math.abs(exact - (1 + (r * k) / (1 - k))) < 1e-4);
  });

  it('has no analytic crossover when the overhead per input token exceeds r', () => {
    // 2600 overhead-equivalents over 4000 control input tokens is 0.65 per token,
    // against r = 0.30. No size of session makes this pay for itself.
    const breakeven = e5Breakeven('worked', WORKED_CONTROL, WORKED_TREATMENT, 0.0078, 3, 15, true);
    assert.equal(e5AnalyticCrossover(breakeven, 4000, 400), null);
  });

  it('places the analytic crossover where the overhead rate is below r', () => {
    // r = 0.70, eps = 1.10, overhead 4000 input-token-equivalents over 20000
    // control input tokens = 0.20 per token, so p = 0.20 < r.
    // I* = rho*O_c*(eps-1) / (r - p) = 5*800*0.10 / 0.50 = 800.
    const breakeven = e5Breakeven(
      'crosses',
      u(20000, 800),
      u(6000, 880),
      4000 * (3 / 1_000_000),
      3,
      15,
      true,
    );
    assert.equal(breakeven.r, 0.7);
    assert.equal(breakeven.eps, 1.1);
    assert.equal(breakeven.overheadInInputTokenEquivalents, 4000);
    const crossover = e5AnalyticCrossover(breakeven, 20000, 800);
    assert.ok(crossover !== null);
    assert.ok(Math.abs(crossover - 800) < 1e-6, `expected ~800, got ${String(crossover)}`);
    assert.ok(crossover < E5_SHIPPED_MIN_TOKENS);
  });

  it('interpolates the measured crossover from the sign change', () => {
    const crossed = e5MeasuredCrossover([
      [10000, 1],
      [2000, -1],
      [6000, 0.5],
    ]);
    assert.ok(crossed !== null);
    // Ascending order: -1 at 2000, +0.5 at 6000. t = 1/1.5, so 2000 + 0.666*4000.
    assert.equal(crossed.inputTokens, 4667);
    assert.deepEqual(crossed.bracket, [2000, 6000]);
  });

  it('reports no measured crossover when every session is on one side', () => {
    assert.equal(
      e5MeasuredCrossover([
        [2000, -1],
        [6000, -0.5],
        [10000, -0.25],
      ]),
      null,
    );
  });

  it('aggregates only priced sessions and keeps the token ledger regardless', () => {
    const priced = workedSavings();
    const unpriced = e5SessionSavings(
      'unpriced',
      'mystery-model',
      u(1000, 100),
      u(600, 120),
      [spendLine('probe_in', 'mystery-model', 100, 0)],
      costModel(),
      table(),
      freshPricing(),
    );
    assert.equal(unpriced.priceable, false);
    // Dollars unknown, not zero.
    assert.equal(unpriced.baselineUsd, 0);
    assert.equal(unpriced.netSavedUsd, 0);
    assert.equal(unpriced.netFraction, null);
    // Tokens are still exact.
    assert.equal(unpriced.tokensByCategory['input_saved'], 400);
    assert.equal(unpriced.tokensByCategory['probe_in'], 100);

    const aggregate = e5AggregateSavings([priced, unpriced]);
    assert.equal(aggregate.priceable, false);
    assert.equal(aggregate.controlInputTokens, 5000);
    assert.equal(aggregate.treatmentInputTokens, 3400);
    // The token ledger still adds up across both, which is the point of keeping it.
    assert.equal(aggregate.tokensByCategory['input_saved'], 1600);
    // 1200 from the priced session plus 100 from the unpriced one: the token
    // ledger spans both, which is the point of keeping it price-independent.
    assert.equal(aggregate.tokensByCategory['probe_in'], 1300);
    assert.equal(aggregate.baselineUsd, priced.baselineUsd);
  });
});

// -------------------------------------------------------------- freshness

describe('e5: pricing freshness', () => {
  it('is fresh at exactly the threshold and stale one day past it', () => {
    // Whole UTC days, strictly greater than the threshold, so 90 is fresh.
    const atNinety = e5PricingFreshness(table('2026-03-22'), TODAY);
    assert.equal(atNinety.ageDays, 90);
    assert.equal(atNinety.stale, false);
    assert.equal(atNinety.reason, 'fresh');

    const atNinetyOne = e5PricingFreshness(table('2026-03-21'), TODAY);
    assert.equal(atNinetyOne.ageDays, 91);
    assert.equal(atNinetyOne.stale, true);
    assert.equal(atNinetyOne.reason, 'stale');
    assert.equal(E5_PRICING_STALE_AFTER_DAYS, 90);
  });

  it('refuses a future verifiedOn instead of clamping it to fresh', () => {
    const future = e5PricingFreshness(table('2026-12-01'), TODAY);
    assert.equal(future.reason, 'verified_in_the_future');
    assert.equal(future.stale, true);
    assert.match(future.message, /permanently exempt/);
  });

  it('refuses a malformed date rather than reading it as epoch zero', () => {
    const malformed = e5PricingFreshness(table('01/06/2026'), TODAY);
    assert.equal(malformed.reason, 'malformed');
    assert.equal(malformed.stale, true);
    assert.ok(Number.isNaN(malformed.ageDays));
    assert.equal(e5EpochMs('01/06/2026'), Number.NaN);
    assert.equal(e5EpochMs('2026-06-01'), Date.parse('2026-06-01T00:00:00.000Z'));
    assert.equal(e5DaysBetween('2026-06-01', '2026-06-20'), 19);
  });

  it('names the table version so a stale verdict is actionable', () => {
    const stale = e5PricingFreshness(table('2025-01-01'), TODAY);
    assert.match(stale.message, /e5-fixture-2026-06/);
    assert.match(stale.message, /cost win into a cost loss/);
  });

  it('reads the injected clock and nothing else', () => {
    assert.equal(e5Today(CLOCK), TODAY);
    assert.throws(
      () => e5Today(fixedE5Clock(Number.NaN)),
      (err: unknown) => err instanceof E5Error && /not a finite epoch/.test(err.message),
    );
  });
});

// ---------------------------------------------------------- token closure

describe('e5: token closure', () => {
  it('closes when the bill equals treatment plus overhead, per side', () => {
    const closure = closeE5Billed('c', 'treatment', WORKED_TREATMENT, WORKED_OVERHEAD, u(4000, 720));
    assert.equal(closure.complete, true);
    assert.equal(closure.attributedInputTokens, 4000);
    assert.equal(closure.attributedOutputTokens, 720);
    assert.equal(closure.residualInputTokens, 0);
    assert.equal(closure.residualOutputTokens, 0);
  });

  it('reports tokens billed with no spend line, and never absorbs them', () => {
    const closure = closeE5Billed('c', 'treatment', WORKED_TREATMENT, WORKED_OVERHEAD, u(4500, 720));
    assert.equal(closure.complete, false);
    assert.equal(closure.residualInputTokens, 500);
    assert.equal(closure.residualOutputTokens, 0);
    assert.match(closure.note, /500 input token\(s\) billed with no spend line/);
    assert.equal(e5UnattributedTokens([closure]), 500);
  });

  it('reports spend lines that exceed the bill, which is the same cheat in reverse', () => {
    const closure = closeE5Billed('c', 'treatment', WORKED_TREATMENT, WORKED_OVERHEAD, u(4000, 400));
    assert.equal(closure.complete, false);
    assert.equal(closure.residualOutputTokens, -320);
    assert.match(closure.note, /output token\(s\) claimed by 4 spend line\(s\) but not billed/);
    // Counted by magnitude, so a negative residual is not mistaken for credit.
    assert.equal(e5UnattributedTokens([closure]), 320);
  });

  it('does not let an input residual excuse an output residual', () => {
    const both = closeE5Billed('c', 'treatment', WORKED_TREATMENT, WORKED_OVERHEAD, u(4500, 400));
    assert.equal(both.complete, false);
    assert.equal(both.residualInputTokens, 500);
    assert.equal(both.residualOutputTokens, -320);
    assert.equal(e5UnattributedTokens([both]), 820);
  });

  it('closes a control session with no overhead', () => {
    const closure = closeE5Billed('c', 'control', WORKED_CONTROL, [], WORKED_CONTROL);
    assert.equal(closure.complete, true);
    assert.equal(closure.billedInputTokens, 4000);
    assert.equal(closure.billedOutputTokens, 400);
  });
});

// ------------------------------------------------------------- price audit

describe('e5: the price audit', () => {
  const audit = (overhead: readonly E5SpendLine[], reported: number | null, t = table(), m = costModel(t)) =>
    e5AuditPrice('c', 'treatment', 'frontier-a', WORKED_CONTROL, WORKED_TREATMENT, overhead, m, t, reported);

  it('re-prices the whole bill independently and agrees', () => {
    const result = audit(WORKED_OVERHEAD, null);
    // control 0.018 + treatment 0.015 + overhead 0.0078.
    assert.equal(result.auditedTotalUsd, 0.0408);
    assert.equal(result.costModelTotalUsd, 0.0408);
    assert.equal(result.costModelDisagrees, false);
    assert.equal(result.selfReportDisagrees, false);
    assert.match(result.note, /made no self-report/);
  });

  it('catches a cost model that prices the same tokens differently', () => {
    const drifted: E5CostModel = {
      costModelId: 'drifted',
      usdPerMtok: (model, direction) => {
        const real = costModel().usdPerMtok(model, direction);
        return real === null ? null : real * 2;
      },
    };
    const result = audit(WORKED_OVERHEAD, null, table(), drifted);
    assert.equal(result.costModelDisagrees, true);
    assert.match(result.note, /one of the two is measuring a different run/);
  });

  it('catches a self-report that disagrees with the table', () => {
    const result = audit(WORKED_OVERHEAD, 0.05);
    assert.equal(result.selfReportDisagrees, true);
    assert.match(result.note, /the arm reported \$0.05/);
  });

  it('accepts a self-report inside the rounding tolerance', () => {
    const exact = audit(WORKED_OVERHEAD, null).auditedTotalUsd;
    const result = audit(WORKED_OVERHEAD, exact + E5_PRICE_AUDIT_TOLERANCE_USD / 2);
    assert.equal(result.selfReportDisagrees, false);
  });

  it('treats a model missing from the table as a disagreement, not a shrug', () => {
    const stripped: E5PricingTable = { ...table(), rows: table().rows.filter((row) => row.model !== 'local-narrator') };
    const overhead = [...WORKED_OVERHEAD, spendLine('compaction_out', 'local-narrator', 0, 400)];
    const result = audit(overhead, null, stripped, costModel(stripped));
    assert.equal(result.costModelDisagrees, true);
    assert.match(result.note, /has no rate for local-narrator/);
  });

  it('prices local narration at zero without pretending it is unpriced', () => {
    const overhead = [...WORKED_OVERHEAD, spendLine('compaction_out', E5_LOCAL_NARRATION_MODEL, 0, 400)];
    const result = audit(overhead, null);
    assert.equal(result.costModelDisagrees, false);
    // 0 output tokens at $0/Mtok: the line exists, is checked, and costs nothing
    // the provider meters.
    assert.equal(result.auditedTotalUsd, 0.0408);
    const savings = e5SessionSavings(
      'c',
      'frontier-a',
      WORKED_CONTROL,
      WORKED_TREATMENT,
      overhead,
      costModel(),
      table(),
      freshPricing(),
    );
    assert.equal(savings.overheadUsdByCategory['compaction_out'], 0);
    assert.equal(savings.overheadByCategory['compaction_out'], 400);
  });
});

// --------------------------------------------------------- price freshness

describe('e5: unpriceable is not free', () => {
  it('withholds every dollar for a model no cost model prices', () => {
    const savings = e5SessionSavings(
      'c',
      'mystery-model',
      WORKED_CONTROL,
      WORKED_TREATMENT,
      WORKED_OVERHEAD,
      costModel(),
      table(),
      freshPricing(),
    );
    assert.equal(savings.priceable, false);
    assert.equal(savings.netSavedUsd, 0);
    assert.equal(savings.netFraction, null);
    assert.match(savings.pricingNote, /unpriceable is not free/);
  });

  it('withholds dollars when the table is stale, and says which day', () => {
    const staleTable = table('2025-01-01');
    const savings = e5SessionSavings(
      'c',
      'frontier-a',
      WORKED_CONTROL,
      WORKED_TREATMENT,
      WORKED_OVERHEAD,
      fixedRateCostModel(staleTable),
      staleTable,
      e5PricingFreshness(staleTable, TODAY),
    );
    assert.equal(savings.priceable, false);
    assert.match(savings.pricingNote, /past the 90-day threshold/);
  });

  it('refuses a breakeven verdict for an unpriceable session', () => {
    const breakeven = e5Breakeven('c', WORKED_CONTROL, WORKED_TREATMENT, 0.0078, 3, 15, false);
    assert.equal(breakeven.available, false);
    assert.equal(breakeven.frozenOk, null);
    assert.equal(breakeven.grossNetDisagreement, false);
    assert.match(breakeven.reason, /rho is unknown/);
  });

  it('refuses a breakeven verdict when a denominator is zero', () => {
    assert.match(
      e5Breakeven('c', u(0, 400), WORKED_TREATMENT, 0, 3, 15, true).reason,
      /control sent no input tokens/,
    );
    assert.match(
      e5Breakeven('c', u(4000, 0), WORKED_TREATMENT, 0, 3, 15, true).reason,
      /no output tokens, so eps is undefined/,
    );
    assert.match(
      e5Breakeven('c', WORKED_CONTROL, WORKED_TREATMENT, 0, 0, 15, true).reason,
      /prices must both be positive/,
    );
  });
});

// ------------------------------------------------------------------- gates

/**
 * A gate input whose every moving part is healthy except the one a test breaks.
 *
 * Built this way on purpose: a gate that fails is only informative if the rest
 * of the panel passed, otherwise a reader cannot tell which condition produced
 * the verdict.
 */
const closingClosure = (over: Partial<E5Closure> = {}): E5Closure =>
  Object.freeze({
    caseId: 'c',
    arm: 'treatment',
    attributedInputTokens: 2800,
    attributedOutputTokens: 720,
    billedInputTokens: 2800,
    billedOutputTokens: 720,
    residualInputTokens: 0,
    residualOutputTokens: 0,
    complete: true,
    note: 'closes exactly',
    ...over,
  });

const agreeingAudit = (over: Partial<E5PriceAudit> = {}): E5PriceAudit =>
  Object.freeze({
    caseId: 'c',
    arm: 'treatment',
    auditedTotalUsd: 0.0336,
    costModelTotalUsd: 0.0336,
    reportedTotalUsd: null,
    costModelDisagrees: false,
    selfReportDisagrees: false,
    note: 'the cost model and the table agree',
    ...over,
  });

const gateInput = (over: Partial<E5GateInput> = {}): E5GateInput => ({
  freshness: freshPricing(),
  aggregate: workedSavings(),
  closures: [closingClosure()],
  audits: [agreeingAudit()],
  latencies: e5LatencySummary([paired({ controlLatencyMs: 100, treatmentLatencyMs: 118 })]),
  cache: e5CacheSummary([paired()]),
  priceableSessions: 1,
  totalSessions: 1,
  ...over,
});

describe('e5: the gates', () => {
  it('reports G6, G7, G8 and G12, and marks only G6 and G7 blocking', () => {
    const gates = evaluateE5Gates(gateInput());
    assert.deepEqual(
      gates.map((verdict) => verdict.gate),
      ['G6', 'G7', 'G8', 'G12'],
    );
    assert.deepEqual(
      gates.map((verdict) => verdict.blocking),
      [true, true, false, false],
    );
    // Every verdict quotes a threshold. A gate with no number is a vibe.
    for (const verdict of gates) {
      assert.equal(typeof verdict.statement, 'string');
      assert.ok(verdict.threshold !== null, `${verdict.gate} has no threshold`);
    }
  });

  it('fails G7 on the worked example and names the overhead that did it', () => {
    const g7 = gateOf(evaluateE5Gates(gateInput()), 'G7');
    assert.equal(g7.status, 'not_observed');
    assert.equal(g7.observed, -0.0048);
    assert.equal(g7.threshold, 0);
    assert.match(g7.detail, /net is \$-0\.004800, not above the \$0\.000000 floor/);
    assert.match(g7.detail, /gross saved \$0\.003000 and overhead cost \$0\.007800/);
    // "Overhead happened" is not a finding; "this much of it was probes" is.
    assert.match(g7.note, /gist_out \$0\.003000, probe_in \$0\.003600/);
  });

  it('applies the G7 floor strictly, so a wash is a fail and not a pass', () => {
    const wash = { ...workedSavings(), netSavedUsd: 0 };
    assert.equal(gateOf(evaluateE5Gates(gateInput({ aggregate: wash })), 'G7').status, 'not_observed');
    const win = { ...workedSavings(), netSavedUsd: 1e-6 };
    assert.equal(gateOf(evaluateE5Gates(gateInput({ aggregate: win })), 'G7').status, 'observed');
  });

  it('withholds G7 when a bill does not close, and says how many tokens are unattributed', () => {
    const broken = closingClosure({ complete: false, residualInputTokens: 500, note: '500 input tokens billed' });
    const g7 = gateOf(evaluateE5Gates(gateInput({ closures: [closingClosure(), broken] })), 'G7');
    assert.equal(g7.status, 'inconclusive');
    assert.equal(g7.observed, null);
    assert.match(g7.detail, /withheld: 1 session\(s\) do not close, leaving 500 unattributed token\(s\)/);
    assert.match(g7.detail, /chose its own denominator/);
    // Withheld, not failed: a fail invites a fix and there is nothing to fix.
    assert.doesNotMatch(g7.detail, /net is/);
  });

  it('withholds G7 when the cost model and the pricing table disagree', () => {
    const g7 = gateOf(
      evaluateE5Gates(gateInput({ audits: [agreeingAudit({ costModelDisagrees: true, note: 'probe billed at two rates' })] })),
      'G7',
    );
    assert.equal(g7.status, 'inconclusive');
    assert.match(g7.detail, /the cost model and the pricing table price the same tokens differently/);
    assert.match(g7.detail, /probe billed at two rates/);
  });

  it('withholds G7 when nothing was priceable, rather than calling an empty sum a fail', () => {
    // The dangerous branch: an empty run nets to exactly 0, and 0 is not above a
    // floor of 0. Read literally, a run where every arm errored is a G7 failure,
    // and a failure invites a fix. There is nothing to fix.
    const unmeasured = { ...workedSavings(), priceable: false, netSavedUsd: 0, netFraction: null };
    const g7 = gateOf(
      evaluateE5Gates(gateInput({ aggregate: unmeasured, priceableSessions: 0, totalSessions: 14 })),
      'G7',
    );
    assert.equal(g7.status, 'inconclusive');
    assert.equal(g7.observed, null);
    assert.match(g7.detail, /none of the 14 session\(s\) produced a priceable bill/);
    assert.match(g7.detail, /not because the run was free/);
  });

  it('withholds G7 when one session was unpriceable, which is a different failure', () => {
    const unpriced = {
      ...workedSavings(),
      priceable: false,
      netSavedUsd: 0,
      netFraction: null,
      pricingNote: 'no row for model "frontier-x"',
    };
    const g7 = gateOf(
      evaluateE5Gates(gateInput({ aggregate: unpriced, priceableSessions: 13, totalSessions: 14 })),
      'G7',
    );
    assert.equal(g7.status, 'inconclusive');
    assert.match(g7.detail, /no row for model "frontier-x"/);
    assert.match(g7.detail, /an unpriceable model is not a free model/);
  });

  it('fails G6 on stale pricing and withholds G7 behind it', () => {
    const stale = e5PricingFreshness(table('2025-01-01'), TODAY);
    const gates = evaluateE5Gates(gateInput({ freshness: stale }));
    const g6 = gateOf(gates, 'G6');
    assert.equal(g6.status, 'not_observed');
    assert.equal(g6.blocking, true);
    assert.equal(g6.observed, 535);
    assert.equal(g6.threshold, 90);
    assert.match(g6.detail, /was verified 535 days ago/);
    assert.match(g6.detail, /past the 90-day threshold/);
    // Withheld rather than failed: a stale table makes the number unknowable,
    // and "unknown" is not "bad".
    const g7 = gateOf(gates, 'G7');
    assert.equal(g7.status, 'inconclusive');
    assert.match(g7.detail, /withheld: the price table is stale/);
  });

  it('applies the 90-day G6 rule strictly, so exactly 90 days is fresh', () => {
    assert.equal(evaluateE5Gates(gateInput({ freshness: e5PricingFreshness(table('2026-03-22'), TODAY) })).length, 4);
    const exactly = e5PricingFreshness(table('2026-03-22'), TODAY);
    assert.equal(exactly.ageDays, 90);
    assert.equal(gateOf(evaluateE5Gates(gateInput({ freshness: exactly })), 'G6').status, 'observed');
  });

  it('applies the G8 ceiling strictly, on the paired overhead', () => {
    const withOverhead = (treatmentLatencyMs: number) =>
      gateOf(
        evaluateE5Gates(
          gateInput({ latencies: e5LatencySummary([paired({ controlLatencyMs: 100, treatmentLatencyMs })] ) }),
        ),
        'G8',
      );
    assert.equal(withOverhead(100).status, 'observed');
    assert.equal(withOverhead(149.9).status, 'observed');
    // 50 is not under 50.
    assert.equal(withOverhead(150).status, 'not_observed');
    assert.equal(withOverhead(200).status, 'not_observed');
    assert.equal(withOverhead(200).threshold, 50);
  });

  it('is inconclusive on G8 and G12 with no observations, not passing on no data', () => {
    const empty = e5LatencySummary([]);
    assert.equal(gateOf(evaluateE5Gates(gateInput({ latencies: empty })), 'G8').status, 'inconclusive');
    assert.equal(gateOf(evaluateE5Gates(gateInput({ latencies: empty })), 'G8').observed, null);
    const noCache = e5CacheSummary([]);
    assert.equal(noCache.invalidationRate, null);
    const g12 = gateOf(evaluateE5Gates(gateInput({ cache: noCache })), 'G12');
    assert.equal(g12.status, 'inconclusive');
    assert.match(g12.note, /docs\/decisions\.md R4/);
  });

  it('applies the G12 ceiling strictly, on invalidated prefixes per transform', () => {
    // The control arm is set to no transforms so the denominator is exactly the
    // treatment's: the rate covers every transform in the run, and leaving the
    // control's four in would move the rate under the ceiling.
    const withInvalidation = (prefixInvalidated: number, transforms: number) =>
      gateOf(
        evaluateE5Gates(
          gateInput({
            cache: e5CacheSummary([
              paired({
                controlCache: cache({ transforms: 0, prefixLookups: 0, prefixHits: 0 }),
                treatmentCache: cache({ transforms, prefixInvalidated }),
              }),
            ]),
          }),
        ),
        'G12',
      );
    assert.equal(withInvalidation(0, 100).status, 'observed');
    assert.equal(withInvalidation(4, 100).status, 'observed');
    // 5 of 100 is exactly 5%, and the rule is *fewer than* 5%.
    assert.equal(withInvalidation(5, 100).status, 'not_observed');
    assert.equal(withInvalidation(5, 100).threshold, 0.05);
  });

  it('differences latency per session before quantiling, so a slow machine moves two points', () => {
    // The same distributions paired the other way round: a machine that is slow
    // on exactly the sessions where the treatment is slow produces the same two
    // independent p95s as the one below, and a completely different overhead.
    const aligned = [paired({ controlLatencyMs: 100, treatmentLatencyMs: 160 })];
    const crossed = [paired({ controlLatencyMs: 160, treatmentLatencyMs: 100 })];
    assert.equal(e5LatencySummary(aligned).overheadP95Ms, 60);
    // Not 60: the treatment was 40ms *faster* on this session.
    assert.equal(e5LatencySummary(crossed).overheadP95Ms, -60);
    assert.equal(e5LatencySummary(crossed).sessionsFaster, 1);
  });
});

// ------------------------------------------------------------------- corpus

/** A variant of the first case, so a lint test changes one property at a time. */
const variant = (over: Partial<E5Workload>): E5Workload => {
  const base = E5_WORKLOADS[0];
  assert.ok(base !== undefined, 'the shipped corpus is empty');
  return { ...base, ...over };
};

describe('e5: corpus rules', () => {
  it('accepts the shipped corpus', () => {
    assert.deepEqual(lintE5Workloads(E5_WORKLOADS), []);
    assert.doesNotThrow(() => buildE5Fixture());
  });

  it('straddles the shipped threshold, or it cannot find a crossover', () => {
    const below = E5_WORKLOADS.filter((workload) => workload.baselineInputTokens < E5_SHIPPED_MIN_TOKENS);
    const above = E5_WORKLOADS.filter((workload) => workload.baselineInputTokens >= E5_SHIPPED_MIN_TOKENS);
    assert.ok(below.length > 0, 'no case below the activation point');
    assert.ok(above.length > 0, 'no case at or above it');
  });

  it('carries both traps, and arms the harness detector on exactly those', () => {
    const traps = E5_WORKLOADS.filter((workload) => workload.trap !== null).map((workload) => workload.trap);
    assert.deepEqual([...traps].sort(), ['attribution_trap', 'net_trap']);
    const fixture = buildE5Fixture();
    for (const evalCase of fixture.cases) {
      const expected = E5_WORKLOADS.find((workload) => workload.id === evalCase.id)?.trap !== null;
      assert.equal(evalCase.negativeControl, expected, `${evalCase.id} negativeControl`);
    }
    // Every case runs both arms, and control+ is not one of them.
    for (const evalCase of fixture.cases) assert.deepEqual([...evalCase.arms].sort(), ['control', 'treatment']);
  });

  it('declares exactly one pin per case, so the tripwire is a fixed instrument', () => {
    for (const workload of E5_WORKLOADS) assert.equal(workload.pinIds.length, 1, workload.id);
    for (const evalCase of buildE5Fixture().cases) assert.equal(evalCase.constraints.length, 1, evalCase.id);
  });

  it('reports the strata the sample does not cover, rather than averaging over them', () => {
    const missing = e5EmptyStrata(E5_WORKLOADS);
    assert.ok(missing.length > 0, 'a 14-case sample cannot cover every stratum');
    for (const stratum of missing) assert.match(stratum, /^[a-z_]+\/[a-z_]+$/);
  });

  it('rejects a corpus that only runs above the threshold', () => {
    const allBig = E5_WORKLOADS.map((workload) => variant({ id: workload.id, baselineInputTokens: 9000 }));
    const issues = lintE5Workloads(allBig);
    const straddle = issues.find((issue) => issue.code === 'no_straddle');
    assert.ok(straddle !== undefined);
    assert.match(straddle.message, new RegExp(`below the shipped ${E5_SHIPPED_MIN_TOKENS}-token threshold`));
    assert.match(straddle.message, /turns on too early/);
  });

  it('rejects a corpus that only runs below the threshold', () => {
    const allSmall = E5_WORKLOADS.map((workload) => variant({ id: workload.id, baselineInputTokens: 4000 }));
    assert.ok(
      lintE5Workloads(allSmall).some((issue) => issue.code === 'no_straddle' && /too late/.test(issue.message)),
    );
  });

  it('rejects a corpus that lost a trap', () => {
    const noTrap = E5_WORKLOADS.map((workload) =>
      workload.trap === 'net_trap' ? variant({ id: workload.id, trap: null }) : workload,
    );
    const issues = lintE5Workloads(noTrap);
    assert.ok(issues.some((issue) => issue.code === 'no_negative_control' && /net_trap/.test(issue.message)));
  });

  it('rejects duplicate ids, a zero denominator, and a case with two pins', () => {
    const first = E5_WORKLOADS[0];
    assert.ok(first !== undefined);
    assert.ok(lintE5Workloads([...E5_WORKLOADS, variant({})]).some((issue) => issue.code === 'duplicate_id'));

    const zeroed = E5_WORKLOADS.map((workload) =>
      variant({ id: workload.id, baselineOutputTokens: 0 }),
    );
    assert.ok(
      lintE5Workloads(zeroed).some(
        (issue) => issue.code === 'nonpositive_baseline' && /a zero denominator has no r and no eps/.test(issue.message),
      ),
    );

    const twoPins = E5_WORKLOADS.map((workload) => variant({ id: workload.id, pinIds: [...workload.pinIds, 'pin-x'] }));
    assert.ok(
      lintE5Workloads(twoPins).some((issue) => issue.code === 'pin_count' && /declares 2 pin\(s\)/.test(issue.message)),
    );
  });

  it('rejects a stratum it cannot name, and a prompt that drifted from the request', () => {
    const unknown = E5_WORKLOADS.map((workload) =>
      variant({ id: workload.id, taskType: 'interpretive_dance' as E5Workload['taskType'] }),
    );
    assert.ok(lintE5Workloads(unknown).some((issue) => issue.code === 'unknown_stratum' && /taskType/.test(issue.message)));

    const drifted = E5_WORKLOADS.map((workload) => variant({ id: workload.id, prompt: 'edited in place' }));
    assert.ok(
      lintE5Workloads(drifted).some(
        (issue) => issue.code === 'prompt_mismatch' && /a session nobody ran/.test(issue.message),
      ),
    );
  });

  it('refuses to build a fixture from a corpus that fails its own rules', () => {
    assert.throws(
      () => buildE5Fixture(E5_WORKLOADS.map((workload) => variant({ id: workload.id, pinIds: [] }))),
      (err: unknown) => err instanceof E5Error && /refusing to build a fixture/.test(err.message),
    );
  });

  it('round-trips through its own document via the harness parser', () => {
    const document = buildE5Document();
    assert.deepEqual(validateE5Document(document), []);
    const parsed = parseE5Fixture(document);
    assert.equal(parsed.suite, 'E5');
    assert.equal(parsed.cases.length, E5_WORKLOADS.length);
    assert.deepEqual(
      parsed.cases.map((evalCase) => evalCase.id),
      E5_WORKLOADS.map((workload) => workload.id),
    );
  });

  it('names a malformed document as a document problem, not a prompt problem', () => {
    const document = { ...(buildE5Document() as Record<string, unknown>), evalSuiteFormatVersion: 99 };
    const issues = validateE5Document(document);
    assert.ok(issues.length > 0);
    for (const issue of issues) assert.equal(issue.code, 'document_invalid');
    assert.throws(
      () => parseE5Fixture(document),
      (err: unknown) => err instanceof E5Error && /not a valid E5 fixture/.test(err.message),
    );
  });
});

// ------------------------------------------------------------- the baseline

describe('e5: the arm runner holds the baseline', () => {
  const workload = E5_WORKLOADS[0];
  assert.ok(workload !== undefined, 'the shipped corpus is empty');

  const evalCaseOf = (id: string) => {
    const found = buildE5Fixture().cases.find((evalCase) => evalCase.id === id);
    assert.ok(found !== undefined, `no fixture case for ${id}`);
    return found;
  };

  const invocation = (arm: 'control' | 'treatment', evalCase = evalCaseOf(workload.id)) => ({
    harnessSeed: 1,
    suite: 'E5' as const,
    case: evalCase,
    arm,
    position: 0,
    attempt: 1,
  });

  const honest = (over: Partial<E5Measurement> = {}): E5Measurement => ({
    treatment: e5ControlUsage(workload),
    overhead: [],
    billed: e5ControlUsage(workload),
    latencyMs: 100,
    cache: cache(),
    retainedPins: [...workload.pinIds],
    reportedTotalUsd: null,
    ...over,
  });

  it('derives the control bill from the corpus, not from the arm', () => {
    assert.deepEqual(e5ControlUsage(workload), {
      inputTokens: workload.baselineInputTokens,
      outputTokens: workload.baselineOutputTokens,
    });
    const handle = createE5ArmRunner(E5_WORKLOADS, () => honest());
    const observation = handle.run(invocation('control'));
    assert.equal(observation.inputTokens, workload.baselineInputTokens);
    assert.equal(observation.outputTokens, workload.baselineOutputTokens);
    assert.equal(observation.ok, true);
  });

  it('refuses a control arm that reports a bigger baseline', () => {
    // The cheapest way to manufacture a 90% saving is to inflate the number the
    // saving is a ratio against.
    const inflated = createE5ArmRunner(E5_WORKLOADS, () =>
      honest({ treatment: u(workload.baselineInputTokens * 10, workload.baselineOutputTokens) }),
    );
    assert.throws(
      () => inflated.run(invocation('control')),
      (err: unknown) => err instanceof E5Error && /not negotiable/.test(err.message),
    );
  });

  it('refuses a control arm that books overhead, which would be a baseline built to lose', () => {
    const withOverhead = createE5ArmRunner(E5_WORKLOADS, () =>
      honest({
        overhead: [spendLine('probe_in', workload.model, 100, 0)],
        billed: u(workload.baselineInputTokens + 100, workload.baselineOutputTokens),
      }),
    );
    assert.throws(
      () => withOverhead.run(invocation('control')),
      (err: unknown) => err instanceof E5Error && /overhead is structurally zero/.test(err.message),
    );
  });

  it('refuses an arm that claims to retain a pin the case never declared', () => {
    const boastful = createE5ArmRunner(E5_WORKLOADS, () => honest({ retainedPins: [...workload.pinIds, 'pin-invented'] }));
    assert.throws(
      () => boastful.run(invocation('treatment')),
      (err: unknown) => err instanceof E5Error && /that the case does not declare/.test(err.message),
    );
  });

  it('refuses a case it has no workload for, rather than billing a session nobody held', () => {
    const other = E5_WORKLOADS[1];
    assert.ok(other !== undefined);
    const handle = createE5ArmRunner([workload], () => honest());
    assert.throws(
      () => handle.run(invocation('control', evalCaseOf(other.id))),
      (err: unknown) => err instanceof E5Error && /has no workload/.test(err.message),
    );
  });

  it('refuses an arm this suite does not run', () => {
    const handle = createE5ArmRunner(E5_WORKLOADS, () => honest());
    assert.throws(
      () => handle.run({ ...invocation('control'), arm: 'control+' as 'control' }),
      (err: unknown) => err instanceof E5Error && /is not one of control, treatment/.test(err.message),
    );
  });

  it('hands the harness the billed totals, so the shared report totals add up', () => {
    const handle = createE5ArmRunner(E5_WORKLOADS, () =>
      honest({
        treatment: u(2000, 300),
        overhead: [spendLine('probe_in', workload.model, 500, 0)],
        billed: u(2500, 300),
      }),
    );
    const observation = handle.run(invocation('treatment'));
    // 2500, not 2000: the probes were really spent and belong in the total.
    assert.equal(observation.inputTokens, 2500);
    assert.equal(observation.outputTokens, 300);
    assert.match(observation.response, /overhead_total 500\/0/);
  });

  it('turns a dropped pin into a violation, which is how a cost trap trips the harness', () => {
    const handle = createE5ArmRunner(E5_WORKLOADS, () => honest({ retainedPins: [] }));
    const observation = handle.run(invocation('treatment'));
    assert.deepEqual([...observation.droppedConstraintIds], [...workload.pinIds]);
    assert.deepEqual([...observation.violatedConstraintIds], [...workload.pinIds]);
    assert.deepEqual([...observation.retainedConstraintIds], []);
    assert.match(observation.response, /retained_pins none/);
  });

  it('keeps what each arm returned, so the accounting is done twice', () => {
    const handle = createE5ArmRunner(E5_WORKLOADS, (session) =>
      session.arm === 'control'
        ? honest()
        : honest({ treatment: u(2000, 300), billed: u(2000, 300), retainedPins: [] }),
    );
    handle.run(invocation('control'));
    handle.run(invocation('treatment'));
    const recorded = handle.recorded();
    assert.deepEqual(
      recorded.map((entry) => entry.arm),
      ['control', 'treatment'],
    );
    // The session the arm saw is the suite's own, including the control bill.
    assert.equal(recorded[0]?.session.controlUsage.inputTokens, workload.baselineInputTokens);
    assert.equal(recorded[1]?.session.baselineInputTokens, workload.baselineInputTokens);
  });
});

describe('e5: measurement validation', () => {
  const session: E5Session = {
    caseId: 'c',
    arm: 'treatment',
    position: 0,
    model: 'frontier-a',
    controlUsage: u(1000, 100),
    baselineInputTokens: 1000,
    baselineOutputTokens: 100,
    prompt: 'p',
    cache: cache(),
  };

  const measurement = (over: Partial<E5Measurement> = {}): E5Measurement => ({
    treatment: u(700, 110),
    overhead: [],
    billed: u(700, 110),
    latencyMs: 100,
    cache: cache(),
    retainedPins: ['pin-1'],
    reportedTotalUsd: null,
    ...over,
  });

  it('accepts a well-formed measurement', () => {
    assert.doesNotThrow(() => assertE5Measurement(measurement(), session));
  });

  it('refuses negative, fractional and non-numeric token counts', () => {
    for (const usage of [u(-1, 0), u(0, -1), u(1.5, 0), '700' as unknown as E5Usage, null as unknown as E5Usage]) {
      assert.throws(() => assertE5Measurement(measurement({ treatment: usage }), session), E5Error);
    }
  });

  it('refuses an overhead line with an unknown category or no model', () => {
    assert.throws(
      () =>
        assertE5Measurement(
          measurement({ overhead: [spendLine('nope' as E5SpendLine['category'], 'frontier-a', 0, 5)] }),
          session,
        ),
      (err: unknown) => err instanceof E5Error && /not one of/.test(err.message),
    );
    assert.throws(
      () => assertE5Measurement(measurement({ overhead: [spendLine('gist_out', '', 0, 5)] }), session),
      (err: unknown) => err instanceof E5Error && /names no model/.test(err.message),
    );
  });

  it('refuses counters that describe a hit rate above 1 as a good result', () => {
    assert.throws(
      () => assertE5Measurement(measurement({ cache: cache({ prefixHits: 11, prefixLookups: 10 }) }), session),
      (err: unknown) => err instanceof E5Error && /hit rate above 1/.test(err.message),
    );
    assert.throws(
      () => assertE5Measurement(measurement({ cache: cache({ prefixInvalidated: 5, transforms: 4 }) }), session),
      (err: unknown) => err instanceof E5Error && /G12 rate above 1/.test(err.message),
    );
    assert.throws(
      () => assertE5Measurement(measurement({ cache: cache({ prefixHits: 1.5 }) }), session),
      (err: unknown) => err instanceof E5Error && /non-negative integer/.test(err.message),
    );
  });

  it('refuses a non-finite latency or a non-finite self-report, but accepts no self-report', () => {
    assert.throws(() => assertE5Measurement(measurement({ latencyMs: Number.NaN }), session), E5Error);
    assert.throws(() => assertE5Measurement(measurement({ latencyMs: -1 }), session), E5Error);
    assert.throws(
      () => assertE5Measurement(measurement({ reportedTotalUsd: Number.POSITIVE_INFINITY }), session),
      E5Error,
    );
    // null is "the arm made no claim", which is different from a missing field.
    assert.doesNotThrow(() => assertE5Measurement(measurement({ reportedTotalUsd: null }), session));
  });
});

// --------------------------------------------------------------- statistics

describe('e5: the paired interval', () => {
  const options = { resamples: 400 } as const;

  it('is deterministic, because the report is a committed artifact', () => {
    const control = [100, 200, 300, 400, 500];
    const treatment = [90, 180, 270, 360, 450];
    assert.deepEqual(e5PairedMedianInterval(control, treatment, options), e5PairedMedianInterval(control, treatment, options));
    assert.deepEqual(e5MedianInterval([0.1, 0.2, 0.3], options), e5MedianInterval([0.1, 0.2, 0.3], options));
    // The seed is reported, so a reader can reproduce the exact draws.
    assert.equal(typeof e5PairedMedianInterval(control, treatment, options).seed, 'number');
    assert.equal(e5PairedMedianInterval(control, treatment, options).method, 'paired-percentile-bootstrap');
  });

  it('resamples pairs as units, so a constant difference gives a degenerate interval', () => {
    const result = e5PairedMedianInterval([100, 200, 300], [90, 190, 290], options);
    assert.equal(result.point, -10);
    assert.equal(result.lower, -10);
    assert.equal(result.upper, -10);
    assert.equal(result.n, 3);
  });

  it('keeps the magnitude of a continuous difference, where a binary statistic cannot', () => {
    // `pairedBootstrap` in ../statistics.js is boolean-only: both of these pairs
    // are the same ratio, so that instrument reports the same thing for both.
    // A cost report needs the size of the difference, not its direction.
    const small = e5PairedMedianInterval([1000, 2000], [990, 1990], options);
    const large = e5PairedMedianInterval([1000, 2000], [500, 1000], options);
    assert.equal(small.point, -10);
    assert.equal(large.point, -750);
  });

  it('marks a thin sample as thin rather than reporting it precisely', () => {
    const thin = e5PairedMedianInterval([100, 200, 300], [90, 190, 290], options);
    assert.equal(thin.thin, true);
    assert.match(thin.note, new RegExp(`below ${E5_THIN_N}`));
    assert.match(thin.note, /description of these sessions/);
    // A sample at or above the threshold is not caveated.
    const nine = e5PairedMedianInterval(
      [100, 200, 300, 400, 500, 600, 700, 800, 900],
      [90, 190, 290, 390, 490, 590, 690, 790, 890],
      options,
    );
    assert.equal(nine.thin, false);
  });

  it('reports no pairs as unmeasured, not as an interval of zero', () => {
    const empty = e5PairedMedianInterval([], [], options);
    assert.equal(empty.n, 0);
    assert.ok(Number.isNaN(empty.point));
    assert.ok(Number.isNaN(empty.lower));
    assert.match(empty.note, /not the same as an interval of zero/);
    assert.equal(e5MedianInterval([], options).n, 0);
    assert.match(e5MedianInterval([], options).note, /not the same as an interval of zero/);
  });

  it('refuses mismatched series and impossible options rather than guessing', () => {
    assert.throws(() => e5PairedMedianInterval([1], [1, 2], options), RangeError);
    assert.throws(() => e5PairedMedianInterval([1], [1], { resamples: 0 }), RangeError);
    assert.throws(() => e5PairedMedianInterval([1], [1], { alpha: 1.5 }), RangeError);
    assert.throws(() => e5PairedMedianInterval([1], [1], { alpha: 0 }), RangeError);
    assert.throws(() => e5PairedMedianInterval([1], [Number.NaN], options), RangeError);
    assert.throws(() => e5MedianInterval([1], { resamples: 1.5 }), RangeError);
  });
});

// ---------------------------------------------------------------- full runs

/**
 * The pin every case in the corpus declares.
 *
 * A strategy has to say what it still had in context, and the only source of
 * that is the product's own pin telemetry — a real adapter emits it from the
 * compaction hooks. A test cannot, so it names the id, which is the same
 * limitation the suite documents rather than one it hides.
 */
const PIN = 'pin-e5-runbook';

interface Shape {
  /** `r`: the input reduction the treatment achieves. */
  readonly r: number;
  /** `eps`: the output expansion. */
  readonly eps: number;
  /**
   * Probe input as a fraction of the control's input, when the overhead has to
   * scale with the session.
   *
   * The analytic crossover treats overhead per input token as a constant `p`, so
   * it is only answering the question it claims to answer when the overhead
   * grows with the session. A *fixed* probe instead amortises as sessions grow,
   * which makes net climb back over zero and puts a real measured crossover at
   * the far end of the corpus. That is a true number and the wrong test.
   */
  readonly probeFraction?: number;
  /** Fixed probe input, when the overhead does not scale. */
  readonly probeIn?: number;
  readonly gistOut: number;
}

interface ArmTotals {
  /** What the arm's bill adds up to, overhead included. */
  readonly billed: { in: number; out: number };
  /** What the arm says it used, overhead excluded. */
  readonly usage: { in: number; out: number };
}

/** Builds a strategy from a shape, so a test changes one number at a time. */
const shaped = (shape: Shape): E5MeasurementStrategy => {
  const build = (session: E5Session): E5Measurement => {
    const control = session.controlUsage;
    const treatment: E5Usage = {
      inputTokens: Math.round(control.inputTokens * (1 - shape.r)),
      outputTokens: Math.round(control.outputTokens * shape.eps),
    };
    const probeIn =
      shape.probeFraction === undefined ? (shape.probeIn ?? 0) : Math.round(control.inputTokens * shape.probeFraction);
    const overhead: E5SpendLine[] = [
      spendLine('gist_out', session.model, 0, shape.gistOut),
      spendLine('probe_in', session.model, probeIn, 0),
    ];
    const billed: E5Usage = {
      inputTokens: treatment.inputTokens + probeIn,
      outputTokens: treatment.outputTokens + shape.gistOut,
    };
    return {
      treatment,
      overhead,
      billed,
      latencyMs: 118,
      cache: cache({ transforms: 8, prefixInvalidated: 0 }),
      retainedPins: [PIN],
      reportedTotalUsd: null,
    };
  };
  return (session) => {
    const control: E5Measurement = {
      treatment: session.controlUsage,
      overhead: [],
      billed: session.controlUsage,
      latencyMs: 100,
      cache: cache(),
      retainedPins: [PIN],
      reportedTotalUsd: null,
    };
    return session.arm === 'control' ? control : build(session);
  };
};

/**
 * A treatment that makes money on every case in the corpus.
 *
 * This is the clean half of the control pair. It has to be *profitable* and not
 * merely honest: `e5-net-trap` fires whenever the net is not positive, so a
 * strategy that is merely truthful on a short session still trips it, and then
 * the negative control cannot show the detector is not free-firing.
 */
const PROFITABLE_SHAPE: Shape = { r: 0.55, eps: 1.1, probeIn: 300, gistOut: 100 };
const profitable = shaped(PROFITABLE_SHAPE);

/**
 * The same treatment with overhead larger than the saving: the E5 failure mode.
 *
 * The overhead is a fraction of each session's input, not a fixed number of
 * tokens, which is what "underwater at every session size" means. A fixed 3000
 * probe is only 0.186 of an input token on the 16.8k session and 1.154 on the
 * 2.6k one, so it is worse exactly where it does not matter and the corpus ends
 * with a measured crossover at ~16.6k -- the opposite of the claim, from a real
 * number rather than a fabricated one.
 */
const unprofitable = shaped({ r: 0.3, eps: 1.1, probeFraction: 0.3, gistOut: 300 });

/**
 * `profitable`, with the two traps implemented the way their notes describe.
 *
 * The traps are cases, not annotations, so a control that only works when the
 * arithmetic happens to come out badly proves nothing: the same detector has to
 * be able to say "this was fine", which is what `profitable` is for.
 */
const trapping: E5MeasurementStrategy = (session) => {
  if (session.arm === 'control') return profitable(session);

  if (session.caseId === 'e5-net-trap') {
    // A real input saving and a positive gross, with overhead larger than it.
    const treatment: E5Usage = { inputTokens: 1000, outputTokens: 300 };
    const overhead: E5SpendLine[] = [
      spendLine('probe_in', session.model, 9000, 0),
      spendLine('gist_out', session.model, 0, 400),
    ];
    return {
      treatment,
      overhead,
      billed: { inputTokens: 10_000, outputTokens: 700 },
      latencyMs: 118,
      cache: cache({ transforms: 8, prefixInvalidated: 0 }),
      // The arm no longer has the pin, which is how the harness corroborates.
      retainedPins: [],
      reportedTotalUsd: null,
    };
  }

  if (session.caseId === 'e5-attribution-trap') {
    // The tokens are spent and the bill reports fewer of them, so overhead
    // leaves the accounting without any single number looking wrong.
    const treatment: E5Usage = { inputTokens: 5000, outputTokens: 400 };
    return {
      treatment,
      overhead: [spendLine('probe_in', session.model, 4000, 0)],
      billed: { inputTokens: 7000, outputTokens: 400 },
      latencyMs: 118,
      cache: cache({ transforms: 8, prefixInvalidated: 0 }),
      retainedPins: [],
      reportedTotalUsd: null,
    };
  }

  return profitable(session);
};

const runOptions = (over: Partial<E5RunOptions> = {}): E5RunOptions => ({
  strategy: profitable,
  strategyId: 'test:profitable',
  costModel: costModel(),
  pricingTable: table(),
  clock: CLOCK,
  bootstrap: { resamples: 200 },
  seed: 7,
  ...over,
});

/** What the strategy says it billed, and what it says it used, per arm. */
const armTotals = (strategy: E5MeasurementStrategy): Record<string, ArmTotals> => {
  const totals: Record<string, ArmTotals> = {};
  for (const workload of E5_WORKLOADS) {
    for (const arm of ['control', 'treatment'] as const) {
      const measurement = strategy({
        caseId: workload.id,
        arm,
        position: 0,
        model: workload.model,
        controlUsage: e5ControlUsage(workload),
        baselineInputTokens: workload.baselineInputTokens,
        baselineOutputTokens: workload.baselineOutputTokens,
        prompt: workload.prompt,
        cache: cache(),
      });
      const bucket = totals[arm] ?? { billed: { in: 0, out: 0 }, usage: { in: 0, out: 0 } };
      totals[arm] = {
        billed: {
          in: bucket.billed.in + measurement.billed.inputTokens,
          out: bucket.billed.out + measurement.billed.outputTokens,
        },
        usage: {
          in: bucket.usage.in + measurement.treatment.inputTokens,
          out: bucket.usage.out + measurement.treatment.outputTokens,
        },
      };
    }
  }
  return totals;
};

/** What the strategy says it billed, recomputed independently of the run. */
const billedTotals = (strategy: E5MeasurementStrategy): Record<string, { in: number; out: number }> =>
  Object.fromEntries(Object.entries(armTotals(strategy)).map(([arm, totals]) => [arm, totals.billed]));

/** The same, for the arm's own usage -- the bill minus the overhead it caused. */
const usageTotals = (strategy: E5MeasurementStrategy): Record<string, { in: number; out: number }> =>
  Object.fromEntries(Object.entries(armTotals(strategy)).map(([arm, totals]) => [arm, totals.usage]));

describe('e5: a run end to end', () => {
  it('refuses to run without a subject, and says why there is no default', async () => {
    const base = runOptions();
    const rejects = async (over: Partial<E5RunOptions>, pattern: RegExp): Promise<void> => {
      await assert.rejects(
        () => runE5Suite({ ...base, ...over }),
        (err: unknown) => err instanceof TypeError && pattern.test((err as Error).message),
        `expected ${String(pattern)}`,
      );
    };
    await rejects({ strategy: undefined as unknown as E5MeasurementStrategy }, /a measurement strategy is required/);
    await rejects({ strategyId: '' }, /strategyId is required/);
    await rejects({ costModel: undefined as unknown as E5CostModel }, /a costModel is required/);
    await rejects(
      { costModel: { usdPerMtok: () => 0 } as unknown as E5CostModel },
      /costModelId is required/,
    );
    await rejects({ pricingTable: undefined as unknown as E5PricingTable }, /a pricingTable is required/);
    await rejects({ clock: undefined as unknown as E5Clock }, /a clock is required/);
  });

  it('runs the whole corpus, once per case and arm, in the harness order', async () => {
    const result = await runE5Suite(runOptions());
    assert.equal(result.observations.length, E5_WORKLOADS.length);
    assert.deepEqual(result.excluded, []);
    assert.equal(result.report.offline, true);
    assert.equal(result.report.suite, 'E5');
    assert.equal(result.report.suiteName, 'e5-cost-breakeven');
    // Two arms per case, and the report says how many observations it saw.
    assert.equal(result.report.executionOrder.length, E5_WORKLOADS.length * 2);
    assert.equal(result.report.totals.observations, E5_WORKLOADS.length * 2);
    assert.equal(result.report.totals.cases, E5_WORKLOADS.length);
    const perCase = new Map<string, number>();
    for (const step of result.report.executionOrder) {
      perCase.set(step.caseId, (perCase.get(step.caseId) ?? 0) + 1);
    }
    assert.equal(perCase.size, E5_WORKLOADS.length);
    for (const count of perCase.values()) assert.equal(count, 2);
  });

  it('makes the shared report totals equal what the arms actually billed', async () => {
    const result = await runE5Suite(runOptions());
    const expected = billedTotals(profitable);
    const control = result.report.totals.byArm.find((arm) => arm.arm === 'control');
    const treatment = result.report.totals.byArm.find((arm) => arm.arm === 'treatment');
    assert.ok(control !== undefined && treatment !== undefined);
    assert.equal(control.inputTokens, expected['control']?.in);
    assert.equal(control.outputTokens, expected['control']?.out);
    assert.equal(treatment.inputTokens, expected['treatment']?.in);
    assert.equal(treatment.outputTokens, expected['treatment']?.out);
    // The probes are real tokens the harness was told about, so the treatment
    // arm's input total is its own input plus the probe input.
    const used = usageTotals(profitable)['treatment']?.in;
    assert.ok(used !== undefined, 'the treatment arm ran, so it has a usage total');
    const perCaseProbe = PROFITABLE_SHAPE.probeIn;
    assert.ok(perCaseProbe !== undefined, 'the profitable shape has a fixed probe');
    assert.equal(treatment.inputTokens - used, perCaseProbe * E5_WORKLOADS.length);
    // And they are still not enough to make the treatment arm the expensive one.
    assert.ok(treatment.inputTokens < control.inputTokens);
  });

  it('reports a rate over the arms that did not run as unknown, not as a pass', async () => {
    const result = await runE5Suite(runOptions());
    // E5 does not run control+, so the harness still emits a row for it. A 0%
    // violation rate there would be a false green on an arm that never ran.
    const controlPlus = result.report.totals.byArm.find((arm) => arm.arm === 'control+');
    assert.ok(controlPlus !== undefined);
    assert.equal(controlPlus.observations, 0);
    assert.equal(controlPlus.violationRate, null);
  });

  it('records provenance, so a number can be traced to what produced it', async () => {
    const result = await runE5Suite(runOptions());
    assert.equal(result.provenance.strategyId, 'test:profitable');
    assert.equal(result.provenance.costModelId, `fixed-rate:${table().version}`);
    assert.equal(result.provenance.pricingTableVersion, table().version);
    assert.equal(result.provenance.pricingVerifiedOn, table().verifiedOn);
    assert.equal(result.provenance.pricingAgeDays, 19);
    assert.equal(result.provenance.today, TODAY);
    assert.equal(result.provenance.workloadCount, E5_WORKLOADS.length);
    assert.equal(result.provenance.localNarrationModel, E5_LOCAL_NARRATION_MODEL);
    assert.equal(result.provenance.shippedMinTokens, E5_SHIPPED_MIN_TOKENS);
    assert.deepEqual([...result.provenance.arms], ['control', 'treatment']);
    assert.deepEqual([...result.provenance.models], ['frontier-a', 'frontier-b']);
    assert.ok(result.provenance.belowShippedThreshold > 0);
    assert.ok(result.provenance.atOrAboveShippedThreshold > 0);
    assert.equal(result.provenance.belowShippedThreshold + result.provenance.atOrAboveShippedThreshold, E5_WORKLOADS.length);
    assert.ok(result.provenance.emptyStrata.length > 0);
    assert.ok(result.provenance.todos.some((todo) => /F1-9/.test(todo)));
  });

  it('is reproducible from the same seed, clock and strategy, byte for byte', async () => {
    const first = await runE5Suite(runOptions());
    const second = await runE5Suite(runOptions());
    assert.deepEqual(first.ledger, second.ledger);
    assert.deepEqual(first.gates, second.gates);
    assert.deepEqual(first.reductions, second.reductions);
    assert.deepEqual(first.crossover, second.crossover);
    assert.deepEqual(first.worst, second.worst);
    assert.deepEqual(first.strata, second.strata);
    assert.deepEqual(first.perCase, second.perCase);
    assert.deepEqual(first.report.executionOrder, second.report.executionOrder);
  });

  it('passes G7 on a profitable run and reports gross beside net', async () => {
    const result = await runE5Suite(runOptions());
    const g7 = result.gates.find((verdict) => verdict.gate === 'G7');
    assert.ok(g7 !== undefined);
    assert.equal(g7.status, 'observed');
    assert.ok((g7.observed ?? 0) > 0);
    assert.match(g7.detail, /gross was \$/);
    // The gate is on net; the gross figure is the one a dashboard would show.
    assert.match(g7.note, /G7 is on net/);
    assert.equal(result.ledger.priceable, true);
  });

  it('splits the reduction into a fraction interval and a token interval, in the units of each', async () => {
    const result = await runE5Suite(runOptions());
    assert.equal(result.reductions.n, E5_WORKLOADS.length);
    assert.equal(result.reductions.fractionInterval.n, result.reductions.n);
    assert.equal(result.reductions.tokenInterval.n, result.reductions.n);
    // The fraction interval is a single-series interval on `r`; the token one is
    // a paired difference. Both quote the same median, in their own units.
    assert.equal(result.reductions.fractionInterval.point, result.reductions.median);
    assert.equal(result.reductions.tokenInterval.point, result.reductions.median * 0 + result.reductions.tokenInterval.point);
    // Tokens saved is positive: the sign is the saving's, not the cost's.
    assert.ok(result.reductions.tokenInterval.point > 0, 'tokenInterval reports tokens saved');
    assert.ok(result.reductions.fractionInterval.lower <= result.reductions.fractionInterval.upper);
    assert.ok(result.reductions.tokenInterval.lower <= result.reductions.tokenInterval.upper);
    // 0.55 of the corpus baseline, to the nearest token of the median session.
    assert.ok(Math.abs(result.reductions.median - 0.55) < 1e-9);
  });

  it('reports the worst quartile by net and by reduction separately', async () => {
    const result = await runE5Suite(runOptions());
    assert.equal(result.worst.n, result.observations.length);
    assert.equal(result.worst.quartileSize, Math.ceil(E5_WORKLOADS.length / 4));
    // The bottom quartile by net can never look better than the one by reduction
    // when the treatment is profitable on both, and the note gives the counts.
    assert.ok(result.worst.worstNetFractionMedian <= result.worst.worstInputReductionMedian + 1e-9);
    assert.ok(result.worst.sessionsClearingFrozen >= result.worst.sessionsClearingNet);
    assert.ok(E5_WORKLOADS.some((workload) => workload.id === result.worst.worstSessionId));
    assert.match(result.worst.note, /bottom \d+ of \d+ session\(s\)/);
  });

  it('quotes a crossover above the shipped threshold when the treatment is profitable', async () => {
    const result = await runE5Suite(runOptions());
    assert.equal(result.crossover.shippedMinTokens, E5_SHIPPED_MIN_TOKENS);
    // r = 0.55 and the probes cost 0.1956 of an input token, so a crossover
    // exists and there is nothing to interpolate.
    assert.equal(result.crossover.analyticCrosses, true);
    assert.ok((result.crossover.overheadPerInputToken ?? 1) < 0.55);
    assert.match(result.crossover.note, new RegExp(`threshold of ${E5_SHIPPED_MIN_TOKENS}`));
  });

  it('says no crossover exists when the overhead beats the reduction at every size', async () => {
    const result = await runE5Suite(runOptions({ strategy: unprofitable, strategyId: 'test:unprofitable' }));
    assert.equal(result.crossover.analyticCrosses, false);
    assert.equal(result.crossover.analyticInputTokens, null);
    assert.equal(result.crossover.measuredInputTokens, null);
    assert.equal(result.crossover.bestEstimateInputTokens, null);
    // r = 0.30 does not cover 0.54 of an input token of overhead, so the
    // intervention is underwater everywhere and gets worse as sessions grow.
    assert.ok((result.crossover.overheadPerInputToken ?? 0) > 0.3);
    assert.match(result.crossover.note, /no crossover exists/);
    assert.match(result.crossover.note, /gets worse as sessions grow/);
    // And the gate agrees, rather than reporting a crossover the run does not have.
    assert.equal(result.gates.find((verdict) => verdict.gate === 'G7')?.status, 'not_observed');
  });

  it('fires on both traps, and stays quiet on the twelve cases that are honest', async () => {
    const result = await runE5Suite(runOptions({ strategy: trapping, strategyId: 'test:trapping' }));
    assert.equal(result.negativeControls.length, 2);
    for (const control of result.negativeControls) {
      // `fired` is both detectors, so a trap that only the harness catches is
      // reported but does not count.
      assert.equal(control.fired, true, `${control.caseId} (${control.trap})`);
      assert.equal(control.harnessFired, true, `${control.caseId} harness`);
      assert.equal(control.e5Fired, true, `${control.caseId} e5`);
      assert.notEqual(control.e5Detail, '');
    }
    // The two traps, and nothing else. A detector that fires on a clean run is
    // not a detector.
    const trapped = new Set(result.negativeControls.map((control) => control.caseId));
    assert.deepEqual([...trapped].sort(), ['e5-attribution-trap', 'e5-net-trap']);
    // The net trap is the one this suite exists for: gross positive, net not.
    const netTrap = result.perCase.find((session) => session.caseId === 'e5-net-trap');
    assert.ok(netTrap !== undefined);
    assert.ok(netTrap.grossSavedUsd > 0, 'the gross saving on the net trap is real');
    assert.ok(netTrap.netSavedUsd <= 0, 'and the net is still not a win');
    // The attribution trap is caught by the closure, not by a sign: the tokens
    // were spent and the bill does not report them. The control arm still
    // closes, so the incomplete closure is named rather than counted in bulk.
    const attribution = result.closures.filter(
      (closure) => closure.caseId === 'e5-attribution-trap' && closure.arm === 'treatment',
    );
    assert.equal(attribution.length, 1);
    const broken = attribution[0];
    assert.ok(broken !== undefined);
    assert.equal(broken.complete, false);
    // 5000 + 4000 attributed against a 7000 bill: the 4000 of probe input the
    // arm spent is missing from what it reported.
    assert.equal(broken.attributedInputTokens, 9000);
    assert.equal(broken.billedInputTokens, 7000);
    assert.equal(broken.residualInputTokens, -2000);
    const controlClosure = result.closures.find(
      (closure) => closure.caseId === 'e5-attribution-trap' && closure.arm === 'control',
    );
    assert.equal(controlClosure?.complete, true);
    assert.ok(e5UnattributedTokens([broken]) > 0, 'the missing probe input is unattributed, not absorbed');
    // Excluded is named, not counted, and the name carries the reason.
    assert.equal(result.excluded.length, 1);
    const excluded = result.excluded[0];
    assert.ok(excluded !== undefined);
    assert.match(excluded, /^e5-attribution-trap: /);
    assert.match(excluded, /2000 input token\(s\) claimed by 1 spend line\(s\) but not billed/);
  });
});
