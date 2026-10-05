import type { TelemetryRecord } from './events.js';
import { EVICTION_SKIPPED_CODE, STRATA_EVENT_TYPES, evictionSkipReason } from './events.js';
import type { JsonlReadResult } from './sink.js';
import { readJsonl } from './sink.js';
import type { PricingTable } from './pricing.js';
import { pricingFreshness } from './pricing.js';

/**
 * G-5: `strata status` -- budget, compactions, pins, savings, violations.
 *
 * ## This is the surface a user reads when something went wrong
 *
 * Everything else in the package is machinery; this is the part that has to be
 * true. The design rule it follows comes from the one place in this codebase
 * that already knows what a log is for (sink.ts, on truncation): **a report
 * that shows zero of something must prove the log was intact.** A "0
 * violations" line fed by a log that dropped three lines, a file that was
 * tailed, a sequence with a hole in it -- each of those is a dashboard
 * reporting health from evidence it never had, and that is the exact failure
 * Governance Decay hides behind. So `warnings` is a first-class output and it
 * is checked before any count is printed.
 *
 * ## It reads a file, it does not own one
 *
 * `buildStatus` takes records. The CLI wrapper is the only thing that touches
 * the filesystem, which means every claim in the report is testable against a
 * fixture list, and the report cannot acquire a side effect by being rendered
 * twice.
 *
 * ## What happened, not only what it cost
 *
 * The first cut of this report was cost and tokens: budget, compactions, pins,
 * savings, violations. It read every record off the log and dropped the two
 * types that answer "what did you do to my last request" -- `case 'stage': case
 * 'error': break;` -- so the per-stage byte counts and every failure were
 * measured, written, and unreachable from the one surface an operator reads
 * (docs/operations.md factor 4 and factor 5). `stages`, `errors` and
 * `perRequest` are the retained answer, and they are additive: nothing that
 * existed before moved, was renamed, or changed type.
 *
 * The three fields worth reading first are `perRequest.byRun[].outcome`,
 * `errors.evictionSkipped` and `stages.reductionFraction`, and all three are
 * three-valued where it matters. `outcome` distinguishes a request the pipeline
 * correctly declined to shrink from a request the log never described, and
 * `reductionFraction` distinguishes a measured 0 from an absent measurement,
 * because the honest report of a no-op request is the case that is easiest to
 * get wrong: silence and "nothing happened" look identical in a summary.
 *
 * ## Two facts that reached the log and died there
 *
 * `case 'cache': break;` and a `savings` handler that read every dollar field
 * and none of `tokensByCategory`. Both were written, both were read by nothing,
 * and both were invisible on the one surface an operator reads. They are now
 * `cache` and `savings.tokensByCategory`, added rather than merged: `cache`
 * keeps its own case because the case it used to share with `canary` is the
 * documented trap, and a merge would put the trap back.
 *
 * `cache` is surfaced as a discrimination rather than a count, because a count
 * cannot answer the question the event was written for. A compaction is the only
 * thing in this log that reorders the context, so it is the only thing that can
 * account for a dropped prefix; `cache.unexplainedInvalidations` names the runs
 * whose prefix was invalidated with nothing behind it. `CacheTelemetry` carries
 * no reason, so the report says "unexplained" and stops -- naming a cause would
 * be a claim the log does not support.
 *
 * ## No network, no clock
 *
 * The report is a pure function of (records, options). `now` is an option, not
 * a call, so the staleness warning is deterministic (N6), and there is no
 * transport anywhere in the path -- the status command reads the same local
 * file the sink wrote and would not work over a URL if you asked it to.
 */

export type ViolationKind = 'pin_missing_pre_apply' | 'pin_post_compact_missing' | 'canary_fail';

export interface StatusOptions {
  /**
   * The configured window, from `policy.budgets.contextLimit`. Optional because
   * the log alone cannot know it -- and a utilization figure computed against an
   * assumed limit is the kind of number that looks measured and is not.
   */
  readonly contextLimit?: number;
  /** `YYYY-MM-DD`. Injected; the report never reads the wall clock. */
  readonly today?: string;
  /** Optional, to surface G-6 in the same report as the money it qualifies. */
  readonly pricing?: PricingTable;
}

export interface LogHealth {
  readonly records: number;
  readonly linesRejected: number;
  readonly tailed: boolean;
  /** `seq` values that never appeared. A hole is lost evidence, not a reorder. */
  readonly sequenceGaps: readonly number[];
  /** `seq` values that appeared more than once. */
  readonly duplicateSeq: readonly number[];
  /** Types present in the file, in `STRATA_EVENT_TYPES` order. */
  readonly eventTypes: readonly string[];
  /** True when nothing at all suggests the log is incomplete. */
  readonly intact: boolean;
}

export interface BudgetSummary {
  readonly requests: number;
  readonly lastInputTokens: number;
  readonly peakInputTokens: number;
  /** peakInputTokens / contextLimit. null when no limit was supplied. */
  readonly peakUtilization: number | null;
  readonly overBudget: number;
}

export interface CompactionSummary {
  readonly count: number;
  readonly validationFailures: number;
  /**
   * Commactions that committed but evicted nothing, because
   * `assessEvictable` refused the raw range. A count and not a flag, and not
   * derivable from `totalDropped`: a run of compactions that each dropped one
   * block and a run where one dropped all of them have the same total and very
   * different meanings.
   */
  readonly noOps: number;
  readonly totalDropped: number;
  readonly totalTokensBefore: number;
  readonly totalTokensAfter: number;
  /** 1 - after/before, summed over compactions. null when nothing compacted. */
  readonly reductionFraction: number | null;
  readonly byTrigger: Readonly<Record<string, number>>;
  readonly byMethod: Readonly<Record<string, number>>;
  readonly aborted: number;
}

export interface ConsolidationSummary {
  readonly runs: number;
  readonly clustersFormed: number;
  readonly metaGistsCreated: number;
  readonly gistsEvicted: number;
  readonly constraintsPreservedRuns: number;
  readonly violatedRuns: number;
  readonly totalDurationMs: number;
  readonly avgClustersPerRun: number | null;
  /** True when at least one run produced clusters but evicted nothing. */
  readonly producedClustersWithZeroEvictions: boolean;
  /** Capped view: this section does not list individual runs. */
  readonly truncated: boolean;
}

export interface PinSummary {
  readonly constraints: number;
  readonly applications: number;
  /** Applications that arrived with pins already missing. A P0, not a warning. */
  readonly missingBeforeApply: number;
  readonly missingTotal: number;
  readonly postCompactMissing: number;
  readonly intact: boolean;
}

export interface SavingsSummary {
  readonly runs: number;
  readonly baselineUsd: number;
  readonly grossSavedUsd: number;
  readonly overheadUsd: number;
  readonly netSavedUsd: number;
  readonly grossFraction: number | null;
  readonly netFraction: number | null;
  readonly gate: 'pass' | 'fail' | 'unknown' | 'none';
  readonly failedRuns: number;
  readonly worstRun: { readonly runId: string; readonly netSavedUsd: number } | null;
  /**
   * E5's per-category token attribution, summed over every savings record.
   * Empty when the log holds no savings record -- an absent breakdown, which is
   * a different fact from a breakdown of zeroes.
   */
  readonly tokensByCategory: Readonly<Record<string, number>>;
  /** Distinct category keys in the log. Complete regardless of the listing. */
  readonly tokensByCategoryCategories: number;
  /**
   * True when `tokensByCategory` lists fewer than
   * `tokensByCategoryCategories` keys. The ledger is keyed by a bare
   * `Record<string, number>` on the wire (`events.ts:114`), so the key count is
   * unbounded and the listing has to be capped; a capped breakdown that did not
   * announce itself would read as the whole one.
   */
  readonly tokensByCategoryTruncated: boolean;
}

export interface ViolationSummary {
  readonly total: number;
  readonly byKind: Readonly<Record<ViolationKind, number>>;
  readonly blocked: number;
  readonly constraintIds: readonly string[];
  readonly kinds: readonly ViolationKind[];
}

/**
 * One pipeline stage, summed over every record that named it.
 *
 * `changed` is a *count of records*, not a flag. A stage fires once per request
 * and can decline to act on some of them, so collapsing it to a boolean
 * reports a stage that ran and did nothing as one that works.
 */
export interface StageEffect {
  readonly stage: string;
  readonly runs: number;
  readonly changed: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly blocksIn: number;
  readonly blocksOut: number;
  readonly durationMs: number;
  /** 1 - bytesOut/bytesIn. null when nothing entered the stage. */
  readonly reductionFraction: number | null;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface StageSummary {
  readonly count: number;
  readonly changed: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly blocksIn: number;
  readonly blocksOut: number;
  readonly durationMs: number;
  /**
   * null when no stage reported at all, and that is the load-bearing
   * distinction: `0` is "the pipeline ran and removed nothing", null is "the
   * log holds no stage records, so its effect is unknown". Collapsing them
   * claims a measurement that was never taken.
   */
  readonly reductionFraction: number | null;
  /** First-seen order, so the listing follows the log rather than the alphabet. */
  readonly byStage: readonly StageEffect[];
  readonly changedStages: readonly string[];
}

export interface ErrorRecord {
  readonly seq: number;
  readonly at: number;
  readonly runId: string;
  readonly stage: string;
  readonly code: string;
  readonly message: string;
  /** True when the failure let the unmodified context through. */
  readonly failedOpen: boolean;
}

/**
 * Step 6 of the transaction refused to evict, and why.
 *
 * Not a violation: no pinned constraint was breached and nothing was lost, so
 * counting it as one would train the reader to ignore the section. Also not a
 * warning, because it is the *expected* path for every real Claude Code session
 * -- `integrations/src/claude-code-observers.ts` mints
 * `artifact://strata/raw/<session>/<turn>`, which the artifact ACL cannot
 * parse, so eviction is refused rather than corrupting the transcript. A
 * warning that fires on every request is the warning nobody reads. The cost is
 * that transcript growth stops being bounded, which is why this is counted,
 * named and rendered rather than left in a string.
 */
export interface EvictionSkipSummary {
  readonly count: number;
  /** Distinct reasons, first-seen order. */
  readonly reasons: readonly string[];
  readonly runIds: readonly string[];
}

export interface ErrorSummary {
  readonly total: number;
  /** The ones the caller felt: the context went upstream uncompressed. */
  readonly failedOpen: number;
  readonly byCode: Readonly<Record<string, number>>;
  readonly byStage: Readonly<Record<string, number>>;
  /** Most recent last. Bounded; `recentTruncated` says when. */
  readonly recent: readonly ErrorRecord[];
  readonly recentTruncated: boolean;
  readonly evictionSkipped: EvictionSkipSummary;
}

/**
 * What happened to one request's context.
 *
 * `outcome` is the whole point, and it has three answers rather than two. A
 * boolean "did we compress this request" cannot tell a stage that ran and
 * correctly declined from a log that never recorded the stage at all, and those
 * are the two cases an operator debugging a no-op most needs separated.
 */
export type RunOutcome =
  /** A stage changed the context, or eviction removed messages. */
  | 'reduced'
  /** Stage records exist and none of them changed anything. */
  | 'noop'
  /** No stage records for this run: the log cannot say. */
  | 'unmeasured';

export interface RunSummary {
  readonly runId: string;
  readonly records: number;
  readonly turns: number;
  readonly lastInputTokens: number;
  readonly stages: readonly string[];
  readonly changedStages: readonly string[];
  readonly compactions: number;
  readonly droppedBlocks: number;
  readonly errorCodes: readonly string[];
  readonly evictionSkipped: number;
  readonly outcome: RunOutcome;
}

export interface PerRequestSummary {
  /** Distinct runIds in the log, however many are listed. */
  readonly total: number;
  readonly reported: number;
  readonly truncated: boolean;
  /** Most recent first: the question is always about the last request. */
  readonly byRun: readonly RunSummary[];
}

/**
 * Where the savings went, in tokens, per E5's five categories.
 *
 * The three counts below are deliberately not a partition of `records`.
 * `CacheTelemetry` (`core-types/src/telemetry.ts:21`) is two *independent*
 * booleans, so a record may set both, set either, or set neither, and a hit/miss
 * split would drop the records that do not fit it -- which is exactly how a
 * cache that is behaving oddly disappears from the report that exists to show
 * it behaving oddly.
 */
export interface CacheSummary {
  readonly records: number;
  /** Records with `prefixHit: true`, whether or not they also invalidated. */
  readonly prefixHits: number;
  readonly prefixInvalidated: number;
  /** Records with both flags false: the log cannot say what happened. */
  readonly neitherFlagSet: number;
  /**
   * Runs whose prefix was invalidated and that hold no compaction to account
   * for it. Empty is the healthy reading; the field exists because a compaction
   * is the only thing in the log that reorders context, so an invalidation
   * without one is a finding rather than a detail.
   */
  readonly unexplainedInvalidations: readonly string[];
  /** Capped view: counts above are complete, this list may not be. */
  readonly truncated: boolean;
}

export interface StatusReport {
  readonly runs: number;
  readonly turns: number;
  readonly log: LogHealth;
  readonly budget: BudgetSummary;
  readonly compactions: CompactionSummary;
  readonly consolidations: ConsolidationSummary;
  readonly pins: PinSummary;
  readonly savings: SavingsSummary;
  readonly cache: CacheSummary;
  readonly violations: ViolationSummary;
  readonly stages: StageSummary;
  readonly errors: ErrorSummary;
  readonly perRequest: PerRequestSummary;
  readonly pricing: ReturnType<typeof pricingFreshness> | null;
  /** Loud, ordered, and printed above every count. See the module doc. */
  readonly warnings: readonly string[];
  readonly generated: boolean;
}

function emptyByKind(): Record<ViolationKind, number> {
  return { pin_missing_pre_apply: 0, pin_post_compact_missing: 0, canary_fail: 0 };
}

/**
 * Events intentionally not surfaced in detail by `buildStatus`. Each entry
 * carries a one-line reason to prevent a new event type from being added to
 * the union and silently dropped by the switch.
 *
 * Empty, and that is a finding rather than an absence: every member of
 * `STRATA_EVENT_TYPES` now reaches the report. `cache` was the last holdout and
 * it is listed nowhere here, because an allowlist entry for a type the switch
 * handles is a declaration that the switch might not -- which is the mistake
 * the exhaustiveness test in `test/status.test.ts` exists to catch.
 */
export const EXPLICIT_UNHANDLED_EVENT_ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({});

/**
 * How many runs `perRequest` lists, and how many error records `errors.recent`
 * carries.
 *
 * `readJsonl` already caps the file at 32 MB because "a 2 GB log read into
 * memory is how a diagnostic tool becomes an outage" (`sink.ts:508`). A
 * `--json` report that inlines every stage record of every run has the same
 * shape problem with a smaller number, so the two unbounded lists are the ones
 * that get an explicit cap -- and each cap says out loud that it was applied
 * rather than letting a truncated list read as a complete one.
 */
const MAX_RUNS_LISTED = 10;
const MAX_ERRORS_LISTED = 10;

/**
 * How many runs `cache.unexplainedInvalidations` lists, and how many category
 * keys `savings.tokensByCategory` lists.
 *
 * The category map is the reason this one is needed. `SavingsEvent
 * .tokensByCategory` is `Readonly<Record<string, number>>` on the wire
 * (`events.ts:114`), not the closed `TokenLedger` of `savings.ts:92`, so nothing
 * bounds its key count and a future writer may add categories freely. A report
 * that inlined an unbounded map is the same `--json` problem `readJsonl` already
 * refuses to be. The per-category sums and the key count stay complete either
 * way; only the listing is capped, and `truncated` says so.
 */
const MAX_CACHE_RUNS_LISTED = 10;
const MAX_TOKEN_CATEGORIES_LISTED = 10;

/** Accumulator behind one `StageEffect`, before it is frozen into the report. */
interface StageTally {
  stage: string;
  runs: number;
  changed: number;
  bytesIn: number;
  bytesOut: number;
  blocksIn: number;
  blocksOut: number;
  durationMs: number;
  inputTokensSum: number;
  outputTokensSum: number;
  inputTokensCount: number;
  outputTokensCount: number;
}

/** Accumulator behind one `RunSummary`. Same lifetime as the report's. */
interface RunTally {
  runId: string;
  records: number;
  turns: number;
  lastInputTokens: number;
  lastSeq: number;
  stages: Set<string>;
  changedStages: Set<string>;
  compactions: number;
  droppedBlocks: number;
  errorCodes: Set<string>;
  evictionSkipped: number;
}

const EMPTY_SAVINGS: Omit<SavingsSummary, 'gate'> = {
  runs: 0,
  baselineUsd: 0,
  grossSavedUsd: 0,
  overheadUsd: 0,
  netSavedUsd: 0,
  grossFraction: null,
  netFraction: null,
  failedRuns: 0,
  worstRun: null,
  // An absent ledger, stated as an empty map with a zero key count rather than
  // as five zeroes: "the log held no savings record" and "the log said the run
  // spent no overhead tokens" are different facts and only one of them is true
  // of an empty log.
  tokensByCategory: Object.freeze({}),
  tokensByCategoryCategories: 0,
  tokensByCategoryTruncated: false,
};

/**
 * Builds the report from records. Pure: no clock, no filesystem, no network.
 */
export function buildStatus(records: readonly TelemetryRecord[], options: StatusOptions = {}): StatusReport {
  const warnings: string[] = [];

  const eventTypes = new Set<string>();
  const seen = new Set<number>();
  const seqs: number[] = [];
  const runIds = new Set<string>();
  const constraintIds = new Set<string>();

  let turns = 0;
  let requests = 0;
  let lastInputTokens = 0;
  let peakInputTokens = 0;
  let overBudget = 0;

  let compactions = 0;
  let validationFailures = 0;
  let compactionNoOps = 0;
  let totalDropped = 0;
  let totalBefore = 0;
  let totalAfter = 0;
  const byTrigger: Record<string, number> = {};
  const byMethod: Record<string, number> = {};

  let consolidationRuns = 0;
  let consolidationClusters = 0;
  let consolidationMetaGists = 0;
  let consolidationEvicted = 0;
  let consolidationPreservedRuns = 0;
  let consolidationViolatedRuns = 0;
  let consolidationDuration = 0;
  let consolidationProducedClustersWithZeroEvictions = false;

  let pinConstraints = 0;
  let pinApplications = 0;
  let missingBeforeApply = 0;
  let missingTotal = 0;
  let postCompactMissing = 0;

  let savingsRuns = 0;
  let savingsBaseline = 0;
  let savingsGross = 0;
  let savingsOverhead = 0;
  let savingsNet = 0;
  let savingsFailed = 0;
  let sawUnknownGate = false;
  let worstRun: SavingsSummary['worstRun'] = null;
  // First-seen order, like `evictionSkipReasons` beside it: the ledger's keys
  // follow the log rather than the alphabet, and a category that appears late
  // is not more interesting than one that appeared first.
  const savingsTokensByCategory = new Map<string, number>();
  let savingsInputShrankBy = 0;
  let savingsInputGrewBy = 0;

  let cacheRecords = 0;
  let cachePrefixHits = 0;
  let cachePrefixInvalidated = 0;
  let cacheNeitherFlag = 0;
  /** Runs that invalidated the prefix, first-seen order. */
  const cacheInvalidatedRuns: string[] = [];

  let violationTotal = 0;
  let blocked = 0;
  const byKind = emptyByKind();
  let breakevenFailures = 0;

  let stageRecords = 0;
  let stageChanged = 0;
  let stageBytesIn = 0;
  let stageBytesOut = 0;
  let stageBlocksIn = 0;
  let stageBlocksOut = 0;
  let stageDurationMs = 0;
  const stageTallies = new Map<string, StageTally>();

  let errorTotal = 0;
  let errorFailedOpen = 0;
  const errorByCode: Record<string, number> = {};
  const errorByStage: Record<string, number> = {};
  const errorRecords: ErrorRecord[] = [];
  const evictionSkipMessages: string[] = [];
  let evictionSkipCount = 0;
  const evictionSkipReasons: string[] = [];
  const evictionSkipRuns: string[] = [];

  const runTallies = new Map<string, RunTally>();
  const tallyFor = (runId: string): RunTally => {
    const existing = runTallies.get(runId);
    if (existing !== undefined) return existing;
    const fresh: RunTally = {
      runId,
      records: 0,
      turns: 0,
      lastInputTokens: 0,
      lastSeq: -1,
      stages: new Set(),
      changedStages: new Set(),
      compactions: 0,
      droppedBlocks: 0,
      errorCodes: new Set(),
      evictionSkipped: 0,
    };
    runTallies.set(runId, fresh);
    return fresh;
  };

  for (const record of records) {
    const event = record.event;
    eventTypes.add(event.type);
    seqs.push(record.seq);
    if (seen.has(record.seq)) {
      // A duplicate seq means two writers, or a sink opened twice over the
      // same file. Either way the seq can no longer be used to prove order.
      warnings.push(`seq ${record.seq} appears more than once; the log has more than one writer`);
    }
    seen.add(record.seq);

    const runId = 'runId' in event ? event.runId : undefined;
    if (typeof runId === 'string' && runId !== '') runIds.add(runId);

    // Every event with a runId is attributed to that run, including the two
    // types the summary below would otherwise account for only in aggregate --
    // `perRequest` is only honest if "nothing happened on this request" can be
    // distinguished from "this request was never described".
    const run = typeof runId === 'string' && runId !== '' ? tallyFor(runId) : null;
    if (run !== null) {
      run.records += 1;
      run.lastSeq = record.seq;
    }

    switch (event.type) {
      case 'request_in': {
        requests += 1;
        turns += event.turn;
        lastInputTokens = event.inputTokens;
        if (event.inputTokens > peakInputTokens) peakInputTokens = event.inputTokens;
        if (options.contextLimit !== undefined && event.inputTokens > options.contextLimit) {
          overBudget += 1;
        }
        if (run !== null) {
          run.turns += event.turn;
          run.lastInputTokens = event.inputTokens;
        }
        break;
      }
      case 'stage': {
        // Retained rather than dropped. `status.ts` read these records off the
        // log and threw them away, which left the per-stage compression numbers
        // (docs/operations.md factor 4) written down and unreachable from the
        // one surface an operator reads.
        stageRecords += 1;
        stageBytesIn += event.bytesIn;
        stageBytesOut += event.bytesOut;
        stageBlocksIn += event.blocksIn;
        stageBlocksOut += event.blocksOut;
        stageDurationMs += event.durationMs;
        if (event.changed) stageChanged += 1;

        const tally = stageTallies.get(event.stage);
        if (tally === undefined) {
          stageTallies.set(event.stage, {
            stage: event.stage,
            runs: 1,
            changed: event.changed ? 1 : 0,
            bytesIn: event.bytesIn,
            bytesOut: event.bytesOut,
            blocksIn: event.blocksIn,
            blocksOut: event.blocksOut,
            durationMs: event.durationMs,
            inputTokensSum: event.inputTokens ?? 0,
            outputTokensSum: event.outputTokens ?? 0,
            inputTokensCount: event.inputTokens === undefined ? 0 : 1,
            outputTokensCount: event.outputTokens === undefined ? 0 : 1,
          });
        } else {
          tally.runs += 1;
          tally.bytesIn += event.bytesIn;
          tally.bytesOut += event.bytesOut;
          tally.blocksIn += event.blocksIn;
          tally.blocksOut += event.blocksOut;
          tally.durationMs += event.durationMs;
          if (event.changed) tally.changed += 1;
          if (event.inputTokens !== undefined) {
            tally.inputTokensSum += event.inputTokens;
            tally.inputTokensCount += 1;
          }
          if (event.outputTokens !== undefined) {
            tally.outputTokensSum += event.outputTokens;
            tally.outputTokensCount += 1;
          }
        }

        if (run !== null) {
          run.stages.add(event.stage);
          if (event.changed) run.changedStages.add(event.stage);
        }
        break;
      }
      case 'error': {
        // Also retained. `stage_failed_open` and `artifact_write_refused` are
        // the two codes docs/operations.md factor 5 names as degradation that
        // nothing surfaces, and both arrive as `error` events; a switch that
        // broke on them discarded the only record that the caller felt nothing.
        errorTotal += 1;
        errorByCode[event.code] = (errorByCode[event.code] ?? 0) + 1;
        errorByStage[event.stage] = (errorByStage[event.stage] ?? 0) + 1;
        if (event.failedOpen) errorFailedOpen += 1;
        errorRecords.push(
          Object.freeze({
            seq: record.seq,
            at: record.at,
            runId: event.runId,
            stage: event.stage,
            code: event.code,
            message: event.message,
            failedOpen: event.failedOpen,
          }),
        );
        if (run !== null) run.errorCodes.add(event.code);

        if (event.code === EVICTION_SKIPPED_CODE) {
          evictionSkipCount += 1;
          // The reason lives on the `gist` event's `failed:` entry, in a
          // discrete form; this message is operator prose that also carries the
          // message counts. Kept only as the fallback for a log that holds the
          // error without the gist record, so one transaction contributes one
          // reason rather than two spellings of it.
          evictionSkipMessages.push(event.message);
          if (run !== null) {
            run.evictionSkipped += 1;
            if (!evictionSkipRuns.includes(run.runId)) evictionSkipRuns.push(run.runId);
          }
        }
        break;
      }
      case 'pin': {
        pinApplications += 1;
        pinConstraints = Math.max(pinConstraints, event.constraints);
        missingBeforeApply += event.missingBefore > 0 ? 1 : 0;
        missingTotal += event.missingBefore;
        break;
      }
      case 'compaction': {
        compactions += 1;
        totalDropped += event.droppedCount;
        totalBefore += event.beforeTokens;
        totalAfter += event.afterTokens;
        if (event.droppedCount === 0) compactionNoOps += 1;
        byTrigger[event.trigger] = (byTrigger[event.trigger] ?? 0) + 1;
        byMethod[event.compressionBy] = (byMethod[event.compressionBy] ?? 0) + 1;
        if (!event.validationPassed) validationFailures += 1;
        if (run !== null) {
          run.compactions += 1;
          run.droppedBlocks += event.droppedCount;
        }
        if (event.afterTokens >= event.beforeTokens) {
          // Not necessarily wrong -- a compaction that could not compress
          // anything is a legitimate outcome -- but the token counts are the
          // only evidence the compaction did anything, so a no-op is a finding.
          warnings.push(
            `compaction on ${event.runId} did not reduce tokens (${event.beforeTokens} -> ${event.afterTokens})`,
          );
        }
        break;
      }
      case 'gist': {
        if (!event.constraintsIntact) {
          // Step 4c. The transaction aborts and the transcript is kept, so the
          // compaction is not logged -- the gist record is the *only* trace
          // that this happened, which is why it is emitted first.
          warnings.push(
            `gist for ${event.taskId} (${event.runId}) lost the pin set [${event.failed.join(', ')}]; ` +
              'the transaction aborted and the transcript was kept',
          );
        }
        const skipReason = evictionSkipReason(event.failed);
        if (skipReason !== undefined && !evictionSkipReasons.includes(skipReason)) {
          evictionSkipReasons.push(skipReason);
        }
        if (!event.rawRecoverable) {
          // Two different facts arrive as `rawRecoverable: false`, and the
          // transaction folds them into one field
          // (`gist/src/transaction.ts:694`: `raw_recoverable && evictable.verified`).
          // The R12 wording below is only true when the raw transcript is
          // genuinely unrecoverable. When step 6 *refused* the eviction nothing
          // was destroyed and nothing is at risk -- the transcript is safe and
          // still in the context -- so saying "a following eviction would
          // destroy evidence" about it would send an operator hunting for lost
          // data that does not exist, and would do so on every Claude Code
          // session. Both still warn: the skip means transcript growth is
          // unbounded, which is the problem this product exists to solve.
          warnings.push(
            skipReason === undefined
              ? `gist for ${event.taskId} (${event.runId}) has no recoverable raw transcript; ` +
                  'a following eviction would destroy evidence (R12)'
              : `gist for ${event.taskId} (${event.runId}) was not evicted: ${skipReason}. ` +
                  'The transcript is safe and still in the context, and it is still growing',
          );
        }
        break;
      }
      case 'violation': {
        violationTotal += 1;
        if (event.blocked) blocked += 1;
        byKind[event.kind] += 1;
        for (const id of event.constraintIds) constraintIds.add(id);
        if (event.kind === 'pin_post_compact_missing') postCompactMissing += 1;
        if (event.kind === 'pin_missing_pre_apply') {
          // architecture §7: "If a constraint is already missing when we get
          // here, something upstream removed it. This is a P0 event, not a
          // warning." The report says so in those words.
          warnings.push(
            `P0: ${event.constraintIds.length} constraint(s) were already missing before the pin buffer was ` +
              `applied on ${event.runId} [${event.constraintIds.join(', ')}]`,
          );
        }
        break;
      }
      case 'savings': {
        savingsRuns += 1;
        savingsBaseline += event.baselineUsd;
        savingsGross += event.grossSavedUsd;
        savingsOverhead += event.overheadUsd;
        savingsNet += event.netSavedUsd;
        if (event.gate === 'fail') savingsFailed += 1;
        if (event.gate === 'unknown') sawUnknownGate = true;
        if (worstRun === null || event.netSavedUsd < worstRun.netSavedUsd) {
          worstRun = { runId: event.runId, netSavedUsd: event.netSavedUsd };
        }
        // `tokensByCategory` was written on every one of these records
        // (savings.ts:151-168) and read by nothing, so the report could say
        // money was saved and not one token of where it went.
        for (const [category, tokens] of Object.entries(event.tokensByCategory)) {
          savingsTokensByCategory.set(
            category,
            (savingsTokensByCategory.get(category) ?? 0) + tokens,
          );
        }
        // Signed on purpose (savings.ts:150): a run that grew its input saved
        // nothing, and summing it unsigned would let the good runs bury it.
        const inputSaved = event.tokensByCategory['input_saved'] ?? 0;
        if (inputSaved < 0) savingsInputGrewBy += -inputSaved;
        else savingsInputShrankBy += inputSaved;
        break;
      }
      case 'consolidation': {
        consolidationRuns += 1;
        consolidationClusters += event.clustersFormed;
        consolidationMetaGists += event.metaGistsCreated;
        consolidationEvicted += event.gistsEvicted;
        consolidationDuration += event.durationMs;
        if (event.constraintsPreserved) {
          consolidationPreservedRuns += 1;
        } else {
          consolidationViolatedRuns += 1;
        }
        if (event.clustersFormed > 0 && event.gistsEvicted === 0) {
          consolidationProducedClustersWithZeroEvictions = true;
        }
        break;
      }
      case 'cost': {
        if (!event.breakevenOk) breakevenFailures += 1;
        break;
      }
      case 'cache': {
        // Its own `break', deliberately, and the reason is in the diff this
        // replaces: this was previously an empty case falling through to
        // `canary', which was harmless while both were `break'. Giving
        // `canary' a body turned the shared fall-through into a silent path
        // from a `cache' event into the canary branch, where a `cache' event
        // has neither `passed` nor `score' -- `!event.passed` was true and
        // `event.score.toFixed(4)` threw. It has a body now, and the two cases
        // are still separate; merging them would reintroduce the exact trap.
        //
        // Both flags are counted independently because `CacheTelemetry`
        // (core-types/src/telemetry.ts:21) declares them that way. A hit/miss
        // partition would silently drop every record that sets both or neither,
        // and the records that set neither are the ones worth seeing.
        cacheRecords += 1;
        if (event.prefixHit) cachePrefixHits += 1;
        if (event.prefixInvalidated) {
          cachePrefixInvalidated += 1;
          if (!cacheInvalidatedRuns.includes(event.runId)) cacheInvalidatedRuns.push(event.runId);
        }
        if (!event.prefixHit && !event.prefixInvalidated) cacheNeitherFlag += 1;
        break;
      }
      case 'canary': {
        // A failed canary is a violation in its own right. `ViolationKind`
        // names `canary_fail` and `byKind` carries the counter, so leaving the
        // `canary` event as a no-op would mean a `rot_canary` that failed is
        // recorded, written, and then never read by anything -- a safety signal
        // that dies in the log. §8 lists `canary_fail` as a violation kind, so
        // it is counted as one here rather than as a bespoke field that a
        // reader has to know to look for.
        if (!event.passed) {
          violationTotal += 1;
          byKind['canary_fail'] += 1;
          warnings.push(
            // `probeId`, not `runId`: a canary is keyed by the probe it belongs
            // to, and `recordRunId` returns undefined for it for that reason. A
            // probe that runs outside a run must still be identifiable in the
            // report, so the field used here is the one the event actually has.
            `canary ${event.probeId} failed (score ${event.score.toFixed(4)}, arm ${event.arm}); the ` +
              'rotation window is being served by an intervention that does not currently pass validation',
          );
        }
        break;
      }
    }
  }

  // Log integrity, before any count is read off the file.
  seqs.sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < seqs.length; i += 1) {
    const prev = seqs[i - 1];
    const cur = seqs[i];
    if (prev === undefined || cur === undefined) continue;
    for (let n = prev + 1; n < cur; n += 1) gaps.push(n);
  }
  const duplicateSeq = seqs.filter((s, i) => i > 0 && seqs[i - 1] === s);
  if (gaps.length > 0) {
    warnings.push(
      `log is missing ${gaps.length} record(s) (seq ${gaps[0]}..${gaps[gaps.length - 1]}); ` +
        'every count below is a lower bound',
    );
  }

  // The discrimination this whole section turns on: a compaction is the only
  // thing in this log that reorders the context, so it is the only thing that
  // can account for a dropped prefix cache. An invalidation with no compaction
  // behind it is not automatically wrong -- the upstream provider can invalidate
  // on its own -- but the log cannot tell the reader which of the two happened,
  // and an unexplained invalidation is the first thing to look at when cache
  // effectiveness drops for reasons nobody can name.
  const unexplainedInvalidations = cacheInvalidatedRuns.filter((id) => {
    const tally = runTallies.get(id);
    return tally === undefined || tally.compactions === 0;
  });

  const netFraction = savingsBaseline > 0 ? savingsNet / savingsBaseline : null;
  const grossFraction = savingsBaseline > 0 ? savingsGross / savingsBaseline : null;
  const gate: SavingsSummary['gate'] =
    savingsRuns === 0 ? 'none' : sawUnknownGate ? 'unknown' : netSavedGates(savingsNet, savingsBaseline, savingsFailed);

  const pricing =
    options.pricing !== undefined && options.today !== undefined
      ? pricingFreshness(options.pricing, options.today)
      : null;

  if (savingsNet < 0) {
    warnings.push(
      `NET savings are negative: the treatment lost $${(-savingsNet).toFixed(6)} across ${savingsRuns} run(s), ` +
        `$${savingsOverhead.toFixed(6)} of it gist and probe cost against a gross saving of ` +
        `$${savingsGross.toFixed(6)}. G7 is a gate on net, so this is a fail, not a footnote.`,
    );
  }
  if (options.contextLimit !== undefined && overBudget > 0) {
    // Counted and not warned about is the same as not counted: `warnings` is
    // the section the CLI prints above everything else, so a budget overrun
    // that only appears in a field the reader has to go looking for is a
    // finding that gets missed on the days it is most relevant.
    warnings.push(
      `BUDGET: ${overBudget} of ${requests} request(s) exceeded the ${options.contextLimit}-token context ` +
        `limit; peak input was ${peakInputTokens} tokens (${((peakInputTokens / options.contextLimit) * 100).toFixed(1)}% of the limit)`,
    );
  }
  if (breakevenFailures > 0) {
    warnings.push(
      `${breakevenFailures} cost record(s) report breakeven_ok=false: the intervention expanded output past the ` +
        'budget its input reduction bought',
    );
  }
  if (validationFailures > 0) {
    warnings.push(`${validationFailures} compaction(s) failed validation and were aborted`);
  }
  if (unexplainedInvalidations.length > 0) {
    // Named as unexplained rather than as a fault. The event carries no reason
    // field (`CacheTelemetry` is two booleans), so "why" is not in the log and
    // inventing one here would be a claim nothing supports.
    warnings.push(
      `CACHE: the prefix was invalidated on ${unexplainedInvalidations.length} run(s) with no compaction to ` +
        `account for it [${unexplainedInvalidations.join(', ')}]; the log records no reason, so an upstream ` +
        'invalidation and a local one are indistinguishable here',
    );
  }
  if (savingsInputGrewBy > 0) {
    // `input_saved` is a signed difference (savings.ts:150), so a negative total
    // is a real finding: the pipeline made the context bigger on at least one
    // run. Reported by magnitude, not as a rate, because the denominator that
    // would make a rate honest is not in this log.
    warnings.push(
      `savings: ${savingsInputGrewBy} token(s) of input grew rather than shrank across ${savingsRuns} ` +
        `run(s) (${savingsInputShrankBy} shrank). The net dollar figure above does not separate the two.`,
    );
  }
  if (pricing?.stale === true) warnings.push(pricing.message);

  const intact = gaps.length === 0 && duplicateSeq.length === 0;

  const byStage: readonly StageEffect[] = Object.freeze(
    [...stageTallies.values()].map((t) => {
      const base: StageEffect = {
        stage: t.stage,
        runs: t.runs,
        changed: t.changed,
        bytesIn: t.bytesIn,
        bytesOut: t.bytesOut,
        blocksIn: t.blocksIn,
        blocksOut: t.blocksOut,
        durationMs: t.durationMs,
        reductionFraction: t.bytesIn > 0 ? 1 - t.bytesOut / t.bytesIn : null,
      };
      const withIn = t.inputTokensCount > 0 ? { ...base, inputTokens: t.inputTokensSum } : base;
      const effect = t.outputTokensCount > 0 ? { ...withIn, outputTokens: t.outputTokensSum } : withIn;
      return Object.freeze(effect);
    }),
  );
  const changedStages = byStage.filter((s) => s.changed > 0).map((s) => s.stage);

  // A log that recorded the refusal but not the gist record still has to yield
  // a reason, because "one eviction was skipped" with an empty reason list is
  // the ambiguous report this whole section exists to avoid.
  const reasons = evictionSkipReasons.length > 0 ? evictionSkipReasons : evictionSkipMessages;
  const runSummaries: readonly RunSummary[] = Object.freeze(
    [...runTallies.values()]
      .sort((a, b) => b.lastSeq - a.lastSeq || (a.runId < b.runId ? -1 : 1))
      .slice(0, MAX_RUNS_LISTED)
      .map((t) =>
        Object.freeze({
          runId: t.runId,
          records: t.records,
          turns: t.turns,
          lastInputTokens: t.lastInputTokens,
          stages: Object.freeze([...t.stages]),
          changedStages: Object.freeze([...t.changedStages]),
          compactions: t.compactions,
          droppedBlocks: t.droppedBlocks,
          errorCodes: Object.freeze([...t.errorCodes]),
          evictionSkipped: t.evictionSkipped,
          // `unmeasured` is checked before `noop` because a run with no stage
          // records has `changedStages` empty too, and reporting that as `noop`
          // would be the exact conflation this three-valued verdict exists to
          // prevent. `reduced` needs a positive fact -- something changed, or
          // messages were actually evicted -- so a no-op cannot reach it.
          outcome: runOutcome(t),
        }),
      ),
  );

  // Capped listing, complete sums. `Object.fromEntries` over the first N keys
  // keeps first-seen order (a Map preserves insertion order), and the count
  // below stays the number of keys the log actually held rather than the number
  // that survived the slice -- otherwise a truncated breakdown would report
  // itself as the whole one.
  const tokenCategoryKeys = [...savingsTokensByCategory.keys()];
  const tokensByCategory = Object.freeze(
    Object.fromEntries(
      tokenCategoryKeys
        .slice(0, MAX_TOKEN_CATEGORIES_LISTED)
        .map((k) => [k, savingsTokensByCategory.get(k) ?? 0]),
    ),
  );

  return Object.freeze({
    runs: runIds.size,
    turns,
    log: Object.freeze({
      records: records.length,
      linesRejected: 0,
      tailed: false,
      sequenceGaps: Object.freeze(gaps),
      duplicateSeq: Object.freeze(duplicateSeq),
      eventTypes: Object.freeze(STRATA_EVENT_TYPES.filter((t) => eventTypes.has(t))),
      intact,
    }),
    budget: Object.freeze({
      requests,
      lastInputTokens,
      peakInputTokens,
      peakUtilization: options.contextLimit !== undefined && options.contextLimit > 0
        ? peakInputTokens / options.contextLimit
        : null,
      overBudget,
    }),
    compactions: Object.freeze({
      count: compactions,
      validationFailures,
      noOps: compactionNoOps,
      totalDropped,
      totalTokensBefore: totalBefore,
      totalTokensAfter: totalAfter,
      reductionFraction: totalBefore > 0 ? 1 - totalAfter / totalBefore : null,
      byTrigger: Object.freeze({ ...byTrigger }),
      byMethod: Object.freeze({ ...byMethod }),
      aborted: compactions - validationFailures,
    }),
    consolidations: Object.freeze({
      runs: consolidationRuns,
      clustersFormed: consolidationClusters,
      metaGistsCreated: consolidationMetaGists,
      gistsEvicted: consolidationEvicted,
      constraintsPreservedRuns: consolidationPreservedRuns,
      violatedRuns: consolidationViolatedRuns,
      totalDurationMs: consolidationDuration,
      avgClustersPerRun: consolidationRuns > 0 ? consolidationClusters / consolidationRuns : null,
      producedClustersWithZeroEvictions: consolidationProducedClustersWithZeroEvictions,
      truncated: false,
    }),
    pins: Object.freeze({
      constraints: pinConstraints,
      applications: pinApplications,
      missingBeforeApply,
      missingTotal,
      postCompactMissing,
      intact: missingTotal === 0 && postCompactMissing === 0,
    }),
    savings: Object.freeze({
      ...EMPTY_SAVINGS,
      runs: savingsRuns,
      baselineUsd: savingsBaseline,
      grossSavedUsd: savingsGross,
      overheadUsd: savingsOverhead,
      netSavedUsd: savingsNet,
      grossFraction,
      netFraction,
      failedRuns: savingsFailed,
      worstRun,
      tokensByCategory,
      tokensByCategoryCategories: tokenCategoryKeys.length,
      tokensByCategoryTruncated: tokenCategoryKeys.length > MAX_TOKEN_CATEGORIES_LISTED,
      gate,
    }),
    cache: Object.freeze({
      records: cacheRecords,
      prefixHits: cachePrefixHits,
      prefixInvalidated: cachePrefixInvalidated,
      neitherFlagSet: cacheNeitherFlag,
      unexplainedInvalidations: Object.freeze(
        unexplainedInvalidations.slice(0, MAX_CACHE_RUNS_LISTED),
      ),
      truncated: unexplainedInvalidations.length > MAX_CACHE_RUNS_LISTED,
    }),
    violations: Object.freeze({
      total: violationTotal,
      byKind: Object.freeze({ ...byKind }),
      blocked,
      constraintIds: Object.freeze([...constraintIds].sort()),
      kinds: Object.freeze((Object.keys(byKind) as ViolationKind[]).filter((k) => byKind[k] > 0)),
    }),
    stages: Object.freeze({
      count: stageRecords,
      changed: stageChanged,
      bytesIn: stageBytesIn,
      bytesOut: stageBytesOut,
      blocksIn: stageBlocksIn,
      blocksOut: stageBlocksOut,
      durationMs: stageDurationMs,
      reductionFraction: stageRecords > 0 && stageBytesIn > 0 ? 1 - stageBytesOut / stageBytesIn : null,
      byStage,
      changedStages: Object.freeze(changedStages),
    }),
    errors: Object.freeze({
      total: errorTotal,
      failedOpen: errorFailedOpen,
      byCode: Object.freeze({ ...errorByCode }),
      byStage: Object.freeze({ ...errorByStage }),
      recent: Object.freeze(errorRecords.slice(-MAX_ERRORS_LISTED)),
      recentTruncated: errorRecords.length > MAX_ERRORS_LISTED,
      evictionSkipped: Object.freeze({
        count: evictionSkipCount,
        reasons: Object.freeze([...reasons]),
        runIds: Object.freeze([...evictionSkipRuns]),
      }),
    }),
    perRequest: Object.freeze({
      total: runTallies.size,
      reported: runSummaries.length,
      truncated: runTallies.size > MAX_RUNS_LISTED,
      byRun: runSummaries,
    }),
    pricing,
    warnings: Object.freeze(warnings),
    generated: records.length > 0,
  });
}

function runOutcome(tally: RunTally): RunOutcome {
  if (tally.stages.size === 0) return 'unmeasured';
  if (tally.changedStages.size > 0 || tally.droppedBlocks > 0) return 'reduced';
  return 'noop';
}

function netSavedGates(net: number, baseline: number, failedRuns: number): SavingsSummary['gate'] {
  if (baseline <= 0) return 'unknown';
  if (failedRuns > 0) return 'fail';
  return net > 0 ? 'pass' : 'fail';
}

/**
 * Folds the reader's own damage report into the status report.
 *
 * Separate from `buildStatus` because the two answer different questions: what
 * the log says, and whether the log can be believed. Keeping them apart is what
 * stops `buildStatus` from having to take a `JsonlReadResult` and every caller
 * from having to remember to check `rejected`.
 */
export function buildStatusFromLog(path: string, options: StatusOptions = {}): StatusReport {
  const read: JsonlReadResult = readJsonl(path);
  const report = buildStatus(read.records, options);
  const warnings = [...report.warnings];

  if (read.rejected.length > 0) {
    const byReason = new Map<string, number>();
    for (const r of read.rejected) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
    const detail = [...byReason.entries()].map(([reason, n]) => `${n} ${reason}`).join(', ');
    warnings.unshift(
      `log is damaged: ${read.rejected.length} line(s) rejected (${detail}). ` +
        'Every count below is a lower bound until the file is repaired.',
    );
  }
  if (read.tailed) {
    warnings.unshift(
      `only the last ${read.bytesRead} byte(s) of the log were read; totals cover a window, not the run`,
    );
  }

  return Object.freeze({
    ...report,
    log: Object.freeze({
      ...report.log,
      linesRejected: read.rejected.length,
      tailed: read.tailed,
      intact: report.log.intact && read.rejected.length === 0,
    }),
    warnings: Object.freeze(warnings),
  });
}

// --- rendering ---------------------------------------------------------------

const usd6 = (v: number): string => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(6)}`;
const pctf = (v: number | null): string => (v === null ? 'n/a' : `${(v * 100).toFixed(2)}%`);

function countMap(m: Readonly<Record<string, number>>): string {
  const entries = Object.entries(m).filter(([, n]) => n > 0);
  if (entries.length === 0) return 'none';
  return entries.map(([k, n]) => `${k} ${n}`).join(', ');
}

/** Per-stage listing, in the log's own stage order, not alphabetical. */
function stageList(byStage: readonly StageEffect[]): string[] {
  return byStage.map((s) => {
    const acted = s.changed > 0 ? `${s.changed}/${s.runs} changed` : `0/${s.runs} changed`;
    return `${s.stage} ${acted}, ${s.bytesIn} -> ${s.bytesOut} bytes, ${s.blocksIn} -> ${s.blocksOut} block(s)`;
  });
}

const RUN_OUTCOME_LINE: Readonly<Record<RunOutcome, string>> = Object.freeze({
  reduced: 'reduced ',
  noop: 'noop    ',
  unmeasured: 'UNKNOWN ',
});

/**
 * Plain text. No colour, no box drawing, no emoji: this goes in a terminal over
 * ssh, gets pasted into a bug report, and gets diffed in review. A status line
 * that only renders on one terminal is a status line nobody reads.
 */
export function formatStatus(report: StatusReport): string {
  const out: string[] = [];
  const rule = '-'.repeat(58);

  out.push('strata status');
  out.push(rule);

  if (report.warnings.length > 0) {
    out.push(`WARNINGS (${report.warnings.length}) -- read these before the numbers`);
    for (const w of report.warnings) out.push(`  ! ${w}`);
    out.push(rule);
  }

  if (!report.generated) {
    out.push('no telemetry found. The log exists, or nothing has been recorded yet.');
    return `${out.join('\n')}\n`;
  }

  const l = report.log;
  out.push(
    `log       ${l.records} record(s), integrity ${l.intact ? 'intact' : 'DAMAGED'}` +
      `${l.linesRejected > 0 ? `, ${l.linesRejected} line(s) rejected` : ''}` +
      `${l.tailed ? ', tailed read' : ''}`,
  );
  if (l.eventTypes.length > 0) out.push(`          events: ${l.eventTypes.join(', ')}`);
  out.push(`runs      ${report.runs} run(s), ${report.turns} turn(s)`);

  const b = report.budget;
  out.push('');
  out.push('budget');
  out.push(`  requests        ${b.requests}`);
  out.push(`  last input      ${b.lastInputTokens} token(s)`);
  out.push(`  peak input      ${b.peakInputTokens} token(s) (${pctf(b.peakUtilization)} of window)`);
  if (b.overBudget > 0) out.push(`  over budget     ${b.overBudget} request(s) exceeded the window`);

  // "what happened to my context", as distinct from "what did it cost". Every
  // branch here distinguishes *measured zero* from *not measured*, because the
  // no-op request is the common case and the one an operator most needs read
  // correctly.
  const st = report.stages;
  out.push('');
  out.push('stages (what the pipeline did to the context)');
  if (st.count === 0) {
    out.push('  UNMEASURED      the log holds no stage records, so the pipeline effect is unknown');
  } else {
    out.push(`  records         ${st.count} (${st.changed} changed the context)`);
    out.push(
      `  bytes           ${st.bytesIn} -> ${st.bytesOut} (${pctf(st.reductionFraction)} removed), ` +
        `${st.blocksIn} -> ${st.blocksOut} block(s)`,
    );
    if (st.changed === 0) {
      out.push('  nothing was compressed: every stage that ran reported no change');
    }
    for (const line of stageList(st.byStage)) out.push(`  ${line}`);
  }

  const c = report.compactions;
  out.push('');
  out.push('compactions');
  out.push(`  count           ${c.count} (${c.aborted} committed, ${c.validationFailures} aborted)`);
  out.push(`  reduction       ${pctf(c.reductionFraction)} (${c.totalTokensBefore} -> ${c.totalTokensAfter} tokens)`);
  out.push(`  dropped blocks  ${c.totalDropped}`);
  if (c.noOps > 0) {
    out.push(`  no-ops          ${c.noOps} committed without evicting anything`);
  }
  out.push(`  by trigger      ${countMap(c.byTrigger)}`);
  out.push(`  by method       ${countMap(c.byMethod)}`);

  const con = report.consolidations;
  out.push('');
  out.push('consolidations');
  if (con.runs === 0) {
    out.push('  none recorded');
  } else {
    out.push(`  runs            ${con.runs}`);
    out.push(`  clusters formed ${con.clustersFormed}`);
    out.push(`  meta-gists      ${con.metaGistsCreated}`);
    out.push(`  gists evicted   ${con.gistsEvicted}`);
    out.push(`  constraints ok  ${con.constraintsPreservedRuns} run(s), violated ${con.violatedRuns} run(s)`);
    out.push(`  avg clusters    ${con.avgClustersPerRun === null ? 'n/a' : con.avgClustersPerRun.toFixed(2)}`);
    if (con.producedClustersWithZeroEvictions) {
      out.push(`  NOTE            clusters formed (${con.clustersFormed}) but evicted ${con.gistsEvicted} (non-zero clusters with zero evictions)`);
    }
    if (con.truncated) {
      out.push(`  truncated       the consolidated view omits individual runs`);
    }
  }

  const p = report.pins;
  out.push('');
  out.push('pins');
  out.push(`  constraints     ${p.constraints} pinned, applied ${p.applications} time(s)`);
  out.push(
    `  missing before  ${p.missingBeforeApply} application(s), ${p.missingTotal} constraint(s) [P0]`,
  );
  out.push(`  post-compact    ${p.postCompactMissing} missing after compaction`);

  const ca = report.cache;
  if (ca.records > 0) {
    out.push('');
    // Only rendered when the log holds a cache record. An absent section and a
    // section reading "0 invalidations" are different facts, and printing the
    // second for a log with no cache records at all would be the first one.
    out.push('prefix cache');
    out.push(
      `  records         ${ca.records}, ${ca.prefixHits} prefix hit(s), ` +
        `${ca.prefixInvalidated} prefix invalidated`,
    );
    // Counted, not derived into a hit rate: the denominator would be a guess
    // about which requests consulted the cache, and the log does not record
    // that. `neitherFlagSet` is the count of records that say nothing either
    // way, which is the number a reader wants before trusting either column.
    if (ca.neitherFlagSet > 0) {
      out.push(`  neither flag    ${ca.neitherFlagSet} record(s) set neither flag, so neither column covers them`);
    }
    if (ca.unexplainedInvalidations.length > 0) {
      out.push(
        `  unexplained     ${ca.unexplainedInvalidations.length} invalidation(s) with no compaction behind ` +
          `them: ${ca.unexplainedInvalidations.join(', ')}`,
      );
    }
    if (ca.truncated) {
      out.push(`  ... and more; only the first ${ca.unexplainedInvalidations.length} unexplained run(s) are shown`);
    }
  }

  const s = report.savings;
  out.push('');
  out.push('savings (net is the gate, G7)');
  if (s.runs === 0) {
    out.push('  no savings records yet');
  } else {
    out.push(`  runs            ${s.runs} (${s.failedRuns} net-negative, gate ${s.gate})`);
    out.push(`  baseline        ${usd6(s.baselineUsd)}`);
    out.push(`  gross saved     ${usd6(s.grossSavedUsd)} (${pctf(s.grossFraction)})   <- flatters`);
    out.push(`  gist + probes   ${usd6(s.overheadUsd)}   <- our cost`);
    out.push(`  NET saved       ${usd6(s.netSavedUsd)} (${pctf(s.netFraction)})   <- the truth`);
    if (s.worstRun !== null) {
      out.push(`  worst run       ${s.worstRun.runId} at ${usd6(s.worstRun.netSavedUsd)}`);
    }
    // `input_saved` is signed, so this line can read negative; that is the
    // whole reason it is printed rather than folded into a total.
    const tokenEntries = Object.entries(s.tokensByCategory);
    if (tokenEntries.length > 0) {
      out.push(`  tokens          ${tokenEntries.map(([k, v]) => `${k} ${v}`).join(', ')}`);
      if (s.tokensByCategoryTruncated) {
        out.push(
          `  ... and ${s.tokensByCategoryCategories - tokenEntries.length} more category/categories not shown; ` +
            'the totals above still cover every record',
        );
      }
    }
  }

  const v = report.violations;
  out.push('');
  out.push('violations');
  out.push(`  total           ${v.total} (${v.blocked} blocked)`);
  out.push(`  by kind         ${countMap(v.byKind)}`);
  if (v.constraintIds.length > 0) out.push(`  constraints     ${v.constraintIds.join(', ')}`);

  const e = report.errors;
  out.push('');
  out.push('errors (what failed, and whether the caller felt it)');
  if (e.total === 0) {
    out.push('  none recorded');
  } else {
    out.push(`  total           ${e.total} (${e.failedOpen} reached the caller uncompressed)`);
    out.push(`  by code         ${countMap(e.byCode)}`);
    out.push(`  by stage        ${countMap(e.byStage)}`);
    for (const rec of e.recent) {
      out.push(
        `  seq ${rec.seq} ${rec.stage}/${rec.code} on ${rec.runId}` +
          `${rec.failedOpen ? ' [failed open]' : ''}: ${rec.message}`,
      );
    }
    if (e.recentTruncated) out.push(`  ... and more; only the last ${e.recent.length} are shown`);
  }
  const ev = e.evictionSkipped;
  if (ev.count > 0) {
    out.push(`  eviction skipped ${ev.count} on ${ev.runIds.length} run(s): nothing was evicted`);
    for (const reason of ev.reasons) out.push(`       because: ${reason}`);
  }

  const pr = report.perRequest;
  if (pr.total > 0) {
    out.push('');
    // No legend here: the verdict is spelled out per run below, and a legend
    // that printed the word UNKNOWN on every report would make "this run is
    // unmeasured" unreadable to a grep and to a human scanning the column.
    out.push(`per request (${pr.reported} of ${pr.total} run(s), most recent first)`);
    for (const run of pr.byRun) {
      out.push(
        `  ${run.runId}  ${RUN_OUTCOME_LINE[run.outcome]} ` +
          `${run.stages.length} stage(s), ${run.changedStages.length} changed, ` +
          `${run.compactions} compaction(s), ${run.droppedBlocks} block(s) evicted, ` +
          `${run.errorCodes.length} error code(s), ${run.evictionSkipped} eviction skip(s)`,
      );
    }
    if (pr.truncated) out.push(`  ... and ${pr.total - pr.reported} older run(s) not shown`);
  }

  if (report.pricing !== null) {
    out.push('');
    out.push('pricing');
    out.push(`  ${report.pricing.message}`);
  }

  out.push(rule);
  out.push(
    report.log.intact && report.violations.total === 0
      ? 'no violations recorded, and the log is intact'
      : 'see warnings above',
  );
  return `${out.join('\n')}\n`;
}

// --- CLI ---------------------------------------------------------------------

export interface StatusIo {
  readonly write: (text: string) => void;
  readonly readFile?: (path: string) => string;
}

export const DEFAULT_STATUS_PATH = '.strata/telemetry.jsonl';

export interface StatusCliOptions extends StatusOptions {
  readonly io: StatusIo;
  readonly path?: string;
  readonly today?: string;
}

export const USAGE = `usage: strata status [--log <path>] [--context-limit <n>] [--today <YYYY-MM-DD>] [--json]

Reads the local telemetry log and reports budget, compactions, pins, savings
and violations. The log is the only input: there is no server to ask and no
network path to fall back to (spec N4).`;

export interface ParsedStatusArgs {
  readonly path: string | undefined;
  readonly contextLimit: number | undefined;
  readonly today: string | undefined;
  readonly asJson: boolean;
  readonly help: boolean;
  readonly unknown: readonly string[];
}

/** Argument parsing split out so it can be tested without a process. */
export function parseStatusArgs(argv: readonly string[]): ParsedStatusArgs {
  let path: string | undefined;
  let contextLimit: number | undefined;
  let today: string | undefined;
  let asJson = false;
  let help = false;
  const unknown: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--json') {
      asJson = true;
    } else if (arg === '--log') {
      const v = argv[i + 1];
      if (v === undefined) unknown.push('--log (needs a value)');
      else {
        path = v;
        i += 1;
      }
    } else if (arg === '--context-limit') {
      const v = argv[i + 1];
      if (v === undefined || !/^\d+$/.test(v)) unknown.push('--context-limit (needs a positive integer)');
      else {
        contextLimit = Number(v);
        i += 1;
      }
    } else if (arg === '--today') {
      const v = argv[i + 1];
      if (v === undefined) unknown.push('--today (needs a value)');
      else {
        today = v;
        i += 1;
      }
    } else if (arg !== undefined) {
      // `arg` is `string | undefined` under noUncheckedIndexedAccess, and an
      // undefined index can only happen if the array shrank underneath the
      // loop. Dropping it silently would be the kind of quiet that hides a
      // caller mutating argv; it is not worth a throw, so it falls through as
      // "no argument here".
      unknown.push(arg);
    }
  }

  return Object.freeze({
    path,
    contextLimit,
    today,
    asJson,
    help,
    unknown: Object.freeze(unknown),
  });
}

/**
 * Exit codes. Anything but 0 means "do not walk away from this terminal".
 *
 * `1` is violations or a damaged log. `2` is a usage error, which is a
 * different thing: the report was never produced, and conflating it with a
 * P0 pin violation would make the wrong one urgent in a monitoring system.
 */
export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_USAGE = 2;

export function runStatusCli(argv: readonly string[], options: StatusCliOptions): number {
  const args = parseStatusArgs(argv);
  if (args.help) {
    options.io.write(`${USAGE}\n`);
    return EXIT_OK;
  }
  if (args.unknown.length > 0) {
    options.io.write(`${USAGE}\n\nunrecognised: ${args.unknown.join(', ')}\n`);
    return EXIT_USAGE;
  }

  const path = args.path ?? options.path ?? DEFAULT_STATUS_PATH;
  let report: StatusReport;
  try {
    report = buildStatusFromLog(path, {
      ...(options.contextLimit === undefined ? {} : { contextLimit: options.contextLimit }),
      ...(args.contextLimit === undefined ? {} : { contextLimit: args.contextLimit }),
      ...(options.today === undefined ? {} : { today: options.today }),
      ...(args.today === undefined ? {} : { today: args.today }),
      ...(options.pricing === undefined ? {} : { pricing: options.pricing }),
    });
  } catch (error) {
    // A missing log is the single most common way to run this command, and it
    // is emphatically not a P0. It exits 2 (usage), not 1 (findings), so a
    // monitor cannot mistake "you have not run anything yet" for "your pins
    // are gone".
    const reason = error instanceof Error ? error.message : String(error);
    options.io.write(`strata status: cannot read ${path}: ${reason}\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }

  options.io.write(args.asJson ? `${JSON.stringify(report, null, 2)}\n` : formatStatus(report));

  if (report.violations.total > 0 || !report.log.intact) return EXIT_FINDINGS;
  return EXIT_OK;
}
