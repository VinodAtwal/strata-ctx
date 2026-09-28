/**
 * F1-1: the eval harness skeleton.
 *
 * The offline half of stream F. Everything in this package runs with no network
 * and no model call, which is what makes the eval suites safe to run on every
 * commit (docs/evaluation.md §6, layer 5). The live A/B runner (F2-1..F2-3) is
 * a separate task with separate credentials, and nothing here reaches for one.
 *
 * ## The one idea this package is built around
 *
 * > If the negative control does not reproduce the bug, our test suite is
 * > worthless. (docs/evaluation.md §1)
 *
 * So a negative control is not an annotation on a case, it is a property the
 * harness has to be able to *detect and report on separately* from a pass. A
 * report where "the negative control passed" and "the product passed" are the
 * same word is a report that cannot support the claim the whole project rests
 * on. Hence `negativeControl` on every case, `negativeControls` on every report,
 * and a dedicated marker in the rendered text.
 *
 * ## Why arms are interleaved (docs/evaluation.md §3, "Order")
 *
 * Every case runs its arms back to back, in a seeded per-case order, rather
 * than running every `control` first and every `treatment` afterwards. The
 * reason is time. A provider that degrades at 03:00, a machine that gets busy,
 * a cache that goes cold after the first hundred cases: any of these is a
 * function of *when* a request was made. Grouping arms by arm lines those up
 * perfectly with the arm variable, and a drift in the last arm looks exactly
 * like an arm effect. Interleaving makes position independent of arm, so drift
 * lands on all arms and partially cancels.
 *
 * The order is seeded rather than `Math.random()` because a report is a
 * committed artifact (G11, determinism): the same fixture and the same seed
 * must produce the same interleaving on every machine, forever, or the text
 * diff between two runs is noise.
 */

/** The arms a case is run against. docs/evaluation.md §2. */
export const ARMS = ['control', 'control+', 'treatment'] as const;
export type Arm = (typeof ARMS)[number];

/**
 * The arm that reproduces the known failure. Named separately from `'control'`
 * because in this harness `'control'` means "the uncompressed baseline we must
 * not lose to", and conflating the two is how a result gets read backwards.
 */
export const NEGATIVE_CONTROL_ARM: Arm = 'control+';

/** The eval suites of docs/evaluation.md Part 2. */
export const SUITE_IDS = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6'] as const;
export type SuiteId = (typeof SUITE_IDS)[number];

export const HARNESS_NAME = 'strata-ctx-eval';
export const HARNESS_VERSION = '0.1.0';

/**
 * A constraint the harness expects to survive a run, plus the concrete marker
 * whose presence in an arm's output means the constraint was violated.
 *
 * `forbidden` is what makes E1 grading deterministic: the paper's methodology,
 * adopted exactly -- a violation is the prohibited *effect* appearing in a tool
 * call, not a judgement about prose. A constraint with an empty `forbidden`
 * list can still be checked for *retention* (did the arm drop it?) but cannot
 * be checked for *violation*, and the harness reports that distinction rather
 * than pretending the two are the same measurement.
 */
export interface EvalConstraint {
  readonly id: string;
  readonly text: string;
  /** Stratum, shared with the governance canary (D-6). Drives E1 reporting. */
  readonly kind: ConstraintKindName;
  /** Literal effects that mean "this constraint was violated". May be empty. */
  readonly forbidden: readonly string[];
}

/** Mirrors `ConstraintKind` in `@strata-ctx/core-types`, frozen at 1.0.0. */
export const CONSTRAINT_KINDS = [
  'hard_safety',
  'soft_policy',
  'user_preference',
  'project_rule',
] as const;
export type ConstraintKindName = (typeof CONSTRAINT_KINDS)[number];

/** One scenario: the same task instance run against each of its arms. */
export interface EvalCase {
  readonly id: string;
  readonly title: string;
  /** The arms this case runs. Usually all three; a case may run a subset. */
  readonly arms: readonly Arm[];
  readonly negativeControl: boolean;
  readonly prompt: string;
  readonly constraints: readonly EvalConstraint[];
  readonly notes: string | undefined;
}

/** A whole suite file, after validation. Frozen: a harness that hands out a
 *  mutable fixture is a harness whose "determinism" is a claim about a copy. */
export interface EvalFixture {
  readonly formatVersion: number;
  readonly suite: SuiteId;
  readonly name: string;
  readonly description: string | undefined;
  readonly cases: readonly EvalCase[];
}

/** What an arm produced for one case. Raw observation: no grading applied. */
export interface ArmObservation {
  readonly arm: Arm;
  /** Interleaved execution position within the run, 0-based. */
  readonly position: number;
  readonly caseId: string;
  /** False when the arm could not produce an answer at all (infrastructure). */
  readonly ok: boolean;
  readonly error: string | null;
  /** The arm's output. Kept verbatim so a failure can be diffed. */
  readonly response: string;
  readonly retainedConstraintIds: readonly string[];
  readonly droppedConstraintIds: readonly string[];
  readonly violatedConstraintIds: readonly string[];
  /** Synthetic cost, in tokens. Not a measurement of a provider. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Synthetic latency, in milliseconds. Not a measurement of a provider. */
  readonly latencyMs: number;
}

/**
 * Everything the harness is handed for one (case, arm) pair.
 *
 * Deliberately the *whole* case rather than a prompt string: F2-1's live arms
 * need the constraints and the position to record provenance, and a narrower
 * signature would have to be widened later.
 */
export interface ArmInvocation {
  readonly harnessSeed: number;
  readonly suite: SuiteId;
  readonly case: EvalCase;
  readonly arm: Arm;
  /** Interleaved position within the run. */
  readonly position: number;
  /** Always 1 offline. F2-1 retries *infrastructure* failures only. */
  readonly attempt: number;
}

/** An arm that answers immediately, with no promise to await. The mock's shape. */
export type SyncArmRunner = (invocation: ArmInvocation) => ArmObservation;

/**
 * An arm implementation, sync or async.
 *
 * Sync here, but `runSuite` awaits it: F2-1's live arms are network calls, and
 * a runner that cannot await its arms would have to be rewritten to add them.
 */
export type ArmRunner =
  | SyncArmRunner
  | ((invocation: ArmInvocation) => Promise<ArmObservation>);

export type ArmStatus = 'pass' | 'fail' | 'error';

/** A constraint's prohibited effect, actually observed. */
export interface ConstraintViolation {
  readonly constraintId: string;
  readonly kind: ConstraintKindName;
  /** The literal marker that was found. */
  readonly marker: string;
}

/** One arm's result for one case, after the harness's own retention check. */
export interface ArmResult {
  readonly arm: Arm;
  readonly position: number;
  readonly status: ArmStatus;
  readonly retainedConstraintIds: readonly string[];
  readonly droppedConstraintIds: readonly string[];
  readonly violations: readonly ConstraintViolation[];
  readonly response: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly error: string | null;
}

export interface CaseResult {
  readonly caseId: string;
  readonly title: string;
  readonly negativeControl: boolean;
  readonly constraintCount: number;
  readonly arms: readonly ArmResult[];
  /** True when every arm this case declares returned `status: 'pass'`. */
  readonly satisfied: boolean;
}

/** One (case, arm) pair in the order it actually ran. The audit trail for
 *  "did the arms really interleave, or did we just say so in a comment". */
export interface ExecutionStep {
  readonly position: number;
  readonly caseId: string;
  readonly arm: Arm;
}

export interface ArmTotals {
  readonly arm: Arm;
  readonly observations: number;
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  /** Observations with at least one violation. */
  readonly violations: number;
  /** violations / observations, or null when there were none to divide. G1 is
   *  a rate; reporting 0% for an arm that never ran would be a false green. */
  readonly violationRate: number | null;
  /** Observations where a declared constraint was dropped. */
  readonly retentionFailures: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ReportTotals {
  readonly cases: number;
  readonly observations: number;
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  readonly negativeControls: number;
  readonly negativeControlsFired: number;
  readonly byArm: readonly ArmTotals[];
}

/**
 * One negative-control case, reported on its own terms.
 *
 * `fired` means the case behaved as the negative control requires -- at least
 * one arm lost a constraint or produced a violation. A negative control that
 * did *not* fire is the finding, and it is reported as prominently as a
 * treatment-arm failure, because it invalidates every other number here.
 */
export interface NegativeControlSummary {
  readonly caseId: string;
  readonly title: string;
  readonly fired: boolean;
  readonly failingArms: readonly Arm[];
}

export type ClaimStatus = 'observed' | 'not_observed' | 'inconclusive';

export interface Claim {
  readonly id: string;
  readonly statement: string;
  readonly status: ClaimStatus;
  readonly detail: string;
  /** True for claims a failed gate blocks a release on (G1). */
  readonly blocking: boolean;
}

/**
 * The whole result of one suite run.
 *
 * Contains no timestamp and nothing read from the clock: the report is meant to
 * be committed and diffed, and a wall-clock field is a diff on every run. F2-2
 * adds campaign metadata behind an explicit option.
 */
export interface RunReport {
  readonly harness: { readonly name: string; readonly version: string };
  readonly suite: SuiteId;
  readonly suiteName: string;
  readonly formatVersion: number;
  readonly seed: number;
  /** Always true in this package. A live run sets it false (F2-1). */
  readonly offline: true;
  readonly executionOrder: readonly ExecutionStep[];
  readonly cases: readonly CaseResult[];
  readonly negativeControls: readonly NegativeControlSummary[];
  readonly totals: ReportTotals;
  readonly claims: readonly Claim[];
}
