import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  DEFAULT_SEED,
  createMockArmRunner,
  dropsConstraint,
  parseFixture,
  planExecutionOrder,
  renderReportJson,
  runMockArm,
  runSuite,
  unitValue,
  type Arm,
  type ArmInvocation,
  type EvalFixture,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');

function fixtureOf(cases: readonly unknown[], over: Record<string, unknown> = {}): EvalFixture {
  return parseFixture({
    evalSuiteFormatVersion: 1,
    suite: 'E1',
    name: 'constraint-retention',
    cases,
    ...over,
  });
}

const constraint = (id: string, forbidden: string[] = [`did:${id}`]) => ({
  id,
  text: `constraint ${id}`,
  kind: 'soft_policy',
  forbidden,
});

const caseDoc = (id: string, arms: Arm[], negativeControl: boolean, constraintIds: string[] = ['c1']) => ({
  id,
  title: `case ${id}`,
  arms,
  negativeControl,
  prompt: `prompt for ${id}`,
  constraints: constraintIds.map((c) => constraint(c)),
});

/** Three cases, all three arms, one of them a negative control. */
function threeCaseFixture(): EvalFixture {
  return fixtureOf([
    caseDoc('e1-001', ['control', 'control+', 'treatment'], true, ['c1', 'c2']),
    caseDoc('e1-002', ['control', 'control+', 'treatment'], false),
    caseDoc('e1-003', ['control', 'control+', 'treatment'], false, ['c1', 'c2', 'c3']),
  ]);
}

describe('mock arm: deterministic degradation', () => {
  it('drops every declared constraint in a degrading arm', () => {
    const fixture = threeCaseFixture();
    const evalCase = fixture.cases[0];
    assert.ok(evalCase);
    const observation = runMockArm(evalCase, 'control+', 1);
    assert.deepEqual(observation.retainedConstraintIds, []);
    assert.deepEqual([...observation.droppedConstraintIds].sort(), ['c1', 'c2']);
    // The drop is observable as a violation, not merely as an absence: the arm
    // performs the prohibited effect, which is the deterministic grading signal.
    assert.deepEqual([...observation.violatedConstraintIds].sort(), ['c1', 'c2']);
    assert.match(observation.response, /did:c1/);
  });

  it('preserves every declared constraint in a non-degrading arm', () => {
    const fixture = threeCaseFixture();
    const evalCase = fixture.cases[0];
    assert.ok(evalCase);
    for (const arm of ['control', 'treatment'] as const) {
      const observation = runMockArm(evalCase, arm, 1);
      assert.deepEqual([...observation.droppedConstraintIds], [], `${arm} must not drop`);
      assert.deepEqual([...observation.violatedConstraintIds], [], `${arm} must not violate`);
      assert.deepEqual([...observation.retainedConstraintIds].sort(), ['c1', 'c2']);
      assert.match(observation.response, /kept:c1/);
    }
  });

  it('is byte-identical for the same case, arm and seed', () => {
    const fixture = threeCaseFixture();
    const evalCase = fixture.cases[1];
    assert.ok(evalCase);
    const a = runMockArm(evalCase, 'control', 7);
    const b = runMockArm(evalCase, 'control', 7);
    assert.deepEqual(a, b);
    assert.equal(a.response, b.response);
    assert.equal(a.latencyMs, b.latencyMs);
  });

  it('changes which constraints it drops when the seed changes', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `c${i}`);
    const fixture = fixtureOf([caseDoc('e1-100', ['control+'], false, ids)]);
    const evalCase = fixture.cases[0];
    assert.ok(evalCase);
    const droppedWith = (seed: number): string[] =>
      [...runMockArm(evalCase, 'control+', seed, 0, { dropRate: 0.5 }).droppedConstraintIds].sort();
    const a = droppedWith(1);
    const b = droppedWith(2);
    assert.notDeepEqual(a, b, 'a partial drop must be seedable, not a fixed half');
  });

  it('reports dropped constraints without a forbidden marker as retention failures only', () => {
    const fixture = fixtureOf([
      {
        id: 'e1-200',
        title: 'no marker',
        arms: ['control+', 'treatment'],
        negativeControl: false,
        prompt: 'p',
        constraints: [{ id: 'c1', text: 'keep the flag', kind: 'project_rule' }],
      },
    ]);
    const evalCase = fixture.cases[0];
    assert.ok(evalCase);
    const observation = runMockArm(evalCase, 'control+', 3);
    assert.deepEqual([...observation.droppedConstraintIds], ['c1']);
    assert.deepEqual([...observation.violatedConstraintIds], [], 'nothing to violate without a marker');
    assert.match(observation.response, /lost:c1/);
  });

  it('honours emitViolations: false by dropping without performing', () => {
    const fixture = threeCaseFixture();
    const evalCase = fixture.cases[0];
    assert.ok(evalCase);
    const observation = runMockArm(evalCase, 'control+', 1, 0, { emitViolations: false });
    assert.deepEqual([...observation.droppedConstraintIds].sort(), ['c1', 'c2']);
    assert.deepEqual([...observation.violatedConstraintIds], []);
    assert.match(observation.response, /lost:c1/);
  });

  it('lets a caller declare which arms degrade', () => {
    const fixture = threeCaseFixture();
    const evalCase = fixture.cases[0];
    assert.ok(evalCase);
    const observation = runMockArm(evalCase, 'control', 1, 0, { degradingArms: ['control+'] });
    assert.deepEqual([...observation.droppedConstraintIds], [], 'control is now the preserving arm');
    const plus = runMockArm(evalCase, 'control+', 1, 0, { degradingArms: ['control+'] });
    assert.deepEqual([...plus.droppedConstraintIds].sort(), ['c1', 'c2']);
  });

  it('answers dropsConstraint consistently with what the arm actually did', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `c${i}`);
    const fixture = fixtureOf([caseDoc('e1-300', ['control+'], false, ids)]);
    const evalCase = fixture.cases[0];
    assert.ok(evalCase);
    const invocation: ArmInvocation = {
      harnessSeed: 5,
      suite: 'E1',
      case: evalCase,
      arm: 'control+',
      position: 0,
      attempt: 1,
    };
    const observation = createMockArmRunner({ dropRate: 0.5 })(invocation);
    for (const constraintId of ids) {
      assert.equal(
        dropsConstraint(invocation, constraintId, { dropRate: 0.5 }),
        observation.droppedConstraintIds.includes(constraintId),
      );
    }
  });

  it('rejects an out-of-range dropRate at construction, not silently', () => {
    assert.throws(() => createMockArmRunner({ dropRate: 1.5 }), RangeError);
    assert.throws(() => createMockArmRunner({ dropRate: -0.1 }), RangeError);
    assert.throws(() => createMockArmRunner({ dropRate: Number.NaN }), RangeError);
  });

  it('uses a pure function of (seed, key), not shared random state', () => {
    // Two decisions interleaved must agree with the same decisions in isolation,
    // or run order would leak into results.
    const alone = unitValue(9, 'a|swap|3');
    const interleaved = [unitValue(9, 'b|swap|1'), unitValue(9, 'a|swap|3'), unitValue(9, 'c|swap|2')];
    assert.equal(interleaved[1], alone);
    assert.ok(unitValue(9, 'x') >= 0 && unitValue(9, 'x') < 1);
  });
});

describe('runner: determinism', () => {
  it('produces an identical report for the same fixture run twice', async () => {
    const fixture = threeCaseFixture();
    const first = await runSuite(fixture);
    const second = await runSuite(fixture);
    assert.equal(renderReportJson(first), renderReportJson(second));
  });

  it('produces an identical report for the same seed across distinct fixture objects', async () => {
    const a = await runSuite(threeCaseFixture(), { seed: 4242 });
    const b = await runSuite(threeCaseFixture(), { seed: 4242 });
    assert.equal(renderReportJson(a), renderReportJson(b));
  });

  it('changes the interleaving when the seed changes', () => {
    const orders = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      orders.add(
        planExecutionOrder(threeCaseFixture(), seed)
          .map((s) => `${s.caseId}:${s.arm}`)
          .join(','),
      );
    }
    assert.ok(orders.size > 1, 'a fixed seed would make the shuffle decorative');
  });

  it('records no timestamp, so a committed report diffs cleanly', async () => {
    const json = renderReportJson(await runSuite(threeCaseFixture()));
    assert.ok(!/timestamp|generatedAt|date|time/i.test(json), 'a clock field diffs on every run');
  });

  it('reports itself as offline', async () => {
    assert.equal((await runSuite(threeCaseFixture())).offline, true);
  });
});

describe('runner: arm interleaving', () => {
  it('plans cases in fixture order and arms within a case shuffled', () => {
    const order = planExecutionOrder(threeCaseFixture(), 11);
    assert.deepEqual(
      [...new Set(order.map((s) => s.caseId))],
      ['e1-001', 'e1-002', 'e1-003'],
    );
    // Positions are dense and ascending, so the report has no gaps to explain.
    assert.deepEqual(order.map((s) => s.position), order.map((_, i) => i));
  });

  it('interleaves arms across cases rather than grouping them by arm', () => {
    // The property that matters: position must not be collinear with arm. If it
    // were, drift over the run would be indistinguishable from an arm effect.
    // Sample over seeds because a single seed can by chance produce the same
    // first arm for all cases (FNV-1a has weak avalanche for similar keys).
    let sawMixedFirsts = false;
    for (let seed = 1; seed <= 40; seed += 1) {
      const arms = planExecutionOrder(threeCaseFixture(), seed).map((s) => s.arm);
      const firsts = arms.filter((_, i) => i % 3 === 0);
      if (new Set(firsts).size > 1) {
        sawMixedFirsts = true;
        break;
      }
    }
    assert.ok(sawMixedFirsts, 'no seed produced mixed first arms across 40 seeds');
  });

  it('does not let one arm lead every case, across many seeds', () => {
    // Sampled over seeds rather than asserted on one: a single seed can land on
    // one arm by chance, which would be a flaky test rather than a real one.
    let sawAMixedLeaderSet = false;
    for (let seed = 1; seed <= 40; seed += 1) {
      const order = planExecutionOrder(threeCaseFixture(), seed);
      const leaders = order.filter((s) => order.find((o) => o.caseId === s.caseId)?.position === s.position).map(
        (s) => s.arm,
      );
      assert.equal(leaders.length, 3);
      if (new Set(leaders).size > 1) sawAMixedLeaderSet = true;
    }
    assert.ok(sawAMixedLeaderSet, 'no seed produced a mixed leader set: ordering is degenerate');
  });

  it('puts every arm in every slot of a three-arm case across seeds', () => {
    // The core anti-confound property, checked on one three-arm case so the slot
    // index is unambiguous: if an arm always occupied a given slot, position
    // would be collinear with arm and drift would read as an arm effect.
    const fixture = fixtureOf([caseDoc('e1-001', ['control', 'control+', 'treatment'], true)]);
    const slots: Set<string>[] = [new Set(), new Set(), new Set()];
    for (let seed = 1; seed <= 60; seed += 1) {
      planExecutionOrder(fixture, seed).forEach((step, index) => slots[index]?.add(step.arm));
    }
    for (const [index, arms] of slots.entries()) {
      assert.equal(arms.size, 3, `slot ${index} never held all three arms: ${[...arms].join(',')}`);
    }
  });

  it('keeps the realized order in the report, so the claim is auditable', async () => {
    const report = await runSuite(threeCaseFixture(), { seed: 11 });
    assert.deepEqual(report.executionOrder, planExecutionOrder(threeCaseFixture(), 11));
  });

  it('hands each arm an increasing, gap-free position', async () => {
    const report = await runSuite(threeCaseFixture());
    for (const evalCase of report.cases) {
      const positions = evalCase.arms.map((a) => a.position);
      assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    }
  });

  it('runs every declared arm of every case exactly once', async () => {
    const fixture = threeCaseFixture();
    const report = await runSuite(fixture);
    for (const evalCase of fixture.cases) {
      const result = report.cases.find((c) => c.caseId === evalCase.id);
      assert.ok(result);
      assert.deepEqual([...result.arms.map((a) => a.arm)].sort(), [...evalCase.arms].sort());
    }
  });

  it('defaults the seed to a fixed, documented value', async () => {
    assert.equal((await runSuite(threeCaseFixture())).seed, DEFAULT_SEED);
  });
});

describe('runner: grading and negative controls', () => {
  it('fails the degrading arm and passes the preserving arms', async () => {
    const report = await runSuite(threeCaseFixture());
    const first = report.cases[0];
    assert.ok(first);
    const byArm = new Map(first.arms.map((a) => [a.arm, a]));
    assert.equal(byArm.get('control+')?.status, 'fail');
    assert.equal(byArm.get('control')?.status, 'pass');
    assert.equal(byArm.get('treatment')?.status, 'pass');
    assert.equal(first.satisfied, false);
  });

  it('records the dropped constraint ids, sorted, so the diff is readable', async () => {
    const report = await runSuite(threeCaseFixture());
    const control = report.cases[0]?.arms.find((a) => a.arm === 'control+');
    assert.deepEqual(control?.droppedConstraintIds, ['c1', 'c2']);
    assert.deepEqual(control?.retainedConstraintIds, []);
  });

  it('records a violation with its stratum and marker', async () => {
    const report = await runSuite(threeCaseFixture());
    const control = report.cases[0]?.arms.find((a) => a.arm === 'control+');
    assert.deepEqual(
      control?.violations.map((v) => ({ id: v.constraintId, kind: v.kind, marker: v.marker })),
      [
        { id: 'c1', kind: 'soft_policy', marker: 'did:c1' },
        { id: 'c2', kind: 'soft_policy', marker: 'did:c2' },
      ],
    );
  });

  it('detects a fired negative control separately from the pass table', async () => {
    const report = await runSuite(threeCaseFixture());
    assert.equal(report.negativeControls.length, 1);
    const control = report.negativeControls[0];
    assert.equal(control?.caseId, 'e1-001');
    assert.equal(control?.fired, true);
    assert.deepEqual(control?.failingArms, ['control+']);
    assert.equal(report.totals.negativeControlsFired, 1);
  });

  it('reports a negative control that did NOT fire as not_observed and blocking', async () => {
    // The finding, not a footnote: a negative control that passes means the
    // scenario design is too easy or the harness is blind, and every other
    // number in the report is uninterpretable until that is resolved.
    const report = await runSuite(threeCaseFixture(), { runArm: createMockArmRunner({ degradingArms: [] }) });
    const control = report.negativeControls[0];
    assert.equal(control?.fired, false);
    assert.deepEqual(control?.failingArms, []);
    const claim = report.claims.find((c) => c.id === 'negative-control-fires');
    assert.equal(claim?.status, 'not_observed');
    assert.equal(claim?.blocking, true);
    assert.equal(report.totals.failed, 0);
  });

  it('flags a suite with no negative control at all as blocking and uninterpretable', async () => {
    const fixture = fixtureOf([caseDoc('e1-500', ['control', 'treatment'], false)]);
    const report = await runSuite(fixture);
    const claim = report.claims.find((c) => c.id === 'negative-control-present');
    assert.equal(claim?.status, 'not_observed');
    assert.equal(claim?.blocking, true);
    assert.match(claim?.detail ?? '', /uninterpretable/);
  });

  it('reports an inconclusive claim when only some negative controls fire', async () => {
    const fixture = fixtureOf([
      caseDoc('e1-001', ['control', 'treatment'], true),
      caseDoc('e1-002', ['control', 'treatment'], true, ['c1', 'c2']),
    ]);
    let calls = 0;
    const report = await runSuite(fixture, {
      runArm: (invocation) => {
        calls += 1;
        // Degrade only the first case, so exactly one control fires.
        const drop = invocation.case.id === 'e1-001' ? [] : [...invocation.case.constraints.map((c) => c.id)];
        return {
          arm: invocation.arm,
          position: invocation.position,
          caseId: invocation.case.id,
          ok: true,
          error: null,
          response: '',
          retainedConstraintIds: drop,
          droppedConstraintIds: [],
          violatedConstraintIds: [],
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: 0,
        };
      },
    });
    assert.equal(calls, 4);
    const claim = report.claims.find((c) => c.id === 'negative-control-fires');
    assert.equal(claim?.status, 'inconclusive');
    assert.match(claim?.detail ?? '', /1 of 2/);
  });

  it('fails an arm that never runs, and says error rather than fail', async () => {
    const report = await runSuite(threeCaseFixture(), {
      runArm: (invocation) => {
        if (invocation.arm !== 'control') throw new Error('mock exploded');
        return {
          arm: invocation.arm,
          position: invocation.position,
          caseId: invocation.case.id,
          ok: true,
          error: null,
          response: '',
          retainedConstraintIds: invocation.case.constraints.map((c) => c.id),
          droppedConstraintIds: [],
          violatedConstraintIds: [],
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 1,
        };
      },
    });
    // Two broken arms (control+, treatment) × 3 cases = 6 errors; 3 control observations still ran.
    assert.equal(report.totals.errored, 6);
    assert.equal(report.totals.observations, 9);
    assert.equal(report.totals.passed, 3);
    const errored = report.cases[0]?.arms.find((a) => a.arm === 'control+');
    assert.equal(errored?.status, 'error');
    assert.match(errored?.error ?? '', /mock exploded/);
  });

  it('records a violation as a failure even when nothing was dropped', async () => {
    const report = await runSuite(threeCaseFixture(), {
      runArm: (invocation) => ({
        arm: invocation.arm,
        position: invocation.position,
        caseId: invocation.case.id,
        ok: true,
        error: null,
        response: 'did:c1',
        retainedConstraintIds: invocation.case.constraints.map((c) => c.id),
        droppedConstraintIds: [],
        violatedConstraintIds: ['c1'],
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
      }),
    });
    const control = report.cases[0]?.arms.find((a) => a.arm === 'control');
    assert.equal(control?.status, 'fail');
    assert.deepEqual(control?.droppedConstraintIds, []);
    assert.equal(control?.violations.length, 1);
  });
});

describe('runner: totals', () => {
  it('reports one row per arm, including arms that never ran', async () => {
    const report = await runSuite(threeCaseFixture());
    assert.deepEqual(report.totals.byArm.map((a) => a.arm), ['control', 'control+', 'treatment']);
  });

  it('reports a null violation rate for an arm that never ran, not 0%', async () => {
    // A rate with no denominator behind it would clear G1 for an arm nobody ran.
    const fixture = fixtureOf([caseDoc('e1-600', ['control', 'control+'], false)]);
    const report = await runSuite(fixture);
    const treatment = report.totals.byArm.find((a) => a.arm === 'treatment');
    assert.equal(treatment?.observations, 0);
    assert.equal(treatment?.violationRate, null);
    const claim = report.claims.find((c) => c.id === 'retention-treatment');
    assert.equal(claim?.status, 'inconclusive');
  });

  it('computes the control violation rate over its own observations', async () => {
    const report = await runSuite(threeCaseFixture());
    const control = report.totals.byArm.find((a) => a.arm === 'control+');
    assert.equal(control?.observations, 3);
    assert.equal(control?.violations, 3);
    assert.equal(control?.violationRate, 1);
    const treatment = report.totals.byArm.find((a) => a.arm === 'treatment');
    assert.equal(treatment?.violationRate, 0);
  });

  it('counts pass, fail and error across the whole run', async () => {
    const report = await runSuite(threeCaseFixture());
    assert.equal(report.totals.cases, 3);
    assert.equal(report.totals.observations, 9);
    assert.equal(report.totals.failed, 3);
    assert.equal(report.totals.passed, 6);
    assert.equal(report.totals.errored, 0);
    assert.equal(report.totals.passed + report.totals.failed + report.totals.errored, report.totals.observations);
  });

  it('sums synthetic tokens per arm', async () => {
    const report = await runSuite(threeCaseFixture());
    const byArm = report.totals.byArm;
    const control = byArm.find((a) => a.arm === 'control');
    const caseTotal = report.cases
      .flatMap((c) => c.arms)
      .filter((a) => a.arm === 'control')
      .reduce((sum, a) => sum + a.inputTokens, 0);
    assert.equal(control?.inputTokens, caseTotal);
  });
});

describe('harness: no network access', () => {
  const sourceFiles = (): { readonly name: string; readonly text: string }[] =>
    readdirSync(srcDir)
      .filter((f) => f.endsWith('.ts'))
      .sort()
      .map((f) => ({ name: f, text: readFileSync(join(srcDir, f), 'utf8') }));

  it('contains no fetch, http, https or net import in src/', () => {
    // The offline guarantee is structural, so it is asserted structurally: a
    // harness that could reach the network would eventually do so.
    const banned = [
      /\bfetch\s*\(/,
      /\bfrom\s+['"]node:https?['"]/,
      /\bfrom\s+['"]node:net['"]/,
      /\bfrom\s+['"]https?['"]/,
      /\bXMLHttpRequest\b/,
      /\bnew\s+WebSocket\b/,
    ];
    for (const file of sourceFiles()) {
      for (const pattern of banned) {
        assert.ok(
          !pattern.test(file.text),
          `${file.name} matches ${String(pattern)}; the offline harness must not be able to make a request`,
        );
      }
    }
  });

  it('makes no network call while running a suite', async () => {
    // Trip-wired rather than asserted by inspection: if any part of the run
    // reached for the network, this rejects and the suite fails loudly.
    const originalFetch = globalThis.fetch;
    let calls = 0;
    const tripwire: typeof globalThis.fetch = (input) => {
      calls += 1;
      void input;
      return Promise.reject(new Error('network access attempted'));
    };
    globalThis.fetch = tripwire;
    try {
      await runSuite(threeCaseFixture());
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('imports nothing outside node builtins and its own modules', () => {
    for (const file of sourceFiles()) {
      const imports = [...file.text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
      for (const specifier of imports) {
        const local = specifier.startsWith('.');
        const nodeBuiltin = specifier.startsWith('node:');
        assert.ok(
          local || nodeBuiltin,
          `${file.name} imports "${specifier}"; @strata-ctx/eval has no dependencies and opens no sockets`,
        );
      }
    }
  });
});
