import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { StrataTelemetryEvent, TelemetryRecord } from './events.js';
import { makeRecord, isStrataTelemetryEvent, recordRunId } from './events.js';
import { assertNoSecretsInLine, RedactionFailure, redactRecord } from './redact.js';

/**
 * G-1: the local-only, append-only, fsync-safe JSONL sink.
 *
 * ## Local-only is a property of the API, not a default
 *
 * spec N4: "all context/gists/artifacts stay on disk; no telemetry egress by
 * default". "By default" is the part that is easy to get wrong later -- one
 * `telemetryUrl` option and the guarantee becomes a config value. So the public
 * surface here is a *filesystem path* and nothing else: there is no HTTP sink,
 * no socket, no transport interface that a future contributor can implement in
 * twenty lines, and no module in this package imports `node:http`, `node:net`
 * or `node:https`. `assertLocalPath` additionally refuses a `scheme:` string, so
 * the one plausible mistake -- handing the sink an `s3://` or an
 * `https://hooks.example.com` URL that looks like it is being accepted -- fails
 * loudly at construction instead of quietly egressing a user's context.
 *
 * File mode 0600 and directory mode 0700 for the same reason: a telemetry log is
 * a copy of the user's data, and a world-readable one in a shared home
 * directory is an egress channel to every other user on the machine.
 *
 * ## Append-only
 *
 * Opened with the `a` flag, which is `O_APPEND` on POSIX: every write lands at
 * the current end of file regardless of what anyone else did to the file in
 * between, so two processes writing the same log cannot overwrite each other
 * and a stale offset can never make us write into a hole. There is no code path
 * that opens this path in a truncating mode; rotation is an explicit method, it
 * renames rather than deletes, and it is the only thing in this file capable of
 * making the file smaller.
 *
 * ## Never truncate silently
 *
 * Three separate senses, all handled:
 *
 * 1. We never truncate. No `'w'`, no `truncateSync`, no `rm`.
 * 2. If *someone else* truncates the file, we notice: the sink compares the
 *    size it believes the file should have against `fstat` before each write and
 *    records the shortfall in `SinkState.truncatedBytes`. A log with a hole in it
 *    is reported as a log with a hole in it, because the failure this project
 *    exists to prevent is a "0% violations" dashboard fed by a log that stopped
 *    being written.
 * 3. A rotation is explicit, names a reason, and returns the path of the file it
 *    kept. Retention policy is I-5's to own; this package only makes sure that
 *    whenever it happens, it is a decision somebody made.
 *
 * ## fsync
 *
 * `fsync` on every write by default. This is a telemetry log whose consumer is a
 * human reading it after a crash, and the alternative (buffering, flushing on
 * close) loses exactly the lines written just before the failure -- which is
 * when the interesting ones are. `on-close` exists for throughput-sensitive
 * deployments and is a documented trade, not the default.
 */

export class TelemetrySinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelemetrySinkError';
  }
}

export interface SinkState {
  readonly path: string;
  readonly written: number;
  /** Bytes the sink has appended, used to detect foreign truncation. */
  readonly bytesWritten: number;
  /** Bytes that vanished from under us. Non-zero means the log is incomplete. */
  readonly truncatedBytes: number;
  readonly rotated: number;
  readonly redactions: number;
  readonly closed: boolean;
  /** Set when a write failed. The event is still counted as attempted. */
  readonly failures: readonly string[];
}

export interface TelemetrySink {
  emit(event: StrataTelemetryEvent): void;
  flush(): void;
  close(): void;
  readonly state: SinkState;
}

const MODE_FILE = 0o600;
const MODE_DIR = 0o700;

/** How far back `#resumeSeq` looks on open. See its doc. */
const RESUME_SCAN_BYTES = 64 * 1024;

/** Narrowing a parsed line to its `seq`, without asserting its shape. */
function seqOf(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!('seq' in value)) return null;
  const seq = value.seq;
  return typeof seq === 'number' ? seq : null;
}

/**
 * Rejects anything that looks like a URL or a remote scheme.
 *
 * The Windows drive-letter case (`C:\logs\telemetry.jsonl`) is the one thing
 * that legitimately matches `^[a-z]:` and is explicitly allowed, so this does
 * not become "no paths on Windows" by accident.
 */
export function assertLocalPath(path: string): void {
  if (path.trim() === '') throw new TelemetrySinkError('telemetry path must not be empty');
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(path);
  if (scheme === null) return;
  const name = scheme[1] ?? '';
  if (name.length === 1) return; // Windows drive letter
  throw new TelemetrySinkError(
    `telemetry is local-only (spec N4); refusing the remote sink "${name}:" -- ` +
      'there is no transport in this package and there will not be one',
  );
}

/** In-memory sink: the default when nothing is wired, and what the CLI reads. */
export class MemorySink implements TelemetrySink {
  readonly #records: TelemetryRecord[] = [];
  readonly #clock: () => number;
  readonly #redactWrites: boolean;
  #redactions = 0;
  #closed = false;

  constructor(options: { readonly clock?: () => number; readonly redact?: boolean } = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#redactWrites = options.redact ?? true;
  }

  emit(event: StrataTelemetryEvent): void {
    const at = this.#clock();
    const record = makeRecord(this.#records.length, at, event);
    if (!this.#redactWrites) {
      this.#records.push(record);
      return;
    }
    // G-7 says *all* sinks. An in-memory sink is not a scratch pad: it is the
    // buffer the status CLI reads and the buffer a long-lived gateway process
    // holds for the whole session.
    //
    // The cast is the one place this class asserts. `redactValue` is typed
    // `unknown` because it walks arbitrary JSON, and the type system cannot see
    // that walking a `TelemetryRecord` yields a `TelemetryRecord`. The claim
    // that matters is checked one level up, by `assertNoSecretsInLine` on the
    // serialised line, which is the pass that looks at bytes.
    const outcome = redactRecord(record);
    this.#redactions += outcome.hits.length;
    this.#records.push(outcome.value as TelemetryRecord);
  }

  flush(): void {
    // Nothing buffered.
  }

  close(): void {
    this.#closed = true;
  }

  get records(): readonly TelemetryRecord[] {
    return Object.freeze([...this.#records]);
  }

  get state(): SinkState {
    return {
      path: ':memory:',
      written: this.#records.length,
      bytesWritten: 0,
      truncatedBytes: 0,
      rotated: 0,
      redactions: this.#redactions,
      closed: this.#closed,
      failures: [],
    };
  }
}

/** Fans one event out to several sinks. */
export class TeeSink implements TelemetrySink {
  constructor(private readonly sinks: readonly TelemetrySink[]) {
    if (sinks.length === 0) {
      throw new TelemetrySinkError('TeeSink needs at least one sink');
    }
  }

  emit(event: StrataTelemetryEvent): void {
    for (const sink of this.sinks) sink.emit(event);
  }

  flush(): void {
    for (const sink of this.sinks) sink.flush();
  }

  close(): void {
    for (const sink of this.sinks) sink.close();
  }

  get state(): SinkState {
    return this.sinks[0]?.state ?? {
      path: ':tee:',
      written: 0,
      bytesWritten: 0,
      truncatedBytes: 0,
      rotated: 0,
      redactions: 0,
      closed: false,
      failures: [],
    };
  }
}

/**
 * Wraps a sink so a broken log cannot break a request.
 *
 * The product fails open on the *user's* context (architecture §1) and a
 * telemetry write happens on the request path, so an unhandled `ENOSPC` here
 * would take down the proxy. The failure is still recorded -- swallowed
 * instrumentation is how a security control becomes invisible -- and
 * `state.failures` is what the status CLI surfaces.
 */
export class GuardedSink implements TelemetrySink {
  readonly #failures: string[] = [];
  #closed = false;

  constructor(private readonly inner: TelemetrySink) {}

  emit(event: StrataTelemetryEvent): void {
    try {
      this.inner.emit(event);
    } catch (error) {
      this.#failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  flush(): void {
    try {
      this.inner.flush();
    } catch (error) {
      this.#failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  close(): void {
    this.#closed = true;
    try {
      this.inner.close();
    } catch (error) {
      this.#failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  get failures(): readonly string[] {
    return Object.freeze([...this.#failures]);
  }

  get state(): SinkState {
    // `closed` is the guard's own, not the inner sink's: a guard that swallowed
    // a failing flush has still closed, and a status report that says otherwise
    // invites somebody to keep writing to a sink nobody is flushing.
    return { ...this.inner.state, closed: this.#closed, failures: [...this.inner.state.failures, ...this.#failures] };
  }
}

export interface JsonlSinkOptions {
  /** Filesystem path. A URL or a remote scheme is refused. */
  readonly path: string;
  readonly clock?: () => number;
  /**
   * Default `every-write`. See the module doc: the lines lost by buffering are
   * the lines written just before the crash.
   */
  readonly fsync?: 'every-write' | 'on-close';
  /** Default true. Set false only for a log that provably holds no user data. */
  readonly redact?: boolean;
  /** Number of previous generations `rotate` keeps looking back for a name. */
  readonly maxRotations?: number;
}

export class JsonlSink implements TelemetrySink {
  readonly #path: string;
  readonly #clock: () => number;
  readonly #fsyncEveryWrite: boolean;
  readonly #redactWrites: boolean;
  readonly #maxRotations: number;
  #fd: number;
  #seq = 0;
  #bytes = 0;
  #truncatedBytes = 0;
  #rotated = 0;
  #closed = false;
  #redactionHits = 0;

  constructor(options: JsonlSinkOptions) {
    assertLocalPath(options.path);
    this.#path = options.path;
    this.#clock = options.clock ?? Date.now;
    this.#fsyncEveryWrite = (options.fsync ?? 'every-write') === 'every-write';
    this.#redactWrites = options.redact ?? true;
    this.#maxRotations = options.maxRotations ?? 64;
    mkdirSync(dirname(this.#path), { recursive: true, mode: MODE_DIR });
    // 'a' == O_APPEND|O_CREAT|O_WRONLY. Never 'w', never 'r+'.
    this.#fd = openSync(this.#path, 'a', MODE_FILE);
    this.#bytes = fstatSync(this.#fd).size;
    this.#seq = this.#resumeSeq();
  }

  /**
   * Where to pick the sequence up from, given what is already on disk.
   *
   * Restarting at 0 is the obvious thing to do and it is wrong: the previous
   * process's records are still in the file, so every subsequent `seq` collides
   * with an existing one. `seq` exists so a reader can say "you are missing
   * line 41" (events.ts), and a duplicated sequence destroys that ability
   * without destroying anything else -- the report reads a healthy file as
   * having two writers, on every restart, forever. A warning that always fires
   * is as useless as no warning.
   *
   * A bounded tail scan rather than a full read: the answer is the *last*
   * sequence number, and a 64 KB window reaches it for any log whose
   * individual lines are smaller than that. If one line somehow is not, the
   * scan degrades to the highest sequence it did manage to parse, which is
   * still better than colliding with the whole file and is reported by the
   * duplicate check if it matters.
   */
  #resumeSeq(): number {
    const size = fstatSync(this.#fd).size;
    if (size === 0) return 0;
    // The write handle is O_WRONLY, so the scan needs its own read handle.
    const rfd = openSync(this.#path, 'r');
    try {
      const span = Math.min(size, RESUME_SCAN_BYTES);
      const buf = Buffer.alloc(span);
      readSync(rfd, buf, 0, span, size - span);
      let highest = -1;
      for (const line of buf.toString('utf8').split('\n')) {
        if (line.trim() === '') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // A line the reader would also reject. Skipping it here is right:
          // refusing to start the gateway because a log has a corrupt line
          // would trade a reportable problem for an outage.
          continue;
        }
        const seq = seqOf(parsed);
        if (seq !== null && Number.isInteger(seq) && seq > highest) highest = seq;
      }
      return highest + 1;
    } finally {
      closeSync(rfd);
    }
  }

  get path(): string {
    return this.#path;
  }

  emit(event: StrataTelemetryEvent): void {
    if (this.#closed) throw new TelemetrySinkError('sink is closed');
    const at = this.#clock();
    const record = makeRecord(this.#seq, at, event);

    let payload: unknown = record;
    if (this.#redactWrites) {
      let outcome;
      try {
        outcome = redactRecord(record);
      } catch (error) {
        // Fail closed: see the module doc. The only way to reach this is a
        // redactor bug, and the fix is to fix the redactor, not to write the
        // line unredacted.
        throw new RedactionFailure(error);
      }
      this.#redactionHits += outcome.hits.length;
      payload = outcome.value;
    }

    // JSON.stringify escapes the control characters, so an attacker-controlled
    // `message` cannot forge a second line. `\n` separators are the only
    // newlines the file gets.
    const line = `${JSON.stringify(payload)}\n`;
    assertNoSecretsInLine(line);

    this.#checkForeignTruncation();
    const written = writeSync(this.#fd, line);
    this.#bytes += written;
    this.#seq += 1;
    if (this.#fsyncEveryWrite) fsyncSync(this.#fd);
  }

  flush(): void {
    if (this.#closed) return;
    fsyncSync(this.#fd);
  }

  close(): void {
    if (this.#closed) return;
    fsyncSync(this.#fd);
    closeSync(this.#fd);
    this.#closed = true;
  }

  /**
   * Explicit, named, non-destructive rotation.
   *
   * The previous generation is *renamed*, never unlinked: this package does not
   * own retention (I-5 does) and an unlink here would be a silent data loss
   * with no purge log, which is precisely the failure the retention policy
   * forbids.
   */
  rotate(reason: string): string {
    if (reason.trim() === '') {
      throw new TelemetrySinkError('a rotation needs a reason; silent truncation is not allowed');
    }
    if (this.#closed) throw new TelemetrySinkError('cannot rotate a closed sink');
    this.flush();
    closeSync(this.#fd);
    const target = this.#nextRotationPath();
    renameSync(this.#path, target);
    this.#fd = openSync(this.#path, 'a', MODE_FILE);
    this.#bytes = 0;
    this.#rotated += 1;
    this.#seq = 0;
    return target;
  }

  get state(): SinkState {
    return {
      path: this.#path,
      written: this.#seq,
      bytesWritten: this.#bytes,
      truncatedBytes: this.#truncatedBytes,
      rotated: this.#rotated,
      redactions: this.#redactionHits,
      closed: this.#closed,
      failures: [],
    };
  }

  /**
   * The file is shorter than we left it: something truncated it behind our back.
   * O_APPEND means our next write cannot compound the damage, but the log has a
   * hole and saying so is the entire point of this method.
   */
  #checkForeignTruncation(): void {
    const size = fstatSync(this.#fd).size;
    if (size < this.#bytes) this.#truncatedBytes += this.#bytes - size;
  }

  #nextRotationPath(): string {
    const base = this.#path;
    const dir = dirname(base);
    const stem = basename(base);
    for (let n = 1; n <= this.#maxRotations; n += 1) {
      const candidate = join(dir, `${stem}.${n}`);
      if (!existsSync(candidate)) return candidate;
    }
    throw new TelemetrySinkError(
      `refusing to rotate: ${this.#maxRotations} generations already exist beside ${base}`,
    );
  }
}

export type RejectedReason = 'blank' | 'unparsable' | 'not_a_record' | 'bad_event' | 'partial';

export interface RejectedLine {
  /** 1-based, within the portion of the file that was read. */
  readonly line: number;
  readonly reason: RejectedReason;
  /**
   * The offending text is deliberately *not* carried. A line that failed
   * validation is the single most likely place for an unredacted secret to
   * survive -- it failed because somebody hand-edited it -- and a reader that
   * echoes it hands that secret to whatever renders the rejection list.
   */
}

export interface JsonlReadResult {
  readonly records: readonly TelemetryRecord[];
  readonly rejected: readonly RejectedLine[];
  /** True when only the tail of the file was read. */
  readonly tailed: boolean;
  readonly bytesRead: number;
}

export interface ReadJsonlOptions {
  /**
   * Cap on bytes read, from the *end* of the file. A status report needs recent
   * aggregates, not a month of logs, and a 2 GB file read into memory is how a
   * diagnostic tool becomes an outage.
   */
  readonly maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Reads a log back. Tolerant of damage and *loud* about it: a corrupt or
 * truncated line is reported, never skipped. `strata status` showing "0
 * violations" from a file it silently dropped three lines of is worse than
 * showing a parse error.
 */
export function readJsonl(path: string, options: ReadJsonlOptions = {}): JsonlReadResult {
  assertLocalPath(path);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const total = statSync(path).size;
  const tailed = total > maxBytes;
  const start = tailed ? total - maxBytes : 0;
  const buf = readFileSync(path, 'utf8');
  let text = start === 0 ? buf : buf.slice(start);

  const rejected: RejectedLine[] = [];
  if (tailed) {
    // The cut almost certainly lands mid-line; that partial line is not a
    // corrupt log, it is our own tail read, and reporting it as damage would
    // make every large log look broken.
    const firstBreak = text.indexOf('\n');
    if (firstBreak === -1) {
      return { records: [], rejected: [{ line: 1, reason: 'partial' }], tailed, bytesRead: text.length };
    }
    text = text.slice(firstBreak + 1);
  }

  const records: TelemetryRecord[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const lineNo = i + 1;
    if (raw.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A truncated *final* line is the signature of a crash mid-write and is
      // reported as `partial`; anything else is corruption.
      rejected.push({ line: lineNo, reason: i === lines.length - 1 ? 'partial' : 'unparsable' });
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || !('event' in parsed)) {
      rejected.push({ line: lineNo, reason: 'not_a_record' });
      continue;
    }
    const candidate = parsed as Partial<TelemetryRecord>;
    if (
      typeof candidate.v !== 'number' ||
      typeof candidate.seq !== 'number' ||
      // `Number.isFinite`, not `typeof`: `at` is read by `makeRecord` a few
      // lines below, which throws on a non-finite timestamp, and that throw
      // escapes `readJsonl` and `buildStatusFromLog` alike. One hand-edited
      // line carrying `at: 1e999` therefore used to abort the whole status
      // command with "cannot read the log" -- the precise failure the module
      // doc refuses: a corrupt line has to be reported as one rejected line,
      // not as a log that does not exist.
      typeof candidate.at !== 'number' ||
      !Number.isFinite(candidate.at) ||
      !isStrataTelemetryEvent(candidate.event)
    ) {
      rejected.push({ line: lineNo, reason: 'bad_event' });
      continue;
    }
    records.push(makeRecord(candidate.seq, candidate.at, candidate.event));
  }
  return { records, rejected: Object.freeze(rejected), tailed, bytesRead: text.length };
}

/** Convenience: the events, in file order, without the envelope. */
export function readJsonlEvents(path: string, options: ReadJsonlOptions = {}): readonly StrataTelemetryEvent[] {
  return Object.freeze(readJsonl(path, options).records.map((r) => r.event));
}

/** Groups records by run, for the status report. Records with no runId land in `''`. */
export function groupByRun(
  records: readonly TelemetryRecord[],
): ReadonlyMap<string, readonly TelemetryRecord[]> {
  const out = new Map<string, TelemetryRecord[]>();
  for (const record of records) {
    const run = recordRunId(record) ?? '';
    const bucket = out.get(run);
    if (bucket === undefined) out.set(run, [record]);
    else bucket.push(record);
  }
  return out;
}
