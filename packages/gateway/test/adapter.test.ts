import assert from 'node:assert/strict';
import { test } from 'node:test';

import { StrataPolicySchema, sha256 } from '@strata-ctx/core-types';
import { collectGovernanceText, enforcePins, type Message, type StrataPolicy } from '@strata-ctx/core-types';
import { fromCanonical, toCanonical, type AnthropicRequest } from '../src/anthropic-adapter.js';

const base: AnthropicRequest = {
  model: 'claude-test',
  max_tokens: 1024,
  system: 'You are a coding agent.',
  messages: [{ role: 'user', content: 'refactor the uploader' }],
};

/** The first non-system message. `toCanonical` puts the system prompt at index 0. */
const firstUser = (messages: readonly Message[]): Message | undefined =>
  messages.find((m) => m.role !== 'system');

const policy: StrataPolicy = StrataPolicySchema.parse({
  version: 1,
  constraints: [
    { id: 'c1', text: 'never delete production data', sha256: sha256('never delete production data'), source: 'org_policy', kind: 'hard_safety', enforcement: 'block' },
  ],
});

test('system prompt becomes a system message, not a dropped field', () => {
  // Dropping it here is how a CLAUDE.md policy silently stops being enforced.
  const c = toCanonical(base);
  assert.equal(c.messages[0]?.role, 'system');
  assert.equal(c.messages[0]?.content[0]?.text, 'You are a coding agent.');
  assert.equal(c.messages[0]?.content[0]?.meta.tier, 'user_intent');
});

test('array-form system prompt is joined', () => {
  const c = toCanonical({ ...base, system: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] });
  assert.equal(c.messages[0]?.content[0]?.text, 'one\ntwo');
});

test('empty system prompt produces no system message', () => {
  const c = toCanonical({ ...base, system: '   ' });
  assert.ok(!c.messages.some((m) => m.role === 'system'));
});

test('plain string message content is accepted', () => {
  const c = toCanonical({ ...base, messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(firstUser(c.messages)?.content[0]?.text, 'hello');
});

test('tool results are filed as tool_state and errors carry severity', () => {
  const c = toCanonical({
    ...base,
    messages: [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }],
      },
    ],
  });
  const b = firstUser(c.messages)?.content[0];
  assert.equal(b?.meta.tier, 'tool_state');
  assert.equal(b?.meta.severity, 'error');
  assert.equal(b?.id, 't1');
});

test('cache_control survives the round trip', () => {
  const c = toCanonical({
    ...base,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'cached', cache_control: { type: 'ephemeral' } }] },
    ],
  });
  assert.equal(firstUser(c.messages)?.content[0]?.cacheControl?.type, 'ephemeral');
  const out = fromCanonical(c, base);
  const block: { cache_control?: { type: string } } = out.messages[0]?.content[0] as never;
  assert.equal(block.cache_control?.type, 'ephemeral');
});

test('round trip preserves text and role', () => {
  const c = toCanonical({
    ...base,
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
    ],
  });
  const out = fromCanonical(c, { ...base, messages: [] });
  assert.deepEqual(
    out.messages.map((m) => [m.role, typeof m.content === 'string' ? m.content : m.content[0]]),
    [
      ['user', { type: 'text', text: 'first' }],
      ['assistant', { type: 'text', text: 'second' }],
    ],
  );
});

test('enforced pins reach the wire and the agent prompt is not clobbered', () => {
  const c = enforcePins(toCanonical(base), policy).state;
  const out = fromCanonical(c, { ...base, messages: [] });

  const sys = out.system as { text: string }[];
  assert.ok(sys.length >= 2);
  assert.ok(sys.some((s) => s.text.includes('never delete production data')));
  assert.ok(sys.some((s) => s.text.includes('You are a coding agent.')));
  assert.equal(out.messages.length, 1, 'the user turn is still there');
  assert.deepEqual(collectGovernanceText(c), ['never delete production data']);
});

test('fromCanonical does not leak the original system field when canonical has none', () => {
  const c = toCanonical({ ...base, system: undefined as never, messages: [{ role: 'user', content: 'x' }] });
  assert.ok(!c.messages.some((m) => m.role === 'system'));
  const out = fromCanonical(c, base);
  assert.equal(out.system, undefined, 'exactOptionalPropertyTypes: absent, not undefined');
});

test('unknown top-level request fields are preserved', () => {
  const withExtras: AnthropicRequest = { ...base, temperature: 0.2, top_p: 0.9 };
  const out = fromCanonical(toCanonical(base), withExtras);
  assert.equal(out.temperature, 0.2);
  assert.equal(out.top_p, 0.9);
});
