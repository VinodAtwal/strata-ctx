import type {
  ContextState,
  LossyContext,
  LossyStage,
  LossyStageName,
  StageName,
  StrataPolicy,
  TotalStage,
  TotalStageName,
} from '@strata-ctx/core-types';
import { estimateTokens, partitionForLossy, restoreHeld } from '@strata-ctx/core-types';
import { LOSSY_TIER0_STAGES, PIPELINE_STAGE_ORDER, runStageFailOpen } from './order.js';
import type { Tier0Stage } from './stage.js';

/**
 * A-14. The generic pipeline runner.
 *
 * The gateway's runner owns ordering and per-stage error isolation for the full
 * seven-stage pipeline and knows nothing about our decision reports -- which is
 * exactly what `order.ts`'s `LossyStage` projections exist for. The stage order
 * is `PIPELINE_STAGE_ORDER` (a safety property, see docs/architecture.md §4),
 * so this module never negotiates it; a stage that is not wired simply does not
 * run, in the position it would have held.
 *
 * Two kinds of stage cross the boundary here, and they have different shapes:
 *
 * - `LossyStage` (`dedupe`…`compress`) runs on a `LossyContext`. Each one is
 *   isolated with the same fail-open contract as `runTier0` (`runStageFailOpen`
 *   from ./order.ts): a throw, a forged return, or a reordered cached prefix
 *   fails the stage and passes the input through untouched.
 * - `TotalStage` (`pin`, `serialize`) runs on a `ContextState`. The same
 *   isolation is applied, because a governance stage that throws must still
 *   never take the request down.
 *
 * The runner bridges between the two views at each stage boundary:
 *
 * - before a `LossyStage`, the current outbound state is partitioned for lossy
 *   processing (`partitionForLossy`);
 * - after it, the lossy context is restored to a full state (`restoreHeld`).
 *
 * Because `pin` sits at position 4 (after triage, around compact), re-pinning
 * happens on every run regardless of what an earlier stage did, which is what
 * makes the governance invariant hold even when a stage failed: if a pin stage
 * is wired and runs, the pins on the output are byte-identical to the policy
 * buffer. Fail-open never skips the pin; it only keeps the input when a stage
 * cannot be trusted to transform it.
 *
 * Isolation guarantee (spec.md principle 1, N5, ADR-8): one bad stage can never
 * take down a request. The default is fail-open; `stopOnFailure` opts a
 * governance-critical caller into fail-closed halting.
 */

/** The machine-readable codes a stage result can carry. No message, no stack. */
export type StageErrorCode =
  | 'stage_threw'
  | 'prefix_reordered'
  | 'not_a_lossy_context'
  | 'not_a_context_state';

/** One stage's run, sized for telemetry: identity, verdict, cost, verdict reason. */
export interface StageResult {
  readonly name: StageName;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** Present only on failure. A closed set, not a serialized exception. */
  readonly code?: StageErrorCode;
}

export interface RunPipelineOptions {
  /** Drives the partition and the pin buffer; must be the policy the stages were built against. */
  readonly policy: StrataPolicy;
  /**
   * The lossy stage registry, keyed by name, replacing this package's fixed
   * Tier 0 default entirely when provided (the empty object means "no lossy
   * stages"). Omit it to run the Tier 0 stages `order.ts` ships. `compact` and
   * `compress` are attached here by their own workstreams.
   */
  readonly lossyStages?: Readonly<Partial<Record<LossyStageName, LossyStage>>>;
  /** `pin` (governance) and `serialize` (egress adapter), owned elsewhere. */
  readonly totalStages?: Readonly<Partial<Record<TotalStageName, TotalStage>>>;
  /** Fail-closed opt-in for governance-critical callers. Default: fail open. */
  readonly stopOnFailure?: boolean;
  /** Observability hook, invoked once per stage that actually ran, in order. */
  readonly onStage?: (result: StageResult) => void;
}

export interface PipelineRun {
  /** The final outbound state: the last successful transform, pins included. */
  readonly state: ContextState;
  /** One entry per stage that ran, in `PIPELINE_STAGE_ORDER` position order. */
  readonly stageResults: readonly StageResult[];
  readonly stagesRun: readonly StageName[];
  /** Number of failed stages. Zero for a clean run. */
  readonly failed: number;
  /** True when `stopOnFailure` cut the run short after a failure. */
  readonly halted: boolean;
}

/**
 * The `LossyStage` shape is the frozen contract's; the isolation guarantee
 * lives on `Tier0Stage` (`StageApplied` carries the report). Projecting one to
 * the other is the exact "one implementation, two views" concession
 * `order.ts` documents, so `runStageFailOpen` covers stages this package does
 * not own too.
 */
const asTier0 = (stage: LossyStage): Tier0Stage<undefined> => ({
  name: stage.name,
  run: (ctx: LossyContext) => ({ ctx: stage.run(ctx), report: undefined }),
});

/**
 * `runStageFailOpen` decides lossy failure with a `string` code; this runner
 * publishes a closed, typed set so telemetry sinks never have to guess. A code
 * this runner does not know still surfaces as `stage_threw` rather than being
 * dropped, so nothing is ever reported as "ok" by accident.
 */
const asStageCode = (code: string | undefined): StageErrorCode | undefined => {
  if (code === undefined) return undefined;
  if (code === 'stage_threw' || code === 'prefix_reordered' || code === 'not_a_lossy_context') {
    return code;
  }
  return 'stage_threw';
};

/**
 * The total-stage analog of `isLossyContext`. A `TotalStage` is lossless, so
 * there is no loss to prevent -- but a stage that hands back something that is
 * not a `ContextState` must still not be trusted with the request.
 */
const isContextState = (value: unknown): value is ContextState => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    readonly messages?: unknown;
    readonly pinned?: unknown;
    readonly tokenEstimate?: unknown;
    readonly policyHash?: unknown;
    readonly runId?: unknown;
    readonly turn?: unknown;
    readonly gists?: unknown;
    readonly artifacts?: unknown;
  };
  return (
    Array.isArray(candidate.messages) &&
    Array.isArray(candidate.pinned) &&
    typeof candidate.tokenEstimate === 'number' &&
    typeof candidate.policyHash === 'string' &&
    typeof candidate.runId === 'string' &&
    typeof candidate.turn === 'number' &&
    Array.isArray(candidate.gists) &&
    Array.isArray(candidate.artifacts)
  );
};

interface TotalOutcome {
  readonly state: ContextState;
  readonly code: StageErrorCode | undefined;
}

const isolateTotal = (stage: TotalStage, state: ContextState): TotalOutcome => {
  let out: ContextState;
  try {
    out = stage.run(state);
  } catch {
    return { state, code: 'stage_threw' };
  }
  if (!isContextState(out)) return { state, code: 'not_a_context_state' };
  return { state: out, code: undefined };
};

/** The stage set this package actually owns, as a name-keyed registry. */
const defaultLossy: ReadonlyMap<LossyStageName, LossyStage> = new Map(
  LOSSY_TIER0_STAGES.map((stage) => [stage.name, stage] as const),
);

export function runPipeline(state: ContextState, opts: RunPipelineOptions): PipelineRun {
  const lossy: ReadonlyMap<LossyStageName, LossyStage> =
    opts.lossyStages === undefined
      ? defaultLossy
      : new Map<LossyStageName, LossyStage>(
          Object.entries(opts.lossyStages)
            .filter((entry): entry is [LossyStageName, LossyStage] => entry[1] !== undefined),
        );
  const total = opts.totalStages ?? {};
  const stopOnFailure = opts.stopOnFailure === true;

  let current: ContextState = state;
  const stageResults: StageResult[] = [];
  let halted = false;

  for (const name of PIPELINE_STAGE_ORDER) {
    if (halted) break;

    if (name === 'pin' || name === 'serialize') {
      const stage = total[name];
      if (stage === undefined) continue;

      const tokensIn = estimateTokens(current);
      const started = performance.now();
      const outcome = isolateTotal(stage, current);
      const next: ContextState = outcome.code === undefined ? outcome.state : current;
      const result: StageResult = {
        name,
        ok: outcome.code === undefined,
        durationMs: performance.now() - started,
        tokensIn,
        tokensOut: estimateTokens(next),
        ...(outcome.code === undefined ? {} : { code: outcome.code }),
      };
      stageResults.push(result);
      current = next;
      opts.onStage?.(result);
      if (stopOnFailure && !result.ok) halted = true;
      continue;
    }

    const stage = lossy.get(name);
    if (stage === undefined) continue;

    const tokensIn = estimateTokens(current);
    const started = performance.now();
    const outcome = runStageFailOpen(asTier0(stage), partitionForLossy(current, opts.policy));
    let next: ContextState = current;
    if (outcome.code === undefined) {
      next = restoreHeld(outcome.ctx, {
        ...current,
        messages: outcome.ctx.messages,
        artifacts: outcome.ctx.artifacts,
      });
      next = { ...next, tokenEstimate: estimateTokens(next) };
    }
    const code = asStageCode(outcome.code);
    const result: StageResult = {
      name,
      ok: outcome.code === undefined,
      durationMs: performance.now() - started,
      tokensIn,
      tokensOut: estimateTokens(next),
      ...(code === undefined ? {} : { code }),
    };
    stageResults.push(result);
    current = next;
    opts.onStage?.(result);
    if (stopOnFailure && !result.ok) halted = true;
  }

  return {
    state: current,
    stageResults,
    stagesRun: stageResults.map((result) => result.name),
    failed: stageResults.reduce((count, result) => (result.ok ? count : count + 1), 0),
    halted,
  };
}