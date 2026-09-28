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
 *   to lose.
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
  /** Blocks a later read would have superseded, kept because they are error/fatal. */
  readonly retainedHighSeverity: number;
  /** Blocks with no subject, which by construction can never be deduped. */
  readonly untiered: number;
  /** Messages folded into a neighbour once a drop made them adjacent. */
  readonly mergedMessages: number;
  readonly drops: readonly DedupeDrop[];
}

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
  if (isHighSeverity(block) && !sameVersion) {
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
  const drops: DedupeDrop[] = [];
  const byReason = emptyDedupeReasons();
  let retainedHighSeverity = 0;
  let untiered = 0;

  for (let i = 0; i < flat.length; i += 1) {
    if (flat[i]?.value.meta.subject === undefined) untiered += 1;
    const { drop, retainedHighSeverity: retained } = decide(flat, lastIndexByIdentity, i);
    if (retained) retainedHighSeverity += 1;
    if (drop !== undefined) {
      dropAt.add(i);
      drops.push(drop);
      byReason[drop.reason] += 1;
    }
  }

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
      dropped: dropAt.size,
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
