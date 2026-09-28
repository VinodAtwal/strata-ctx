import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { RetentionPolicy } from '@strata-ctx/core-types';

import { META_PURGE_LOG_NAME, PURGE_LOG_NAME } from '../src/audit.js';
import { META_PURGE_CONFIRMATION, PURGE_SCOPES, handlePurgeRequest, parsePurgeRequest } from '../src/purge.js';
import { DAY, T0, clock, tempStore, withTempDir } from './fixtures.js';

/**
 * I-5 and I-7: the `/strata/purge` endpoint logic and the meta-purge.
 *
 * Two properties carry the weight here, and both are about the *refusals*:
 *
 * 1. The purge log cannot be reached through the ordinary purge. `keepPurgeLog:
 *    true` in the frozen policy is decorative if `scope: 'audit'` answers
 *    without the confirmation token, so it asks for the same token and is
 *    tested from both directions -- no token, wrong token, right token.
 * 2. A request that is understood but hits a retain-worthy item returns 409 and
 *    deletes nothing. Not "deletes the rest" -- a partial purge reported as
 *    success is the worst thing this endpoint could do.
 */

const POLICY: RetentionPolicy = { rawTranscriptDays: 7, artifactDays: 30, keepPurgeLog: true };

interface Deps {
  readonly now: () => number;
  readonly purge: (body: unknown) => Promise<Awaited<ReturnType<typeof handlePurgeRequest>>>;
  readonly store: Awaited<ReturnType<typeof tempStore>>;
}

/** A store with one artifact per kind, all old enough to purge. */
const scaffold = async (dir: string): Promise<Deps> => {
  const t = clock(T0);
  const store = await tempStore(dir, { now: t.now });
  await store.put('a transcript', 'raw_transcript', { at: T0 });
  await store.put('a tool log', 'tool_log', { at: T0 });
  await store.put('a snapshot', 'file_snapshot', { at: T0 });
  await store.put('a patch', 'patch', { at: T0 });
  t.set(T0 + 100 * DAY);
  return { now: t.now, purge: (body) => handlePurgeRequest(body, { store, retention: POLICY, now: t.now }), store };
};

describe('parsePurgeRequest', () => {
  it('rejects a body that is not an object', () => {
    for (const body of [null, 42, 'purge', [], undefined]) {
      const parsed = parsePurgeRequest(body);
      assert.equal(parsed.ok, false);
      if (!parsed.ok) assert.equal(parsed.status, 400);
    }
  });

  it('requires op: purge', () => {
    const parsed = parsePurgeRequest({ op: 'delete' });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.error, /op must be/);
  });

  it('rejects an unknown scope rather than coercing it', () => {
    // A scope that arrives as an object or an array must not become a scope.
    for (const scope of ['everything', '', 'ALL', { scope: 'all' }, ['all'], 7, null]) {
      const parsed = parsePurgeRequest({ op: 'purge', scope });
      assert.equal(parsed.ok, false, `accepted scope ${JSON.stringify(scope)}`);
      if (!parsed.ok) assert.equal(parsed.status, 400);
    }
  });

  it('accepts every documented scope', () => {
    for (const scope of PURGE_SCOPES) {
      const body = scope === 'audit' ? { op: 'purge', scope, confirm: META_PURGE_CONFIRMATION } : { op: 'purge', scope };
      const parsed = parsePurgeRequest(body);
      assert.equal(parsed.ok, true, `rejected ${scope}`);
    }
  });

  it('requires an explicit scope rather than defaulting to all', () => {
    // "Delete everything" is the one request where a typo in the wrong field
    // matters most, so it is spelled out by the caller and not inferred here.
    const parsed = parsePurgeRequest({ op: 'purge' });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.equal(parsed.status, 400);
      assert.match(parsed.error, /scope/);
    }
  });

  it('rejects a before that is not an instant', () => {
    const parsed = parsePurgeRequest({ op: 'purge', scope: 'all', before: 'last tuesday' });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.error, /iso-8601/);
  });

  it('normalises a before it accepts', () => {
    const parsed = parsePurgeRequest({ op: 'purge', scope: 'all', before: '2026-09-28T00:00:00+02:00' });
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.request.before, '2026-09-27T22:00:00.000Z');
  });

  it('defaults an omitted before to no cutoff at all', () => {
    const parsed = parsePurgeRequest({ op: 'purge', scope: 'all' });
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.request.before, '9999-12-31T23:59:59.999Z');
  });

  it('ignores a non-boolean force rather than treating it as true', () => {
    const parsed = parsePurgeRequest({ op: 'purge', scope: 'all', force: 'yes' });
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.request.force, false);
  });
});

describe('I-7: the meta-purge needs an explicit token', () => {
  it('refuses meta: true without the token', () => {
    const parsed = parsePurgeRequest({ op: 'purge', scope: 'all', meta: true });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.status, 403);
  });

  it('refuses scope: audit without the token, so there is no back door', () => {
    // This is the one that makes `keepPurgeLog: true` mean something. If the
    // ordinary purge could reach the log, the frozen flag would be a comment.
    const parsed = parsePurgeRequest({ op: 'purge', scope: 'audit' });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.equal(parsed.status, 403);
      assert.match(parsed.error, /R9/);
    }
  });

  it('refuses the wrong token', () => {
    for (const confirm of ['', 'yes', 'erase-the-purge-log', META_PURGE_CONFIRMATION.toLowerCase()]) {
      const parsed = parsePurgeRequest({ op: 'purge', scope: 'audit', confirm });
      assert.equal(parsed.ok, false, `accepted confirm=${JSON.stringify(confirm)}`);
      if (!parsed.ok) assert.equal(parsed.status, 403);
    }
  });

  it('still requires a scope when the confirmation token is present', () => {
    // The token authorises the erasure; it does not supply the intent. A body
    // with a valid token and no scope is a client bug, not a request.
    const parsed = parsePurgeRequest({ op: 'purge', confirm: META_PURGE_CONFIRMATION });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.status, 400);
  });

  it('accepts the correct token', () => {
    const parsed = parsePurgeRequest({ op: 'purge', scope: 'audit', confirm: META_PURGE_CONFIRMATION });
    assert.equal(parsed.ok, true);
  });
});

describe('scope', () => {
  it('deletes artifacts but leaves transcripts', async () => {
    await withTempDir(async (dir) => {
      const d = await scaffold(dir);
      const res = await d.purge({ op: 'purge', scope: 'artifacts' });
      assert.equal(res.status, 200);
      assert.equal(res.body.deleted.length, 2, 'snapshot and patch');
      const left = await d.store.list();
      assert.deepEqual(left.map((s) => s.kind).sort(), ['raw_transcript', 'tool_log']);
    });
  });

  it('deletes transcripts but leaves artifacts', async () => {
    await withTempDir(async (dir) => {
      const d = await scaffold(dir);
      const res = await d.purge({ op: 'purge', scope: 'transcripts' });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.deleted.map((x) => x.uri.split('://')[1]?.split('/')[0]).sort(), ['log', 'transcript']);
      const left = await d.store.list();
      assert.deepEqual(left.map((s) => s.kind).sort(), ['file_snapshot', 'patch']);
    });
  });

  it('deletes everything for scope: all', async () => {
    await withTempDir(async (dir) => {
      const d = await scaffold(dir);
      const res = await d.purge({ op: 'purge', scope: 'all' });
      assert.equal(res.status, 200);
      assert.equal(res.body.deleted.length, 4);
      assert.deepEqual(await d.store.list(), []);
    });
  });
});

describe('the before cutoff is the boundary, not the retention window', () => {
  it('keeps anything newer than before', async () => {
    await withTempDir(async (dir) => {
      const t = clock(T0);
      const store = await tempStore(dir, { now: t.now });
      await store.put('old', 'other', { at: T0 });
      await store.put('recent', 'other', { at: T0 + 50 * DAY });
      t.set(T0 + 100 * DAY);

      const cutoff = new Date(T0 + 25 * DAY).toISOString();
      const res = await handlePurgeRequest({ op: 'purge', scope: 'all', before: cutoff }, { store, retention: POLICY, now: t.now });

      assert.equal(res.status, 200);
      assert.equal(res.body.deleted.length, 1, 'the 50-day-old artifact is inside the window and inside the cutoff');
      const left = await store.list();
      assert.equal(left.length, 1);
      assert.equal(left[0]?.writtenAt, T0 + 50 * DAY);
    });
  });

  it('deletes an item that is inside its window but older than before', async () => {
    await withTempDir(async (dir) => {
      const t = clock(T0);
      const store = await tempStore(dir, { now: t.now });
      // 3 days old, 30-day window. A purge that consulted the window would do
      // nothing here and report success, which is the quiet-failure mode.
      await store.put('young', 'other', { at: T0 + 97 * DAY });
      t.set(T0 + 100 * DAY);

      const res = await handlePurgeRequest(
        { op: 'purge', scope: 'all', before: new Date(T0 + 98 * DAY).toISOString() },
        { store, retention: POLICY, now: t.now },
      );
      assert.equal(res.status, 200);
      assert.equal(res.body.deleted.length, 1);
    });
  });

  it('answers 412 when before predates everything retained', async () => {
    await withTempDir(async (dir) => {
      const d = await scaffold(dir);
      const res = await d.purge({ op: 'purge', scope: 'all', before: new Date(T0 - DAY).toISOString() });
      assert.equal(res.status, 412);
      assert.equal(res.body.deleted.length, 0, 'a 412 must not have deleted anything');
      assert.equal((await d.store.list()).length, 4, 'the artifacts are still there');
    });
  });

  it('does not answer 412 for an unbounded request', async () => {
    await withTempDir(async (dir) => {
      const d = await scaffold(dir);
      assert.equal((await d.purge({ op: 'purge', scope: 'all' })).status, 200);
    });
  });
});

describe('I-8: a purge refuses rather than partially applying', () => {
  it('answers 409 and deletes nothing when an advisory is unacknowledged', async () => {
    await withTempDir(async (dir) => {
      const t = clock(T0);
      const store = await tempStore(dir, { now: t.now });
      const kept = await store.put('referenced by a gist', 'file_snapshot', { at: T0 });
      await store.put('unrelated', 'patch', { at: T0 });
      t.set(T0 + 100 * DAY);

      const res = await handlePurgeRequest(
        { op: 'purge', scope: 'all' },
        { store, retention: POLICY, now: t.now, referencedDigests: new Set([kept.sha256]) },
      );
      assert.equal(res.status, 409);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.advisories.length, 1);
      assert.equal(res.body.advisories[0]?.reason, 'referenced_by_gist');
      assert.match(res.body.error, /force/);
      // The critical assertion: the unrelated expired patch is still here. A
      // 409 that deleted the rest would be a partial purge reported as a
      // failure, and the user would have to know which half happened.
      assert.equal((await store.list()).length, 2);
      assert.equal(await store.exists(kept.uri), true);
    });
  });

  it('records the refusal in the purge log', async () => {
    await withTempDir(async (dir) => {
      const t = clock(T0);
      const store = await tempStore(dir, { now: t.now });
      const kept = await store.put('referenced', 'file_snapshot', { at: T0 });
      t.set(T0 + 100 * DAY);
      await handlePurgeRequest({ op: 'purge', scope: 'all' }, { store, retention: POLICY, now: t.now, referencedDigests: new Set([kept.sha256]) });
      const records = await store.audit.read();
      const refused = records.find((e) => e.action === 'purge_refused');
      assert.ok(refused, 'a refused purge left no record');
    });
  });

  it('proceeds when the caller acknowledges the advisory', async () => {
    await withTempDir(async (dir) => {
      const t = clock(T0);
      const store = await tempStore(dir, { now: t.now });
      const kept = await store.put('referenced', 'file_snapshot', { at: T0 });
      await store.put('unrelated', 'patch', { at: T0 });
      t.set(T0 + 100 * DAY);

      const res = await handlePurgeRequest(
        { op: 'purge', scope: 'all', force: true },
        { store, retention: POLICY, now: t.now, referencedDigests: new Set([kept.sha256]) },
      );
      // Acknowledged, so the *unrelated* item is gone -- and the referenced one
      // still is not, because an advisory is never a deletion at any force level.
      assert.equal(res.status, 200);
      assert.equal(res.body.deleted.length, 1);
      assert.equal(res.body.advisories.length, 1, 'the advisory is still reported after being acknowledged');
      assert.equal(await store.exists(kept.uri), true);
    });
  });
});

describe('the purge log is not erasable through the ordinary path', () => {
  it('returns 403 for scope: audit and leaves the log intact', async () => {
    await withTempDir(async (dir) => {
      const d = await scaffold(dir);
      const before = (await d.store.audit.read()).length;
      assert.ok(before > 0);
      const res = await d.purge({ op: 'purge', scope: 'audit' });
      assert.equal(res.status, 403);
      assert.equal((await d.store.audit.read()).length, before, 'the refused request changed the log');
    });
  });

  it('leaves the log intact through a full artifact purge', async () => {
    await withTempDir(async (dir) => {
      const d = await scaffold(dir);
      const res = await d.purge({ op: 'purge', scope: 'all' });
      assert.equal(res.status, 200);
      // The log grew (the purge itself was recorded) and still has every earlier
      // line: an artifact purge does not touch the log even when it empties the
      // store.
      const records = await d.store.audit.read();
      assert.ok(records.some((e) => e.action === 'purge_requested'));
      assert.ok(records.some((e) => e.action === 'artifact_written'));
      assert.ok(records.some((e) => e.action === 'purge_completed'));
    });
  });
});

describe('I-7: the meta-purge', () => {
  const confirmBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    op: 'purge',
    scope: 'audit',
    meta: true,
    confirm: META_PURGE_CONFIRMATION,
    ...extra,
  });

  it('empties the purge log and reports how many entries it held', async () => {
    await withTempDir(async (dir) => {
      const d = await scaffold(dir);
      const before = (await d.store.audit.read()).length;
      const res = await d.purge(confirmBody());
      assert.equal(res.status, 200);
      assert.equal(res.body.metaPurged, true);
      assert.equal(res.body.purgeLogEntries, 0, 'the log is not empty after a meta-purge');
      assert.ok(before > 0);
    });
  });

  it('writes a receipt somewhere else, with the log digest', async () => {
    await withTempDir(async (dir) => {
      const d = await scaffold(dir);
      const res = await d.purge(confirmBody());
      assert.equal(res.body.receipt.completed, true);
      assert.match(res.body.receipt.logDigest, /^[0-9a-f]{64}$/);
      assert.ok(res.body.receipt.entries > 0);

      const meta = await fs.readFile(join(dir, 'store', 'audit', META_PURGE_LOG_NAME), 'utf8');
      assert.match(meta, /meta_purge_started/);
      assert.match(meta, /meta_purge_completed/);
    });
  });

  it('writes the started record before the erasure, so an interruption is visible', async () => {
    await withTempDir(async (dir) => {
      const d = await scaffold(dir);
      await d.purge(confirmBody());
      const lines = (await fs.readFile(join(dir, 'store', 'audit', META_PURGE_LOG_NAME), 'utf8'))
        .split('\n')
        .filter((l) => l.trim() !== '');
      const startedAt = lines.findIndex((l) => l.includes('meta_purge_started'));
      const completedAt = lines.findIndex((l) => l.includes('meta_purge_completed'));
      assert.ok(startedAt >= 0 && completedAt >= 0);
      // Ordering in the file is the ordering of the operations: a crash between
      // the two leaves a started line and no completed line, which is the
      // accurate evidence of an interrupted erasure.
      assert.ok(startedAt < completedAt);
    });
  });

  it('records the purge itself in the meta log, not in the log it just emptied', async () => {
    await withTempDir(async (dir) => {
      const d = await scaffold(dir);
      await d.purge(confirmBody());
      const meta = await fs.readFile(join(dir, 'store', 'audit', META_PURGE_LOG_NAME), 'utf8');
      assert.match(meta, /purge_completed/);
      // The purge log stays empty. Appending the completion there would
      // re-populate what the user just asked to have emptied.
      const purge = await fs.readFile(join(dir, 'store', 'audit', PURGE_LOG_NAME), 'utf8').catch(() => '');
      assert.equal(purge.trim(), '');
    });
  });

  it('is not erasable by any request in the module', async () => {
    await withTempDir(async (dir) => {
      const d = await scaffold(dir);
      await d.purge(confirmBody());
      // A second meta-purge empties the purge log again -- it was already empty
      // -- and leaves the meta log, which is the fixed point of the whole
      // design. Without it, "erase the log" would be an infinite regress.
      const res = await d.purge(confirmBody());
      assert.equal(res.status, 200);
      const meta = await fs.readFile(join(dir, 'store', 'audit', META_PURGE_LOG_NAME), 'utf8');
      assert.match(meta, /meta_purge_started/, 'the meta log was erased by a meta-purge');
    });
  });

  it('purges artifacts and the log in one request', async () => {
    await withTempDir(async (dir) => {
      const d = await scaffold(dir);
      const res = await d.purge(confirmBody({ scope: 'all' }));
      assert.equal(res.status, 200);
      assert.equal(res.body.deleted.length, 4);
      assert.equal(res.body.metaPurged, true);
      assert.equal(res.body.purgeLogEntries, 0);
    });
  });
});

describe('a malformed request is refused without touching anything', () => {
  it('answers 400 for a nonsense body and deletes nothing', async () => {
    await withTempDir(async (dir) => {
      const d = await scaffold(dir);
      const res = await d.purge({ op: 'nope' });
      assert.equal(res.status, 400);
      assert.equal(res.body.deleted.length, 0);
      assert.equal((await d.store.list()).length, 4);
    });
  });

  it('does not append a purge_requested record for a request it could not parse', async () => {
    await withTempDir(async (dir) => {
      const d = await scaffold(dir);
      const before = (await d.store.audit.read()).length;
      await d.purge({ op: 'nope' });
      assert.equal((await d.store.audit.read()).length, before, 'a malformed request was logged as a purge');
    });
  });
});

describe('the response body explains itself', () => {
  it('names the scope, the cutoff, and the byte count', async () => {
    await withTempDir(async (dir) => {
      const d = await scaffold(dir);
      const res = await d.purge({ op: 'purge', scope: 'artifacts' });
      assert.equal(res.body.op, 'purge');
      assert.equal(res.body.scope, 'artifacts');
      assert.equal(res.body.before, '9999-12-31T23:59:59.999Z');
      assert.equal(res.body.bytesFreed, res.body.deleted.reduce((n, x) => n + x.bytes, 0));
      assert.equal(res.body.error, '', 'a successful purge should not carry an error');
    });
  });
});

describe('a retain-worthy record keeps the bytes it names', () => {
  it('turns an evidence artifact into an advisory rather than a deletion', async () => {
    // decisions.md §3 requires the log to keep policy-violation records. If the
    // artifact such a record names could then be purged, the surviving record
    // would point at nothing, so the record is the thing that has to protect it.
    await withTempDir(async (dir) => {
      const d = await scaffold(dir);
      const snapshot = (await d.store.list()).find((s) => s.kind === 'file_snapshot');
      assert.ok(snapshot, 'the scaffold should have written a snapshot');
      await d.store.audit.append({ action: 'policy_violation', target: snapshot.uri, detail: 'pii in a snapshot' });

      const refused = await d.purge({ op: 'purge', scope: 'artifacts' });
      assert.equal(refused.status, 409, 'a purge that deletes the evidence must not report success');
      assert.ok(refused.body.advisories.some((a) => a.uri === snapshot.uri));
      assert.equal(refused.body.advisories[0]?.reason ?? '', 'subject_of_audit_record');
      assert.equal((await d.store.list()).length, 4, 'nothing was deleted on a refusal');

      // force acknowledges the advisory, and the other artifacts still go.
      const forced = await d.purge({ op: 'purge', scope: 'artifacts', force: true });
      assert.equal(forced.status, 200);
      assert.deepEqual(
        forced.body.deleted.map((x) => x.uri.split('://')[1]?.split('/')[0]).sort(),
        ['patch'],
      );
    });
  });

  it('does not treat a routine artifact_written record as evidence', async () => {
    // Every artifact has one of these. If they counted, no purge could ever
    // succeed, which would make the endpoint useless rather than careful.
    await withTempDir(async (dir) => {
      const d = await scaffold(dir);
      const written = (await d.store.audit.read()).filter((r) => r.action === 'artifact_written');
      assert.ok(written.length >= 4, 'the store audits its writes');
      const res = await d.purge({ op: 'purge', scope: 'artifacts' });
      assert.equal(res.status, 200);
      assert.equal(res.body.deleted.length, 2);
    });
  });
});
