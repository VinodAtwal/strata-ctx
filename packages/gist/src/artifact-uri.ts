import type { Message } from '@strata-ctx/core-types';
import { ARTIFACT_SCHEME, parseArtifactUri } from '@strata-ctx/security';

/**
 * `artifact://` URIs, and the two different questions this package asks about
 * one.
 *
 * The asymmetry below is the whole point. A URI that is *published* is a claim
 * that bytes exist somewhere a later process can read them back; a URI that is
 * *scanned for* is a claim somebody else made. So:
 *
 * - `isResolvableArtifactUri` answers "could the store ever serve this?", which
 *   is the question eviction turns on. Anything the ACL would refuse has to
 *   answer no, because the answer is used to discard the only copy of
 *   something. `parseArtifactUri` (acl.ts:194) is the authority and is used
 *   rather than a second regex, so the bucket vocabulary and the digest form
 *   have exactly one definition.
 * - `extractArtifactUris` answers "what is this text pointing at?", which has
 *   to be *more* permissive, not less. A bucket the ACL refuses is still a
 *   pointer that was published, and hiding it from recovery is how a dangling
 *   promise becomes invisible instead of reported.
 *
 * The failure mode this file exists to close: a gist re-injects a segment whose
 * tool result still reads `artifact://file/<sha>`, recovery records the URI as
 * resolved because it copied `stat` metadata, and the caller is handed a
 * pointer stub that nothing can fetch.
 */

/**
 * A content-addressed URI, whatever bucket it names.
 *
 * One segment then exactly 64 lowercase hex. The bucket is deliberately not
 * constrained to `ARTIFACT_BUCKETS`: acl.ts:60-65 makes the bucket a label an
 * operator reads and never a path component, so a bucket outside the
 * vocabulary names no reachable bytes -- which makes it exactly the case
 * recovery has to surface. Restricting the class here is what previously made
 * `artifact://output/<digest>` (output-compress/src/reference.ts:40) and the
 * bare `artifact://<digest>` minted by the now-deleted ./artifact-store.ts
 * invisible rather than reported.
 */
const CONTENT_ADDRESSED = /artifact:\/\/[A-Za-z0-9._-]+\/[0-9a-f]{64}/g;

/**
 * Every distinct `artifact://` URI mentioned in `text`, in first-seen order.
 */
export function extractArtifactUris(text: string): string[] {
  return [...new Set(text.match(CONTENT_ADDRESSED) ?? [])];
}

/**
 * Could `@strata-ctx/security` resolve this URI to bytes?
 *
 * Named-address URIs are refused even though the store can read them: eviction
 * publishes a content address and has to be able to re-derive it from the
 * message it dropped, which a caller-chosen name does not give.
 */
export function isResolvableArtifactUri(uri: string): boolean {
  try {
    return parseArtifactUri(uri).contentAddressed;
  } catch {
    return false;
  }
}

/**
 * Every `artifact://` URI a set of messages depends on.
 *
 * Every block type is scanned, not just `tool_result`. H-6 references blocks
 * that are not tool results -- anything with a subject or `tool_state` tier
 * qualifies (output-compress/src/reference.ts:105-106) -- so restricting this
 * to `tool_result` left published references on `text` blocks unresolvable by
 * construction.
 */
export function artifactUrisOfMessages(messages: readonly Message[]): string[] {
  const uris = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.text !== undefined) {
        for (const uri of extractArtifactUris(block.text)) uris.add(uri);
      }
      const ref = block.meta.subject?.ref;
      if (ref !== undefined && ref.startsWith(ARTIFACT_SCHEME)) uris.add(ref);
    }
  }
  return [...uris];
}