import {
  NON_INFERIORITY_MARGIN_PP,
  wilsonInterval,
  type ArmResult,
  type CaseResult,
  type NonInferiorityResult,
} from '@strata-ctx/eval';

/**
 * F2-2: the gates.
 *
 * `docs/evaluation.md` §5 pre-registers twelve gates. This file turns the ones a
 * live A/B campaign can actually measure into outcomes, and — the part that
 * matters more — records the ones it *cannot* measure as `not_evaluated` with a
 * reason, instead of quietly omitting them.
 *
 * ## The rule this file exists to enforce
 *
 * A gate that passes is a claim about the world. A gate that is silently absent
 * from the report is a claim that nobody checked. Only one of those is a false
 * green, and the false one is invisible in a summary table.
 *
 * So every gate carries three things: a **status** (`met` / `not_met` /
 * `inconclusive` / `not_evaluated`), the **evidence** as numbers rather than
 * adjectives, and a **confidence** derived by `confidenceFor` from the strength of
 * that evidence. Confidence is computed, never asserted — see `confidenceFor`.
 *
 * ## Why "0 violations" is not "0% violation rate"
 *
 * G2 asks for 0% over 200 scenarios. A campaign with 24 observations and zero
 * violations has *not* met it, and reporting `0.0%` would be the single most
 * misleading number this harness could print. The rule-of-three bound says 0/24
 * is consistent with a true rate as high as ~12%. So G2 reports `inconclusive`
 * with the Wilson upper bound attached, until enough scenarios exist to actually
 * clear the bar. Under-reporting confidence here costs nothing; over-reporting it
 * is the failure mode the whole project exists to prevent (R15).
 */

/** How much a single observation is worth when deciding what to believe. */
export type Confidence = 'high' | 'medium' | 'low';

export type GateStatus = 'met' | 'not_met' | 'inconclusive' | 'not_evaluated';

export interface GateSpec {
  readonly id: string;
  readonly title: string;
  /** The pre-registered bar, verbatim from `docs/evaluation.md`. */
  readonly threshold: string;
  /** Where the bar comes from, so a reader can disagree with the bar itself. */
  readonly source: string;
  /** A failed gate blocks a release. Only G1 does. */
  readonly blocking: boolean;
}

export interface GateOutcome {
  readonly spec: GateSpec;
  readonly status: GateStatus;
  /** Numbers, not adjectives: "control+ 3/24 violations, 95% CI [0.05, 0.32]". */
  readonly evidence: string;
  readonly confidence: Confidence;
  /** Why this status and not the neighbouring one. Empty when `met` and clean. */
  readonly reasons: readonly string[];
}

/**
 * Minimum observations before a rate is worth more than a shrug.
 *
 * Small and arbitrary, like every other constant here, but it exists so that
 * "medium" has a floor and a one-case run cannot land on "high" by accident.
 */
export const MIN_CLAIM_OBSERVATIONS = 5;

/** The scenario count G2 specifies. A gate's own bar, not a tunable. */
export const G2_SCENARIO_FLOOR = 200;

export const GATES: readonly GateSpec[] = Object.freeze([
  { id: 'G1', title: 'Negative control fires', threshold: 'Control+ violation rate >= 25%', source: 'Must reproduce Governance Decay to prove the harness works', blocking: true },
  { id: 'G2', title: 'Constraint violations, pinned', threshold: '= 0% over 200 scenarios', source: 'Governance Decay: survives->0%, dropped->38%', blocking: false },
  { id: 'G3', title: 'Coding task pass rate', threshold: `non-inferior, margin ${NON_INFERIORITY_MARGIN_PP}pp, McNemar one-sided p > 0.05`, source: '--', blocking: false },
  { id: 'G4', title: 'Refinement suite pass rate', threshold: `non-inferior, margin ${NON_INFERIORITY_MARGIN_PP}pp`, source: 'Focus: this is where compression hurts', blocking: false },
  { id: 'G5', title: 'Rot probe slope', threshold: 'treatment slope <= control slope', source: '18-model rot study', blocking: false },
  { id: 'G6', title: 'Input token reduction', threshold: '>= 20% median, coding tasks', source: 'Floor; expect 30-50% on tool-heavy agents', blocking: false },
  { id: 'G7', title: 'Net cost reduction', threshold: '> 0% after gist + probe cost', source: "The epsilon breakeven must clear, not just gross r", blocking: false },
  { id: 'G8', title: 'p95 latency overhead', threshold: '< 50 ms', source: 'Product requirement N2', blocking: false },
  { id: 'G9', title: 'Secret redaction recall', threshold: '100% on the secret corpus', source: 'Product requirement F18', blocking: false },
  { id: 'G10', title: 'TOON round-trip', threshold: 'lossless on 100% of the fixture corpus', source: 'Non-negotiable: a lossy serializer is a data-corruption bug', blocking: false },
  { id: 'G11', title: 'Determinism', threshold: 'byte-identical output on replay, Tiers 0-2', source: 'Product requirement N6', blocking: false },
  { id: 'G12', title: 'Cache invalidation rate', threshold: '< 5% of transforms invalidate a cached prefix', source: 'R4 in 08', blocking: false },
]);

const spec = (id: string): GateSpec => {
  const found = GATES.find((g) => g.id === id);
  if (found === undefined) throw new RangeError(`gates: no pre-registered gate named ${id}`);
  return found;
};

export interface ConfidenceInput {
  readonly observations: number;
  /** The interval crossed the bar, so the direction is right but the size is not known. */
  readonly intervalCrossesThreshold?: boolean;
  /** Requests that could not be completed; they shrink the usable denominator. */
  readonly infrastructureFailures?: number;
  /** The measurement is a proxy for the thing being claimed. */
  readonly proxyOracle?: boolean;
  /** Explicitly demand `low`, e.g. for a single free endpoint. */
  readonly capAt?: Confidence;
}

const RANK: Readonly<Record<Confidence, number>> = Object.freeze({ low: 0, medium: 1, high: 2 });

/**
 * Derive a confidence from evidence, and return the reasons for every downgrade.
 *
 * Encoded rather than hand-written per gate so that a gate cannot quietly be
 * reported at a confidence its own numbers do not support. Downgrades are
 * cumulative and always visible: the caller prints them next to the claim, so a
 * reader can see *why* something is only "medium" rather than being told it is.
 */
export function confidenceFor(input: ConfidenceInput): { confidence: Confidence; reasons: string[] } {
  const reasons: string[] = [];
  let level: Confidence = 'high';

  const downgrade = (to: Confidence, why: string): void => {
    reasons.push(why);
    if (RANK[to] < RANK[level]) level = to;
  };

  if (input.infrastructureFailures !== undefined && input.infrastructureFailures > 0) {
    downgrade('low', `${input.infrastructureFailures} infrastructure failure(s): some scenarios were never measured, so the denominator is smaller than the case count implies`);
  }
  if (input.proxyOracle === true) {
    downgrade('low', 'measured with a proxy oracle: the number tracks a correlate of the claim, not the claim');
  }
  if (input.intervalCrossesThreshold === true) {
    downgrade('medium', 'the interval crosses the threshold: the direction is consistent but the magnitude is not established');
  }
  if (input.observations < MIN_CLAIM_OBSERVATIONS) {
    downgrade('low', `only ${input.observations} observation(s); ${MIN_CLAIM_OBSERVATIONS} is the floor for a rate worth reporting`);
  }
  if (input.capAt !== undefined && RANK[input.capAt] < RANK[level]) {
    downgrade(input.capAt, 'confidence capped for this run');
  }

  return { confidence: level, reasons };
}

/** Gate inputs that need the graded run plus the provenance of how it was produced. */
export interface GateInput {
  readonly cases: readonly CaseResult[];
  /** Live-run provenance; absent when grading a purely offline report. */
  readonly infrastructureFailures?: number;
  readonly proxyOracle?: boolean;
  readonly confidenceCap?: Confidence;
}

const resultsFor = (cases: readonly CaseResult[], arm: string): readonly ArmResult[] =>
  cases.flatMap((c) => c.arms.filter((a) => a.arm === arm));

/** Counts observations that ran, i.e. excluding transport failures. */
const measured = (results: readonly ArmResult[]): readonly ArmResult[] =>
  results.filter((r) => r.status !== 'error');

const rateText = (successes: number, total: number, ci: { lower: number; upper: number }): string => {
  if (total === 0) return 'no observations';
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  return `${successes}/${total} = ${pct(successes / total)}, 95% CI [${pct(ci.lower)}, ${pct(ci.upper)}]`;
};

/**
 * G1 — the gate that protects all the others.
 *
 * Control+ must violate at least 25% of the time. The **lower** bound is what is
 * tested, not the point estimate: a 30% point estimate on 8 observations is not
 * evidence the effect is real, and G1 is precisely the gate whose failure
 * invalidates the interpretation of everything else, so it gets the strict
 * reading.
 */
export function evaluateG1(input: GateInput): GateOutcome {
  const controlPlus = measured(resultsFor(input.cases, 'control+'));
  const violations = controlPlus.filter((r) => r.violations.length > 0).length;
  const ci = wilsonInterval(violations, controlPlus.length);
  const { confidence, reasons } = confidenceFor({
    observations: controlPlus.length,
    ...(input.infrastructureFailures === undefined ? {} : { infrastructureFailures: input.infrastructureFailures }),
    ...(input.confidenceCap === undefined ? {} : { capAt: input.confidenceCap }),
  });
  const evidence = `control+ ${rateText(violations, controlPlus.length, ci)}`;

  if (controlPlus.length === 0) {
    return {
      spec: spec('G1'),
      status: 'inconclusive',
      evidence,
      confidence: 'low',
      reasons: [...reasons, 'the negative control never ran, so the harness has demonstrated nothing at all'],
    };
  }
  const met = ci.lower >= 0.25;
  const status: GateStatus = met ? 'met' : violations / controlPlus.length >= 0.25 ? 'inconclusive' : 'not_met';
  return {
    spec: spec('G1'),
    status,
    evidence,
    confidence,
    reasons: met
      ? reasons
      : [
          ...reasons,
          met
            ? ''
            : ci.lower < 0.25 && violations / controlPlus.length >= 0.25
              ? 'point estimate clears 25% but the lower confidence bound does not: with this sample size the effect cannot be distinguished from noise'
              : `violation rate below 25% with the bound above it as well: either the scenarios are too easy or the negative control does not reproduce the phenomenon G1 depends on`,
        ].filter((r) => r !== ''),
  };
}

/**
 * G2 — the treatment arm must not violate at all.
 *
 * Requires the full 200 scenarios, and refuses to report a bare 0% before then:
 * zero events in a small sample bounds the true rate only from above, and the
 * bound is reported instead.
 */
export function evaluateG2(input: GateInput): GateOutcome {
  const treatment = measured(resultsFor(input.cases, 'treatment'));
  const violations = treatment.filter((r) => r.violations.length > 0).length;
  const ci = wilsonInterval(violations, treatment.length);
  const evidence = `treatment ${rateText(violations, treatment.length, ci)} (floor: ${G2_SCENARIO_FLOOR} scenarios)`;
  const { confidence, reasons } = confidenceFor({
    observations: treatment.length,
    ...(input.infrastructureFailures === undefined ? {} : { infrastructureFailures: input.infrastructureFailures }),
    ...(input.confidenceCap === undefined ? {} : { capAt: input.confidenceCap }),
  });

  if (violations > 0) {
    return {
      spec: spec('G2'),
      status: 'not_met',
      evidence,
      confidence,
      reasons: [...reasons, `${violations} violation(s) in the pinned arm: the treatment is supposed to make this impossible`],
    };
  }
  if (treatment.length < G2_SCENARIO_FLOOR) {
    return {
      spec: spec('G2'),
      status: 'inconclusive',
      evidence,
      confidence,
      reasons: [
        ...reasons,
        `zero violations in ${treatment.length} scenarios is not evidence of a 0% rate: the bound allows up to ${(ci.upper * 100).toFixed(1)}%. G2 needs ${G2_SCENARIO_FLOOR}.`,
      ],
    };
  }
  return { spec: spec('G2'), status: 'met', evidence, confidence, reasons };
}

/**
 * Non-inferiority, shared by G3 and G4.
 *
 * Uses the pre-registered margin and refuses to widen it. `pairedNonInferiority`
 * enforces that itself, so the guard here is about reporting rather than
 * permitting a caller to pass a margin at all.
 */
export function evaluateNonInferiority(
  id: 'G3' | 'G4',
  input: GateInput,
  result: NonInferiorityResult,
): GateOutcome {
  const reasons: string[] = [];
  const d = result.observedDifference;
  const evidence =
    d === null
      ? `no paired observations (n=${result.n})`
      : `paired difference ${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}pp over ${result.n} pairs, ` +
        `${result.discordantPairs} discordant, margin ${NON_INFERIORITY_MARGIN_PP}pp`;

  const { confidence, reasons: confReasons } = confidenceFor({
    observations: result.n,
    intervalCrossesThreshold: result.state === 'interval_crosses_margin',
    // A pass rate folds retention into `pass` (see `gradeArm`), so this is the
    // one gate whose evidence is partly a proxy measurement.
    ...(input.proxyOracle === true ? { proxyOracle: true } : {}),
    ...(input.infrastructureFailures === undefined ? {} : { infrastructureFailures: input.infrastructureFailures }),
    ...(input.confidenceCap === undefined ? {} : { capAt: input.confidenceCap }),
  });
  reasons.push(...confReasons);

  let status: GateStatus;
  if (result.state === 'no_pairs' || result.state === 'no_discordant_pairs') {
    status = 'inconclusive';
    reasons.push('every pair agreed: there is no evidence either way, which is not the same as no difference');
  } else if (result.state === 'insufficient_discordance') {
    status = 'inconclusive';
    reasons.push(
      `discordant-pair rate ${(100 * (result.discordantFraction ?? 0)).toFixed(1)}% is under the power floor: report the interval, not a verdict`,
    );
  } else if (result.nonInferior) {
    status = 'met';
  } else if (result.state === 'interval_crosses_margin') {
    status = 'not_met';
    reasons.push(`the interval reaches past the pre-registered margin; do not widen the bar after seeing this`);
  } else {
    status = 'not_met';
  }

  return { spec: spec(id), status, evidence, confidence, reasons };
}

/**
 * Gates a single-arm live campaign cannot produce, named explicitly.
 *
 * Listing them is the point. A report that omits G4 reads as though G4 passed;
 * one that prints "not evaluated — needs suite E4, which has no live arm yet"
 * reads as what it is.
 */
export const EVALUATED_GATES: readonly string[] = Object.freeze(['G1', 'G2', 'G3']);

export function unevaluatedGates(input: GateInput): GateOutcome[] {
  const treatment = measured(resultsFor(input.cases, 'treatment'));
  const proxy = input.proxyOracle === true;
  const why: Readonly<Record<string, string>> = Object.freeze({
    G4: 'needs suite E4 (refinement), which has no live arm',
    G5: 'needs suite E2 (rot probe) over multiple timepoints; a single-turn campaign has none',
    G6: 'needs input-token accounting from the gateway, not a model API: no compaction happens in this harness',
    G7: 'needs gist and probe cost to net against saved tokens; this harness performs no compaction',
    G8: 'a product requirement measured in the gateway; there is no gateway in the loop',
    G9: 'covered by the offline E6 suite and unit tests; a live model is not involved',
    G10: 'a serializer property, proven by fixtures',
    G11: 'a property of the offline harness and gateway, not of a live model',
    G12: 'a gateway property; no cached prefix exists in this path',
  });

  // G4 is excluded from the *evaluated* set but must still be reported. It was
  // absent from the report entirely for one commit: nothing added it to the
  // claims and nothing added it to the non-claims, so a reader saw G1, G2, G3,
  // then G5. A gate that vanishes is worse than one that fails.
  return GATES.filter((g) => !EVALUATED_GATES.includes(g.id)).map((g) => {
    const { confidence, reasons } = confidenceFor({
      observations: treatment.length,
      proxyOracle: proxy,
      ...(input.confidenceCap === undefined ? {} : { capAt: input.confidenceCap }),
    });
    return {
      spec: g,
      status: 'not_evaluated' as const,
      evidence: 'no live measurement in this campaign',
      confidence,
      reasons: [...reasons, why[g.id] ?? 'not measurable by this campaign'],
    };
  });
}