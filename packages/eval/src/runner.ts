import {
  ARMS,
  HARNESS_NAME,
  HARNESS_VERSION,
  type Arm,
  type ArmInvocation,
  type ArmObservation,
  type ArmResult,
  type ArmRunner,
  type ArmStatus,
  type ArmTotals,
  type CaseResult,
  type Claim,
  type ConstraintViolation,
  type EvalCase,
  type EvalFixture,
  type ExecutionStep,
  type NegativeControlSummary,
  type RunReport,
} from './types.js';
import { createMockArmRunner, unitValue } from './mock-arm.js';

/**
 * F1-1: the suite runner.
 *
 * Runs every case against every arm it declares, in an interleaved seeded
 * order, and produces one `RunReport`. It makes zero network calls and reads no
 * clock: `runSuite` is a pure function of `(fixture, seed, runner)`, so two
 * runs over the same inputs produce identical output. Everything downstream
 * (G11, and every diff between two committed reports) depends on that.
 *
 * ## Why arms interleave per case
 *
 * docs/evaluation.md §3 requires "interleaved, arm order randomized per task".
 * The reason is that *when* a run happens is not independent of how well it
 * does. A provider degrades at 03:00. A machine gets busy. A prompt cache goes
 * cold after the first hundred cases. Every one of those is a function of
 * position in the run. Run all the controls first and all the treatments last,
 * and position is perfectly collinear with arm: any drift reads as an arm
 * effect, and the harness will happily publish it as a result.
 *
 * Interleaving makes position uncorrelated with arm, so drift lands on all arms
 * and largely cancels. The order is seeded rather than `Math.random()` so the
 * report is reproducible; a report that differs run to run cannot be diffed,
 * and an un-diffable report is an unreadable one.
 *
 * Concretely: cases run in fixture order, and within each case the declared
 * arms are shuffled by a seed derived from `(seed, suite, case)`. So each case's
 * own order is stable across runs, different cases get different orders, and no
 * arm systematically occupies a fixed slot. The full realized order is recorded
 * in `RunReport.executionOrder` -- an interleaving claim that is only in a
 * comment is not a claim.
 */

export interface RunOptions {
  /**
   * Master seed for arm ordering. The same seed always yields the same
   * interleaving. Defaults to `DEFAULT_SEED`.
   */
  readonly seed?: number;
  /** Override the arm implementation. Defaults to the offline mock. */
  readonly runArm?: ArmRunner;
}

/**
 * Fixed, arbitrary, and documented. A named default means a report with no
 * explicit seed is still reproducible, which is the common case (someone runs
 * the suite, commits the output).
 */
export const DEFAULT_SEED = 0x5eed_1e55;

/** Fisher-Yates against a seeded comparator-free swap, so order is total. */
const shuffleSeeded = <T>(items: readonly T[], seed: number, key: string): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(unitValue(seed, `${key}|swap|${i}`) * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
};

/**
 * The order this run will use: cases in fixture order, arms within a case in a
 * seeded shuffle.
 *
 * Exported so a test can assert the interleaving *without* running a suite --
 * the property under test is the ordering function, and testing it through
 * `runSuite` would only ever observe one sample of it.
 */
export function planExecutionOrder(fixture: EvalFixture, seed: number = DEFAULT_SEED): ExecutionStep[] {
  const steps: ExecutionStep[] = [];
  let position = 0;
  for (const evalCase of fixture.cases) {
    const ordered = shuffleSeeded(evalCase.arms, seed, `${fixture.suite}|${fixture.name}|${evalCase.id}`);
    for (const arm of ordered) {
      steps.push({ position, caseId: evalCase.id, arm });
      position += 1;
    }
  }
  return steps;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/**
 * Turn a raw observation into a graded result.
 *
 * Grading here is deliberately the smallest thing that can be called grading:
 * retained constraints compared against the declared set, and forbidden markers
 * found in the response. That is deterministic, arm-agnostic (the grader sees
 * only the observation, never the arm label -- docs/evaluation.md §3, "Blinding"),
 * and exactly the methodology F1-2 extends with tool-call graders and rubric
 * judges. It lives in the runner because a `CaseResult` with no status field is
 * not something a reporter can render.
 *
 * A dropped constraint fails the arm whether or not it also produced a
 * violation: retention is the mechanism, the violation is the symptom, and E1's
 * claim is about the mechanism.
 */
const gradeArm = (observation: ArmObservation, evalCase: EvalCase): ArmResult => {
  const expected = new Set(evalCase.constraints.map((c) => c.id));
  const observedRetained = new Set(observation.retainedConstraintIds);
  const missing = [...expected].filter((id) => !observedRetained.has(id)).sort();

  const violations: ConstraintViolation[] = [];
  for (const constraintId of [...observation.violatedConstraintIds].sort()) {
    const constraint = evalCase.constraints.find((c) => c.id === constraintId);
    if (constraint === undefined) continue;
    const marker = constraint.forbidden[0];
    if (marker === undefined) continue;
    violations.push({ constraintId, kind: constraint.kind, marker });
  }

  let status: ArmStatus;
  if (!observation.ok) status = 'error';
  else if (missing.length > 0 || violations.length > 0) status = 'fail';
  else status = 'pass';

  return {
    arm: observation.arm,
    position: observation.position,
    status,
    retainedConstraintIds: [...observation.retainedConstraintIds],
    droppedConstraintIds: missing,
    violations,
    response: observation.response,
    inputTokens: observation.inputTokens,
    outputTokens: observation.outputTokens,
    latencyMs: observation.latencyMs,
    error: observation.error,
  };
};

/** An observation for a failed invocation, so a suite never throws mid-run. */
const errorObservation = (invocation: ArmInvocation, message: string): ArmObservation => ({
  arm: invocation.arm,
  position: invocation.position,
  caseId: invocation.case.id,
  ok: false,
  error: message,
  response: '',
  retainedConstraintIds: [],
  droppedConstraintIds: [],
  violatedConstraintIds: [],
  inputTokens: 0,
  outputTokens: 0,
  latencyMs: 0,
});

/**
 * Run every case against every arm it declares, interleaved, and report.
 *
 * A throwing arm becomes an `error` result rather than an exception: one bad
 * arm should degrade one row of the report, not lose the other 199 cases. An
 * `error` is not a pass and not a fail, and the reporter says which it was --
 * "this arm did not run" and "this arm ran and got it wrong" are different
 * findings, and collapsing them is how a broken harness reports green.
 */
export async function runSuite(fixture: EvalFixture, options: RunOptions = {}): Promise<RunReport> {
  const seed = options.seed ?? DEFAULT_SEED;
  const runArm = options.runArm ?? createMockArmRunner();
  const order = planExecutionOrder(fixture, seed);
  const byCase = new Map<string, EvalCase>();
  for (const evalCase of fixture.cases) byCase.set(evalCase.id, evalCase);

  const results = new Map<string, ArmResult[]>();
  for (const step of order) {
    const evalCase = byCase.get(step.caseId);
    if (evalCase === undefined) continue;
    const invocation: ArmInvocation = {
      harnessSeed: seed,
      suite: fixture.suite,
      case: evalCase,
      arm: step.arm,
      position: step.position,
      attempt: 1,
    };
    let observation: ArmObservation;
    try {
      observation = await runArm(invocation);
    } catch (err) {
      observation = errorObservation(invocation, err instanceof Error ? err.message : String(err));
    }
    const bucket = results.get(step.caseId);
    const graded = gradeArm(observation, evalCase);
    if (bucket === undefined) results.set(step.caseId, [graded]);
    else bucket.push(graded);
  }

  const cases: CaseResult[] = fixture.cases.map((evalCase) => {
    const arms = [...(results.get(evalCase.id) ?? [])].sort((a, b) => a.position - b.position);
    return {
      caseId: evalCase.id,
      title: evalCase.title,
      negativeControl: evalCase.negativeControl,
      constraintCount: evalCase.constraints.length,
      arms,
      satisfied: arms.length > 0 && arms.every((a) => a.status === 'pass'),
    };
  });

  const allArms = cases.flatMap((c) => c.arms);
  const byArm: ArmTotals[] = ARMS.map((arm: Arm) => {
    const forArm = allArms.filter((a) => a.arm === arm);
    const violations = forArm.filter((a) => a.violations.length > 0).length;
    return {
      arm,
      observations: forArm.length,
      passed: forArm.filter((a) => a.status === 'pass').length,
      failed: forArm.filter((a) => a.status === 'fail').length,
      errored: forArm.filter((a) => a.status === 'error').length,
      violations,
      // null, not 0, when the arm never ran: a rate computed from no
      // observations is a rate that would clear G1 for an arm nobody tested.
      violationRate: forArm.length === 0 ? null : round4(violations / forArm.length),
      retentionFailures: forArm.filter((a) => a.droppedConstraintIds.length > 0).length,
      inputTokens: forArm.reduce((sum, a) => sum + a.inputTokens, 0),
      outputTokens: forArm.reduce((sum, a) => sum + a.outputTokens, 0),
    };
  });

  const negativeControls: NegativeControlSummary[] = cases
    .filter((c) => c.negativeControl)
    .map((c) => ({
      caseId: c.caseId,
      title: c.title,
      fired: c.arms.some((a) => a.status !== 'pass'),
      failingArms: c.arms.filter((a) => a.status !== 'pass').map((a) => a.arm),
    }));

  return {
    harness: { name: HARNESS_NAME, version: HARNESS_VERSION },
    suite: fixture.suite,
    suiteName: fixture.name,
    formatVersion: fixture.formatVersion,
    seed,
    offline: true,
    executionOrder: order,
    cases,
    negativeControls,
    totals: {
      cases: cases.length,
      observations: allArms.length,
      passed: allArms.filter((a) => a.status === 'pass').length,
      failed: allArms.filter((a) => a.status === 'fail').length,
      errored: allArms.filter((a) => a.status === 'error').length,
      negativeControls: negativeControls.length,
      negativeControlsFired: negativeControls.filter((n) => n.fired).length,
      byArm,
    },
    claims: buildClaims(fixture, byArm, negativeControls),
  };
}

/**
 * F1-1 claims. These are *observations from this offline run*, not the campaign's
 * claims -- nothing here is a statistical statement, because statistics are
 * F1-3 and an ad-hoc significance claim computed early would be quoted later as
 * if it were the real thing.
 *
 * What F1-1 can honestly assert is structural: the negative control fired (or
 * did not), and which arms retained what. A negative control that did not fire
 * is flagged `not_observed` and blocking, because it invalidates the other
 * numbers rather than merely adding to them.
 */
function buildClaims(
  fixture: EvalFixture,
  byArm: readonly ArmTotals[],
  negativeControls: readonly NegativeControlSummary[],
): RunReport['claims'] {
  const claims: Claim[] = [];

  if (negativeControls.length === 0) {
    claims.push({
      id: 'negative-control-present',
      statement: 'Suite declares at least one negative control',
      status: 'not_observed',
      detail:
        'no case is marked negativeControl, so nothing in this run proves the harness can detect ' +
        'the failure it is supposed to detect; every other number here is uninterpretable',
      blocking: true,
    });
  } else {
    const fired = negativeControls.filter((n) => n.fired).length;
    claims.push({
      id: 'negative-control-fires',
      statement: 'Negative control reproduces the failure it is meant to reproduce',
      status: fired === negativeControls.length ? 'observed' : fired === 0 ? 'not_observed' : 'inconclusive',
      detail:
        fired === negativeControls.length
          ? `all ${fired} negative control(s) fired`
          : `${fired} of ${negativeControls.length} negative control(s) fired: ` +
            negativeControls
              .filter((n) => !n.fired)
              .map((n) => n.caseId)
              .join(', '),
      blocking: true,
    });
  }

  for (const totals of byArm) {
    claims.push({
      id: `retention-${totals.arm}`,
      statement: `Arm "${totals.arm}" retained every declared constraint`,
      status:
        totals.observations === 0
          ? 'inconclusive'
          : totals.retentionFailures === 0
            ? 'observed'
            : 'not_observed',
      detail:
        totals.observations === 0
          ? 'arm did not run in this suite'
          : `${totals.retentionFailures} of ${totals.observations} observation(s) lost a constraint`,
      blocking: false,
    });
  }

  claims.push({
    id: 'offline',
    statement: 'Run is offline: no network call, no model call',
    status: 'observed',
    detail: `fixture "${fixture.name}" (suite ${fixture.suite}) replayed through the deterministic mock arm`,
    blocking: false,
  });

  return claims;
}
