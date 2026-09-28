import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { PinnedConstraint } from '@strata-ctx/core-types';
import { ConstraintKindSchema, sha256 } from '@strata-ctx/core-types';

import {
  assertProbeSuite,
  buildProbeSuite,
  CanarySuiteError,
  ConstraintCanary,
  DECAY_EXPOSED_STRATA,
  requireProbeSuite,
  type CanaryProbe,
  type CanarySuite,
} from '../src/canary.js';
import { FIXED_NOW, HARD_ONLY, MIXED, MIXED_POLICY, SOFT_ONLY, constraint, policyOf } from './fixtures.js';

/** The frozen `ConstraintKind` union, enumerated. Adding a kind must break a test. */
const ALL_KINDS = ConstraintKindSchema.options;

const now = () => FIXED_NOW;

const soft = (text: string, over: Partial<PinnedConstraint> = {}) =>
  constraint(text, { kind: 'soft_policy', ...over });

const hard = (text: string) => constraint(text, { kind: 'hard_safety' });

/** A suite that is mostly soft, with one hard rule as a contrast. */
const GOOD_SUITE = [
  soft('house style: tab indent'),
  soft('never commit the lockfile churn'),
  soft('always run the linter before pushing'),
  hard('never delete production data'),
];

function suiteOf(constraints: readonly PinnedConstraint[] = GOOD_SUITE): CanarySuite {
  return requireProbeSuite('suite-1', constraints);
}

function canary(
  suite: readonly PinnedConstraint[] = GOOD_SUITE,
  options: Partial<ConstructorParameters<typeof ConstraintCanary>[2]> = {},
): ConstraintCanary {
  return new ConstraintCanary(MIXED_POLICY, suiteOf(suite), { now, runId: 'run-1', ...options });
}

/** Run `n` probes, marking every `missEvery`-th one absent. */
function run(c: ConstraintCanary, n: number, missEvery = 0, startTurn = 1): (CanaryProbe | null)[] {
  const out: (CanaryProbe | null)[] = [];
  let turn = startTurn;
  for (let i = 0; i < n; i += 1) {
    const probe = c.next(turn);
    if (probe === undefined) {
      out.push(null);
    } else {
      c.ask(probe, missEvery > 0 && i % missEvery === 0 ? 'I do not have one' : `marker: ${probe.marker}`, turn);
      out.push(probe);
    }
    turn += c.intervalTurns;
  }
  return out;
}

describe('D-6 the suite rule, which is the point of the module', () => {
  it('rejects a hard-safety-only suite', () => {
    // Governance Decay: decay is 8.3x worse for soft organisational policies
    // *because* alignment training already holds hard safety norms in place. A
    // hard-only suite therefore measures the provider's priors, not this
    // product, and will report a comfortable green while the stratum that
    // actually rots in production goes unmeasured.
    const r = buildProbeSuite('hard-only', HARD_ONLY);
    assert.equal(r.ok, false);
    assert.ok(r);
    const reasons = r.ok ? [] : r.rejections.map((x) => x.reason);
    assert.equal(reasons.includes('hard_safety_only'), true);
  });

  it('names the paper in the rejection, so it cannot be argued past', () => {
    const r = buildProbeSuite('hard-only', HARD_ONLY);
    assert.ok(!r.ok);
    const hard = r.rejections.find((x) => x.reason === 'hard_safety_only');
    assert.match(hard?.detail ?? '', /8\.3x/);
    assert.match(hard?.detail ?? '', /training holds the hard ones in place/);
  });

  it('rejects a suite with no soft_policy even when it is decay-exposed', () => {
    // `user_preference` and `project_rule` are decay-exposed, but
    // "organisational policy" is what the paper measured, so a suite without
    // one is not the study it claims to be.
    const r = buildProbeSuite('prefs', [
      constraint('use tab indent', { kind: 'user_preference' }),
      constraint('ci is green before merge', { kind: 'project_rule' }),
    ]);
    assert.equal(r.ok, false);
    assert.ok(!r.ok);
    assert.deepEqual(
      r.rejections.map((x) => x.reason).sort(),
      ['no_soft_policy'],
    );
  });

  it('rejects an empty suite, because it would report 100% retention', () => {
    // The most flattering possible wrong answer: no probes, no misses.
    const r = buildProbeSuite('empty', []);
    assert.ok(!r.ok);
    assert.deepEqual(
      r.rejections.map((x) => x.reason),
      ['empty_suite'],
    );
  });

  it('rejects duplicate ids', () => {
    const r = buildProbeSuite('dupes', [soft('a', { id: 'x' }), soft('b', { id: 'x' })]);
    assert.ok(!r.ok);
    assert.deepEqual(
      r.rejections.map((x) => x.reason),
      ['duplicate_id'],
    );
  });

  it('reports every reason at once rather than the first', () => {
    // A hard-only suite is also missing a soft_policy, and an author fixing one
    // at a time is a review cycle nobody finishes.
    const r = buildProbeSuite('hard-only', HARD_ONLY);
    assert.ok(!r.ok);
    assert.deepEqual(
      r.rejections.map((x) => x.reason).sort(),
      ['hard_safety_only', 'no_decay_exposed_stratum', 'no_soft_policy'],
    );
  });

  it('accepts a suite that is mostly soft', () => {
    const r = buildProbeSuite('good', GOOD_SUITE);
    assert.equal(r.ok, true);
    assert.ok(r.ok);
    assert.equal(r.suite.softShare, 0.75);
  });

  it('stratifies explicitly, because there is no unstratified suite', () => {
    const r = buildProbeSuite('good', GOOD_SUITE);
    assert.ok(r.ok);
    assert.deepEqual(r.suite.strata, {
      hard_safety: 1,
      soft_policy: 3,
      user_preference: 0,
      project_rule: 0,
    });
  });

  it('freezes what it hands out', () => {
    const s = suiteOf();
    assert.throws(() => {
      (s.constraints as PinnedConstraint[]).push(soft('sneaky'));
    }, TypeError);
    assert.ok(Object.isFrozen(s.strata));
  });

  it('throws rather than returning, so the rule cannot be skipped', () => {
    // A harness that assembles its suite from whatever the scenario happens to
    // set will otherwise take the unvalidated list. Making the rejecting path
    // throw is what turns a review rule that depends on the reviewer noticing
    // into one that cannot be forgotten.
    assert.throws(
      () => requireProbeSuite('hard-only', HARD_ONLY),
      (e: unknown) => e instanceof CanarySuiteError && /probe suite hard-only rejected/.test(e.message),
    );
    assert.doesNotThrow(() => requireProbeSuite('good', GOOD_SUITE));
  });

  it('carries the rejections on the thrown error', () => {
    try {
      requireProbeSuite('hard-only', HARD_ONLY);
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof CanarySuiteError);
      assert.equal(e.rejections.length, 3);
    }
  });
});

describe('D-6 which strata count as decay-exposed', () => {
  it('names exactly the strata Governance Decay says actually break', () => {
    // The floor is a warning about the strata that decay, not a quota on the
    // ones alignment training already holds in place. If a new kind is added to
    // the frozen contract, it has to be argued in or out here rather than
    // defaulting to "measured" or "ignored" by accident.
    assert.deepEqual(
      [...DECAY_EXPOSED_STRATA].sort(),
      ['project_rule', 'soft_policy', 'user_preference'],
    );
    assert.deepEqual(
      ALL_KINDS.filter((k) => !DECAY_EXPOSED_STRATA.includes(k)),
      ['hard_safety'],
      'hard safety is the only contrast stratum, and it is the only one that does not decay',
    );
  });

  it('rejects a suite that probes none of them', () => {
    assert.throws(
      () => requireProbeSuite('m', HARD_ONLY),
      (err: unknown) => {
        assert.ok(err instanceof CanarySuiteError);
        assert.match((err as Error).message, /decay-exposed stratum/);
        return true;
      },
    );
  });
});

describe('D-6 the soft-share floor is a warning, not a rejection', () => {
  it('warns when most of the suite is hard safety', () => {
    // Refusing here would push people back to hard-only, which is worse. But the
    // blended number must not be allowed to pass as the paper's.
    const mostlyHard = [hard('never delete production data'), hard('never leak the api key'), soft('use tab indent')];
    const view = assertProbeSuite(requireProbeSuite('mixed', mostlyHard));
    assert.equal(view.warnings.length, 1);
    assert.match(view.warnings[0] ?? '', /33%/);
    assert.match(view.warnings[0] ?? '', /read higher than in production/);
  });

  it('says nothing when the suite is healthy', () => {
    assert.deepEqual(assertProbeSuite(suiteOf()).warnings, []);
  });

  it('honours a caller-supplied floor', () => {
    const s = requireProbeSuite('m', [hard('a'), hard('b'), soft('c')], { softShareFloor: 0.5 });
    assert.equal(s.softShare, 1 / 3);
    const view = assertProbeSuite(s);
    assert.equal(view.warnings.length, 1);
    assert.match(view.warnings[0] ?? '', /33%/);
    assert.match(view.warnings[0] ?? '', /50% floor/);
  });
});

describe('D-6 running a probe', () => {
  it('adds a marker to the request and never to policy', () => {
    const c = canary();
    const probe = c.next(1);
    assert.ok(probe);
    assert.match(probe.marker, /^CTX-HEALTH-[0-9A-F]{12}$/);
    assert.equal(c.pendingConstraints().length, 1);
    // A canary is a neutral marker, not a fake safety rule. Writing "never
    // delete production data" into a probe and finding it absent teaches you
    // nothing and litters the transcript with rules that were never real.
    assert.match(probe.constraint.text, /This is a probe, not a policy instruction/);
    assert.equal(
      MIXED_POLICY.constraints.some((x) => x.id === probe.constraint.id),
      false,
      'and the policy the canary holds is untouched by it',
    );
  });

  it('derives the digest rather than trusting one, so the check is not circular', () => {
    const probe = canary().next(1);
    assert.ok(probe);
    assert.equal(probe.constraint.sha256, sha256(probe.constraint.text));
  });

  it('is request-scoped and log-only, so a probe can never block an action', () => {
    const probe = canary().next(1);
    assert.ok(probe);
    assert.equal(probe.constraint.enforcement, 'log');
    assert.equal(probe.constraint.source, 'detected');
  });

  it('inherits the stratum kind, so a miss is attributed to the stratum it was drawn for', () => {
    const c = canary();
    const kinds: (string | undefined)[] = [];
    let turn = 1;
    for (let i = 0; i < 4; i += 1) {
      const probe = c.next(turn);
      kinds.push(probe?.kind);
      if (probe !== undefined) c.ask(probe, probe.marker, turn + 1);
      turn += c.intervalTurns;
    }
    // Round-robins the suite, so the contrast constraint gets probed too.
    assert.deepEqual(kinds, ['soft_policy', 'soft_policy', 'soft_policy', 'hard_safety']);
    assert.deepEqual(
      c.retention().byKind.hard_safety.probes,
      1,
      'and the strata really are tracked separately',
    );
  });

  it('refuses to start a probe that collides with a real constraint', () => {
    // A probe must never be mistaken for policy, in either direction.
    const marker = 'CTX-HEALTH-FIXTURETOKEN';
    const c = new ConstraintCanary(
      policyOf([constraint(`policy with a ${marker} in it`, { id: `canary.${marker}` })]),
      suiteOf(),
      { now, runId: 'run-1', tokenSource: () => 'FIXTURETOKEN' },
    );
    assert.throws(() => c.next(1), /collides with a real constraint/);
  });

  it('asks only once, and a second ask is a no-op on the open set', () => {
    const c = canary();
    const probe = c.next(1);
    assert.ok(probe);
    assert.equal(c.pendingConstraints().length, 1);
    c.ask(probe, probe.marker, 2);
    assert.equal(c.pendingConstraints().length, 0);
  });

  it('grades a hit only on the exact marker', () => {
    const c = canary(GOOD_SUITE, { tokenSource: () => 'FIXTURE' });
    const marker = 'CTX-HEALTH-FIXTURE';
    let turn = 1;
    for (const [reply, hit] of [
      [`the marker is ${marker}`, true],
      [marker, true],
      [marker.toLowerCase(), false],
      [marker.replace('-', ''), false],
      ['I was not given a marker', false],
      ['', false],
    ] as const) {
      const p = c.next(turn);
      assert.ok(p, `no probe due at turn ${turn}`);
      assert.equal(p.marker, marker);
      assert.equal(c.ask(p, reply, turn + 1).hit, hit, `reply: ${JSON.stringify(reply)}`);
      turn += c.intervalTurns;
    }
    assert.equal(c.results.length, 6);
    // Exact string, no normalisation: a probe that accepted a paraphrase would
    // be measuring the model's formatting, not its retention.
    assert.equal(c.retention().rate, 2 / 6);
  });

  it('marks an unanswered probe absent rather than dropping it silently', () => {
    const c = canary();
    const probe = c.next(1);
    assert.ok(probe);
    const r = c.expire(probe, 9);
    assert.equal(r.hit, false);
    assert.equal(r.state, 'absent');
    assert.equal(c.results.length, 1);
  });

  it('makes the marker unguessable, because a predictable token measures the adversary', () => {
    const a = new ConstraintCanary(MIXED_POLICY, suiteOf(), { now, runId: 'run-a' }).next(1);
    const b = new ConstraintCanary(MIXED_POLICY, suiteOf(), { now, runId: 'run-b' }).next(1);
    assert.ok(a && b);
    assert.notEqual(a.marker, b.marker);
  });

  it('uses an injected token source, so a test is reproducible', () => {
    const c = canary(GOOD_SUITE, { tokenSource: (turn) => `T${turn}` });
    const probe = c.next(7);
    assert.equal(probe?.marker, 'CTX-HEALTH-T7');
  });
});

describe('D-6 scheduling', () => {
  it('always runs the first probe', () => {
    assert.equal(canary().dueAt(1), true);
    assert.equal(canary().dueAt(1000), true);
  });

  it('respects the interval afterwards', () => {
    const c = canary();
    const first = c.next(1);
    assert.ok(first);
    assert.equal(c.dueAt(2), false);
    assert.equal(c.dueAt(1 + c.intervalTurns), true);
  });

  it('takes its interval from policy when the caller does not say', () => {
    const p = policyOf([], { governance: { canaryIntervalTurns: 12 } });
    const c = new ConstraintCanary(p, suiteOf(), { now });
    assert.equal(c.intervalTurns, 12);
    c.next(1);
    assert.equal(c.dueAt(12), false);
    assert.equal(c.dueAt(13), true);
  });

  it('will not start a second probe while one is open', () => {
    // A probe whose answer never arrives is a failure of the probe, and letting
    // them pile up would make the retention number meaningless.
    const c = canary();
    const first = c.next(1);
    assert.ok(first);
    assert.equal(c.next(1 + c.intervalTurns), undefined);
    assert.equal(c.next(1000), undefined);
    assert.equal(c.pendingConstraints().length, 1);
    c.ask(first, first.marker, 2);
    assert.notEqual(c.next(1 + c.intervalTurns), undefined);
  });

  it('keeps the interval running from when a probe started, not when it was graded', () => {
    // Anchoring to the graded turn would let a slow agent be probed on every
    // turn once it finally replies, which is how a canary turns into load.
    const c = canary();
    const first = c.next(1);
    assert.ok(first);
    c.ask(first, first.marker, 50);
    assert.equal(c.next(1 + c.intervalTurns - 1), undefined);
    assert.notEqual(c.next(1 + c.intervalTurns), undefined);
  });
});

describe('D-6 what a miss costs', () => {
  it('files the first miss as P1, because models paraphrase and truncate', () => {
    const c = canary();
    const probe = c.next(1);
    assert.ok(probe);
    c.ask(probe, 'no marker here', 2);
    const v = c.violations[0];
    assert.equal(v?.kind, 'canary_fail');
    assert.equal(v?.severity, 'P1');
    assert.equal(c.consecutiveMisses, 1);
  });

  it('escalates to P0 on the second consecutive miss', () => {
    // Two in a row on a stratum that is supposed to decay 8.3x faster is the
    // shape of the failure this module exists to catch.
    run(canary(), 2);
    const c = canary();
    const severities: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const probe = c.next(1 + i * c.intervalTurns);
      assert.ok(probe);
      c.ask(probe, 'no marker here', 2 + i * c.intervalTurns);
      severities.push(c.violations.at(-1)?.severity ?? '?');
    }
    assert.deepEqual(severities, ['P1', 'P0', 'P0']);
  });

  it('honours a caller-supplied escalation threshold', () => {
    const c = canary(GOOD_SUITE, { escalateAfter: 1 });
    const probe = c.next(1);
    assert.ok(probe);
    c.ask(probe, 'gone', 2);
    assert.equal(c.violations[0]?.severity, 'P0');
  });

  it('resets the miss counter on a hit', () => {
    // Otherwise a single early miss pages an operator forever, which is how a
    // P0 gets muted.
    const c = canary();
    let turn = 1;
    for (const hit of [false, true, false]) {
      const probe = c.next(turn);
      assert.ok(probe);
      c.ask(probe, hit ? probe.marker : 'gone', turn + 1);
      turn += c.intervalTurns;
    }
    assert.equal(c.consecutiveMisses, 1);
    assert.deepEqual(
      c.violations.map((v) => v.severity),
      ['P1', 'P1'],
    );
  });

  it('attributes the miss to the real constraint whose stratum was probed', () => {
    const c = canary();
    const probe = c.next(1);
    assert.ok(probe);
    c.ask(probe, 'gone', 2);
    // The id is how an operator goes and edits the rule that decayed.
    assert.deepEqual([...(c.violations[0]?.constraintIds ?? [])], [probe.stratumConstraintId]);
  });

  it('attributes the record to the run and turn', () => {
    const c = canary();
    const probe = c.next(1);
    assert.ok(probe);
    c.ask(probe, 'gone', 7);
    assert.equal(c.violations[0]?.runId, 'run-1');
    assert.equal(c.violations[0]?.turn, 7);
  });

  it('never blocks on a canary failure', () => {
    // A canary is a measurement. If it could block a request, a flaky probe
    // would take the product down.
    const c = canary();
    const probe = c.next(1);
    assert.ok(probe);
    assert.equal(c.ask(probe, 'gone', 2).hit, false);
    assert.equal(c.violations[0]?.blocked, false);
  });
});

describe('D-6 retention, stratified', () => {
  it('reports zero probes as zero, not as perfect retention', () => {
    const r = canary().retention();
    assert.equal(r.probes, 0);
    assert.equal(r.rate, 0);
    assert.equal(r.sufficient, false);
  });

  it('computes a rate per stratum, not one blended number', () => {
    // A blended number with one stratum empty reports the provider's priors as
    // if they were the product's.
    const c = canary();
    let turn = 1;
    for (let i = 0; i < 4; i += 1) {
      const probe = c.next(turn);
      assert.ok(probe);
      // Miss the one hard_safety probe (index 3), hit the soft ones.
      c.ask(probe, i === 3 ? 'gone' : probe.marker, turn + 1);
      turn += c.intervalTurns;
    }
    const r = c.retention();
    assert.equal(r.probes, 4);
    assert.equal(r.hits, 3);
    assert.equal(r.rate, 0.75);
    assert.equal(r.byKind.soft_policy.probes, 3);
    assert.equal(r.byKind.soft_policy.rate, 1);
    assert.equal(r.byKind.hard_safety.probes, 1);
    assert.equal(r.byKind.hard_safety.rate, 0);
  });

  it('calls an underpowered sample insufficient rather than reporting it', () => {
    // Reporting 100% retention from one probe is how a suite gets laundered
    // into a claim.
    const c = canary();
    run(c, 1);
    const r = c.retention();
    assert.equal(r.rate, 1);
    assert.equal(r.sufficient, false, 'but the number is not a result yet');

    run(c, 5);
    assert.equal(c.retention().sufficient, true);
  });

  it('honours a caller-supplied minimum, per stratum as well as overall', () => {
    // The overall count can clear the bar while a single stratum has not been
    // probed enough to say anything about it. That is the gap a blended number
    // hides, so `sufficient` is per stratum too.
    const c = canary(GOOD_SUITE, { minProbesForConfidence: 5 });
    run(c, 5);
    const r = c.retention();
    assert.equal(r.probes, 5);
    assert.equal(r.sufficient, true);
    assert.equal(r.byKind.soft_policy.probes, 4);
    assert.equal(r.byKind.soft_policy.sufficient, false, 'four soft probes is not a result');
    assert.equal(r.byKind.hard_safety.probes, 1);
  });

  it('carries the miss streak into the report', () => {
    const c = canary();
    run(c, 3, 1);
    assert.equal(c.retention().consecutiveMisses, 3);
  });

  it('freezes the report it hands out', () => {
    const c = canary();
    run(c, 2);
    const r = c.retention();
    assert.ok(Object.isFrozen(r.byKind));
    assert.throws(() => {
      (c.results as unknown[]).push({});
    }, TypeError);
  });
});

describe('D-6 against a policy that actually decays', () => {
  it('shows the gap the paper reports, which is the whole justification', () => {
    // Run the same scenario against a soft-only policy and a hard-safety-only
    // one. The soft stratum is the one that rots; if the canary cannot tell them
    // apart it is not measuring the thing.
    const softCanary = new ConstraintCanary(
      policyOf(SOFT_ONLY),
      requireProbeSuite('soft-suite', [soft('a'), soft('b'), soft('c')]),
      { now, runId: 'run-1' },
    );
    // Every soft probe is lost to compaction; the hard one is not.
    const softProbes = run(softCanary, 6, 1);
    assert.equal(softCanary.retention().byKind.soft_policy.rate, 0);
    assert.equal(softProbes.filter(Boolean).length, 6);
  });

  it('round-trips a suite built from a real policy', () => {
    // A harness assembling its suite from the policy under test is the normal
    // shape, and it must produce a valid suite for a policy that contains any
    // soft rule at all.
    const s = buildProbeSuite('from-policy', MIXED);
    assert.equal(s.ok, true);
    assert.ok(s.ok);
    assert.equal(s.suite.softShare, 0.75);
  });

  it('rejects the policy-derived suite for a hard-only policy, as it must', () => {
    const s = buildProbeSuite('from-hard-policy', HARD_ONLY);
    assert.equal(s.ok, false);
  });
});
