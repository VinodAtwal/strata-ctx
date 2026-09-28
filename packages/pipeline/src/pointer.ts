import type { ArtifactRef, BlockSubject, NonGovernanceBlock, NonGovernanceMessage } from '@strata-ctx/core-types';
import { isHighSeverity } from '@strata-ctx/core-types';

/**
 * B-3. Pointer-ization: an oversized file read becomes a reference.
 *
 * docs/spec.md F8: bulk payloads become an `artifact://` URI plus sha256, not
 * inline content. The point is not the token saving -- it is that a 40k-line
 * `git diff` in the middle of a transcript is both expensive and actively
 * harmful, because it is the sort of bulk that pushes the agent's real state out
 * of the attention window (docs/architecture.md §2, rot).
 *
 * ## Reversibility
 *
 * spec.md principle 2: compaction must be re-injectable. A pointer is only
 * acceptable if the original can be recovered, so the stub carries everything
 * needed to do that: the subject ref (the path), the content digest, the
 * original byte count and line count, and a content-addressed URI. The same
 * facts are appended to `ctx.artifacts` as an `ArtifactRef`, so recovery does
 * not depend on parsing the stub text.
 *
 * ## The digest deliberately does not change
 *
 * `meta.sha256` keeps the digest of the *content the block represents*, not of
 * the stub now standing in for it. Two consequences, both wanted: the dedupe and
 * staleness keys upstream keep working across a pointer-ization, and
 * `assertPrefixPreserved` still recognises the block as the same block rather
 * than as a removal.
 */

export const ARTIFACT_SCHEME = 'artifact://';

/**
 * First line of every pointer stub. Other stages (H's log compressor, C's gist
 * assembler) grep for it, and it is what makes the operator idempotent: a second
 * pass must not wrap an existing pointer in another pointer.
 */
export const POINTER_MARKER = '[strata:pointer]';

export const artifactUriFor = (sha256: string): string => `${ARTIFACT_SCHEME}file/${sha256}`;

/** True for a block this operator has already rewritten. */
export const isPointerized = (block: NonGovernanceBlock): boolean =>
  (block.text?.startsWith(POINTER_MARKER) ?? false) && block.meta.subject !== undefined;

/** True when the block is a file read -- the only thing this operator touches. */
export const isFileRead = (subject: BlockSubject | undefined): boolean =>
  subject !== undefined && subject.kind === 'file';

export interface Pointerized {
  readonly ref: string;
  readonly uri: string;
  readonly sha256: string;
  readonly originalChars: number;
  readonly originalLines: number;
}

export interface PointerizeReport {
  readonly pointerized: number;
  readonly charsFreed: number;
  readonly artifactsAdded: number;
  readonly skippedNoSubject: number;
  readonly skippedSeverity: number;
  readonly skippedNoCap: number;
  readonly skippedAlreadyPointer: number;
  readonly pointers: readonly Pointerized[];
}

/**
 * Deterministic, model-readable stub. The path comes first because that is what
 * a reader needs to decide whether to re-inject; the URI comes second because
 * that is what actually fetches it.
 */
export function pointerStub(block: NonGovernanceBlock, uri: string): string {
  const text = block.text ?? '';
  const subject = block.meta.subject;
  const lines = text.length === 0 ? 0 : text.split('\n').length;
  return [
    POINTER_MARKER,
    `path: ${subject?.ref ?? '(unknown)'}`,
    `uri: ${uri}`,
    `sha256: ${block.meta.sha256}`,
    `chars: ${text.length}`,
    `lines: ${lines}`,
    'content elided; recoverable verbatim at the uri above (artifact store)',
  ].join('\n');
}

/**
 * `meta.bytes` in the canonical model is `text.length` -- see the Anthropic
 * adapter and `estimateBlockTokens`, which divide that same number by four. Caps
 * are therefore measured in code units so that Tier 0's savings and the token
 * estimator never disagree. The *original* length survives in the stub text and
 * in the `ArtifactRef`, which is where reversibility needs it.
 */
const withText = (
  block: NonGovernanceBlock,
  text: string,
  meta: Partial<NonGovernanceBlock['meta']>,
): NonGovernanceBlock => ({ ...block, text, meta: { ...block.meta, bytes: text.length, ...meta } });

const tierOf = (): NonGovernanceBlock['meta']['tier'] => 'artifact_ref';

export interface PointerizeInput {
  /**
   * Per-tier cap used to decide "oversized". Undefined for a tier with no
   * configured cap, in which case nothing is pointer-ized: the operator is
   * budgeted by policy and does not carry an un-sourced constant of its own.
   */
  readonly capFor: (block: NonGovernanceBlock) => number | undefined;
}

export function pointerizeBlocks(
  messages: readonly NonGovernanceMessage[],
  artifacts: readonly ArtifactRef[],
  input: PointerizeInput,
): {
  readonly messages: readonly NonGovernanceMessage[];
  readonly artifacts: readonly ArtifactRef[];
  readonly report: PointerizeReport;
} {
  const knownUris = new Set(artifacts.map((a) => a.uri));
  const added: ArtifactRef[] = [];

  let pointerized = 0;
  let charsFreed = 0;
  let skippedNoSubject = 0;
  let skippedSeverity = 0;
  let skippedNoCap = 0;
  let skippedAlreadyPointer = 0;
  const pointers: Pointerized[] = [];

  const messagesOut = messages.map((m) => {
    let touched = false;
    const content = m.content.map((block) => {
      if (!isFileRead(block.meta.subject)) {
        if (block.meta.subject === undefined) skippedNoSubject += 1;
        return block;
      }
      if (isPointerized(block)) {
        skippedAlreadyPointer += 1;
        return block;
      }
      if (isHighSeverity(block)) {
        // Producer-declared severity only. This operator runs *before* B-4
        // classifies anything, precisely so that a source file containing the
        // word "error" is still pointer-ized. See the note in ./truncate.ts.
        skippedSeverity += 1;
        return block;
      }
      const cap = input.capFor(block);
      if (cap === undefined) {
        skippedNoCap += 1;
        return block;
      }
      const text = block.text ?? '';
      if (text.length <= cap) return block;

      const uri = artifactUriFor(block.meta.sha256);
      const stub = pointerStub(block, uri);
      if (!knownUris.has(uri)) {
        knownUris.add(uri);
        added.push({ uri, sha256: block.meta.sha256, bytes: text.length, kind: 'file_snapshot' });
      }
      pointerized += 1;
      charsFreed += text.length - stub.length;
      pointers.push({
        ref: block.meta.subject?.ref ?? '',
        uri,
        sha256: block.meta.sha256,
        originalChars: text.length,
        originalLines: text.length === 0 ? 0 : text.split('\n').length,
      });
      touched = true;
      return withText(block, stub, { tier: tierOf() });
    });
    return touched ? { ...m, content } : m;
  });

  return {
    messages: messagesOut,
    artifacts: added.length === 0 ? artifacts : [...artifacts, ...added],
    report: {
      pointerized,
      charsFreed,
      artifactsAdded: added.length,
      skippedNoSubject,
      skippedSeverity,
      skippedNoCap,
      skippedAlreadyPointer,
      pointers,
    },
  };
}
