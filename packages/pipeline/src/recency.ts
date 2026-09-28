import type { Message, Role, TriggerPolicy } from '@strata-ctx/core-types';
import { estimateMessageTokens } from '@strata-ctx/core-types';

/**
 * B-6, second half: the recency tail.
 *
 * `TriggerPolicy.keepRecentTokens` (8192) is the recency tail that stays
 * verbatim, and `userMessageTailTokens` (20000) is a wider, separate budget for
 * the last *user* turns. Two budgets, not one, because they defend against two
 * different failures: the tail keeps the model anchored in what it is doing right
 * now, and the user budget defends against command-window loss, where the
 * instruction the agent was given has scrolled out and it re-reads or re-runs
 * something the user already corrected.
 *
 * ## Why this is a function and not a stage
 *
 * The tail is a *boundary*, and its consumer is `compact` (stage 5, WS-C), which
 * must not summarise anything inside it. Tier 0 has no such boundary to set:
 * truncating a 200kB log in the recency tail is the single largest win Tier 0
 * exists to deliver, and blocking it would be a self-inflicted wound. So the
 * boundary is computed here and exported for the compactor.
 *
 * ## Why it is recomputed rather than cached
 *
 * Stage 2 changes the token counts the boundary is computed from. A tail
 * computed before truncation is a boundary in the wrong place. That is why this
 * takes the messages and the policy and nothing else, and why it is called
 * immediately before the compaction decision rather than memoised at a stage.
 */

export interface RecencyTail {
  /** First message index protected by `keepRecentTokens`. */
  readonly protectedFromIndex: number;
  /** First message index of the user tail protected by `userMessageTailTokens`. */
  readonly userProtectedFromIndex: number;
  /** The whole context fits inside `keepRecentTokens`; nothing is evictable. */
  readonly entireContext: boolean;
  readonly keptTokens: number;
  readonly keptUserTokens: number;
  /** Contiguous suffix protected by `keepRecentTokens`. */
  readonly tailMessages: readonly number[];
  /** User messages protected by `userMessageTailTokens`, wherever they sit. */
  readonly tailUserMessages: readonly number[];
}

/** Sentinel for "the boundary is the whole transcript". */
const NONE = Number.MAX_SAFE_INTEGER;

/**
 * Walk backwards from the newest message, accumulating cost until the budget is
 * spent.
 *
 * The most recent message is always kept even if it alone exceeds the budget:
 * dropping the turn the agent is currently in is the worst available outcome, and
 * a cap that cannot be honoured is a fact to report, not a reason to delete the
 * present.
 */
export function recencyTail(
  messages: readonly Message[],
  trigger: Pick<TriggerPolicy, 'keepRecentTokens' | 'userMessageTailTokens'>,
): RecencyTail {
  const costs = messages.map((m) => estimateMessageTokens(m));

  let protectedFrom = NONE;
  let keptTokens = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (i !== messages.length - 1 && keptTokens + (costs[i] ?? 0) > trigger.keepRecentTokens) break;
    protectedFrom = i;
    keptTokens += costs[i] ?? 0;
  }

  // The newest user turn is kept whatever it costs, and *whether or not it is the
  // last message*: an agent whose final turn is a tool call is still executing an
  // instruction, and that instruction is the one thing command-window loss takes
  // first. The recency loop gets this for free because the last message is always
  // index `length - 1`; here the newest user message can be anywhere.
  let userProtectedFrom = NONE;
  let keptUserTokens = 0;
  let seenUser = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== 'user') continue;
    if (seenUser && keptUserTokens + (costs[i] ?? 0) > trigger.userMessageTailTokens) break;
    userProtectedFrom = i;
    keptUserTokens += costs[i] ?? 0;
    seenUser = true;
  }

  const tailMessages: number[] = [];
  for (let i = 0; i < messages.length; i += 1) if (i >= protectedFrom) tailMessages.push(i);
  const tailUserMessages: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === 'user' && i >= userProtectedFrom) tailUserMessages.push(i);
  }

  return {
    protectedFromIndex: messages.length === 0 ? 0 : protectedFrom,
    userProtectedFromIndex: messages.length === 0 ? 0 : userProtectedFrom,
    entireContext: messages.length > 0 && protectedFrom === 0,
    keptTokens,
    keptUserTokens,
    tailMessages,
    tailUserMessages,
  };
}

/**
 * Is message `index` inside either protected window? This is the predicate
 * `compact` must consult before it replaces an episodic block with a gist.
 *
 * The role is a parameter, not a lookup, and that is the whole point. The two
 * budgets protect different things: `keepRecentTokens` protects a contiguous
 * suffix, `userMessageTailTokens` protects a scattered set of *user* turns that
 * reach further back. Collapsing them into `index >= min(a, b)` -- which is what
 * this looked like at first -- silently protects every assistant turn in the
 * gap as well, handing `compact` a boundary it cannot explain and shrinking the
 * summarisable range for no reason.
 */
export const isTailProtected = (tail: RecencyTail, index: number, role: Role): boolean =>
  index >= tail.protectedFromIndex || (role === 'user' && index >= tail.userProtectedFromIndex);

/**
 * The first index that is protected: everything strictly before it may be
 * summarised without consulting the predicate per message.
 *
 * This is a *prefix* boundary and deliberately not the whole answer. The user
 * budget can protect a turn that sits below the recency tail, so the range from
 * here to the end is not uniformly protected -- `compact` walks it with
 * `isTailProtected`. What this gives it is the point past which it has to ask.
 */
export function compactableFrom(tail: RecencyTail, messageCount: number): number {
  let boundary = tail.protectedFromIndex;
  for (const i of tail.tailUserMessages) {
    if (i < boundary) boundary = i;
  }
  return Math.min(boundary, messageCount);
}
