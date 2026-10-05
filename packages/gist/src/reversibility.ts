import type { Gist, Message, ArtifactRef } from '@strata-ctx/core-types';
import { sha256 } from '@strata-ctx/core-types';
import type { ReadResult } from '@strata-ctx/security';
import { artifactUrisOfMessages, extractArtifactUris } from './artifact-uri.js';

/**
 * The only store surface recovery needs.
 *
 * Recovery never writes, so depending on the concrete `ArtifactStore` class
 * forced every caller to hold the full store -- including the ones that already
 * keep a deliberately narrower view of it (see ./transaction.ts:19). The class
 * has private fields, so no structural object can satisfy it.
 */
export interface RecoveryArtifactStore {
  read(uri: string): Promise<ReadResult>;
}

/**
 * Reconstructed context segment from a gist's source turn range.
 */
export interface RecoveredSegment {
  /** The original messages for the turn range. */
  readonly messages: readonly Message[];
  /** Artifacts that were resolved during recovery. */
  readonly resolvedArtifacts: readonly ArtifactRef[];
  /** Any artifacts that could not be resolved. */
  readonly missingArtifacts: readonly string[];
  /** True if all governance blocks round-tripped bit-identically. */
  readonly governanceIntact: boolean;
}

/**
 * Options for turn recovery.
 */
export interface RecoverTurnsOptions {
  /** If true, throw on missing artifacts instead of recording them. */
  readonly strict?: boolean;
  /** Custom artifact resolver (for testing or alternate stores). */
  readonly artifactResolver?: (uri: string) => Promise<ReadResult | null>;
}

/**
 * Recover original messages for a gist's source_turn_range.
 *
 * This is the core reversibility operation: given a gist and an artifact store,
 * fetch the raw transcript artifact (referenced by gist.log_gist.raw_uri) and
 * extract the messages for the turn range specified in gist.source_turn_range.
 *
 * Messages that carry `artifact://` pointers come back with the pointed-at
 * content substituted in. Returning the stub and a metadata `ArtifactRef` was
 * the shape this used to have: `resolvedArtifacts[].uri` said the bytes existed
 * while the message a caller actually re-injects still said `content elided`,
 * so the segment looked recovered and was not.
 *
 * Governance blocks MUST round-trip bit-identically -- this is verified by
 * comparing sha256 hashes before and after recovery, and the comparison runs on
 * the transcript as stored, before any pointer substitution.
 *
 * @param gist - The gist containing source_turn_range and raw_uri
 * @param store - Artifact store to resolve raw_uri and artifact_refs
 * @param options - Recovery options
 * @returns Recovered context segment with messages and artifact resolution status
 */
export async function recoverTurns(
  gist: Gist,
  store: RecoveryArtifactStore,
  options: RecoverTurnsOptions = {},
): Promise<RecoveredSegment> {
  const { strict = false, artifactResolver } = options;

  const [fromTurn, toTurn] = gist.source_turn_range;
  if (toTurn < fromTurn) {
    throw new Error(`invalid source_turn_range: [${fromTurn}, ${toTurn}]`);
  }

  // Fetch the raw transcript artifact using the store directly
  const rawUri = gist.log_gist.raw_uri;
  const rawResult = await store.read(rawUri).catch(() => null);

  if (!rawResult) {
    if (strict) throw new Error(`raw transcript not found: ${rawUri}`);
    return {
      messages: [],
      resolvedArtifacts: [],
      missingArtifacts: [rawUri],
      // Nothing was recovered, so nothing was verified. Reporting `true` here
      // turned total loss of the transcript into a green result, which is the
      // one answer this function must never give: a caller that checks only
      // `governanceIntact` was told the pinned buffer round-tripped when it had
      // not been consulted at all.
      governanceIntact: false,
    };
  }

  // Parse the raw transcript (assumed to be JSONL or JSON array of messages)
  const rawMessages = parseRawTranscript(rawResult.text);

  // Extract messages in the turn range
  const segmentMessages = rawMessages.slice(fromTurn, toTurn + 1);

  // Resolve artifact references in the segment using custom resolver if provided
  const { resolvedArtifacts, missingArtifacts, contents } = await resolveArtifactRefs(
    segmentMessages,
    store,
    artifactResolver,
    strict,
  );

  // Verified against the stored bytes, before substitution: the question is
  // whether the transcript round-tripped, not whether the restored segment does.
  const governanceIntact = verifyGovernanceIntegrity(segmentMessages);

  return {
    messages: substituteArtifactContent(segmentMessages, contents),
    resolvedArtifacts,
    missingArtifacts,
    governanceIntact,
  };
}

/**
 * A transcript read back far enough to undo an eviction.
 *
 * `digests` exists so "it restored something" can be told apart from "it
 * restored the right bytes": a caller compares these against the `meta.sha256`
 * of the blocks it lost, and a mismatch names the block rather than leaving the
 * operator to eyeball text. `complete` is the one field an operator should gate
 * on before treating a segment as whole.
 */
export interface EvictedSegmentRecovery {
  /**
   * Every non-governance message in the transcript, artifact content
   * substituted back in. This is the eviction drop set by construction; see
   * `recoverEvictedMessages`.
   */
  readonly messages: readonly Message[];
  /** One sha256 per content block, in message then block order. */
  readonly digests: readonly string[];
  readonly resolvedArtifacts: readonly ArtifactRef[];
  /** Pointers in the segment the store could not serve. */
  readonly missingArtifacts: readonly string[];
  /** False when the transcript was unreadable, so nothing was verified. */
  readonly governanceIntact: boolean;
  /**
   * False when any pointer went unresolved, which means a message came back as
   * a stub standing in for bytes this call did not retrieve. Distinct from
   * `governanceIntact`, which is about the transcript round-tripping.
   */
  readonly complete: boolean;
}

/** One sha256 per content block, in the order `messages` presents them. */
const digestsOf = (messages: readonly Message[]): readonly string[] =>
  messages.flatMap((message) => message.content.map((block) => sha256(block.text ?? '')));

/**
 * Recover everything an eviction of this gist can have removed.
 *
 * ## Why this exists alongside `recoverTurns`
 *
 * The two address the same transcript differently, and the difference is not
 * cosmetic -- it decides whether a deleted message can be got back.
 *
 * - Eviction chooses its drop set **by identity, not by index**: everything in
 *   the committed context that is neither a governance message nor the gist it
 *   just appended (`transaction.ts:652-667`). It does not consult any range.
 * - `recoverTurns` returns `rawMessages.slice(from, to + 1)`
 *   (`reversibility.ts:99`), where the window is the first through last
 *   `user`/`assistant` message index (`assembly.ts:57-68`). It skips every
 *   message of any other role that sits outside that span.
 *
 * So a trailing `tool` result -- the shape a turn actually ends in -- is
 * deleted, proven present in the transcript by `findRun`
 * (`transaction.ts:264-280`), and never returned by `recoverTurns`. Measured on
 * the shipped fixture plus one appended tool result: 5 messages deleted, 4
 * recovered, `95f20da5...` unreachable through `recoverTurns` while still
 * present in the artifact. "Verified recoverable" and "recoverable through the
 * tool" were not the same claim, and only the first was checked.
 *
 * This closes that by construction: it returns every non-governance message in
 * the transcript, so its result is a superset of `recoverTurns`' for any input
 * where the turn window is a subset of the transcript. It reads only, adds no
 * assertion to the gist, and cannot weaken `raw_recoverable` -- the claim that
 * guards *discarding* bytes is unaffected by how willing this function is to
 * hand them back.
 *
 * Governance blocks are excluded deliberately: eviction keeps them and step 5
 * re-materialises them from the pin buffer (`transaction.ts:637-638`), so they
 * are re-derived rather than recovered, and returning them would describe as
 * "recovered" something that was never lost.
 */
export async function recoverEvictedMessages(
  gist: Gist,
  store: RecoveryArtifactStore,
  options: RecoverTurnsOptions = {},
): Promise<EvictedSegmentRecovery> {
  const { strict = false, artifactResolver } = options;

  const rawUri = gist.log_gist.raw_uri;
  const rawResult = await store.read(rawUri).catch(() => null);

  if (!rawResult) {
    if (strict) throw new Error(`raw transcript not found: ${rawUri}`);
    // Nothing was read, so nothing was verified. Same rule as `recoverTurns`:
    // reporting `governanceIntact: true` here would certify a transcript that
    // was never consulted.
    return {
      messages: [],
      digests: [],
      resolvedArtifacts: [],
      missingArtifacts: [rawUri],
      governanceIntact: false,
      complete: false,
    };
  }

  // A transcript that cannot be parsed is a refusal, not an empty result: an
  // empty segment here would read as "nothing was lost".
  let persisted: Message[];
  try {
    persisted = parseRawTranscript(rawResult.text);
  } catch (e) {
    if (strict) throw e;
    return {
      messages: [],
      digests: [],
      resolvedArtifacts: [],
      missingArtifacts: [rawUri],
      governanceIntact: false,
      complete: false,
    };
  }

  const droppable = persisted.filter((message) => !isGovernanceMessage(message));

  const { resolvedArtifacts, missingArtifacts, contents } = await resolveArtifactRefs(
    droppable,
    store,
    artifactResolver,
    strict,
  );

  const messages = substituteArtifactContent(droppable, contents);

  return {
    messages,
    digests: digestsOf(messages),
    resolvedArtifacts,
    missingArtifacts,
    governanceIntact: verifyGovernanceIntegrity(persisted),
    complete: missingArtifacts.length === 0,
  };
}

/**
 * Whether eviction would keep this message, which is the same predicate the
 * transaction uses to build its drop set (`transaction.ts:652-653`).
 *
 * Duplicated rather than imported: `transaction.ts` depends on this module, so
 * sharing it would be a cycle. The two must agree, and the test that pins it
 * asserts the agreement by recovering exactly the set the transaction dropped.
 */
function isGovernanceMessage(message: Message): boolean {
  return message.content.length > 0 && message.content.every((block) => block.meta.tier === 'governance');
}

/**
 * Parse raw transcript text into Message array.
 * Supports JSONL (one message per line) and JSON array formats.
 */
export function parseRawTranscript(text: string): Message[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Try JSON array first
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every(isMessage)) return parsed;
    } catch {
      // Fall through to JSONL
    }
  }

  // Parse as JSONL
  return trimmed
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (isMessage(parsed)) return parsed;
      throw new Error('invalid message format in transcript');
    });
}

export function isMessage(value: unknown): value is Message {
  return (
    typeof value === 'object' &&
    value !== null &&
    'role' in value &&
    'content' in value &&
    'ts' in value
  );
}

/**
 * Resolve all artifact_refs found in message content blocks.
 *
 * The resolved *content* is returned alongside the metadata because the metadata
 * is not the answer. A caller holding `resolvedArtifacts` has been told the
 * bytes exist; the only thing they can do with that is put the bytes back.
 */
async function resolveArtifactRefs(
  messages: readonly Message[],
  store: RecoveryArtifactStore,
  customResolver: ((uri: string) => Promise<ReadResult | null>) | undefined,
  strict: boolean,
): Promise<{
  resolvedArtifacts: ArtifactRef[];
  missingArtifacts: string[];
  contents: ReadonlyMap<string, string>;
}> {
  const contents = new Map<string, string>();
  const resolved: ArtifactRef[] = [];
  const missing: string[] = [];

  for (const uri of artifactUrisOfMessages(messages)) {
    try {
      const result = customResolver
        ? await customResolver(uri)
        : await store.read(uri).catch(() => null);

      if (result) {
        contents.set(uri, result.text);
        resolved.push({
          uri,
          sha256: result.stat.digest,
          bytes: result.stat.bytes,
          kind: result.stat.kind,
        });
      } else if (strict) {
        throw new Error(`artifact not found: ${uri}`);
      } else {
        missing.push(uri);
      }
    } catch (e) {
      if (strict) throw e;
      missing.push(uri);
    }
  }

  return { resolvedArtifacts: resolved, missingArtifacts: missing, contents };
}

/**
 * Put the resolved bytes back where the pointers were.
 *
 * Two shapes, decided by digest rather than by sniffing stub markers. B-3 and
 * H-6 both promise that a block's `meta.sha256` stays the digest of the content
 * the block *represents* rather than of the stub standing in for it
 * (pipeline/src/pointer.ts:22-28), so when the stored bytes hash to it the
 * whole block text is the placeholder and is replaced outright -- otherwise a
 * 40kB file comes back wrapped in six lines of pointer bookkeeping.
 *
 * A URI merely *mentioned* in a tool result is different: the surrounding log
 * line is real content that must survive, so there the URI is replaced in
 * place.
 *
 * `meta.bytes` is `text.length` everywhere in this codebase (see the note in
 * pipeline/src/pointer.ts:93), so it is recomputed here rather than left
 * describing the stub the caller no longer has.
 */
function substituteArtifactContent(
  messages: readonly Message[],
  contents: ReadonlyMap<string, string>,
): readonly Message[] {
  if (contents.size === 0) return messages;

  return messages.map((message) => ({
    ...message,
    content: message.content.map((block) => {
      const text = block.text;
      if (text === undefined) return block;

      let restored: string | null = null;
      for (const uri of extractArtifactUris(text)) {
        const content = contents.get(uri);
        if (content === undefined) continue;
        restored =
          sha256(content) === block.meta.sha256
            ? content
            : (restored ?? text).split(uri).join(content);
      }
      if (restored === null || restored === text) return block;
      return { ...block, text: restored, meta: { ...block.meta, bytes: restored.length } };
    }),
  }));
}

/**
 * Verify that all governance blocks in the segment have intact sha256 hashes.
 * This ensures lossless round-trip for governance content.
 */
function verifyGovernanceIntegrity(messages: readonly Message[]): boolean {
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.meta.tier === 'governance') {
        // Recompute hash and compare
        const content = block.text ?? '';
        const expectedHash = block.meta.sha256;
        const actualHash = sha256(content);
        if (expectedHash !== actualHash) {
          return false;
        }
      }
    }
  }
  return true;
}

/**
 * A recovered segment prepared for re-injection into a live context.
 *
 * `runId`/`turn`/`policyHash` are echoed from the context the segment is being
 * grafted into because nothing inside `messages` carries that identity, and a
 * segment recovered from a different run under a different pinned buffer is
 * indistinguishable from the right one once it has been flattened to a message
 * list.
 */
export interface ReconstructedSegment {
  readonly messages: readonly Message[];
  readonly artifacts: readonly ArtifactRef[];
  readonly tokenEstimate: number;
  readonly runId: string;
  readonly turn: number;
  readonly taskId?: string;
  readonly policyHash: string;
}

/**
 * Reconstruct a ContextState segment from a recovered segment.
 *
 * The messages are re-derived from `segment.messages`, not handed back by
 * reference: those already carry the restored artifact content (see
 * `recoverTurns` above), and `tokenEstimate` has to be recomputed against it or
 * the caller budgets for stub bytes it is no longer being sent.
 *
 * Stays synchronous because the I/O it would need was already done during
 * recovery -- the point of carrying the content on `RecoveredSegment` is that
 * nothing here has to read the store again.
 */
export function reconstructContextSegment(
  segment: RecoveredSegment,
  baseContext: {
    readonly runId: string;
    readonly turn: number;
    readonly taskId?: string;
    readonly policyHash: string;
  },
): ReconstructedSegment {
  const messages = [...segment.messages];
  const tokenEstimate = messages.reduce(
    (acc, msg) => acc + msg.content.reduce((sum, block) => sum + block.meta.bytes, 0),
    0,
  );

  return {
    messages,
    artifacts: segment.resolvedArtifacts,
    tokenEstimate,
    runId: baseContext.runId,
    turn: baseContext.turn,
    ...(baseContext.taskId === undefined ? {} : { taskId: baseContext.taskId }),
    policyHash: baseContext.policyHash,
  };
}

/**
 * Verify that a recovered segment's governance blocks match the original
 * pinned buffer. Used as a post-recovery integrity check.
 */
export function verifyGovernanceRoundTrip(
  recovered: RecoveredSegment,
  expectedPinned: readonly string[],
): { ok: boolean; missing: string[]; extra: string[] } {
  const recoveredPinned = recovered.messages.flatMap((msg) =>
    msg.content
      .filter((block) => block.meta.tier === 'governance')
      .map((block) => block.text ?? ''),
  );

  const missing = expectedPinned.filter((p) => !recoveredPinned.includes(p));
  const extra = recoveredPinned.filter((p) => !expectedPinned.includes(p));

  return {
    ok: missing.length === 0 && extra.length === 0,
    missing,
    extra,
  };
}