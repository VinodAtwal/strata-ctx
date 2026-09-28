import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isNoProgress,
  VOLUME_DEFAULTS,
  VolumeAttackDetector,
  type CompactionObservation,
  type VolumeOptions,
} from '../src/volume-attack.js';
import { ViolationRecorder } from '../src/violations.js';
import { FIXED_NOW } from './fixtures.js';

const now = () => FIXED_NOW;

const compaction = (over: Partial<CompactionObservation> = {}): CompactionObservation => ({
  turn: 1,
  beforeTokens: 100_000,
  afterTokens: 20_000,
  droppedCount: 40,
  validationPassed: true,
  compressionBy: 'self-gist',
  ...over,
});

function detector(options: VolumeOptions = {}): VolumeAttackDetector {
  return new VolumeAttackDetector({ now, runId: 'run-1', ...options });
}

/** A healthy, gradually-progressing compaction every `every` turns. */
function healthy(count: number, every = 5, start = 0): CompactionObservation[] {
  return Array.from({ length: count }, (_, i) =>
    compaction({ turn: start + i * every, beforeTokens: 100_000, afterTokens: 20_000, droppedCount: 40 }),
  );
}

describe('D-7 what counts as a compaction worth counting', () => {
  it('accepts an observation with no trigger, because not every compaction has one', () => {
    // A task-boundary compaction has no trigger. An optional field that is
    // accidentally required would make the common path unobservable.
    const d = detector();
    assert.equal(d.observe(compaction()).ok, true);
    assert.equal(d.observe(compaction({ turn: 5, trigger: 'token_sawtooth' })).ok, true);
  });

  it('records every observation, including one with no fields beyond the required', () => {
    const r = detector().observe(compaction());
    assert.equal(r.stats.total, 1);
  });

  it('does not mutate the observation it was given', () => {
    const o = compaction();
    const before = structuredClone(o);
    detector().observe(o);
    assert.deepEqual(o, before);
  });

  it('freezes what it hands back, so a caller cannot corrupt the detector', () => {
    const r = detector().observe(compaction());
    assert.ok(Object.isFrozen(r.reasons));
    assert.ok(Object.isFrozen(r.stats.active));
    assert.throws(() => {
      (r.reasons as string[]).push('made_up');
    }, TypeError);
  });
});

describe('D-7 signal 1: rate', () => {
  it('is quiet at the ceiling and loud above it', () => {
    const d = detector();
    for (const o of healthy(3)) assert.equal(d.observe(o).ok, true);
    const over = d.observe(healthy(4)[3] as CompactionObservation);
    assert.equal(over.ok, false);
    assert.deepEqual(over.newlyFired, ['rate_above_ceiling']);
  });

  it('counts a rate, not a total, so an old burst is forgotten', () => {
    // The same four compactions spread over a long session is not an attack.
    const d = detector();
    for (const o of healthy(4, 200)) d.observe(o);
    assert.equal(d.stats().total, 4);
    assert.equal(d.stats().inWindow, 1);
    assert.equal(d.stats().active.includes('rate_above_ceiling'), false);
  });

  it('prunes on a half-open window, so N in N turns is exactly 1/turn', () => {
    const d = detector({ windowTurns: 20, maxCompactionsPerWindow: 3 });
    for (const o of healthy(4, 5)) d.observe(o);
    // Turns 0,5,10,15 -- all inside (15-20, 15].
    assert.equal(d.stats().inWindow, 4);
    // One more turn on and the turn-0 entry falls out of the window.
    d.observe(compaction({ turn: 21 }));
    assert.equal(d.stats().inWindow, 4);
    d.observe(compaction({ turn: 26 }));
    assert.equal(d.stats().inWindow, 4);
    assert.equal(d.stats().perTurn, 4 / 20);
  });

  it('reports the rate an operator actually reads', () => {
    const d = detector({ windowTurns: 20 });
    for (const o of healthy(4, 5)) d.observe(o);
    assert.equal(d.stats().perTurn, 0.2);
  });

  it('never prunes the total, because exposure is cumulative', () => {
    // The exposure budget is about the whole run: 10% survival is a statement
    // about the fifth compaction, not about a twenty-turn window.
    const d = detector();
    for (const o of healthy(10, 500)) d.observe(o);
    assert.equal(d.stats().total, 10);
    assert.equal(d.stats().inWindow <= 1, true);
  });
});

describe('D-7 signal 2: the exposure budget', () => {
  it('escalates at the Compaction Cliff figure, and it is the only P0', () => {
    // 53% survival after one round, 10% after five. Past the fifth, the run is
    // no longer evidence for the product's central claim.
    const d = detector();
    for (const o of healthy(4, 500)) assert.equal(d.observe(o).ok, true);
    const fifth = d.observe(healthy(5, 500)[4] as CompactionObservation);
    assert.deepEqual(fifth.newlyFired, ['exposure_budget_exhausted']);
    assert.equal(fifth.violations[0]?.severity, 'P0');
  });

  it('files the other three as P1, because an anomaly is not a proven violation', () => {
    // Filing these as P0 would put the 0%-violation claim next to a number that
    // is mostly "we compacted a lot".
    const d = detector();
    for (const o of [
      ...healthy(4, 5),
      compaction({ turn: 30, droppedCount: 0, afterTokens: 100_000 }),
      compaction({ turn: 40, droppedCount: 0, afterTokens: 100_000 }),
      compaction({ turn: 50, droppedCount: 0, afterTokens: 100_000 }),
      compaction({ turn: 60, validationPassed: false }),
      compaction({ turn: 70, validationPassed: false }),
      compaction({ turn: 80, validationPassed: false }),
    ]) {
      d.observe(o);
    }
    const byReason = new Map(
      d.violations.map((v) => [v.detail.split(': ').at(-1) ?? '', v.severity]),
    );
    for (const v of d.violations) {
      if (v.severity === 'P0') assert.match(v.detail, /survival is known to collapse/);
      else assert.notEqual(v.severity, 'P0');
    }
    assert.equal(d.violations.length, 4);
    assert.equal(byReason.size, 4);
  });

  it('never re-attributes an already-fired signal', () => {
    // Rising edge only. A loop that runs for 10,000 turns produces one record,
    // not 10,000 -- otherwise the alert becomes the reason the log is unreadable.
    const d = detector();
    for (const o of healthy(12, 500)) d.observe(o);
    const exposure = d.violations.filter((v) => v.detail.includes('survival is known to collapse'));
    assert.equal(exposure.length, 1);
  });
});

describe('D-7 signal 3: no progress', () => {
  it('treats a compaction that dropped nothing as no progress', () => {
    assert.equal(isNoProgress(compaction({ droppedCount: 0, afterTokens: 100_000 })), true);
  });

  it('also treats one that made the transcript bigger as no progress', () => {
    // The trigger watches the transcript, not `dropped_count`. A compactor that
    // rewrote the session into a slightly larger gist has also made no progress,
    // and the sawtooth will fire again next turn.
    assert.equal(isNoProgress(compaction({ droppedCount: 0, afterTokens: 120_000 })), true);
  });

  it('does not treat a small real reduction as no progress', () => {
    assert.equal(isNoProgress(compaction({ droppedCount: 0, afterTokens: 99_999 })), false);
    assert.equal(isNoProgress(compaction({ droppedCount: 1, afterTokens: 200_000 })), false);
  });

  it('needs the configured number in a row, not the total', () => {
    // Everything else is pushed out of the way so this test is only about the
    // streak; the other two signals have their own cases below.
    const d = detector({ noProgressLimit: 3, exposureEscalateAt: 99, maxCompactionsPerWindow: 99 });
    const noProgress = (turn: number) => compaction({ turn, droppedCount: 0, afterTokens: 100_000 });
    d.observe(noProgress(1));
    d.observe(compaction({ turn: 2 }));
    assert.equal(d.stats().consecutiveNoProgress, 0, 'a good compaction resets the streak');
    d.observe(noProgress(3));
    d.observe(noProgress(4));
    assert.equal(d.stats().consecutiveNoProgress, 2);
    const third = d.observe(noProgress(5));
    assert.deepEqual(third.newlyFired, ['no_progress']);
  });

  it('survives a real progress in the middle of a streak', () => {
    const d = detector({ noProgressLimit: 3, exposureEscalateAt: 99, maxCompactionsPerWindow: 99 });
    for (const o of [
      compaction({ turn: 1, droppedCount: 0, afterTokens: 100_000 }),
      compaction({ turn: 2 }),
      compaction({ turn: 3, droppedCount: 0, afterTokens: 100_000 }),
      compaction({ turn: 4, droppedCount: 0, afterTokens: 100_000 }),
    ]) {
      d.observe(o);
    }
    assert.equal(d.violations.length, 0, 'two in a row is noise, not a loop');
    assert.equal(d.stats().consecutiveNoProgress, 2);
  });
});

describe('D-7 signal 4: the abort loop', () => {
  it('counts consecutive aborts and resets on a pass', () => {
    // An aborted compaction is a *correct* outcome: step 4 is supposed to abort.
    // It only becomes a finding when it repeats, because each one costs a full
    // gist generation and the kept transcript is a bigger one.
    const d = detector({ abortLimit: 3, exposureEscalateAt: 99, maxCompactionsPerWindow: 99 });
    d.observe(compaction({ turn: 1, validationPassed: false }));
    d.observe(compaction({ turn: 2, validationPassed: true }));
    assert.equal(d.stats().consecutiveAborts, 0);
    d.observe(compaction({ turn: 3, validationPassed: false }));
    d.observe(compaction({ turn: 4, validationPassed: false }));
    assert.equal(d.violations.length, 0);
    const third = d.observe(compaction({ turn: 5, validationPassed: false }));
    assert.deepEqual(third.newlyFired, ['abort_loop']);
  });

  it('is the self-inflicted-wound shape, so a healthy run files nothing', () => {
    // Four real compactions over a long session: not too often, nowhere near
    // the exposure budget, every one of them making progress.
    const d = detector();
    for (const o of healthy(4, 100)) assert.equal(d.observe(o).ok, true);
    assert.deepEqual(d.violations, []);
  });

  it('stays quiet past the ceiling until it is actually crossed', () => {
    // The rate alert is a rate: a long session that compacts often is not the
    // same as a short one that compacts often.
    const d = detector();
    for (const o of healthy(3, 100)) assert.equal(d.observe(o).ok, true);
    assert.deepEqual(d.violations, []);
  });
});

describe('D-7 the four signals together', () => {
  it('reports every signal one observation satisfies, not just the first', () => {
    // An operator needs to know it is rate *and* no-progress, because the two
    // have different causes.
    const d = detector({ noProgressLimit: 1, abortLimit: 1, exposureEscalateAt: 1 });
    const r = d.observe(compaction({ turn: 1, droppedCount: 0, afterTokens: 100_000, validationPassed: false }));
    assert.deepEqual([...r.newlyFired].sort(), [
      'abort_loop',
      'exposure_budget_exhausted',
      'no_progress',
    ]);
  });

  it('fires rising edge only, and says a signal is still active while it is', () => {
    const d = detector({ maxCompactionsPerWindow: 1 });
    const a = d.observe(compaction({ turn: 1 }));
    assert.deepEqual(a.newlyFired, []);
    const b = d.observe(compaction({ turn: 2 }));
    assert.deepEqual(b.newlyFired, ['rate_above_ceiling']);
    assert.deepEqual(b.reasons, ['rate_above_ceiling']);
    // Still satisfied, but already said.
    const c = d.observe(compaction({ turn: 3 }));
    assert.deepEqual(c.newlyFired, []);
    assert.deepEqual(c.reasons, ['rate_above_ceiling']);
    assert.deepEqual(c.violations, []);
    assert.ok(c.stats.active.includes('rate_above_ceiling'));
  });

  it('clears a signal once it stops being true', () => {
    const d = detector({ maxCompactionsPerWindow: 1, windowTurns: 5 });
    d.observe(compaction({ turn: 1 }));
    d.observe(compaction({ turn: 2 }));
    assert.deepEqual(d.stats().active, ['rate_above_ceiling']);
    // The window empties out.
    d.observe(compaction({ turn: 20 }));
    assert.deepEqual(d.stats().active, []);
  });

  it('re-arms without forgetting the counters', () => {
    // A segmented run should report a still-true signal once more rather than
    // leaving it silently suppressed for the rest of the process.
    const d = detector({ maxCompactionsPerWindow: 1 });
    d.observe(compaction({ turn: 1 }));
    d.observe(compaction({ turn: 2 }));
    assert.equal(d.violations.length, 1);
    d.rearm();
    assert.deepEqual(d.stats().active, []);
    const again = d.observe(compaction({ turn: 3 }));
    assert.deepEqual(again.newlyFired, ['rate_above_ceiling']);
    assert.equal(d.stats().total, 3, 'the counter is untouched');
  });

  it('attributes each record to the run and turn it was seen on', () => {
    const d = detector({ exposureEscalateAt: 1 });
    const r = d.observe(compaction({ turn: 77 }));
    assert.equal(r.violations[0]?.runId, 'run-1');
    assert.equal(r.violations[0]?.turn, 77);
    assert.match(r.violations[0]?.detail ?? '', /compaction 1 at turn 77/);
  });

  it('says which compaction number it was, in a form a human can find', () => {
    const d = detector({ exposureEscalateAt: 1 });
    const r = d.observe(compaction({ turn: 1 }));
    assert.match(r.violations[0]?.detail ?? '', /compaction 1 at turn 1/);
  });

  it('never throws on a hostile observation', () => {
    // An alerting failure must not be able to take the request path with it.
    const d = detector();
    const weird: CompactionObservation = {
      turn: 0,
      beforeTokens: -1,
      afterTokens: Number.NaN,
      droppedCount: -5,
      validationPassed: false,
      compressionBy: 'none',
    };
    assert.doesNotThrow(() => d.observe(weird));
  });

  it('surfaces the recorder so the caller can wire it into the run', () => {
    const recorder = new ViolationRecorder([], now);
    const d = detector({ recorder, exposureEscalateAt: 1 });
    d.observe(compaction());
    assert.equal(d.recorder, recorder);
    assert.deepEqual(d.violations, recorder.log.all());
  });
});

describe('D-7 the defaults are the documented numbers', () => {
  it('anchors the window to the canary interval', () => {
    // An attack that outpaces the canary has to show up inside the interval in
    // which the canary would have spoken, or the canary reports a healthy number
    // over a session that never stopped compacting.
    assert.equal(VOLUME_DEFAULTS.windowTurns, 20);
  });

  it('uses the Compaction Cliff figures', () => {
    assert.equal(VOLUME_DEFAULTS.exposureEscalateAt, 5);
  });

  it('allows more compactions per window than the escalation point', () => {
    // Otherwise the rate alert would be unreachable: the exposure budget would
    // always fire first and the rate would never get a look.
    assert.equal(
      VOLUME_DEFAULTS.maxCompactionsPerWindow < VOLUME_DEFAULTS.exposureEscalateAt,
      true,
    );
  });

  it('is frozen, so a caller cannot retune the shared defaults', () => {
    assert.ok(Object.isFrozen(VOLUME_DEFAULTS));
  });
});
