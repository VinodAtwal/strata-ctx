import type {
  ArtifactRef,
  BlockMeta,
  ContentBlock,
  ContextState,
  Message,
  Tier,
} from './context.js';
import type { Gist } from './gist.js';
import type { RunId, TaskId } from './ids.js';
import { sha256 } from './hash.js';
import type { StrataPolicy } from './policy.js';
import { pinSetText } from './policy.js';

/**
 * The security core: making it impossible to hand a lossy operator something it
 * is not allowed to destroy. See docs/architecture.md §3 and §7.
 *
 * The plan says "prefer making the bug unrepresentable", and a closed union
 * member is not enough on its own -- `'governance' in Tier` still lets a lossy
 * stage be *called* with a governance block. So the narrowing happens at the
 * type boundary: a lossy stage accepts `NonGovernanceMessage[]`, and the only
 * way to obtain one is `partitionForLossy`, which lifts governance blocks into a
 * separate `held` bucket that no lossy stage can reach.
 */

export type NonGovernanceTier = Exclude<Tier, 'governance'>;

export type NonGovernanceBlock = Omit<ContentBlock, 'meta'> & {
  readonly meta: Omit<BlockMeta, 'tier'> & { readonly tier: NonGovernanceTier };
};

export type NonGovernanceMessage = Omit<Message, 'content'> & {
  readonly content: readonly NonGovernanceBlock[];
};

export const LOSSY_CONTEXT: unique symbol = Symbol('strata.LossyContext');

/**
 * A block withheld from the lossy path. Today the only reason is governance,
 * but the bucket is a sealed list so that adding a second reason later is an
 * additive change rather than a redesign.
 */
export type HeldReason = 'governance';

export interface HeldBlock {
  readonly block: ContentBlock;
  readonly reason: HeldReason;
}

export interface LossyContext {
  readonly [LOSSY_CONTEXT]: true;
  readonly runId: RunId;
  readonly turn: number;
  readonly taskId: TaskId | undefined;
  readonly messages: readonly NonGovernanceMessage[];
  readonly gists: readonly Gist[];
  readonly artifacts: readonly ArtifactRef[];
  readonly policy: StrataPolicy;
  /** Out of reach of every lossy stage by construction. */
  readonly held: readonly HeldBlock[];
  readonly tokenEstimate: number;
}

/** Stages that can lose information. Order is fixed; see docs/architecture.md §4. */
export type LossyStageName = 'dedupe' | 'truncate' | 'triage' | 'compact' | 'compress';

export interface LossyStage {
  readonly name: LossyStageName;
  run(ctx: LossyContext): LossyContext;
}

/** Stages that are lossless by construction. */
export type TotalStageName = 'pin' | 'serialize';

export interface TotalStage {
  readonly name: TotalStageName;
  run(state: ContextState): ContextState;
}

export function isLossyContext(v: unknown): v is LossyContext {
  return typeof v === 'object' && v !== null && LOSSY_CONTEXT in v;
}

const isGovernance = (b: ContentBlock): boolean => b.meta.tier === 'governance';

/**
 * The single narrowing point. Lifts governance blocks, and the head of the
 * cached prefix, into `held`; everything left is structurally incapable of
 * being governance.
 */
export function partitionForLossy(state: ContextState, policy: StrataPolicy): LossyContext {
  const held: HeldBlock[] = [];
  const messages: NonGovernanceMessage[] = [];

  for (const msg of state.messages) {
    const blocks: NonGovernanceBlock[] = [];
    let sawGovernance = false;

    for (const block of msg.content) {
      if (isGovernance(block)) {
        held.push({ block, reason: 'governance' });
        sawGovernance = true;
        continue;
      }
      blocks.push(block as NonGovernanceBlock);
    }

    if (sawGovernance && blocks.length === 0) continue;
    messages.push({ ...msg, content: blocks });
  }

  return {
    [LOSSY_CONTEXT]: true,
    runId: state.runId,
    turn: state.turn,
    taskId: state.taskId,
    messages,
    gists: state.gists,
    artifacts: state.artifacts,
    policy,
    held,
    tokenEstimate: state.tokenEstimate,
  };
}

/**
 * Runtime belt-and-braces for the property suite (D-9) and for any stage that
 * arrives from outside the type system. Cheap, and it catches a `as` cast
 * during development rather than in a user's context window.
 */
export function assertNoGovernance(messages: readonly Message[]): void {
  for (const msg of messages) {
    for (const block of msg.content) {
      if (isGovernance(block)) {
        throw new Error(
          `governance block reached a lossy stage (sha256=${block.meta.sha256.slice(0, 12)})`,
        );
      }
    }
  }
}

export interface PinApplication {
  readonly state: ContextState;
  readonly expected: readonly string[];
  /** Any governance blocks already in the inbound context, verbatim. */
  readonly inboundGovernance: readonly string[];
}

/**
 * Stage 4: the pin buffer becomes actual context.
 *
 * Note the two halves. `applyPins` sets the buffer field; this materialises it as
 * real governance-tier blocks, because a buffer nothing reads is a comment. They
 * are one function so that "the buffer says the constraint is pinned" and "the
 * constraint is in the request" cannot drift apart -- which they did, once, and
 * the dev smoke test caught it.
 *
 * Replace, never merge: any governance block already in the context is stripped
 * and the policy buffer is prepended fresh. A gist or summary that *appends* to
 * the pin set could inject text that reads like policy; overwriting makes that
 * structurally impossible.
 */
export function enforcePins(state: ContextState, policy: StrataPolicy): PinApplication {
  const expected = Object.freeze(pinSetText(policy));
  const inboundGovernance = Object.freeze(collectGovernanceText(state));

  const messages = state.messages.filter((m) => !m.content.some(isGovernance));
  const blocks: ContentBlock[] = expected.map((text) => ({
    type: 'text',
    text,
    meta: {
      origin: 'system',
      sha256: sha256(text),
      tier: 'governance',
      bytes: text.length,
      // Cacheable: a constraint that re-invalidates the prefix every turn is a
      // tax paid on every request, and the whole point of pinning is stability.
      cacheable: true,
    },
  }));

  return {
    state: {
      ...state,
      messages: [{ role: 'system', content: blocks, ts: state.messages[0]?.ts ?? 0 }, ...messages],
      pinned: expected,
    },
    expected,
    inboundGovernance,
  };
}

/** Verbatim text of every governance block currently in the context. */
export function collectGovernanceText(state: ContextState): string[] {
  return state.messages.flatMap((m) =>
    m.content.filter(isGovernance).map((b) => b.text ?? ''),
  );
}

/**
 * Checks the pin set we sent last turn against what arrived this turn.
 *
 * Scoped deliberately: it is meaningless on turn 1 (nothing was sent yet) and
 * it is the only version of the check that is not trivially satisfiable. A
 * client that does not carry our buffer cannot be asked to return it, so the
 * comparison has to be against our own record.
 */
export function pinDrift(
  lastSent: readonly string[],
  inboundGovernance: readonly string[],
): PinIntegrity {
  return verifyPinIntegrity(lastSent, inboundGovernance);
}

export type PinDefect = 'missing' | 'extra' | 'reordered';

export interface PinIntegrity {
  readonly ok: boolean;
  readonly defects: readonly { readonly kind: PinDefect; readonly text: string }[];
  readonly policyHash: string;
}

/**
 * Step 4c of the compaction transaction: the security gate. A mismatch aborts
 * the transaction and keeps the transcript -- fail toward more context.
 *
 * `extra` is reported separately from `missing` because it is a different
 * event: something wrote text into the pin buffer that policy never declared.
 */
export function verifyPinIntegrity(expected: readonly string[], actual: readonly string[]): PinIntegrity {
  const defects: { kind: PinDefect; text: string }[] = [];
  const exp = [...expected];
  const act = [...actual];

  for (const text of exp) if (!act.includes(text)) defects.push({ kind: 'missing', text });
  for (const text of act) if (!exp.includes(text)) defects.push({ kind: 'extra', text });

  const sameMembers =
    defects.length === 0 &&
    exp.length === act.length &&
    exp.every((t, i) => act[i] === t);
  if (!sameMembers && defects.length === 0) {
    for (let i = 0; i < Math.max(exp.length, act.length); i += 1) {
      if (exp[i] !== act[i]) defects.push({ kind: 'reordered', text: act[i] ?? exp[i] ?? '' });
    }
  }

  return {
    ok: defects.length === 0,
    defects,
    policyHash: sha256(expected.join('\n')),
  };
};

/**
 * Reassemble a full context from a lossy context. Held blocks are restored
 * first, ahead of everything the lossy path produced, because that is also the
 * position they must occupy in the outbound request.
 */
export function restoreHeld(ctx: LossyContext, state: ContextState): ContextState {
  const prefix = ctx.held.filter((h) => h.reason === 'governance').map((h) => h.block);
  if (prefix.length === 0) return state;
  const [first, ...rest] = state.messages;
  if (first === undefined) {
    return {
      ...state,
      messages: [{ role: 'system', content: prefix, ts: 0 }],
    };
  }
  return {
    ...state,
    messages: [{ ...first, content: [...prefix, ...first.content] }, ...rest],
  };
}

/**
 * A stage that reorders or drops cacheable blocks silently invalidates the
 * provider's prompt cache, which destroys the unit economics of the whole
 * system (decisions R4). This is the check for that, run per request in dev and
 * asserted in the property suite.
 */
export function assertPrefixPreserved(
  before: readonly Message[],
  after: readonly Message[],
): void {
  const cacheableOrder = (ms: readonly Message[]): string[] =>
    ms
      .flatMap((m) => m.content)
      .filter((b) => b.meta.cacheable)
      .map((b) => b.meta.sha256);

  const was = cacheableOrder(before);
  const now = cacheableOrder(after);
  const stillPresent = was.filter((h) => now.includes(h));
  const iWas = stillPresent.map((h) => was.indexOf(h));
  const iNow = stillPresent.map((h) => now.indexOf(h));
  const ordered = iWas.every((v, i) => v === iNow[i]);
  if (!ordered) {
    throw new Error('stage reordered blocks inside the cached prefix');
  }
}
