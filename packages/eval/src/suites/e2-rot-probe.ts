import { EVAL_FIXTURE_FORMAT_VERSION, validateFixture, parseFixture, type FixtureIssueCode } from '../fixture.js';
import { runSuite, type RunOptions } from '../runner.js';
import { unitValue } from '../mock-arm.js';
import { percentile, wilsonInterval } from '../statistics.js';
import type {
  Arm,
  ArmObservation,
  EvalFixture,
  RunReport,
  SuiteId,
  SyncArmRunner,
} from '../types.js';

/**
 * F1-6 — E2, the context rot probe. The suite that measures a *shape*.
 *
 * docs/evaluation.md §E2: *"does the gateway keep the shape of the degradation
 * curve, or just move the endpoint?"* One pre-registered gate hangs off it, G5,
 * and the gate is a single signed number per arm:
 *
 * > **G5 — Rot probe slope: treatment slope ≤ control slope.** (18-model rot study)
 *
 * ## Why the slope and not the endpoint
 *
 * The doc is explicit and the reason is worth repeating because it is the whole
 * difference between this suite and a benchmark: *"A treatment scoring 0.80 at
 * 80% while control scores 0.82 may have a worse slope — growing degradation with
 * a flattering endpoint."* An endpoint is a single point, it is a lottery at low
 * n, and it is trivially moved by making one tier easy. A slope is a four-point
 * fit over the whole curve, so `endpointWouldMislead` is a *named, reported*
 * field here rather than something a reader has to notice for themselves.
 *
 * The sign convention is the other trap, and it is the one place where this
 * suite had to *choose* an interpretation of the doc rather than transcribe it.
 * §E2 states G5 as `treatment slope ≤ control slope` and never says which
 * direction is worse, so the two available encodings disagree about which arm
 * should pass:
 *
 * - slope of **accuracy** (negative = decaying). Then a treatment that degrades
 *   *less* has a *less negative* slope, and `−0.10 ≤ −0.60` is true — the gate
 *   as literally written would pass a treatment that degraded *six times more*.
 * - slope of **degradation**, `1 − accuracy` (positive = decaying). Then
 *   `+0.10 ≤ +0.60` is true for the same reason it should be: the treatment
 *   grew rot more slowly.
 *
 * The second is what is implemented, because a gate that is trivially passed by
 * being worse is not a gate. So every slope in this file is
 * `d(1 − accuracy) / d(fill)`: **positive means getting worse**, and
 * `E2_SLOPE_THRESHOLD` is 0 on the *difference* `slope_treatment −
 * slope_control`, never on a slope. `E2_DEGRADATION_AXIS` names the convention
 * in the report so a reader never has to guess which way the number runs.
 *
 * TODO(WS-F, F1-6): this is an interpretation of an underspecified line, and
 * the *margin* is a further choice — §E2 gives no non-inferiority margin for
 * G5 the way it gives −2pp for G3 and G4. Confirm the sign convention and
 * whether G5 wants a margin with the doc owner before quoting a pass as a
 * campaign result. A suite that silently picks the reading that flatters the
 * product is the failure mode this whole file exists to avoid.
 *
 * ## The distractor design — the poison case
 *
 * docs/evaluation.md §E2 asks for *"synthetic long-context tasks with plausible,
 * low-similarity distractors — the poison case from the 18-model rot study"*.
 * Both halves of that phrase are load-bearing and they pull in opposite
 * directions, so the corpus satisfies each with a separate, machine-checked rule:
 *
 * - **Plausible** — every distractor is a *record that exists in the haystack*,
 *   of the same family and format as the answer, and reachable by a small edit
 *   of the answer: the runbook needle is answered by three rows differing from it
 *   in one field each, the escalation needle by three `service@owner` pairs
 *   taken from real incidents, the ledger count by the neighbouring count and
 *   by the count of the *adjacent published section*. A distractor that appears
 *   nowhere in the context is not a distractor, it is noise, and the lint
 *   refuses it (`unverifiable_distractor`).
 * - **Low-similarity** — the property that makes the probe a *discrimination*
 *   task rather than a retrieval task. If any option shares a contiguous
 *   four-word span with the question, a lexical or BM25-style shortcut finds the
 *   answer without reading the context, the curve flattens, and the probe
 *   silently stops measuring rot. `lintE2Probes` refuses such a case
 *   (`question_overlaps_option`); `E2_OPTION_SHARED_NGRAM` is the threshold.
 *
 * Three rot families, because one is not a probe: `lookup` (discriminate a
 * record by a three-field conjunction), `multihop` (join two distant records —
 * the "long-context reasoning" half of the doc's sentence) and `aggregate`
 * (count a conjunction inside one published section, where the tempting wrong
 * answer is the count of the same status everywhere else). Plus `niah`, the
 * control, below.
 *
 * ## NIAH is the negative control *on the probe*
 *
 * docs/evaluation.md §E2: *"If NIAH stays ~100% while realistic tasks degrade,
 * we've reproduced the original finding and validated that our probe detects
 * something NIAH cannot. If NIAH also degrades, the probe is probably just
 * measuring 'long input is hard' and needs redesign."*
 *
 * That is a three-way judgement, not a yes/no, and `evaluateE2ProbeValidity`
 * implements all three states:
 *
 * | status | meaning |
 * |---|---|
 * | `distinguishing` | NIAH is flat and the rot families degrade — the probe measures something NIAH cannot |
 * | `blind` | nothing degrades, or the easiest tier is already at chance — the probe measures nothing |
 * | `confounded` | NIAH degrades too — the probe is measuring input length, not rot |
 *
 * **A `confounded` probe makes G5 `inconclusive`, not `observed`.** A green
 * slope from a probe already shown to be confounded is the exact outcome §E2
 * exists to prevent; publishing it anyway would make the gate worse than having
 * no gate at all. `evaluateE2Gate` refuses.
 *
 * ## The subject is injected, never imported
 *
 * Same rule as E1 (AGENTS.md §12.1): this package imports nothing, so
 * `E2Subject` is a parameter. It has two halves because the suite measures two
 * things — `present` is the **gateway** (what context the model would be sent)
 * and `answer` is the **model**. The tests supply a deterministic degradation
 * model for both; F2 supplies the real pipeline and a real provider.
 *
 * Two things are computed by the suite and *not* taken on trust:
 *
 * - **Evidence presence is re-derived from the text an arm returns**, by the
 *   same parser that lints the fixture, so an arm cannot report that it kept
 *   the answer. `assertE2Presented` additionally refuses a context containing a
 *   line that is not in the input, or a `PTR-` pointer to a record that does not
 *   exist — pointer-isation is real in the offline treatment arm, but it may not
 *   invent a record.
 * - **Token counts.** `E2Presented` has no token field at all. A subject that
 *   reports its own context size has an incentive to report a flattering one,
 *   and G6/G7 are token gates, so the measuring apparatus measures and the
 *   subject is never asked.
 *
 * A stage returning a *summary* rather than a subset of lines must declare
 * `lossy: true`; its cases are then **excluded from the curve** and reported,
 * because a derivation oracle that cannot read a summary format would score the
 * loss as a wrong answer. Excluded is not the same as excluded-and-forgotten.
 *
 * ## What this fixture does NOT support
 *
 * docs/evaluation.md §4 requires ≥30 tasks per continuous suite, and §E2 is
 * graded from a live model. Offline there are 3 rot cases per tier, a *declared*
 * degradation model rather than a model, and no live run at all. So G5 is
 * `inconclusive` at this n by construction, the way E1's G2 is `inconclusive`
 * below 200 scenarios — the point estimate and its interval are both reported,
 * and `not_observed` stays reachable, because a treatment that is *worse* is a
 * finding at any n. `E2_CASES_PER_TIER_TARGET` records the campaign target as a
 * `TODO(WS-F, F2)` rather than pretending to have met it.
 *
 * ## Telemetry
 *
 * None, for the reason in E1's header: `src/` opens no socket and takes no
 * dependency, so the event sink cannot be imported without breaking the one
 * property that keeps the measuring apparatus honest. The diffable report is
 * the substitute.
 */

// ---------------------------------------------------------------- constants

/** docs/evaluation.md Part 2, E2. Mirrored as a literal, as in E1. */
export const E2_SUITE_ID: SuiteId = 'E2';

export const E2_SUITE_NAME = 'e2-rot-probe';

/**
 * docs/evaluation.md §E2: *"Arms: Control (full context) · Control+truncated ·
 * Treatment."*
 *
 * `control+` is the truncated arm, and it is also the harness's negative-control
 * arm (`NEGATIVE_CONTROL_ARM` in `../types.js`). E2 hangs no gate off it — its
 * curve is reported because it is what the field actually ships — but it is the
 * arm that must reproduce the failure, and at the two high tiers it does so
 * structurally rather than statistically: the needle sits deeper than the
 * truncation budget, so the evidence is *deleted*, not degraded.
 */
export const E2_ARMS: readonly Arm[] = Object.freeze<Arm[]>([
  'control',
  'control+',
  'treatment',
]);

/** The truncated arm, named so a report never has to say `control+` and hope. */
export const E2_TRUNCATED_ARM: Arm = 'control+';

/** The arm G5 compares against, and the arm whose flatness makes a probe valid. */
export const E2_BASELINE_ARM: Arm = 'control';

/**
 * The window the tiers are fractions of.
 *
 * Mirrors `BudgetPolicy.contextLimit` in `@strata-ctx/core-types` (200 000)
 * because this package may not import the policy object — the same mirror, with
 * the same TODO, as `E1_COMPACTION_BUDGET_TOKENS`.
 *
 * TODO(WS-F, F1-6): mirrored, not read. A change to the default in core-types
 * would silently make every tier the wrong size with nothing failing. Read the
 * real window from the gateway in F2 and drop the constant.
 */
export const E2_WINDOW_TOKENS = 200_000;

/**
 * Characters per token. Mirrors the anthropic / openai-compat profile in
 * `packages/gateway/src/token-estimator.ts` (4.0), which this package may not
 * import. 4.0 is the middle of the published profiles, so the mirror errs
 * towards calling a context shorter than it is.
 */
export const E2_CHARS_PER_TOKEN = 4;

/**
 * The budget the truncated arm is given.
 *
 * **This is a stated design decision, not a measured one.** 25% of the window
 * is chosen so the arm actually bites at the 50% and 80% tiers: a budget that
 * only bit at the very top tier would leave the arm indistinguishable from the
 * control at three of four points and report a flat curve for it. The needle
 * sits at 0.6 depth, so a head-retention truncation to 25% of the window deletes
 * the evidence at 50% and 80% fill and leaves it alone at 5% and 20%.
 *
 * TODO(WS-F, F2): replace with the agent's real compaction trigger — the
 * `softTriggerFrac` / compaction budget the gateway actually reads — and
 * re-check the tier sweep. A budget picked to make an arm fail is a hypothesis
 * about that arm, not a measurement of it, and F2 is where it stops being one.
 */
export const E2_TRUNCATION_BUDGET_TOKENS = Math.floor(E2_WINDOW_TOKENS * 0.25);

/** The four difficulty tiers of docs/evaluation.md §E2, as window fractions. */
export const E2_TIER_IDS = ['t05', 't20', 't50', 't80'] as const;
export type E2TierId = (typeof E2_TIER_IDS)[number];

export interface E2Tier {
  readonly id: E2TierId;
  /** Fraction of `E2_WINDOW_TOKENS` this tier's context fills. */
  readonly fill: number;
  /** `fill * E2_WINDOW_TOKENS`, which is what the renderer targets. */
  readonly targetTokens: number;
}

export const E2_TIERS: Readonly<Record<E2TierId, E2Tier>> = Object.freeze({
  t05: Object.freeze({ id: 't05', fill: 0.05, targetTokens: Math.round(E2_WINDOW_TOKENS * 0.05) }),
  t20: Object.freeze({ id: 't20', fill: 0.2, targetTokens: Math.round(E2_WINDOW_TOKENS * 0.2) }),
  t50: Object.freeze({ id: 't50', fill: 0.5, targetTokens: Math.round(E2_WINDOW_TOKENS * 0.5) }),
  t80: Object.freeze({ id: 't80', fill: 0.8, targetTokens: Math.round(E2_WINDOW_TOKENS * 0.8) }),
});

/**
 * How far a rendered tier may drift from its target, in either direction.
 *
 * "At 80% of the window" is a claim about the fixture, and the only way it
 * becomes a fact instead of a comment is a measured bound. 2% is wider than the
 * error of the 4-chars-per-token mirror is *expected* to be over 600 KB of
 * generated records, and narrow enough that "80%" is not really "74%".
 */
export const E2_TIER_FILL_TOLERANCE = 0.02;

/**
 * The G5 threshold, applied to `slope_treatment − slope_control`.
 *
 * Zero, and applied to a *difference* rather than to a slope, for two reasons.
 * The difference is the paired quantity: both arms see the same cases at the
 * same tiers, so the case-to-case difficulty cancels and the difference is the
 * only honest form of the comparison. And zero is the only threshold the doc
 * states — `treatment slope ≤ control slope` — with the sign convention fixed by
 * the module header, so any margin here would be a number nobody agreed to.
 * `NON_INFERIORITY_MARGIN` from `../statistics.js` is a margin on a difference
 * of proportions *at one point* and does not transfer to a rate of change over
 * the whole window.
 */
export const E2_SLOPE_THRESHOLD = 0;

/** Which quantity the slopes are taken over. Named so a report states it. */
export const E2_DEGRADATION_AXIS = 'degradation (1 - accuracy) per unit window fill; positive = worse';

/**
 * Largest accuracy drop the NIAH control may show across the window before the
 * probe is declared `confounded`.
 *
 * The threshold is a reading of docs/evaluation.md §E2's *"if NIAH stays ~100%"*,
 * not a published constant. 0.10 is chosen as the largest drop that a reader
 * would still call "about 100%" on a curve reported to two decimal places.
 *
 * TODO(WS-F, F1-6): a judgement call wearing a number's clothes. Pre-register
 * it against the live campaign the way `NON_INFERIORITY_MARGIN` is pre-registered
 * in `../statistics.ts`, or cite the 18-model study's own NIAH variance. Do not
 * present it as a standard in a claims audit before then.
 */
export const E2_NIAH_MAX_DROP = 0.1;

/**
 * Rot cases per tier the campaign must reach before G5 is read on the interval.
 *
 * 8 per tier is `TODO(WS-F, F2)`: 3 is what the offline fixture honestly has,
 * docs/evaluation.md §4 asks for ≥30 per continuous suite overall, and a
 * bootstrap over 3 items produces an interval that is coarse but not vacuous.
 * The gate therefore reports `inconclusive` offline and still reports the point
 * estimate, the interval, and `not_observed` when the treatment is worse.
 */
export const E2_CASES_PER_TIER_TARGET = 8;

/**
 * Bootstrap replicates for the slope interval.
 *
 * 2 000 rather than the 10 000 in `../statistics.js`, because each replicate
 * here refits three arms over the whole case set rather than computing one
 * median, and the Monte-Carlo error of a percentile endpoint is already well
 * under the width of the interval at this count for a 3-item-per-tier resample.
 *
 * TODO(WS-F, F1-6): the error-vs-replicates argument is asserted, not measured
 * — the same TODO `../statistics.ts` carries for its own default. Add the
 * interval-width-stabilising test before quoting this number in a report.
 */
export const E2_SLOPE_RESAMPLES = 2000;

/** Seed for the slope bootstrap. Named so it cannot be confused with a run seed. */
export const E2_SLOPE_BOOTSTRAP_SEED = 0x5eed_0e02;

/** Alpha for every interval this suite reports. */
export const E2_ALPHA = 0.05;

/**
 * Options per probe. Four, so chance accuracy is 0.25 by construction and the
 * "is the easy tier above chance?" check needs no second magic number.
 */
export const E2_OPTION_COUNT = 4;

/** Chance accuracy implied by `E2_OPTION_COUNT`. */
export const E2_CHANCE_ACCURACY = 1 / E2_OPTION_COUNT;

/**
 * The longest contiguous word span an option may share with its question.
 *
 * The check exists because a rot probe that can be solved by keyword overlap
 * measures nothing: a lexical retriever finds the option, the curve flattens,
 * and the suite reports "no rot" for a corpus that rotted. Four is the smallest
 * span that is unlikely to arise by accident in prose about a record format and
 * short enough to catch a copied clause. `lintE2Probes` enforces it, and the
 * test file proves the enforcement by copying a clause into a distractor.
 */
export const E2_OPTION_SHARED_NGRAM = 4;

/**
 * Where the needle sits in the haystack, as a fraction of the rendered context.
 *
 * Fixed, and identical across all four families and all four tiers, so that tier
 * varies the amount of plausible noise and nothing else. Letting the needle
 * float with the fill would confound "more context" with "the answer moved", and
 * a slope is exactly the kind of number that cannot tell those apart afterwards.
 *
 * 0.6 rather than 0.5 is deliberate and is the one asymmetry in the layout: the
 * truncated arm retains the *head* of the context, so a needle at exactly 0.5
 * would sit on the cut boundary at the 50% tier and its inclusion would depend
 * on rounding. 0.6 clears it.
 */
export const E2_NEEDLE_DEPTH = 0.6;

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

const estimateTokens = (text: string): number => Math.ceil(text.length / E2_CHARS_PER_TOKEN);

// ------------------------------------------------------------------- types

/**
 * The four task families.
 *
 * Three rot families and one control. `niah` is the control *on the probe* and
 * is deliberately the easiest possible task in the suite: the key appears
 * verbatim on exactly one line, so anything that finds the line has the answer.
 */
export const E2_FAMILIES = ['lookup', 'multihop', 'aggregate', 'niah'] as const;
export type E2Family = (typeof E2_FAMILIES)[number];

/** The families whose degradation is the subject of G5. `niah` is excluded. */
export const E2_ROT_FAMILIES: readonly E2Family[] = Object.freeze<E2Family[]>([
  'lookup',
  'multihop',
  'aggregate',
]);

/** True for the families G5 is about. */
export const isE2RotFamily = (family: E2Family): boolean => family !== 'niah';

/**
 * How a probe's answer is derived from its context.
 *
 * This is the load-bearing type in the file. A probe whose answer cannot be
 * derived from the context by a *declared, deterministic* procedure is not a
 * probe: it is a coin flip with a plausible costume, and the arm that scores
 * well on it has learned nothing. `deriveE2Answer` implements all three kinds
 * and `lintE2Probes` asserts that re-deriving the answer from the rendered
 * context reproduces the authored answer exactly.
 */
export type E2Derivation =
  /** Find the unique record matching `keys`, read `field`. */
  | { readonly kind: 'field'; readonly keys: Readonly<Record<string, string>>; readonly field: string }
  /** Find the record matching `keys`, follow `hopField` to a second record, compose. */
  | {
      readonly kind: 'multihop';
      readonly keys: Readonly<Record<string, string>>;
      readonly hopField: string;
      readonly compose: readonly [string, string];
    }
  /** Count the records matching `keys`; the answer is that count in decimal. */
  | { readonly kind: 'aggregate'; readonly keys: Readonly<Record<string, string>> };

/**
 * A wrong option, and the rule the lint checks it against.
 *
 * The kind is not a label — it is a *verifiable claim* about where that option
 * comes from, and `lintE2Probes` recomputes each one:
 *
 * | kind | the lint requires |
 * |---|---|
 * | `near_miss_literal` | the value occurs literally in the rendered context |
 * | `near_miss_pair` | some record in the context carries that `service`/`owner` pair |
 * | `off_by_one` | the value is an integer exactly one away from the answer |
 * | `wrong_count` | recounting the context under `countKeys` reproduces the value |
 */
export type E2DistractorKind = 'near_miss_literal' | 'near_miss_pair' | 'off_by_one' | 'wrong_count';

export interface E2Distractor {
  readonly value: string;
  readonly kind: E2DistractorKind;
  /** For `wrong_count`: the alternative query this value is the answer to. */
  readonly countKeys?: Readonly<Record<string, string>>;
}

/** One probe: a question, its options, its answer, and how to re-derive it. */
export interface E2Probe {
  readonly id: string;
  readonly family: E2Family;
  readonly tier: E2TierId;
  readonly title: string;
  /** Rendered above the options in the prompt; the model is shown the same text. */
  readonly question: string;
  /** All four options, correct one included, in a fixed order. */
  readonly options: readonly string[];
  /** Must be exactly one of `options`. */
  readonly correctAnswer: string;
  /** The wrong options. Linted against the context, not merely listed. */
  readonly distractors: readonly E2Distractor[];
  readonly derivation: E2Derivation;
  /**
   * The token this probe's noise is counted by.
   *
   * The degradation model has to answer "how much plausible noise is in my
   * input?" without knowing the answer, and this is the string it counts: a
   * `key=value` pair taken verbatim from the question. It grows linearly with
   * the tier, which is what makes the *tier* a noise axis rather than a length
   * axis with an unexplained slope.
   */
  readonly noiseCue: string;
  readonly notes: string;
}

// ------------------------------------------------------------------- corpus

/**
 * One line of the haystack.
 *
 * A flat `key=value` record with a typed id, and nothing else — no nesting, no
 * prose, no values containing spaces. The simplicity is the point: the
 * derivation oracle and the injected model have to agree about where a field
 * ends, and a format that can be parsed two ways is a format whose agreement is
 * an accident. Realism lives in the *field vocabulary* and the distractor
 * structure, not in the grammar.
 */
export interface E2Record {
  readonly type: string;
  readonly id: string;
  readonly fields: Readonly<Record<string, string>>;
}

const REGIONS = ['eu-west', 'us-east', 'ap-south', 'sa-east', 'ca-central'] as const;

const TEAMS = [
  'team-halyard',
  'team-levy',
  'team-okonkwo',
  'team-brandt',
  'team-ferreira',
  'team-novak',
] as const;

const STATUSES = ['blocked', 'triaged', 'resolved', 'deferred'] as const;

/**
 * Sections the filler ledger may use.
 *
 * `s2` and `s3` are absent on purpose: those are the *published* sections, and
 * they are authored block for block (see `E2_PUBLISHED_SECTIONS`). The probe
 * counts rows in `s3`; if unfiled rows were also allowed to land there, the
 * answer would change with the tier and the family would be measuring "bigger
 * numbers are harder" instead of rot.
 */
const LEDGER_FILLER_SECTIONS = ['s1', 's4', 's5', 's6'] as const;

const FILLER_LIMITS = ['1.75', '2.25', '6.50', '7.00', '8.25', '9.50', '1.25', '6.75'] as const;

const FILLER_MESSAGES = ['heartbeat-ok', 'flush-done', 'retry-issued', 'quorum-met'] as const;

/**
 * Filler runbook triples.
 *
 * Authored, not sampled, and the omission is the mechanism: the needle's
 * `(check, service, region)` triple and all three decoys' triples are
 * deliberately *not* in this list, so the three-field conjunction in the lookup
 * question identifies exactly one row in the whole haystack. Sampling instead
 * would guarantee collisions at 5 000 records over a 240-combination key space,
 * and a probe whose needle is one of seventeen rows is a retrieval benchmark
 * with extra steps.
 */
const RUNBOOK_FILLER_TRIPLES: readonly (readonly [string, string, string])[] = [
  ['retry-budget', 'checkout-api', 'us-east'],
  ['retry-budget', 'mail-relay', 'ap-south'],
  ['retry-budget', 'pdf-render', 'ca-central'],
  ['backfill-window', 'checkout-api', 'eu-west'],
  ['backfill-window', 'ledger-compactor', 'us-east'],
  ['backfill-window', 'mail-relay', 'sa-east'],
  ['fanout-lag', 'webhook-fanout', 'eu-west'],
  ['fanout-lag', 'checkout-api', 'ap-south'],
  ['fanout-lag', 'usage-meter', 'us-east'],
  ['cache-warmth', 'session-store', 'sa-east'],
  ['cache-warmth', 'pdf-render', 'eu-west'],
  ['lock-contention', 'ledger-compactor', 'ap-south'],
];

/** Filler `(service, owner)` pairs, excluding the multihop needle's. */
const INCIDENT_FILLER_PAIRS: readonly (readonly [string, string])[] = [
  ['checkout-api', 'team-halyard'],
  ['checkout-api', 'team-brandt'],
  ['mail-relay', 'team-okonkwo'],
  ['mail-relay', 'team-novak'],
  ['session-store', 'team-levy'],
  ['session-store', 'team-ferreira'],
  ['pdf-render', 'team-okonkwo'],
  ['pdf-render', 'team-halyard'],
  ['usage-meter', 'team-novak'],
  ['webhook-fanout', 'team-levy'],
];

const renderE2Record = (record: E2Record): string => {
  const fields = Object.entries(record.fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  return `${record.type}-${record.id} ${fields}`;
};

/** A record's address as the corpus spells it, e.g. `INC-04120`. */
const recordAddress = (record: E2Record): string => `${record.type}-${record.id}`;

/**
 * The runbook block: one needle row and the three rows that differ from it in
 * exactly one field each.
 *
 * Each decoy matches the needle on two of the question's three keys, which is
 * the whole poison: a retriever that honours two of three constraints lands on
 * a real row, and the answer it then reads is a different `limit`.
 */
const RUNBOOK_NEEDLE: E2Record = {
  type: 'RB',
  id: '90001',
  fields: {
    check: 'retry-budget',
    service: 'tax-service',
    region: 'eu-west',
    owner: 'team-levy',
    limit: '3.50',
  },
};

const RUNBOOK_DECOYS: readonly E2Record[] = [
  {
    type: 'RB',
    id: '90002',
    fields: { check: 'retry-budget', service: 'tax-service', region: 'us-east', owner: 'team-brandt', limit: '4.00' },
  },
  {
    type: 'RB',
    id: '90003',
    fields: {
      check: 'retry-budget',
      service: 'session-store',
      region: 'eu-west',
      owner: 'team-halyard',
      limit: '3.25',
    },
  },
  {
    type: 'RB',
    id: '90004',
    fields: {
      check: 'lock-contention',
      service: 'tax-service',
      region: 'eu-west',
      owner: 'team-novak',
      limit: '5.75',
    },
  },
];

/**
 * The escalation block: a needle incident, the incident it escalates to, the
 * next link in that chain, and two rows built to be retrieved instead of the
 * needle.
 *
 * `INC-05088` escalates *to* the needle and `INC-04119` shares two of the
 * needle's three identifying fields. Between them they cover the two ways a
 * two-step lookup goes wrong before it goes right.
 */
const INCIDENT_NEEDLE: E2Record = {
  type: 'INC',
  id: '04120',
  fields: {
    status: 'blocked',
    service: 'tax-service',
    region: 'eu-west',
    owner: 'team-levy',
    escalates: 'INC-05877',
  },
};

const INCIDENT_HOP: E2Record = {
  type: 'INC',
  id: '05877',
  fields: {
    status: 'triaged',
    service: 'pdf-render',
    region: 'us-east',
    owner: 'team-halyard',
    escalates: 'INC-05901',
  },
};

const INCIDENT_CHAIN_NEXT: E2Record = {
  type: 'INC',
  id: '05901',
  fields: {
    status: 'triaged',
    service: 'pdf-render',
    region: 'us-east',
    owner: 'team-brandt',
    escalates: 'INC-05922',
  },
};

const INCIDENT_CHAIN_PREV: E2Record = {
  type: 'INC',
  id: '05088',
  fields: {
    status: 'triaged',
    service: 'ledger-compactor',
    region: 'ap-south',
    owner: 'team-ferreira',
    escalates: 'INC-04120',
  },
};

const INCIDENT_LOOKALIKE: E2Record = {
  type: 'INC',
  id: '04119',
  fields: {
    status: 'triaged',
    service: 'tax-service',
    region: 'eu-west',
    owner: 'team-okonkwo',
    escalates: 'INC-05870',
  },
};

/**
 * The two published ledger sections, as status patterns.
 *
 * `s3` is the counted section and `s2` its neighbour. The counts are *derived*
 * from these patterns rather than written down, so a change to a pattern cannot
 * leave a stale answer behind — and `lintE2Probes` recounts from the rendered
 * context, so a wrong pattern is a build failure, not a quietly wrong gate.
 */
const E2_PUBLISHED_SECTIONS = Object.freeze({
  s2: Object.freeze({
    rows: 12,
    status: Object.freeze(['triaged', 'blocked', 'resolved', 'deferred', 'blocked', 'resolved', 'triaged', 'blocked']),
  }),
  s3: Object.freeze({
    rows: 16,
    status: Object.freeze(['blocked', 'triaged', 'blocked', 'resolved', 'blocked', 'deferred', 'triaged', 'resolved']),
  }),
});

/** The NIAH needle, one per tier so the key is unique inside its own context. */
export const E2_NIAH_MAGIC_IDS: Readonly<Record<E2TierId, string>> = Object.freeze({
  t05: 'e2-niah-05',
  t20: 'e2-niah-20',
  t50: 'e2-niah-50',
  t80: 'e2-niah-80',
});

/** The NIAH answer, constant across tiers so the tier varies only the noise. */
const NIAH_STAMP = '48213';

/** Three other stamps, each on a real line, for another key. */
const NIAH_DECOY_STAMPS: readonly (readonly [string, string])[] = [
  ['e2-niah-11', '91734'],
  ['e2-niah-23', '30628'],
  ['e2-niah-31', '77451'],
];

const niahLine = (id: string, magicFor: string, stamp: string): E2Record => ({
  type: 'LOG',
  id,
  fields: { ts: '04:12:09', lvl: 'warn', magic_for: magicFor, stamp },
});

// ------------------------------------------------------------------ parsing

/**
 * A record line: `TYPE-12345 k=v k=v`, with nothing else on the line.
 *
 * The anchored pattern is doing real work, not decoration. `deriveE2Answer`
 * scans whole prompts, and a prompt ends with the question block — which
 * contains `key=value` pairs of its own. A looser match would find the
 * *question* and read a field out of it, so the oracle would confirm an answer
 * that is in fact printed next to the question. Only lines that look like
 * records are records.
 */
const E2_RECORD_LINE = /^([A-Z]{2,4})-([0-9]+) ([A-Za-z_]+=[^\s]+(?: [A-Za-z_]+=[^\s]+)*)$/;

const parseE2RecordLine = (line: string): E2Record | null => {
  const match = E2_RECORD_LINE.exec(line);
  if (match === null) return null;
  const [, type, id, fieldText] = match;
  if (type === undefined || id === undefined || fieldText === undefined) return null;
  const fields: Record<string, string> = {};
  for (const pair of fieldText.split(' ')) {
    const at = pair.indexOf('=');
    if (at <= 0) return null;
    fields[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return { type, id: `${type}-${id}`, fields };
};

/**
 * Whether a record satisfies a key conjunction.
 *
 * `id` is special-cased because the id is not a field: it is the record's
 * address, and the multihop family has to follow it. Treating it as an ordinary
 * key would look for a field nothing ever emits, match nothing, and report the
 * probe as unanswerable — a silent zero rather than a failure, which is the
 * worst of the three outcomes.
 */
const recordMatches = (record: E2Record, keys: Readonly<Record<string, string>>): boolean =>
  Object.entries(keys).every(([key, value]) => (key === 'id' ? record.id === value : record.fields[key] === value));

/** The first record in `context` matching every key, or null. */
export function findE2Record(context: string, keys: Readonly<Record<string, string>>): E2Record | null {
  for (const line of context.split('\n')) {
    const record = parseE2RecordLine(line);
    if (record !== null && recordMatches(record, keys)) return record;
  }
  return null;
}

/** How many records in `context` match every key. */
export function countE2Records(context: string, keys: Readonly<Record<string, string>>): number {
  let count = 0;
  for (const line of context.split('\n')) {
    const record = parseE2RecordLine(line);
    if (record !== null && recordMatches(record, keys)) count += 1;
  }
  return count;
}

/** Whether any record in `context` carries this `field=first` / `field2=second` pair. */
export const contextSupportsPair = (
  context: string,
  first: { readonly field: string; readonly value: string },
  second: { readonly field: string; readonly value: string },
): boolean => {
  for (const line of context.split('\n')) {
    const record = parseE2RecordLine(line);
    if (record === null) continue;
    if (record.fields[first.field] === first.value && record.fields[second.field] === second.value) return true;
  }
  return false;
};

/**
 * The answer to a probe, re-derived from a context.
 *
 * Returns `null` when the context cannot support the answer at all — which is
 * not the same as an answer that differs from the authored one, and the lint
 * reports the two differently. "I could not find it" and "I found something
 * else" are different claims about a context, and a stage that deletes the
 * evidence must be distinguishable from a stage that corrupts it.
 */
export function deriveE2Answer(probe: E2Probe, context: string): string | null {
  const derivation = probe.derivation;
  switch (derivation.kind) {
    case 'field': {
      const record = findE2Record(context, derivation.keys);
      if (record === undefined || record === null) return null;
      return record.fields[derivation.field] ?? null;
    }
    case 'multihop': {
      const first = findE2Record(context, derivation.keys);
      if (first === null) return null;
      const hop = first.fields[derivation.hopField];
      if (hop === undefined) return null;
      const second = findE2Record(context, { id: hop });
      if (second === null) return null;
      const [left, right] = derivation.compose;
      const composed = [second.fields[left], second.fields[right]];
      if (composed.some((part) => part === undefined)) return null;
      return composed.join('@');
    }
    case 'aggregate':
      return String(countE2Records(context, derivation.keys));
    default:
      return null;
  }
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export const countOccurrences = (haystack: string, needle: string): number => {
  if (needle === '') return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
};

// ------------------------------------------------------------------ filler

/**
 * Filler `src` values.
 *
 * 64 of them, one per filler record, cycling. This field exists for the *noise
 * axis* and nothing else: a probe declares a `key=value` cue and the suite turns
 * its occurrence count into a noise load, so the cue has to be a pool value whose
 * frequency is **the same for all three rot families**. Choosing a semantically
 * meaningful field instead (`check=…`, `status=…`) would give each family a
 * different hand-tuned noise load, and the family that happened to get more would
 * be harder for a reason that has nothing to do with rot.
 *
 * Equal *to within one cycle*. The pool is walked in order, so a context that
 * stops mid-cycle includes some pool values and not others, and the three cues
 * can differ by one 256-line cycle (~3% at the 80% tier). The corpus test asserts
 * that bound rather than exact equality, because exact equality is not a property
 * this generator has and claiming it in a comment would be a lie the test would
 * catch.
 *
 * At 1-in-64 of every record, a `src=` cue is ~0.4% of the window at any tier:
 * small enough to be plausible noise, large enough to be a real count rather
 * than a rounding error. The exact share is measured per tier and reported.
 */
const SRC_POOL: readonly string[] = Object.freeze(
  Array.from({ length: 64 }, (_, index) => `src-${String(index).padStart(2, '0')}`),
);

const srcFor = (k: number): string => {
  const src = SRC_POOL[k % SRC_POOL.length];
  if (src === undefined) throw new RangeError('e2: SRC_POOL is empty');
  return src;
};

/**
 * The deterministic filler line at index `i`.
 *
 * A pure function of `i` with no internal state, so the haystack is the same on
 * every machine and every run (G11) and can be sliced by a truncating arm
 * without that arm needing to know how it was built. Type rotates with `i % 4`
 * and the per-type index with `floor(i / 4)`, which keeps the four families
 * interleaved at a fixed cadence — a haystack of one record type would make
 * distractor load and record type the same variable.
 *
 * Ids are offset per type (`RB-1000+`, `INC-2000+`, `LG-3000+`, `LOG-1000+`) and
 * the authored blocks live far above those ranges, so no filler can collide
 * with a needle or a decoy.
 */
const fillerLine = (i: number): string => {
  const k = Math.floor(i / 4);
  const src = srcFor(k);
  switch (i % 4) {
    case 0: {
      const triple = RUNBOOK_FILLER_TRIPLES[k % RUNBOOK_FILLER_TRIPLES.length];
      const owner = TEAMS[k % TEAMS.length];
      const limit = FILLER_LIMITS[k % FILLER_LIMITS.length];
      if (triple === undefined || owner === undefined || limit === undefined) break;
      return renderE2Record({
        type: 'RB',
        id: String(1000 + k),
        fields: { check: triple[0], service: triple[1], region: triple[2], owner, limit, src },
      });
    }
    case 1: {
      const pair = INCIDENT_FILLER_PAIRS[k % INCIDENT_FILLER_PAIRS.length];
      const region = REGIONS[k % REGIONS.length];
      const status = STATUSES[k % STATUSES.length];
      if (pair === undefined || region === undefined || status === undefined) break;
      return renderE2Record({
        type: 'INC',
        id: String(2000 + k),
        fields: {
          status,
          service: pair[0],
          region,
          owner: pair[1],
          // Four digits, never five. A five-digit target would make the
          // multihop family's noise cue a constant instead of a function of the
          // tier, which is the one property the cue has to have.
          escalates: `INC-${2000 + (k % 8000)}`,
          src,
        },
      });
    }
    case 2: {
      const section = LEDGER_FILLER_SECTIONS[k % LEDGER_FILLER_SECTIONS.length];
      const region = REGIONS[k % REGIONS.length];
      const status = STATUSES[(k + 1) % STATUSES.length];
      if (section === undefined || region === undefined || status === undefined) break;
      return renderE2Record({
        type: 'LG',
        id: String(3000 + k),
        fields: { section, region, status, amount: String(k % 997), src },
      });
    }
    default: {
      const lvl = ['info', 'info', 'info', 'warn'][k % 4];
      const message = FILLER_MESSAGES[k % FILLER_MESSAGES.length];
      if (lvl === undefined || message === undefined) break;
      const minutes = String(k % 60).padStart(2, '0');
      const seconds = String((k * 7) % 60).padStart(2, '0');
      return renderE2Record({
        type: 'LOG',
        id: String(1000 + k),
        fields: { ts: `0${k % 10}:${minutes}:${seconds}`, lvl, msg: message, src },
      });
    }
  }
  throw new RangeError('e2: the filler pools are empty; a pool being empty is a build error, not a tier condition');
};

/** The rows of one published ledger section, in order. */
const publishedSectionLines = (section: 's2' | 's3'): string[] => {
  const spec = E2_PUBLISHED_SECTIONS[section];
  const lines: string[] = [];
  for (let row = 0; row < spec.rows; row += 1) {
    const status = spec.status[row % spec.status.length];
    const region = REGIONS[row % REGIONS.length];
    if (status === undefined || region === undefined) {
      throw new RangeError(`e2: published section ${section} has an empty status or region pool`);
    }
    lines.push(
      renderE2Record({
        type: 'LG',
        id: String(20_000 + (section === 's2' ? 0 : 1_000) + row),
        fields: { section, region, status, amount: String((row * 13) % 997) },
      }),
    );
  }
  return lines;
};

/**
 * A block of authored records, and where it sits.
 *
 * `anchorOffset` positions a block in **rendered lines** relative to the needle
 * anchor, which is the only way to keep four families at "the same depth" when
 * one of them is 28 lines tall. A 28-line needle is 5.7% of a 490-line context
 * and 0.4% of a 7 500-line one, so expressing all four depths as fractions
 * cannot hold them together: the aggregate's answerability point would sit 28
 * lines below the lookup's at one tier and 28 lines below it in a *different
 * fraction* at the next, which is precisely the "the answer moved" confound the
 * pinned depth exists to rule out. Pinning lines against one anchor pins the
 * confound instead of introducing it.
 *
 * `depth` is the fallback for blocks that are deliberately outside the needle
 * region — the NIAH decoys, which are parked far from every needle so that the
 * magic key is unique in a context that still contains lookalikes. Their position
 * is a fraction because nothing about them is being compared across tiers.
 */
interface E2SpecialBlock {
  readonly label: string;
  readonly anchorOffset?: number;
  readonly depth?: number;
  readonly lines: readonly string[];
}

/**
 * The line span the needle region occupies, measured from the anchor.
 *
 * Exported because it is the tolerance the corpus test asserts against: a
 * family's answerability point must land inside this many lines of the anchor at
 * every tier, and the region must not grow with the context.
 */
export const E2_NEEDLE_SPAN_LINES = 40;

const specialBlocks = (tier: E2TierId): readonly E2SpecialBlock[] => {
  const magicFor = E2_NIAH_MAGIC_IDS[tier];
  // The needle region is laid out in lines around the anchor, deepest first. The
  // ledger holds the anchor and runs downward because its answerability point is
  // its last row; the one-line and five-line families sit above it, as close to
  // the anchor as their own heights allow, so the whole region is 38 lines at
  // every tier.
  return Object.freeze([
    {
      label: 'ledger',
      anchorOffset: 0,
      lines: Object.freeze([...publishedSectionLines('s2'), ...publishedSectionLines('s3')]),
    },
    {
      label: 'runbook',
      anchorOffset: -4,
      lines: Object.freeze([RUNBOOK_NEEDLE, ...RUNBOOK_DECOYS].map(renderE2Record)),
    },
    {
      label: 'escalation',
      anchorOffset: -9,
      lines: Object.freeze(
        [INCIDENT_NEEDLE, INCIDENT_HOP, INCIDENT_CHAIN_NEXT, INCIDENT_CHAIN_PREV, INCIDENT_LOOKALIKE].map(
          renderE2Record,
        ),
      ),
    },
    {
      label: 'magic',
      anchorOffset: -10,
      lines: Object.freeze([niahLine('4512', magicFor, NIAH_STAMP)].map(renderE2Record)),
    },
    {
      label: 'magic-decoys',
      depth: 0.25,
      lines: Object.freeze(
        NIAH_DECOY_STAMPS.map(([key, stamp], index) => niahLine(String(3108 + index * 2300), key, stamp)).map(
          renderE2Record,
        ),
      ),
    },
  ]);
};

/**
 * Render one tier's context extract.
 *
 * Sizing is *measured*, not declared: filler is emitted line by line while the
 * running character count is tracked, the authored blocks are spliced in at
 * their pinned depths, and any shortfall is made up with more filler. The result
 * is then checked against the tier target and the tolerance, and a context that
 * misses by more than `E2_TIER_FILL_TOLERANCE` throws instead of being returned.
 *
 * That check is the reason "four difficulty tiers at 5/20/50/80% of the window"
 * can be asserted in a test rather than believed in a comment. A renderer that
 * quietly produced 74% at the 80% tier would make every slope in the report a
 * slope over the wrong x-axis, and nothing downstream would notice.
 */
/**
 * The rendered line index the needle region is anchored at.
 *
 * Exported so the corpus test can assert the *rendered* geometry against the
 * declared anchor rather than against a copy of the formula. The needle region
 * is `[anchor - 10, anchor + 27]` at every tier: it is a fixed number of lines,
 * so its share of the context shrinks from 8% at the 5% tier to 0.5% at the 80%
 * tier, which is the point — the needle stays put while the haystack grows.
 */
export const e2NeedleAnchorLine = (tier: E2TierId): number =>
  Math.round(renderE2Context(tier).split('\n').length * E2_NEEDLE_DEPTH);

export function renderE2Context(tier: E2TierId): string {
  const spec = E2_TIERS[tier];
  const targetChars = spec.targetTokens * E2_CHARS_PER_TOKEN;
  const blocks = specialBlocks(tier);
  const header =
    `# context extract — e2 tier ${tier} — ${round4(spec.fill * 100)}% of a ${E2_WINDOW_TOKENS}-token window\n` +
    '# records are flat key=value lines; the question is at the end\n';

  // The authored blocks are subtracted from the budget before the filler is
  // counted, so the filler is sized to the space that is actually left. Sizing
  // the filler first and then splicing the blocks in would overshoot by the
  // blocks' own length — ~1% at the 80% tier, which is inside the tolerance but
  // is a systematic bias rather than rounding, and it grows with the corpus.
  let injectedChars = 0;
  for (const block of blocks) {
    for (const line of block.lines) injectedChars += line.length + 1;
  }
  const headerLines = header.split('\n').length - 1;
  // The filler is counted to completion *before* anything is placed, so the
  // rendered line total is known exactly when the anchor is computed. Emitting
  // first and measuring after left the anchor a few lines below where the blocks
  // were actually put, which showed up as a family whose answerability offset
  // moved by a line between tiers — a one-line confound in a test that exists to
  // rule out exactly that.
  const fillerBudget = Math.max(0, targetChars - header.length - injectedChars);
  let fillerChars = 0;
  let fillerCount = 0;
  while (fillerChars < fillerBudget || fillerCount < 4) {
    fillerChars += fillerLine(fillerCount).length + 1;
    fillerCount += 1;
  }
  const totalLines = headerLines + fillerCount;

  // A block *replaces* `lines.length` filler lines rather than being emitted in
  // addition to one, so the number of lines pushed always equals the position
  // reached and a block placed at index `s` renders at index `s`. Emitting a
  // filler line alongside the block pushes every later block down by the heights
  // above it, which is how a needle declared at 0.60 used to render at 0.596 with
  // the offsets varying by tier. Blocks are placed in order of ideal start and
  // pushed *down* on collision, never up, so a collision costs depth and never
  // buys a shallower-than-declared needle.
  const placements = blocks
    .map((block) => {
      const ideal =
        block.anchorOffset !== undefined
          ? Math.round(totalLines * E2_NEEDLE_DEPTH) + block.anchorOffset
          : Math.round(totalLines * (block.depth ?? E2_NEEDLE_DEPTH)) - (block.lines.length - 1);
      return { block, ideal };
    })
    .sort((left, right) => left.ideal - right.ideal);

  const at = new Map<number, readonly string[]>();
  let cursor = headerLines;
  for (const { block, ideal } of placements) {
    const start = Math.max(cursor, Math.min(totalLines - block.lines.length, ideal));
    at.set(start, block.lines);
    cursor = start + block.lines.length;
  }

  const lines: string[] = [];
  let chars = header.length;
  let fillerIndex = 0;
  for (let position = headerLines; position < totalLines; position += 1) {
    const block = at.get(position);
    if (block !== undefined) {
      for (const line of block) {
        lines.push(line);
        chars += line.length + 1;
      }
      position += block.length - 1;
      continue;
    }
    const filler = fillerLine(fillerIndex);
    fillerIndex += 1;
    lines.push(filler);
    chars += filler.length + 1;
  }

  // The filler count was measured against the block budget before placement, so
  // this is normally a no-op. It stays as a floor rather than being deleted: if a
  // future corpus makes a block's mean line shorter than the filler's, the tier
  // would silently render under its target and the check below would start
  // failing for a reason that has nothing to do with the placement logic.
  let extra = fillerIndex;
  while (chars < targetChars) {
    const filler = fillerLine(extra);
    lines.push(filler);
    chars += filler.length + 1;
    extra += 1;
  }

  const text = `${header}${lines.join('\n')}\n`;
  const actual = estimateTokens(text);
  const fill = actual / E2_WINDOW_TOKENS;
  if (Math.abs(fill - spec.fill) > E2_TIER_FILL_TOLERANCE) {
    throw new RangeError(
      `e2: tier ${tier} rendered ${actual} tokens, which is ${round4(fill * 100)}% of the ` +
        `${E2_WINDOW_TOKENS}-token window rather than the declared ${round4(spec.fill * 100)}%, outside the ` +
        `${round4(E2_TIER_FILL_TOLERANCE * 100)}% tolerance`,
    );
  }
  return text;
}

/** The question block appended to a context to make a probe's prompt. */
export const renderE2QuestionBlock = (probe: Pick<E2Probe, 'question' | 'options'>): string =>
  ['## question', probe.question, '## options', ...probe.options.map((option) => `- ${option}`), ''].join('\n');

// ------------------------------------------------------------------- probes

/** The `src=` cue each rot family declares as its noise load. */
const ROT_NOISE_CUES: Readonly<Record<'lookup' | 'multihop' | 'aggregate', string>> = Object.freeze({
  lookup: 'src=src-07',
  multihop: 'src=src-23',
  aggregate: 'src=src-41',
});

const e2CaseId = (tier: E2TierId, family: E2Family): string => `e2-${tier}-${family}`;

/**
 * The three-field conjunction that identifies the runbook needle.
 *
 * Three keys, not one, and every one of them is *load-bearing*: the authored
 * decoy block contains a row matching each pair of them, so an arm that
 * honours two constraints out of three lands on a real record and reads a real
 * but wrong `limit`. That is the poison case in the doc's sense — the wrong
 * answer is a fluent, in-context, plausible reading of the wrong row.
 */
const LOOKUP_KEYS = Object.freeze({ check: 'retry-budget', service: 'tax-service', region: 'eu-west' });

const lookupProbe = (tier: E2TierId): E2Probe =>
  Object.freeze({
    id: e2CaseId(tier, 'lookup'),
    family: 'lookup',
    tier,
    title: 'runbook limit behind a three-field conjunction',
    question:
      'One runbook row in the extract records a check, a service and a region. Report the numeric limit ' +
      'recorded for the retry-budget check on tax-service in eu-west. Reply with the limit and nothing else.',
    options: Object.freeze([RUNBOOK_NEEDLE.fields.limit as string, '4.00', '3.25', '5.75']),
    correctAnswer: RUNBOOK_NEEDLE.fields.limit as string,
    distractors: Object.freeze([
      Object.freeze({ value: '4.00', kind: 'near_miss_literal' as const }),
      Object.freeze({ value: '3.25', kind: 'near_miss_literal' as const }),
      Object.freeze({ value: '5.75', kind: 'near_miss_literal' as const }),
    ]),
    derivation: Object.freeze({ kind: 'field' as const, keys: LOOKUP_KEYS, field: 'limit' }),
    noiseCue: ROT_NOISE_CUES.lookup,
    notes:
      'decoys RB-90002/90003/90004 each match the needle on exactly two of the three keys; the lint ' +
      'checks each distractor value occurs literally in the rendered context',
  });

/** Incident fields, for the multihop family. */
const FIRST_INCIDENT = Object.freeze({
  id: recordAddress(INCIDENT_NEEDLE),
  status: INCIDENT_NEEDLE.fields.status as string,
});

/**
 * A two-step join: find the blocked incident, follow its escalation, read the
 * *second* incident's owner and service.
 *
 * The two hops are pinned to values that are in the corpus rather than computed,
 * so the lint's independent re-derivation and the model's route are the same
 * route. The distractors are the two ways the join goes wrong before it goes
 * right: the row that shares the first incident's id prefix (`INC-04119`, same
 * service and region, different owner) and the row that points *at* the first
 * incident (`INC-05088`, the previous link in the chain).
 */
const multihopProbe = (tier: E2TierId): E2Probe =>
  Object.freeze({
    id: e2CaseId(tier, 'multihop'),
    family: 'multihop',
    tier,
    title: 'owner@service across an escalation link',
    question:
      'Incident INC-04120 is blocked. Its escalation field points at another incident; that incident in turn ' +
      'carries an owner and a service. Report the owner and the service of the incident INC-04120 escalates ' +
      'to, joined with @. Reply with owner@service and nothing else.',
    options: Object.freeze([
      'team-halyard@pdf-render',
      'team-okonkwo@pdf-render',
      'team-ferreira@ledger-compactor',
      'team-halyard@checkout-api',
    ]),
    correctAnswer: 'team-halyard@pdf-render',
    distractors: Object.freeze([
      Object.freeze({ value: 'team-okonkwo@pdf-render', kind: 'near_miss_pair' as const }),
      Object.freeze({ value: 'team-ferreira@ledger-compactor', kind: 'near_miss_pair' as const }),
      Object.freeze({ value: 'team-halyard@checkout-api', kind: 'near_miss_pair' as const }),
    ]),
    derivation: Object.freeze({
      kind: 'multihop' as const,
      keys: FIRST_INCIDENT,
      hopField: 'escalates',
      compose: Object.freeze<[string, string]>(['owner', 'service']),
    }),
    noiseCue: ROT_NOISE_CUES.multihop,
    notes:
      'INC-04119 shares two of the first incident identifying fields; INC-05088 escalates *to* the first ' +
      'incident, so a one-hop read lands on it; the third distractor is a filler incident with the right owner',
  });

/** The ledger conjunction the aggregate family counts. */
const LEDGER_KEYS = Object.freeze({ section: 's3', status: 'blocked' });

/** The same status in the adjacent published section — the tempting wrong count. */
const LEDGER_NEIGHBOUR_KEYS = Object.freeze({ section: 's2', status: 'blocked' });

const aggregateProbe = (tier: E2TierId): E2Probe =>
  Object.freeze({
    id: e2CaseId(tier, 'aggregate'),
    family: 'aggregate',
    tier,
    title: 'count within one published section',
    question:
      'The extract contains two published ledger sections, s2 and s3. Count the ledger rows whose section is ' +
      's3 and whose status is blocked. Report the count as a bare number, counting only rows in section s3.',
    options: Object.freeze(['6', '5', '7', '4']),
    correctAnswer: '6',
    distractors: Object.freeze([
      Object.freeze({ value: '5', kind: 'off_by_one' as const }),
      Object.freeze({ value: '7', kind: 'off_by_one' as const }),
      Object.freeze({ value: '4', kind: 'wrong_count' as const, countKeys: LEDGER_NEIGHBOUR_KEYS }),
    ]),
    derivation: Object.freeze({ kind: 'aggregate' as const, keys: LEDGER_KEYS }),
    noiseCue: ROT_NOISE_CUES.aggregate,
    notes:
      'the s2 distractor is the count of the same status in the adjacent published section, which is the ' +
      'mistake a scanner makes when it matches the status but not the section; s2 and s3 are the only ' +
      'published sections, so filler rows can never land in the counted one',
  });

const niahProbe = (tier: E2TierId): E2Probe => {
  const magicFor = E2_NIAH_MAGIC_IDS[tier];
  return Object.freeze({
    id: e2CaseId(tier, 'niah'),
    family: 'niah',
    tier,
    title: 'needle in a haystack: one verbatim stamp',
    question:
      `Exactly one log line in the extract carries magic_for=${magicFor}. Report the stamp on that line. ` +
      'Reply with the stamp and nothing else.',
    options: Object.freeze([NIAH_STAMP, '91734', '30628', '77451']),
    correctAnswer: NIAH_STAMP,
    distractors: Object.freeze([
      Object.freeze({ value: '91734', kind: 'near_miss_literal' as const }),
      Object.freeze({ value: '30628', kind: 'near_miss_literal' as const }),
      Object.freeze({ value: '77451', kind: 'near_miss_literal' as const }),
    ]),
    derivation: Object.freeze({ kind: 'field' as const, keys: { magic_for: magicFor }, field: 'stamp' }),
    // The needle's own key. Declared noise load is therefore ~0, which is the
    // honest description of NIAH: the thing to find is unique and there is
    // nothing else like it. Every other log line carries a *different* magic
    // key, so those decoy stamps are reachable only by a wrong-key read.
    noiseCue: `magic_for=${magicFor}`,
    notes:
      'the negative control on the probe: three other lines carry a different magic_for with a different ' +
      'stamp, so the distractor values are real and in-context but belong to the wrong key',
  });
};

const probeFor = (tier: E2TierId, family: E2Family): E2Probe => {
  switch (family) {
    case 'lookup':
      return lookupProbe(tier);
    case 'multihop':
      return multihopProbe(tier);
    case 'aggregate':
      return aggregateProbe(tier);
    case 'niah':
      return niahProbe(tier);
    default:
      throw new RangeError(`e2: unknown family ${String(family)}`);
  }
};

/**
 * The 16 probes: four families at each of four tiers, one shared haystack per
 * tier.
 *
 * The sharing is the design. If each probe had its own corpus, a tier sweep
 * would also be a sweep over sixteen different haystacks, and the slope would
 * be reporting "the corpora differ" rather than "the context grew". One context
 * per tier means the *only* thing that varies across the sweep is the amount of
 * context, and every probe reads the same records.
 *
 * Frozen, and re-derived by `lintE2Probes` before anything runs: an authored
 * answer that the corpus does not support is a build failure, not a score.
 */
export function authorE2Probes(): readonly E2Probe[] {
  const probes: E2Probe[] = [];
  for (const tier of E2_TIER_IDS) {
    for (const family of E2_FAMILIES) {
      probes.push(probeFor(tier, family));
    }
  }
  return Object.freeze(probes);
}

/** The offline fixture's 16 probes. */
export const E2_PROBES: readonly E2Probe[] = authorE2Probes();

// -------------------------------------------------------------------- lint

/**
 * Rendered contexts, memoised per tier.
 *
 * The render is a pure function of the tier id, so caching it cannot change a
 * result — and it matters: a tier is up to 640 KB of generated records, and the
 * lint, the fixture builder, the runner and the report would otherwise each pay
 * for four of them. `renderE2Context` is exported for tests that want to see the
 * corpus itself.
 */
const contextCache = new Map<E2TierId, string>();

const e2Context = (tier: E2TierId): string => {
  const cached = contextCache.get(tier);
  if (cached !== undefined) return cached;
  const text = renderE2Context(tier);
  contextCache.set(tier, text);
  return text;
};

/** The fields a `near_miss_pair` distractor is checked against, in `@` order. */
const E2_PAIR_FIELDS: readonly [string, string] = Object.freeze(['owner', 'service']);

export type E2ProbeIssueCode =
  | 'option_count'
  | 'option_multiline'
  | 'answer_not_an_option'
  | 'duplicate_option'
  | 'option_contains_option'
  | 'question_contains_answer'
  | 'question_overlaps_option'
  | 'options_overlap'
  | 'unverifiable_distractor'
  | 'distractor_is_the_answer'
  | 'answer_not_derivable'
  | 'ambiguous_derivation'
  | 'noise_cue_absent'
  | 'missing_derivable_answer';

export interface E2ProbeIssue {
  readonly probeId: string;
  readonly code: E2ProbeIssueCode;
  readonly message: string;
}

/** Lowercased word tokens, for the overlap rules. */
const words = (text: string): readonly string[] => text.toLowerCase().split(/[^a-z0-9]+/u).filter((word) => word !== '');

/**
 * The longest contiguous word span shared by two texts, or 0.
 *
 * This is the low-similarity rule, and it is a *span* rule rather than a
 * set-intersection rule on purpose: a question and an option that share four
 * words in a row can be found by a keyword scorer, and one that shares four
 * words scattered across a sentence cannot. Jaccard would flag the second and
 * miss the first.
 *
 * No shipped probe trips it — every option in this fixture is a short value
 * rather than a phrase — so it is a guard for probes F2 authors, and the test
 * proves it fires rather than leaving it unexercised.
 */
export const sharedWordSpan = (a: readonly string[], b: readonly string[]): number => {
  let best = 0;
  for (const [i, first] of a.entries()) {
    for (const [j, second] of b.entries()) {
      if (first !== second) continue;
      // Bound the run by what each text actually has left. Comparing the two
      // entries without that bound walks off both ends, where `undefined ===
      // undefined` and a two-word overlap reports itself as a four-word one.
      const max = Math.min(a.length - i, b.length - j);
      let run = 0;
      while (run < max && a[i + run] === b[j + run]) run += 1;
      if (run > best) best = run;
    }
  }
  return best;
};

const distractorIsVerifiable = (distractor: E2Distractor, context: string, correctAnswer: string): string | null => {
  switch (distractor.kind) {
    case 'near_miss_literal':
      return countOccurrences(context, distractor.value) > 0
        ? null
        : `the value "${distractor.value}" occurs nowhere in the rendered context, so it is noise rather ` +
            'than a distractor: a plausible distractor has to be a reading the context actually supports';
    case 'near_miss_pair': {
      const [left, right] = distractor.value.split('@');
      if (left === undefined || right === undefined) {
        return `the value "${distractor.value}" is not in the ${E2_PAIR_FIELDS.join('@')} form this kind checks`;
      }
      return contextSupportsPair(
        context,
        { field: E2_PAIR_FIELDS[0], value: left },
        { field: E2_PAIR_FIELDS[1], value: right },
      )
        ? null
        : `no record in the context carries ${E2_PAIR_FIELDS[0]}=${left} with ${E2_PAIR_FIELDS[1]}=${right}, ` +
            'so this distractor is not reachable from the haystack';
    }
    case 'off_by_one': {
      const value = Number(distractor.value);
      const answer = Number(correctAnswer);
      if (!Number.isFinite(value) || !Number.isFinite(answer)) {
        return `"${distractor.value}" and the answer "${correctAnswer}" are not numbers, so off_by_one is ` +
          'not a claim anybody can check';
      }
      return Math.abs(value - answer) === 1
        ? null
        : `off_by_one claims "${distractor.value}" is one away from the answer "${correctAnswer}", and it is not`;
    }
    case 'wrong_count': {
      if (distractor.countKeys === undefined) {
        return 'wrong_count names no countKeys, so the count it asserts cannot be recomputed';
      }
      const recounted = String(countE2Records(context, distractor.countKeys));
      return recounted === distractor.value
        ? null
        : `wrong_count claims counting ${JSON.stringify(distractor.countKeys)} yields "${distractor.value}", ` +
            `but the context yields "${recounted}"`;
    }
    default:
      return `unknown distractor kind ${String(distractor.kind)}`;
  }
};

/**
 * Every reason a probe cannot measure rot.
 *
 * The rules divide into two groups, and the second group is the reason this
 * function exists at all.
 *
 * *Well-formedness* — the answer is one of the options, the options are
 * distinct, the question does not print its own answer. A probe that fails
 * here is not a hard probe, it is a broken one.
 *
 * *Verifiability* — the answer is re-derived from the rendered context by
 * `deriveE2Answer` and must come out equal; the derivation must select exactly
 * one record; every distractor must be checkable against the context; and the
 * declared noise cue must actually occur. These are the checks that make the
 * word "synthetic" in docs/evaluation.md §E2 mean *generated with a known
 * answer* rather than *invented*. Each one is a claim a reader would otherwise
 * have to take on trust, and a claim that can be checked and is not checked is
 * a claim that has stopped being worth anything.
 */
export function lintE2Probes(probes: readonly E2Probe[]): readonly E2ProbeIssue[] {
  const issues: E2ProbeIssue[] = [];
  const add = (probe: E2Probe, code: E2ProbeIssueCode, message: string): void => {
    issues.push({ probeId: probe.id, code, message });
  };

  for (const probe of probes) {
    const context = e2Context(probe.tier);
    const questionWords = words(probe.question);

    if (probe.options.length !== E2_OPTION_COUNT) {
      add(
        probe,
        'option_count',
        `carries ${probe.options.length} options; ${E2_OPTION_COUNT} keeps chance accuracy at a known ` +
          `${E2_CHANCE_ACCURACY} and gives the "is the easy tier above chance" check something to compare to`,
      );
    }
    if (!probe.options.includes(probe.correctAnswer)) {
      add(probe, 'answer_not_an_option', `the answer "${probe.correctAnswer}" is not among its options`);
    }
    for (const option of probe.options) {
      // The transcript carries `answer=<option>` on one line and the oracle reads
      // it back with a single-line regex, so a multi-line option would arrive at
      // the grader truncated and be scored as an unrecognised answer.
      if (/[\r\n]/u.test(option)) {
        add(
          probe,
          'option_multiline',
          `option ${JSON.stringify(option)} spans lines, so it cannot survive the answer= transcript the ` +
            'oracle grades from',
        );
      }
    }
    if (words(probe.question).includes(probe.correctAnswer.toLowerCase())) {
      add(
        probe,
        'question_contains_answer',
        `the question contains its own answer ("${probe.correctAnswer}"), so the probe can be answered ` +
          'without reading the context at all',
      );
    }

    const seen = new Set<string>();
    for (const option of probe.options) {
      if (seen.has(option)) add(probe, 'duplicate_option', `option "${option}" appears more than once`);
      seen.add(option);
    }
    for (const option of probe.options) {
      for (const other of probe.options) {
        if (option === other) continue;
        if (other.includes(option)) {
          add(
            probe,
            'option_contains_option',
            `option "${option}" is a substring of option "${other}", so the two cannot be told apart by a ` +
              'reader or a scorer and one of them is decorative',
          );
        }
      }
    }

    for (const option of probe.options) {
      const span = sharedWordSpan(questionWords, words(option));
      if (span >= E2_OPTION_SHARED_NGRAM) {
        add(
          probe,
          'question_overlaps_option',
          `option "${option}" shares a ${span}-word span with the question, so a keyword scorer can find it ` +
            `without reading the context; the low-similarity rule allows ${E2_OPTION_SHARED_NGRAM - 1}`,
        );
      }
    }
    for (const [i, a] of probe.options.entries()) {
      for (const b of probe.options.slice(i + 1)) {
        const span = sharedWordSpan(words(a), words(b));
        if (span >= E2_OPTION_SHARED_NGRAM) {
          add(
            probe,
            'options_overlap',
            `options "${a}" and "${b}" share a ${span}-word span, so they are the same option twice`,
          );
        }
      }
    }

    if (countOccurrences(context, probe.noiseCue) === 0) {
      add(
        probe,
        'noise_cue_absent',
        `the declared noise cue "${probe.noiseCue}" does not occur in the tier ${probe.tier} context, so the ` +
          'noise load this probe declares is not a measurement of anything',
      );
    }

    const derived = deriveE2Answer(probe, context);
    if (derived === null) {
      add(
        probe,
        'missing_derivable_answer',
        `the ${probe.derivation.kind} derivation found nothing in the tier ${probe.tier} context, so the ` +
          'probe has no answer the model could find either',
      );
    } else if (derived !== probe.correctAnswer) {
      add(
        probe,
        'answer_not_derivable',
        `the context re-derives to "${derived}" but the probe is authored with "${probe.correctAnswer}"; the ` +
          'answer key and the corpus disagree',
      );
    }

    if (probe.derivation.kind !== 'aggregate' && countE2Records(context, probe.derivation.keys) !== 1) {
      add(
        probe,
        'ambiguous_derivation',
        `the ${probe.derivation.kind} derivation matches ${countE2Records(context, probe.derivation.keys)} ` +
          'records, so the question has more than one reading',
      );
    }
    if (probe.derivation.kind === 'aggregate' && countE2Records(context, probe.derivation.keys) === 0) {
      add(
        probe,
        'ambiguous_derivation',
        'the aggregate counts zero records, so the probe measures a count of nothing',
      );
    }

    const wrongOptions = probe.options.filter((option) => option !== probe.correctAnswer);
    for (const distractor of probe.distractors) {
      if (distractor.value === probe.correctAnswer) {
        add(probe, 'distractor_is_the_answer', `the answer is listed as a distractor: "${distractor.value}"`);
        continue;
      }
      if (!wrongOptions.includes(distractor.value)) {
        add(
          probe,
          'unverifiable_distractor',
          `distractor "${distractor.value}" is not one of the wrong options, so the probe offers a wrong ` +
            'answer that is not on the sheet',
        );
        continue;
      }
      const problem = distractorIsVerifiable(distractor, context, probe.correctAnswer);
      if (problem !== null) add(probe, 'unverifiable_distractor', problem);
    }
    for (const option of wrongOptions) {
      if (!probe.distractors.some((distractor) => distractor.value === option)) {
        add(
          probe,
          'unverifiable_distractor',
          `wrong option "${option}" carries no distractor rule, so nothing checks that it is a plausible ` +
            'reading of the context rather than a typo',
        );
      }
    }
  }

  return Object.freeze(issues);
}

// ------------------------------------------------------------------ fixture

/** The constraint id a probe's answer key is carried on. */
const answerKeyId = (probeId: string): string => `${probeId}-answer-key`;

export type E2Document = Record<string, unknown>;

/**
 * The fixture document.
 *
 * One case per (tier, family), and the *same* context rendered into all four
 * probes at a tier. The prompt is the rendered context plus the question block,
 * so a case prompt is self-contained: the derivation oracle, the injected model
 * and the test suite all read the same bytes, and a probe cannot be answered
 * from anything that is not in its own prompt.
 */
export const buildE2Document = (probes: readonly E2Probe[] = E2_PROBES): E2Document => ({
  evalSuiteFormatVersion: EVAL_FIXTURE_FORMAT_VERSION,
  suite: E2_SUITE_ID,
  name: E2_SUITE_NAME,
  description:
    'Context rot probe per docs/evaluation.md E2: four difficulty tiers at 5/20/50/80% of a ' +
    `${E2_WINDOW_TOKENS}-token window, one shared haystack per tier, three rot families (three-field ` +
    'lookup, escalation multihop, in-section aggregate) plus a NIAH control. Every answer is re-derived ' +
    'from the rendered context by a deterministic oracle and every distractor is checked against that ' +
    'context, so a "synthetic" task here means a task with a known answer rather than an invented one. ' +
    `Offline scale is ${probes.length} probes; ${E2_CASES_PER_TIER_TARGET} rot cases per tier and a live ` +
    'model are TODO(WS-F, F2) and are not claimed here.',
  cases: probes.map((probe) => ({
    id: probe.id,
    title: probe.title,
    arms: [...E2_ARMS],
    // Only the rot families reproduce the failure, and only at the tiers where
    // the truncated arm loses the evidence. A NIAH case is the *probe's* control
    // and marking it a negative control would put "the control failed" in the
    // report as a finding about the product.
    negativeControl: isE2RotFamily(probe.family),
    prompt: `${e2Context(probe.tier)}${renderE2QuestionBlock(probe)}`,
    notes: probe.notes,
    constraints: [
      {
        // The answer key *is* the constraint. One constraint per case, whose
        // text is the question and whose forbidden markers are the three wrong
        // options, so the harness's existing deterministic grading scores a
        // multiple-choice probe with no new grading path: correct answer means
        // no forbidden marker, wrong answer means the marker it chose.
        id: answerKeyId(probe.id),
        text: probe.question,
        kind: 'project_rule',
        forbidden: probe.options.filter((option) => option !== probe.correctAnswer),
      },
    ],
  })),
});

export type E2IssueCode = FixtureIssueCode | E2ProbeIssueCode | 'missing_arm' | 'missing_family' | 'missing_tier';

export interface E2Issue {
  readonly path: string;
  readonly code: E2IssueCode;
  readonly message: string;
}

/** The `E2ProbeIssueCode`s that are also reasons to refuse a *fixture*. */
const PROBE_ISSUE_CODES: readonly E2ProbeIssueCode[] = Object.freeze<E2ProbeIssueCode[]>([
  'answer_not_an_option',
  'answer_not_derivable',
  'ambiguous_derivation',
  'unverifiable_distractor',
  'missing_derivable_answer',
]);

/**
 * Suite-level rules, all of them conditions under which G5 would mean something
 * other than what it says.
 *
 * - every arm on every case, or the curve is fitted to different case sets;
 * - every family at every tier, or the sweep is not the sweep §E2 describes;
 * - no probe-level issue that would make a score uninterpretable.
 */
export function checkE2Rules(fixture: EvalFixture, probes: readonly E2Probe[] = E2_PROBES): readonly E2Issue[] {
  const issues: E2Issue[] = lintE2Probes(probes).map((issue) => ({
    path: issue.probeId,
    code: issue.code,
    message: `${issue.probeId}: ${issue.message}`,
  }));

  fixture.cases.forEach((evalCase, caseIndex) => {
    for (const arm of E2_ARMS) {
      if (!evalCase.arms.includes(arm)) {
        issues.push({
          path: `cases[${caseIndex}].arms`,
          code: 'missing_arm',
          message: `does not run "${arm}"; a slope fitted from different case sets per arm is not a comparison`,
        });
      }
    }
  });

  // Coverage is checked against the *document*, not the probe list. The two can
  // disagree — a fixture that silently drops its hardest tier still lints clean,
  // and it is precisely that fixture whose curve would be read as a result.
  const caseIds = new Set(fixture.cases.map((evalCase) => evalCase.id));
  for (const tier of E2_TIER_IDS) {
    for (const family of E2_FAMILIES) {
      if (!caseIds.has(e2CaseId(tier, family))) {
        issues.push({
          path: 'cases',
          code: 'missing_family',
          message: `has no ${family} probe at tier ${tier}; §E2's sweep is four families at four tiers`,
        });
      }
    }
  }

  return Object.freeze(issues);
}

export class E2FixtureError extends Error {
  readonly issues: readonly E2Issue[];

  constructor(issues: readonly E2Issue[]) {
    super(issues.map((issue) => (issue.path === '' ? issue.message : `${issue.path} ${issue.message}`)).join('; '));
    this.name = 'E2FixtureError';
    this.issues = issues;
  }
}

/** Every E2-specific problem in a fixture document, base validation included. */
export const validateE2Document = (input: unknown): readonly E2Issue[] => {
  const base = validateFixture(input);
  if (base.length > 0) return Object.freeze([...base]);
  return checkE2Rules(parseFixture(input));
};

/**
 * Build the fixture, or refuse.
 *
 * Two refusals: probes the lint cannot verify (so a reported accuracy would be
 * a number with no meaning) and a document the suite's own rules reject. A
 * harness that will run a suite it cannot measure is worse than one that
 * crashes, because the crash is visible.
 */
export function buildE2Fixture(probes: readonly E2Probe[] = E2_PROBES): EvalFixture {
  const document = buildE2Document(probes);
  const base = validateFixture(document);
  const rules = checkE2Rules(parseFixture(document), probes);
  const issues: E2Issue[] = [...base, ...rules.filter((issue) => PROBE_ISSUE_CODES.includes(issue.code as E2ProbeIssueCode))];
  if (issues.length > 0) throw new E2FixtureError(issues);
  return parseFixture(document);
}

// ------------------------------------------------------------------ subject

/**
 * What a stage or a model is handed for one (case, arm) pair.
 *
 * Note what is *not* here: the answer key, the distractors, the tier id as a
 * difficulty, and the noise cue. A view that carried the correct answer would
 * make every curve flat, and a view that carried the cue would make the noise
 * model a lookup instead of a measurement. Everything the model can use is
 * inside `prompt`.
 */
export interface E2SubjectView {
  readonly caseId: string;
  readonly arm: Arm;
  readonly tier: E2TierId;
  readonly family: E2Family;
  /** The rendered context plus the question block: the model's whole input. */
  readonly prompt: string;
  /** The rendered context on its own, so noise can be counted without parsing. */
  readonly context: string;
  /** Modelled context size in tokens. The suite measures tokens itself; this is
   *  for a subject's own bookkeeping and is never used for scoring. */
  readonly contextTokens: number;
  readonly question: string;
  readonly options: readonly string[];
}

/** What a gateway stage did to a context. */
export interface E2PresentedContext {
  /** Free-form label for the report: what the stage did. */
  readonly stage: string;
  /** The text the model would actually receive. */
  readonly context: string;
  /**
   * True when `context` is a *summary* rather than a subset of the input.
   *
   * A summary cannot be read by the derivation oracle, so its cases are
   * excluded from the curve and reported separately. Declaring it is the
   * subject's honesty; `assertE2Presented` then checks the declaration against
   * the bytes, so a stage cannot pass a summary off as verbatim.
   */
  readonly lossy: boolean;
}

/** What the model answered. */
export interface E2Answer {
  /** The option the model chose, as option text. */
  readonly answer: string;
  /**
   * The model's own belief that the evidence survived.
   *
   * Audited, never trusted: the suite re-derives presence from the context text
   * the arm returned, and a disagreement is reported. A model that says
   * "I could not find it" when the line is right there is measuring something
   * other than rot, and the report has to be able to say so.
   */
  readonly evidenceRetained: boolean;
  /** Raw output, kept verbatim so a failure can be diffed. */
  readonly freeText: string | undefined;
}

/**
 * The subject under test, injected.
 *
 * A function pair, not an import, and that is the design rather than a
 * limitation: the offline tests supply a deterministic model and F2 supplies the
 * real gateway and a real provider, and nothing here can tell the difference —
 * which is the property that lets the measuring apparatus be tested against a
 * thing that measurably fails.
 *
 * The two halves are separate because E2 measures two different things. `present`
 * is the **gateway** (what context reaches the model at all), and it is where
 * truncation and pointerisation live. `answer` is the **model**, and it never
 * sees the presented context except through the argument it is given.
 */
export interface E2Subject {
  /** What to call the subject in the report's provenance. */
  readonly id: string;
  present(view: E2SubjectView): E2PresentedContext;
  answer(view: E2SubjectView, presented: E2PresentedContext): E2Answer;
}

/** Line sets per tier, for the verbatim-subset check. */
const lineSets = new Map<E2TierId, ReadonlySet<string>>();
/** Record ids per tier, so a pointer can be resolved to a record that exists. */
const recordIdSets = new Map<E2TierId, ReadonlySet<string>>();

const e2LineSet = (tier: E2TierId): ReadonlySet<string> => {
  const cached = lineSets.get(tier);
  if (cached !== undefined) return cached;
  const set = new Set(e2Context(tier).split('\n'));
  lineSets.set(tier, set);
  return set;
};

const e2RecordIdSet = (tier: E2TierId): ReadonlySet<string> => {
  const cached = recordIdSets.get(tier);
  if (cached !== undefined) return cached;
  const set = new Set<string>();
  for (const line of e2LineSet(tier)) {
    const id = parseE2RecordLine(line)?.id;
    if (id !== undefined) set.add(id);
  }
  recordIdSets.set(tier, set);
  return set;
};

/** `PTR-RB-90001` — a reference to a record that exists in the input. */
const E2_POINTER_LINE = /^PTR-([A-Z]{2,4}-[0-9]+)$/;

/**
 * The bytes an arm returned, checked.
 *
 * Three claims are verified here rather than believed:
 *
 * 1. **`lossy` is honest.** If `lossy` is false, every line of the returned
 *    context must be a line of the input. A stage that drops records *and*
 *    claims to be lossless would otherwise have its deletions scored as rot —
 *    the suite would report "this treatment causes context rot" about a stage
 *    that simply threw data away.
 * 2. **Pointers point at something.** A `PTR-` line is allowed — pointerisation
 *    is a real gateway behaviour and E4 will need it — but only to a record that
 *    exists. A pointer to an invented record is a stage that made the context
 *    *look* lossless while adding information, which is the worst of both.
 * 3. **A pointer is not evidence.** The oracle derives answers from record
 *    lines, so a context carrying only pointers measures as having lost the
 *    evidence even though the stage did its job. That is a limitation of the
 *    offline oracle and it is reported as such rather than papered over.
 */
export function assertE2Presented(presented: E2PresentedContext, view: E2SubjectView): void {
  if (typeof presented !== 'object' || presented === null) {
    throw new TypeError(`e2: ${view.arm}/${view.caseId}: present() returned no object`);
  }
  if (typeof presented.stage !== 'string' || presented.stage === '') {
    throw new TypeError(`e2: ${view.arm}/${view.caseId}: present() named no stage`);
  }
  if (typeof presented.context !== 'string') {
    throw new TypeError(`e2: ${view.arm}/${view.caseId}: present() returned a non-string context`);
  }
  if (typeof presented.lossy !== 'boolean') {
    throw new TypeError(
      `e2: ${view.arm}/${view.caseId}: present() did not say whether its context is lossy; a stage that ` +
        'summarises without saying so would have its cases dropped from the curve without explanation',
    );
  }
  if (presented.lossy) return;

  const allowed = e2LineSet(view.tier);
  const ids = e2RecordIdSet(view.tier);
  for (const line of presented.context.split('\n')) {
    if (line === '' || allowed.has(line)) continue;
    const pointer = E2_POINTER_LINE.exec(line);
    if (pointer !== null) {
      const id = pointer[1];
      if (id !== undefined && ids.has(id)) continue;
      throw new TypeError(
        `e2: ${view.arm}/${view.caseId}: stage "${presented.stage}" emitted pointer ${line}, which names a ` +
          'record that is not in the input context',
      );
    }
    throw new TypeError(
      `e2: ${view.arm}/${view.caseId}: stage "${presented.stage}" claimed a lossless context but emitted a ` +
        `line that is not in the input: ${JSON.stringify(line.slice(0, 80))}`,
    );
  }
}

/** The transcript line the oracle grades from. One per (case, arm). */
const renderE2Response = (header: string, answer: string, freeText: string | undefined): string => {
  const transcript = `${header}\nanswer=${answer}`;
  return freeText === undefined || freeText === '' ? transcript : `${transcript}\n${freeText}`;
};

/**
 * Read the emitted answer back out of a transcript.
 *
 * The transcript, not the subject's structured return. A subject that returns
 * `answer: "3.50"` while its own transcript says `answer=4.00` has graded itself
 * against a record of the run that did not happen, and the only way to catch
 * that is to score the artifact rather than the return value. The first
 * `answer=` line wins, so a model that reasons and *then* answers cannot have
 * its answer overwritten by a mention of the format earlier in the text.
 */
export const extractE2EmittedAnswer = (response: string): string | null => {
  const match = /^answer=(.*)$/mu.exec(response);
  const value = match?.[1];
  return value === undefined ? null : value.trim();
};

// ------------------------------------------------------------------- runner

/** One (case, arm) pair, recorded so the oracle can be re-run independently. */
export interface E2RecordedCall {
  readonly caseId: string;
  readonly arm: Arm;
  readonly position: number;
  /** The stage the subject named. */
  readonly stage: string;
  /** The stage's own `lossy` claim, cross-checked against its bytes. */
  readonly claimedLossy: boolean;
  /** Tokens the *suite* counted on the returned text. Never the subject's number. */
  readonly presentedTokens: number;
  /** Evidence presence re-derived by the suite from the returned text. */
  readonly evidencePresent: boolean;
  /** What the subject claimed about presence. */
  readonly evidenceClaim: boolean;
  /** The answer read back out of the transcript. */
  readonly emitted: string | null;
  /** Whether the emitted text is exactly one of the probe's options. */
  readonly answerRecognised: boolean;
  readonly correct: boolean;
}

/** A pair of (case, arm) that the subject and the oracle describe differently. */
export interface E2Disagreement {
  readonly caseId: string;
  readonly arm: Arm;
  readonly field: 'answer' | 'evidence';
  readonly detail: string;
}

export interface E2Audit {
  readonly calls: readonly E2RecordedCall[];
  /**
   * Must be empty.
   *
   * Two kinds, and both invalidate the run rather than merely adding to it: a
   * transcript whose answer is not the answer the subject returned, and an
   * evidence claim that the returned text contradicts. A subject that
   * misdescribes its own output cannot be measured by it.
   */
  readonly disagreements: readonly E2Disagreement[];
  /** `(case, arm)` pairs whose presented context was lossy and so unmeasurable. */
  readonly lossyCalls: readonly string[];
  /** `(case, arm)` pairs the evidence audit says lost the evidence. */
  readonly evidenceLostCalls: readonly string[];
}

export interface E2ArmRunnerHandle {
  /** Pass to `runSuite` as `runArm`. */
  readonly run: SyncArmRunner;
  /** The recorded calls, for the audit and the report. */
  readonly recorded: () => readonly E2RecordedCall[];
}

/**
 * Adapt an injected subject to the harness's `ArmRunner` shape.
 *
 * The mechanism, stated once so the whole suite can be read from it: the subject
 * presents a context and answers a question; the suite counts the tokens,
 * re-derives the answer from the returned bytes, and grades *that*. The subject
 * declares neither the token count nor its own correctness.
 */
export function createE2ArmRunner(
  probes: readonly E2Probe[] = E2_PROBES,
  subject: E2Subject,
): E2ArmRunnerHandle {
  const byCase = new Map<string, E2Probe>(probes.map((probe) => [probe.id, probe]));
  const log: E2RecordedCall[] = [];

  const run = (invocation: Parameters<SyncArmRunner>[0]): ArmObservation => {
    const probe = byCase.get(invocation.case.id);
    if (probe === undefined) {
      throw new Error(
        `e2: case "${invocation.case.id}" has no probe; the fixture and the subject must be built from the ` +
          'same probe list or the suite is answering a question it never asked',
      );
    }

    const context = e2Context(probe.tier);
    const questionBlock = renderE2QuestionBlock(probe);
    const prompt = `${context}${questionBlock}`;
    if (invocation.case.prompt !== prompt) {
      throw new Error(
        `e2: case "${invocation.case.id}" was built from a different corpus than the probe list; the prompt ` +
          'in the fixture and the prompt the subject would receive must be the same bytes',
      );
    }

    const view: E2SubjectView = {
      caseId: probe.id,
      arm: invocation.arm,
      tier: probe.tier,
      family: probe.family,
      prompt,
      context,
      contextTokens: estimateTokens(context),
      question: probe.question,
      options: probe.options,
    };

    const presented = subject.present(view);
    assertE2Presented(presented, view);
    const answer = subject.answer(view, presented);
    if (typeof answer !== 'object' || answer === null || typeof answer.answer !== 'string') {
      throw new TypeError(`e2: ${invocation.arm}/${probe.id}: answer() returned no answer string`);
    }

    const presentedTokens = estimateTokens(presented.context);
    // The oracle's own reading of the returned bytes. Two separate questions:
    // does the context still *support* the answer, and did the model *find* it.
    const derived = deriveE2Answer(probe, presented.context);
    const evidencePresent = derived === probe.correctAnswer;
    const header =
      `[arm=${invocation.arm} case=${probe.id} pos=${invocation.position} stage=${presented.stage} ` +
      `claimedLossy=${String(presented.lossy)} evidence=${evidencePresent ? 'present' : 'absent'} ` +
      `tokens=${presentedTokens}]`;
    const response = renderE2Response(header, answer.answer, answer.freeText);
    const emitted = extractE2EmittedAnswer(response);
    const answerRecognised = emitted !== null && probe.options.includes(emitted);
    const correct = answerRecognised && emitted === probe.correctAnswer;

    const keyId = answerKeyId(probe.id);
    log.push(
      Object.freeze({
        caseId: probe.id,
        arm: invocation.arm,
        position: invocation.position,
        stage: presented.stage,
        claimedLossy: presented.lossy,
        presentedTokens,
        evidencePresent,
        evidenceClaim: answer.evidenceRetained === true,
        emitted,
        answerRecognised,
        correct,
      }),
    );

    return {
      arm: invocation.arm,
      position: invocation.position,
      caseId: invocation.case.id,
      ok: true,
      error: null,
      response,
      // Graded from the transcript, never from the subject's own claim.
      retainedConstraintIds: correct ? [keyId] : [],
      droppedConstraintIds: [],
      violatedConstraintIds: correct ? [] : [keyId],
      inputTokens: presentedTokens,
      outputTokens: estimateTokens(response),
      latencyMs: 0,
    };
  };

  return { run, recorded: () => Object.freeze([...log]) };
}

/**
 * The independent pass over what the arms actually returned.
 *
 * Runs *after* `runSuite` and reads the recorded calls, not the report, so a
 * disagreement between what a subject said and what its bytes support is
 * visible even when the report grades green.
 */
export function auditE2Calls(calls: readonly E2RecordedCall[]): E2Audit {
  const disagreements: E2Disagreement[] = [];
  const lossyCalls: string[] = [];
  const evidenceLostCalls: string[] = [];

  for (const call of calls) {
    if (call.emitted === null) {
      disagreements.push({
        caseId: call.caseId,
        arm: call.arm,
        field: 'answer',
        detail: 'the transcript carries no answer= line, so there is nothing to grade',
      });
    }
    if (call.evidencePresent !== call.evidenceClaim) {
      disagreements.push({
        caseId: call.caseId,
        arm: call.arm,
        field: 'evidence',
        detail:
          `the subject claimed evidence ${call.evidenceClaim ? 'survived' : 'was lost'}, but the returned ` +
          `context ${call.evidencePresent ? 'supports' : 'does not support'} the answer`,
      });
    }
    if (call.claimedLossy) lossyCalls.push(`${call.caseId}/${call.arm}`);
    if (!call.evidencePresent) evidenceLostCalls.push(`${call.caseId}/${call.arm}`);
  }

  return Object.freeze({
    calls: Object.freeze([...calls]),
    disagreements: Object.freeze(
      [...disagreements].sort(
        (a, b) => a.caseId.localeCompare(b.caseId) || a.arm.localeCompare(b.arm) || a.field.localeCompare(b.field),
      ),
    ),
    lossyCalls: Object.freeze([...lossyCalls].sort()),
    evidenceLostCalls: Object.freeze([...evidenceLostCalls].sort()),
  });
}

// --------------------------------------------------------------- statistics

/** One (tier, arm) cell: the unit the curve is fitted from. */
export interface E2Cell {
  readonly caseId: string;
  readonly tier: E2TierId;
  readonly family: E2Family;
  readonly arm: Arm;
  readonly passed: boolean;
  /** True when the arm's context was lossy, so the cell is not a measurement. */
  readonly excluded: boolean;
}

export interface E2TierAccuracy {
  readonly tier: E2TierId;
  readonly fill: number;
  readonly cases: number;
  readonly correct: number;
  /** `correct / cases`, or null when every case at this tier was excluded. */
  readonly accuracy: number | null;
  readonly ciLower: number;
  readonly ciUpper: number;
  readonly excluded: number;
}

/**
 * Pool accuracy per tier, over the cells that survived.
 *
 * Excluded cells are *removed*, not scored as failures. A lossy context is a
 * stage that failed to deliver a measurement, and counting it as a wrong answer
 * would put a delivery failure into the rot curve — the same category error as
 * treating a thrown arm as a wrong answer, which `../runner.js` also refuses.
 * The count of excluded cells is reported so the removal is visible.
 */
export function e2TierAccuracy(cells: readonly E2Cell[], arm: Arm, family: 'rot' | 'niah'): readonly E2TierAccuracy[] {
  return Object.freeze(
    E2_TIER_IDS.map((tier) => {
      const at = cells.filter(
        (cell) =>
          cell.arm === arm &&
          cell.tier === tier &&
          (family === 'rot' ? isE2RotFamily(cell.family) : cell.family === 'niah'),
      );
      const scored = at.filter((cell) => !cell.excluded);
      const correct = scored.filter((cell) => cell.passed).length;
      const interval = wilsonInterval(correct, scored.length, E2_ALPHA);
      return Object.freeze({
        tier,
        fill: E2_TIERS[tier].fill,
        cases: scored.length,
        correct,
        accuracy: scored.length === 0 ? null : correct / scored.length,
        ciLower: interval.lower,
        ciUpper: interval.upper,
        excluded: at.length - scored.length,
      });
    }),
  );
}

export interface E2SlopeFit {
  /** Degradation per unit window fill. **Positive means getting worse.** */
  readonly slope: number;
  readonly intercept: number;
  readonly points: number;
  /**
   * How linear the four points are, or null when they do not vary at all.
   *
   * Reported because a slope fitted to four points is a *summary*, and a curve
   * that is flat then crashes has a slope and an `r²` that tell different
   * stories: the slope averages the crash away, which is precisely the
   * "flattering endpoint" §E2 warns about. A reader gets both.
   */
  readonly rSquared: number | null;
}

/**
 * Ordinary least squares of degradation against window fill.
 *
 * Unweighted, and one point per tier. Unweighted because the tiers are the
 * design: they are 5/20/50/80% by fiat, so a fit that weighted them by how many
 * cases happened to land in each would be fitting the sampling, not the sweep.
 *
 * The dependent variable is `1 − accuracy`, not accuracy — see the module header
 * for why the sign convention is a decision rather than a transcription.
 */
export function fitE2RotSlope(tierAccuracy: readonly E2TierAccuracy[]): E2SlopeFit {
  const points = tierAccuracy.filter((tier) => tier.accuracy !== null);
  if (points.length < 2) {
    return { slope: Number.NaN, intercept: Number.NaN, points: points.length, rSquared: null };
  }
  const n = points.length;
  const meanX = points.reduce((sum, point) => sum + point.fill, 0) / n;
  const meanY = points.reduce((sum, point) => sum + (1 - (point.accuracy ?? 0)), 0) / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const point of points) {
    const dx = point.fill - meanX;
    const dy = 1 - (point.accuracy ?? 0) - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (sxx === 0) {
    return { slope: Number.NaN, intercept: Number.NaN, points: n, rSquared: null };
  }
  const slope = sxy / sxx;
  return {
    slope,
    intercept: meanY - slope * meanX,
    points: n,
    rSquared: syy === 0 ? null : (sxy * sxy) / (sxx * syy),
  };
}

export interface E2SlopeIntervalOptions {
  readonly resamples?: number;
  readonly seed?: number;
  readonly alpha?: number;
}

export type E2SlopeIntervalState = 'ok' | 'degenerate';

export interface E2SlopeInterval {
  /** The observed `slope_treatment − slope_control`. */
  readonly point: number;
  /** Percentile bounds, or NaN when the bootstrap produced nothing usable. */
  readonly lower: number;
  readonly upper: number;
  readonly resamples: number;
  /** Replicates actually used; lower than `resamples` when some were skipped. */
  readonly usedResamples: number;
  readonly state: E2SlopeIntervalState;
}

/**
 * A paired, tier-stratified bootstrap of the slope *difference*.
 *
 * Three properties, each of which is a way this number is usually got wrong:
 *
 * 1. **Paired.** The arms are refit on the *same* resampled case set, so
 *    case-to-case difficulty cancels. Resampling the arms independently would
 *    throw that away and inflate the interval.
 * 2. **Stratified by tier.** Cases are resampled *within* each tier, so every
 *    replicate has cases at all four fills. Unstratified resampling can leave a
 *    tier empty, which would silently drop a point from a four-point fit and
 *    change the slope being estimated.
 * 3. **The whole curve is refit.** Each replicate recomputes both arms' slopes
 *    from the resampled accuracies and then differences them, because the
 *    quantity of interest is a ratio-like quantity of fitted lines rather than
 *    a mean of independent samples.
 *
 * The degenerate case is real and reported rather than smoothed over: with three
 * cases per tier, a replicate in which every arm got everything right at every
 * tier has zero variance and no defined slope. Those replicates are skipped and
 * counted, and if too few survive, the interval is `degenerate` and the gate says
 * `inconclusive` instead of printing an interval that came from 4 usable draws.
 */
export function bootstrapE2SlopeDifference(
  cells: readonly E2Cell[],
  options: E2SlopeIntervalOptions = {},
): E2SlopeInterval {
  const resamples = options.resamples ?? E2_SLOPE_RESAMPLES;
  const seed = options.seed ?? E2_SLOPE_BOOTSTRAP_SEED;
  const alpha = options.alpha ?? E2_ALPHA;

  const slopeOf = (sample: readonly E2Cell[], arm: Arm): number =>
    fitE2RotSlope(e2TierAccuracy(sample, arm, 'rot')).slope;

  const rot = cells.filter((cell) => isE2RotFamily(cell.family) && !cell.excluded);
  // Pairing is by *case*, not by copying a control cell onto the other arms. A
  // replicate has to carry each arm's own outcome for the cases it drew: cloning
  // the control outcome would make every replicate's difference exactly zero and
  // the interval a zero-width line through it, which is the most flattering
  // possible interval and a completely fictional one.
  const paired = new Map<E2TierId, Map<string, Map<Arm, E2Cell>>>();
  for (const cell of rot) {
    const cases = paired.get(cell.tier) ?? new Map<string, Map<Arm, E2Cell>>();
    const arms = cases.get(cell.caseId) ?? new Map<Arm, E2Cell>();
    arms.set(cell.arm, cell);
    cases.set(cell.caseId, arms);
    paired.set(cell.tier, cases);
  }
  // Only cases both compared arms ran are drawable, so a replicate always fits
  // control and treatment on the same case set and neither is quietly fitted on
  // fewer cases. The truncated arm is a reported arm, not a compared one, so its
  // absence must not cost the interval.
  const compared: readonly Arm[] = [E2_BASELINE_ARM, 'treatment'];
  const byTier = new Map<E2TierId, ReadonlyMap<Arm, E2Cell>[]>();
  for (const tier of E2_TIER_IDS) {
    const complete = [...(paired.get(tier) ?? new Map<string, Map<Arm, E2Cell>>()).values()].filter((arms) =>
      compared.every((arm) => arms.get(arm) !== undefined),
    );
    byTier.set(tier, complete);
  }
  const point =
    slopeOf(rot, 'treatment') -
    slopeOf(rot, 'control');
  if (cells.length === 0 || rot.length === 0) {
    return { point, lower: Number.NaN, upper: Number.NaN, resamples, usedResamples: 0, state: 'degenerate' };
  }

  const differences: number[] = [];
  for (let replicate = 0; replicate < resamples; replicate += 1) {
    const sample: E2Cell[] = [];
    let usable = true;
    for (const tier of E2_TIER_IDS) {
      const pool = byTier.get(tier) ?? [];
      if (pool.length === 0) {
        usable = false;
        break;
      }
      for (let draw = 0; draw < pool.length; draw += 1) {
        const unit = Math.floor(unitValue(seed, `e2|slope|${tier}|${replicate}|${draw}`) * pool.length);
        const chosen = pool[unit];
        if (chosen === undefined) {
          usable = false;
          break;
        }
        for (const arm of E2_ARMS) {
          const cell = chosen.get(arm);
          if (cell !== undefined) sample.push(cell);
        }
      }
      if (!usable) break;
    }
    if (!usable) continue;
    const control = slopeOf(sample, 'control');
    const treatment = slopeOf(sample, 'treatment');
    if (!Number.isFinite(control) || !Number.isFinite(treatment)) continue;
    differences.push(treatment - control);
  }

  if (differences.length < Math.max(2, Math.floor(resamples * 0.5))) {
    return {
      point,
      lower: Number.NaN,
      upper: Number.NaN,
      resamples,
      usedResamples: differences.length,
      state: 'degenerate',
    };
  }

  differences.sort((a, b) => a - b);
  return {
    point,
    lower: percentile(differences, alpha / 2),
    upper: percentile(differences, 1 - alpha / 2),
    resamples,
    usedResamples: differences.length,
    state: 'ok',
  };
}

// ------------------------------------------------------- probe validity

/**
 * Slack above chance for the "is the easy tier even solvable" check.
 *
 * 5 points on top of the 0.25 chance rate, which is one extra case in four at
 * this scale. Wider would pass a probe nobody can solve; narrower would fail one
 * everybody can, on sampling alone.
 */
export const E2_CHANCE_SLACK = 0.05;

export type E2ProbeStatus = 'distinguishing' | 'blind' | 'confounded' | 'undetermined';

export interface E2ProbeValidity {
  readonly status: E2ProbeStatus;
  /** NIAH accuracy per tier on the control arm. */
  readonly niahByTier: readonly E2TierAccuracy[];
  /** Rot accuracy per tier on the control arm, pooled over the three families. */
  readonly rotByTier: readonly E2TierAccuracy[];
  /** Easy tier to hard tier, control arm. Negative is a drop. */
  readonly niahDrop: number;
  readonly rotDrop: number;
  /** Pooled accuracy at the easiest tier, over every family. */
  readonly easiestTierAccuracy: number;
  readonly niahExceedsMaxDrop: boolean;
  readonly rotDegrades: boolean;
  readonly easiestTierAtChance: boolean;
  readonly statement: string;
  readonly detail: string;
}

const tierAccuracyAt = (tiers: readonly E2TierAccuracy[], tier: E2TierId): number | null =>
  tiers.find((candidate) => candidate.tier === tier)?.accuracy ?? null;

/**
 * Is this probe measuring rot, or just input length?
 *
 * docs/evaluation.md §E2's own rule, made mechanical. The assessment is on the
 * **control** arm and never on the treatment: the treatment's job is to change
 * the curve, and a gate that could be satisfied by choosing a subject which
 * degrades everywhere is a gate with a second, hidden failure mode.
 *
 * - `confounded` — NIAH fell by more than `E2_NIAH_MAX_DROP`. The probe is
 *   measuring "long input is hard". §E2's instruction for that case is *"needs
 *   redesign"*, and the gate below refuses to read a slope from it.
 * - `blind` — the rot families did not fall either (nothing is being measured),
 *   or the easiest tier is already at chance (the probe is unsolvable and the
 *   whole curve is flat for the wrong reason).
 * - `undetermined` — both of the above, or no data. Two different faults with one
 *   label, because a single label would assert a diagnosis the data does not
 *   support.
 * - `distinguishing` — NIAH flat, rot degrading. The finding §E2 predicts.
 */
export function evaluateE2ProbeValidity(cells: readonly E2Cell[]): E2ProbeValidity {
  const niahByTier = e2TierAccuracy(cells, E2_BASELINE_ARM, 'niah');
  const rotByTier = e2TierAccuracy(cells, E2_BASELINE_ARM, 'rot');
  const niahEasy = tierAccuracyAt(niahByTier, 't05');
  const niahHard = tierAccuracyAt(niahByTier, 't80');
  const rotEasy = tierAccuracyAt(rotByTier, 't05');
  const rotHard = tierAccuracyAt(rotByTier, 't80');
  const niahDrop = niahEasy === null || niahHard === null ? Number.NaN : niahHard - niahEasy;
  const rotDrop = rotEasy === null || rotHard === null ? Number.NaN : rotHard - rotEasy;

  const scored = cells.filter((cell) => cell.arm === E2_BASELINE_ARM && !cell.excluded);
  const easy = scored.filter((cell) => cell.tier === 't05');
  const easiestTierAccuracy = easy.length === 0 ? Number.NaN : easy.filter((cell) => cell.passed).length / easy.length;

  const niahExceedsMaxDrop = Number.isFinite(niahDrop) && niahDrop < -E2_NIAH_MAX_DROP;
  const rotDegrades = Number.isFinite(rotDrop) && rotDrop < -E2_NIAH_MAX_DROP;
  const easiestTierAtChance =
    Number.isFinite(easiestTierAccuracy) && easiestTierAccuracy <= E2_CHANCE_ACCURACY + E2_CHANCE_SLACK;
  const hasData = scored.length > 0 && Number.isFinite(niahDrop) && Number.isFinite(rotDrop);

  const describe = (drop: number): string => (Number.isFinite(drop) ? `by ${round4(Math.abs(drop))} ` : '');

  let status: E2ProbeStatus;
  let statement: string;
  let detail: string;
  if (!hasData) {
    status = 'undetermined';
    statement = 'E2 probe validity is undetermined: the baseline arm has no scored cells';
    detail =
      'NIAH and rot accuracy could not both be measured on the control arm, so nothing here can say ' +
      'whether the probe detects something NIAH cannot';
  } else if (niahExceedsMaxDrop && (!rotDegrades || easiestTierAtChance)) {
    // Both faults at once: NIAH fell *and* the probe shows no rot of its own.
    // `blind` is the union of its own two conditions, so this is "confounded and
    // blind", not "confounded and fine" — which is why the rot arm of the
    // condition is negated. Reading NIAH-and-rot-both-fell as `undetermined`
    // would mislabel the most common real outcome (a probe that degrades, plus a
    // control that also degrades) as a diagnostic dead end.
    status = 'undetermined';
    statement = 'E2 probe validity is undetermined: NIAH degraded and the rot families did not degrade either';
    detail =
      `NIAH fell ${describe(niahDrop)}across the window (limit ${E2_NIAH_MAX_DROP}) and the rot families ` +
      `${rotDegrades ? 'degraded too' : 'did not fall'}` +
      `${easiestTierAtChance ? ', with the easiest tier already at chance' : ''}. Two faults at once, and a ` +
      'single diagnosis would claim more than the numbers support';
  } else if (niahExceedsMaxDrop) {
    status = 'confounded';
    statement = 'E2 probe is confounded: NIAH degrades with context length';
    detail =
      `on the control arm NIAH fell ${describe(niahDrop)}from the 5% tier to the 80% tier, over the ` +
      `${E2_NIAH_MAX_DROP} limit, while the rot families fell ${describe(rotDrop)}. Per docs/evaluation.md §E2 ` +
      'this is the "measuring long-input-is-hard" case: the probe needs redesign, and G5 is reported ' +
      'inconclusive rather than read from a slope this probe produced';
  } else if (!rotDegrades) {
    status = 'blind';
    statement = 'E2 probe is blind: the realistic tasks did not degrade either';
    detail =
      `on the control arm the rot families fell ${describe(rotDrop)}from the 5% tier to the 80% tier, at or ` +
      `under the ${E2_NIAH_MAX_DROP} limit NIAH is held to. A flat curve from a probe nobody can fail is a ` +
      'null result, not a pass, so G5 is inconclusive';
  } else if (easiestTierAtChance) {
    status = 'blind';
    statement = 'E2 probe is blind: the easiest tier is already at chance';
    detail =
      `pooled accuracy at the 5% tier is ${round4(easiestTierAccuracy)}, at or under the ` +
      `${round4(E2_CHANCE_ACCURACY)} chance rate plus ${E2_CHANCE_SLACK} slack, so every tier is flat for the ` +
      'wrong reason and the sweep measures nothing';
  } else {
    status = 'distinguishing';
    statement = 'E2 probe is distinguishing: NIAH is flat while the realistic tasks degrade';
    detail =
      `on the control arm NIAH fell ${describe(niahDrop)}across the window (within the ${E2_NIAH_MAX_DROP} ` +
      `limit) and the rot families fell ${describe(rotDrop)}, which is the shape docs/evaluation.md §E2 ` +
      'predicts: the probe detects something NIAH cannot';
  }

  return Object.freeze({
    status,
    niahByTier,
    rotByTier,
    niahDrop,
    rotDrop,
    easiestTierAccuracy,
    niahExceedsMaxDrop,
    rotDegrades,
    easiestTierAtChance,
    statement,
    detail,
  });
}

// -------------------------------------------------------------------- gate

export type E2GateId = 'G5';

export interface E2EndpointComparison {
  readonly control: number | null;
  readonly treatment: number | null;
  /** The endpoint comparison G5 does *not* use, kept so the difference is visible. */
  readonly endpointDifference: number | null;
  /**
   * True when the endpoint would have read the other way from the slope.
   *
   * The §E2 failure in one boolean: a treatment can sit above the control at the
   * 80% tier and still be growing degradation faster, and a report that printed
   * only the endpoint would call that a pass.
   */
  readonly endpointWouldMislead: boolean;
}

export interface E2GateVerdict {
  readonly gate: E2GateId;
  readonly status: 'observed' | 'not_observed' | 'inconclusive';
  readonly blocking: true;
  readonly statement: string;
  readonly detail: string;
  readonly threshold: number;
  /** `slope_treatment − slope_control` on the degradation axis. */
  readonly difference: number;
  readonly differenceCiLower: number;
  readonly differenceCiUpper: number;
  readonly controlSlope: number;
  readonly treatmentSlope: number;
  readonly truncatedSlope: number;
  readonly endpoint: E2EndpointComparison;
  readonly probe: E2ProbeValidity;
  readonly casesPerTier: number;
  readonly casesPerTierTarget: number;
  readonly degradationAxis: string;
  /** True when the whole interval sits on the passing side of the threshold. */
  readonly ciClearsThreshold: boolean;
}

/** One arm's whole curve, rot and NIAH, over the tiers. */
export interface E2ArmCurve {
  readonly arm: Arm;
  readonly rotByTier: readonly E2TierAccuracy[];
  readonly rotSlope: E2SlopeFit;
  readonly niahByTier: readonly E2TierAccuracy[];
  readonly niahSlope: E2SlopeFit;
  readonly excludedCells: number;
}

/** The three curves, keyed by arm. */
export function summariseE2Curves(cells: readonly E2Cell[]): readonly E2ArmCurve[] {
  return Object.freeze(
    E2_ARMS.map((arm) => {
      const rotByTier = e2TierAccuracy(cells, arm, 'rot');
      const niahByTier = e2TierAccuracy(cells, arm, 'niah');
      return Object.freeze({
        arm,
        rotByTier,
        rotSlope: fitE2RotSlope(rotByTier),
        niahByTier,
        niahSlope: fitE2RotSlope(niahByTier),
        excludedCells: cells.filter((cell) => cell.arm === arm && cell.excluded).length,
      });
    }),
  );
}

const curveFor = (curves: readonly E2ArmCurve[], arm: Arm): E2ArmCurve | undefined =>
  curves.find((curve) => curve.arm === arm);

const endpointOf = (curve: E2ArmCurve | undefined): number | null =>
  curve === undefined ? null : (tierAccuracyAt(curve.rotByTier, 't80') ?? null);

/**
 * G5: treatment slope ≤ control slope.
 *
 * The pre-registered test is the **point** estimate of the slope difference, and
 * the interval is reported beside it rather than substituted for it — the same
 * discipline E1 uses for G1's rate. Three ways this can be `inconclusive`, and
 * all three are refusals to read a number the data does not support:
 *
 * 1. the probe is `confounded` or `undetermined` (NIAH degraded too, or there
 *    is no data). A green slope from a probe already shown to be confounded
 *    would be worse than no gate at all, so it is not read.
 * 2. the probe is `blind`.
 * 3. fewer rot cases per tier than `E2_CASES_PER_TIER_TARGET`, which is where
 *    the offline fixture sits.
 *
 * `not_observed` survives all three: a treatment that degrades *faster* than
 * control is a finding at any n, and letting the small-n clause swallow it would
 * turn "we have not measured enough to pass" into "we have not measured enough
 * to fail", which is how a bad treatment ships.
 */
export function evaluateE2Gate(
  curves: readonly E2ArmCurve[],
  probe: E2ProbeValidity,
  interval: E2SlopeInterval,
  casesPerTier: number,
): E2GateVerdict {
  const control = curveFor(curves, E2_BASELINE_ARM);
  const treatment = curveFor(curves, 'treatment');
  const truncated = curveFor(curves, E2_TRUNCATED_ARM);
  const controlSlope = control?.rotSlope.slope ?? Number.NaN;
  const treatmentSlope = treatment?.rotSlope.slope ?? Number.NaN;
  const difference = interval.point;

  const controlEndpoint = endpointOf(control);
  const treatmentEndpoint = endpointOf(treatment);
  const endpointDifference =
    controlEndpoint === null || treatmentEndpoint === null ? null : treatmentEndpoint - controlEndpoint;
  const endpointWouldMislead =
    endpointDifference !== null &&
    Number.isFinite(difference) &&
    (endpointDifference > 0) !== (difference <= E2_SLOPE_THRESHOLD) &&
    Math.abs(endpointDifference) > 0;

  const endpoint: E2EndpointComparison = {
    control: controlEndpoint,
    treatment: treatmentEndpoint,
    endpointDifference,
    endpointWouldMislead,
  };

  const ciClearsThreshold =
    interval.state === 'ok' && interval.upper <= E2_SLOPE_THRESHOLD;
  const base = {
    gate: 'G5' as const,
    blocking: true as const,
    threshold: E2_SLOPE_THRESHOLD,
    difference,
    differenceCiLower: interval.lower,
    differenceCiUpper: interval.upper,
    controlSlope,
    treatmentSlope,
    truncatedSlope: truncated?.rotSlope.slope ?? Number.NaN,
    endpoint,
    probe,
    casesPerTier,
    casesPerTierTarget: E2_CASES_PER_TIER_TARGET,
    degradationAxis: E2_DEGRADATION_AXIS,
    ciClearsThreshold,
  };

  const slopes = (): string =>
    `control slope ${round4(controlSlope)}, treatment slope ${round4(treatmentSlope)}, ` +
    `truncated slope ${round4(base.truncatedSlope)} (positive = rot grows faster)`;
  const endpointText = (): string =>
    endpointDifference === null
      ? 'the 80% endpoint could not be compared'
      : `at the 80% tier alone the treatment is ${endpointDifference >= 0 ? 'above' : 'below'} control by ` +
        `${round4(Math.abs(endpointDifference))}, which is ${endpointWouldMislead ? 'the OPPOSITE of' : 'consistent with'} ` +
        'the slope verdict';

  if (probe.status === 'confounded' || probe.status === 'undetermined') {
    return {
      ...base,
      status: 'inconclusive',
      statement: 'G5 is inconclusive: the rot probe is not valid',
      detail:
        `${probe.detail} The observed slopes were ${slopes()}, but a slope from this probe is not evidence ` +
        'either way, so G5 reports inconclusive rather than observed.',
    };
  }
  if (probe.status === 'blind') {
    return {
      ...base,
      status: 'inconclusive',
      statement: 'G5 is inconclusive: the rot probe is blind',
      detail: `${probe.detail} ${slopes()}. A flat curve from a probe nobody can fail is a null result.`,
    };
  }
  if (!Number.isFinite(difference)) {
    return {
      ...base,
      status: 'inconclusive',
      statement: 'G5 is inconclusive: no slope could be fitted',
      detail: `the tiers did not yield a fittable curve, so there is no difference to test. ${slopes()}.`,
    };
  }
  if (difference > E2_SLOPE_THRESHOLD) {
    return {
      ...base,
      status: 'not_observed',
      statement: 'G5 not observed: the treatment degrades faster than the control',
      detail:
        `slope difference treatment − control is ${round4(difference)} against a threshold of ` +
        `${E2_SLOPE_THRESHOLD}, and ${endpointText()}. ${slopes()}. The offline fixture has ` +
        `${casesPerTier} rot case(s) per tier against a target of ${E2_CASES_PER_TIER_TARGET}, and a ` +
        'treatment that is worse is a finding at any n, so this status does not wait for the campaign.',
    };
  }
  if (casesPerTier < E2_CASES_PER_TIER_TARGET || interval.state !== 'ok') {
    return {
      ...base,
      status: 'inconclusive',
      statement: 'G5 is inconclusive at this scale; the point estimate does not fail the gate',
      detail:
        `slope difference treatment − control is ${round4(difference)} against a threshold of ` +
        `${E2_SLOPE_THRESHOLD}, and ${endpointText()}. ${slopes()}. The offline fixture has ` +
        `${casesPerTier} rot case(s) per tier against a target of ${E2_CASES_PER_TIER_TARGET}` +
        (interval.state === 'ok'
          ? ''
          : `, and the bootstrap interval is ${interval.state} (${interval.usedResamples} of ` +
            `${interval.resamples} replicates produced a slope)`) +
        ', so the point estimate is reported and the gate is not claimed.',
    };
  }
  return {
    ...base,
    status: 'observed',
    statement: 'G5 observed: the treatment does not degrade faster than the control',
    detail:
      `slope difference treatment − control is ${round4(difference)} against a threshold of ` +
      `${E2_SLOPE_THRESHOLD}` +
      (ciClearsThreshold
        ? `, and the whole ${round4(interval.lower)}–${round4(interval.upper)} interval is on the passing side`
        : `, but the ${round4(interval.lower)}–${round4(interval.upper)} interval still crosses the ` +
          'threshold, so the difference is not resolved at this n') +
      `. ${endpointText()}. ${slopes()}.`,
  };
}

// -------------------------------------------------------------- running it

export interface E2RunOptions extends Omit<RunOptions, 'runArm'> {
  readonly probes?: readonly E2Probe[];
  /** Required. There is no default; see the module header. */
  readonly subject: E2Subject;
  readonly resamples?: number;
  readonly bootstrapSeed?: number;
}

/** Where a number in an E2 report came from. Not decoration: claims audit needs it. */
export interface E2Provenance {
  readonly subjectId: string;
  readonly probeCount: number;
  readonly rotCasesPerTier: number;
  readonly rotCasesPerTierTarget: number;
  readonly families: readonly E2Family[];
  readonly tiers: readonly E2TierId[];
  readonly arms: readonly Arm[];
  readonly windowTokens: number;
  readonly charsPerToken: number;
  readonly truncationBudgetTokens: number;
  readonly needleDepth: number;
  readonly optionCount: number;
  /**
   * Live model families this run measured. 0 offline: the suite fits whatever
   * subject it is handed and the offline subject is a declared synthetic model,
   * not a model. F2 fills this in with the families it runs.
   */
  readonly modelFamiliesObserved: number;
  /** The offline fixture's declared degradation model, not a measurement. */
  readonly degradationModel: string;
  /** Mirrored from core-types and the gateway, not imported. */
  readonly windowSource: string;
  readonly todos: readonly string[];
}

export interface E2RunResult {
  readonly report: RunReport;
  readonly fixture: EvalFixture;
  readonly gate: E2GateVerdict;
  readonly curves: readonly E2ArmCurve[];
  readonly probe: E2ProbeValidity;
  readonly audit: E2Audit;
  readonly slopeInterval: E2SlopeInterval;
  readonly provenance: E2Provenance;
}

/** Cells for the statistics, from the report and the recorded calls. */
const e2Cells = (report: RunReport, calls: readonly E2RecordedCall[]): readonly E2Cell[] => {
  const passed = new Map<string, boolean>();
  for (const result of report.cases) {
    for (const arm of result.arms) passed.set(`${result.caseId}|${arm.arm}`, arm.status === 'pass');
  }
  const excluded = new Set(calls.filter((call) => call.claimedLossy).map((call) => `${call.caseId}|${call.arm}`));
  const families = new Map<string, E2Family>();
  for (const family of E2_FAMILIES) {
    for (const tier of E2_TIER_IDS) families.set(`${e2CaseId(tier, family)}`, family);
  }
  const tiers = new Map<string, E2TierId>();
  for (const tier of E2_TIER_IDS) {
    for (const family of E2_FAMILIES) tiers.set(`${e2CaseId(tier, family)}`, tier);
  }
  const cells: E2Cell[] = [];
  for (const [key, isPass] of [...passed.entries()].sort()) {
    const caseId = key.slice(0, key.lastIndexOf('|'));
    const arm = key.slice(key.lastIndexOf('|') + 1) as Arm;
    const family = families.get(caseId);
    const tier = tiers.get(caseId);
    if (family === undefined || tier === undefined) continue;
    cells.push({ caseId, tier, family, arm, passed: isPass, excluded: excluded.has(key) });
  }
  return Object.freeze(cells);
};

/**
 * Run E2 end to end: build the fixture, run the subject through the harness's own
 * `runSuite`, audit what came back, fit the curves, evaluate G5.
 *
 * Deliberately not a second runner: the interleaved seeded execution order, the
 * per-arm totals and the negative-control section all come from `../runner.js`,
 * because a suite that ran its own arms would have its own ideas about what
 * "interleaved" means and there would be no way to check them against the
 * harness.
 */
export async function runE2Suite(options: E2RunOptions): Promise<E2RunResult> {
  if (typeof options.subject !== 'object' || options.subject === null) {
    throw new TypeError(
      'e2: a subject is required. The subject under test is injected, not imported -- this package cannot ' +
        'call a gateway or a provider, and a default here would be a green report nobody earned.',
    );
  }
  if (typeof options.subject.id !== 'string' || options.subject.id === '') {
    throw new TypeError('e2: subject.id is required; a report that cannot name what it measured is not evidence');
  }

  const probes = options.probes ?? E2_PROBES;
  const fixture = buildE2Fixture(probes);
  const handle = createE2ArmRunner(probes, options.subject);
  const report = await runSuite(fixture, {
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    runArm: handle.run,
  });

  const calls = handle.recorded();
  const audit = auditE2Calls(calls);
  const cells = e2Cells(report, calls);
  const curves = summariseE2Curves(cells);
  const probe = evaluateE2ProbeValidity(cells);
  const interval = bootstrapE2SlopeDifference(cells, {
    ...(options.resamples === undefined ? {} : { resamples: options.resamples }),
    ...(options.bootstrapSeed === undefined ? {} : { seed: options.bootstrapSeed }),
  });
  const rotPerTier = E2_TIER_IDS.map(
    (tier) => cells.filter((cell) => cell.arm === E2_BASELINE_ARM && isE2RotFamily(cell.family) && cell.tier === tier).length,
  );
  const casesPerTier = rotPerTier.length === 0 ? 0 : Math.min(...rotPerTier);

  return Object.freeze({
    report,
    fixture,
    gate: evaluateE2Gate(curves, probe, interval, casesPerTier),
    curves,
    probe,
    audit,
    slopeInterval: interval,
    provenance: Object.freeze({
      subjectId: options.subject.id,
      probeCount: probes.length,
      rotCasesPerTier: casesPerTier,
      rotCasesPerTierTarget: E2_CASES_PER_TIER_TARGET,
      families: E2_FAMILIES,
      tiers: E2_TIER_IDS,
      arms: E2_ARMS,
      windowTokens: E2_WINDOW_TOKENS,
      charsPerToken: E2_CHARS_PER_TOKEN,
      truncationBudgetTokens: E2_TRUNCATION_BUDGET_TOKENS,
      needleDepth: E2_NEEDLE_DEPTH,
      optionCount: E2_OPTION_COUNT,
      modelFamiliesObserved: 0,
      degradationModel:
        'none measured: this suite fits whatever the injected subject returns, and no model family was run. ' +
        'The offline fixture ships a declared synthetic degradation model in its test file, and a live run ' +
        'replaces it with a measured one.',
      windowSource:
        'mirrored core-types BudgetPolicy.contextLimit (200000) and the anthropic/openai-compat ' +
        'chars-per-token (4.0) in packages/gateway/src/token-estimator.ts; this package may not import either',
      todos: Object.freeze([
        `TODO(WS-F, F2): the campaign scale of ${E2_CASES_PER_TIER_TARGET} rot cases per tier across >= 7 ` +
          'model families is not reached offline and is not claimed; G5 is inconclusive at this n',
        'TODO(WS-F, F1-6): G5 has no pre-registered non-inferiority margin, unlike G3/G4 — confirm with the ' +
          'doc owner whether the threshold of 0 is the intended test',
        'TODO(WS-F, F1-6): the 200000-token window and the 4.0 chars-per-token ratio are mirrored, not read ' +
          'from core-types or the gateway, so a change there silently makes every tier the wrong size',
        `TODO(WS-F, F2): the truncation budget of ${E2_TRUNCATION_BUDGET_TOKENS} tokens is a stated ` +
          'assumption chosen so the arm bites at the top two tiers, not a measured compaction trigger',
        'TODO(WS-F, F1-6): E2_NIAH_MAX_DROP is a reading of the doc\'s "NIAH stays ~100%", not a published ' +
          'constant, and is labelled as such wherever it is reported',
      ]),
    }),
  });
}
