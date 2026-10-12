/**
 * The `compact` lossy stage, as a value the composition root can hand the
 * gateway (C-16).
 *
 * ## Why this is a factory and not an import
 *
 * `GatewayOptions.lossyStages` takes a stage per name and the gateway never
 * imports the implementation (server.ts:85-107): the composition root builds it
 * and hands it in, the same way `adapters` carries providers the gateway does
 * not link. So the implementation lives where the transaction lives -- here, in
 * the package that owns the code which deletes data -- and the root
 * (`tools/dev.ts`) supplies the pair of things a stage cannot invent: a store to
 * write the raw transcript to, and a telemetry sink.
 *
 * This module deliberately imports nothing from `@strata-ctx/pipeline`. The
 * gateway accepts `LossyStage | AsyncLossyStage` and both are structural, so a
 * `{ name: 'compact', run }` that returns a promise is assignable without this
 * package depending on the runner that happens to hold the type.
 *
 * ## The gates, and which one is the operator's
 *
 * Three things have to agree before a single message is dropped, and none of
 * them is this file's decision to make alone:
 *
 * 1. `policy.pipeline.stages` must list `compact`. The gateway filters the
 *    injected registry against it, so a stage the operator removed never runs.
 * 2. `policy.pipeline.compaction` must be `auto`. This is the switch the stage
 *    owns: `off` and `manual` return the context untouched. `manual` has no
 *    per-request signal in a pipeline stage -- nothing hands it a "compact now"
 *    edge -- so it is treated as `off` here rather than guessing one.
 * 3. The context must be past the sawtooth trigger
 *    (`policy.pipeline.trigger.softTriggerFrac`). Compacting every turn costs
 *    the cache prefix and buys nothing while the context still fits.
 *
 * ## Fail-open, and why it is the whole safety story
 *
 * Anything that goes wrong -- an unreadable store, a gist that fails assembly, a
 * transaction that aborts on a validation defect -- returns the input context
 * unchanged. The runner already reverts a stage that throws, but a stage that
 * catches and returns the input is clearer to read and keeps the telemetry the
 * transaction emitted. Nothing here can lose a message that the transaction did
 * not itself prove is in the raw artifact: the transaction's step 6 evicts only
 * after `assessEvictable` re-reads the transcript and finds the drop set in it.
 */
import type {
  ContextState,
  ContentBlock,
  LossyContext,
  Message,
  StrataPolicy,
} from '@strata-ctx/core-types';
import { budgetView, estimateTokens, partitionForLossy, pinSetText, sha256 } from '@strata-ctx/core-types';
import type { StrataTelemetryEvent } from '@strata-ctx/telemetry';
import { createGistAssembler } from './assembly.js';
import type { TransactionArtifactStore } from './transaction.js';
import { runCompactionTransaction } from './transaction.js';

export interface CompactStageDeps {
  /** Where the raw transcript and the gist are written before anything is dropped. */
  readonly store: TransactionArtifactStore;
  /**
   * Telemetry sink. Typed to the wider `StrataTelemetryEvent` because the
   * transaction emits `gist` and `compaction`, which are not in the frozen
   * `TelemetryEvent` union the gateway accepts.
   */
  readonly emit: (event: StrataTelemetryEvent) => void;
  /** Injected clock, for deterministic timestamps in tests. */
  readonly now?: () => number;
  /** Goal for the assembled gist. Defaults to the last user message. */
  readonly goal?: string;
  /**
   * Gist status. Defaults to `partial`: the gist is assembled from a context
   * that is still mid-task, and claiming `complete` would assert something the
   * stage has no evidence for.
   */
  readonly status?: 'complete' | 'partial' | 'blocked' | 'abandoned';
  /** An explicit self-gist narrative, when the model produced one. */
  readonly selfGistBlock?: ContentBlock;
}

/**
 * The slot the gateway accepts: a lossy stage whose `run` may wait. Not a
 * `LossyStage` -- that port's `run` is synchronous and frozen in core-types --
 * so this is a separate, structural shape rather than a widening.
 */
export interface CompactStage {
  readonly name: 'compact';
  run(ctx: LossyContext): Promise<LossyContext>;
}

const DEFAULT_GOAL = 'compact the session context';

const lastUserText = (messages: readonly Message[]): string | undefined => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    const text = message.content.map((block) => block.text ?? '').join(' ').trim();
    if (text.length > 0) return text;
  }
  return undefined;
};

const toolLogOf = (messages: readonly Message[]): string =>
  JSON.stringify(
    messages.flatMap((message) =>
      message.content
        .filter((block) => block.type === 'tool_use' || block.type === 'tool_result')
        .map((block) => block.text ?? ''),
    ),
  );

/**
 * Rebuild the full context a transaction needs from the lossy view the runner
 * hands a stage.
 *
 * `partitionForLossy` holds governance out of `messages`, and the transaction's
 * step 5 repin expects it back: the assembler byte-compares the gist's
 * constraints against the governance text it finds in the state, and eviction's
 * drop set is "everything that is not governance and not the gist". So the held
 * blocks are put back as a dedicated system message at the head -- the shape
 * `enforcePins` itself produces -- rather than left out.
 */
const fullStateFrom = (ctx: LossyContext): ContextState => {
  const policy = ctx.policy;
  const held = ctx.held.filter((h) => h.reason === 'governance').map((h) => h.block);
  const messages: readonly Message[] =
    held.length > 0
      ? [{ role: 'system', content: held, ts: ctx.messages[0]?.ts ?? 0 }, ...ctx.messages]
      : [...ctx.messages];
  const pinned = pinSetText(policy);
  return {
    messages,
    pinned,
    tokenEstimate: ctx.tokenEstimate,
    policyHash: sha256(pinned.join('\n')),
    runId: ctx.runId,
    turn: ctx.turn,
    ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
    gists: ctx.gists,
    artifacts: ctx.artifacts,
  };
};

export function createCompactStage(deps: CompactStageDeps): CompactStage {
  return {
    name: 'compact',
    async run(ctx: LossyContext): Promise<LossyContext> {
      const policy: StrataPolicy = ctx.policy;
      if (policy.pipeline.compaction !== 'auto') return ctx;

      const full = fullStateFrom(ctx);
      const trigger = policy.pipeline.trigger;
      const budget = budgetView(
        policy.budgets.contextLimit,
        policy.budgets.maxOutputTokens,
        policy.budgets.targetUtilization,
        trigger.softTriggerFrac,
        trigger.hardTriggerFrac,
      );
      if (estimateTokens(full) < budget.triggerAt) return ctx;

      try {
        const taskId = ctx.taskId ?? ctx.runId;
        const goal = deps.goal ?? lastUserText(full.messages) ?? DEFAULT_GOAL;
        const draft = createGistAssembler().assemble({
          state: full,
          policy,
          budget,
          taskId,
          status: deps.status ?? 'partial',
          goal,
          ...(deps.selfGistBlock === undefined ? {} : { selfGistBlock: deps.selfGistBlock }),
        });

        const result = await runCompactionTransaction({
          state: full,
          gist: draft,
          policy,
          artifactStore: deps.store,
          emit: deps.emit,
          expectedErrorCount: draft.log_gist.salient_errors.length,
          trigger: 'auto',
          ...(deps.now === undefined ? {} : { now: deps.now }),
          rawTranscript: JSON.stringify(full.messages),
          toolLog: toolLogOf(full.messages),
        });

        if (!result.ok) return ctx;
        return partitionForLossy(result.state, policy);
      } catch {
        // Assembly or the transaction refused. The context the user already has
        // is worth more than the tokens, so nothing is dropped.
        return ctx;
      }
    },
  };
}
