import type {
  Gist,
  LossyContext,
  Message,
  NonGovernanceMessage,
  NonGovernanceTier,
  PinIntegrity,
  StrataPolicy,
  Tier,
} from '@strata-ctx/core-types';
import { assertNoGovernance, isLossyContext, pinSetText, verifyPinIntegrity } from '@strata-ctx/core-types';

/**
 * D-8: the runtime half of "governance is unrepresentable on a lossy stage".
 *
 * The static half lives in core-types and is load-bearing: a lossy stage is
 * typed `run(ctx: LossyContext): LossyContext`, `LossyContext.messages` is
 * `readonly NonGovernanceMessage[]`, and `NonGovernanceTier` has `governance`
 * removed. A lossy stage cannot be *handed* a governance block, and it cannot
 * put one into the message list it returns. `NonGovernanceTier` narrowing to
 * include `'governance'` would make every lossy call site in the repo a
 * compile error, which is the tripwire this module's tests also sit on.
 *
 * This file does three things the frozen contract does not, and does not
 * reimplement anything it does.
 *
 * ## 1. It is honest about the channels that remain
 *
 * `assertNoGovernance(ctx.messages)` in core-types walks one field. There are
 * three places a lossy stage can reach governance text, and only one of them is
 * invisible:
 *
 * | Channel | Reachable by a lossy stage | Why |
 * |---|---|---|
 * | `messages` | no, statically and at runtime | the guarantee; must always be empty |
 * | `held` | **yes, for reading** | `LossyStage.run` receives the whole `LossyContext`, and `held` is a field on it |
 * | `gists[].constraints` | **yes, for reading** | the step-4c byte-equality target |
 *
 * `held` is the one that is easy to get wrong in prose. It is true that a
 * lossy stage cannot *write* a held block into the outbound request -- the
 * output type forbids it. It is not true that a lossy stage cannot read the
 * pin text, because the pin text is right there. Any document that claims
 * "lossy stages never see governance" is claiming something stronger than the
 * types support, and this module exists to make the difference checkable
 * instead of arguable.
 *
 * ## 2. It closes the window between step 4c and step 7
 *
 * The transaction validates a gist at step 4c and evicts the raw turns at step
 * 7. Between those two steps the validated gist is *resident in the context*,
 * where `compact` and `compress` -- both lossy stages, both downstream of the
 * gate -- can reach it and rewrite `constraints`. A stage that edits
 * `gist.constraints` after the gate has already passed turns the check from
 * "a boolean that aborts a transaction" back into "a comparison that happened
 * once". `assertGistConstraintsIntact` re-runs step 4c against every resident
 * gist, immediately before the eviction, for exactly that reason. It is the
 * same `verifyPinIntegrity` call, deliberately: a second implementation of "are
 * the pins intact" would be a second thing to get wrong.
 *
 * ## 3. It is usable on values that arrived by cast
 *
 * Every lossy stage that comes from outside this repository is a value that was
 * not produced by `partitionForLossy`, so the runtime checks are not
 * redundant belt-and-braces -- they are the only check there is.
 */

export function isNonGovernanceTier(tier: Tier): tier is NonGovernanceTier {
  return tier !== 'governance';
}

/**
 * Sound despite checking only `tier`: `NonGovernanceMessage` differs from
 * `Message` solely in the element type of `content`, and a `ContentBlock` whose
 * `meta.tier` is a `NonGovernanceTier` *is* a `NonGovernanceBlock`. There is no
 * other field for the predicate to get wrong.
 */
export function isNonGovernanceMessage(message: Message): message is NonGovernanceMessage {
  return message.content.every((b) => isNonGovernanceTier(b.meta.tier));
}

/** True when any block in a lossy message list claims the governance tier. */
export function containsGovernance(messages: readonly Message[]): boolean {
  return messages.some((m) => m.content.some((b) => !isNonGovernanceTier(b.meta.tier)));
}

export type GovernanceChannel = 'messages' | 'gists' | 'held';

export interface GovernanceExposure {
  readonly channel: GovernanceChannel;
  /** Index within the channel's own container, so a report points at a gist. */
  readonly index: number;
  /**
   * Byte lengths rather than text. Everything on this path is
   * attacker-controlled -- `gists[].constraints` and the governance message
   * both arrive from outside the trust boundary -- and a record that carries the
   * text is a record an attacker can put newlines into.
   */
  readonly byteLengths: readonly number[];
  /**
   * True for the two channels a lossy stage is *allowed* to read. `messages`
   * is never by design: a non-empty result is a bug or a forged value, and
   * `assertLossyContextSafe` throws on it.
   */
  readonly byDesign: boolean;
}

export interface GistIntegrity {
  readonly index: number;
  readonly taskId: string;
  readonly ok: boolean;
  readonly integrity: PinIntegrity;
}

export interface LossyGovernanceAudit {
  /** Governance blocks in the lossy message list. Must be empty. */
  readonly inMessages: readonly GovernanceExposure[];
  /** Pin text readable from `gists[].constraints`. The step-4c target. */
  readonly inGists: readonly GovernanceExposure[];
  /** Pin text readable from `held`. Never writable back into `messages`. */
  readonly inHeld: readonly GovernanceExposure[];
  /** Step 4c re-run against every resident gist. */
  readonly gistIntegrity: readonly GistIntegrity[];
  readonly ok: boolean;
}

const exposure = (
  channel: GovernanceChannel,
  index: number,
  texts: readonly string[],
  byDesign: boolean,
): GovernanceExposure => ({
  channel,
  index,
  byteLengths: Object.freeze(texts.map((t) => t.length)),
  byDesign,
});

/**
 * Step 4c, re-run. The same `verifyPinIntegrity` the transaction gate uses, so
 * there is no second definition of "the constraints are intact" to drift.
 */
export function gistIntegrityFor(gist: Gist, policy: StrataPolicy, index = 0): GistIntegrity {
  const integrity = verifyPinIntegrity(pinSetText(policy), gist.constraints);
  return { index, taskId: gist.task_id, ok: integrity.ok, integrity };
}

/**
 * Walk every channel of a lossy context and report what a lossy stage can
 * reach. Intended to be logged once per compaction alongside the transaction
 * telemetry: it is the only place the "unrepresentable" claim becomes a number
 * rather than a proof sketch.
 */
export function auditLossyContext(ctx: LossyContext, policy: StrataPolicy): LossyGovernanceAudit {
  const inMessages: GovernanceExposure[] = [];
  for (const [i, message] of ctx.messages.entries()) {
    const governance = message.content
      .filter((b) => !isNonGovernanceTier(b.meta.tier))
      .map((b) => b.text ?? '');
    if (governance.length > 0) inMessages.push(exposure('messages', i, governance, false));
  }

  const inGists = ctx.gists
    .map((g, i) => ({ g, i }))
    .filter(({ g }) => g.constraints.length > 0)
    .map(({ g, i }) => exposure('gists', i, g.constraints, true));

  const inHeld = ctx.held
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => (h.block.text ?? '') !== '')
    .map(({ h, i }) => exposure('held', i, [h.block.text ?? ''], true));

  const gistIntegrity = ctx.gists.map((g, i) => gistIntegrityFor(g, policy, i));

  return {
    inMessages: Object.freeze(inMessages),
    inGists: Object.freeze(inGists),
    inHeld: Object.freeze(inHeld),
    gistIntegrity: Object.freeze(gistIntegrity),
    ok: inMessages.length === 0 && gistIntegrity.every((g) => g.ok),
  };
}

/**
 * The write-path guard. Delegates to the frozen `assertNoGovernance` rather
 * than duplicating the throw, so a lossy stage that trips it produces the same
 * message whoever catches it.
 */
export function assertLossyContextSafe(ctx: LossyContext, policy: StrataPolicy): void {
  if (!isLossyContext(ctx)) {
    throw new Error('not a LossyContext: a value that skipped partitionForLossy');
  }
  assertNoGovernance(ctx.messages);
  for (const gist of auditLossyContext(ctx, policy).gistIntegrity) {
    if (gist.ok) continue;
    // Refusing here is the whole point of re-running the gate: a gist whose
    // constraint set no longer byte-equals policy must not reach step 7.
    throw new Error(
      `gist ${JSON.stringify(gist.taskId)} no longer byte-equals the pinned set ` +
        `(${gist.integrity.defects.length} defect(s)); refusing to evict the raw transcript`,
    );
  }
}

/** The one assertion that belongs to a *result*, not a stage. See the note above. */
export function assertGistConstraintsIntact(ctx: LossyContext, policy: StrataPolicy): void {
  for (const gist of ctx.gists) {
    if (!gistIntegrityFor(gist, policy).ok) {
      throw new Error(`gist ${JSON.stringify(gist.task_id)} does not carry the pinned constraint set`);
    }
  }
}
