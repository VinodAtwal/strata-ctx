import type {
  ArtifactRef,
  ContentBlock,
  ContextState,
  Gist,
  LossyContext,
  Message,
  NonGovernanceBlock,
  NonGovernanceMessage,
  NonGovernanceTier,
  PinnedConstraint,
  Role,
  StrataPolicy,
} from '@strata-ctx/core-types';
import { partitionForLossy, pinSetText, runId, sha256, StrataPolicySchema } from '@strata-ctx/core-types';

/**
 * Local fixtures for this package. Rule P2 (development §2): nothing here
 * imports another package's test directory, so a change to someone else's
 * fixtures cannot break these tests and a change here cannot break theirs.
 *
 * ## Why `block` and `message` are narrow
 *
 * `block` returns `NonGovernanceBlock` and `message` returns
 * `NonGovernanceMessage`, so anything a lossy stage is handed is built at the
 * right width in the first place and no call site needs a cast. The one builder
 * that is deliberately wide is `stateMessage`, because a `ContextState`
 * legitimately does contain governance -- that is exactly what `enforcePins`
 * puts there. Losing the narrowing at the context boundary is correct; losing
 * it at the operator boundary would not be.
 *
 * ## Why there is a PRNG in here at all
 *
 * D-9 is a property suite and no property-testing library is installed, and
 * adding one is not this stream's call. So: a seeded mulberry32, plus the
 * forked streams the property test needs to vary one dimension at a time while
 * keeping the run reproducible. Everything it produces is a pure function of
 * the seed, so a failure is replayable by printing the seed -- which is the
 * entire reason a property suite is worth having over a pile of hand-written
 * scenarios.
 */

/** The meta a non-governance block can carry. Widening it to `BlockMeta` puts the cast back. */
type NonGovernanceMeta = NonGovernanceBlock['meta'];

export const NON_GOVERNANCE_TIERS: readonly NonGovernanceTier[] = Object.freeze([
  'episodic',
  'tool_state',
  'artifact_ref',
  'user_intent',
]);

export function meta(over: Partial<NonGovernanceMeta> = {}): NonGovernanceMeta {
  return {
    origin: 'tool',
    sha256: sha256(over.subject?.ref ?? `seed-${over.tier ?? 'episodic'}`),
    tier: 'episodic',
    bytes: 100,
    cacheable: false,
    ...over,
  };
}

export function block(over: Partial<NonGovernanceBlock> = {}): NonGovernanceBlock {
  const text = over.text ?? 'hello';
  return { type: 'text', text, meta: meta({ bytes: text.length }), ...over };
}

export function unsubjected(
  text: string,
  origin: NonGovernanceMeta['origin'] = 'user',
  tier: NonGovernanceTier = 'episodic',
): NonGovernanceBlock {
  return block({ text, meta: meta({ origin, tier, bytes: text.length }) });
}

export function message(
  role: Role,
  content: readonly NonGovernanceBlock[],
  ts = 1_700_000_000_000,
): NonGovernanceMessage {
  return { role, content, ts };
}

/**
 * A full-width `Message`, for a `ContextState` that carries governance. Named
 * apart from `message` so every call site says which boundary it crosses.
 */
export function stateMessage(
  role: Role,
  content: readonly ContentBlock[],
  ts = 1_700_000_000_000,
): Message {
  return { role, content, ts };
}

export function governanceBlock(text: string): ContentBlock {
  return {
    type: 'text',
    text,
    meta: {
      origin: 'system',
      sha256: sha256(text),
      tier: 'governance',
      bytes: text.length,
      // Cacheable, for the same reason `enforcePins` says it is: a constraint
      // that re-invalidates the cached prefix every turn is a tax on every
      // request, and stability of the pin is the whole point of pinning.
      cacheable: true,
    },
  };
}

/**
 * A governance block presented as a `NonGovernanceBlock`.
 *
 * The one deliberate hole in this file, and it exists solely to exercise the
 * *runtime* half of the guarantee: `partitionForLossy` removes governance
 * statically, so the only way one can reach a lossy stage is a value that
 * arrived by cast rather than by constructor. The `@ts-expect-error` is
 * load-bearing in both directions -- it documents that the value is not
 * representable, and if `NonGovernanceTier` is ever widened to include
 * `'governance'` it goes unused and the package stops compiling, which is the
 * same tripwire D-8's test asserts directly.
 */
export function smuggledGovernance(text: string): NonGovernanceBlock {
  const wide: ContentBlock = governanceBlock(text);
  // @ts-expect-error -- the point of this fixture: governance is not
  // representable as a NonGovernanceBlock. Stands in for a value that came
  // from outside the type system (another package, a deserialiser, a test).
  return wide;
}

/** A lossy context with a governance block smuggled into the narrowed list. */
export function lossyWithSmuggle(policy: StrataPolicy, texts: readonly string[]): LossyContext {
  return {
    ...partitionForLossy(state(), policy),
    messages: [message('system', [smuggledGovernance(texts[0] ?? 'smuggled')])],
  };
}

export function state(over: Partial<ContextState> = {}): ContextState {
  return {
    messages: [
      stateMessage('system', [unsubjected('CLAUDE.md', 'system', 'user_intent')]),
      stateMessage('user', [unsubjected('refactor the parser')]),
    ],
    pinned: [],
    tokenEstimate: 0,
    policyHash: sha256(''),
    runId: runId('run-1'),
    turn: 1,
    gists: [],
    artifacts: [],
    ...over,
  };
}

export function constraint(
  text: string,
  over: Partial<Omit<PinnedConstraint, 'text'>> & Record<string, unknown> = {},
): PinnedConstraint {
  return {
    // Content-addressed by default so a fixture never has to invent an id, and
    // so a reordered file cannot read as a policy change -- the same reasoning
    // `expandConstraint` in ./policy-store applies to YAML input.
    id: over.id ?? `c-${sha256(text).slice(0, 10)}`,
    text,
    sha256: sha256(text),
    source: over.source ?? 'org_policy',
    // soft_policy, not hard_safety: an unlabelled constraint is the kind that
    // decays 8.3x faster, and a fixture default of the kind that alignment
    // training already holds in place would flatter every result downstream.
    kind: over.kind ?? 'soft_policy',
    enforcement: over.enforcement ?? 'block',
  };
}

/** The four constraints most of these tests use, deliberately mixed in kind. */
export const MIXED: readonly PinnedConstraint[] = Object.freeze([
  constraint('never delete production data', { id: 'safety.delete', kind: 'hard_safety' }),
  constraint('never email the client directly', { id: 'soft.client-email', kind: 'soft_policy' }),
  constraint('always route schema changes through review', {
    id: 'soft.schema-review',
    kind: 'soft_policy',
  }),
  constraint("don't touch the legacy adapter", { id: 'pref.legacy-adapter', kind: 'user_preference' }),
]);

export const SOFT_ONLY: readonly PinnedConstraint[] = Object.freeze(
  MIXED.filter((c) => c.kind !== 'hard_safety'),
);

/** The configuration D-6 exists to reject. */
export const HARD_ONLY: readonly PinnedConstraint[] = Object.freeze(
  MIXED.filter((c) => c.kind === 'hard_safety'),
);

export function policyOf(
  constraints: readonly PinnedConstraint[] = [],
  over: Record<string, unknown> = {},
): StrataPolicy {
  return StrataPolicySchema.parse({
    version: 1,
    ...over,
    constraints: constraints.map((c) => ({ ...c })),
  });
}

export const MIXED_POLICY: StrataPolicy = policyOf(MIXED);

/** A policy that is entirely soft: the stratum Governance Decay says actually breaks. */
export const SOFT_POLICY: StrataPolicy = policyOf(SOFT_ONLY);

export const NO_CONSTRAINT_POLICY: StrataPolicy = policyOf([]);

export function policyWith(texts: readonly string[]): StrataPolicy {
  return policyOf(
    texts.map((t, i) => constraint(t, { id: `c${i + 1}` })),
  );
}

export interface GistOver {
  readonly task_id?: string;
  readonly status?: Gist['status'];
  readonly goal?: string;
  readonly constraints?: readonly string[];
  readonly unresolved?: readonly string[];
  readonly salient_errors?: readonly string[];
  readonly dropped_count?: number;
  readonly source_turn_range?: [number, number];
  readonly compressed_by?: Gist['compressed_by'];
  readonly artifacts?: Gist['artifacts'];
  readonly raw_uri?: string;
}

/**
 * A gist that satisfies the frozen v1 schema.
 *
 * `constraints` has no default on purpose: in `GistSchema` it is the one field
 * with no `.default()`, because it is a verification target rather than
 * something a compactor fills in. A fixture that defaulted it would stop
 * testing the property that matters.
 */
export function gist(over: GistOver = {}): Gist {
  return {
    v: 1,
    task_id: over.task_id ?? 'task-42',
    status: over.status ?? 'complete',
    goal: over.goal ?? 'refactor the token estimator',
    changed: [],
    current_values: {},
    decided: [],
    unresolved: [...(over.unresolved ?? [])],
    artifacts: [...(over.artifacts ?? [])],
    next: { question: '', next_command: '', blockers: [] },
    log_gist: {
      ran: [],
      failed: [],
      salient_errors: [...(over.salient_errors ?? [])],
      salient_warnings: [],
      dropped_count: over.dropped_count ?? 3,
      raw_uri: over.raw_uri ?? 'artifact://transcript/task-42',
    },
    verification: { status: 'untested', tests_run: [] },
    constraints: [...(over.constraints ?? [])],
    source_turn_range: over.source_turn_range ?? [1, 7],
    raw_recoverable: true,
    compressed_by: over.compressed_by ?? 'self-gist',
  };
}

/** A gist whose constraint set byte-equals the given policy's pin set. */
export function gistFor(policy: StrataPolicy, over: GistOver = {}): Gist {
  return gist({ constraints: pinSetText(policy), ...over });
}

export function artifact(over: Partial<ArtifactRef> = {}): ArtifactRef {
  return {
    uri: 'artifact://transcript/task-42',
    sha256: sha256('raw transcript'),
    bytes: 4096,
    kind: 'raw_transcript',
    ...over,
  };
}

export function lines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n');
}

/** A deterministic clock. Every timing-sensitive fixture takes one of these. */
export function clock(start = 1_700_000_000_000, step = 1000): () => number {
  let t = start;
  return () => {
    t += step;
    return t;
  };
}

export const FIXED_NOW = 1_700_000_500_000;

// ---------------------------------------------------------------------------
// D-9: a seeded PRNG. mulberry32, because it is four lines, has no state
// larger than a uint32, and produces the same stream on every platform -- which
// is the only property that makes a failing property-suite run replayable.
// ---------------------------------------------------------------------------

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [0, maxExclusive). Throws on a non-positive bound. */
  int(maxExclusive: number): number;
  /** Uniform in [min, maxInclusive]. */
  between(min: number, maxInclusive: number): number;
  bool(probability?: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** An independent stream derived from this one plus a salt. */
  fork(salt: string): Rng;
}

const FNV_OFFSET = 0x811c9dc5;

function fnv1a(s: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededRandom(seed: number): Rng {
  const next = mulberry32(seed >>> 0);
  return {
    next: () => next(),
    int: (maxExclusive: number) => {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new RangeError(`rng.int bound must be a positive integer, got ${maxExclusive}`);
      }
      return Math.floor(next() * maxExclusive);
    },
    between: (min: number, maxInclusive: number) => min + Math.floor(next() * (maxInclusive - min + 1)),
    bool: (probability = 0.5) => next() < probability,
    pick: <T,>(items: readonly T[]): T => {
      if (items.length === 0) throw new RangeError('rng.pick from an empty list');
      const value = items[Math.floor(next() * items.length)];
      if (value === undefined) throw new RangeError('rng.pick out of range');
      return value;
    },
    fork: (salt: string) => seededRandom((Math.floor(next() * 0x1_0000_0000) ^ fnv1a(salt)) >>> 0),
  };
}
