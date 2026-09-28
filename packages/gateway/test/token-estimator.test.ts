import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ContentBlock, Message, Origin, Role } from '@strata-ctx/core-types';
import { sha256 } from '@strata-ctx/core-types';

import {
  DEFAULT_PROVIDER,
  MockTokenEstimator,
  TOKEN_PROVIDERS,
  countMessageTokens,
  estimateTokens,
  providerProfile,
  type TokenProvider,
} from '../src/token-estimator.js';

/* -------------------------------------------------------------------------- */
/* Fixtures -- local to this suite. Rule P2 (docs/development.md §2): nothing    */
/* here reaches into another package's test directory.                         */
/* -------------------------------------------------------------------------- */

const ORIGIN: Readonly<Record<Role, Origin>> = {
  system: 'system',
  user: 'user',
  assistant: 'assistant',
  tool: 'tool',
};

const blockOf = (type: ContentBlock['type'], text: string | undefined, origin: Origin): ContentBlock => ({
  type,
  // `exactOptionalPropertyTypes`: an absent `text` is not the same type as
  // `text: undefined`, so the key is spread in only when there is one.
  ...(text === undefined ? {} : { text }),
  meta: {
    origin,
    sha256: sha256(text ?? `${type}:none`),
    tier: 'episodic',
    bytes: text?.length ?? 0,
    cacheable: false,
  },
});

const textBlock = (text: string, origin: Origin = 'user'): ContentBlock => blockOf('text', text, origin);

/** A block with no text projection at all -- an image reference, say. */
const untypedBlock: ContentBlock = blockOf('image', undefined, 'user');

/** A message built from block *text*, one block per argument. */
const message = (role: Role, ...texts: readonly string[]): Message => ({
  role,
  ts: 0,
  content: texts.map((t) => textBlock(t, ORIGIN[role])),
});

/** A message built from ready-made blocks, for the block-level cases. */
const rawMessage = (role: Role, ...blocks: readonly ContentBlock[]): Message => ({
  role,
  ts: 0,
  content: blocks,
});

const convo = (text: string): Message[] => [message('user', text)];

/** 400 ASCII characters, long enough that the per-provider ratios actually diverge. */
const ASCII_400 = 'a'.repeat(400);
/** Three CJK ideographs: one code point each, three UTF-16 code units each. */
const CJK_3 = '日本語';
const EMOJI_100 = '😀'.repeat(100);

describe('A-6 estimateTokens', () => {
  it('is zero for an empty string, on every provider', () => {
    // A non-zero floor here would be charged once per request and quietly
    // inflate every budget, which is the kind of error that only shows up as
    // "compaction fires too early" weeks later.
    for (const provider of TOKEN_PROVIDERS) {
      assert.equal(estimateTokens('', provider), 0, provider);
    }
  });

  it('is an integer for any input, on every provider', () => {
    const samples = ['', 'a', 'abcd', ASCII_400, CJK_3, EMOJI_100, 'mixed 日本語 text 😀'];
    for (const provider of TOKEN_PROVIDERS) {
      for (const sample of samples) {
        const n = estimateTokens(sample, provider);
        assert.ok(Number.isInteger(n), `${provider}: ${JSON.stringify(sample)} -> ${n}`);
        assert.ok(n >= 0);
      }
    }
  });

  it('divides ASCII by the provider ratio and rounds up', () => {
    // Hardcoded rather than read from the profile table: a test that computes
    // its expectation from the implementation is a test that cannot fail.
    assert.equal(estimateTokens('abcde', 'anthropic'), 2); // ceil(5 / 3.5)
    assert.equal(estimateTokens('abcde', 'openai'), 2); // ceil(5 / 4)
    assert.equal(estimateTokens('abcde', 'gemini'), 2); // ceil(5 / 4.5)
    assert.equal(estimateTokens('abcd', 'anthropic'), 2); // ceil(4 / 3.5) is 2, not 1
  });

  it('gives the same ASCII text a different count per provider', () => {
    assert.equal(estimateTokens(ASCII_400, 'anthropic'), 115); // ceil(400 / 3.5)
    assert.equal(estimateTokens(ASCII_400, 'openai'), 100); // ceil(400 / 4)
    assert.equal(estimateTokens(ASCII_400, 'gemini'), 89); // ceil(400 / 4.5)
  });

  it('orders the providers densest-first, so the aggressive estimate is the safe one', () => {
    // Under-estimating a prompt means the trigger fires late and the request
    // dies on a context overflow. Over-estimating only costs a little money,
    // so the ordering is a safety property, not a preference.
    const dense = estimateTokens(ASCII_400, 'anthropic');
    const middle = estimateTokens(ASCII_400, 'openai');
    const sparse = estimateTokens(ASCII_400, 'gemini');
    assert.ok(dense > middle, `${dense} > ${middle}`);
    assert.ok(middle > sparse, `${middle} > ${sparse}`);
  });

  it('carries a positive, finite, distinct ratio for every provider it claims to support', () => {
    const ratios = TOKEN_PROVIDERS.map((p) => providerProfile(p).charsPerToken);
    for (const ratio of ratios) {
      assert.ok(ratio > 0 && Number.isFinite(ratio), `bad ratio ${ratio}`);
    }
    assert.equal(new Set(ratios).size, ratios.length, 'two providers share a ratio');
  });

  it('charges more per character for CJK than for ASCII', () => {
    // Three ASCII characters are one token on the densest provider; the same
    // three ideographs are two. A flat chars/token ratio would call them equal
    // and under-count every non-English session by a third.
    assert.equal(estimateTokens('abc', 'anthropic'), 1);
    assert.equal(estimateTokens(CJK_3, 'anthropic'), 2);
  });

  it('charges a CJK character less than the ASCII equivalent, not nothing', () => {
    // 1.5 per ideograph for Gemini, against 1.0 per ASCII character: a wide
    // vocabulary makes CJK cheap, not free.
    assert.equal(estimateTokens('日', 'gemini'), 1); // ceil(1.5 / 4.5)
    assert.equal(estimateTokens('日'.repeat(3), 'gemini'), 1); // ceil(4.5 / 4.5)
    assert.equal(estimateTokens('日'.repeat(4), 'gemini'), 2); // ceil(6 / 4.5)
  });

  it('counts an emoji once, as a code point, not twice as UTF-16 code units', () => {
    // The unit has to be stated because it changes the answer: 100 emoji are
    // 200 code units. Charged per code point they are 200 billable chars -> 58
    // tokens; charged per code unit they would be 400 -> 115, a 2x error on
    // exactly the input where a flat chars/token guess is most wrong.
    assert.equal(EMOJI_100.length, 200, 'the fixture is 100 code points');
    assert.equal(estimateTokens(EMOJI_100, 'anthropic'), 58);
  });

  it('mixes ASCII and non-ASCII by charging each its own weight', () => {
    // 2 ASCII + 3 ideographs at weight 2 = 8 billable chars; ceil(8 / 3.5) = 3.
    assert.equal(estimateTokens(`ab${CJK_3}`, 'anthropic'), 3);
  });

  it('scales a very long document linearly and stays exact', () => {
    // 3.5M characters, a size that divides by 3.5 with no remainder so the
    // linear claim is exact rather than "within a rounding". A per-character
    // implementation that is accidentally quadratic is the failure mode here,
    // and it is invisible at fixture size.
    const long = 'a'.repeat(3_500_000);
    const once = estimateTokens(long, 'anthropic');
    assert.equal(once, 1_000_000);
    assert.equal(estimateTokens(long + long, 'anthropic'), 2 * once);
    assert.ok(Number.isInteger(once));
  });

  it('falls back to the documented default for a provider it does not know', () => {
    // `upstream: openai-compat` is a legal value in strata-ctx.yaml and it is
    // not a typechecked call site. A bad ratio must not 502 a request the
    // gateway can otherwise serve, so it degrades to the default.
    const unknown = 'openai-compat' as TokenProvider;
    assert.equal(providerProfile(unknown).provider, DEFAULT_PROVIDER);
    assert.equal(estimateTokens(ASCII_400, unknown), estimateTokens(ASCII_400, DEFAULT_PROVIDER));
  });
});

describe('A-6 countMessageTokens', () => {
  it('is zero for an empty conversation and does not charge the reply priming', () => {
    // There is nothing to reply to, so the assistant preamble is not owed.
    for (const provider of TOKEN_PROVIDERS) {
      assert.equal(countMessageTokens([], provider), 0, provider);
    }
  });

  it('is content plus the block, message and reply overheads', () => {
    // 'abcd' = ceil(4 / 3.5) = 2 content, +3 block, +4 message, +3 reply.
    assert.equal(countMessageTokens(convo('abcd'), 'anthropic'), 12);
  });

  it('charges the message envelope once per message, not once per conversation', () => {
    // 9 per turn (2 content + 3 block + 4 message) x 2, plus one reply priming.
    const two = countMessageTokens([...convo('abcd'), ...convo('abcd')], 'anthropic');
    assert.equal(two, 21);
  });

  it('charges a block envelope per block', () => {
    // Two blocks of 'abcd': 2 content + 2*3 block + 4 message + 3 reply = 17.
    const split = countMessageTokens([message('user', 'abcd', 'abcd')], 'anthropic');
    assert.equal(split, 17);
  });

  it('is the sum of the messages', () => {
    const messages = [message('user', 'first turn'), message('assistant', 'second')];
    const parts = messages.map((m) => countMessageTokens([m], 'anthropic'));
    // Each part is charged its own reply priming and the whole is charged one
    // more, so the parts over-count by exactly one priming (3 tokens).
    assert.equal(countMessageTokens(messages, 'anthropic'), parts.reduce((a, b) => a + b, 0) - 3);
  });

  it('charges a message with no blocks its envelope and nothing else', () => {
    // An empty turn is still a turn on the wire: the role marker is real.
    assert.equal(countMessageTokens([message('system')], 'anthropic'), 7); // 4 + 3
  });

  it('charges an untextured block its envelope and no content', () => {
    // An image reference is not pixels. What we would be spending is the
    // envelope; pretending it is free is how an image-heavy session overflows.
    assert.equal(countMessageTokens([rawMessage('user', untypedBlock)], 'anthropic'), 10); // 3 + 4 + 3
  });

  it('gives the same conversation a different total per provider', () => {
    const messages = convo('abcd');
    assert.equal(countMessageTokens(messages, 'anthropic'), 12);
    assert.equal(countMessageTokens(messages, 'openai'), 9); // 1 + 2 + 3 + 3
    assert.equal(countMessageTokens(messages, 'gemini'), 6); // 1 + 1 + 2 + 2
  });

  it('never charges a conversation less than its own text would cost', () => {
    // The envelope is the floor, not a discount: adding a provider's overhead
    // on top of content that is already non-zero can only go up.
    for (const provider of TOKEN_PROVIDERS) {
      const flat = convo(ASCII_400);
      assert.ok(
        countMessageTokens(flat, provider) >= estimateTokens(ASCII_400, provider),
        provider,
      );
    }
  });
});

describe('A-6 determinism', () => {
  it('returns the same number every time for the same input', () => {
    for (const provider of TOKEN_PROVIDERS) {
      const runs = new Set(Array.from({ length: 50 }, () => estimateTokens(ASCII_400, provider)));
      assert.equal(runs.size, 1, `${provider} produced ${[...runs].join(', ')}`);
    }
  });

  it('does not depend on evaluation order or on how many calls preceded it', () => {
    // A fresh estimate of the same text has to be the same number whether it is
    // the first call in the process or the hundredth, or a compaction trigger
    // becomes un-reproducible between a dev session and a test.
    const before = estimateTokens(ASCII_400, 'gemini');
    for (const junk of [CJK_3, '', EMOJI_100, ASCII_400]) estimateTokens(junk, 'anthropic');
    assert.equal(estimateTokens(ASCII_400, 'gemini'), before);
  });

  it('is deterministic for a whole conversation too', () => {
    const messages = [
      message('system', 'you are a coding agent'),
      message('user', 'refactor the uploader'),
      message('assistant', 'on it'),
    ];
    const runs = new Set(TOKEN_PROVIDERS.map((p) => countMessageTokens(messages, p)));
    assert.equal(runs.size, TOKEN_PROVIDERS.length);
    assert.deepEqual(
      TOKEN_PROVIDERS.map((p) => countMessageTokens(messages, p)),
      TOKEN_PROVIDERS.map((p) => countMessageTokens(messages, p)),
    );
  });

  it('hands out frozen profiles, so no caller can retune the shared table', () => {
    // If a profile were mutable, one test that nudged a constant would move the
    // budget for every other test in the process, and the failure would land in
    // a package that never touched the estimator.
    const profile = providerProfile('anthropic');
    assert.ok(Object.isFrozen(profile));
    assert.equal(providerProfile('anthropic'), profile, 'stable identity');
  });

  it('gives every provider it exports a profile that names itself', () => {
    // A profile reached by the wrong key would silently carry another
    // provider's ratio, which is the one bug no estimate comparison catches.
    for (const provider of TOKEN_PROVIDERS) {
      assert.equal(providerProfile(provider).provider, provider);
    }
  });
});

describe('A-6 monotonicity', () => {
  // The property the compaction trigger depends on: a longer prompt must never
  // estimate as cheaper, or a growing session can appear to shrink and the
  // trigger that was supposed to fire silently does not.
  const SIZES = [0, 1, 2, 3, 4, 7, 8, 15, 16, 31, 32, 63, 64, 127, 128, 399, 400, 1000, 4096];
  const TEXTS = {
    ascii: 'the quick brown fox jumps over the lazy dog, repeatedly and at length ',
    cjk: 'このメッセージは日本語のテキストであり、語彙 Sega を通します。',
    emoji: '🚀🔧📦 done ✅ done ✅ done ✅ ',
    mixed: 'commit a1b2c3 → ✅ 日本語 テスト → 🚀 done ',
  };

  it('never decreases as ASCII input grows', () => {
    for (const provider of TOKEN_PROVIDERS) {
      let previous = estimateTokens('', provider);
      for (const size of SIZES) {
        const current = estimateTokens(TEXTS.ascii.slice(0, size), provider);
        assert.ok(
          current >= previous,
          `${provider}: ${size} chars estimated ${current}, below the ${previous} of a shorter input`,
        );
        previous = current;
      }
    }
  });

  it('never decreases as multibyte input grows', () => {
    // The case a weighted estimator gets wrong: an emoji is two code units, so
    // a length-based implementation and a code-point-based one disagree about
    // what "longer" means and can step backwards between the two.
    for (const [name, text] of Object.entries(TEXTS)) {
      for (const provider of TOKEN_PROVIDERS) {
        let previous = 0;
        for (let size = 0; size <= 40; size += 1) {
          const current = estimateTokens([...text].slice(0, size).join(''), provider);
          assert.ok(current >= previous, `${provider}/${name}: size ${size} went ${previous} -> ${current}`);
          previous = current;
        }
      }
    }
  });

  it('never decreases as turns are appended to a conversation', () => {
    for (const provider of TOKEN_PROVIDERS) {
      const growing: Message[] = [];
      let previous = 0;
      for (let turn = 0; turn < 10; turn += 1) {
        growing.push(message(turn % 2 === 0 ? 'user' : 'assistant', 'a moderate turn of prose '));
        const current = countMessageTokens(growing, provider);
        assert.ok(current > previous, `${provider}: turn ${turn} did not increase the total`);
        previous = current;
      }
    }
  });

  it('never decreases as a block is appended to an existing message', () => {
    for (const provider of TOKEN_PROVIDERS) {
      const content: ContentBlock[] = [textBlock('first block')];
      let previous = countMessageTokens([rawMessage('user', ...content)], provider);
      for (let i = 0; i < 20; i += 1) {
        content.push(textBlock('x'.repeat(i + 1)));
        const current = countMessageTokens([rawMessage('user', ...content)], provider);
        assert.ok(current > previous, `${provider}: block ${i} did not increase the total`);
        previous = current;
      }
    }
  });

  it('never decreases as the last block of a conversation grows by one character', () => {
    for (const provider of TOKEN_PROVIDERS) {
      let previous = 0;
      for (let size = 0; size <= 64; size += 1) {
        const current = countMessageTokens(convo(TEXTS.mixed.slice(0, size)), provider);
        assert.ok(current >= previous, `${provider}: ${size} chars went ${previous} -> ${current}`);
        previous = current;
      }
    }
  });
});

describe('A-6 MockTokenEstimator', () => {
  it('returns the programmed value, not the heuristic', () => {
    // 412 is deliberately far from anything `estimateTokens` would produce for
    // this text. If the mock ever started consulting the real estimator, the
    // gateway tests built on it would silently become ratio tests.
    const mock = new MockTokenEstimator({ byText: { 'hello world': 412 } });
    assert.equal(mock.estimateTokens('hello world', 'anthropic'), 412);
    assert.notEqual(412, estimateTokens('hello world', 'anthropic'));
  });

  it('returns the programmed value for every provider, because it is provider-blind', () => {
    const mock = new MockTokenEstimator({ byText: { x: 77 } });
    for (const provider of TOKEN_PROVIDERS) {
      assert.equal(mock.estimateTokens('x', provider), 77, provider);
    }
  });

  it('returns the programmed message count', () => {
    const mock = new MockTokenEstimator({ byMessageCount: { 3: 1200 } });
    assert.equal(mock.countMessageTokens([message('user'), message('assistant'), message('user')], 'openai'), 1200);
    assert.equal(mock.countMessageTokens([message('user')], 'openai'), 0, 'not programmed -> fallback');
  });

  it('is deterministic across repeated calls', () => {
    const mock = new MockTokenEstimator({ byText: { repeat: 5 }, fallback: 3 });
    const runs = new Set(Array.from({ length: 20 }, () => mock.estimateTokens('repeat', 'gemini')));
    assert.deepEqual([...runs], [5]);
  });

  it('returns a programmed zero rather than the fallback', () => {
    // `hit || fallback` would be the natural way to write this and it would be
    // a bug: an empty request is a real, meaningful zero.
    const mock = new MockTokenEstimator({ byText: { '': 0 }, fallback: 99 });
    assert.equal(mock.estimateTokens('', 'anthropic'), 0);
  });

  it('falls back for an unprogrammed input, and the fallback is the default 0', () => {
    const soft = new MockTokenEstimator({ byText: { known: 1 } });
    assert.equal(soft.estimateTokens('unknown', 'anthropic'), 0);
    const configured = new MockTokenEstimator({ fallback: 12 });
    assert.equal(configured.estimateTokens('unknown', 'anthropic'), 12);
  });

  it('throws on an unprogrammed input when strict, so a test cannot pass for the wrong reason', () => {
    const mock = new MockTokenEstimator({ strict: true });
    assert.throws(() => mock.estimateTokens('unprogrammed', 'anthropic'), /strict is on/);
    assert.throws(() => mock.countMessageTokens([message('user')], 'gemini'), /1 messages/);
  });

  it('does not resolve an inherited Object property as a programmed value', () => {
    // The bug a bare `byText[text]` lookup has: the text "toString" finds
    // Object.prototype.toString and hands back a function.
    const mock = new MockTokenEstimator({ byText: { toString: 3 }, fallback: 8 });
    assert.equal(mock.estimateTokens('toString', 'anthropic'), 3);
    assert.equal(mock.estimateTokens('hasOwnProperty', 'anthropic'), 8);
  });

  it('records the calls it was asked, with the provider threaded through', () => {
    const mock = new MockTokenEstimator({ byText: { 'a b': 1 }, byMessageCount: { 1: 2 } });
    mock.estimateTokens('a b', 'gemini');
    mock.countMessageTokens([message('user')], 'openai');
    assert.deepEqual(mock.calls, [
      { method: 'estimateTokens', provider: 'gemini', preview: 'a b', chars: 3 },
      { method: 'countMessageTokens', provider: 'openai', messages: 1 },
    ]);
  });

  it('truncates a long preview so the call log cannot be the size of the input', () => {
    const mock = new MockTokenEstimator();
    mock.estimateTokens('z'.repeat(5_000), 'anthropic');
    const call = mock.calls[0];
    assert.equal(call?.method, 'estimateTokens');
    assert.equal(call?.chars, 5_000);
    assert.equal(call?.preview.length, 48);
  });

  it('hands out a frozen copy of the call log, and clears it on reset', () => {
    const mock = new MockTokenEstimator({ byText: { a: 1 } });
    mock.estimateTokens('a', 'anthropic');
    const snapshot = mock.calls;
    assert.ok(Object.isFrozen(snapshot));
    mock.estimateTokens('a', 'anthropic');
    assert.equal(snapshot.length, 1, 'the snapshot does not grow');
    assert.equal(mock.calls.length, 2);
    mock.reset();
    assert.equal(mock.calls.length, 0);
    assert.equal(mock.estimateTokens('a', 'anthropic'), 1, 'programmed values survive reset');
  });

  it('still works for a provider it has never heard of', () => {
    const mock = new MockTokenEstimator({ byText: { a: 9 } });
    assert.equal(mock.estimateTokens('a', 'openai-compat' as TokenProvider), 9);
  });
});
