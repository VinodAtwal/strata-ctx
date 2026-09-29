/**
 * F1-2: grading primitives.
 *
 * Two graders, both deterministic, both arm-blind:
 *
 * 1. `gradeToolCalls` -- compares an expected tool-call sequence against an
 *    observed one and emits a normalized, machine-readable result. Not a
 *    boolean, because docs/evaluation.md §7 is explicit that binary grading is
 *    not enough: "Deterministic grading under-rewards partial progress. A task
 *    that made 70% of the right edits scores the same as one that made none."
 *    A boolean would throw that information away at exactly the point where the
 *    compression regression we are looking for lives.
 * 2. `gradeRubric` -- scores a rubric against an observed artifact, with the
 *    judge's per-criterion verdicts injected (see "The model call is not here").
 *
 * ## Neither grader can see which arm produced the observation
 *
 * docs/evaluation.md §3 (Methodology, "Blinding"): "Grading is deterministic
 * and arm-agnostic; graders never see which arm; ... the LLM-judge arm gets
 * blinded prompts."
 *
 * This is enforced structurally rather than by convention: neither
 * `ExpectedToolCall`, `ObservedToolCall`, `RubricArtifact` nor any options bag
 * in this module has a field that could hold an arm label, and
 * `renderRubricPrompt`'s only inputs are the rubric and the artifact. A grader
 * that cannot be told the arm cannot be biased by it, and this module has no
 * dependency on `./types.js` at all, so there is no `Arm` in scope to leak.
 *
 * ## The tool-call matching rule
 *
 * Chosen rule, in full. An expectation matches an observation when the tool
 * names are equal and the arguments agree; matching is then resolved by a
 * greedy lowest-index walk, and *order* is checked separately as a property of
 * the resulting index sequence.
 *
 * **(a) Argument agreement.** An expectation either omits `args` entirely
 * ("this criterion does not care about arguments" -- a deliberately weaker
 * criterion, and the result records the observed arguments either way) or
 * compares them under `argMatch`:
 *
 * - `'subset'` (default) -- every key the expectation declares must be present
 *   in the observation with an equal value. Undeclared observed keys are
 *   ignored, so a tool that adds a timestamp does not fail every call.
 * - `'exact'` -- the observed argument object must equal the declared one
 *   wholesale, key for key. This is the only mode that can catch a tool being
 *   called with a spurious extra argument.
 *
 * Values are compared by canonical JSON (keys sorted at every level), so
 * argument key order never affects a verdict and there is no way for
 * `{a:1,b:2}` and `{b:2,a:1}` to grade differently.
 *
 * **(b) Resolution.** For each expectation in declaration order, the matcher
 * takes the *lowest-numbered still-unclaimed* observation that matches it, and
 * claims it. An expectation with `count: 3` claims three, in ascending index
 * order. This greedy rule is what makes (c) a statement about the *run* rather
 * than about the matcher: the matched index sequence is the canonical one, and
 * there is no second assignment that would let a different order pass.
 *
 * **(c) Order, and where it matters.** Order is a property of the *ordered*
 * expectations only. The matched observation indices of every expectation
 * declared `order: 'ordered'` are flattened, in declaration order, and must be
 * strictly increasing. A `Read` before an `Edit` therefore grades differently
 * from the same two calls the other way round, and an expectation declared
 * `order: 'unordered'` is *removed from the sequence*, not merely permittted
 * to move within it: it asserts that the call happened, not when.
 *
 * The corollary, which is the part people get wrong: to assert an interleaving
 * position ("read, then grep, then edit"), all three calls must be declared
 * ordered. There is no separate "between" relation, because a partial one
 * cannot be made order-consistent; see the `TODO(WS-F)` below.
 *
 * The graded form of the order check is the length of the **longest
 * increasing subsequence** of that index sequence, divided by its length
 * (Schensted / patience sorting; Knuth, TAOCP vol. 3 §5.2.4). An expectation
 * that matched but does not lie on the longest increasing subsequence is
 * reported as `order_violation` and excluded from neither `recall` nor
 * `precision` -- it did happen, it happened in the wrong place, and a graded
 * score that conflated "wrong place" with "never happened" would hide exactly
 * the failure mode worth seeing.
 *
 * `TODO(WS-F, F1-2 follow-up)`: the per-expectation order vocabulary is
 * `ordered | unordered` and nothing else. A suite that needs "must happen
 * between X and Y" currently has to mark the neighbours ordered, which is
 * correct but indirect. Add a relation-valued variant only when a real suite
 * needs it -- a second order vocabulary shipped speculatively is a second
 * thing to get wrong.
 *
 * **(d) The verdict.** `strictness: 'exact'` requires relation `'exact'` and
 * a perfect order score. `strictness: 'at_least'` requires every expectation
 * matched and a perfect order score, and permits extra observations. The
 * graded `score` is `f1 * orderScore` and is the number the statistics layer
 * consumes; `passed` is the boolean gate and is derived from `strictness`.
 *
 * ## The model call is not here
 *
 * The rubric judge is deterministic by default: this module contains no model
 * call, no network call, no clock read and no global random state. A live
 * judge needs provider credentials, and F2-1..F2-3 are `exec: ext` and blocked
 * on exactly that. So what ships here is the part that *can* be right without
 * a model: the rubric shape, its validator, the blinded prompt renderer, the
 * validator for the injected verdicts, and the scoring arithmetic.
 *
 * The judge's verdict is **injected input**, and it is validated as untrusted
 * input, because that is what it is. A live judge that returns `score: 7`, or
 * a verdict for a criterion this rubric does not define, or two verdicts for
 * one criterion, must fail loudly here rather than be averaged into a number
 * that gets published. `validateJudgement` is the boundary, and it is
 * negative-tested for each of those.
 *
 * **This module must stay deterministic.** If a future change makes a graded
 * result depend on a clock, a locale, `Math.random`, or a model, G11
 * (byte-identical output on replay) stops being checkable and every committed
 * report becomes noise. That is a correctness regression, not a feature.
 *
 * ## No dependencies, by construction
 *
 * This package has no dependencies and no project reference
 * (AGENTS.md §12.1). Nothing here imports `@strata-ctx/core-types`, and
 * nothing here imports even this package's own `types.ts`: the measuring
 * apparatus must not be able to drift with the thing it measures, and the
 * cheapest way to guarantee that is for the grader to have nothing to drift
 * with.
 */

// ------------------------------------------------------------------- helpers

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Canonical JSON: keys sorted at every level, no whitespace.
 *
 * Used for two things that must agree -- comparing tool-call arguments, and
 * computing the provenance digest. If the digest were not canonical, the same
 * rubric re-serialized with its keys in a different order would hash
 * differently and a claims audit could not cite it.
 *
 * JSON's own undefined semantics are followed (`JSON.stringify`), and values
 * JSON cannot represent are **rejected** rather than silently coerced. A
 * `NaN` in a tool argument is a bug in the recorder, and `JSON.stringify` would
 * turn it into `null` and grade it as a legitimate null.
 */
/**
 * Names a value that failed validation without ever stringifying it through
 * `Object.prototype.toString`. Only the primitive types are named; anything
 * structural is described by shape, because the point of the message is to say
 * *which* argument was wrong, and "[object Object]" says nothing.
 */
const describeUnprintable = (value: unknown): string => {
  if (typeof value === 'number') return Number.isNaN(value) ? 'NaN' : `${value}`;
  if (typeof value === 'bigint') return 'a bigint';
  return `type ${typeof value}`;
};

const canonicalJson = (value: unknown, path: string): string => {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'boolean') return value ? 'true' : 'false';
  if (kind === 'number') {
    if (!Number.isFinite(value)) {
      // Checked as a `number` before printing. An unprintable value must not
      // reach the message via default toString, which would render "[object
      // Object]" and hide which argument was at fault.
      throw new RangeError(
        `grading: ${path} is not a finite number (${describeUnprintable(value)}), which has no JSON form`,
      );
    }
    // -0 and 0 must not grade differently.
    return JSON.stringify(value === 0 ? 0 : value);
  }
  if (kind === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const parts = value.map((item, i) =>
      item === undefined ? 'null' : canonicalJson(item, `${path}[${i}]`),
    );
    return `[${parts.join(',')}]`;
  }
  if (kind === 'object') {
    const record: Record<string, unknown> = isRecord(value) ? value : {};
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const inner = record[key];
      if (inner === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(inner, `${path}.${key}`)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new TypeError(`grading: ${path} is a ${kind}, which has no JSON form`);
};

/**
 * FNV-1a, 32-bit, then murmur3's finaliser -- the same pair `mock-arm.ts` uses
 * and for the same documented reason: raw FNV-1a has almost no avalanche in the
 * high bits for short strings, so a sequence number incremented one at a time
 * produces visibly structured digests, and a structured digest in a claims
 * audit invites a reader to look for structure that is not there.
 *
 * This is provenance, not security. It makes "these two committed reports were
 * graded from identical inputs" a checkable statement. It does not resist an
 * adversary and is not used to gate anything.
 */
const digest = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let mixed = hash >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x85ebca6b) >>> 0;
  mixed ^= mixed >>> 13;
  mixed = Math.imul(mixed, 0xc2b2ae35) >>> 0;
  mixed ^= mixed >>> 16;
  return (mixed >>> 0).toString(16).padStart(8, '0');
};

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

const typeName = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  switch (typeof value) {
    case 'string':
      return `the string "${value}"`;
    case 'number':
      return `the number ${value}`;
    case 'boolean':
      return `the boolean ${value}`;
    case 'undefined':
      return 'nothing';
    default:
      return typeof value;
  }
};

// ============================================================ tool-call grading

/** Whether an expectation's position is part of the graded order check. */
export type ToolCallOrder = 'ordered' | 'unordered';

/** How arguments are compared. See the module rule, (a). */
export type ToolCallArgMatch = 'subset' | 'exact';

/** How much slack an observation gets. See the module rule, (d). */
export type ToolCallStrictness = 'exact' | 'at_least';

/** One call the run was supposed to make. */
export interface ExpectedToolCall {
  /** Criterion id, named. Provenance is unciteable without names. */
  readonly id: string;
  readonly tool: string;
  /**
   * How many times this call was required. Default 1. A `count: 2` expectation
   * claims the two lowest-numbered matching observations, so a single call
   * where two were required is a partial match and a *third* is a duplicate.
   */
  readonly count: number;
  /** Default `'ordered'`. See the module rule, (c). */
  readonly order: ToolCallOrder;
  /**
   * Omit to assert the tool name only. See the module rule, (a) -- omitting
   * this is a weaker criterion, and `gradeToolCalls` records which expectations
   * were graded that weakly.
   */
  readonly args?: Readonly<Record<string, unknown>>;
  /** Default `'subset'`. Ignored when `args` is absent. */
  readonly argMatch: ToolCallArgMatch;
}

/** One call the run actually made. */
export interface ObservedToolCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** Why an expectation was not satisfied. */
export type ExpectedCallStatus = 'matched' | 'missing' | 'argument_mismatch' | 'order_violation';

/** Why an observation went unmatched. */
export type UnmatchedObservedReason = 'extra' | 'argument_mismatch' | 'duplicate';

export interface ExpectedCallDiff {
  readonly index: number;
  readonly id: string;
  readonly tool: string;
  readonly order: ToolCallOrder;
  /** Indices claimed for this expectation, ascending. Empty when unmatched. */
  readonly matchedObservedIndices: readonly number[];
  readonly status: ExpectedCallStatus;
  /** One sentence, stable, safe to put in a report. */
  readonly detail: string;
}

export interface UnmatchedObservedCall {
  readonly index: number;
  readonly tool: string;
  readonly reason: UnmatchedObservedReason;
  readonly detail: string;
}

/** The set relationship between what was required and what happened. */
export type ToolCallRelation =
  /** Every expectation matched, nothing extra. */
  | 'exact'
  /** Every expectation matched, extras present: observed is a superset. */
  | 'observed_superset'
  /** Something was missing, nothing extra: expected is a superset. */
  | 'expected_superset'
  /** Both. */
  | 'incomparable';

export interface ToolCallGradeResult {
  readonly caseId: string;
  readonly strictness: ToolCallStrictness;
  readonly relation: ToolCallRelation;
  readonly expected: readonly ExpectedCallDiff[];
  readonly unmatchedObserved: readonly UnmatchedObservedCall[];
  readonly expectedCount: number;
  readonly observedCount: number;
  readonly matchedCount: number;
  /** matched / expected. 1 when nothing was expected. */
  readonly recall: number;
  /** matched / observed. 1 when nothing was observed. */
  readonly precision: number;
  /**
   * Longest-increasing-subsequence length over the ordered expectations,
   * divided by their count. 1 when fewer than two are ordered.
   */
  readonly orderScore: number;
  /** Harmonic mean of recall and precision. Never NaN. */
  readonly f1: number;
  /** `f1 * orderScore`, the graded value the statistics layer consumes. */
  readonly score: number;
  /** The binary gate. Derived from `strictness`; see the module rule, (d). */
  readonly passed: boolean;
  /** Ids graded on the tool name alone, so a reader knows the weak spot. */
  readonly argumentBlindCriterionIds: readonly string[];
  readonly provenance: GradingProvenance;
}

/**
 * Provenance for a claims audit. Every graded result carries enough to be
 * cited later: what ran, what failed, and a digest of the exact input.
 */
export interface GradingProvenance {
  /** Grader identity and version, so a report says which code graded it. */
  readonly grader: string;
  /**
   * FNV-1a + murmur3 finaliser over the canonical form of the grading input.
   * Provenance, not security. See `digest`.
   */
  readonly inputDigest: string;
  /** Every criterion that ran, in declaration order. */
  readonly criteria: readonly string[];
  /** Every criterion that did not meet its bar, sorted. */
  readonly failed: readonly string[];
  /** `'deferred-to-F2'` marks the rubric judge, whose model call is not here. */
  readonly modelCall: 'none' | 'deferred-to-F2';
}

export interface ToolCallGradeOptions {
  /** Default `'exact'`. See the module rule, (d). */
  readonly strictness?: ToolCallStrictness;
}

/** Does the observed argument object satisfy this expectation? Module rule (a). */
const argumentsMatch = (
  expected: ExpectedToolCall,
  observed: ObservedToolCall,
): boolean => {
  const declared = expected.args;
  if (declared === undefined) return true;
  if (expected.argMatch === 'exact') {
    return canonicalJson(declared, 'expected.args') === canonicalJson(observed.args, 'observed.args');
  }
  const keys = Object.keys(declared).sort();
  // Projecting the observation onto the declared keys and comparing whole is
  // equivalent to "every declared key is present and equal", and cannot be
  // fooled by a declared key whose value is literally `undefined`.
  const projection: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(observed.args, key)) projection[key] = observed.args[key];
  }
  return canonicalJson(declared, 'expected.args') === canonicalJson(projection, 'observed.args');
};

const describeArgs = (call: { readonly args: Readonly<Record<string, unknown>> }): string =>
  Object.keys(call.args).length === 0 ? '()' : canonicalJson(call.args, 'args');

/**
 * Patience sorting with backtracking: the longest strictly increasing
 * subsequence of `values`, and which positions lie on it.
 *
 * `values` is already strictly increasing whenever the run's order was
 * correct, so the common case is length n; the search is O(n log n) and this is
 * a diagnostic path, not a hot loop. A position that does not lie on a longest
 * increasing subsequence is involved in an inversion by any reading of the
 * sequence, which is the only claim made about it.
 */
const longestIncreasingSubsequence = (
  values: readonly number[],
): { readonly length: number; readonly onLongest: readonly boolean[] } => {
  const n = values.length;
  const onLongest: boolean[] = new Array<boolean>(n).fill(false);
  if (n === 0) return { length: 0, onLongest };
  if (n === 1) {
    onLongest[0] = true;
    return { length: 1, onLongest };
  }
  // `tails[t]` is the position of the smallest possible tail of a strictly
  // increasing subsequence of length t + 1.
  const tails: number[] = [];
  const previous: number[] = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i += 1) {
    const value = values[i];
    if (value === undefined) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const tailIndex = tails[mid];
      const tail = tailIndex === undefined ? undefined : values[tailIndex];
      if (tail !== undefined && tail < value) lo = mid + 1;
      else hi = mid;
    }
    const before = lo > 0 ? tails[lo - 1] : undefined;
    previous[i] = before ?? -1;
    if (lo === tails.length) tails.push(i);
    else tails[lo] = i;
  }
  const cursor = tails.length - 1;
  let index = cursor >= 0 ? tails[cursor] : undefined;
  while (index !== undefined && index >= 0) {
    onLongest[index] = true;
    index = previous[index] ?? -1;
  }
  return { length: tails.length, onLongest };
};

/**
 * Grade an observed tool-call sequence against an expected one.
 *
 * Pure, deterministic, and total: no clock, no randomness, no I/O, and no
 * parameter that could carry an arm label. See the module doc for the rule.
 */
export function gradeToolCalls(
  caseId: string,
  expected: readonly ExpectedToolCall[],
  observed: readonly ObservedToolCall[],
  options: ToolCallGradeOptions = {},
): ToolCallGradeResult {
  const strictness = options.strictness ?? 'exact';
  const claimed = new Array<boolean>(observed.length).fill(false);

  let expectedCount = 0;
  for (const call of expected) {
    const count = call.count ?? 1;
    if (!Number.isInteger(count) || count < 1) {
      throw new RangeError(
        `grading: expectation "${call.id}" has count ${String(count)}; required count is an integer >= 1`,
      );
    }
    if (call.order !== 'ordered' && call.order !== 'unordered') {
      throw new RangeError(`grading: expectation "${call.id}" has an unknown order mode`);
    }
    expectedCount += count;
  }

  // Intermediate: which observations each expectation claimed, and nothing
  // else. The status is assigned only after the index sequence is final,
  // because whether a matched call is an `order_violation` depends on the other
  // ordered expectations, not on this one in isolation.
  const claims: { readonly diff: ExpectedCallDiff; readonly claimedIndices: readonly number[] }[] = [];
  const orderedPositions: number[] = [];
  const orderedSlotToDiff: { readonly diff: number; readonly slot: number }[] = [];
  let matchedCount = 0;

  for (const [index, call] of expected.entries()) {
    const count = call.count ?? 1;
    const matchedObservedIndices: number[] = [];
    for (let k = 0; k < count; k += 1) {
      let found: number | null = null;
      for (let i = 0; i < observed.length; i += 1) {
        if (claimed[i] === true) continue;
        const candidate = observed[i];
        if (candidate === undefined) continue;
        if (candidate.tool !== call.tool) continue;
        if (!argumentsMatch(call, candidate)) continue;
        found = i;
        break;
      }
      if (found === null) break;
      claimed[found] = true;
      matchedObservedIndices.push(found);
    }

    if (call.order === 'ordered') {
      for (const position of matchedObservedIndices) {
        orderedPositions.push(position);
        orderedSlotToDiff.push({ diff: index, slot: position });
      }
    }

    matchedCount += matchedObservedIndices.length;
    claims.push({
      diff: {
        index,
        id: call.id,
        tool: call.tool,
        order: call.order,
        matchedObservedIndices,
        status: 'matched',
        detail: '',
      },
      claimedIndices: matchedObservedIndices,
    });
  }

  // Classify each expectation that claimed nothing, and attribute order
  // violations, now that the index sequence is final.
  const { length: orderLength } = longestIncreasingSubsequence(orderedPositions);
  const orderScore = orderedPositions.length === 0 ? 1 : orderLength / orderedPositions.length;

  // Blame is assigned by participation in an inversion, not by membership in
  // the longest increasing subsequence. Both members of a swapped pair moved,
  // so reporting only the one a patience-sorting pass happened to leave off the
  // LIS would tell a suite author that the other call happened in order, which
  // is the one thing the observation does not support.
  const outOfOrderDiffs = new Set<number>();
  {
    const orderedDiffs: { readonly index: number; readonly positions: readonly number[] }[] = [];
    for (const [index, call] of expected.entries()) {
      if (call.order !== 'ordered') continue;
      const positions: number[] = [];
      for (const entry of orderedSlotToDiff) if (entry.diff === index) positions.push(entry.slot);
      orderedDiffs.push({ index, positions });
    }
    for (let a = 0; a < orderedDiffs.length; a += 1) {
      const earlier = orderedDiffs[a];
      if (earlier === undefined) continue;
      for (let b = a + 1; b < orderedDiffs.length; b += 1) {
        const later = orderedDiffs[b];
        if (later === undefined) continue;
        // `earlier` is required to precede `later`; an inversion marks both.
        const inverted = earlier.positions.some((p) => later.positions.some((q) => p > q));
        if (!inverted) continue;
        outOfOrderDiffs.add(earlier.index);
        outOfOrderDiffs.add(later.index);
      }
    }
  }

  const finalDiffs: ExpectedCallDiff[] = claims.map(({ diff }, index) => {
    const call = expected[index];
    if (call === undefined) return diff;
    const count = call.count ?? 1;
    if (diff.matchedObservedIndices.length === count) {
      if (outOfOrderDiffs.has(index)) {
        return {
          ...diff,
          status: 'order_violation',
          detail:
            `${call.tool} happened ${diff.matchedObservedIndices.length} time(s) at ` +
            `[${diff.matchedObservedIndices.join(', ')}], which is out of order for an ` +
            '`ordered` expectation',
        };
      }
      return {
        ...diff,
        status: 'matched',
        detail: `${call.tool} ${describeArgs({ args: call.args ?? {} })} matched at ` +
          `[${diff.matchedObservedIndices.join(', ')}]`,
      };
    }
    // Real observed indices, not positions in the filtered list: a detail
    // string that cites the wrong indices is worse than one that cites none.
    const sameToolIndices: number[] = [];
    for (const [observedIndex, candidate] of observed.entries()) {
      if (candidate.tool === call.tool && claimed[observedIndex] !== true) {
        sameToolIndices.push(observedIndex);
      }
    }
    if (sameToolIndices.length > 0) {
      return {
        ...diff,
        status: 'argument_mismatch',
        detail:
          `${diff.matchedObservedIndices.length}/${count} matched, and the unclaimed ` +
          `${call.tool} call(s) at [${sameToolIndices.join(', ')}] had different arguments`,
      };
    }
    return {
      ...diff,
      status: 'missing',
      detail: `${call.tool} was required ${count} time(s) and was observed ` +
        `${diff.matchedObservedIndices.length} time(s)`,
    };
  });

  const expectedToolNames = new Set(expected.map((call) => call.tool));
  const unmatchedObserved: UnmatchedObservedCall[] = [];
  for (const [index, call] of observed.entries()) {
    if (claimed[index] === true) continue;
    if (!expectedToolNames.has(call.tool)) {
      unmatchedObserved.push({
        index,
        tool: call.tool,
        reason: 'extra',
        detail: `${call.tool} ${describeArgs(call)} was not expected at all`,
      });
      continue;
    }
    const wanted = expected.filter((candidate) => candidate.tool === call.tool);
    if (wanted.some((candidate) => argumentsMatch(candidate, call))) {
      unmatchedObserved.push({
        index,
        tool: call.tool,
        reason: 'duplicate',
        detail: `${call.tool} ${describeArgs(call)} matches an expectation whose required count ` +
          'is already satisfied',
      });
      continue;
    }
    unmatchedObserved.push({
      index,
      tool: call.tool,
      reason: 'argument_mismatch',
      detail: `${call.tool} was expected but with different arguments: got ${describeArgs(call)}, ` +
        `expected ${wanted.map((candidate) => describeArgs({ args: candidate.args ?? {} })).join(' or ')}`,
    });
  }

  const allMatched = finalDiffs.every((diff) => diff.status === 'matched');
  const nothingExtra = unmatchedObserved.length === 0;
  const relation: ToolCallRelation =
    allMatched && nothingExtra
      ? 'exact'
      : allMatched
        ? 'observed_superset'
        : nothingExtra
          ? 'expected_superset'
          : 'incomparable';

  const recall = expectedCount === 0 ? 1 : matchedCount / expectedCount;
  const precision = observed.length === 0 ? 1 : matchedCount / observed.length;
  const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);
  const score = round4(f1 * orderScore);
  const passed = allMatched && orderScore === 1 && (strictness === 'exact' ? nothingExtra : true);

  const failed = finalDiffs
    .filter((diff) => diff.status !== 'matched')
    .map((diff) => diff.id)
    .sort();

  const inputDigest = digest(
    canonicalJson(
      { caseId, strictness, expected, observed },
      'toolCallInput',
    ),
  );

  return Object.freeze({
    caseId,
    strictness,
    relation,
    expected: Object.freeze(finalDiffs),
    unmatchedObserved: Object.freeze(unmatchedObserved),
    expectedCount,
    observedCount: observed.length,
    matchedCount,
    recall: round4(recall),
    precision: round4(precision),
    orderScore: round4(orderScore),
    f1: round4(f1),
    score,
    passed,
    argumentBlindCriterionIds: Object.freeze(
      expected.filter((call) => call.args === undefined).map((call) => call.id),
    ),
    provenance: Object.freeze({
      grader: 'toolcall-v1',
      inputDigest,
      criteria: Object.freeze(expected.map((call) => call.id)),
      failed: Object.freeze(failed),
      modelCall: 'none' as const,
    }),
  });
}

// ================================================================= rubric judge

export const RUBRIC_FORMAT_VERSION = 1;

/**
 * Marks the rubric judge's model call as out of scope for F1. Named so a
 * reviewer grepping for "where is the judge" finds the answer rather than
 * inferring it from an absence. F2-1..F2-3 supply it; they are `exec: ext` and
 * blocked on provider credentials.
 */
export const RUBRIC_MODEL_CALL_DEFERRED_TO = 'F2';

export type RubricIssueCode =
  | 'missing'
  | 'type'
  | 'enum'
  | 'range'
  | 'format'
  | 'unknown_key'
  | 'not_object'
  | 'duplicate'
  | 'rule'
  | 'version';

export interface RubricIssue {
  readonly path: string;
  readonly code: RubricIssueCode;
  readonly message: string;
}

export type RubricParseResult =
  | { readonly ok: true; readonly rubric: Rubric }
  | { readonly ok: false; readonly issues: readonly RubricIssue[] };

export class RubricError extends Error {
  readonly issues: readonly RubricIssue[];

  constructor(issues: readonly RubricIssue[]) {
    super(
      `rubric: ${issues
        .map((issue) => (issue.path === '' ? issue.message : `${issue.path} ${issue.message}`))
        .join('; ')}`,
    );
    this.name = 'RubricError';
    this.issues = issues;
  }
}

export interface RubricCriterion {
  readonly id: string;
  /** The text handed to the judge. See `renderRubricPrompt`. */
  readonly prompt: string;
  /** Relative importance. Finite and >= 0. The weights must sum above 0. */
  readonly weight: number;
  /**
   * A required criterion is a gate; an optional one only moves the score.
   *
   * A rubric with no required criterion is rejected: it would produce a number
   * and no verdict, and docs/evaluation.md §4 requires underpowered and
   * unsupported results to be reported as inconclusive rather than dressed up
   * as a finding.
   */
  readonly required: boolean;
  /** Score at or above which this criterion is met, in [0, 1]. */
  readonly passThreshold: number;
}

export interface Rubric {
  readonly formatVersion: number;
  readonly id: string;
  readonly name: string;
  readonly criteria: readonly RubricCriterion[];
}

const RUBRIC_KEYS = ['rubricFormatVersion', 'id', 'name', 'criteria'] as const;
const CRITERION_KEYS = ['id', 'prompt', 'weight', 'required', 'passThreshold'] as const;

const rejectUnknownKeys = (
  record: Record<string, unknown>,
  known: readonly string[],
  prefix: string,
  noun: string,
  add: (path: string, code: RubricIssueCode, message: string) => void,
): void => {
  for (const key of Object.keys(record).sort()) {
    if (known.includes(key)) continue;
    const path = prefix === '' ? key : `${prefix}.${key}`;
    add(path, 'unknown_key', `is not a ${noun} key`);
  }
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
};

const resolveRubric = (input: unknown): RubricParseResult => {
  const issues: RubricIssue[] = [];
  const add = (path: string, code: RubricIssueCode, message: string): void => {
    issues.push({ path, code, message });
  };

  if (!isRecord(input)) {
    add('', 'not_object', `must be a JSON object, got ${typeName(input)}`);
    return { ok: false, issues: Object.freeze(issues) };
  }
  rejectUnknownKeys(input, RUBRIC_KEYS, '', 'rubric', add);

  // Version first and on its own, so a stale rubric says "your harness is
  // wrong" instead of listing a hundred consequences of misreading it.
  const version = input.rubricFormatVersion;
  if (version === undefined) {
    add('rubricFormatVersion', 'missing', 'is required');
  } else if (typeof version !== 'number') {
    add('rubricFormatVersion', 'type', `must be a number, got ${typeName(version)}`);
  } else if (version !== RUBRIC_FORMAT_VERSION) {
    add(
      'rubricFormatVersion',
      'version',
      `${version} cannot be read by this harness (it reads version ${RUBRIC_FORMAT_VERSION})`,
    );
  }

  const requiredText = (record: Record<string, unknown>, key: string, noun: string): string => {
    const value = record[key];
    if (value === undefined) {
      add(key, 'missing', 'is required');
      return '';
    }
    if (typeof value !== 'string') {
      add(key, 'type', `must be a string, got ${typeName(value)}`);
      return '';
    }
    if (value.trim() === '') {
      add(key, 'format', `must not be empty (a ${noun} cannot be graded against nothing)`);
      return '';
    }
    return value;
  };

  const id = requiredText(input, 'id', 'rubric id');
  const name = requiredText(input, 'name', 'rubric name');

  const criteria: RubricCriterion[] = [];
  const criteriaRaw = input.criteria;
  if (criteriaRaw === undefined) {
    add('criteria', 'missing', 'is required');
  } else if (!Array.isArray(criteriaRaw)) {
    add('criteria', 'type', `must be an array, got ${typeName(criteriaRaw)}`);
  } else if (criteriaRaw.length === 0) {
    add('criteria', 'format', 'must contain at least one criterion');
  } else {
    criteriaRaw.forEach((raw, index) => {
      const path = `criteria[${index}]`;
      if (!isRecord(raw)) {
        add(path, 'not_object', `must be an object, got ${typeName(raw)}`);
        return;
      }
      rejectUnknownKeys(raw, CRITERION_KEYS, path, 'criterion', add);
      const criterionId = requiredText(raw, 'id', 'criterion id');
      const prompt = requiredText(raw, 'prompt', 'criterion prompt');

      let weight = 0;
      const weightRaw = raw.weight;
      if (weightRaw === undefined) {
        add(`${path}.weight`, 'missing', 'is required (use 0 to drop a criterion from the score)');
      } else if (typeof weightRaw !== 'number') {
        add(`${path}.weight`, 'type', `must be a number, got ${typeName(weightRaw)}`);
      } else if (!Number.isFinite(weightRaw) || weightRaw < 0) {
        add(`${path}.weight`, 'range', `must be a finite number >= 0, got ${String(weightRaw)}`);
      } else {
        weight = weightRaw;
      }

      let required = false;
      const requiredRaw = raw.required;
      if (requiredRaw === undefined) {
        add(`${path}.required`, 'missing', 'is required: every criterion must say whether it gates');
      } else if (typeof requiredRaw !== 'boolean') {
        add(`${path}.required`, 'type', `must be a boolean, got ${typeName(requiredRaw)}`);
      } else {
        required = requiredRaw;
      }

      let passThreshold = 1;
      const thresholdRaw = raw.passThreshold;
      if (thresholdRaw === undefined) {
        add(`${path}.passThreshold`, 'missing', 'is required');
      } else if (typeof thresholdRaw !== 'number') {
        add(`${path}.passThreshold`, 'type', `must be a number, got ${typeName(thresholdRaw)}`);
      } else if (!Number.isFinite(thresholdRaw) || thresholdRaw < 0 || thresholdRaw > 1) {
        add(
          `${path}.passThreshold`,
          'range',
          `must be a finite number in [0, 1], got ${String(thresholdRaw)}`,
        );
      } else {
        passThreshold = thresholdRaw;
      }

      if (criterionId !== '') {
        const previous = criteria.findIndex((candidate) => candidate.id === criterionId);
        if (previous >= 0) {
          add(`${path}.id`, 'duplicate', `reuses id "${criterionId}" (already used at criteria[${previous}])`);
        }
      }

      criteria.push({ id: criterionId, prompt, weight, required, passThreshold });
    });

    const weightSum = criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
    if (criteria.length > 0 && !(weightSum > 0)) {
      add(
        'criteria',
        'rule',
        `weights sum to ${String(weightSum)}; a rubric whose every criterion has weight 0 has no score`,
      );
    }
    if (criteria.length > 0 && !criteria.some((criterion) => criterion.required)) {
      add(
        'criteria',
        'rule',
        'has no required criterion, so it produces a number and no verdict; a rubric that cannot ' +
          'fail cannot protect the claim it is cited for',
      );
    }
  }

  if (issues.length > 0) return { ok: false, issues: Object.freeze(issues) };
  return {
    ok: true,
    rubric: deepFreeze<Rubric>({
      formatVersion: RUBRIC_FORMAT_VERSION,
      id,
      name,
      criteria,
    }),
  };
};

/** Every problem in `input`, in a stable order. Empty means valid. */
export function validateRubric(input: unknown): readonly RubricIssue[] {
  const result = resolveRubric(input);
  return result.ok ? [] : result.issues;
}

/** Non-throwing validation, for callers that treat a bad rubric as a state. */
export function safeParseRubric(input: unknown): RubricParseResult {
  return resolveRubric(input);
}

/** Throws `RubricError` with every issue; returns a frozen rubric otherwise. */
export function parseRubric(input: unknown): Rubric {
  const result = resolveRubric(input);
  if (!result.ok) throw new RubricError(result.issues);
  return result.rubric;
}

/**
 * The artifact a rubric is graded against.
 *
 * Deliberately has no `arm` field, and neither does anything else in this
 * module. That is how blinding is enforced here: docs/evaluation.md §3 requires
 * the LLM-judge arm to get blinded prompts, and a type that cannot hold the
 * arm label is a stronger guarantee than a prompt template that asks nicely.
 */
export interface RubricArtifact {
  readonly caseId: string;
  /** What the judge reads: the diff, the patch, the response. */
  readonly text: string;
  /** Structured evidence a judge may cite, e.g. file paths or test names. */
  readonly evidence: readonly string[];
}

/**
 * The blinded judge prompt.
 *
 * A pure function of `(rubric, artifact)`. No timestamp, no run id, no arm
 * label, no iteration counter -- a prompt that varied between two otherwise
 * identical artifacts would make an LLM judge a non-reproducible instrument
 * and no amount of downstream statistics would repair that.
 */
export function renderRubricPrompt(rubric: Rubric, artifact: RubricArtifact): string {
  const lines: string[] = [];
  lines.push(`# rubric ${rubric.id} — ${rubric.name}`);
  lines.push('');
  lines.push('Score each criterion independently on the scale 0.0 to 1.0, then return only');
  lines.push('JSON of the form {"verdicts":[{"criterionId":"...","score":0.0-1.0}]}.');
  lines.push('');
  lines.push('## criteria');
  for (const criterion of rubric.criteria) {
    lines.push(`- ${criterion.id} (${criterion.required ? 'required' : 'optional'}) — ${criterion.prompt}`);
  }
  lines.push('');
  lines.push(`## artifact (case ${artifact.caseId})`);
  lines.push('');
  lines.push(artifact.text);
  if (artifact.evidence.length > 0) {
    lines.push('');
    lines.push('## evidence');
    for (const item of artifact.evidence) lines.push(`- ${item}`);
  }
  return `${lines.join('\n')}\n`;
}

/** One criterion's verdict, as returned by the judge. Injected input. */
export interface RubricCriterionVerdict {
  readonly criterionId: string;
  /** Must be a finite number in [0, 1]. A judge returning 7 fails here. */
  readonly score: number;
  /** Carried for the claims audit. Never scored. */
  readonly rationale: string | undefined;
}

/** A judge's full answer. Injected input, and validated as untrusted input. */
export interface RubricJudgement {
  readonly judgeId: string;
  /** Optional, but must equal `rubric.id` when present. */
  readonly rubricId: string | undefined;
  readonly verdicts: readonly RubricCriterionVerdict[];
}

export type JudgementIssueCode = 'missing' | 'type' | 'range' | 'unknown_criterion' | 'duplicate' | 'mismatch' | 'not_object';

export interface JudgementIssue {
  readonly path: string;
  readonly code: JudgementIssueCode;
  readonly message: string;
}

export class JudgementError extends Error {
  readonly issues: readonly JudgementIssue[];

  constructor(issues: readonly JudgementIssue[]) {
    super(
      `rubric judgement: ${issues
        .map((issue) => (issue.path === '' ? issue.message : `${issue.path} ${issue.message}`))
        .join('; ')}`,
    );
    this.name = 'JudgementError';
    this.issues = issues;
  }
}

/**
 * Validate an injected judgement against the rubric it claims to answer.
 *
 * The live judge is the least trustworthy component in the pipeline and the one
 * whose failure modes are quietest, so every way it can be wrong is a loud
 * failure here rather than a plausible number in a report:
 *
 * - a verdict for a criterion the rubric does not define (the judge was asked
 *   a different question, or hallucinated one);
 * - two verdicts for one criterion, where averaging them would invent a score
 *   nobody produced;
 * - a score outside [0, 1], or `NaN`, which would otherwise propagate into
 *   `score` and then into every statistic computed from it;
 * - a `rubricId` that does not match, which is the signature of verdicts from
 *   two different runs being concatenated.
 */
export function validateJudgement(
  rubric: Rubric,
  judgement: RubricJudgement,
): readonly JudgementIssue[] {
  const issues: JudgementIssue[] = [];
  const add = (path: string, code: JudgementIssueCode, message: string): void => {
    issues.push({ path, code, message });
  };

  if (typeof judgement.judgeId !== 'string' || judgement.judgeId.trim() === '') {
    add('judgeId', 'missing', 'is required; a verdict with no judge cannot be audited');
  }
  if (judgement.rubricId !== undefined && judgement.rubricId !== rubric.id) {
    add(
      'rubricId',
      'mismatch',
      `is "${judgement.rubricId}" but the rubric being graded is "${rubric.id}"; verdicts from two ` +
        'different runs have been concatenated',
    );
  }
  if (!Array.isArray(judgement.verdicts)) {
    add('verdicts', 'type', 'must be an array');
    return Object.freeze(issues);
  }

  const known = new Set(rubric.criteria.map((criterion) => criterion.id));
  const seen = new Set<string>();
  judgement.verdicts.forEach((verdict, index) => {
    const path = `verdicts[${index}]`;
    if (!isRecord(verdict)) {
      add(path, 'not_object', `must be an object, got ${typeName(verdict)}`);
      return;
    }
    const criterionId = verdict.criterionId;
    if (typeof criterionId !== 'string' || criterionId === '') {
      add(`${path}.criterionId`, 'missing', 'is required');
      return;
    }
    if (!known.has(criterionId)) {
      add(
        `${path}.criterionId`,
        'unknown_criterion',
        `is "${criterionId}", which this rubric does not define`,
      );
      return;
    }
    if (seen.has(criterionId)) {
      add(`${path}.criterionId`, 'duplicate', `gives two verdicts for "${criterionId}"; averaging them would invent a score`);
      return;
    }
    seen.add(criterionId);
    const score = verdict.score;
    if (typeof score !== 'number') {
      add(`${path}.score`, 'type', `must be a number, got ${typeName(score)}`);
    } else if (!Number.isFinite(score)) {
      add(`${path}.score`, 'range', `must be a finite number, got ${String(score)}`);
    } else if (score < 0 || score > 1) {
      add(`${path}.score`, 'range', `must be in [0, 1], got ${String(score)}`);
    }
    if (verdict.rationale !== undefined && typeof verdict.rationale !== 'string') {
      add(`${path}.rationale`, 'type', `must be a string, got ${typeName(verdict.rationale)}`);
    }
  });

  return Object.freeze(issues);
}

/**
 * What happens when the judge returned no verdict for a criterion.
 *
 * `'inconclusive'` (the default) treats a missing verdict as a broken judge
 * call, which is what it is -- the artifact did not get to be judged. That is
 * the only option that cannot turn a harness bug into a published result.
 *
 * `'zero'` scores it zero and is available for a suite that would rather fail
 * closed. It must be opted into explicitly, because "the judge crashed" and
 * "the artifact is terrible" produce the same number under it, and only one of
 * those is a finding about the artifact.
 */
export type MissingVerdictPolicy = 'inconclusive' | 'zero';

export type GradeStatus = 'pass' | 'fail' | 'inconclusive';

export interface RubricCriterionGrade {
  readonly id: string;
  readonly required: boolean;
  readonly weight: number;
  readonly passThreshold: number;
  /** null when the judge returned no verdict. */
  readonly score: number | null;
  /** weight / total weight. Sums to 1 across all criteria. */
  readonly normalisedWeight: number;
  /** score * normalisedWeight, 0 when unscored. */
  readonly contribution: number;
  readonly rationale: string | undefined;
}

export interface RubricGradeResult {
  readonly caseId: string;
  readonly rubricId: string;
  readonly judgeId: string;
  readonly status: GradeStatus;
  /** Weighted mean of criterion scores in [0, 1]. null when nothing was scored. */
  readonly score: number | null;
  /** Every required criterion met its threshold. Requires status `pass`. */
  readonly passed: boolean;
  readonly criteria: readonly RubricCriterionGrade[];
  readonly criterionIds: readonly string[];
  /**
   * Required criteria below their own threshold. This is the gate: an optional
   * criterion that scores badly does not appear here.
   */
  readonly failedCriterionIds: readonly string[];
  /**
   * Every criterion below its own threshold, required or not.
   *
   * Kept separate from `failedCriterionIds` on purpose, because "did not fail
   * the run" and "met its own bar" are different claims and merging them hides
   * the second. docs/evaluation.md §7 makes the same demand of the redaction
   * suite -- report the false-positive rate, not just the recall -- and a
   * claims audit needs the same thing: an optional criterion that scored 0 on
   * a 0.5 threshold is a finding about the artifact even though the run passed.
   */
  readonly belowThresholdCriterionIds: readonly string[];
  readonly missingCriterionIds: readonly string[];
  readonly modelCallDeferredTo: string;
  readonly provenance: GradingProvenance;
}

export interface RubricGradeOptions {
  /** Default `'inconclusive'`. See `MissingVerdictPolicy`. */
  readonly missingVerdict?: MissingVerdictPolicy;
}

/**
 * Score a rubric against an artifact, from an injected judgement.
 *
 * The scoring arithmetic, in full:
 *
 * - `normalisedWeight = weight / sum(weights)`. The validator guarantees the
 *   weights sum above zero, so this is never a division by zero.
 * - `contribution = (score ?? 0) * normalisedWeight`, so `score` is the
 *   weighted mean of criterion scores in [0, 1] and sums to 1 in weight.
 * - `passed` is `true` only when every **required** criterion was scored and
 *   met its threshold. Optional criteria move the score and cannot fail a run.
 * - `status` is `inconclusive` when any required criterion went unscored under
 *   the default policy, `pass` when `passed`, and `fail` otherwise.
 *
 * A threshold affects the verdict and never the score. Making the score
 * depend on the threshold too would mean a suite author could raise a graded
 * number by moving a gate, which is margin shopping wearing a different hat
 * (docs/evaluation.md §4).
 */
export function gradeRubric(
  rubric: Rubric,
  artifact: RubricArtifact,
  judgement: RubricJudgement,
  options: RubricGradeOptions = {},
): RubricGradeResult {
  if (typeof artifact.caseId !== 'string' || artifact.caseId.trim() === '') {
    throw new TypeError('grading: artifact.caseId is required; a grade with no case id cannot be audited');
  }
  const issues = validateJudgement(rubric, judgement);
  if (issues.length > 0) throw new JudgementError(issues);

  const missingPolicy = options.missingVerdict ?? 'inconclusive';
  const byId = new Map<string, RubricCriterionVerdict>();
  for (const verdict of judgement.verdicts) byId.set(verdict.criterionId, verdict);

  const weightSum = rubric.criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  let earned = 0;
  let scoredSomething = false;
  const missingCriterionIds: string[] = [];
  const failedCriterionIds: string[] = [];
  const belowThresholdCriterionIds: string[] = [];

  const criteria: RubricCriterionGrade[] = rubric.criteria.map((criterion) => {
    const verdict = byId.get(criterion.id);
    const normalisedWeight = criterion.weight / weightSum;
    if (verdict === undefined) {
      missingCriterionIds.push(criterion.id);
      return {
        id: criterion.id,
        required: criterion.required,
        weight: criterion.weight,
        passThreshold: criterion.passThreshold,
        score: null,
        normalisedWeight: round4(normalisedWeight),
        contribution: 0,
        rationale: undefined,
      };
    }
    scoredSomething = true;
    const contribution = verdict.score * normalisedWeight;
    earned += contribution;
    const met = verdict.score >= criterion.passThreshold;
    if (!met) belowThresholdCriterionIds.push(criterion.id);
    if (criterion.required && !met) failedCriterionIds.push(criterion.id);
    return {
      id: criterion.id,
      required: criterion.required,
      weight: criterion.weight,
      passThreshold: criterion.passThreshold,
      score: verdict.score,
      normalisedWeight: round4(normalisedWeight),
      contribution: round4(contribution),
      rationale: verdict.rationale,
    };
  });

  const requiredUnscored = rubric.criteria.some(
    (criterion) => criterion.required && missingCriterionIds.includes(criterion.id),
  );
  const requiredFailed = failedCriterionIds.length > 0;
  const passed = !requiredFailed && !requiredUnscored;

  let status: GradeStatus;
  if (requiredUnscored && missingPolicy === 'inconclusive') status = 'inconclusive';
  else if (passed) status = 'pass';
  else status = 'fail';

  const score = scoredSomething ? round4(earned) : null;

  const inputDigest = digest(
    canonicalJson(
      { rubric, artifact, judgeId: judgement.judgeId, verdicts: judgement.verdicts },
      'rubricInput',
    ),
  );

  return Object.freeze({
    caseId: artifact.caseId,
    rubricId: rubric.id,
    judgeId: judgement.judgeId,
    status,
    score,
    passed,
    criteria: Object.freeze(criteria),
    criterionIds: Object.freeze(rubric.criteria.map((criterion) => criterion.id)),
    failedCriterionIds: Object.freeze([...failedCriterionIds].sort()),
    belowThresholdCriterionIds: Object.freeze([...belowThresholdCriterionIds].sort()),
    missingCriterionIds: Object.freeze([...missingCriterionIds].sort()),
    modelCallDeferredTo: RUBRIC_MODEL_CALL_DEFERRED_TO,
    provenance: Object.freeze({
      grader: 'rubric-v1',
      inputDigest,
      criteria: Object.freeze(rubric.criteria.map((criterion) => criterion.id)),
      // Provenance records everything that missed its own bar, gates and
      // non-gates alike, plus anything the judge never answered. A claims
      // audit citing "the run passed" must be able to see what did not.
      failed: Object.freeze([...belowThresholdCriterionIds, ...missingCriterionIds].sort()),
      modelCall: 'deferred-to-F2' as const,
    }),
  });
}
