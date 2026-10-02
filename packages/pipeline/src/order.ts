import type {
  CacheTelemetry,
  ContextState,
  LossyContext,
  LossyStage,
  Message,
  StageName,
  StageTelemetry,
  StrataPolicy,
} from '@strata-ctx/core-types';
import {
  assertPrefixPreserved,
  estimateTokens,
  isLossyContext,
  partitionForLossy,
  restoreHeld,
} from '@strata-ctx/core-types';
import type { DedupeReport } from './dedupe.js';
import { dedupeStage } from './dedupe.js';
import type { StageApplied, Tier0Stage, Tier0StageOptions } from './stage.js';
import type { TruncateReport } from './truncate.js';
import { truncateStage } from './truncate.js';
import type { PendingArtifact } from './pointer.js';
import type { TriageReport } from './triage.js';
import { triageStage } from './triage.js';

/**
 * The stage order, in one importable place.
 *
 * docs/architecture.md §4 calls this a safety property rather than a preference,
 * and each position is load-bearing:
 *
 * - dedupe before truncate: dedupe is free, and truncating a block you are about
 *   to delete is wasted work.
 * - truncate before compact: compaction is the expensive, lossy stage. Never
 *   spend it summarising garbage that can be deleted for free. Claude Code's
 *   tiered-eviction insight.
 * - triage before compact: a context that mixes policy with logs cannot be
 *   safely summarised under one retention policy. That is the Compaction Cliff
 *   fix, and it is structural rather than procedural -- see ./triage.ts.
 * - pin after triage and around compact, so no lossy stage can remove it.
 * - compress after compact: token-level compression is the most lossy input
 *   stage, and compressing first means compacting already-compressed noise.
 * - serialize last: it is lossless and reversible, so nothing downstream has to
 *   parse TOON.
 */

export const TIER0_STAGE_ORDER = Object.freeze(['dedupe', 'truncate', 'triage'] as const);

/**
 * The whole order. This package implements only the first three: `pin` is WS-D
 * (`enforcePins`, already in core-types), `compact` is WS-C, `compress` is WS-H
 * and `serialize` is the gateway's egress adapter. They attach after `triage` in
 * exactly this sequence -- see `TUNNEL_AFTER_TIER0` and `LAST_STAGE`.
 */
export const PIPELINE_STAGE_ORDER: readonly StageName[] = Object.freeze([
  'dedupe',
  'truncate',
  'triage',
  'pin',
  'compact',
  'compress',
  'serialize',
]);

/** Where the stages owned by other workstreams attach. */
export const TUNNEL_AFTER_TIER0 = Object.freeze(['pin', 'compact', 'compress'] as const);
export const LAST_STAGE: StageName = 'serialize';

/**
 * `LossyStage` projections for the gateway's generic runner (A-14), which owns
 * ordering and per-stage error isolation for the full seven-stage pipeline and
 * knows nothing about our decision reports. Written out rather than mapped so
 * that each stage keeps its own report type with no assertion in between.
 */
export const LOSSY_TIER0_STAGES: readonly LossyStage[] = Object.freeze([
  { name: 'dedupe', run: (ctx: LossyContext): LossyContext => dedupeStage.run(ctx).ctx },
  { name: 'truncate', run: (ctx: LossyContext): LossyContext => truncateStage.run(ctx).ctx },
  { name: 'triage', run: (ctx: LossyContext): LossyContext => triageStage.run(ctx).ctx },
]);

export interface Tier0Reports {
  readonly dedupe?: DedupeReport;
  readonly truncate?: TruncateReport;
  readonly triage?: TriageReport;
}

export interface StageRun {
  readonly name: LossyStage['name'];
  readonly telemetry: StageTelemetry;
  readonly cache: CacheTelemetry;
  /** The stage threw, reordered the cached prefix, or returned a forged context. */
  readonly failedOpen: boolean;
  readonly code?: string;
}

const blockFingerprint = (messages: readonly Message[]): string =>
  messages
    .flatMap((m) => m.content)
    .map((b) => `${b.meta.sha256}/${b.meta.tier}/${b.meta.bytes}`)
    .join('|');

const cacheableFingerprint = (messages: readonly Message[]): string =>
  messages
    .flatMap((m) => m.content)
    .filter((b) => b.meta.cacheable)
    .map((b) => b.meta.sha256)
    .join('|');

const measure = (messages: readonly Message[]): { blocks: number; bytes: number } => {
  let blocks = 0;
  let bytes = 0;
  for (const m of messages) {
    for (const b of m.content) {
      blocks += 1;
      bytes += b.meta.bytes;
    }
  }
  return { blocks, bytes };
};

const PREFIX_REORDERED = 'reordered blocks inside the cached prefix';

export interface FailOpenOutcome<T> {
  readonly ctx: LossyContext;
  /** Present unless the stage failed open, in which case `ctx` is the input. */
  readonly report: T | undefined;
  /** Machine-readable reason, for telemetry. Undefined on success. */
  readonly code: string | undefined;
}

/**
 * One stage, fail-open (spec.md principle 1, N5, ADR-8).
 *
 * Failing open means returning the *input* context, unmodified. A stage that
 * throws, reorders the cached prefix, or hands back something that is not a
 * `LossyContext` is not trusted with a lossy transform: the user's context is
 * worth more than the tokens, and an exception is never a reason to lose it.
 *
 * Exported because the isolation guarantee is only worth something if it can be
 * exercised, and because the gateway's generic runner wants the same guarantee
 * for the stages this package does not own.
 */
export function runStageFailOpen<T>(
  stage: Tier0Stage<T>,
  ctx: LossyContext,
  opts?: Tier0StageOptions,
): FailOpenOutcome<T> {
  try {
    const out: StageApplied<T> = stage.run(ctx, opts);
    if (!isLossyContext(out.ctx)) return { ctx, report: undefined, code: 'not_a_lossy_context' };
    // Cheap, and it catches a bug during development rather than in a user's
    // context window. R4: reordering inside the cached prefix destroys the
    // economics of the whole system, silently.
    assertPrefixPreserved(ctx.messages, out.ctx.messages);
    return { ctx: out.ctx, report: out.report, code: undefined };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ctx,
      report: undefined,
      code: message.includes(PREFIX_REORDERED) ? 'prefix_reordered' : 'stage_threw',
    };
  }
}

export interface Tier0Result {
  readonly state: ContextState;
  readonly runs: readonly StageRun[];
  readonly reports: Tier0Reports;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly blocksBefore: number;
  readonly blocksAfter: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  /** A cacheable block changed content or position. See decisions R4. */
  readonly prefixInvalidated: boolean;
  readonly stagesRun: readonly LossyStage['name'][];
  /** Policy listed the Tier 0 stages in some order other than the fixed one. */
  readonly policyOrderIgnored: boolean;
  /**
   * `artifact://` references this run published whose bytes are not stored yet.
   *
   * A caller that publishes `state` while this is non-empty has published a
   * pointer to nothing. So the contract is narrow and absolute: persist these
   * first, or discard `state` and re-run with `durable: false`.
   */
  readonly pending: readonly PendingArtifact[];
}

/**
 * The Tier 0 half of the pipeline: partition, run stages 1-3, restore.
 *
 * Stages run in `TIER0_STAGE_ORDER` regardless of the order in
 * `policy.pipeline.stages`. Order is a safety property, and a config file is not
 * a place to negotiate it; a policy that reorders is a mistake worth reporting
 * rather than obeying. The policy still decides *whether* a stage runs, which is
 * a decision it should own.
 *
 * The stages are pure functions. The measurement wrapped around them is not, and
 * that is the only impurity in this package.
 *
 * `opts.durable` is the caller's promise that it can store what stage 2 hands
 * back. It is a parameter because Tier 0 cannot verify it and cannot fail on it:
 * the stage is synchronous, so it publishes a reference it cannot back and the
 * store write happens later, on the other side of this call. Passing
 * `durable: false` is the honest answer when no store was opened, and it costs
 * compression rather than content.
 */
export function runTier0(
  state: ContextState,
  policy: StrataPolicy,
  opts?: Tier0StageOptions,
): Tier0Result {
  const enabled = new Set<StageName>(policy.pipeline.stages);
  const activeTier0 = TIER0_STAGE_ORDER.filter((n) => enabled.has(n));
  const policyTier0 = policy.pipeline.stages.filter((n): n is LossyStage['name'] =>
    (TIER0_STAGE_ORDER as readonly string[]).includes(n),
  );
  const policyOrderIgnored = policyTier0.join() !== activeTier0.join();

  const before = measure(state.messages);
  const tokensBefore = estimateTokens(state);
  const beforeCache = cacheableFingerprint(state.messages);

  let ctx: LossyContext = partitionForLossy(state, policy);
  const runs: StageRun[] = [];
  const reports: {
    dedupe?: DedupeReport;
    truncate?: TruncateReport;
    triage?: TriageReport;
  } = {};
  const stagesRun: LossyStage['name'][] = [];

  for (const name of TIER0_STAGE_ORDER) {
    if (!enabled.has(name)) continue;

    const start = performance.now();
    const stageBefore = measure(ctx.messages);
    const fingerprintBefore = blockFingerprint(ctx.messages);
    const cacheBefore = cacheableFingerprint(ctx.messages);

    // Three branches, one implementation. Each hands the same generic runner a
    // concrete stage so the report stays typed all the way to the sink; a lookup
    // table would need an assertion on the report, which is exactly the kind of
    // thing the frozen contract asks us not to paper over.
    let next: LossyContext = ctx;
    let code: string | undefined;
    if (name === 'dedupe') {
      const r = runStageFailOpen(dedupeStage, ctx);
      next = r.ctx;
      code = r.code;
      if (r.report !== undefined) reports.dedupe = r.report;
    } else if (name === 'truncate') {
      const r = runStageFailOpen(truncateStage, ctx, opts);
      next = r.ctx;
      code = r.code;
      if (r.report !== undefined) reports.truncate = r.report;
    } else {
      const r = runStageFailOpen(triageStage, ctx);
      next = r.ctx;
      code = r.code;
      if (r.report !== undefined) reports.triage = r.report;
    }

    const durationMs = performance.now() - start;
    ctx = next;

    const stageAfter = measure(ctx.messages);
    const cacheAfter = cacheableFingerprint(ctx.messages);

    runs.push({
      name,
      telemetry: {
        stage: name,
        bytesIn: stageBefore.bytes,
        bytesOut: stageAfter.bytes,
        blocksIn: stageBefore.blocks,
        blocksOut: stageAfter.blocks,
        durationMs,
        changed: code !== undefined || blockFingerprint(ctx.messages) !== fingerprintBefore,
      },
      cache: { prefixHit: cacheAfter === cacheBefore, prefixInvalidated: cacheAfter !== cacheBefore },
      failedOpen: code !== undefined,
      ...(code === undefined ? {} : { code }),
    });
    stagesRun.push(name);
  }

  // `ctx.messages` and `ctx.artifacts` are assignable to their `ContextState`
  // counterparts; `restoreHeld` puts the held governance blocks back at the
  // head, which is the position `enforcePins` gave them when they were sent.
  const restored = restoreHeld(ctx, {
    ...state,
    messages: ctx.messages,
    artifacts: ctx.artifacts,
  });
  const out: ContextState = { ...restored, tokenEstimate: estimateTokens(restored) };
  const after = measure(out.messages);

  return {
    state: out,
    runs,
    reports,
    tokensBefore,
    tokensAfter: out.tokenEstimate,
    blocksBefore: before.blocks,
    blocksAfter: after.blocks,
    bytesBefore: before.bytes,
    bytesAfter: after.bytes,
    prefixInvalidated: cacheableFingerprint(out.messages) !== beforeCache,
    stagesRun,
    policyOrderIgnored,
    // Truncate is the only stage that mints references, but the caller should not
    // have to know that -- and a stage policy that omits truncate must yield an
    // empty list rather than an undefined one that needs a guard downstream.
    pending: reports.truncate?.pending ?? [],
  };
}
