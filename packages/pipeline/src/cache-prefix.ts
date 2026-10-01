import type {
  CacheTelemetry,
  ContentBlock,
  Message,
  StageName,
  TelemetryEvent,
} from '@strata-ctx/core-types';
import { sha256 } from '@strata-ctx/core-types';

/**
 * A-13. Per-stage accounting for the provider's cached prefix.
 *
 * The prefix that matters is the bytes the egress adapter actually sends, in
 * document order, restricted to blocks marked `meta.cacheable`. Providers key
 * their prompt cache on that byte prefix, so what decides cache economics is
 * (a) whether those bytes still appear in the same relative order and (b)
 * whether they are still the same bytes. This module answers both, per stage.
 *
 * ## Why this exists rather than `assertPrefixPreserved`
 *
 * `assertPrefixPreserved` (core-types/guards.ts) is the enforcement guard, and
 * it is the right thing for a *throw* -- coarse, cheap, and it fails toward
 * more context. It is the wrong thing for *accounting*, for three measured
 * reasons:
 *
 * 1. It compares absolute indices. Inserting or dropping anything before a
 *    surviving cacheable block shifts that block's index, so the guard reports
 *    `prefix_reordered` for two things the pipeline does on every run:
 *    `enforcePins` prepending the governance prefix, and `dedupe` dropping a
 *    superseded cacheable tool result. Both are designed behaviour. Both throw.
 * 2. It matches on `meta.sha256` alone, which every transform deliberately
 *    preserves. `truncate` and `pointer-ize` rewrite a cacheable block's text
 *    from 8289 bytes to a 284-byte stub while keeping the digest, so the guard
 *    sees "unchanged" precisely when the provider cache was in fact destroyed.
 * 3. It resolves duplicates with `indexOf`, so two cacheable blocks sharing a
 *    digest and exchanging places are invisible to it -- `was` and `now` are the
 *    same list of the same string.
 *
 * This module is the precise version. It is deliberately *observational*: it
 * never mutates a context and never decides whether a stage is trusted. The
 * enforcement decision stays in `runStageFailOpen` (lossy stages) and, for
 * `pin`/`serialize`, still has no enforcement at all -- which is a gap this
 * module reports rather than papers over. See the report on the A-13 tracker
 * for the core-types/`order.ts` change this implies.
 *
 * ## Known limit: swaps between blocks that share a digest
 *
 * Case 3 is not fixed here, and it cannot be. When two cacheable blocks carry
 * the same `meta.sha256`, identity carries no information about which physical
 * block is which, so a swap is indistinguishable from two independent content
 * rewrites. This module reports `modified` with a count of 2 rather than
 * `reordered`, because attributing it to a reorder would be a guess dressed up
 * as a measurement. When the two blocks are byte-identical -- the realistic way
 * a duplicate arises -- the swap is a genuine no-op for the provider cache and
 * `intact` is the correct verdict. The invalidation is still reported either
 * way, so the accounting is not lost; only the attribution is.
 *
 * ## What a provider cache actually rewards
 *
 * A cache is a byte prefix, so only a change to bytes *at or before* a
 * surviving block can invalidate it. That is why `appended` counts as a hit:
 * adding blocks after the last survivor leaves every cached byte untouched. It
 * is also why the severity order below is not decorative -- it separates
 * *budgeted* costs from *unbudgeted* bugs, and that distinction is the whole
 * point of the type.
 */

export type CacheVerdict =
  /** Every cacheable block is present, in order, byte-identical. */
  | 'intact'
  /** New cacheable blocks, all after the last survivor. Cheap and cache-preserving. */
  | 'appended'
  /** New cacheable blocks before an existing one. Invalidates from the insert point. */
  | 'inserted'
  /** A survivor's bytes changed under a stable digest. Invalidates from that block. */
  | 'modified'
  /** A cacheable block left the prefix. Designed (dedupe), and the cost is budgeted. */
  | 'dropped'
  /**
   * Two survivors exchanged relative order. Nothing in the pipeline is designed
   * to do this, it saves zero bytes, and it recurs every turn because the input
   * has the same shape every turn. This is the catastrophic case.
   */
  | 'reordered';

/**
 * Whether the diff is a real measurement, and if not, why. Three distinct
 * states, because "the stage threw" and "the tracker threw" have different
 * fixes and a sink that cannot tell them apart will page the wrong person.
 */
export type CacheObservation = 'observed' | 'stage_failed_open' | 'tracker_failed';

export interface CachePrefixDiff {
  readonly stage: StageName;
  readonly verdict: CacheVerdict;
  /** The frozen telemetry projection. `intact` and `appended` are hits. */
  readonly cache: CacheTelemetry;
  readonly observation: CacheObservation;
  /** Cacheable blocks present after but not before. */
  readonly added: number;
  /** Cacheable blocks present before but not after. */
  readonly dropped: number;
  /** Survivors whose serialized bytes changed under a stable digest. */
  readonly modified: number;
  /** Survivors found out of relative order. Non-zero is the catastrophic signal. */
  readonly reordered: number;
  /** True when the runner discarded this stage's output and kept the input. */
  readonly reverted: boolean;
}

/**
 * One cacheable block, keyed for two different questions.
 *
 * `identity` answers "is this still the same block?" and is `meta.sha256`,
 * matching `assertPrefixPreserved` -- deliberately, so the two never disagree
 * about *which blocks are in the prefix*. It is stable across every transform,
 * which is exactly why it cannot also answer "are these still the same bytes?".
 * That is `content`'s job, and the split is the point: a truncated block is the
 * same block with different bytes, not a removal plus an addition.
 */
interface CacheRef {
  readonly identity: string;
  readonly content: string;
}

/**
 * The identity of a cacheable block, or a throw.
 *
 * A precondition rather than paranoia. `BlockMeta.sha256` is documented as a
 * content hash, and every stage that builds a block computes it. A non-digest
 * or empty identity would not fail here -- it would silently corrupt the
 * survivor matching, because every block would key as its own identity and the
 * diff would report spurious drops and additions for a prefix that never
 * changed. That is precisely the class of bug this module exists to catch, so it
 * must not be able to cause one. Throwing lets the runner fail the measurement
 * open instead. The message carries no content.
 */
const identityOf = (block: ContentBlock): string => {
  const id = block.meta.sha256;
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('cacheable block has no digest identity');
  }
  return id;
};

/**
 * The prefix, as the provider will see it: cacheable blocks flattened in
 * document order.
 *
 * `content` hashes what egress serialises rather than `meta.bytes`, because
 * byte length is not a fingerprint -- a rewrite that coincidentally preserves
 * length would pass, and this is the one axis that catches the case
 * `assertPrefixPreserved` is blind to. Cost is O(prefix bytes) per stage; the
 * cacheable prefix is the system prompt plus the head of the first user turn,
 * and at ~500MB/s this is noise next to a network-bound request. Correctness
 * first: this is the axis that decides whether the cache survived.
 */
const cacheRefs = (messages: readonly Message[]): CacheRef[] => {
  const refs: CacheRef[] = [];
  for (const msg of messages) {
    for (const block of msg.content) {
      if (!block.meta.cacheable) continue;
      refs.push({
        identity: identityOf(block),
        // The type is in the hash so a text->image swap at a stable digest is
        // caught, and the NUL separator so concatenation is unambiguous.
        content: sha256(`${block.type}\u0000${block.text ?? ''}`),
      });
    }
  }
  return refs;
};

const isHit = (verdict: CacheVerdict): boolean => verdict === 'intact' || verdict === 'appended';

/**
 * Classify one stage boundary. Pure, total, and the whole of the logic.
 *
 * Survivor matching is by *k-th occurrence*: the k-th copy of an identity in
 * `after` is paired with the k-th copy in `before`. That pairing is canonical
 * (no choice to get wrong) and handles duplicate digests correctly, which
 * `indexOf` does not. A copy with no counterpart is an addition, whether the
 * identity is entirely new or `after` simply has more copies than `before`.
 *
 * Reorder is then a single monotonicity test: walking `after`, the paired
 * before-indices must strictly increase. If one does not, a survivor moved back
 * past a survivor that precedes it. Insertions and drops cannot produce this,
 * because they leave the *survivors'* relative order alone -- which is exactly
 * the distinction `assertPrefixPreserved` cannot make.
 *
 * Precedence (reordered > dropped > modified > inserted > appended > intact) is
 * a fixed total order so the reported verdict is deterministic when several
 * apply. Reorder dominates because a reorder that also drops something is
 * still fundamentally a reorder bug.
 */
export function diffCachePrefix(
  stage: StageName,
  before: readonly Message[],
  after: readonly Message[],
): CachePrefixDiff {
  const was = cacheRefs(before);
  const now = cacheRefs(after);

  const slots = new Map<string, Array<{ readonly index: number; readonly content: string }>>();
  let cursor = 0;
  for (const ref of was) {
    const bucket = slots.get(ref.identity);
    if (bucket === undefined) slots.set(ref.identity, [{ index: cursor, content: ref.content }]);
    else bucket.push({ index: cursor, content: ref.content });
    cursor += 1;
  }

  const taken = new Map<string, number>();
  const addedAt: number[] = [];
  let nowIndex = 0;
  let survivors = 0;
  let dropped = 0;
  let modified = 0;
  let reordered = 0;
  let lastSurvivorAt = -1;
  let highWater = -1;

  for (const ref of now) {
    const bucket = slots.get(ref.identity);
    const used = taken.get(ref.identity) ?? 0;
    // `undefined` covers both "no such identity in before" and "after has more
    // copies than before" -- in both cases this occurrence is an addition.
    const slot = bucket === undefined ? undefined : bucket[used];
    if (slot === undefined) {
      addedAt.push(nowIndex);
    } else {
      taken.set(ref.identity, used + 1);
      survivors += 1;
      if (slot.index < highWater) reordered += 1;
      else highWater = slot.index;
      if (slot.content !== ref.content) modified += 1;
      lastSurvivorAt = nowIndex;
    }
    nowIndex += 1;
  }

  dropped = was.length - survivors;

  // An addition is a cache-preserving tail append only if it landed after every
  // survivor. Anything earlier invalidates the bytes that follow it.
  const inserted = addedAt.some((at) => at < lastSurvivorAt);

  const verdict: CacheVerdict =
    reordered > 0
      ? 'reordered'
      : dropped > 0
        ? 'dropped'
        : modified > 0
          ? 'modified'
          : inserted
            ? 'inserted'
            : addedAt.length > 0
              ? 'appended'
              : 'intact';

  return {
    stage,
    verdict,
    cache: { prefixHit: isHit(verdict), prefixInvalidated: !isHit(verdict) },
    observation: 'observed',
    added: addedAt.length,
    dropped,
    modified,
    reordered,
    reverted: false,
  };
}

const ACCOUNTING_FAILED = 'cache_accounting_failed';
const PREFIX_REORDERED = 'cache_prefix_reordered';

const benign = (stage: StageName, observation: CacheObservation, reverted: boolean): CachePrefixDiff => ({
  stage,
  // The fail-open contract means a discarded stage provably did not damage the
  // prefix, so "we could not measure" reports as a hit, not a false alarm.
  verdict: 'intact',
  cache: { prefixHit: true, prefixInvalidated: false },
  observation,
  added: 0,
  dropped: 0,
  modified: 0,
  reordered: 0,
  reverted,
});

/**
 * The tracker the runner wires in: diff one stage, emit its `cache` event, and
 * fail open if the measurement itself fails.
 *
 * Fail-open is total here, and it is free rather than bolted on: the tracker
 * only ever *reads* contexts and its return value feeds nothing but the run
 * result, so it cannot alter a request even in principle. The `try` exists to
 * keep a bad measurement from turning into a bad request.
 *
 * `after: undefined` means the stage's output was never observed -- it threw,
 * or returned something that was not a stage context. `runStageFailOpen` and
 * `isolateTotal` both discard the output and keep the input in that case, so
 * the committed prefix is provably unchanged and the diff is a genuine hit.
 *
 * Reorder is reported on the frozen `error` event rather than as an extra field
 * on `cache`, because `CacheTelemetry` is closed at two booleans and this is
 * the one distinction that has to survive to the sink: a drop is a budgeted cost
 * and a reorder is a bug. Distinguishable codes are the contract-respecting way
 * to say that. `failedOpen` reports whether the pipeline actually discarded the
 * stage's output, which differs by stage kind and is passed in rather than
 * guessed.
 *
 * The sink itself is not guarded, matching `onStage`: a caller-supplied hook
 * that throws is the caller's bug, and hiding it would be worse than loud.
 */
export function observeCachePrefix(
  stage: StageName,
  input: {
    readonly before: readonly Message[];
    readonly after: readonly Message[] | undefined;
    readonly reverted: boolean;
  },
  runId: string,
  emit: (event: TelemetryEvent) => void,
): CachePrefixDiff {
  let diff: CachePrefixDiff;
  try {
    diff =
      input.after === undefined
        ? benign(stage, 'stage_failed_open', input.reverted)
        : { ...diffCachePrefix(stage, input.before, input.after), reverted: input.reverted };
  } catch {
    // Fixed string, never the exception: a hash error can quote its input, and
    // telemetry is a place user content must not leak from. Determinism is the
    // other reason.
    emit({
      type: 'error',
      runId,
      stage,
      code: ACCOUNTING_FAILED,
      message: 'cache accounting failed open; prefix unmeasured',
      failedOpen: true,
    });
    return benign(stage, 'tracker_failed', input.reverted);
  }

  emit({ type: 'cache', runId, ...diff.cache });

  if (diff.verdict === 'reordered') {
    emit({
      type: 'error',
      runId,
      stage,
      code: PREFIX_REORDERED,
      message: `reordered ${diff.reordered} cacheable block(s)`,
      failedOpen: input.reverted,
    });
  }

  return diff;
}
