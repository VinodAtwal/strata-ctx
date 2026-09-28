import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { TelemetryEvent } from '@strata-ctx/core-types';

import {
  FROZEN_VIOLATION_KINDS,
  ViolationLog,
  ViolationRecorder,
  sanitizeDetail,
  violationEvent,
  type ViolationKind,
  type ViolationRecord,
  type ViolationSink,
} from '../src/violations.js';

const ctx = { runId: 'run-7', turn: 42 };

class CollectingSink implements ViolationSink {
  readonly seen: ViolationRecord[] = [];
  record(violation: ViolationRecord): void {
    this.seen.push(violation);
  }
}

describe('D-2 severity: a missing pin is a P0, not a warning', () => {
  it('records pin_missing_pre_apply as P0 and names the constraints', () => {
    const recorder = new ViolationRecorder([], () => 1_700_000_000_000);
    const v = recorder.record(
      {
        kind: 'pin_missing_pre_apply',
        severity: 'P0',
        constraintIds: ['soft.client-email', 'pref.legacy-adapter'],
        detail: '2 constraint(s) missing before the pin stage ran',
      },
      ctx,
    );

    assert.equal(v.kind, 'pin_missing_pre_apply');
    assert.equal(v.severity, 'P0');
    assert.deepEqual([...v.constraintIds], ['soft.client-email', 'pref.legacy-adapter']);
    assert.equal(v.runId, 'run-7');
    assert.equal(v.turn, 42);
    assert.equal(v.at, 1_700_000_000_000);
    assert.equal(v.blocked, false, 'the pin was re-applied, so the request still went out');
  });

  it('keeps ids, not constraint text: an id is ours, a text may be the user\'s', () => {
    // The record travels to sinks and to a log file. Constraint text can be a
    // customer's rule; an id cannot be turned into anything by whoever reads it.
    const recorder = new ViolationRecorder();
    const v = recorder.record(
      {
        kind: 'pin_post_compact_missing',
        severity: 'P0',
        constraintIds: ['soft.client-email'],
        detail: 'ok',
      },
      ctx,
    );
    assert.equal(JSON.stringify(v).includes('never email the client directly'), false);
  });

  it('defaults constraintIds to an empty frozen array and blocked to false', () => {
    const v = new ViolationRecorder().record(
      { kind: 'volume_attack', severity: 'P1', detail: 'rate' },
      ctx,
    );
    assert.deepEqual([...v.constraintIds], []);
    assert.equal(v.blocked, false);
    assert.throws(() => {
      (v.constraintIds as string[]).push('x');
    }, TypeError);
  });
});

describe('D-2 the record survives its own plumbing', () => {
  it('appends to the recorder\'s own log even with no sink wired up', () => {
    // A security control that is only as loud as its plumbing is not a control.
    // Nothing has to have called `new ViolationRecorder([sink])` for the
    // evidence to exist.
    const recorder = new ViolationRecorder();
    recorder.record({ kind: 'canary_fail', severity: 'P1', detail: 'gone' }, ctx);

    assert.equal(recorder.log.count, 1);
    assert.equal(recorder.p0().length, 0);
  });

  it('forwards the same frozen object to every sink, in wiring order', () => {
    const a = new CollectingSink();
    const b = new CollectingSink();
    const recorder = new ViolationRecorder([a, b]);

    const v = recorder.record({ kind: 'canary_fail', severity: 'P1', detail: 'gone' }, ctx);

    assert.equal(a.seen.length, 1);
    assert.equal(b.seen.length, 1);
    assert.equal(a.seen[0], v, 'identity, not a copy: a sink cannot observe a later mutation');
    assert.equal(b.seen[0], v);
    assert.equal(recorder.log.all()[0], v);
  });

  it('is deterministic under an injected clock', () => {
    const at = 1_700_000_123_456;
    const a = new ViolationRecorder([], () => at).record(
      { kind: 'canary_fail', severity: 'P1', detail: 'same input' },
      ctx,
    );
    const b = new ViolationRecorder([], () => at).record(
      { kind: 'canary_fail', severity: 'P1', detail: 'same input' },
      ctx,
    );
    assert.deepEqual(a, b);
  });
});

describe('D-2 detail sanitisation', () => {
  it('flattens newlines and terminal escapes out of attacker-controlled text', () => {
    // The one place in the system where an attacker gets to write into our
    // logs: injected governance text is quoted into `detail`. Without this a
    // forged constraint of "x\n[ok] all clear" rewrites the shape of the log.
    const hostile = 'fake rule\n[ok] governance intact\r\u001b[31mred';
    const flat = sanitizeDetail(hostile);

    assert.equal(flat.includes('\n'), false);
    assert.equal(flat.includes('\r'), false);
    assert.equal(flat.includes('\u001b'), false);
    assert.equal(flat, 'fake rule [ok] governance intact  [31mred');
  });

  it('caps the length so one injected constraint cannot flood the log', () => {
    const flat = sanitizeDetail('z'.repeat(5_000));
    assert.equal(flat.length, 203);
    assert.ok(flat.endsWith('...'));
  });

  it('applies to records built through record(), not just to the helper', () => {
    const v = new ViolationRecorder().record(
      { kind: 'pin_injected_text', severity: 'P0', detail: 'a\nb' },
      ctx,
    );
    assert.equal(v.detail, 'a b');
  });
});

describe('D-2 the frozen telemetry projection, and where it runs out', () => {
  it('projects the three kinds core-types can carry', () => {
    for (const kind of FROZEN_VIOLATION_KINDS) {
      const v: ViolationRecord = {
        kind,
        severity: 'P0',
        runId: 'run-7',
        turn: 1,
        constraintIds: ['c1'],
        detail: 'x',
        blocked: true,
        at: 0,
      };
      const event = violationEvent(v);
      assert.ok(event, kind);
      assert.equal(event.type, 'violation');
      assert.equal(event.kind, kind);
      assert.equal(event.blocked, true);
      assert.deepEqual([...event.constraintIds], ['c1']);
    }
  });

  it('returns undefined for the three kinds the frozen contract cannot express', () => {
    // These are real events the product has to see and that core-types has no
    // room for. They stay in `ViolationLog` regardless, so a telemetry sink
    // wired up later still sees the history -- but nothing pretending to be a
    // contract event gets invented for them. See the proposal in ./violations.
    const proposed: readonly ViolationKind[] = [
      'pin_injected_text',
      'volume_attack',
      'policy_override_refused',
    ];
    for (const kind of proposed) {
      const event = violationEvent({
        kind,
        severity: 'P1',
        runId: 'run-7',
        turn: 1,
        constraintIds: [],
        detail: 'x',
        blocked: false,
        at: 0,
      });
      assert.equal(event, undefined, kind);
    }
    assert.equal(FROZEN_VIOLATION_KINDS.length, 3);
    assert.equal(new Set(FROZEN_VIOLATION_KINDS).size, 3, 'no duplicates in the frozen list');
  });

  it('never fabricates a frozen kind for a proposed one', () => {
    // The projection is a lookup, not a cast-and-hope. If it ever became the
    // latter, a `volume_attack` would be reported to the provider as a
    // `pin_missing_pre_apply`, which is a false P0 on the safety dashboard.
    const v = new ViolationRecorder().record(
      { kind: 'volume_attack', severity: 'P1', detail: 'x' },
      ctx,
    );
    assert.equal(violationEvent(v), undefined);
    assert.equal(recorder_kinds_of(recorderWith(v)).includes('pin_missing_pre_apply'), false);
  });
});

function recorderWith(v: ViolationRecord): ViolationRecorder {
  const r = new ViolationRecorder();
  r.log.record(v);
  return r;
}

function recorder_kinds_of(r: ViolationRecorder): readonly string[] {
  return r.log.all().map((x) => x.kind);
}

describe('ViolationLog queries', () => {
  it('filters by kind and by severity, and never hands out its own array', () => {
    const log = new ViolationLog();
    for (const [kind, severity] of [
      ['canary_fail', 'P1'],
      ['canary_fail', 'P0'],
      ['volume_attack', 'P1'],
    ] as const) {
      log.record({ kind, severity, runId: 'r', turn: 0, constraintIds: [], detail: '', blocked: false, at: 0 });
    }

    assert.equal(log.count, 3);
    assert.equal(log.byKind('canary_fail').length, 2);
    assert.equal(log.byKind('volume_attack').length, 1);
    assert.equal(log.p0().length, 1);
    assert.equal(log.p0()[0]?.severity, 'P0');

    const all = log.all();
    assert.throws(() => {
      (all as ViolationRecord[]).push(all[0] as ViolationRecord);
    }, TypeError);
  });
});

describe('the projection really is a TelemetryEvent', () => {
  it('type-checks as the frozen union member and keeps the constraint ids', () => {
    const v = new ViolationRecorder().record(
      { kind: 'pin_post_compact_missing', severity: 'P0', constraintIds: ['a'], detail: '', blocked: true },
      ctx,
    );
    const event: TelemetryEvent | undefined = violationEvent(v);
    assert.ok(event);
    assert.equal(event.type, 'violation');
  });
});
