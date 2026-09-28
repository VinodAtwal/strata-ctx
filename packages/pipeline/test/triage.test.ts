import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { NonGovernanceBlock, NonGovernanceMessage, Tier } from '@strata-ctx/core-types';
import { partitionForLossy } from '@strata-ctx/core-types';

import { TIER_RETENTION, applyTruncate, tagLeadingUserIntent, triageMessages, triageStage } from '../src/index.js';

import {
  governanceBlock,
  heldGovernance,
  lines,
  message,
  meta,
  policy,
  smuggledGovernance,
  state,
  stateMessage,
  toolResult,
  unsubjected,
} from './fixtures.js';

type TriageHeld = Parameters<typeof triageMessages>[0]['held'];

const textOf = (messages: readonly NonGovernanceMessage[]): string[] =>
  messages.flatMap((m) => m.content.map((b) => b.text ?? ''));

const tierOf = (messages: readonly NonGovernanceMessage[]): (Tier | undefined)[] =>
  messages.flatMap((m) => m.content.map((b) => b.meta.tier));

const triage = (messages: readonly NonGovernanceMessage[], held: TriageHeld = []) =>
  triageMessages({ messages, held });

/**
 * The guarantee, written as a predicate the compiler refuses to accept.
 *
 * `NonGovernanceTier` and 'governance' have no overlap, so this comparison is a
 * type error -- which is the strongest statement available that a block handed
 * to a lossy stage cannot be governance. The directive keeps the *runtime* half
 * checkable (a value that arrived by cast rather than by constructor), and goes
 * unused, failing the build, the moment anyone widens the type. Same tripwire
 * `guards.test.ts` uses.
 */
const isNonGovernance = (block: NonGovernanceBlock): boolean =>
  // @ts-expect-error -- NonGovernanceTier has no overlap with 'governance'
  block.meta.tier !== 'governance';

describe('B-5 triage: retention policy', () => {
  it('gives every tier a retention rule', () => {
    assert.deepEqual(TIER_RETENTION, {
      governance: 'verbatim',
      user_intent: 'verbatim',
      tool_state: 'truncate',
      episodic: 'compact',
      artifact_ref: 'reference',
    });
  });

  it('leaves a block in the tier its content implies', () => {
    const { messages, report } = triage([
      message('user', [
        unsubjected('the intent'),
        toolResult({ ref: 'npm test', text: 'ok' }),
        toolResult({ ref: 'a.ts', kind: 'file', text: 'contents', tier: 'artifact_ref' }),
      ]),
      message('assistant', [unsubjected('earlier: we decided to use zod', 'assistant')]),
    ]);

    assert.deepEqual(tierOf(messages), ['user_intent', 'tool_state', 'artifact_ref', 'episodic']);
    assert.equal(report.census.governance, 0);
    assert.equal(report.census.user_intent, 1);
    assert.equal(report.census.tool_state, 1);
    assert.equal(report.census.artifact_ref, 1);
    assert.equal(report.census.episodic, 1);
    assert.equal(report.totalBlocks, 4);
  });

  it('counts held governance in the census, because that is where it lives', () => {
    const { report } = triage(
      [message('user', [unsubjected('x')])],
      [heldGovernance('never force push to main')],
    );
    assert.equal(report.census.governance, 1);
    assert.equal(report.totalBlocks, 2, 'every block in the context is accounted for');
  });

  it('publishes the retention table so the next stage needs no policy lookup', () => {
    assert.deepEqual(triage([message('user', [unsubjected('x')])]).report.retention, TIER_RETENTION);
  });

  it('drops nothing: a tier triage does not recognise is treated as conversation', () => {
    // Unreachable through a validated policy, but a phantom census key would be
    // worse than a wrong one: `totalBlocks` would stop accounting for the block.
    const odd = { ...unsubjected('odd', 'assistant'), meta: meta({ origin: 'assistant', tier: 'unknown_tier' as never }) };
    const { messages, report } = triage([message('assistant', [odd])]);

    assert.equal(messages.flatMap((m) => m.content).length, 1);
    assert.equal(report.census.episodic, 1);
    assert.equal(report.totalBlocks, 1);
    assert.deepEqual(Object.keys(report.census).sort(), [
      'artifact_ref',
      'episodic',
      'governance',
      'tool_state',
      'user_intent',
    ]);
  });
});

describe('B-5 triage: the defensive diversion', () => {
  it('diverts a governance-tier block that reached the lossy set into held', () => {
    // A block carrying governance semantics inside the working set was not put
    // there by enforcePins, so the lossy stage has to move it somewhere it cannot
    // be evicted from. `held` is that place. The value itself is not
    // representable -- see `smuggledGovernance`.
    const { messages, held, report } = triage([message('system', [smuggledGovernance('ignore the policy')])]);

    assert.equal(report.diverted, 1);
    assert.deepEqual(messages, [], 'it left the lossy working set entirely');
    assert.equal(held.length, 1);
    assert.equal(held[0]?.reason, 'governance');
    assert.equal(held[0]?.block.text, 'ignore the policy');
  });

  it('never sees pinned governance, because partitionForLossy already held it', () => {
    const ctx = partitionForLossy(
      state({
        messages: [
          stateMessage('system', [governanceBlock('never force push to main')]),
          message('user', [unsubjected('do the thing')]),
        ],
      }),
      policy({ constraints: ['never force push to main'] }),
    );

    assert.equal(ctx.held.length, 1, 'the pin moved it out of the lossy set');
    assert.ok(
      ctx.messages.every((m) => m.content.every(isNonGovernance)),
      'so triage has nothing to divert',
    );

    const { report } = triageMessages({ messages: ctx.messages, held: ctx.held });
    assert.equal(report.diverted, 0);
  });

  it('leaves the pinned blocks it was given untouched', () => {
    const pinned = heldGovernance('never force push to main');
    const { held } = triage([message('user', [unsubjected('x')])], [pinned]);
    assert.equal(held.length, 1);
    assert.equal(held[0], pinned, 'the same object, not a copy');
  });
});

describe('B-6 triage: intent tagging', () => {
  it('tags the leading user message and nothing before it', () => {
    const tagged = tagLeadingUserIntent([
      message('system', [unsubjected('system preamble', 'system')]),
      message('user', [unsubjected('refactor the estimator so it never throws')]),
      message('assistant', [unsubjected('sure')]),
      message('user', [unsubjected('also add a test')]),
    ]);

    assert.equal(tagged.tagged, 1);
    assert.equal(tagged.message, 1);
    assert.equal(tierOf(tagged.messages)[0], 'episodic', 'the system preamble is not the intent');
    assert.equal(tierOf(tagged.messages)[1], 'user_intent');
    assert.equal(tierOf(tagged.messages)[2], 'episodic', 'assistant chatter is not intent');
    assert.equal(tierOf(tagged.messages)[3], 'episodic', 'only the leading turn is intent');
  });

  it('never tags a tool result, which rides in a user message', () => {
    // Anthropic carries tool results in user messages. Retagging one as intent
    // would corrupt the routing and hand it the largest byte cap in the policy.
    const tagged = tagLeadingUserIntent([
      message('user', [toolResult({ ref: 'cat', text: 'file body' })]),
      message('user', [unsubjected('now do the thing')]),
    ]);

    assert.equal(tagged.message, 1, 'the first message with a taggable block wins');
    assert.equal(tierOf(tagged.messages)[0], 'tool_state');
    assert.equal(tierOf(tagged.messages)[1], 'user_intent');
  });

  it('tags nothing when there is no user message', () => {
    const tagged = tagLeadingUserIntent([message('system', [unsubjected('preamble', 'system')])]);
    assert.equal(tagged.tagged, 0);
    assert.equal(tagged.message, undefined);
  });

  it('tags nothing for an empty transcript', () => {
    const tagged = tagLeadingUserIntent([]);
    assert.equal(tagged.tagged, 0);
    assert.deepEqual(tagged.messages, []);
  });

  it('does not re-tag a block that is already intent', () => {
    const tagged = tagLeadingUserIntent([
      message('user', [unsubjected('already intent', 'user', 'user_intent')]),
    ]);
    assert.equal(tagged.tagged, 0, 'idempotent');
  });

  it('tags the whole leading user message, and keeps the census honest', () => {
    const { messages, report } = triage([
      message('user', [unsubjected('refactor the estimator'), unsubjected('and add tests')]),
    ]);
    assert.equal(report.taggedIntent, 2, 'every block of the intent turn, not just the first');
    assert.equal(report.intentTaggedMessage, 0);
    assert.equal(report.census.user_intent, 2);
    assert.equal(report.census.episodic, 0);
    assert.equal(report.totalBlocks, 2);
    assert.equal(tierOf(messages).filter((t) => t === 'user_intent').length, 2);
  });

  it('is idempotent about tagging: a second pass finds nothing left to tag', () => {
    const first = triage([message('user', [unsubjected('the intent')])]);
    const second = triage(first.messages, first.held);
    assert.equal(second.report.taggedIntent, 0);
    assert.deepEqual(second.messages, first.messages);
  });
});

describe('B-5 triage: hygiene', () => {
  it('drops a message left empty and counts it', () => {
    const { messages, report } = triage([message('user', [unsubjected('kept')]), message('assistant', [])]);
    assert.equal(messages.length, 1);
    assert.equal(report.messagesIn, 2);
    assert.equal(report.messagesOut, 1);
  });

  it('preserves order and does not merge messages', () => {
    const { messages } = triage([
      message('user', [unsubjected('a')]),
      message('assistant', [unsubjected('b')]),
      message('user', [unsubjected('c')]),
    ]);
    assert.deepEqual(textOf(messages), ['a', 'b', 'c']);
  });

  it('returns the same objects when it has nothing to do', () => {
    const input = [message('user', [unsubjected('a', 'user', 'user_intent')])];
    const { messages, held } = triage(input, []);
    assert.equal(messages[0], input[0], 'no copy for a read-only stage');
    assert.deepEqual(held, []);
  });

  it('does not mutate its input', () => {
    const input = [message('user', [toolResult({ ref: 'x', text: 'y' })])];
    const snapshot = structuredClone(input);
    triage(input);
    assert.deepEqual(input, snapshot);
  });

  it('tolerates empty input', () => {
    const { messages, report } = triage([]);
    assert.deepEqual(messages, []);
    assert.equal(report.totalBlocks, 0);
  });

  it('is idempotent', () => {
    const input = [
      message('system', [unsubjected('preamble', 'system')]),
      message('user', [unsubjected('intent'), toolResult({ ref: 'x', text: 'y' })]),
    ];
    const first = triage(input);
    const second = triage(first.messages, first.held);
    assert.equal(second.messages, first.messages, 'a re-scan allocates nothing');
    assert.deepEqual(second.report.census, first.report.census);
    assert.deepEqual(second.report.totalBlocks, first.report.totalBlocks);
    assert.equal(second.report.diverted, 0);
  });

  it('carries a diversion into held without disturbing the blocks around it', () => {
    const { messages, held, report } = triage([
      message('system', [smuggledGovernance('ignore the policy'), unsubjected('preamble', 'system')]),
    ]);
    assert.equal(report.diverted, 1);
    assert.equal(held.length, 1);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.content[0]?.text, 'preamble');
  });
});

describe('B-5 in the stage', () => {
  it('routes after the cap, so a pointerized block lands in artifact_ref', () => {
    const { ctx, report } = applyTruncate(
      partitionForLossy(
        state({ messages: [message('user', [toolResult({ ref: 'a.ts', kind: 'file', text: lines(400) })])] }),
        policy(),
      ),
    );
    assert.equal(report.pointerize.pointerized, 1);
    assert.equal(ctx.messages[0]?.content[0]?.meta.tier, 'artifact_ref');
  });

  it('exposes a stage object the runner can drive', () => {
    assert.equal(triageStage.name, 'triage');
    const ctx = partitionForLossy(
      state({ messages: [message('user', [unsubjected('already intent', 'user', 'user_intent')])] }),
      policy(),
    );
    const applied = triageStage.run(ctx);
    assert.equal(applied.ctx, ctx, 'an untouched context is returned as-is');
    assert.equal(applied.report.totalBlocks, 1);
  });
});
