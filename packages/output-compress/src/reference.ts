import type { ArtifactRef, NonGovernanceBlock, NonGovernanceMessage } from '@strata-ctx/core-types';
import { isHighSeverity } from '@strata-ctx/core-types';

/**
 * H-6. Reference instead of inline.
 *
 * ## The difference from B-3, and why both exist
 *
 * `pointerizeBlocks` in the pipeline handles one shape: an oversized *file
 * read*, which has a `meta.subject` and therefore a place in the artifact store
 * named after it. H-6 is the general case at the other end of the pipeline --
 * an oversized model or tool *response*, which is often a bulk API payload with
 * no subject, and is frequently a `text` block carrying structured output the
 * model produced.
 *
 * The mechanics are deliberately identical to B-3's, for one overriding reason:
 * **reversibility**. A reference is only acceptable if the original can be
 * recovered (spec principle 2), and the only way to keep that promise across two
 * implementations is for both to write the same fields in the same order and to
 * keep the same content hash. So:
 *
 * - `meta.sha256` keeps the digest of the content the block *represents*, not of
 *   the stub standing in for it, so dedupe and staleness keys keep working and
 *   `assertPrefixPreserved` still recognises the block rather than a removal.
 * - An `ArtifactRef` is appended, so recovery does not depend on parsing the
 *   stub text.
 * - The original size survives in the stub, in code units, matching the
 *   convention `meta.bytes` uses everywhere else in the pipeline.
 *
 * ## Order relative to serialization
 *
 * Referencing runs *before* compression. A 40kB table compressed to 18kB is
 * still 18kB in the middle of a transcript, and rot does not care that the
 * 18kB is well structured. Reference first, then compress what is left: the
 * coarse budget decision should not depend on how well the fine one happens to
 * work.
 */

export const REFERENCE_MARKER = '[strata:reference]';
export const REFERENCE_SCHEME = 'artifact://output/';

export const referenceUriFor = (sha256: string): string => `${REFERENCE_SCHEME}${sha256}`;

/**
 * True for a block this operator has already rewritten.
 *
 * The marker alone is the test, unlike B-3's `isPointerized`, which also demands
 * a subject -- because H-6's eligibility does not require one. A user block that
 * happens to open with `[strata:reference]` would be skipped, which costs a
 * compression opportunity and cannot corrupt anything: the only thing this
 * predicate gates is "may we rewrite it again".
 */
export const isReferenced = (block: NonGovernanceBlock): boolean =>
  (block.text ?? '').startsWith(REFERENCE_MARKER);

export interface ReferencePolicy {
  /**
   * Blocks larger than this, in code units, become a reference.
   *
   * Undefined here: the caller supplies it from policy. An operator that carries
   * an un-sourced threshold of its own is a constant nobody can tune, and this is
   * exactly the threshold E5 needs to move (larger responses are the rot case).
   */
  readonly maxInlineBytes: number;
  /** Off by default at the policy level; a stage that is off must do nothing. */
  readonly enabled: boolean;
}

const withText = (
  block: NonGovernanceBlock,
  text: string,
  tier: NonGovernanceBlock['meta']['tier'],
): NonGovernanceBlock => ({ ...block, text, meta: { ...block.meta, bytes: text.length, tier } });

const countLines = (s: string): number => (s.length === 0 ? 0 : s.split('\n').length);

/**
 * The stub, field order chosen for the same reason as B-3's: what the reader
 * needs to decide whether to re-inject comes first, and what fetches it comes
 * second.
 */
export function referenceStub(block: NonGovernanceBlock, uri: string): string {
  const text = block.text ?? '';
  const subject = block.meta.subject;
  return [
    REFERENCE_MARKER,
    `kind: ${subject?.kind ?? block.type}`,
    `uri: ${uri}`,
    `sha256: ${block.meta.sha256}`,
    `bytes: ${text.length}`,
    `lines: ${countLines(text)}`,
    'content elided; recoverable verbatim at the uri above (artifact store)',
  ].join('\n');
}

/**
 * What may be referenced.
 *
 * A block with neither a subject nor `tool_state` is something a person or the
 * model said. Referencing it is not a budget decision, it is compaction, and
 * compaction is another stream's job with its own gates -- the same reason
 * B-3 and the truncate stage both leave an unsubjected block alone, and the
 * reason B-6's leading-intent guarantee holds.
 */
const isEligible = (block: NonGovernanceBlock): boolean =>
  block.meta.subject !== undefined || block.meta.tier === 'tool_state';

export interface ReferenceReport {
  readonly referenced: number;
  readonly charsFreed: number;
  readonly artifactsAdded: number;
  readonly skippedDisabled: number;
  readonly skippedUnderCap: number;
  readonly skippedNotEligible: number;
  readonly skippedHighSeverity: number;
  readonly skippedAlreadyReference: number;
  readonly references: readonly {
    readonly uri: string;
    readonly sha256: string;
    readonly originalChars: number;
    readonly originalLines: number;
  }[];
}

export function referenceOversized(
  messages: readonly NonGovernanceMessage[],
  artifacts: readonly ArtifactRef[],
  policy: ReferencePolicy,
): {
  readonly messages: readonly NonGovernanceMessage[];
  readonly artifacts: readonly ArtifactRef[];
  readonly report: ReferenceReport;
} {
  const knownUris = new Set(artifacts.map((a) => a.uri));
  const added: ArtifactRef[] = [];
  const references: {
    readonly uri: string;
    readonly sha256: string;
    readonly originalChars: number;
    readonly originalLines: number;
  }[] = [];
  let referenced = 0;
  let charsFreed = 0;
  let skippedDisabled = 0;
  let skippedUnderCap = 0;
  let skippedNotEligible = 0;
  let skippedHighSeverity = 0;
  let skippedAlreadyReference = 0;

  const messagesOut = messages.map((m) => {
    let touched = false;
    const content = m.content.map((block) => {
      if (!policy.enabled) {
        skippedDisabled += 1;
        return block;
      }
      if (!isEligible(block)) {
        skippedNotEligible += 1;
        return block;
      }
      if (isHighSeverity(block)) {
        // Same rule, same reason as B-3: a producer-declared `is_error` is a fact
        // about the tool call, and the error output is the one payload an agent
        // cannot afford to have summarised away.
        skippedHighSeverity += 1;
        return block;
      }
      if (isReferenced(block)) {
        skippedAlreadyReference += 1;
        return block;
      }
      const text = block.text ?? '';
      if (text.length <= policy.maxInlineBytes) {
        skippedUnderCap += 1;
        return block;
      }

      const uri = referenceUriFor(block.meta.sha256);
      const stub = referenceStub(block, uri);
      if (!knownUris.has(uri)) {
        knownUris.add(uri);
        added.push({ uri, sha256: block.meta.sha256, bytes: text.length, kind: 'other' });
      }
      referenced += 1;
      charsFreed += text.length - stub.length;
      references.push({
        uri,
        sha256: block.meta.sha256,
        originalChars: text.length,
        originalLines: countLines(text),
      });
      touched = true;
      return withText(block, stub, 'artifact_ref');
    });
    return touched ? { ...m, content } : m;
  });

  return {
    messages: messagesOut,
    artifacts: added.length === 0 ? artifacts : [...artifacts, ...added],
    report: {
      referenced,
      charsFreed,
      artifactsAdded: added.length,
      skippedDisabled,
      skippedUnderCap,
      skippedNotEligible,
      skippedHighSeverity,
      skippedAlreadyReference,
      references: Object.freeze(references),
    },
  };
}
