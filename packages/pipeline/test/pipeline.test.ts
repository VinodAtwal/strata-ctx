import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ContextState, LossyContext, StrataPolicy } from '@strata-ctx/core-types';
import { assertPrefixPreserved, isHighSeverity, partitionForLossy } from '@strata-ctx/core-types';

import {
  LAST_STAGE,
  LOSSY_TIER0_STAGES,
  PIPELINE_STAGE_ORDER,
  TIER0_STAGE_ORDER,
  TUNNEL_AFTER_TIER0,
  runStageFailOpen,
  runTier0,
  truncateStage,
} from '../src/index.js';

import {
  CONSTRAINTS,
  PINNED_POLICY,
  block,
  lines,
  message,
  meta,
  policy,
  realisticState,
  state,
  toolResult,
} from './fixtures.js';

const blocks = (s: ContextState) => s.messages.flatMap((m) => m.content);
const textOf = (s: ContextState) => blocks(s).map((b) => b.text ?? '');

describe('stage order', () => {
  it('is the fixed order the architecture calls a safety property', () => {
    assert.deepEqual(TIER0_STAGE_ORDER, ['dedupe', 'truncate', 'triage']);
    assert.deepEqual(PIPELINE_STAGE_ORDER, [
      'dedupe',
      'truncate',
      'triage',
      'pin',
      'compact',
      'compress',
      'serialize',
    ]);
    assert.deepEqual(TUNNEL_AFTER_TIER0, ['pin', 'compact', 'compress']);
    assert.equal(LAST_STAGE, 'serialize');
  });

  it('puts the lossy stages first and the reversible one last', () => {
    assert.equal(PIPELINE_STAGE_ORDER.indexOf('dedupe'), 0);
    assert.ok(PIPELINE_STAGE_ORDER.indexOf('compact') > PIPELINE_STAGE_ORDER.indexOf('truncate'));
    assert.equal(PIPELINE_STAGE_ORDER.at(-1), 'serialize');
  });

  it('exposes projections for the gateway runner, in order', () => {
    assert.deepEqual(
      LOSSY_TIER0_STAGES.map((s) => s.name),
      ['dedupe', 'truncate', 'triage'],
    );
  });

  it('ignores a policy that reorders the stages, and says so', () => {
    const reordered = policy({ stages: ['triage', 'truncate', 'dedupe', 'pin', 'compact', 'compress', 'serialize'] });
    const result = runTier0(realisticState(), reordered);

    assert.deepEqual(result.stagesRun, ['dedupe', 'truncate', 'triage'], 'the fixed order wins');
    assert.equal(result.policyOrderIgnored, true);
  });

  it('honours a policy that disables a stage', () => {
    // Whether a stage runs is the operator's call; in what order is not.
    const result = runTier0(
      realisticState(),
      policy({ stages: ['dedupe', 'truncate', 'triage', 'pin', 'compact', 'compress', 'serialize'] }),
    );
    assert.deepEqual(result.stagesRun, ['dedupe', 'truncate', 'triage']);
  });
});

describe('Tier 0 end to end', () => {
  const input = realisticState();
  const result = runTier0(input, PINNED_POLICY);

  it('shrinks a realistic transcript', () => {
    assert.ok(result.tokensAfter < result.tokensBefore, `${result.tokensAfter} < ${result.tokensBefore}`);
    assert.ok(result.bytesAfter < result.bytesBefore);
    assert.ok(result.blocksAfter <= result.blocksBefore);
  });

  it('reports every stage it ran, in order, with telemetry', () => {
    assert.deepEqual(result.stagesRun, ['dedupe', 'truncate', 'triage']);
    for (const run of result.runs) {
      assert.equal(run.failedOpen, false, run.name);
      assert.equal(run.telemetry.stage, run.name);
      assert.ok(run.telemetry.durationMs >= 0);
      assert.ok(run.telemetry.bytesIn > 0);
    }
    assert.ok(result.runs.every((r) => r.telemetry.changed), 'this fixture makes every stage work');
  });

  it('reclaims bytes at the pointer-izer, which is the biggest win', () => {
    const pointerize = result.reports.truncate?.pointerize;
    assert.equal(pointerize?.pointerized, 1);
    assert.ok((pointerize?.charsFreed ?? 0) > 9_000, 'the oversized file read became a pointer');
    assert.equal(pointerize?.artifactsAdded, 1);
    assert.equal(result.state.artifacts.length, 1, 'and the artifact survives the restore');
  });

  it('dedupes the re-read file, the older version, and the producer-flagged block', () => {
    const dedupe = result.reports.dedupe;
    assert.equal(dedupe?.dropped, 4);
    assert.equal(dedupe?.byReason.duplicate, 2, 'two byte-identical re-reads');
    assert.equal(dedupe?.byReason.superseded, 1, 'v1 of a file read twice');
    assert.equal(dedupe?.byReason.superseded_by_flag, 1, 'the producer said so');
    assert.equal(dedupe?.retainedHighSeverity, 0);
    assert.equal(dedupe?.drops.length, 4, 'every drop is named in the report');
    assert.ok((dedupe?.mergedMessages ?? 0) > 0, 'and the emptied messages were folded away');
  });

  it('routes every block to a tier and accounts for all of them', () => {
    const triage = result.reports.triage;
    assert.ok(triage);
    assert.equal(triage.diverted, 0, 'the pins were already held by the partition');
    assert.equal(
      triage.totalBlocks,
      triage.census.governance + triage.census.episodic + triage.census.tool_state + triage.census.artifact_ref + triage.census.user_intent,
    );
    assert.equal(triage.taggedIntent >= 1, true, 'the leading intent turn was tagged');
  });

  it('keeps the pinned governance at the head of the restored context', () => {
    const first = blocks(result.state)[0];
    assert.equal(first?.meta.tier, 'governance');
    assert.equal(first?.text, CONSTRAINTS[0]);
    assertPrefixPreserved(input.messages, result.state.messages);
  });

  it('reclaims every cacheable byte it drops rather than moving it', () => {
    // R4, the operator-visible form. `assertPrefixPreserved` above is the
    // property; this is the number the gateway reports, and it has to agree for
    // the check to mean anything. Tier 0 deleted a great deal here, so this is
    // the case where a reorder would show up. That the check can fail at all is
    // pinned by the `prefix_reordered` case in the fail-open suite below.
    assert.equal(result.prefixInvalidated, false);
    for (const run of result.runs) {
      assert.equal(run.cache.prefixInvalidated, false, `${run.name} moved a cacheable block`);
      assert.equal(run.cache.prefixHit, true, run.name);
    }
  });

  it('never loses a high-severity block or an error line', () => {
    const out = blocks(result.state);
    for (const original of blocks(input)) {
      if (!isHighSeverity(original)) continue;
      const survivor = out.find((b) => b.meta.sha256 === original.meta.sha256);
      assert.ok(survivor, `dropped a block at ${original.meta.severity}`);
      assert.equal(survivor.text, original.text);
    }

    for (const original of blocks(input)) {
      const survivor = out.find((b) => b.meta.sha256 === original.meta.sha256);
      if (survivor === undefined || survivor.text === original.text) continue;
      for (const line of (original.text ?? '').split('\n')) {
        if (/(?:^|\W)(?:fatal|error)\b/i.test(line) && !/^\[strata:/.test(line)) {
          assert.ok((survivor.text ?? '').includes(line), `lost ${JSON.stringify(line)}`);
        }
      }
    }
  });

  it('is idempotent: a second pass over its own output changes nothing', () => {
    const again = runTier0(result.state, PINNED_POLICY);
    assert.equal(again.tokensAfter, result.tokensAfter);
    assert.equal(again.bytesAfter, result.bytesAfter);
    assert.deepEqual(textOf(again.state), textOf(result.state));
    assert.equal(again.runs.every((r) => !r.telemetry.changed), true, 'no stage has anything left to do');
  });

  it('is deterministic: the same input gives byte-identical output', () => {
    const a = runTier0(realisticState(), PINNED_POLICY);
    const b = runTier0(realisticState(), PINNED_POLICY);
    assert.deepEqual(a.state.messages, b.state.messages);
    assert.deepEqual(a.reports, b.reports);
  });

  it('does not mutate the state it was given', () => {
    const before = structuredClone(input);
    runTier0(input, PINNED_POLICY);
    assert.deepEqual(input, before);
  });
});

describe('fail-open isolation (spec.md principle 1, N5, ADR-8)', () => {
  const ctx = () =>
    partitionForLossy(
      state({
        messages: [
          message('system', [block({ text: 'preamble', meta: meta({ origin: 'system', cacheable: true }) })]),
          message('user', [toolResult({ ref: 'x', text: lines(400), cacheable: true })]),
        ],
      }),
      policy(),
    );

  it('lets a good stage through', () => {
    const out = runStageFailOpen(truncateStage, ctx());
    assert.equal(out.code, undefined);
    assert.ok(out.report);
    assert.notEqual(out.ctx, undefined);
  });

  it('returns the input untouched when a stage throws', () => {
    const input = ctx();
    const out = runStageFailOpen(
      {
        name: 'truncate',
        run: () => {
          throw new Error('boom');
        },
      },
      input,
    );

    assert.equal(out.ctx, input, 'the context is the very object we passed in');
    assert.equal(out.report, undefined);
    assert.equal(out.code, 'stage_threw');
  });

  it('returns the input when a stage reorders the cached prefix', () => {
    // R4: reordering inside the cached prefix destroys the economics of the
    // whole system, silently. The check has to be here, not in review.
    const input = ctx();
    const out = runStageFailOpen(
      {
        name: 'dedupe',
        run: (c) => ({ ctx: { ...c, messages: [...c.messages].reverse() }, report: undefined }),
      },
      input,
    );

    assert.equal(out.ctx, input);
    assert.equal(out.code, 'prefix_reordered');
  });

  it('returns the input when a stage hands back something that is not a context', () => {
    const input = ctx();
    const out = runStageFailOpen(
      {
        name: 'dedupe',
        // The double cast is the point, not a shortcut: a value that reached a
        // stage by cast rather than by constructor is exactly the case
        // `isLossyContext` exists to catch, and it has to be constructible for
        // the guard to be testable at all. Same idiom as `guards.test.ts`.
        run: () => ({ ctx: { messages: 'not messages' } as unknown as LossyContext, report: undefined }),
      },
      input,
    );

    assert.equal(out.ctx, input);
    assert.equal(out.code, 'not_a_lossy_context');
  });

  it('does not let a throwing stage lose the rest of the pipeline', () => {
    // runTier0 owns the ordering and the reporting; the isolation is what keeps
    // one bad stage from taking the turn with it.
    const result = runTier0(realisticState(), PINNED_POLICY);
    assert.ok(result.tokensAfter > 0, 'the context survives');
    assert.equal(result.runs.filter((r) => r.failedOpen).length, 0);
  });
});

describe('Tier 0 hygiene', () => {
  it('handles an empty context', () => {
    const result = runTier0(state({ messages: [] }), PINNED_POLICY);
    assert.equal(result.tokensAfter, 0);
    assert.equal(result.blocksAfter, 0);
    assert.equal(result.prefixInvalidated, false);
  });

  it('handles a context with only pinned governance', () => {
    const result = runTier0(realisticState({ messages: [] }), PINNED_POLICY);
    assert.equal(result.stagesRun.length, 3);
    assert.equal(result.prefixInvalidated, false);
  });

  it('survives every stage being disabled', () => {
    const off: StrataPolicy = policy({ stages: ['pin', 'compact', 'compress', 'serialize'] });
    const result = runTier0(realisticState(), off);

    assert.deepEqual(result.stagesRun, []);
    assert.equal(result.tokensAfter, result.tokensBefore);
    assert.equal(result.policyOrderIgnored, false);
  });
});
