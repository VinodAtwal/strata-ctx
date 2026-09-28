import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  AuditLog,
  AuditWriteError,
  META_PURGE_LOG_NAME,
  PURGE_LOG_NAME,
  RETAIN_WORTHY_ACTIONS,
  isRetainWorthy,
} from '../src/audit.js';
import { T0, withTempDir } from './fixtures.js';

/**
 * I-5, I-7, I-8: the append-only record.
 *
 * Two failure modes matter more than the happy path, and both are quiet.
 *
 * The first is a record that does not get written. The log is the evidence for
 * the retention claims and for decisions.md §3's "auth events,
 * policy-violation records, purge log", so a skipped append is not a lost
 * metric -- it is a claim the product cannot support afterwards. Every write
 * path here is therefore exercised both when it succeeds and when it cannot.
 *
 * The second is a record that leaks. A `detail` string is a stack frame, a
 * rejected URI or a command line, and those are ordinary routes for a
 * credential onto a disk nobody is watching. So the line is redacted *before* it
 * is written, and the tests here check the bytes on disk rather than the object
 * that was handed in.
 *
 * The corruption case is here too, because a log that cannot be read is exactly
 * when an operator most needs to read it.
 */

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

const record = (over: Partial<Parameters<AuditLog['append']>[0]> = {}) => ({
  action: 'artifact_written' as const,
  target: 'artifact://file/abc123',
  detail: '',
  count: 1,
  bytes: 2,
  kinds: [],
  ...over,
});

/** The raw bytes of a log, because the guarantee is about what reaches the disk. */
const raw = async (log: AuditLog): Promise<string> => fs.readFile(log.path, 'utf8');

describe('I-5: a record is complete and readable', () => {
  it('writes one line that parses back to the same fields', async () => {
    await withTempDir(async (dir) => {
      const log = AuditLog.open(dir, PURGE_LOG_NAME, { now: () => T0 });
      await log.append(record({ detail: 'written by the store' }));

      assert.equal(log.path, join(dir, 'audit', PURGE_LOG_NAME));
      const lines = (await raw(log)).split('\n').filter((l) => l !== '');
      assert.equal(lines.length, 1);
      assert.deepEqual(JSON.parse(lines[0]!), {
        at: T0,
        action: 'artifact_written',
        target: 'artifact://file/abc123',
        detail: 'written by the store',
        count: 1,
        bytes: 2,
        kinds: [],
      });
    });
  });

  it('writes every field even when the caller omitted most of them', async () => {
    // The point of an all-required record: "the count was zero" and "the count
    // was never written" have to be different bytes, because this file exists to
    // answer questions that are contested.
    await withTempDir(async (dir) => {
      const log = AuditLog.open(dir, PURGE_LOG_NAME, { now: () => T0 });
      await log.append({ action: 'gc_refused' });

      const parsed = JSON.parse((await raw(log)).trim()) as Record<string, unknown>;
      assert.deepEqual(Object.keys(parsed).sort(), [
        'action',
        'at',
        'bytes',
        'count',
        'detail',
        'kinds',
        'target',
      ]);
      assert.equal(parsed['target'], '');
      assert.equal(parsed['detail'], '');
      assert.equal(parsed['count'], 0);
      assert.equal(parsed['bytes'], 0);
      assert.deepEqual(parsed['kinds'], []);
    });
  });

  it('stamps the injected clock, and honours an explicit one', async () => {
    await withTempDir(async (dir) => {
      const log = AuditLog.open(dir, PURGE_LOG_NAME, { now: () => T0 });
      await log.append(record());
      await log.append(record({ at: T0 + 60_000 }));
      const read = await log.read();
      assert.deepEqual(
        read.map((r) => r.at),
        [T0, T0 + 60_000],
      );
    });
  });

  it('is durable across a reopen, not just in this process', async () => {
    await withTempDir(async (dir) => {
      await AuditLog.open(dir, PURGE_LOG_NAME, { now: () => T0 }).append(record());
      // A second handle on the same path: if the log were buffered in memory this
      // would be empty, and the evidence would be gone at the moment it mattered.
      const reopened = AuditLog.open(dir, PURGE_LOG_NAME, { now: () => T0 });
      assert.equal((await reopened.read()).length, 1);
    });
  });

  it('keeps the meta-purge receipt out of the log it records', () => {
    // A receipt written into the file being erased is not a receipt, so these
    // are two different paths. Asserted on the constant rather than on behaviour
    // because the behaviour is a purge test; this is the invariant it rests on.
    assert.notEqual(META_PURGE_LOG_NAME, PURGE_LOG_NAME);
  });
});

describe('I-5: appends do not interleave', () => {
  it('keeps every line parseable under concurrent appends', async () => {
    // O_APPEND is what makes this safe, and the only way to know it is still
    // there is to hammer it: interleaved writes produce a file where the first
    // JSON.parse throws and, worse, records that are valid JSON and wrong.
    await withTempDir(async (dir) => {
      const log = AuditLog.open(dir, PURGE_LOG_NAME, { now: () => T0 });
      const n = 64;
      await Promise.all(
        Array.from({ length: n }, (_unused, i) =>
          log.append(record({ target: `artifact://file/${i}`, count: i })),
        ),
      );
      const read = await log.read();
      assert.equal(read.length, n);
      assert.deepEqual(
        read.map((r) => r.count).sort((a, b) => a - b),
        Array.from({ length: n }, (_unused, i) => i),
        'a record was lost or a count was spliced',
      );
    });
  });

  it('leaves no partial line behind', async () => {
    await withTempDir(async (dir) => {
      const log = AuditLog.open(dir, PURGE_LOG_NAME, { now: () => T0 });
      await log.append(record());
      const text = await raw(log);
      assert.equal(text.endsWith('\n'), true, 'the last record has no terminator, so the next append would join it');
    });
  });
});

describe('I-5: the log is redacted before it is written', () => {
  it('does not put a secret from a detail string on disk', async () => {
    // The realistic route: a rejected URI or a command line in `detail`. The
    // object handed in is the caller's business; the file is not.
    await withTempDir(async (dir) => {
      const log = AuditLog.open(dir, PURGE_LOG_NAME, { now: () => T0 });
      await log.append(record({ detail: `refused ${AWS_KEY} at /tmp/x` }));

      const text = await raw(log);
      assert.equal(text.includes(AWS_KEY), false, 'the key reached the log file');
      assert.match(text, /\[strata:redacted:aws_access_key_id\]/);
      assert.deepEqual(
        (await log.read())[0]?.detail,
        'refused [strata:redacted:aws_access_key_id] at /tmp/x',
      );
    });
  });

  it('does not put a secret from a target on disk', async () => {
    await withTempDir(async (dir) => {
      const log = AuditLog.open(dir, PURGE_LOG_NAME, { now: () => T0 });
      await log.append(record({ target: `artifact://file/named?token=${AWS_KEY}` }));
      assert.equal((await raw(log)).includes(AWS_KEY), false);
    });
  });

  it('keeps the kind name, which is the useful half of a finding', async () => {
    // `kinds` is a vocabulary, not a value, and it is what makes a redacted line
    // still actionable. Redacting it would turn the log into noise.
    await withTempDir(async (dir) => {
      const log = AuditLog.open(dir, PURGE_LOG_NAME, { now: () => T0 });
      await log.append(record({ detail: AWS_KEY, kinds: ['aws_access_key_id'] }));
      assert.deepEqual((await log.read())[0]?.kinds, ['aws_access_key_id']);
    });
  });

  it('refuses to write a line it cannot prove is clean', async () => {
    // Defence in depth: redaction runs, then a separate check runs on the result.
    // If they ever disagree, the outcome has to be no line at all rather than a
    // line that got through.
    await withTempDir(async (dir) => {
      const log = AuditLog.open(dir, PURGE_LOG_NAME, { now: () => T0 });
      // A nesting that defeats the JSON walk: the detail is a JSON document, so
      // the secret is in a string the redactor's own scan still has to catch.
      await log.append(record({ detail: JSON.stringify({ note: AWS_KEY }) }));
      const text = await raw(log);
      assert.equal(text.includes(AWS_KEY), false);
    });
  });
});

describe('I-5: a write that cannot happen is an error, not a shrug', () => {
  it('throws AuditWriteError when the log path cannot be created', async () => {
    // The parent is a file, so `mkdir` fails with ENOTDIR. Silently dropping the
    // record would leave the product making claims it has no record for.
    await withTempDir(async (dir) => {
      const blocker = join(dir, 'not-a-directory');
      await fs.writeFile(blocker, 'x');
      const log = new AuditLog(join(blocker, 'audit', PURGE_LOG_NAME), { now: () => T0 });

      await assert.rejects(
        log.append(record({ detail: AWS_KEY })),
        (e: unknown) => {
          assert.ok(e instanceof AuditWriteError);
          assert.equal(e.message.includes(AWS_KEY), false, 'the refusal quoted the secret');
          assert.match(e.message, /audit log is the evidence/);
          return true;
        },
      );
      assert.equal(await fs.readFile(blocker, 'utf8'), 'x', 'the blocked path was modified');
    });
  });

  it('leaves the records it already wrote alone when the gate refuses', async () => {
    // The gate is the check that runs *after* redaction. Turning redaction off
    // (`mode: 'off'`) is not a configuration anyone should ship, and it is
    // exactly how to reach the gate in a test: the line reaches disk-write
    // verification with a secret still in it, so the append is refused and the
    // existing line must be untouched.
    await withTempDir(async (dir) => {
      const clean = AuditLog.open(dir, PURGE_LOG_NAME, { now: () => T0 });
      await clean.append(record({ target: 'artifact://file/kept' }));
      const before = await raw(clean);

      const ungated = new AuditLog(clean.path, { now: () => T0, redaction: { mode: 'off' } });
      await assert.rejects(ungated.append(record({ detail: AWS_KEY })), AuditWriteError);
      assert.equal(await raw(clean), before, 'the refusal changed a line that was already written');

      // And the refusal is specific: the same log with the same option still takes
      // a record with nothing to redact, so this is not a log that refuses all.
      await ungated.append(record({ target: 'artifact://file/clean' }));
      assert.equal((await clean.read()).length, 2);
    });
  });
});

describe('I-5: the log survives being read badly', () => {
  it('reads a corrupt line without losing the ones around it', async () => {
    await withTempDir(async (dir) => {
      const log = AuditLog.open(dir, PURGE_LOG_NAME, { now: () => T0 });
      await log.append(record({ target: 'artifact://file/first' }));
      // A truncated write, which is what a crash mid-append looks like.
      await fs.appendFile(log.path, '{"at":1,"action":"artifa\n', 'utf8');
      await log.append(record({ target: 'artifact://file/third' }));

      const read = await log.read();
      const corrupt = read.filter((r) => r.detail === 'unparseable audit line');
      assert.equal(corrupt.length, 1, 'a corrupt line must be visible, not silently dropped');
      assert.deepEqual(
        read.filter((r) => r.detail !== 'unparseable audit line').map((r) => r.target),
        ['artifact://file/first', 'artifact://file/third'],
      );
    });
  });

  it('skips a blank line instead of reporting it', async () => {
    await withTempDir(async (dir) => {
      const log = AuditLog.open(dir, PURGE_LOG_NAME, { now: () => T0 });
      await log.append(record());
      await fs.appendFile(log.path, '\n\n', 'utf8');
      assert.equal((await log.read()).length, 1);
    });
  });

  it('fills in fields an older or partial line omitted', async () => {
    // Lenient on read, strict on write: a record written by an earlier version
    // must not make the whole log unreadable to the operator who needs it.
    await withTempDir(async (dir) => {
      const log = AuditLog.open(dir, PURGE_LOG_NAME, { now: () => T0 });
      await fs.mkdir(join(dir, 'audit'), { recursive: true });
      await fs.writeFile(log.path, '{"at":7,"action":"acl_denied"}\n', 'utf8');

      assert.deepEqual(await log.read(), [
        {
          at: 7,
          action: 'acl_denied',
          target: '',
          detail: '',
          count: 0,
          bytes: 0,
          kinds: [],
        },
      ]);
    });
  });

  it('reads a log that does not exist as empty, not as an error', async () => {
    await withTempDir(async (dir) => {
      const log = AuditLog.open(dir, PURGE_LOG_NAME, { now: () => T0 });
      assert.deepEqual(await log.read(), []);
    });
  });

  it('creates the log directory itself', async () => {
    // Nothing above this module knows where the file goes, so a missing directory
    // is a routine first-append condition rather than a setup error.
    await withTempDir(async (dir) => {
      const log = AuditLog.open(dir, PURGE_LOG_NAME, { now: () => T0 });
      await log.append(record());
      assert.deepEqual((await fs.stat(log.path)).isFile(), true);
    });
  });
});

describe('I-7: erasing is explicit and counted', () => {
  it('erases the log and reports how many lines went', async () => {
    await withTempDir(async (dir) => {
      const log = AuditLog.open(dir, PURGE_LOG_NAME, { now: () => T0 });
      await log.append(record());
      await log.append(record());

      assert.equal(await log.erase(), 2);
      assert.equal(await fs.access(log.path).then(() => true, () => false), false);
      assert.deepEqual(await log.read(), [], 'a read after an erase reported history that no longer exists');
    });
  });

  it('erasing a log that is not there is zero, not a throw', async () => {
    await withTempDir(async (dir) => {
      const log = AuditLog.open(dir, PURGE_LOG_NAME, { now: () => T0 });
      assert.equal(await log.erase(), 0);
    });
  });
});

describe('I-8: what the log keeps, the log keeps by default', () => {
  it('classifies the classes decisions.md §3 names for retention', () => {
    // Auth events, policy-violation records and the purge record. A refusal is
    // the one kind of line that must outlive the data it is about, which is why
    // `purge_refused` and `gc_refused` are in the set and `gc_deleted` is not.
    for (const action of [
      'acl_denied',
      'secret_blocked',
      'purge_refused',
      'gc_refused',
      'meta_purged',
      'policy_violation',
    ] as const) {
      assert.equal(isRetainWorthy(action), true, `${action} is retain-worthy and is not marked as such`);
    }
  });

  it('does not retain the routine successes', () => {
    // If these were retain-worthy, retention would have nothing to collect and
    // the retention tests elsewhere would be measuring a no-op.
    for (const action of ['artifact_written', 'artifact_read', 'artifact_deleted', 'gc_deleted'] as const) {
      assert.equal(isRetainWorthy(action), false, `${action} is routine and would make retention a no-op`);
    }
  });

  it('has no duplicate and does not cover everything', () => {
    assert.equal(new Set(RETAIN_WORTHY_ACTIONS).size, RETAIN_WORTHY_ACTIONS.length);
    assert.ok(RETAIN_WORTHY_ACTIONS.length < 13, 'every action is retain-worthy, so nothing is ever collected');
  });
});

describe('I-5: the log is not world-readable', () => {
  it('is created owner-only', async () => {
    // The log holds artifact paths, digests and sizes. That is not a secret in
    // the redaction sense, but it is the user's project structure, and a
    // default umask of 022 would put it in every local user's reach.
    await withTempDir(async (dir) => {
      const log = AuditLog.open(dir, PURGE_LOG_NAME, { now: () => T0 });
      await log.append(record());
      const mode = (await fs.stat(log.path)).mode & 0o777;
      assert.equal(mode & 0o077, 0, `log mode is ${mode.toString(8)}`);
    });
  });
});
