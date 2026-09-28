import { sha256 } from '@strata-ctx/core-types';
import type { ArtifactRef, RetentionPolicy } from '@strata-ctx/core-types';

import type { AuditRecord } from './audit.js';
import { META_PURGE_LOG_NAME } from './audit.js';
import { AuditLog, isRetainWorthy } from './audit.js';
import type { GcAdvisory, GcOptions, GcSkip } from './retention.js';
import { AdvisoryNotAcknowledgedError, applyGc, planGc, windowDaysFor } from './retention.js';
import type { ArtifactStore } from './store.js';

/**
 * I-5 + I-7: the `/strata purge` endpoint's logic, and the meta-purge.
 *
 * ## Why the endpoint is logic and not a route
 *
 * This package owns the security boundary, and the gateway (stream A) owns the
 * socket. So what is here is a pure function from a request body to a status
 * and a body, and the gateway's route is `JSON.stringify(handlePurgeRequest(...))`.
 * Two reasons that is better than a route handler living here:
 *
 * - the authorisation decisions are testable without binding a port, so the
 *   "you cannot reach the purge log through the ordinary purge" property is a
 *   test rather than a code-reading exercise;
 * - the confirmation token cannot be forgotten, because there is one code path
 *   and the token check is inside it.
 *
 * ## The status codes are the policy
 *
 * | status | meaning |
 * |--------|---------|
 * | 200    | the request was understood and the deletions happened |
 * | 400    | the request was not understood; nothing was touched |
 * | 403    | understood, but not authorised (meta-purge without confirmation) |
 * | 409    | understood and authorised, but I-8 advisories are unacknowledged -- nothing was deleted |
 * | 412    | the request's `before` predates the oldest retained record, so it cannot be honoured |
 * | 500    | the purge started and failed partway; the log says how far it got |
 *
 * 409 rather than a silent success is the whole of I-8 at the API boundary.
 *
 * ## I-7: the meta-purge
 *
 * decisions R9: "a purge without a record of what was purged is
 * indistinguishable from a cover-up", and meta-purge is for the user with a
 * genuine obligation to erase. Three properties, all of them testable:
 *
 * 1. **Explicit.** It needs a literal confirmation token that no default,
 *    policy file, or scheduled GC supplies. A capability that can be reached by
 *    accident is a capability that will be.
 * 2. **No back door.** `scope: 'audit'` is refused *unless* it carries the same
 *    confirmation, so there is no ordinary-purge route to the log. The frozen
 *    `keepPurgeLog: true` means nothing if the API can ignore it.
 * 3. **Recorded somewhere else.** The receipt goes to a different file, and it
 *    goes there *before* the erasure. Two lines, not one: `meta_purge_started`
 *    then `meta_purge_completed`. A crash between them leaves the started line
 *    and no completed line, which is the accurate evidence of an interrupted
 *    erasure. A single line written afterwards would leave nothing at all.
 *
 * The meta-purge log itself is not erasable by any request in this file, or the
 * regress has no fixed point. That is a position, not an oversight, and it is
 * the third bullet of decisions §3.
 */

export const PURGE_PATH = '/strata/purge';

/**
 * The literal a caller must send to erase the purge log.
 *
 * Spelled out in full rather than a boolean because this is the one request in
 * the product whose whole purpose is to destroy the evidence of itself, and a
 * boolean is something a client library fills in for you.
 */
export const META_PURGE_CONFIRMATION = 'ERASE-THE-PURGE-LOG';

export type PurgeScope = 'artifacts' | 'transcripts' | 'audit' | 'all';

export const PURGE_SCOPES: readonly PurgeScope[] = ['artifacts', 'transcripts', 'audit', 'all'];

export interface PurgeRequest {
  readonly op: 'purge';
  readonly scope: PurgeScope;
  /** ISO-8601. Records at or after this instant are kept. */
  readonly before: string;
  /** Acknowledges I-8 advisories. */
  readonly force: boolean;
  /** Also erase the purge log. Requires `confirm`. */
  readonly meta: boolean;
  readonly confirm: string;
}

export type PurgeStatus = 200 | 400 | 403 | 409 | 412 | 500;

export interface MetaPurgeReceipt {
  readonly startedAt: number;
  /** Entries the log held when the receipt was written. */
  readonly entries: number;
  /** Digest of the log's bytes: lets a user prove later that a log did exist. */
  readonly logDigest: string;
  readonly completed: boolean;
}

export interface PurgeOutcome {
  readonly op: 'purge';
  readonly ok: boolean;
  readonly scope: PurgeScope;
  readonly before: string;
  readonly deleted: readonly { readonly uri: string; readonly bytes: number }[];
  readonly bytesFreed: number;
  readonly skipped: readonly GcSkip[];
  readonly advisories: readonly GcAdvisory[];
  readonly purgeLogEntries: number;
  readonly metaPurged: boolean;
  readonly receipt: MetaPurgeReceipt;
  /** Empty when `ok`. */
  readonly error: string;
}

export interface PurgeResponse {
  readonly status: PurgeStatus;
  readonly body: PurgeOutcome;
}

export interface PurgeDeps {
  readonly store: ArtifactStore;
  readonly retention: RetentionPolicy;
  readonly now: () => number;
  /**
   * Digests a live gist depends on. Supplied by the caller because only the
   * compaction transaction knows which gists are live; an expired artifact they
   * reference becomes an advisory rather than a deletion.
   */
  readonly referencedDigests?: ReadonlySet<string>;
}

/** What an omitted `before` means: no cutoff at all. */
const UNBOUNDED = '9999-12-31T23:59:59.999Z';

const NO_RECEIPT: MetaPurgeReceipt = {
  startedAt: 0,
  entries: 0,
  logDigest: '',
  completed: false,
};

const outcome = (over: Partial<PurgeOutcome> & Pick<PurgeOutcome, 'scope' | 'before'>): PurgeOutcome => ({
  op: 'purge',
  ok: false,
  deleted: [],
  bytesFreed: 0,
  skipped: [],
  advisories: [],
  purgeLogEntries: 0,
  metaPurged: false,
  receipt: NO_RECEIPT,
  error: '',
  ...over,
});

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Parse and authorise. Pure, and the only place a request body is trusted for
 * even one field: everything that is not an enum member or a boolean is dropped
 * rather than coerced, so a client cannot smuggle a scope in as an object.
 */
export function parsePurgeRequest(
  input: unknown,
): { ok: true; request: PurgeRequest } | { ok: false; status: PurgeStatus; error: string } {
  if (!isRecord(input)) return { ok: false, status: 400, error: 'body must be a json object' };
  if (input['op'] !== 'purge') return { ok: false, status: 400, error: "op must be 'purge'" };

  const scope = asString(input['scope']);
  if (!PURGE_SCOPES.includes(scope as PurgeScope)) {
    return {
      ok: false,
      status: 400,
      error: `scope must be one of ${PURGE_SCOPES.join(', ')}`,
    };
  }

  // Default: everything. An unbounded purge is the documented default of the
  // product ("the working context is cleaned after every task", decisions §3),
  // and `before` is what keeps it from being a mistake.
  const before = asString(input['before']) === '' ? UNBOUNDED : asString(input['before']);
  const parsed = Date.parse(before);
  if (Number.isNaN(parsed)) return { ok: false, status: 400, error: 'before must be an iso-8601 instant' };

  const meta = input['meta'] === true;
  const confirm = asString(input['confirm']);
  // The frozen `keepPurgeLog: true` is only meaningful if *every* route to the
  // log requires the same explicit token, including `scope: 'audit'`. A separate
  // weaker route would make the flag decorative.
  if ((meta || scope === 'audit') && confirm !== META_PURGE_CONFIRMATION) {
    return {
      ok: false,
      status: 403,
      error: `erasing the purge log requires confirm: "${META_PURGE_CONFIRMATION}" (decisions R9: a purge with no record is indistinguishable from a cover-up)`,
    };
  }

  return {
    ok: true,
    request: {
      op: 'purge',
      scope: scope as PurgeScope,
      before: new Date(parsed).toISOString(),
      force: input['force'] === true,
      meta,
      confirm,
    },
  };
}

const inScope = (kind: string, scope: PurgeScope): boolean => {
  if (scope === 'all') return true;
  if (scope === 'transcripts') return kind === 'raw_transcript' || kind === 'tool_log';
  if (scope === 'artifacts') return kind !== 'raw_transcript' && kind !== 'tool_log';
  return false; // 'audit' is handled by the meta path, never by artifact deletion
};

/**
 * The retention options the endpoint shares with the background GC, so a purge
 * and a GC can never disagree about what "retain-worthy" means.
 */
const gcOptions = (deps: PurgeDeps, force: boolean): GcOptions => {
  const base: GcOptions = {
    policy: deps.retention,
    // The caller's `before` cutoff is the boundary; the retention window plays
    // no part in deciding what a purge deletes.
    boundary: 'explicit',
    now: deps.now(),
    force,
  };
  return {
    ...base,
    ...(deps.referencedDigests === undefined ? {} : { referencedDigests: deps.referencedDigests }),
  };
};

export async function handlePurgeRequest(input: unknown, deps: PurgeDeps): Promise<PurgeResponse> {
  const parsed = parsePurgeRequest(input);
  if (!parsed.ok) {
    return {
      status: parsed.status,
      body: outcome({ scope: 'all', before: '', error: parsed.error }),
    };
  }
  const request = parsed.request;
  const now = deps.now();

  const snapshot = await deps.store.list();
  const entries = await deps.store.audit.read();
  // Only the classes the log is *required* to keep count as evidence
  // (decisions.md §3). `artifact_written` is deliberately excluded: every
  // artifact has one of those records, so treating them as evidence would make
  // every purge impossible rather than careful. A `policy_violation` or a
  // `meta_purged` line names something the operator may need to look at later,
  // and deleting the bytes would leave the record pointing at nothing.
  const auditTargets = new Set(
    entries.filter((e) => isRetainWorthy(e.action) && e.target !== '').map((e) => e.target),
  );

  // The purge boundary is `before`, not the retention window. GC ages things out
  // on a policy schedule; a purge is a user saying "not this one either", and
  // conflating the two would make "purge everything" quietly mean "purge what
  // happens to be old".
  const cutoff = Date.parse(request.before);
  const targets = snapshot.filter((s) => inScope(s.kind, request.scope) && s.writtenAt < cutoff);

  await deps.store.audit.append({
    action: 'purge_requested',
    target: request.scope,
    detail: `before=${request.before} candidates=${targets.length} meta=${request.meta}`,
    count: targets.length,
    bytes: 0,
    kinds: [],
  });

  // Advisories are computed with the retention planner so the endpoint and the
  // background GC agree on what "worth keeping" means. A purge narrows *which*
  // artifacts are eligible; it does not get a weaker notion of retention.
  const plan = planGc(targets, { ...gcOptions(deps, request.force), now, auditTargets });

  if (plan.advisories.length > 0 && !request.force) {
    await deps.store.audit.append({
      action: 'purge_refused',
      target: request.scope,
      detail: `${plan.advisories.length} retain-worthy item(s) not acknowledged; nothing deleted`,
      count: plan.advisories.length,
      bytes: 0,
      kinds: [],
    });
    return {
      status: 409,
      body: outcome({
        scope: request.scope,
        before: request.before,
        advisories: plan.advisories,
        skipped: plan.skip,
        purgeLogEntries: entries.length,
        error:
          'the request would delete items flagged as retain-worthy; re-send with force: true to acknowledge, or narrow the scope',
      }),
    };
  }

  // 412: asked to erase a window that predates the oldest thing still retained.
  // Checked before any deletion, because a purge that silently did less than it
  // was told is the worst available outcome: the user asked for a specific
  // window and would be told it was erased.
  const oldest = snapshot.reduce<number>(
    (n, s) => (s.writtenAt > 0 && s.writtenAt < n ? s.writtenAt : n),
    Number.POSITIVE_INFINITY,
  );
  const bounded = request.before !== UNBOUNDED;
  if (bounded && Number.isFinite(oldest) && cutoff < oldest) {
    await deps.store.audit.append({
      action: 'purge_refused',
      target: request.scope,
      detail: `before=${request.before} predates the oldest retained record`,
      count: 0,
      bytes: 0,
      kinds: [],
    });
    return {
      status: 412,
      body: outcome({
        scope: request.scope,
        before: request.before,
        error: `nothing is older than ${new Date(oldest).toISOString()}; the oldest retained record is newer than the requested cutoff`,
      }),
    };
  }

  let report;
  try {
    report = await applyGc(deps.store, plan, { ...gcOptions(deps, request.force), now });
  } catch (e) {
    if (e instanceof AdvisoryNotAcknowledgedError) {
      return {
        status: 409,
        body: outcome({
          scope: request.scope,
          before: request.before,
          advisories: e.advisories,
          error: e.message,
        }),
      };
    }
    await deps.store.audit.append({
      action: 'purge_refused',
      target: request.scope,
      detail: `failed: ${e instanceof Error ? e.message : String(e)}`,
      count: 0,
      bytes: 0,
      kinds: [],
    });
    return {
      status: 500,
      body: outcome({
        scope: request.scope,
        before: request.before,
        error: 'the purge failed partway; the purge log records how far it got',
      }),
    };
  }

  // The `purge_completed` line goes to the meta log when the purge log was just
  // erased. Appending it to the log the user asked to have emptied would
  // re-populate it with a record of the emptying, which is the opposite of what
  // was asked for -- and `purgeLogEntries: 0` afterwards has to be literally
  // true rather than true for one request.
  const receipt = request.meta ? await metaPurge(deps) : NO_RECEIPT;
  const completion: Omit<AuditRecord, 'at'> = {
    action: 'purge_completed',
    target: request.scope,
    detail: `deleted=${report.deleted.length} bytes=${report.bytesFreed} meta=${request.meta}`,
    count: report.deleted.length,
    bytes: report.bytesFreed,
    kinds: [],
  };
  if (request.meta) {
    await AuditLog.open(deps.store.root, META_PURGE_LOG_NAME, { now: deps.now }).append(completion);
  } else {
    await deps.store.audit.append(completion);
  }

  // Read at the very end so the number is the log's state after this request,
  // not before it. A field called `purgeLogEntries` that reported the pre-erase
  // count would tell the caller the log was full immediately after emptying it.
  const purgeLogEntries = (await deps.store.audit.read()).length;

  return {
    status: 200,
    body: outcome({
      ok: true,
      scope: request.scope,
      before: request.before,
      deleted: report.deleted,
      bytesFreed: report.bytesFreed,
      skipped: report.skipped,
      advisories: report.advisories,
      purgeLogEntries,
      metaPurged: request.meta,
      receipt,
    }),
  };
}

/**
 * I-7. Two records, in a different file, written around the erasure.
 *
 * The `started` record goes first: a crash between the two lines leaves an
 * accurate statement that an erasure was attempted, which is exactly the
 * evidence decisions §3 asks for. Writing only afterwards would leave nothing.
 */
export async function metaPurge(deps: PurgeDeps): Promise<MetaPurgeReceipt> {
  const meta = AuditLog.open(deps.store.root, META_PURGE_LOG_NAME, { now: deps.now });
  // Counted, not remembered from earlier in the request: the receipt has to
  // describe the log as it actually was, and a caller that passed a stale count
  // would put a false number in the one record that survives the erasure.
  const existing = await deps.store.audit.read();
  const entries = existing.length;
  const startedAt = deps.now();
  const logDigest = digestOfAudit(existing);

  const started: MetaPurgeReceipt = { startedAt, entries, logDigest, completed: false };
  await meta.append({
    action: 'meta_purged',
    target: 'purge-log',
    detail: `meta_purge_started entries=${entries} digest=${logDigest.slice(0, 16)}`,
    count: entries,
    bytes: 0,
    kinds: [],
    at: startedAt,
  });

  const erased = await deps.store.audit.erase();

  const completed: MetaPurgeReceipt = { ...started, completed: true, entries: erased };
  await meta.append({
    action: 'meta_purged',
    target: 'purge-log',
    detail: `meta_purge_completed erased=${erased}`,
    count: erased,
    bytes: 0,
    kinds: [],
    at: deps.now(),
  });
  return completed;
}

/** The exact bytes the log held, so a user can prove later that a log existed. */
export const digestOfAudit = (records: readonly AuditRecord[]): string =>
  sha256(records.map((r) => JSON.stringify(r)).join('\n'));

/** The retention window a kind is judged against, spelled out for a response body. */
export const describeWindow = (kind: ArtifactRef['kind'], retention: RetentionPolicy): string => {
  const days = windowDaysFor({ kind }, retention);
  return `${days} day${days === 1 ? '' : 's'}`;
};
