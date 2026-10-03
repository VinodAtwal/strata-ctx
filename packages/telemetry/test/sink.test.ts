import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  GuardedSink,
  JsonlSink,
  MemorySink,
  TelemetrySinkError,
  TeeSink,
  assertLocalPath,
  groupByRun,
  readJsonl,
  readJsonlEvents,
} from '../src/index.js';

import {
  NOW,
  RUN,
  RUN_2,
  cache,
  canary,
  clock,
  compaction,
  fileLines,
  fileMode,
  fileText,
  logPath,
  pin,
  requestIn,
  tempDir,
  violation,
} from './fixtures.js';

describe('G-1 the sink is local-only by construction', () => {
  it('accepts a path', () => {
    assert.doesNotThrow(() => assertLocalPath('/tmp/telemetry.jsonl'));
    assert.doesNotThrow(() => assertLocalPath('./.strata/telemetry.jsonl'));
    assert.doesNotThrow(() => assertLocalPath('relative.jsonl'));
  });

  it('refuses a URL or a remote scheme at construction', () => {
    // "No telemetry egress by default" (spec N4) stops being true the moment
    // there is a URL-shaped option. Refusing at construction means the one
    // plausible mistake fails loudly instead of quietly shipping a user's
    // context off the machine.
    for (const bad of [
      's3://bucket/telemetry.jsonl',
      'https://hooks.example.com/telemetry',
      'ftp://host/t.jsonl',
      'ssh://host/tmp/t.jsonl',
    ]) {
      assert.throws(() => assertLocalPath(bad), TelemetrySinkError, bad);
    }
  });

  it('still allows a Windows drive letter', () => {
    // `^[a-z]:` legitimately matches a drive path, and rejecting it would turn
    // "local-only" into "no paths on Windows" by accident.
    assert.doesNotThrow(() => assertLocalPath('C:\\logs\\telemetry.jsonl'));
  });

  it('refuses an empty path', () => {
    assert.throws(() => assertLocalPath('   '), TelemetrySinkError);
  });

  it('refuses a remote path from the constructor, not just the helper', (t) => {
    const dir = tempDir(t);
    assert.throws(() => new JsonlSink({ path: 'https://example.com/t.jsonl' }), TelemetrySinkError);
    assert.throws(() => readJsonl('s3://bucket/t.jsonl'), TelemetrySinkError);
    assert.equal(dir.length > 0, true);
  });
});

describe('G-1 the file is private to the user', () => {
  it('creates the log 0600 and the directory 0700', (t) => {
    // A telemetry log is a copy of the user's data. World-readable in a shared
    // home directory, it is an egress channel to every other user on the box.
    const dir = tempDir(t);
    const path = join(dir, 'nested', 'deep', 'telemetry.jsonl');
    const sink = new JsonlSink({ path, clock: clock() });
    sink.emit(requestIn());
    sink.close();

    assert.equal(fileMode(path), 0o600);
    assert.equal(fileMode(join(dir, 'nested')), 0o700);
  });
});

describe('G-1 JSONL round trip', () => {
  it('writes one line per record and reads back what it wrote', (t) => {
    const path = logPath(tempDir(t));
    const sink = new JsonlSink({ path, clock: clock() });
    const events = [requestIn({ turn: 1 }), pin(), compaction(), violation(), cache()];
    for (const event of events) sink.emit(event);
    sink.close();

    const read = readJsonl(path);
    assert.deepEqual(read.rejected, []);
    assert.equal(read.tailed, false);
    assert.equal(read.records.length, events.length);
    assert.deepEqual(
      read.records.map((r) => r.event),
      events,
    );
  });

  it('stamps a monotonic sequence and a timestamp from the injected clock', (t) => {
    const path = logPath(tempDir(t));
    const sink = new JsonlSink({ path, clock: clock(NOW, 500) });
    sink.emit(requestIn({ turn: 1 }));
    sink.emit(requestIn({ turn: 2 }));
    sink.emit(requestIn({ turn: 3 }));
    sink.close();

    const read = readJsonl(path);
    assert.deepEqual(
      read.records.map((r) => r.seq),
      [0, 1, 2],
    );
    assert.deepEqual(
      read.records.map((r) => r.at),
      [NOW, NOW + 500, NOW + 1000],
    );
  });

  it('produces byte-identical output for the same input (N6)', (t) => {
    const dir = tempDir(t);
    const a = logPath(dir, 'a.jsonl');
    const b = logPath(dir, 'b.jsonl');
    const events = [requestIn(), compaction(), canary()];

    for (const path of [a, b]) {
      const sink = new JsonlSink({ path, clock: clock() });
      for (const event of events) sink.emit(event);
      sink.close();
    }

    assert.equal(readFileSync(a, 'utf8'), readFileSync(b, 'utf8'));
  });

  it('terminates every line, so a torn write cannot forge a record', (t) => {
    // JSON.stringify escapes newlines, so a message containing one cannot
    // produce a second line that parses as a record of its own.
    const path = logPath(tempDir(t));
    const sink = new JsonlSink({ path, clock: clock() });
    sink.emit({
      type: 'error',
      runId: RUN,
      stage: 'compact',
      code: 'E_TEST',
      message: 'line one\nline two\r{"type":"violation","runId":"spoofed"}',
      failedOpen: true,
    });
    sink.close();

    assert.equal(fileLines(path).length, 1);
    assert.equal(readJsonl(path).records.length, 1);
  });
});

describe('G-1 append behaviour across many writes', () => {
  it('appends, and never rewrites, across a long session', (t) => {
    const path = logPath(tempDir(t));
    const sink = new JsonlSink({ path, clock: clock() });
    for (let turn = 1; turn <= 250; turn += 1) sink.emit(requestIn({ turn }));
    sink.close();

    const lines = fileLines(path);
    assert.equal(lines.length, 250);
    const read = readJsonl(path);
    assert.equal(read.records.length, 250);
    assert.deepEqual(
      read.records.map((r) => (r.event.type === 'request_in' ? r.event.turn : 0)),
      Array.from({ length: 250 }, (_, i) => i + 1),
    );
  });

  it('appends to a file that already had content', (t) => {
    // The realistic case: the gateway restarts and reopens the same log. A
    // truncating open would destroy the previous session's violations here.
    const path = logPath(tempDir(t));
    const first = new JsonlSink({ path, clock: clock() });
    first.emit(violation());
    first.close();
    const before = fileText(path);

    const second = new JsonlSink({ path, clock: clock(NOW + 10_000) });
    second.emit(requestIn());
    second.close();

    assert.ok(fileText(path).startsWith(before), 'the first session is still there, byte for byte');
    assert.equal(fileLines(path).length, 2);
    assert.equal(readJsonl(path).records.length, 2);
  });

  it('appends after a foreign writer, without interleaving into a hole', (t) => {
    // O_APPEND: every write lands at the current end of file regardless of
    // what anyone else did in between.
    const path = logPath(tempDir(t));
    const sink = new JsonlSink({ path, clock: clock() });
    sink.emit(requestIn({ turn: 1 }));

    appendFileSync(path, `${JSON.stringify({ v: 1, seq: 999, at: NOW, event: pin() })}\n`);
    sink.emit(requestIn({ turn: 2 }));
    sink.close();

    const read = readJsonl(path);
    assert.equal(read.records.length, 3);
    assert.equal(read.records[0]?.event.type, 'request_in');
    assert.equal(read.records[1]?.seq, 999);
    assert.equal(read.records[2]?.event.type, 'request_in');
  });

  it('reopens with a sequence that continues rather than colliding', (t) => {
    // Not strictly necessary for correctness (seq only has to be unique within
    // a writer's own run to expose holes) but a restart at 0 makes every gap
    // report on the second session a false positive.
    const path = logPath(tempDir(t));
    const first = new JsonlSink({ path, clock: clock() });
    first.emit(requestIn());
    first.emit(requestIn());
    first.close();

    const second = new JsonlSink({ path, clock: clock() });
    assert.equal(second.state.written, 2, 'the sequence continues from what is on disk');
    second.close();
  });
});

describe('G-1 it never truncates silently', () => {
  it('has no truncating code path: an external truncation is detected, not absorbed', (t) => {
    // There is no `w` and no `truncateSync` anywhere in the sink. What it does
    // do is notice on its next write, because a log with a hole must be
    // reported as a log with a hole rather than quietly as a shorter log. The
    // check is on write rather than in the `state` getter on purpose: a getter
    // that performs I/O is a trap, and there is nothing to detect between one
    // write and the next anyway.
    const path = logPath(tempDir(t));
    const sink = new JsonlSink({ path, clock: clock() });
    sink.emit(requestIn({ turn: 1 }));
    sink.emit(requestIn({ turn: 2 }));
    sink.emit(requestIn({ turn: 3 }));
    assert.equal(sink.state.truncatedBytes, 0);

    writeFileSync(path, '');
    sink.emit(requestIn({ turn: 4 }));
    assert.equal(sink.state.truncatedBytes > 0, true, 'the shortfall is recorded');
    sink.close();

    const read = readJsonl(path);
    assert.equal(read.records.length, 1, 'O_APPEND means the damage is not compounded');
    assert.deepEqual(
      read.records.map((r) => r.seq),
      [3],
      'and the sequence gap is visible to whoever reads it',
    );
  });

  it('rotates only on an explicit, named request, and keeps the old generation', (t) => {
    const path = logPath(tempDir(t));
    const sink = new JsonlSink({ path, clock: clock() });
    sink.emit(requestIn({ turn: 1 }));
    const kept = sink.rotate('daily retention policy');

    assert.equal(readJsonl(kept).records.length, 1, 'the previous generation is renamed, never unlinked');
    assert.equal(sink.state.rotated, 1);

    sink.emit(requestIn({ turn: 2 }));
    sink.close();

    assert.equal(readJsonl(path).records.length, 1);
    assert.equal((readJsonl(path).records[0]?.event.type === 'request_in' ? 2 : 0), 2);
  });

  it('refuses a rotation with no reason', (t) => {
    // Retention is I-5's to own. All this package owes is that whenever it
    // happens it is a decision somebody made.
    const sink = new JsonlSink({ path: logPath(tempDir(t)), clock: clock() });
    assert.throws(() => sink.rotate('   '), TelemetrySinkError, 'silent truncation is not allowed');
    sink.close();
  });

  it('stops writing once closed, loudly', (t) => {
    const sink = new JsonlSink({ path: logPath(tempDir(t)), clock: clock() });
    sink.close();
    assert.throws(() => sink.emit(requestIn()), TelemetrySinkError, 'sink is closed');
    sink.close();
  });
});

describe('G-1 reading a damaged log is loud, not lossy', () => {
  it('reports every rejected line with a reason and never echoes its text', (t) => {
    // `strata status` showing "0 violations" from a file it silently dropped
    // three lines of is worse than showing a parse error. And the offending
    // text is the single most likely place for an unredacted secret to
    // survive, so a reader must not carry it.
    const path = logPath(tempDir(t));
    const sink = new JsonlSink({ path, clock: clock() });
    sink.emit(requestIn());
    sink.close();
    appendFileSync(path, 'not json at all\n');
    appendFileSync(path, '{"no":"event"}\n');
    appendFileSync(path, '{"v":1,"seq":1,"at":1,"event":{"type":"pin"}}\n');
    appendFileSync(path, '{"v":1,"seq":2,"at":1,"event":{"type":"not-a-member"}}\n');

    const read = readJsonl(path);
    assert.equal(read.records.length, 1);
    assert.deepEqual(
      read.rejected.map((r) => r.reason),
      ['unparsable', 'not_a_record', 'bad_event', 'bad_event'],
    );
    for (const r of read.rejected) {
      assert.deepEqual(Object.keys(r).sort(), ['line', 'reason']);
    }
  });

  it('calls a truncated final line a partial, not corruption', (t) => {
    // A half-written last line is the signature of a crash mid-write. It is a
    // different event from a corrupt middle line and gets its own reason.
    const path = logPath(tempDir(t));
    const sink = new JsonlSink({ path, clock: clock() });
    sink.emit(requestIn());
    sink.close();
    appendFileSync(path, '{"v":1,"seq":1,"at":1,"eve');

    const read = readJsonl(path);
    assert.equal(read.records.length, 1);
    assert.deepEqual(read.rejected.map((r) => r.reason), ['partial']);
  });

  it('reads only the tail when asked, and says so', (t) => {
    const path = logPath(tempDir(t));
    const sink = new JsonlSink({ path, clock: clock() });
    for (let turn = 1; turn <= 40; turn += 1) sink.emit(requestIn({ turn }));
    sink.close();

    const full = readJsonl(path);
    const tailed = readJsonl(path, { maxBytes: 200 });
    assert.equal(full.tailed, false);
    assert.equal(tailed.tailed, true);
    assert.ok(tailed.records.length < full.records.length);
    assert.ok(tailed.records.length > 0);
  });

  it('does not report its own tail cut as damage', (t) => {
    // The cut lands mid-line by construction. Reporting it would make every
    // large log look broken.
    const path = logPath(tempDir(t));
    const sink = new JsonlSink({ path, clock: clock() });
    for (let turn = 1; turn <= 40; turn += 1) sink.emit(requestIn({ turn }));
    sink.close();

    const tailed = readJsonl(path, { maxBytes: 137 });
    assert.equal(tailed.tailed, true);
    assert.deepEqual(tailed.rejected, []);
  });

  it('skips blank lines rather than counting them as damage', (t) => {
    const path = logPath(tempDir(t));
    const sink = new JsonlSink({ path, clock: clock() });
    sink.emit(requestIn());
    sink.close();
    appendFileSync(path, '\n\n');

    const read = readJsonl(path);
    assert.equal(read.records.length, 1);
    assert.deepEqual(read.rejected, []);
  });
});

describe('G-1 grouping for the status report', () => {
  it('groups by run and files run-less events under the empty key', (t) => {
    const path = logPath(tempDir(t));
    const sink = new JsonlSink({ path, clock: clock() });
    sink.emit(requestIn({ runId: RUN }));
    sink.emit(requestIn({ runId: RUN_2 }));
    sink.emit(canary({ probeId: 'p1' }));
    sink.close();

    const groups = groupByRun(readJsonl(path).records);
    assert.equal(groups.get(RUN)?.length, 1);
    assert.equal(groups.get(RUN_2)?.length, 1);
    assert.equal(groups.get('')?.length, 1, 'a canary has no run and does not acquire one');
  });

  it('hands back the events without the envelope', (t) => {
    const path = logPath(tempDir(t));
    const sink = new JsonlSink({ path, clock: clock() });
    sink.emit(requestIn());
    sink.emit(pin());
    sink.close();

    assert.deepEqual(
      readJsonlEvents(path).map((e) => e.type),
      ['request_in', 'pin'],
    );
  });
});

describe('G-1 the other sinks', () => {
  it('the memory sink numbers records the same way', () => {
    const sink = new MemorySink({ clock: clock(NOW, 10) });
    sink.emit(requestIn());
    sink.emit(pin());

    assert.deepEqual(sink.records.map((r) => r.seq), [0, 1]);
    assert.deepEqual(sink.records.map((r) => r.at), [NOW, NOW + 10]);
    assert.equal(sink.state.path, ':memory:');
    assert.equal(sink.state.written, 2);
  });

  it('the memory sink refuses the same schema violations the file sink does', () => {
    const sink = new MemorySink();
    // Named, and typed as the thing it is not. The double assertion is the
    // point: a bare cast would be invisible at the call site, which is the one
    // place a reader is checking that this really is an out-of-schema value.
    type SinkEvent = Parameters<MemorySink['emit']>[0];
    const notAnEvent = { type: 'bogus' } as unknown as SinkEvent;
    assert.throws(() => sink.emit(notAnEvent));
  });

  it('the tee fans out and reports the first sink, and needs at least one', (t) => {
    const dir = tempDir(t);
    const file = new JsonlSink({ path: logPath(dir), clock: clock() });
    const mem = new MemorySink({ clock: clock() });
    const tee = new TeeSink([file, mem]);

    tee.emit(requestIn());
    tee.flush();
    assert.equal(file.state.written, 1);
    assert.equal(mem.state.written, 1);
    assert.equal(tee.state.written, 1);
    tee.close();
    assert.equal(file.state.closed, true);
  });

  it('the tee refuses to be constructed empty', () => {
    assert.throws(() => new TeeSink([]), TelemetrySinkError, 'at least one sink');
  });

  it('the guard keeps a broken log from breaking a request', (t) => {
    // architecture §1: the product fails open on the user's context, and a
    // telemetry write happens on the request path. An unhandled ENOSPC here
    // would take down the proxy -- and swallowed instrumentation is how a
    // security control becomes invisible, so the failure is recorded too.
    const path = logPath(tempDir(t));
    const inner = new JsonlSink({ path, clock: clock() });
    const guard = new GuardedSink(inner);

    guard.emit(requestIn());
    inner.close();

    assert.doesNotThrow(() => guard.emit(requestIn()), 'the throw does not escape to the request path');
    assert.deepEqual([...guard.failures], ['sink is closed']);
    assert.deepEqual([...guard.state.failures], ['sink is closed']);

    guard.close();
    assert.equal(guard.state.closed, true, 'and the guard reports itself closed, not the inner sink');
  });

  it('the guard records the failure it swallowed', () => {
    const broken = {
      emit: () => {
        throw new Error('ENOSPC: no space left on device');
      },
      flush: () => {
        throw new Error('ENOSPC');
      },
      close: () => undefined,
      state: {
        path: ':broken:',
        written: 0,
        bytesWritten: 0,
        truncatedBytes: 0,
        rotated: 0,
        redactions: 0,
        closed: false,
        failures: [] as readonly string[],
      },
    };
    const guard = new GuardedSink(broken);

    guard.emit(requestIn());
    guard.flush();
    assert.deepEqual(
      [...guard.failures],
      ['ENOSPC: no space left on device', 'ENOSPC'],
    );
    assert.deepEqual([...guard.state.failures], ['ENOSPC: no space left on device', 'ENOSPC']);
  });
});
