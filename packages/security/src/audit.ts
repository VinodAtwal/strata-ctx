import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import type { RedactionOptions, SecretKind } from './redact.js';
import { RedactionEngine } from './redact.js';

/**
 * I-5, I-7, I-8: the append-only record of what this process did to the user's
 * data.
 *
 * ## Why this is not telemetry
 *
 * Telemetry goes to a sink that may be aggregated. This does not: it is a local
 * JSONL file, it is the *evidence* for the retention claims, and the retention
 * policy freezes `keepPurgeLog: true` with the reasoning that "a purge without a
 * record of what was purged is indistinguishable from a cover-up". So this
 * module has one job that a metrics emitter does not have: a record must be
 * appendable, readable, and *deletable only as a whole and only on purpose*
 * (I-7). There is no update, no compaction, no rotation.
 *
 * ## Every field is required
 *
 * All of them, including the ones that are usually `undefined`. A log line
 * whose fields are optional is a log line where "the count was zero" and "the
 * count was never written" are the same bytes, and this file exists to answer
 * questions that are contested. The cost is one `0` and one `''` per line that
 * does not apply.
 *
 * ## The log is redacted before it is written
 *
 * A stack frame, a rejected URI or a command line in a `detail` string is an
 * ordinary route for a credential into a file nobody is watching -- exactly the
 * argument stream G makes for telemetry in `packages/telemetry/src/redact.ts`.
 * The line is redacted, *then* gated, and the two are separate steps so a field
 * the first pass did not know about still cannot land a secret on disk.
 */

export const PURGE_LOG_NAME = 'purge-log.jsonl';

/**
 * The meta-purge receipt (I-7). A different file from the log it records the
 * erasure of, because a receipt written into the file being erased is not a
 * receipt. See decisions R9.
 */
export const META_PURGE_LOG_NAME = 'meta-purge-log.jsonl';

export type AuditAction =
  | 'artifact_written'
  | 'artifact_read'
  | 'artifact_deleted'
  | 'acl_denied'
  | 'secret_blocked'
  | 'gc_planned'
  | 'gc_deleted'
  | 'gc_refused'
  | 'purge_requested'
  | 'purge_completed'
  | 'purge_refused'
  | 'meta_purged'
  | 'policy_violation';

/** decisions.md §3: "auth events, policy-violation records, purge log". */
export const RETAIN_WORTHY_ACTIONS: readonly AuditAction[] = [
  'acl_denied',
  'secret_blocked',
  'purge_refused',
  'gc_refused',
  'meta_purged',
  'policy_violation',
];

export interface AuditRecord {
  readonly at: number;
  readonly action: AuditAction;
  /** A URI, a digest, or `''` for an action that is not about a target. */
  readonly target: string;
  readonly detail: string;
  readonly count: number;
  readonly bytes: number;
  readonly kinds: readonly SecretKind[];
}

/**
 * What a caller has to supply.
 *
 * Only `action` is required, because only `action` is always meaningful: a
 * caller that has to invent a `count` for an `acl_denied` will invent a wrong
 * one, and a caller that cannot express "no target" will put an empty string
 * where a URI belongs by hand. Every field is still *written* -- the defaults
 * here exist so the record on disk is total, which is the invariant that matters
 * when someone reads it back during an incident.
 */
export type AuditRecordInput = Omit<Partial<AuditRecord>, 'at' | 'action'> & {
  readonly action: AuditAction;
  readonly at?: number;
};

export class AuditWriteError extends Error {
  constructor(cause: unknown) {
    super(`refusing to write an unrecorded action; the audit log is the evidence (${String(cause)})`);
    this.name = 'AuditWriteError';
  }
}

/**
 * One line, redacted, gated, appended. O_APPEND via `appendFile`, which on every
 * supported platform is a single atomic append for a write below `PIPE_BUF`-
 * sized buffers and a `O_APPEND` open otherwise -- interleaved appends are the
 * only corruption mode that matters here, and `O_APPEND` is precisely the flag
 * that prevents it.
 */
export class AuditLog {
  readonly path: string;
  private readonly engine: RedactionEngine;
  private readonly now: () => number;

  constructor(path: string, options: { readonly redaction?: Partial<RedactionOptions>; readonly now?: () => number } = {}) {
    this.path = path;
    this.engine = new RedactionEngine({ mode: 'placeholder', ...options.redaction });
    this.now = options.now ?? Date.now;
  }

  static open(root: string, name: string, options: ConstructorParameters<typeof AuditLog>[1] = {}): AuditLog {
    return new AuditLog(join(root, 'audit', name), options);
  }

  /**
   * Redact, gate, then append. A finding that survives redaction means the line
   * would carry a credential, and a refusal is the only correct outcome: the
   * alternative is an audit trail that cannot be written because it contains a
   * secret, which is a reason to fix the redaction, not to write the secret.
   */
  async append(record: AuditRecordInput): Promise<AuditRecord> {
    const full: AuditRecord = { at: record.at ?? this.now(), ...stripUndefined(record) };
    const line = this.engine.redact(JSON.stringify(full)).text;
    try {
      this.engine.assertPersistable(line, 'audit record');
    } catch (e) {
      throw new AuditWriteError(e);
    }
    try {
      await fs.mkdir(dirname(this.path), { recursive: true });
      await fs.appendFile(this.path, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (e) {
      throw new AuditWriteError(e);
    }
    return full;
  }

  /**
   * Read every line. A malformed line is returned as a synthetic record rather
   * than thrown: a log that cannot be read is exactly when an operator most
   * needs it, and one corrupt line must not hide the ones around it.
   */
  async read(): Promise<readonly AuditRecord[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.path, 'utf8');
    } catch {
      return [];
    }
    const out: AuditRecord[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as Partial<AuditRecord>;
        if (typeof parsed.action === 'string' && typeof parsed.at === 'number') {
          out.push({
            at: parsed.at,
            action: parsed.action,
            target: typeof parsed.target === 'string' ? parsed.target : '',
            detail: typeof parsed.detail === 'string' ? parsed.detail : '',
            count: typeof parsed.count === 'number' ? parsed.count : 0,
            bytes: typeof parsed.bytes === 'number' ? parsed.bytes : 0,
            kinds: Array.isArray(parsed.kinds) ? (parsed.kinds as SecretKind[]) : [],
          });
        }
      } catch {
        out.push({
          at: 0,
          action: 'policy_violation',
          target: '',
          detail: 'unparseable audit line',
          count: 0,
          bytes: 0,
          kinds: [],
        });
      }
    }
    return out;
  }

  /** Erase the log. Only I-7 may call this, and only with an explicit request. */
  async erase(): Promise<number> {
    let lines = 0;
    try {
      const raw = await fs.readFile(this.path, 'utf8');
      lines = raw.split('\n').filter((l) => l.trim() !== '').length;
    } catch {
      return 0;
    }
    await fs.rm(this.path, { force: true });
    return lines;
  }
}

const stripUndefined = (record: AuditRecordInput): Omit<AuditRecord, 'at'> => {
  const {
    at: _at,
    action,
    target = '',
    detail = '',
    count = 0,
    bytes = 0,
    kinds = [],
  } = record;
  return { action, target, detail, count, bytes, kinds };
};

/** True when an action is in a class decisions.md §3 says to retain by default. */
export const isRetainWorthy = (action: AuditAction): boolean =>
  RETAIN_WORTHY_ACTIONS.includes(action);
