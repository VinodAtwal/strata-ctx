import type {
  ArtifactRef,
  ContextState,
  Gist,
  GistDraft,
  Message,
  PinIntegrity,
  StrataPolicy,
  TelemetryEvent,
} from '@strata-ctx/core-types';
import { enforcePins, verifyPinIntegrity, validateGist, pinSetText } from '@strata-ctx/core-types';
import type { ReadResult } from '@strata-ctx/security';
import { artifactUrisOfMessages, artifactUriRefusal, isResolvableArtifactUri } from './artifact-uri.js';
import { parseRawTranscript } from './reversibility.js';
import type { StrataTelemetryEvent, GistEvent } from '@strata-ctx/telemetry';
import { EVICTION_SKIPPED_CODE, EVICTION_SKIPPED_PREFIX } from '@strata-ctx/telemetry';

/**
 * Minimal interface for the artifact store operations needed by the transaction.
 * Implemented by @strata-ctx/security ArtifactStore.
 */
export interface TransactionArtifactStore {
  /** Write content and return the artifact reference. */
  put(content: string | Uint8Array, kind: ArtifactRef['kind'], options?: { readonly at?: number }): Promise<ArtifactRef>;
  /** Check if an artifact URI or digest exists in the store. */
  exists(uriOrDigest: string): Promise<boolean>;
  /** Read an artifact. */
  read(uri: string): Promise<ReadResult>;
}

/**
 * Telemetry emitter function type using the extended StrataTelemetryEvent.
 */
export type TelemetryEmitter = (event: StrataTelemetryEvent) => void;

/**
 * Options for the compaction transaction.
 */
export interface CompactionTransactionOptions {
  /** The current context state. */
  readonly state: ContextState;
  /**
   * The gist to compact into the context.
   *
   * A `GistDraft` is accepted because `GistAssembler.assemble` has no store and
   * so cannot assert `raw_recoverable` (assembly.ts:353-360); a committed `Gist`
   * is still accepted unchanged.
   */
  readonly gist: GistDraft;
  /** The policy containing the pinned constraints. */
  readonly policy: StrataPolicy;
  /** Artifact store for writing the raw transcript and reading artifacts. */
  readonly artifactStore: TransactionArtifactStore;
  /** Telemetry emitter. */
  readonly emit: TelemetryEmitter;
  /** Number of ERROR/FATAL lines expected in the raw log (for validation 4b). */
  readonly expectedErrorCount?: number;
  /** Trigger description for telemetry (e.g., 'task_boundary', 'soft_limit'). */
  readonly trigger: string;
  /** Injected clock for deterministic timestamps. */
  readonly now?: () => number;
  /** The raw transcript text to store (step 1: flush). */
  readonly rawTranscript: string;
  /** The tool log text to store (step 1: flush). */
  readonly toolLog: string;
}

/**
 * Result of the compaction transaction.
 */
export interface CompactionTransactionResult {
  /** Whether the transaction committed successfully. */
  readonly ok: boolean;
  /** The new context state (if ok) or the original state (if aborted). */
  readonly state: ContextState;
  /** The gist that was validated (if ok). */
  readonly gist: Gist | null;
  /** Validation defects if the transaction aborted. */
  readonly defects: readonly ValidationDefect[];
  /** Telemetry events emitted during the transaction. */
  readonly telemetry: readonly StrataTelemetryEvent[];
  /** Pin integrity check result (step 4c / step 6). */
  readonly pinIntegrity: PinIntegrity | null;
}

/**
 * Validation defect from the transaction's step 3.
 */
export interface ValidationDefect {
  readonly step: '4a_digests' | '4b_invariants' | '4c_constraint_bytes' | '4d_artifacts';
  readonly detail: string;
  readonly constraintIds: readonly string[];
}

/**
 * The open threads ("unresolved") already carried by gists in the context.
 *
 * This is the source of truth for the 4b invariant: a thread is only "dropped"
 * if some earlier gist recorded it. Gists already in the context are the
 * structured record of what was outstanding, so this deliberately does not
 * guess by scanning transcript prose. A context with no prior gists therefore
 * has no unresolved contract to violate.
 */
function collectPriorUnresolved(gists: readonly Gist[]): string[] {
  const threads = new Set<string>();
  for (const gist of gists) {
    for (const item of gist.unresolved) {
      const trimmed = item.trim();
      if (trimmed.length > 0) threads.add(trimmed);
    }
  }
  return [...threads].sort();
}

/**
 * Whether the messages eviction would discard can actually be served back.
 *
 * Eviction is the only irreversible step: afterwards those messages exist
 * solely in the raw artifact. So it is gated on the artifact holding them.
 * If it does not, compaction still commits (the gist and the repin are sound)
 * but the transcript is kept, because holding a larger context is recoverable
 * and losing the only copy is not.
 *
 * Two things are checked, and the second is the one that used to be missing.
 * The transcript artifact has to hold the dropped messages, *and* every
 * `artifact://` URI those messages publish has to resolve. A pointerized tool
 * result is a message whose payload lives in a second artifact: the transcript
 * faithfully preserves the stub and the stub says "recoverable verbatim at the
 * uri above". Verifying only the transcript certifies a message as recoverable
 * on the strength of an artifact that contains nothing but the pointer to the
 * content.
 *
 * The check is content-based, not index-based, and deliberately so. Step 5
 * repin rewrites the message list -- it collapses governance blocks into a
 * single system message -- so the same numeric offset addresses a different
 * message before and after. Any index arithmetic spanning that rewrite can
 * certify one range and discard another, so the whole run must be found
 * intact in the transcript or nothing is discarded.
 *
 * @param dropping the exact messages eviction would remove
 * @returns how many would go, whether the transcript can restore all of them,
 *          and why not when it cannot.
 */
async function assessEvictable(
  dropping: readonly Message[],
  artifactStore: TransactionArtifactStore,
  gist: Gist,
): Promise<{ evicted: number; verified: boolean; reason: string }> {
  const evicted = dropping.length;
  if (evicted === 0) return { evicted: 0, verified: true, reason: 'nothing to evict' };

  if (gist.raw_recoverable !== true) {
    return {
      evicted,
      verified: false,
      reason: 'gist does not assert raw_recoverable, so eviction cannot be undone',
    };
  }

  const rawUri = gist.log_gist.raw_uri;
  // `/^artifact:\/\//` used to stand in for this and asserted nothing: the
  // bucket can be one the ACL refuses and the tail can be anything, so a URI
  // no store would ever answer to passed. `isResolvableArtifactUri` defers to
  // packages/security/src/acl.ts for both the bucket vocabulary and the digest
  // form.
  if (!isResolvableArtifactUri(rawUri)) {
    return {
      evicted,
      verified: false,
      reason:
        `raw_uri "${rawUri}" is not a content-addressed artifact reference ` +
        `(expected artifact://<bucket>/<64-hex digest>), so the transcript is unresolvable`,
    };
  }

  let exists: boolean;
  try {
    exists = await artifactStore.exists(rawUri);
  } catch {
    return { evicted, verified: false, reason: `artifact store threw while resolving ${rawUri}` };
  }
  if (!exists) {
    return {
      evicted,
      verified: false,
      reason: `raw transcript artifact ${rawUri} is not in the store, so ${evicted} message(s) would be unrecoverable`,
    };
  }

  let persisted: Message[];
  try {
    const read: ReadResult = await artifactStore.read(rawUri);
    persisted = parseRawTranscript(read.text);
  } catch (e) {
    return {
      evicted,
      verified: false,
      reason: `raw transcript artifact ${rawUri} could not be parsed: ${e instanceof Error ? e.message : 'unknown'}`,
    };
  }

  const found = findRun(persisted, dropping);
  if (found === -1) {
    return {
      evicted,
      verified: false,
      reason:
        `the ${evicted} message(s) eviction would drop do not appear as a contiguous run ` +
        `anywhere in ${rawUri}, so the transcript cannot restore them`,
    };
  }

  const dangling = await firstUnresolvableReference(dropping, artifactStore, rawUri);
  if (dangling !== null) {
    return {
      evicted,
      verified: false,
      reason:
        `the dropped message(s) publish ${dangling}, which is not in the store, so restoring ` +
        `them from ${rawUri} would re-inject a pointer stub rather than the content it stands for`,
    };
  }

  return {
    evicted,
    verified: true,
    reason: `round-trip verified: the ${evicted} dropped message(s) were found at offset ${found} of ${rawUri}`,
  };
}

/**
 * The first `artifact://` URI the dropped messages reference that the store
 * cannot serve, or null when every one of them resolves.
 *
 * Existence rather than a read: a pointer the store refuses has no readable
 * form, and a store that answers `exists` for one it cannot read has already
 * broken its own contract. The raw transcript's own URI is skipped because
 * `assessEvictable` has already proved that one.
 */
async function firstUnresolvableReference(
  dropping: readonly Message[],
  artifactStore: TransactionArtifactStore,
  rawUri: string,
): Promise<string | null> {
  for (const uri of artifactUrisOfMessages(dropping)) {
    if (uri === rawUri) continue;
    let present: boolean;
    try {
      present = await artifactStore.exists(uri);
    } catch {
      return uri;
    }
    if (!present) return uri;
  }
  return null;
}

/**
 * Offset of the first place `span` occurs contiguously in `haystack`, or -1.
 *
 * Compared with `sameMessage`, so a partial match does not count: the whole
 * run has to be present, in order, for eviction to be reversible.
 */
function findRun(haystack: readonly Message[], span: readonly Message[]): number {
  if (span.length === 0) return -1;
  const last = haystack.length - span.length;
  for (let start = 0; start <= last; start++) {
    let ok = true;
    for (let i = 0; i < span.length; i++) {
      const candidate = haystack[start + i];
      const wanted = span[i];
      if (!candidate || !wanted || !sameMessage(candidate, wanted)) {
        ok = false;
        break;
      }
    }
    if (ok) return start;
  }
  return -1;
}

/**
 * Byte-equality for one message, by role, timestamp and content-block digests.
 *
 * Comparing blocks through their sha256 rather than their text means a
 * mismatch cannot be masked by a field that does not affect content, and it
 * matches how governance round-tripping is already verified elsewhere.
 */
function sameMessage(a: Message, b: Message): boolean {
  if (a.role !== b.role || a.ts !== b.ts) return false;
  if (a.content.length !== b.content.length) return false;
  return a.content.every((block, i) => {
    const other = b.content[i];
    if (!other || other.type !== block.type) return false;
    if (block.meta?.sha256 && other.meta?.sha256) {
      return block.meta.sha256 === other.meta.sha256;
    }
    return JSON.stringify(block) === JSON.stringify(other);
  });
}

/**
 * The 8-step compaction transaction (docs/architecture.md §7).
 *
 * Steps:
 * 1. Flush - ensure all pending writes (telemetry, artifacts) are durable
 * 2. Write gist - assemble gist, write to artifact store, get URI
 * 3. Validate - run validateGist with 4 invariants:
 *    4a: every changed[].path has a sha
 *    4b: unresolved_survives (the scary one round-trips)
 *    4c: constraints_byte_equal - gist constraints == pinned set (SECURITY GATE)
 *    4d: artifact_resolves - every artifact_refs[].uri resolves in store
 * 4. Commit - if validation passes, append gist to context, update turn counter
 * 5. Repin - re-apply enforcePins to new context (re-materialize governance)
 * 6. Evict - remove compacted transcript range from live context
 * 7. Log - emit telemetry gist + compaction events
 * 8. Done - return new ContextState
 *
 * Rollback on ANY failure: if step 3 validation fails, ABORT — keep original
 * transcript, emit compaction with validationPassed: false, emit violation for
 * constraints_byte_equal failure. This is a P0 event.
 */
export async function runCompactionTransaction(
  options: CompactionTransactionOptions,
): Promise<CompactionTransactionResult> {
  const {
    state: originalState,
    gist,
    policy,
    artifactStore,
    emit,
    expectedErrorCount,
    trigger,
    now = Date.now,
    rawTranscript,
    toolLog,
  } = options;

  const telemetry: StrataTelemetryEvent[] = [];

  // Step 1: FLUSH - ensure all pending writes are durable
  // Write raw transcript and tool log to artifact store
  let rawTranscriptUri: string | null = null;

  try {
    const rawResult = await artifactStore.put(rawTranscript, 'raw_transcript', { at: now() });
    rawTranscriptUri = rawResult.uri;

    await artifactStore.put(toolLog, 'tool_log', { at: now() });
  } catch (e) {
    // If flush fails, we cannot proceed - the transaction must not lose evidence
    const errorEvent: TelemetryEvent = {
      type: 'error',
      runId: originalState.runId,
      stage: 'compact',
      code: 'FLUSH_FAILED',
      message: e instanceof Error ? e.message : 'unknown flush error',
      failedOpen: true,
    };
    emit(errorEvent);
    telemetry.push(errorEvent);

    return {
      ok: false,
      state: originalState,
      gist: null,
      defects: [{ step: '4a_digests', detail: `flush failed: ${e instanceof Error ? e.message : 'unknown'}`, constraintIds: [] }],
      telemetry,
      pinIntegrity: null,
    };
  }

  // Step 2: WRITE GIST - write gist to artifact store, get URI
  // The gist's log_gist.raw_uri should point to the raw transcript we just stored
  //
  // `raw_recoverable` is stamped here for the same reason, and only here: this
  // is the only place in the transaction where the bytes exist, because step 1
  // put them there. A builder without a store leaves the claim off rather than
  // making it (see `GistDraft`, core-types/src/gist.ts), and a caller that
  // already made it loses nothing.
  // What still gates discarding anything is `assessEvictable` below, which
  // re-reads the artifact and proves the dropped messages are in it.
  const gistWithRawUri: Gist = {
    ...gist,
    log_gist: {
      ...gist.log_gist,
      raw_uri: rawTranscriptUri ?? gist.log_gist.raw_uri,
    },
    raw_recoverable: true,
  };

  try {
    const gistJson = JSON.stringify(gistWithRawUri);
    await artifactStore.put(gistJson, 'raw_transcript', { at: now() });
  } catch (e) {
    const errorEvent: TelemetryEvent = {
      type: 'error',
      runId: originalState.runId,
      stage: 'compact',
      code: 'GIST_WRITE_FAILED',
      message: e instanceof Error ? e.message : 'unknown gist write error',
      failedOpen: true,
    };
    emit(errorEvent);
    telemetry.push(errorEvent);

    return {
      ok: false,
      state: originalState,
      gist: null,
      defects: [{ step: '4a_digests', detail: `gist write failed: ${e instanceof Error ? e.message : 'unknown'}`, constraintIds: [] }],
      telemetry,
      pinIntegrity: null,
    };
  }

  // Step 3: VALIDATE - run validation with 4 invariants
  const validationDefects: ValidationDefect[] = [];
  let pinIntegrity: PinIntegrity | null = null;

  // 4a + 4b: validateGist checks schema, digests, unresolved survival, errors retained, raw_recoverable
  const schemaValidation = validateGist(gistWithRawUri, expectedErrorCount);
  if (!schemaValidation.ok) {
    for (const defect of schemaValidation.defects) {
      if (defect.kind === 'raw_not_recoverable') {
        validationDefects.push({
          step: '4a_digests',
          detail: 'raw_recoverable is not true: refusing to evict the only copy of the transcript',
          constraintIds: [],
        });
      } else if (defect.kind === 'turn_range_inverted') {
        validationDefects.push({
          step: '4b_invariants',
          detail: `source_turn_range is inverted (${defect.range[0]} > ${defect.range[1]})`,
          constraintIds: [],
        });
      } else if (defect.kind === 'errors_not_retained') {
        validationDefects.push({
          step: '4b_invariants',
          detail: `${defect.missing} ERROR/FATAL line(s) did not survive compaction`,
          constraintIds: [],
        });
      } else if (defect.kind === 'unresolved_dropped') {
        validationDefects.push({
          step: '4b_invariants',
          detail: 'unresolved[] was dropped',
          constraintIds: [],
        });
      }
    }
    // Parse failure (no gist, no defects)
    if (schemaValidation.gist === undefined && schemaValidation.defects.length === 0) {
      validationDefects.push({
        step: '4a_digests',
        detail: 'the gist does not satisfy the v1 schema',
        constraintIds: [],
      });
    }
  }

  // 4b (additional): unresolved_survives - open threads must round-trip.
  //
  // "Dropped" is only meaningful relative to a source. An empty unresolved[]
  // means either (a) the source carried open threads and the gist lost them,
  // or (b) the session had none outstanding, which is the healthy case.
  // Aborting on (b) made every default-path compaction a silent no-op:
  // GistAssembler only fills unresolved[] from a prior self-gist block, so a
  // plain "context grew too big, compact it" always produced an empty array
  // and always aborted at 4b, returning the original state at 0% savings.
  //
  // So the invariant is checked against the source: the open threads carried
  // by gists already in the context must all still be present.
  const priorUnresolved = collectPriorUnresolved(originalState.gists);
  if (schemaValidation.gist !== undefined && priorUnresolved.length > 0) {
    const kept = new Set(gistWithRawUri.unresolved.map((u) => u.trim().toLowerCase()));
    const lost = priorUnresolved.filter((u) => !kept.has(u.trim().toLowerCase()));
    if (lost.length > 0) {
      validationDefects.push({
        step: '4b_invariants',
        detail: `unresolved[] dropped ${lost.length} open thread(s): ${lost.slice(0, 3).join(' | ')}`,
        constraintIds: [],
      });
    }
  }

  // 4c: SECURITY GATE - constraints_byte_equal
  // Compare gist constraints byte-wise against pinned set from policy
  const expectedConstraints = pinSetText(policy);
  pinIntegrity = verifyPinIntegrity(expectedConstraints, gistWithRawUri.constraints);
  if (!pinIntegrity.ok) {
    for (const defect of pinIntegrity.defects) {
      const constraintIds = defect.kind === 'extra'
        ? []
        : policy.constraints
            .filter((c) => c.text === defect.text)
            .map((c) => c.id);
      validationDefects.push({
        step: '4c_constraint_bytes',
        detail:
          defect.kind === 'missing'
            ? 'the gist is missing a pinned constraint'
            : defect.kind === 'extra'
            ? 'the gist carries a constraint that policy never declared'
            : 'the gist reordered the constraint set',
        constraintIds,
      });
    }
  }

  // 4d: artifact_resolves - every artifact_refs[].uri resolves in store
  //
  // Parse before asking, for the same reason `assessEvictable` does above:
  // `ArtifactStore.exists` hands the string to `parseArtifactUri` (acl.ts:194)
  // and lets a refusal propagate, so asking it about a string that is not a URI
  // throws out of the transaction instead of describing the artifact. A gist's
  // `artifacts[]` is attacker-controlled (acl.ts:16-19), so "that is not a
  // pointer" is an answer this step has to be able to give -- it is the whole
  // reason 4d exists.
  //
  // Parseability rather than resolvability, because `putNamed` mints named URIs
  // that `exists` answers for: requiring a digest here would report artifacts
  // the store can serve.
  for (const artifact of gistWithRawUri.artifacts) {
    const refusal = artifactUriRefusal(artifact.uri);
    if (refusal !== null) {
      validationDefects.push({
        step: '4d_artifacts',
        detail: `artifact "${artifact.uri}" is not a reference the artifact store can parse (${refusal}), so it cannot resolve`,
        constraintIds: [],
      });
      continue;
    }
    let present: boolean;
    try {
      present = await artifactStore.exists(artifact.uri);
    } catch (e) {
      // A store that cannot be asked is not a store that holds nothing, and
      // the two defects mean different things to whoever has to fix them.
      validationDefects.push({
        step: '4d_artifacts',
        detail: `the artifact store threw while resolving "${artifact.uri}": ${e instanceof Error ? e.message : 'unknown'}`,
        constraintIds: [],
      });
      continue;
    }
    if (!present) {
      validationDefects.push({
        step: '4d_artifacts',
        detail: `artifact ${artifact.uri} does not resolve in the store`,
        constraintIds: [],
      });
    }
  }

  // If validation failed, ABORT - rollback
  if (validationDefects.length > 0) {
    // Emit violation for constraints_byte_equal failure (P0 event)
    const constraintViolation = validationDefects.find((d) => d.step === '4c_constraint_bytes');
    if (constraintViolation) {
      const violationEvent: TelemetryEvent = {
        type: 'violation',
        runId: originalState.runId,
        kind: 'pin_post_compact_missing',
        constraintIds: constraintViolation.constraintIds,
        blocked: true,
      };
      emit(violationEvent);
      telemetry.push(violationEvent);
    }

    // Emit gist event with validation failure
    const gistEvent: GistEvent = {
      type: 'gist',
      runId: originalState.runId,
      taskId: gistWithRawUri.task_id,
      schemaValid: schemaValidation.ok,
      constraintsIntact: pinIntegrity?.ok ?? false,
      rawRecoverable: gistWithRawUri.raw_recoverable === true,
      compressionBy: gistWithRawUri.compressed_by,
      failed: validationDefects.map((d) => d.step),
    };
    emit(gistEvent);
    telemetry.push(gistEvent);

    // Emit compaction event with validationPassed: false
    const compactionEvent: TelemetryEvent = {
      type: 'compaction',
      runId: originalState.runId,
      trigger,
      beforeTokens: originalState.tokenEstimate,
      afterTokens: originalState.tokenEstimate,
      droppedCount: 0,
      compressionBy: gistWithRawUri.compressed_by,
      validationPassed: false,
    };
    emit(compactionEvent);
    telemetry.push(compactionEvent);

    return {
      ok: false,
      state: originalState,
      gist: null,
      defects: validationDefects,
      telemetry,
      pinIntegrity,
    };
  }

  // Step 4: COMMIT - append gist to context, update turn counter
  const gistMessage: Message = {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: `gist://${gistWithRawUri.task_id}`,
        meta: {
          origin: 'synthetic',
          sha256: await computeSha256(`gist://${gistWithRawUri.task_id}`),
          tier: 'artifact_ref',
          bytes: `gist://${gistWithRawUri.task_id}`.length,
          cacheable: false,
        },
      },
    ],
    ts: now(),
  };

  let newState: ContextState = {
    ...originalState,
    messages: [...originalState.messages, gistMessage],
    gists: [...originalState.gists, gistWithRawUri],
    turn: originalState.turn + 1,
    tokenEstimate: originalState.tokenEstimate + (gistMessage.content[0]?.meta.bytes ?? 0),
  };

  // Step 5: REPIN - re-apply enforcePins to new context
  const pinApplication = enforcePins(newState, policy);
  newState = pinApplication.state;

  // Step 6: EVICT - drop the compacted transcript, keeping governance and the gist
  //
  // Eviction is the only irreversible step: afterwards the dropped messages
  // exist solely in the raw artifact. So it is gated on the artifact holding
  // them intact. When it does not, compaction still commits (the gist and the
  // repin are sound) but the transcript is kept, because holding a larger
  // context is recoverable and losing the only copy is not.
  //
  // The drop set is chosen by identity, not by index: everything that is not
  // a governance message and not the gist just committed. Index arithmetic
  // cannot be used here because step 5 repin collapses governance blocks into a
  // single system message, which shifts every offset after them.
  const isGovernanceMessage = (message: Message): boolean =>
    message.content.length > 0 && message.content.every((block) => block.meta.tier === 'governance');

  const gistMessageAdded = newState.messages[newState.messages.length - 1];
  if (!gistMessageAdded) {
    throw new Error('gist message not found after commit');
  }

  const keep = newState.messages.filter(
    (message, index) =>
      index === newState.messages.length - 1 || isGovernanceMessage(message),
  );
  const dropping = newState.messages.filter(
    (message, index) =>
      index !== newState.messages.length - 1 && !isGovernanceMessage(message),
  );

  const evictable = await assessEvictable(dropping, artifactStore, gistWithRawUri);

  let evicted = 0;
  if (evictable.verified) {
    newState = {
      ...newState,
      messages: keep,
      // Recalculate token estimate after eviction
      tokenEstimate: keep.reduce((acc, msg) => acc + msg.content.reduce((sum, block) => sum + block.meta.bytes, 0), 0),
    };
    evicted = evictable.evicted;
  } else {
    // Reported as an error rather than a violation: no pinned constraint was
    // breached, the transcript just is not safe to discard yet.
    const evictionSkipped: TelemetryEvent = {
      type: 'error',
      runId: originalState.runId,
      stage: 'compact',
      code: EVICTION_SKIPPED_CODE,
      message: `${evictable.reason}; kept ${newState.messages.length} message(s) instead of evicting ${evictable.evicted}`,
      failedOpen: false,
    };
    telemetry.push(evictionSkipped);
    emit(evictionSkipped);
  }

  // Step 7: LOG - emit telemetry gist + compaction events
  const gistEvent: GistEvent = {
    type: 'gist',
    runId: originalState.runId,
    taskId: gistWithRawUri.task_id,
    schemaValid: true,
    constraintsIntact: true,
    rawRecoverable: gistWithRawUri.raw_recoverable === true && evictable.verified,
    compressionBy: gistWithRawUri.compressed_by,
    // A skipped eviction is not a validation failure, so it is reported here
    // rather than aborting: the commit stands, only the size win is deferred.
    failed: evictable.verified ? [] : [`${EVICTION_SKIPPED_PREFIX} ${evictable.reason}`],
  };
  emit(gistEvent);
  telemetry.push(gistEvent);

  const droppedCount = evicted;
  const compactionEvent: TelemetryEvent = {
    type: 'compaction',
    runId: originalState.runId,
    trigger,
    beforeTokens: originalState.tokenEstimate,
    afterTokens: newState.tokenEstimate,
    droppedCount,
    compressionBy: gistWithRawUri.compressed_by,
    validationPassed: true,
  };
  emit(compactionEvent);
  telemetry.push(compactionEvent);

  // Step 8: DONE - return new ContextState
  return {
    ok: true,
    state: newState,
    gist: gistWithRawUri,
    defects: [],
    telemetry,
    pinIntegrity,
  };
}

/**
 * Compute SHA-256 hash of a string.
 */
async function computeSha256(input: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(input, 'utf8').digest('hex');
}