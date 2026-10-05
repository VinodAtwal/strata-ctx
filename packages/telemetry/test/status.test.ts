import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';

import {
  DEFAULT_STATUS_PATH,
  EVICTION_SKIPPED_CODE,
  EVICTION_SKIPPED_PREFIX,
  EXIT_FINDINGS,
  EXIT_OK,
  EXIT_USAGE,
  JsonlSink,
  USAGE,
  buildStatus,
  buildStatusFromLog,
  formatStatus,
  parseStatusArgs,
  runStatusCli,
} from '../src/index.js';
import type { StatusIo, StatusReport, StrataTelemetryEvent } from '../src/index.js';

import {
  NOW,
  ONE_OF_EVERY_TYPE,
  RUN,
  RUN_2,
  TASK,
  TODAY,
  asEvent,
  cache,
  canary,
  compaction,
  cost,
  failure,
  gist,
  logPath,
  pin,
  recordsOf,
  requestIn,
  savings as savingsEvent,
  stage,
  tableAged,
  tempDir,
  violation,
} from './fixtures.js';

const capture = (): StatusIo & { out: string[] } => {
  const out: string[] = [];
  return { out, write: (t) => out.push(t) };
};

describe('G-5 the report is built from the log and nothing else', () => {
  it('reports zero of everything for an empty log, without inventing findings', () => {
    const r = buildStatus([]);
    assert.equal(r.runs, 0);
    assert.equal(r.log.records, 0);
    assert.equal(r.budget.requests, 0);
    assert.equal(r.violations.total, 0);
    assert.equal(r.generated, false, 'nothing ran, so nothing is claimed to have run');
    assert.equal(r.savings.gate, 'none', 'no runs is not a pass');
  });

  it('counts runs, not records', () => {
    const r = buildStatus(recordsOf([requestIn({ runId: RUN }), requestIn({ runId: RUN }), requestIn({ runId: RUN_2 })]));
    assert.equal(r.runs, 2, 'three requests across two runs is two runs');
    assert.equal(r.budget.requests, 3);
    assert.equal(r.log.records, 3);
  });

  it('is a pure function of its records (N6)', () => {
    const records = recordsOf(ONE_OF_EVERY_TYPE);
    assert.deepEqual(buildStatus(records), buildStatus(records));
  });

  it('takes today as an argument and never reads the clock', () => {
    // A freshness verdict from Date.now() would flip between two runs of the
    // same test, and would make the same log report differently tomorrow.
    const records = recordsOf([savingsEvent()]);
    assert.deepEqual(buildStatus(records, { today: TODAY }), buildStatus(records, { today: TODAY }));
  });
});

describe('G-5 budget', () => {
  it('reports peak utilization only when a limit was supplied', () => {
    // The log cannot know the configured window, and a utilization figure
    // computed against an assumed limit looks measured without being measured.
    const records = recordsOf([requestIn({ inputTokens: 50_000 })]);
    assert.equal(buildStatus(records).budget.peakUtilization, null);
    const withLimit = buildStatus(records, { contextLimit: 100_000 });
    assert.equal(withLimit.budget.peakUtilization, 0.5);
  });

  it('keeps the peak, not the last, so one spike is visible', () => {
    const r = buildStatus(
      recordsOf([
        requestIn({ inputTokens: 10_000 }),
        requestIn({ inputTokens: 90_000 }),
        requestIn({ inputTokens: 20_000 }),
      ]),
      { contextLimit: 100_000 },
    );
    assert.equal(r.budget.peakInputTokens, 90_000);
    assert.equal(r.budget.lastInputTokens, 20_000, 'and the current value separately');
    assert.equal(r.budget.peakUtilization, 0.9);
  });

  it('counts requests that exceeded the limit', () => {
    const r = buildStatus(
      recordsOf([
        requestIn({ inputTokens: 150_000 }),
        requestIn({ inputTokens: 160_000 }),
        requestIn({ inputTokens: 10_000 }),
      ]),
      { contextLimit: 100_000 },
    );
    assert.equal(r.budget.overBudget, 2);
  });

  it('warns when the budget was exceeded, not merely counts it', () => {
    // `warnings` is the block the CLI prints above every count. An overrun that
    // only appears in a field the reader has to go looking for is a finding that
    // gets missed on exactly the days it matters.
    const r = buildStatus(recordsOf([requestIn({ inputTokens: 150_000 })]), { contextLimit: 100_000 });
    assert.ok(r.warnings.some((w) => w.includes('BUDGET')), r.warnings.join(' | '));
    assert.ok(r.warnings.some((w) => w.includes('150000')), r.warnings.join(' | '));
  });

  it('says nothing about the budget when no limit was configured', () => {
    // Without a limit there is no overrun to report, and inventing one would be
    // the same "looks measured, is not" problem as a utilisation figure.
    const r = buildStatus(recordsOf([requestIn({ inputTokens: 150_000 })]));
    assert.equal(r.budget.overBudget, 0);
    assert.equal(r.warnings.filter((w) => w.includes('BUDGET')).length, 0);
  });
});

describe('G-5 compactions', () => {
  it('summarises reduction across every compaction', () => {
    const r = buildStatus(
      recordsOf([
        compaction({ beforeTokens: 100_000, afterTokens: 40_000, droppedCount: 2 }),
        compaction({ beforeTokens: 50_000, afterTokens: 30_000, droppedCount: 1 }),
      ]),
    );
    assert.equal(r.compactions.count, 2);
    assert.equal(r.compactions.totalDropped, 3);
    assert.equal(r.compactions.totalTokensBefore, 150_000);
    assert.equal(r.compactions.totalTokensAfter, 70_000);
    assert.ok(r.compactions.reductionFraction !== null);
    assert.ok(Math.abs((r.compactions.reductionFraction ?? 0) - (1 - 70_000 / 150_000)) < 1e-12);
  });

  it('reports a null reduction when nothing compacted, not 0%', () => {
    // "We reduced by nothing" and "we did not run" are different facts.
    assert.equal(buildStatus([]).compactions.reductionFraction, null);
  });

  it('counts a gist that failed validation as a compaction failure', () => {
    const r = buildStatus(
      recordsOf([
        compaction({ validationPassed: true }),
        compaction({ validationPassed: false }),
        compaction({ validationPassed: false }),
      ]),
    );
    assert.equal(r.compactions.count, 3);
    assert.equal(r.compactions.validationFailures, 2);
    assert.ok(r.warnings.some((w) => w.includes('validation')), r.warnings.join(' | '));
  });

  it('breaks the count down by trigger and by method', () => {
    const r = buildStatus(
      recordsOf([
        compaction({ trigger: 'budget', compressionBy: 'self-gist' }),
        compaction({ trigger: 'budget', compressionBy: 'local-model' }),
        compaction({ trigger: 'manual', compressionBy: 'none' }),
      ]),
    );
    assert.equal(r.compactions.byTrigger['budget'], 2);
    assert.equal(r.compactions.byMethod['self-gist'], 1);
    assert.equal(r.compactions.byMethod['none'], 1);
  });
});

describe('G-5 pins', () => {
  it('treats pins already missing at apply time as a P0, not a warning', () => {
    // Architecture §7.2: if a constraint is already missing at apply, something
    // upstream removed it. That is the strongest signal the log carries, and
    // the report says so in those words.
    const r = buildStatus(recordsOf([violation({ kind: 'pin_missing_pre_apply', constraintIds: ['c2'] })]));
    assert.equal(r.violations.byKind['pin_missing_pre_apply'], 1);
    assert.ok(r.warnings.some((w) => w.includes('P0')), r.warnings.join(' | '));
    assert.ok(r.warnings.some((w) => w.includes('c2')), r.warnings.join(' | '));
  });

  it('counts a pin application that arrived incomplete, without a P0 of its own', () => {
    // The `pin` event corroborates; the `violation` event is the P0 record
    // (architecture §7 has the pre-apply check call `recordViolation`). One P0
    // per incomplete application, not one per missing constraint.
    const r = buildStatus(recordsOf([pin({ missingBefore: 3, constraints: 4 })]));
    assert.equal(r.pins.missingBeforeApply, 1, 'one application');
    assert.equal(r.pins.missingTotal, 3, 'three constraints');
    assert.equal(r.pins.intact, false);
    assert.equal(r.violations.total, 0, 'and no violation invented from the pin event alone');
  });

  it('distinguishes applications that were incomplete from constraints that vanished', () => {
    const r = buildStatus(
      recordsOf([
        pin({ missingBefore: 2, constraints: 5 }),
        pin({ missingBefore: 0, constraints: 5 }),
        violation({ kind: 'pin_post_compact_missing', constraintIds: ['c3'] }),
      ]),
    );
    assert.equal(r.pins.missingBeforeApply, 1, 'one application arrived incomplete');
    // `missingTotal` sums `missingBefore` across applications: 2 + 0. The
    // frozen `pin` event carries no separate running total to sum.
    assert.equal(r.pins.missingTotal, 2, 'two constraints were missing, both at the first application');
    assert.equal(r.pins.postCompactMissing, 1);
  });

  it('says intact when every pin application found all its constraints', () => {
    const r = buildStatus(recordsOf([pin({ missingBefore: 0, constraints: 4 })]));
    assert.equal(r.pins.intact, true);
    assert.equal(r.warnings.length, 0);
  });

  it('counts a blocked violation as blocked, separately from the total', () => {
    // `blocked` is the thing that makes a violation a non-event; a report that
    // counted them together would alarm the reader about writes that never
    // happened.
    const r = buildStatus(recordsOf([violation({ blocked: true }), violation({ blocked: false, kind: 'canary_fail' })]));
    assert.equal(r.violations.total, 2);
    assert.equal(r.violations.blocked, 1);
  });

  it('names the constraints that went missing', () => {
    const r = buildStatus(recordsOf([violation({ constraintIds: ['c2', 'c7'], kind: 'pin_post_compact_missing' })]));
    assert.deepEqual([...r.violations.constraintIds].sort(), ['c2', 'c7']);
    assert.deepEqual([...r.violations.kinds], ['pin_post_compact_missing']);
  });

  it('counts a failed canary as a violation of its own kind', () => {
    // `ViolationKind` names `canary_fail` and `byKind` carries the counter. If
    // the `canary` event did not feed it, a failed rotation check would be
    // written to the log and then read by nothing -- a safety signal that dies
    // in the file.
    const r = buildStatus(recordsOf([canary({ passed: false })]));
    assert.equal(r.violations.byKind['canary_fail'], 1);
    assert.equal(r.violations.total, 1);
    assert.equal(r.violations.blocked, 0, 'a failed canary is not a blocked write');
    assert.deepEqual([...r.violations.kinds], ['canary_fail']);
    // The warning names the probe, not a run: a canary is keyed by `probeId`,
    // and printing an `undefined` run would be the sort of quiet that hides a
    // probe that runs outside any run.
    assert.ok(
      r.warnings.some((w) => w.includes('canary probe-1 failed')),
      r.warnings.join(' | '),
    );
    assert.equal(r.warnings.some((w) => w.includes('undefined')), false, r.warnings.join(' | '));
  });

  it('makes a failed canary a nonzero CLI exit, since the gate reads violations.total', (t: TestContext) => {
    const dir = tempDir(t);
    const path = logPath(dir);
    const sink = new JsonlSink({ path });
    sink.emit(canary({ passed: false }));
    sink.close();
    const io = capture();
    assert.equal(runStatusCli(['--log', path], { io, today: TODAY }), EXIT_FINDINGS);
  });

  it('does not count a passing canary as a violation', () => {
    assert.equal(buildStatus(recordsOf([canary({ passed: true })])).violations.total, 0);
  });
});

describe('G-5 savings: the report shows net, and the worst run', () => {
  it('sums gross, overhead and net separately so the subtraction is visible', () => {
    const r = buildStatus(
      recordsOf([
        savingsEvent({ runId: RUN, grossSavedUsd: 1.8, overheadUsd: 3, netSavedUsd: -1.2, gate: 'fail' }),
        savingsEvent({ runId: RUN_2, grossSavedUsd: 2, overheadUsd: 0.5, netSavedUsd: 1.5, gate: 'pass' }),
      ]),
    );
    assert.equal(r.savings.runs, 2);
    assert.ok(Math.abs(r.savings.grossSavedUsd - 3.8) < 1e-9);
    assert.ok(Math.abs(r.savings.overheadUsd - 3.5) < 1e-9);
    assert.ok(Math.abs(r.savings.netSavedUsd - 0.3) < 1e-9);
    assert.equal(r.savings.failedRuns, 1);
  });

  it('names the worst run, because the aggregate hides which one lost money', () => {
    // A total of +0.3 over two runs reads as a win. One run is -1.2. E5's
    // anti-cherry-picking rule is unsatisfiable without the worst run.
    const r = buildStatus(
      recordsOf([
        savingsEvent({ runId: RUN, netSavedUsd: -1.2, gate: 'fail' }),
        savingsEvent({ runId: RUN_2, netSavedUsd: 1.5, gate: 'pass' }),
      ]),
    );
    assert.ok(r.savings.netSavedUsd > 0, 'the aggregate is positive');
    assert.equal(r.savings.worstRun?.runId, RUN);
    assert.equal(r.savings.worstRun?.netSavedUsd, -1.2);
    assert.ok(r.savings.worstRun !== null && r.savings.worstRun.netSavedUsd < 0);
  });

  it('fails the run count when any run failed, even if the total is positive', () => {
    const r = buildStatus(
      recordsOf([
        savingsEvent({ runId: RUN, netSavedUsd: -1.2, gate: 'fail' }),
        savingsEvent({ runId: RUN_2, netSavedUsd: 5, gate: 'pass' }),
      ]),
    );
    assert.equal(r.savings.gate, 'fail');
    assert.ok(r.savings.netSavedUsd > 0, 'and it still says so, rather than hiding the total');
  });

  it('keeps unknown as its own gate, never folded into pass or fail', () => {
    const r = buildStatus(recordsOf([savingsEvent({ gate: 'unknown', netFraction: null })]));
    assert.equal(r.savings.gate, 'unknown');
    assert.notEqual(r.savings.gate, 'pass');
    assert.notEqual(r.savings.gate, 'fail');
  });

  it('carries G-6 staleness into the same report as the money it qualifies', () => {
    // A saving computed from a stale price table is a number whose own
    // validity is in question. Printing the saving without the staleness is
    // how a 200-day-old price reads as current.
    const records = recordsOf([savingsEvent()]);
    const withoutTable = buildStatus(records, { today: TODAY });
    assert.equal(withoutTable.pricing, null, 'no table, no verdict -- not a "fresh" verdict');
    const withStale = buildStatus(records, { today: TODAY, pricing: tableAged(200) });
    assert.equal(withStale.pricing?.stale, true);
    assert.ok(
      withStale.warnings.some((w) => w.includes('pricing')),
      withStale.warnings.join(' | '),
    );
  });
});

describe('G-5 log health', () => {
  it('reports a sequence gap as lost evidence, not as a reordering', () => {
    const r = buildStatus([
      ...recordsOf([requestIn()], 0),
      ...recordsOf([requestIn()], 5),
    ]);
    assert.deepEqual([...r.log.sequenceGaps], [1, 2, 3, 4]);
    assert.equal(r.log.intact, false);
  });

  it('reports duplicate seq numbers too', () => {
    const r = buildStatus([...recordsOf([requestIn()], 0), ...recordsOf([requestIn()], 0)]);
    assert.deepEqual([...r.log.duplicateSeq], [0]);
    assert.equal(r.log.intact, false);
  });

  it('lists event types in schema order, not in the order they happened', () => {
    const r = buildStatus(recordsOf([savingsEvent(), requestIn(), cost()]));
    assert.deepEqual([...r.log.eventTypes], ['request_in', 'cost', 'savings']);
  });

  it('calls a log with a complete seq range intact, whatever it contains', () => {
    // `intact` is about the *file*, not about whether anything went wrong. The
    // two are separate verdicts, and conflating them would make a report that
    // correctly found a violation go on to claim the log is damaged.
    const full = buildStatus(recordsOf(ONE_OF_EVERY_TYPE));
    assert.equal(full.log.intact, true, 'every seq 0..n is present');
    assert.equal(full.violations.total, 1, 'and the fixture does contain a (blocked) violation');
    const clean = buildStatus(recordsOf([requestIn(), stage(), pin(), cache(), cost()]));
    assert.equal(clean.log.intact, true);
    assert.equal(clean.violations.total, 0);
  });
});

describe('G-5 buildStatusFromLog', () => {
  it('reads a log the sink wrote and gets the same report', (t: TestContext) => {
    const dir = tempDir(t);
    const path = logPath(dir);
    const sink = new JsonlSink({ path });
    for (const e of ONE_OF_EVERY_TYPE) sink.emit(e);
    sink.close();

    const fromFile = buildStatusFromLog(path, { today: TODAY });
    assert.equal(fromFile.log.records, ONE_OF_EVERY_TYPE.length);
    assert.equal(fromFile.runs, 1);
    assert.equal(fromFile.budget.requests, 1);
  });

  it('counts a malformed line as rejected and refuses to call the log intact', (t: TestContext) => {
    const dir = tempDir(t);
    const path = logPath(dir);
    const sink = new JsonlSink({ path });
    for (const e of ONE_OF_EVERY_TYPE) sink.emit(e);
    sink.close();
    appendFileSync(path, 'this is not json\n');

    const r = buildStatusFromLog(path, { today: TODAY });
    assert.equal(r.log.linesRejected, 1);
    assert.equal(r.log.intact, false, 'a damaged log is not intact, whatever else is fine');
    assert.equal(r.log.records, ONE_OF_EVERY_TYPE.length, 'the good lines are still counted');
  });

  it('throws a path error rather than reporting an empty log for a missing file', () => {
    // Silently reporting "0 violations, 0 runs" for a file that does not exist
    // is the worst possible failure mode for a status command.
    assert.throws(() => buildStatusFromLog('/nonexistent/telemetry.jsonl'), /cannot read|ENOENT|no such file/i);
  });
});

describe('G-5 formatStatus', () => {
  it('prints warnings above the counts, because a warning that scrolls away is not a warning', () => {
    const r = buildStatus(recordsOf([pin({ missingBefore: 1, constraints: 4 })]));
    const text = formatStatus(r);
    assert.ok(text.length > 0);
    assert.ok(text.includes('WARN') || text.includes('P0'), text);
  });

  it('is deterministic, so two runs produce byte-identical output (N6)', () => {
    const r = buildStatus(recordsOf(ONE_OF_EVERY_TYPE), { today: TODAY, contextLimit: 100_000 });
    assert.equal(formatStatus(r), formatStatus(r));
  });

  it('never prints a savings pass without its net number next to it', () => {
    const r = buildStatus(recordsOf([savingsEvent({ netSavedUsd: 0.4, gate: 'pass' })]));
    const text = formatStatus(r);
    assert.ok(text.includes('0.4') || text.includes('net'), text);
  });
});

describe('G-5 the CLI', () => {
  it('parses flags without a process', () => {
    const a = parseStatusArgs(['--log', '/tmp/x.jsonl', '--context-limit', '100', '--today', '2026-04-01', '--json']);
    assert.equal(a.path, '/tmp/x.jsonl');
    assert.equal(a.contextLimit, 100);
    assert.equal(a.today, '2026-04-01');
    assert.equal(a.asJson, true);
    assert.equal(a.help, false);
    assert.deepEqual([...a.unknown], []);
  });

  it('collects unknown arguments instead of throwing, so usage can list them', () => {
    const a = parseStatusArgs(['--nope', '--log']);
    assert.deepEqual([...a.unknown].length, 2);
    assert.ok(a.unknown.some((u) => u.includes('--log')), a.unknown.join(' | '));
  });

  it('rejects a non-integer context limit rather than coercing it', () => {
    // `Number('12abc')` is NaN and `Number('12.5')` is 12.5. A budget
    // computed from a silently truncated limit is a budget nobody agreed to.
    assert.ok(parseStatusArgs(['--context-limit', 'abc']).unknown.length > 0);
    assert.ok(parseStatusArgs(['--context-limit', '12.5']).unknown.length > 0);
    assert.ok(parseStatusArgs(['--context-limit', '-1']).unknown.length > 0);
  });

  it('prints usage and exits 0 for --help', () => {
    const io = capture();
    assert.equal(runStatusCli(['--help'], { io }), EXIT_OK);
    assert.ok(io.out.join('').includes('usage: strata status'));
    assert.equal(USAGE.includes('--today'), true);
  });

  it('exits 2 on a usage error, distinct from a P0', () => {
    // Conflating them would make "you typed it wrong" as urgent as "your pins
    // are gone", in whatever is watching the exit code.
    const io = capture();
    assert.equal(runStatusCli(['--bogus'], { io }), EXIT_USAGE);
    assert.ok(io.out.join('').includes('unrecognised'));
  });

  it('exits 2, not 1, when the log is missing', () => {
    const io = capture();
    const code = runStatusCli(['--log', '/nonexistent/telemetry.jsonl'], { io });
    assert.equal(code, EXIT_USAGE);
  });

  it('exits 0 on a clean log', (t: TestContext) => {
    const dir = tempDir(t);
    const path = logPath(dir);
    const sink = new JsonlSink({ path });
    sink.emit(requestIn());
    sink.emit(pin({ missingBefore: 0 }));
    sink.close();

    const io = capture();
    assert.equal(runStatusCli(['--log', path], { io, today: TODAY }), EXIT_OK);
  });

  it('exits 1 on a violation, and 1 on a damaged log', (t: TestContext) => {
    const dir = tempDir(t);
    const path = logPath(dir);
    const sink = new JsonlSink({ path });
    sink.emit(violation());
    sink.close();

    const io = capture();
    assert.equal(runStatusCli(['--log', path], { io, today: TODAY }), EXIT_FINDINGS);

    const dir2 = tempDir(t);
    const path2 = logPath(dir2);
    mkdirSync(dir2, { recursive: true });
    writeFileSync(path2, 'not json at all\n');
    const io2 = capture();
    assert.equal(runStatusCli(['--log', path2], { io: io2, today: TODAY }), EXIT_FINDINGS);
  });

  it('defaults to the conventional local path, with no network fallback', () => {
    // N4: the log is the only input. There is no server to ask, so "let me
    // check if the log is empty and then report clean" is not a valid reading.
    assert.equal(DEFAULT_STATUS_PATH, '.strata/telemetry.jsonl');
    const io = capture();
    const code = runStatusCli([], { io, path: '/nonexistent/telemetry.jsonl', today: TODAY });
    assert.equal(code, EXIT_USAGE);
  });

  it('emits valid JSON with --json and no prose around it', (t: TestContext) => {
    const dir = tempDir(t);
    const path = logPath(dir);
    const sink = new JsonlSink({ path });
    sink.emit(requestIn({ inputTokens: 1234 }));
    sink.close();

    const io = capture();
    runStatusCli(['--log', path, '--json'], { io, today: TODAY, contextLimit: 10_000 });
    const parsed = JSON.parse(io.out.join('')) as StatusReport;
    assert.equal(parsed.budget.peakInputTokens, 1234);
    assert.equal(parsed.budget.peakUtilization, 0.1234);
  });

  it('lets an argument override the configured path, and the argument override the config', (t: TestContext) => {
    const dir = tempDir(t);
    const path = logPath(dir);
    const sink = new JsonlSink({ path });
    sink.emit(requestIn());
    sink.close();

    const io = capture();
    assert.equal(runStatusCli(['--log', path], { io, path: '/nonexistent/other.jsonl', today: TODAY }), EXIT_OK);
  });
});

describe('G-5 no value is read that the log cannot support', () => {
  it('marks the report as not generated when there is nothing to report', () => {
    assert.equal(buildStatus([]).generated, false);
    assert.equal(buildStatus(recordsOf([requestIn()])).generated, true);
  });

  it('trusts its input, because the reader is the one that validates', () => {
    // `buildStatus` takes `TelemetryRecord[]`, and the only thing that turns
    // arbitrary bytes into that type is `readJsonl`. Validating a second time
    // here would mean two schema implementations to keep in step, and the
    // second one would be the one that silently drifts.
    const bad = asEvent({ type: 'request_in', runId: RUN, turn: 'not a number', inputTokens: 1, messages: 1 });
    assert.equal(buildStatus([{ v: 1, seq: 0, at: 0, event: bad }]).budget.requests, 1);
    assert.equal(typeof buildStatus([{ v: 1, seq: 0, at: 0, event: bad }]).turns, 'string');
  });

  it('rejects a malformed event at the reader boundary, and counts the rejection', (t: TestContext) => {
    // So a malformed event can never reach the report: it becomes a rejected
    // line, and the rejected count is what makes the log non-intact.
    const dir = tempDir(t);
    const path = logPath(dir);
    const sink = new JsonlSink({ path });
    sink.emit(requestIn());
    sink.close();
    appendFileSync(
      path,
      `${JSON.stringify({
        v: 1,
        seq: 1,
        at: 0,
        event: { type: 'request_in', runId: RUN, turn: 'nope', inputTokens: 1, messages: 1 },
      })}\n`,
    );

    const r = buildStatusFromLog(path, { today: TODAY });
    assert.equal(r.log.linesRejected, 1, 'the malformed event was rejected, not counted');
    assert.equal(r.budget.requests, 1, 'only the good one is counted');
    assert.equal(r.log.intact, false, 'and the report refuses to call the log intact');
  });
});

// --- E-15: what happened to my context ---------------------------------------

describe('E-15 stages are retained, not read and dropped', () => {
  it('keeps the per-stage byte and block counts the log already carried', () => {
    // These numbers were written by the sink and read by the report, which then
    // discarded them (docs/operations.md factor 4). A stage that removes 90% of
    // a request's bytes and a stage that touches nothing have to be
    // distinguishable from the outside.
    const r = buildStatus(
      recordsOf([
        stage({ stage: 'dedupe', bytesIn: 5000, bytesOut: 1000, blocksIn: 10, blocksOut: 4, changed: true }),
        stage({ stage: 'compress', bytesIn: 1000, bytesOut: 1000, blocksIn: 4, blocksOut: 4, changed: false }),
      ]),
    );
    assert.equal(r.stages.count, 2);
    assert.equal(r.stages.changed, 1);
    assert.equal(r.stages.bytesIn, 6000);
    assert.equal(r.stages.bytesOut, 2000);
    assert.equal(r.stages.blocksIn, 14);
    assert.equal(r.stages.blocksOut, 8);
    assert.ok(Math.abs((r.stages.reductionFraction ?? 0) - (1 - 2000 / 6000)) < 1e-12);
    assert.deepEqual([...r.stages.changedStages], ['dedupe']);
  });

  it('sums repeat firings of one stage rather than letting the last one win', () => {
    // A stage fires once per request, so the last record's bytes are not the
    // stage's effect and reporting them as such is how a stage that ran on four
    // requests gets attributed to one.
    const r = buildStatus(
      recordsOf([
        stage({ stage: 'compact', bytesIn: 1000, bytesOut: 900, changed: true }),
        stage({ stage: 'compact', bytesIn: 1000, bytesOut: 100, changed: true }),
      ]),
    );
    const compact = r.stages.byStage.find((s) => s.stage === 'compact');
    assert.equal(compact?.runs, 2);
    assert.equal(compact?.changed, 2);
    assert.equal(compact?.bytesIn, 2000);
    assert.equal(compact?.bytesOut, 1000);
  });

  it('lists stages in the order the log first named them', () => {
    // Alphabetical would read as a pipeline order, and the pipeline order is
    // not alphabetical (architecture §4). First-seen is the only ordering the
    // log actually supports.
    const r = buildStatus(
      recordsOf([stage({ stage: 'triage' }), stage({ stage: 'dedupe' }), stage({ stage: 'pin' })]),
    );
    assert.deepEqual(
      r.stages.byStage.map((s) => s.stage),
      ['triage', 'dedupe', 'pin'],
    );
  });

  it('reports a null reduction for a stage that received nothing, not 100%', () => {
    // 1 - 0/0 is NaN and 1 - n/0 is -Infinity. Neither is a measurement, and
    // printing either as a percentage is a number the log cannot support.
    const r = buildStatus(recordsOf([stage({ bytesIn: 0, bytesOut: 0 })]));
    assert.equal(r.stages.byStage[0]?.reductionFraction, null);
    assert.equal(r.stages.reductionFraction, null, 'and the same at the total');
  });
});

describe('E-15 errors are retained, not read and dropped', () => {
  it('counts failures by code and by stage, and separates the ones the caller felt', () => {
    // `failedOpen` is the difference between a bug the user hit and a bug the
    // user never saw; a single total reports them as equally urgent.
    const r = buildStatus(
      recordsOf([
        failure({ stage: 'compact', code: 'STAGE_FAILED_OPEN', failedOpen: true }),
        failure({ stage: 'compact', code: 'STAGE_FAILED_OPEN', failedOpen: false }),
        failure({ stage: 'truncate', code: 'ARTIFACT_WRITE_REFUSED', failedOpen: false }),
      ]),
    );
    assert.equal(r.errors.total, 3);
    assert.equal(r.errors.failedOpen, 1);
    assert.equal(r.errors.byCode['STAGE_FAILED_OPEN'], 2);
    assert.equal(r.errors.byCode['ARTIFACT_WRITE_REFUSED'], 1);
    assert.equal(r.errors.byStage['compact'], 2);
    assert.equal(r.errors.byStage['truncate'], 1);
  });

  it('does not let an error become a violation, or the exit code with it', () => {
    // `failedOpen` means the context went upstream uncompressed. That is
    // degradation, not a constraint breach, and folding it into
    // `violations.total` would turn every fail-open into a P0 and exit 1 on a
    // log the previous release called clean.
    const r = buildStatus(recordsOf([failure({ failedOpen: true })]));
    assert.equal(r.violations.total, 0);
    assert.equal(r.warnings.length, 0);
  });

  it('keeps the detail, including the sequence number, so a finding is addressable', () => {
    const r = buildStatus(recordsOf([requestIn(), stage(), failure({ code: 'E_GIST_INVALID', message: 'bad gist' })], 0));
    const rec = r.errors.recent[0];
    assert.equal(rec?.code, 'E_GIST_INVALID');
    assert.equal(rec?.stage, 'compact');
    assert.equal(rec?.runId, RUN);
    assert.equal(rec?.message, 'bad gist');
    assert.equal(rec?.failedOpen, true);
    assert.equal(rec?.seq, 2, 'the seq names the line in the file, so the operator can go and look');
    assert.equal(rec?.at, NOW + 2);
  });

  it('bounds the detail list and says that it did', () => {
    // An unbounded `recent` on a 32 MB log is a `--json` report nobody can read,
    // and a silently truncated one reads as complete. Both are wrong, so the
    // cap is reported.
    const many = Array.from({ length: 12 }, (_, i) => failure({ code: `E_${i}` }));
    const r = buildStatus(recordsOf(many));
    assert.equal(r.errors.total, 12, 'the count is never capped, only the listing');
    assert.equal(r.errors.recent.length < 12, true);
    assert.equal(r.errors.recentTruncated, true);
    assert.equal(r.errors.byCode['E_11'], 1, 'and the breakdown still sees all twelve');
  });
});

describe('E-15 the negative case: a request where nothing was evicted or compressed', () => {
  const NOOP_RECORDS = recordsOf([
    requestIn({ inputTokens: 40_000 }),
    // Every stage ran and every one of them declined to act. This is the common
    // request: a small turn, or one with nothing to compress.
    stage({ stage: 'dedupe', bytesIn: 4000, bytesOut: 4000, blocksIn: 8, blocksOut: 8, changed: false }),
    stage({ stage: 'truncate', bytesIn: 4000, bytesOut: 4000, blocksIn: 8, blocksOut: 8, changed: false }),
    stage({ stage: 'triage', bytesIn: 4000, bytesOut: 4000, blocksIn: 8, blocksOut: 8, changed: false }),
  ]);

  it('says the pipeline ran and changed nothing, in the same breath', () => {
    const r = buildStatus(NOOP_RECORDS);
    assert.equal(r.stages.count, 3, 'the stages ran');
    assert.equal(r.stages.changed, 0, 'and none of them changed the context');
    assert.equal(r.stages.reductionFraction, 0, 'a measured zero, which is not the same as unmeasured');
    assert.deepEqual([...r.stages.changedStages], []);
    assert.equal(r.perRequest.byRun[0]?.outcome, 'noop');
  });

  it('does not let a compaction that never ran read as one that removed nothing', () => {
    // `0` would claim a compaction happened and did nothing. There was no
    // compaction; `null` is the only honest answer, and it is the distinction
    // the compactions section already made for `reductionFraction`.
    const r = buildStatus(NOOP_RECORDS);
    assert.equal(r.compactions.count, 0);
    assert.equal(r.compactions.totalDropped, 0);
    assert.equal(r.compactions.reductionFraction, null);
    assert.equal(r.compactions.noOps, 0, 'no-ops counts compactions, so zero compactions is zero no-ops');
  });

  it('distinguishes a no-op request from one the log never described', () => {
    // The failure this guards: a summary in which "the pipeline correctly
    // decided to change nothing" and "we have no idea what the pipeline did"
    // look identical. A log that lost its stage records -- rejected lines, a
    // sequence hole, a host that never wired the emitter -- is the more likely
    // of the two in the field, and it is the one that must never be reported as
    // a clean no-op.
    const measured = buildStatus(NOOP_RECORDS).perRequest.byRun[0]?.outcome;
    const unmeasured = buildStatus(recordsOf([requestIn(), pin(), cache(), cost()])).perRequest.byRun[0]?.outcome;
    assert.equal(measured, 'noop');
    assert.equal(unmeasured, 'unmeasured');
    assert.notEqual(measured, unmeasured);
    assert.equal(buildStatus(recordsOf([requestIn(), pin(), cache(), cost()])).stages.reductionFraction, null);
  });

  it('renders a no-op request as a no-op, and an undescribed one as unknown', () => {
    // The rendered report is the surface; a field that is honest and a line that
    // is not is still a lie to the reader.
    const noop = formatStatus(buildStatus(NOOP_RECORDS));
    assert.ok(noop.includes('nothing was compressed'), noop);
    assert.ok(noop.includes('noop'), noop);
    assert.equal(noop.includes('UNKNOWN'), false, noop);

    const unknown = formatStatus(buildStatus(recordsOf([requestIn(), pin(), cache(), cost()])));
    assert.ok(unknown.includes('UNMEASURED'), unknown);
    assert.ok(unknown.includes('UNKNOWN'), unknown);
    assert.equal(unknown.includes('nothing was compressed'), false, unknown);
  });

  it('raises no warning for a request the pipeline correctly declined to shrink', () => {
    // A no-op is a correct outcome. Promoting it into `warnings` -- the block
    // printed above every count -- would put a routine request at the top of
    // every report, and a warning that always fires is a warning nobody reads.
    const r = buildStatus(NOOP_RECORDS);
    assert.deepEqual([...r.warnings], []);
  });
});

describe('E-15 eviction_skipped is visible with its reason', () => {
  const SKIP_REASON = 'raw_uri "artifact://strata/raw/s/1" is not a content-addressed artifact reference';
  const SKIP_RECORDS = recordsOf([
    requestIn(),
    stage({ stage: 'compact', changed: false, bytesOut: 4000 }),
    failure({
      stage: 'compact',
      code: EVICTION_SKIPPED_CODE,
      message: `${SKIP_REASON}; kept 14 message(s) instead of evicting 12`,
      failedOpen: false,
    }),
    // Exactly what gist/src/transaction.ts emits: rawRecoverable is the
    // conjunction of the gist's own flag and evictable.verified, and the reason
    // rides along in `failed`.
    gist({ rawRecoverable: false, failed: [`${EVICTION_SKIPPED_PREFIX} ${SKIP_REASON}`] }),
    compaction({ beforeTokens: 40_000, afterTokens: 40_000, droppedCount: 0 }),
  ]);

  it('counts the refusal and names the cause', () => {
    // The single most important thing an operator could want to know -- nothing
    // was evicted, here is why -- used to exist only as a string inside a
    // transaction result and as an `error` record the report discarded.
    const ev = buildStatus(SKIP_RECORDS).errors.evictionSkipped;
    assert.equal(ev.count, 1);
    assert.deepEqual([...ev.reasons], [SKIP_REASON]);
    assert.deepEqual([...ev.runIds], [RUN]);
  });

  it('falls back to the error message when the gist record is absent', () => {
    // A log that has the refusal but not its `failed:` entry must still yield a
    // reason; "one eviction was skipped" with an empty reason list is the
    // ambiguous report this section exists to replace.
    const r = buildStatus(recordsOf([failure({ code: EVICTION_SKIPPED_CODE, message: 'store threw while resolving x' })]));
    assert.deepEqual([...r.errors.evictionSkipped.reasons], ['store threw while resolving x']);
  });

  it('de-duplicates reasons, so one transaction does not report twice', () => {
    // A single transaction emits the refusal twice: once as the `error` record
    // and once as the `failed:` entry on its `gist` record. Reporting both
    // would tell the operator two things went wrong when one did, and the count
    // and the reason list have to agree.
    const two = recordsOf([
      failure({ runId: RUN, code: EVICTION_SKIPPED_CODE }),
      failure({ runId: RUN_2, code: EVICTION_SKIPPED_CODE }),
      failure({ runId: RUN_2, code: EVICTION_SKIPPED_CODE }),
      gist({ runId: RUN, taskId: TASK, rawRecoverable: false, failed: [`${EVICTION_SKIPPED_PREFIX} ${SKIP_REASON}`] }),
      gist({ runId: RUN_2, taskId: TASK, rawRecoverable: false, failed: [`${EVICTION_SKIPPED_PREFIX} ${SKIP_REASON}`] }),
    ]);
    const ev = buildStatus(two).errors.evictionSkipped;
    assert.equal(ev.count, 3, 'three refusals');
    assert.deepEqual([...ev.reasons], [SKIP_REASON], 'one distinct reason, not five records of it');
    assert.deepEqual([...ev.runIds], [RUN, RUN_2], 'two runs affected');
  });

  it('stops describing a refused eviction as destroyed evidence', () => {
    // `rawRecoverable: false` carries two different facts, because the
    // transaction folds `raw_recoverable && evictable.verified` into one field.
    // The R12 wording is only true for the first, and telling an operator their
    // evidence was destroyed when step 6 simply refused sends them hunting for
    // data loss that did not happen.
    const r = buildStatus(SKIP_RECORDS);
    assert.equal(
      r.warnings.some((w) => w.includes('destroy evidence')),
      false,
      r.warnings.join(' | '),
    );
    const warned = r.warnings.find((w) => w.includes('was not evicted'));
    assert.ok(warned !== undefined, r.warnings.join(' | '));
    assert.ok(warned.includes(SKIP_REASON), warned);
    assert.ok(warned.includes('still growing'), 'transcript growth being unbounded is the actual finding');
  });

  it('still reports genuine evidence loss in the R12 words', () => {
    // The reworded branch must not have swallowed the case it was split away
    // from: a gist with no recoverable raw transcript and no skip reason really
    // would lose evidence to a following eviction.
    const r = buildStatus(recordsOf([gist({ rawRecoverable: false, failed: ['changed_sha'] })]));
    assert.ok(
      r.warnings.some((w) => w.includes('destroy evidence')),
      r.warnings.join(' | '),
    );
  });

  it('is not a violation and does not change the exit code', () => {
    // No constraint was breached and nothing was lost, so counting it as a
    // violation would train the reader to ignore the section.
    const r = buildStatus(SKIP_RECORDS);
    assert.equal(r.violations.total, 0);
    assert.equal(r.errors.total, 1);
    assert.equal(r.errors.failedOpen, 0, 'the caller got a complete context; nothing was degraded');
  });

  it('renders the skip and its reason', () => {
    const text = formatStatus(buildStatus(SKIP_RECORDS));
    assert.ok(text.includes('eviction skipped 1'), text);
    assert.ok(text.includes(SKIP_REASON), text);
  });
});

describe('E-15 perRequest', () => {
  it('lists the most recent run first, because the question is about the last request', () => {
    const r = buildStatus(
      recordsOf([requestIn({ runId: RUN }), stage({ runId: RUN }), requestIn({ runId: RUN_2 }), stage({ runId: RUN_2 })]),
    );
    assert.deepEqual(
      r.perRequest.byRun.map((x) => x.runId),
      [RUN_2, RUN],
    );
    assert.equal(r.perRequest.total, 2);
    assert.equal(r.perRequest.truncated, false);
  });

  it('attributes only what that run did, so two runs cannot cancel out', () => {
    // The aggregate hides it: one request compressed and one did not reads as
    // a single middling fraction.
    const r = buildStatus(
      recordsOf([
        requestIn({ runId: RUN, inputTokens: 40_000 }),
        stage({ runId: RUN, stage: 'compact', bytesIn: 4000, bytesOut: 400, changed: true }),
        compaction({ runId: RUN, droppedCount: 12 }),
        requestIn({ runId: RUN_2, inputTokens: 10_000 }),
        stage({ runId: RUN_2, stage: 'compact', bytesIn: 1000, bytesOut: 1000, changed: false }),
      ]),
    );
    const first = r.perRequest.byRun.find((x) => x.runId === RUN);
    const second = r.perRequest.byRun.find((x) => x.runId === RUN_2);
    assert.equal(first?.outcome, 'reduced');
    assert.equal(first?.droppedBlocks, 12);
    assert.deepEqual([...(first?.changedStages ?? [])], ['compact']);
    assert.equal(second?.outcome, 'noop');
    assert.equal(second?.droppedBlocks, 0);
    assert.equal(second?.lastInputTokens, 10_000, 'each run carries its own tokens, not the log total');
  });

  it('calls a run reduced when eviction removed messages even if no stage changed', () => {
    // The hook path emits `stage { changed: false }` for pin bookkeeping and
    // still evicts at PreCompact. Keying the verdict on stage activity alone
    // would report a request that shed 180 blocks as a no-op.
    const r = buildStatus(recordsOf([stage({ changed: false }), compaction({ droppedCount: 180 })]));
    assert.equal(r.perRequest.byRun[0]?.outcome, 'reduced');
  });

  it('bounds the listing without bounding the count', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      requestIn({ runId: `run-${i}` }),
    ).flatMap((e) => [e, stage({ runId: e.runId })]);
    const r = buildStatus(recordsOf(many));
    assert.equal(r.perRequest.total, 12);
    assert.equal(r.perRequest.reported, r.perRequest.byRun.length);
    assert.equal(r.perRequest.reported < 12, true);
    assert.equal(r.perRequest.truncated, true);
    assert.equal(r.runs, 12, 'the pre-existing count is not capped, and moving it would be a breaking change');
    assert.equal(formatStatus(r).includes('not shown'), true, 'and the rendering admits it');
  });

  it('is deterministic, so the same log renders the same report twice (N6)', () => {
    assert.deepEqual(buildStatus(recordsOf(ONE_OF_EVERY_TYPE)), buildStatus(recordsOf(ONE_OF_EVERY_TYPE)));
  });
});

describe('E-15 the added sections cannot be resized out from under a consumer', () => {
  it('reports an empty log as empty, with every new section present and zeroed', () => {
    // A consumer reading `stages.count` on an empty report must get 0, not a
    // throw and not `undefined`. `reductionFraction` is null because nothing was
    // measured; `noOps` is 0 because it is a count and always exists.
    const r = buildStatus([]);
    assert.equal(r.stages.count, 0);
    assert.equal(r.stages.changed, 0);
    assert.equal(r.stages.reductionFraction, null);
    assert.deepEqual([...r.stages.byStage], []);
    assert.equal(r.errors.total, 0);
    assert.equal(r.errors.failedOpen, 0);
    assert.equal(r.errors.evictionSkipped.count, 0);
    assert.deepEqual([...r.errors.evictionSkipped.reasons], []);
    assert.equal(r.perRequest.total, 0);
    assert.equal(r.perRequest.byRun.length, 0);
    assert.equal(r.compactions.noOps, 0);
  });

  it('survives a JSON round trip, because --json is half the consumers', () => {
    const r = buildStatus(recordsOf(ONE_OF_EVERY_TYPE));
    assert.deepEqual(JSON.parse(JSON.stringify(r)) as unknown, r);
  });

  it('freezes the new sections, like every other one in the report', () => {
    // The report is returned frozen because it is rendered more than once and
    // `formatStatus` must not be able to observe a mutated input.
    const r = buildStatus(recordsOf(ONE_OF_EVERY_TYPE));
    assert.equal(Object.isFrozen(r.stages), true);
    assert.equal(Object.isFrozen(r.stages.byStage), true);
    assert.equal(Object.isFrozen(r.errors), true);
    assert.equal(Object.isFrozen(r.errors.recent), true);
    assert.equal(Object.isFrozen(r.errors.evictionSkipped), true);
    assert.equal(Object.isFrozen(r.perRequest), true);
    assert.equal(Object.isFrozen(r.perRequest.byRun), true);
  });
});

describe('E-15 the reader still refuses a line it cannot trust', () => {
  it('rejects a non-finite timestamp instead of aborting the whole report', (t: TestContext) => {
    // `makeRecord` throws on a non-finite `at`, and that throw used to escape
    // `readJsonl` -- so one hand-edited line with `at: 1e999` made `strata
    // status` exit 2 with "cannot read the log", which is the exact failure the
    // sink's own doc refuses: a corrupt line must be reported as one rejected
    // line, never as a log that does not exist.
    const dir = tempDir(t);
    const path = logPath(dir);
    const sink = new JsonlSink({ path });
    sink.emit(requestIn());
    sink.close();
    appendFileSync(
      path,
      `${JSON.stringify({ v: 1, seq: 1, at: 'not a timestamp', event: requestIn() })}\n`,
    );
    // `1e999` is written into the file as text on purpose: it is what a
    // hand-edited log actually contains, and `JSON.parse` turns it into
    // Infinity, which `typeof` reports as `number`. Only a `Number.isFinite`
    // guard rejects it -- and `makeRecord` throws on it one line later.
    appendFileSync(
      path,
      '{"v":1,"seq":2,"at":1e999,"event":{"type":"request_in","runId":"run-2","turn":1,' +
        '"inputTokens":1,"messages":1}}\n',
    );

    const r = buildStatusFromLog(path, { today: TODAY });
    assert.equal(r.log.linesRejected, 2, 'both bad lines are counted, and the report still exists');
    assert.equal(r.log.intact, false);
    assert.equal(r.log.records, 1, 'the one good line is still counted');
    assert.equal(r.budget.requests, 1);
    assert.ok(r.warnings.some((w) => w.includes('damaged')), r.warnings.join(' | '));
  });
});

describe('G-8 a cache invalidation with no reorder must not read like one with a reorder', () => {
  // The named failure (docs/testing-plan.md G-8, written before this work): the
  // `cache` case used to fall through into `canary`. A `cache` event carries
  // `prefixHit`/`prefixInvalidated` and no `passed`/`score`, so `!event.passed`
  // was true and `event.score.toFixed(4)` threw on `undefined`. Asserting only
  // that "cache is handled" would have passed with the trap intact: a report can
  // say `cache` was handled and still be unable to tell these two logs apart.
  // So the pair below differs in exactly one respect -- whether a compaction
  // reorders the context -- and must be distinguishable in the field, in the
  // rendered text and in the warnings.

  const invalidated = (runId: string) =>
    cache({ runId, prefixHit: false, prefixInvalidated: true });

  const WITHOUT_REORDER = recordsOf([requestIn({ runId: RUN }), invalidated(RUN)]);
  const WITH_REORDER = recordsOf([
    requestIn({ runId: RUN }),
    invalidated(RUN),
    // The only difference: a compaction on the same run, which is the thing
    // that invalidates a prefix cache in the first place.
    compaction({ runId: RUN, droppedCount: 3, beforeTokens: 9000, afterTokens: 5000 }),
  ]);

  it('separates an unexplained invalidation from one a compaction accounts for', () => {
    const unexplained = buildStatus(WITHOUT_REORDER);
    const explained = buildStatus(WITH_REORDER);

    assert.equal(unexplained.cache.records, 1);
    assert.equal(unexplained.cache.prefixInvalidated, 1);
    assert.equal(explained.cache.records, 1);
    assert.equal(explained.cache.prefixInvalidated, 1);

    assert.deepEqual(
      [...unexplained.cache.unexplainedInvalidations],
      [RUN],
      'no compaction on this run, so the log cannot say what dropped the prefix',
    );
    assert.deepEqual(
      [...explained.cache.unexplainedInvalidations],
      [],
      'a compaction reorders the context, so the invalidation is accounted for',
    );
    assert.notDeepEqual(
      [...unexplained.cache.unexplainedInvalidations],
      [...explained.cache.unexplainedInvalidations],
    );
  });

  it('counts the two flags separately, because the event does not make them exclusive', () => {
    // `CacheTelemetry` (core-types/src/telemetry.ts:21) is two independent
    // booleans, so a record can carry both. A hit/miss partition would report
    // one of those records under neither column and lose it.
    const r = buildStatus(
      recordsOf([
        cache({ runId: RUN, prefixHit: true, prefixInvalidated: false }),
        cache({ runId: RUN, prefixHit: true, prefixInvalidated: true }),
        cache({ runId: RUN_2, prefixHit: false, prefixInvalidated: false }),
      ]),
    );
    assert.equal(r.cache.records, 3);
    assert.equal(r.cache.prefixHits, 2);
    assert.equal(r.cache.prefixInvalidated, 1);
    assert.equal(r.cache.neitherFlagSet, 1, 'the third record is counted, not discarded');
  });

  it('raises a warning for an invalidation nothing in the log accounts for', () => {
    // `warnings` is the block the CLI prints above every count, so an
    // unexplained invalidation that only appears in a field the reader has to
    // go looking for is a finding that gets missed on the day it matters.
    const unexplained = buildStatus(WITHOUT_REORDER);
    assert.ok(
      unexplained.warnings.some((w) => w.includes(RUN) && w.includes('prefix')),
      unexplained.warnings.join(' | '),
    );
    const explained = buildStatus(WITH_REORDER);
    assert.equal(
      explained.warnings.some((w) => w.includes('prefix')),
      false,
      explained.warnings.join(' | '),
    );
  });

  it('renders the two logs differently, because a field nobody prints is not a report', () => {
    const a = formatStatus(buildStatus(WITHOUT_REORDER));
    const b = formatStatus(buildStatus(WITH_REORDER));
    assert.ok(a.includes('prefix invalidated'), a);
    assert.ok(b.includes('prefix invalidated'), b);
    assert.notEqual(a, b, 'the rendered reports must not be the same document');
  });

  it('never counts a cache event as a canary failure', () => {
    // The regression the fall-through produced, stated as an assertion rather
    // than as a comment: `canary_fail` is a `ViolationKind`, so a cache event
    // that reached the canary branch would land in `violations.byKind` and in
    // the exit-1 findings path.
    const r = buildStatus(WITHOUT_REORDER);
    assert.equal(r.violations.total, 0);
    assert.equal(r.violations.byKind['canary_fail'], 0);
    assert.deepEqual([...r.violations.kinds], []);
  });

  it('keeps counts complete and caps only the listing, announcing the cap', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      invalidated(`run-cache-${String(i)}`),
    );
    const r = buildStatus(recordsOf(many));
    assert.equal(r.cache.records, 12, 'the count is never capped, only the listing');
    assert.equal(r.cache.prefixInvalidated, 12);
    assert.equal(r.cache.unexplainedInvalidations.length < 12, true);
    assert.equal(r.cache.truncated, true);
    assert.ok(
      formatStatus(buildStatus(recordsOf(many))).includes('not shown'),
      'a capped list that does not announce itself reads as complete',
    );
  });
});

describe('G-8 token-category savings: where the tokens went', () => {
  it('reports the per-category ledger the log already carried', () => {
    // `savings.tokensByCategory` was written on every savings record
    // (events.ts:114, populated by savings.ts:151-168) and read by nothing, so
    // an operator could see that money was saved and not one token of where it
    // went.
    const r = buildStatus(
      recordsOf([
        savingsEvent({ tokensByCategory: { input_saved: 10_000, gist_out: 200, probe_in: 5, probe_out: 0, compaction_out: 0 } }),
        savingsEvent({ runId: RUN_2, tokensByCategory: { input_saved: 4_000, gist_out: 100, probe_in: 1, probe_out: 2, compaction_out: 3 } }),
      ]),
    );
    assert.equal(r.savings.tokensByCategory?.input_saved, 14_000);
    assert.equal(r.savings.tokensByCategory?.gist_out, 300);
    assert.equal(r.savings.tokensByCategory?.probe_out, 2);
    assert.equal(r.savings.tokensByCategory?.compaction_out, 3);
  });

  it('keeps input_saved signed, because a run that grew its input saved nothing', () => {
    // savings.ts:150 documents `input_saved` as a signed difference on
    // purpose. Summing it as an unsigned count would hide the one run that made
    // the context bigger.
    const r = buildStatus(recordsOf([savingsEvent({ tokensByCategory: { input_saved: -1_500, gist_out: 0, probe_in: 0, probe_out: 0, compaction_out: 0 } })]));
    assert.equal(r.savings.tokensByCategory?.input_saved, -1_500);
    assert.ok(
      r.warnings.some((w) => w.includes('input grew') || w.includes('grew its input')),
      r.warnings.join(' | '),
    );
  });

  it('makes a category total that does not cover the run visible as such', () => {
    // The completeness rule this section exists for: the listing is capped and
    // the cap is announced, and a total that does not account for every
    // category in the log says so rather than reading as the whole story.
    const wide: Record<string, number> = { input_saved: 1_000 };
    for (let i = 0; i < 11; i += 1) wide[`cat_${String(i)}`] = 10;
    const r = buildStatus(recordsOf([savingsEvent({ tokensByCategory: wide })]));
    assert.equal(r.savings.tokensByCategoryCategories, 12, 'the count is complete');
    assert.equal(Object.keys(r.savings.tokensByCategory ?? {}).length < 12, true);
    assert.equal(r.savings.tokensByCategoryTruncated, true);
    const text = formatStatus(buildStatus(recordsOf([savingsEvent({ tokensByCategory: wide })])));
    assert.ok(text.includes('not shown'), text);
  });

  it('reports no category breakdown when the log holds no savings record', () => {
    // An absent breakdown and an empty one are different facts; the report must
    // not present "the log said nothing about tokens" as "tokens were zero".
    const r = buildStatus(recordsOf([requestIn(), stage()]));
    assert.equal(r.savings.runs, 0);
    assert.deepEqual(Object.keys(r.savings.tokensByCategory), []);
    assert.equal(r.savings.tokensByCategoryCategories, 0);
    assert.equal(r.savings.tokensByCategoryTruncated, false);
    const text = formatStatus(r);
    assert.ok(text.includes('no savings records yet'), text);
    assert.equal(text.includes('input_saved'), false, text);
  });
});

describe('G-9 per-stage tokens are reported as estimates, not as measurements', () => {
  const estimated = (over: Partial<Extract<StrataTelemetryEvent, { type: 'stage' }>> = {}) =>
    stage({ inputTokens: 320, outputTokens: 300, ...over });

  /**
   * The stages section alone. A whole-report `includes('est.')` would fail on
   * the budget section's own estimate marking, which is correct and is asserted
   * separately below -- so the assertion has to be scoped to the section it is
   * about rather than loosened until it passes.
   */
  const stagesSection = (records: Parameters<typeof buildStatus>[0]): string => {
    const text = formatStatus(buildStatus(records));
    const start = text.indexOf('stages (');
    if (start === -1) return '';
    return text.slice(start, text.indexOf('\ncompactions', start));
  };

  it('names the basis in the field, so a --json reader cannot mistake it for usage', () => {
    // The defect this row closes. `pipeline/src/order.ts:273-287` fills these
    // two fields from `estimateTokens` and says so where it writes them; the
    // reader is a `--json` consumer, not the pipeline's author, and a field
    // named `inputTokens` carrying a character count is a plausible number that
    // is wrong. The wire names are frozen at digest 2abea9eb56758454, so the
    // report's own names are where the basis has to live.
    const r = buildStatus(recordsOf([estimated()]));
    const effect = r.stages.byStage[0];
    assert.equal(effect?.estimatedInputTokens, 320);
    assert.equal(effect?.estimatedOutputTokens, 300);
    assert.equal(
      Object.prototype.hasOwnProperty.call(effect ?? {}, 'inputTokens'),
      false,
      'the unlabelled spelling is gone from the report, so nothing reads as a measurement',
    );
    assert.equal(r.stages.basis, 'estimated', 'and the basis is a datum, not only prose');
  });

  it('renders the caveat, because a field nobody renders fixes nothing', () => {
    // The operator reads the terminal, not the source. An estimate that reaches
    // --json with a good name and never reaches `strata status` has fixed the
    // reader who was already reading carefully and left the one who was not.
    const text = formatStatus(buildStatus(recordsOf([estimated()])));
    assert.match(text, /est\. tokens /, text);
    assert.match(text, /basis: estimated/, text);
    assert.match(text, /NOTE .*not provider-reported/, text);
    assert.match(text, /dedupe .*est\. 320 -> 300 token\(s\)/, text);
  });

  it('says the arithmetic, so a reader who disagrees can see what produced the number', () => {
    const text = formatStatus(buildStatus(recordsOf([estimated()])));
    assert.match(text, /chars\/4/, text);
    assert.match(text, /tokens\.ts/, text);
  });

  it('refuses to print a token figure for a log that never estimated one', () => {
    // Absent, not zero. A pre-G-9 log has stage records and no token fields, and
    // "0 estimated tokens" over it reports the absence of a measurement as a
    // measurement -- the stages were not free, they were unmeasured.
    const r = buildStatus(recordsOf([stage(), stage({ stage: 'truncate' })]));
    assert.equal(r.stages.count, 2);
    assert.equal(r.stages.basis, undefined, 'no basis is asserted for figures that do not exist');
    assert.equal(r.stages.estimatedInputTokens, undefined);
    assert.equal(r.stages.estimatedOutputTokens, undefined);
    assert.equal(r.stages.byStage[0]?.estimatedInputTokens, undefined);
    assert.equal(r.stages.byStage[0]?.inputEstimateRecords, 0, 'but the count of records carrying one is a real zero');
    const section = stagesSection(recordsOf([stage(), stage({ stage: 'truncate' })]));
    assert.equal(section.includes('est. tokens'), false, section);
    assert.equal(section.includes('est.'), false, 'no estimate line and no NOTE either');
    assert.equal(section.includes('NOTE'), false, section);
    assert.ok(section.includes('dedupe 1/1 changed'), section);
  });

  it('separates a stage that was never estimated from one that was estimated', () => {
    // The discrimination, not the negative: two logs that differ in exactly one
    // respect -- whether the record carried a token field -- have to give
    // opposite verdicts on what the report can claim.
    const unestimated = buildStatus(recordsOf([stage({ stage: 'triage' })]));
    const estimatedLog = buildStatus(recordsOf([stage({ stage: 'triage', inputTokens: 500, outputTokens: 480 })]));
    assert.equal(unestimated.stages.byStage[0]?.inputEstimateRecords, 0);
    assert.equal(estimatedLog.stages.byStage[0]?.inputEstimateRecords, 1);
    assert.equal(estimatedLog.stages.byStage[0]?.estimatedInputTokens, 500);
    assert.notEqual(formatStatus(unestimated), formatStatus(estimatedLog));
  });

  it('announces partial coverage instead of summing a fraction of the log', () => {
    // One estimated record out of three is not "the stage saw 320 tokens". The
    // coverage count is the load-bearing half of the figure, and a report that
    // showed the sum without it would read as complete -- the same shape as the
    // capped lists that have to say they were capped.
    const r = buildStatus(recordsOf([estimated(), stage({}), stage({})]));
    const effect = r.stages.byStage[0];
    assert.equal(effect?.runs, 3);
    assert.equal(effect?.inputEstimateRecords, 1);
    assert.equal(r.stages.inputEstimateRecords, 1);
    assert.equal(r.stages.count, 3, 'and the denominator is the whole log, not the estimated part');
    const text = formatStatus(r);
    assert.match(text, /1 of 3 stage record\(s\)/, text);
    assert.match(text, /\[estimate covers input on 1 of 3 record\(s\)/, text);
  });

  it('does not announce a gap in a direction it holds no figure for', () => {
    // `inputTokens` and `outputTokens` are independent optional fields, so a
    // record can carry one. Saying "output on 0 of 1 record(s)" beside a report
    // that never claimed an output figure states the absence of a measurement
    // as a measurement of the absence.
    const r = buildStatus(recordsOf([stage({ inputTokens: 320 })]));
    assert.equal(r.stages.estimatedInputTokens, 320);
    assert.equal(r.stages.estimatedOutputTokens, undefined);
    const text = formatStatus(r);
    assert.match(text, /est\. 320 token\(s\)/, text);
    assert.equal(text.includes('estimate covers output'), false, text);
    assert.equal(text.includes('input 320, output'), false, text);
  });

  it('carries the coverage count on a stage that has no figures, so zero is stated', () => {
    const r = buildStatus(recordsOf([stage({ stage: 'triage' }), estimated({ stage: 'pin' })]));
    const triage = r.stages.byStage.find((s) => s.stage === 'triage');
    assert.equal(triage?.inputEstimateRecords, 0);
    assert.equal(triage?.outputEstimateRecords, 0);
    assert.equal(triage?.estimatedInputTokens, undefined);
    const text = formatStatus(r);
    assert.equal(text.includes('triage 1/1 changed, 1000 -> 900 bytes, 10 -> 8 block(s), est.'), false, text);
  });

  it('sums across stages, and says that the sum is not a quantity', () => {
    // Each stage re-estimates the whole context on its way past, so the same
    // tokens are counted once per stage. A bare total reads as one measured
    // figure; the record count it covers and the NOTE are what make it a sum of
    // N overlapping estimates rather than a run's token usage.
    const r = buildStatus(
      recordsOf([
        estimated({ stage: 'dedupe', inputTokens: 320, outputTokens: 300 }),
        estimated({ stage: 'truncate', inputTokens: 300, outputTokens: 180 }),
      ]),
    );
    assert.equal(r.stages.estimatedInputTokens, 620, 'the arithmetic is still done, and still complete');
    assert.equal(r.stages.estimatedOutputTokens, 480);
    assert.equal(r.stages.inputEstimateRecords, 2);
    const text = formatStatus(r);
    assert.match(text, /input 620, output 480/, text);
    assert.match(text, /not a request size/, text);
    assert.match(text, /each measure the whole context/, text);
    assert.equal(
      text.includes('620 token(s)'),
      false,
      'no bare total anywhere: the number never appears without its coverage and its basis',
    );
  });

  it('folds the cross-stage total from the same tallies as the per-stage listing', () => {
    // Two accumulators would be free to disagree and nothing would see it. This
    // is the property that makes the total safe to print at all.
    const records = recordsOf([
      estimated({ stage: 'dedupe', inputTokens: 100, outputTokens: 90 }),
      estimated({ stage: 'dedupe', inputTokens: 200, outputTokens: 180 }),
      estimated({ stage: 'triage', inputTokens: 50, outputTokens: 40 }),
    ]);
    const r = buildStatus(records);
    const listed = r.stages.byStage.reduce((n, s) => n + (s.estimatedInputTokens ?? 0), 0);
    const listedOut = r.stages.byStage.reduce((n, s) => n + (s.estimatedOutputTokens ?? 0), 0);
    assert.equal(r.stages.estimatedInputTokens, listed);
    assert.equal(r.stages.estimatedOutputTokens, listedOut);
    assert.equal(r.stages.inputEstimateRecords, 3);
    assert.equal(
      r.stages.byStage.reduce((n, s) => n + s.inputEstimateRecords, 0),
      r.stages.inputEstimateRecords,
      'and the coverage counts fold the same way',
    );
  });

  it('keeps the token figures off a log with no stage records', () => {
    const r = buildStatus(recordsOf([requestIn(), pin()]));
    assert.equal(r.stages.count, 0);
    assert.equal(r.stages.basis, undefined);
    const text = formatStatus(r);
    assert.match(text, /UNMEASURED/, text);
    assert.equal(text.includes('est. tokens'), false, text);
  });

  it('marks the budget section too, because request_in carries an estimate as well', () => {
    // `request_in.inputTokens` is `state.tokenEstimate` (gateway/src/server.ts:499)
    // emitted at ingress, so it is an estimate by construction rather than by
    // inference -- and a report that says "estimate" under `stages` while
    // printing bare "token(s)" under `budget` has told the operator the same
    // arithmetic is measured in one place and guessed in the other.
    const text = formatStatus(
      buildStatus(recordsOf([requestIn({ inputTokens: 150_000 }), stage()]), { contextLimit: 100_000 }),
    );
    assert.match(text, /last input\s+150000 est\. token\(s\)/, text);
    assert.match(text, /peak input\s+150000 est\. token\(s\)/, text);
    assert.match(text, /estimated peak input was 150000 tokens/, text);
  });

  it('reports a per-stage estimate over repeat firings without letting them add up silently', () => {
    // Two firings of one stage, both estimated: the sum is the stage's own
    // history and the coverage count says so.
    const r = buildStatus(
      recordsOf([
        estimated({ stage: 'compact', inputTokens: 1000, outputTokens: 900 }),
        estimated({ stage: 'compact', inputTokens: 1200, outputTokens: 1100 }),
      ]),
    );
    const compact = r.stages.byStage.find((s) => s.stage === 'compact');
    assert.equal(compact?.runs, 2);
    assert.equal(compact?.estimatedInputTokens, 2200);
    assert.equal(compact?.inputEstimateRecords, 2, 'full coverage needs no announcement');
    assert.equal(formatStatus(r).includes('estimate covers'), false);
  });
});

describe('exhaustiveness guard against unhandled event types', () => {
  it('enumerates STRATA_EVENT_TYPES and asserts every member is handled or explicitly allowed', async () => {
    // Load the allowlist from the module under test to keep this assertion in
    // lockstep with the implementation.
    const statusModule = await import('../src/status.js');
    const eventsModule = await import('../src/events.js');
    const EXPLICIT_UNHANDLED_EVENT_ALLOWLIST = statusModule.EXPLICIT_UNHANDLED_EVENT_ALLOWLIST;
    const STRATA_EVENT_TYPES = eventsModule.STRATA_EVENT_TYPES;

    const handledInSwitch = new Set<string>([
      'request_in',
      'stage',
      'error',
      'pin',
      'compaction',
      'gist',
      'violation',
      'savings',
      'consolidation',
      'cost',
      'cache',
      'canary',
    ]);

    const allowlist = EXPLICIT_UNHANDLED_EVENT_ALLOWLIST;
    const unknown = STRATA_EVENT_TYPES.filter((t) => !handledInSwitch.has(t) && !allowlist[t]);
    assert.equal(unknown.length, 0, `Unhandled event types without explicit allowlist: ${unknown.join(', ')}`);

    for (const t of STRATA_EVENT_TYPES) {
      assert.ok(
        handledInSwitch.has(t) || allowlist[t],
        `Event type ${t} must be handled in switch or present in EXPLICIT_UNHANDLED_EVENT_ALLOWLIST`,
      );
    }
  });

  it('names nothing in the allowlist that the switch also handles', async () => {
    // The other half of the guard, and the half that was missing. The test above
    // passes just as happily with a stale entry: a type listed as "deliberately
    // unhandled" while the switch handles it satisfies `handled || allowlist`
    // twice, so the allowlist could claim `cache` was unhandled for as long as
    // the switch kept quietly handling it, and nothing here would object. That
    // is the same shape as the wiring-ledger gate's rule -- an allowlist entry
    // for something now handled is a declaration that the handling might not be.
    const statusModule = await import('../src/status.js');
    const eventsModule = await import('../src/events.js');
    const handledInSwitch = new Set<string>([
      'request_in',
      'stage',
      'error',
      'pin',
      'compaction',
      'gist',
      'violation',
      'savings',
      'consolidation',
      'cost',
      'cache',
      'canary',
    ]);
    const stale = Object.keys(statusModule.EXPLICIT_UNHANDLED_EVENT_ALLOWLIST)
      .filter((t) => handledInSwitch.has(t))
      .sort();
    assert.deepEqual(
      stale,
      [],
      'the allowlist declares these deliberately unhandled, but the switch handles them. Delete the entry.',
    );
    const unknownEntry = Object.keys(statusModule.EXPLICIT_UNHANDLED_EVENT_ALLOWLIST)
      .filter((t) => !(eventsModule.STRATA_EVENT_TYPES as readonly string[]).includes(t))
      .sort();
    assert.deepEqual(unknownEntry, [], 'the allowlist names a type that is not in the union at all');
  });

  it('surfaces every event type the log can carry', async () => {
    // Not the guard above: an observation about what the report now holds, so a
    // reader of this file can tell the remaining gaps are none rather than
    // having to trust a hand-maintained list. `ONE_OF_EVERY_TYPE` carries one
    // record of each type, so anything the switch drops shows up as a count that
    // stayed at zero.
    const eventsModule = await import('../src/events.js');
    const r = buildStatus(recordsOf(ONE_OF_EVERY_TYPE));
    assert.deepEqual(
      [...r.log.eventTypes],
      [...eventsModule.STRATA_EVENT_TYPES],
      'all twelve types reached the report',
    );
    assert.equal(r.cache.records, 1, 'the cache record the fixture carries is counted');
    assert.ok(
      Object.keys(r.savings.tokensByCategory).length > 0,
      'the token-category ledger the savings fixture carries is surfaced',
    );
  });
});
