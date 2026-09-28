import type { Gist, Message, ArtifactRef } from '@strata-ctx/core-types';
import type { ArtifactStore, ReadResult } from '@strata-ctx/security';

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
 * Governance blocks MUST round-trip bit-identically — this is verified by
 * comparing sha256 hashes before and after recovery.
 *
 * @param gist - The gist containing source_turn_range and raw_uri
 * @param store - Artifact store to resolve raw_uri and artifact_refs
 * @param options - Recovery options
 * @returns Recovered context segment with messages and artifact resolution status
 */
export async function recoverTurns(
  gist: Gist,
  store: ArtifactStore,
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
      governanceIntact: true,
    };
  }

  // Parse the raw transcript (assumed to be JSONL or JSON array of messages)
  const rawMessages = parseRawTranscript(rawResult.text);

  // Extract messages in the turn range
  const segmentMessages = rawMessages.slice(fromTurn, toTurn + 1);

  // Resolve artifact references in the segment using custom resolver if provided
  const { resolvedArtifacts, missingArtifacts } = await resolveArtifactRefs(
    segmentMessages,
    store,
    artifactResolver,
    strict,
  );

  // Verify governance blocks are bit-identical
  const governanceIntact = verifyGovernanceIntegrity(segmentMessages);

  return {
    messages: segmentMessages,
    resolvedArtifacts,
    missingArtifacts,
    governanceIntact,
  };
}

/**
 * Parse raw transcript text into Message array.
 * Supports JSONL (one message per line) and JSON array formats.
 */
function parseRawTranscript(text: string): Message[] {
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

function isMessage(value: unknown): value is Message {
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
 */
async function resolveArtifactRefs(
  messages: readonly Message[],
  store: ArtifactStore,
  customResolver: ((uri: string) => Promise<ReadResult | null>) | undefined,
  strict: boolean,
): Promise<{ resolvedArtifacts: ArtifactRef[]; missingArtifacts: string[] }> {
  const artifactUris = new Set<string>();

  // Collect all artifact URIs from blocks
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.text) {
        // Tool results may contain artifact URIs in their text
        const uris = extractArtifactUris(block.text);
        for (const uri of uris) artifactUris.add(uri);
      }
      // Also check meta.subject for file references that might be artifacts
      if (block.meta.subject?.kind === 'file') {
        // File subjects might have artifact URIs as refs
        if (block.meta.subject.ref.startsWith('artifact://')) {
          artifactUris.add(block.meta.subject.ref);
        }
      }
    }
  }

  // Also check gist artifacts if present in context
  // (This would be handled by the caller passing the full context)

  const resolved: ArtifactRef[] = [];
  const missing: string[] = [];

  for (const uri of artifactUris) {
    try {
      const result = customResolver
        ? await customResolver(uri)
        : await store.read(uri).catch(() => null);

      if (result) {
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

  return { resolvedArtifacts: resolved, missingArtifacts: missing };
}

/**
 * Extract artifact:// URIs from text content.
 */
function extractArtifactUris(text: string): string[] {
  const regex = /artifact:\/\/[a-z]+\/[0-9a-f]{64}/g;
  const matches = text.match(regex);
  return matches ?? [];
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
        const actualHash = computeSha256(content);
        if (expectedHash !== actualHash) {
          return false;
        }
      }
    }
  }
  return true;
}

import { createHash } from 'node:crypto';

/**
 * Compute SHA-256 hash of a string (matches core-types/hash.ts implementation).
 */
function computeSha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Reconstruct a ContextState segment from a recovered segment.
 * This is a convenience function that builds a minimal ContextState
 * containing only the recovered messages and their artifacts.
 */
export function reconstructContextSegment(
  segment: RecoveredSegment,
  _baseContext: {
    readonly runId: string;
    readonly turn: number;
    readonly taskId?: string;
    readonly policyHash: string;
  },
): {
  readonly messages: readonly Message[];
  readonly artifacts: readonly ArtifactRef[];
  readonly tokenEstimate: number;
} {
  const tokenEstimate = segment.messages.reduce(
    (acc, msg) => acc + msg.content.reduce((sum, block) => sum + block.meta.bytes, 0),
    0,
  );

  return {
    messages: segment.messages,
    artifacts: segment.resolvedArtifacts,
    tokenEstimate,
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