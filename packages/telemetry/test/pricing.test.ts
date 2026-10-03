import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PRICING_STALE_AFTER_DAYS,
  PRICING_TABLE,
  PricingError,
  addDays,
  assertPricingTable,
  daysBetween,
  epochMsToIsoDate,
  isPricingStale,
  isoDateToEpochMs,
  lookupPricing,
  priceRatio,
  pricingFreshness,
} from '../src/index.js';

import {
  FRONTIER,
  LOCAL,
  STANDARD,
  TODAY,
  freshnessAt,
  pricingRow,
  pricingTable,
  tableAged,
} from './fixtures.js';

const TODAY_FOR_LOOKUP = '2026-01-15';

describe('G-2 the pricing table', () => {
  it('prices a model it knows and returns null for one it does not', () => {
    // null is not 0. An unpriceable model is not a free model, and returning
    // 0 here is how a gap in the table becomes a win in someone's dashboard.
    const found = lookupPricing(PRICING_TABLE, 'fixture-standard', TODAY_FOR_LOOKUP);
    assert.equal(found.pricing?.model, 'fixture-standard');
    assert.equal(found.stale, false);

    const missing = lookupPricing(PRICING_TABLE, 'some-unreleased-model', TODAY_FOR_LOOKUP);
    assert.equal(missing.pricing, null);
    assert.equal(missing.model, 'some-unreleased-model', 'the request is still echoed, for the report');
  });

  it('derives rho from the table rather than hard-coding it', () => {
    // §8: rho is "~4-5 for frontier models". A number that a provider can
    // change without telling us is exactly the number that must not be a
    // constant in the cost engine.
    assert.equal(priceRatio(STANDARD), 5);
    assert.equal(priceRatio(FRONTIER), 25 / 3);
  });

  it('reports rho as 0 for a model with no input price', () => {
    // A free model genuinely has no output:input ratio. Infinity is the honest
    // arithmetic and a NaN-poisoned log line is not.
    assert.equal(priceRatio(LOCAL), 0);
    assert.equal(priceRatio(pricingRow({ usdPerMillionInputTokens: 0 })), 0);
  });

  it('validates itself, and says which field is wrong', () => {
    assert.doesNotThrow(() => assertPricingTable(PRICING_TABLE));
    assert.doesNotThrow(() => assertPricingTable(PRICING_TABLE));

    assert.throws(
      () => assertPricingTable({ ...PRICING_TABLE, models: { x: pricingRow({ usdPerMillionInputTokens: -1 }) } }),
      PricingError,
      'usdPerMillionInputTokens',
    );
    assert.throws(
      () => assertPricingTable({ ...PRICING_TABLE, verifiedOn: '01/01/2026' }),
      PricingError,
      'ISO calendar date',
    );
    assert.throws(() => assertPricingTable({ ...PRICING_TABLE, models: {} }), PricingError, 'prices nothing');
    assert.throws(
      // A row whose key is not its model id is a lookup that silently misses.
      () => assertPricingTable({ ...PRICING_TABLE, models: { other: pricingRow({ model: 'real' }) } }),
      PricingError,
      'the key must be the model id',
    );
  });

  it('refuses a row verified after the table itself', () => {
    // The table's date is the weaker of the two, so a row claiming a later
    // verification means somebody re-checked one price and did not bump the
    // version. The reader would trust the older date.
    assert.throws(
      () => assertPricingTable(pricingTable({ verifiedOn: '2026-01-01', models: { 'test-model': pricingRow({ verifiedOn: '2026-06-01' }) } })),
      PricingError,
      'after the table',
    );
  });
});

describe('G-6 staleness: the 90-day boundary', () => {
  it('is fresh just under the threshold', () => {
    // "Older than 90 days" is what G-6 says. A rule that fired *at* the
    // boundary would warn about a table that is exactly on the edge of its own
    // promise, and a warning that fires on schedule is a warning nobody reads.
    const f = freshnessAt(PRICING_STALE_AFTER_DAYS - 1);
    assert.equal(f.ageDays, 89);
    assert.equal(f.stale, false);
    assert.equal(f.reason, 'fresh');
    assert.ok(f.message.includes('fresh'), f.message);
  });

  it('is still fresh exactly at the threshold', () => {
    const f = freshnessAt(PRICING_STALE_AFTER_DAYS);
    assert.equal(f.ageDays, 90);
    assert.equal(f.stale, false, 'strictly greater than 90 is stale; 90 is not');
    assert.equal(f.reason, 'fresh');
  });

  it('is stale just over the threshold', () => {
    const f = freshnessAt(PRICING_STALE_AFTER_DAYS + 1);
    assert.equal(f.ageDays, 91);
    assert.equal(f.stale, true);
    assert.equal(f.reason, 'stale');
    assert.ok(f.message.includes('91 days'), f.message);
    assert.ok(f.message.includes('cost win into a cost loss'), 'the message says why it matters');
  });

  it('uses the threshold the task names, not one of its own', () => {
    assert.equal(PRICING_STALE_AFTER_DAYS, 90);
    assert.equal(freshnessAt(89).stale, false);
    assert.equal(freshnessAt(90).stale, false);
    assert.equal(freshnessAt(91).stale, true);
  });

  it('crosses the boundary monotonically, with no plateaus', () => {
    for (let age = 0; age <= 200; age += 1) {
      assert.equal(freshnessAt(age).stale, age > 90, `age ${age}`);
    }
  });

  it('measures in whole UTC days, so the answer does not depend on when it is asked', () => {
    // `verifiedOn` is a date, so staleness is a date question. Mixing in the
    // time of day would make the same table fresh at 23:59 and stale at 00:01.
    const verified = '2026-01-01';
    const ninetyDays = addDays(verified, 90);
    assert.equal(daysBetween(verified, ninetyDays), 90);
    assert.equal(pricingFreshness({ ...PRICING_TABLE, verifiedOn: verified }, ninetyDays).stale, false);
    assert.equal(
      pricingFreshness({ ...PRICING_TABLE, verifiedOn: verified }, addDays(verified, 91)).stale,
      true,
    );
  });

  it('is stable across a leap year and a month end', () => {
    // The boundary is computed by subtracting real days, not by string
    // arithmetic, so 2024-02-29 and a 31st cannot shift it.
    assert.equal(pricingFreshness({ ...PRICING_TABLE, verifiedOn: '2024-02-01' }, '2024-05-01').stale, false);
    assert.equal(pricingFreshness({ ...PRICING_TABLE, verifiedOn: '2024-02-01' }, '2024-05-02').stale, true);
    assert.equal(pricingFreshness({ ...PRICING_TABLE, verifiedOn: '2024-01-31' }, '2024-05-01').ageDays, 91);
  });

  it('treats a future verifiedOn as unverified, not as freshly verified', () => {
    // A date in the future is a typo or a timezone bug, and it would otherwise
    // be permanently exempt from the staleness rule -- the exact failure the
    // rule exists to prevent, wearing the rule's own name.
    const f = pricingFreshness({ ...PRICING_TABLE, verifiedOn: '2030-01-01' }, '2026-01-01');
    assert.equal(f.stale, true);
    assert.equal(f.reason, 'verified_in_the_future');
    assert.equal(f.ageDays, -1461);
    assert.ok(f.message.includes('treating it as unverified'), f.message);
  });

  it('is a pure function of the table and the date, never of the clock (N6)', () => {
    const table = tableAged(200);
    assert.deepEqual(pricingFreshness(table, TODAY), pricingFreshness(table, TODAY));
    assert.equal(isPricingStale(table, TODAY), true);
    assert.equal(isPricingStale(tableAged(1), TODAY), false);
  });

  it('surfaces staleness next to the lookup that used it', () => {
    // A number computed from a stale table has to be able to say so, or the
    // reader has to remember to check the table separately.
    const lookup = lookupPricing(tableAged(200), 'test-model', TODAY);
    assert.equal(lookup.stale, true);
    assert.equal(lookup.pricing?.model, 'test-model');
    assert.equal(lookup.freshness.stale, true);
  });

  it('names the table and the date in the message, so a report is actionable', () => {
    const f = freshnessAt(120);
    assert.ok(f.message.includes(`v${PRICING_TABLE.version}`), f.message);
    assert.ok(f.message.includes(tableAged(120).verifiedOn), f.message);
    assert.equal(f.thresholdDays, 90);
  });
});

describe('G-6 date arithmetic', () => {
  it('round-trips a date through epoch ms', () => {
    assert.equal(epochMsToIsoDate(isoDateToEpochMs('2026-03-01')), '2026-03-01');
  });

  it('refuses a date that is not a calendar date', () => {
    for (const bad of ['2026-13-01', '2026-02-30', '26-01-01', '2026-1-1', '']) {
      assert.throws(() => isoDateToEpochMs(bad), PricingError, bad);
    }
  });

  it('refuses a non-finite instant', () => {
    assert.throws(() => epochMsToIsoDate(Number.NaN), PricingError);
  });

  it('counts days backwards as well as forwards', () => {
    assert.equal(daysBetween('2026-01-11', '2026-01-01'), -10);
    assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  });
});
