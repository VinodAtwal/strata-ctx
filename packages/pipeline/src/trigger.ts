import type {
  BudgetPolicy,
  BudgetView,
  LossyContext,
  StrataPolicy,
  TriggerPolicy,
} from '@strata-ctx/core-types';
import { budgetView, estimateMessageTokens } from '@strata-ctx/core-types';

/**
 * B-7. Compaction trigger policy: task-boundary (sawtooth) with a size backstop.
 *
 * ## Why sawtooth
 *
 * architecture §1: Focus observed the sawtooth. Context grows within a task and
 * drops at the task boundary, so the *minimum* between tasks is where compaction
 * is nearly free and the maximum is where rot is worst. Triggering on size alone
 * fires mid-task, which is the worst possible moment: the agent is holding
 * partial state that has not yet been written anywhere. Triggering on the
 * boundary fires when the work is finished and the episodic range is
 * self-contained enough to replace with a gist.
 *
 * `monotonic` exists for the opposite shape: a one-shot reasoning run with no
 * tasks, no boundaries and no episodic range to summarise. Waiting for a signal
 * that will never arrive means never compacting, so monotonic fires on size.
 *
 * ## Why the trigger sits well below capacity
 *
 * architecture §5: rot is continuous and long precedes overflow, so for an agent
 * the trigger is a quality decision, not a capacity one. The schema default is
 * 0.85, which is deliberately conservative; ~0.6 is probably right for coding
 * agents. The knob is honoured exactly as configured -- this module has no
 * opinion of its own and no hidden clamp.
 */

export type CompactionTrigger = 'none' | 'soft' | 'hard' | 'task_boundary';

export interface TriggerDecision {
  readonly fire: boolean;
  readonly trigger: CompactionTrigger;
  /** Machine-readable explanation, for telemetry (`compaction.trigger`). */
  readonly reason: string;
  readonly view: BudgetView;
  readonly tokens: number;
  /** tokens / (contextLimit - reserveOutput). Can exceed 1 before anything fires. */
  readonly utilization: number;
  readonly matchedSignals: readonly string[];
  /** Past the hard limit, whether or not we are allowed to act on it. */
  readonly atHardLimit: boolean;
  /** softTriggerFrac >= hardTriggerFrac, i.e. the policy cannot express two levels. */
  readonly policyMisordered: boolean;
}

export interface TriggerInput {
  readonly tokens: number;
  /** Signals observed this turn by the caller; see `matchTaskBoundarySignals`. */
  readonly signals?: readonly string[];
  readonly trigger: TriggerPolicy;
  readonly budgets: BudgetPolicy;
  readonly compaction: StrataPolicy['pipeline']['compaction'];
}

/**
 * Both knobs are reservations against the same window and they are different
 * things: `maxOutputTokens` is the response we must still be able to emit, and
 * `TriggerPolicy.reserveTokens` is the next tool result we must still be able to
 * accept. Summing them is what makes "fire before the window is full" true
 * rather than nearly true.
 */
export const reserveFor = (b: BudgetPolicy, trigger: TriggerPolicy): number =>
  b.maxOutputTokens + trigger.reserveTokens;

/**
 * Signals configured in policy, in the order they are listed, de-duplicated.
 * Order is the policy's, not the caller's, so two callers observing the same set
 * of signals produce the same decision (N6).
 */
export function matchTaskBoundarySignals(
  signals: readonly string[],
  trigger: TriggerPolicy,
): string[] {
  const present = new Set(signals);
  const matched: string[] = [];
  for (const s of trigger.taskBoundarySignals) {
    if (present.has(s) && !matched.includes(s)) matched.push(s);
  }
  return matched;
}

export function evaluateTrigger(input: TriggerInput): TriggerDecision {
  const { trigger: tp, budgets } = input;
  const reserveOutput = reserveFor(budgets, tp);
  const view = budgetView(
    budgets.contextLimit,
    reserveOutput,
    budgets.targetUtilization,
    tp.softTriggerFrac,
    tp.hardTriggerFrac,
  );

  const usable = Math.max(1, view.contextLimit - view.reserveOutput);
  const atHardLimit = input.tokens >= view.hardLimit;
  const atSoftLimit = input.tokens >= view.triggerAt;
  const matched = matchTaskBoundarySignals(input.signals ?? [], tp);
  const policyMisordered = view.triggerAt >= view.hardLimit;

  const decide = (
    fire: boolean,
    compaction: CompactionTrigger,
    reason: string,
  ): TriggerDecision => ({
    fire,
    trigger: compaction,
    reason,
    view,
    tokens: input.tokens,
    utilization: input.tokens / usable,
    matchedSignals: matched,
    atHardLimit,
    policyMisordered,
  });

  // ADR-11: auto-compaction ships off, and compacting anyway would be taking a
  // decision the operator explicitly did not delegate. Q7: we observe the
  // provider's own compaction, we do not fight it. So `off` and `manual` both
  // report and never act -- `atHardLimit` is there so telemetry can warn that the
  // next request is at risk.
  if (input.compaction === 'off') return decide(false, 'none', 'compaction_off');
  if (input.compaction === 'manual') return decide(false, 'none', 'compaction_manual');

  // The hard limit is checked first on purpose. A misordered policy
  // (`softTriggerFrac >= hardTriggerFrac`, which the schema permits) must
  // degrade to the more conservative of the two rather than throwing: failing
  // open here means overflowing the provider's window, and failing closed means
  // evicting a user's context over a config typo.
  if (atHardLimit) return decide(true, 'hard', policyMisordered ? 'hard_limit_misordered' : 'hard_limit');

  if (tp.strategy === 'sawtooth') {
    if (!atSoftLimit) {
      return decide(
        false,
        'none',
        matched.length > 0 ? 'below_soft_at_boundary' : 'below_soft',
      );
    }
    // Past the trigger with no boundary: hold. This is the whole point of the
    // sawtooth -- mid-task is the moment compaction damages quality.
    if (matched.length === 0) return decide(false, 'none', 'awaiting_task_boundary');
    return decide(true, 'task_boundary', 'soft_limit_at_boundary');
  }

  if (!atSoftLimit) return decide(false, 'none', 'below_soft');
  return decide(true, 'soft', 'soft_limit');
}

/** Recomputed rather than read off `ctx.tokenEstimate`: stage 2 may have moved it. */
export const estimateLossyTokens = (ctx: LossyContext): number =>
  ctx.messages.reduce((n, m) => n + estimateMessageTokens(m), 0);

export function triggerFor(
  ctx: LossyContext,
  policy: StrataPolicy,
  signals: readonly string[] = [],
): TriggerDecision {
  return evaluateTrigger({
    tokens: estimateLossyTokens(ctx),
    signals,
    trigger: policy.pipeline.trigger,
    budgets: policy.budgets,
    compaction: policy.pipeline.compaction,
  });
}
