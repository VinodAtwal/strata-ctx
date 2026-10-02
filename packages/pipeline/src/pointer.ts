import type { ArtifactRef, BlockSubject, NonGovernanceBlock, NonGovernanceMessage } from '@strata-ctx/core-types';
import { isHighSeverity, sha256 } from '@strata-ctx/core-types';

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
 * ## Two digests, and which is which
 *
 * `meta.sha256` keeps the digest of the *block the stub stands in for*, not of
 * the stub and not of `text`. Two consequences, both wanted: the dedupe and
 * staleness keys upstream keep working across a pointer-ization, and
 * `assertPrefixPreserved` still recognises the block as the same block rather
 * than as a removal.
 *
 * It is therefore *not* what the URI is built from. `artifactDigest` below
 * hashes `text`, because that is the string the store is going to file. Using
 * `meta.sha256` for both was one of the two ways this operator could publish a
 * URI that resolves to nothing.
 */

export const ARTIFACT_SCHEME = 'artifact://';

/**
 * First line of every pointer stub. Other stages (H's log compressor, C's gist
 * assembler) grep for it, and it is what makes the operator idempotent: a second
 * pass must not wrap an existing pointer in another pointer.
 */
export const POINTER_MARKER = '[strata:pointer]';

export const artifactUriFor = (sha256: string): string => `${ARTIFACT_SCHEME}file/${sha256}`;

/**
 * The digest a pointer's URI is built from: the digest of the block's *text*.
 *
 * It is deliberately not `block.meta.sha256`. `meta.sha256` identifies a block
 * -- the Anthropic adapter hashes `JSON.stringify(block)`, so it covers the
 * tool name, the id and the result envelope, none of which are in `text` -- and
 * the two therefore disagree for every block the adapters build.
 *
 * A content-addressed URI has to be the address of the content it addresses. The
 * store (`ArtifactStore.put`, security/store.ts) digests the string it is given,
 * so the URI minted here and the path the object lands on can only coincide if
 * both digest the same bytes. Minting from `meta.sha256` instead produced a URI
 * that named an object that was never written, which is the same dead reference
 * as no writer at all -- and a subtler one, because the pointer looked
 * well-formed.
 *
 * `meta.sha256` itself is untouched. It remains the dedupe and staleness key,
 * which is the reason it exists; see the note on the digest above.
 */
const artifactDigest = (text: string): string => sha256(text);

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

/**
 * An `artifact://` reference this operator minted whose bytes it does not hold.
 *
 * The operator is pure and runs inside a synchronous stage, so it cannot write to
 * the store itself; it hands the bytes to the caller instead. Whoever publishes
 * the context MUST persist these before the pointer goes out, because from the
 * moment the stub replaces the text the only copy of the content is here. A
 * caller with no durable store must therefore not pointer-ize at all -- see
 * `PointerizeInput.durable`, which is what stops that from being forgotten.
 */
export interface PendingArtifact {
  readonly uri: string;
  readonly sha256: string;
  readonly kind: ArtifactRef['kind'];
  readonly text: string;
  /**
   * The tier the block carried before the rewrite. Needed to put the block back
   * if a write is refused; `pointerStub` overwrites `meta.tier` with
   * `artifact_ref` and the original is otherwise lost.
   */
  readonly tier: NonGovernanceBlock['meta']['tier'];
}

export interface PointerizeReport {
  readonly pointerized: number;
  readonly charsFreed: number;
  readonly artifactsAdded: number;
  readonly skippedNoSubject: number;
  readonly skippedSeverity: number;
  readonly skippedNoCap: number;
  readonly skippedAlreadyPointer: number;
  /** Blocks left inline because no durable writer was offered. */
  readonly skippedNoWriter: number;
  readonly pointers: readonly Pointerized[];
}

/**
 * Deterministic, model-readable stub. The path comes first because that is what
 * a reader needs to decide whether to re-inject; the URI comes second because
 * that is what actually fetches it.
 *
 * `digest` is the digest of the *content the URI addresses*, which is not
 * `block.meta.sha256` -- see the note on `artifactDigest` above. It is a
 * parameter rather than being read off the block so that the two identities
 * cannot be confused at the call site either.
 */
export function pointerStub(block: NonGovernanceBlock, uri: string, digest: string): string {
  const text = block.text ?? '';
  const subject = block.meta.subject;
  const lines = text.length === 0 ? 0 : text.split('\n').length;
  return [
    POINTER_MARKER,
    `path: ${subject?.ref ?? '(unknown)'}`,
    `uri: ${uri}`,
    `sha256: ${digest}`,
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
  /**
   * Whether a durable artifact store exists to honor what this operator mints.
   * Defaults to true, which is the correct answer for a caller that persists
   * `pending` before publishing -- and the wrong one for a caller that does not,
   * which is why it is a parameter rather than an assumption.
   *
   * Pointer-ization is the only Tier 0 step that can destroy information: a
   * capped block keeps a recoverable head and tail, a stub keeps nothing but a
   * URI. So a caller without a store gets the cap instead, which is lossy in a
   * way the operator can report, rather than a loss it cannot.
   */
  readonly durable?: boolean;
}

export function pointerizeBlocks(
  messages: readonly NonGovernanceMessage[],
  artifacts: readonly ArtifactRef[],
  input: PointerizeInput,
): {
  readonly messages: readonly NonGovernanceMessage[];
  readonly artifacts: readonly ArtifactRef[];
  /** Bytes this operator removed from the messages and did not store. See above. */
  readonly pending: readonly PendingArtifact[];
  readonly report: PointerizeReport;
} {
  const knownUris = new Set(artifacts.map((a) => a.uri));
  const added: ArtifactRef[] = [];
  const pending: PendingArtifact[] = [];
  const durable = input.durable ?? true;

  let pointerized = 0;
  let charsFreed = 0;
  let skippedNoSubject = 0;
  let skippedSeverity = 0;
  let skippedNoCap = 0;
  let skippedNoWriter = 0;
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
      if (!durable) {
        // The cap still applies to this block downstream, so it is not lost --
        // only left inline instead of referenced.
        skippedNoWriter += 1;
        return block;
      }

      const digest = artifactDigest(text);
      const uri = artifactUriFor(digest);
      const stub = pointerStub(block, uri, digest);
      if (!knownUris.has(uri)) {
        knownUris.add(uri);
        added.push({ uri, sha256: digest, bytes: text.length, kind: 'file_snapshot' });
        // Deduplicated with `added` on purpose: one URI is one object, and the
        // store is content-addressed, so two identical blocks are one write.
        pending.push({
          uri,
          sha256: digest,
          kind: 'file_snapshot',
          text,
          tier: block.meta.tier,
        });
      }
      pointerized += 1;
      charsFreed += text.length - stub.length;
      pointers.push({
        ref: block.meta.subject?.ref ?? '',
        uri,
        sha256: digest,
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
    pending,
    report: {
      pointerized,
      charsFreed,
      artifactsAdded: added.length,
      skippedNoSubject,
      skippedSeverity,
      skippedNoCap,
      skippedNoWriter,
      skippedAlreadyPointer,
      pointers,
    },
  };
}
