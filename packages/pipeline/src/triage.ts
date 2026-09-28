import type {
  HeldBlock,
  LossyContext,
  NonGovernanceBlock,
  NonGovernanceMessage,
  Tier,
} from '@strata-ctx/core-types';
import type { Tier0Stage } from './stage.js';

/**
 * B-5 triage + B-6 user-intent tagging.
 *
 * ## Why triage exists at all
 *
 * docs/architecture.md §4: "you cannot safely summarize a context that mixes
 * policy with logs under one retention policy." Governance Decay measured policy
 * violations going 0% -> 30% purely from compaction, and 38% when a constraint
 * was dropped versus 0% when it survived. The mechanism is a *single* retention
 * policy applied to a heterogeneous context. So triage's job is to give every
 * tier its own retention policy, and the policy is what the compactor reads.
 *
 * ## The Compaction Cliff fix lives here, and it is structural
 *
 * Compaction Cliff (CIKM 2026) measured safety rules surviving production
 * `/compact` at 53% after one round and 10% after five. The fix is not a
 * better summariser; it is that governance must never be summarised. The frozen
 * contract already guarantees that: `partitionForLossy` lifts governance blocks
 * into `ctx.held`, and `NonGovernanceBlock` cannot carry `tier: 'governance'`,
 * so triage is handed something that *cannot* contain one.
 *
 * This module therefore does two things and no more:
 *
 * 1. A runtime re-check, because a context can arrive by cast rather than by
 *    constructor. A block whose declared tier is governance is *diverted into
 *    `held`*, never dropped and never reclassified: losing it would be a
 *    correctness bug, and keeping it in the lossy path would be a safety bug.
 *    `held` is exactly the bucket `restoreHeld` puts back at the head of the
 *    outbound request, so diverting is lossless.
 * 2. The retention policy per tier, plus the census that proves nothing was lost.
 */

/**
 * What a compactor is allowed to do with a tier. This is the glossary's
 * "per-type retention policy": governance, tool_state and episodic are not
 * treated alike.
 */
export type TierRetention =
  /** Never summarised. Ever. This is the Compaction Cliff fix. */
  | 'verbatim'
  /** Tier 0 head/tail only; a command result is not worth a gist. */
  | 'truncate'
  /** Replaceable by a validated gist at a task boundary. */
  | 'compact'
  /** Already a pointer. Never re-expanded, never gisted. */
  | 'reference';

export const TIER_RETENTION: Readonly<Record<Tier, TierRetention>> = Object.freeze({
  governance: 'verbatim',
  user_intent: 'verbatim',
  tool_state: 'truncate',
  episodic: 'compact',
  artifact_ref: 'reference',
});

/**
 * Why `user_intent` is verbatim and not merely "tagged": the intent statement is
 * the thing generic summarisation loses first, and spec.md principle 4 exists
 * because conflating backward state with forward intent is exactly where generic
 * summaries fail. It is not a tier that gets summarised; it is the task.
 */

const ALL_TIERS: readonly Tier[] = Object.freeze([
  'governance',
  'episodic',
  'tool_state',
  'artifact_ref',
  'user_intent',
]);

/**
 * Reading a `NonGovernanceBlock`'s tier as a `Tier` is a widening, not an
 * assertion, and it is what makes the runtime governance re-check expressible:
 * the compiler already believes the value cannot be 'governance', so the
 * comparison has to be made against the wider type for the runtime value to be
 * examinable at all.
 *
 * `Tier` is a closed union in the schema, so the fallback is unreachable through
 * a validated policy. It exists because a phantom census key is worse than a
 * wrong one: writing `census[tier] += 1` for a value outside the union would add
 * a key that `totalBlocks` does not sum, and the invariant "every block in the
 * context is accounted for" would quietly stop holding. An unrecognised tier is
 * treated as `episodic` -- conversation, which `compact` can handle and which is
 * emphatically not governance, so the block stays visible in the working set.
 */
const declaredTier = (b: NonGovernanceBlock): Tier =>
  (ALL_TIERS as readonly string[]).includes(b.meta.tier) ? b.meta.tier : 'episodic';

export interface TriageReport {
  /** Blocks per tier, governance counted from `held` because it is out of reach. */
  readonly census: Readonly<Record<Tier, number>>;
  readonly totalBlocks: number;
  readonly messagesIn: number;
  readonly messagesOut: number;
  /** Governance blocks found at runtime. Structurally impossible; always 0 in practice. */
  readonly diverted: number;
  readonly taggedIntent: number;
  readonly intentTaggedMessage: number | undefined;
  readonly retention: Readonly<Record<Tier, TierRetention>>;
}

const emptyCensus = (): Record<Tier, number> => ({
  governance: 0,
  episodic: 0,
  tool_state: 0,
  artifact_ref: 0,
  user_intent: 0,
});

/**
 * B-6: tag the leading user-intent turn.
 *
 * The *leading* turn only. The intent is what the agent was asked to do, and it
 * is the first thing a summary drops; the *latest* user turns are protected by a
 * different mechanism (the recency tail in ./recency.ts, which `compact` must
 * honour). Tagging every user turn would flood `user_intent`, which has the
 * largest byte cap in the policy and would then exempt the whole conversation
 * from Tier 0.
 *
 * `tool_result` blocks are excluded because Anthropic carries them in *user*
 * messages. Retagging a tool result as intent would both corrupt the routing and
 * hand it the 60k cap.
 */
export function tagLeadingUserIntent(
  messages: readonly NonGovernanceMessage[],
): { readonly messages: readonly NonGovernanceMessage[]; readonly tagged: number; readonly message: number | undefined } {
  const index = messages.findIndex(
    (m) => m.role === 'user' && m.content.some((b) => taggable(b)),
  );
  if (index === -1) return { messages, tagged: 0, message: undefined };

  const target = messages[index];
  if (target === undefined) return { messages, tagged: 0, message: undefined };

  let tagged = 0;
  const content = target.content.map((b) => {
    if (!taggable(b) || b.meta.tier === 'user_intent') return b;
    tagged += 1;
    return { ...b, meta: { ...b.meta, tier: 'user_intent' as const } };
  });

  if (tagged === 0) return { messages, tagged: 0, message: index };
  const out = [...messages];
  out[index] = { ...target, content };
  return { messages: out, tagged, message: index };
}

const taggable = (b: NonGovernanceBlock): boolean =>
  b.type !== 'tool_result' && b.type !== 'cache_control';

export interface TriageInput {
  readonly messages: readonly NonGovernanceMessage[];
  readonly held: readonly HeldBlock[];
}

export interface TriageOutput {
  readonly messages: readonly NonGovernanceMessage[];
  readonly held: readonly HeldBlock[];
  readonly report: TriageReport;
}

export function triageMessages(input: TriageInput): TriageOutput {
  const census = emptyCensus();
  let diverted = 0;
  let changed = false;
  const extraHeld: HeldBlock[] = [];

  const rebuilt: NonGovernanceMessage[] = [];
  for (const m of input.messages) {
    const content: NonGovernanceBlock[] = [];
    for (const b of m.content) {
      if (declaredTier(b) === 'governance') {
        extraHeld.push({ block: b, reason: 'governance' });
        diverted += 1;
        changed = true;
        continue;
      }
      content.push(b);
    }
    if (content.length === 0) {
      changed = true;
      continue;
    }
    if (content.length !== m.content.length) changed = true;
    rebuilt.push(content.length === m.content.length ? m : { ...m, content });
  }

  // Recount after triage so the census describes the state that leaves this
  // stage, which is the only one a caller can act on. Governance is counted from
  // `held` -- including anything this stage diverted -- because that is where
  // those blocks now live, and because `totalBlocks` is only a useful invariant
  // if it accounts for every block in the context.
  const messages = changed ? rebuilt : input.messages;
  for (const m of messages) for (const b of m.content) census[declaredTier(b)] += 1;
  census.governance = input.held.length + extraHeld.length;
  const totalBlocks = ALL_TIERS.reduce((n, t) => n + census[t], 0);

  const tagged = tagLeadingUserIntent(messages);
  if (tagged.tagged > 0) {
    census.episodic -= tagged.tagged;
    census.user_intent += tagged.tagged;
  }

  return {
    messages: tagged.messages,
    held: extraHeld.length === 0 ? input.held : [...input.held, ...extraHeld],
    report: {
      census,
      totalBlocks,
      messagesIn: input.messages.length,
      messagesOut: tagged.messages.length,
      diverted,
      taggedIntent: tagged.tagged,
      intentTaggedMessage: tagged.message,
      retention: TIER_RETENTION,
    },
  };
}

/**
 * Stage 3. Triage assigns each tier its own retention policy (the Compaction
 * Cliff fix), re-checks at runtime that no governance block is in scope, and
 * tags the leading user-intent turn. It drops nothing, by construction: a tier
 * that triage does not recognise still leaves with all of its blocks.
 *
 * On a steady-state context -- one that is already tagged and holds no stray
 * governance -- `triageMessages` hands back the very arrays it was given, so the
 * stage can return the input context untouched and the caller's `changed` check
 * can tell a real change from a re-scan. That check is worth having: this runs
 * on every turn, and a stage that always allocates makes "did anything change"
 * unanswerable without deep comparison.
 */
export const triageStage: Tier0Stage<TriageReport> = {
  name: 'triage',
  run: (ctx: LossyContext) => {
    const out = triageMessages({ messages: ctx.messages, held: ctx.held });
    const untouched = out.messages === ctx.messages && out.held === ctx.held;
    return {
      ctx: untouched ? ctx : { ...ctx, messages: out.messages, held: out.held },
      report: out.report,
    };
  },
};
