import type { PinnedConstraint, ProbeId, TelemetryEvent } from '@strata-ctx/core-types';
import { probeId as makeProbeId } from '@strata-ctx/core-types';

import {
  runConstraintProbe,
  selectProbeConstraints,
  type ConstraintProbeResult,
  type ConstraintProbeSubject,
} from './constraint-probe.js';
import {
  observationOf,
  runRotProbe,
  rotTierAccuracy,
  rotTierForFill,
  type RotObservation,
  type RotProbeCase,
  type RotProbeResult,
  type RotProbeSubject,
  type RotSlopeFit,
} from './rot-probe.js';
import { rotDegradationSlope } from './rot-probe.js';

/**
 * F1-11 — the canary scheduler.
 *
 * ## The config it implements
 *
 * docs/integrations.md §8, verbatim:
 *
 * ```yaml
 * canary:
 *   constraint_probe: { enabled: true, interval_turns: 25 }
 *   rot_probe: { enabled: true, interval_turns: 50 }
 *   include_soft_org_policies: true   # decay is 8.3x worse here; hard norms give a false green
 * ```
 *
 * Three decisions in those five lines, and this module exists to make all three
 * real rather than parsed:
 *
 * 1. **Cadence in turns, not time.** The probes measure degradation that accrues
 *    per compaction, and compaction is what turns are. A time-based probe fires a
 *    variable number of times for a variable number of compactions, so its score
 *    is not comparable between two runs of the same workload.
 * 2. **Turn 0 is not a probe turn.** See `isProbeTurn`.
 * 3. **`include_soft_org_policies` is load-bearing**, and the failure it prevents
 *    is silent. See `./constraint-probe.js`.
 *
 * ## Fail-open, and why it is not a `catch` with an empty body
 *
 * A canary runs inside somebody's turn. A probe that throws must cost a telemetry
 * line and nothing else — never the user's request, never the loop that schedules
 * the next probe. That is why every probe call here is wrapped, why the wrapper
 * emits a `canary_fail` violation rather than swallowing the error silently, and
 * why `runTurn` returns a result instead of rejecting: a caller in the gateway
 * has to be able to await it without a `try` of its own, or the first engineer to
 * wire it up forgets.
 *
 * The same reasoning makes `blocked` permanently `false` on every violation this
 * module emits. Governance's `pin_post_compact_missing` blocks the request; a
 * canary miss is a *measurement*, and blocking on a measurement converts an
 * observability signal into an outage.
 *
 * ## The subject is injected, and that is the design
 *
 * The scheduler decides *when* to fire and *records* what came back. Nothing here
 * knows what a model is, what a gateway is, or what a transcript looks like —
 * `CanarySubjects` is two functions. That is what lets the offline tests drive the
 * whole scheduler deterministically, and F2 drive the identical code path against
 * a real provider, with nothing in `src/` able to tell the difference.
 *
 * ## Time is injected too
 *
 * There is no `Date.now()` anywhere in this file, and no `Math.random()`. Turn
 * numbers and probe ids are pure functions of the turn, so replaying a
 * conversation reproduces the probe schedule byte for byte (N6: same input ⇒
 * byte-identical output) and a failing probe can be replayed from the turn number
 * alone.
 */

// --------------------------------------------------------------------- config

/**
 * The three violation names docs/architecture.md §8 lists under `violations`.
 *
 * Mirrored as a literal rather than read off the frozen `TelemetryEvent` union,
 * because a union's members cannot be enumerated at runtime and a dashboard that
 * has to hardcode this list anyway should be asserting against something. The
 * names are byte-identical to `packages/governance/src/violations.ts`'s
 * `FROZEN_VIOLATION_KINDS`, which is the other copy; both were transcribed from
 * `core-types/src/telemetry.ts` at digest `0a3c0fea6360e6d9`.
 *
 * **This module emits only `canary_fail`.** The other two are pin-integrity
 * findings and belong to `governance`: a canary cannot observe a pin that is
 * missing before the pin stage ran, and a probe that claimed to would be
 * reporting a stage's result as its own.
 */
export const CANARY_VIOLATION_KINDS = Object.freeze([
  'pin_missing_pre_apply',
  'pin_post_compact_missing',
  'canary_fail',
] as const);

export type CanaryViolationKind = (typeof CANARY_VIOLATION_KINDS)[number];

/** The one kind this package can observe. */
export const CANARY_EMITTED_VIOLATION_KIND: CanaryViolationKind = 'canary_fail';

export interface CanaryProbeConfig {
  readonly enabled: boolean;
  /** Probe every N turns. Positive integer; validated by `assertCanaryConfig`. */
  readonly intervalTurns: number;
}

/**
 * docs/integrations.md §8, `canary:` block, as a type.
 *
 * Field names are camelCase where the YAML is snake_case, matching how the rest
 * of the repo bridges the two (`redaction.onDetect` for `on_detect`). The mapping
 * lives here, once, rather than at each of the four call sites that read it.
 */
export interface CanaryConfig {
  readonly constraintProbe: CanaryProbeConfig;
  readonly rotProbe: CanaryProbeConfig;
  readonly includeSoftOrgPolicies: boolean;
}

/** The §8 defaults: 25-turn constraint cadence, 50-turn rot cadence, soft policies in. */
export const DEFAULT_CANARY_CONFIG: CanaryConfig = Object.freeze({
  constraintProbe: Object.freeze({ enabled: true, intervalTurns: 25 }),
  rotProbe: Object.freeze({ enabled: true, intervalTurns: 50 }),
  includeSoftOrgPolicies: true,
});

export class CanaryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanaryConfigError';
  }
}

/**
 * Reject a config that would silently never probe.
 *
 * `enabled: true` with `intervalTurns: 0` is the shape of a typo that produces a
 * dashboard reading zero probes, zero violations, and a fully green release gate
 * — the "0% violations from a pipeline that stopped recording" failure
 * `packages/telemetry/src/sink.ts` is built to prevent, reached by a different
 * road. Also rejects a non-integer interval, because `turn % 2.5` is 0.5 for half
 * the turns and no turn ever after that.
 */
export function assertCanaryConfig(config: CanaryConfig): CanaryConfig {
  const check = (name: string, probe: CanaryProbeConfig): void => {
    if (!Number.isInteger(probe.intervalTurns) || probe.intervalTurns <= 0) {
      throw new CanaryConfigError(
        `canary.${name}.interval_turns must be a positive integer; got ${String(probe.intervalTurns)}. ` +
          'A probe that can never fire reports zero violations, which reads as a clean run.',
      );
    }
  };
  check('constraint_probe', config.constraintProbe);
  check('rot_probe', config.rotProbe);
  return config;
}

// -------------------------------------------------------------------- cadence

/**
 * Whether a probe fires on this turn.
 *
 * `turn % interval === 0` **and `turn > 0`**. The second clause is the whole
 * reason this is a function and not an expression at the call site: turn 0 is the
 * first request of a session, before any compaction has run, so a probe there
 * measures a context that cannot have decayed. It would report a perfect score,
 * it would cost a model call, and — worst — it would be the sample that makes the
 * session's *first* reported retention number the one nobody should trust.
 */
export function isProbeTurn(turn: number, intervalTurns: number): boolean {
  if (!Number.isInteger(turn) || turn < 0) {
    throw new CanaryConfigError(`turn must be a non-negative integer; got ${String(turn)}`);
  }
  if (!Number.isInteger(intervalTurns) || intervalTurns <= 0) {
    throw new CanaryConfigError(`intervalTurns must be a positive integer; got ${String(intervalTurns)}`);
  }
  return turn > 0 && turn % intervalTurns === 0;
}

/**
 * The next turn on which a probe fires, strictly after `turn`.
 *
 * Exported because an operator asking "when does the next probe run?" should be
 * answerable without running a session, and because a scheduler that can be asked
 * that question is a scheduler whose cadence can be tested.
 */
export function nextProbeTurn(turn: number, intervalTurns: number): number {
  const multiples = Math.floor(turn / intervalTurns) + 1;
  return multiples * intervalTurns;
}

/**
 * The probe id for one firing.
 *
 * A pure function of kind and turn, so a violation logged three turns from now is
 * traceable to the turn that caused it with no clock and no counter. The `@turn`
 * suffix is the same convention `packages/governance/src/canary.ts` uses for its
 * marker ids.
 */
export function canaryProbeId(kind: 'constraint' | 'rot', turn: number): ProbeId {
  return makeProbeId(`canary.${kind}@${turn}`);
}

// ------------------------------------------------------------------ telemetry

/**
 * PROPOSED CONTRACT ADDITION (additive; see the module header).
 *
 * docs/architecture.md §8:
 *
 * ```
 * rot_canary       { score, at_frac_of_window }
 * ```
 *
 * The frozen `TelemetryEvent` union has a `canary` member (`probeId`, `kind`,
 * `arm`, `score`, `passed`) but nothing carrying *where in the window* the score
 * was taken, and that position is the measurement: a rot score is meaningless
 * without the fill it was taken at, which is the whole reason §E2 fits a curve
 * rather than reporting a number.
 *
 * Field names are camelCase where §8 writes snake_case (`at_frac_of_window` →
 * `atFracOfWindow`), matching the bridge the frozen contract already uses:
 * §8's `breakeven_ok` is `breakevenOk` in `core-types/src/telemetry.ts`, and §8's
 * `schema_valid` is `schemaValid` in the telemetry package's proposed `GistEvent`.
 * The doc spelling is preserved in the comment above so the two can be diffed.
 *
 * TODO(contract owner): this belongs in `core-types` alongside `TelemetryEvent`.
 * Until it does, a consumer reading `rot_canary` off the JSONL sink is depending on
 * a package that is not the contract, which is the drift the freeze exists to stop.
 */
export interface RotCanaryEvent {
  readonly type: 'rot_canary';
  readonly runId: string;
  /** Rot-case accuracy for this firing, or 0 when nothing was scorable. */
  readonly score: number;
  /** `at_frac_of_window`: the session's fill at the moment of the probe. */
  readonly atFracOfWindow: number;
  readonly probeId: ProbeId;
  readonly turn: number;
  /** The tier this fill was classified into; the point on the §E2 x-axis. */
  readonly tier: string;
}

/** The frozen union plus the §8 addition above. */
export type CanaryTelemetryEvent = TelemetryEvent | RotCanaryEvent;

/**
 * A canary violation, with the one field the frozen event has no room for.
 *
 * `detail` carries **only** values this module generated: constraint ids, counts,
 * probe ids, error *messages* from our own subjects. Model output and constraint
 * text are never interpolated — a violation log is attacker-reachable text, and
 * `packages/governance/src/violations.ts` is where that sanitiser lives and where
 * P1 stops this package from importing it. The length cap below is the part that
 * matters here: an id from an untrusted policy file must not be able to write a
 * 4 MB log line.
 */
export interface CanaryViolation {
  readonly kind: CanaryViolationKind;
  readonly runId: string;
  readonly turn: number;
  /** Constraint ids, never constraint text. */
  readonly constraintIds: readonly string[];
  readonly detail: string;
  /**
   * Always false. A canary measures; it does not gate.
   *
   * Latched rather than merely defaulted so the field cannot be set true by a
   * future caller: blocking on a probe miss converts an observability signal into
   * an outage, and the only safe time to decide that is before someone needs it.
   */
  readonly blocked: false;
}

const MAX_DETAIL = 200;

const clipDetail = (detail: string): string =>
  detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL)}...` : detail;

export function canaryViolation(input: Omit<CanaryViolation, 'blocked'>): CanaryViolation {
  return Object.freeze({
    kind: input.kind,
    runId: input.runId,
    turn: input.turn,
    constraintIds: Object.freeze([...input.constraintIds]),
    detail: clipDetail(input.detail),
    blocked: false,
  });
}

/** Projects onto the frozen `violation` event, which is what the sink serialises. */
export function canaryViolationEvent(violation: CanaryViolation): TelemetryEvent {
  return {
    type: 'violation',
    runId: violation.runId,
    kind: violation.kind,
    constraintIds: violation.constraintIds,
    blocked: violation.blocked,
  };
}

/**
 * The frozen `canary` event for a scored probe.
 *
 * `arm: 'treatment'` always. A runtime canary has no control arm: measuring the
 * control means sending the user's turn a second time, uncompressed, to a
 * provider that charges for both. The arms belong to the offline harness
 * (`packages/eval`, docs/evaluation.md §2), and a runtime probe that reported
 * itself as a control would be claiming an experiment it did not run.
 */
function canaryEvent(
  probeId: ProbeId,
  kind: 'constraint' | 'rot',
  score: number,
  passed: boolean,
): TelemetryEvent {
  return { type: 'canary', probeId, kind, arm: 'treatment', score, passed };
}

/**
 * Build the §8 `rot_canary` record.
 *
 * `score` is `0` for a firing that scored nothing, because the frozen
 * `TelemetryEvent` schema requires a finite number and has no null. The rotation
 * is deliberate and is why `runTurn` emits a `canary_fail` violation alongside it:
 * a `rot_canary { score: 0 }` on its own reads as total rot, which is the
 * flattering direction for a *missed measurement*.
 */
function rotCanaryEvent(runId: string, result: RotProbeResult): RotCanaryEvent {
  return {
    type: 'rot_canary',
    runId,
    score: result.score ?? 0,
    atFracOfWindow: result.fill,
    probeId: result.probeId,
    turn: result.turn,
    tier: result.tier,
  };
}

// --------------------------------------------------------------------- subject

/**
 * The two things that answer probes, injected.
 *
 * Either may be absent, and either may throw. Absent means "not wired up", which
 * `runTurn` reports as a `canary_fail` on a probe turn rather than skipping
 * silently — a scheduler whose subject was never provided should look broken, and
 * it will, in the one place anyone looks.
 */
export interface CanarySubjects {
  readonly constraint?: ConstraintProbeSubject;
  readonly rot?: RotProbeSubject;
}

/** What the scheduler needs to know about the turn it is scheduling. */
export interface CanaryTurnInput {
  /** Monotonic within a run. Turn 0 is the session's first request. */
  readonly turn: number;
  /**
   * The session's current input-token estimate.
   *
   * Injected rather than measured here because this package does not own a
   * tokenizer, and a probe that estimated the context itself would be measuring
   * its own arithmetic — the same reason the F1-6 suite counts tokens rather than
   * asking the subject for a number.
   */
  readonly tokenEstimate: number;
}

/** One successful constraint firing. */
export interface ConstraintProbeRecord {
  readonly kind: 'constraint';
  readonly result: ConstraintProbeResult;
}

/** One successful rot firing. */
export interface RotProbeRecord {
  readonly kind: 'rot';
  readonly result: RotProbeResult;
}

/** One probe firing, successful or not. */
export type CanaryProbeRecord = ConstraintProbeRecord | RotProbeRecord;

/** A probe that threw. Recorded rather than rethrown; see the module header. */
export interface CanaryProbeFailure {
  readonly kind: 'constraint' | 'rot';
  readonly probeId: ProbeId;
  readonly turn: number;
  readonly message: string;
}

export interface CanaryTurnResult {
  readonly turn: number;
  /** Probes that returned a result, in a fixed order: constraint, then rot. */
  readonly probes: readonly CanaryProbeRecord[];
  /** Probes that threw. Present in `violations` as `canary_fail` too. */
  readonly failures: readonly CanaryProbeFailure[];
  /** Everything this turn emitted, in emission order. */
  readonly events: readonly CanaryTelemetryEvent[];
  readonly violations: readonly CanaryViolation[];
  /** Whether anything fired at all. A turn that probed nothing emits nothing. */
  readonly probed: boolean;
}

export interface CanarySchedulerOptions {
  readonly subjects: CanarySubjects;
  /** Policy's pinned constraints. The constraint probe draws its suite from here. */
  readonly constraints: readonly PinnedConstraint[];
  /**
   * The session window, from `BudgetPolicy.contextLimit`.
   *
   * Required rather than defaulted: `DEFAULT_CANARY_WINDOW_TOKENS` would be a
   * mirror of a value this package may change, and every tier on the rot curve is
   * a fraction of it, so a stale default would put every observation on the wrong
   * x-axis with nothing failing.
   */
  readonly windowTokens: number;
  readonly config?: CanaryConfig;
  readonly rotCases?: readonly RotProbeCase[];
  /** Attribution for emitted events. */
  readonly runId?: string;
  /** Called once per event. Throwing here fails open, like a throwing subject. */
  readonly emit?: (event: CanaryTelemetryEvent) => void;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The scheduler.
 *
 * Holds the probe history so the *shape* can be read after the fact — the
 * endpoint of a single firing is not the finding, and a package that only exposed
 * per-turn scores would be reproducing the mistake docs/evaluation.md §E2 names.
 */
export class CanaryScheduler {
  readonly #config: CanaryConfig;
  readonly #subjects: CanarySubjects;
  readonly #constraints: readonly PinnedConstraint[];
  readonly #windowTokens: number;
  readonly #rotCases: readonly RotProbeCase[];
  readonly #runId: string;
  readonly #emit: (event: CanaryTelemetryEvent) => void;
  readonly #records: CanaryProbeRecord[] = [];
  readonly #failures: CanaryProbeFailure[] = [];
  readonly #violations: CanaryViolation[] = [];
  readonly #events: CanaryTelemetryEvent[] = [];

  constructor(options: CanarySchedulerOptions) {
    this.#config = assertCanaryConfig(options.config ?? DEFAULT_CANARY_CONFIG);
    this.#subjects = options.subjects;
    this.#constraints = Object.freeze([...options.constraints]);
    if (!Number.isInteger(options.windowTokens) || options.windowTokens <= 0) {
      throw new CanaryConfigError(
        `windowTokens must be a positive integer; got ${String(options.windowTokens)}. ` +
          'Every rot tier is a fraction of the window, so a wrong one mis-places every observation.',
      );
    }
    this.#windowTokens = options.windowTokens;
    this.#rotCases = Object.freeze([...(options.rotCases ?? [])]);
    this.#runId = options.runId ?? 'unknown-run';
    this.#emit = options.emit ?? (() => undefined);
  }

  get config(): CanaryConfig {
    return this.#config;
  }

  /** Every probe that returned a result, in firing order. */
  get records(): readonly CanaryProbeRecord[] {
    return Object.freeze([...this.#records]);
  }

  get failures(): readonly CanaryProbeFailure[] {
    return Object.freeze([...this.#failures]);
  }

  get violations(): readonly CanaryViolation[] {
    return Object.freeze([...this.#violations]);
  }

  get events(): readonly CanaryTelemetryEvent[] {
    return Object.freeze([...this.#events]);
  }

  /** Which probes are due on a turn, without running anything. */
  dueAt(turn: number): readonly ('constraint' | 'rot')[] {
    const due: ('constraint' | 'rot')[] = [];
    if (this.#config.constraintProbe.enabled && isProbeTurn(turn, this.#config.constraintProbe.intervalTurns)) {
      due.push('constraint');
    }
    if (this.#config.rotProbe.enabled && isProbeTurn(turn, this.#config.rotProbe.intervalTurns)) {
      due.push('rot');
    }
    return Object.freeze(due);
  }

  /**
   * Schedule and run whatever is due on this turn. Never rejects.
   *
   * Constraint before rot, fixed. Two reasons, and the second is the one that
   * bites: a governance failure explains a rot score, so measuring rot first
   * means reading the rot number before knowing whether the context it was taken
   * in still had its constraints in it. Rot is also the expensive probe, and a
   * throw from the cheap one must not cost the expensive one.
   */
  async runTurn(input: CanaryTurnInput): Promise<CanaryTurnResult> {
    const { turn, tokenEstimate } = input;
    const due = this.dueAt(turn);
    const probes: CanaryProbeRecord[] = [];
    const failures: CanaryProbeFailure[] = [];
    const events: CanaryTelemetryEvent[] = [];
    const violations: CanaryViolation[] = [];

    if (due.includes('constraint')) {
      const constraint = await this.#runConstraint(turn);
      if (constraint.record !== null) probes.push(constraint.record);
      if (constraint.failure !== null) failures.push(constraint.failure);
      for (const event of constraint.events) events.push(event);
      for (const violation of constraint.violations) violations.push(violation);
    }

    if (due.includes('rot')) {
      const rot = await this.#runRot(turn, tokenEstimate);
      if (rot.record !== null) probes.push(rot.record);
      if (rot.failure !== null) failures.push(rot.failure);
      for (const event of rot.events) events.push(event);
      for (const violation of rot.violations) violations.push(violation);
    }

    this.#records.push(...probes);
    this.#failures.push(...failures);
    this.#events.push(...events);
    this.#violations.push(...violations);

    for (const event of events) {
      try {
        this.#emit(event);
      } catch {
        // There is nowhere left to report a broken reporter without recursing
        // into it, so this is the one genuinely swallowed error in the package.
        // The alternative — letting it reach `runTurn`'s caller — would make a
        // telemetry sink outage fail the user's turn, which is the exact inversion
        // of the fail-open contract. A sink that throws is a sink bug, and the
        // sink's own tests are where it is caught.
      }
    }

    return Object.freeze({
      turn,
      probes: Object.freeze(probes),
      failures: Object.freeze(failures),
      events: Object.freeze(events),
      violations: Object.freeze(violations),
      probed: due.length > 0,
    });
  }

  // ------------------------------------------------------------- the probes

  async #runConstraint(turn: number): Promise<ProbeOutcome<ConstraintProbeRecord>> {
    const probeId = canaryProbeId('constraint', turn);
    const subject = this.#subjects.constraint;
    if (subject === undefined) {
      return this.#constraintFailure(probeId, turn, 'no constraint probe subject is wired into the scheduler');
    }

    const selection = selectProbeConstraints(this.#constraints, this.#config.includeSoftOrgPolicies);
    const request = {
      probeId,
      turn,
      constraints: selection.selected,
      excludedConstraintIds: selection.excluded.map((constraint) => constraint.id),
      includeSoftOrgPolicies: this.#config.includeSoftOrgPolicies,
    };

    try {
      const result = await runConstraintProbe(subject, request);
      const violations: CanaryViolation[] = [];

      if (result.validity === 'not_measurable') {
        violations.push(
          this.#violation(probeId, turn, [], 'the constraint probe had no constraints to ask about, so it measured nothing'),
        );
      } else if (result.validity === 'hard_norms_only') {
        // The false green, named at runtime rather than only in the probe result.
        // A dashboard reading `passed: true` here is reading the provider's
        // alignment priors and calling them this product's retention.
        violations.push(
          this.#violation(
            probeId,
            turn,
            [],
            'every probed constraint was hard_safety, so this firing cannot see the 8.3x soft-org decay; ' +
              'set include_soft_org_policies: true',
          ),
        );
      } else if (result.missing.length > 0) {
        violations.push(
          this.#violation(
            probeId,
            turn,
            result.missing,
            `constraint probe ${result.missing.length} of ${result.probed} constraints did not survive ` +
              `compaction (soft share ${selection.softShare})`,
          ),
        );
      }

      const events: CanaryTelemetryEvent[] = [];
      if (result.score !== null) {
        events.push(canaryEvent(probeId, 'constraint', result.score, result.passed));
      }
      for (const violation of violations) events.push(canaryViolationEvent(violation));

      return {
        record: { kind: 'constraint', result },
        failure: null,
        events: Object.freeze(events),
        violations: Object.freeze(violations),
      };
    } catch (error: unknown) {
      return this.#constraintFailure(probeId, turn, `constraint probe subject threw: ${errorMessage(error)}`);
    }
  }

  #constraintFailure(probeId: ProbeId, turn: number, message: string): ProbeFailureReport {
    const failure: CanaryProbeFailure = Object.freeze({ kind: 'constraint', probeId, turn, message });
    const violation = this.#violation(probeId, turn, [], message);
    return {
      record: null,
      failure,
      events: Object.freeze([canaryViolationEvent(violation)]),
      violations: Object.freeze([violation]),
    };
  }

  async #runRot(turn: number, tokenEstimate: number): Promise<ProbeOutcome<RotProbeRecord>> {
    const probeId = canaryProbeId('rot', turn);
    const subject = this.#subjects.rot;
    if (subject === undefined) {
      return this.#rotFailure(probeId, turn, 'no rot probe subject is wired into the scheduler');
    }
    if (this.#rotCases.length === 0) {
      return this.#rotFailure(probeId, turn, 'the rot probe has no cases, so a firing could not measure anything');
    }

    const fill = this.#fillOf(tokenEstimate);
    const tier = rotTierForFill(fill);
    const request = { probeId, turn, tier, fill, cases: this.#rotCases };

    try {
      const result = await runRotProbe(subject, request);
      const violations: CanaryViolation[] = [];
      if (result.state === 'unscored') {
        violations.push(
          this.#violation(
            probeId,
            turn,
            [],
            `rot probe returned no scorable case (${result.excluded} excluded), so the score it would ` +
              'report is not a measurement',
          ),
        );
      } else if (!result.passed) {
        violations.push(
          this.#violation(
            probeId,
            turn,
            [],
            result.state === 'confounded'
              ? `rot probe scored ${result.score} but the NIAH control fell with it, so this is probably ` +
                  'measuring "long input is hard" rather than rot'
              : `rot probe scored ${result.score} at ${fill} of the window (${result.correct}/${result.scored} cases)`,
          ),
        );
      }

      const events: CanaryTelemetryEvent[] = [rotCanaryEvent(this.#runId, result)];
      if (result.score !== null) events.push(canaryEvent(probeId, 'rot', result.score, result.passed));
      for (const violation of violations) events.push(canaryViolationEvent(violation));

      return {
        record: { kind: 'rot', result },
        failure: null,
        events: Object.freeze(events),
        violations: Object.freeze(violations),
      };
    } catch (error: unknown) {
      return this.#rotFailure(probeId, turn, `rot probe subject threw: ${errorMessage(error)}`);
    }
  }

  #rotFailure(probeId: ProbeId, turn: number, message: string): ProbeFailureReport {
    const failure: CanaryProbeFailure = Object.freeze({ kind: 'rot', probeId, turn, message });
    const violation = this.#violation(probeId, turn, [], message);
    return {
      record: null,
      failure,
      events: Object.freeze([canaryViolationEvent(violation)]),
      violations: Object.freeze([violation]),
    };
  }

  // ------------------------------------------------------------------ reading

  /**
   * The rot series, scored firings only.
   *
   * Unscored firings carry no number, and admitting nulls would mean every reader
   * filters them. They are still visible as `canary_fail` violations, so a session
   * with a broken subject reads as broken rather than as short.
   */
  rotSeries(): readonly RotObservation[] {
    const out: RotObservation[] = [];
    for (const record of this.#records) {
      if (record.kind !== 'rot') continue;
      const observation = observationOf(record.result);
      if (observation !== null) out.push(observation);
    }
    return Object.freeze(out);
  }

  /** Accuracy per §E2 tier. The curve, not the endpoint. */
  rotCurve(): ReturnType<typeof rotTierAccuracy> {
    return rotTierAccuracy(this.rotSeries());
  }

  /** Degradation against window fill. Positive means getting worse. */
  rotSlope(): RotSlopeFit {
    return rotDegradationSlope(this.rotCurve());
  }

  /**
   * `tokenEstimate / windowTokens`, clamped to [0, 1].
   *
   * Clamped because the two numbers come from different places — the estimate
   * from the gateway's estimator, the window from policy — and a session that
   * overran its budget would otherwise report a fill above 1.0 and land outside
   * the top of the §E2 ladder, where no tier exists to classify it into.
   */
  #fillOf(tokenEstimate: number): number {
    const raw = tokenEstimate / this.#windowTokens;
    if (!Number.isFinite(raw) || raw < 0) return 0;
    return raw > 1 ? 1 : raw;
  }

  #violation(probeId: ProbeId, turn: number, constraintIds: readonly string[], detail: string): CanaryViolation {
    return canaryViolation({
      kind: CANARY_EMITTED_VIOLATION_KIND,
      runId: this.#runId,
      turn,
      constraintIds,
      detail: `${probeId}: ${detail}`,
    });
  }
}

/**
 * What one probe method hands back.
 *
 * A discriminated pair rather than a thrown error, because the fail-open path is
 * not exceptional: it is one of two ordinary outcomes and `runTurn` has to account
 * for both in the same accumulator. `record` and `failure` are mutually exclusive,
 * so a caller reads `record` for the successful path and `failure` for the
 * violation-only path without a cast.
 */
interface ProbeReport<R extends CanaryProbeRecord> {
  readonly record: R | null;
  readonly failure: null;
  readonly events: readonly CanaryTelemetryEvent[];
  readonly violations: readonly CanaryViolation[];
}

interface ProbeFailureReport {
  readonly record: null;
  readonly failure: CanaryProbeFailure;
  readonly events: readonly CanaryTelemetryEvent[];
  readonly violations: readonly CanaryViolation[];
}

type ProbeOutcome<R extends CanaryProbeRecord> = ProbeReport<R> | ProbeFailureReport;
