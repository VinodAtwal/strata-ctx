import type { ContentBlock, ContextState, LossyContext, Message } from '@strata-ctx/core-types';
import { estimateBlockTokens, estimateMessageTokens, estimateTokens } from '@strata-ctx/core-types';

/**
 * P0-2. Two estimators, two jobs, and the type system holds the line between them.
 *
 * ## What the comparative estimator is for
 *
 * core-types' `./tokens.ts` divides character count by four. It is a *ratio-safe
 * estimate*: docs/risk-analysis.md §3.1 R1 measured it against a real tokenizer and
 * found the bias runs in both directions -- natural prose lands at 0.89-0.97x (the
 * estimate is pessimistic, therefore safe) while JSON lands at 1.43-1.49x and
 * special-character-dense text at 2.43-2.49x [7]. A shared bias cancels when the same
 * estimator sits on both sides of a subtraction, which is why `estimateTextTokens` in
 * output-compress is the right tool for a savings claim and stays untouched.
 *
 * ## What it is not for
 *
 * `evaluateTrigger` compares a token count against a real `contextLimit`, and a
 * `contextLimit` is not a ratio. A 1.49x under-count means the trigger reads 33% of a
 * window that is really 50% full: compaction does not fire, the request goes out over
 * budget, and the error is invisible because the code that produced it looks like every
 * other budget computation in the repo. Nothing in a char/4 divide can tell you that;
 * only a different estimate can.
 *
 * ## The split, in one sentence
 *
 * The comparative estimator answers "how much did we save?". The pessimistic estimator
 * answers "how much of the window is this?". They are different questions with
 * different correct answers, so they are different functions rather than one function
 * with a flag.
 *
 * ## How the estimate is built, and why it is per-character
 *
 * A tokenizer's packing rate is not a property of a document, it is a property of a
 * *character kind*. Letters and spaces pack densely -- that is why prose measures
 * 0.89-0.97x, comfortably pessimistic. Punctuation does not: a tokenizer has to spell
 * `{`, `}`, `,` and `:` out of its vocabulary, so a JSON object costs more than its
 * character count admits and symbol soup costs more still.
 *
 * Solving [7]'s two dense rows against a prose baseline gives the per-character rates
 * directly. JSON is ~40% structural characters at 1.49x overall and prose is ~0.95x,
 * so the structural characters themselves must cost (1.49 - 0.6x0.95) / 0.4 ~ 2.3x the
 * char/4 rate; symbol-dense text at 2.49x and ~100% punctuation gives ~2.5x. Both round
 * to the same number, which is the point: **`PUNCTUATION_EXCESS` is not a fudge factor,
 * it is the measured per-character rate of punctuation**, and letters are free.
 *
 * Doing it per character rather than per document is what makes a mixed block correct
 * without a special case. A threshold on a whole block's density has a cliff at it: a
 * transcript that is 75% prose, 11% JSON and 14% symbols crosses no threshold at all
 * and gets filed as code at 1.0x, when the length-weighted blend of the measurements is
 * 1.22x. A sum over characters has no cliff, because the prose genuinely dilutes the
 * punctuation and the arithmetic does the diluting for us.
 *
 * ## What this does not handle
 *
 * High-entropy base64 payloads, minified bundles with no punctuation, and long unbroken
 * alphanumeric runs are all charged the letters-are-free rate of 1.0x, because every
 * character in them is a letter and [7] measured letters as already pessimistic. A real
 * tokenizer does not agree for base64, which is close to incompressible. That gap is
 * declared here rather than patched with a heuristic, because the only thing that would
 * size the penalty is a measurement of what a tokenizer does to base64, and inventing a
 * number for it is the exact failure mode this module exists to remove. The calibration
 * loop is where the number belongs.
 * TODO(calibration): measure high-entropy alphanumeric content and charge it accordingly.
 *
 * ## Why the comparison is `Math.max` and never `Math.min`
 *
 * The structured estimate is derived independently -- it measures content shape, not
 * character count -- so it can land either side of the comparative floor. For ASCII
 * prose the two agree exactly and `max` is an identity. For JSON,
 * special-character-dense text and anything non-ASCII the structured side wins, and
 * `max` is what keeps the result above the floor. Swapping it for `min` silently
 * reinstates the under-count for exactly the content classes the measurement flagged.
 *
 * ## Why the trigger input is branded
 *
 * A bare `number` cannot be wrong at the point where it is produced, only at the point
 * where it is trusted, and those two points are in different files. So the budget
 * boundary takes a `PessimisticTokens`, whose brand is a module-private `unique symbol`.
 * Nothing outside this file can manufacture one -- not `estimateMessageTokens`, not an
 * arithmetic expression, not an object literal -- so a budget decision can only ever
 * receive a count this module vouched for. The explicit constructor `pessimisticCount`
 * exists for the case where a count is genuinely already pessimistic; it is a named
 * function rather than a cast so the claim is visible at the call site and greppable,
 * which is the difference between a convention and a type.
 */

/**
 * The same divisor as `BYTES_PER_TOKEN` in core-types' `./tokens.ts`.
 *
 * Restated rather than imported: a separate estimator that reads the comparative one's
 * constants is the comparative estimator with extra steps. It is not a silent second
 * copy, though -- `pessimisticBlockTokens` on ASCII prose is *required* to equal
 * `estimateBlockTokens` on the same block, so the two constants cannot drift apart
 * without turning that equality test red.
 */
const BYTES_PER_TOKEN = 4;

/** Matches `PER_BLOCK_OVERHEAD_TOKENS` in core-types' `./tokens.ts`; the same test pins it. */
const PER_BLOCK_OVERHEAD_TOKENS = 3;

/** Matches the per-message structural overhead `estimateMessageTokens` adds. */
const PER_MESSAGE_OVERHEAD_TOKENS = 3;

/**
 * How much more than the `chars/4` rate a punctuation character costs.
 *
 * 2.5 total minus the 1.0 letters get, from the derivation in this file's header.
 * Exported because it is the one number the whole model turns on and a silent edit to
 * it would change every budget decision in the product; the suite pins what it implies
 * for each measured class.
 */
export const PUNCTUATION_EXCESS = 1.5;

/**
 * Punctuation characters in contact before a run counts as expensive.
 *
 * Punctuation surrounded by words is punctuation a tokenizer can pack with its
 * neighbours -- `a + b`, `users[2]`, `(a, b)`, and the `,` and `.` of a sentence.
 * Punctuation touching punctuation has no word-shaped anchor anywhere near it, so a real
 * tokenizer spells each character out separately: `#$%&*!<>?~^|@+=_` costs about what
 * two and a half times its character count admits.
 *
 * Two is the threshold, and it is the low one on purpose. One is the case that must *not*
 * fire, or every sentence period in the corpus would be charged as JSON punctuation and
 * ASCII prose would stop equalling the comparative estimate -- which is the one property
 * that keeps prose from being inflated. Three was tried first and under-charged JSON,
 * whose structural characters sit in runs of two.
 *
 * TODO(calibration): measured against a real tokenizer's output rather than inferred
 * from the fixtures in [7].
 */
const PUNCTUATION_CONTACT_RUN = 2;

/**
 * ASCII-character equivalents charged for one non-ASCII code point.
 *
 * docs/risk-analysis.md §3.1 R1 measured only ASCII classes, so this is a design
 * judgement and is declared as one. The comparative estimator counts UTF-16 code units,
 * so a 3-byte CJK ideograph is charged 0.75 of a token while costing a real tokenizer
 * one or two -- the same under-count the measurement documents, on every non-Latin
 * script. The gateway's ratio table (`packages/gateway/src/token-estimator.ts`) weights
 * a non-ASCII character at 2.0 ASCII-equivalents, which is right for a *ratio* because
 * the ratio's own bias absorbs it; a budget decision wants the safe end of the range
 * instead. A CJK ideograph is one BPE token on its own or two at worst, against roughly
 * four ASCII characters per token, so 8 units -- two tokens -- is the pessimistic end.
 *
 * TODO(calibration): replace with the measured per-script distribution. The calibration
 * loop below is the mechanism. Until a provider's own `usage` field has been sampled
 * across scripts this number is a reasoned guess in the safe direction, not a
 * measurement, and it is the single least-supported number in this file.
 */
const NON_ASCII_UNITS = 8;

/**
 * Multiplier intervals that define each content class.
 *
 * The class is a label on the multiplier, not a separate judgement: the number and the
 * name cannot disagree because one is computed from the other. A caller can therefore
 * report the class in telemetry and know which number produced it.
 */
const CLASS_THRESHOLDS = Object.freeze({ code: 1.05, json: 1.35, symbols: 2.0 });

export type TokenContentClass = 'prose' | 'code' | 'json' | 'symbols';

/** `{`, `}`, `[`, `]`, `"`, `:`, `,` -- the delimiters a serialised object is built from. */
const JSON_STRUCTURE_CODES: ReadonlySet<number> = new Set([
  0x7b, 0x7d, 0x5b, 0x5d, 0x22, 0x3a, 0x2c,
]);

const isAsciiAlnum = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);

const isAsciiSpace = (code: number): boolean => code === 0x20 || (code >= 0x09 && code <= 0x0d);

/** Selects a sample's band in `calibrationReport`. `\p{ASCII}` rather than a code-point loop. */
const NON_ASCII_PATTERN = /[^\p{ASCII}]/u;

interface Shape {
  /** Content charged in ASCII-character equivalents. */
  readonly units: number;
  readonly ascii: number;
  /** ASCII punctuation a tokenizer cannot pack with its neighbours. */
  readonly expensive: number;
  readonly nonAscii: number;
}

/**
 * One pass, because deciding whether a punctuation run is expensive needs to know the
 * whole run -- the first character of a run cannot be classified until the second one
 * proves a run exists -- and re-scanning would make this quadratic on exactly the
 * multi-megabyte transcripts that motivated the estimator.
 *
 * A run is expensive when it has two or more punctuation characters, or when it contains
 * a structural character with no letter on its left. The second clause is what separates
 * JSON's `":"` and `,"` from a sentence's `,` and `.`: both are isolated runs of one, and
 * only the structural ones are ever adjacent to something that is not a letter. Charging
 * on structural characters *alone* was tried and inflated ordinary prose, because a comma
 * is a comma is a comma and `,` is in the structural set.
 */
function shapeOf(text: string): Shape {
  let units = 0;
  let ascii = 0;
  let expensive = 0;
  let nonAscii = 0;
  let run = 0;
  let structUnflanked = false;
  let letterBefore = false;

  const closeRun = (): void => {
    if (run > 0 && (run >= PUNCTUATION_CONTACT_RUN || structUnflanked)) expensive += run;
    run = 0;
    structUnflanked = false;
  };

  for (const cp of text) {
    const code = cp.codePointAt(0) ?? 0;
    if (code > 0x7f) {
      closeRun();
      units += NON_ASCII_UNITS;
      nonAscii += 1;
      letterBefore = false;
      continue;
    }
    ascii += 1;
    units += 1;
    if (isAsciiAlnum(code) || isAsciiSpace(code)) {
      closeRun();
      letterBefore = isAsciiAlnum(code);
      continue;
    }
    run += 1;
    if (JSON_STRUCTURE_CODES.has(code) && !letterBefore) structUnflanked = true;
    letterBefore = false;
  }
  closeRun();
  return { units, ascii, expensive, nonAscii };
}

/**
 * The multiplier this content earns, as a plain number between 1.0 and 2.5.
 *
 * Letters, digits, spaces and word-anchored punctuation cost the `chars/4` rate that [7]
 * measured as *already pessimistic* for prose, so they contribute nothing. Expensive
 * punctuation contributes `PUNCTUATION_EXCESS`, which is why the range has a floor of
 * exactly 1.0 and can never dip below the comparative estimate on ASCII content.
 */
export function pessimisticMultiplier(text: string): number {
  const { ascii, expensive } = shapeOf(text);
  // No ASCII to measure against (empty, or entirely non-ASCII): the letters-are-free rate
  // is the conservative default, and `NON_ASCII_UNITS` carries the non-ASCII cost in
  // `shapeOf`'s unit count rather than here.
  if (ascii === 0) return 1.0;
  return 1.0 + PUNCTUATION_EXCESS * (expensive / ascii);
}

export function tokenContentClass(text: string): TokenContentClass {
  const m = pessimisticMultiplier(text);
  if (m >= CLASS_THRESHOLDS.symbols) return 'symbols';
  if (m >= CLASS_THRESHOLDS.json) return 'json';
  if (m >= CLASS_THRESHOLDS.code) return 'code';
  return 'prose';
}

/**
 * Never less than the comparative estimate, never at the caller's discretion.
 *
 * The `max` is the safety property and it is load-bearing for every block that contains
 * expensive punctuation or a non-ASCII code point -- replace it with `min` and the JSON,
 * symbol and non-ASCII cases all fall back to the under-counting floor. For ASCII prose
 * it is an identity, which is the point: prose is already pessimistic and must not be
 * inflated.
 */
export function pessimisticBlockTokens(b: ContentBlock): number {
  const text = b.text ?? '';
  const { units, expensive } = shapeOf(text);
  const structured =
    PER_BLOCK_OVERHEAD_TOKENS + Math.ceil((units + PUNCTUATION_EXCESS * expensive) / BYTES_PER_TOKEN);
  return Math.max(estimateBlockTokens(b), structured);
}

export function pessimisticMessageTokens(m: Message): number {
  const blocks = m.content.reduce((n, b) => n + pessimisticBlockTokens(b), 0);
  return Math.max(estimateMessageTokens(m), blocks + PER_MESSAGE_OVERHEAD_TOKENS);
}

export function pessimisticStateTokens(state: ContextState): number {
  return Math.max(
    estimateTokens(state),
    state.messages.reduce((n, m) => n + pessimisticMessageTokens(m), 0),
  );
}

/**
 * The budget-path estimator, and the only way to obtain a branded count.
 *
 * core-types owns `partitionForLossy` as the sole constructor for a `LossyContext`, so
 * the same discipline applies here: the brand is only obtainable from this module, and
 * this module can only produce one by having done the pessimistic comparison.
 */
const PESSIMISTIC: unique symbol = Symbol('strata.PessimisticTokens');

export interface PessimisticTokens {
  readonly tokens: number;
  readonly [PESSIMISTIC]: 'pessimistic';
}

/**
 * Name a count that is already pessimistic.
 *
 * The escape hatch, for callers holding a number this module has already verified -- and
 * only those. It is a function rather than a bare cast precisely so that asserting the
 * claim is a greppable act; a silent `as` would defeat the brand.
 */
export const pessimisticCount = (tokens: number): PessimisticTokens =>
  Object.freeze({ tokens, [PESSIMISTIC]: 'pessimistic' } satisfies PessimisticTokens);

export function pessimisticLossyTokens(ctx: LossyContext): PessimisticTokens {
  const comparative = ctx.messages.reduce((n, m) => n + estimateMessageTokens(m), 0);
  const structured = ctx.messages.reduce((n, m) => n + pessimisticMessageTokens(m), 0);
  return pessimisticCount(Math.max(comparative, structured));
}

/* ------------------------------------------------------------------ *
 * Calibration
 *
 * The measured table in docs/risk-analysis.md §3.1 R1 is old and covers ASCII prose, code,
 * JSON and special characters. It does not cover this project's corpus and certainly
 * does not cover the provider serving it. Choosing multipliers from it and hoping is not
 * a plan; the plan is to sample the provider's own `usage.input_tokens` and report
 * observed / predicted, so the next multiplier choice is a measurement instead of an
 * inheritance.
 *
 * The sampler is injected. Nothing here opens a socket, and a calibration run is a pure
 * function of (blocks, observed counts), so the loop is testable offline and a bad
 * number shows up as a failing test rather than as an over-budget request.
 */

/**
 * The bands the pessimistic estimator is declared to hold.
 *
 * Two of them, because one number cannot be the honest bound for both kinds of content.
 *
 * `predictedOverComparative` is the [7] claim: for ASCII content the multiplier lives in
 * [1.0, 2.5] -- 1.0 is the floor and is not negotiable, since never under-count is the
 * entire reason this module exists, and 2.5 is `PUNCTUATION_EXCESS` taken to the limit,
 * which ASCII content reaches only when every character is expensive punctuation.
 *
 * `nonAsciiOverComparative` covers content containing code points outside ASCII, and its
 * ceiling is derived, not chosen. `NON_ASCII_UNITS` charges a code point 8 ASCII-equivalents
 * while the comparative estimator charges it `text.length / 4` -- and a BMP character like a
 * CJK ideograph is one UTF-16 unit, so the comparative estimate gives it a *quarter* of a
 * token. 8 / 1 is exactly 8x. An astral character is two UTF-16 units and so lands at 4x,
 * inside the bound. The wide ceiling is not over-reservation being tolerated: it is the
 * comparative estimate being wrong by that much on non-Latin script, and a band that
 * pretended otherwise could not be checked by anything.
 *
 * `observedOverPredicted` bounds how far the real tokenizer may land *below* a prediction --
 * over-reservation, which is the safe direction and not a defect. A ratio above 1.0 there is
 * precisely the defect, which is why it is reported as a named list of samples rather than a
 * boolean.
 */
export interface DeclaredBand {
  readonly predictedOverComparative: readonly [number, number];
  readonly nonAsciiOverComparative: readonly [number, number];
  readonly observedOverPredicted: readonly [number, number];
}

const band = (low: number, high: number): readonly [number, number] => Object.freeze([low, high]);

export const PESSIMISTIC_BAND: DeclaredBand = Object.freeze({
  predictedOverComparative: band(1, 2.5),
  nonAsciiOverComparative: band(1, 8),
  observedOverPredicted: band(0, 1),
});

export interface CalibrationSample {
  readonly contentClass: TokenContentClass;
  /** True when the block contains a code point outside ASCII; selects the wider band. */
  readonly nonAscii: boolean;
  /** What the comparative estimator would have said. */
  readonly comparative: number;
  /** What the pessimistic estimator said. */
  readonly predicted: number;
  /** The provider's authoritative count, from `usage.input_tokens`. */
  readonly observed: number;
  readonly observedOverPredicted: number;
  readonly predictedOverComparative: number;
}

export interface CalibrationReport {
  readonly samples: readonly CalibrationSample[];
  readonly contentClasses: readonly TokenContentClass[];
  readonly band: DeclaredBand;
  /** Every sample's observed / predicted, in the order it was observed. */
  readonly ratios: readonly number[];
  readonly meanRatio: number;
  readonly maxRatio: number;
  /** Samples where the provider charged *more* than predicted. Must be empty. */
  readonly underCounted: readonly CalibrationSample[];
  readonly withinBand: boolean;
  /** False when no sample was observed; a vacuous pass, so it is reported as one. */
  readonly observedAny: boolean;
}

const ratio = (num: number, den: number): number => (den === 0 ? 0 : num / den);

const inBand = (value: number, bound: readonly [number, number]): boolean =>
  value >= bound[0] && value <= bound[1];

/**
 * One block against both estimators. The block is supplied rather than synthesised from
 * its text so the sample scores the same object the pipeline would score, not a stand-in
 * that happens to have the same length.
 */
export function calibrationSample(b: ContentBlock, observed: number): CalibrationSample {
  const comparative = estimateBlockTokens(b);
  const predicted = pessimisticBlockTokens(b);
  const text = b.text ?? '';
  return Object.freeze({
    contentClass: tokenContentClass(text),
    nonAscii: NON_ASCII_PATTERN.test(text),
    comparative,
    predicted,
    observed,
    observedOverPredicted: ratio(observed, predicted),
    predictedOverComparative: ratio(predicted, comparative),
  });
}

export function calibrationReport(
  samples: readonly CalibrationSample[],
  declared: DeclaredBand = PESSIMISTIC_BAND,
): CalibrationReport {
  const ratios = samples.map((s) => s.observedOverPredicted);
  const underCounted = samples.filter(
    (s) => !inBand(s.observedOverPredicted, declared.observedOverPredicted),
  );
  const withinPredictedBand = (s: CalibrationSample): boolean =>
    inBand(
      s.predictedOverComparative,
      s.nonAscii ? declared.nonAsciiOverComparative : declared.predictedOverComparative,
    );
  return Object.freeze({
    samples,
    contentClasses: [...new Set(samples.map((s) => s.contentClass))],
    band: declared,
    ratios,
    meanRatio: ratios.length === 0 ? 0 : ratios.reduce((a, b) => a + b, 0) / ratios.length,
    maxRatio: ratios.length === 0 ? 0 : ratios.reduce((a, b) => Math.max(a, b), 0),
    underCounted,
    withinBand:
      samples.length > 0 &&
      samples.every(
        (s) => withinPredictedBand(s) && inBand(s.observedOverPredicted, declared.observedOverPredicted),
      ),
    observedAny: samples.length > 0,
  });
}

/** The provider's authoritative `usage.input_tokens` for one block's text. */
export type TokenUsageSampler = (text: string) => number;

export interface CalibratorOptions {
  readonly sampler: TokenUsageSampler;
  readonly band?: DeclaredBand;
}

/**
 * Accumulates calibration samples, so the reported ratio is a distribution and not a
 * single anecdote.
 *
 * No provider is constructed here and none can be: the only way in is an injected
 * sampler, which is what lets the loop run under `node:test` against a fixture of
 * recorded counts.
 */
export class TokenCalibrator {
  private readonly sampler: TokenUsageSampler;
  private readonly band: DeclaredBand;
  private readonly recorded: CalibrationSample[] = [];

  constructor(options: CalibratorOptions) {
    this.sampler = options.sampler;
    this.band = options.band ?? PESSIMISTIC_BAND;
  }

  observe(b: ContentBlock): CalibrationSample {
    const sample = calibrationSample(b, this.sampler(b.text ?? ''));
    this.recorded.push(sample);
    return sample;
  }

  get samples(): readonly CalibrationSample[] {
    return this.recorded;
  }

  report(): CalibrationReport {
    return calibrationReport(this.recorded, this.band);
  }
}