/**
 * G-2 (the pricing table) and G-6 (its staleness).
 *
 * ## Why a table with a date on it
 *
 * A dollar figure with no as-of date is a claim about a provider's price list
 * that nobody can check, and provider prices move. The failure is not that the
 * number is a little wrong: it is *directional*. Prices for long-context and
 * reasoning models have moved repeatedly, and a table that quietly lags turns a
 * genuine cost win into a genuine cost loss while every headline number -- `r`,
 * the gross saving, the token counts -- still looks fine. Nothing downstream of
 * a stale table is detectably wrong; it is just wrong. So `verifiedOn` is a
 * required member rather than a comment, and G-6 makes age a first-class
 * answer instead of something a reader has to remember to check.
 *
 * The `as of` values below are placeholders with a real `verifiedOn`, not
 * claims about anyone's current price list. They exist so the arithmetic,
 * `rho`, the staleness rule and the savings engine can be exercised end to end
 * with no network, and so a stale row is a *representable* state rather than
 * something the fixtures would never produce. A deployment ships a table built
 * from the provider's own published page on the day it ships it; the only
 * supported way to refresh one is a new table with a new `verifiedOn`, because
 * silently editing the date would destroy the only evidence that the numbers
 * were ever re-checked.
 *
 * ## Dates are UTC calendar days, and that is deliberate
 *
 * `verifiedOn` is a *date*, so staleness is measured in whole UTC days between
 * two dates. A half-day past the threshold is not a meaningful signal for a
 * table that gets re-checked on a release cadence, and mixing in the time of
 * day would make the answer depend on when the report was run.
 */

/** Dollars per million tokens. The unit every provider publishes in. */
export interface ModelPricing {
  readonly model: string;
  readonly usdPerMillionInputTokens: number;
  readonly usdPerMillionOutputTokens: number;
  /**
   * `YYYY-MM-DD`. Required, and the reason G-6 exists. There is deliberately no
   * default: a table that has not been verified has no date, and an
   * unverified table is not a table this engine should price against quietly.
   */
  readonly verifiedOn: string;
}

export interface PricingTable {
  /** Bumped on any change to the rows. Surfaced in the report so a mixed log is detectable. */
  readonly version: number;
  readonly verifiedOn: string;
  readonly models: Readonly<Record<string, ModelPricing>>;
}

/**
 * The threshold, in days. G-6 names it; nothing here gets to move it.
 *
 * A quarter is chosen because that is roughly the cadence at which a stale
 * table turns from "slightly conservative" into "wrong about the direction of
 * the result": a provider repricing a frontier tier by more than the observed
 * saving does not need to be a dramatic change to invert a net verdict.
 */
export const PRICING_STALE_AFTER_DAYS = 90;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const MS_PER_DAY = 86_400_000;

function assertIsoDate(value: string, what: string): number {
  if (!ISO_DATE.test(value)) {
    throw new PricingError(`${what} must be an ISO calendar date (YYYY-MM-DD), got "${value}"`);
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) throw new PricingError(`${what} is not a real date: "${value}"`);
  // `Date.parse` on a well-formed ISO string is *not* a calendar check. The
  // MakeDay algorithm rolls an out-of-range day forward, so `2026-02-30` parses
  // to 2 March and `2026-13-01` to January of the next year. A pricing table
  // with a typo'd date would then be silently trusted as if it were two days
  // fresher than it is -- which is the one thing the staleness rule exists to
  // prevent, wearing a format that looks validated.
  const roundTripped = new Date(parsed).toISOString().slice(0, 10);
  if (roundTripped !== value) {
    throw new PricingError(`${what} is not a real date: "${value}" (parsed as "${roundTripped}")`);
  }
  return parsed;
}

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingError';
  }
}

/** UTC epoch ms for a calendar date. Never reads the wall clock (N6). */
export function isoDateToEpochMs(date: string): number {
  return assertIsoDate(date, 'date');
}

/** `YYYY-MM-DD` for an epoch-ms instant, in UTC. */
export function epochMsToIsoDate(epochMs: number): string {
  if (!Number.isFinite(epochMs)) throw new PricingError(`timestamp must be finite, got ${String(epochMs)}`);
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return epochMsToIsoDate(isoDateToEpochMs(date) + days * MS_PER_DAY);
}

/** Whole UTC days from `from` to `to`. Negative when `to` precedes `from`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((isoDateToEpochMs(to) - isoDateToEpochMs(from)) / MS_PER_DAY);
}

export type PricingFreshnessReason = 'fresh' | 'stale' | 'verified_in_the_future';

export interface PricingFreshness {
  readonly verifiedOn: string;
  readonly today: string;
  readonly ageDays: number;
  readonly thresholdDays: number;
  /**
   * `stale` when `ageDays > PRICING_STALE_AFTER_DAYS` -- strictly greater, so a
   * table verified exactly 90 days ago is still inside the window. "Older than
   * 90 days" is what G-6 says, and a rule that fired *at* the boundary would
   * warn on a table that is exactly on the edge of its own promise.
   */
  readonly stale: boolean;
  readonly reason: PricingFreshnessReason;
  /** One line, safe to print, carrying the numbers the verdict was made from. */
  readonly message: string;
}

/**
 * G-6. Reports the age of a table against the threshold.
 *
 * A `verifiedOn` in the future is reported rather than clamped to fresh. It is
 * almost always a typo or a timezone bug in whatever generated the table, and
 * a table that claims to have been verified tomorrow would otherwise be
 * permanently, silently exempt from the staleness rule -- the exact failure
 * the rule exists to prevent, wearing the rule's own name.
 */
export function pricingFreshness(
  table: PricingTable,
  today: string,
): PricingFreshness {
  const ageDays = daysBetween(table.verifiedOn, today);
  const threshold = PRICING_STALE_AFTER_DAYS;

  if (ageDays < 0) {
    return {
      verifiedOn: table.verifiedOn,
      today,
      ageDays,
      thresholdDays: threshold,
      stale: true,
      reason: 'verified_in_the_future',
      message:
        `pricing table v${table.version} claims verifiedOn=${table.verifiedOn}, which is ${-ageDays} day(s) ` +
        `after today (${today}); treating it as unverified rather than fresh`,
    };
  }

  const stale = ageDays > threshold;
  return {
    verifiedOn: table.verifiedOn,
    today,
    ageDays,
    thresholdDays: threshold,
    stale,
    reason: stale ? 'stale' : 'fresh',
    message: stale
      ? `pricing table v${table.version} was verified ${ageDays} days ago (${table.verifiedOn}), past the ` +
        `${threshold}-day threshold; a stale price table silently turns a cost win into a cost loss`
      : `pricing table v${table.version} is fresh: verified ${ageDays} day(s) ago (${table.verifiedOn}), ` +
        `within the ${threshold}-day threshold` + (ageDays === threshold ? ' (exactly at it)' : ''),
  };
}

export function isPricingStale(table: PricingTable, today: string): boolean {
  return pricingFreshness(table, today).stale;
}

export interface PricingLookup {
  /** null when the model is not in the table. Unpriceable is not the same as free. */
  readonly pricing: ModelPricing | null;
  readonly model: string;
  readonly freshness: PricingFreshness;
  /** True when a stale table is being used to produce a number. */
  readonly stale: boolean;
}

export function lookupPricing(table: PricingTable, model: string, today: string): PricingLookup {
  const freshness = pricingFreshness(table, today);
  return { pricing: table.models[model] ?? null, model, freshness, stale: freshness.stale };
}

/**
 * `rho`: the output:input price ratio, which §8 says is ~4-5 for frontier
 * models. Derived from the table rather than configured, because the whole
 * point of a pricing table is to stop hard-coding a number that a provider can
 * change without telling us.
 *
 * A zero input price makes the ratio meaningless. It is reported as 0 rather
 * than Infinity: Infinity is the honest arithmetic and a NaN-poisoned log line
 * is not, and a free model genuinely has no output:input ratio to speak of.
 */
export function priceRatio(pricing: ModelPricing): number {
  if (pricing.usdPerMillionInputTokens <= 0) return 0;
  return pricing.usdPerMillionOutputTokens / pricing.usdPerMillionInputTokens;
}

/**
 * The shipped table.
 *
 * `verifiedOn` is pinned to 2026-01-01 and the model ids are deliberately
 * recognisable-but-generic. This is not a price list: it is a fixture with a
 * realistic `rho` (~5, the §8 figure) so the cost engine has something to
 * compute against, and it is *stale by construction relative to the repo's own
 * clock*, which means G-6 is exercised by default rather than only when
 * somebody remembers to construct the case. Deployments replace it.
 */
export const PRICING_TABLE: PricingTable = Object.freeze({
  version: 1,
  verifiedOn: '2026-01-01',
  models: Object.freeze({
    'fixture-frontier': Object.freeze({
      model: 'fixture-frontier',
      usdPerMillionInputTokens: 3,
      // rho = 25/3 ~ 8.3. Deliberately above the ~4-5 §8 quotes for frontier
      // models: the ~4-5 figure describes a *typical* mix, and a cost engine
      // that is only ever exercised at rho=5 cannot tell a correct
      // implementation from one that got lucky on the arithmetic.
      usdPerMillionOutputTokens: 25,
      verifiedOn: '2026-01-01',
    }),
    'fixture-standard': Object.freeze({
      model: 'fixture-standard',
      usdPerMillionInputTokens: 3,
      // rho = 5 exactly: the §8 figure, so the worked example in the doc can be
      // reproduced literally in a test.
      usdPerMillionOutputTokens: 15,
      verifiedOn: '2026-01-01',
    }),
    'fixture-local': Object.freeze({
      model: 'fixture-local',
      // Tier 3 narration runs on the operator's own hardware. It is not free,
      // but it is not metered by the provider either, and counting it in
      // provider dollars while ignoring its latency would be a selective
      // accounting choice made in the flattering direction. The caller reports
      // the local arm's cost in wall clock instead.
      usdPerMillionInputTokens: 0,
      usdPerMillionOutputTokens: 0,
      verifiedOn: '2026-01-01',
    }),
  }),
});

/**
 * Validates a table before it prices anything.
 *
 * A table with a negative price or a model with no rate is a data-entry error
 * that would otherwise propagate into a savings figure with no marker, and the
 * whole claim of this stream is that the figures are checkable.
 */
export function assertPricingTable(table: PricingTable): void {
  assertIsoDate(table.verifiedOn, 'table.verifiedOn');
  if (!Number.isInteger(table.version) || table.version < 1) {
    throw new PricingError(`table.version must be a positive integer, got ${String(table.version)}`);
  }
  const models = Object.entries(table.models);
  if (models.length === 0) throw new PricingError('a pricing table with no models prices nothing');
  for (const [key, row] of models) {
    if (row.model !== key) {
      throw new PricingError(`pricing row "${key}" declares model "${row.model}"; the key must be the model id`);
    }
    for (const [field, value] of [
      ['usdPerMillionInputTokens', row.usdPerMillionInputTokens],
      ['usdPerMillionOutputTokens', row.usdPerMillionOutputTokens],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) {
        throw new PricingError(`${key}.${field} must be a finite, non-negative number, got ${String(value)}`);
      }
    }
    assertIsoDate(row.verifiedOn, `${key}.verifiedOn`);
    if (daysBetween(row.verifiedOn, table.verifiedOn) < 0) {
      throw new PricingError(
        `${key}.verifiedOn (${row.verifiedOn}) is after the table's own verifiedOn (${table.verifiedOn})`,
      );
    }
  }
}
