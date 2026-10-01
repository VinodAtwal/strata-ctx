import {
  ARMS,
  pairedNonInferiority,
  runSuite,
  type ArmResult,
  type ArmRunner,
  type CaseResult,
  type EvalFixture,
  type RunReport,
} from '@strata-ctx/eval';
import {
  liveArm,
  newRunStats,
  resolveLiveArm,
  type LiveArmOptions,
  type LiveRunStats,
  RETENTION_THRESHOLD,
} from './live-arm.js';
import { evaluateG1, evaluateG2, evaluateNonInferiority, unevaluatedGates, type GateInput, type GateOutcome } from './gates.js';

/**
 * F2-2: the live campaign report.
 *
 * Wraps `runSuite` -- the same interleaved runner, the same grader, the same
 * statistics as the offline path -- and adds what only a live run can carry:
 * which model answered, what the provider said it was, and how many requests
 * never completed.
 *
 * ## Why `LiveRunReport` is a separate type
 *
 * `RunReport.offline` is typed as the literal `true` in `@strata-ctx/eval`. That
 * is not decoration: `packages/eval` has a structural test proving it opens no
 * sockets, and widening the field there would weaken the type that documents
 * where the guarantee lives. So the offline type keeps its `true`, and the live
 * report is defined here as the offline one minus that field plus `false`. The
 * direction of the substitution is the point -- `eval` cannot express a live run
 * even by accident.
 *
 * ## Why this carries a timestamp
 *
 * `RunReport` deliberately has no clock field, so an offline report is
 * byte-stable and diffable. A live report is a record of one campaign against
 * one endpoint at one moment; a timestamp is a fact about it, not noise. It
 * lives in `campaign`, added behind an explicit option, exactly as
 * `types.ts` said F2-2 would do -- and the payload is stable in shape, so a
 * re-run differs in one line rather than in every number.
 */

export interface CampaignMetadata {
  /** What we asked for. */
  readonly model: string;
  /** What the provider said it was, which is not always the same string. */
  readonly modelsObserved: readonly string[];
  readonly baseUrl: string;
  /** Fixed at 0. Restated per report so a reader never has to go looking. */
  readonly temperature: number;
  readonly attempts: number;
  readonly retries: number;
  readonly infrastructureFailures: number;
  readonly observedAt: string;
  /** The one judgement call in the oracle, recorded so a run is re-gradeable. */
  readonly retentionThreshold: number;
  /**
   * Every statement about what this campaign is *not*, carried in the report
   * rather than in a README nobody re-reads.
   */
  readonly caveats: readonly string[];
}

export type LiveRunReport = Omit<RunReport, 'offline'> & {
  readonly offline: false;
  readonly campaign: CampaignMetadata;
  readonly gates: readonly GateOutcome[];
};

export interface CampaignOptions extends LiveArmOptions {
  readonly fixture: EvalFixture;
  readonly seed?: number;
  /**
   * Wall-clock source for `campaign.observedAt`, supplied rather than read
   * directly so tests stay deterministic. Named `clock` because `now` is
   * already `() => number` in `LiveArmOptions` and two different clocks in one
   * options object is a bug waiting to happen.
   */
  readonly clock?: () => Date;
  readonly retentionThreshold?: number;
  /**
   * Force every gate to this confidence or lower. Free endpoints vary between
   * runs; a single un-replicated free model cannot support "high" on anything.
   */
  readonly confidenceCap?: 'high' | 'medium' | 'low';
}

export const DEFAULT_RETENTION_THRESHOLD = RETENTION_THRESHOLD;

/** Pull a model id out of whatever shape the provider returned. */
const observedModels = (cases: readonly CaseResult[]): string[] => {
  const seen = new Set<string>();
  for (const c of cases) {
    for (const arm of c.arms) {
      const model = (arm as ArmResult & { provenance?: { model?: string } }).provenance?.model;
      if (typeof model === 'string' && model !== '') seen.add(model);
    }
  }
  return [...seen].sort();
};

export const statsOf = (stats: LiveRunStats): Pick<LiveRunStats, 'attempts' | 'retries' | 'infrastructureFailures'> => ({
  attempts: stats.attempts,
  retries: stats.retries,
  infrastructureFailures: stats.infrastructureFailures,
});

export interface RunCampaignOptions extends CampaignOptions {
  /** Inject a pre-built arm or a fake; the live one is constructed otherwise. */
  readonly arm?: ArmRunner;
  readonly stats?: LiveRunStats;
}

/**
 * Run a campaign and grade it.
 *
 * `suite`-agnostic: the fixture decides which gates can apply, and the arm order
 * comes from `runSuite`'s seeded interleaving rather than from here, so the
 * treatment arm cannot accidentally get a systematically warmer slot.
 */
export async function runCampaign(options: RunCampaignOptions): Promise<LiveRunReport> {
  const { fixture, seed, clock, retentionThreshold, confidenceCap, arm: injected, stats: injectedStats, ...rest } = options;
  const live = rest as LiveArmOptions;
  const stats = injectedStats ?? newRunStats();
  const arm = injected ?? liveArm(live, stats);
  // Resolved separately from the runner so the report can state the model and
  // endpoint it was configured with, not just the one it happened to use.
  const resolved = resolveLiveArm(live);

  const report = await runSuite(fixture, seed === undefined ? { runArm: arm } : { runArm: arm, seed });

  // Two gate inputs, deliberately.
  //
  // G1 and G2 are *violation* rates: a forbidden effect appearing in the output.
  // That is a direct measurement, so they do not carry the retention-proxy
  // downgrade -- applying it there would discount a good measurement because of
  // something else in the report.
  //
  // G3 is a *pass rate*, and `gradeArm` computes `pass` as "no violations and no
  // dropped constraints". Retention is scored by text overlap, which F2-1
  // established returns "not measured" for tool-call-only responses. So G3 mixes
  // a direct measurement with a proxy one and is marked accordingly.
  const shared = {
    cases: report.cases,
    infrastructureFailures: stats.infrastructureFailures,
    ...(confidenceCap === undefined ? {} : { confidenceCap }),
  } as const;
  const directInput: GateInput = { ...shared };
  const passRateInput: GateInput = { ...shared, proxyOracle: true };

  const gates: GateOutcome[] = [evaluateG1(directInput), evaluateG2(directInput)];

  // Paired pass/fail per case, treatment against control, in fixture order so
  // the pairing is by case and not by position.
  const byCase = new Map(report.cases.map((c) => [c.caseId, c]));
  const paired = fixture.cases.map((c) => {
    const result = byCase.get(c.id);
    const ok = (arm: string): boolean | 'error' => {
      const found = result?.arms.find((a) => a.arm === arm);
      if (found === undefined) return 'error';
      return found.status === 'error' ? 'error' : found.status === 'pass';
    };
    return { control: ok('control'), treatment: ok('treatment') };
  });

  const runnable = paired.filter((p) => typeof p.control === 'boolean' && typeof p.treatment === 'boolean');
  const nonInferiority = pairedNonInferiority(
    runnable.map((p) => p.control as boolean),
    runnable.map((p) => p.treatment as boolean),
  );
  gates.push(evaluateNonInferiority('G3', passRateInput, nonInferiority));
  gates.push(...unevaluatedGates(passRateInput));

  const timestamp = (clock ?? (() => new Date()))().toISOString();

  return {
    ...report,
    offline: false,
    gates,
    campaign: {
      model: resolved.model,
      modelsObserved: observedModels(report.cases),
      baseUrl: resolved.baseUrl,
      temperature: 0,
      ...statsOf(stats),
      observedAt: timestamp,
      retentionThreshold: retentionThreshold ?? DEFAULT_RETENTION_THRESHOLD,
      caveats: LIVE_CAVEATS,
    },
  };
}

/**
 * First live run, recorded because it is the most useful thing this file has to
 * say: **the campaign produced no usable result, and the audit said so.**
 *
 * 2026-10-01, `cohere/north-mini-code:free`, suite E1, 6 cases x 3 arms, 20
 * requests, 2 retries, 1 infrastructure failure. G1 came back `not_met`: the
 * negative control did not decay, at 0 violations in 5 completed observations.
 * Every downstream claim was therefore marked `invalidated` -- G2's clean
 * treatment arm describes a harness that has not shown it detects anything.
 *
 * Two things are worth separating. The treatment arm did the task correctly and
 * violated nothing, which is a good sign about the task and says nothing about
 * the intervention. And all three arms dropped every constraint, because the
 * model answered with a bare tool call and there was no prose for a text-overlap
 * oracle to find.
 *
 * The honest reading is that a small free model on six cases cannot support any
 * governance claim in either direction, and the useful output of this run is the
 * audit that says so rather than a green table. F2-3 needs more scenarios and a
 * model that actually decays under naive compaction before G1 can fire.
 */

/**
 * What a live campaign report is not allowed to be used for.
 *
 * Copied into every report. Each of these is a claim someone could make from a
 * green run, so each is written as the refusal rather than left for the reader
 * to infer.
 */
export const LIVE_CAVEATS: readonly string[] = Object.freeze([
  'This measures a prompt prefix, not a pin. Pinning is a gateway property; no single-turn API call demonstrates it.',
  'Retention is scored by text overlap and returns "not measured" for tool-call-only responses. Violation counts are the direct measurement; retention is the proxy.',
  'Arms are interleaved per case in one process against one endpoint. Order effects and endpoint drift are controlled for by seeding, not eliminated.',
  `Arms are compared at temperature 0, which reduces sampling variance and does not remove model or provider nondeterminism.`,
  'A single model stands in for no population. Nothing here generalises to models or providers not named in `campaign.modelsObserved`.',
  `Every arm receives the same tool-call instruction. Retention thresholds below ${(DEFAULT_RETENTION_THRESHOLD * 100).toFixed(0)}% score a paraphrase as dropped, biasing against the treatment arm.`,
]);

/** Arms in canonical order, for callers that want to iterate deterministically. */
export const LIVE_ARMS = ARMS;