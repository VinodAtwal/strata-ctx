import type { BlockSubject, NonGovernanceBlock, NonGovernanceMessage } from '@strata-ctx/core-types';
import { isHighSeverity } from '@strata-ctx/core-types';
import type { Tier0Stage } from './stage.js';

/**
 * B-1. Dedupe: drop blocks superseded by a newer version of the same subject.
 *
 * Why it runs first (docs/architecture.md §4): dedupe is free, and truncating a
 * block you are about to delete is wasted work. Everything downstream sees
 * strictly fewer bytes.
 *
 * ## The ordering question
 *
 * The dedupe key is `subject.ref`. `subject.version` is an opaque string with no
 * ordering we are entitled to invent -- it may be a git sha, an mtime, a content
 * hash or a monotonic counter, depending on which tool produced it. So
 * *transcript position* is the version ordering: a later block for the same
 * `(kind, ref)` is a later read, and the earlier one is stale. That is also what
 * an agent transcript means -- read, edit, read again.
 *
 * The full `(kind, ref, version)` key is still computed, and it labels a drop as
 * an exact `duplicate` (same version) rather than a `supersession` (a different
 * version). The two have different causes, and telemetry should be able to tell
 * them apart.
 *
 * ## Two exemptions
 *
 * - No `subject` means no identity, so no dedupe. This is not a nicety: it is
 *   what keeps the leading user-intent turn safe, because a user message carries
 *   no subject and the intent statement is the one thing compaction must never
 *   lose.
 * - Inferred supersession never eats a high-severity block. A `supersededBy` set
 *   by the producer is honoured unconditionally, because that is a fact and not
 *   a guess, but a *later* read of the same ref does not reproduce an error only
 *   the earlier read contained. Release gates G1/G3 rest on severity surviving
 *   the whole pipeline, and dedupe is a stage in it. An exact `duplicate` is not
 *   exempt: the surviving copy carries the same severity, so there is no evidence
 *   to lose -- which is a claim about one block, and across a tool pair it does
 *   not hold, since only the result half is severe. The pairing pass below
 *   re-applies the rule to the pair.
 *
 * ## The exemption is sticky across turns, and that is deliberate
 *
 * `meta.severity` does not record where it came from, so on turn 2 this stage
 * cannot tell a producer's `is_error: true` from a label B-4's regex wrote on
 * turn 1 -- and a block the classifier once called error/fatal keeps its
 * exemption for the rest of the run. The effect is that dedupe's output depends
 * on how many times a context has been through the pipeline. That is
 * fail-safe: it retains a stale copy the pipeline would otherwise have dropped,
 * which is the direction the gates care about, and the reason the exemption
 * exists ("a later read does not reproduce an error") is exactly as true of an
 * inferred label as of a declared one. Fixing it properly needs a provenance
 * field on `BlockMeta`, which is a contract change (see the B-4 handoff); until
 * then this stage deliberately over-retains rather than guesses.
 *
 * ## The pairing invariant
 *
 * Anthropic rejects a request in which a `tool_use` id has no `tool_result`
 * carrying that id, and one whose `tool_result` names a `tool_use` that is not
 * there. So: **for every `tool_use`/`tool_result` pair that was complete in the
 * input, the output contains both halves or neither.** Dedupe is the only Tier 0
 * stage that deletes a block outright, so it is the only place a pair can be
 * broken between ingress and egress.
 *
 * A pair is one unit, and the two halves are dropped together or not at all --
 * see `enforcePairAtomicity`. The alternative, refusing to drop any paired
 * `tool_use`, was rejected: a tool result is the large half of a tool pair, so
 * keeping the call to save the pairing saves nothing while leaving the
 * transcript two identical reads deep. Co-dropping is the only option that
 * both frees the bytes and keeps the request legal.
 */

/**
 * Why a block left the transcript. `retained_severity` is not a drop: it is
 * carried in `byReason` so the counter set is closed and a telemetry dashboard
 * never has to special-case a missing key. Nothing is ever counted under it --
 * a block that severity saved is counted in `retainedHighSeverity` and never
 * appears in `drops` -- so it is structurally always zero.
 */
export type DedupeReason = 'superseded_by_flag' | 'duplicate' | 'superseded' | 'retained_severity';

export interface DedupeDrop {
  readonly sha256: string;
  readonly ref: string;
  readonly version: string | undefined;
  readonly reason: DedupeReason;
  /** Version, or content digest, of the block that won. */
  readonly supersededBy: string;
}

export interface DedupeReport {
  readonly dropped: number;
  readonly byReason: Readonly<Record<DedupeReason, number>>;
  /**
   * Blocks a later read would have superseded, kept because they are error/fatal.
   *
   * Two kinds of hold-back are *not* in here, and both are worth naming because
   * they make `dropped` smaller than the identity arithmetic alone suggests: a
   * block refused a drop because a paired `tool_use`/`tool_result` half is
   * ambiguous, and a `tool_use` kept because its result is severe. Both are
   * visible only as the absence of a drop. There is no field for them and adding
   * one is a telemetry-surface change (the severity log reads this report), not a
   * dedupe-local one.
   */
  readonly retainedHighSeverity: number;
  /** Blocks with no subject, which by construction can never be deduped. */
  readonly untiered: number;
  /** Messages folded into a neighbour once a drop made them adjacent. */
  readonly mergedMessages: number;
  readonly drops: readonly DedupeDrop[];
}

/**
 * Blocks grouped by the `tool_use` id they correlate on, in transcript order.
 *
 * `ContentBlock.id` is the correlation id (`core-types/src/context.ts:62`), so it
 * -- not `meta.subject` -- is what says which `tool_result` answers which
 * `tool_use`. The adapters key a result's *subject* on that id and a call's
 * subject on what the call actually asked for, so the two halves of a pair have
 * deliberately different subjects and only `id` pairs them.
 */
interface PairIndex {
  readonly uses: ReadonlyMap<string, number[]>;
  readonly results: ReadonlyMap<string, number[]>;
}

const pairIndex = (flat: readonly FlatBlock[]): PairIndex => {
  const uses = new Map<string, number[]>();
  const results = new Map<string, number[]>();
  for (let i = 0; i < flat.length; i += 1) {
    const block = flat[i]?.value;
    if (block === undefined) continue;
    const id = block.id;
    // An absent id is not a correlation: a block that never had one cannot pair
    // with anything, so there is nothing to keep it for.
    if (id === undefined || id === '') continue;
    const table = block.type === 'tool_use' ? uses : block.type === 'tool_result' ? results : undefined;
    if (table === undefined) continue;
    const at = table.get(id);
    if (at === undefined) table.set(id, [i]);
    else at.push(i);
  }
  return { uses, results };
};

export const emptyDedupeReasons = (): Record<DedupeReason, number> => ({
  superseded_by_flag: 0,
  duplicate: 0,
  superseded: 0,
  retained_severity: 0,
});

/** Identity key: what "the same thing" means. */
const identityKey = (s: BlockSubject): string => `${s.kind}\u0000${s.ref}`;

/** Full key per the docs: identity plus version. */
const versionKey = (s: BlockSubject): string => `${identityKey(s)}\u0000${s.version ?? ''}`;

/** How a winner is referred to in a `supersededBy` field. */
const stampOf = (b: NonGovernanceBlock): string => b.meta.subject?.version ?? b.meta.sha256;

interface FlatBlock {
  readonly value: NonGovernanceBlock;
}

const flatten = (messages: readonly NonGovernanceMessage[]): FlatBlock[] =>
  messages.flatMap((m) => m.content.map((value) => ({ value })));

interface Decision {
  readonly drop: DedupeDrop | undefined;
  readonly retainedHighSeverity: boolean;
}

/** One backward pass: the winner of a key is simply the last block carrying it. */
function decide(
  flat: readonly FlatBlock[],
  lastIndexByIdentity: ReadonlyMap<string, number>,
  i: number,
): Decision {
  const entry = flat[i];
  if (entry === undefined) return { drop: undefined, retainedHighSeverity: false };
  const block = entry.value;
  const subject = block.meta.subject;

  // A block with no subject is never deduped. See the note above.
  if (subject === undefined) return { drop: undefined, retainedHighSeverity: false };

  if (block.meta.supersededBy !== undefined) {
    // Severity outranks a producer flag. A newer read of a path makes an
    // earlier one less true, which is why the flag exists -- but an error/fatal
    // block is the record that the earlier read *failed*, and that fact does not
    // expire when the file is later read successfully. Dropping it here is how an
    // ENOENT disappeared: the flag rule never consulted severity, and
    // `enforcePairAtomicity` then co-dropped the call that would have explained
    // it. `retainedHighSeverity: true` keeps it out of `drops` and counts it.
    if (isHighSeverity(block)) return { drop: undefined, retainedHighSeverity: true };
    return {
      drop: {
        sha256: block.meta.sha256,
        ref: subject.ref,
        version: subject.version,
        reason: 'superseded_by_flag',
        supersededBy: block.meta.supersededBy,
      },
      retainedHighSeverity: false,
    };
  }

  const last = lastIndexByIdentity.get(identityKey(subject));
  if (last === undefined || last <= i) return { drop: undefined, retainedHighSeverity: false };
  const winner = flat[last]?.value;
  if (winner === undefined) return { drop: undefined, retainedHighSeverity: false };

  const winnerSubject = winner.meta.subject ?? subject;
  const sameVersion = versionKey(subject) === versionKey(winnerSubject);

  // Severity retention covers *supersession*, not duplication. A later version of
  // a file makes an earlier one less true, so an error/fatal block that has been
  // superseded is the one case where keeping the stale copy could mislead. An
  // exact duplicate adds no fact at all: the surviving copy carries the same
  // severity, so dropping the twin costs the transcript nothing and the gate is
  // still satisfied.
  //
  // "The surviving copy carries the same severity" is a claim about one block, so
  // it does not hold across a tool pair: the call and its result are separate
  // blocks and only one of them is severe. `enforcePairAtomicity` re-applies this
  // rule to the pair, and refuses the drop when the severe half has no equally
  // severe replacement.
  if (isHighSeverity(block) && (!sameVersion || !isHighSeverity(winner))) {
    return { drop: undefined, retainedHighSeverity: true };
  }

  return {
    drop: {
      sha256: block.meta.sha256,
      ref: subject.ref,
      version: subject.version,
      reason: sameVersion ? 'duplicate' : 'superseded',
      supersededBy: stampOf(winner),
    },
    retainedHighSeverity: false,
  };
}

/**
 * What the pairing pass changed, and what it cost.
 *
 * `coDrops` is keyed by position because it is merged into `dropAt`, which is.
 * `retainedHighSeverity` counts only the error/fatal blocks themselves: a
 * `tool_use` kept alive because its result is severe was saved by pair
 * atomicity, not by the severity exemption, and counting it here would let
 * `retainedHighSeverity` exceed the number of severe blocks in the transcript.
 */
interface PairingOutcome {
  readonly coDrops: ReadonlyMap<number, DedupeDrop>;
  readonly retainedHighSeverity: number;
}

/**
 * Make a `tool_use` and the `tool_result`s answering it one drop unit.
 *
 * Three resolutions, in the order they are tried:
 *
 * 1. **No counterpart in the input.** Nothing can be orphaned, so the ordinary
 *    decision stands. This is the pending-call-at-the-tail-of-a-turn case, and
 *    it is also why a bare `tool_result` with no call is still deduped on its
 *    own subject as before.
 * 2. **The id is ambiguous** -- more than one call, or more than one result,
 *    shares it. Then we cannot prove which half answers which, and Gemini is the
 *    standing case: `functionResponse` has no id (`gemini-adapter.ts:96`) so
 *    correlation is by name, and two calls to the same function in one turn are
 *    indistinguishable. Refuse the drop. Keeping a redundant call is the
 *    recoverable direction; deleting the wrong half of a pair is not.
 * 3. **Co-drop**, unless the counterpart is error/fatal and no equally severe
 *    counterpart survives. That is the severity guarantee
 *    (`decide`, above) applied to the pair rather than to the single block, and
 *    it is what keeps an ENOENT alive when the same path is later read
 *    successfully.
 */
function enforcePairAtomicity(
  flat: readonly FlatBlock[],
  dropAt: Set<number>,
  lastIndexByIdentity: ReadonlyMap<string, number>,
): PairingOutcome {
  const { uses, results } = pairIndex(flat);
  const coDrops = new Map<number, DedupeDrop>();
  const retainedHighSeverity = new Set<number>();
  /** Whether this pass is deleting the block at a position, for `survivingTwin`. */
  const leaving = (index: number): boolean => dropAt.has(index) || coDrops.has(index);

  for (let i = 0; i < flat.length; i += 1) {
    if (!dropAt.has(i)) continue;
    const block = flat[i]?.value;
    if (block === undefined) continue;
    const id = block.id;
    if (id === undefined || id === '') continue;
    const own = block.type === 'tool_use' ? uses : block.type === 'tool_result' ? results : undefined;
    const other = block.type === 'tool_use' ? results : block.type === 'tool_result' ? uses : undefined;
    if (own === undefined || other === undefined) continue;

    const counterparts = other.get(id);
    if (counterparts === undefined || counterparts.length === 0) continue;
    const ownCount = own.get(id)?.length ?? 0;
    // Ambiguous: retract rather than pick a half. See case 2 in the note above.
    if (counterparts.length > 1 || ownCount > 1) {
      dropAt.delete(i);
      continue;
    }

    const partnerAt = counterparts[0];
    if (partnerAt === undefined) continue;
    // The other half is already leaving: the pair goes atomically either way.
    if (dropAt.has(partnerAt) || coDrops.has(partnerAt)) continue;

    const partner = flat[partnerAt]?.value;
    if (partner === undefined) continue;

    // The surviving counterpart of the partner's kind: the answer to the call
    // that won. Without it the byte comparison below has nothing to compare
    // against, which is reported as `superseded` rather than guessed at.
    const survivor = survivingTwin(flat, block, lastIndexByIdentity, other, partnerAt, leaving);

    // Case 3 applies to *both* halves, not only to the partner. The severe half
    // is frequently `block` itself: an error/fatal `tool_result` carrying a
    // producer flag, positioned before its own call. A guard that asked only
    // about the partner therefore examined the benign half, found nothing wrong,
    // and co-dropped the severe one together with it. Retract both halves, and
    // count only the severe one -- the benign call was saved by the pair, not by
    // the severity exemption.
    const severe = isHighSeverity(block) ? i : isHighSeverity(partner) ? partnerAt : undefined;
    if (severe !== undefined && (survivor === undefined || !isHighSeverity(survivor))) {
      dropAt.delete(i);
      dropAt.delete(partnerAt);
      retainedHighSeverity.add(severe);
      continue;
    }

    coDrops.set(partnerAt, coDropOf(partner, survivor, block));
    dropAt.add(partnerAt);
  }

  return { coDrops, retainedHighSeverity: retainedHighSeverity.size };
}

/**
 * The block of `table`'s kind that answers the call which beat `block`, so a
 * co-dropped half can be compared against the copy that stayed.
 *
 * Two hops: the identity winner of `block` is the surviving call, and its id
 * names the block in `table` that answers it. `table` is the *other* half's kind,
 * not `block`'s own, because the question is always "what replaces the partner".
 * Returns `undefined` when either hop is missing -- a winner with no counterpart,
 * or a winner this stage is also dropping -- rather than substituting a
 * different block, because a comparison against the wrong block would label a
 * drop `duplicate` when it is not one.
 */
function survivingTwin(
  flat: readonly FlatBlock[],
  block: NonGovernanceBlock,
  lastIndexByIdentity: ReadonlyMap<string, number>,
  table: ReadonlyMap<string, number[]>,
  excluding: number,
  leaving: (index: number) => boolean,
): NonGovernanceBlock | undefined {
  const subject = block.meta.subject;
  if (subject === undefined) return undefined;
  const winnerIndex = lastIndexByIdentity.get(identityKey(subject));
  if (winnerIndex === undefined) return undefined;
  const winner = flat[winnerIndex]?.value;
  if (winner === undefined) return undefined;
  const twinIndex = winner.id === undefined ? undefined : table.get(winner.id)?.[0];
  if (twinIndex === undefined) return undefined;
  // The twin cannot stand in for itself. `winner` is usually `block`, so the
  // twin this walk finds is `excluding` -- the very block the severity check is
  // about. Returning it made `isHighSeverity(survivor)` confirm an error/fatal
  // block against itself, so the guard passed and the block was deleted along
  // with its call. That is how an ENOENT result disappeared from a transcript
  // whose call had been superseded by a producer flag.
  if (twinIndex === excluding) return undefined;
  // A twin this pass is also deleting is not a surviving replacement either,
  // which is the second case the note above promises.
  if (leaving(twinIndex)) return undefined;
  return flat[twinIndex]?.value;
}

/**
 * The `DedupeDrop` for a block that leaves because its partner left.
 *
 * The label is **derived, not inherited**, because the two questions have
 * different answers in exactly the case that matters: a file re-read between two
 * identical calls means the two results differ, so the result left as
 * `superseded` while the call that caused it left as a `duplicate`. Reporting
 * the decided half's reason for both would put `duplicate` on a block whose
 * bytes were not duplicated -- the label is the only record an operator has of
 * why a block vanished, so it has to be true.
 *
 * `superseded_by_flag` never propagates to a half nobody flagged: the producer
 * stamped a version on one block, and the other half's content is a separate
 * question this stage can only answer by comparing it with the survivor.
 */
function coDropOf(
  dropped: NonGovernanceBlock,
  survivor: NonGovernanceBlock | undefined,
  decided: NonGovernanceBlock,
): DedupeDrop {
  const sameContent = survivor !== undefined && dropped.meta.sha256 === survivor.meta.sha256;
  const reason: DedupeReason =
    sameContent && decided.meta.supersededBy === undefined ? 'duplicate' : 'superseded';
  return {
    sha256: dropped.meta.sha256,
    ref: dropped.meta.subject?.ref ?? dropped.id ?? '',
    version: dropped.meta.subject?.version,
    reason,
    supersededBy: survivor === undefined ? stampOf(decided) : stampOf(survivor),
  };
}

/**
 * Drop every block whose subject has been read again, and rebuild the messages.
 *
 * ## Why messages are merged afterwards
 *
 * Anthropic carries `tool_result` blocks in *user* messages, so deleting a tool
 * result can empty a message and leave two same-role messages adjacent, which
 * the Messages API rejects. Merging keeps the outbound request legal.
 *
 * It carries no R4 hazard: `assertPrefixPreserved` flattens all blocks across
 * messages, and merging two adjacent messages leaves that flattened order
 * byte-identical. Only a *reorder* invalidates a provider cache.
 */
export function mergeAdjacentSameRole(
  messages: readonly NonGovernanceMessage[],
): NonGovernanceMessage[] {
  const merged: NonGovernanceMessage[] = [];
  for (const m of messages) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && previous.role === m.role) {
      merged[merged.length - 1] = { ...previous, content: [...previous.content, ...m.content] };
      continue;
    }
    merged.push(m);
  }
  return merged;
}

export function dedupeMessages(messages: readonly NonGovernanceMessage[]): {
  readonly messages: readonly NonGovernanceMessage[];
  readonly report: DedupeReport;
} {
  const flat = flatten(messages);

  const lastIndexByIdentity = new Map<string, number>();
  for (let i = 0; i < flat.length; i += 1) {
    const subject = flat[i]?.value.meta.subject;
    if (subject !== undefined) lastIndexByIdentity.set(identityKey(subject), i);
  }

  // Decisions are indexed by *position*, not by content hash. Two blocks can
  // legitimately carry the same hash -- the same file read twice in one turn --
  // and a hash-keyed drop would take out both, or neither, depending on
  // iteration order. Position is unambiguous and needs no uniqueness assumption.
  const dropAt = new Set<number>();
  const dropByIndex = new Map<number, DedupeDrop>();
  let retainedHighSeverity = 0;
  let untiered = 0;

  for (let i = 0; i < flat.length; i += 1) {
    if (flat[i]?.value.meta.subject === undefined) untiered += 1;
    const { drop, retainedHighSeverity: retained } = decide(flat, lastIndexByIdentity, i);
    if (retained) retainedHighSeverity += 1;
    if (drop !== undefined) {
      dropAt.add(i);
      dropByIndex.set(i, drop);
    }
  }

  // Before the counters, not after: the pairing pass both retracts drops and adds
  // blocks `decide` never saw, so counting first would under-report `dropped` and
  // leave a co-dropped result in `drops` with no reason counted for it.
  const pairing = enforcePairAtomicity(flat, dropAt, lastIndexByIdentity);
  retainedHighSeverity += pairing.retainedHighSeverity;
  for (const [i, drop] of pairing.coDrops) dropByIndex.set(i, drop);

  // Transcript order, so the report is byte-identical across runs regardless of
  // which pass recorded a given drop.
  const order = [...dropAt].sort((a, b) => a - b);
  const drops = order.flatMap((i) => {
    const drop = dropByIndex.get(i);
    return drop === undefined ? [] : [drop];
  });
  const byReason = emptyDedupeReasons();
  for (const drop of drops) byReason[drop.reason] += 1;

  if (dropAt.size === 0) {
    return {
      messages,
      report: {
        dropped: 0,
        byReason,
        retainedHighSeverity,
        untiered,
        mergedMessages: 0,
        drops,
      },
    };
  }

  let cursor = 0;
  const rebuilt: NonGovernanceMessage[] = [];
  for (const m of messages) {
    const content: NonGovernanceBlock[] = [];
    let touched = false;
    for (const b of m.content) {
      if (dropAt.has(cursor)) touched = true;
      else content.push(b);
      cursor += 1;
    }
    if (content.length === 0) continue;
    rebuilt.push(touched ? { ...m, content } : m);
  }

  const out = mergeAdjacentSameRole(rebuilt);

  return {
    messages: out,
    report: {
      dropped: order.length,
      byReason,
      retainedHighSeverity,
      untiered,
      mergedMessages: rebuilt.length - out.length,
      drops,
    },
  };
}

/**
 * A Tier 0 operator's result. See ./stage.ts.
 */
export const dedupeStage: Tier0Stage<DedupeReport> = {
  name: 'dedupe',
  run: (ctx) => {
    const { messages, report } = dedupeMessages(ctx.messages);
    return { ctx: report.dropped === 0 ? ctx : { ...ctx, messages }, report };
  },
};
