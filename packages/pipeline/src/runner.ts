import type {
  ContextState,
  LossyContext,
  LossyStage,
  LossyStageName,
  Message,
  StageName,
  StrataPolicy,
  TelemetryEvent,
  TotalStage,
  TotalStageName,
} from '@strata-ctx/core-types';
import {
  estimateTokens,
  isLossyContext,
  partitionForLossy,
  restoreHeld,
} from '@strata-ctx/core-types';
import type { CachePrefixDiff } from './cache-prefix.js';
import { observeCachePrefix } from './cache-prefix.js';
import { LOSSY_TIER0_STAGES, PIPELINE_STAGE_ORDER, runStageFailOpen } from './order.js';
import type { StageApplied } from './stage.js';

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

/**
 * The machine-readable codes a stage result can carry. No message, no stack.
 *
 * One code per *actionable* condition, which is the property that makes the
 * code worth having. A code that stands for two conditions is a code an operator
 * has to disambiguate by hand from the `message`, and `message` is free text
 * that nobody has ever written a dashboard against:
 *
 * - `stage_threw` -- the stage's `run` raised. The remedy is in the stage's own
 *   implementation, or in `policy.pipeline.stages`, which is where an operator
 *   can remove it from the run.
 * - `prefix_reordered` -- the stage moved or rewrote a cacheable block inside
 *   the provider's cached prefix. Distinct from a throw on purpose: this is
 *   decisions R4, the one that destroys the cache economics, and it recurs
 *   every turn because the offending input recurs every turn.
 * - `not_a_lossy_context` / `not_a_context_state` -- the stage returned a
 *   forged state. The stage's declared return type is a lie, which is a
 *   different bug from the same signature raising.
 * - `unrecognised_stage_code` -- `order.ts` produced a code this runner does not
 *   know. Nothing ran wrongly; this runner's own vocabulary is out of date, and
 *   that has to be visible rather than folded into `stage_threw`.
 */
export type StageErrorCode =
  | 'stage_threw'
  | 'prefix_reordered'
  | 'not_a_lossy_context'
  | 'not_a_context_state'
  | 'unrecognised_stage_code';

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

/**
 * The lossy stage this runner actually accepts: same slot, same isolation
 * contract as `LossyStage`, one difference -- `run` may return a promise.
 *
 * `compact` is the reason this type exists rather than a widening of
 * `LossyStage`. `LossyStage.run` is in the frozen contract
 * (`core-types/src/guards.ts`), so widening it would be a §1 change. The shape
 * lives here instead, and `RunPipelineOptions.lossyStages` is typed as
 * `LossyStage | AsyncLossyStage` so that one registry means one thing: a plain
 * `LossyStage` is a widening of this, so a registry that was valid before
 * C-13 is still valid, and nothing has to be re-typed to opt out of waiting.
 */
export interface AsyncLossyStage {
  readonly name: LossyStageName;
  run(ctx: LossyContext): LossyContext | Promise<LossyContext>;
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
  readonly lossyStages?: Readonly<Partial<Record<LossyStageName, LossyStage | AsyncLossyStage>>>;
  /** `pin` (governance) and `serialize` (egress adapter), owned elsewhere. */
  readonly totalStages?: Readonly<Partial<Record<TotalStageName, TotalStage>>>;
  /** Fail-closed opt-in for governance-critical callers. Default: fail open. */
  readonly stopOnFailure?: boolean;
  /** Observability hook, invoked once per stage that actually ran, in order. */
  readonly onStage?: (result: StageResult) => void;
  /**
   * Telemetry sink, same shape the gateway's server already accepts
   * (`telemetry?: (e: TelemetryEvent) => void`). Receives one `cache` event per
   * stage that ran, plus an `error` event when a stage is found to have
   * reordered the cached prefix or when the accounting itself failed open.
   */
  readonly onTelemetry?: (event: TelemetryEvent) => void;
}

export interface PipelineRun {
  /** The final outbound state: the last successful transform, pins included. */
  readonly state: ContextState;
  /** One entry per stage that ran, in `PIPELINE_STAGE_ORDER` position order. */
  readonly stageResults: readonly StageResult[];
  readonly stagesRun: readonly StageName[];
  /**
   * One entry per stage that ran, in `PIPELINE_STAGE_ORDER` position order:
   * what happened to the provider's cached prefix, and whether it was measured.
   * Populated whether or not `onTelemetry` is wired, so a caller can read the
   * accounting without owning a sink.
   */
  readonly cachePrefix: readonly CachePrefixDiff[];
  /** Number of failed stages. Zero for a clean run. */
  readonly failed: number;
  /** True when `stopOnFailure` cut the run short after a failure. */
  readonly halted: boolean;
}

/**
 * `runStageFailOpen` decides lossy failure with a `string` code; this runner
 * publishes a closed, typed set so telemetry sinks never have to guess.
 *
 * Exported because the gateway reports the same conditions on the same
 * vocabulary: `runTier0` hands back `StageRun.code` as a bare `string`, and the
 * gateway has to narrow it somewhere. Two copies of this table would be two
 * answers to "what codes exist", which is the defect P0-1 is about.
 *
 * ## Why `unrecognised_stage_code` exists
 *
 * The old version ended in `return 'stage_threw'`, on the reasoning that an
 * unknown code "still surfaces rather than being dropped, so nothing is ever
 * reported as ok by accident". True, and it is the whole problem: it surfaces a
 * condition this file has never heard of *as a throw*, which is a different
 * condition with a different fix. `order.ts` grows a code, every new failure
 * silently becomes `stage_threw`, and an operator is sent to a stage that is
 * working perfectly.
 *
 * Note the one reachable path that does not need a future `order.ts` change:
 * this function is public, so a caller narrowing a `StageRun.code` it did not
 * produce can hand it anything.
 */
export function asStageCode(code: string | undefined): StageErrorCode | undefined {
  switch (code) {
    case undefined:
      return undefined;
    case 'stage_threw':
    case 'prefix_reordered':
    case 'not_a_lossy_context':
    case 'not_a_context_state':
    case 'unrecognised_stage_code':
      return code;
    default:
      return 'unrecognised_stage_code';
  }
}

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

const NO_EMIT = (): void => {};

/**
 * What a stage leaves behind: the typed verdict, the prefix measurement, and
 * the state to commit. Every stage records through this, so telemetry is a
 * property of the stage rather than of the branch that reached it: a stage that
 * returned a `LossyContext` and a stage that returned a promise are measured
 * the same way or the numbers are not comparable.
 */
interface RecordedStep {
  readonly result: StageResult;
  readonly diff: CachePrefixDiff;
  readonly next: ContextState;
}

interface StepInput {
  /** The messages the prefix measurement compares against. */
  readonly measuredBefore: readonly Message[];
  /**
   * What the stage actually produced, narrowed by the caller. Measuring the
   * committed state instead would be blind: isolation discards the output on
   * failure, so a reordered prefix would be reverted before the tracker saw it,
   * and these stages have no other guard.
   */
  readonly observedMessages: readonly Message[] | undefined;
  readonly code: StageErrorCode | undefined;
  readonly started: number;
  readonly tokensIn: number;
  readonly runId: string;
  readonly emit: (event: TelemetryEvent) => void;
}

const recordStep = (name: StageName, input: StepInput, next: ContextState): RecordedStep => ({
  result: {
    name,
    ok: input.code === undefined,
    durationMs: performance.now() - input.started,
    tokensIn: input.tokensIn,
    tokensOut: estimateTokens(next),
    ...(input.code === undefined ? {} : { code: input.code }),
  },
  diff: observeCachePrefix(
    name,
    {
      before: input.measuredBefore,
      after: input.observedMessages,
      reverted: input.code !== undefined,
    },
    input.runId,
    input.emit,
  ),
  next,
});

/** The mutable part of a run, so a loop body reads as compute, record, commit. */
interface LoopState {
  current: ContextState;
  readonly stageResults: StageResult[];
  readonly cachePrefix: CachePrefixDiff[];
  halted: boolean;
}

const commit = (
  loop: LoopState,
  step: RecordedStep,
  stopOnFailure: boolean,
  onStage: ((result: StageResult) => void) | undefined,
): void => {
  loop.stageResults.push(step.result);
  loop.cachePrefix.push(step.diff);
  loop.current = step.next;
  onStage?.(step.result);
  if (stopOnFailure && !step.result.ok) loop.halted = true;
};

const finish = (loop: LoopState): PipelineRun => ({
  state: loop.current,
  stageResults: loop.stageResults,
  stagesRun: loop.stageResults.map((result) => result.name),
  cachePrefix: loop.cachePrefix,
  failed: loop.stageResults.reduce((count, result) => (result.ok ? count : count + 1), 0),
  halted: loop.halted,
});

/**
 * Put a validated lossy output back into a full state.
 *
 * `gists` is taken from the stage's output as well as `messages` and
 * `artifacts`, which is the one thing this does that it did not do before.
 * `compact` commits a gist: a `gist://` message in `messages` and a matching
 * record in `gists`. Keeping the first and dropping the second would leave
 * `governance/type-guard.ts` and `ctx_status` reading a state that disagrees
 * with the transcript it is about. The Tier 0 stages do not touch `gists`, so
 * for everything wired today the value is the same either way.
 */
const restoreLossy = (
  outcome: { readonly ctx: LossyContext; readonly code: string | undefined },
  current: ContextState,
): ContextState => {
  if (outcome.code !== undefined) return current;
  const restored = restoreHeld(outcome.ctx, {
    ...current,
    messages: outcome.ctx.messages,
    artifacts: outcome.ctx.artifacts,
    gists: outcome.ctx.gists,
  });
  return { ...restored, tokenEstimate: estimateTokens(restored) };
};

/**
 * Run one turn's stages in pipeline order, isolating each so one failure costs
 * that stage and not the request.
 *
 * ## Why this is `async` and there is only one of it
 *
 * It was two runners: a synchronous `runPipeline` for callers with nothing to
 * wait for, and `runPipelineAsync` for the ones that injected `compact`. Both
 * bodies were the same loop with one branch moved, which is exactly the
 * "one implementation, two views" shape this repo's gates treat as a defect --
 * and the moment the gateway tunnel awaited the async one, the synchronous one
 * had no caller left anywhere and the wiring ratchet said so.
 *
 * Awaiting a stage that returned a `LossyContext` rather than a promise costs a
 * microtask and no behavior, so one runner that waits covers both. The type
 * still tells a reader which stages can block: `lossyStages` accepts
 * `LossyStage | AsyncLossyStage`, and a plain `LossyStage` needs no change to
 * run through it.
 *
 * The isolation contract does not change with the wait: a stage that throws or
 * rejects, resolves to something that is not a `LossyContext`, or reorders the
 * cached prefix fails open, with the stage's own input restored. The rejection
 * is re-raised *inside* `runStageFailOpen` rather than handled here, so there
 * is one classification table (`stage_threw` vs `prefix_reordered`) instead of
 * a second one that drifts.
 *
 * Total stages stay synchronous. `TotalStage` is governance (`pin`) or the
 * egress adapter (`serialize`), and neither can become async without a contract
 * change; only `compact` needs to wait.
 */
export async function runPipeline(state: ContextState, opts: RunPipelineOptions): Promise<PipelineRun> {
  const lossy: ReadonlyMap<LossyStageName, LossyStage | AsyncLossyStage> =
    opts.lossyStages === undefined
      ? defaultLossy
      : new Map<LossyStageName, LossyStage | AsyncLossyStage>(
          Object.entries(opts.lossyStages)
            .filter(
              (entry): entry is [LossyStageName, LossyStage | AsyncLossyStage] =>
                entry[1] !== undefined,
            ),
        );
  const total = opts.totalStages ?? {};
  const stopOnFailure = opts.stopOnFailure === true;
  const runId = state.runId;
  const emit = opts.onTelemetry ?? NO_EMIT;

  const loop: LoopState = {
    current: state,
    stageResults: [],
    cachePrefix: [],
    halted: false,
  };

  for (const name of PIPELINE_STAGE_ORDER) {
    if (loop.halted) break;

    if (name === 'pin' || name === 'serialize') {
      const stage = total[name];
      if (stage === undefined) continue;

      const current = loop.current;
      const tokensIn = estimateTokens(current);
      const started = performance.now();
      let observed: ContextState | undefined;
      const outcome = isolateTotal(
        { name, run: (s) => (observed = stage.run(s)) },
        current,
      );
      const next = outcome.code === undefined ? outcome.state : current;
      commit(
        loop,
        recordStep(
          name,
          {
            measuredBefore: current.messages,
            observedMessages: isContextState(observed) ? observed.messages : undefined,
            code: outcome.code,
            started,
            tokensIn,
            runId,
            emit,
          },
          next,
        ),
        stopOnFailure,
        opts.onStage,
      );
      continue;
    }

    const stage = lossy.get(name);
    if (stage === undefined) continue;

    const current = loop.current;
    const tokensIn = estimateTokens(current);
    const started = performance.now();
    const lossyIn = partitionForLossy(current, opts.policy);

    let observed: LossyContext | undefined;
    let rejection: { readonly error: unknown } | undefined;
    try {
      observed = await stage.run(lossyIn);
    } catch (error) {
      rejection = { error };
    }

    const outcome = runStageFailOpen(
      {
        name,
        run: (): StageApplied<undefined> => {
          if (rejection !== undefined) throw rejection.error;
          return { ctx: observed as LossyContext, report: undefined };
        },
      },
      lossyIn,
    );
    commit(
      loop,
      recordStep(
        name,
        {
          measuredBefore: lossyIn.messages,
          observedMessages: isLossyContext(observed) ? observed.messages : undefined,
          code: asStageCode(outcome.code),
          started,
          tokensIn,
          runId,
          emit,
        },
        restoreLossy(outcome, current),
      ),
      stopOnFailure,
      opts.onStage,
    );
  }

  return finish(loop);
}