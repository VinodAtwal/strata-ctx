import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Message, Role, TriggerPolicy } from '@strata-ctx/core-types';
import { estimateMessageTokens } from '@strata-ctx/core-types';

import { compactableFrom, isTailProtected, recencyTail } from '../src/index.js';

import { block, lines, message, meta } from './fixtures.js';

const TRIGGER: Pick<TriggerPolicy, 'keepRecentTokens' | 'userMessageTailTokens'> = {
  keepRecentTokens: 200,
  userMessageTailTokens: 600,
};

const say = (role: Role, text: string, tier: 'episodic' | 'tool_state' = 'episodic'): Message =>
  message(role, [block({ text, meta: meta({ origin: role, tier, bytes: text.length }) })]);

/** A transcript of `count` alternating messages, each roughly `chars` long. */
const transcript = (count: number, chars = 400): Message[] =>
  Array.from({ length: count }, (_, i) => say(i % 2 === 0 ? 'user' : 'assistant', lines(20, `m${i} `).padEnd(chars, 'x')));

const cost = (m: Message): number => estimateMessageTokens(m);

describe('B-6 recency: the recency tail', () => {
  it('protects a contiguous suffix that fits the budget', () => {
    const messages = transcript(10);
    const tail = recencyTail(messages, TRIGGER);

    assert.ok(!tail.entireContext);
    assert.ok(tail.protectedFromIndex > 0, 'something is evictable');
    assert.deepEqual(
      tail.tailMessages,
      Array.from({ length: messages.length - tail.protectedFromIndex }, (_, i) => tail.protectedFromIndex + i),
    );
    assert.ok(tail.keptTokens <= TRIGGER.keepRecentTokens + cost(messages[messages.length - 1]!));
  });

  it('reports that the whole context fits when it does', () => {
    const tail = recencyTail(transcript(2, 20), { keepRecentTokens: 100_000, userMessageTailTokens: 100_000 });
    assert.equal(tail.entireContext, true);
    assert.equal(tail.protectedFromIndex, 0);
  });

  it('always keeps the newest message, even when it alone exceeds the budget', () => {
    // Dropping the turn the agent is currently in is the worst outcome available,
    // and a cap that cannot be honoured is a fact to report, not a reason to
    // delete the present.
    const huge = say('assistant', lines(4000, 'x'));
    const tail = recencyTail([say('user', 'older'), huge], { keepRecentTokens: 10, userMessageTailTokens: 0 });

    assert.equal(tail.protectedFromIndex, 1);
    assert.deepEqual(tail.tailMessages, [1]);
    assert.ok(tail.keptTokens > 10, 'and the report shows the budget was blown');
  });

  it('handles an empty transcript without inventing a boundary', () => {
    const tail = recencyTail([], TRIGGER);
    assert.equal(tail.protectedFromIndex, 0);
    assert.equal(tail.entireContext, false);
    assert.deepEqual(tail.tailMessages, []);
    assert.equal(tail.keptTokens, 0);
  });
});

describe('B-6 recency: the user tail', () => {
  it('protects user turns that reach below the recency tail', () => {
    // Command-window loss: the instruction the agent was given has scrolled out
    // of the recency window but the newest user turns are still worth their
    // bytes.
    const messages = transcript(12);
    const tail = recencyTail(messages, { keepRecentTokens: 100, userMessageTailTokens: 100_000 });

    assert.ok(tail.userProtectedFromIndex < tail.protectedFromIndex, 'the user budget reaches further back');
    assert.ok(tail.tailUserMessages.includes(0));
    for (const i of tail.tailUserMessages) {
      assert.equal(messages[i]?.role, 'user');
    }
  });

  it('always keeps the newest user turn, even mid-turn', () => {
    // The last message is a tool result here, so the agent is still executing an
    // instruction. That instruction is what command-window loss takes first.
    const messages = [
      say('user', lines(3000, 'the original instruction')),
      say('assistant', 'working on it'),
      say('user', lines(3000, 'and now this')),
      say('assistant', 'still working'),
    ];
    const tail = recencyTail(messages, { keepRecentTokens: 1, userMessageTailTokens: 1 });

    assert.equal(tail.userProtectedFromIndex, 2, 'the newest user turn survives an exhausted budget');
    assert.ok(tail.keptUserTokens > 1);
  });

  it('leaves a transcript with no user messages with nothing to protect', () => {
    const tail = recencyTail([say('assistant', 'a'), say('assistant', 'b')], {
      keepRecentTokens: 1,
      userMessageTailTokens: 1000,
    });
    assert.deepEqual(tail.tailUserMessages, []);
  });
});

describe('B-6 recency: the predicate compact consumes', () => {
  it('protects the recency suffix regardless of role', () => {
    const messages = transcript(10);
    const tail = recencyTail(messages, TRIGGER);
    for (const i of tail.tailMessages) {
      const role = messages[i]?.role ?? 'user';
      assert.ok(isTailProtected(tail, i, role), `message ${i} is in the recency tail`);
    }
    for (let i = 0; i < tail.protectedFromIndex; i += 1) {
      const role = messages[i]?.role ?? 'user';
      if (!tail.tailUserMessages.includes(i)) {
        assert.ok(!isTailProtected(tail, i, role), `message ${i} is evictable`);
      }
    }
  });

  it('does not let the user budget protect the assistant turns in the gap', () => {
    // The bug this pins: `index >= userProtectedFromIndex` without a role check
    // protects every message in the gap, not just the user's.
    const messages = transcript(12);
    const tail = recencyTail(messages, { keepRecentTokens: 1, userMessageTailTokens: 100_000 });

    const userGap = tail.tailUserMessages.filter((i) => i < tail.protectedFromIndex);
    const assistantGap = Array.from({ length: messages.length }, (_, i) => i).filter(
      (i) => i < tail.protectedFromIndex && messages[i]?.role === 'assistant',
    );

    assert.ok(userGap.length > 0, 'the scenario has user turns in the gap');
    for (const i of userGap) assert.ok(isTailProtected(tail, i, 'user'));
    for (const i of assistantGap) {
      assert.ok(!isTailProtected(tail, i, 'assistant'), `assistant message ${i} must stay summarisable`);
    }
  });

  it('gives compact a prefix boundary and asks it to walk the rest', () => {
    const messages = transcript(12);
    const tail = recencyTail(messages, { keepRecentTokens: 1, userMessageTailTokens: 100_000 });
    const from = compactableFrom(tail, messages.length);

    assert.equal(from, tail.tailUserMessages[0], 'the first protected index');
    for (let i = 0; i < from; i += 1) {
      assert.ok(!isTailProtected(tail, i, messages[i]?.role ?? 'user'));
    }
  });

  it('clamps a boundary to the transcript it was given', () => {
    const tail = recencyTail(transcript(3, 10), TRIGGER);
    assert.equal(compactableFrom(tail, 0), 0);
    assert.ok(compactableFrom(tail, 2) <= 2);
  });
});
