import assert from 'node:assert/strict';
import { test } from 'node:test';

import { StrataPolicySchema, sha256 } from '@strata-ctx/core-types';
import { collectGovernanceText, enforcePins, type ContentBlock, type Message, type StrataPolicy } from '@strata-ctx/core-types';
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

test('a tool_use is identified by name and input, not by name alone', () => {
  // The Messages API declares `tool_use` as `{ id, name, input }`, so the call is
  // `name` + `input`. Keyed on `name`, every `Read` in a turn was one subject and
  // dedupe dropped one of them, orphaning its `tool_result`.
  const twoCalls = toCanonical({
    ...base,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/a.ts' } },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/repo/b.ts' } },
        ],
      },
    ],
  });
  const [a, b] = firstUser(twoCalls.messages)?.content ?? [];
  assert.notEqual(a?.meta.subject?.ref, b?.meta.subject?.ref, 'different files are different subjects');
  assert.equal(a?.meta.subject?.ref, 'Read\u0000{"file_path":"/repo/a.ts"}');

  // Two identical calls are the same subject, which is what makes a repeated read
  // dedupeable at all.
  const repeated = toCanonical({
    ...base,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/a.ts' } },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/repo/a.ts' } },
        ],
      },
    ],
  });
  const [c] = firstUser(repeated.messages)?.content ?? [];
  assert.equal(c?.meta.subject?.ref, 'Read\u0000{"file_path":"/repo/a.ts"}');
});

test('a tool_use and its tool_result never share a subject', () => {
  // If they did, the result would read as a newer version of the call and dedupe
  // would drop the call out from under it -- which is exactly the orphan.
  const c = toCanonical({
    ...base,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/a.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'contents' }] },
    ],
  });
  const [call, res] = c.messages.filter((m) => m.role !== 'system').flatMap((m) => m.content);
  assert.equal(call?.meta.subject?.ref, 'Read\u0000{"file_path":"/repo/a.ts"}');
  assert.equal(res?.meta.subject?.ref, 't1');
  assert.notEqual(call?.meta.subject?.ref, res?.meta.subject?.ref);
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

/* -------------------------------------------------------------------------- */
/* tool_use egress (B-16)                                                     */
/* -------------------------------------------------------------------------- */

const wireInput = (req: AnthropicRequest): unknown => {
  for (const m of req.messages) {
    const parts = Array.isArray(m.content) ? m.content : [];
    for (const p of parts) {
      if (p.type === 'tool_use') return (p as { input?: unknown }).input;
    }
  }
  return undefined;
};

test('a tool_use round trips its arguments instead of sending an empty object', () => {
  const c = toCanonical({
    ...base,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading' },
          { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'src/index.ts', limit: 40 } },
        ],
      },
    ],
  });
  // The arguments have to be on the block already, or there is nothing to read.
  const call = c.messages[1]?.content[1] as { text?: string } | undefined;
  assert.ok(call?.text?.includes('src/index.ts'), 'ingress puts the payload in text');
  assert.deepEqual(wireInput(fromCanonical(c, base)), { path: 'src/index.ts', limit: 40 });
});

test('an empty argument object is sent as an empty object', () => {
  const c = toCanonical({
    ...base,
    messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'tu_2', name: 'list_dir', input: {} }] }],
  });
  assert.deepEqual(wireInput(fromCanonical(c, base)), {});
});

test('a non-object tool_use argument is a value, not a loss', () => {
  // Anthropic's `input` is arbitrary JSON, so a bare string is a legal call.
  // Gemini's Struct field cannot do this, which is why the two decode paths
  // differ on exactly this case.
  for (const input of ['query', 42, null, [{ path: 'a.ts' }]]) {
    const c = toCanonical({
      ...base,
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'tu_3', name: 'search', input }] }],
    });
    assert.deepEqual(wireInput(fromCanonical(c, base)), input, JSON.stringify(input));
  }
});

test('a tool_use whose arguments a lossy stage rewrote states the loss', () => {
  // Truncate/summary rewrote the text, so the envelope is gone. `{}` would be a
  // lie here: Anthropic reads an empty object as "called with no arguments" and
  // the model would run the tool that way.
  const c = toCanonical({
    ...base,
    messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'tu_4', name: 'read_file', input: { path: 'secret.ts' } }] }],
  });
  const rewrittenBlock: ContentBlock = { ...c.messages[1]!.content[0]!, text: 'HEAD... TAIL' };
  const rewritten: Message = { ...c.messages[1]!, content: [rewrittenBlock] };
  const out = fromCanonical({ ...c, messages: [c.messages[0]!, rewritten] }, base);
  const input = wireInput(out) as { error?: string };
  assert.match(input.error ?? '', /ANTHROPIC_INPUT_LOSS/);
  assert.ok(!(JSON.stringify(input).includes('secret.ts')), 'the loss marker must not echo the arguments');
});

test('a tool_use with no text at all is an empty call, not a claimed loss', () => {
  const c = toCanonical({
    ...base,
    messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'tu_5', name: 'noop', input: {} }] }],
  });
  const src = c.messages[1]!.content[0]!;
  const bare: ContentBlock = { type: 'tool_use', toolName: 'noop', meta: src.meta };
  const stripped: Message = { ...c.messages[1]!, content: [bare] };
  const out = fromCanonical({ ...c, messages: [c.messages[0]!, stripped] }, base);
  assert.deepEqual(wireInput(out), {}, 'absent text means no arguments, which is honest');
});
