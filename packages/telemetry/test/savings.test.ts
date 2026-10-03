import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  NET_SAVINGS_GATE,
  TOKEN_CATEGORIES,
  breakdownSavings,
  crossoverSessionLength,
  savingsEvent,
} from '../src/index.js';
import type { SavingsInput, SpendLine } from '../src/index.js';

import { LOCAL, RUN, STANDARD } from './fixtures.js';

const priced = STANDARD;

/** $3/M in, $15/M out. 1M in + 200k out = $6. 400k in + 200k out = $4.20. */
const input = (over: Partial<SavingsInput> = {}): SavingsInput => ({
  runId: RUN,
  model: 'fixture-standard',
  baseline: { inputTokens: 1_000_000, outputTokens: 200_000 },
  treatment: { inputTokens: 400_000, outputTokens: 200_000 },
  pricing: priced,
  ...over,
});

const probeOut = (outputTokens: number, pricing = priced): SpendLine => ({
  category: 'probe_out',
  usage: { inputTokens: 0, outputTokens },
  pricing,
});

/**
 * Money is compared with a tolerance, not exactly.
 *
 * `1M * 3/1e6 + 200k * 15/1e6` is not 6 in binary floating point, and the
 * differences are around 2e-16. A tolerance is the honest way to assert on a
 * float. The gate itself is *not* tolerant, and should not be -- see the
 * break-even test.
 */
const money = (actual: number, expected: number, msg = ''): void => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg} expected ~${expected}, got ${actual}`);
};

describe('G-4 the token ledger', () => {
  it('names E5 categories, and separates the signed saving from the counts', () => {
    // `input_saved` is a difference, the other four are counts. Keeping them in
    // one record is a convenience; the distinction is the point of it.
    assert.deepEqual(TOKEN_CATEGORIES, [
      'input_saved',
      'gist_out',
      'probe_in',
      'probe_out',
      'compaction_out',
    ]);
  });

  it('attributes each overhead line to its own category only', () => {
    // A line that incremented two buckets would make the total a fiction, and
    // the total is the number E5's report quotes.
    const b = breakdownSavings(
      input({
        overhead: [
          { category: 'gist_out', usage: { inputTokens: 0, outputTokens: 4000 } },
          { category: 'probe_in', usage: { inputTokens: 7000, outputTokens: 0 } },
          probeOut(3000),
          { category: 'compaction_out', usage: { inputTokens: 0, outputTokens: 1000 } },
        ],
      }),
    );
    assert.deepEqual(b.tokensByCategory, {
      input_saved: 600_000,
      gist_out: 4000,
      probe_in: 7000,
      probe_out: 3000,
      compaction_out: 1000,
    });
  });

  it('keeps a negative input saving signed rather than clamping it', () => {
    // If this clamps, a run that grew its input reports the same ledger as a
    // run that did nothing, and the gross figure stops being falsifiable.
    const b = breakdownSavings(
      input({ treatment: { inputTokens: 1_400_000, outputTokens: 200_000 } }),
    );
    assert.equal(b.tokensByCategory['input_saved'], -400_000);
    assert.ok(b.grossSavedUsd < 0);
  });
});

describe('G-4 gross savings', () => {
  it('is baseline minus treatment', () => {
    const b = breakdownSavings(input());
    money(b.baselineUsd, 6, 'baseline');
    money(b.treatmentUsd, 4.2, 'treatment');
    money(b.grossSavedUsd, 1.8, 'gross');
  });

  it('is negative when the treatment costs more, and stays negative', () => {
    const b = breakdownSavings(
      input({ treatment: { inputTokens: 1_000_000, outputTokens: 400_000 } }),
    );
    // 6 - 9 = -3.
    money(b.grossSavedUsd, -3, 'gross');
    assert.equal(b.gate, 'fail');
  });
});

describe('G-4 the net gate: overhead is subtracted, never ignored', () => {
  it('fails when the probe costs more than the gross saving', () => {
    // The headline in every other dashboard is the 1.8. It is a lie on its own.
    // This is the case the whole gate exists for: a 200k-token probe at $15/M
    // costs $3.00 against a $1.80 saving, so the intervention is a net loss and
    // reporting the gross would report a win.
    const b = breakdownSavings(input({ overhead: [probeOut(200_000)] }));
    money(b.grossSavedUsd, 1.8, 'the gross saving is real');
    money(b.overheadUsd, 3, '200k output tokens at $15/M');
    money(b.netSavedUsd, -1.2, 'and the net is a loss');
    assert.ok(b.netSavedUsd < 0, 'the negative number is not clamped away');
    assert.equal(b.gate, 'fail');
    assert.ok(b.verdict.includes('net LOST'), b.verdict);
  });

  it('names the category that spent the money, so a fail is actionable', () => {
    const b = breakdownSavings(
      input({ overhead: [probeOut(200_000), { category: 'gist_out', usage: { inputTokens: 0, outputTokens: 1000 } }] }),
    );
    money(b.overheadByCategory['probe_out'], 3, 'probe_out');
    money(b.overheadByCategory['gist_out'], 0.015, 'gist_out');
    money(b.overheadUsd, 3.015, 'overhead');
    assert.ok(b.verdict.includes('exceeded the gross saving'), b.verdict);
  });

  it('passes when the overhead is smaller than the saving', () => {
    const b = breakdownSavings(input({ overhead: [probeOut(20_000)] }));
    money(b.overheadUsd, 0.3, 'overhead');
    money(b.netSavedUsd, 1.5, 'net');
    assert.equal(b.gate, 'pass');
    assert.ok(b.verdict.includes('net saved'), b.verdict);
  });

  it('fails at exactly break-even, because the gate is a strict > 0', () => {
    // A net of exactly zero is not a win. It is where the intervention has
    // consumed its entire benefit in overhead, and passing it would make a
    // product that does nothing indistinguishable from one that helps.
    const b = breakdownSavings(
      input({ overhead: [{ category: 'probe_out', usage: { inputTokens: 0, outputTokens: 120_000 } }] }),
    );
    // Exactly break-even in decimal arithmetic; -2.2e-16 in binary floating
    // point. The gate is `netSavedUsd > 0` with no epsilon, so a float wobble
    // of either sign lands on `fail`. That is the correct outcome and it is the
    // reason the gate is not tolerant: a tolerance here would let a run that
    // saved nothing through as a win.
    money(b.netSavedUsd, 0, '200k output tokens at $15/M is exactly $1.80');
    assert.equal(b.gate, 'fail');
    assert.ok(b.verdict.includes('entire gross saving was consumed'), b.verdict);
    assert.equal(NET_SAVINGS_GATE, 0, 'the threshold is named, not re-derived downstream');
  });

  it('reports a negative net fraction rather than nulling it out', () => {
    // -1.2/6 is a real ratio: 20% of the control budget was overspent. Nulling
    // it would lose the only way to compare losses across runs.
    const b = breakdownSavings(input({ overhead: [probeOut(200_000)] }));
    money(b.grossFraction, 0.3, 'gross fraction');
    assert.ok(b.netFraction !== null);
    money(b.netFraction, -0.2, 'net fraction');
  });

  it('keeps a local-model overhead line out of the dollar total but not the ledger', () => {
    // Tier 3: local narration runs on the operator's hardware. It is not free,
    // but it is not metered by the provider, and pricing it at the frontier
    // rate would inflate overhead.
    const b = breakdownSavings(
      input({
        overhead: [
          { category: 'gist_out', usage: { inputTokens: 0, outputTokens: 5000 }, pricing: LOCAL },
          probeOut(20_000),
        ],
      }),
    );
    assert.equal(b.tokensByCategory['gist_out'], 5000, 'the tokens are still attributed');
    money(b.overheadUsd, 0.3, 'but they cost $0 at a zero rate');
    money(b.netSavedUsd, 1.5, 'net');
  });
});

describe('G-4 the breakdown is honest about what it cannot compute', () => {
  it('reports unknown, not pass, when the model is not in the price table', () => {
    // Unpriceable is not free. A gate that passed here would be reporting a win
    // measured in dollars it never had.
    const b = breakdownSavings(input({ model: 'not-in-the-table', pricing: null }));
    assert.equal(b.priceable, false);
    assert.equal(b.gate, 'unknown');
    assert.equal(b.netFraction, null);
    assert.ok(b.verdict.includes('not in the pricing table'), b.verdict);
  });

  it('pairs every zeroed dollar with the flags that make it non-comparable', () => {
    // The dollar fields are 0 rather than null in the unpriceable branch, which
    // is only safe because `priceable: false` and `gate: 'unknown'` travel with
    // them. This test pins that pairing: it is the thing that stops a consumer
    // from reading `netSavedUsd: 0` as "broke even".
    const b = breakdownSavings(input({ pricing: null }));
    assert.equal(b.netSavedUsd, 0);
    assert.equal(b.grossSavedUsd, 0);
    assert.equal(b.priceable, false);
    assert.equal(b.gate, 'unknown');
    assert.notEqual(b.gate, 'pass', 'unknown is never silently promoted to pass');
  });

  it('still counts tokens when it cannot count dollars', () => {
    // An unpriceable run still spent tokens, and the count is exact. Zeroing
    // the ledger on the way out of the priceable branch would have produced
    // "savings unknown" *and* "no probe tokens used" -- two claims, both false.
    const b = breakdownSavings(input({ pricing: null, overhead: [probeOut(1000)] }));
    assert.equal(b.tokensByCategory['probe_out'], 1000);
    assert.equal(b.tokensByCategory['input_saved'], 600_000);
  });

  it('attributes every overhead category even with no price for the model', () => {
    const b = breakdownSavings(
      input({
        pricing: null,
        overhead: [
          { category: 'gist_out', usage: { inputTokens: 0, outputTokens: 4000 } },
          { category: 'probe_in', usage: { inputTokens: 7000, outputTokens: 0 } },
          probeOut(3000),
          { category: 'compaction_out', usage: { inputTokens: 0, outputTokens: 1000 } },
        ],
      }),
    );
    assert.deepEqual(b.tokensByCategory, {
      input_saved: 600_000,
      gist_out: 4000,
      probe_in: 7000,
      probe_out: 3000,
      compaction_out: 1000,
    });
    assert.equal(b.overheadUsd, 0, 'the dollars really are unknown-as-zero, and gated unknown');
    assert.equal(b.gate, 'unknown');
  });

  it('reports a zero-cost baseline as an undefined fraction, not a free win', () => {
    // 0 baseline is not a 100% saving. A local model has no denominator, and
    // dividing by it would be the most flattering number in the package.
    const b = breakdownSavings(
      input({ pricing: LOCAL, treatment: { inputTokens: 400_000, outputTokens: 200_000 } }),
    );
    assert.equal(b.baselineUsd, 0);
    assert.equal(b.grossFraction, 0, 'no baseline to have saved a fraction of');
    assert.equal(b.netFraction, null, 'and an undefined rate is null, not 0');
    assert.equal(b.gate, 'unknown');
    assert.ok(b.verdict.includes('not a pass'), b.verdict);
  });

  it('treats absent overhead as zero overhead, because that is what absent means', () => {
    // Tier 2: a self-gist in the agent's own turn costs the account nothing
    // extra, and the empty list is the honest description of that.
    assert.deepEqual(breakdownSavings(input()), breakdownSavings(input({ overhead: [] })));
  });
});

describe('G-4 the savings event', () => {
  it('carries every number the report quotes, with nothing left implicit', () => {
    const e = savingsEvent(input({ overhead: [probeOut(20_000)] }));
    assert.equal(e.type, 'savings');
    assert.equal(e.runId, RUN);
    assert.equal(e.model, 'fixture-standard');
    money(e.baselineUsd, 6, 'baseline');
    money(e.grossSavedUsd, 1.8, 'gross');
    money(e.overheadUsd, 0.3, 'overhead');
    money(e.netSavedUsd, 1.5, 'net');
    assert.equal(e.gate, 'pass');
    assert.equal(e.tokensByCategory['probe_out'], 20_000);
  });

  it('survives a JSONL round trip with no field lost and no null flipped to 0', () => {
    // The event goes to disk and comes back. Anything that does not survive
    // this is a number a report will quietly get wrong.
    const failing = savingsEvent(input({ overhead: [probeOut(200_000)] }));
    const back = JSON.parse(JSON.stringify(failing)) as typeof failing;
    assert.deepEqual(back, failing);
    money(back.netSavedUsd, -1.2, 'net after round trip');
    assert.equal(back.gate, 'fail');
  });

  it('keeps netFraction null through a round trip', () => {
    const unknown = savingsEvent(input({ pricing: null }));
    assert.equal(unknown.netFraction, null);
    assert.equal((JSON.parse(JSON.stringify(unknown)) as typeof unknown).netFraction, null);
  });

  it('is reproducible (N6)', () => {
    assert.deepEqual(breakdownSavings(input({ overhead: [probeOut(20_000)] })), breakdownSavings(input({ overhead: [probeOut(20_000)] })));
  });
});

describe('G-4 the crossover session length', () => {
  it('is null when there is no marginal saving to amortise against', () => {
    // Infinity is arithmetically defensible and operationally useless. null
    // means "wins from the first session", which is a better answer.
    assert.equal(crossoverSessionLength({ fixedOverheadUsd: 1, savingRateUsdPerToken: 0 }), null);
    assert.equal(crossoverSessionLength({ fixedOverheadUsd: 1, savingRateUsdPerToken: -0.5 }), null);
    assert.equal(crossoverSessionLength({ fixedOverheadUsd: 1 }), null);
  });

  it('divides the uncovered fixed cost by the marginal saving rate', () => {
    // E5 §7: "on a short session, probes can exceed the savings".
    const x = crossoverSessionLength({ fixedOverheadUsd: 10, savingRateUsdPerToken: 0.001 });
    assert.equal(x, 10_000);
  });

  it('is null when the fixed overhead is already covered before session one', () => {
    assert.equal(crossoverSessionLength({ fixedOverheadUsd: 3, savedUsdPerSession: 3 }), null);
    assert.equal(
      crossoverSessionLength({ fixedOverheadUsd: 3, savedUsdPerSession: 5, savingRateUsdPerToken: 0.1 }),
      null,
    );
  });

  it('shrinks as the per-session saving grows', () => {
    const few = crossoverSessionLength({ fixedOverheadUsd: 10, savingRateUsdPerToken: 0.1, savedUsdPerSession: 0 });
    const many = crossoverSessionLength({ fixedOverheadUsd: 10, savingRateUsdPerToken: 0.1, savedUsdPerSession: 5 });
    assert.ok(few !== null && many !== null);
    assert.ok(many < few, 'a product that already banks savings crosses over sooner');
  });
});
