import { ViolationRecorder, type ViolationRecord } from './violations.js';

/**
 * D-7: the volume-attack alert.
 *
 * ## The attack
 *
 * Compaction is the only operation in this system that can put a pinned
 * constraint at risk, and Governance Decay's headline number is an *exposure*
 * number: 0% -> 30% violations (59% worst) across 1,323 episodes, caused purely
 * by compaction, with the violation rate conditional on whether the constraint
 * survived at 0% (survived) vs 38% (dropped). Compaction Cliff (CIKM 2026,
 * arXiv 2608.22752) puts a number on the per-exposure damage: 53% of safety
 * rules survive one production `/compact`, 10% after five.
 *
 * Read together those two say something specific: **each compaction is a dice
 * roll, and the odds compound.** An adversary who can make compaction happen
 * more often is not attacking the pin buffer directly -- that is structurally
 * impossible, `PinnedBuffer.apply` re-materialises it from an immutable
 * snapshot every turn. They are rolling the dice faster.
 *
 * Four concrete ways to do that, all of which need only influence over the
 * *content* of a session rather than over the process:
 *
 * 1. **Rate.** A long tool result, a generated fixture, a vendored file. Each
 *    one pushes the token estimate and the sawtooth trigger fires. Nothing
 *    about this is anomalous on its own; forty of them is.
 * 2. **Exposure budget.** Five compactions puts the run at the Compaction Cliff
 *    10% figure. Nothing "attacked" -- the run simply aged into the regime
 *    where the product's central claim stops being about this run.
 * 3. **No progress.** If something can inflate the *measured* token count
 *    without adding real content, the trigger fires, the compactor writes a
 *    gist, `dropped_count` is 0, and the transcript is no smaller. That is a
 *    compaction loop: full price, zero benefit, one extra dice roll per turn.
 * 4. **Abort loop.** Step 4 failing aborts the transaction and keeps the
 *    transcript (spec.md principle 1: fail toward more context). A kept
 *    transcript is a *bigger* transcript, so it re-triggers the trigger. An
 *    adversary who can keep a gist invalid keeps the loop spinning and the
 *    bill climbing, one failed gate per turn.
 *
 * ## What this module is and is not
 *
 * It is a rate detector, not a defence. Nothing here can stop any of the four;
 * the pin survives all of them by construction, which is exactly why the
 * *rate* is worth an alert. It is a P1 signal by default, because an unusual
 * compaction rate is an anomaly, not a proven violation -- treating it as a
 * proven violation would put the 0%-violation claim in the README next to a
 * number that is mostly "we compacted a lot".
 *
 * The one exception is `exposure_budget_exhausted`, which is P0, and only
 * because it is a citation rather than a judgement: past five compactions the
 * published survival figure for each constraint is 10%, so any run past that
 * point is making the product's claim about someone else's session.
 *
 * ## Rising edge only
 *
 * An alert fires when a signal appears, not on every observation that still
 * satisfies it. A loop that runs for 10,000 turns produces one violation
 * record, not 10,000 -- otherwise the alert becomes the thing that makes the
 * log unreadable, and a log nobody reads is a log with no alert in it.
 */

export type CompressionBy = 'self-gist' | 'local-model' | 'none';

/**
 * One compaction event. The first six fields are exactly the frozen
 * `compaction` telemetry event's payload, so a caller can build one straight
 * from what it already emits rather than maintaining a second shape.
 */
export interface CompactionObservation {
  readonly turn: number;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly droppedCount: number;
  /** Step 4 of the transaction. `false` means the eviction was refused. */
  readonly validationPassed: boolean;
  readonly compressionBy: CompressionBy;
  readonly trigger?: string | undefined;
}

export type VolumeAlertReason =
  | 'rate_above_ceiling'
  | 'exposure_budget_exhausted'
  | 'no_progress'
  | 'abort_loop';

export const VOLUME_DEFAULTS = Object.freeze({
  /**
   * Equal to `governance.canaryIntervalTurns`. The window is the canary's own
   * sampling period on purpose: an attack that outpaces the canary has to show
   * up inside the interval in which the canary would have spoken, or the canary
   * reports a healthy number over a session that never stopped compacting.
   */
  windowTurns: 20,
  /**
   * A compaction is a task boundary (architecture.md §5 runs the whole
   * transaction `ON task_boundary`). Three in twenty turns is not a coding
   * session, and the ceiling is well above what a genuinely long task needs.
   */
  maxCompactionsPerWindow: 3,
  /** Compaction Cliff: 53% survival after one round, 10% after five. */
  exposureEscalateAt: 5,
  /**
   * Two in a row is suspicious, three is a loop. A single zero-progress
   * compaction is a real and common outcome of a task-boundary trigger firing
   * slightly early.
   */
  noProgressLimit: 3,
  /**
   * An aborted compaction is a correct outcome, not a fault: step 4 is
   * supposed to abort. Three in a row is a loop, and it costs a full gist
   * generation each time.
   */
  abortLimit: 3,
});

export interface VolumeOptions {
  readonly windowTurns?: number;
  readonly maxCompactionsPerWindow?: number;
  readonly exposureEscalateAt?: number;
  readonly noProgressLimit?: number;
  readonly abortLimit?: number;
  readonly recorder?: ViolationRecorder;
  /** Attribution for the violation records. The caller knows the real run. */
  readonly runId?: string;
  readonly now?: () => number;
}

export interface VolumeStats {
  /** Compactions seen in this run, ever. Never pruned. */
  readonly total: number;
  /** Compactions inside the current window. */
  readonly inWindow: number;
  /** `inWindow / windowTurns`. The number an operator actually reads. */
  readonly perTurn: number;
  readonly consecutiveNoProgress: number;
  readonly consecutiveAborts: number;
  /** Signals that are currently satisfied, having fired at least once. */
  readonly active: readonly VolumeAlertReason[];
}

export interface VolumeAssessment {
  readonly ok: boolean;
  /** Every signal satisfied by this observation. */
  readonly reasons: readonly VolumeAlertReason[];
  /** Of those, the ones that have just started. Empty on a steady state. */
  readonly newlyFired: readonly VolumeAlertReason[];
  readonly violations: readonly ViolationRecord[];
  readonly stats: VolumeStats;
}

/**
 * P0 only for the exposure budget, and the citation is the justification: past
 * this many compactions the published per-rule survival rate is 10%, so the run
 * is no longer evidence for the product's central claim.
 */
const SEVERITY: Readonly<Record<VolumeAlertReason, 'P0' | 'P1'>> = Object.freeze({
  rate_above_ceiling: 'P1',
  exposure_budget_exhausted: 'P0',
  no_progress: 'P1',
  abort_loop: 'P1',
});

const LABEL: Readonly<Record<VolumeAlertReason, string>> = Object.freeze({
  rate_above_ceiling: 'more compactions in the window than a task-boundary trigger should produce',
  exposure_budget_exhausted: 'past the compaction count at which constraint survival is known to collapse',
  no_progress: 'consecutive compactions that reclaimed nothing',
  abort_loop: 'consecutive compactions refused by the step-4 gate',
});

/**
 * A compaction that dropped nothing. `afterTokens >= beforeTokens` is the
 * honest test rather than `droppedCount === 0`: a compactor that rewrote the
 * transcript into a slightly larger gist has also made no progress, and the
 * transcript is the thing the trigger watches.
 */
export function isNoProgress(o: CompactionObservation): boolean {
  return o.droppedCount === 0 && o.afterTokens >= o.beforeTokens;
}

export class VolumeAttackDetector {
  readonly #windowTurns: number;
  readonly #maxPerWindow: number;
  readonly #exposureEscalateAt: number;
  readonly #noProgressLimit: number;
  readonly #abortLimit: number;
  readonly #recorder: ViolationRecorder;
  readonly #runId: string;
  readonly #now: () => number;
  /** Retained only inside the window. */
  readonly #window: CompactionObservation[] = [];
  #total = 0;
  #consecutiveNoProgress = 0;
  #consecutiveAborts = 0;
  #active: ReadonlySet<VolumeAlertReason> = new Set();

  constructor(options: VolumeOptions = {}) {
    this.#windowTurns = options.windowTurns ?? VOLUME_DEFAULTS.windowTurns;
    this.#maxPerWindow = options.maxCompactionsPerWindow ?? VOLUME_DEFAULTS.maxCompactionsPerWindow;
    this.#exposureEscalateAt = options.exposureEscalateAt ?? VOLUME_DEFAULTS.exposureEscalateAt;
    this.#noProgressLimit = options.noProgressLimit ?? VOLUME_DEFAULTS.noProgressLimit;
    this.#abortLimit = options.abortLimit ?? VOLUME_DEFAULTS.abortLimit;
    this.#recorder = options.recorder ?? new ViolationRecorder();
    this.#runId = options.runId ?? 'unknown-run';
    this.#now = options.now ?? Date.now;
  }

  get violations(): readonly ViolationRecord[] {
    return this.#recorder.log.all();
  }

  get recorder(): ViolationRecorder {
    return this.#recorder;
  }

  /**
   * Report one compaction. Never throws and never mutates the observation: an
   * alerting failure must not be able to take the request path with it, which
   * is the same reasoning as the fail-open principle in spec.md §6.1.
   */
  observe(observation: CompactionObservation): VolumeAssessment {
    this.#total += 1;
    this.#window.push(observation);
    // The window is half-open, `(turn - windowTurns, turn]`, so that N
    // compactions inside N turns is a rate of exactly 1/turn rather than one
    // that silently benefits from an off-by-one in the window.
    const cutoff = observation.turn - this.#windowTurns;
    while (this.#window.length > 0 && (this.#window[0]?.turn ?? 0) <= cutoff) this.#window.shift();

    this.#consecutiveNoProgress = isNoProgress(observation) ? this.#consecutiveNoProgress + 1 : 0;
    this.#consecutiveAborts = observation.validationPassed ? 0 : this.#consecutiveAborts + 1;

    const inWindow = this.#window.length;
    const reasons: VolumeAlertReason[] = [];
    if (inWindow > this.#maxPerWindow) reasons.push('rate_above_ceiling');
    if (this.#total >= this.#exposureEscalateAt) reasons.push('exposure_budget_exhausted');
    if (this.#consecutiveNoProgress >= this.#noProgressLimit) reasons.push('no_progress');
    if (this.#consecutiveAborts >= this.#abortLimit) reasons.push('abort_loop');

    const active = new Set(reasons);
    const newlyFired = reasons.filter((r) => !this.#active.has(r));
    this.#active = active;

    const violations = newlyFired.map((reason) =>
      this.#recorder.record(
        {
          kind: 'volume_attack',
          severity: SEVERITY[reason],
          constraintIds: [],
          detail: `compaction ${this.#total} at turn ${observation.turn}: ${LABEL[reason]}`,
          at: this.#now(),
        },
        { runId: this.#runId, turn: observation.turn },
      ),
    );

    return {
      ok: reasons.length === 0,
      reasons: Object.freeze(reasons),
      newlyFired: Object.freeze(newlyFired),
      violations: Object.freeze(violations),
      stats: {
        total: this.#total,
        inWindow,
        perTurn: inWindow / this.#windowTurns,
        consecutiveNoProgress: this.#consecutiveNoProgress,
        consecutiveAborts: this.#consecutiveAborts,
        active: Object.freeze([...active].sort()),
      },
    };
  }

  stats(): VolumeStats {
    return {
      total: this.#total,
      inWindow: this.#window.length,
      perTurn: this.#window.length / this.#windowTurns,
      consecutiveNoProgress: this.#consecutiveNoProgress,
      consecutiveAborts: this.#consecutiveAborts,
      active: Object.freeze([...this.#active].sort()),
    };
  }

  /**
   * Forget the active set, keeping the counters. Used when a run is segmented
   * (a new task boundary), so a signal that is still true in the next segment
   * is reported once more rather than staying silently suppressed.
   */
  rearm(): void {
    this.#active = new Set();
  }
}
