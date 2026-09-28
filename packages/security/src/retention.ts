import type { RetentionPolicy } from '@strata-ctx/core-types';

import { isRetainWorthy } from './audit.js';
import type { ArtifactStat } from './store.js';
import type { ArtifactStore } from './store.js';

/**
 * I-5 + I-8: what gets deleted, when, and -- the part that matters -- what
 * refuses to be deleted without saying so.
 *
 * ## The two classes, from decisions.md §3
 *
 * | class                              | examples                                     | behaviour |
 * |------------------------------------|----------------------------------------------|-----------|
 * | ephemeral context                  | tool output, scratch narration, bulk payloads | age out (default; the product) |
 * | durable memory                     | gists, `current_values`, artifacts            | age out on the longer window |
 * | audit / security / legal          | ACL denials, blocked secrets, purge refusals   | **never** by age |
 *
 * The third row is I-8. A GC that quietly drops the record of a refused purge
 * has removed the only evidence that the tool tried to do something the user did
 * not authorise, and it did so in the same code path that is supposed to be the
 * boring one. So the GC *plans* first, the plan is inspectable, and anything
 * retain-worthy in the plan comes back as an advisory the caller has to
 * acknowledge -- never as a deletion.
 *
 * ## Why planning is separate from applying
 *
 * `planGc` is pure: it takes a snapshot of what is on disk and says what it
 * would do. That is what makes I-8 testable, and it is what makes it possible
 * for the `/strata purge` endpoint to answer "what would this delete?" before it
 * deletes anything. Deletion is a separate call that takes a plan, so the only
 * way to delete is to have planned first -- and a plan that contains an
 * unacknowledged advisory deletes nothing.
 *
 * ## The clock is injected
 *
 * Retention is the one feature that cannot be tested by calling it. Every
 * function here takes `now`, so a test can place an artifact at day 0 and GC at
 * day 31 without waiting, and so a bug in the arithmetic shows up as a wrong
 * number rather than as a test that expires next month.
 */

export type RetentionClass = 'raw' | 'artifact' | 'retain_worthy';

export const DAY_MS = 86_400_000;

/**
 * Which window an artifact is judged against.
 *
 * `raw_transcript` and `tool_log` are the raw user context -- the most sensitive
 * thing the product touches (decisions Q3) -- and they get the *shorter* window
 * on purpose. Data minimisation is about the most sensitive data first.
 */
export function retentionClassOf(stat: Pick<ArtifactStat, 'kind'>): RetentionClass {
  if (stat.kind === 'raw_transcript' || stat.kind === 'tool_log') return 'raw';
  return 'artifact';
}

export function windowDaysFor(
  stat: Pick<ArtifactStat, 'kind'>,
  policy: RetentionPolicy,
): number {
  return retentionClassOf(stat) === 'raw' ? policy.rawTranscriptDays : policy.artifactDays;
}

export function expiresAt(
  stat: Pick<ArtifactStat, 'kind' | 'writtenAt'>,
  policy: RetentionPolicy,
): number {
  return stat.writtenAt + windowDaysFor(stat, policy) * DAY_MS;
}

/** Why the planner declined to put an artifact in the delete list. */
export type SkipReason =
  // `writtenAt` is 0 or in the future: a store with no sidecar, or a clock skew.
  | 'unknown_age'
  // A live gist still points at it; deleting it would make that compaction
  // irreversible, which is the guarantee spec principle 2 is built on.
  | 'referenced_by_gist'
  // An audit record names it, so the bytes are evidence for a recorded event.
  | 'subject_of_audit_record'
  // Under its retention window, or inside an explicit `before` cutoff.
  | 'within_window';

export interface GcCandidate {
  readonly stat: ArtifactStat;
  readonly class: RetentionClass;
  readonly expiresAt: number;
}

export interface GcSkip {
  readonly uri: string;
  readonly kind: ArtifactStat['kind'];
  readonly reason: SkipReason;
  readonly detail: string;
}

export interface GcAdvisory {
  readonly uri: string;
  readonly reason: string;
  /**
   * What the user loses. Named, because an advisory nobody can act on is a
   * warning they learn to ignore.
   */
  readonly consequence: string;
}

export interface GcPlan {
  readonly now: number;
  readonly delete: readonly GcCandidate[];
  readonly skip: readonly GcSkip[];
  /** Things that would be deleted but are flagged as worth keeping. Never deleted by `applyGc`. */
  readonly advisories: readonly GcAdvisory[];
  readonly bytesFreedIfApplied: number;
  readonly policy: {
    readonly rawTranscriptDays: number;
    readonly artifactDays: number;
  };
}

export interface GcReport {
  readonly deleted: readonly { uri: string; bytes: number }[];
  readonly advisories: readonly GcAdvisory[];
  readonly skipped: readonly GcSkip[];
  readonly bytesFreed: number;
  readonly aliasesPruned: number;
}

/**
 * What decides that something is old enough to delete.
 *
 * - `'retention'` (default) is background GC: the policy window decides.
 * - `'explicit'` is a user purge: the caller already applied its own cutoff, so
 *   the window is deliberately *not* consulted. Conflating the two would make
 *   "purge my last 24 hours" silently mean "purge what also happens to be older
 *   than 14 days", and a purge that quietly does less than it was told is worse
 *   than a purge that refuses.
 */
export type GcBoundary = 'retention' | 'explicit';

export interface GcOptions {
  readonly policy: RetentionPolicy;
  readonly boundary?: GcBoundary;
  readonly now: number;
  /**
   * Digests a live gist depends on. An expired artifact in this set is an
   * advisory, not a deletion: the whole reversibility guarantee (spec principle
   * 2) depends on those bytes still being there.
   */
  readonly referencedDigests?: ReadonlySet<string>;
  /**
   * Set only by an explicit user request. Acknowledges advisories; the report
   * still lists them, so an override is visible after the fact rather than
   * invisible during it.
   */
  readonly force?: boolean;
  /**
   * Audit targets seen in the log. An artifact named by a purge or a violation
   * record is part of the evidence for that event.
   */
  readonly auditTargets?: ReadonlySet<string>;
}

const DAY = (n: number): string => `${n} day${n === 1 ? '' : 's'}`;

/**
 * Pure. Says what GC would do, and refuses to put a retain-worthy thing in the
 * delete list even with `force` -- `force` acknowledges advisories, and an
 * advisory about evidence is not a deletion the GC is allowed to make at all.
 */
export function planGc(
  snapshot: readonly ArtifactStat[],
  options: GcOptions,
): GcPlan {
  const deleteList: GcCandidate[] = [];
  const skip: GcSkip[] = [];
  const advisories: GcAdvisory[] = [];

  const explicit = options.boundary === 'explicit';

  for (const stat of snapshot) {
    const cls = retentionClassOf(stat);
    const window = windowDaysFor(stat, options.policy);
    // In explicit mode the caller's cutoff has already done the ageing, so the
    // window is reported for context but not used as a gate.
    const expiry = explicit ? stat.writtenAt : expiresAt(stat, options.policy);

    if (stat.writtenAt <= 0 || stat.writtenAt > options.now) {
      skip.push({
        uri: stat.uri,
        kind: stat.kind,
        reason: 'unknown_age',
        detail: 'no sidecar timestamp, or a timestamp in the future: treated as unexpired',
      });
      continue;
    }

    const referenced = options.referencedDigests?.has(stat.digest) === true;
    if (referenced) {
      advisories.push({
        uri: stat.uri,
        reason: 'referenced_by_gist',
        consequence:
          'a live gist points here; deleting it makes that compaction irreversible, which breaks the reversibility guarantee',
      });
      skip.push({ uri: stat.uri, kind: stat.kind, reason: 'referenced_by_gist', detail: 'retain' });
      continue;
    }

    const inAudit = options.auditTargets?.has(stat.uri) === true;
    if (inAudit) {
      advisories.push({
        uri: stat.uri,
        reason: 'subject_of_audit_record',
        consequence: 'an audit record names this artifact; deleting it removes the evidence for that event',
      });
      skip.push({
        uri: stat.uri,
        kind: stat.kind,
        reason: 'subject_of_audit_record',
        detail: 'retain',
      });
      continue;
    }

    if (options.now < expiry) {
      skip.push({
        uri: stat.uri,
        kind: stat.kind,
        reason: 'within_window',
        detail: `expires at ${new Date(expiry).toISOString()} (${DAY(window)})`,
      });
      continue;
    }

    deleteList.push({ stat, class: cls, expiresAt: expiry });
  }

  return {
    now: options.now,
    delete: deleteList,
    skip,
    advisories,
    bytesFreedIfApplied: deleteList.reduce((n, c) => n + c.stat.bytes, 0),
    policy: {
      rawTranscriptDays: options.policy.rawTranscriptDays,
      artifactDays: options.policy.artifactDays,
    },
  };
}

/**
 * Apply a plan. Refuses to run at all while the plan carries an unacknowledged
 * advisory, which is the I-8 guarantee expressed as a control-flow fact rather
 * than as a code review note.
 */
export function assertPlanAcknowledged(plan: GcPlan, options: GcOptions): void {
  if (plan.advisories.length > 0 && options.force !== true) {
    throw new AdvisoryNotAcknowledgedError(plan.advisories);
  }
}

export class AdvisoryNotAcknowledgedError extends Error {
  readonly advisories: readonly GcAdvisory[];

  constructor(advisories: readonly GcAdvisory[]) {
    super(
      `${advisories.length} item(s) are flagged as retain-worthy; nothing was deleted (re-run with an explicit acknowledgement)`,
    );
    this.name = 'AdvisoryNotAcknowledgedError';
    this.advisories = advisories;
  }
}

export async function applyGc(store: ArtifactStore, plan: GcPlan, options: GcOptions): Promise<GcReport> {
  assertPlanAcknowledged(plan, options);
  const deleted: { uri: string; bytes: number }[] = [];
  let aliasesPruned = 0;

  for (const candidate of plan.delete) {
    const uri = candidate.stat.uri;
    if (await store.remove(uri)) {
      deleted.push({ uri, bytes: candidate.stat.bytes });
      aliasesPruned += await store.pruneAliases(candidate.stat.digest);
    }
  }

  await store.audit.append({
    action: 'gc_deleted',
    target: 'store',
    detail: `raw=${DAY(plan.policy.rawTranscriptDays)} artifact=${DAY(plan.policy.artifactDays)}`,
    count: deleted.length,
    bytes: plan.bytesFreedIfApplied,
    kinds: [],
  });

  return {
    deleted,
    advisories: plan.advisories,
    skipped: plan.skip,
    bytesFreed: deleted.reduce((n, d) => n + d.bytes, 0),
    aliasesPruned,
  };
}

/** Convenience: plan and apply, with the acknowledgement check in between. */
export async function runGc(store: ArtifactStore, options: GcOptions): Promise<{ plan: GcPlan; report: GcReport }> {
  const plan = planGc(await store.list(), options);
  const report = await applyGc(store, plan, options);
  return { plan, report };
}

/** True for an audit action GC must never age out. Re-exported for the endpoint. */
export const isRetainWorthyAction = isRetainWorthy;
