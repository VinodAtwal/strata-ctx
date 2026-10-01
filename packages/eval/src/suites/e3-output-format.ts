import { EVAL_FIXTURE_FORMAT_VERSION, parseFixture, validateFixture, type FixtureIssueCode } from '../fixture.js';
import { runSuite, type RunOptions } from '../runner.js';
import { unitValue } from '../mock-arm.js';
import {
  exactMcNemar,
  pairedNonInferiority,
  wilsonInterval,
  type McNemarResult,
  type NonInferiorityResult,
} from '../statistics.js';
import type {
  Arm,
  ArmObservation,
  EvalFixture,
  RunReport,
  SuiteId,
  SyncArmRunner,
} from '../types.js';

/**
 * F1-7 — E3, output format: accuracy and diversity.
 *
 * docs/evaluation.md §E3: *"does compressing the output format change which
 * answer you get?"*
 *
 * ## Why this suite is allowed to kill a feature
 *
 * §E3 exists because of a finding that is easy to miss: across 44 models,
 * forcing **JSON** reduced answer diversity by **~0.22 bits** and XML by ~0.19,
 * while **YAML and CSV showed no significant effect**. A format optimization
 * that quietly biases a model toward consensus answers is a correctness problem,
 * not a preference — and the doc is explicit about the consequence:
 *
 * > If TOON behaves like JSON on diversity, we drop it and keep only verbosity
 * > directives. This suite is allowed to kill a feature.
 *
 * So the suite is built to make that outcome *reachable*, and every structural
 * decision below follows from it:
 *
 * 1. **Nothing here assumes TOON is safe.** `evaluateE3Diversity` computes the
 *    verdict from measured bits, and the two paths to
 *    `drop_toon_keep_verbosity_directives` are reachable by injecting a subject
 *    that behaves like JSON. The test does exactly that, so the drop path is
 *    exercised rather than merely described.
 * 2. **The instrument is calibrated before it is trusted.** A verdict of
 *    `retain_toon` requires that the *same* measurement code first reproduced
 *    the known JSON-suppression effect on a synthetic stimulus
 *    (`calibrateE3Diversity`). An instrument that cannot see the effect it is
 *    calibrated on cannot license a claim that TOON does not have it — that is
 *    the false-green structure G1 protects in E1, applied to entropy.
 * 3. **G10 is the only blocking gate, and it is measured before anything else
 *    is read.** An accuracy comparison over a payload that does not decode back
 *    is a comparison of two corruptions, so fidelity runs first, and a codec
 *    that refuses the whole corpus scores 0% rather than a vacuous 100%.
 * 4. **The boundary gate can fail in the direction that corrupts output.** A
 *    classifier that says "yes" to prose is not a slower classifier, it is one
 *    that rewrites a model's reasoning into a table. And a classifier that says
 *    "no" to everything is *not* safe — it is a gate that cannot fire, which is
 *    why `E3BoundaryReport.degenerate` is reported separately from the false-
 *    positive rate.
 *
 * ## The four elements, and what each one refuses to be happy about
 *
 * | Element | Question | The failure it is built to catch |
 * |---|---|---|
 * | Fidelity (G10) | does TOON/TRON put the value back *exactly*? | a field silently dropped, a `"1"` read back as `1`, a row lost |
 * | Accuracy | same tasks, TOON vs JSON — same answers? | a format that saves tokens and changes the answer |
 * | Diversity | JSON/YAML/CSV/TOON entropy, plus embedding entropy | TOON silently joining JSON's consensus-pulling band |
 * | Boundary (H-3) | must prose ever be TOON-ified? | reasoning prose rewritten into a table |
 *
 * ## The subject under test is injected, never imported
 *
 * This package has no dependencies and no project reference (AGENTS.md §12.1).
 * `serializeToon`/`parseToon` live in `@strata-ctx/output-compress` and cannot be
 * called from here, and a hand-rolled copy would be a strawman. So three subjects
 * are supplied as parameters:
 *
 * - `ToonCodec` — `encode`/`decode` for both dialects. The deterministic
 *   reference implementation lives in the test file.
 * - `E3Responder` — the model. Answers extraction requests and open-ended
 *   diversity requests.
 * - `E3BoundaryClassifier` — H-3, the "is this block machine-readable?"
 *   decision.
 *
 * None of the three has a default, and `runE3Suite` refuses to run without all
 * three, because a default is how a green report is obtained by forgetting to
 * configure the thing under test.
 *
 * ## Entropy without dependencies, and why it is labelled a proxy
 *
 * docs/evaluation.md §E3 asks for "n-gram and embedding entropy". There is no
 * tokenizer and no embedding model available to an offline, zero-dependency
 * package, and inventing either would produce a number nobody can audit. So this
 * suite measures **three** quantities, in bits, and names each one for what it
 * is:
 *
 * - `exactEntropyBits` — Shannon entropy of the empirical distribution over the
 *   distinct answers a format produced, averaged per task. This is the closest
 *   offline analogue of the study's quantity and the one the verdict rests on.
 * - `ngramEntropyBits` — a **proxy**: mean per-answer character n-gram Shannon
 *   entropy. It measures surface form, and a condition that collapses answers
 *   *without* changing their wording does not move it. Saying so is the point;
 *   an unlabelled number here would be a number read as more than it is.
 * - `embeddingEntropyBits` — a **proxy** for embedding entropy: a deterministic
 *   hashed character-trigram vector per answer, greedy leader clustering at a
 *   cosine threshold, and the Shannon entropy of the cluster distribution. It
 *   moves when answers converge *semantically* while staying textually distinct,
 *   which is precisely the case the exact-answer metric cannot see.
 *
 * The calibration includes a **paraphrase-collapse** condition that pins the
 * non-redundancy of the two proxies. In it the responder answers only with
 * wordings of one answer — the modal candidate and its two declared rewordings,
 * so three distinct strings and one meaning: the exact-answer metric reports
 * about a bit of diversity, the embedding proxy reports zero, and the n-gram
 * proxy stays on the surface and does not report the collapse either. Without
 * that condition, "we measured n-gram and embedding entropy" is a claim about
 * two numbers that are the same number twice, and nobody would know which one
 * they were looking at.
 *
 * That condition is also why the sweep is **replicated** rather than sampled
 * once. One sample of a plug-in entropy estimate over `E3_DIVERSITY_SEEDS`
 * answers is noisy at the ~0.2-bit level, so a calibration that demanded its own
 * series be monotone would be demanding that a noisy estimator be noise-free.
 * `E3_CALIBRATION_REPLICATES` samples put the spread of a single condition in
 * reach, and that measured spread is the band a rise has to clear to count as a
 * rise — the instrument reports its own noise rather than being handed a
 * tolerance chosen to make it pass.
 *
 * ## What this fixture does NOT support
 *
 * The 44-model structured-output diversity study is the source of truth for the
 * −0.22-bit figure, and no offline deterministic run can reproduce a magnitude
 * measured across 44 models. What this suite can honestly do offline is
 * establish the **shape** of the effect on a synthetic stimulus, and then ask
 * whether the injected subject puts TOON in JSON's band or in YAML/CSV's. The
 * 0.22-bit bar is carried in `E3_JSON_DIVERSITY_DEFICIT_BITS` and reported
 * beside the measured value, and the campaign-scale number is a
 * `TODO(WS-F, F2)` on `E3Provenance` — never a claim made here.
 *
 * ## Telemetry
 *
 * None, by the same design as E1: `src/` opens no socket and takes no
 * dependency, so the event sink cannot be imported without breaking the one
 * property that keeps the measuring apparatus honest. The report is the
 * substitute, and it is deterministic and diffable by construction.
 */

// ---------------------------------------------------------------- constants

/** docs/evaluation.md Part 2, E3. Mirrored as a literal for the same reason
 *  `types.ts` mirrors `ConstraintKind` (AGENTS.md §12.1). */
export const E3_SUITE_ID: SuiteId = 'E3';

export const E3_SUITE_NAME = 'e3-output-format';

/** docs/evaluation.md §E3: fidelity, accuracy, diversity, boundary. */
export const E3_ARMS: readonly Arm[] = Object.freeze<Arm[]>(['control', 'control+', 'treatment']);

/**
 * G10, docs/evaluation.md §5: "TOON round-trip — **lossless** on 100% of the
 * fixture corpus".
 *
 * Absolute, not a rate to be traded off. A lossy serializer is a data-corruption
 * bug, not a quality regression, so there is no margin to pre-register and no
 * "acceptable" loss rate: one dropped field fails the gate.
 */
export const G10_LOSSLESS_RATE_FLOOR = 1;

/**
 * docs/evaluation.md §E3: across 44 models, forcing JSON reduced answer
 * diversity by ~0.22 bits. Cited, not chosen.
 *
 * It is the *reference magnitude* for the report, not the gate. Offline the
 * suite measures a different instrument (see the module header), so this number
 * is printed next to the measurement it is being compared with and the campaign
 * number is a `TODO(WS-F, F2)`.
 */
export const E3_JSON_DIVERSITY_DEFICIT_BITS = 0.22;

/**
 * Below this many bits, a format's diversity effect is reported as "no
 * significant effect", which is the label the study gives YAML and CSV.
 *
 * TODO(WS-F, F1-7): 0.05 bits is a judgement call with no citation, in the same
 * category as `MIN_DISCORDANT_FRACTION` in `../statistics.ts`. It needs a source
 * or a power calculation against the campaign's task set before it appears in a
 * claims audit. It errs small, so "no significant effect" is the harder label to
 * earn.
 */
export const E3_NULL_EFFECT_BITS = 0.05;

/**
 * How much less suppressing TOON must be than JSON for the suite to keep it.
 *
 * The test in `evaluateE3Diversity` is "is TOON at least as suppressing as
 * JSON", and this is the slack in that comparison. It is one-sided on purpose: a
 * hair's-breadth difference in TOON's favour still counts as JSON-like, because
 * the suite is permitted to kill a feature and a false "keep" is the expensive
 * error. TODO(WS-F, F1-7): unsourced; see `E3_NULL_EFFECT_BITS`.
 */
export const E3_JSON_LIKE_TOLERANCE_BITS = 0.02;

/**
 * n-gram order for the surface-entropy proxy.
 *
 * 4 is the smallest order at which ordinary English tool output stops looking
 * uniform, which is the failure mode of short n-grams on text with a small
 * alphabet. TODO(WS-F, F1-7): chosen by inspection, not tuned; the calibration
 * only requires the metric to be monotone in the stimulus, not to be optimal.
 */
export const E3_NGRAM_ORDER = 4;

/**
 * Hashing-vectorizer settings for the embedding-entropy proxy.
 *
 * TODO(WS-F, F1-7): 128 dimensions, trigrams, and a 0.6 cosine threshold are
 * all unsourced. The dimensionality trades collision rate against resolution and
 * the threshold is what decides when two answers are "the same answer"; both
 * were picked so that paraphrases of one answer land in one cluster and
 * different answers do not, on the authored pool. The calibration's
 * paraphrase-collapse condition is what actually pins the behaviour, and it
 * would fail loudly if these drifted.
 */
export const E3_EMBEDDING_DIMS = 128;
export const E3_EMBEDDING_TRIGRAM = 3;
export const E3_EMBEDDING_COSINE_THRESHOLD = 0.6;

/** Seed for every seeded decision in this file. Fixed, so reports diff. */
export const E3_SEED = 0xe3_0007;

/**
 * k answers per task per format. docs/evaluation.md §3 puts seeds on the
 * refinement suite only; §E3's diversity arm is the other place a distribution
 * rather than a point estimate is needed, and with 5 admissible answers a
 * handful of seeds saturates the exact-answer metric.
 *
 * TODO(WS-F, F1-7): 12 is enough to move every metric monotonically under the
 * calibration stimulus and is not a power calculation. The campaign's k is set
 * by the model-behaviour budget, not here.
 */
export const E3_DIVERSITY_SEEDS = 12;

/**
 * The consensus-pull weights the calibration sweeps.
 *
 * These are **stimuli, not measurements**: they set how hard each synthetic
 * responder pulls toward the mode, and the sweep's job is to show that the
 * metric responds monotonically to a known input. They are not estimates of any
 * model's consensus-pull, and nothing in a verdict is derived from their
 * magnitude — only from the ordering.
 *
 * `0` is a model that never converges; `1` is a model that emits the same answer
 * every time. The metric must fall monotonically across the sweep, and the total
 * fall must exceed `E3_CALIBRATION_MIN_DROP_BITS` — a metric that is monotone
 * because it is constant is also monotone.
 */
export const E3_CALIBRATION_WEIGHTS: readonly number[] = Object.freeze([
  0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1,
]);

/**
 * The synthetic "JSON suppresses diversity" condition.
 *
 * Reproduces the study's *shape* — a format that pulls answers toward the mode —
 * at a known strength, so the instrument can be shown to detect the effect class
 * before it is used to decide anything about TOON. It is deliberately not
 * tuned to produce 0.22 bits: reproducing that magnitude needs the 44 models
 * this package cannot call.
 */
export const E3_SYNTHETIC_JSON_CONSENSUS_WEIGHT = 0.6;

/**
 * The synthetic "no significant effect" condition, applied to YAML and CSV.
 *
 * 0.02 rather than 0, because a calibration that tests a metric against a
 * perfectly inert stimulus proves less than one that tests it against a
 * *barely* active one: the first only shows the metric reads zero, the second
 * shows it can resolve a small effect and still calls it small.
 */
export const E3_SYNTHETIC_NULL_CONSENSUS_WEIGHT = 0.02;

/**
 * How far a metric must move across the calibration sweep to count as a working
 * instrument, so a metric that is "monotone" only because it is flat fails.
 *
 * Empirically, not by feel: the sweep is replicated
 * `E3_CALIBRATION_REPLICATES` times and each metric reports the spread of its
 * own condition, and that spread is ~0.5 bits for the exact-answer metric on
 * the authored pool. The floor sits just above the instrument's own noise so
 * the drop it demands is a drop it can distinguish from a reshuffle. If the
 * pool changes, this is the number to re-measure first, and
 * `E3_CALIBRATION_REPLICATES` is why re-measuring it is possible at all.
 */
export const E3_CALIBRATION_MIN_DROP_BITS = 0.5;

/**
 * H-3 must not rewrite reasoning prose, so the false-positive rate is an
 * absolute zero and not a tolerance: there is no acceptable rate of corrupting
 * what a model said.
 */
// TODO(WS-F, F1-7): 0 is a normative reading of H-3, not a measured rate. The
// ceiling has to be justified against a real classifier on a real corpus before
// it is a number, and until then it is the strictest available claim, which is
// the safe direction to be wrong in.
export const E3_BOUNDARY_FALSE_POSITIVE_CEILING = 0;

/**
 * A classifier that catches nothing is not safe, it is absent. One true positive
 * is the floor below which `degenerate` is reported, because a classifier that
 * passes the false-positive test by answering "no" to every block has not
 * demonstrated that it can tell the two apart.
 */
// TODO(WS-F, F1-7): 1 is a floor chosen to catch a classifier that answers "no"
// to everything, which is the failure this gate exists to catch. It is not a
// power calculation, and the F2 corpus is what should replace it.
export const E3_BOUNDARY_MIN_TRUE_POSITIVES = 1;

/** Characters per token. Mirrors the anthropic / openai-compat profile in
 *  `packages/gateway/src/token-estimator.ts` (4.0; gemini is 3.5), which this
 *  package may not import. A char-count proxy, and labelled as one everywhere it
 *  appears. */
const CHARS_PER_TOKEN = 4;

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/** Code-unit ordering. `localeCompare` is locale-dependent and a report that
 *  diffs differently under two locales is not a committed artifact. */
const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ------------------------------------------------------------------ mirrors

/**
 * Mirrors `core-types.ConstraintKind` (frozen 1.0.0, digest `0a3c0fea6360e6d9`)
 * through `../types.js`, same as E1. Re-stated here only because this suite
 * reuses two frozen kinds as analysis labels for its own invariants: the
 * round-trip invariant is a `project_rule` (a rule the project holds itself to)
 * and the extraction invariant is a `soft_policy` (the soft-organizational
 * stratum E1 established is the one no trained-in prior keeps alive on its own,
 * which is exactly the right place for "the answer must not change").
 */

/** Mirrors `core-types.Origin` / `BlockType` / `Tier` / `Severity`
 *  (`packages/core-types/src/context.ts`) at freeze digest `0a3c0fea6360e6d9`.
 *
 *  Mirrored rather than imported for the reason `types.ts` mirrors
 *  `ConstraintKind`: the measuring apparatus must not be able to drift with the
 *  thing it measures (AGENTS.md §12.1). A suite that imported the block type
 *  would be asserting against whatever `core-types` currently says, and a
 *  widening of `BlockType` would silently change what the boundary cases mean.
 */
export type E3BlockType = 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'image' | 'cache_control';
export type E3BlockOrigin = 'system' | 'user' | 'assistant' | 'tool' | 'synthetic';
export type E3BlockTier = 'governance' | 'episodic' | 'tool_state' | 'artifact_ref' | 'user_intent';
export type E3BlockSeverity = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

// ------------------------------------------------------------- the codec API

/** A value inside the JSON domain: what a conforming serializer promises. */
export type E3Scalar = string | number | boolean | null;

/**
 * A cell, which may be composite.
 *
 * Recursive rather than scalar-only because composite cells are **inside the
 * domain**, and getting that wrong is the single easiest way to write a fidelity
 * gate that passes a broken serializer. The tabular win comes from factoring out
 * the *columns*; a second bespoke grammar for recursion would save a few tokens
 * on a rare cell while adding a parser to keep strict forever, so a real
 * serializer writes composites as strict JSON and round-trips them exactly.
 * `E3_CORPUS` holds `e3-corpus-nested-cells` to hold that obligation, and it
 * includes `{}` and `[]` on purpose: an empty container is a value, and a codec
 * that cannot write one will quietly write `null` instead.
 *
 * What is *not* in the domain is the point of `E3_REFUSAL_CORPUS`: `NaN`,
 * infinities, `-0`, `Date`s, class instances, and `undefined`.
 */
export type E3Value = E3Scalar | readonly E3Value[] | { readonly [key: string]: E3Value };

/** One uniform record. The key *order* is part of the value (see `E3Record`). */
export type E3Record = { readonly [key: string]: E3Value };

/** The two table dialects. They differ only in framing; the cell grammar and
 *  therefore the loss properties are identical, which is why one codec serves
 *  both and why G10 is evaluated over both. */
export type E3Dialect = 'toon' | 'tron';

export const E3_DIALECTS: readonly E3Dialect[] = Object.freeze<E3Dialect[]>(['toon', 'tron']);

/**
 * The serializer under test. Injected, never imported: `serializeToon` and
 * `parseToon` live in `@strata-ctx/output-compress`, which this package has no
 * dependency on and no project reference to (AGENTS.md §12.1).
 *
 * ## The contract, and why each half is shaped the way it is
 *
 * - `encode(value: unknown, dialect)` takes `unknown` on purpose. The value
 *   arrives off a wire and the first job of a serializer is to find out whether
 *   it is representable at all. A narrower parameter would move that check into
 *   the type system, and the type system is not what a wire speaks.
 * - **A conforming encoder signals "not representable" by throwing**, never by
 *   emitting a lossy document. `E3_REFUSAL_CORPUS` is the set of values that must
 *   be refused, and `runE3RoundTrip` fails the gate if one of them encodes
 *   successfully — a serializer that accepts a value it cannot represent has
 *   already corrupted it, whatever the bytes say.
 * - `decode(text): unknown` returns `unknown` rather than a record array because
 *   the fidelity oracle compares the decoded value against the *original*,
 *   which is `unknown` too. Widening the return type would be a claim that decode
 *   cannot keep.
 */
export interface ToonCodec {
  /** Name for the provenance block. A report that cannot name its serializer is
   *  not evidence about a serializer. */
  readonly codecId: string;
  encode(value: unknown, dialect: E3Dialect): string;
  decode(text: string, dialect: E3Dialect): unknown;
}

// ------------------------------------------------------------------- corpus

/** One in-domain fixture: an array of uniform flat records. */
export interface E3CorpusEntry {
  readonly id: string;
  readonly title: string;
  /** Why this entry is in the corpus. Rendered into the report. */
  readonly notes: string;
  /**
   * Key order is part of the value.
   *
   * A real serializer demands it: rows that disagree about which fields they
   * have, or hold the same fields in a different order, cannot be written as a
   * table without inventing nulls the agent would read as data. So the corpus
   * fixes the order and the fidelity oracle reports key-order churn separately
   * from value loss.
   */
  readonly records: readonly E3Record[];
}

/** One out-of-domain fixture: a value a conforming serializer must refuse.
 *
 *  `records` is `readonly unknown[]` and not a record type, because the corpus
 *  is *defined* by its violations: a `NaN` cell, a `Date`, an `undefined` key, a
 *  scalar row, an empty array. Typing it as records would mean the interesting
 *  cases could not be written down. */
export interface E3OutOfDomainEntry {
  readonly id: string;
  readonly title: string;
  readonly notes: string;
  /** The exact rule being tested, in one clause. Rendered into the report. */
  readonly rule: string;
  readonly records: readonly unknown[];
}

/**
 * The in-domain corpus. G10's denominator is `this.length * E3_DIALECTS.length`,
 * and it is the same corpus the accuracy arm reads its payloads from, so the
 * fidelity claim and the accuracy claim are about the same bytes.
 *
 * Every entry earns its place by being a place a real serializer goes wrong:
 * delimiters inside cells, values that look like JSON literals, numbers at the
 * edges of the domain, unicode that a naive escaper mangles, keys that collide
 * with the format's own framing, and the shapes a table either has to support or
 * has to refuse.
 */
export const E3_CORPUS: readonly E3CorpusEntry[] = Object.freeze<E3CorpusEntry[]>([
  {
    id: 'e3-corpus-file-list',
    title: 'Repository file listing',
    notes: 'The canonical case: many rows, few columns. Where the token saving is largest.',
    records: [
      { path: 'packages/eval/src/runner.ts', bytes: 11284, lines: 352 },
      { path: 'packages/eval/src/fixture.ts', bytes: 17411, lines: 546 },
      { path: 'packages/eval/src/grading.ts', bytes: 41920, lines: 1307 },
      { path: 'packages/eval/src/statistics.ts', bytes: 33410, lines: 895 },
      { path: 'packages/eval/src/mock-arm.ts', bytes: 9640, lines: 285 },
      { path: 'packages/eval/src/reporter.ts', bytes: 5310, lines: 157 },
      { path: 'packages/eval/src/types.ts', bytes: 9180, lines: 276 },
      { path: 'packages/eval/src/index.ts', bytes: 1340, lines: 37 },
      { path: 'packages/eval/src/suites/e1-constraint-retention.ts', bytes: 92140, lines: 2434 },
      { path: 'packages/eval/src/suites/e2-rot-probe.ts', bytes: 31200, lines: 880 },
      { path: 'packages/eval/test/runner.test.ts', bytes: 20110, lines: 567 },
      { path: 'packages/eval/test/grading.test.ts', bytes: 23870, lines: 625 },
    ],
  },
  {
    id: 'e3-corpus-test-results',
    title: 'Test run summary',
    notes: 'Mixed column types in one table, which is where a type-coercing reader loses data.',
    records: [
      { suite: 'unit', passed: 512, failed: 0, skipped: 4, duration_ms: 8412 },
      { suite: 'contract', passed: 1, failed: 0, skipped: 0, duration_ms: 2104 },
      { suite: 'property', passed: 38, failed: 0, skipped: 1, duration_ms: 61220 },
      { suite: 'integration', passed: 114, failed: 2, skipped: 7, duration_ms: 284110 },
      { suite: 'fixture-eval', passed: 9, failed: 1, skipped: 0, duration_ms: 1440300 },
      { suite: 'live-ab', passed: 0, failed: 0, skipped: 40, duration_ms: 0 },
    ],
  },
  {
    id: 'e3-corpus-search-hits',
    title: 'Grep results for a symbol',
    notes: 'Line numbers and match text, where a leading-zero or off-by-one cell rewrites a file reference.',
    records: [
      { file: 'src/api/handlers.ts', line: 88, match: 'const orderId = params.id as OrderId' },
      { file: 'src/api/handlers.ts', line: 131, match: 'return { code: 500 }' },
      { file: 'src/billing/retry.ts', line: 42, match: 'const wait: Backoff = attempt ** 2' },
      { file: 'src/search/index.ts', line: 17, match: "import type { Rank } from '../types/ids'" },
      { file: 'src/search/index.ts', line: 44, match: 'return rows.slice(0, limit)' },
      { file: 'src/search/score.ts', line: 9, match: 'const WEIGHTS = { text: 1, recency: 0.4 }' },
      { file: 'test/search/index.test.ts', line: 71, match: "expect(results[0]?.id).toBe('ord_1')" },
    ],
  },
  {
    id: 'e3-corpus-ci-runs',
    title: 'Recent CI runs',
    notes: 'Timestamps. A timezone-normalising reader would silently rewrite them and break a cache key.',
    records: [
      { workflow: 'web-ci', conclusion: 'failure', created_at: '2026-09-22T06:11:04Z', attempt: 3 },
      { workflow: 'web-ci', conclusion: 'failure', created_at: '2026-09-22T05:58:41Z', attempt: 2 },
      { workflow: 'web-ci', conclusion: 'failure', created_at: '2026-09-22T05:41:19Z', attempt: 1 },
      { workflow: 'web-ci', conclusion: 'success', created_at: '2026-09-21T22:03:57Z', attempt: 1 },
      { workflow: 'pkg-ci', conclusion: 'success', created_at: '2026-09-22T04:12:00Z', attempt: 1 },
    ],
  },
  {
    id: 'e3-corpus-dependencies',
    title: 'Direct dependencies and licences',
    notes: 'Licence strings are the values a compression bug is least likely to be caught on, because nothing downstream reads them.',
    records: [
      { name: '@strata-ctx/core-types', version: '1.0.0', license: 'Apache-2.0' },
      { name: '@strata-ctx/pipeline', version: '0.4.2', license: 'Apache-2.0' },
      { name: '@strata-ctx/gist', version: '0.4.2', license: 'Apache-2.0' },
      { name: '@strata-ctx/governance', version: '0.3.9', license: 'Apache-2.0' },
      { name: 'typescript-eslint', version: '8.19.0', license: 'MIT' },
      { name: 'tsx', version: '4.19.0', license: 'MIT' },
    ],
  },
  {
    id: 'e3-corpus-migrations',
    title: 'Applied migrations',
    notes: 'Identifiers with leading zeros. A number-coercing reader turns "0042" into 42 and the migration never re-applies.',
    records: [
      // The bare zero-padded id is the trap the task note describes. Every other
      // row carries a suffix, and a suffix is enough to stop a number-coercing
      // reader — so without this row the corpus does not test what it claims and
      // `e3-task-migration-ids` passes against a reader that mangles every other
      // value in the suite.
      { id: '0042', applied_at: '2026-09-14T03:12:04Z', rows: 0, reversible: true },
      { id: '0042_add_status', applied_at: '2026-09-14T03:12:04Z', rows: 0, reversible: true },
      { id: '0041_backfill_currency', applied_at: '2026-09-11T08:41:22Z', rows: 18402301, reversible: false },
      { id: '0040_drop_legacy_flag', applied_at: '2026-09-02T11:02:55Z', rows: 41288, reversible: true },
      { id: '0039_add_tenant_id', applied_at: '2026-08-28T16:33:10Z', rows: 41288, reversible: false },
      { id: '0038_widen_sku', applied_at: '2026-08-19T09:20:31Z', rows: 0, reversible: true },
    ],
  },
  {
    id: 'e3-corpus-delimiters',
    title: 'Cells full of delimiters and whitespace',
    notes:
      'The highest-yield fidelity case. Commas end a cell, braces and brackets open composites, whitespace at a cell edge is invisible, and every one of these is ordinary tool output — a diff, a stack frame, a CSV cell inside a CSV.',
    records: [
      { kind: 'diff', body: '-  const a = 1;\n+  const a = 2;' },
      { kind: 'log', body: '  at Object.<anonymous> (/app/src/index.js:12:9)' },
      { kind: 'csv', body: 'id,name,note\n1,"Acme, Inc.","said ""yes"""' },
      { kind: 'path', body: 'src/a b/c(d)/e[f].ts' },
      { kind: 'json', body: '{"a":1,"b":[2,3]}' },
      { kind: 'edge-space', body: '  leading and trailing  ' },
      { kind: 'backslash', body: 'C:\\Users\\dev\\repo\\file.txt' },
      { kind: 'brace-open', body: '{not json at all' },
      { kind: 'bracket', body: '[1, 2, 3]' },
      { kind: 'empty', body: '' },
    ],
  },
  {
    id: 'e3-corpus-json-lookalikes',
    title: 'Strings that parse as JSON literals',
    notes:
      'The silent type-corruption case. A bare cell is read as whatever it parses as, so an unquoted "1", "true", "null", "-0" or "1e999" comes back as a number, a boolean or a parse failure instead of the string it visibly is. Every value here is a string.',
    records: [
      { label: 'number-string', value: '1' },
      { label: 'negative', value: '-0' },
      { label: 'exponent', value: '1e999' },
      { label: 'float-string', value: '1.5' },
      { label: 'true-string', value: 'true' },
      { label: 'false-string', value: 'false' },
      { label: 'null-string', value: 'null' },
      { label: 'empty-array-string', value: '[]' },
      { label: 'empty-object-string', value: '{}' },
      { label: 'quoted-string', value: '"already quoted"' },
      { label: 'bare-word', value: 'enabled' },
      { label: 'zero-padded', value: '007' },
    ],
  },
  {
    id: 'e3-corpus-numeric-edges',
    title: 'Numbers at the edges of the domain',
    notes:
      'Zero, large magnitudes, long fractions, and integers past 2^53. Note what is *not* here: NaN, the infinities and negative zero are outside the domain and are in E3_REFUSAL_CORPUS, because JSON.stringify turns them into something else without an error.',
    records: [
      { id: 'zero', value: 0, ratio: 0 },
      { id: 'one', value: 1, ratio: 1 },
      { id: 'small-fraction', value: 0.000001, ratio: 1e-6 },
      { id: 'long-fraction', value: 3.141592653589793, ratio: 0.3333333333333333 },
      { id: 'large', value: 9007199254740991, ratio: 1 },
      // 2^53 + 1 does not exist as a double: the literal above would already be
      // 9007199254740992 before the serializer saw it. The only way an integer
      // that large can be carried at all is as a string, and a reader that
      // coerces it to a number changes the id. So that is the case: a big id
      // that survives only as text.
      { id: 'past-2-53', value: '9007199254740993', ratio: 2 },
      { id: 'exponent-large', value: 1.7976931348623157e308, ratio: 1e-2 },
      { id: 'negative', value: -273.15, ratio: -0.5 },
    ],
  },
  {
    id: 'e3-corpus-unicode',
    title: 'Non-ASCII cells',
    notes:
      'Emoji with surrogate pairs, CJK, combining marks, right-to-left text, a zero-width joiner, and a lone surrogate. A naive escaper either double-escapes the emoji or mangles the lone surrogate, and both look fine in a diff.',
    records: [
      { id: 'emoji', label: 'deployment 🚀 finished', value: 'ok' },
      { id: 'family-zwj', label: '👩‍💻 reviewing', value: 'in-progress' },
      { id: 'cjk', label: 'デプロイ完了', value: 'ok' },
      { id: 'combining', label: 'café résumé', value: 'ok' },
      { id: 'rtl', label: 'تم النشر بنجاح', value: 'ok' },
      { id: 'lone-surrogate', label: 'lone: \ud800 end', value: 'degraded' },
      { id: 'flag', label: '🇬🇧 staging', value: 'ok' },
      { id: 'accented-key-value', label: 'Größe: 42', value: 'ok' },
    ],
  },
  {
    id: 'e3-corpus-typed-cells',
    title: 'Booleans, nulls and their string twins in one column',
    notes:
      'A column holding `true`, `"true"`, `null` and `"null"` at once. The type is the value; a reader that normalises truthiness has destroyed the difference between "no value" and "the word no value".',
    records: [
      { id: 'a', enabled: true, note: 'true' },
      { id: 'b', enabled: false, note: 'false' },
      { id: 'c', enabled: null, note: 'null' },
      { id: 'd', enabled: true, note: 'yes' },
      { id: 'e', enabled: false, note: 'no' },
      { id: 'f', enabled: null, note: '' },
    ],
  },
  {
    id: 'e3-corpus-nested-cells',
    title: 'Records holding composite cells',
    notes:
      'An object and an array inside a cell. This is inside the domain — the tabular win comes from factoring out the *columns*, and a second grammar for recursion would save a few tokens on a rare cell while adding a parser to keep strict forever — so it is a round-trip obligation, not a refusal.',
    records: [
      { id: 'r1', labels: { env: 'prod', tier: 'web' }, owners: ['sam', 'priya'] },
      { id: 'r2', labels: { env: 'staging', tier: 'web' }, owners: ['dev-a'] },
      { id: 'r3', labels: {}, owners: [] },
      { id: 'r4', labels: { env: 'prod', tier: 'worker', region: 'eu-west-1' }, owners: ['sam', 'kim', 'dev-b'] },
    ],
  },
  {
    id: 'e3-corpus-framing-lookalikes',
    title: 'Keys and values that collide with the format framing',
    notes:
      'A serializer that reads its own header back can confuse a column called "count" or a cell containing "toon1[1]{path}:" with framing. Key order is also fixed here, because a table cannot be written from rows that disagree about it.',
    records: [
      { magic: 'toon1', count: 1, indent: '  ', label: 'a' },
      { magic: 'tron1', count: 2, indent: '', label: 'b' },
      { magic: 'toon1', count: 3, indent: '  ', label: 'c' },
      { magic: 'plain', count: 4, indent: 'x', label: 'd' },
    ],
  },
  {
    id: 'e3-corpus-single-row',
    title: 'A one-row table',
    notes:
      'The degenerate shape. A header that names two columns and one row pays for the header and saves nothing, which is the case where a *selector* should decline to compress even though the round trip is exact.',
    records: [{ id: 'ord_88213', state: 'settled', total_cents: 4199 }],
  },
  {
    id: 'e3-corpus-wide-table',
    title: 'A twenty-four column table',
    notes: 'The width extreme: a header long enough to dominate the document, which is where factoring out columns stops paying.',
    records: [
      {
        id: 'ord_1', state: 'settled', channel: 'web', currency: 'GBP', total_cents: 4199,
        tax_cents: 683, discount_cents: 0, customer_ref: 'acct_8812', risk_score: 0.04,
        fraud_flag: false, captured: true, refunded: false, partial: false,
        gateway: 'stripe', gateway_ref: 'pi_3Oqz1', attempts: 1, settled_at: '2026-09-20T11:02:00Z',
        created_at: '2026-09-20T10:58:31Z', updated_at: '2026-09-20T11:02:04Z', warehouse: 'eu-west-1',
        note: '', reviewer: '', reviewed_at: null, legacy_id: 'L-99213', schema_version: 7,
      },
      {
        id: 'ord_2', state: 'pending', channel: 'mobile', currency: 'GBP', total_cents: 1299,
        tax_cents: 212, discount_cents: 250, customer_ref: 'acct_9004', risk_score: 0.61,
        fraud_flag: true, captured: false, refunded: false, partial: false,
        gateway: 'adyen', gateway_ref: 'psp_77a1', attempts: 2, settled_at: null,
        created_at: '2026-09-21T08:14:02Z', updated_at: '2026-09-21T08:14:40Z', warehouse: 'eu-west-2',
        note: '3DS challenged', reviewer: 'sam', reviewed_at: '2026-09-21T09:00:00Z', legacy_id: '',
        schema_version: 7,
      },
      {
        id: 'ord_3', state: 'refunded', channel: 'web', currency: 'GBP', total_cents: 7500,
        tax_cents: 1223, discount_cents: 0, customer_ref: 'acct_7711', risk_score: 0.11,
        fraud_flag: false, captured: true, refunded: true, partial: true,
        gateway: 'stripe', gateway_ref: 'pi_3Oqz2', attempts: 1, settled_at: '2026-09-19T19:44:10Z',
        created_at: '2026-09-19T19:40:02Z', updated_at: '2026-09-22T06:02:19Z', warehouse: 'eu-west-1',
        note: 'partial refund', reviewer: 'priya', reviewed_at: '2026-09-22T06:30:00Z', legacy_id: 'L-88120',
        schema_version: 6,
      },
    ],
  },
]);

/**
 * The out-of-domain corpus.
 *
 * Every entry here must be **refused**. The alternative to refusing is not a
 * different encoding — it is a document that no longer contains the value, which
 * is a data-corruption bug wearing a successful exit code. A serializer that
 * encodes one of these has already failed G10, and `runE3RoundTrip` scores it as
 * a failure rather than as a success with a warning.
 *
 * Between them these cover every way the JSON domain leaks: a value JSON cannot
 * represent at all (`NaN`, `Infinity`, `-0`, a `Date`, a class instance), a row
 * set that is not a table (ragged keys, reordered keys, a non-record row, an
 * empty array), and a name that cannot be written into a header.
 */
/**
 * A value with a prototype of its own, for `e3-refuse-class-instance`.
 *
 * One enumerable field and no `toJSON`, so a lenient writer emits `{"value":"ok"}`
 * for it: the row still looks like a row, the field is still there, and the value
 * is still gone. A refusal is the only honest answer, and nothing in the
 * *structure* of the table says so.
 */
class E3RowState {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export const E3_REFUSAL_CORPUS: readonly E3OutOfDomainEntry[] = Object.freeze<E3OutOfDomainEntry[]>([
  {
    id: 'e3-refuse-nan',
    title: 'A NaN cell',
    notes: 'JSON.stringify writes NaN as null, with no error. A reader that accepts it hands back a null the agent will read as a value.',
    rule: 'a non-finite number is not a JSON number',
    records: [{ id: 'a', latency_ms: Number.NaN }],
  },
  {
    id: 'e3-refuse-infinity',
    title: 'An infinite cell',
    notes: 'Same class as NaN and the same silent substitution.',
    rule: 'a non-finite number is not a JSON number',
    records: [{ id: 'a', ratio: Number.POSITIVE_INFINITY }],
  },
  {
    id: 'e3-refuse-negative-zero',
    title: 'A negative zero cell',
    notes:
      'The nastiest one. JSON.stringify(-0) is "0", so a round trip returns 0, and Object.is(-0, 0) is false, so nothing downstream notices the swap. The value that changed is the sign of a zero.',
    rule: '-0 is not a JSON number',
    records: [{ id: 'a', offset: -0 }],
  },
  {
    id: 'e3-refuse-date',
    title: 'A Date cell',
    notes: 'JSON.stringify writes an ISO string. The field survives and the *type* does not, so a comparison against a Date silently fails forever.',
    rule: 'a Date is not a JSON value; its prototype is not Object.prototype',
    records: [{ id: 'a', applied_at: new Date('2026-09-14T03:12:04Z') }],
  },
  {
    id: 'e3-refuse-undefined-cell',
    title: 'An undefined-valued key',
    notes: 'JSON.stringify drops the key entirely. The agent was told about the field and no longer has it.',
    rule: 'an undefined property would be dropped by any JSON writer',
    records: [{ id: 'a', reviewer: undefined }],
  },
  {
    id: 'e3-refuse-ragged-keys',
    title: 'Rows that do not agree about their fields',
    notes:
      'Encodable by unioning the keys and filling the gaps with null — and those nulls are inventions the agent would read as data. Refusing costs tokens and is always correct.',
    rule: 'rows must carry the same fields, in the same order',
    records: [
      { id: 'a', state: 'ok' },
      { id: 'b', state: 'ok', note: 'extra field' },
    ],
  },
  {
    id: 'e3-refuse-reordered-keys',
    title: 'The same fields in a different order',
    notes: 'The same argument one step smaller: a header names columns positionally, so row order of keys is part of the value.',
    rule: 'rows must carry the same fields, in the same order',
    records: [
      { id: 'a', state: 'ok', bytes: 1 },
      { bytes: 1, state: 'ok', id: 'b' },
    ],
  },
  {
    id: 'e3-refuse-scalar-row',
    title: 'An array whose rows are not records',
    notes: 'A scalar row has no columns to factor out, and a table cannot be invented from it.',
    rule: 'every row must be a plain object',
    records: [{ id: 'a', state: 'ok' }, 'a bare string is not a record'],
  },
  {
    id: 'e3-refuse-empty-array',
    title: 'An empty array',
    notes: 'Well formed and unrepresentable: an empty array declares no columns, so there is no header to write.',
    rule: 'an empty array declares no columns',
    records: [],
  },
  {
    id: 'e3-refuse-unwritable-key',
    title: 'A key that cannot go in a header',
    notes:
      'A comma ends a header cell. The key is not renameable — it arrives inside the payload — so the only correct answer is to leave the payload alone.',
    rule: 'a field name may not contain a comma, a brace, a control character, or edge whitespace',
    records: [{ 'id,with,commas': 'a' }],
  },
  {
    id: 'e3-refuse-class-instance',
    title: 'A class instance cell',
    notes:
      'JSON.stringify produces *something* for it — usually {} or a couple of enumerable fields — and that ' +
      'something is not the value. The rows here are uniform and the keys line up, so the only thing wrong ' +
      'with them is the prototype, which is exactly why this is the case a header check cannot catch.',
    rule: 'the prototype is neither Object.prototype nor null',
    records: [
      { id: 'a', state: new E3RowState('ok') },
      { id: 'b', state: new E3RowState('ok') },
    ],
  },
]);

// -------------------------------------------------------------- the fixtures

/** One extraction task: a question, a payload, and the fields the answer is in. */
export interface E3ExtractionTask {
  readonly id: string;
  readonly title: string;
  readonly notes: string;
  /** Which corpus entry is the payload. Fidelity and accuracy read the same bytes. */
  readonly corpusId: string;
  readonly question: string;
  /** Fields whose values, across every row, make up the answer set. */
  readonly fields: readonly string[];
}

/**
 * The extraction tasks.
 *
 * Each one is a question an agent genuinely has to answer from a tool result, and
 * each one is chosen so a format that mangles *values* rather than *structure*
 * fails it. The `migrations` and `json-lookalikes` tasks are the sharpest: their
 * answers are strings that a type-coercing reader turns into numbers, so an
 * extraction that is "nearly right" is wrong, and a suite that graded on
 * structure alone would call it a pass.
 */
export const E3_EXTRACTION_TASKS: readonly E3ExtractionTask[] = Object.freeze<E3ExtractionTask[]>([
  {
    id: 'e3-task-largest-files',
    title: 'Which five files in this listing are the largest?',
    notes: 'The plain case. Establishes that the pipeline works before the adversarial ones run.',
    corpusId: 'e3-corpus-file-list',
    question: 'List the byte size of every file in the listing.',
    fields: ['bytes'],
  },
  {
    id: 'e3-task-failing-suites',
    title: 'How many tests failed, in which suites?',
    notes: 'Numeric answer set, and the payload mixes suites with zero rows and suites that never ran.',
    corpusId: 'e3-corpus-test-results',
    question: 'For each suite, report the number of tests that failed.',
    fields: ['failed'],
  },
  {
    id: 'e3-task-migration-ids',
    title: 'Which migration ids were applied?',
    notes:
      'The leading-zero trap. An answer of "42" instead of "0042" is a different migration, and a re-applied migration is an incident.',
    corpusId: 'e3-corpus-migrations',
    question: 'Report the id of every applied migration.',
    fields: ['id'],
  },
  {
    id: 'e3-task-lookalike-values',
    title: 'What are the literal values in the value column?',
    notes:
      'Every value is a string that parses as a JSON literal. An extractor that returns the number 1 where the payload said "1" has silently changed a value, and this task is the one that catches it.',
    corpusId: 'e3-corpus-json-lookalikes',
    question: 'Report the literal value column, exactly as written.',
    fields: ['value'],
  },
  {
    id: 'e3-task-enabled-flags',
    title: 'Which records are enabled?',
    notes:
      'A column holding true, "true", null and "null" at once. Truthiness normalisation destroys the difference between "no value" and "the word no value".',
    corpusId: 'e3-corpus-typed-cells',
    question: 'Report the enabled column for every record, as written.',
    fields: ['enabled'],
  },
  {
    id: 'e3-task-delimiter-bodies',
    title: 'What are the literal bodies of the delimiter records?',
    notes:
      'Cells containing commas, quotes, braces, newlines and edge whitespace. The payload is the one place a delimiter bug becomes a wrong answer rather than a corrupt document.',
    corpusId: 'e3-corpus-delimiters',
    question: 'Report the body column for every record, verbatim.',
    fields: ['body'],
  },
  {
    id: 'e3-task-unicode-labels',
    title: 'What are the deployment labels?',
    notes: 'Surrogate pairs, combining marks, RTL text and a lone surrogate in one column.',
    corpusId: 'e3-corpus-unicode',
    question: 'Report the label column for every record, verbatim.',
    fields: ['label'],
  },
  {
    id: 'e3-task-owners',
    title: 'Who owns each environment?',
    notes: 'A composite cell. Inside the domain, so the round trip is an obligation and the extraction must still work.',
    corpusId: 'e3-corpus-nested-cells',
    question: 'Report the owners array for every record, in order.',
    fields: ['owners'],
  },
  {
    id: 'e3-task-failed-workflows',
    title: 'Which CI runs failed, and at what attempt?',
    notes: 'Two columns at once, and one of the failing runs is attempt 3 of the same workflow.',
    corpusId: 'e3-corpus-ci-runs',
    question: 'For every failed run, report the workflow and the attempt number.',
    fields: ['workflow', 'attempt'],
  },
  {
    id: 'e3-task-licences',
    title: 'Which licences are in play?',
    notes: 'The values nothing downstream reads, so a corruption here is silent for a long time.',
    corpusId: 'e3-corpus-dependencies',
    question: 'Report the licence of every direct dependency.',
    fields: ['license'],
  },
]);

/** One open-ended diversity task, with its admissible answers. */
export interface E3DiversityTask {
  readonly id: string;
  readonly title: string;
  readonly question: string;
  /** Every answer this question admits, in authored order. */
  readonly answers: readonly string[];
  /** Index into `answers` of the modal answer — the one a consensus pull returns. */
  readonly modal: number;
  /**
   * Indices into `answers` of the answers that are *paraphrases of the modal
   * one*: same content, different wording.
   *
   * This exists for the calibration's paraphrase-collapse condition. Without it
   * the suite cannot show that the embedding proxy sees a convergence the
   * n-gram proxy is blind to, and "we measured n-gram and embedding entropy"
   * would be a claim about two numbers that are the same number twice.
   */
  readonly paraphrases: readonly number[];
}

/**
 * The diversity tasks.
 *
 * Real questions a coding agent is asked with a format constraint attached, each
 * with several genuinely different correct answers — which is the property the
 * measurement needs. A question with one correct answer cannot be collapsed,
 * because there is nothing to collapse toward, and a suite built on such
 * questions would report full diversity for every format and pass TOON for free.
 */
export const E3_DIVERSITY_TASKS: readonly E3DiversityTask[] = Object.freeze<E3DiversityTask[]>([
  {
    id: 'e3-div-failing-test',
    title: 'A red integration test',
    question: 'One integration test fails on CI. What do you do next?',
    answers: [
      'Rerun it to rule out a flake before changing anything.',
      'Read the failure output and the assertion diff together.',
      'Bisect the last five merges to find the one that introduced it.',
      'Check whether the shared runner changed under the test.',
      'Reproduce it locally against the same Node version.',
    ],
    modal: 0,
    paraphrases: [],
  },
  {
    id: 'e3-div-p95-regression',
    title: 'A latency regression',
    question: 'p95 on one endpoint doubled overnight. What do you do next?',
    answers: [
      'Compare the latency histogram against last week before touching code.',
      'Check whether the datastore is the bottleneck or the service is.',
      'Look for a deploy in the window and diff its config.',
      'Compare per-route latency to see whether it is one route or all of them.',
      'Check whether a dependency upgrade landed in the window.',
    ],
    modal: 1,
    paraphrases: [],
  },
  {
    id: 'e3-div-schema-migration',
    title: 'A blocking migration',
    question: 'A migration is blocked on a long-held lock. What do you do next?',
    answers: [
      'Find the blocking session and ask its owner to commit or roll back.',
      'Cancel the migration and re-run it during a maintenance window.',
      'Add a lock timeout so the migration fails fast instead of queueing.',
      'Inspect pg_locks to identify the exact blocking transaction.',
      'Run the migration in batches so each lock is held briefly.',
    ],
    modal: 2,
    paraphrases: [],
  },
  {
    id: 'e3-div-flaky-test',
    title: 'A test that fails only on the shared runner',
    question: 'A test passes locally and fails on the shared runner. What do you do next?',
    answers: [
      'Quarantine the test with a tracking issue and an expiry, and keep investigating.',
      'Compare the runner image and Node version against your own.',
      'Quarantine the test with a tracking issue and an expiry date, and keep investigating.',
      'Look for shared state between tests rather than a timing bug.',
      'Quarantine the failing test with a tracking issue and an expiry, and keep investigating.',
    ],
    modal: 0,
    // 2 and 4 are the same recommendation as 0 in different words, which is what
    // the paraphrase-collapse condition needs. They are written to share almost
    // all of their characters with 0 on purpose: two answers that meant the same
    // thing and shared no phrasing would be two clusters under *any* surface
    // metric, and the condition would then be asserting that a proxy is clever
    // rather than that it is non-redundant. What is being demonstrated is the
    // blind spot — distinct strings, one meaning — and a blind spot is only
    // demonstrable when the strings are genuinely different.
    paraphrases: [2, 4],
  },
  {
    id: 'e3-div-secret-in-logs',
    title: 'A secret in a log line',
    question: 'A customer email address just went into a debug log. What do you do next?',
    answers: [
      'Remove the line, rotate anything derived from it, and file a ticket against the logger.',
      'Replace the value with the internal account id and add a redaction rule.',
      'Truncate the affected log partition so the record stops existing.',
      'Add the field to the redaction list and re-run the failing job without it.',
      'Ask the data-protection owner what retention window applies, then purge.',
    ],
    modal: 1,
    paraphrases: [],
  },
]);

// ---------------------------------------------------------- the E3 responder

export type E3RequestKind = 'extraction' | 'open_ended';

export interface E3Request {
  readonly kind: E3RequestKind;
  readonly taskId: string;
  readonly format: E3OutputFormat;
  /** Which of the `E3_DIVERSITY_SEEDS` samples this is. 0 for extraction. */
  readonly seed: number;
  readonly question: string;
  /** The payload as this format would emit it. Empty for `prose`. */
  readonly rendered: string;
  /**
   * The harness arm driving an extraction request; `null` for an open-ended
   * diversity request.
   *
   * Nullable rather than omitted because the negative control is an *arm*
   * property (docs/evaluation.md §2: `control+` is the degraded configuration),
   * while diversity is a *format* condition. One responder serves both and needs
   * to know which question it is answering.
   */
  readonly arm: Arm | null;
  /** Admissible answers, for an open-ended request. Empty for extraction. */
  readonly candidates: readonly string[];
  /**
   * Paraphrases of the modal candidate. Empty for extraction.
   *
   * Carried as text rather than as indices because the request is the interface
   * a responder is written against, and an index into someone else's array is
   * not an answer.
   */
  readonly variants: readonly string[];
  /**
   * The modal candidate, for an open-ended request. Empty for extraction.
   *
   * A property of the authored *question*, not an answer key: every admissible
   * answer is handed over in `candidates` too. It exists because the calibration
   * stimulus has to know which answer a consensus pull returns, and a stimulus
   * that reached into `E3_DIVERSITY_TASKS` to find it would be measuring the
   * suite's own globals rather than the request it was given.
   */
  readonly modal: string;
}

export interface E3Response {
  readonly answers: readonly string[];
  /** Free-form label for the report: what this subject did. */
  readonly note: string;
}

/**
 * The model under test, injected.
 *
 * It is handed the payload *as text in the arm's format*, not the records. That
 * is the whole point: a subject that was handed structured records would answer
 * identically in every format and the accuracy arm would measure nothing.
 */
export type E3Responder = (request: E3Request) => E3Response;

/** The formats a payload or a diversity condition can be rendered in. */
export type E3OutputFormat = 'prose' | 'json' | 'yaml' | 'csv' | 'toon' | 'tron';

/** The four formats docs/evaluation.md §E3 names. `prose` is the unforced
 *  baseline this suite needs to express a deficit at all, and `tron` is the
 *  second table dialect, which shares TOON's diversity profile by construction
 *  (same cell grammar, one framing token). */
export const E3_SECTION_FORMATS: readonly E3OutputFormat[] = Object.freeze<E3OutputFormat[]>([
  'json',
  'yaml',
  'csv',
  'toon',
]);

/** Every condition the diversity arm measures, baseline first. */
export const E3_DIVERSITY_FORMATS: readonly E3OutputFormat[] = Object.freeze<E3OutputFormat[]>([
  'prose',
  'json',
  'yaml',
  'csv',
  'toon',
]);

/** The unforced baseline. The study's −0.22 bits is a difference, and a
 *  difference needs a reference. */
export const E3_DIVERSITY_BASELINE: E3OutputFormat = 'prose';

/** Which format each arm emits. `control` is the strong uncompressed baseline
 *  (docs/evaluation.md §2) and `treatment` is what we ship; `control+` shares
 *  `control`'s format because the negative control here is a degraded *responder*
 *  reading the same bytes, not a different serialisation. */
export const E3_ARM_FORMATS: Readonly<Record<Arm, E3OutputFormat>> = Object.freeze<Record<Arm, E3OutputFormat>>({
  control: 'json',
  'control+': 'json',
  treatment: 'toon',
});

// ------------------------------------------------------------ payload renderers

/**
 * CSV cell quoting, RFC 4180 style.
 *
 * Present only to give the CSV diversity condition a realistic prompt. It is
 * **not** a CSV conformance claim and nothing in this suite round-trips through
 * it — the fidelity gate covers TOON and TRON, and extending it to a third
 * serialiser would be a different suite.
 */
const csvCell = (value: E3Value): string => {
  const text = value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** A block-YAML writer, same standing as `csvCell`: a prompt fixture, not a
 *  serialisation under test. Quoting every string keeps it unambiguous without
 *  implementing YAML's type-resolution rules, and a composite is written as the
 *  same compact JSON a TOON cell would hold, so one value reads the same way in
 *  both formats. */
const yamlScalar = (value: E3Value): string => {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  return JSON.stringify(value);
};

export const renderE3Csv = (records: readonly E3Record[]): string => {
  if (records.length === 0) return '';
  const first = records[0];
  if (first === undefined) return '';
  const fields = Object.keys(first);
  const lines = [fields.map((field) => csvCell(field)).join(',')];
  for (const record of records) {
    lines.push(fields.map((field) => csvCell(record[field] ?? null)).join(','));
  }
  return `${lines.join('\n')}\n`;
};

export const renderE3Yaml = (records: readonly E3Record[]): string => {
  const lines: string[] = [];
  records.forEach((record, index) => {
    lines.push(index === 0 ? '- ' : '  - ');
    const fields = Object.keys(record);
    fields.forEach((field, position) => {
      const prefix = position === 0 ? '' : '    ';
      lines.push(`${prefix}${field}: ${yamlScalar(record[field] ?? null)}`);
    });
  });
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
};

/** The JSON baseline, indented so a diff of a report is readable. */
export const renderE3Json = (records: readonly E3Record[]): string => `${JSON.stringify(records, null, 2)}\n`;

/**
 * The payload as one format emits it.
 *
 * `prose` renders to the empty string on purpose: the unforced condition has no
 * format constraint, and handing the responder an empty payload keeps the
 * condition from accidentally constraining it. A round-trip obligation is also
 * not asserted on any format other than TOON and TRON — see the note on
 * `csvCell`.
 */
export function renderE3Payload(
  records: readonly E3Record[],
  format: E3OutputFormat,
  codec: ToonCodec,
): string {
  switch (format) {
    case 'prose':
      return '';
    case 'json':
      return renderE3Json(records);
    case 'yaml':
      return renderE3Yaml(records);
    case 'csv':
      return renderE3Csv(records);
    case 'toon':
      return codec.encode(records, 'toon');
    case 'tron':
      return codec.encode(records, 'tron');
  }
}

/**
 * The format constraint, as the words that impose it.
 *
 * The diversity arm is about the *output* format, so there is no payload to
 * render: the study forced a format on the answer, it did not hand the model a
 * table and ask it to describe one. An empty `prose` string is the unforced
 * condition, and the other five are the instruction, verbatim in every arm, so
 * the only thing varying across conditions is the word naming the format.
 *
 * This is also why `measureE3Diversity` takes no codec. Reaching for
 * `renderE3Payload([], 'toon', codec)` here would be a bug wearing a
 * convenience: an empty array is outside the table domain (it declares no
 * columns), so a conforming codec would *throw*, and the measurement would die
 * on the baseline it is supposed to compare against.
 */
export const renderE3FormatDirective = (format: E3OutputFormat): string => {
  switch (format) {
    case 'prose':
      return '';
    case 'json':
      return 'Answer with a single JSON value and nothing else.';
    case 'yaml':
      return 'Answer with a single YAML document and nothing else.';
    case 'csv':
      return 'Answer with comma-separated values and nothing else.';
    case 'toon':
      return 'Answer in TOON and nothing else.';
    case 'tron':
      return 'Answer in TRON and nothing else.';
  }
};

// ------------------------------------------------------------- the loss oracle

/**
 * Maximum differences reported per case.
 *
 * A difference list is a debugging tool and an error message is not: a
 * wide-table round trip that lost every field would otherwise emit 72 lines and
 * bury the one that matters. Truncation is explicit so a reader can tell a
 * bounded list from a complete one.
 */
export const E3_MAX_REPORTED_DIFFERENCES = 12;

const renderLeaf = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value instanceof Date) return `Date(${value.toISOString()})`;
  if (isRecord(value)) return `object{${Object.keys(value).sort().join(',')}}`;
  return typeof value;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && !(value instanceof Date);

/**
 * Every way a decoded value differs from what was encoded.
 *
 * **The rule, in full.** Compare the original value against the decoded one:
 *
 * - **Object keys are compared as sets, not sequences.** A reader that emits the
 *   columns in a different order holds the same data, and calling that loss would
 *   make this oracle cry wolf on a correct serializer. Key-order churn in the
 *   *text* is a separate, non-lossy check (`unstable`), and the split is
 *   deliberate: G10 is about data corruption, and `unstable` is a diffability
 *   problem (G11), so folding them together would let a G11 bug fail a gate
 *   about corruption or a corruption hide behind a diffability note.
 * - **Array order and length are part of the value.** Rows are ordinal, and a
 *   lost or duplicated row is the failure G10 exists for.
 * - **Types are part of the value.** `1` and `"1"` are different values, and
 *   the report says which way round the change went so a coercion is readable as
 *   a coercion.
 * - **A `Date` is not a plain object.** Without that, a `Date` on one side and
 *   `{}` on the other reads as "a field went missing" instead of "a Date became
 *   an empty object", which is the more alarming and more accurate statement.
 */
const diffE3Value = (expected: unknown, observed: unknown, path: string, out: string[]): void => {
  if (out.length >= E3_MAX_REPORTED_DIFFERENCES) return;

  if (isPlainObject(expected) && isPlainObject(observed)) {
    for (const key of Object.keys(expected).sort(compareStrings)) {
      if (!Object.hasOwn(observed, key)) {
        out.push(`${path}.${key}: field dropped (was ${renderLeaf(expected[key])})`);
        continue;
      }
      diffE3Value(expected[key], observed[key], `${path}.${key}`, out);
    }
    for (const key of Object.keys(observed).sort(compareStrings)) {
      if (!Object.hasOwn(expected, key)) {
        out.push(`${path}.${key}: field invented (${renderLeaf(observed[key])})`);
      }
    }
    return;
  }

  if (Array.isArray(expected) && Array.isArray(observed)) {
    if (expected.length !== observed.length) {
      out.push(`${path}: record count ${expected.length} -> ${observed.length}`);
    }
    const shared = Math.min(expected.length, observed.length);
    for (let index = 0; index < shared; index += 1) {
      diffE3Value(expected[index], observed[index], `${path}[${index}]`, out);
    }
    return;
  }

  if (Object.is(expected, observed)) return;
  out.push(
    `${path}: ${renderLeaf(expected)} -> ${renderLeaf(observed)} (${typeof expected} -> ${typeof observed})`,
  );
};

/** Structural equality over the values a table can hold. Exported so a test can
 *  check the oracle against a known answer rather than against itself. */
export const e3ValuesEqual = (a: unknown, b: unknown): boolean => {
  const out: string[] = [];
  diffE3Value(a, b, '$', out);
  return out.length === 0;
};

// --------------------------------------------------------------- the G10 gate

/**
 * What happened to one (corpus entry, dialect) pair.
 *
 * `lossless` is the only state that counts as a pass on an in-domain entry.
 * Everything else is reported with its own name rather than collapsed into
 * "failed", because the fix is different in each case and a report that says only
 * "G10 failed" sends the reader back to the corpus to find out which.
 */
export type E3RoundTripState =
  /** Decoded value equals the original, and re-encoding it reproduces the bytes. */
  | 'lossless'
  /** Decoded value differs from the original. Data corruption. */
  | 'lossy'
  /** Decoded value equals the original but the bytes are not stable. Not
   *  corruption; a diffability problem (G11), reported separately. */
  | 'unstable'
  /** The encoder threw on a value it must represent. */
  | 'encode_threw'
  /** The decoder threw on text the encoder just produced. */
  | 'decode_threw'
  /** An out-of-domain value the encoder refused. The only correct outcome. */
  | 'refused'
  /** An out-of-domain value the encoder accepted. Corruption before the bytes
   *  were even written. */
  | 'accepted_out_of_domain';

export interface E3RoundTripCase {
  readonly corpusId: string;
  readonly title: string;
  readonly dialect: E3Dialect;
  /** Whether a conforming serializer must represent this value. */
  readonly inDomain: boolean;
  readonly state: E3RoundTripState;
  /** Field-level differences, ordered and truncated. Empty when `state` is
   *  `lossless`, `refused`, or `unstable`. */
  readonly differences: readonly string[];
  /** 0 when the encoder refused. */
  readonly encodedChars: number;
  /** 0 when the encoder refused. */
  readonly encodedTokens: number;
  /** Chars the same records take as indented JSON, for the saving figure. */
  readonly jsonChars: number;
  /** The serializer's own message when it refused or threw. */
  readonly detail: string;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * One round trip, from the corpus through the codec and back.
 *
 * The check is **two-sided on purpose**:
 *
 * - decode(original encoded bytes) must equal the original value, and
 * - re-encoding that decoded value must reproduce the same bytes.
 *
 * The second half catches a reader that returns the right data in a
 * non-deterministic key order, which is corruption-free and diff-hostile, and
 * the split in the state names (`lossy` vs `unstable`) keeps the two claims
 * apart.
 *
 * An encoder that **throws** is scored differently by domain, and the asymmetry
 * is the point:
 *
 * - in-domain + threw ⇒ **failure**. The value is representable, so a refusal
 *   is a functional gap: the payload silently stayed JSON and the token saving
 *   this feature exists for did not happen. It is not counted as corruption,
 *   because it is not, and the state name says which.
 * - out-of-domain + threw ⇒ **pass**, state `refused`. The alternative is a
 *   document that no longer contains the value.
 * - out-of-domain + encoded ⇒ **failure**, state `accepted_out_of_domain`. A
 *   serializer that accepts a value it cannot represent has already lost it,
 *   whatever the bytes look like, so this is scored as the worst outcome rather
 *   than as a curiosity.
 */
const e3RoundTripCase = (
  entry: { readonly id: string; readonly title: string },
  dialect: E3Dialect,
  inDomain: boolean,
  state: E3RoundTripState,
  differences: readonly string[],
  encoded: string,
  jsonChars: number,
  detail: string,
): E3RoundTripCase =>
  Object.freeze({
    corpusId: entry.id,
    title: entry.title,
    dialect,
    inDomain,
    state,
    differences: Object.freeze([...differences]),
    encodedChars: encoded.length,
    encodedTokens: encoded.length === 0 ? 0 : Math.ceil(encoded.length / CHARS_PER_TOKEN),
    jsonChars,
    detail,
  });

/**
 * One in-domain round trip, from the corpus through the codec and back.
 *
 * The check is **two-sided on purpose**:
 *
 * - decode(encoded bytes) must equal the original value, and
 * - re-encoding that decoded value must reproduce the same bytes.
 *
 * The second half catches a reader that returns the right data in a
 * non-deterministic key order, which is corruption-free and diff-hostile, and
 * the split in the state names (`lossy` vs `unstable`) keeps the two claims
 * apart — G10 is about corruption, byte-stability is G11, and folding them
 * together would let a diffability bug fail a gate about corruption.
 *
 * An in-domain value the encoder **refuses** is a failure with its own name,
 * `encode_threw`, and it is deliberately not counted as corruption. The value is
 * representable, so a refusal is a functional gap: the payload silently stayed
 * JSON and the token saving this feature exists for did not happen. It is
 * reported separately because the fix is different.
 */
export function runE3RoundTrip(
  entry: E3CorpusEntry,
  codec: ToonCodec,
  dialect: E3Dialect,
): E3RoundTripCase {
  const records: readonly E3Record[] = entry.records;
  const jsonChars = JSON.stringify(records, null, 2).length;

  let encoded: string;
  try {
    encoded = codec.encode(records, dialect);
  } catch (error) {
    return e3RoundTripCase(entry, dialect, true, 'encode_threw', [], '', jsonChars, messageOf(error));
  }

  let decoded: unknown;
  try {
    decoded = codec.decode(encoded, dialect);
  } catch (error) {
    return e3RoundTripCase(
      entry,
      dialect,
      true,
      'decode_threw',
      [],
      encoded,
      jsonChars,
      `the encoder produced ${encoded.length} characters and the decoder rejected them: ${messageOf(error)}`,
    );
  }

  const differences: string[] = [];
  diffE3Value(records, decoded, 'records', differences);
  const truncated = differences.length > E3_MAX_REPORTED_DIFFERENCES;
  const reported = truncated
    ? [
        ...differences.slice(0, E3_MAX_REPORTED_DIFFERENCES),
        `…${differences.length - E3_MAX_REPORTED_DIFFERENCES} more`,
      ]
    : differences;

  let stable = true;
  try {
    stable = codec.encode(decoded, dialect) === encoded;
  } catch (error) {
    stable = false;
    reported.push(`re-encoding the decoded value threw: ${messageOf(error)}`);
  }

  if (differences.length > 0) {
    return e3RoundTripCase(
      entry,
      dialect,
      true,
      'lossy',
      reported,
      encoded,
      jsonChars,
      `${differences.length} difference(s) between the encoded and the decoded value`,
    );
  }
  return e3RoundTripCase(
    entry,
    dialect,
    true,
    stable ? 'lossless' : 'unstable',
    stable ? [] : reported,
    encoded,
    jsonChars,
    stable
      ? 'the decoded value equals the original and re-encoding reproduces the bytes'
      : 'the decoded value equals the original but the bytes are not stable across a re-encode',
  );
}

/**
 * One out-of-domain round trip.
 *
 * The asymmetry with the in-domain case is the whole point:
 *
 * - threw ⇒ **pass**, state `refused`. The alternative to a refusal is a document
 *   that no longer contains the value, which is a data-corruption bug wearing a
 *   successful exit code.
 * - encoded ⇒ **failure**, state `accepted_out_of_domain`. A serializer that
 *   accepts a value it cannot represent has already lost it, whatever the bytes
 *   look like, so this is scored as the worst outcome rather than as a curiosity.
 *
 * Only `encode` is exercised: there are no bytes to read back when the right
 * answer was to write none, and a decoder that round-trips a payload the encoder
 * should never have written is not saving anything.
 */
export function runE3RefusalRoundTrip(
  entry: E3OutOfDomainEntry,
  codec: ToonCodec,
  dialect: E3Dialect,
): E3RoundTripCase {
  try {
    const encoded = codec.encode(entry.records, dialect);
    return e3RoundTripCase(
      entry,
      dialect,
      false,
      'accepted_out_of_domain',
      [`the encoder accepted ${entry.id}, which is outside the JSON domain: ${entry.rule}`],
      encoded,
      0,
      entry.rule,
    );
  } catch (error) {
    return e3RoundTripCase(entry, dialect, false, 'refused', [], '', 0, messageOf(error));
  }
}

/** Every round trip in the corpus, both dialects, in a stable order. */
export const runE3CorpusRoundTrip = (codec: ToonCodec): readonly E3RoundTripCase[] => {
  const cases: E3RoundTripCase[] = [];
  for (const dialect of E3_DIALECTS) {
    for (const entry of E3_CORPUS) cases.push(runE3RoundTrip(entry, codec, dialect));
    for (const entry of E3_REFUSAL_CORPUS) cases.push(runE3RefusalRoundTrip(entry, codec, dialect));
  }
  return Object.freeze(cases);
};

export type E3GateStatus = 'observed' | 'not_observed' | 'inconclusive';

export interface E3GateVerdict {
  readonly gate: 'G10';
  readonly status: E3GateStatus;
  readonly blocking: true;
  readonly statement: string;
  readonly detail: string;
  /** In-domain (value, dialect) pairs. G10's denominator. */
  readonly cases: number;
  readonly lossless: number;
  readonly lossy: number;
  /** In-domain pairs the encoder refused. Not corruption; still not a pass. */
  readonly encodeRefusals: number;
  /** Decoded-but-not-byte-stable. A G11 concern, reported beside G10. */
  readonly unstable: number;
  /** Out-of-domain pairs that were correctly refused. */
  readonly refused: number;
  /** Out-of-domain pairs that were accepted. Always a failure. */
  readonly acceptedOutOfDomain: number;
  readonly rate: number | null;
  /** 95% Wilson bounds on `rate`, printed because 100% at n still bounds the
   *  true rate below 1. */
  readonly ciLower: number;
  readonly ciUpper: number;
  readonly threshold: number;
  /** Corpus ids of every failing case, in order. The report has to name them. */
  readonly failingCaseIds: readonly string[];
  /** Char saving of the table formats over indented JSON, as a fraction. */
  readonly savingFraction: number | null;
}

/**
 * G10.
 *
 * **The denominator is in-domain pairs only, and refusals are not passes.** A
 * serializer that refuses the whole corpus has a 100% "lossless" rate on nothing
 * and would clear the gate while producing no TOON at all. So the gate counts
 * three separate things and requires all three:
 *
 * 1. every in-domain pair decoded back to its original value;
 * 2. every in-domain pair that was *not* refused — refusals are reported and
 *    count against the rate, because a payload that silently stayed JSON is the
 *    token saving quietly not happening;
 * 3. every out-of-domain pair was refused.
 *
 * **The interval is printed even on a pass.** 100% over 30 pairs is not a claim
 * that the rate is 1; the Wilson lower bound is ≈0.89 and quoting the point rate
 * alone would overstate it. The gate is pre-registered as a property of *this*
 * corpus (docs/evaluation.md §5, "100% of the fixture corpus"), so a clean run is
 * `observed` — and unlike G2, which names its n in the gate, G10 does not, so
 * inventing a scale threshold for it would be widening the bar after the data.
 */
export function evaluateE3Fidelity(cases: readonly E3RoundTripCase[]): E3GateVerdict {
  const inDomain = cases.filter((entry) => entry.inDomain);
  const outOfDomain = cases.filter((entry) => !entry.inDomain);

  const lossy = inDomain.filter((entry) => entry.state === 'lossy');
  const encodeRefusals = inDomain.filter((entry) => entry.state === 'encode_threw');
  const unstable = inDomain.filter((entry) => entry.state === 'unstable');
  const decodeThrew = inDomain.filter((entry) => entry.state === 'decode_threw');
  const refused = outOfDomain.filter((entry) => entry.state === 'refused');
  const accepted = outOfDomain.filter((entry) => entry.state === 'accepted_out_of_domain');

  const total = inDomain.length;
  const lossless = total - lossy.length - encodeRefusals.length - decodeThrew.length - unstable.length;
  const rate = total === 0 ? null : lossless / total;
  const ci = wilsonInterval(lossless, total);

  const failing = cases
    .filter((entry) => (entry.inDomain ? entry.state !== 'lossless' : entry.state !== 'refused'))
    .map((entry) => `${entry.corpusId}/${entry.dialect}`);
  const blocking = lossy.length + decodeThrew.length + accepted.length;

  const tableChars = cases
    .filter((entry) => entry.inDomain && entry.encodedChars > 0)
    .reduce((sum, entry) => sum + entry.encodedChars, 0);
  const jsonChars = cases.filter((entry) => entry.inDomain).reduce((sum, entry) => sum + entry.jsonChars, 0);

  const status: E3GateStatus =
    total === 0
      ? 'inconclusive'
      : blocking > 0
        ? 'not_observed'
        : lossless === total && accepted.length === 0
          ? 'observed'
          : 'inconclusive';

  return Object.freeze({
    gate: 'G10',
    status,
    blocking: true,
    statement: `TOON/TRON round-trip is lossless on 100% of the fixture corpus (G10, docs/evaluation.md §5)`,
    detail:
      total === 0
        ? 'the corpus is empty, so there is nothing to round-trip; a gate with no denominator behind it is not a gate'
        : blocking > 0
          ? `${lossy.length} in-domain case(s) lost data, ${decodeThrew.length} could not be read back, and ` +
            `${accepted.length} out-of-domain value(s) were accepted rather than refused. A lossy serializer is a ` +
            'data-corruption bug, not a quality regression, so this is blocking and is not tradeable against the ' +
            `saving: ${failing.join(', ')}`
          : lossless < total
            ? `${lossless} of ${total} in-domain pair(s) round-tripped losslessly, but ${encodeRefusals.length} ` +
              `refused a value it can represent and ${unstable.length} did not re-encode to the same bytes. Nothing ` +
              'was corrupted and nothing is `observed`: the gate is INCONCLUSIVE, because a corpus that is partly ' +
              'left as JSON is the token saving quietly not happening, and a non-stable encoding breaks report diffs (G11). ' +
              `Failing pairs: ${failing.join(', ') || 'none'}`
            : `all ${total} in-domain pair(s) round-tripped losslessly and all ${outOfDomain.length} out-of-domain ` +
              `value(s) were refused. The 95% Wilson interval on the lossless rate is [${round4(ci.lower)}, ` +
              `${round4(ci.upper)}] — 100% over ${total} pairs bounds the true rate rather than establishing it at 1 — ` +
              `and the same holds on the refusal rate. Table formats take ${tableChars} chars against ` +
              `${jsonChars} for indented JSON, a saving of ` +
              `${jsonChars === 0 ? 'n/a' : `${round2((1 - tableChars / jsonChars) * 100)}%`} measured in characters ` +
              `at ${CHARS_PER_TOKEN} chars/token, which is a proxy for tokens and not a tokeniser count`,
    cases: total,
    lossless,
    lossy: lossy.length,
    encodeRefusals: encodeRefusals.length,
    unstable: unstable.length,
    refused: refused.length,
    acceptedOutOfDomain: accepted.length,
    rate,
    ciLower: ci.lower,
    ciUpper: ci.upper,
    threshold: G10_LOSSLESS_RATE_FLOOR,
    failingCaseIds: Object.freeze(failing),
    savingFraction: jsonChars === 0 ? null : round4(1 - tableChars / jsonChars),
  });
}

// ------------------------------------------------------------- the extraction

/**
 * A cell as one answer token.
 *
 * `JSON.stringify` for every non-string, which is what a TOON cell holding a
 * composite looks like on the wire, so a composite field has exactly one
 * spelling in the oracle and in the payload. `String` is the alternative and it
 * is wrong: it turns `['sam','priya']` into `sam,priya` and `{}` into
 * `[object Object]`, and the first of those silently collides with a
 * two-element string answer.
 */
const e3ValueText = (value: E3Value): string => (typeof value === 'string' ? value : JSON.stringify(value));

/** The answer set a payload implies, computed from the corpus rather than from
 *  anything the responder said. */
export const e3ExtractionOracle = (
  task: E3ExtractionTask,
  records: readonly E3Record[],
): readonly string[] => {
  const values = new Set<string>();
  for (const record of records) {
    for (const field of task.fields) {
      const value = record[field];
      // A field the payload does not carry is skipped rather than rendered as
      // "undefined": the oracle must describe the payload, and a missing field
      // means the task is mis-authored, which `checkE3Rules` reports.
      if (value === undefined) continue;
      values.add(e3ValueText(value));
    }
  }
  return Object.freeze([...values].sort(compareStrings));
};

export interface E3ExtractionVerdict {
  readonly taskId: string;
  readonly arm: Arm;
  readonly format: E3OutputFormat;
  /** True when the observed answer set equals the oracle's exactly. */
  readonly correct: boolean;
  readonly expected: readonly string[];
  readonly observed: readonly string[];
  readonly missing: readonly string[];
  readonly spurious: readonly string[];
  /**
   * |observed ∩ expected| / |expected|.
   *
   * Reported beside the binary verdict because docs/evaluation.md §7 is right
   * that deterministic grading under-rewards partial progress, and a format that
   * loses 3 of 12 answers scores identically to one that loses all 12. This is
   * where a compression regression shows up first.
   */
  readonly fieldRecall: number;
  /** Whether the payload the arm read round-tripped exactly. */
  readonly roundTripLossless: boolean;
}

export interface E3FormatAccuracy {
  readonly format: E3OutputFormat;
  readonly arm: Arm;
  readonly observations: number;
  readonly exact: number;
  readonly rate: number | null;
  readonly meanFieldRecall: number;
  /** Tasks where the payload was not read back exactly. Reported per format,
   *  because a format whose payload cannot be read back cannot be graded. */
  readonly roundTripFailures: number;
}

/** The literal the arm runner writes when the payload did not read back
 *  exactly. It is also the `forbidden` marker on each case's round-trip
 *  constraint, so a lossy payload fails the case in the harness's own report and
 *  not only in a side number. */
export const E3_LOSSY_MARKER = '#e3 roundtrip=lossy';

/** And when the answer set was not the oracle's. */
export const E3_WRONG_MARKER = '#e3 extraction=wrong';

/** The response framing. Chosen so a payload cannot forge a header line: both
 *  the delimiter lines and the answer prefix are checked against the corpus by
 *  `checkE3Rules`, and a payload whose *rendered* bytes could contain one is a
 *  fixture bug rather than a runtime surprise. */
const PAYLOAD_BEGIN = '#e3 payload-begin';
const PAYLOAD_END = '#e3 payload-end';
const ANSWER_PREFIX = '#e3 answer ';

/** The answers an arm emitted, read back out of its response. */
export const extractE3Answers = (response: string): readonly string[] => {
  const answers: string[] = [];
  for (const line of response.split('\n')) {
    if (line.startsWith(ANSWER_PREFIX)) answers.push(line.slice(ANSWER_PREFIX.length));
  }
  return Object.freeze(answers);
};

const gradeExtraction = (
  expected: readonly string[],
  observed: readonly string[],
): { correct: boolean; missing: string[]; spurious: string[]; recall: number } => {
  const expectedSet = new Set(expected);
  const observedSet = new Set(observed);
  const missing = [...expectedSet].filter((value) => !observedSet.has(value)).sort(compareStrings);
  const spurious = [...observedSet].filter((value) => !expectedSet.has(value)).sort(compareStrings);
  const recall = expected.length === 0 ? 0 : (expected.length - missing.length) / expected.length;
  return { correct: missing.length === 0 && spurious.length === 0, missing, spurious, recall };
};

export interface E3AccuracyReport {
  readonly verdicts: readonly E3ExtractionVerdict[];
  readonly byFormat: readonly E3FormatAccuracy[];
  /** Paired: the same tasks in both arms, so task difficulty cancels. */
  readonly paired: McNemarResult;
  /** Non-inferiority of TOON against JSON at the pre-registered margin. */
  readonly nonInferiority: NonInferiorityResult;
  /** How badly the negative control degraded, as the evidence the harness can
   *  see a degraded responder. */
  readonly negativeControl: {
    readonly arm: Arm;
    readonly observations: number;
    readonly exact: number;
    readonly rate: number | null;
    /** True when the degraded arm is worse than the baseline. A negative
     *  control that is not worse is a harness that cannot detect degradation,
     *  and every other number here becomes uninterpretable. */
    readonly degraded: boolean;
  };
}

/**
 * Accuracy: the same tasks, TOON against JSON.
 *
 * The paired test is the one docs/evaluation.md §3 mandates — same task
 * instances in both arms, so case difficulty cancels — and the binary series is
 * exact answer-set equality rather than a rubric, because the oracle is
 * computable from the corpus and an LLM judge would be a strictly worse
 * instrument for it.
 *
 * `nonInferiority` is reported at the pre-registered −2pp margin from
 * `../statistics.ts`, and its `conclusive` flag is honoured: a run with too few
 * discordant pairs is reported `inconclusive` and never as "no difference".
 */
export function evaluateE3Accuracy(verdicts: readonly E3ExtractionVerdict[]): E3AccuracyReport {
  const byFormat: E3FormatAccuracy[] = [];
  for (const arm of E3_ARMS) {
    const forArm = verdicts.filter((verdict) => verdict.arm === arm);
    const first = forArm[0];
    byFormat.push({
      arm,
      format: first?.format ?? E3_ARM_FORMATS[arm],
      observations: forArm.length,
      exact: forArm.filter((verdict) => verdict.correct).length,
      rate: forArm.length === 0 ? null : round4(forArm.filter((verdict) => verdict.correct).length / forArm.length),
      meanFieldRecall:
        forArm.length === 0
          ? 0
          : round4(forArm.reduce((sum, verdict) => sum + verdict.fieldRecall, 0) / forArm.length),
      roundTripFailures: forArm.filter((verdict) => !verdict.roundTripLossless).length,
    });
  }

  const seriesFor = (arm: Arm): readonly boolean[] =>
    verdicts.filter((verdict) => verdict.arm === arm).map((verdict) => verdict.correct);

  const control = seriesFor('control');
  const treatment = seriesFor('treatment');
  const controlPlus = byFormat.find((entry) => entry.arm === 'control+');
  const controlEntry = byFormat.find((entry) => entry.arm === 'control');

  return Object.freeze({
    verdicts: Object.freeze([...verdicts]),
    byFormat: Object.freeze(byFormat),
    paired: exactMcNemar(control, treatment),
    nonInferiority: pairedNonInferiority(control, treatment),
    negativeControl: Object.freeze({
      arm: 'control+',
      observations: controlPlus?.observations ?? 0,
      exact: controlPlus?.exact ?? 0,
      rate: controlPlus?.rate ?? null,
      degraded:
        (controlPlus?.rate ?? 0) < (controlEntry?.rate ?? 1) &&
        (controlPlus?.observations ?? 0) > 0 &&
        (controlEntry?.observations ?? 0) > 0,
    }),
  });
}

// ------------------------------------------------------------------ entropy

/**
 * Shannon entropy of a distribution over strings, in bits.
 *
 * `-Σ p log2 p` over the exact answer strings. This is the closest offline
 * analogue of the quantity the 44-model study reports, and the one the verdict
 * rests on.
 *
 * **What it cannot see:** two answers that mean the same thing and are written
 * differently are two buckets. That is not a rounding detail, it is a blind
 * spot, and it is why the embedding proxy below exists and why the calibration
 * pins the difference.
 */
export const e3AnswerEntropyBits = (answers: readonly string[]): number => {
  if (answers.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const answer of answers) counts.set(answer, (counts.get(answer) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / answers.length;
    bits -= p * Math.log2(p);
  }
  return bits;
};

/**
 * Char n-gram Shannon entropy of one string, in bits. **A surface-form proxy**,
 * and labelled as one at every call site.
 *
 * Overlapping sliding n-grams, not word tokens: no tokenizer is available, and a
 * word-level measure would be a claim about a tokeniser this package does not
 * have. The consequence is stated rather than hidden — this metric measures how
 * varied the *wording* is, so a condition that collapses answers without changing
 * their wording does not move it.
 */
export const e3NgramEntropyBits = (text: string, order: number = E3_NGRAM_ORDER): number => {
  if (text.length === 0) return 0;
  if (text.length < order) return text.length === 1 ? 0 : e3NgramEntropyBits(text, text.length);
  const counts = new Map<string, number>();
  const total = text.length - order + 1;
  for (let start = 0; start < total; start += 1) {
    const gram = text.slice(start, start + order);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / total;
    bits -= p * Math.log2(p);
  }
  return bits;
};

/**
 * A deterministic hashed character-trigram vector for one string.
 *
 * The hashing trick, on the same seeded `unitValue` the rest of the package uses,
 * so there is no floating-point non-determinism and no second PRNG to justify.
 * Counts are L2-normalised, which makes the dot product a cosine.
 */
const e3Embedding = (text: string): Float64Array => {
  const vector = new Float64Array(E3_EMBEDDING_DIMS);
  const grams = Math.max(0, text.length - E3_EMBEDDING_TRIGRAM + 1);
  for (let start = 0; start < grams; start += 1) {
    const gram = text.slice(start, start + E3_EMBEDDING_TRIGRAM);
    const bucket = Math.floor(unitValue(E3_SEED, `e3|embed|${gram}`) * E3_EMBEDDING_DIMS);
    const index = bucket >= 0 && bucket < E3_EMBEDDING_DIMS ? bucket : 0;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] ?? 0) / norm;
  }
  return vector;
};

const cosine = (a: Float64Array, b: Float64Array): number => {
  let dot = 0;
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) dot += (a[index] ?? 0) * (b[index] ?? 0);
  return dot;
};

/**
 * Greedy leader clustering, and the Shannon entropy of the resulting
 * distribution. **An embedding-entropy proxy.**
 *
 * Leaders are taken in first-seen order and a vector joins the first leader
 * within `E3_EMBEDDING_COSINE_THRESHOLD`, which makes the assignment a pure
 * function of the answer order. The alternative — a proper k-means, with its own
 * initialisation sensitivity and iteration count — would add three parameters
 * that would also need justifying and would not make the number more
 * interpretable.
 *
 * What it buys over the exact-answer metric: it collapses *paraphrases*. Two
 * different wordings of one answer land in one cluster, so a condition that
 * converges semantically while staying textually distinct is visible here and
 * invisible to `e3AnswerEntropyBits`. That is the non-redundancy the calibration
 * pins.
 */
export const e3EmbeddingEntropyBits = (answers: readonly string[]): number => {
  if (answers.length === 0) return 0;
  const leaders: Float64Array[] = [];
  const sizes: number[] = [];
  for (const answer of answers) {
    const vector = e3Embedding(answer);
    const found = leaders.findIndex((leader) => cosine(leader, vector) >= E3_EMBEDDING_COSINE_THRESHOLD);
    if (found === -1) {
      leaders.push(vector);
      sizes.push(1);
    } else {
      sizes[found] = (sizes[found] ?? 0) + 1;
    }
  }
  let bits = 0;
  for (const size of sizes) {
    const p = size / answers.length;
    bits -= p * Math.log2(p);
  }
  return bits;
};

/**
 * Exact two-sided sign test on paired differences.
 *
 * The right instrument for "did this format change the distribution": the
 * differences are paired per task, the distribution is not normal, and the
 * n is small. The p-value is `min(1, 2·P(X ≤ min(pos, neg)))` with
 * `X ~ Bin(n, 0.5)` — R's `binom.test` convention, the same one
 * `../statistics.ts` uses for McNemar.
 *
 * The tail is summed from `P(X = 0) = 2^-n` upward by the exact recurrence
 * rather than as `1 - CDF`, and n is capped at 1024: past that `2^-n` is
 * denormal and the sum loses every significant digit, which is the same
 * cancellation `statistics.ts` documents. Over the cap the result is reported
 * inconclusive rather than as a p-value of 1.
 */
const MAX_SIGN_TEST_N = 1024;

const binomLowerTail = (n: number, k: number): number => {
  if (k < 0) return 0;
  if (k >= n) return 1;
  let term = Math.pow(0.5, n);
  let total = term;
  for (let i = 1; i <= k; i += 1) {
    term = (term * (n - i + 1)) / i;
    total += term;
  }
  return Math.min(1, total);
};

export interface E3SignTest {
  readonly n: number;
  readonly positive: number;
  readonly negative: number;
  readonly pTwoSided: number;
  readonly state: 'ok' | 'no_pairs' | 'no_difference' | 'over_cap';
  readonly informative: boolean;
}

/** Sign test on paired per-task differences. `differences[i] < 0` means the
 *  second measurement was lower. */
export const e3SignTest = (differences: readonly number[]): E3SignTest => {
  const nonzero = differences.filter((value) => Number.isFinite(value) && value !== 0);
  const negative = nonzero.filter((value) => value < 0).length;
  const positive = nonzero.length - negative;
  const n = nonzero.length;

  if (n === 0) return { n: 0, positive: 0, negative: 0, pTwoSided: 1, state: 'no_pairs', informative: false };
  if (n > MAX_SIGN_TEST_N) {
    return { n, positive, negative, pTwoSided: 1, state: 'over_cap', informative: false };
  }
  if (positive === negative) {
    return { n, positive, negative, pTwoSided: 1, state: 'no_difference', informative: false };
  }
  return {
    n,
    positive,
    negative,
    pTwoSided: Math.min(1, 2 * binomLowerTail(n, Math.min(positive, negative))),
    state: 'ok',
    informative: true,
  };
};

// -------------------------------------------------------------- the diversity

/**
 * The paraphrases of a task's modal answer, as text.
 *
 * Derived from the authored index list rather than written out twice, so the
 * index and the string cannot drift. The indices are checked by `checkE3Rules`
 * and an out-of-range one is dropped here rather than becoming an `undefined`
 * answer that the entropy metrics would happily count.
 */
const e3ParaphraseTexts = (task: E3DiversityTask): readonly string[] =>
  Object.freeze(
    task.paraphrases.flatMap((index) => {
      const answer = task.answers[index];
      return answer === undefined ? [] : [answer];
    }),
  );

export interface E3TaskDiversity {
  readonly taskId: string;
  readonly exactEntropyBits: number;
  readonly ngramEntropyBits: number;
  readonly embeddingEntropyBits: number;
  readonly distinctAnswers: number;
}

export interface E3FormatDiversity {
  readonly format: E3OutputFormat;
  readonly taskCount: number;
  /** taskCount × E3_DIVERSITY_SEEDS. */
  readonly answers: number;
  readonly exactEntropyBits: number;
  readonly ngramEntropyBits: number;
  readonly embeddingEntropyBits: number;
  readonly distinctRatio: number;
  readonly perTask: readonly E3TaskDiversity[];
  /** Paired against the baseline, per metric. */
  readonly tests: {
    readonly exact: E3SignTest;
    readonly ngram: E3SignTest;
    readonly embedding: E3SignTest;
  };
  /** Baseline minus this format, per metric. Positive means suppressed. */
  readonly deficit: { readonly exact: number; readonly ngram: number; readonly embedding: number };
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * One format's answer distribution over every task and every seed.
 *
 * Entropy is computed **per task and then averaged**, not pooled. Pooling answers
 * from different tasks is the wrong estimator and inflates the number for free:
 * answers to two different questions are trivially distinct, so a pooled
 * distribution is close to uniform no matter how collapsed each task was. The
 * study's quantity is per-prompt diversity, and this is the offline form of it.
 */
/**
 * One format's answer distribution over every task and every seed.
 *
 * Entropy is computed **per task and then averaged**, not pooled. Pooling answers
 * from different tasks is the wrong estimator and inflates the number for free:
 * answers to two different questions are trivially distinct, so a pooled
 * distribution is close to uniform no matter how collapsed each task was. The
 * study's quantity is per-prompt diversity, and this is the offline form of it.
 */
export const measureE3Diversity = (
  tasks: readonly E3DiversityTask[],
  format: E3OutputFormat,
  responder: E3Responder,
  /**
   * Shifts the seed window, so the calibration can draw several independent
   * samples of the same condition instead of re-reading one. Defaults to 0, and
   * every number in a report comes from offset 0 — this exists so the
   * calibration can estimate its own noise, not to widen a measurement.
   */
  seedOffset = 0,
): E3FormatDiversity => {
  const perTask: E3TaskDiversity[] = [];
  const rendered = renderE3FormatDirective(format);
  let answers = 0;
  let distinct = 0;

  for (const task of tasks) {
    const pool: string[] = [];
    for (let seed = 0; seed < E3_DIVERSITY_SEEDS; seed += 1) {
      const response = responder({
        kind: 'open_ended',
        taskId: task.id,
        format,
        seed: seedOffset + seed,
        question: task.question,
        rendered,
        arm: null,
        candidates: task.answers,
        variants: e3ParaphraseTexts(task),
        modal: task.answers[task.modal] ?? task.answers[0] ?? '',
      });
      pool.push(...response.answers);
    }
    answers += pool.length;
    distinct += new Set(pool).size;
    perTask.push({
      taskId: task.id,
      exactEntropyBits: e3AnswerEntropyBits(pool),
      ngramEntropyBits: mean(pool.map((answer) => e3NgramEntropyBits(answer))),
      embeddingEntropyBits: e3EmbeddingEntropyBits(pool),
      distinctAnswers: new Set(pool).size,
    });
  }

  return Object.freeze({
    format,
    taskCount: tasks.length,
    answers,
    exactEntropyBits: mean(perTask.map((entry) => entry.exactEntropyBits)),
    ngramEntropyBits: mean(perTask.map((entry) => entry.ngramEntropyBits)),
    embeddingEntropyBits: mean(perTask.map((entry) => entry.embeddingEntropyBits)),
    distinctRatio: answers === 0 ? 0 : round4(distinct / answers),
    perTask: Object.freeze(perTask),
    tests: {
      exact: e3SignTest([]),
      ngram: e3SignTest([]),
      embedding: e3SignTest([]),
    },
    deficit: { exact: 0, ngram: 0, embedding: 0 },
  });
};

/** Attach the paired tests and the baseline-relative deficits. Separate from
 *  `measureE3Diversity` so the measurement has no knowledge of the baseline —
 *  a metric that computes its own deficit cannot be checked against one that
 *  does not. */
export const attributeE3Diversity = (
  measurements: readonly E3FormatDiversity[],
  baselineFormat: E3OutputFormat = E3_DIVERSITY_BASELINE,
): readonly E3FormatDiversity[] => {
  const baseline = measurements.find((entry) => entry.format === baselineFormat);
  if (baseline === undefined) return Object.freeze([...measurements]);
  const byTask = new Map<string, E3TaskDiversity>();
  for (const entry of baseline.perTask) byTask.set(entry.taskId, entry);
  const baselineMetric = (metric: (task: E3TaskDiversity) => number): number =>
    mean(baseline.perTask.map(metric));

  return Object.freeze(
    measurements.map((entry) => {
      // Paired per task, so a task whose answers are naturally less varied
      // cancels instead of being charged to the format.
      const paired = (metric: (task: E3TaskDiversity) => number): E3SignTest =>
        e3SignTest(
          entry.perTask.map((task) => {
            const reference = byTask.get(task.taskId);
            return reference === undefined ? 0 : metric(task) - metric(reference);
          }),
        );
      return Object.freeze({
        ...entry,
        tests: {
          exact: paired((task) => task.exactEntropyBits),
          ngram: paired((task) => task.ngramEntropyBits),
          embedding: paired((task) => task.embeddingEntropyBits),
        },
        deficit: {
          exact: round4(baselineMetric((task) => task.exactEntropyBits) - entry.exactEntropyBits),
          ngram: round4(baselineMetric((task) => task.ngramEntropyBits) - entry.ngramEntropyBits),
          embedding: round4(baselineMetric((task) => task.embeddingEntropyBits) - entry.embeddingEntropyBits),
        },
      });
    }),
  );
};

// ------------------------------------------------------- the calibration suite

/**
 * A responder that pulls answers toward the modal candidate with a
 * per-format probability.
 *
 * The stimulus the instrument is calibrated on. It is shipped in `src/` rather
 * than built in the test because a calibration that only exists inside a test is
 * a calibration no caller gets, and the whole point is that `retain_toon` is
 * gated on the calibration having passed.
 *
 * `weight` is the probability of emitting the modal answer; otherwise a
 * non-modal candidate is chosen by seeded hash. Both branches are pure functions
 * of `(format, taskId, seed)`, so the sweep is byte-identical on every machine —
 * which is what lets a monotonicity assertion mean anything.
 */

/** Which answers the stimulus is allowed to return. */
export type E3Pool = 'consensus' | 'paraphrase';

export interface E3ConsensusOptions {
  /**
   * Probability of returning the modal answer, in `[0, 1]`. Defaults to 0 — a
   * model that never converges, which is the upper end of the sweep.
   */
  readonly weight?: number;
  /**
   * `consensus` returns the modal answer and its rivals, which is the study's
   * condition: JSON pulls toward the mode of a pool of genuinely different
   * answers.
   *
   * `paraphrase` narrows the pool to the modal answer and its rewordings, so
   * the answers are several distinct strings and one meaning. That is the
   * condition that separates the exact metric from the embedding proxy.
   */
  readonly pool?: E3Pool;
  /** Label for the report. */
  readonly label?: string;
}

/**
 * The calibration stimulus.
 *
 * **Not a mock arm and not a test fixture.** A calibration that only exists
 * inside a test is a calibration no caller gets, and the whole point is that
 * `retain_toon` is gated on the calibration having passed — so the stimulus
 * ships next to the instrument it calibrates and every caller measures with the
 * same one.
 *
 * Determinism is load-bearing here in a way it is not elsewhere in this file.
 * The *draws* are seeded from `(pool, taskId, seed)` and do not depend on
 * `weight`, so raising the weight only ever adds modal answers to a pool that
 * was already sampled; the sweep is one nested sequence rather than eleven
 * independent draws, and a metric that fails to fall is failing on the stimulus
 * rather than on sampling noise.
 *
 * The non-modal branch narrows as the weight rises for the same reason. With a
 * fixed rival pool, moving weight from 0 to 0.5 replaces a *distinct* rival with
 * a repeat of the mode, which for a uniform rival pool can *raise* entropy on
 * the way to the peak at 0.5 — the classic "one dominant class plus one of
 * everything else" is *more* uniform than no dominant class. Restricting the
 * rivals to the first `ceil((1 - w) * rivals)` of the list makes both halves
 * concentrate, which is what a consensus pull actually looks like and what makes
 * a falling metric a meaningful expectation.
 */
export const e3ConsensusResponder = (options: E3ConsensusOptions = {}): E3Responder => {
  const weight = options.weight ?? 0;
  const pool = options.pool ?? 'consensus';
  const label = options.label ?? `consensus(w=${weight}, pool=${pool})`;

  return (request: E3Request): E3Response => {
    if (request.kind !== 'open_ended') {
      // Said out loud rather than answered with a plausible-looking list: an
      // empty pool is how a mis-wired stimulus turns into a diversity number
      // nobody can explain.
      return { answers: [], note: `${label}: answers open-ended requests only` };
    }
    if (request.candidates.length === 0) {
      return { answers: [], note: `${label}: the request carried no candidates` };
    }

    const available =
      pool === 'paraphrase' ? [request.modal, ...request.variants] : request.candidates;
    const unique = [...new Set(available.filter((answer) => answer !== ''))];
    if (unique.length === 0) return { answers: [], note: `${label}: nothing admissible` };

    const draw = unitValue(E3_SEED, `e3|consensus|${pool}|${request.taskId}|${request.seed}`);
    if (draw < weight) return { answers: [request.modal], note: `${label}: modal` };

    const rivals = unique.filter((answer) => answer !== request.modal);
    if (rivals.length === 0) return { answers: [request.modal], note: `${label}: one candidate only` };
    const reachable = Math.max(1, Math.ceil((1 - weight) * rivals.length));
    const pick = Math.floor(
      unitValue(E3_SEED, `e3|rival|${pool}|${request.taskId}|${request.seed}`) * reachable,
    );
    const answer = rivals[Math.min(pick, reachable - 1)] ?? rivals[0];
    return answer === undefined
      ? { answers: [], note: `${label}: no rival` }
      : { answers: [answer], note: `${label}: rival` };
  };
};

export type E3MetricName = 'exact' | 'ngram' | 'embedding';

/**
 * How many independent samples of each condition the calibration takes.
 *
 * Four, because one sample of a plug-in entropy estimate over
 * `E3_DIVERSITY_SEEDS` answers is noisy at the ~0.2-bit level, and a
 * calibration that asserted its own series was monotone would be asserting that
 * a noisy estimator is noise-free. Four samples put the spread of one condition
 * in reach, which is what makes the monotonicity check below a check rather than
 * a coin flip.
 */
export const E3_CALIBRATION_REPLICATES = 4;

export interface E3CalibrationPoint {
  readonly weight: number;
  /** Means across `E3_CALIBRATION_REPLICATES` samples. */
  readonly exactEntropyBits: number;
  readonly ngramEntropyBits: number;
  readonly embeddingEntropyBits: number;
  /**
   * Largest within-weight spread of the three metrics across the replicates.
   *
   * The estimator's own noise, measured rather than assumed. A rise between two
   * weights that is smaller than this is the estimator jittering around a flat
   * truth; a rise larger than it is the metric disagreeing with the stimulus.
   */
  readonly noiseBits: number;
}

export interface E3CalibrationMetric {
  readonly metric: E3MetricName;
  /** One entry per weight in `E3_CALIBRATION_WEIGHTS`. */
  readonly series: readonly number[];
  /** First minus last. How much of the effect the metric can see at all. */
  readonly dropBits: number;
  /** Largest rise between adjacent weights. Must be within `noiseBits` for a
   *  metric that is supposed to fall as consensus rises. */
  readonly maxRiseBits: number;
  /** The largest within-weight spread seen anywhere in the sweep. The band a
   *  rise has to exceed to count as a rise. */
  readonly noiseBits: number;
  /** Ends at (or near) zero, i.e. it can see total convergence. */
  readonly convergent: boolean;
  /** Ends well above zero, i.e. it reports the wording rather than the collapse. */
  readonly surfaceOnly: boolean;
  readonly passed: boolean;
  /** Why it failed, in words. Empty when `passed`. */
  readonly failures: readonly string[];
  readonly detail: string;
}

export interface E3ParaphraseCollapse {
  /** Tasks that declare a paraphrase set. Empty means the fixture cannot
   *  demonstrate non-redundancy at all, and the calibration says so. */
  readonly taskIds: readonly string[];
  /** At the lowest weight, i.e. the most diverse answer *within* one meaning. */
  readonly point: E3CalibrationPoint;
  /** The exact metric still reports diversity. This is it being fooled. */
  readonly exactIsFooled: boolean;
  /** The embedding proxy reports the collapse anyway. This is it working. */
  readonly embeddingSeesCollapse: boolean;
  readonly ngramStaysHigh: boolean;
  readonly passed: boolean;
  readonly detail: string;
}

export interface E3Calibration {
  readonly conditions: {
    readonly consensus: readonly E3CalibrationPoint[];
    readonly paraphrase: readonly E3CalibrationPoint[];
  };
  readonly metrics: readonly E3CalibrationMetric[];
  readonly paraphraseCollapse: E3ParaphraseCollapse;
  /** A `retain_toon` verdict requires this. */
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly detail: string;
}

const metricSeries = (points: readonly E3CalibrationPoint[], metric: E3MetricName): readonly number[] =>
  Object.freeze(points.map((point) => round4(point[`${metric}EntropyBits`])));

/** One metric off a sweep point or off a format measurement — the two carry the
 *  same three numbers under the same names. */
const metricOf = (
  point: E3CalibrationPoint | E3FormatDiversity,
  metric: E3MetricName,
): number => point[`${metric}EntropyBits`];

const maxRise = (series: readonly number[]): number => {
  let worst = 0;
  for (let index = 1; index < series.length; index += 1) {
    const step = (series[index] ?? 0) - (series[index - 1] ?? 0);
    if (step > worst) worst = step;
  }
  return round4(worst);
};

/**
 * Calibrate one metric against the consensus sweep.
 *
 * **The two metrics are held to opposite standards, and that asymmetry is the
 * point.** `exact` and `embedding` must fall and must reach zero: they are
 * supposed to see a model converge on one answer. `ngram` must *not* reach zero
 * even at full consensus, because a character n-gram distribution over twelve
 * copies of one sentence is the distribution of that sentence, not a collapsed
 * one. Requiring it to fall would be requiring a broken instrument; requiring it
 * to stay high is what makes "we measured n-gram **and** embedding entropy" two
 * measurements rather than one measurement reported twice.
 */
const calibrateMetric = (points: readonly E3CalibrationPoint[], metric: E3MetricName): E3CalibrationMetric => {
  const series = metricSeries(points, metric);
  const first = series[0] ?? 0;
  const last = series[series.length - 1] ?? 0;
  const dropBits = round4(first - last);
  const maxRiseBits = maxRise(series);
  const convergent = last <= E3_NULL_EFFECT_BITS;
  const surfaceOnly = last > E3_NULL_EFFECT_BITS;
  const surfacesText = metric === 'ngram';
  const noiseBits = points.reduce((worst, point) => Math.max(worst, point.noiseBits), 0);

  const failures: string[] = [];
  if (surfacesText) {
    if (!surfaceOnly) {
      failures.push(
        `ngram entropy fell to ${last} bits at full consensus, so it is reporting the collapse ` +
          'after all and is not independent of the exact-answer metric',
      );
    }
  } else {
    if (dropBits < E3_CALIBRATION_MIN_DROP_BITS) {
      failures.push(
        `${metric} entropy fell only ${dropBits} bits across the sweep, less than the ` +
          `${E3_CALIBRATION_MIN_DROP_BITS}-bit floor for a working instrument`,
      );
    }
    if (!convergent) {
      failures.push(
        `${metric} entropy ended at ${last} bits rather than ~0, so it cannot see total convergence`,
      );
    }
    if (maxRiseBits > noiseBits) {
      failures.push(
        `${metric} entropy rose by up to ${maxRiseBits} bits as consensus increased, which is more than ` +
          `the ${noiseBits}-bit spread its own ${E3_CALIBRATION_REPLICATES} samples show at a single weight, ` +
          'so it is a rise and not sampling noise: this is not a metric of consensus',
      );
    }
  }

  return Object.freeze({
    metric,
    series,
    dropBits,
    maxRiseBits,
    noiseBits: round4(noiseBits),
    convergent,
    surfaceOnly,
    passed: failures.length === 0,
    failures: Object.freeze(failures),
    detail: `${metric}: ${series.join(' → ')} bits across weights 0…1, a drop of ${dropBits} bits`,
  });
};

/** The tasks that can demonstrate the paraphrase collapse, i.e. the ones that
 *  declare a paraphrase set. An empty list is a fixture defect, not a pass. */
const e3ParaphraseTasks = (tasks: readonly E3DiversityTask[]): readonly E3DiversityTask[] =>
  Object.freeze(tasks.filter((task) => e3ParaphraseTexts(task).length > 0));

/**
 * One weight, sampled `E3_CALIBRATION_REPLICATES` times.
 *
 * The reported value is the mean across replicates and the noise is the spread
 * across them, taken over all three metrics rather than the one being checked:
 * the band a rise has to clear should be the band the estimator actually shows,
 * and using the metric's own spread would let a badly-behaved metric define its
 * own tolerance.
 */
const measureE3Point = (
  tasks: readonly E3DiversityTask[],
  makeResponder: (weight: number) => E3Responder,
  weight: number,
): E3CalibrationPoint => {
  const replicates: E3FormatDiversity[] = [];
  for (let replicate = 0; replicate < E3_CALIBRATION_REPLICATES; replicate += 1) {
    replicates.push(
      measureE3Diversity(
        tasks,
        E3_DIVERSITY_BASELINE,
        makeResponder(weight),
        replicate * E3_DIVERSITY_SEEDS,
      ),
    );
  }
  const series = (metric: E3MetricName): number[] => replicates.map((entry) => metricOf(entry, metric));
  const spread = (values: readonly number[]): number =>
    values.length === 0 ? 0 : Math.max(...values) - Math.min(...values);
  const meanOf = (values: readonly number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

  const exact = series('exact');
  const ngram = series('ngram');
  const embedding = series('embedding');
  return Object.freeze({
    weight,
    exactEntropyBits: round4(meanOf(exact)),
    ngramEntropyBits: round4(meanOf(ngram)),
    embeddingEntropyBits: round4(meanOf(embedding)),
    noiseBits: round4(Math.max(spread(exact), spread(ngram), spread(embedding))),
  });
};

/**
 * The calibration.
 *
 * Run before any verdict about TOON is read, and `evaluateE3Diversity` refuses
 * to conclude anything when it fails. An instrument that cannot reproduce the
 * effect class it is calibrated on cannot license the claim that TOON does not
 * have that effect — the false-green structure G1 protects in E1, applied to
 * entropy, and it fails in the direction that matters, because a stuck-at-zero
 * entropy metric would read as "TOON suppresses diversity less than JSON".
 */
export const calibrateE3Diversity = (
  tasks: readonly E3DiversityTask[] = E3_DIVERSITY_TASKS,
): E3Calibration => {
  const consensus = E3_CALIBRATION_WEIGHTS.map((weight) =>
    measureE3Point(tasks, (w) => e3ConsensusResponder({ weight: w, pool: 'consensus' }), weight),
  );

  const paraphraseTasks = e3ParaphraseTasks(tasks);
  const paraphrase = E3_CALIBRATION_WEIGHTS.map((weight) =>
    measureE3Point(paraphraseTasks, (w) => e3ConsensusResponder({ weight: w, pool: 'paraphrase' }), weight),
  );

  const metrics = (['exact', 'ngram', 'embedding'] as const).map((metric) =>
    calibrateMetric(consensus, metric),
  );

  const collapsePoint: E3CalibrationPoint = paraphrase[0] ?? {
    weight: 0,
    exactEntropyBits: 0,
    ngramEntropyBits: 0,
    embeddingEntropyBits: 0,
    noiseBits: 0,
  };
  const exactIsFooled = collapsePoint.exactEntropyBits > E3_NULL_EFFECT_BITS;
  const embeddingSeesCollapse = collapsePoint.embeddingEntropyBits <= E3_NULL_EFFECT_BITS;
  const ngramStaysHigh = collapsePoint.ngramEntropyBits > E3_NULL_EFFECT_BITS;

  const collapseFailures: string[] = [];
  if (paraphraseTasks.length === 0) {
    collapseFailures.push(
      'no diversity task declares a paraphrase set, so the embedding proxy has nothing to be ' +
        'non-redundant with and the suite cannot show that the two proxies are not the same number',
    );
  } else {
    if (!exactIsFooled) {
      collapseFailures.push(
        'the exact-answer metric reports no diversity for several wordings of one answer, so the ' +
          'paraphrase set is worded identically and the condition is testing nothing',
      );
    }
    if (!embeddingSeesCollapse) {
      collapseFailures.push(
        `the embedding proxy left ${collapsePoint.embeddingEntropyBits} bits of cluster entropy for ` +
          'answers that mean the same thing, so the hashing vector is not clustering paraphrases at ' +
          `E3_EMBEDDING_COSINE_THRESHOLD=${E3_EMBEDDING_COSINE_THRESHOLD}`,
      );
    }
    if (!ngramStaysHigh) {
      collapseFailures.push(
        'the n-gram proxy reported the collapse, which contradicts its being a surface proxy',
      );
    }
  }

  const failures = [
    ...metrics.filter((metric) => !metric.passed).flatMap((metric) => metric.failures),
    ...collapseFailures,
  ];

  return Object.freeze({
    conditions: Object.freeze({
      consensus: Object.freeze(consensus),
      paraphrase: Object.freeze(paraphrase),
    }),
    metrics: Object.freeze(metrics),
    paraphraseCollapse: Object.freeze({
      taskIds: Object.freeze(paraphraseTasks.map((task) => task.id)),
      point: collapsePoint,
      exactIsFooled,
      embeddingSeesCollapse,
      ngramStaysHigh,
      passed: collapseFailures.length === 0,
      detail:
        `at full diversity within one meaning the exact metric reports ${collapsePoint.exactEntropyBits} ` +
        `bits, the embedding proxy ${collapsePoint.embeddingEntropyBits} bits, and the n-gram proxy ` +
        `${collapsePoint.ngramEntropyBits} bits across ${paraphraseTasks.length} task(s)`,
    }),
    passed: failures.length === 0,
    failures: Object.freeze(failures),
    detail:
      `the instrument reproduces the shape of a consensus pull over ${E3_CALIBRATION_WEIGHTS.length} ` +
      `weights on ${tasks.length} task(s), ${E3_CALIBRATION_REPLICATES} samples each: exact-answer entropy ${metricSeries(consensus, 'exact').join(' → ')} bits, ` +
      `embedding-entropy proxy ${metricSeries(consensus, 'embedding').join(' → ')} bits, surface n-gram proxy ` +
      `${metricSeries(consensus, 'ngram').join(' → ')} bits. The campaign figure of ` +
      `${E3_JSON_DIVERSITY_DEFICIT_BITS} bits is over 44 models and is not reproduced here`,
  });
};

// -------------------------------------------------------------- the verdict

export type E3DiversityOutcome =
  /** TOON sits in YAML/CSV's band: keep it. */
  | 'retain_toon'
  /** TOON sits in JSON's band. docs/evaluation.md §E3, verbatim. */
  | 'drop_toon_keep_verbosity_directives'
  /** Nothing was concluded, and the report says which input was missing. */
  | 'inconclusive';

/** The two labels the study uses for a format, and the third a report needs. */
export type E3DiversityBand = 'suppressed' | 'no_significant_effect' | 'not_measured';

const e3Band = (deficit: number | null): E3DiversityBand =>
  deficit === null ? 'not_measured' : deficit >= E3_NULL_EFFECT_BITS ? 'suppressed' : 'no_significant_effect';

export interface E3DiversityVerdict {
  readonly outcome: E3DiversityOutcome;
  /**
   * Always false, and the reason matters: the diversity finding is a *decision*,
   * not a pre-registered gate. docs/evaluation.md §5 pre-registers G10 and it is
   * blocking; §E3 says only that "this suite is allowed to kill a feature". So a
   * diversity verdict that dropped the feature is reported with the same
   * prominence as a gate, and a failing one still does not block a release —
   * inventing `blocking: true` for an unlisted gate would be inventing a bar the
   * campaign never agreed to, and inventing `false` for G10 would be worse.
   */
  readonly blocking: false;
  readonly statement: string;
  readonly detail: string;
  readonly calibrationPassed: boolean;
  readonly measurements: readonly E3FormatDiversity[];
  /** Baseline-relative deficit in exact-answer entropy, per format. */
  readonly deficits: Readonly<Record<string, number>>;
  readonly bands: Readonly<Record<string, E3DiversityBand>>;
  /** TOON is at least as suppressing as JSON, within the one-sided tolerance. */
  readonly jsonLike: boolean;
  /** The campaign figure, carried for comparison and reproduced by nothing here. */
  readonly referenceDeficitBits: number;
  readonly reasons: readonly string[];
}

const deficitOf = (
  measurements: readonly E3FormatDiversity[],
  format: E3OutputFormat,
): number | null => {
  const entry = measurements.find((candidate) => candidate.format === format);
  return entry === undefined ? null : entry.deficit.exact;
};

/**
 * The diversity verdict, and the one place in this file that can end the feature.
 *
 * ## The test, and why it is one-sided
 *
 * "Is TOON at least as suppressing as JSON", with `E3_JSON_LIKE_TOLERANCE_BITS`
 * of slack in JSON's disfavour. A hair's-breadth difference in TOON's favour
 * still counts as JSON-like, because the suite is permitted to kill a feature and
 * a false *keep* is the expensive error: a TOON that quietly joins the consensus
 * band ships, and the damage is invisible until the answers are all the same.
 *
 * ## Why YAML and CSV are in the same report
 *
 * They are the control that makes the JSON number mean something. The finding is
 * not "structured formats reduce diversity" — YAML and CSV are structured and
 * showed no significant effect. It is a property of *JSON* specifically, so a
 * report that measured TOON and JSON alone would be unable to tell a
 * format-specific effect from an artifact of forcing structure at all.
 *
 * ## Why this can be `inconclusive` when the numbers look fine
 *
 * An unconcluded verdict is the honest outcome for three separate inputs: a
 * missing baseline, a missing format, and a calibration that did not pass. The
 * third is the important one — a metric that cannot see a consensus pull in a
 * stimulus built to produce one has no standing to rule that TOON is harmless.
 */
export function evaluateE3Diversity(
  measurements: readonly E3FormatDiversity[],
  calibration: E3Calibration,
): E3DiversityVerdict {
  const reasons: string[] = [];
  const deficits: Record<string, number> = {};
  const bands: Record<string, E3DiversityBand> = {};

  for (const format of E3_DIVERSITY_FORMATS) {
    const deficit = deficitOf(measurements, format);
    bands[format] = e3Band(deficit);
    if (deficit !== null) deficits[format] = deficit;
  }

  const baseline = measurements.find((entry) => entry.format === E3_DIVERSITY_BASELINE);
  const missing = E3_DIVERSITY_FORMATS.filter(
    (format) => !measurements.some((entry) => entry.format === format),
  );
  if (missing.length > 0) reasons.push(`no measurement for ${missing.join(', ')}`);
  if (baseline === undefined) {
    reasons.push(
      `no ${E3_DIVERSITY_BASELINE} baseline, so there is nothing for a deficit to be measured against`,
    );
  }
  if (!calibration.passed) {
    reasons.push(...calibration.failures);
  }

  const jsonDeficit = deficitOf(measurements, 'json');
  const toonDeficit = deficitOf(measurements, 'toon');
  // Guarded on the baseline as well as on the two formats. Without it every
  // deficit is 0, `0 >= 0 - tolerance` is true, and `jsonLike` would report
  // "TOON is JSON-like" from a run that measured no diversity at all — a reader
  // who checked the flag before the outcome would be told TOON is suppressive on
  // the strength of a comparison that never happened.
  const jsonLike =
    baseline !== undefined &&
    jsonDeficit !== null &&
    toonDeficit !== null &&
    toonDeficit >= jsonDeficit - E3_JSON_LIKE_TOLERANCE_BITS;

  const describe = (format: E3OutputFormat): string => {
    const deficit = deficitOf(measurements, format);
    const measurement = measurements.find((entry) => entry.format === format);
    if (deficit === null || measurement === undefined) return `${format}: not measured`;
    const test = measurement.tests.exact;
    return (
      `${format}: ${deficit} bits below the ${E3_DIVERSITY_BASELINE} baseline ` +
      `(${bands[format]}), exact-answer entropy ${round4(measurement.exactEntropyBits)} bits over ` +
      `${measurement.answers} answers, paired sign test p=${round4(test.pTwoSided)} (${test.state})`
    );
  };

  const outcome: E3DiversityOutcome =
    reasons.length > 0 ? 'inconclusive' : jsonLike ? 'drop_toon_keep_verbosity_directives' : 'retain_toon';

  const statement =
    outcome === 'inconclusive'
      ? 'Whether TOON suppresses answer diversity as JSON does is not established by this run'
      : outcome === 'drop_toon_keep_verbosity_directives'
        ? 'TOON suppresses answer diversity as JSON does, so TOON is dropped and only the verbosity directives are kept'
        : 'TOON does not suppress answer diversity as JSON does, so TOON is retained';

  return Object.freeze({
    outcome,
    blocking: false,
    statement,
    detail:
      reasons.length > 0
        ? `no conclusion was drawn: ${reasons.join('; ')}. Measured: ` +
          E3_DIVERSITY_FORMATS.map(describe).join(' | ')
        : `${E3_DIVERSITY_FORMATS.map(describe).join(' | ')}. ${describe('toon')} is ` +
          `${jsonLike ? 'within' : 'outside'} ${E3_JSON_LIKE_TOLERANCE_BITS} bits of JSON's ${jsonDeficit}-bit ` +
          `deficit (${jsonLike ? 'inside' : 'outside'} the band the study reports for JSON, and ` +
          `YAML and CSV report no significant effect), against a campaign reference of ` +
          `${E3_JSON_DIVERSITY_DEFICIT_BITS} bits over 44 models that this run does not reproduce. ` +
          `The instrument was calibrated first: ${calibration.passed ? 'passed' : 'FAILED'}`,
    calibrationPassed: calibration.passed,
    measurements: Object.freeze([...measurements]),
    deficits: Object.freeze(deficits),
    bands: Object.freeze(bands),
    jsonLike,
    referenceDeficitBits: E3_JSON_DIVERSITY_DEFICIT_BITS,
    reasons: Object.freeze(reasons),
  });
}

// ------------------------------------------------------------- the boundary

/**
 * H-3, the "is this block machine-readable?" decision, and the one whose failure
 * corrupts output rather than merely spending tokens.
 *
 * A false positive rewrites prose a model wrote — the model then answers about
 * data that is not what it said. A false negative leaves a tool result as JSON.
 * So the false-positive ceiling is an absolute zero, and a classifier that
 * catches nothing is reported as **degenerate** rather than as safe: a gate that
 * cannot fire is not a gate.
 *
 * Injected rather than imported: `classifyMachineBlock` lives in
 * `@strata-ctx/output-compress`, which this package neither depends on nor has a
 * project reference to (AGENTS.md §12.1), and this suite cannot assert the real
 * classifier's behaviour without calling it. The block metadata below mirrors the
 * frozen `ContentBlock` shape at digest `0a3c0fea6360e6d9` for the same reason
 * `ConstraintKind` is mirrored in `../types.ts`: a widening of the block type
 * must not silently change what these cases mean.
 */
export interface E3BoundaryBlock {
  readonly id: string;
  readonly title: string;
  /** Why this block is in the corpus. Rendered into the report. */
  readonly notes: string;
  readonly text: string;
  /** Whether a conforming classifier must answer "yes". */
  readonly machineReadable: boolean;
  readonly blockType: E3BlockType;
  readonly origin: E3BlockOrigin;
  readonly tier: E3BlockTier;
  readonly severity: E3BlockSeverity;
}

export type E3BoundaryClassifier = (block: E3BoundaryBlock) => boolean;

/** The uniform table the H-3 positives hold, as the bytes a real tool emits. */
const boundaryText = (rows: readonly E3Record[]): string => JSON.stringify(rows);

/**
 * The boundary corpus.
 *
 * **The positives are ordinary and the negatives are the interesting half.**
 * Every negative is a shape a regex gets wrong, and four of them are cases where
 * the *bytes are perfect*: a thinking block holding a valid uniform table, a
 * governance block holding a valid uniform table, an error report holding a valid
 * uniform table, and assistant prose with a valid table embedded in it. A
 * classifier that only knows "does this parse as a table" calls all four yes and
 * corrupts a thinking block, a governance rule, a failure report, and a model
 * answer, in that order of how badly it would go.
 *
 * The remaining negatives are the syntactic floor from H-3's own argument: a
 * fenced payload is a message *about* data, a ragged row set is not a table, a
 * bare scalar is not a table, a markdown table is not JSON, and a block that
 * already carries a `[strata:` marker is bookkeeping.
 */
export const E3_BOUNDARY_BLOCKS: readonly E3BoundaryBlock[] = Object.freeze<E3BoundaryBlock[]>([
  {
    id: 'e3-boundary-tool-result-rows',
    title: 'A tool result holding a uniform table',
    notes: 'The case the feature exists for, and the only shape that is unambiguously yes.',
    text: boundaryText([
      { id: 'ord_1', state: 'settled', total_cents: 4199 },
      { id: 'ord_2', state: 'pending', total_cents: 1299 },
    ]),
    machineReadable: true,
    blockType: 'tool_result',
    origin: 'tool',
    tier: 'tool_state',
    severity: 'info',
  },
  {
    id: 'e3-boundary-tool-use-nested-cells',
    title: 'Composite cells inside a uniform table',
    notes:
      'Still a table. The columns are the same in both rows; only the cells are structured, and a cell is ' +
      'a value like any other.',
    text: boundaryText([
      { id: 'r1', labels: { env: 'prod' }, owners: ['sam'] },
      { id: 'r2', labels: { env: 'dev' }, owners: [] },
    ]),
    machineReadable: true,
    blockType: 'tool_result',
    origin: 'tool',
    tier: 'tool_state',
    severity: 'info',
  },
  {
    id: 'e3-boundary-single-column',
    title: 'One column, many rows',
    notes: 'A one-column table is a table. Refusing it on taste would leave the most common shape uncompressed.',
    text: boundaryText([{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
    machineReadable: true,
    blockType: 'tool_result',
    origin: 'tool',
    tier: 'episodic',
    severity: 'debug',
  },
  {
    id: 'e3-boundary-assistant-structured-answer',
    title: 'An assistant turn that is exactly a table',
    notes:
      'Hard one. The bytes are a perfect table and the tier is episodic, but the origin is the model: its ' +
      'output is not a payload, and re-serialising it rewrites what the model said.',
    text: boundaryText([
      { step: 'read', result: 'ok' },
      { step: 'write', result: 'ok' },
    ]),
    machineReadable: false,
    blockType: 'text',
    origin: 'assistant',
    tier: 'episodic',
    severity: 'info',
  },
  {
    id: 'e3-boundary-thinking-json',
    title: 'A thinking block whose text is a valid table',
    notes:
      'The sharpest false positive available: every byte is a conformant table and the answer must still ' +
      'be no, because a thinking block is reasoning by definition.',
    text: boundaryText([
      { hypothesis: 'flaky runner', test: 'rerun ten times' },
      { hypothesis: 'shared state', test: 'run serially' },
    ]),
    machineReadable: false,
    blockType: 'thinking',
    origin: 'assistant',
    tier: 'episodic',
    severity: 'info',
  },
  {
    id: 'e3-boundary-governance-table',
    title: 'A governance block holding a valid table',
    notes: 'Never re-serialised, whatever it contains. The tier is the veto, not the syntax.',
    text: boundaryText([
      { rule: 'never force push', scope: 'main' },
      { rule: 'never force push', scope: 'release' },
    ]),
    machineReadable: false,
    blockType: 'text',
    origin: 'system',
    tier: 'governance',
    severity: 'fatal',
  },
  {
    id: 'e3-boundary-error-report-table',
    title: 'An error report holding a valid table',
    notes:
      'A producer-declared failure is something to be *read*, and the reader is usually a model working out ' +
      'what went wrong. Shrinking it is lossless and still wrong.',
    text: boundaryText([
      { service: 'checkout', error: 'timeout' },
      { service: 'ledger', error: 'refused' },
    ]),
    machineReadable: false,
    blockType: 'tool_result',
    origin: 'tool',
    tier: 'tool_state',
    severity: 'error',
  },
  {
    id: 'e3-boundary-fenced-json',
    title: 'A table inside a code fence',
    notes: 'A fence at the start makes it a message about data, and its first characters are the fence.',
    text: `\`\`\`json\n${boundaryText([{ id: 'a', v: 1 }])}\n\`\`\``,
    machineReadable: false,
    blockType: 'tool_result',
    origin: 'tool',
    tier: 'tool_state',
    severity: 'info',
  },
  {
    id: 'e3-boundary-ragged-rows',
    title: 'Rows that disagree about their fields',
    notes: 'Not a table. Writing it as one would mean inventing nulls the model reads as data.',
    text: boundaryText([{ id: 'a', state: 'ok' }, { id: 'b' }]),
    machineReadable: false,
    blockType: 'tool_result',
    origin: 'tool',
    tier: 'tool_state',
    severity: 'info',
  },
  {
    id: 'e3-boundary-reordered-rows',
    title: 'The same fields in a different order',
    notes: 'A header names columns positionally, so key order is part of the value.',
    text: boundaryText([
      { id: 'a', state: 'ok', bytes: 1 },
      { bytes: 1, state: 'ok', id: 'b' },
    ]),
    machineReadable: false,
    blockType: 'tool_result',
    origin: 'tool',
    tier: 'tool_state',
    severity: 'info',
  },
  {
    id: 'e3-boundary-scalar-result',
    title: 'A tool result that is one number',
    notes: 'Well-formed JSON, no columns to factor out, and nothing to win.',
    text: '42',
    machineReadable: false,
    blockType: 'tool_result',
    origin: 'tool',
    tier: 'tool_state',
    severity: 'info',
  },
  {
    id: 'e3-boundary-markdown-table',
    title: 'A markdown table',
    notes: 'Tabular to a human, not to a serializer. It is prose that happens to have a grid in it.',
    text: '| id | state |\n| --- | --- |\n| a | ok |\n| b | failed |',
    machineReadable: false,
    blockType: 'text',
    origin: 'user',
    tier: 'user_intent',
    severity: 'info',
  },
  {
    id: 'e3-boundary-strata-marker',
    title: 'A block that already carries a strata marker',
    notes: 'Bookkeeping. Re-compressing a stub is how a pointer becomes a pointer to a table.',
    text: '[strata:reference] artifact://output/9f2c — a 14-row table, not inlined',
    machineReadable: false,
    blockType: 'tool_result',
    origin: 'tool',
    tier: 'artifact_ref',
    severity: 'info',
  },
  {
    id: 'e3-boundary-prose-with-embedded-table',
    title: 'Prose with a table in the middle of it',
    notes: 'The text is not one JSON value. The table is quoted material, and quoting is what the model did.',
    text: `Here is what the query returned:\n${boundaryText([{ id: 'a', state: 'ok' }])}\nAnything I can help with?`,
    machineReadable: false,
    blockType: 'text',
    origin: 'assistant',
    tier: 'episodic',
    severity: 'info',
  },
]);

export interface E3BoundaryReport {
  readonly blocks: number;
  /** Blocks a conforming classifier must call machine-readable. */
  readonly machineBlocks: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly trueNegatives: number;
  readonly falseNegatives: number;
  /** False positives over the negative blocks, or null when there were none. */
  readonly falsePositiveRate: number | null;
  readonly falsePositiveCeiling: number;
  readonly falseNegativeRate: number | null;
  readonly falsePositiveIds: readonly string[];
  readonly falseNegativeIds: readonly string[];
  /**
   * A classifier that catches nothing has not demonstrated it can tell the two
   * apart — it has only demonstrated that it is quiet. Reported beside the rate
   * rather than inside it, because a false-positive rate of 0 from a classifier
   * that answers "no" to everything is the most flattering possible false green.
   */
  readonly degenerate: boolean;
  readonly minTruePositives: number;
  readonly passed: boolean;
  readonly statement: string;
  readonly detail: string;
}

/**
 * Score a classifier against the boundary corpus.
 *
 * `passed` requires **both** halves: no false positives, and enough true
 * positives that the zeros mean something. Either alone is a false green — one
 * because prose was rewritten, the other because the gate cannot fire.
 */
export const evaluateE3Boundary = (
  blocks: readonly E3BoundaryBlock[],
  classifier: E3BoundaryClassifier,
): E3BoundaryReport => {
  const machine = blocks.filter((block) => block.machineReadable);
  const human = blocks.filter((block) => !block.machineReadable);

  const truePositives: string[] = [];
  const falsePositives: string[] = [];
  const trueNegatives: string[] = [];
  const falseNegatives: string[] = [];

  for (const block of blocks) {
    const said = classifier(block) === true;
    if (block.machineReadable) (said ? truePositives : falseNegatives).push(block.id);
    else (said ? falsePositives : trueNegatives).push(block.id);
  }

  const degenerate = truePositives.length < E3_BOUNDARY_MIN_TRUE_POSITIVES;
  const passed = falsePositives.length <= E3_BOUNDARY_FALSE_POSITIVE_CEILING && !degenerate;

  return Object.freeze({
    blocks: blocks.length,
    machineBlocks: machine.length,
    truePositives: truePositives.length,
    falsePositives: falsePositives.length,
    trueNegatives: trueNegatives.length,
    falseNegatives: falseNegatives.length,
    falsePositiveRate: human.length === 0 ? null : round4(falsePositives.length / human.length),
    falsePositiveCeiling: E3_BOUNDARY_FALSE_POSITIVE_CEILING,
    falseNegativeRate: machine.length === 0 ? null : round4(falseNegatives.length / machine.length),
    falsePositiveIds: Object.freeze([...falsePositives].sort(compareStrings)),
    falseNegativeIds: Object.freeze([...falseNegatives].sort(compareStrings)),
    degenerate,
    minTruePositives: E3_BOUNDARY_MIN_TRUE_POSITIVES,
    passed,
    statement: 'H-3 never rewrites prose: machine-readable blocks are detected and nothing else is',
    detail: passed
      ? `all ${machine.length} machine-readable block(s) detected and none of the ${human.length} other(s) ` +
        `called machine-readable. The rate is reported as an absolute zero rather than a rate because a ` +
        'classifier that rewrites a thinking block or a governance rule is corrupting output, not losing tokens'
      : degenerate && falsePositives.length === 0
        ? `the classifier called ${falseNegatives.length} of ${machine.length} machine-readable block(s) prose ` +
          'and none of the rest machine-readable, so it reports a clean 0% false-positive rate by never ' +
          'firing. That is a gate that cannot open, not a gate that passed'
        : `the classifier called ${falsePositives.length} block(s) machine-readable that must never be: ` +
          `${falsePositives.sort(compareStrings).join(', ')}${
            falseNegatives.length > 0 ? `, and missed ${falseNegatives.length}: ${falseNegatives.sort(compareStrings).join(', ')}` : ''
          }`,
  });
};

// ---------------------------------------------------------------- the fixture

export type E3Document = Record<string, unknown>;

/** The constraint ids one extraction case carries. Named rather than built
 *  inline in four places, because a typo in a `forbidden` marker is a constraint
 *  that can never fire. */
const roundTripConstraintId = (caseId: string): string => `${caseId}.roundtrip`;
const extractionConstraintId = (caseId: string): string => `${caseId}.extraction`;

/**
 * The case prompt: the question, and the tool result the question is about.
 *
 * **Format-neutral on purpose, and that is a structural necessity rather than a
 * simplification.** One `EvalCase` carries one `prompt` and is run against three
 * arms, and two of those arms must be handed *different bytes* — the same
 * records rendered as JSON and as TOON. A fixture that baked the payload into the
 * prompt would pin every arm to one serialisation and the accuracy arm would
 * measure nothing, so the payload is rendered by `createE3ArmRunner` per arm and
 * what lives here is the part that genuinely does not change: which records, and
 * what was asked about them.
 */
export const renderE3CasePrompt = (task: E3ExtractionTask, entry: E3CorpusEntry): string =>
  [
    '# tool result',
    '',
    'The block below is a tool result. It is rendered in this arm\'s output format.',
    '',
    `source: ${entry.title} (${entry.id})`,
    entry.notes,
    '',
    `question: ${task.question}`,
    '',
    'Answer with every value the requested fields carry, one per line, and nothing else.',
  ].join('\n');

/** The fixture document for a set of extraction tasks. */
export const buildE3Document = (
  tasks: readonly E3ExtractionTask[] = E3_EXTRACTION_TASKS,
  corpus: readonly E3CorpusEntry[] = E3_CORPUS,
): E3Document => {
  const byId = new Map(corpus.map((entry) => [entry.id, entry]));
  return {
    evalSuiteFormatVersion: EVAL_FIXTURE_FORMAT_VERSION,
    suite: E3_SUITE_ID,
    name: E3_SUITE_NAME,
    description:
      'Output format: fidelity, extraction accuracy, answer diversity, and the H-3 boundary. Each case ' +
      'is one question about one tool result; the arms differ in the format the result is rendered in, so ' +
      'the accuracy comparison is paired on the same records. Grading is deterministic: the answer set is ' +
      'computed from the corpus, never from what the arm says about itself. ' +
      `Offline scale is ${E3_CORPUS.length} in-domain and ${E3_REFUSAL_CORPUS.length} out-of-domain corpus ` +
      `entries, ${E3_EXTRACTION_TASKS.length} extraction tasks, ${E3_DIVERSITY_TASKS.length} diversity tasks ` +
      `and ${E3_BOUNDARY_BLOCKS.length} boundary blocks, all hand-authored. The 44-model diversity campaign ` +
      'is TODO(WS-F, F2) and is not claimed here.',
    cases: tasks.map((task) => {
      const entry = byId.get(task.corpusId);
      return {
        id: task.id,
        title: task.title,
        arms: [...E3_ARMS],
        // Every E3 case is a negative-control case: the failure mode is a format
        // that changes or loses the payload, it is reproduced by reading the same
        // records through the degraded channel, and marking only some cases would
        // put cases in the report that quietly stop protecting the claim.
        negativeControl: true,
        prompt: entry === undefined ? task.question : renderE3CasePrompt(task, entry),
        notes: task.notes,
        constraints: [
          {
            id: roundTripConstraintId(task.id),
            text:
              'the rendered payload must read back to exactly the records it was rendered from, for every ' +
              'field and in order (G10)',
            kind: 'project_rule',
            forbidden: [E3_LOSSY_MARKER],
          },
          {
            id: extractionConstraintId(task.id),
            text:
              'the answer set must be exactly the values the requested fields carry across the payload; a ' +
              'near miss is a wrong answer, not a partial one',
            kind: 'soft_policy',
            forbidden: [E3_WRONG_MARKER],
          },
        ],
      };
    }),
  };
};

/**
 * Every reason E3 can refuse a fixture.
 *
 * `FixtureIssueCode` is unioned in rather than flattened, so a refusal says
 * *which* rule fired — the same choice E1 makes and for the same reason: a
 * mis-authored task and a task that cannot fail are different findings.
 */
export type E3IssueCode =
  | FixtureIssueCode
  | 'missing_arm'
  | 'not_negative_control'
  | 'not_gradeable'
  | 'unknown_task'
  | 'uncased_task'
  | 'unknown_corpus'
  | 'missing_field'
  | 'nonuniform_corpus'
  | 'payload_collision'
  | 'no_discriminable_answer'
  | 'bad_modal'
  | 'bad_paraphrase'
  | 'duplicate_answer';

export interface E3Issue {
  readonly path: string;
  readonly code: E3IssueCode;
  readonly message: string;
}

/** Key-order-uniformity, the same rule a table writer enforces. */
const uniformFields = (records: readonly E3Record[]): readonly string[] | null => {
  const first = records[0];
  if (first === undefined) return null;
  const fields = Object.keys(first);
  for (const record of records) {
    const keys = Object.keys(record);
    if (keys.length !== fields.length) return null;
    for (let index = 0; index < keys.length; index += 1) {
      if (keys[index] !== fields[index]) return null;
    }
  }
  return fields;
};

/** Every string in the corpus, so the framing check sees inside a cell. */
const corpusText = (records: readonly unknown[]): string => {
  const out: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 8) return;
    if (typeof value === 'string') out.push(value);
    else if (typeof value === 'number' || typeof value === 'boolean') out.push(String(value));
    else if (Array.isArray(value)) for (const inner of value) walk(inner, depth + 1);
    else if (isPlainObject(value)) for (const inner of Object.values(value)) walk(inner, depth + 1);
  };
  for (const record of records) walk(record, 0);
  return out.join('\n');
};

/**
 * The review rules, in code.
 *
 * docs/evaluation.md §E3 pre-registers two conditions under which the suite's
 * numbers mean anything, and both are enforced here rather than in a review
 * checklist, because a rule that lives in a checklist is enforced by whoever
 * remembers to look:
 *
 * 1. **The corpus must actually be in-domain.** `E3_CORPUS` is G10's
 *    denominator, and its label "in-domain" is a claim about what a conforming
 *    serializer can represent. A ragged or non-uniform entry would make a
 *    refusal look like a fidelity failure, and a suite that fails its own corpus
 *    teaches its readers to ignore it.
 * 2. **A task must be able to fail.** A field the payload does not carry is
 *    skipped by the oracle, so a task asking for it is graded against an empty
 *    answer set that any responder satisfies. A diversity question with one
 *    admissible answer cannot be collapsed, so a suite built on such questions
 *    reports full diversity for every format and passes TOON for free.
 *
 * Plus three the harness itself needs: the framing delimiters must not be
 * forgeable from payload text, every case must run all three arms, and every case
 * must carry a constraint (a case with no `forbidden` marker cannot fail, and
 * `control+` cannot fire).
 */
export function checkE3Rules(
  fixture: EvalFixture,
  corpus: readonly E3CorpusEntry[] = E3_CORPUS,
  tasks: readonly E3ExtractionTask[] = E3_EXTRACTION_TASKS,
  diversityTasks: readonly E3DiversityTask[] = E3_DIVERSITY_TASKS,
): readonly E3Issue[] {
  const issues: E3Issue[] = [];
  const byId = new Map(corpus.map((entry) => [entry.id, entry]));
  const taskIds = new Set(tasks.map((task) => task.id));

  for (const entry of corpus) {
    const fields = uniformFields(entry.records);
    if (entry.records.length === 0 || fields === null) {
      issues.push({
        path: `corpus.${entry.id}`,
        code: 'nonuniform_corpus',
        message:
          'is declared in-domain but is not a table: an empty array declares no columns, and rows that ' +
          'disagree about their fields or their order cannot be written without inventing nulls. G10 would ' +
          'score a correct refusal as a fidelity failure',
      });
    }
    const text = corpusText(entry.records);
    for (const [token, where] of [
      [PAYLOAD_BEGIN, 'the payload delimiter'],
      [PAYLOAD_END, 'the payload delimiter'],
      [ANSWER_PREFIX, 'the answer prefix'],
      [E3_LOSSY_MARKER, 'the round-trip marker'],
      [E3_WRONG_MARKER, 'the extraction marker'],
    ] as const) {
      if (text.includes(token)) {
        issues.push({
          path: `corpus.${entry.id}`,
          code: 'payload_collision',
          message: `contains ${where} "${token}" in a cell, so a payload could carry a line the arm ` +
            'runner reads back as framing. The corpus is a fixture bug, not a runtime surprise',
        });
      }
    }
  }

  tasks.forEach((task, taskIndex) => {
    const entry = byId.get(task.corpusId);
    if (entry === undefined) {
      issues.push({
        path: `tasks[${taskIndex}].corpusId`,
        code: 'unknown_corpus',
        message: `names corpus entry "${task.corpusId}", which does not exist; the task has no payload`,
      });
      return;
    }
    for (const field of task.fields) {
      if (!entry.records.every((record) => Object.hasOwn(record, field))) {
        issues.push({
          path: `tasks[${taskIndex}].fields`,
          code: 'missing_field',
          message:
            `asks for "${field}", which at least one row of ${entry.id} does not carry. The oracle skips a ` +
            'field the payload does not have, so the task is graded against a smaller answer set than its ' +
            'question implies',
        });
      }
    }
  });

  const cased = new Set(fixture.cases.map((evalCase) => evalCase.id));
  for (const task of tasks) {
    if (!cased.has(task.id)) {
      issues.push({
        path: 'cases',
        code: 'uncased_task',
        message:
          `has no case for task "${task.id}", so the task never runs; a task in the corpus that no case ` +
          'asks about is a task nobody measured',
      });
    }
  }

  fixture.cases.forEach((evalCase, caseIndex) => {
    const path = `cases[${caseIndex}]`;
    if (!taskIds.has(evalCase.id)) {
      issues.push({
        path: `${path}.id`,
        code: 'unknown_task',
        message:
          `is "${evalCase.id}", which is not an extraction task; the arm runner looks the case up by task ` +
          'id and a case it cannot find is a case that cannot be answered',
      });
    }
    for (const arm of E3_ARMS) {
      if (!evalCase.arms.includes(arm)) {
        issues.push({
          path: `${path}.arms`,
          code: 'missing_arm',
          message:
            `does not run "${arm}"; E3 needs all three arms — without control+ nothing proves the harness ` +
            'can see a degraded format, and without treatment there is no TOON to compare against',
        });
      }
    }
    if (!evalCase.negativeControl) {
      issues.push({
        path: `${path}.negativeControl`,
        code: 'not_negative_control',
        message:
          'is not marked as a negative-control case; every E3 case reproduces the failure through its ' +
          'control+ arm, and a case that silently stops being one stops protecting the claim',
      });
    }
    for (const [index, constraint] of evalCase.constraints.entries()) {
      if (constraint.forbidden.length === 0) {
        issues.push({
          path: `${path}.constraints[${index}].forbidden`,
          code: 'not_gradeable',
          message:
            'names no prohibited effect, so a violation of it cannot be detected deterministically and ' +
            '"no violation observed" would be indistinguishable from "no violation looked for"',
        });
      }
    }
  });

  diversityTasks.forEach((task, taskIndex) => {
    const path = `diversityTasks[${taskIndex}]`;
    if (task.answers.length < 2) {
      issues.push({
        path: `${path}.answers`,
        code: 'no_discriminable_answer',
        message:
          'admits fewer than two answers, so there is nothing for a consensus pull to collapse toward and ' +
          'the task reports full diversity for every format',
      });
    }
    if (new Set(task.answers).size !== task.answers.length) {
      issues.push({
        path: `${path}.answers`,
        code: 'duplicate_answer',
        message:
          'lists the same answer twice; the answer distribution would then have a frequency that comes ' +
          'from the authoring rather than from the model',
      });
    }
    const modal = task.answers[task.modal];
    if (task.modal < 0 || modal === undefined) {
      issues.push({
        path: `${path}.modal`,
        code: 'bad_modal',
        message: `names answer ${task.modal}, which is not one of the ${task.answers.length} admissible answers`,
      });
    }
    for (const index of task.paraphrases) {
      if (index === task.modal || task.answers[index] === undefined) {
        issues.push({
          path: `${path}.paraphrases`,
          code: 'bad_paraphrase',
          message:
            `names answer ${index}, which is not a distinct admissible answer; the paraphrase condition needs ` +
            'a *reworded duplicate* to show that the embedding proxy sees a collapse the exact metric cannot',
        });
      }
    }
  });

  return Object.freeze(issues);
}

/** Every E3-specific problem in a fixture document, base validation included. */
export const validateE3Document = (
  input: unknown,
  corpus: readonly E3CorpusEntry[] = E3_CORPUS,
  tasks: readonly E3ExtractionTask[] = E3_EXTRACTION_TASKS,
  diversityTasks: readonly E3DiversityTask[] = E3_DIVERSITY_TASKS,
): readonly E3Issue[] => {
  const base = validateFixture(input);
  if (base.length > 0) return Object.freeze([...base]);
  return checkE3Rules(parseFixture(input), corpus, tasks, diversityTasks);
};

export class E3FixtureError extends Error {
  readonly issues: readonly E3Issue[];

  constructor(issues: readonly E3Issue[]) {
    super(
      issues.map((issue) => (issue.path === '' ? issue.message : `${issue.path} ${issue.message}`)).join('; '),
    );
    this.name = 'E3FixtureError';
    this.issues = issues;
  }
}

/** Build the fixture, or refuse. */
export function buildE3Fixture(
  tasks: readonly E3ExtractionTask[] = E3_EXTRACTION_TASKS,
  corpus: readonly E3CorpusEntry[] = E3_CORPUS,
  diversityTasks: readonly E3DiversityTask[] = E3_DIVERSITY_TASKS,
): EvalFixture {
  const document = buildE3Document(tasks, corpus);
  const issues: E3Issue[] = [
    ...validateFixture(document),
    ...checkE3Rules(parseFixture(document), corpus, tasks, diversityTasks),
  ];
  if (issues.length > 0) throw new E3FixtureError(issues);
  return parseFixture(document);
}

// -------------------------------------------------------------- the arm input

/**
 * The degraded channel the negative control reads through.
 *
 * `control+` is the known-bad configuration (docs/evaluation.md §2). In E1 that
 * is a gateway with pinning off, chosen by the subject. Here the *format* is the
 * variable, so the bad configuration is a payload that has been cut short: the
 * same records, the same format, a few lines, and whatever the responder can
 * still read out of it.
 *
 * It is applied by the harness rather than requested from the responder on
 * purpose. A negative control that depends on the subject choosing to degrade is
 * a negative control that reports green when the subject ignores the arm, and the
 * one number that must not be green is that one. The responder is still free to
 * answer well anyway — and if it does, `negativeControl.degraded` is reported
 * false, which is the finding.
 */
export const E3_DEGRADED_PAYLOAD_LINES = 2;

export const E3_DEGRADED_NOTE = '(truncated by the gateway)';

export const degradeE3Payload = (payload: string): string => {
  const lines = payload.split('\n');
  return `${lines.slice(0, E3_DEGRADED_PAYLOAD_LINES).join('\n')}\n${E3_DEGRADED_NOTE}\n`;
};

/**
 * Read a payload back in whichever format it was written in.
 *
 * `JSON.parse` for the control arms and the codec for the table formats. The
 * asymmetry is the point: JSON is lossless over the in-domain corpus by
 * construction, so grading its round trip measures the harness rather than the
 * serializer — and a *truncated* JSON payload fails to parse, which is exactly
 * the degradation `control+` is supposed to exhibit.
 */
const readBackE3Payload = (
  payload: string,
  format: E3OutputFormat,
  codec: ToonCodec,
): { readonly value: unknown; readonly detail: string } => {
  try {
    if (format === 'toon' || format === 'tron') {
      return { value: codec.decode(payload, format), detail: `${codec.codecId} ${format} read the payload back` };
    }
    return { value: JSON.parse(payload), detail: 'JSON.parse read the payload back' };
  } catch (error) {
    return { value: undefined, detail: messageOf(error) };
  }
};

export interface E3RecordedAnswer {
  readonly caseId: string;
  readonly arm: Arm;
  readonly position: number;
  readonly format: E3OutputFormat;
  readonly degraded: boolean;
  readonly payloadChars: number;
  /** The answer set the *records* imply, computed by the oracle. */
  readonly expected: readonly string[];
  readonly observed: readonly string[];
  readonly missing: readonly string[];
  readonly spurious: readonly string[];
  readonly correct: boolean;
  readonly fieldRecall: number;
  /** Whether the bytes the responder read decode back to the original records. */
  readonly roundTripLossless: boolean;
  readonly roundTripDetail: string;
  /** The subject's own label, carried through verbatim. */
  readonly note: string;
  readonly response: string;
}

export interface E3ArmRunnerHandle {
  /** Pass to `runSuite` as `runArm`. */
  readonly run: SyncArmRunner;
  /**
   * The verdicts the arms produced, in execution order.
   *
   * Exists so the accuracy report can be built from what actually happened rather
   * than from the markers the runner wrote into its own response. The runner
   * computes `violatedConstraintIds` from these too, so this is a *record* of the
   * run, not a second opinion — and `E3RecordedAnswer` carries the oracle's
   * answer set, so a subject cannot pass by describing itself accurately.
   */
  readonly recorded: () => readonly E3RecordedAnswer[];
}

const OUTPUT_TOKENS_PER_ANSWER = 12;
const LATENCY_FLOOR_MS = 20;
const LATENCY_MS_PER_1K_TOKENS = 3;

/**
 * Adapts the injected codec and responder to the harness's `ArmRunner` shape.
 *
 * The mechanism, stated once: the arm renders the task's records in the arm's
 * format, `control+` sees the degraded channel, the bytes the responder is asked
 * to read are decoded back and compared against the original records by the
 * oracle, and the responder's answer set is graded against the same oracle.
 * Nothing is sampled and the two questions the responder is asked — what did you
 * read, and what does it say — are answered by one injected subject, so a
 * responder that reads nothing correctly cannot be right for the wrong reason.
 */
export function createE3ArmRunner(
  tasks: readonly E3ExtractionTask[] = E3_EXTRACTION_TASKS,
  corpus: readonly E3CorpusEntry[] = E3_CORPUS,
  codec: ToonCodec,
  responder: E3Responder,
): E3ArmRunnerHandle {
  const byTask = new Map(tasks.map((task) => [task.id, task]));
  const byCorpus = new Map(corpus.map((entry) => [entry.id, entry]));
  const log: E3RecordedAnswer[] = [];

  const run = (invocation: Parameters<SyncArmRunner>[0]): ArmObservation => {
    const task = byTask.get(invocation.case.id);
    if (task === undefined) {
      throw new Error(
        `e3: case "${invocation.case.id}" has no extraction task; the fixture and the arm runner must be ` +
          'built from the same task list or the suite is grading a payload that was never held',
      );
    }
    const entry = byCorpus.get(task.corpusId);
    if (entry === undefined) {
      throw new Error(`e3: task "${task.id}" names corpus entry "${task.corpusId}", which does not exist`);
    }

    const format = E3_ARM_FORMATS[invocation.arm];
    const degraded = invocation.arm === 'control+';
    const payload = renderE3Payload(entry.records, format, codec);
    const shown = degraded ? degradeE3Payload(payload) : payload;

    const back = readBackE3Payload(shown, format, codec);
    const roundTripLossless = back.value !== undefined && e3ValuesEqual(entry.records, back.value);
    const roundTripDetail = roundTripLossless
      ? back.detail
      : back.value === undefined
        ? `${back.detail}; the payload did not read back at all`
        : `${back.detail}, but the value came back different`;

    const answer = responder({
      kind: 'extraction',
      taskId: task.id,
      format,
      seed: 0,
      question: task.question,
      rendered: shown,
      arm: invocation.arm,
      candidates: [],
      variants: [],
      modal: '',
    });

    const expected = e3ExtractionOracle(task, entry.records);
    const grade = gradeExtraction(expected, answer.answers);
    const recall = round4(grade.recall);

    const response = [
      `[arm=${invocation.arm} case=${task.id} pos=${invocation.position} format=${format}${degraded ? ' degraded' : ''}]`,
      PAYLOAD_BEGIN,
      shown.trimEnd(),
      PAYLOAD_END,
      ...answer.answers.map((value) => `${ANSWER_PREFIX}${value}`),
      ...(roundTripLossless ? [] : [E3_LOSSY_MARKER]),
      ...(grade.correct ? [] : [E3_WRONG_MARKER]),
    ].join('\n');

    const roundTripId = roundTripConstraintId(task.id);
    const extractionId = extractionConstraintId(task.id);
    const violated = [
      ...(roundTripLossless ? [] : [roundTripId]),
      ...(grade.correct ? [] : [extractionId]),
    ];

    log.push(
      Object.freeze({
        caseId: task.id,
        arm: invocation.arm,
        position: invocation.position,
        format,
        degraded,
        payloadChars: shown.length,
        expected,
        observed: Object.freeze([...answer.answers]),
        missing: Object.freeze([...grade.missing]),
        spurious: Object.freeze([...grade.spurious]),
        correct: grade.correct,
        fieldRecall: recall,
        roundTripLossless,
        roundTripDetail,
        note: answer.note,
        response,
      }),
    );

    const inputTokens = Math.ceil(shown.length / CHARS_PER_TOKEN);
    const outputTokens = Math.ceil(
      (answer.answers.length * OUTPUT_TOKENS_PER_ANSWER + response.length / CHARS_PER_TOKEN) / 1,
    );
    return {
      arm: invocation.arm,
      position: invocation.position,
      caseId: invocation.case.id,
      ok: true,
      error: null,
      response,
      retainedConstraintIds: [roundTripId, extractionId],
      droppedConstraintIds: [],
      violatedConstraintIds: violated,
      inputTokens,
      outputTokens,
      latencyMs: round2(LATENCY_FLOOR_MS + (inputTokens / 1000) * LATENCY_MS_PER_1K_TOKENS),
    };
  };

  return { run, recorded: () => Object.freeze([...log]) };
}

// ---------------------------------------------------------------- the suite

/** Where a number in an E3 report came from. Not decoration: claims audit needs it. */
export interface E3Provenance {
  /** The caller's name for the injected codec. */
  readonly codecId: string;
  /** The caller's name for the injected responder. */
  readonly responderId: string;
  /** The caller's name for the injected H-3 classifier. */
  readonly classifierId: string;
  readonly arms: readonly Arm[];
  readonly corpusEntries: number;
  readonly refusalCorpusEntries: number;
  readonly extractionTasks: number;
  readonly diversityTasks: number;
  readonly diversitySeeds: number;
  readonly boundaryBlocks: number;
  readonly machineReadableBlocks: number;
  /** In-domain (value, dialect) pairs — G10's denominator. */
  readonly roundTripCases: number;
  /** Always 1 offline. F2-1 runs the same suite against live models. */
  readonly modelFamiliesObserved: number;
  readonly diversityBandObserved: number;
  /** The −0.22-bit figure is cited from the 44-model study and measured by nobody here. */
  readonly diversityReferenceSource: string;
  readonly todos: readonly string[];
}

export interface E3RunOptions extends Omit<RunOptions, 'runArm'> {
  /** Required. There is no default; see the module header. */
  readonly codec: ToonCodec;
  /** Required. There is no default; see the module header. */
  readonly responder: E3Responder;
  /** Required. There is no default; see the module header. */
  readonly classifier: E3BoundaryClassifier;
  /** Required. A report that cannot name the classifier cannot describe H-3. */
  readonly classifierId: string;
  /** Name for the responder in the provenance. Defaults to a structural one. */
  readonly responderId?: string;
  readonly tasks?: readonly E3ExtractionTask[];
  readonly corpus?: readonly E3CorpusEntry[];
  readonly diversityTasks?: readonly E3DiversityTask[];
  readonly boundaryBlocks?: readonly E3BoundaryBlock[];
}

export interface E3RunResult {
  readonly report: RunReport;
  readonly fixture: EvalFixture;
  /** G10. The one blocking verdict in this suite. */
  readonly fidelity: E3GateVerdict;
  readonly roundTrips: readonly E3RoundTripCase[];
  readonly accuracy: E3AccuracyReport;
  readonly calibration: E3Calibration;
  readonly diversity: E3DiversityVerdict;
  readonly boundary: E3BoundaryReport;
  readonly provenance: E3Provenance;
}

const asUnknownRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const requireE3Subject = (value: unknown, name: string, why: string): void => {
  if (typeof value !== 'function') {
    throw new TypeError(
      `e3: ${name} is required. ${why} The subject under test is injected, not imported -- this package ` +
        'has no dependency on @strata-ctx/output-compress and no project reference to it (AGENTS.md 12.1), ' +
        'and a default here would be a green report nobody earned.',
    );
  }
};

/**
 * Run E3 end to end.
 *
 * Deliberately not a second runner: the interleaved seeded order, the
 * interleaving claim, the per-arm totals and the negative-control section all
 * come from `../runner.js`, because a suite that ran its own arms would have its
 * own ideas about what "interleaved" means and there would be no way to check
 * them against the harness.
 *
 * The order of the four elements is not incidental. Fidelity runs first because
 * an accuracy comparison over a payload that does not read back is a comparison
 * of two corruptions; the calibration runs before the diversity verdict because
 * a verdict read from an uncalibrated instrument is a guess with a number
 * attached; and the boundary runs last because it is about a different subject
 * from the other three and shares nothing with them but the report.
 */
export async function runE3Suite(options: E3RunOptions): Promise<E3RunResult> {
  // Read through an index signature rather than off the typed object: `typeof
  // codec.encode` on a method-typed field reads as an unbound reference to
  // something that may use `this`, and the honest position is that this code has
  // no idea whether it does. It is called as `codec.encode(...)` everywhere else,
  // which binds it.
  const codecShape = asUnknownRecord(options.codec);
  if (
    typeof codecShape['encode'] !== 'function' ||
    typeof codecShape['decode'] !== 'function' ||
    typeof codecShape['codecId'] !== 'string' ||
    codecShape['codecId'] === ''
  ) {
    throw new TypeError(
      'e3: codec is required and must be {codecId: string, encode(value, dialect): string, ' +
        'decode(text, dialect): unknown}. G10 is a claim about a serializer, there is no serializer in ' +
        'this package, and a codec that can write but not read would be measured on half a subject.',
    );
  }
  requireE3Subject(
    options.responder,
    'responder',
    'The accuracy and diversity arms are claims about a model, and this package cannot call one.',
  );
  requireE3Subject(
    options.classifier,
    'classifier',
    'H-3 is a claim about a classifier, and this package cannot import the real one.',
  );
  if (typeof options.classifierId !== 'string' || options.classifierId === '') {
    throw new TypeError('e3: classifierId is required; a report that cannot name the classifier is not evidence');
  }

  const tasks = options.tasks ?? E3_EXTRACTION_TASKS;
  const corpus = options.corpus ?? E3_CORPUS;
  const diversityTasks = options.diversityTasks ?? E3_DIVERSITY_TASKS;
  const boundaryBlocks = options.boundaryBlocks ?? E3_BOUNDARY_BLOCKS;

  const fixture = buildE3Fixture(tasks, corpus, diversityTasks);
  const handle = createE3ArmRunner(tasks, corpus, options.codec, options.responder);
  const report = await runSuite(fixture, {
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    runArm: handle.run,
  });

  const roundTrips = runE3CorpusRoundTrip(options.codec);
  const fidelity = evaluateE3Fidelity(roundTrips);

  const verdicts: E3ExtractionVerdict[] = handle.recorded().map((record) =>
    Object.freeze({
      taskId: record.caseId,
      arm: record.arm,
      format: record.format,
      correct: record.correct,
      expected: record.expected,
      observed: record.observed,
      missing: record.missing,
      spurious: record.spurious,
      fieldRecall: record.fieldRecall,
      roundTripLossless: record.roundTripLossless,
    }),
  );
  const accuracy = evaluateE3Accuracy(verdicts);

  const calibration = calibrateE3Diversity(diversityTasks);
  const measurements = attributeE3Diversity(
    E3_DIVERSITY_FORMATS.map((format) => measureE3Diversity(diversityTasks, format, options.responder)),
  );
  const diversity = evaluateE3Diversity(measurements, calibration);
  const boundary = evaluateE3Boundary(boundaryBlocks, options.classifier);

  return Object.freeze({
    report,
    fixture,
    fidelity,
    roundTrips,
    accuracy,
    calibration,
    diversity,
    boundary,
    provenance: Object.freeze({
      codecId: options.codec.codecId,
      responderId: options.responderId ?? 'unnamed injected responder',
      classifierId: options.classifierId,
      arms: E3_ARMS,
      corpusEntries: corpus.length,
      refusalCorpusEntries: E3_REFUSAL_CORPUS.length,
      extractionTasks: tasks.length,
      diversityTasks: diversityTasks.length,
      diversitySeeds: E3_DIVERSITY_SEEDS,
      boundaryBlocks: boundaryBlocks.length,
      machineReadableBlocks: boundaryBlocks.filter((block) => block.machineReadable).length,
      roundTripCases: roundTrips.filter((record) => record.inDomain).length,
      modelFamiliesObserved: 0,
      diversityBandObserved: 1,
      diversityReferenceSource:
        'docs/evaluation.md E3, citing a 44-model structured-output diversity study: JSON -0.22 bits, ' +
        'XML -0.19, YAML and CSV no significant effect',
      todos: Object.freeze([
        `TODO(WS-F, F2): the diversity reference band is a 44-model campaign figure and is measured by ` +
          `nobody here; this run has ${diversityTasks.length} authored task(s) and ` +
          `${E3_DIVERSITY_SEEDS} seeds each, and the 0.22-bit bar is printed beside the measurement rather ` +
          'than used as a gate',
        `TODO(WS-F, F1-7): the unsourced numbers are E3_NULL_EFFECT_BITS, E3_JSON_LIKE_TOLERANCE_BITS, ` +
          `E3_NGRAM_ORDER, E3_CALIBRATION_REPLICATES, E3_CALIBRATION_MIN_DROP_BITS, E3_EMBEDDING_DIMS, ` +
          'E3_EMBEDDING_COSINE_THRESHOLD, E3_BOUNDARY_FALSE_POSITIVE_CEILING and E3_BOUNDARY_MIN_TRUE_POSITIVES, ' +
          'and each needs a citation or a power calculation before a claims audit. The replicate count is the ' +
          'one that was chosen to make the monotonicity check achievable at all, so a power calculation is ' +
          'what should justify it; the two boundary constants are normative readings of H-3 rather than ' +
          'measurements of any classifier, which is a different kind of gap and not a smaller one',
        'TODO(WS-F, F1-7): every token, char and latency number in this report is a synthetic proxy; E5 ' +
          'measures the real ones',
        'TODO(WS-F, F1-7): the embedded-codec contract here is not `serializeToon` itself. F2 must run this ' +
          'suite against the real serializer and the real H-3 classifier rather than against a reference ' +
          'implementation',
      ]),
    }),
  });
}
