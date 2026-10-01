import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  BlockMeta,
  ContentBlock,
  ContextState,
  LossyStage,
  Message,
  Role,
  StrataPolicy,
  TelemetryEvent,
  TotalStage,
} from '@strata-ctx/core-types';
import { assertPrefixPreserved, runId, sha256, StrataPolicySchema } from '@strata-ctx/core-types';

import { diffCachePrefix, observeCachePrefix } from '../src/cache-prefix.js';
import type { CachePrefixDiff } from '../src/cache-prefix.js';
import { runPipeline } from '../src/runner.js';

/**
 * A-13 cache-prefix tracker tests. Fixtures are inline by rule; nothing here
 * imports another package's test directory (development.md P2).
 *
 * The randomised sections use a seeded PRNG so a failure is reproducible from
 * the seed printed in the assertion message. There is no `Math.random` and no
 * timing anywhere: a flaky cache-accounting test is worse than no test, because
 * the thing it guards is the pipeline's economics.
 */

const policy: StrataPolicy = StrataPolicySchema.parse({
  version: 1,
  pipeline: {
    stages: ['dedupe', 'truncate', 'triage'],
    tierByteCaps: { tool_state: 4096, episodic: 4096, artifact_ref: 4096, user_intent: 4096 },
  },
});

const policyOnlyDedupe: StrataPolicy = StrataPolicySchema.parse({
  version: 1,
  pipeline: { stages: ['dedupe'] },
});

/** A cacheable block. `sha256` defaults to the digest of the text, overridable. */
function cacheable(text: string, over: Partial<BlockMeta> = {}): ContentBlock {
  return {
    type: 'text',
    text,
    meta: {
      origin: 'user',
      sha256: sha256(text),
      tier: 'user_intent',
      bytes: text.length,
      cacheable: true,
      ...over,
    },
  };
}

/** A non-cacheable block, which by definition is outside the prefix. */
function plain(text: string): ContentBlock {
  return { ...cacheable(text), meta: { ...cacheable(text).meta, cacheable: false } };
}

function oneBlock(block: ContentBlock): Message[] {
  return [{ role: 'user', content: [block], ts: 0 }];
}

function messagesOf(...blocks: ContentBlock[]): Message[] {
  return blocks.map((block, i) => ({ role: 'user' as Role, content: [block], ts: i }));
}

const A = sha256('A');
const B = sha256('B');
const C = sha256('C');

/** Seeded PRNG (mulberry32). Deterministic, unlike `Math.random`. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stateOf(messages: readonly Message[]): ContextState {
  return {
    messages,
    pinned: [],
    tokenEstimate: 0,
    policyHash: sha256('policy'),
    runId: runId('r1'),
    turn: 1,
    gists: [],
    artifacts: [],
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

describe('cache-prefix: classification', () => {
  it('reports a no-op stage as intact and a hit', () => {
    const d = diffCachePrefix('truncate', messagesOf(cacheable('A', { sha256: A })), messagesOf(cacheable('A', { sha256: A })));
    assert.equal(d.verdict, 'intact');
    assert.deepEqual(d.cache, { prefixHit: true, prefixInvalidated: false });
    assert.equal(d.observation, 'observed');
  });

  it('ignores non-cacheable blocks entirely', () => {
    const before = messagesOf(cacheable('A', { sha256: A }), plain('x'), cacheable('B', { sha256: B }));
    const after = messagesOf(cacheable('A', { sha256: A }), plain('x'), plain('y'), plain('z'), cacheable('B', { sha256: B }));
    assert.equal(diffCachePrefix('truncate', before, after).verdict, 'intact');
  });

  it('treats a tail append as a hit: the cached bytes are untouched', () => {
    const d = diffCachePrefix(
      'serialize',
      messagesOf(cacheable('A', { sha256: A })),
      messagesOf(cacheable('A', { sha256: A }), cacheable('C', { sha256: C })),
    );
    assert.equal(d.verdict, 'appended');
    assert.equal(d.cache.prefixHit, true);
    assert.equal(d.added, 1);
  });

  it('reports a prepend as an insertion, not a reorder', () => {
    // This is `enforcePins` on every run. `assertPrefixPreserved` throws here.
    const before = messagesOf(cacheable('A', { sha256: A }), cacheable('B', { sha256: B }));
    const after = messagesOf(cacheable('G', { sha256: sha256('G') }), cacheable('A', { sha256: A }), cacheable('B', { sha256: B }));
    const d = diffCachePrefix('pin', before, after);
    assert.equal(d.verdict, 'inserted');
    assert.equal(d.reordered, 0);
    assert.throws(() => assertPrefixPreserved(before, after), /reordered blocks/);
  });

  it('reports a drop as a drop, not a reorder', () => {
    // This is `dedupe` dropping a superseded cacheable tool result.
    const before = messagesOf(cacheable('A', { sha256: A }), cacheable('B', { sha256: B }));
    const after = messagesOf(cacheable('B', { sha256: B }));
    const d = diffCachePrefix('dedupe', before, after);
    assert.equal(d.verdict, 'dropped');
    assert.equal(d.dropped, 1);
    assert.equal(d.reordered, 0);
    assert.equal(d.cache.prefixInvalidated, true);
    assert.throws(() => assertPrefixPreserved(before, after), /reordered blocks/);
  });

  it('reports a content rewrite under a stable digest as modified', () => {
    // This is `truncate`/`pointer-ize`, which preserve `meta.sha256` on purpose.
    const before = oneBlock(cacheable('x'.repeat(200), { sha256: A }));
    const after = oneBlock(cacheable('x'.repeat(3), { sha256: A }));
    const d = diffCachePrefix('truncate', before, after);
    assert.equal(d.verdict, 'modified');
    assert.equal(d.modified, 1);
    assert.equal(d.reordered, 0);
    assert.equal(d.cache.prefixInvalidated, true);
    assert.doesNotThrow(() => assertPrefixPreserved(before, after));
  });

  it('detects a genuine reorder of distinct blocks', () => {
    const before = messagesOf(cacheable('A', { sha256: A }), cacheable('B', { sha256: B }), cacheable('C', { sha256: C }));
    const after = [before[2]!, before[0]!, before[1]!];
    const d = diffCachePrefix('serialize', before, after);
    assert.equal(d.verdict, 'reordered');
    assert.ok(d.reordered > 0);
  });

  it('detects a reorder of duplicates that have distinct neighbours', () => {
    const D = sha256('dup');
    const before = messagesOf(cacheable('A', { sha256: A }), cacheable('1', { sha256: D }), cacheable('2', { sha256: D }), cacheable('B', { sha256: B }));
    const after = [before[3]!, before[1]!, before[2]!, before[0]!];
    const d = diffCachePrefix('serialize', before, after);
    assert.equal(d.verdict, 'reordered');
  });

  it('declines to call a shared-digest swap a reorder, and says why', () => {
    // Identity carries no information here, so `modified` is the honest verdict.
    const D = sha256('dup');
    const before = messagesOf(cacheable('first', { sha256: D }), cacheable('second', { sha256: D }));
    const after = [before[1]!, before[0]!];
    const d = diffCachePrefix('serialize', before, after);
    assert.equal(d.verdict, 'modified');
    assert.equal(d.modified, 2);
    assert.equal(d.reordered, 0);
  });

  it('treats a swap of byte-identical cacheable blocks as intact', () => {
    // Nothing to invalidate: the serialised prefix is byte-identical.
    const D = sha256('same');
    const before = messagesOf(cacheable('same', { sha256: D }), cacheable('same', { sha256: D }));
    const after = [before[1]!, before[0]!];
    assert.equal(diffCachePrefix('serialize', before, after).verdict, 'intact');
  });

  it('ranks a reorder above a drop when both apply', () => {
    // C and A both survive and exchange places, and B is dropped: two verdicts
    // apply at once and the reported one must be deterministic.
    const before = messagesOf(
      cacheable('A', { sha256: A }),
      cacheable('B', { sha256: B }),
      cacheable('C', { sha256: C }),
    );
    const after = [before[2]!, before[0]!];
    const d = diffCachePrefix('serialize', before, after);
    assert.equal(d.dropped, 1, 'B was dropped');
    assert.ok(d.reordered > 0, 'A and C exchanged places');
    assert.equal(d.verdict, 'reordered');
  });

  it('does not mutate either input', () => {
    const before = deepFreeze(messagesOf(cacheable('A', { sha256: A }), cacheable('B', { sha256: B })));
    const after = deepFreeze([before[1]!, before[0]!]);
    const beforeCopy = JSON.stringify(before);
    const afterCopy = JSON.stringify(after);
    diffCachePrefix('serialize', before, after);
    assert.equal(JSON.stringify(before), beforeCopy);
    assert.equal(JSON.stringify(after), afterCopy);
  });
});

describe('cache-prefix: randomised properties', () => {
  const TRIALS = 300;

  it('classifies every random no-op stage as intact', () => {
    for (let seed = 1; seed <= TRIALS; seed += 1) {
      const rand = prng(seed);
      const n = 1 + Math.floor(rand() * 6);
      const messages = messagesOf(
        ...Array.from({ length: n }, (_, i) => cacheable(`block-${seed}-${i}`, { sha256: sha256(`b${seed}-${i}`) })),
      );
      const d = diffCachePrefix('truncate', messages, messages);
      assert.equal(d.verdict, 'intact', `seed ${seed}`);
      assert.equal(d.cache.prefixHit, true, `seed ${seed}`);
      assert.equal(d.reordered, 0, `seed ${seed}`);
    }
  });

  it('never calls a survivor-preserving edit a reorder, however many edits', () => {
    // Random drops, random non-cacheable inserts, random tail appends. Survivor
    // order is preserved by construction, so `reordered` must stay 0 -- and
    // `assertPrefixPreserved` must throw on some of them, which is the bug this
    // tracker exists alongside.
    let guardFalsePositives = 0;
    for (let seed = 1; seed <= TRIALS; seed += 1) {
      const rand = prng(seed);
      const n = 2 + Math.floor(rand() * 6);
      const original = Array.from({ length: n }, (_, i) =>
        cacheable(`orig-${seed}-${i}`, { sha256: sha256(`o${seed}-${i}`) }),
      );

      const kept = original.filter(() => rand() > 0.3);
      const withInserts: ContentBlock[] = [];
      for (const b of kept) {
        if (rand() > 0.6) withInserts.push(plain(`noise-${seed}-${rand()}`));
        withInserts.push(b);
      }
      const appends = Math.floor(rand() * 3);
      for (let i = 0; i < appends; i += 1) {
        withInserts.push(cacheable(`app-${seed}-${i}`, { sha256: sha256(`ap${seed}-${i}`) }));
      }

      const before = messagesOf(...original);
      const after = messagesOf(...withInserts);
      const d = diffCachePrefix('truncate', before, after);

      assert.equal(d.reordered, 0, `seed ${seed} falsely reported a reorder`);
      assert.notEqual(d.verdict, 'reordered', `seed ${seed}`);
      if (d.dropped === 0 && d.modified === 0 && d.added === 0) {
        assert.equal(d.verdict, 'intact', `seed ${seed}`);
      }

      try {
        assertPrefixPreserved(before, after);
      } catch {
        guardFalsePositives += 1;
      }
    }
    // Non-vacuous: the legacy guard really does fire on legitimate transforms.
    assert.ok(guardFalsePositives > TRIALS / 2, `guard only false-positived ${guardFalsePositives}/${TRIALS} times`);
  });

  it('flags every non-identity permutation of distinct blocks as reordered', () => {
    for (let seed = 1; seed <= TRIALS; seed += 1) {
      const rand = prng(seed);
      const n = 2 + Math.floor(rand() * 5);
      const ids = Array.from({ length: n }, (_, i) => sha256(`p${seed}-${i}`));
      const before = messagesOf(...ids.map((id) => cacheable(id, { sha256: id })));

      const shuffled = [...ids];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      const after = messagesOf(...shuffled.map((id) => cacheable(id, { sha256: id })));

      const identity = shuffled.every((id, i) => id === ids[i]);
      const d = diffCachePrefix('serialize', before, after);
      if (identity) {
        assert.equal(d.verdict, 'intact', `seed ${seed}`);
      } else {
        assert.equal(d.verdict, 'reordered', `seed ${seed}`);
        assert.ok(d.reordered > 0, `seed ${seed}`);
      }
    }
  });
});

describe('cache-prefix: runner wiring', () => {
  function collect(): { events: TelemetryEvent[]; onTelemetry: (e: TelemetryEvent) => void } {
    const events: TelemetryEvent[] = [];
    return { events, onTelemetry: (e) => events.push(e) };
  }

  it('emits one cache event per stage on a clean run and no error events', () => {
    const { events, onTelemetry } = collect();
    const run = runPipeline(
      stateOf(messagesOf(cacheable('A', { sha256: A }), cacheable('B', { sha256: B }))),
      { policy, onTelemetry },
    );
    const cache = events.filter((e) => e.type === 'cache');
    assert.equal(cache.length, run.stageResults.length);
    assert.equal(run.cachePrefix.length, run.stageResults.length);
    for (const e of events) assert.equal(e.type, 'cache', `unexpected ${e.type}`);
    for (const d of run.cachePrefix) {
      assert.equal(d.verdict, 'intact');
      assert.equal(d.cache.prefixHit, true);
      assert.equal(d.observation, 'observed');
    }
  });

  it('populates cachePrefix with no telemetry sink attached', () => {
    const run = runPipeline(stateOf(messagesOf(cacheable('A', { sha256: A }))), { policy });
    assert.equal(run.cachePrefix.length, run.stageResults.length);
    assert.equal(run.cachePrefix[0]?.stage, 'dedupe');
  });

  it('detects a reorder committed by a total stage, which has no other guard', () => {
    // `pin` and `serialize` run through `isolateTotal`, which validates the shape
    // and nothing else. Nothing in the pipeline fails this stage open, so the
    // output commits -- and only the tracker sees it.
    const { events, onTelemetry } = collect();
    const reordering: TotalStage = {
      name: 'serialize',
      run: (s) => ({ ...s, messages: [...s.messages].reverse() }),
    };
    const run = runPipeline(stateOf(messagesOf(cacheable('A', { sha256: A }), cacheable('B', { sha256: B }))), {
      policy,
      totalStages: { serialize: reordering },
      onTelemetry,
    });

    assert.equal(run.failed, 0, 'the existing guards do not catch a total-stage reorder');
    const diff = run.cachePrefix.find((d) => d.stage === 'serialize');
    assert.equal(diff?.verdict, 'reordered');

    const err = events.find((e) => e.type === 'error');
    assert.ok(err && err.type === 'error');
    assert.equal(err.code, 'cache_prefix_reordered');
    // Nothing was reverted, so this was not a fail-open.
    assert.equal(err.failedOpen, false);
  });

  it('tells a legitimate drop apart from a reorder in the emitted telemetry', () => {
    const { events: dropEvents, onTelemetry: onDrop } = collect();
    const dropping: LossyStage = {
      name: 'truncate',
      run: (ctx) => ({ ...ctx, messages: ctx.messages.slice(1) }),
    };
    const droppedRun = runPipeline(
      stateOf(messagesOf(cacheable('A', { sha256: A }), cacheable('B', { sha256: B }))),
      { policy, lossyStages: { truncate: dropping }, onTelemetry: onDrop },
    );
    assert.equal(droppedRun.cachePrefix.find((d) => d.stage === 'truncate')?.verdict, 'dropped');
    assert.equal(dropEvents.filter((e) => e.type === 'error').length, 0);

    const { events: reorderEvents, onTelemetry: onReorder } = collect();
    const reversing: LossyStage = {
      name: 'truncate',
      run: (ctx) => ({ ...ctx, messages: [...ctx.messages].reverse() }),
    };
    const reorderedRun = runPipeline(
      stateOf(messagesOf(cacheable('A', { sha256: A }), cacheable('B', { sha256: B }))),
      { policy, lossyStages: { truncate: reversing }, onTelemetry: onReorder },
    );
    assert.equal(reorderedRun.cachePrefix.find((d) => d.stage === 'truncate')?.verdict, 'reordered');
    assert.equal(reorderEvents.filter((e) => e.type === 'error').length, 1);
  });

  it('measures the raw stage output, not the state the runner committed', () => {
    // The lossy guard reverts a reordered stage, so a tracker that diffed the
    // committed states would report `intact` here and miss the bug.
    const { events, onTelemetry } = collect();
    const reversing: LossyStage = {
      name: 'truncate',
      run: (ctx) => ({ ...ctx, messages: [...ctx.messages].reverse() }),
    };
    const run = runPipeline(
      stateOf(messagesOf(cacheable('A', { sha256: A }), cacheable('B', { sha256: B }))),
      { policy, lossyStages: { truncate: reversing }, onTelemetry },
    );
    const diff = run.cachePrefix.find((d) => d.stage === 'truncate');
    assert.equal(diff?.verdict, 'reordered');
    assert.equal(diff?.reverted, true, 'runStageFailOpen discarded the output');
    assert.equal(run.stageResults.find((r) => r.name === 'truncate')?.code, 'prefix_reordered');
    const err = events.find((e) => e.type === 'error');
    assert.ok(err?.type === 'error' && err.failedOpen);
  });

  it('finds the live dedupe false positive: designed drop, legacy guard throws', () => {
    // Two cacheable reads of the same file. Dedupe drops the stale one -- that is
    // the stage working -- and `assertPrefixPreserved` calls it a reorder, so the
    // runner throws the drop away. Pinned so the discrepancy cannot disappear.
    const { events, onTelemetry } = collect();
    const subject = { kind: 'file' as const, ref: 'src/app.ts' };
    const before = messagesOf(
      cacheable('v1 contents', { sha256: A, origin: 'tool', tier: 'tool_state', subject: { ...subject, version: 'v1' } }),
      cacheable('v2 contents', { sha256: B, origin: 'tool', tier: 'tool_state', subject: { ...subject, version: 'v2' } }),
    );
    const run = runPipeline(stateOf(before), { policy: policyOnlyDedupe, onTelemetry });

    const dedupe = run.stageResults.find((r) => r.name === 'dedupe');
    assert.equal(dedupe?.ok, false);
    assert.equal(dedupe?.code, 'prefix_reordered');

    const diff = run.cachePrefix.find((d) => d.stage === 'dedupe');
    assert.equal(diff?.verdict, 'dropped', 'the tracker calls a designed drop what it is');
    assert.equal(diff?.dropped, 1);
    assert.equal(diff?.reordered, 0);
    assert.equal(diff?.reverted, true);

    // The cost of the false positive: the drop was reverted, so both blocks are
    // still in the outbound context and no tokens were saved.
    assert.equal(run.state.messages.length, 2);
    assert.equal(events.filter((e) => e.type === 'error').length, 0);
  });

  it('reports a stage that threw as unobserved, and the prefix as intact', () => {
    const { events, onTelemetry } = collect();
    const throwing: LossyStage = {
      name: 'truncate',
      run: () => {
        throw new Error('boom');
      },
    };
    const run = runPipeline(
      stateOf(messagesOf(cacheable('A', { sha256: A }), cacheable('B', { sha256: B }))),
      { policy, lossyStages: { truncate: throwing }, onTelemetry },
    );
    const diff = run.cachePrefix.find((d) => d.stage === 'truncate');
    assert.equal(diff?.observation, 'stage_failed_open');
    assert.equal(diff?.verdict, 'intact');
    assert.equal(diff?.cache.prefixHit, true, 'the fail-open contract means nothing was damaged');
    assert.equal(diff?.reverted, true);
    assert.equal(run.stageResults.find((r) => r.name === 'truncate')?.code, 'stage_threw');
    assert.equal(events.filter((e) => e.type === 'error').length, 0);
  });

  it('does not mutate the input state', () => {
    const state = deepFreeze(stateOf(messagesOf(cacheable('A', { sha256: A }), cacheable('B', { sha256: B }))));
    assert.doesNotThrow(() => runPipeline(state, { policy: policyOnlyDedupe }));
  });

  it('is deterministic: the same input yields the same accounting and events', () => {
    const a = runPipeline(stateOf(messagesOf(cacheable('A', { sha256: A }), cacheable('B', { sha256: B }))), { policy });
    const b = runPipeline(stateOf(messagesOf(cacheable('A', { sha256: A }), cacheable('B', { sha256: B }))), { policy });
    assert.deepEqual(a.cachePrefix, b.cachePrefix);
    assert.deepEqual(a.stageResults.map((r) => r.name), b.stageResults.map((r) => r.name));
  });
});

describe('cache-prefix: fail-open', () => {
  it('proceeds unmodified and reports a measurement failure', () => {
    // `meta.sha256` is not a digest, so the tracker cannot key the prefix. The
    // pipeline never hashes it, so it completes normally.
    const forged = cacheable('hello world', { sha256: 42 as unknown as string, tier: 'user_intent' });
    const { events, onTelemetry } = { events: [] as TelemetryEvent[], onTelemetry: (e: TelemetryEvent) => events.push(e) };

    const run = runPipeline(stateOf(oneBlock(forged)), { policy, onTelemetry });

    assert.equal(run.failed, 0, 'a measurement failure is not a stage failure');
    assert.deepEqual(run.stagesRun, ['dedupe', 'truncate', 'triage']);
    assert.equal(run.state.messages[0]?.content.length, 1);
    assert.equal(run.state.messages[0]?.content[0]?.text, 'hello world');

    for (const diff of run.cachePrefix) {
      assert.equal(diff.observation, 'tracker_failed');
      assert.equal(diff.verdict, 'intact');
    }
    const errs = events.filter((e) => e.type === 'error');
    assert.equal(errs.length, run.stageResults.length);
    for (const e of errs) {
      assert.ok(e.type === 'error');
      assert.equal(e.code, 'cache_accounting_failed');
      assert.equal(e.failedOpen, true);
    }
  });

  it('never lets the exception message reach telemetry', () => {
    const forged = cacheable('secret payload', { sha256: '' as unknown as string });
    const events: TelemetryEvent[] = [];
    observeCachePrefix('truncate', { before: oneBlock(forged), after: oneBlock(forged), reverted: false }, 'r1', (e) => events.push(e));
    assert.equal(events.length, 1);
    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes('secret payload'), 'user content must not leak into telemetry');
  });

  it('returns a usable diff for an unobserved stage', () => {
    const diff: CachePrefixDiff = observeCachePrefix(
      'dedupe',
      { before: messagesOf(cacheable('A', { sha256: A })), after: undefined, reverted: true },
      'r1',
      () => {},
    );
    assert.equal(diff.observation, 'stage_failed_open');
    assert.equal(diff.reverted, true);
    assert.equal(diff.cache.prefixInvalidated, false);
  });
});

describe('cache-prefix: cache projection coherence', () => {
  it('reports a hit only for verdicts that leave the cached bytes intact', () => {
    const before = messagesOf(cacheable('A', { sha256: A }), cacheable('B', { sha256: B }));
    const cases: ReadonlyArray<readonly [string, Message[], boolean]> = [
      ['intact', before, true],
      ['appended', [...before, ...messagesOf(cacheable('C', { sha256: C }))], true],
      ['dropped', messagesOf(cacheable('B', { sha256: B })), false],
      ['reordered', [before[1]!, before[0]!], false],
    ];
    for (const [expected, after, hit] of cases) {
      const d = diffCachePrefix('serialize', before, after);
      assert.equal(d.verdict, expected);
      assert.equal(d.cache.prefixHit, hit, expected);
      assert.equal(d.cache.prefixInvalidated, !hit, expected);
    }
  });
});
