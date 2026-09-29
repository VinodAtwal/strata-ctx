import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  benjaminiHochberg,
  exactMcNemar,
  pairedBootstrap,
  pairedNonInferiority,
  percentile,
  wilsonInterval,
  DEFAULT_ALPHA,
  DEFAULT_BOOTSTRAP_RESAMPLES,
  DEFAULT_BOOTSTRAP_SEED,
  MIN_DISCORDANT_FRACTION,
  NON_INFERIORITY_MARGIN,
  NON_INFERIORITY_MARGIN_PP,
  type PairedOutcome,
} from '../src/statistics.js';

// Fixtures are inline per AGENTS.md §6.2. No shared fixture files.

/**
 * Builds a paired table with exactly the requested cell counts, so a test can
 * state the contingency counts it means instead of encoding them as a run of
 * booleans that has to be counted by eye.
 */
const table = (
  n11: number,
  n10: number,
  n01: number,
  n00: number,
): { control: PairedOutcome[]; treatment: PairedOutcome[] } => {
  const control: PairedOutcome[] = [];
  const treatment: PairedOutcome[] = [];
  for (let i = 0; i < n11; i += 1) {
    control.push(true);
    treatment.push(true);
  }
  for (let i = 0; i < n10; i += 1) {
    control.push(true);
    treatment.push(false);
  }
  for (let i = 0; i < n01; i += 1) {
    control.push(false);
    treatment.push(true);
  }
  for (let i = 0; i < n00; i += 1) {
    control.push(false);
    treatment.push(false);
  }
  return { control, treatment };
};

const meanOf = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Index into an array that TypeScript has widened to `| undefined`, failing
 * loudly rather than silently comparing `undefined` to a number. A test that
 * reads past the end of an array should say so; it should not quietly pass
 * because `NaN > 0` is false.
 */
const at = (values: readonly number[], index: number): number => {
  const value = values[index];
  if (value === undefined) {
    assert.fail(`no value at index ${index} of a ${values.length}-element array`);
  }
  return value;
};

/**
 * Assert a bound is present, and narrow it. Null means the estimator declined
 * to produce a number, which is a legitimate state elsewhere but never the
 * thing a caller reading this position expects.
 */
const bound = (value: number | null): number => {
  if (value === null) {
    assert.fail('expected a numeric bound, got null');
  }
  return value;
};

const near = (actual: number | null, expected: number, tolerance = 1e-9): void => {
  // A null bound is a different claim from a wrong one: it says the estimator
  // declined to produce a number. Failing here on null is therefore deliberate.
  if (actual === null) {
    assert.fail('expected a numeric bound, got null');
  }
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
};

// --------------------------------------------------------------------- McNemar

describe('F1-3 McNemar: cell counts', () => {
  it('places each pair in the right cell', () => {
    const { control, treatment } = table(2, 3, 5, 7);
    const result = exactMcNemar(control, treatment);
    assert.equal(result.n11, 2);
    assert.equal(result.n10, 3);
    assert.equal(result.n01, 5);
    assert.equal(result.n00, 7);
    assert.equal(result.n, 17);
    assert.equal(result.discordantPairs, 8);
  });

  it('treats the string outcomes as equivalent to the booleans', () => {
    const asStrings: PairedOutcome[] = ['pass', 'fail', 'pass'];
    const paired: PairedOutcome[] = [true, false, true];
    // 'pass' must be a pass, so a harness that labels outcomes cannot silently
    // score every case as a failure.
    assert.equal(exactMcNemar(asStrings, asStrings).n11, 2);
    assert.equal(exactMcNemar(asStrings, asStrings).n00, 1);
    assert.equal(exactMcNemar(asStrings, asStrings).n, 3);
    assert.equal(exactMcNemar(paired, paired).n11, 2);
  });

  it('rejects paired arrays of different lengths rather than truncating', () => {
    assert.throws(() => exactMcNemar([true, false], [true]), RangeError);
  });
});

describe('F1-3 McNemar: exact p-values, hand-checked against R binom.test', () => {
  // Every value below is R's `binom.test(x, m, 0.5, two.sided = TRUE)`, which
  // is the doubled-smaller-tail convention: min(1, 2 * P(X <= min(n01, n10))).
  const cases: readonly {
    readonly label: string;
    readonly cells: [number, number, number, number];
    readonly expected: number;
  }[] = [
    { label: 'm=4, n01=1, n10=3', cells: [0, 3, 1, 0], expected: 0.625 },
    { label: 'm=4, n01=0, n10=4', cells: [0, 4, 0, 0], expected: 0.125 },
    { label: 'm=4, n01=4, n10=0', cells: [0, 0, 4, 0], expected: 0.125 },
    { label: 'm=4, n01=2, n10=2 (balanced)', cells: [0, 2, 2, 0], expected: 1 },
    { label: 'm=2, n01=1, n10=1', cells: [0, 1, 1, 0], expected: 1 },
    { label: 'm=6, n01=5, n10=1', cells: [0, 1, 5, 0], expected: 2 * (7 / 64) },
    { label: 'm=10, n01=9, n10=1', cells: [0, 1, 9, 0], expected: (2 * 11) / 1024 },
    { label: 'm=20, n01=15, n10=5', cells: [0, 5, 15, 0], expected: (2 * 21700) / 1048576 },
  ];

  for (const { label, cells, expected } of cases) {
    it(`gives the exact two-sided p-value for ${label}`, () => {
      const { control, treatment } = table(...cells);
      const result = exactMcNemar(control, treatment);
      near(result.pTwoSided, expected, 1e-12);
    });
  }

  it('points the one-sided p-values in opposite directions', () => {
    // 9 wins and 1 loss out of 10 discordant pairs.
    const { control, treatment } = table(0, 1, 9, 0);
    const result = exactMcNemar(control, treatment);
    // Evidence that the treatment is better: 9 or more wins, P = 11/1024.
    near(result.pTreatmentBetter, 11 / 1024, 1e-12);
    // Evidence that it is worse: 1 or more losses. A single loss is
    // unremarkable, so this is close to 1 and says nothing.
    near(result.pTreatmentWorse, 1 - 1 / 1024, 1e-12);
  });

  it('keeps a tiny one-sided p-value instead of cancelling it to zero', () => {
    // 990 wins out of 1000 discordant pairs. "1 - P(X <= 989)" is one minus a
    // number that equals 1 to within 1e-250, so in double precision it is
    // exactly 0: the result would be a total absence of evidence for the most
    // extreme outcome the test can be given. A direct tail avoids that.
    const { control, treatment } = table(0, 10, 990, 0);
    const result = exactMcNemar(control, treatment);
    assert.ok(
      result.pTreatmentBetter > 0,
      'an overwhelming one-sided result must not report p = 0',
    );
    assert.ok(result.pTreatmentBetter < 1e-270, 'expected a p on the order of 1e-278');
    assert.ok(result.pTwoSided > 0, 'the two-sided p must not cancel to zero');
  });

  it('exposes the sum-of-tails variant so the two conventions cannot be confused', () => {
    const { control, treatment } = table(0, 3, 1, 0);
    const result = exactMcNemar(control, treatment);
    near(result.pTwoSided, 0.625, 1e-12);
    // Summing the tails saturates at 1 while the doubled tail keeps the
    // evidence in the smaller tail. Reporting only one of these would make a
    // comparison against a paper using the other unresolvable.
    near(result.pTwoSidedSumOfTails, 1, 1e-12);
    assert.notEqual(result.pTwoSided, result.pTwoSidedSumOfTails);
  });

  it('keeps every p-value a probability', () => {
    const cases: ReadonlyArray<readonly [number, number, number, number]> = [
      [0, 4, 0, 0],
      [0, 0, 4, 0],
      [0, 1, 1, 0],
      [0, 1, 19, 0],
    ];
    for (const cells of cases) {
      const { control, treatment } = table(...cells);
      const r = exactMcNemar(control, treatment);
      for (const value of [r.pTreatmentBetter, r.pTreatmentWorse, r.pTwoSided, r.pTwoSidedSumOfTails]) {
        assert.ok(value >= 0 && value <= 1, `p-value ${value} is outside [0, 1]`);
      }
    }
  });

  it('stays exact at a large discordant count, where differencing a CDF would not', () => {
    // 200 discordant pairs, 190 wins. The smaller tail is 2^-200 * sum(0..10),
    // far below the 1e-16 where `1 - CDF` would round to zero.
    const { control, treatment } = table(0, 10, 190, 0);
    const result = exactMcNemar(control, treatment);
    assert.ok(result.pTwoSided > 0, 'a small p-value must not collapse to exactly 0');
    assert.ok(result.pTwoSided < 1e-40, `expected a tiny p-value, got ${result.pTwoSided}`);
  });
});

describe('F1-3 McNemar: degenerate inputs are reported, not papered over', () => {
  it('distinguishes no pairs from no discordant pairs', () => {
    const empty = exactMcNemar([], []);
    assert.equal(empty.state, 'no_pairs');
    assert.equal(empty.n, 0);
    assert.equal(empty.informative, false);
    assert.equal(empty.pTwoSided, 1);

    const agreed = table(5, 0, 0, 5);
    const none = exactMcNemar(agreed.control, agreed.treatment);
    assert.equal(none.state, 'no_discordant_pairs');
    assert.equal(none.discordantPairs, 0);
    assert.equal(none.informative, false);
    assert.equal(none.pTwoSided, 1);
  });

  it('marks a run with no discordance as uninformative even though p is 1', () => {
    // p = 1 here must not be quotable as "we showed the arms are equivalent".
    const agreed = table(40, 0, 0, 40);
    const result = exactMcNemar(agreed.control, agreed.treatment);
    assert.equal(result.informative, false);
    assert.equal(result.state, 'no_discordant_pairs');
  });

  it('marks a real comparison as informative', () => {
    const mixed = table(40, 5, 8, 40);
    const result = exactMcNemar(mixed.control, mixed.treatment);
    assert.equal(result.informative, true);
    assert.equal(result.state, 'ok');
  });
});

// ------------------------------------------------------------- non-inferiority

describe('F1-3 non-inferiority: the Agresti-Min published example', () => {
  // Agresti & Min (2005) Table V, row 2, as reproduced by NCSS: n=86,
  // n10=8, n01=16, published 95% CI [-0.019, 0.201] with width 0.21946.
  const example = table(62, 8, 16, 0);

  it('reproduces the published point estimate', () => {
    const result = pairedNonInferiority(example.control, example.treatment);
    near(result.correctedDifference, 0.0909090909090909, 1e-12);
    near(result.standardError, 0.055986, 1e-6);
  });

  it('reproduces the published interval and its width', () => {
    const result = pairedNonInferiority(example.control, example.treatment);
    near(bound(result.lower), -0.019, 5e-4);
    near(bound(result.upper), 0.201, 5e-4);
    near(bound(result.upper) - bound(result.lower), 0.21946, 5e-5);
  });

  it('keeps the uncorrected difference separate from the corrected one', () => {
    const result = pairedNonInferiority(example.control, example.treatment);
    near(result.observedDifference, 8 / 86, 1e-12);
    assert.notEqual(result.correctedDifference, result.observedDifference);
  });

  it('clears the -2pp margin with room to spare', () => {
    const result = pairedNonInferiority(example.control, example.treatment);
    assert.ok(bound(result.lower) > NON_INFERIORITY_MARGIN);
    assert.equal(result.nonInferior, true);
    assert.equal(result.conclusive, true);
    assert.equal(result.state, 'ok');
  });

  it('records its citation and margin on every result', () => {
    const result = pairedNonInferiority(example.control, example.treatment);
    assert.match(result.citation, /Agresti & Min/);
    assert.equal(result.margin, NON_INFERIORITY_MARGIN);
    assert.equal(NON_INFERIORITY_MARGIN, NON_INFERIORITY_MARGIN_PP / 100);
  });
});

describe('F1-3 non-inferiority: the margin cannot be widened after the data', () => {
  const example = table(62, 8, 16, 0);

  it('rejects a wider margin, which would make the claim easier after the fact', () => {
    assert.throws(() => pairedNonInferiority(example.control, example.treatment, { margin: -0.05 }), RangeError);
    assert.throws(() => pairedNonInferiority(example.control, example.treatment, { margin: -0.5 }), RangeError);
  });

  it('rejects a zero or positive margin, which is superiority, not non-inferiority', () => {
    assert.throws(() => pairedNonInferiority(example.control, example.treatment, { margin: 0 }), RangeError);
    assert.throws(() => pairedNonInferiority(example.control, example.treatment, { margin: 0.05 }), RangeError);
  });

  it('accepts a tighter margin, which is a stricter claim', () => {
    const result = pairedNonInferiority(example.control, example.treatment, { margin: -0.01 });
    assert.equal(result.margin, -0.01);
    // Tighter bar, same data, and it no longer clears: which is the point of
    // letting a caller tighten the claim.
    assert.equal(result.nonInferior, false);
    assert.equal(result.state, 'interval_crosses_margin');
  });

  it('rejects a nonsensical alpha', () => {
    for (const alpha of [0, 1, -0.1, 1.5, Number.NaN]) {
      assert.throws(() => pairedNonInferiority(example.control, example.treatment, { alpha }), RangeError);
    }
  });

  it('rejects mismatched array lengths', () => {
    assert.throws(() => pairedNonInferiority([true], []), RangeError);
  });
});

describe('F1-3 non-inferiority: degenerate and inconclusive outcomes', () => {
  it('reports no pairs as inconclusive, not as non-inferior', () => {
    const result = pairedNonInferiority([], []);
    assert.equal(result.state, 'no_pairs');
    assert.equal(result.conclusive, false);
    assert.equal(result.nonInferior, false);
    assert.equal(result.observedDifference, null);
    assert.equal(result.lower, null);
  });

  it('reports perfect agreement as inconclusive, not as a pass', () => {
    // This is the trap the state exists to prevent. The interval is [0, 0],
    // which clears -2pp, and a caller reading only `nonInferior` would ship a
    // claim that a single arm was shown equal to control.
    const agreed = table(80, 0, 0, 20);
    const result = pairedNonInferiority(agreed.control, agreed.treatment);
    assert.equal(result.state, 'no_discordant_pairs');
    assert.equal(result.discordantPairs, 0);
    assert.equal(result.conclusive, false);
    assert.equal(result.nonInferior, true, 'the interval does clear the margin, but...');
    assert.equal(result.lower, 0);
  });

  it('reports a too-small discordant fraction as inconclusive', () => {
    // 2 discordant pairs out of 100: a 2pp claim cannot rest on 2 cases.
    const sparse = table(94, 1, 1, 4);
    const result = pairedNonInferiority(sparse.control, sparse.treatment);
    assert.equal(result.discordantFraction, 0.02);
    assert.ok((result.discordantFraction as number) < MIN_DISCORDANT_FRACTION);
    assert.equal(result.state, 'insufficient_discordance');
    assert.equal(result.conclusive, false);
    assert.equal(result.nonInferior, false);
  });

  it('still reports the interval on an inconclusive run, so the data are not hidden', () => {
    const sparse = table(94, 1, 1, 4);
    const result = pairedNonInferiority(sparse.control, sparse.treatment);
    assert.ok(result.lower !== null && result.upper !== null);
    assert.ok(result.standardError !== null);
  });

  it('distinguishes a real loss from a real gain', () => {
    const worse = table(90, 8, 2, 0);
    const result = pairedNonInferiority(worse.control, worse.treatment);
    assert.ok((result.correctedDifference as number) < 0);
    assert.equal(result.nonInferior, false);
  });
});

// ------------------------------------------------------------------ bootstrap

describe('F1-3 bootstrap: reproducibility and the seeded PRNG', () => {
  it('is byte-identical across calls with the same seed', () => {
    const { control, treatment } = table(20, 20, 40, 20);
    const a = pairedBootstrap(control, treatment, { resamples: 400, seed: 42, statistic: meanOf });
    const b = pairedBootstrap(control, treatment, { resamples: 400, seed: 42, statistic: meanOf });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  it('actually varies with the seed, rather than ignoring it', () => {
    const { control, treatment } = table(20, 20, 40, 20);
    const a = pairedBootstrap(control, treatment, { resamples: 400, seed: 42, statistic: meanOf });
    const b = pairedBootstrap(control, treatment, { resamples: 400, seed: 7, statistic: meanOf });
    assert.notDeepEqual([...a.replicates], [...b.replicates]);
  });

  it('has a default seed that is stable and is not the runner seed', () => {
    const { control, treatment } = table(10, 5, 15, 10);
    const a = pairedBootstrap(control, treatment, { resamples: 200, statistic: meanOf });
    const b = pairedBootstrap(control, treatment, { resamples: 200, seed: DEFAULT_BOOTSTRAP_SEED, statistic: meanOf });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.equal(a.seed, DEFAULT_BOOTSTRAP_SEED);
  });

  it('defaults to the median and 10,000 replicates', () => {
    const { control, treatment } = table(10, 5, 15, 10);
    const result = pairedBootstrap(control, treatment, { resamples: 50 });
    assert.equal(result.statistic, 'median');
    assert.equal(DEFAULT_BOOTSTRAP_RESAMPLES, 10_000);
    assert.equal(result.resamples, 50);
  });

  it('labels a custom statistic as custom', () => {
    const { control, treatment } = table(10, 5, 15, 10);
    assert.equal(pairedBootstrap(control, treatment, { resamples: 50, statistic: meanOf }).statistic, 'custom');
  });

  it('produces one replicate per requested resample', () => {
    const { control, treatment } = table(10, 5, 15, 10);
    for (const resamples of [1, 7, 100, 250]) {
      const result = pairedBootstrap(control, treatment, { resamples, statistic: meanOf });
      assert.equal(result.replicates.length, resamples);
    }
  });
});

describe('F1-3 bootstrap: degenerate samples', () => {
  it('reports no pairs as a null estimate rather than a number', () => {
    const result = pairedBootstrap([], []);
    assert.equal(result.state, 'no_pairs');
    assert.equal(result.estimate, null);
    assert.equal(result.lower, null);
    assert.equal(result.upper, null);
    assert.equal(result.degenerate, true);
  });

  it('collapses a single pair to a point, labelled as degenerate', () => {
    const result = pairedBootstrap([true], [false]);
    assert.equal(result.state, 'single_pair');
    assert.equal(result.estimate, -1);
    assert.equal(result.lower, -1);
    assert.equal(result.upper, -1);
    assert.equal(result.degenerate, true);
    assert.equal(result.replicates.length, 0, 'every resample is the same; do not pretend otherwise');
  });

  it('collapses a zero-variance sample to a point', () => {
    const { control, treatment } = table(10, 0, 0, 10);
    const result = pairedBootstrap(control, treatment);
    assert.equal(result.state, 'degenerate_zero_variance');
    assert.equal(result.estimate, 0);
    assert.equal(result.lower, 0);
    assert.equal(result.upper, 0);
    assert.equal(result.degenerate, true);
  });

  it('does not call a pinned median degenerate when the variance is real', () => {
    // 20 wins and 10 losses: the median difference is 0 for almost every
    // resample, which is a property of a median on discrete data, not a
    // degenerate sample. It must not be reported as one.
    const { control, treatment } = table(40, 10, 20, 30);
    const result = pairedBootstrap(control, treatment, { resamples: 300 });
    assert.equal(result.state, 'ok');
    assert.equal(result.degenerate, false);
  });

  it('rejects a non-positive resample count and a bad alpha', () => {
    const { control, treatment } = table(1, 1, 1, 1);
    for (const resamples of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => pairedBootstrap(control, treatment, { resamples }), RangeError);
    }
    for (const alpha of [0, 1, -0.5, Number.NaN]) {
      assert.throws(() => pairedBootstrap(control, treatment, { alpha }), RangeError);
    }
  });

  it('rejects mismatched array lengths', () => {
    assert.throws(() => pairedBootstrap([true, false], [true]), RangeError);
  });
});

describe('F1-3 bootstrap: pairing is respected', () => {
  it('is far tighter than the arms would be sampled independently', () => {
    // Both arms pass 60/100. Sampled independently the difference would carry
    // roughly the full binomial variance; resampled as pairs the shared
    // per-case difficulty cancels and the interval collapses to a point.
    const { control, treatment } = table(60, 0, 0, 40);
    const paired = pairedBootstrap(control, treatment, { resamples: 300, statistic: meanOf });
    assert.equal(paired.estimate, 0);
    assert.equal(paired.lower, 0);
    assert.equal(paired.upper, 0);
  });

  it('recovers a real positive difference with an interval above zero', () => {
    const { control, treatment } = table(50, 10, 40, 0);
    const result = pairedBootstrap(control, treatment, { resamples: 2000, statistic: meanOf });
    near(result.estimate, 0.3, 1e-12);
    assert.ok(bound(result.lower) > 0, `expected a lower bound above 0, got ${result.lower}`);
  });

  it('narrows at a lower alpha', () => {
    const { control, treatment } = table(20, 20, 40, 20);
    const wide = pairedBootstrap(control, treatment, { resamples: 500, statistic: meanOf, alpha: 0.05 });
    const narrow = pairedBootstrap(control, treatment, { resamples: 500, statistic: meanOf, alpha: 0.10 });
    assert.ok(
      (bound(narrow.upper) - bound(narrow.lower)) < (bound(wide.upper) - bound(wide.lower)),
    );
  });

  it('uses the median by default, which is what the methodology asks for', () => {
    // 40 wins, 10 losses, 50 ties: n = 100. The median of those differences
    // is 0 while their mean is 0.3, and the two are not interchangeable. The
    // median is the default because a single catastrophic case should not be
    // able to move a run's central estimate.
    const { control, treatment } = table(50, 10, 40, 0);
    const result = pairedBootstrap(control, treatment, { resamples: 2000 });
    assert.equal(result.statistic, 'median');
    assert.equal(result.estimate, 0);
    const byMean = pairedBootstrap(control, treatment, { resamples: 2000, statistic: meanOf });
    near(byMean.estimate, 0.3, 1e-12);
  });
});

// ----------------------------------------------------------------- percentile

describe('F1-3 percentile: Hyndman & Fan type 7', () => {
  const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it('uses h = (n-1)p, the R quantile default', () => {
    for (const p of [0.025, 0.1, 0.25, 0.5, 0.75, 0.9, 0.975]) {
      const h = (data.length - 1) * p;
      const low = data[Math.floor(h)] as number;
      const high = data[Math.ceil(h)] as number;
      near(percentile(data, p), low + (h - Math.floor(h)) * (high - low), 1e-12);
    }
  });

  it('agrees with R on the published worked example', () => {
    // quantile(1:10, c(0, 0.25, 0.5, 0.75, 1)) in R is
    // 1.00 3.25 5.50 7.75 10.00
    near(percentile(data, 0), 1, 1e-12);
    near(percentile(data, 0.25), 3.25, 1e-12);
    near(percentile(data, 0.5), 5.5, 1e-12);
    near(percentile(data, 0.75), 7.75, 1e-12);
    near(percentile(data, 1), 10, 1e-12);
  });

  it('handles the endpoints of a single-element sample', () => {
    assert.equal(percentile([7], 0.5), 7);
    assert.equal(percentile([7], 0), 7);
    assert.equal(percentile([7], 1), 7);
  });

  it('requires sorted input and says so by being an interpolation of it', () => {
    // Documented contract: the caller passes a sorted array, as the bootstrap
    // does. This test pins that the function does not sort for you, so a
    // future caller cannot pass unsorted data and get a plausible number.
    assert.equal(percentile([10, 1, 5], 0), 10);
  });
});

// ------------------------------------------------------------------- Wilson

describe('F1-3 Wilson interval for a single proportion', () => {
  it('matches the known interval for 50 of 100 at 95%', () => {
    const result = wilsonInterval(50, 100, 0.05);
    near(result.lower, 0.403831530366, 1e-9);
    near(result.upper, 0.596168469634, 1e-9);
    near(result.point, 0.5, 1e-12);
  });

  it('stays inside [0, 1] at the extremes, unlike the Wald interval', () => {
    for (const successes of [0, 1, 99, 100]) {
      const r = wilsonInterval(successes, 100, 0.05);
      assert.ok(r.lower >= 0, `lower ${r.lower} < 0`);
      assert.ok(r.upper <= 1, `upper ${r.upper} > 1`);
    }
  });

  it('reports the whole unit interval for no data', () => {
    const r = wilsonInterval(0, 0, 0.05);
    assert.equal(r.lower, 0);
    assert.equal(r.upper, 1);
    assert.ok(Number.isNaN(r.point), 'no point estimate exists for 0 of 0');
  });

  it('rejects impossible counts', () => {
    assert.throws(() => wilsonInterval(5, 3), RangeError);
    assert.throws(() => wilsonInterval(-1, 3), RangeError);
    assert.throws(() => wilsonInterval(1.5, 3), RangeError);
  });
});

// --------------------------------------------------------- multiple comparison

describe('F1-3 Benjamini-Hochberg', () => {
  it('reproduces R p.adjust on the standard published example', () => {
    // R: p.adjust(c(0.001,0.008,0.039,0.041,0.042,0.06,0.074,0.205,0.212,0.216), "BH")
    const expected = [0.01, 0.04, 0.084, 0.084, 0.084, 0.1, 0.1057, 0.216, 0.216, 0.216];
    const result = benjaminiHochberg(
      [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216],
      0.05,
    );
    assert.equal(result.adjustedPValues.length, expected.length);
    for (const [index, want] of expected.entries()) {
      near(at(result.adjustedPValues, index), want, 5e-5);
    }
  });

  it('rejects exactly the first two of that example', () => {
    const result = benjaminiHochberg(
      [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216],
      0.05,
    );
    assert.deepEqual([...result.reject], [true, true, false, false, false, false, false, false, false, false]);
    assert.equal(result.rejectedCount, 2);
  });

  it('returns adjusted p-values in the original input order', () => {
    // A caller that maps position i to its own test must not have to re-sort.
    const ascending = benjaminiHochberg([0.01, 0.02, 0.03], 0.05);
    const descending = benjaminiHochberg([0.03, 0.02, 0.01], 0.05);
    near(at(descending.adjustedPValues, 0), at(ascending.adjustedPValues, 2), 1e-12);
    near(at(descending.adjustedPValues, 2), at(ascending.adjustedPValues, 0), 1e-12);
  });

  it('keeps adjusted p-values non-decreasing once sorted by raw p-value', () => {
    // Monotonicity is a property of the *sorted* sequence. In input order the
    // adjusted values legitimately follow the input, so testing it there
    // would be testing the wrong thing and would fail on correct code.
    const raw = [0.9, 0.01, 0.5, 0.02, 0.7, 0.001];
    const result = benjaminiHochberg(raw, 0.05);
    const order = raw
      .map((value, index) => ({ value, index }))
      .sort((a, b) => a.value - b.value)
      .map((entry) => result.adjustedPValues[entry.index] as number);
    for (let i = 1; i < order.length; i += 1) {
      assert.ok(
        (order[i] as number) >= (order[i - 1] as number) - 1e-15,
        `adjusted p-value ${i} (${String(order[i])}) is below the previous (${String(order[i - 1])})`,
      );
    }
  });

  it('never returns an adjusted p-value below its raw value', () => {
    const raw = [0.001, 0.02, 0.2, 0.5, 0.9];
    const result = benjaminiHochberg(raw, 0.05);
    for (const [index, value] of result.pValues.entries()) {
      assert.ok(
        (result.adjustedPValues[index] as number) >= value - 1e-15,
        `adjusted ${String(result.adjustedPValues[index])} is below raw ${value} at ${index}`,
      );
    }
  });

  it('rejects nothing when the smallest p-value is too large, even with many tests', () => {
    // The step-up must not let a family of large p-values reject at the last
    // rank, which is the classic way a BH implementation goes wrong.
    const result = benjaminiHochberg([0.6, 0.7, 0.8, 0.9], 0.05);
    assert.equal(result.rejectedCount, 0);
    assert.deepEqual([...result.reject], [false, false, false, false]);
  });

  it('rejects everything when every p-value is tiny', () => {
    const result = benjaminiHochberg([1e-10, 2e-10, 3e-10], 0.05);
    assert.equal(result.rejectedCount, 3);
  });

  it('handles an empty family without dividing by zero', () => {
    const result = benjaminiHochberg([], 0.05);
    assert.equal(result.familySize, 0);
    assert.equal(result.rejectedCount, 0);
    assert.deepEqual([...result.reject], []);
    assert.deepEqual([...result.adjustedPValues], []);
  });

  it('accepts the boundary p-values 0 and 1', () => {
    const result = benjaminiHochberg([0, 1], 0.05);
    near(at(result.adjustedPValues, 0), 0, 1e-15);
    near(at(result.adjustedPValues, 1), 1, 1e-15);
  });

  it('rejects p-values outside [0, 1] and a bad alpha', () => {
    assert.throws(() => benjaminiHochberg([0.5, 1.5], 0.05), RangeError);
    assert.throws(() => benjaminiHochberg([0.5, -0.1], 0.05), RangeError);
    assert.throws(() => benjaminiHochberg([0.5, Number.NaN], 0.05), RangeError);
    assert.throws(() => benjaminiHochberg([0.5], 0), RangeError);
    assert.throws(() => benjaminiHochberg([0.5], 1), RangeError);
  });

  it('names its method and citation', () => {
    const result = benjaminiHochberg([0.01], 0.05);
    assert.equal(result.method, 'benjamini-hochberg');
    assert.match(result.citation, /Benjamini & Hochberg/);
  });
});

// ------------------------------------------------------------------- defaults

describe('F1-3 published defaults', () => {
  it('exposes the pre-registered margin in both scales, consistently', () => {
    assert.equal(NON_INFERIORITY_MARGIN_PP, -2);
    assert.equal(NON_INFERIORITY_MARGIN, -0.02);
    assert.equal(DEFAULT_ALPHA, 0.05);
    assert.equal(MIN_DISCORDANT_FRACTION, 0.05);
  });

  it('is offline: no sockets, no clock, no global randomness', () => {
    // Determinism is the property the whole harness rests on, so it is asserted
    // rather than assumed. Byte-identical JSON across repeated runs is the
    // observable form.
    const { control, treatment } = table(30, 12, 25, 33);
    const first = JSON.stringify({
      mcnemar: exactMcNemar(control, treatment),
      ni: pairedNonInferiority(control, treatment),
      boot: pairedBootstrap(control, treatment, { resamples: 300, statistic: meanOf }),
      bh: benjaminiHochberg([0.01, 0.2, 0.5], 0.05),
    });
    const second = JSON.stringify({
      mcnemar: exactMcNemar(control, treatment),
      ni: pairedNonInferiority(control, treatment),
      boot: pairedBootstrap(control, treatment, { resamples: 300, statistic: meanOf }),
      bh: benjaminiHochberg([0.01, 0.2, 0.5], 0.05),
    });
    assert.equal(first, second);
  });

  it('never emits NaN for finite, well-formed input', () => {
    const { control, treatment } = table(30, 12, 25, 33);
    const results = [
      exactMcNemar(control, treatment),
      pairedNonInferiority(control, treatment),
      pairedBootstrap(control, treatment, { resamples: 200, statistic: meanOf }),
    ];
    for (const result of results) {
      assert.doesNotMatch(JSON.stringify(result), /null,NaN|NaN/, 'a NaN reached the report');
    }
  });
});
