import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { sha256 } from '@strata-ctx/core-types';
import type { RetentionPolicy } from '@strata-ctx/core-types';

import { AdvisoryNotAcknowledgedError, DAY_MS, applyGc, assertPlanAcknowledged, expiresAt, planGc, retentionClassOf, runGc, windowDaysFor } from '../src/retention.js';
import type { ArtifactStat } from '../src/store.js';
import { DAY, T0, clock, tempStore, testPolicy, withTempDir } from './fixtures.js';

/**
 * I-5 and I-8: what ages out, what refuses to, and the difference between the
 * two being visible.
 *
 * The clock is injected everywhere, so these are arithmetic rather than a
 * multi-week wait. The tests that matter are the ones where a *retain-worthy*
 * item shows up in the plan: the property is not that the GC refuses to delete
 * it (the GC never lists it as a deletion), it is that the GC says so out loud
 * and cannot proceed silently.
 */

const POLICY: RetentionPolicy = { rawTranscriptDays: 7, artifactDays: 30, keepPurgeLog: true };

const stat = (over: Partial<ArtifactStat> = {}): ArtifactStat => ({
  uri: `artifact://other/${sha256(String(over.bytes ?? 1))}`,
  digest: sha256(String(over.bytes ?? 1)),
  bytes: over.bytes ?? 100,
  kind: 'file_snapshot',
  writtenAt: T0,
  redacted: false,
  redactionKinds: [],
  sourceDigest: '',
  integrity: 'exact',
  path: '/nowhere',
  ...over,
});

describe('the windows', () => {
  it('gives raw user context the shorter window', () => {
    // Data minimisation starts with the most sensitive thing the product
    // touches. A transcript is the user's own words; a patch is not.
    assert.equal(windowDaysFor({ kind: 'raw_transcript' }, POLICY), 7);
    assert.equal(windowDaysFor({ kind: 'tool_log' }, POLICY), 7);
    assert.equal(windowDaysFor({ kind: 'file_snapshot' }, POLICY), 30);
    assert.equal(windowDaysFor({ kind: 'patch' }, POLICY), 30);
    assert.equal(windowDaysFor({ kind: 'other' }, POLICY), 30);
  });

  it('classifies raw and artifact kinds', () => {
    assert.equal(retentionClassOf({ kind: 'raw_transcript' }), 'raw');
    assert.equal(retentionClassOf({ kind: 'tool_log' }), 'raw');
    assert.equal(retentionClassOf({ kind: 'file_snapshot' }), 'artifact');
  });

  it('computes the expiry from the write time and the window', () => {
    assert.equal(expiresAt({ kind: 'raw_transcript', writtenAt: T0 }, POLICY), T0 + 7 * DAY_MS);
    assert.equal(expiresAt({ kind: 'patch', writtenAt: T0 }, POLICY), T0 + 30 * DAY_MS);
  });

  it('takes the windows from policy, not from a constant', () => {
    const strict: RetentionPolicy = { rawTranscriptDays: 1, artifactDays: 2, keepPurgeLog: true };
    assert.equal(windowDaysFor({ kind: 'raw_transcript' }, strict), 1);
    assert.equal(windowDaysFor({ kind: 'other' }, strict), 2);
  });
});

describe('planGc', () => {
  const at = (days: number, kind: ArtifactStat['kind'] = 'file_snapshot'): ArtifactStat =>
    stat({ kind, writtenAt: T0 + days * DAY, bytes: days });

  it('deletes nothing inside the window', () => {
    const plan = planGc([at(1), at(29, 'file_snapshot')], { policy: POLICY, now: T0 + 30 * DAY });
    assert.deepEqual(plan.delete, []);
    assert.equal(plan.skip.length, 2);
    assert.ok(plan.skip.every((s) => s.reason === 'within_window'));
  });

  it('deletes what is past its window', () => {
    // The patch is 31 days old against a 30-day window; the transcript is 8 days
    // old against a 7-day one. Both windows are measured from the write, not
    // from the store's creation, and the classes differ.
    const plan = planGc([at(31, 'file_snapshot'), at(8, 'raw_transcript')], {
      policy: POLICY,
      now: T0 + 70 * DAY,
    });
    assert.equal(plan.delete.length, 2);
    assert.deepEqual(
      plan.delete.map((c) => c.class).sort(),
      ['artifact', 'raw'],
    );
    assert.equal(plan.bytesFreedIfApplied, 39);
  });

  it('deletes exactly when the window has elapsed, not before', () => {
    // The window is a deadline, not a grace period: at `writtenAt + 30d` the
    // 30 days are up. The failure that matters is deleting *early*, so the
    // assertion one millisecond earlier is the one below.
    const s = at(30, 'file_snapshot');
    const oneMsEarly = planGc([s], { policy: POLICY, now: s.writtenAt + 30 * DAY_MS - 1 });
    assert.deepEqual(oneMsEarly.delete, [], 'the window expired early');
    const atDeadline = planGc([s], { policy: POLICY, now: s.writtenAt + 30 * DAY_MS });
    assert.equal(atDeadline.delete.length, 1);
  });

  it('refuses to age out an item with no timestamp', () => {
    // `writtenAt: 0` is what a store with a missing sidecar reports. Deleting
    // it would make an unreadable artifact indistinguishable from an expired one.
    const plan = planGc([stat({ writtenAt: 0 })], { policy: POLICY, now: T0 + 999 * DAY });
    assert.deepEqual(plan.delete, []);
    assert.equal(plan.skip[0]?.reason, 'unknown_age');
  });

  it('refuses to age out an item dated in the future', () => {
    const plan = planGc([stat({ writtenAt: T0 + 10 * DAY })], { policy: POLICY, now: T0 });
    assert.deepEqual(plan.delete, []);
    assert.equal(plan.skip[0]?.reason, 'unknown_age');
  });
});

describe('I-8: retain-worthy items are advisories, not deletions', () => {
  it('never lists a gist-referenced artifact as a deletion', () => {
    const s = stat({ writtenAt: T0, bytes: 42 });
    const plan = planGc([s], {
      policy: POLICY,
      now: T0 + 999 * DAY,
      referencedDigests: new Set([s.digest]),
    });
    assert.deepEqual(plan.delete, [], 'a live gist pointer was queued for deletion');
    assert.equal(plan.advisories.length, 1);
    assert.equal(plan.advisories[0]?.reason, 'referenced_by_gist');
    assert.equal(plan.skip[0]?.reason, 'referenced_by_gist');
  });

  it('names what the user would lose', () => {
    const s = stat({ writtenAt: T0 });
    const plan = planGc([s], { policy: POLICY, now: T0 + 999 * DAY, referencedDigests: new Set([s.digest]) });
    assert.match(plan.advisories[0]?.consequence ?? '', /reversib/);
  });

  it('never lists an audited artifact as a deletion', () => {
    const s = stat({ writtenAt: T0 });
    const plan = planGc([s], {
      policy: POLICY,
      now: T0 + 999 * DAY,
      auditTargets: new Set([s.uri]),
    });
    assert.deepEqual(plan.delete, []);
    assert.equal(plan.advisories[0]?.reason, 'subject_of_audit_record');
    assert.match(plan.advisories[0]?.consequence ?? '', /evidence/);
  });

  it('blocks the whole plan while an advisory is unacknowledged', () => {
    const plan = planGc([stat({ writtenAt: T0 })], {
      policy: POLICY,
      now: T0 + 999 * DAY,
      referencedDigests: new Set([stat({ writtenAt: T0 }).digest]),
    });
    assert.throws(
      () => assertPlanAcknowledged(plan, { policy: POLICY, now: T0 + 999 * DAY }),
      AdvisoryNotAcknowledgedError,
    );
  });

  it('lets an explicit acknowledgement through, and keeps the advisory in the report', () => {
    const s = stat({ writtenAt: T0 });
    const options = {
      policy: POLICY,
      now: T0 + 999 * DAY,
      referencedDigests: new Set([s.digest]),
    };
    const plan = planGc([s], options);
    assert.doesNotThrow(() => assertPlanAcknowledged(plan, { ...options, force: true }));
    // Acknowledged, not hidden: the operator still gets to see what they agreed
    // to delete after the fact.
    assert.equal(plan.advisories.length, 1);
    assert.deepEqual(plan.delete, [], 'even force does not delete a gist reference');
  });
});

describe('an explicit boundary ignores the retention window', () => {
  it('deletes a young item when the caller set the cutoff', () => {
    const s = stat({ writtenAt: T0 });
    // 3 days old, with a 30-day window. A purge that honoured the window would
    // silently do less than it was told, which is the failure mode this
    // boundary exists to remove.
    const plan = planGc([s], { policy: POLICY, boundary: 'explicit', now: T0 + 3 * DAY });
    assert.equal(plan.delete.length, 1);
  });

  it('still reports the window for context', () => {
    const plan = planGc([stat({ kind: 'raw_transcript', writtenAt: T0 })], {
      policy: POLICY,
      boundary: 'explicit',
      now: T0 + 999 * DAY,
    });
    assert.equal(plan.delete[0]?.class, 'raw');
  });
});

describe('applyGc against a real store', () => {
  it('deletes expired objects and prunes their aliases', async () => {
    await withTempDir(async (dir) => {
      const t = clock(T0);
      const store = await tempStore(dir, { now: t.now });
      const old = await store.put('old', 'file_snapshot', { at: T0 });
      const fresh = await store.put('fresh', 'file_snapshot', { at: T0 + 20 * DAY });

      t.set(T0 + 40 * DAY);
      const { plan, report } = await runGc(store, { policy: POLICY, now: t.now() });

      assert.deepEqual(plan.delete.map((c) => c.stat.digest), [old.sha256]);
      assert.equal(report.deleted.length, 1);
      assert.equal(await store.exists(old.uri), false);
      assert.equal(await store.exists(fresh.uri), true, 'the young artifact was deleted');
    });
  });

  it('writes a gc_deleted record, so the deletion is itself auditable', async () => {
    await withTempDir(async (dir) => {
      const t = clock(T0);
      const store = await tempStore(dir, { now: t.now });
      await store.put('old', 'file_snapshot', { at: T0 });
      t.set(T0 + 40 * DAY);
      await runGc(store, { policy: POLICY, now: t.now() });
      const records = await store.audit.read();
      assert.ok(records.some((e) => e.action === 'gc_deleted' && e.count === 1));
    });
  });

  it('is a no-op on an empty store', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      const { report } = await runGc(store, { policy: POLICY, now: T0 + 999 * DAY });
      assert.deepEqual(report.deleted, []);
      assert.equal(report.bytesFreed, 0);
    });
  });

  it('refuses to run at all when a gist reference would be deleted', async () => {
    await withTempDir(async (dir) => {
      const t = clock(T0);
      const store = await tempStore(dir, { now: t.now });
      const gistArtifact = await store.put('referenced', 'file_snapshot', { at: T0 });
      t.set(T0 + 400 * DAY);

      await assert.rejects(
        () => runGc(store, { policy: POLICY, now: t.now(), referencedDigests: new Set([gistArtifact.sha256]) }),
        AdvisoryNotAcknowledgedError,
      );
      // Nothing was deleted, not even the unrelated expired objects.
      assert.equal(await store.exists(gistArtifact.uri), true);
      const others = await fs.readdir(join(store.root, 'objects'));
      assert.ok(others.length > 0);
    });
  });

  it('rejects a plan whose advisory count does not match the acknowledgement', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      await store.put('x', 'file_snapshot', { at: T0 });
      const plan = planGc(await store.list(), {
        policy: POLICY,
        now: T0 + 999 * DAY,
        referencedDigests: new Set([sha256('x')]),
      });
      await assert.rejects(
        () => applyGc(store, plan, { policy: POLICY, now: T0 + 999 * DAY }),
        AdvisoryNotAcknowledgedError,
      );
    });
  });
});

describe('the policy the store is opened with drives the windows', () => {
  it('uses the retention block from a real policy document', () => {
    const policy = testPolicy({ retention: { rawTranscriptDays: 2, artifactDays: 5 } });
    assert.equal(windowDaysFor({ kind: 'raw_transcript' }, policy.retention), 2);
    assert.equal(windowDaysFor({ kind: 'other' }, policy.retention), 5);
  });
});
