import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { breakevenOk, costTelemetry } from '@strata-ctx/core-types';

import {
  CostError,
  ZERO_USAGE,
  analyseCost,
  breakevenView,
  costEvent,
  inputReduction,
  outputExpansion,
  spendShare,
  usage,
  usd,
} from '../src/index.js';

import { LOCAL, RUN, STANDARD, usage as u } from './fixtures.js';

/**
 * Relative tolerance for comparing an implementation against algebra done by
 * hand.
 *
 * 1e-8, not 1e-12: `k` is recovered as a ratio of two `tokens * usdPerMillion`
 * products, so it carries the float error of that ratio amplified by 1/(1-k).
 * Still four orders of magnitude tighter than the factor-of-2 differences
 * being tested, so it cannot hide a formula that is merely close.
 */
const close = (actual: number, expected: number, msg = '', tolerance = 1e-8): void => {
  const scale = Math.max(1, Math.abs(expected));
  assert.ok(
    Math.abs(actual - expected) / scale < tolerance,
    `${msg} expected ~${expected}, got ${actual}`,
  );
};

describe('G-2 r: the input token reduction fraction', () => {
  it('is 0 when input is unchanged and 0.5 when input halves', () => {
    assert.equal(inputReduction(u(1000, 200), u(1000, 200)), 0);
    assert.equal(inputReduction(u(1000, 200), u(500, 200)), 0.5);
  });

  it('is 1 when the prompt is fully cached away', () => {
    assert.equal(inputReduction(u(1000, 200), u(0, 200)), 1);
  });

  it('clamps a negative reduction to 0, because a worse run is not a win', () => {
    // An input *increase* is r = -0.4. Left unclamped it buys back budget in
    // `1 + (1-r)/...` and a 40% cost regression would report as headroom.
    assert.equal(inputReduction(u(1000, 200), u(1400, 200)), 0);
    assert.equal(inputReduction(u(1000, 200), u(4000, 200)), 0);
  });

  it('is 0, not NaN, when the control arm spent no input tokens', () => {
    // NaN here would land in a JSONL line and round-trip back as null, which
    // reads as data rather than as a broken denominator.
    assert.equal(inputReduction(u(0, 0), u(500, 0)), 0);
    assert.ok(!Number.isNaN(inputReduction(ZERO_USAGE, u(1, 1))));
  });
});

describe('G-2 eps: the output token expansion factor', () => {
  it('is a factor, so an unchanged output is 1.0', () => {
    // Reporting 0 here would claim the model became 100% less verbose, which
    // is the direction that flatters.
    assert.equal(outputExpansion(u(1000, 200), u(1000, 200)), 1);
  });

  it('is multiplicative, so a 25% increase is 1.25', () => {
    assert.equal(outputExpansion(u(1000, 200), u(1000, 250)), 1.25);
    assert.equal(outputExpansion(u(1000, 200), u(1000, 100)), 0.5);
    assert.equal(outputExpansion(u(1000, 200), u(1000, 0)), 0);
  });

  it('floors at 1 when the control produced nothing, never Infinity', () => {
    // Infinity would clear every breakeven comparison and read as the best
    // possible run. 1 is the conservative reading: all of the output is new.
    assert.equal(outputExpansion(u(1000, 0), u(1000, 0)), 0);
    assert.equal(outputExpansion(u(1000, 0), u(1000, 1)), 1);
    assert.equal(outputExpansion(u(1000, 0), u(1000, 9000)), 1);
  });
});

describe('G-2 k: the share of spend the intervention is responsible for', () => {
  it('is input spend over total baseline spend', () => {
    assert.equal(spendShare(u(1000, 0), STANDARD), 1, 'input-only baseline is all input');
    assert.equal(spendShare(u(0, 1000), STANDARD), 0, 'output-only baseline is no input share');
  });

  it('is strictly between 0 and 1 for a mixed baseline', () => {
    const k = spendShare(u(1000, 1000), STANDARD);
    assert.ok(k > 0 && k < 1, String(k));
    // in = 1000*3/1e6, out = 1000*15/1e6 => k = 3/18 = 1/6.
    close(k, 1 / 6, 'k');
  });

  it('is 0 for a zero-spend baseline, so k is never NaN or Infinity', () => {
    assert.equal(spendShare(ZERO_USAGE, STANDARD), 0);
    const local = { ...STANDARD, usdPerMillionInputTokens: 0, usdPerMillionOutputTokens: 0 };
    assert.equal(spendShare(u(1000, 1000), local), 0);
  });
});

describe('G-2 usd', () => {
  it('prices per million, per side', () => {
    assert.equal(usd(u(1_000_000, 200_000), STANDARD, 'input'), 3);
    assert.equal(usd(u(1_000_000, 200_000), STANDARD, 'output'), 3);
    close(usd(u(1_000_000, 200_000), STANDARD, 'input') + usd(u(1_000_000, 200_000), STANDARD, 'output'), 6);
  });

  it('prices a free model at 0 without a special case', () => {
    const local = { ...STANDARD, usdPerMillionInputTokens: 0, usdPerMillionOutputTokens: 0 };
    assert.equal(usd(u(1_000_000, 200_000), local, 'input'), 0);
    assert.equal(usd(u(1_000_000, 200_000), local, 'output'), 0);
  });

  it('refuses a usage object with negative or non-finite counts', () => {
    assert.throws(() => usage(-1, 0), CostError);
    assert.throws(() => usage(0, Number.NaN), CostError);
    assert.throws(() => usage(Number.POSITIVE_INFINITY, 0), CostError);
  });
});

describe('G-2 the breakeven verdict cannot drift from the frozen contract', () => {
  it('agrees with core-types breakevenOk across the range', () => {
    // The single most important test in this file. G7 and E5 are written
    // against the frozen helper. If this package re-derived the comparison
    // differently the summary would contradict the library consuming it, and
    // the divergence would only show up as a wrong number in a report.
    // Each case builds a control arm that *has* the k it claims, so the derived
    // k, r, eps and rho the analysis computes are the ones handed to the frozen
    // helper. Comparing those to a re-typed formula would only prove the test
    // agrees with itself.
    const RHO = 4.5;
    const priced = { ...STANDARD, usdPerMillionOutputTokens: STANDARD.usdPerMillionInputTokens * RHO };
    for (const r of [0, 0.1, 0.2, 0.5, 0.8, 0.9, 1]) {
      for (const eps of [0, 0.5, 1, 1.05, 1.2, 2, 5]) {
        // k = 1 is handled separately below: it means the control arm produced no
        // output at all, which leaves `eps` nothing to be a ratio *of*.
        for (const k of [0.05, 0.1, 0.5]) {
          // k = in / (in + rho*out)  =>  out = in * (1/k - 1) / rho
          const outOverIn = (1 / k - 1) / RHO;
          const baseline = u(1_000_000_000, Math.round(1_000_000_000 * outOverIn));
          const actual = u(
            Math.round(1_000_000_000 * (1 - r)),
            Math.round(baseline.outputTokens * eps),
          );
          const a = analyseCost(baseline, actual, priced);
          const msg = `r=${r} eps=${eps} k=${k}`;
          assert.ok(Math.abs(a.k - k) < 1e-6, `${msg} fixture built the wrong k: ${a.k}`);
          assert.ok(Math.abs(a.r - r) < 1e-6, `${msg} fixture built the wrong r: ${a.r}`);
          assert.ok(Math.abs(a.eps - eps) < 1e-6, `${msg} fixture built the wrong eps: ${a.eps}`);
          assert.equal(a.breakevenOk, breakevenOk(a.r, a.eps, a.rho, a.k), msg);
        }
      }
    }

    // k = 1: all of the control spend was input, so the control produced no
    // output and eps is 1 by the floor rule however much the treatment emits.
    for (const r of [0, 0.5, 1]) {
      const a = analyseCost(u(1_000_000_000, 0), u(Math.round(1_000_000_000 * (1 - r)), 500_000), priced);
      assert.equal(a.k, 1, `r=${r} k`);
      assert.equal(a.eps, 1, `r=${r} eps floors at 1 with no control output`);
      assert.equal(a.breakevenOk, breakevenOk(r, 1, RHO, 1), `r=${r}`);
    }
  });

  it('exercises both verdicts, so a test that always passed one way is ruled out', () => {
    // A loop of identical assertions is a test that proves nothing if every case
    // lands on the same branch.
    const outcomes = new Set<boolean>();
    for (const eps of [0.5, 1, 1.05, 1.2, 2, 5, 50]) {
      outcomes.add(analyseCost(u(1_000_000, 200_000), u(400_000, Math.round(200_000 * eps)), STANDARD).breakevenOk);
    }
    assert.equal(outcomes.size, 2, `expected both verdicts, saw ${[...outcomes].join(',')}`);
  });

  it('carries the frozen telemetry record verbatim', () => {
    const a = analyseCost(u(1000, 200), u(500, 200), STANDARD);
    assert.deepEqual(a.telemetry, costTelemetry(a.r, a.eps, a.rho, a.k));
    assert.equal(a.telemetry.breakevenOk, a.breakevenOk);
  });

  it('reports k = 0 as an unbounded budget, matching the contract', () => {
    // core-types documents this: an intervention accounting for none of the
    // spend gets an unbounded expansion budget. The honest part is that the
    // analysis *says so* rather than passing a silent `true` through.
    // A local model is the real k=0 case -- tokens were spent, none of them
    // billed, so there is no spend for the intervention to be responsible for.
    const a = analyseCost(u(1000, 1000), u(500, 1000), LOCAL);
    assert.equal(a.k, 0);
    assert.equal(a.inputBaselineEmpty, false, 'tokens were spent, so this is not the degenerate case');
    assert.equal(a.epsBudget, Number.POSITIVE_INFINITY);
    assert.equal(a.breakevenOk, true);
    assert.equal(breakevenView(a).reason, 'k_zero');
  });

  it('prefers the degenerate reason when the control arm is empty', () => {
    // Both are true at once, and the more specific-sounding one is the more
    // useful one to log: a zero-token control explains no savings at all.
    const a = analyseCost(ZERO_USAGE, u(1000, 1000), LOCAL);
    assert.equal(a.k, 0);
    assert.equal(breakevenView(a).reason, 'degenerate');
  });
});

describe('G-2 the frozen bound vs the arithmetic bound', () => {
  it('reproduces the exact budget from the price definitions', () => {
    // r*in*pin == (eps-1)*out*pout  =>  eps == 1 + r*in/(out*rho)
    const a = analyseCost(u(1_000_000, 200_000), u(400_000, 200_000), STANDARD);
    const rho = STANDARD.usdPerMillionOutputTokens / STANDARD.usdPerMillionInputTokens;
    assert.ok(a.exactEpsBudget !== null);
    close(a.exactEpsBudget, 1 + (0.6 * 1_000_000) / (200_000 * rho), 'exact');
  });

  it('equals the k-form of the same budget, 1 + r*k/(1-k)', () => {
    // rho is already inside k, which is the whole point: the frozen rule
    // divides by rho a second time as though it were not.
    //
    // A 1e9-token baseline keeps the integer quantisation of `out/in` below the
    // algebra tolerance. At 1e6 tokens the rounding is 1.6e-6 for k = 0.8,
    // because k's sensitivity to out/in grows as 1/(1-k) -- loosening the
    // tolerance to fit would have hidden that.
    for (const k of [0.1, 0.3, 0.5, 0.8]) {
      const pricing = { ...STANDARD, usdPerMillionOutputTokens: STANDARD.usdPerMillionInputTokens * 4.5 };
      // out/in = (1/k - 1)/rho
      const outOverIn = (1 / k - 1) / 4.5;
      const a = analyseCost(u(1_000_000_000, Math.round(1_000_000_000 * outOverIn)), u(500_000_000, 0), pricing);
      close(a.k, k, 'k');
      close(a.exactEpsBudget ?? -1, 1 + (0.5 * k) / (1 - k), `k=${k}`);
    }
  });

  it('moves opposite ways in k, which is the erratum the report must carry', () => {
    // §8's prose: "on output-heavy workloads the same cut permits almost none".
    // Output-heavy means small k. The exact budget tightens as k falls; the
    // frozen budget loosens. They do not merely differ in size, they disagree
    // about which workloads are risky.
    const exactAt = (k: number): number => 1 + (0.5 * k) / (1 - k);
    const frozenAt = (k: number): number => 1 + (1 - 0.5) / (4.5 * k);
    assert.ok(exactAt(0.1) < exactAt(0.5), 'exact tightens as the workload gets output-heavy');
    assert.ok(frozenAt(0.1) > frozenAt(0.5), 'frozen loosens as the workload gets output-heavy');
    close(exactAt(0.1), 1 + (0.5 * 0.1) / 0.9, 'exact at k=0.1, §8 "almost none"');
    close(frozenAt(0.1), 1 + 0.5 / 0.45, 'frozen at k=0.1, §8 "~2x"');
    close(frozenAt(0.1), 2.1111111111, 'frozen at k=0.1', 1e-9);
  });

  it('coincides at exactly one r per (rho, k), and not at r = 0.5', () => {
    const agreeR = (k: number, rho: number): number => (1 - k) / (1 - k + rho * k * k);
    for (const [k, rho] of [
      [0.1, 4.5],
      [0.5, 5],
      [0.3, 4],
    ] as const) {
      const r = agreeR(k, rho);
      close(1 + (1 - r) / (rho * k), 1 + (r * k) / (1 - k), `rho=${rho} k=${k}`);
      // A hair off that r and they part company, in opposite directions.
      const below = 1 + ((1 - (r - 0.1)) / (rho * k)) - (1 + ((r - 0.1) * k) / (1 - k));
      const above = 1 + ((1 - (r + 0.1)) / (rho * k)) - (1 + ((r + 0.1) * k) / (1 - k));
      assert.ok(below > 0 && above < 0, `frozen is looser below r=${r.toFixed(3)} and tighter above it`);
    }
    // And at the value §8's own worked example uses, they are a factor of 2 apart.
    const atHalf = 1 + (0.5 * 0.1) / (1 - 0.1);
    assert.notEqual(Math.round(1 + (1 - 0.5) / (4.5 * 0.1) * 1e6), Math.round(atHalf * 1e6));
  });
});

describe('G-2 degenerate denominators are flagged, not divided through', () => {
  it('flags an empty control arm and still returns finite numbers', () => {
    const a = analyseCost(ZERO_USAGE, u(1000, 1000), STANDARD);
    assert.equal(a.inputBaselineEmpty, true);
    assert.equal(a.outputBaselineEmpty, true);
    assert.equal(a.r, 0);
    assert.equal(a.eps, 1);
    assert.equal(a.exactEpsBudget, null, 'there is no output:input ratio to be exact about');
    assert.ok(Number.isFinite(a.r) && Number.isFinite(a.eps));
    assert.equal(breakevenView(a).reason, 'degenerate');
  });

  it('flags an input increase even though r clamps to 0', () => {
    // Otherwise a 40% cost regression is indistinguishable from a run that
    // simply did nothing, and E5's "report the worst quartile" rule has
    // nothing to sort on.
    const a = analyseCost(u(1000, 200), u(1400, 200), STANDARD);
    assert.equal(a.inputExpanded, true);
    assert.equal(a.r, 0);
    assert.equal(breakevenView(a).reason, 'no_reduction');
  });

  it('separates "no output expansion" from "expanded past the budget"', () => {
    const fine = analyseCost(u(1000, 200), u(500, 200), STANDARD);
    assert.equal(fine.inputExpanded, false);
    assert.equal(breakevenView(fine).reason, 'within_budget');
  });

  it('reports total cost as the sum of its two sides', () => {
    const a = analyseCost(u(1_000_000, 200_000), u(1_000_000, 200_000), STANDARD);
    close(a.totalUsd, a.inputUsd + a.outputUsd);
    assert.equal(a.inputUsd, 3);
    assert.equal(a.outputUsd, 3);
  });
});

describe('G-2 the analysis is reproducible and emits a contract-shaped event (N6)', () => {
  it('is a pure function of its arguments', () => {
    const a = analyseCost(u(1000, 200), u(500, 200), STANDARD);
    assert.deepEqual(a, analyseCost(u(1000, 200), u(500, 200), STANDARD));
  });

  it('emits an event whose numeric fields are the frozen CostTelemetry fields', () => {
    const a = analyseCost(u(1000, 200), u(500, 200), STANDARD);
    const event = costEvent(RUN, a);
    assert.equal(event.type, 'cost');
    assert.equal(event.runId, RUN);
    assert.equal(event.r, a.r);
    assert.equal(event.eps, a.eps);
    assert.equal(event.rho, a.rho);
    assert.equal(event.k, a.k);
    assert.equal(event.breakevenOk, a.breakevenOk);
  });

  it('freezes the analysis so a caller cannot edit a number out from under the event', () => {
    const a = analyseCost(u(1000, 200), u(500, 200), STANDARD);
    assert.throws(() => {
      (a as { r: number }).r = 0.99;
    }, TypeError);
  });
});
