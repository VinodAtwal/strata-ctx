import type {
  ArtifactRef,
  ContextState,
  Gist,
  Message,
  PinIntegrity,
  StrataPolicy,
  TelemetryEvent,
} from '@strata-ctx/core-types';
import { enforcePins, verifyPinIntegrity, validateGist, pinSetText } from '@strata-ctx/core-types';
import type { ReadResult } from '@strata-ctx/security';
import type { StrataTelemetryEvent, GistEvent } from '@strata-ctx/telemetry';

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
  /** The gist to compact into the context. */
  readonly gist: Gist;
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
  const gistWithRawUri: Gist = {
    ...gist,
    log_gist: {
      ...gist.log_gist,
      raw_uri: rawTranscriptUri ?? gist.log_gist.raw_uri,
    },
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
  for (const artifact of gistWithRawUri.artifacts) {
    const exists = await artifactStore.exists(artifact.uri);
    if (!exists) {
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

  // Step 6: EVICT - remove compacted transcript range from live context
  const [fromTurn, toTurn] = gistWithRawUri.source_turn_range;
  // Keep messages before fromTurn and after toTurn
  // Also keep the new gist message we just added (at the end)
  const messagesBeforeRange = newState.messages.slice(0, fromTurn);
  const messagesAfterRange = newState.messages.slice(toTurn + 1, newState.messages.length - 1);
  const gistMessageAdded = newState.messages[newState.messages.length - 1];

  if (!gistMessageAdded) {
    throw new Error('gist message not found after commit');
  }

  const remainingMessages = [...messagesBeforeRange, ...messagesAfterRange, gistMessageAdded];
  newState = {
    ...newState,
    messages: remainingMessages,
    // Recalculate token estimate after eviction
    tokenEstimate: remainingMessages.reduce((acc, msg) => acc + msg.content.reduce((sum, block) => sum + block.meta.bytes, 0), 0),
  };

  // Step 7: LOG - emit telemetry gist + compaction events
  const gistEvent: GistEvent = {
    type: 'gist',
    runId: originalState.runId,
    taskId: gistWithRawUri.task_id,
    schemaValid: true,
    constraintsIntact: true,
    rawRecoverable: gistWithRawUri.raw_recoverable === true,
    compressionBy: gistWithRawUri.compressed_by,
    failed: [],
  };
  emit(gistEvent);
  telemetry.push(gistEvent);

  const droppedCount = toTurn - fromTurn + 1;
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