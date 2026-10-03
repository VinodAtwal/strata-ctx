import type { TelemetryEvent } from '@strata-ctx/core-types';

/**
 * G-1: the event schema, and G-3: the compaction and gist events.
 *
 * ## What is reused and what is proposed
 *
 * Everything the frozen contract already expresses is reused verbatim: the
 * `TelemetryEvent` union in `core-types/src/telemetry.ts` is the event schema,
 * and this module does not restate it. It is closed, though, and the contract was
 * frozen at A-5 before this package existed (contract.lock.json, semver-locked
 * at 1.0.0). Two things architecture §8 requires have no member in it:
 *
 * - `gist { schema_valid, constraints_intact, raw_recoverable, compression_by }`
 *   -- §8 lists it as its own line, and step 4 of the transaction (docs/
 *   architecture.md §5) produces exactly those four booleans. The frozen
 *   `compaction` member carries `validationPassed` as a single collapsed flag,
 *   which cannot answer "did the summarizer keep the pins?" on its own.
 * - a savings record. The frozen `cost` member is dimensionless (r, eps, rho, k);
 *   E5's gate G7 is on *net* dollars, and there is nowhere to put a dollar sign.
 *
 * Both are declared here, marked as proposed, and additive: no existing member
 * changes, so they can move into core-types as a semver-minor without touching
 * a single existing call site. See the final report.
 *
 * ## Why there is an envelope
 *
 * The on-disk record is `{ v, seq, at, event }` rather than a flattened event.
 *
 * - `v` so a reader written against this schema can tell whether it understands
 *   a future record, instead of silently mis-parsing a field that changed
 *   meaning. The contract-freeze lesson is the whole point of this project; a
 *   telemetry format with no version is a future postmortem.
 * - `seq` because JSONL has no ordering guarantee across processes and the
 *   reading tools here must be able to say "you are missing line 41" instead of
 *   reporting a silently short log. A hole in a violation log is exactly the
 *   failure governance/violations.ts warns about: "0% violations" from a
 *   pipeline that stopped recording.
 * - `at` is wall-clock from an *injected* clock. Business logic here never calls
 *   Date.now() itself (N6: same input => byte-identical output).
 */

/** Bumped only on a breaking change to the record shape or the event payloads. */
export const TELEMETRY_SCHEMA_VERSION = 1;

export type GistCompressionBy = 'self-gist' | 'local-model' | 'none';

/**
 * PROPOSED CONTRACT ADDITION (additive; see the module doc).
 *
 * C-6: Offline consolidation / dreaming. Emitted when a dreaming run completes.
 * Captures the clustering outcome and whether constraints were preserved.
 */
export interface ConsolidationEvent {
  readonly type: 'consolidation';
  readonly runId: string;
  readonly clustersFormed: number;
  readonly metaGistsCreated: number;
  readonly gistsEvicted: number;
  readonly constraintsPreserved: boolean;
  readonly durationMs: number;
}

/**
 * PROPOSED CONTRACT ADDITION (additive; see the module doc).
 *
 * §8: `gist { schema_valid, constraints_intact, raw_recoverable, compression_by }`.
 * Emitted at step 4 of the transaction -- *before* the `compaction` record, which
 * is step 8 -- because a validation failure aborts the compaction and there is
 * then no compaction to log. Emitting in the other order would lose the abort.
 */
export interface GistEvent {
  readonly type: 'gist';
  readonly runId: string;
  readonly taskId: string;
  /** Step 4a-d: the whole validation, or the specific invariant that failed. */
  readonly schemaValid: boolean;
  /** Step 4c, the security gate. False means the transaction aborted. */
  readonly constraintsIntact: boolean;
  /** Step 7's precondition: may the raw range be evicted? */
  readonly rawRecoverable: boolean;
  readonly compressionBy: GistCompressionBy;
  /** Named invariants that failed, so an abort says *why* and not just "no". */
  readonly failed: readonly string[];
}

/** Gate outcome for net savings. `unknown` is a real answer, not a pass. */
export type SavingsGate = 'pass' | 'fail' | 'unknown';

/**
 * PROPOSED CONTRACT ADDITION (additive; see the module doc).
 *
 * G7 lives or dies on this. `grossSavedUsd` is the number that flatters the
 * product; `netSavedUsd` is gross minus everything *we* spent computing the
 * saving (gist narration, canary probes). They are separate fields rather than
 * one `savings` field precisely because a single number invites the flattering
 * one to be reported.
 */
export interface SavingsEvent {
  readonly type: 'savings';
  readonly runId: string;
  readonly model: string;
  /** Cost of the same workload uncompressed. The denominator of the fractions. */
  readonly baselineUsd: number;
  readonly grossSavedUsd: number;
  /** What computing the saving cost: gist + probes, never negative. */
  readonly overheadUsd: number;
  /** gross - overhead. **Legitimately negative.** */
  readonly netSavedUsd: number;
  readonly grossFraction: number;
  /** null when the baseline cannot be priced, which is not the same as 0. */
  readonly netFraction: number | null;
  /** E5's per-category token attribution. */
  readonly tokensByCategory: Readonly<Record<string, number>>;
  readonly gate: SavingsGate;
}

/** The frozen union plus the two additive proposals above. */
export type StrataTelemetryEvent = TelemetryEvent | GistEvent | SavingsEvent | ConsolidationEvent;

export type StrataEventType = StrataTelemetryEvent['type'];

export const STRATA_EVENT_TYPES: readonly StrataEventType[] = Object.freeze([
  'request_in',
  'stage',
  'pin',
  'compaction',
  'gist',
  'canary',
  'violation',
  'cache',
  'cost',
  'savings',
  'consolidation',
  'error',
]);

/** One line of the JSONL sink. */
export interface TelemetryRecord {
  readonly v: number;
  /** Monotonic per sink, starting at 0. Gaps mean a lost write, not a reorder. */
  readonly seq: number;
  /** Epoch ms, from the injected clock. */
  readonly at: number;
  readonly event: StrataTelemetryEvent;
}

export class TelemetrySchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelemetrySchemaError';
  }
}

/**
 * Required fields per event type, beyond the discriminator.
 *
 * A sink that accepts anything is a sink that will eventually be read by a
 * dashboard that divides by an `undefined` and reports a 100% violation rate.
 * The check is structural and cheap; it runs on emit *and* on read, so a
 * hand-edited or truncated file is reported rather than believed.
 */
const REQUIRED_FIELDS: Readonly<Record<StrataEventType, readonly string[]>> = Object.freeze({
  request_in: ['runId', 'turn', 'inputTokens', 'messages'],
  stage: ['runId', 'stage', 'bytesIn', 'bytesOut', 'blocksIn', 'blocksOut', 'durationMs', 'changed'],
  pin: ['runId', 'missingBefore', 'constraints'],
  compaction: [
    'runId',
    'trigger',
    'beforeTokens',
    'afterTokens',
    'droppedCount',
    'compressionBy',
    'validationPassed',
  ],
  gist: [
    'runId',
    'taskId',
    'schemaValid',
    'constraintsIntact',
    'rawRecoverable',
    'compressionBy',
    'failed',
  ],
  canary: ['probeId', 'kind', 'arm', 'score', 'passed'],
  violation: ['runId', 'kind', 'constraintIds', 'blocked'],
  cache: ['runId', 'prefixHit', 'prefixInvalidated'],
  cost: ['runId', 'r', 'eps', 'rho', 'k', 'breakevenOk'],
  savings: [
    'runId',
    'model',
    'baselineUsd',
    'grossSavedUsd',
    'overheadUsd',
    'netSavedUsd',
    'grossFraction',
    'netFraction',
    'tokensByCategory',
    'gate',
  ],
  error: ['runId', 'stage', 'code', 'message', 'failedOpen'],
  consolidation: [
    'runId',
    'clustersFormed',
    'metaGistsCreated',
    'gistsEvicted',
    'constraintsPreserved',
    'durationMs',
  ],
});

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Number-or-null: `netFraction` is null when the baseline is unpriceable. */
const isNumberOrNull = (v: unknown): boolean => v === null || typeof v === 'number';

/**
 * Required fields whose value must be a finite number, and those that must be
 * a boolean.
 *
 * Presence alone is not a schema. With only `REQUIRED_FIELDS`, a hand-edited
 * line carrying `turn: "nope"` is accepted, and then `buildStatus` executes
 * `turns += event.turn` on it -- which string-concatenates and produces a
 * `turns` field that is the text `0nope`. That is precisely the failure the
 * comment above `REQUIRED_FIELDS` names: a dashboard dividing by `undefined`
 * and reporting 100%, except the value is worse than `undefined` because it
 * still looks like a number on the way in.
 *
 * `validationPassed: "yes"` is the same bug wearing a hat: `!event
 * .validationPassed` is false, so a compaction whose gist never validated
 * reports as a clean one.
 */
const NUMERIC_FIELDS: ReadonlySet<string> = Object.freeze(
  new Set([
    'turn',
    'inputTokens',
    'messages',
    'bytesIn',
    'bytesOut',
    'blocksIn',
    'blocksOut',
    'durationMs',
    'missingBefore',
    'constraints',
    'beforeTokens',
    'afterTokens',
    'droppedCount',
    'score',
    'r',
    'eps',
    'rho',
    'k',
    'baselineUsd',
    'grossSavedUsd',
    'overheadUsd',
    'netSavedUsd',
    'grossFraction',
    'clustersFormed',
    'metaGistsCreated',
    'gistsEvicted',
  ]),
);

const BOOLEAN_FIELDS: ReadonlySet<string> = Object.freeze(
  new Set([
    'changed',
    'schemaValid',
    'constraintsIntact',
    'rawRecoverable',
    'validationPassed',
    'passed',
    'blocked',
    'prefixHit',
    'prefixInvalidated',
    'breakevenOk',
    'failedOpen',
    'constraintsPreserved',
  ]),
);

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function isStrataTelemetryEvent(v: unknown): v is StrataTelemetryEvent {
  if (!isRecord(v)) return false;
  const type = v['type'];
  if (typeof type !== 'string') return false;
  // The explicit membership test rather than a cast: an unknown `type` is
  // schema drift, and reading it as an event of some member would be exactly
  // the silent mis-parse `v` exists to prevent.
  if (!(STRATA_EVENT_TYPES as readonly string[]).includes(type)) return false;
  const required = REQUIRED_FIELDS[type as StrataEventType];
  for (const field of required) {
    if (!(field in v)) return false;
    const value = v[field];
    if (NUMERIC_FIELDS.has(field) && !isFiniteNumber(value)) return false;
    if (BOOLEAN_FIELDS.has(field) && typeof value !== 'boolean') return false;
  }
  if (type === 'savings' && !isNumberOrNull(v['netFraction'])) return false;
  return true;
}

export function makeRecord(seq: number, at: number, event: StrataTelemetryEvent): TelemetryRecord {
  if (!Number.isInteger(seq) || seq < 0) {
    throw new TelemetrySchemaError(`seq must be a non-negative integer, got ${String(seq)}`);
  }
  if (!Number.isFinite(at)) {
    throw new TelemetrySchemaError(`at must be a finite epoch-ms timestamp, got ${String(at)}`);
  }
  if (!isStrataTelemetryEvent(event)) {
    throw new TelemetrySchemaError('refusing to record an event that does not match the schema');
  }
  return Object.freeze({ v: TELEMETRY_SCHEMA_VERSION, seq, at, event: Object.freeze(event) });
}

/**
 * Run id for a record, when the event type has one. Canary events are keyed by
 * probe id instead, so this returns undefined rather than inventing a run.
 */
export function recordRunId(record: TelemetryRecord): string | undefined {
  const runId = (record.event as { readonly runId?: unknown }).runId;
  return typeof runId === 'string' ? runId : undefined;
}

// --- G-3: compaction and gist ------------------------------------------------

export interface CompactionOutcome {
  readonly runId: string;
  /** Free-form and machine-readable: 'task_boundary', 'soft_limit', ... */
  readonly trigger: string;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly droppedCount: number;
  readonly compressionBy: GistCompressionBy;
  /**
   * The transaction's step 4 in one bit. The per-invariant detail lives on the
   * `gist` record, which is emitted first precisely so that a `false` here can
   * be read next to its reason.
   */
  readonly validationPassed: boolean;
}

export function compactionEvent(outcome: CompactionOutcome): TelemetryEvent {
  return {
    type: 'compaction',
    runId: outcome.runId,
    trigger: outcome.trigger,
    beforeTokens: outcome.beforeTokens,
    afterTokens: outcome.afterTokens,
    droppedCount: outcome.droppedCount,
    compressionBy: outcome.compressionBy,
    validationPassed: outcome.validationPassed,
  };
}

export interface GistValidation {
  readonly runId: string;
  readonly taskId: string;
  readonly schemaValid: boolean;
  /** Step 4c, the security gate. */
  readonly constraintsIntact: boolean;
  readonly rawRecoverable: boolean;
  readonly compressionBy: GistCompressionBy;
  /**
   * The named invariants that failed, from step 4's a-d. An empty list with
   * `schemaValid: true` is the only healthy reading; a non-empty list is the
   * reason the transaction aborted and the transcript was kept.
   */
  readonly failed?: readonly string[];
}

export function gistEvent(validation: GistValidation): GistEvent {
  return {
    type: 'gist',
    runId: validation.runId,
    taskId: validation.taskId,
    schemaValid: validation.schemaValid,
    constraintsIntact: validation.constraintsIntact,
    rawRecoverable: validation.rawRecoverable,
    compressionBy: validation.compressionBy,
    failed: Object.freeze([...(validation.failed ?? [])]),
  };
}

/** The invariant names step 4 checks, in order. */
export const GIST_INVARIANTS: readonly string[] = Object.freeze([
  'changed_sha', // 4a  every changed[].path has a sha
  'unresolved_survives', // 4b  the scary one round-trips
  'constraints_byte_equal', // 4c  SECURITY GATE
  'artifact_resolves', // 4d  artifacts[].uri resolves in the store
]);

/**
 * The `code` the transaction puts on the `error` event it emits when step 6
 * refuses to evict (`gist/src/transaction.ts:683`).
 *
 * A skipped eviction is the step-6 refusal: the commit stands, nothing is lost,
 * and the transcript stays in the context. It is the answer to "nothing was
 * evicted, here is why", and until `strata status` can count it by this string
 * the only trace is a free-form code that nothing in the repo named.
 *
 * Declared here rather than in `gist` because this is the telemetry package's
 * vocabulary and `status.ts` reads it: a status report that recognises a
 * refusal by string equality against a literal in a package it cannot import is
 * a report that breaks the first time somebody improves the wording. The
 * *value* is frozen against logs already on disk -- renaming the code orphans
 * every existing record -- so changing it needs a reader that accepts both.
 */
export const EVICTION_SKIPPED_CODE = 'EVICTION_SKIPPED_UNVERIFIED';

/**
 * The prefix on the `failed:` entry a skipped eviction writes into the `gist`
 * event (`gist/src/transaction.ts:705`).
 *
 * Two spellings of one fact, and the reason the reason survives: the `error`
 * event's `message` is operator prose (`<reason>; kept N message(s) instead of
 * evicting M`) while this one is the bare reason, so a reader can surface the
 * cause without parsing a sentence.
 */
export const EVICTION_SKIPPED_PREFIX = 'eviction_skipped:';

/** The bare reason on a `failed:` entry, or undefined when it is not one. */
export function evictionSkipReason(failed: readonly string[]): string | undefined {
  const entry = failed.find((f) => f.startsWith(EVICTION_SKIPPED_PREFIX));
  if (entry === undefined) return undefined;
  return entry.slice(EVICTION_SKIPPED_PREFIX.length).trim();
}

/**
 * Emits the pair in transaction order: validation (step 4) then the outcome
 * (step 8). Returns what it emitted so a caller can assert on it without
 * reaching into the sink.
 */
export function emitCompaction(
  emit: (event: StrataTelemetryEvent) => void,
  input: { readonly validation: GistValidation; readonly outcome: CompactionOutcome },
): readonly StrataTelemetryEvent[] {
  const gist = gistEvent(input.validation);
  const compaction = compactionEvent(input.outcome);
  emit(gist);
  emit(compaction);
  return Object.freeze([gist, compaction]);
}
