import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { costTelemetry } from '@strata-ctx/core-types';

import type {
  SavingsEvent,
  StrataTelemetryEvent,
  TelemetryRecord,
} from '../src/index.js';
import type { CompactionOutcome as LocalCompactionOutcome, GistValidation as LocalGistValidation } from '../src/events.js';
import type { ModelPricing, PricingTable, TokenUsage } from '../src/index.js';
import {
  PRICING_TABLE,
  epochMsToIsoDate,
  makeRecord,
  pricingFreshness,
  usage as tokenUsage,
} from '../src/index.js';

/**
 * Local fixtures for this package. Rule P2: no cross-stream test fixtures, so
 * nothing here imports another package's test directory (development §2).
 *
 * ## The one thing every fixture in this file obeys
 *
 * No wall clock. `NOW` is a fixed instant and `clock()` steps forward from it,
 * so a test that writes three records gets three known timestamps and the whole
 * suite is reproducible on any machine in any timezone. That is not
 * fastidiousness: N6 (same input => byte-identical output) is a *product*
 * requirement, and a suite that cannot reproduce its own bytes cannot be used
 * to check it.
 */

/** 2023-11-14T22:13:20.000Z. Arbitrary, fixed, and not near a DST boundary. */
export const NOW = 1_700_000_000_000;

export const RUN = 'run-1';
export const RUN_2 = 'run-2';
export const TASK = 'task-42';

/**
 * A monotonically increasing clock. Starts at `start` and advances `stepMs` on
 * every read, so consecutive records are strictly ordered -- which is what
 * makes "was anything written out of order" a testable question.
 */
export function clock(start: number = NOW, stepMs = 1000): () => number {
  let t = start;
  return () => {
    const value = t;
    t += stepMs;
    return value;
  };
}

/** A clock that never moves, for the cases where equal timestamps are correct. */
export const frozenClock = (at: number = NOW): (() => number) => () => at;

export function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'strata-telemetry-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

export function logPath(dir: string, name = 'telemetry.jsonl'): string {
  return join(dir, name);
}

/** Raw file bytes. Assertions about what is *not* on disk read through this. */
export function fileBytes(path: string): Buffer {
  return readFileSync(path);
}

export function fileText(path: string): string {
  return readFileSync(path, 'utf8');
}

export function fileLines(path: string): string[] {
  return fileText(path).split('\n').filter((l) => l !== '');
}

export function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

// --- events ------------------------------------------------------------------

export const requestIn = (over: Partial<Extract<StrataTelemetryEvent, { type: 'request_in' }>> = {}) =>
  ({
    type: 'request_in',
    runId: RUN,
    turn: 1,
    inputTokens: 10_000,
    messages: 4,
    ...over,
  }) satisfies Extract<StrataTelemetryEvent, { type: 'request_in' }>;

/**
 * Typed off the event union rather than off `StageTelemetry`, like every other
 * fixture here: `StageTelemetry` is the payload, so `Partial<StageTelemetry>`
 * cannot express `runId`, and a per-run `stage` record is exactly what the
 * per-request report has to be testable against.
 */
export const stage = (
  over: Partial<Extract<StrataTelemetryEvent, { type: 'stage' }>> = {},
): StrataTelemetryEvent => ({
  type: 'stage',
  runId: RUN,
  stage: 'dedupe',
  bytesIn: 1000,
  bytesOut: 900,
  blocksIn: 10,
  blocksOut: 8,
  durationMs: 2,
  changed: true,
  ...over,
});

export const pin = (over: Partial<Extract<StrataTelemetryEvent, { type: 'pin' }>> = {}) =>
  ({
    type: 'pin',
    runId: RUN,
    missingBefore: 0,
    constraints: 2,
    ...over,
  }) satisfies Extract<StrataTelemetryEvent, { type: 'pin' }>;

export const compaction = (
  over: Partial<LocalCompactionOutcome> = {},
): StrataTelemetryEvent => ({
  type: 'compaction',
  runId: RUN,
  trigger: 'task_boundary',
  beforeTokens: 120_000,
  afterTokens: 40_000,
  droppedCount: 180,
  compressionBy: 'self-gist',
  validationPassed: true,
  ...over,
});

export const gist = (over: Partial<LocalGistValidation> = {}) =>
  ({
    type: 'gist',
    runId: RUN,
    taskId: TASK,
    schemaValid: true,
    constraintsIntact: true,
    rawRecoverable: true,
    compressionBy: 'self-gist',
    failed: [],
    ...over,
  }) satisfies StrataTelemetryEvent;

/** Local-type versions for emitCompaction tests. */
export const compactionOutcome = (
  over: Partial<LocalCompactionOutcome> = {},
): LocalCompactionOutcome => ({
  runId: RUN,
  trigger: 'task_boundary',
  beforeTokens: 120_000,
  afterTokens: 40_000,
  droppedCount: 180,
  compressionBy: 'self-gist',
  validationPassed: true,
  ...over,
});

export const gistValidation = (over: Partial<LocalGistValidation> = {}): LocalGistValidation => ({
  runId: RUN,
  taskId: TASK,
  schemaValid: true,
  constraintsIntact: true,
  rawRecoverable: true,
  compressionBy: 'self-gist',
  failed: [],
  ...over,
});

export const canary = (over: Partial<Extract<StrataTelemetryEvent, { type: 'canary' }>> = {}) =>
  ({
    type: 'canary',
    probeId: 'probe-1',
    kind: 'constraint',
    arm: 'treatment',
    score: 1,
    passed: true,
    ...over,
  }) satisfies Extract<StrataTelemetryEvent, { type: 'canary' }>;

export const violation = (
  over: Partial<Extract<StrataTelemetryEvent, { type: 'violation' }>> = {},
): StrataTelemetryEvent => ({
  type: 'violation',
  runId: RUN,
  kind: 'pin_missing_pre_apply',
  constraintIds: ['c2'],
  blocked: true,
  ...over,
});

export const cache = (over: Partial<Extract<StrataTelemetryEvent, { type: 'cache' }>> = {}) =>
  ({
    type: 'cache',
    runId: RUN,
    prefixHit: true,
    prefixInvalidated: false,
    ...over,
  }) satisfies Extract<StrataTelemetryEvent, { type: 'cache' }>;

/**
 * A `cost` event built through the *frozen* `costTelemetry`, so a fixture can
 * never drift from the contract the sink validates against.
 */
export const cost = (over: {
  readonly runId?: string;
  readonly r?: number;
  readonly eps?: number;
  readonly rho?: number;
  readonly k?: number;
} = {}): StrataTelemetryEvent => ({
  type: 'cost',
  runId: RUN,
  ...costTelemetry(over.r ?? 0.5, over.eps ?? 1, over.rho ?? 5, over.k ?? 0.1),
});

export const failure = (
  over: Partial<Extract<StrataTelemetryEvent, { type: 'error' }>> = {},
): StrataTelemetryEvent => ({
  type: 'error',
  runId: RUN,
  stage: 'compact',
  code: 'E_GIST_INVALID',
  message: 'gist validation failed',
  failedOpen: true,
  ...over,
});

export const savings = (over: Partial<SavingsEvent> = {}): SavingsEvent => ({
  type: 'savings',
  runId: RUN,
  model: 'fixture-standard',
  baselineUsd: 1,
  grossSavedUsd: 0.5,
  overheadUsd: 0.1,
  netSavedUsd: 0.4,
  grossFraction: 0.5,
  netFraction: 0.4,
  tokensByCategory: {
    input_saved: 10_000,
    gist_out: 200,
    probe_in: 0,
    probe_out: 0,
    compaction_out: 0,
  },
  gate: 'pass',
  ...over,
});

export const consolidation = (over: Partial<Extract<StrataTelemetryEvent, { type: 'consolidation' }>> = {}) =>
  ({
    type: 'consolidation',
    runId: RUN,
    clustersFormed: 2,
    metaGistsCreated: 1,
    gistsEvicted: 0,
    constraintsPreserved: true,
    durationMs: 1500,
    ...over,
  }) satisfies StrataTelemetryEvent;

/** One event per `type`, for the schema-coverage sweep. */
export const ONE_OF_EVERY_TYPE: readonly StrataTelemetryEvent[] = Object.freeze([
  requestIn(),
  stage(),
  pin(),
  compaction(),
  gist(),
  canary(),
  violation(),
  cache(),
  cost(),
  savings(),
  failure(),
  consolidation(),
]);

/** Records, for the pure report builders. */
export function recordsOf(
  events: readonly StrataTelemetryEvent[],
  startSeq = 0,
  at = NOW,
): readonly TelemetryRecord[] {
  return Object.freeze(events.map((event, i) => makeRecord(startSeq + i, at + i, event)));
}

/**
 * Presents an arbitrary value as an event, for the negative cases.
 *
 * The cast is deliberate and lives here so the negative tests read as prose.
 * There is no type that means "a value the schema must reject" without also
 * lying about the values it must accept, and a negative test is exactly the
 * one place where the type system's opinion is the thing under test.
 */
export function asEvent(value: unknown): StrataTelemetryEvent {
  return value as StrataTelemetryEvent;
}

/** A number-typed value carrying something that is not a number. Same reasoning. */
export function asNumber(value: unknown): number {
  return value as number;
}

// --- pricing -----------------------------------------------------------------

function rowOf(model: string): ModelPricing {
  const row = PRICING_TABLE.models[model];
  if (row === undefined) throw new Error(`the fixture pricing table has no row for ${model}`);
  return row;
}

export const FRONTIER: ModelPricing = rowOf('fixture-frontier');
export const STANDARD: ModelPricing = rowOf('fixture-standard');
export const LOCAL: ModelPricing = rowOf('fixture-local');

export function pricingRow(over: Partial<ModelPricing> = {}): ModelPricing {
  return { ...STANDARD, model: 'test-model', ...over };
}

export function pricingTable(over: Partial<PricingTable> = {}): PricingTable {
  const model = over.models?.['test-model'] ?? pricingRow();
  return { ...PRICING_TABLE, ...over, models: { 'test-model': model, ...over.models } };
}

/**
 * The "today" the pricing tests read.
 *
 * Deliberately *not* `epochMsToIsoDate(NOW)`. `NOW` exists to freeze the sink's
 * clock, and it predates the shipped table's `verifiedOn` -- so using it here
 * would put every table in the `verified_in_the_future` branch and quietly turn
 * the boundary tests into tests of the future-date guard. The two concerns need
 * two clocks.
 */
export const TODAY = '2026-04-01';

/**
 * A table with exactly `ageDays` between `verifiedOn` and `today`.
 *
 * Built by subtracting real days from a real date rather than by string
 * arithmetic, so the 90-day boundary is tested against the same calendar the
 * production code reads, leap years and month ends included.
 */
export function tableAged(days: number, today: string = TODAY): PricingTable {
  const verified = epochMsToIsoDate(Date.parse(`${today}T00:00:00.000Z`) - days * 86_400_000);
  return pricingTable({ verifiedOn: verified, models: { 'test-model': pricingRow({ verifiedOn: verified }) } });
}

export function freshnessAt(ageDays: number, today: string = TODAY) {
  return pricingFreshness(tableAged(ageDays, today), today);
}

// --- cost / savings ----------------------------------------------------------

export function usage(inputTokens: number, outputTokens: number): TokenUsage {
  return tokenUsage(inputTokens, outputTokens);
}

/** A record list whose `seq` starts at 0 and whose timestamps are `at + i`. */
export { NOW as FIXED_NOW };
