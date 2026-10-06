import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ContextState, PinnedConstraint } from '@strata-ctx/core-types';
import { estimateTokens, runId, sha256 } from '@strata-ctx/core-types';

import {
  CanaryConfigError,
  CanaryScheduler,
  DEFAULT_CANARY_CONFIG,
  type CanaryTelemetryEvent,
  type RotProbeCase,
} from '../src/index.js';

/**
 * Falsifiers for the fill that places a rot probe on the §E2 ladder
 * (docs/risk-analysis.md §3.1 R1, R14). Local fixtures, per rule P2.
 *
 * The subject under test is `#fillOf`, which cannot be called directly — it is
 * private and the ladder reaches it only through a firing. So every assertion
 * here reads `rot_canary.atFracOfWindow` and `tier`, which are the record
 * `docs/telemetry.md` §8 actually publishes and therefore what a mis-placed
 * observation would be read as. Two mutations are applied to `src/scheduler.ts`
 * to confirm each of these fails: (A) route the count back to core-types'
 * `estimateTokens`, (B) delete the `[0, 1]` clamp.
 */
function constraint(
  id: string,
  kind: PinnedConstraint['kind'] = 'soft_policy',
): PinnedConstraint {
  const text = `constraint ${id}`;
  return {
    id,
    text,
    sha256: sha256(text),
    source: 'org_policy',
    kind,
    enforcement: 'block',
  };
}

const MIXED: readonly PinnedConstraint[] = Object.freeze([
  constraint('safety.delete', 'hard_safety'),
  constraint('soft.client-email', 'soft_policy'),
  constraint('pref.legacy-adapter', 'user_preference'),
]);

const ROT_CASES: readonly RotProbeCase[] = Object.freeze([
  { id: 'rot-1', prompt: 'What was the deploy token?', correctAnswer: 'hunter2', niah: false },
  { id: 'niah-1', prompt: 'What was the needle?', correctAnswer: 'needle', niah: true },
]);

const subjects = {
  constraint: { id: 'fill-constraint', probeConstraints: () => Promise.resolve({ retainedConstraintIds: ['safety.delete', 'soft.client-email', 'pref.legacy-adapter'] }) },
  rot: { id: 'fill-rot', answerRot: () => Promise.resolve([{ caseId: 'rot-1', answer: 'hunter2' }, { caseId: 'niah-1', answer: 'needle' }]) },
} as const;

const WINDOW = 200_000;

/** Rot only, so a fill assertion never races the constraint probe. */
const rotOnly = { ...DEFAULT_CANARY_CONFIG, constraintProbe: { enabled: false, intervalTurns: 25 } };

function stateOf(text: string): ContextState {
  const base: ContextState = {
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text,
            meta: { origin: 'user', sha256: sha256(text), tier: 'episodic', bytes: text.length, cacheable: false },
          },
        ],
        ts: 0,
      },
    ],
    pinned: [],
    tokenEstimate: 0,
    policyHash: 'policy-hash',
    runId: runId('run-1'),
    turn: 0,
    gists: [],
    artifacts: [],
  };
  return { ...base, tokenEstimate: estimateTokens(base) };
}

const fixedTokens = (tokens: number): ((state: ContextState) => number) => () => tokens;

/** Collects `rot_canary` records in emission order. */
const recorder = (): { events: CanaryTelemetryEvent[]; emit: (event: CanaryTelemetryEvent) => void } => {
  const events: CanaryTelemetryEvent[] = [];
  return { events, emit: (event) => void events.push(event) };
};

const rotOf = (events: readonly CanaryTelemetryEvent[]) => {
  const rot = events.find((event) => event.type === 'rot_canary');
  assert.ok(rot !== undefined, 'the rot probe must emit a rot_canary record');
  return rot;
};

/** One scheduler, one rot turn at 50. */
async function fireOnce(
  pessimisticTokens: (state: ContextState) => number,
  state: ContextState,
): Promise<{ atFracOfWindow: number; tier: string }> {
  const { events, emit } = recorder();
  const scheduler = new CanaryScheduler({
    subjects,
    constraints: MIXED,
    windowTokens: WINDOW,
    pessimisticTokens,
    rotCases: ROT_CASES,
    config: rotOnly,
    emit,
  });
  await scheduler.runTurn({ turn: 50, state });
  const rot = rotOf(events);
  return { atFracOfWindow: rot.atFracOfWindow, tier: rot.tier };
}

describe('the fill is the injected count, not the comparison the ledger warns about', () => {
  it('reads the estimator, even when state.tokenEstimate says the window is full', async () => {
    const { atFracOfWindow, tier } = await fireOnce(
      fixedTokens(WINDOW / 2),
      { ...stateOf('one short message'), tokenEstimate: WINDOW },
    );
    assert.equal(atFracOfWindow, 0.5);
    assert.equal(tier, 't50');
  });

  it('ignores state.tokenEstimate when the estimator reports an empty window', async () => {
    const { atFracOfWindow, tier } = await fireOnce(
      fixedTokens(0),
      { ...stateOf('one short message'), tokenEstimate: WINDOW },
    );
    assert.equal(atFracOfWindow, 0);
    assert.equal(tier, 't05');
  });

  it('hands the turn its own state, once, and only on a rot turn', async () => {
    const seen: ContextState[] = [];
    const state = stateOf('one short message');
    const { events, emit } = recorder();
    const scheduler = new CanaryScheduler({
      subjects,
      constraints: MIXED,
      windowTokens: WINDOW,
      pessimisticTokens: (received) => {
        seen.push(received);
        return 0;
      },
      rotCases: ROT_CASES,
      config: rotOnly,
      emit,
    });

    await scheduler.runTurn({ turn: 1, state });
    assert.equal(seen.length, 0, 'no probe turn means no reason to count anything');

    await scheduler.runTurn({ turn: 50, state });
    assert.equal(seen.length, 1, 'exactly one count per rot firing');
    assert.equal(seen[0], state, 'the state that arrived is the state that was counted');
    assert.notEqual(seen[0], undefined);
    rotOf(events);
  });
});

describe('a structure-heavier session sits a rung higher at the same length', () => {
  /**
   * `pessimisticStateTokens` in `@strata-ctx/pipeline` is the real estimator and
   * cannot be imported here — a canary → pipeline edge is the fourth cross-stream
   * edge (AGENTS.md §7), and the count is injected precisely so it does not have
   * to be. This stand-in applies the measured comparative instead: JSON-shaped
   * content reads 1.43–1.49x under at `chars/4`, and prose ~0.97x
   * (docs/risk-analysis.md §3.1 R1), so 1.49x for a `{`-led block and 1.0 for
   * anything else is the worst case the register quotes.
   */
  const standIn = (state: ContextState): number => {
    const text = state.messages[0]?.content[0]?.text ?? '';
    const uplift = text.startsWith('{') ? 1.49 : 1;
    return Math.ceil(estimateTokens(state) * uplift);
  };

  /** 279_600 chars ⇒ `chars/4` + overhead = 69_906 ⇒ fill 0.34953, a hair under the t20/t50 midpoint. */
  const prose = stateOf('the session so far. '.padEnd(279_600, 'a'));
  const json = stateOf('{"hits":['.padEnd(279_600, '{"k":"v"},'));

  it('starts from the same tokenEstimate on both sides', () => {
    assert.equal(prose.tokenEstimate, json.tokenEstimate, 'same length, so chars/4 cannot tell them apart');
    assert.ok(prose.tokenEstimate / WINDOW < 0.35, 'the premise: the comparative lands below the midpoint');
  });

  it('places the prose session on t20 and the JSON session on t50', async () => {
    const proseFill = await fireOnce(standIn, prose);
    const jsonFill = await fireOnce(standIn, json);

    assert.equal(proseFill.tier, 't20', 'a content-agnostic count sits below the t20/t50 midpoint');
    assert.equal(proseFill.atFracOfWindow, prose.tokenEstimate / WINDOW);

    assert.equal(jsonFill.tier, 't50', 'the same length of JSON crosses the midpoint, so the rung must move');
    assert.ok(jsonFill.atFracOfWindow > 0.5, 'the measured uplift, not chars/4, put it there');
  });
});

describe('the fill never leaves the ladder', () => {
  it('never decreases as the count grows, and hits each rung', async () => {
    const counts = [0, WINDOW * 0.05, WINDOW * 0.3, WINDOW * 0.5, WINDOW * 0.8, WINDOW, WINDOW * 1.4];
    let next = 0;
    const { events, emit } = recorder();
    const scheduler = new CanaryScheduler({
      subjects,
      constraints: MIXED,
      windowTokens: WINDOW,
      pessimisticTokens: () => counts[next++] ?? 0,
      rotCases: ROT_CASES,
      config: rotOnly,
      emit,
    });

    const turns = counts.map((_, index) => 50 + index * 50);
    for (const turn of turns) await scheduler.runTurn({ turn, state: stateOf('x') });

    const fills = events.filter((event) => event.type === 'rot_canary').map((event) => event.atFracOfWindow);
    assert.equal(fills.length, counts.length, 'one observation per count');
    assert.equal(next, counts.length, 'one count per firing, and no count on a turn without one');

    const expected = counts.map((count) => Math.min(Math.max(count / WINDOW, 0), 1));
    assert.deepEqual(fills, expected);

    for (let i = 1; i < fills.length; i++) {
      assert.ok((fills[i] ?? 0) >= (fills[i - 1] ?? 0), 'a longer session cannot sit lower on the ladder');
    }
    assert.ok((fills.at(-1) ?? 0) <= 1, 'the top of the ladder is 1, not 1.4');
  });

  it('clamps an over-budget fill to 1 and reports the top rung', async () => {
    const { atFracOfWindow, tier } = await fireOnce(fixedTokens(WINDOW * 3), stateOf('x'));
    assert.equal(atFracOfWindow, 1, 'a count past the window is still only the top of the ladder');
    assert.equal(tier, 't80');
  });

  it('keeps NaN and -Infinity off the ladder and clamps +Infinity to the top of it', async () => {
    assert.equal((await fireOnce(fixedTokens(Number.NaN), stateOf('x'))).atFracOfWindow, 0);
    assert.equal((await fireOnce(fixedTokens(Number.POSITIVE_INFINITY), stateOf('x'))).atFracOfWindow, 1);
    assert.equal((await fireOnce(fixedTokens(Number.NEGATIVE_INFINITY), stateOf('x'))).atFracOfWindow, 0);
  });
});

describe('a count that cannot be produced fails open as a canary_fail', () => {
  it('records the estimator throw instead of rejecting the turn', async () => {
    const { events, emit } = recorder();
    const scheduler = new CanaryScheduler({
      subjects,
      constraints: MIXED,
      windowTokens: WINDOW,
      pessimisticTokens: () => {
        throw new Error('estimator exploded');
      },
      rotCases: ROT_CASES,
      config: rotOnly,
      emit,
    });

    const result = await scheduler.runTurn({ turn: 50, state: stateOf('x') });
    assert.equal(result.failures.length, 1, 'the caller still gets its turn');
    assert.equal(result.failures[0]?.kind, 'rot');
    assert.match(result.failures[0]?.message ?? '', /pessimisticTokens estimator threw: estimator exploded/);
    assert.equal(result.violations[0]?.kind, 'canary_fail');
    assert.equal(result.violations[0]?.blocked, false);
    assert.equal(events.some((event) => event.type === 'rot_canary'), false, 'no rung, no observation');
  });

  it('rejects an estimator that is not a function, like any other bad config', () => {
    for (const bad of [undefined, 42, 'estimateTokens', null]) {
      assert.throws(
        () =>
          new CanaryScheduler({
            subjects,
            constraints: MIXED,
            windowTokens: WINDOW,
            pessimisticTokens: bad as unknown as (state: ContextState) => number,
            rotCases: ROT_CASES,
          }),
        CanaryConfigError,
        `pessimisticTokens: ${String(bad)}`,
      );
    }
  });
});
