import type { Arm, ArmInvocation, ArmObservation, EvalCase, SyncArmRunner } from './types.js';

/**
 * F1-1: the deterministic mock arm.
 *
 * Every arm in an offline run is this function. It makes no network call, reads
 * no clock, and takes no global random state: given the same fixture, the same
 * seed and the same arm it returns the same observation, byte for byte, on
 * every machine and every run. That is what makes the offline half of stream F
 * testable at all -- G11 (determinism, byte-identical output on replay) is a
 * product requirement, and a harness that cannot reproduce its own report cannot
 * check it.
 *
 * ## What the mock simulates, and why
 *
 * The harness needs two kinds of arm to be distinguishable, or it cannot tell a
 * working detector from a broken one:
 *
 * 1. An arm that **drops** declared constraints on the way through compaction.
 *    Its output therefore omits the constraint text and emits the constraint's
 *    prohibited effect instead, so a failure is visible in the observation
 *    rather than inferred. This is the arm that makes a constraint-retention
 *    failure *observable* -- without it, every case passes in every
 *    configuration and a green report means nothing.
 * 2. An arm that **preserves** every declared constraint. This is what a
 *    correctly-pinned configuration has to look like, so the same detector run
 *    against it reports a pass.
 *
 * Which arms drop is configuration (`degradingArms`), not a constant. The
 * default follows docs/evaluation.md §2, which is the labelling every real
 * claim is written against: `control+` is the negative control (naive
 * compaction, no triage, no pinning) and `control` is the strong
 * uncompressed baseline the treatment must not lose to.
 *
 * The default degrading the *strong* baseline would be the wrong way round —
 * it would make a retention failure look like a win and a passing treatment
 * look like the anomaly. F1-5 carries the G1 claim and may override
 * `degradingArms`, but the default has to already match the paper.
 */

/** Arms that drop constraints by default. See the note above. */
export const DEFAULT_DEGRADING_ARMS: readonly Arm[] = Object.freeze(['control+']);

/**
 * FNV-1a, 32-bit. Small, dependency-free, and total.
 *
 * `Math.random` is banned here on purpose: it is process-global, so two
 * interleaved arms would consume from the same stream and the order of runs
 * would change the answers. Deriving every pseudo-random decision from
 * `(seed, strings)` makes each decision a pure function of its own inputs, so
 * interleaving order cannot leak into results.
 */
const fnv1a = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

/**
 * murmur3's 32-bit finaliser, and not optional.
 *
 * Raw FNV-1a has almost no avalanche in the *high* bits for short strings that
 * differ only at the end: `c1`, `c2`, ... `c19` differ in one byte, so their
 * hashes differ by a small delta, and a uniform draw over the whole 32-bit range
 * would then hand out ten consecutive constraints to the same bucket. That was
 * not theoretical -- it made a seeded partial drop come out as one contiguous
 * block, which is exactly the sort of artefact a seeded choice must not have.
 * The finaliser mixes every input bit into every output bit.
 */
const fmix32 = (hash: number): number => {
  let h = hash >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
};

/**
 * A deterministic value in [0, 1) for one named decision.
 *
 * `key` must include everything the decision depends on, including the arm and
 * the case, or two arms would agree on a decision they should have made
 * independently.
 */
export const unitValue = (seed: number, key: string): number =>
  fmix32(fnv1a(`${seed >>> 0}:${key}`)) / 0x1_0000_0000;

export interface MockArmOptions {
  /**
   * Arms that drop declared constraints. Default `['control']`.
   *
   * The set is configuration because it *is* the claim: an eval result that does
   * not name which configuration was degraded is not a result.
   */
  readonly degradingArms?: readonly Arm[];
  /**
   * Fraction of a degrading arm's constraints to drop, in [0, 1]. Default 1:
   * every declared constraint goes, so the failure is unmissable in a skeleton
   * run. F1-5 lowers it to model a partial-retention world.
   */
  readonly dropRate?: number;
  /**
   * Emit the dropped constraint's first forbidden marker in the response, which
   * is what makes a *violation* observable rather than only a *drop*. Default
   * true.
   */
  readonly emitViolations?: boolean;
  /** Base synthetic input cost, in tokens. Default 900. */
  readonly baseInputTokens?: number;
  /** Synthetic tokens per unit of prompt text. Default 1. */
  readonly inputTokensPerChar?: number;
  /** Synthetic output cost, in tokens. Default 120. */
  readonly baseOutputTokens?: number;
  /** Synthetic latency floor, in ms. Default 40. */
  readonly baseLatencyMs?: number;
  /** Synthetic latency per unit of prompt text, in ms. Default 0.05. */
  readonly latencyMsPerChar?: number;
}

const DEFAULTS = {
  degradingArms: DEFAULT_DEGRADING_ARMS,
  dropRate: 1,
  emitViolations: true,
  baseInputTokens: 900,
  inputTokensPerChar: 1,
  baseOutputTokens: 120,
  baseLatencyMs: 40,
  latencyMsPerChar: 0.05,
} as const;

interface ResolvedMockOptions {
  readonly degradingArms: ReadonlySet<Arm>;
  readonly dropRate: number;
  readonly emitViolations: boolean;
  readonly baseInputTokens: number;
  readonly inputTokensPerChar: number;
  readonly baseOutputTokens: number;
  readonly baseLatencyMs: number;
  readonly latencyMsPerChar: number;
}

/**
 * Options are resolved (and range-checked) once, at construction, so a bad
 * `dropRate` is a loud failure at wiring time instead of a subtly wrong report
 * three suites later. Defaults are frozen and never shared mutable state.
 */
const resolveOptions = (options: MockArmOptions): ResolvedMockOptions => {
  const dropRate = options.dropRate ?? DEFAULTS.dropRate;
  if (!(Number.isFinite(dropRate) && dropRate >= 0 && dropRate <= 1)) {
    throw new RangeError(`mock arm: dropRate must be a number in [0, 1], got ${String(dropRate)}`);
  }
  const degrading = options.degradingArms ?? DEFAULTS.degradingArms;
  return Object.freeze({
    degradingArms: new Set(degrading),
    dropRate,
    emitViolations: options.emitViolations ?? DEFAULTS.emitViolations,
    baseInputTokens: options.baseInputTokens ?? DEFAULTS.baseInputTokens,
    inputTokensPerChar: options.inputTokensPerChar ?? DEFAULTS.inputTokensPerChar,
    baseOutputTokens: options.baseOutputTokens ?? DEFAULTS.baseOutputTokens,
    baseLatencyMs: options.baseLatencyMs ?? DEFAULTS.baseLatencyMs,
    latencyMsPerChar: options.latencyMsPerChar ?? DEFAULTS.latencyMsPerChar,
  });
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * The degradation decision for one (arm, case, constraint).
 *
 * Split out and exported so a test -- or a future corpus generator -- can ask
 * the same question the arm asks and get the same answer, instead of inferring
 * the rule from output text.
 */
export function dropsConstraint(
  invocation: Pick<ArmInvocation, 'harnessSeed' | 'arm' | 'case'>,
  constraintId: string,
  options: MockArmOptions = {},
): boolean {
  return dropsWithResolved(invocation, constraintId, resolveOptions(options));
}

/** The same question, asked against options that were already resolved. */
const dropsWithResolved = (
  invocation: Pick<ArmInvocation, 'harnessSeed' | 'arm' | 'case'>,
  constraintId: string,
  resolved: ResolvedMockOptions,
): boolean => {
  if (!resolved.degradingArms.has(invocation.arm)) return false;
  if (resolved.dropRate === 0) return false;
  if (resolved.dropRate === 1) return true;
  return (
    unitValue(invocation.harnessSeed, `${invocation.case.id}|${invocation.arm}|${constraintId}`) <
    resolved.dropRate
  );
};

const buildResponse = (
  evalCase: EvalCase,
  invocation: ArmInvocation,
  opts: ResolvedMockOptions,
): { response: string; retained: string[]; dropped: string[]; violated: string[] } => {
  const retained: string[] = [];
  const dropped: string[] = [];
  const violated: string[] = [];
  const parts: string[] = [`[arm=${invocation.arm} case=${evalCase.id} pos=${invocation.position}]`];

  for (const constraint of evalCase.constraints) {
    const droppedHere = dropsWithResolved(invocation, constraint.id, opts);
    if (!droppedHere) {
      retained.push(constraint.id);
      parts.push(`kept:${constraint.id}`);
      continue;
    }
    dropped.push(constraint.id);
    // A dropped constraint contributes nothing of its own text to the output.
    // If it has a forbidden effect and violations are enabled, the arm performs
    // that effect instead -- the deterministic grading signal (find the
    // prohibited effect in the tool call, never judge the prose).
    const marker = opts.emitViolations ? constraint.forbidden[0] : undefined;
    if (marker !== undefined) {
      violated.push(constraint.id);
      parts.push(`did:${marker}`);
    } else {
      parts.push(`lost:${constraint.id}`);
    }
  }

  return { response: parts.join(' '), retained, dropped, violated };
};

/** A runner that answers every invocation from the mock, with no I/O. */
export function createMockArmRunner(options: MockArmOptions = {}): SyncArmRunner {
  const opts = resolveOptions(options);
  return (invocation: ArmInvocation): ArmObservation => {
    const built = buildResponse(invocation.case, invocation, opts);
    const promptChars = invocation.case.prompt.length;
    return {
      arm: invocation.arm,
      position: invocation.position,
      caseId: invocation.case.id,
      ok: true,
      error: null,
      response: built.response,
      retainedConstraintIds: built.retained,
      droppedConstraintIds: built.dropped,
      violatedConstraintIds: built.violated,
      inputTokens: Math.round(opts.baseInputTokens + promptChars * opts.inputTokensPerChar),
      outputTokens: Math.round(opts.baseOutputTokens + built.response.length / 4),
      latencyMs: round2(opts.baseLatencyMs + promptChars * opts.latencyMsPerChar),
    };
  };
}

/**
 * What one arm does to one case, on its own. The runner calls the same
 * `createMockArmRunner` it uses for the suite, so this is a convenience, not a
 * second implementation.
 */
export function runMockArm(
  evalCase: EvalCase,
  arm: Arm,
  seed: number,
  position = 0,
  options: MockArmOptions = {},
): ArmObservation {
  const runner = createMockArmRunner(options);
  const invocation: ArmInvocation = {
    harnessSeed: seed,
    suite: 'E1',
    case: evalCase,
    arm,
    position,
    attempt: 1,
  };
  const observation: ArmObservation | Promise<ArmObservation> = runner(invocation);
  if (observation instanceof Promise) {
    throw new TypeError('runMockArm is the synchronous convenience API; use createMockArmRunner and await it');
  }
  return observation;
}
