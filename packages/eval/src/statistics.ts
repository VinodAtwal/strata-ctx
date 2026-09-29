/**
 * F1-3: the statistics that turn per-case outcomes into a claim.
 *
 * Everything here is deterministic and offline. No clock, no sockets, no
 * global randomness. The bootstrap draws from a seeded PRNG with a fixed
 * default, so two runs of the same harness on the same data produce
 * byte-identical intervals -- a claim about a product that changes on every
 * invocation is not a claim anyone can act on.
 *
 * Method choices are cited in the comments where they are made. Where a
 * literature check turned up a materially different convention, the convention
 * actually implemented is the one that matches the cited software, and the
 * disagreement is noted rather than smoothed over.
 */

// ---------------------------------------------------------------- constants

/**
 * Pre-registered non-inferiority margin, in percentage points.
 *
 * docs/spec.md:97-98 and ADR-10 (docs/decisions.md:81) pre-register -2pp
 * before data collection. It is written here as a fraction (-0.02) because
 * every other quantity in this file is a difference of proportions, and
 * mixing the two scales is how a -2pp margin silently becomes a -2.0 margin.
 */
export const NON_INFERIORITY_MARGIN_PP = -2;
export const NON_INFERIORITY_MARGIN = NON_INFERIORITY_MARGIN_PP / 100;

/**
 * Default alpha for interval estimates and hypothesis tests.
 */
export const DEFAULT_ALPHA = 0.05;

/**
 * Default paired-bootstrap replicate count.
 *
 * 10,000 is enough that the Monte Carlo error on a percentile endpoint is well
 * under the width of the interval it is estimating, which is the only property
 * that matters for a decision boundary. The default is overridable so a caller
 * can trade runtime for precision, but it is never implicit randomness: the
 * seed below is fixed.
 *
 * TODO(WS-F, F1-3): the error-vs-replicates argument is asserted, not measured.
 * Add a test that shows the interval width stabilising as `B` grows, so this
 * number is supported by the suite rather than by this comment.
 */
export const DEFAULT_BOOTSTRAP_RESAMPLES = 10_000;

/**
 * Default PRNG seed. Distinct name from the runner's `DEFAULT_SEED` on
 * purpose: both may be exported from the package barrel eventually, and two
 * exports with the same name cannot coexist.
 */
export const DEFAULT_BOOTSTRAP_SEED = 0x5eed_1234;

/**
 * Below this fraction of discordant pairs, the paired design carries too little
 * information for a difference to mean much, and the run is reported
 * inconclusive rather than as a null result.
 *
 * docs/evaluation.md requires inconclusive outcomes to be reported as such
 * instead of being folded into "no difference". A 2pp non-inferiority claim on
 * a run where 99% of pairs agreed is a claim about 1% of the data.
 *
 * TODO(WS-F, F1-3): 0.05 is a judgement call, not a cited threshold. It needs
 * either a source or a power calculation against the corpus sizes F1-4 curates.
 * Do not present it as a standard in a claims audit before then.
 */
export const MIN_DISCORDANT_FRACTION = 0.05;

// ------------------------------------------------------------------ types

export type PairedOutcome = boolean | 'pass' | 'fail';

export interface McNemarResult {
  readonly n11: number;
  readonly n10: number;
  readonly n01: number;
  readonly n00: number;
  readonly n: number;
  /**
   * Exact conditional one-sided p-value for H0: p01 = p10, in the direction the
   * data point. Conservative by construction -- see the note in
   * `exactMcNemar`. The two directions are the same number by the symmetry of
   * the null distribution; both are exposed so a caller cannot have to know
   * that in order to report "the treatment was better" or "worse".
   */
  readonly pTreatmentWorse: number;
  readonly pTreatmentBetter: number;
  /**
   * Two-sided exact p-value, `min(1, 2 * P(X <= min(n01, n10)))`.
   *
   * This is R's `binom.test` convention and the one used by the standard
   * exact-McNemar implementations. It is *not* the same as summing the two
   * one-sided tails: for n01=1, n10=3 out of m=4 discordant pairs the doubled
   * smaller tail is 0.625 while the sum of the one-sided tails saturates at
   * 1.0. The doubled form is the one used, because the sum saturates as soon
   * as either tail exceeds 0.5, which throws away the evidence in the other
   * tail exactly when the data are most lopsided.
   */
  readonly pTwoSided: number;
  /**
   * The sum-of-tails variant, `min(1, pBetter + pWorse)`, reported only so a
   * reader can see it differ from `pTwoSided` instead of guessing which
   * convention a comparison number came from.
   */
  readonly pTwoSidedSumOfTails: number;
  readonly discordantPairs: number;
  readonly state: McNemarState;
  readonly informative: boolean;
  readonly method: 'exact-conditional';
}

export type McNemarState =
  | 'ok'
  | 'no_pairs'
  | 'no_discordant_pairs'
  | 'insufficient_discordance';

export interface BootstrapOptions {
  readonly resamples?: number;
  readonly seed?: number;
  /** Defaults to the median, which is the summary docs/evaluation.md asks for. */
  readonly statistic?: (differences: readonly number[]) => number;
  readonly alpha?: number;
}

export type BootstrapState = 'ok' | 'no_pairs' | 'degenerate_zero_variance' | 'single_pair';

export interface BootstrapResult {
  readonly n: number;
  readonly statistic: 'median' | 'custom';
  readonly resamples: number;
  readonly seed: number;
  readonly estimate: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly alpha: number;
  readonly state: BootstrapState;
  readonly degenerate: boolean;
  readonly method: 'paired-percentile-bootstrap';
  /** Per-resample statistic values, in draw order. Enables an exact test. */
  readonly replicates: readonly number[];
}

export interface NonInferiorityResult {
  readonly n: number;
  readonly n10: number;
  readonly n01: number;
  readonly discordantPairs: number;
  readonly discordantFraction: number | null;
  /** Observed paired difference in proportions, treatment minus control. */
  readonly observedDifference: number | null;
  /** Same difference, with the Agresti-Min continuity correction applied. */
  readonly correctedDifference: number | null;
  readonly standardError: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  /** The pre-registered margin the interval was tested against. */
  readonly margin: number;
  /** True only if the whole interval clears the margin and data suffice. */
  readonly nonInferior: boolean;
  readonly conclusive: boolean;
  readonly state: NonInferiorityState;
  readonly method: 'agresti-min-wald-plus-two';
  readonly citation: string;
}

export type NonInferiorityState =
  | 'ok'
  | 'no_pairs'
  | 'no_discordant_pairs'
  | 'insufficient_discordance'
  | 'interval_crosses_margin';

export interface MultipleComparisonResult {
  readonly method: 'benjamini-hochberg';
  readonly pValues: readonly number[];
  readonly adjustedPValues: readonly number[];
  readonly reject: readonly boolean[];
  readonly alpha: number;
  readonly rejectedCount: number;
  readonly familySize: number;
  readonly citation: string;
}

// ------------------------------------------------------------------ helpers

/**
 * A 32-bit PRNG (mulberry32).
 *
 * Chosen for being short, auditable, and adequate for resampling indices: the
 * bootstrap's reproducibility requirement is that a given seed gives the same
 * resample, not that the resample is high-quality randomness. Cryptographic
 * quality would buy nothing here and would obscure the fact that the result is
 * reproducible by design.
 */
const mulberry32 = (seed: number): (() => number) => {
  // Force to uint32 so a negative or fractional seed still yields a valid state
  // rather than an undefined one.
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Inverse standard normal CDF, via Wichura's Algorithm AS 241 (PPND16).
 *
 * AS 241 is used rather than a rational approximation of Acklam or a
 * Taylor-series normal approximation because it is accurate to about 1e-16
 * across the whole double range. z values here are bounded away from the
 * extremes by the 1e-15 clamps below, so the algorithm's own tail branches are
 * never the thing under test.
 *
 * Wichura, A. S. (1988). The Percentage Points of the Normal Distribution.
 * Applied Statistics 37(3), 477-483.
 */
const normalQuantile = (p: number): number => {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) {
    throw new RangeError(`statistics: normalQuantile needs 0 < p < 1, got ${p}`);
  }
  // Clamped so a 0 or 1 tail probability cannot produce an infinite z and then
  // an infinite interval.
  const prob = Math.min(1 - 1e-15, Math.max(1e-15, p));
  const q = prob - 0.5;
  let r: number;

  if (Math.abs(q) <= 0.425) {
    r = 0.180625 - q * q;
    return (
      q *
      (((((((2509.08092873012265 * r + 33430.575583588128211) * r + 67265.770927008707076) * r +
        45921.953931549869594) * r + 13731.693765509460718) * r + 1971.590950306551349) * r +
        133.14166789178438) * r + 3.3871328727963665) /
      (((((((5226.495278852854426 * r + 28729.08573572194291) * r + 39307.895800092708669) * r +
        21213.794301586596703) * r + 5394.196021424751052) * r + 687.187007492057887) * r +
        42.313330701600911) * r + 1)
    );
  }

  r = q < 0 ? prob : 1 - prob;
  r = Math.sqrt(-Math.log(r));
  let value: number;
  if (r <= 5) {
    r -= 1.6;
    value = (((((((0.00077454501427834139 * r + 0.02272384498926918392) * r +
      0.24178072517745061165) * r + 1.2704582524523684) * r +
      3.6478483247632045) * r + 5.769497221460691) * r +
      4.630337846156546) * r + 1.4234371107496835) /
      (((((((1.0507500716444169e-9 * r + 0.00054759380849953455) * r +
        0.01519866656361645689) * r + 0.1481039764274800774) * r +
        0.6897673349851000113) * r + 1.6763848301838038) * r +
        2.053191626637759) * r + 1);
  } else {
    r -= 5;
    value = (((((((2.0103343992922881e-7 * r + 2.7115555687434876e-5) * r +
      0.00124266094738807839) * r + 0.02653218952657612414) * r +
      0.29656057182850487086) * r + 1.7848265399172913) * r +
      5.463784911164114) * r + 6.657904643501103) /
      (((((((2.0442631033899397e-15 * r + 1.4215117583164459e-7) * r +
        1.8463183175100548e-5) * r + 0.00078686913114561329) * r +
        0.01487536129085061457) * r + 0.13692988092273580825) * r +
        0.5998322065558879812) * r + 1);
  }
  return q < 0 ? -value : value;
};

const clamp01 = (value: number): number => clamp(value, 0, 1);

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

/**
 * Exact P(X <= k) for X ~ Binomial(n, 0.5).
 *
 * Three properties matter here, and all of them are about not losing a real
 * result.
 *
 * First, the sum is never formed as `1 - CDF(k)`. Differencing loses every
 * significant digit once the tail falls below about 1e-16, and for a few
 * hundred discordant pairs one of the two tails routinely is that small.
 *
 * Second, and less obviously, the sum is *anchored at the mode* and run
 * downwards, rather than starting from `0.5^n` and running up. The term
 * `0.5^n` is the smallest term in the whole distribution: for n = 200 it is
 * about 6e-61, and every step up from there multiplies by a ratio under 1, so
 * the accumulator only ever moves further toward zero. By n in the low
 * hundreds the initial term underflows to exactly 0 and the returned tail is 0
 * for every k, which is a silent wrong answer rather than an obvious one.
 *
 * Third, the walk is anchored at P(X = limit) and then stepped all the way
 * down to 0, accumulating as it goes. Two details are load-bearing:
 *
 *   - The ratios below the mode are all under 1, so the terms shrink as the
 *     walk descends and the accumulator grows monotonically to the answer. It
 *     is therefore safe at any n: the smallest term summed is P(X = 0) =
 *     0.5^n, and by then the accumulator is already the bulk of the tail.
 *   - The walk must run from `limit` down to 0 inclusive. Summing only the
 *     window between the mode and `limit` yields the probability mass of that
 *     window rather than of the tail below it, which is wrong by a wide margin
 *     (for n = 4, k = 1 it returns 0.625 instead of 0.3125).
 *
 * The upper tail is then taken by symmetry: P(X >= n-k) == P(X <= k), which
 * is exact for a symmetric binomial and guarantees the two one-sided
 * p-values cannot drift apart by rounding.
 */
const binomialTailHalf = (n: number, k: number): number => {
  if (k < 0) return 0;
  if (k >= n) return 1;
  // Sum the shorter side: for a symmetric binomial P(X <= k) and
  // P(X <= n-k-1) are complements, and one of them is below the mode.
  const upper = k >= n / 2;
  const limit = upper ? n - k - 1 : k;
  if (limit < 0) return 0;

  // P(X = mode) for the symmetric binomial, accumulated in logs so the
  // intermediate exponentiation cannot underflow on its own.
  const mode = Math.floor(n / 2);
  let logTerm = -n * Math.LN2;
  for (let i = 0; i < mode; i += 1) {
    logTerm += Math.log(n - i) - Math.log(i + 1);
  }
  let term = Math.exp(logTerm);

  // Step down from the mode to `limit` without accumulating, to reach
  // P(X = limit): P(X = i-1) = P(X = i) * i / (n - i + 1).
  for (let i = mode; i > limit; i -= 1) {
    term *= i / (n - i + 1);
  }

  // Now accumulate P(X = limit) + P(X = limit-1) + ... + P(X = 0).
  let total = term;
  for (let i = limit; i > 0; i -= 1) {
    term *= i / (n - i + 1);
    total += term;
  }
  return upper ? 1 - total : total;
};

const asPass = (value: PairedOutcome): boolean => {
  if (value === true) return true;
  if (value === false) return false;
  if (value === 'pass') return true;
  return false;
};

const validateCounts = (control: readonly PairedOutcome[], treatment: readonly PairedOutcome[]): void => {
  if (control.length !== treatment.length) {
    throw new RangeError(
      `statistics: paired arrays must be the same length, got ${control.length} and ${treatment.length}`,
    );
  }
};

// ------------------------------------------------------------------ McNemar

/**
 * Exact conditional McNemar test on paired binary outcomes.
 *
 * Under H0 the discordant pairs are exchangeable, so conditional on the m
 * discordant pairs the count n01 is Binomial(m, 0.5) and the p-value is a
 * binomial tail. This is exact in the conditional sense, not the unconditional
 * sense: the marginal test conditions on n01 + n10, which is itself
 * informative, and is therefore uniformly more likely to reject than a test
 * that did not condition. The consequence is that this test is conservative.
 *
 * That is a deliberate choice, not an oversight. The claims in docs/evaluation.md
 * are one-sided and safety-shaped ("does not lose more than 2pp"), and a
 * conservative test under-reports gains and over-retains a treatment that
 * should be dropped. Readers expecting the asymptotic McNemar with a
 * continuity correction will get a larger p-value from this function; the
 * literature on this gap is Fagerland, Lydersen & Laake (2013), BMC Medical
 * Research Methodology 13:91,
 * https://pmc.ncbi.nlm.nih.gov/articles/PMC3716987/
 *
 * Table layout, fixed here so the two functions in this file cannot disagree:
 *   n11: control and treatment both pass
 *   n10: control passes, treatment fails  (a treatment loss)
 *   n01: control fails, treatment passes  (a treatment gain)
 *   n00: both fail
 */
export const exactMcNemar = (
  control: readonly PairedOutcome[],
  treatment: readonly PairedOutcome[],
): McNemarResult => {
  validateCounts(control, treatment);

  let n11 = 0;
  let n10 = 0;
  let n01 = 0;
  let n00 = 0;
  for (const [index] of control.entries()) {
    const c = asPass(control[index] ?? false);
    const t = asPass(treatment[index] ?? false);
    if (c && t) n11 += 1;
    else if (c && !t) n10 += 1;
    else if (!c && t) n01 += 1;
    else n00 += 1;
  }

  const n = control.length;
  const discordantPairs = n10 + n01;
  const base = {
    n11,
    n10,
    n01,
    n00,
    n,
    discordantPairs,
  };

  if (n === 0) {
    return {
      ...base,
      pTreatmentWorse: 1,
      pTreatmentBetter: 1,
      pTwoSided: 1,
      pTwoSidedSumOfTails: 1,
      state: 'no_pairs',
      informative: false,
      method: 'exact-conditional',
    };
  }
  if (discordantPairs === 0) {
    // The two arms agreed on every case. There is no evidence of a difference,
    // but reporting p=1 here without saying so would let "identical results"
    // be cited as though the run had power to detect a difference.
    return {
      ...base,
      pTreatmentWorse: 1,
      pTreatmentBetter: 1,
      pTwoSided: 1,
      pTwoSidedSumOfTails: 1,
      state: 'no_discordant_pairs',
      informative: false,
      method: 'exact-conditional',
    };
  }

  // Under H0, X = n01 ~ Binomial(m, 0.5), and n10 = m - X is also Bin(m, 0.5).
  //
  // Evidence that the treatment is BETTER: n01 is unusually large, so the p
  // is P(n01 >= observed) = P(X >= n01_obs) = P(X <= n10_obs) by symmetry.
  //
  // Evidence that it is WORSE: n10 is unusually large, so the p is
  // P(n10 >= observed) = P(X <= n01_obs) by the same symmetry.
  //
  // Both are expressed as a direct lower tail rather than as `1 - CDF(k)`.
  // When the imbalance is large, `1 - P(X <= n01 - 1)` is one minus a number
  // extremely close to 1 and cancels to exactly 0, destroying the very
  // evidence being measured. That is not hypothetical: at n01 = 990 of 1000
  // discordant pairs it returns 0 where the true p is about 2.5e-278.
  const pBetter = binomialTailHalf(discordantPairs, n10);
  const pWorse = binomialTailHalf(discordantPairs, n01);
  // The two-sided p doubles whichever tail is smaller, which is R's
  // convention and the one the methodology commits to.
  const smaller = Math.min(pBetter, pWorse);

  return {
    ...base,
    // Not rounded. Rounding a p-value to 12 decimal places would silently
    // turn any p below 5e-13 into exactly 0, which is precisely the
    // cancellation this module exists to avoid: a real result of 3e-14 would
    // then be indistinguishable from a computation that underflowed.
    pTreatmentBetter: clamp01(pBetter),
    pTreatmentWorse: clamp01(pWorse),
    pTwoSided: clamp01(smaller * 2),
    pTwoSidedSumOfTails: clamp01(pBetter + pWorse),
    state: 'ok',
    informative: true,
    method: 'exact-conditional',
  };
};

/**
 * Wilson score interval for a single proportion.
 *
 * Used only to describe the per-arm pass rates alongside a paired test, where
 * an unpaired interval would be misleading on its own and is labelled as such.
 */
export const wilsonInterval = (
  successes: number,
  total: number,
  alpha: number = DEFAULT_ALPHA,
): { readonly lower: number; readonly upper: number; readonly point: number } => {
  if (!Number.isInteger(successes) || !Number.isInteger(total) || total < 0) {
    throw new RangeError('statistics: wilsonInterval needs integer counts and a non-negative total');
  }
  if (successes < 0 || successes > total) {
    throw new RangeError(`statistics: ${successes} successes cannot lie in [0, ${total}]`);
  }
  if (total === 0) {
    // No data: the interval is the whole unit interval, not a point estimate.
    return { lower: 0, upper: 1, point: Number.NaN };
  }
  const z = normalQuantile(1 - alpha / 2);
  const n = total;
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const halfWidth = (z / denominator) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    lower: clamp(center - halfWidth, 0, 1),
    upper: clamp(center + halfWidth, 0, 1),
    point: p,
  };
};

// ----------------------------------------------------------------- bootstrap

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const mid = n >> 1;
  const upper = sorted[mid];
  const lower = sorted[n % 2 === 0 ? mid - 1 : mid];
  if (upper === undefined || lower === undefined) return Number.NaN;
  return (upper + lower) / 2;
};

/**
 * Percentile of a pre-sorted array using Hyndman & Fan type 7, the default in
 * R's `quantile` and in numpy.
 *
 * Type 7 is chosen over the other interpolating types because it is the
 * convention a reader will assume when a paper reports a bootstrap interval
 * without naming its quantile method. The value is pinned by a hand-checked
 * test against R's result.
 *
 * Hyndman, R. J. and Fan, Y. (1996). Sample Quantiles in Statistical Packages.
 * The American Statistician 50(4), 361-365.
 */
export const percentile = (sorted: readonly number[], probability: number): number => {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sorted[0] ?? Number.NaN;
  const h = (n - 1) * probability;
  const lowIndex = Math.floor(h);
  const highIndex = Math.ceil(h);
  const low = sorted[lowIndex];
  const high = sorted[highIndex];
  if (low === undefined || high === undefined) return Number.NaN;
  return low + (h - lowIndex) * (high - low);
};

/**
 * Paired percentile bootstrap of a location statistic on the difference
 * (treatment - control).
 *
 * Pairs are resampled as units, never as two independent samples. Resampling
 * the arms separately would discard the pairing and inflate the interval,
 * which is the single most common error in this analysis: the arms see the
 * same cases, so the case-to-case difficulty cancels in the difference and the
 * variance of that difference is much smaller than the arms' variances imply.
 *
 * References: Efron & Tibshirani (1993), An Introduction to the Bootstrap;
 * percentile intervals as implemented in R's `boot` and numpy's
 * `bootstrap`.
 */
export const pairedBootstrap = (
  control: readonly PairedOutcome[],
  treatment: readonly PairedOutcome[],
  options: BootstrapOptions = {},
): BootstrapResult => {
  validateCounts(control, treatment);

  const resamples = options.resamples ?? DEFAULT_BOOTSTRAP_RESAMPLES;
  const seed = options.seed ?? DEFAULT_BOOTSTRAP_SEED;
  const alpha = options.alpha ?? DEFAULT_ALPHA;
  const statistic = options.statistic;
  const statName: BootstrapResult['statistic'] = statistic === undefined ? 'median' : 'custom';

  if (!Number.isInteger(resamples) || resamples < 1) {
    throw new RangeError(`statistics: resamples must be an integer >= 1, got ${resamples}`);
  }
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new RangeError(`statistics: alpha must lie in (0, 1), got ${alpha}`);
  }
  if (!Number.isFinite(seed)) {
    throw new RangeError(`statistics: seed must be finite, got ${seed}`);
  }

  const n = control.length;
  const differences: number[] = [];
  for (const [index] of control.entries()) {
    const difference = (asPass(treatment[index] ?? false) ? 1 : 0) - (asPass(control[index] ?? false) ? 1 : 0);
    if (!Number.isFinite(difference)) {
      throw new RangeError(`statistics: pair ${index} produced a non-finite difference`);
    }
    differences.push(difference);
  }

  const base = { n, statistic: statName, resamples, seed, alpha, method: 'paired-percentile-bootstrap' as const };

  if (n === 0) {
    return {
      ...base,
      estimate: null,
      lower: null,
      upper: null,
      state: 'no_pairs',
      degenerate: true,
      replicates: [],
    };
  }

  const pointEstimate = statistic === undefined ? median(differences) : statistic(differences);
  if (!Number.isFinite(pointEstimate)) {
    throw new RangeError('statistics: the statistic returned a non-finite value on the observed data');
  }

  const spread = Math.max(...differences) - Math.min(...differences);
  if (n === 1 || spread === 0) {
    // Every resample of a constant sample is that constant, so the interval is
    // the point itself. Reporting [d, d] as a percentile interval would be
    // technically correct and analytically useless; the explicit degenerate
    // label is what stops it being read as a tight but well-measured estimate.
    return {
      ...base,
      estimate: pointEstimate,
      lower: pointEstimate,
      upper: pointEstimate,
      state: n === 1 ? 'single_pair' : 'degenerate_zero_variance',
      degenerate: true,
      replicates: [],
    };
  }

  const random = mulberry32(seed);
  const replicates: number[] = [];
  for (let draw = 0; draw < resamples; draw += 1) {
    const resample: number[] = new Array<number>(n);
    for (let i = 0; i < n; i += 1) {
      const pick = Math.floor(random() * n);
      resample[i] = differences[pick] ?? 0;
    }
    const value = statistic === undefined ? median(resample) : statistic(resample);
    if (!Number.isFinite(value)) {
      throw new RangeError(`statistics: the statistic returned a non-finite value on replicate ${draw}`);
    }
    replicates.push(value);
  }

  const sorted = [...replicates].sort((a, b) => a - b);
  return {
    ...base,
    estimate: pointEstimate,
    lower: percentile(sorted, alpha / 2),
    upper: percentile(sorted, 1 - alpha / 2),
    state: 'ok',
    degenerate: false,
    replicates: Object.freeze(replicates),
  };
};

// -------------------------------------------------------- non-inferiority

/**
 * Non-inferiority of the treatment arm against the control arm, on paired
 * binary outcomes, at the pre-registered margin.
 *
 * Interval: Agresti & Min's Wald interval with the "+2" modification, the
 * "Agresti-Min" method of Newcombe (1998). The correction adds two pseudo-
 * observations to each arm before applying the ordinary Wald interval to the
 * 2x2 paired table. Writing n for the number of pairs (NOT the number of
 * discordant pairs) and m = n10 + n01:
 *
 *   d = (n01 - n10) / (n + 2)
 *   SE = sqrt(((n10 + n01 + 1) / (n + 2) - d^2) / (n + 2))
 *   CI = d +/- z * SE, clamped to [-1, 1]
 *
 * Using the discordant count in the denominator instead of n is a plausible
 * looking error that gives visibly different numbers on real data, and it is
 * pinned here by a hand-check against the published example: n=86, n10=8,
 * n01=16 gives d=0.09091, SE=0.05599, CI=[-0.019, 0.201], which is
 * Agresti & Min (2005) Table V, row 2, as reproduced by NCSS.
 *
 * The correction pulls the interval away from the degenerate zero width the
 * uncorrected Wald interval collapses to when the arms agree, and makes the
 * interval computable when a marginal total is zero. Coverage is close to
 * nominal where the uncorrected interval is badly anti-conservative.
 *
 * Agresti, A. and Min, Y. (2005). Simple improved confidence intervals for
 * comparing matched proportions. Statistics in Medicine 24(5), 729-740.
 * doi:10.1002/sim.1781. Also Newcombe, R.G. (1998), Statistics in Medicine
 * 17, 889-902.
 *
 * This is deliberately *not* presented as an exact conditional test. A search
 * of the matched-proportions literature turned up no exact conditional
 * procedure for a non-inferiority margin other than the null margin of zero
 * (D'Agostino & Gallo, Statistics in Medicine 17, 1998), so the interval is
 * the honest instrument and the claim rests on the interval clearing the
 * margin, not on a p-value.
 */
export const pairedNonInferiority = (
  control: readonly PairedOutcome[],
  treatment: readonly PairedOutcome[],
  options: { readonly margin?: number; readonly alpha?: number } = {},
): NonInferiorityResult => {
  validateCounts(control, treatment);

  const margin = options.margin ?? NON_INFERIORITY_MARGIN;
  const alpha = options.alpha ?? DEFAULT_ALPHA;

  if (!Number.isFinite(margin) || margin >= 0) {
    throw new RangeError(
      `statistics: margin must be negative; ${margin} is not a non-inferiority margin`,
    );
  }
  // The pre-registration fixes -2pp. A wider margin makes the test easier to
  // pass, so accepting one at runtime would let a run widen its own bar after
  // seeing the data. A tighter margin is fine: it is a stricter claim.
  if (margin < NON_INFERIORITY_MARGIN) {
    throw new RangeError(
      `statistics: margin ${margin} is wider than the pre-registered ` +
        `${NON_INFERIORITY_MARGIN} (${NON_INFERIORITY_MARGIN_PP}pp); widen the bar before the data, not after`,
    );
  }
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new RangeError(`statistics: alpha must lie in (0, 1), got ${alpha}`);
  }

  const mcnemar = exactMcNemar(control, treatment);
  const n = mcnemar.n;
  const discordantFraction = n === 0 ? null : mcnemar.discordantPairs / n;

  const base = {
    n,
    n10: mcnemar.n10,
    n01: mcnemar.n01,
    discordantPairs: mcnemar.discordantPairs,
    discordantFraction,
    margin,
    method: 'agresti-min-wald-plus-two' as const,
    citation: 'Agresti & Min (2005), Stat Med 24(5):729-740, doi:10.1002/sim.1781',
  };

  if (n === 0) {
    return {
      ...base,
      observedDifference: null,
      correctedDifference: null,
      standardError: null,
      lower: null,
      upper: null,
      nonInferior: false,
      conclusive: false,
      state: 'no_pairs',
    };
  }
  if (mcnemar.discordantPairs === 0) {
    return {
      ...base,
      observedDifference: 0,
      correctedDifference: 0,
      standardError: 0,
      lower: 0,
      upper: 0,
      nonInferior: true,
      conclusive: false,
      state: 'no_discordant_pairs',
    };
  }

  const observedDifference = (mcnemar.n01 - mcnemar.n10) / n;
  // n, not the discordant count: Agresti-Min add two pseudo-observations to
  // each arm, and the arms have n observations each.
  const adjusted = n + 2;
  const correctedDifference = (mcnemar.n01 - mcnemar.n10) / adjusted;
  const varianceTerm = (mcnemar.n10 + mcnemar.n01 + 1) / adjusted - correctedDifference * correctedDifference;
  const standardError = Math.sqrt(Math.max(varianceTerm, 0) / adjusted);
  const z = normalQuantile(1 - alpha / 2);
  const lower = clamp(correctedDifference - z * standardError, -1, 1);
  const upper = clamp(correctedDifference + z * standardError, -1, 1);

  if (discordantFraction !== null && discordantFraction < MIN_DISCORDANT_FRACTION) {
    return {
      ...base,
      observedDifference,
      correctedDifference,
      standardError,
      lower,
      upper,
      nonInferior: false,
      conclusive: false,
      state: 'insufficient_discordance',
    };
  }

  const clearsMargin = lower > margin;
  return {
    ...base,
    observedDifference,
    correctedDifference,
    standardError,
    lower,
    upper,
    nonInferior: clearsMargin,
    conclusive: true,
    state: clearsMargin ? 'ok' : 'interval_crosses_margin',
  };
};

// ------------------------------------------------- multiple comparisons

/**
 * Benjamini-Hochberg step-up FDR control.
 *
 * Reject hypotheses in ascending p-value order while the running p-value
 * stays below the rank-scaled threshold k*alpha/m, then reject everything at or
 * below the largest such p-value. The step-up structure is what makes the
 * procedure valid under positive dependence; the fixed-order (Bonferroni-style)
 * step-down variant does not control FDR in general.
 *
 * Benjamini, Y. and Hochberg, Y. (1995). Controlling the False Discovery Rate.
 * JRSS-B 57(1), 289-300.
 */
export const benjaminiHochberg = (
  pValues: readonly number[],
  alpha: number = DEFAULT_ALPHA,
): MultipleComparisonResult => {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new RangeError(`statistics: alpha must lie in (0, 1), got ${alpha}`);
  }
  const familySize = pValues.length;
  for (const [index, value] of pValues.entries()) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(
        `statistics: pValues[${index}] is ${String(value)}; p-values must be finite and lie in [0, 1]`,
      );
    }
  }

  const order = pValues
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value || a.index - b.index);

  const adjusted = new Array<number>(familySize).fill(1);
  const reject = new Array<boolean>(familySize).fill(false);
  if (familySize === 0) {
    return {
      method: 'benjamini-hochberg',
      pValues: [],
      adjustedPValues: [],
      reject: [],
      alpha,
      rejectedCount: 0,
      familySize: 0,
      citation: 'Benjamini & Hochberg (1995), JRSS-B 57(1):289-300',
    };
  }

  // Largest rank k whose p_k <= k*alpha/m; everything at or below it rejects.
  let largestPassingRank = -1;
  for (const [rank, entry] of order.entries()) {
    const threshold = ((rank + 1) * alpha) / familySize;
    if (entry.value <= threshold) largestPassingRank = rank;
  }
  if (largestPassingRank >= 0) {
    for (let rank = 0; rank <= largestPassingRank; rank += 1) {
      const entry = order[rank];
      if (entry === undefined) continue;
      reject[entry.index] = true;
    }
  }

  // Monotone adjusted p-values: running minimum from the largest p downwards,
  // so the sequence is non-decreasing as Hyndman & Fan require.
  let runningMin = 1;
  for (let rank = familySize - 1; rank >= 0; rank -= 1) {
    const entry = order[rank];
    if (entry === undefined) continue;
    const scaled = (entry.value * familySize) / (rank + 1);
    runningMin = Math.min(runningMin, scaled);
    adjusted[entry.index] = clamp(runningMin, 0, 1);
  }

  return {
    method: 'benjamini-hochberg',
    pValues: [...pValues],
    adjustedPValues: adjusted,
    reject,
    alpha,
    rejectedCount: reject.filter(Boolean).length,
    familySize,
    citation: 'Benjamini & Hochberg (1995), JRSS-B 57(1):289-300',
  };
};
