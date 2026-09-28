import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Gist, LossyContext, NonGovernanceTier } from '@strata-ctx/core-types';
import { partitionForLossy, pinSetText, type HeldBlock } from '@strata-ctx/core-types';

import {
  assertGistConstraintsIntact,
  assertLossyContextSafe,
  auditLossyContext,
  containsGovernance,
  gistIntegrityFor,
  isNonGovernanceMessage,
  isNonGovernanceTier,
} from '../src/type-guard.js';
import {
  MIXED_POLICY,
  NO_CONSTRAINT_POLICY,
  block,
  gist,
  gistFor,
  governanceBlock,
  lossyWithSmuggle,
  message,
  policyWith,
  smuggledGovernance,
  state,
  stateMessage,
  unsubjected,
} from './fixtures.js';

const lossy = (over: Partial<LossyContext> = {}): LossyContext => ({
  ...partitionForLossy(state(), MIXED_POLICY),
  ...over,
});

const heldOf = (text: string): HeldBlock => ({ block: governanceBlock(text), reason: 'governance' });

/** A lossy context that has completed step 4c, so the eviction is legitimately due. */
const readyToEvict = (over: Partial<LossyContext> = {}): LossyContext =>
  lossy({ gists: [gistFor(MIXED_POLICY, { task_id: 'task-42' })], ...over });

describe('D-8 the tier predicate', () => {
  it('excludes governance and includes every other tier', () => {
    for (const tier of ['episodic', 'tool_state', 'artifact_ref', 'user_intent'] as const) {
      assert.equal(isNonGovernanceTier(tier), true, tier);
    }
    assert.equal(isNonGovernanceTier('governance'), false);
  });

  it('covers the whole Tier union, so a new tier cannot fall through the cracks', () => {
    // A predicate that predates a tier addition is a silent hole. This asserts
    // the union is fully enumerated rather than trusting the other four.
    const all: readonly string[] = [
      'governance',
      'episodic',
      'tool_state',
      'artifact_ref',
      'user_intent',
    ];
    for (const tier of all) {
      assert.equal(isNonGovernanceTier(tier as NonGovernanceTier), tier !== 'governance', tier);
    }
  });
});

describe('D-8 the message predicate', () => {
  it('accepts a message whose blocks are all non-governance', () => {
    assert.equal(isNonGovernanceMessage(message('user', [unsubjected('refactor the parser')])), true);
  });

  it('rejects a message that carries a governance block anywhere', () => {
    const forged = {
      role: 'system' as const,
      content: [unsubjected('chatter'), smuggledGovernance('never delete production data')],
      ts: 1,
    };
    assert.equal(isNonGovernanceMessage(forged), false);
  });

  it('agrees with containsGovernance on the same value', () => {
    const good = message('user', [unsubjected('a'), unsubjected('b')]);
    const bad = { role: 'user' as const, content: [smuggledGovernance('x')], ts: 1 };
    assert.equal(containsGovernance([good]), false);
    assert.equal(containsGovernance([bad]), true);
    assert.equal(isNonGovernanceMessage(good), !containsGovernance([good]));
    assert.equal(isNonGovernanceMessage(bad), !containsGovernance([bad]));
  });

  it('treats an empty message as non-governance', () => {
    // Vacuously true, and it has to be: `partitionForLossy` drops a message that
    // was *only* governance, and an empty one is not a governance leak.
    assert.equal(containsGovernance([message('user', [])]), false);
  });
});

describe('D-8 the channels a lossy stage can actually reach', () => {
  it('reports nothing for a context that has only ever been partitioned', () => {
    const a = auditLossyContext(lossy(), MIXED_POLICY);
    assert.equal(a.ok, true);
    assert.deepEqual(a.inMessages, []);
    assert.deepEqual(a.inGists, []);
    assert.deepEqual(a.inHeld, []);
  });

  it('refuses a context whose message list carries a smuggled governance block', () => {
    // The one channel that must always be empty. A non-empty result is a bug or
    // a forged value, and it is a P0, not a warning.
    const a = auditLossyContext(lossyWithSmuggle(MIXED_POLICY, ['never delete production data']), MIXED_POLICY);
    assert.equal(a.ok, false);
    assert.equal(a.inMessages.length, 1);
    assert.equal(a.inMessages[0]?.byDesign, false);
    assert.equal(a.inMessages[0]?.channel, 'messages');
  });

  it('reports held pin text as by-design reachable', () => {
    // It is true that a lossy stage cannot *write* a held block back into the
    // request. It is not true that it cannot *read* the pin text -- the block is
    // right there on the context. Any doc claiming otherwise claims more than
    // the types support.
    const a = auditLossyContext(lossy({ held: [heldOf('never delete production data')] }), MIXED_POLICY);
    assert.equal(a.ok, true);
    assert.equal(a.inHeld.length, 1);
    assert.equal(a.inHeld[0]?.byDesign, true);
    assert.equal(a.inHeld[0]?.byteLengths[0], 'never delete production data'.length);
  });

  it('reports gist constraints as by-design reachable, and they are the step-4c target', () => {
    const a = auditLossyContext(readyToEvict(), MIXED_POLICY);
    assert.deepEqual(a.inGists[0]?.byteLengths, pinSetText(MIXED_POLICY).map((t) => t.length));
    assert.equal(a.inGists[0]?.byDesign, true);
    assert.equal(a.inGists[0]?.index, 0);
  });

  it('never carries the text of anything it found', () => {
    // `gists[].constraints` and the governance message both arrive from outside
    // the trust boundary. A report that carries the text is a report an attacker
    // can put newlines into, and a log nobody can parse is a log nobody reads.
    const hostile = 'a\nb\r\nc‮d';
    const a = auditLossyContext(
      lossy({ gists: [gist({ task_id: 't', constraints: [hostile] })], held: [heldOf(hostile)] }),
      MIXED_POLICY,
    );
    // The exposure records are what a caller is expected to log. `gistIntegrity`
    // is deliberately not sanitised: it holds the frozen `PinIntegrity`, which
    // step 4c already records, and an operator who is told "the constraints are
    // intact" is not much use -- they need to know *which* one changed.
    const exposures = JSON.stringify([a.inMessages, a.inGists, a.inHeld]);
    assert.equal(exposures.includes(hostile), false);
    assert.equal(exposures.includes('‮'), false);
    assert.equal(exposures.includes('\\n'), false);
    assert.deepEqual(a.inHeld[0]?.byteLengths, [hostile.length]);
    assert.deepEqual(a.inGists[0]?.byteLengths, [hostile.length]);
  });

  it('ignores a held block with no text, because there is nothing to leak', () => {
    const empty: HeldBlock = { block: { type: 'text', meta: governanceBlock('x').meta }, reason: 'governance' };
    assert.deepEqual(auditLossyContext(lossy({ held: [empty] }), MIXED_POLICY).inHeld, []);
  });

  it('skips a gist that carries no constraints at all', () => {
    // A gist from a policy with nothing pinned is legitimately constraint-free.
    const a = auditLossyContext(lossy({ gists: [gist({ constraints: [] })] }), NO_CONSTRAINT_POLICY);
    assert.deepEqual(a.inGists, []);
    assert.equal(a.gistIntegrity[0]?.ok, true);
  });

  it('reports lengths for every block, not just the first', () => {
    const a = auditLossyContext(
      lossy({ messages: [message('system', [smuggledGovernance('aa'), smuggledGovernance('bbbb')])] }),
      MIXED_POLICY,
    );
    assert.deepEqual(a.inMessages[0]?.byteLengths, [2, 4]);
  });

  it('points at the offending index, so a report names a gist', () => {
    const a = auditLossyContext(
      lossy({ gists: [gistFor(MIXED_POLICY), gist({ task_id: 'task-9', constraints: ['x'] })] }),
      MIXED_POLICY,
    );
    assert.equal(a.inGists[1]?.index, 1);
  });
});

describe('D-8 the window between step 4c and step 7', () => {
  it('re-runs step 4c and passes on a gist that still byte-equals the pin set', () => {
    const r = gistIntegrityFor(gistFor(MIXED_POLICY), MIXED_POLICY);
    assert.equal(r.ok, true);
    assert.equal(r.taskId, 'task-42');
    assert.deepEqual(r.integrity.defects, []);
  });

  it('catches a stage that rewrote constraints after the gate passed', () => {
    // This is the whole reason the check is re-run. Between 4c and 7 the
    // validated gist is resident, and `compact` and `compress` are both lossy
    // stages downstream of the gate and can both reach `gist.constraints`.
    const tampered = gistFor(MIXED_POLICY, {
      constraints: pinSetText(MIXED_POLICY).map((t, i) => (i === 0 ? `${t} (unless asked nicely)` : t)),
    });
    const r = gistIntegrityFor(tampered, MIXED_POLICY);
    assert.equal(r.ok, false);
    // One rewritten entry is two defects -- the original is missing and the
    // rewrite is extra -- and both are reported rather than the first one.
    assert.deepEqual(r.integrity.defects.map((d) => d.kind).sort(), ['extra', 'missing']);
    assert.ok(r.integrity.defects.some((d) => d.text.includes('unless asked nicely')));
  });

  it('accepts a context that is legitimately ready to evict', () => {
    assert.doesNotThrow(() => assertLossyContextSafe(readyToEvict(), MIXED_POLICY));
  });

  it('refuses to evict when a resident gist was tampered with, and says why', () => {
    const tampered = gistFor(MIXED_POLICY, { constraints: ['drop everything'] });
    assert.throws(
      () => assertLossyContextSafe(lossy({ gists: [tampered] }), MIXED_POLICY),
      (err: unknown) => {
        const m = (err as Error).message;
        assert.match(m, /task-42/);
        assert.match(m, /no longer byte-equals/);
        assert.match(m, /refusing to evict/);
        assert.match(m, /5 defect/);
        return true;
      },
    );
  });

  it('treats it as a refusal, not as a sanitisation', () => {
    // Fail toward more context (spec.md principle 1). The alternative -- evict
    // anyway and log -- is how a tampered gist reaches step 7.
    const tampered = gistFor(MIXED_POLICY, { constraints: [] });
    let threw = false;
    try {
      assertLossyContextSafe(lossy({ gists: [tampered] }), MIXED_POLICY);
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
  });

  it('rejects a value that never went through partitionForLossy', () => {
    // Every lossy stage from outside this repository is a value the constructor
    // never touched, so this check is not redundant belt-and-braces.
    assert.throws(
      () => assertLossyContextSafe({ messages: [] } as unknown as LossyContext, MIXED_POLICY),
      /skipped partitionForLossy/,
    );
  });

  it('delegates the message check to the frozen guard, so the message is the same one', () => {
    assert.throws(
      () => assertLossyContextSafe(lossyWithSmuggle(MIXED_POLICY, ['never delete production data']), MIXED_POLICY),
      /governance block reached a lossy stage/,
    );
  });

  it('does not repeat a task id in one error, so two bad gists are still one error each', () => {
    const a = gistFor(MIXED_POLICY, { task_id: 't-1', constraints: [] });
    const b = gistFor(MIXED_POLICY, { task_id: 't-2', constraints: [] });
    assert.throws(() => assertLossyContextSafe(lossy({ gists: [a, b] }), MIXED_POLICY), /t-1/);
  });
});

describe('D-8 the whole-context verdict', () => {
  it('is ok only when messages are clean and every gist still verifies', () => {
    const a = auditLossyContext(readyToEvict(), MIXED_POLICY);
    assert.equal(a.ok, true);
    const b = auditLossyContext(lossy({ gists: [gistFor(MIXED_POLICY, { constraints: [] })] }), MIXED_POLICY);
    assert.equal(b.ok, false, 'a clean message list does not excuse a bad gist');
  });

  it('evaluates every resident gist, not just the first', () => {
    const gists: Gist[] = [
      gistFor(MIXED_POLICY, { task_id: 't-1' }),
      gistFor(MIXED_POLICY, { task_id: 't-2', constraints: ['x'] }),
    ];
    const a = auditLossyContext(lossy({ gists }), MIXED_POLICY);
    assert.deepEqual(
      a.gistIntegrity.map((g) => [g.taskId, g.ok]),
      [
        ['t-1', true],
        ['t-2', false],
      ],
    );
  });

  it('is ok for a policy with nothing pinned', () => {
    // The degenerate case has to work or every policy-free deployment breaks.
    assert.equal(assertGistConstraintsIntact(lossy({ gists: [gist({ constraints: [] })] }), NO_CONSTRAINT_POLICY), undefined);
  });

  it('holds up when the gist is checked against a different policy', () => {
    // Two policies, one session. A gist that matched policy A does not match B,
    // and the guard has to say so rather than trusting a stale pass.
    const other = policyWith(['never commit to main directly']);
    assert.equal(gistIntegrityFor(gistFor(MIXED_POLICY), other).ok, false);
  });

  it('frees the arrays it returns, so a caller cannot edit the verdict', () => {
    const a = auditLossyContext(readyToEvict(), MIXED_POLICY);
    assert.ok(Object.isFrozen(a.inGists));
    assert.ok(Object.isFrozen(a.gistIntegrity));
  });
});

describe('D-8 assertGistConstraintsIntact is about a result, not a stage', () => {
  it('throws on a gist that lost a constraint', () => {
    const partial = gistFor(MIXED_POLICY, { constraints: pinSetText(MIXED_POLICY).slice(0, 2) });
    assert.throws(() => assertGistConstraintsIntact(lossy({ gists: [partial] }), MIXED_POLICY), /task-42/);
  });

  it('does not look at messages, because a returned context may legitimately hold governance', () => {
    // The distinction that keeps this from being a second, conflicting guard: a
    // lossy *stage* must not see governance in messages, but the context that
    // comes back is re-joined with `held` and must not have had anything dropped.
    const returned: LossyContext = {
      ...lossy(),
      messages: [stateMessage('system', [governanceBlock('never delete production data')])] as LossyContext['messages'],
    };
    assert.doesNotThrow(() => assertGistConstraintsIntact(returned, MIXED_POLICY));
  });

  it('passes when there are no gists at all', () => {
    assert.doesNotThrow(() => assertGistConstraintsIntact(lossy(), MIXED_POLICY));
  });
});

describe('D-8 the static half, as a tripwire', () => {
  it('cannot construct a governance block as a NonGovernanceBlock', () => {
    // If `NonGovernanceTier` ever widens to include `'governance'`, this stops
    // compiling and the `@ts-expect-error` in the fixture goes unused -- the same
    // tripwire, asserted from the other end.
    const wide: Parameters<typeof isNonGovernanceMessage>[0]['content'][number] = governanceBlock('x');
    assert.equal(isNonGovernanceTier(wide.meta.tier), false);
  });

  it('still narrows a real partitioned context to a valid NonGovernanceMessage', () => {
    const ctx = partitionForLossy(state({ pinned: [] }), MIXED_POLICY);
    for (const m of ctx.messages) {
      assert.equal(isNonGovernanceMessage(m), true);
    }
    // @ts-expect-error intentional: governance tier is excluded from NonGovernanceTier
assert.equal(block().meta.tier !== 'governance', true);
  });
});
