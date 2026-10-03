import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EVICTION_SKIPPED_CODE,
  EVICTION_SKIPPED_PREFIX,
  GIST_INVARIANTS,
  STRATA_EVENT_TYPES,
  TELEMETRY_SCHEMA_VERSION,
  TelemetrySchemaError,
  compactionEvent,
  emitCompaction,
  evictionSkipReason,
  gistEvent,
  isStrataTelemetryEvent,
  makeRecord,
  recordRunId,
} from '../src/index.js';

import {
  NOW,
  ONE_OF_EVERY_TYPE,
  RUN,
  TASK,
  asEvent,
  asNumber,
  canary,
  compactionOutcome,
  gist,
  gistValidation,
  requestIn,
  savings,
} from './fixtures.js';

describe('G-1 the event schema', () => {
  it('names exactly the types the union declares', () => {
    // A `type` in STRATA_EVENT_TYPES with no required-fields entry would be an
    // event the schema accepts structurally but cannot validate; a real event
    // with no entry would be one the sink accepts with no checks at all.
    assert.deepEqual(
      [...STRATA_EVENT_TYPES].sort(),
      [...new Set(ONE_OF_EVERY_TYPE.map((e) => e.type))].sort(),
    );
  });

  it('accepts one of every type', () => {
    for (const event of ONE_OF_EVERY_TYPE) {
      assert.equal(isStrataTelemetryEvent(event), true, event.type);
    }
  });

  it('rejects an unknown discriminator rather than guessing at a member', () => {
    // The whole reason `v` is on the envelope: reading an unknown `type` as
    // some member is the silent mis-parse a version field exists to prevent.
    assert.equal(isStrataTelemetryEvent(asEvent({ type: 'telemetry', runId: RUN })), false);
    assert.equal(isStrataTelemetryEvent(asEvent({ type: '' })), false);
    assert.equal(isStrataTelemetryEvent(asEvent({ type: 7 })), false);
  });

  it('rejects anything that is not an object', () => {
    for (const v of [null, undefined, 1, 'x', true, []]) {
      assert.equal(isStrataTelemetryEvent(v), false, String(v));
    }
  });

  it('rejects an event that is missing any one required field', () => {
    // A sink that accepts anything is a sink whose dashboard divides by an
    // undefined and reports a 100% violation rate.
    const full: Record<string, unknown> = { ...requestIn() };
    for (const key of Object.keys(full)) {
      const broken: Record<string, unknown> = { ...full };
      delete broken[key];
      assert.equal(isStrataTelemetryEvent(broken), false, `without ${key}`);
    }
  });

  it('accepts a null netFraction, which is a real answer, and rejects a string', () => {
    // netFraction is null when the baseline cannot be priced. Collapsing that
    // to 0 would report "we saved nothing" for a run nobody could measure.
    assert.equal(isStrataTelemetryEvent(savings({ netFraction: null })), true);
    assert.equal(isStrataTelemetryEvent(savings({ netFraction: 0.1 })), true);
    assert.equal(isStrataTelemetryEvent(savings({ netFraction: asNumber('lots') })), false);
  });
});

describe('G-1 the record envelope', () => {
  it('stamps the schema version on every record', () => {
    // A telemetry format with no version is a future postmortem: a reader
    // cannot tell whether it understands a record or merely mis-parses it.
    const record = makeRecord(0, NOW, requestIn());
    assert.equal(record.v, TELEMETRY_SCHEMA_VERSION);
    assert.equal(record.seq, 0);
    assert.equal(record.at, NOW);
  });

  it('numbers records from zero and refuses a sequence it cannot order', () => {
    for (const seq of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => makeRecord(seq, NOW, requestIn()), TelemetrySchemaError, `seq ${String(seq)}`);
    }
  });

  it('refuses a non-finite timestamp', () => {
    // `at` comes from an injected clock, and a clock that returned NaN would
    // otherwise produce a record that sorts nowhere.
    for (const at of [Number.NaN, Number.POSITIVE_INFINITY, -Number.POSITIVE_INFINITY]) {
      assert.throws(() => makeRecord(0, at, requestIn()), TelemetrySchemaError, String(at));
    }
  });

  it('refuses to record an event that does not match the schema', () => {
    assert.throws(
      () => makeRecord(0, NOW, asEvent({ type: 'nope' })),
      TelemetrySchemaError,
      'refusing to record',
    );
  });

  it('freezes the record, so a later mutation cannot rewrite history', () => {
    const record = makeRecord(0, NOW, requestIn());
    assert.equal(Object.isFrozen(record), true);
    assert.equal(Object.isFrozen(record.event), true);
  });

  it('reports the run id only for events that have one', () => {
    // Canary events are keyed by probe id, and inventing a run for one would
    // make the status report attribute probes to a session that never ran.
    assert.equal(recordRunId(makeRecord(0, NOW, requestIn())), RUN);
    assert.equal(recordRunId(makeRecord(1, NOW, canary())), undefined);
  });
});

describe('G-3 the compaction and gist events', () => {
  it('mirrors the outcome onto the frozen member', () => {
    assert.deepEqual(compactionEvent(compactionOutcome({ beforeTokens: 1000, afterTokens: 250, droppedCount: 9 })), {
      type: 'compaction',
      runId: RUN,
      trigger: 'task_boundary',
      beforeTokens: 1000,
      afterTokens: 250,
      droppedCount: 9,
      compressionBy: 'self-gist',
      validationPassed: true,
    });
  });

  it('carries the four step-4 invariants §8 asks for, separately', () => {
    // The frozen `compaction` member has one collapsed `validationPassed` bit,
    // which cannot answer "did the summarizer keep the pins?". The gist member
    // exists for exactly that question.
    const event = gistEvent({
      runId: RUN,
      taskId: TASK,
      schemaValid: true,
      constraintsIntact: false,
      rawRecoverable: true,
      compressionBy: 'self-gist',
      failed: ['constraints_byte_equal'],
    });

    assert.equal(event.type, 'gist');
    assert.equal(event.schemaValid, true);
    assert.equal(event.constraintsIntact, false);
    assert.equal(event.rawRecoverable, true);
    assert.deepEqual([...event.failed], ['constraints_byte_equal']);
  });

  it('defaults `failed` to empty and freezes it', () => {
    // An empty list alongside schemaValid:true is the only healthy reading, so
    // the default has to be the empty list rather than undefined.
    const event = gistEvent(gist());
    assert.deepEqual([...event.failed], []);
    assert.equal(Object.isFrozen(event.failed), true);
  });

  it('names the invariants the transaction actually checks', () => {
    // Straight out of architecture §5 step 4: 4a shas, 4b the scary one, 4c the
    // security gate, 4d artifacts resolve. A fifth name would claim a check
    // that does not exist.
    assert.deepEqual(
      [...GIST_INVARIANTS],
      ['changed_sha', 'unresolved_survives', 'constraints_byte_equal', 'artifact_resolves'],
    );
  });

  it('emits validation before the outcome, so an abort is still recorded', () => {
    // A validation failure aborts the transaction, so there is no compaction
    // to log at step 8. Emitting in the other order loses the only trace.
    const seen: string[] = [];
    const emitted = emitCompaction(
      (e) => seen.push(e.type),
      {
        validation: gistValidation({ schemaValid: false, constraintsIntact: false, failed: ['constraints_byte_equal'] }),
        outcome: compactionOutcome({ validationPassed: false }),
      },
    );

    assert.deepEqual(seen, ['gist', 'compaction']);
    assert.deepEqual(
      emitted.map((e) => e.type),
      ['gist', 'compaction'],
    );
  });

  it('is deterministic for the same input (N6)', () => {
    const input = { validation: gistValidation(), outcome: compactionOutcome() };
    assert.deepEqual(emitCompaction(() => {}, input), emitCompaction(() => {}, input));
  });
});

describe('G-8 the eviction-skip vocabulary', () => {
  it('names the code the transaction puts on the refusal, byte for byte', () => {
    // Renaming this orphans every `error` record already on disk: `status.ts`
    // recognises the refusal by equality, not by prefix, precisely so a code
    // cannot be silently half-matched. The value is therefore frozen against
    // logs written by gist/src/transaction.ts:683.
    assert.equal(EVICTION_SKIPPED_CODE, 'EVICTION_SKIPPED_UNVERIFIED');
  });

  it('recovers the bare reason from a gist failed entry', () => {
    assert.equal(
      evictionSkipReason([`${EVICTION_SKIPPED_PREFIX} raw_uri "artifact://strata/raw/s/1" is unresolvable`]),
      'raw_uri "artifact://strata/raw/s/1" is unresolvable',
    );
  });

  it('returns undefined for any other failed entry, rather than a half-match', () => {
    // The other entries on the same array are the step-4 invariants, and a
    // prefix match that also caught them would attribute a validation abort to
    // eviction.
    assert.equal(evictionSkipReason(['constraints_byte_equal']), undefined);
    assert.equal(evictionSkipReason(['changed_sha', 'artifact_resolves']), undefined);
    assert.equal(evictionSkipReason([]), undefined);
    assert.equal(evictionSkipReason(['eviction_skipped']), undefined, 'the prefix carries the colon');
  });

  it('does not match a prefix that is not the marker', () => {
    assert.equal(evictionSkipReason(['eviction_skipped_x: nope']), undefined);
  });
});
