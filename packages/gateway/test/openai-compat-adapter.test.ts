import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  StrataPolicySchema,
  assertPrefixPreserved,
  collectGovernanceText,
  enforcePins,
  sha256,
  type BlockMeta,
  type ContextState,
  type Message,
  type StrataPolicy,
  type Tier,
} from '@strata-ctx/core-types';
import {
  OPENAI_COMPAT_SSE_DONE,
  fromCanonical,
  isOpenAiCompatStreamDone,
  toCanonical,
  unpairedToolResultIds,
  type OpenAiCompatMessage,
  type OpenAiCompatRequest,
} from '../src/openai-compat-adapter.js';

const NOW = 1_700_000_000_000;

const base: OpenAiCompatRequest = {
  model: 'gpt-4o',
  messages: [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'refactor the uploader' },
  ],
};

const policy = (...texts: string[]): StrataPolicy =>
  StrataPolicySchema.parse({
    version: 1,
    constraints: texts.map((t, i) => ({
      id: `c${i + 1}`,
      text: t,
      sha256: sha256(t),
      source: 'org_policy',
      kind: 'hard_safety',
      enforcement: 'block',
    })),
  });

/** The whole point of the module: wire in, wire out, nothing lost. */
const roundTrip = (req: OpenAiCompatRequest): OpenAiCompatRequest =>
  fromCanonical(toCanonical(req, NOW), req);

const textAt = (messages: readonly Message[], i: number): string | undefined =>
  messages[i]?.content[0]?.text;

const meta = (tier: Tier, cacheable = false): BlockMeta => ({
  origin: 'user',
  sha256: sha256(`fixture-${tier}`),
  tier,
  bytes: 0,
  cacheable,
});

/* -------------------------------------------------------------------------- */
/* The system prompt                                                           */
/* -------------------------------------------------------------------------- */

test('a leading system message is already canonical and stays at index 0', () => {
  const c = toCanonical(base, NOW);
  assert.equal(c.messages[0]?.role, 'system');
  assert.equal(textAt(c.messages, 0), 'You are a coding agent.');
  assert.equal(c.messages[0]?.content[0]?.meta.tier, 'user_intent');
  assert.equal(c.messages[0]?.content[0]?.meta.cacheable, true);
});

test('the developer role is the same thing as system', () => {
  const c = toCanonical({ ...base, messages: [{ role: 'developer', content: 'be terse' }] }, NOW);
  assert.equal(c.messages[0]?.role, 'system');
  assert.equal(textAt(c.messages, 0), 'be terse');
});

test('a mid-conversation system message is not hoisted to the front', () => {
  // Hoisting is a reordering, and the whole module promises not to reorder. It
  // also changes the cached prefix, which is a cost, not a style question.
  const c = toCanonical(
    {
      ...base,
      messages: [
        { role: 'user', content: 'one' },
        { role: 'system', content: 'reminder' },
        { role: 'user', content: 'two' },
      ],
    },
    NOW,
  );
  assert.deepEqual(
    c.messages.map((m) => m.role),
    ['user', 'system', 'user'],
  );
  assert.deepEqual(roundTrip({ ...base, messages: [
    { role: 'user', content: 'one' },
    { role: 'system', content: 'reminder' },
    { role: 'user', content: 'two' },
  ] }).messages.map((m) => m.role), ['user', 'system', 'user']);
});

test('several system messages stay several system messages', () => {
  // The alternative -- merging them into one -- is the Anthropic adapter's job,
  // and it can only do it because the format has one slot for them. Merging here
  // would destroy a boundary the wire actually has.
  const req: OpenAiCompatRequest = {
    ...base,
    messages: [
      { role: 'system', content: 'first' },
      { role: 'system', content: 'second' },
      { role: 'user', content: 'go' },
    ],
  };
  const c = toCanonical(req, NOW);
  assert.equal(c.messages.length, 3);
  assert.deepEqual(roundTrip(req).messages, req.messages);
});

/* -------------------------------------------------------------------------- */
/* Round-trip fidelity                                                         */
/* -------------------------------------------------------------------------- */

const conversation: OpenAiCompatRequest = {
  model: 'gpt-4o',
  stream: true,
  stream_options: { include_usage: true },
  temperature: 0.2,
  messages: [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'refactor the uploader' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{ "path" : "a.ts" }' } },
        { id: 'call_2', type: 'function', function: { name: 'list_dir', arguments: '' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'export const a = 1;' },
    { role: 'tool', tool_call_id: 'call_2', content: 'a.ts' },
    { role: 'assistant', content: 'renamed it' },
    { role: 'user', content: 'thanks' },
  ],
};

test('a full tool-using conversation round trips byte for byte', () => {
  assert.deepEqual(roundTrip(conversation), conversation);
});

test('the arguments string is carried verbatim, never re-serialised', () => {
  // `JSON.parse` + `JSON.stringify` would turn this into `{"path":"a.ts"}`: the
  // same document, different bytes, and a cache miss on the whole prefix.
  const c = toCanonical(conversation, NOW);
  const call = c.messages[2]?.content[0];
  assert.equal(call?.type, 'tool_use');
  assert.equal(call?.text, '{ "path" : "a.ts" }');
  assert.equal(roundTrip(conversation).messages[2]?.tool_calls?.[0]?.function.arguments, '{ "path" : "a.ts" }');
});

test('unknown top-level fields pass through untouched', () => {
  const out = fromCanonical(toCanonical(base, NOW), {
    ...base,
    max_tokens: 4096,
    tools: [{ type: 'function', function: { name: 'read_file' } }],
    response_format: { type: 'json_object' },
  });
  assert.equal(out.max_tokens, 4096);
  assert.equal(out.model, 'gpt-4o');
  assert.deepEqual(out.tools, [{ type: 'function', function: { name: 'read_file' } }]);
});

test('the request is not mutated and normalising is deterministic', () => {
  const before = JSON.stringify(conversation);
  const first = toCanonical(conversation, NOW);
  const second = toCanonical(conversation, NOW);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(conversation), before);
  assert.equal(first.tokenEstimate, 0, '0 is the not-yet-counted sentinel');
  assert.equal(first.runId, 'pending');
});

/* -------------------------------------------------------------------------- */
/* Tool calls and tool results                                                 */
/* -------------------------------------------------------------------------- */

test('a tool call carries its id, name and arguments', () => {
  const c = toCanonical(conversation, NOW);
  const b = c.messages[2]?.content[0];
  assert.equal(b?.id, 'call_1');
  assert.equal(b?.toolName, 'read_file');
  assert.equal(b?.meta.tier, 'tool_state');
  assert.deepEqual(b?.meta.subject, { kind: 'other', ref: 'read_file' });
  assert.equal(b?.meta.cacheable, false, 'the conversational tail is not the gateway prefix');
});

test('a role:tool message is a tool_result, not a text block', () => {
  const c = toCanonical(conversation, NOW);
  const msg = c.messages[3];
  assert.equal(msg?.role, 'tool');
  assert.equal(msg?.content[0]?.type, 'tool_result');
  assert.equal(msg?.content[0]?.id, 'call_1');
  assert.equal(msg?.content[0]?.text, 'export const a = 1;');
  assert.equal(msg?.content[0]?.meta.tier, 'tool_state');
});

test('a tool result with no matching call is kept, and reported', () => {
  // Dropping it would be the one unrecoverable choice available here: the model
  // asked, and the answer is all the next turn has to work with.
  const req: OpenAiCompatRequest = {
    ...base,
    messages: [
      { role: 'user', content: 'go' },
      { role: 'tool', tool_call_id: 'call_missing', content: 'orphaned output' },
    ],
  };
  const c = toCanonical(req, NOW);
  assert.equal(c.messages.length, 2);
  assert.equal(c.messages[1]?.content[0]?.type, 'tool_result');
  assert.equal(c.messages[1]?.content[0]?.id, 'call_missing');
  assert.deepEqual(unpairedToolResultIds(req), ['call_missing']);
});

test('a paired tool result is not reported, and duplicates are not double-counted', () => {
  assert.deepEqual(unpairedToolResultIds(conversation), []);
  const twice: OpenAiCompatRequest = {
    ...base,
    messages: [
      { role: 'tool', tool_call_id: 'call_gone', content: 'a' },
      { role: 'tool', tool_call_id: 'call_gone', content: 'b' },
    ],
  };
  assert.deepEqual(unpairedToolResultIds(twice), ['call_gone']);
});

test('a tool_result block inside a user message egresses as its own tool message', () => {
  // This is the shape the Anthropic adapter produces, so the canonical model has
  // to be able to get back out to both wire formats.
  const state: ContextState = {
    ...toCanonical(base, NOW),
    messages: [
      {
        role: 'user',
        ts: NOW,
        content: [
          { type: 'text', text: 'here is the file', meta: meta('episodic') },
          { type: 'tool_result', text: 'contents', id: 'call_1', meta: meta('tool_state') },
        ],
      },
    ],
  };
  const out = fromCanonical(state, base).messages;
  assert.equal(out.length, 2);
  assert.equal(out[0]?.role, 'user');
  assert.equal(out[0]?.content, 'here is the file');
  assert.equal(out[1]?.role, 'tool');
  assert.equal(out[1]?.tool_call_id, 'call_1');
  assert.equal(out[1]?.content, 'contents');
});

test('a leading tool_result block stays ahead of the message body', () => {
  const state: ContextState = {
    ...toCanonical(base, NOW),
    messages: [
      {
        role: 'user',
        ts: NOW,
        content: [
          { type: 'tool_result', text: 'first', id: 'call_1', meta: meta('tool_state') },
          { type: 'text', text: 'second', meta: meta('episodic') },
        ],
      },
    ],
  };
  const out = fromCanonical(state, base).messages;
  assert.deepEqual(
    out.map((m) => [m.role, m.content]),
    [
      ['tool', 'first'],
      ['user', 'second'],
    ],
  );
});

test('a legacy function message is a tool result', () => {
  const c = toCanonical(
    { ...base, messages: [{ role: 'function', name: 'read_file', content: 'old style' }] },
    NOW,
  );
  assert.equal(c.messages[0]?.role, 'tool');
  assert.equal(c.messages[0]?.content[0]?.type, 'tool_result');
  assert.equal(c.messages[0]?.content[0]?.id, 'read_file');
  assert.equal(
    fromCanonical(c, base).messages[0]?.role,
    'tool',
    'egress normalises legacy `function` to `tool`, which is the direction every server accepts',
  );
});

/* -------------------------------------------------------------------------- */
/* Negative and fail-open cases                                                */
/* -------------------------------------------------------------------------- */

test('malformed arguments JSON is passed through and flagged, not thrown on', () => {
  const c = toCanonical(
    {
      ...base,
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{not json' } }],
        },
      ],
    },
    NOW,
  );
  const b = c.messages[0]?.content[0];
  assert.equal(b?.text, '{not json', 'the bytes the model produced are the bytes we keep');
  assert.equal(b?.meta.severity, 'warn', 'surfaced, and biasing truncate toward keeping it');
});

test('an empty arguments string is a no-argument call, not a malformed one', () => {
  const c = toCanonical(
    {
      ...base,
      messages: [
        { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'now', arguments: '' } }] },
      ],
    },
    NOW,
  );
  assert.equal(c.messages[0]?.content[0]?.meta.severity, undefined);
  assert.equal(c.messages[0]?.content[0]?.text, '');
});

test('a message with no tool_calls is left alone', () => {
  const c = toCanonical({ ...base, messages: [{ role: 'assistant', content: 'plain answer' }] }, NOW);
  assert.equal(c.messages[0]?.content.length, 1);
  assert.equal(c.messages[0]?.content[0]?.type, 'text');
  assert.deepEqual(unpairedToolResultIds({ ...base, messages: [] }), []);
});

test('an empty message list normalises to an empty context and back', () => {
  const c = toCanonical({ model: 'gpt-4o', messages: [] }, NOW);
  assert.deepEqual(c.messages, []);
  assert.deepEqual(fromCanonical(c, { model: 'gpt-4o', messages: [] }).messages, []);
});

test('empty string content is a message, not an absence of one', () => {
  const c = toCanonical({ ...base, messages: [{ role: 'user', content: '' }] }, NOW);
  assert.equal(c.messages.length, 1);
  assert.equal(c.messages[0]?.content[0]?.text, '');
  assert.equal(roundTrip({ ...base, messages: [{ role: 'user', content: '' }] }).messages[0]?.content, '');
});

test('null content with no tool call degrades to empty, never to a missing message', () => {
  const c = toCanonical({ ...base, messages: [{ role: 'user', content: null }] }, NOW);
  assert.equal(c.messages.length, 1);
  assert.equal(c.messages[0]?.content.length, 0);
  assert.equal(fromCanonical(c, base).messages[0]?.content, '');
});

test('a non-text array content joins into one projection', () => {
  const c = toCanonical(
    { ...base, messages: [{ role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] },
    NOW,
  );
  assert.equal(c.messages[0]?.content[0]?.text, 'a\nb');
});

test('an empty tool_calls array produces no tool_use blocks', () => {
  const c = toCanonical(
    { ...base, messages: [{ role: 'assistant', content: 'hi', tool_calls: [] }] },
    NOW,
  );
  assert.equal(c.messages[0]?.content.length, 1);
  assert.ok(!fromCanonical(c, base).messages[0]?.tool_calls, 'an empty array is not emitted');
});

test('a role:tool message with no correlation id is kept, and no id is invented', () => {
  const c = toCanonical({ ...base, messages: [{ role: 'tool', content: 'anonymous' }] }, NOW);
  assert.equal(c.messages[0]?.content[0]?.text, 'anonymous');
  const out = fromCanonical(c, base).messages[0];
  assert.equal(out?.role, 'tool');
  assert.ok(!('tool_call_id' in (out ?? {})));
});

test('fromCanonical fails open on canonical blocks with unusable fields', () => {
  const state: ContextState = {
    ...toCanonical(base, NOW),
    messages: [
      {
        role: 'assistant',
        ts: NOW,
        content: [
          // No id, no name, and an arguments projection that is not JSON at all.
          { type: 'tool_use', text: 'garbage', meta: meta('tool_state') },
          { type: 'tool_result', text: '', meta: meta('tool_state') },
        ],
      },
    ],
  };
  let out: readonly OpenAiCompatMessage[] = [];
  assert.doesNotThrow(() => {
    out = fromCanonical(state, base).messages;
  });
  assert.equal(out[0]?.tool_calls?.[0]?.id, '');
  assert.equal(out[0]?.tool_calls?.[0]?.function.name, 'unknown');
  assert.equal(out[0]?.tool_calls?.[0]?.function.arguments, 'garbage');
  assert.equal(out[0]?.content, null, 'a tool call with no text keeps the null content it had');
  assert.equal(out[1]?.role, 'tool');
  assert.equal(out[1]?.content, '');
});

/* -------------------------------------------------------------------------- */
/* Cache prefixes                                                              */
/* -------------------------------------------------------------------------- */

test('the gateway prefix is the system prompt and the head of the first user turn', () => {
  const c = toCanonical(conversation, NOW);
  assert.equal(c.messages[0]?.content[0]?.meta.cacheable, true, 'system');
  assert.equal(c.messages[1]?.content[0]?.meta.cacheable, true, 'first user block');
  assert.equal(c.messages[5]?.content[0]?.meta.cacheable, false, 'the tail is not the prefix');
});

test('a cache_control hint from the Anthropic shape is never invented onto this wire', () => {
  const state: ContextState = {
    ...toCanonical(base, NOW),
    messages: [
      {
        role: 'system',
        ts: NOW,
        content: [{ type: 'text', text: 'pinned', cacheControl: { type: 'ephemeral' }, meta: meta('governance', true) }],
      },
    ],
  };
  const out = fromCanonical(state, base);
  assert.equal(JSON.stringify(out).includes('cache_control'), false);
  assert.equal(out.messages[0]?.content, 'pinned');
});

/* -------------------------------------------------------------------------- */
/* Governance                                                                  */
/* -------------------------------------------------------------------------- */

test('enforced pins survive egress and ingress intact, in order, prefix-stable', () => {
  const p = policy('never delete production data');
  const state = enforcePins(toCanonical(conversation, NOW), p).state;
  const out = fromCanonical(state, conversation);
  const reingested = toCanonical(out, NOW);

  // The tier does not survive the wire -- there is no tier field on the format --
  // and the re-ingested block comes back as `user_intent`. That is not a hole in
  // this adapter; it is the reason `enforcePins` replaces the buffer from the
  // policy every turn instead of trusting what the client returned. What this
  // module owes is that the *text* and the *position* are untouched.
  assert.deepEqual(collectGovernanceText(state), ['never delete production data']);
  assert.equal(reingested.messages[0]?.role, 'system');
  assert.equal(textAt(reingested.messages, 0), 'never delete production data');
  assert.doesNotThrow(() => assertPrefixPreserved(state.messages, reingested.messages));
  assert.deepEqual(unpairedToolResultIds(out), []);
  assert.equal(out.messages[0]?.content, 'never delete production data');
});

test('pinned order is the policy order and nothing reorders around it', () => {
  const p = policy('alpha constraint', 'beta constraint');
  const state = enforcePins(toCanonical(conversation, NOW), p).state;
  const out = fromCanonical(state, conversation);
  const wire = out.messages[0]?.content;
  assert.equal(typeof wire, 'string');
  assert.equal(wire, 'alpha constraint\nbeta constraint');
  assert.equal(collectGovernanceText(state).join('\n'), wire);
  assert.equal(textAt(toCanonical(out, NOW).messages, 0), 'alpha constraint\nbeta constraint');
});

/* -------------------------------------------------------------------------- */
/* Content parts and reasoning                                                 */
/* -------------------------------------------------------------------------- */

test('an image part round trips as image_url', () => {
  const req: OpenAiCompatRequest = {
    ...base,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'https://example.invalid/a.png' } }] },
    ],
  };
  const c = toCanonical(req, NOW);
  assert.deepEqual(c.messages[0]?.content.map((b) => b.type), ['text', 'image']);
  assert.equal(c.messages[0]?.content[1]?.text, 'https://example.invalid/a.png');
  assert.deepEqual(roundTrip(req).messages, req.messages);
});

test('a mixed text array is the one multi-part content that survives as a string', () => {
  const out = roundTrip({
    ...base,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }],
  });
  assert.equal(out.messages[0]?.content, 'a\nb', 'block boundaries are not representable outbound');
});

test('reasoning_content round trips as a thinking block, not as assistant content', () => {
  const req: OpenAiCompatRequest = {
    ...base,
    messages: [
      { role: 'user', content: 'think' },
      { role: 'assistant', content: 'answer', reasoning_content: 'because' },
    ],
  };
  const c = toCanonical(req, NOW);
  assert.deepEqual(c.messages[1]?.content.map((b) => b.type), ['thinking', 'text']);
  assert.deepEqual(roundTrip(req).messages, req.messages);
});

/* -------------------------------------------------------------------------- */
/* Streaming                                                                   */
/* -------------------------------------------------------------------------- */

test('the terminal frame is the documented sentinel, byte for byte', () => {
  assert.equal(OPENAI_COMPAT_SSE_DONE, 'data: [DONE]');
  assert.equal(isOpenAiCompatStreamDone('[DONE]'), true);
  assert.equal(isOpenAiCompatStreamDone(' [DONE] '), true);
  assert.equal(isOpenAiCompatStreamDone('{"id":"chatcmpl-1","choices":[]}'), false);
  assert.equal(isOpenAiCompatStreamDone(''), false);
  assert.equal(isOpenAiCompatStreamDone('[done]'), false, 'the sentinel is case-sensitive');
});

test('a partial arguments fragment is not mistaken for a complete stream', () => {
  // A streamed tool call arrives as fragments joined by `index`; recognising the
  // sentinel must not depend on how much of a frame has been seen.
  const fragment = '{"index":0,"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pa"}}]}}]}';
  assert.equal(isOpenAiCompatStreamDone(fragment), false);
});
