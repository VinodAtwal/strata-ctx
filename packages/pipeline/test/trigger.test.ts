import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { BudgetPolicy, TriggerPolicy } from '@strata-ctx/core-types';
import { budgetView, estimateMessageTokens, partitionForLossy } from '@strata-ctx/core-types';

import { applyTruncate, evaluateTrigger, matchTaskBoundarySignals, reserveFor, triggerFor } from '../src/index.js';

import { block, lines, message, meta, policy, state, toolResult } from './fixtures.js';

const BUDGETS: BudgetPolicy = {
  contextLimit: 100_000,
  maxOutputTokens: 8_000,
  targetUtilization: 0.7,
};

const TRIGGER: TriggerPolicy = {
  strategy: 'sawtooth',
  softTriggerFrac: 0.6,
  hardTriggerFrac: 0.85,
  keepRecentTokens: 8192,
  userMessageTailTokens: 20_000,
  reserveTokens: 16_000,
  taskBoundarySignals: ['task_complete', 'result_extracted'],
};

const at = (frac: number): number => {
  const view = budgetView(
    BUDGETS.contextLimit,
    reserveFor(BUDGETS, TRIGGER),
    BUDGETS.targetUtilization,
    TRIGGER.softTriggerFrac,
    TRIGGER.hardTriggerFrac,
  );
  return Math.floor(frac * (view.contextLimit - view.reserveOutput));
};

const decide = (tokens: number, over: Partial<Parameters<typeof evaluateTrigger>[0]> = {}) =>
  evaluateTrigger({
    tokens,
    trigger: TRIGGER,
    budgets: BUDGETS,
    compaction: 'auto',
    ...over,
  });

describe('B-7 trigger: the reserve', () => {
  it('reserves for the response and the next tool result', () => {
    // They are reservations against the same window and they are different
    // things; summing them is what makes "fire before it is full" true.
    assert.equal(reserveFor(BUDGETS, TRIGGER), BUDGETS.maxOutputTokens + TRIGGER.reserveTokens);
  });
});

describe('B-7 trigger: sawtooth', () => {
  it('holds below the soft limit', () => {
    const d = decide(at(0.1));
    assert.equal(d.fire, false);
    assert.equal(d.trigger, 'none');
    assert.equal(d.reason, 'below_soft');
  });

  it('holds past the soft limit with no boundary in sight', () => {
    // Mid-task is the moment compaction damages quality: the agent is holding
    // partial state that has not been written anywhere yet.
    const d = decide(at(0.7), { signals: [] });
    assert.equal(d.fire, false);
    assert.equal(d.reason, 'awaiting_task_boundary');
  });

  it('fires at the boundary once past the soft limit', () => {
    const d = decide(at(0.7), { signals: ['task_complete'] });
    assert.equal(d.fire, true);
    assert.equal(d.trigger, 'task_boundary');
    assert.equal(d.reason, 'soft_limit_at_boundary');
  });

  it('reports a boundary below the soft limit without firing on it', () => {
    const d = decide(at(0.1), { signals: ['task_complete'] });
    assert.equal(d.fire, false);
    assert.equal(d.reason, 'below_soft_at_boundary');
    assert.deepEqual(d.matchedSignals, ['task_complete']);
  });

  it('matches signals in policy order, de-duplicated', () => {
    // N6: two callers observing the same set of signals must get the same answer.
    const a = matchTaskBoundarySignals(['result_extracted', 'task_complete', 'result_extracted'], TRIGGER);
    const b = matchTaskBoundarySignals(['task_complete', 'result_extracted'], TRIGGER);
    assert.deepEqual(a, b);
    assert.deepEqual(a, ['task_complete', 'result_extracted']);
  });

  it('ignores signals the policy does not name', () => {
    assert.deepEqual(matchTaskBoundarySignals(['unrelated', 'task_complete'], TRIGGER), ['task_complete']);
    assert.deepEqual(matchTaskBoundarySignals([], TRIGGER), []);
  });
});

describe('B-7 trigger: monotonic', () => {
  const monotonic: TriggerPolicy = { ...TRIGGER, strategy: 'monotonic' };

  it('fires on size alone, because no boundary is coming', () => {
    const d = evaluateTrigger({
      tokens: at(0.7),
      signals: [],
      trigger: monotonic,
      budgets: BUDGETS,
      compaction: 'auto',
    });
    assert.equal(d.fire, true);
    assert.equal(d.trigger, 'soft');
    assert.equal(d.reason, 'soft_limit');
  });

  it('still holds below the soft limit', () => {
    const d = evaluateTrigger({
      tokens: at(0.1),
      trigger: monotonic,
      budgets: BUDGETS,
      compaction: 'auto',
    });
    assert.equal(d.fire, false);
    assert.equal(d.reason, 'below_soft');
  });
});

describe('B-7 trigger: the hard limit is a backstop, not a plan', () => {
  it('reaches soft strictly before hard, for every strategy and every level', () => {
    // The ordering is the property that makes `hard` a backstop. If soft ever
    // fired at or after the hard level, the sawtooth would have no working room:
    // a mid-task context would be at the emergency threshold before the
    // task-boundary signal it is waiting for could arrive.
    assert.equal(decide(at(0.1)).fire, false, 'and nothing fires below the soft level at all');

    for (const strategy of ['sawtooth', 'monotonic'] as const) {
      const trigger = { ...TRIGGER, strategy };
      const soft = budgetView(
        BUDGETS.contextLimit,
        reserveFor(BUDGETS, trigger),
        BUDGETS.targetUtilization,
        trigger.softTriggerFrac,
        trigger.hardTriggerFrac,
      );

      const atSoft = evaluateTrigger({
        tokens: soft.triggerAt,
        signals: ['task_complete'],
        trigger,
        budgets: BUDGETS,
        compaction: 'auto',
      });
      const atHard = evaluateTrigger({
        tokens: soft.hardLimit,
        signals: ['task_complete'],
        trigger,
        budgets: BUDGETS,
        compaction: 'auto',
      });

      assert.equal(atSoft.atHardLimit, false, `${strategy}: the soft level is not the hard level`);
      assert.equal(atSoft.fire, true, `${strategy}: soft fires at the soft level`);
      assert.notEqual(atSoft.trigger, 'hard', `${strategy}: and reports itself as soft`);
      assert.equal(atHard.trigger, 'hard', `${strategy}: only the hard level reports hard`);
    }
  });

  it('fires on hard regardless of strategy or boundary', () => {
    for (const strategy of ['sawtooth', 'monotonic'] as const) {
      const d = evaluateTrigger({
        tokens: at(0.95),
        signals: [],
        trigger: { ...TRIGGER, strategy },
        budgets: BUDGETS,
        compaction: 'auto',
      });
      assert.equal(d.fire, true, strategy);
      assert.equal(d.trigger, 'hard', strategy);
      assert.equal(d.atHardLimit, true, strategy);
    }
  });

  it('degrades to the conservative level when the policy is misordered', () => {
    // The schema permits softTriggerFrac >= hardTriggerFrac. Failing open here
    // overflows the provider's window; failing closed evicts a user's context
    // over a config typo. So it degrades, and says so.
    const d = decide(at(0.95), { trigger: { ...TRIGGER, softTriggerFrac: 0.95, hardTriggerFrac: 0.6 } });
    assert.equal(d.policyMisordered, true);
    assert.equal(d.fire, true);
    assert.equal(d.trigger, 'hard');
    assert.equal(d.reason, 'hard_limit_misordered');
  });

  it('does not call a healthy policy misordered', () => {
    assert.equal(decide(at(0.1)).policyMisordered, false);
  });
});

describe('B-7 trigger: the operator always wins', () => {
  it('reports but never fires when compaction is off', () => {
    // ADR-11: auto-compaction ships off. Compacting anyway would be taking a
    // decision the operator explicitly did not delegate.
    for (const compaction of ['off', 'manual'] as const) {
      const d = evaluateTrigger({
        tokens: at(2),
        signals: ['task_complete'],
        trigger: TRIGGER,
        budgets: BUDGETS,
        compaction,
      });
      assert.equal(d.fire, false, compaction);
      assert.equal(d.trigger, 'none', compaction);
      assert.equal(d.reason, `compaction_${compaction}`, compaction);
      assert.equal(d.atHardLimit, true, 'telemetry still learns the request is at risk');
    }
  });
});

describe('B-7 trigger: the reported numbers', () => {
  it('measures utilization against the usable window, and admits it can exceed 1', () => {
    const d = decide(at(0.5));
    const usable = d.view.contextLimit - d.view.reserveOutput;
    assert.equal(d.utilization, d.tokens / usable);
    assert.ok(Math.abs(d.utilization - 0.5) < 0.01);

    const over = decide(BUDGETS.contextLimit * 3);
    assert.ok(over.utilization > 1, 'before anything fires, the ratio is allowed to exceed 1');
  });

  it('carries the budget view the decision was made against', () => {
    const d = decide(at(0.1));
    assert.equal(d.view.reserveOutput, reserveFor(BUDGETS, TRIGGER));
    assert.ok(d.view.softLimit < d.view.hardLimit);
    assert.ok(d.view.triggerAt < d.view.hardLimit);
  });

  it('is deterministic', () => {
    assert.deepEqual(decide(at(0.7), { signals: ['task_complete'] }), decide(at(0.7), { signals: ['task_complete'] }));
  });
});

describe('B-7 trigger: over a real lossy context', () => {
  it('recomputes tokens from the truncated context rather than trusting the estimate', () => {
    const big = toolResult({ ref: 'npm test', text: lines(2000, 'test output') });
    const capped = policy({ trigger: { ...TRIGGER }, tierByteCaps: { tool_state: 400 } });

    const before = triggerFor(partitionForLossy(state({ messages: [message('user', [big])] }), capped), capped);
    const truncated = applyTruncate(
      partitionForLossy(state({ messages: [message('user', [big])] }), capped),
    );
    const after = triggerFor(truncated.ctx, capped);

    assert.ok(after.tokens < before.tokens, 'the cap moved the number the trigger reads');
    assert.ok(after.tokens > 0);
    assert.equal(after.tokens, truncated.ctx.messages.reduce((n, m) => n + estimateMessageTokens(m), 0));
  });

  it('honours the policy the caller passes, not a default', () => {
    const off = policy({ trigger: { ...TRIGGER }, compaction: 'off' });
    const ctx = partitionForLossy(state({ messages: [message('user', [block({ text: 'x', meta: meta({ tier: 'episodic' }) })])] }), off);

    assert.equal(triggerFor(ctx, off, ['task_complete']).fire, false);
    assert.equal(triggerFor(ctx, policy({ trigger: { ...TRIGGER } }), ['task_complete']).reason.length > 0, true);
  });
});
