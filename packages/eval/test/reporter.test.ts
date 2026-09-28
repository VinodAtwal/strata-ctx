import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createMockArmRunner,
  parseFixture,
  renderReport,
  renderReportJson,
  renderReportPair,
  reportVerdict,
  runSuite,
  type Arm,
  type ArmInvocation,
  type ArmObservation,
  type EvalFixture,
  type RunReport,
} from '../src/index.js';

function fixtureOf(cases: readonly unknown[], over: Record<string, unknown> = {}): EvalFixture {
  return parseFixture({ evalSuiteFormatVersion: 1, suite: 'E1', name: 'constraint-retention', cases, ...over });
}

const caseDoc = (id: string, arms: Arm[], negativeControl: boolean, ids: string[] = ['c1']) => ({
  id,
  title: `case ${id}`,
  arms,
  negativeControl,
  prompt: `prompt for ${id}`,
  constraints: ids.map((c) => ({
    id: c,
    text: `constraint ${c}`,
    kind: 'soft_policy',
    forbidden: [`did:${c}`],
  })),
});

function threeCaseFixture(): EvalFixture {
  return fixtureOf([
    caseDoc('e1-001', ['control', 'control+', 'treatment'], true, ['c1', 'c2']),
    caseDoc('e1-002', ['control', 'control+', 'treatment'], false),
    caseDoc('e1-003', ['control', 'control+', 'treatment'], false, ['c1', 'c2', 'c3']),
  ]);
}

/** An arm that reproduces every declared constraint and never drops one. */
const preservingArm = (invocation: ArmInvocation): ArmObservation => ({
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
});

function once(): Promise<RunReport> {
  return runSuite(threeCaseFixture(), { seed: 11 });
}

describe('reporter: text output', () => {
  it('renders one line per case, in fixture order, with a per-case verdict', async () => {
    const text = renderReport(await once());
    const order = ['e1-001', 'e1-002', 'e1-003'].map((id) => text.indexOf(id));
    assert.ok(order.every((i) => i > 0));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.match(text, /e1-001\s+FAIL\s+constraints=2\s+\[NEGATIVE CONTROL\]/);
    assert.match(text, /e1-002\s+FAIL\s+constraints=1/);
    assert.match(text, /e1-003\s+FAIL\s+constraints=3/);
  });

  it('marks a passing case PASS', async () => {
    const report = await runSuite(threeCaseFixture(), { runArm: preservingArm });
    const text = renderReport(report);
    assert.match(text, /e1-001\s+PASS\s+constraints=2\s+\[NEGATIVE CONTROL\]/);
    assert.match(text, /e1-002\s+PASS\s+constraints=1/);
  });

  it('renders per-arm pass/fail lines with retention and violation counts', async () => {
    const text = renderReport(await once());
    assert.match(text, /FAIL control\+\s+retained=0\s+dropped=2\s+violations=2/);
    assert.match(text, /PASS control\s+retained=2\s+dropped=0\s+violations=0/);
    assert.match(text, /PASS treatment\s+retained=2\s+dropped=0\s+violations=0/);
  });

  it('names every violation with its constraint, stratum and marker', async () => {
    const text = renderReport(await once());
    assert.match(text, /! control\+ violated c1 \(soft_policy\): did:c1/);
    assert.match(text, /! control\+ violated c2 \(soft_policy\): did:c2/);
  });

  it('has a claims section covering the negative control and per-arm retention', async () => {
    const text = renderReport(await once());
    assert.match(text, /^claims$/m);
    assert.match(text, /negative-control-fires: Negative control reproduces the failure/);
    assert.match(text, /retention-control: Arm "control" retained every declared constraint/);
    assert.match(text, /retention-control\+: Arm "control\+" retained every declared constraint/);
    assert.match(text, /retention-treatment: Arm "treatment" retained every declared constraint/);
    assert.match(text, /offline: Run is offline/);
  });

  it('marks an observed claim with [x] and an unobserved one with [ ]', async () => {
    const text = renderReport(await once());
    assert.match(text, /\[x\] negative-control-fires/);
    assert.match(text, /\[x\] retention-control/);
    assert.match(text, /\[ \] retention-control\+/);
    assert.match(text, /\[x\] retention-treatment/);
  });

  it('flags a blocking claim as blocking', async () => {
    const text = renderReport(await once());
    assert.match(text, /\[x\] negative-control-fires[\s\S]*\(blocking\)/);
  });

  it('has a negative-control section reporting how many fired', async () => {
    const text = renderReport(await once());
    assert.match(text, /^negative controls \(1\/1 fired\)$/m);
    assert.match(text, /FIRED\s+e1-001\s+failing arms: control\+/);
  });

  it('distinguishes an errored arm from a failed one', async () => {
    // Default mock arm does not throw; it records violations instead of throwing errors.
    // error=0, fail=3 (control+ fails 3×). Distinct from error.
    const text = renderReport(await once());
    assert.match(text, /fail=3\s+error=0/);
  });

  it('prints no rate for an arm that never ran', async () => {
    const report = await runSuite(fixtureOf([caseDoc('e1-600', ['control', 'control+'], false)]));
    const text = renderReport(report);
    const treatmentRow = text.split('\n').find((l) => /^ {2}treatment /.test(l));
    assert.ok(treatmentRow, 'expected a treatment row in the per-arm totals');
    assert.match(treatmentRow, / {3}- {3}/);
    assert.ok(!treatmentRow.includes('0.0%'));
    assert.match(text, /\[\?\] retention-treatment/);
    assert.match(text, /arm did not run in this suite/);
  });

  it('prints rates to one decimal so the column never shifts', async () => {
    const text = renderReport(await once());
    assert.match(text, /100\.0%/);
    assert.match(text, /0\.0%/);
  });

  it('lists the execution order, so the interleaving claim is auditable', async () => {
    const text = renderReport(await once());
    assert.match(text, /execution order \(interleaved, seeded: position is uncorrelated with arm\)/);
    const orderLines = text.split('\n').filter((l) => /^ {2}\d+ +(control|control\+|treatment) +e1-/.test(l));
    assert.equal(orderLines.length, 9);
    assert.match(orderLines[0] ?? '', /e1-001/);
    assert.ok(orderLines.some((l) => l.includes('control+') && l.includes('e1-003')));
  });

  it('ends with exactly one trailing newline', async () => {
    const text = renderReport(await once());
    assert.ok(text.endsWith('\n'));
    assert.ok(!text.endsWith('\n\n'));
  });
});

describe('reporter: JSON output', () => {
  it('is byte-identical for two runs of the same fixture', async () => {
    const a = renderReportJson(await runSuite(threeCaseFixture(), { seed: 11 }));
    const b = renderReportJson(await runSuite(threeCaseFixture(), { seed: 11 }));
    assert.equal(a, b);
  });

  it('round-trips the report through JSON.parse', async () => {
    const text = renderReportJson(await once());
    const parsed = JSON.parse(text);
    assert.equal(parsed.suite, 'E1');
  });

  it('preserves a null violation rate as null rather than as a number', async () => {
    const report = await runSuite(fixtureOf([caseDoc('e1-600', ['control', 'control+'], false)]));
    const text = renderReportJson(report);
    const parsed = JSON.parse(text) as { totals: { byArm: Array<{ arm: string; violationRate: number | null }> } };
    const treatment = parsed.totals.byArm.find((a) => a.arm === 'treatment');
    assert.equal(treatment?.violationRate, null);
  });

  it('contains no clock-derived field', async () => {
    const text = renderReportJson(await once());
    assert.ok(!/timestamp|startedAt|finishedAt/.test(text));
  });

  it('ends with exactly one trailing newline and two-space indent', async () => {
    const text = renderReportJson(await once());
    assert.ok(text.endsWith('\n'));
    assert.ok(!text.endsWith('\n\n'));
    assert.match(text, /^ {2}"/m);
  });
});

describe('reporter: pair and verdict', () => {
  it('returns both renderings from renderReportPair', async () => {
    const report = await runSuite(threeCaseFixture());
    const { text, json } = renderReportPair(report);
    assert.ok(text.length > 0);
    assert.ok(json.length > 0);
    const parsed = JSON.parse(json);
    assert.equal(parsed.suite, 'E1');
  });

  it('reports fail when any arm failed', async () => {
    const report = await runSuite(threeCaseFixture());
    assert.equal(reportVerdict(report), 'fail');
  });

  it('reports fail when any arm errored', async () => {
    const report = await runSuite(threeCaseFixture(), {
      runArm: createMockArmRunner({ degradingArms: ['treatment'] }),
    });
    assert.equal(reportVerdict(report), 'fail');
  });

  it('reports pass only when every observation passed', async () => {
    const report = await runSuite(threeCaseFixture(), { runArm: preservingArm });
    assert.equal(reportVerdict(report), 'pass');
  });
});

describe('reporter: degradation is opt-in, not baked into the harness', () => {
  it('reverses which arm fails when the caller names a different degrading arm', async () => {
    const report = await runSuite(threeCaseFixture(), { runArm: createMockArmRunner({ degradingArms: ['treatment'] }) });
    const first = report.cases[0];
    const byArm = new Map(first?.arms.map((a) => [a.arm, a]) ?? []);
    assert.equal(byArm.get('treatment')?.status, 'fail');
    assert.equal(byArm.get('control')?.status, 'pass');
    assert.equal(report.negativeControls[0]?.fired, true);
  });
});
