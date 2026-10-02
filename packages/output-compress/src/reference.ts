import type { ArtifactRef, NonGovernanceBlock, NonGovernanceMessage } from '@strata-ctx/core-types';
import { isHighSeverity, sha256 } from '@strata-ctx/core-types';

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
 * ## Two digests, and which is which
 *
 * The second bullet above is not the whole of reversibility, and getting it wrong
 * is what this operator got wrong. `meta.sha256` is the digest of the *block* --
 * the Anthropic adapter hashes `JSON.stringify(block)`, so it covers the tool
 * name, the id and the result envelope, none of which are in `text`. The URI is
 * therefore built from `artifactDigest` below, which digests `text`, because that
 * is the string `ArtifactStore.put` files. The two can never coincide for a block
 * an adapter built, so minting from `meta.sha256` published a URI naming an object
 * nobody wrote: a dead reference that looked well formed.
 *
 * ## No writer, and the default that follows from it
 *
 * Like B-3 this operator is pure and cannot write, so it returns the bytes it
 * removed as `pending` for the caller to store. What differs is the default.
 * B-3's `durable` is `true` because the gateway hands Tier 0 a store; this
 * package has no caller and no store, so `durable` is `false` here and enabling
 * `enabled` alone references nothing. A stub is the only surviving record of the
 * content, so publishing one with no object behind it destroys the transcript
 * while still reporting a saving.
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

/**
 * The bucket H-6 references into.
 *
 * `other`, not a bucket named after this stage, because `parseArtifactUri`
 * rejects any bucket outside the closed vocabulary in
 * packages/security/src/acl.ts:66 -- and a URI the ACL refuses is a URI no
 * store will ever answer to, so an `artifact://output/...` reference published a
 * pointer that recovery could only ever report as missing. The bucket is a
 * label for an operator and never a path component (acl.ts:60-65), so naming
 * the stage after itself bought nothing that `ArtifactRef.kind: 'other'`, which
 * this operator already publishes, does not.
 *
 * `other` is also what `ArtifactStore.put(text, 'other')` files under
 * (`KIND_BUCKET`, security/src/store.ts:145), so the URI minted here is the URI
 * the write lands on, with no translation step.
 */
export const REFERENCE_SCHEME = 'artifact://other/';

export const referenceUriFor = (sha256: string): string => `${REFERENCE_SCHEME}${sha256}`;

/**
 * The digest a reference's URI is built from: the digest of the block's *text*.
 *
 * Deliberately not `block.meta.sha256`, which hashes the block rather than the
 * text (`JSON.stringify(block)` in the Anthropic adapter). `ArtifactStore.put`
 * digests the string it is given, so the URI minted here and the path the object
 * lands on coincide only if both digest the same bytes.
 *
 * `meta.sha256` itself is untouched. It remains the dedupe and staleness key,
 * which is the reason it exists.
 */
const artifactDigest = (text: string): string => sha256(text);

/**
 * True for a block this operator has already rewritten.
 *
 * The marker alone is the test, unlike B-3's `isPointerized`, which also demands
 * a subject -- because H-6's eligibility does not require one. A user block that
 * happens to open with `[strata:reference]` would be skipped, which costs a
 * compression opportunity and cannot corrupt anything: the only thing this
 * predicate gates is "may we rewrite it again".
 *
 * Checked *before* `isEligible`, and that order is load-bearing. A rewritten
 * block's `meta.tier` is `artifact_ref`, so a subject-less one no longer passes
 * `isEligible` and would be reported as `skippedNotEligible` forever. The marker
 * is the only thing left that says "this is mine", and this is exactly the block
 * shape the note above claims the predicate exists for.
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
  /**
   * Whether a durable artifact store exists to honor what this operator mints.
   * `false` by default, which is the opposite of B-3's `PointerizeInput.durable`
   * and for the same kind of reason: a default that is only correct for a caller
   * who happens to have a store should not be the default of a package with no
   * caller at all.
   *
   * When false the block is left inline and counted in `skippedNoWriter`. The
   * inline cap still applies downstream, so the block is not simply spared --
   * it is merely not replaced by a URI that resolves to nothing.
   */
  readonly durable?: boolean;
}

/**
 * An `artifact://` reference this operator minted whose bytes it does not hold.
 *
 * Whoever publishes the context MUST persist these before the stub goes out: from
 * the moment the stub replaces the text the only copy of the content is here. See
 * `ReferencePolicy.durable`, which is what stops that from being forgotten.
 */
export interface PendingArtifact {
  readonly uri: string;
  readonly sha256: string;
  readonly kind: ArtifactRef['kind'];
  readonly text: string;
  /**
   * The tier the block carried before the rewrite. Needed to put the block back
   * if a write is refused; `referenceStub` overwrites `meta.tier` with
   * `artifact_ref` and the original is otherwise lost.
   */
  readonly tier: NonGovernanceBlock['meta']['tier'];
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
 *
 * `digest` is the digest of the *content the URI addresses*, which is not
 * `block.meta.sha256` -- see `artifactDigest` above. It is a parameter rather
 * than being read off the block so that the two identities cannot be confused at
 * the call site either.
 */
export function referenceStub(block: NonGovernanceBlock, uri: string, digest: string): string {
  const text = block.text ?? '';
  const subject = block.meta.subject;
  return [
    REFERENCE_MARKER,
    `kind: ${subject?.kind ?? block.type}`,
    `uri: ${uri}`,
    `sha256: ${digest}`,
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
  /** Blocks left inline because no durable writer was offered. */
  readonly skippedNoWriter: number;
  readonly references: readonly {
    readonly uri: string;
    /** The artifact digest: what `uri` addresses. */
    readonly sha256: string;
    /**
     * The digest of the block this reference replaced, i.e. `meta.sha256`.
     *
     * Carried separately from `sha256` because a caller matching a rewritten
     * block back to this report has to key on the block, not on the object it
     * was filed under. See `referencedBySha` in ./compress.ts.
     */
    readonly blockSha256: string;
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
  /** Bytes this operator removed from the messages and did not store. See above. */
  readonly pending: readonly PendingArtifact[];
  readonly report: ReferenceReport;
} {
  const knownUris = new Set(artifacts.map((a) => a.uri));
  const added: ArtifactRef[] = [];
  const pending: PendingArtifact[] = [];
  const durable = policy.durable ?? false;
  const references: {
    readonly uri: string;
    readonly sha256: string;
    readonly blockSha256: string;
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
  let skippedNoWriter = 0;

  const messagesOut = messages.map((m) => {
    let touched = false;
    const content = m.content.map((block) => {
      if (!policy.enabled) {
        skippedDisabled += 1;
        return block;
      }
      if (isReferenced(block)) {
        // Before eligibility: a rewritten subject-less block carries
        // `artifact_ref` and would otherwise be counted `skippedNotEligible`
        // forever. See the note on `isReferenced`.
        skippedAlreadyReference += 1;
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
      const text = block.text ?? '';
      if (text.length <= policy.maxInlineBytes) {
        skippedUnderCap += 1;
        return block;
      }
      if (!durable) {
        // Nothing here can write, so a stub would be the only copy of these
        // bytes left in existence. Left inline instead; the cap that follows
        // this stage still applies, so this is a deferral, not an exemption.
        skippedNoWriter += 1;
        return block;
      }

      const digest = artifactDigest(text);
      const uri = referenceUriFor(digest);
      const stub = referenceStub(block, uri, digest);
      if (!knownUris.has(uri)) {
        knownUris.add(uri);
        added.push({ uri, sha256: digest, bytes: text.length, kind: 'other' });
        // Deduplicated with `added` on purpose: one URI is one object, and the
        // store is content-addressed, so two identical blocks are one write --
        // and one owed to the caller, who may already have made it.
        pending.push({
          uri,
          sha256: digest,
          kind: 'other',
          text,
          tier: block.meta.tier,
        });
      }
      referenced += 1;
      charsFreed += text.length - stub.length;
      references.push({
        uri,
        sha256: digest,
        blockSha256: block.meta.sha256,
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
    pending,
    report: {
      referenced,
      charsFreed,
      artifactsAdded: added.length,
      skippedDisabled,
      skippedUnderCap,
      skippedNotEligible,
      skippedHighSeverity,
      skippedAlreadyReference,
      skippedNoWriter,
      references: Object.freeze(references),
    },
  };
}
