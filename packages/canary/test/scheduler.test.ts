import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PinnedConstraint } from '@strata-ctx/core-types';
import { sha256 } from '@strata-ctx/core-types';

import {
  CANARY_VIOLATION_KINDS,
  CanaryConfigError,
  CanaryScheduler,
  DEFAULT_CANARY_CONFIG,
  assertCanaryConfig,
  canaryProbeId,
  isProbeTurn,
  nextProbeTurn,
  type CanaryTelemetryEvent,
  type RotProbeCase,
} from '../src/index.js';

/**
 * Fixtures are local by rule P2: this file imports no other package's test
 * directory, so a change to governance's fixtures cannot break these tests.
 *
 * `soft_policy` is the default kind, matching the reason governance makes it the
 * default too: the kind that alignment training already holds in place would
 * flatter every result, so a fixture that defaulted to `hard_safety` would test
 * the one stratum that never decays.
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

const HARD_ONLY: readonly PinnedConstraint[] = Object.freeze([constraint('safety.delete', 'hard_safety')]);

/** Two cases: one rot case to score, one NIAH case to control it. */
const ROT_CASES: readonly RotProbeCase[] = Object.freeze([
  { id: 'rot-1', prompt: 'What was the deploy token?', correctAnswer: 'hunter2', niah: false },
  { id: 'niah-1', prompt: 'What was the needle?', correctAnswer: 'needle', niah: true },
]);

const WINDOW = 200_000;

/** A subject that retains everything and answers the rot cases correctly. */
const goodSubjects = {
  constraint: {
    id: 'test-constraint',
    probeConstraints: () => Promise.resolve({ retainedConstraintIds: ['safety.delete', 'soft.client-email', 'pref.legacy-adapter'] }),
  },
  rot: {
    id: 'test-rot',
    answerRot: () =>
      Promise.resolve([
        { caseId: 'rot-1', answer: 'hunter2' },
        { caseId: 'niah-1', answer: 'needle' },
      ]),
  },
} as const;

const rotCasesFor = (constraints: readonly PinnedConstraint[]) =>
  new CanaryScheduler({
    subjects: goodSubjects,
    constraints,
    windowTokens: WINDOW,
    rotCases: ROT_CASES,
    runId: 'run-1',
    emit: () => undefined,
  });

describe('cadence — turn 0 is not a probe turn', () => {
  it('fires on multiples of the interval, and never on turn 0', () => {
    assert.equal(isProbeTurn(0, 25), false, 'turn 0 is before any compaction has run');
    assert.equal(isProbeTurn(25, 25), true);
    assert.equal(isProbeTurn(50, 25), true);
    assert.equal(isProbeTurn(75, 25), true);
    assert.equal(isProbeTurn(24, 25), false);
    assert.equal(isProbeTurn(50, 50), true, 'rot cadence');
    assert.equal(isProbeTurn(100, 50), true);
  });

  it('rejects a turn that cannot exist and an interval that can never fire', () => {
    assert.throws(() => isProbeTurn(-1, 25), CanaryConfigError);
    assert.throws(() => isProbeTurn(1.5, 25), CanaryConfigError);
    assert.throws(() => isProbeTurn(25, 0), CanaryConfigError);
  });

  it('computes the next firing strictly after a turn', () => {
    assert.equal(nextProbeTurn(0, 25), 25);
    assert.equal(nextProbeTurn(24, 25), 25);
    assert.equal(nextProbeTurn(25, 25), 50);
    assert.equal(nextProbeTurn(26, 50), 50);
  });

  it('derives the probe id from the turn, so it is replayable', () => {
    assert.equal(canaryProbeId('constraint', 25), 'canary.constraint@25');
    assert.equal(canaryProbeId('rot', 50), 'canary.rot@50');
    assert.equal(canaryProbeId('rot', 50), canaryProbeId('rot', 50));
  });
});

describe('config defaults and validation', () => {
  it('matches docs/integrations.md §8', () => {
    assert.deepEqual(DEFAULT_CANARY_CONFIG, {
      constraintProbe: { enabled: true, intervalTurns: 25 },
      rotProbe: { enabled: true, intervalTurns: 50 },
      includeSoftOrgPolicies: true,
    });
  });

  it('rejects an interval that would silently never probe', () => {
    assert.throws(
      () => assertCanaryConfig({ ...DEFAULT_CANARY_CONFIG, constraintProbe: { enabled: true, intervalTurns: 0 } }),
      CanaryConfigError,
    );
    assert.throws(
      () => assertCanaryConfig({ ...DEFAULT_CANARY_CONFIG, rotProbe: { enabled: true, intervalTurns: 2.5 } }),
      CanaryConfigError,
    );
  });

  it('rejects a non-positive window rather than mis-placing every rot tier', () => {
    assert.throws(
      () =>
        new CanaryScheduler({
          subjects: goodSubjects,
          constraints: MIXED,
          windowTokens: 0,
          rotCases: ROT_CASES,
        }),
      CanaryConfigError,
    );
  });
});

describe('dueAt — which probes run on a turn', () => {
  it('constraint alone at 25, both at 50, neither at 0', () => {
    const scheduler = rotCasesFor(MIXED);
    assert.deepEqual(scheduler.dueAt(25), ['constraint']);
    assert.deepEqual(scheduler.dueAt(50), ['constraint', 'rot']);
    assert.deepEqual(scheduler.dueAt(0), []);
    assert.deepEqual(scheduler.dueAt(10), []);
  });

  it('honours the disable switches independently', () => {
    const noConstraint = new CanaryScheduler({
      subjects: goodSubjects,
      constraints: MIXED,
      windowTokens: WINDOW,
      rotCases: ROT_CASES,
      config: { ...DEFAULT_CANARY_CONFIG, constraintProbe: { enabled: false, intervalTurns: 25 } },
    });
    assert.deepEqual(noConstraint.dueAt(25), []);
    assert.deepEqual(noConstraint.dueAt(50), ['rot']);

    const noRot = new CanaryScheduler({
      subjects: goodSubjects,
      constraints: MIXED,
      windowTokens: WINDOW,
      rotCases: ROT_CASES,
      config: { ...DEFAULT_CANARY_CONFIG, rotProbe: { enabled: false, intervalTurns: 50 } },
    });
    assert.deepEqual(noRot.dueAt(50), ['constraint']);
  });
});

describe('runTurn — the quiet path', () => {
  it('probes nothing and emits nothing off-cadence', async () => {
    const events: CanaryTelemetryEvent[] = [];
    const scheduler = new CanaryScheduler({
      subjects: goodSubjects,
      constraints: MIXED,
      windowTokens: WINDOW,
      rotCases: ROT_CASES,
      emit: (event) => events.push(event),
    });
    const result = await scheduler.runTurn({ turn: 1, tokenEstimate: 1000 });
    assert.equal(result.probed, false);
    assert.deepEqual(result.probes, []);
    assert.deepEqual(result.violations, []);
    assert.deepEqual(events, []);
  });

  it('emits a frozen canary event and no violation when everything is retained', async () => {
    const events: CanaryTelemetryEvent[] = [];
    const scheduler = new CanaryScheduler({
      subjects: goodSubjects,
      constraints: MIXED,
      windowTokens: WINDOW,
      rotCases: ROT_CASES,
      emit: (event) => events.push(event),
    });
    const result = await scheduler.runTurn({ turn: 25, tokenEstimate: WINDOW / 4 });
    assert.equal(result.probed, true);
    assert.deepEqual(result.violations, []);
    assert.equal(result.probes.length, 1);
    assert.equal(result.probes[0]?.kind, 'constraint');
    assert.deepEqual(events, [
      { type: 'canary', probeId: canaryProbeId('constraint', 25), kind: 'constraint', arm: 'treatment', score: 1, passed: true },
    ]);
  });

  it('emits canary_fail when a constraint is dropped', async () => {
    const events: CanaryTelemetryEvent[] = [];
    const scheduler = new CanaryScheduler({
      subjects: {
        ...goodSubjects,
        constraint: {
          id: 'partial',
          probeConstraints: () => Promise.resolve({ retainedConstraintIds: ['safety.delete'] }),
        },
      },
      constraints: MIXED,
      windowTokens: WINDOW,
      rotCases: ROT_CASES,
      emit: (event) => events.push(event),
    });
    const result = await scheduler.runTurn({ turn: 25, tokenEstimate: 0 });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0]?.kind, 'canary_fail');
    assert.equal(result.violations[0]?.blocked, false, 'a canary must never block the turn');
    assert.deepEqual(result.violations[0]?.constraintIds, ['pref.legacy-adapter', 'soft.client-email']);
    const violationEvent = events.find((event) => event.type === 'violation');
    assert.deepEqual(violationEvent, {
      type: 'violation',
      runId: 'unknown-run',
      kind: 'canary_fail',
      constraintIds: ['pref.legacy-adapter', 'soft.client-email'],
      blocked: false,
    });
  });
});

describe('fail-open — a throwing probe costs a telemetry line and nothing else', () => {
  it('resolves instead of rejecting, and records canary_fail', async () => {
    const scheduler = new CanaryScheduler({
      subjects: {
        constraint: { id: 'boom', probeConstraints: () => Promise.reject(new Error('subject exploded')) },
        rot: goodSubjects.rot,
      },
      constraints: MIXED,
      windowTokens: WINDOW,
      rotCases: ROT_CASES,
    });
    const result = await scheduler.runTurn({ turn: 25, tokenEstimate: 0 });
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]?.kind, 'constraint');
    assert.match(result.failures[0]?.message ?? '', /subject exploded/);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0]?.kind, 'canary_fail');
    assert.equal(scheduler.failures.length, 1);
    assert.equal(scheduler.violations.length, 1);
  });

  it('treats a missing subject as broken, not as a skipped probe', async () => {
    const scheduler = new CanaryScheduler({
      subjects: {},
      constraints: MIXED,
      windowTokens: WINDOW,
      rotCases: ROT_CASES,
    });
    const result = await scheduler.runTurn({ turn: 50, tokenEstimate: 0 });
    assert.equal(result.failures.length, 2, 'constraint and rot both report the missing subject');
    assert.equal(result.violations.length, 2);
  });

  it('does not let a throwing emit reject the turn', async () => {
    const scheduler = new CanaryScheduler({
      subjects: goodSubjects,
      constraints: MIXED,
      windowTokens: WINDOW,
      rotCases: ROT_CASES,
      emit: () => {
        throw new Error('sink is down');
      },
    });
    await assert.doesNotReject(scheduler.runTurn({ turn: 25, tokenEstimate: 0 }));
  });
});

describe('the false green — hard-norms-only is surfaced, not passed', () => {
  it('reports canary_fail when every probed constraint is hard_safety', async () => {
    const scheduler = new CanaryScheduler({
      subjects: {
        ...goodSubjects,
        constraint: {
          id: 'hard-only',
          probeConstraints: () => Promise.resolve({ retainedConstraintIds: ['safety.delete'] }),
        },
      },
      constraints: HARD_ONLY,
      windowTokens: WINDOW,
      rotCases: ROT_CASES,
    });
    const result = await scheduler.runTurn({ turn: 25, tokenEstimate: 0 });
    assert.equal(result.violations.length, 1, 'a green here would be measuring the provider priors');
    assert.match(result.violations[0]?.detail ?? '', /hard_safety/);
  });

  it('surfaces hard_norms_only when the flag withheld every soft constraint', async () => {
    const scheduler = new CanaryScheduler({
      subjects: goodSubjects,
      constraints: MIXED,
      windowTokens: WINDOW,
      rotCases: ROT_CASES,
      config: { ...DEFAULT_CANARY_CONFIG, includeSoftOrgPolicies: false },
    });
    const result = await scheduler.runTurn({ turn: 25, tokenEstimate: 0 });
    // With the flag off, the only constraint left is hard_safety, so the firing
    // cannot see the 8.3x decay and must not read as a pass.
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0]?.detail ?? '', /hard_safety|include_soft_org_policies/);
  });
});

describe('rot telemetry — the §8 rot_canary shape', () => {
  it('emits the literal field names score and atFracOfWindow', async () => {
    const events: CanaryTelemetryEvent[] = [];
    const scheduler = new CanaryScheduler({
      subjects: goodSubjects,
      constraints: MIXED,
      windowTokens: WINDOW,
      rotCases: ROT_CASES,
      runId: 'run-rot',
      emit: (event) => events.push(event),
    });
    await scheduler.runTurn({ turn: 50, tokenEstimate: WINDOW / 2 });
    const rot = events.find((event) => event.type === 'rot_canary');
    assert.ok(rot !== undefined, 'the rot probe must emit a rot_canary record');
    assert.deepEqual(Object.keys(rot).sort(), ['atFracOfWindow', 'probeId', 'runId', 'score', 'tier', 'turn', 'type'].sort());
    assert.equal(rot.score, 1);
    assert.equal(rot.atFracOfWindow, 0.5);
    assert.equal(rot.tier, 't50', 'half a window is the t50 point on the §E2 ladder');
  });

  it('clamps an over-budget fill to the top of the ladder', async () => {
    const events: CanaryTelemetryEvent[] = [];
    const scheduler = new CanaryScheduler({
      subjects: goodSubjects,
      constraints: MIXED,
      windowTokens: WINDOW,
      rotCases: ROT_CASES,
      emit: (event) => events.push(event),
    });
    await scheduler.runTurn({ turn: 50, tokenEstimate: WINDOW * 3 });
    const rot = events.find((event) => event.type === 'rot_canary');
    assert.equal(rot?.atFracOfWindow, 1);
    assert.equal(rot?.tier, 't80');
  });
});

describe('the three violation names are the frozen ones', () => {
  it('lists them verbatim', () => {
    assert.deepEqual([...CANARY_VIOLATION_KINDS], [
      'pin_missing_pre_apply',
      'pin_post_compact_missing',
      'canary_fail',
    ]);
  });
});
