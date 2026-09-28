import type {
  LossyContext,
  NonGovernanceBlock,
  NonGovernanceMessage,
  Tier,
} from '@strata-ctx/core-types';
import { isHighSeverity } from '@strata-ctx/core-types';
import type { PointerizeReport } from './pointer.js';
import { isPointerized, pointerizeBlocks } from './pointer.js';
import type { SeverityReport } from './severity.js';
import { applySeverityClassification, isHighSeverityLine } from './severity.js';
import type { Tier0Stage } from './stage.js';

/**
 * B-2. Per-tier byte caps, with head + tail and unconditional severity
 * retention.
 *
 * ## Why head *and* tail
 *
 * A truncation that keeps only the head of a log keeps the banner and loses the
 * failure; one that keeps only the tail keeps the failure and loses what the
 * command was. Both halves are load-bearing for a coding agent, and the tail is
 * where the last error almost always is.
 *
 * ## Two different things called "severity"
 *
 * Release gates G1 and G3 are built on the claim that `severity >= error` survives
 * the pipeline, and `isHighSeverity` is the check for it. So the cap is
 * subordinate to it, with one deliberate refinement:
 *
 * - A severity the *producer* set -- the ingress adapter writing `severity:
 *   'error'` because the provider flagged `is_error: true` -- is a fact about
 *   the tool call. Such a block is never truncated and never pointer-ized, at
 *   any size.
 * - A severity the *classifier* inferred (B-4) from the text is a regex's opinion.
 *   It does not buy block-level immunity, because that would exempt essentially
 *   every failing build log and every source file that contains the word
 *   "error" -- which is most of them -- and Tier 0 would stop working on exactly
 *   the payloads it exists for. It buys *line*-level retention instead: every
 *   ERROR/FATAL line in an over-cap block is re-injected even when the cap is
 *   exceeded, and the report says so (`capOverriddenBySeverity`).
 *
 * The upshot is that the gate is satisfied a fortiori: a producer-declared error
 * is never touched, and an inferred one keeps every error line it had. The
 * ordering consequence is that classification runs *last* in this stage -- see
 * `applyTruncate`.
 *
 * ## Why an unsubjected block is never touched
 *
 * A user message has no `meta.subject`, so "never truncate a block with no
 * subject" is what makes the leading intent statement survive step 2
 * unconditionally -- the intent is not a tool result and is never a candidate
 * for tiered eviction. The rule reads like a formality and is the mechanism
 * behind B-6's guarantee.
 *
 * ## Why a pointer stub is never touched either
 *
 * B-3 runs first in this stage, so the cap sees the stubs B-3 just wrote. A stub
 * is already the smallest honest statement of a file -- the whole point of
 * pointer-izing was that the alternative was 40kB -- so capping it frees nothing
 * and costs the two lines that make it work. `path:` and `uri:` sit at the head
 * of the stub, and head+tail truncation spends its budget on the marker and the
 * trailing prose, cutting both out. What came out the other side was a block
 * that still announced `[strata:pointer]` and could no longer be resolved from
 * its own text; recovery fell back entirely on `ctx.artifacts`, which is a
 * second path to the bytes that the operator's contract says must not be
 * load-bearing. So a stub is skipped, for the same reason `pointerizeBlocks`
 * skips one: it is Tier 0's own bookkeeping and no later operator may eat it.
 */

export const TRUNCATION_MARKER = '[strata:truncated]';
export const RETAINED_MARKER = '[strata:retained]';

/**
 * Share of the cap given to the head. Flagged, not sourced: no study in the
 * plan measures where in a tool result the useful content sits. 0.6 favours the
 * head because the first lines of a file or a log identify the subject, and
 * operators are expected to tune it. Cited as folklore on purpose so nobody
 * mistakes it for a measured constant.
 */
export const HEAD_SHARE = 0.6;

/** Per-tier cap lookup. A tier with no configured cap has no budget, so no truncation. */
export const capForTier = (
  caps: Readonly<Record<string, number>>,
  tier: Tier,
): number | undefined => caps[tier];

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/** Cut at `at` without splitting a surrogate pair, so the text stays valid. */
function safeCut(text: string, at: number): number {
  let end = Math.max(0, Math.min(at, text.length));
  while (end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return end;
}

/** Index just after the last newline at or before `limit`, or 0 if there is none. */
function lineEndWithin(text: string, limit: number): number {
  if (limit <= 0) return 0;
  const at = text.lastIndexOf('\n', limit - 1);
  return at === -1 ? 0 : at + 1;
}

/** Start of the first whole line at or after `from`; keeps the tail line-aligned. */
function lineStartFrom(text: string, from: number): number {
  if (from >= text.length) return text.length;
  const at = text.indexOf('\n', from);
  return at === -1 ? text.length : at + 1;
}

export interface TruncatedText {
  readonly text: string;
  readonly originalChars: number;
  readonly elidedLines: number;
  readonly elidedChars: number;
  readonly retainedLines: number;
  /** The reassembled text is longer than the cap because errors were kept. */
  readonly capOverriddenBySeverity: boolean;
}

const countLines = (s: string): number => (s.length === 0 ? 0 : s.split('\n').length);

/**
 * Head + tail + every ERROR/FATAL line from the elided middle.
 *
 * Deterministic by construction (N6): the only inputs are the text, the cap and
 * the two markers, so the same block always produces byte-identical output.
 */
export function truncateText(text: string, cap: number): TruncatedText {
  const originalChars = text.length;
  if (originalChars <= cap) {
    return {
      text,
      originalChars,
      elidedLines: 0,
      elidedChars: 0,
      retainedLines: 0,
      capOverriddenBySeverity: false,
    };
  }

  // Reserve room for the markers before dividing the rest, so the head and tail
  // can never overflow the cap between them.
  const markerAllowance = TRUNCATION_MARKER.length + RETAINED_MARKER.length + 64;
  const budget = Math.max(0, cap - markerAllowance);
  const headBudget = Math.floor(budget * HEAD_SHARE);
  const tailBudget = budget - headBudget;

  const headEnd = lineEndWithin(text, headBudget) || safeCut(text, headBudget);
  const tailStart = Math.max(headEnd, lineStartFrom(text, text.length - tailBudget));

  // Windows overlapped: the cap is not actually binding. Keep the block.
  if (tailStart <= headEnd) {
    return {
      text,
      originalChars,
      elidedLines: 0,
      elidedChars: 0,
      retainedLines: 0,
      capOverriddenBySeverity: false,
    };
  }

  const elided = text.slice(headEnd, tailStart);
  const head = text.slice(0, headEnd);
  const tail = text.slice(tailStart);

  // Taken from the elided region only, so a retained line is never duplicated by
  // the head or the tail.
  const retained = elided.split('\n').filter((l) => l.trim() !== '' && isHighSeverityLine(l));

  const middle: string[] = [
    `${TRUNCATION_MARKER} ${countLines(elided)} lines / ${elided.length} chars elided`,
  ];
  if (retained.length > 0) middle.push(`${RETAINED_MARKER} ${retained.length} error/fatal lines`);
  middle.push(...retained);

  const out = [head, ...middle, tail].join('\n');
  return {
    text: out,
    originalChars,
    elidedLines: countLines(elided),
    elidedChars: elided.length,
    retainedLines: retained.length,
    capOverriddenBySeverity: out.length > cap,
  };
}

export interface TruncateReport {
  readonly truncatedBlocks: number;
  readonly charsFreed: number;
  readonly retainedHighSeverityLines: number;
  readonly capOverriddenBySeverity: number;
  readonly skippedNoSubject: number;
  readonly skippedHighSeverity: number;
  readonly skippedNoCap: number;
  /** Blocks already reduced to a pointer stub, which the cap must not touch. */
  readonly skippedAlreadyPointer: number;
  readonly truncatedByTier: ReadonlyMap<Tier, number>;
  readonly severity: SeverityReport;
  readonly pointerize: PointerizeReport;
}

export interface TruncateInput {
  readonly caps: Readonly<Record<string, number>>;
}

const withMeta = (
  block: NonGovernanceBlock,
  text: string,
  extra: Partial<NonGovernanceBlock['meta']>,
): NonGovernanceBlock => ({ ...block, text, meta: { ...block.meta, bytes: text.length, ...extra } });

export function truncateBlocks(
  messages: readonly NonGovernanceMessage[],
  input: TruncateInput,
): {
  readonly messages: readonly NonGovernanceMessage[];
  readonly report: Omit<TruncateReport, 'severity' | 'pointerize'>;
} {
  const truncatedByTier = new Map<Tier, number>();
  let truncatedBlocks = 0;
  let charsFreed = 0;
  let retainedHighSeverityLines = 0;
  let capOverridden = 0;
  let skippedNoSubject = 0;
  let skippedHighSeverity = 0;
  let skippedNoCap = 0;
  let skippedAlreadyPointer = 0;

  const messagesOut = messages.map((m) => {
    let touched = false;
    const content = m.content.map((block: NonGovernanceBlock) => {
      if (block.meta.subject === undefined) {
        skippedNoSubject += 1;
        return block;
      }
      if (isHighSeverity(block)) {
        // The release gate. See the note at the top of the file.
        skippedHighSeverity += 1;
        return block;
      }
      if (isPointerized(block)) {
        // Tier 0 must not eat its own bookkeeping. A pointer stub is already the
        // cheapest representation of the file it stands for, so capping it frees
        // nothing worth having -- and head+tail truncation of a stub cuts exactly
        // the `path:` and `uri:` lines the stub exists to carry, leaving a block
        // that announces itself as resolvable and is not. See the note in
        // ./pointer.ts; this is the same skip, from the other side.
        skippedAlreadyPointer += 1;
        return block;
      }
      const cap = capForTier(input.caps, block.meta.tier);
      if (cap === undefined) {
        skippedNoCap += 1;
        return block;
      }
      const text = block.text ?? '';
      const result = truncateText(text, cap);
      if (result.text === text) return block;

      truncatedBlocks += 1;
      charsFreed += result.originalChars - result.text.length;
      retainedHighSeverityLines += result.retainedLines;
      if (result.capOverriddenBySeverity) capOverridden += 1;
      truncatedByTier.set(block.meta.tier, (truncatedByTier.get(block.meta.tier) ?? 0) + 1);
      touched = true;
      return withMeta(block, result.text, {});
    });
    return touched ? { ...m, content } : m;
  });

  return {
    messages: messagesOut,
    report: {
      truncatedBlocks,
      charsFreed,
      retainedHighSeverityLines,
      capOverriddenBySeverity: capOverridden,
      skippedNoSubject,
      skippedHighSeverity,
      skippedNoCap,
      skippedAlreadyPointer,
      truncatedByTier,
    },
  };
}

/**
 * The whole of stage 2, in the order the stage performs it.
 *
 * 1. pointer-ize oversized file reads, because a pointer to the whole file is
 *    strictly more information than a head and tail of it, and it is the only
 *    way to get the bytes back;
 * 2. cap everything else, head + tail + every ERROR/FATAL line, and nothing that
 *    step 1 just wrote;
 * 3. classify severity, last.
 *
 * Step 3 is last on purpose. The labels it writes are for the *next* stage and
 * for the consumers B-4 exports them to -- H's log compressor, C's gist
 * assembler, E-2's hook rewriting -- and letting stage 2 read back its own
 * inferred labels would let a regex grant a block the immunity that only a
 * producer-declared `is_error` earns. See the note on the two kinds of severity
 * at the top of this file.
 *
 * Steps 1 and 3 are B-3 and B-4. They are separate exported operators because
 * E-2 (Claude Code PostToolUse result rewriting) and H-6 (reference-instead-of-
 * inline) need them on their own, but they are not separate *stages*: the fixed
 * order in docs/architecture.md §4 has seven slots and no room for them.
 */
export function applyTruncate(ctx: LossyContext): {
  readonly ctx: LossyContext;
  readonly report: TruncateReport;
} {
  const caps = ctx.policy.pipeline.tierByteCaps;
  const capFor = (block: NonGovernanceBlock): number | undefined =>
    capForTier(caps, block.meta.tier);

  const pointerized = pointerizeBlocks(ctx.messages, ctx.artifacts, { capFor });
  const capped = truncateBlocks(pointerized.messages, { caps });
  const severity = applySeverityClassification({
    ...ctx,
    messages: capped.messages,
    artifacts: pointerized.artifacts,
  });

  return {
    ctx: severity.ctx,
    report: { ...capped.report, severity: severity.report, pointerize: pointerized.report },
  };
}

/** Stage 2. See `applyTruncate` for what it composes and in which order. */
export const truncateStage: Tier0Stage<TruncateReport> = {
  name: 'truncate',
  run: applyTruncate,
};
