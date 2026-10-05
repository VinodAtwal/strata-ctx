import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  StrataPolicySchema,
  collectGovernanceText,
  enforcePins,
  sha256,
  type ContextState,
  type Message,
  type StrataPolicy,
} from '@strata-ctx/core-types';
import {
  fromCanonical,
  readGeminiResponseMetadata,
  safeFromCanonical,
  safeToCanonical,
  toCanonical,
  type GeminiContent,
  type GeminiPart,
  type GeminiRequest,
} from '../src/gemini-adapter.js';

const NOW = 1_700_000_000_000;

const base: GeminiRequest = {
  model: 'gemini-2.5-pro',
  contents: [{ role: 'user', parts: [{ text: 'refactor the uploader' }] }],
};

const withSystem: GeminiRequest = {
  ...base,
  systemInstruction: { parts: [{ text: 'You are a coding agent.' }] },
};

const nonSystem = (state: ContextState): Message[] => state.messages.filter((m) => m.role !== 'system');

/**
 * A wire value the adapter is not supposed to see, typed past the declared
 * shape. The assertion lives on a parameter rather than on an object literal so
 * the fixtures below read as the malformed JSON they are.
 */
const asPart = (v: unknown): GeminiPart => v as never;
const asContent = (v: unknown): GeminiContent => v as never;
const system = (state: ContextState): Message[] => state.messages.filter((m) => m.role === 'system');

const policy: StrataPolicy = StrataPolicySchema.parse({
  version: 1,
  constraints: [
    {
      id: 'c1',
      text: 'never delete production data',
      sha256: sha256('never delete production data'),
      source: 'org_policy',
      kind: 'hard_safety',
      enforcement: 'block',
    },
  ],
});

/* -------------------------------------------------------------------------- */
/* systemInstruction -> canonical                                             */
/* -------------------------------------------------------------------------- */

test('systemInstruction is a leading system message, not a lost top-level field', () => {
  const c = toCanonical(withSystem, NOW);
  assert.equal(c.messages[0]?.role, 'system');
  assert.equal(c.messages[0]?.content[0]?.text, 'You are a coding agent.');
  assert.equal(c.messages[0]?.content[0]?.meta.origin, 'system');
});

test('systemInstruction is user_intent, never governance and never episodic', () => {
  // The three-tier decision is documented on `systemInstructionMessage`. This
  // test is the tripwire for the middle one: `user_intent` retains `verbatim`,
  // `episodic` is what `compact` replaces with a gist.
  const block = toCanonical(withSystem, NOW).messages[0]?.content[0];
  assert.equal(block?.meta.tier, 'user_intent');
  assert.notEqual(block?.meta.tier, 'governance');
  assert.notEqual(block?.meta.tier, 'episodic');
});

test('systemInstruction text is not laundered into the governance tier', () => {
  // `enforcePins` deletes every governance-tier block, so marking client text as
  // governance would erase the user's GEMINI.md on the next turn. It must stay
  // outside that sweep and survive it.
  const c = toCanonical(withSystem, NOW);
  assert.deepEqual(collectGovernanceText(c), []);
  const pinned = enforcePins(c, policy).state;
  assert.ok(pinned.messages.some((m) => m.role === 'system' && m.content.some((b) => b.text === 'You are a coding agent.')));
  assert.deepEqual(collectGovernanceText(pinned), ['never delete production data']);
});

test('multi-part systemInstruction is joined with newlines', () => {
  const c = toCanonical(
    { ...base, systemInstruction: { parts: [{ text: 'one' }, { text: 'two' }] } },
    NOW,
  );
  assert.equal(c.messages[0]?.content[0]?.text, 'one\ntwo');
});

test('blank systemInstruction produces no system message', () => {
  const c = toCanonical({ ...base, systemInstruction: { parts: [{ text: '   ' }] } }, NOW);
  assert.deepEqual(system(c), []);
});

test('a systemInstruction with no parts field at all is ignored, not thrown on', () => {
  const c = safeToCanonical({ ...base, systemInstruction: asContent({ parts: 'nope' }) }, NOW);
  assert.equal(c.failedOpen, false);
  assert.deepEqual(system(c.state), []);
});

/* -------------------------------------------------------------------------- */
/* contents + parts                                                            */
/* -------------------------------------------------------------------------- */

test('absent role defaults to user, model maps to assistant', () => {
  const c = toCanonical(
    {
      ...base,
      contents: [{ parts: [{ text: 'a' }] }, { role: 'model', parts: [{ text: 'b' }] }],
    },
    NOW,
  );
  assert.deepEqual(
    nonSystem(c).map((m) => m.role),
    ['user', 'assistant'],
  );
});

test('an unrecognised role degrades to user rather than inventing a turn', () => {
  const c = toCanonical({ ...base, contents: [asContent({ role: 'robot', parts: [{ text: 'a' }] })] }, NOW);
  assert.equal(nonSystem(c)[0]?.role, 'user');
});

test('empty contents produce no messages and no throw', () => {
  const c = toCanonical({ ...base, contents: [] }, NOW);
  assert.deepEqual(c.messages, []);
  assert.equal(safeToCanonical({ ...base, contents: [] }, NOW).failedOpen, false);
});

test('a content that is not an object is skipped, not fatal', () => {
  const c = toCanonical({ ...base, contents: [asContent(null), { role: 'user', parts: [{ text: 'a' }] }] }, NOW);
  assert.equal(nonSystem(c).length, 1);
});

test('functionCall becomes a tool_use filed as tool_state with the name as correlation id', () => {
  const c = toCanonical(
    {
      ...base,
      contents: [
        { role: 'user', parts: [{ text: 'list the files' }] },
        { role: 'model', parts: [{ functionCall: { name: 'run_shell_command', args: { command: 'ls' } } }] },
      ],
    },
    NOW,
  );
  const b = nonSystem(c)[1]?.content[0];
  assert.equal(b?.type, 'tool_use');
  assert.equal(b?.toolName, 'run_shell_command');
  assert.equal(b?.id, 'run_shell_command');
  assert.equal(b?.meta.tier, 'tool_state');
  assert.equal(b?.meta.origin, 'assistant');
  // Name *and* args. Keyed on the name alone, every `run_shell_command` in a turn
  // was one subject, so dedupe read a `functionResponse` as a newer version of the
  // call and deleted the call -- which is the same orphan the Anthropic adapter
  // had, reached one step further. See `toolUseSubject` in the adapter.
  assert.deepEqual(b?.meta.subject, { kind: 'other', ref: 'run_shell_command\u0000{"command":"ls"}' });
});

test('two calls of one function with different args are different subjects', () => {
  // Gemini parallel-calls a function by name, with no id on either half. Identity
  // therefore has to come from the args, or a turn that calls the same function
  // twice is one subject and the second call deletes the first.
  const c = toCanonical(
    {
      ...base,
      contents: [
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'run_shell_command', args: { command: 'ls' } } },
            { functionCall: { name: 'run_shell_command', args: { command: 'ls -la' } } },
          ],
        },
      ],
    },
    NOW,
  );
  const [a, b] = nonSystem(c).flatMap((m) => m.content);
  assert.equal(a?.meta.subject?.ref, 'run_shell_command\u0000{"command":"ls"}');
  assert.equal(b?.meta.subject?.ref, 'run_shell_command\u0000{"command":"ls -la"}');
  assert.notEqual(a?.meta.subject?.ref, b?.meta.subject?.ref);
});

test('a functionCall and its functionResponse never share a subject', () => {
  // GeminiFunctionResponse has no id, so its only correlation key is the name and
  // that is what the result is keyed on. Giving the call that same ref would make
  // the answer read as a newer version of the call.
  const c = toCanonical(
    {
      ...base,
      contents: [
        { role: 'model', parts: [{ functionCall: { name: 'run_shell_command', args: { command: 'ls' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'run_shell_command', response: { output: 'a.ts' } } }] },
      ],
    },
    NOW,
  );
  const [call, res] = nonSystem(c).flatMap((m) => m.content);
  assert.equal(call?.meta.subject?.ref, 'run_shell_command\u0000{"command":"ls"}');
  assert.equal(res?.meta.subject?.ref, 'run_shell_command');
  assert.notEqual(call?.meta.subject?.ref, res?.meta.subject?.ref);
});

test('a tool_result records the tool as its origin even though Gemini files it under user', () => {
  // Gemini puts `functionResponse` in a `user` content. Reading provenance off
  // the message role would file every tool result as something the user said.
  const c = toCanonical(
    {
      ...base,
      contents: [
        { role: 'model', parts: [{ functionCall: { name: 'read_file', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'x' } } }] },
      ],
    },
    NOW,
  );
  const b = nonSystem(c)[1]?.content[0];
  assert.equal(b?.type, 'tool_result');
  assert.equal(b?.meta.origin, 'tool');
  assert.equal(b?.meta.tier, 'tool_state');
});

test('a functionResponse matching an earlier functionCall carries no severity', () => {
  const c = toCanonical(
    {
      ...base,
      contents: [
        { role: 'model', parts: [{ functionCall: { name: 'read_file', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'x' } } }] },
      ],
    },
    NOW,
  );
  assert.equal(nonSystem(c)[1]?.content[0]?.meta.severity, undefined);
});

test('a functionResponse with no matching functionCall is kept and marked warn', () => {
  // Negative case. Dropping it would be the one thing a proxy must not do; the
  // marker is how it stays countable.
  const c = toCanonical(
    {
      ...base,
      contents: [{ role: 'user', parts: [{ functionResponse: { name: 'ghost', response: { output: 'x' } } }] }],
    },
    NOW,
  );
  const b = nonSystem(c)[0]?.content[0];
  assert.equal(b?.type, 'tool_result');
  assert.equal(b?.meta.severity, 'warn');
  assert.equal(b?.meta.tier, 'tool_state');
});

test('a forward functionCall does not retroactively vouch for a later orphan', () => {
  // Order matters: a call that arrives *after* the result does not match it.
  const c = toCanonical(
    {
      ...base,
      contents: [
        { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: {} } }] },
        { role: 'model', parts: [{ functionCall: { name: 'read_file', args: {} } }] },
      ],
    },
    NOW,
  );
  assert.equal(nonSystem(c)[0]?.content[0]?.meta.severity, 'warn');
});

test('an error key in a functionResponse is filed as severity error', () => {
  // Gemini has no `is_error` flag, so this is the convention standing in for
  // one. `truncate` keeps ERROR/FATAL lines, so losing it is how a failed tool
  // result becomes the first thing cut.
  const c = toCanonical(
    {
      ...base,
      contents: [
        { role: 'model', parts: [{ functionCall: { name: 'read_file', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { error: 'ENOENT' } } }] },
      ],
    },
    NOW,
  );
  assert.equal(nonSystem(c)[1]?.content[0]?.meta.severity, 'error');
});

test('a thought part becomes thinking, not text with a marker in it', () => {
  const c = toCanonical(
    { ...base, contents: [{ role: 'model', parts: [{ text: 'weighing options', thought: true }] }] },
    NOW,
  );
  assert.equal(nonSystem(c)[0]?.content[0]?.type, 'thinking');
});

test('fileData keeps its pointer and its mime type', () => {
  const c = toCanonical(
    { ...base, contents: [{ role: 'user', parts: [{ fileData: { mimeType: 'image/png', fileUri: 'gs://b/1' } }] }] },
    NOW,
  );
  const b = nonSystem(c)[0]?.content[0];
  assert.equal(b?.type, 'image');
  assert.equal(b?.id, 'gs://b/1');
  assert.equal(b?.text, 'image/png');
});

test('inlineData keeps only the mime type, and egress says so instead of faking bytes', () => {
  const c = toCanonical(
    { ...base, contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0K' } }] }] },
    NOW,
  );
  const out = fromCanonical(c, { ...base, contents: [] });
  const part = out.contents[0]?.parts[0];
  assert.deepEqual(part, { text: '[image image/png]' });
  assert.equal(part !== undefined && 'inlineData' in part, false, 'never a fabricated empty inlineData');
});

/* -------------------------------------------------------------------------- */
/* Malformed input                                                             */
/* -------------------------------------------------------------------------- */

test('an unknown part type becomes a visible synthetic placeholder, not a dropped block', () => {
  const c = toCanonical(
    { ...base, contents: [{ role: 'user', parts: [asPart({ videoMetadata: { startOffset: '1s' } })] }] },
    NOW,
  );
  const b = nonSystem(c)[0]?.content[0];
  assert.equal(b?.type, 'text');
  assert.equal(b?.text, '[unsupported part: videoMetadata]');
  assert.equal(b?.meta.origin, 'synthetic');
});

test('placeholder key lists are sorted so the same part hashes the same either way', () => {
  const a = toCanonical({ ...base, contents: [{ role: 'user', parts: [asPart({ b: 1, a: 2 })] }] }, NOW);
  const b = toCanonical({ ...base, contents: [{ role: 'user', parts: [asPart({ a: 2, b: 1 })] }] }, NOW);
  assert.equal(a.messages[0]?.content[0]?.text, '[unsupported part: a,b]');
  assert.equal(a.messages[0]?.content[0]?.meta.sha256, b.messages[0]?.content[0]?.meta.sha256);
});

test('a Gemini code-execution part is not laundered into a function call', () => {
  // Negative case with teeth: mapping `executableCode` onto tool_use would make
  // egress emit a functionCall the model never made, and it would then wait for
  // a tool response the gateway made up.
  const c = toCanonical(
    { ...base, contents: [{ role: 'model', parts: [asPart({ executableCode: { language: 'PYTHON', code: 'print(1)' } })] }] },
    NOW,
  );
  assert.equal(nonSystem(c)[0]?.content[0]?.type, 'text');
  const out = fromCanonical(c, { ...base, contents: [] });
  const part = out.contents[0]?.parts[0];
  assert.equal(part !== undefined && 'functionCall' in part, false);
});

test('malformed parts degrade one block at a time instead of failing the turn', () => {
  const c = toCanonical(
    {
      ...base,
      contents: [
        {
          role: 'user',
          parts: [
            asPart('not a part'),
            asPart(42),
            asPart(null),
            asPart({ text: 7 }),
            asPart({ functionCall: { args: { path: 'a.ts' } } }),
            asPart({ functionResponse: { response: { output: 'x' } } }),
            { text: 'real' },
          ],
        },
      ],
    },
    NOW,
  );
  const blocks = nonSystem(c)[0]?.content ?? [];
  assert.equal(blocks.length, 7);
  // The part *kind* is trusted even when its payload is broken: a nameless
  // functionCall is still a call, and flattening it to a placeholder would
  // throw away an argument object the gateway can still see. What is not
  // invented is the name, and with it the id, the subject and the orphan flag.
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['text', 'text', 'text', 'text', 'tool_use', 'tool_result', 'text'],
  );
  assert.deepEqual(
    blocks.map((b) => b.text),
    [
      '[unsupported part: string]',
      '[unsupported part: number]',
      '[unsupported part: object]',
      '[unsupported part: text]',
      '{"path":"a.ts"}',
      '{"output":"x"}',
      'real',
    ],
  );
  assert.equal(blocks[4]?.toolName, undefined);
  assert.equal(blocks[5]?.id, undefined);
  assert.equal(blocks[5]?.meta.severity, undefined);
});

test('a functionResponse whose response is not a Struct still produces a tool_result', () => {
  const c = toCanonical(
    { ...base, contents: [{ role: 'user', parts: [asPart({ functionResponse: { name: 'f', response: 'oops' } })] }] },
    NOW,
  );
  const b = nonSystem(c)[0]?.content[0];
  assert.equal(b?.type, 'tool_result');
  assert.equal(b?.text, '{}');
});

/* -------------------------------------------------------------------------- */
/* Round trips                                                                 */
/* -------------------------------------------------------------------------- */

test('round trip preserves text, roles and part order', () => {
  const req: GeminiRequest = {
    ...base,
    contents: [
      { role: 'user', parts: [{ text: 'first' }, { text: 'second' }] },
      { role: 'model', parts: [{ text: 'third' }] },
    ],
  };
  const out = fromCanonical(toCanonical(req, NOW), { ...req, contents: [] });
  assert.deepEqual(out.contents, req.contents);
});

test('round trip preserves a structured functionCall', () => {
  const call: GeminiContent = { role: 'model', parts: [{ functionCall: { name: 'run_shell_command', args: { command: 'ls', flags: ['-la'] } } }] };
  const out = fromCanonical(toCanonical({ ...base, contents: [call] }, NOW), { ...base, contents: [] });
  assert.deepEqual(out.contents[0], call);
});

test('a provider functionCall id round-trips, and a name-derived one is not invented', () => {
  const req: GeminiRequest = {
    ...base,
    contents: [
      { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'read_file', args: {} } }] },
      { role: 'model', parts: [{ functionCall: { name: 'read_file', args: {} } }] },
    ],
  };
  const out = fromCanonical(toCanonical(req, NOW), { ...req, contents: [] });
  assert.deepEqual(out.contents[0]?.parts[0], { functionCall: { id: 'c1', name: 'read_file', args: {} } });
  const second = out.contents[1]?.parts[0];
  assert.ok(second !== undefined && 'functionCall' in second);
  assert.equal('id' in second.functionCall, false, 'a correlation key we derived is not a field to re-emit');
});

test('round trip preserves a structured functionResponse', () => {
  const req: GeminiRequest = {
    ...base,
    contents: [
      { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'contents' } } }] },
    ],
  };
  const out = fromCanonical(toCanonical(req, NOW), { ...req, contents: [] });
  assert.deepEqual(out.contents, req.contents);
});

test('round trip preserves a fileData pointer', () => {
  const req: GeminiRequest = {
    ...base,
    contents: [{ role: 'user', parts: [{ fileData: { mimeType: 'image/png', fileUri: 'gs://b/1' } }] }],
  };
  const out = fromCanonical(toCanonical(req, NOW), { ...req, contents: [] });
  assert.deepEqual(out.contents, req.contents);
});

test('round trip preserves systemInstruction byte for byte', () => {
  const out = fromCanonical(toCanonical(withSystem, NOW), { ...withSystem, contents: [] });
  assert.deepEqual(out.systemInstruction, withSystem.systemInstruction);
});

test('round trip preserves a thought flag', () => {
  const req: GeminiRequest = {
    ...base,
    contents: [{ role: 'model', parts: [{ text: 'weighing', thought: true }] }],
  };
  const out = fromCanonical(toCanonical(req, NOW), { ...req, contents: [] });
  assert.deepEqual(out.contents, req.contents);
});

test('fromCanonical does not leak the original systemInstruction when canonical has none', () => {
  const c = toCanonical({ ...base, systemInstruction: asContent(undefined) }, NOW);
  assert.deepEqual(system(c), []);
  const out = fromCanonical(c, withSystem);
  assert.equal(out.systemInstruction, undefined, 'exactOptionalPropertyTypes: absent, not undefined');
});

test('unknown top-level request fields are preserved', () => {
  const withExtras: GeminiRequest = {
    ...withSystem,
    tools: [{ functionDeclarations: [{ name: 'read_file' }] }],
    generationConfig: { temperature: 0.2, topP: 0.9 },
    safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH' }],
    cachedContent: 'cachedContents/abc',
    stream: true,
  };
  const out = fromCanonical(toCanonical(withExtras, NOW), { ...withExtras, contents: [] });
  assert.deepEqual(out.tools, withExtras.tools);
  assert.deepEqual(out.generationConfig, withExtras.generationConfig);
  assert.deepEqual(out.safetySettings, withExtras.safetySettings);
  assert.equal(out.cachedContent, 'cachedContents/abc');
  assert.equal(out.stream, true);
  assert.equal(out.model, 'gemini-2.5-pro');
});

test('a canonical tool-role turn is emitted as a user content of functionResponse parts', () => {
  // Gemini has no `tool` role; inventing one is a request the provider rejects.
  const c = toCanonical(
    { ...base, contents: [{ role: 'user', parts: [{ functionResponse: { name: 'f', response: {} } }] }] },
    NOW,
  );
  const out = fromCanonical(c, { ...base, contents: [] });
  assert.equal(out.contents[0]?.role, 'user');
});

test('a tool_result whose text was rewritten by a lossy stage degrades to an empty struct', () => {
  // Truncate does head+tail on a tool_result, so its text stops parsing. The
  // only honest answer is `{}`; sending a half-parsed struct the model never
  // produced would be worse.
  const c = toCanonical(
    { ...base, contents: [{ role: 'user', parts: [{ functionResponse: { name: 'f', response: { output: 'x' } } }] }] },
    NOW,
  );
  const truncated: ContextState = {
    ...c,
    messages: c.messages.map((m) => ({
      ...m,
      content: m.content.map((b) => (b.type === 'tool_result' ? { ...b, text: '{"output": "x…' } : b)),
    })),
  };
  const out = fromCanonical(truncated, { ...base, contents: [] });
  assert.deepEqual(out.contents[0]?.parts[0], { functionResponse: { name: 'f', response: {} } });
});

/* -------------------------------------------------------------------------- */
/* Order stability and determinism                                             */
/* -------------------------------------------------------------------------- */

test('message and part order is the wire order, with the system message hoisted', () => {
  const c = toCanonical(
    {
      ...base,
      systemInstruction: { parts: [{ text: 'sys' }] },
      contents: [
        { role: 'user', parts: [{ text: 'u1' }, { text: 'u2' }] },
        { role: 'model', parts: [{ text: 'm1' }] },
        { role: 'user', parts: [{ text: 'u3' }] },
      ],
    },
    NOW,
  );
  assert.deepEqual(
    c.messages.flatMap((m) => [m.role, ...m.content.map((b) => b.text)]),
    ['system', 'sys', 'user', 'u1', 'u2', 'assistant', 'm1', 'user', 'u3'],
  );
});

test('the cacheable flag marks the head of each user turn and nothing else', () => {
  // The same heuristic the Anthropic adapter uses, so A-13 has one rule.
  const c = toCanonical(
    {
      ...base,
      contents: [
        { role: 'user', parts: [{ text: 'a' }, { text: 'b' }] },
        { role: 'model', parts: [{ text: 'c' }] },
      ],
    },
    NOW,
  );
  assert.deepEqual(
    nonSystem(c).map((m) => m.content.map((b) => b.meta.cacheable)),
    [[true, false], [false]],
  );
});

test('same input produces byte-identical canonical state', () => {
  const req: GeminiRequest = {
    ...withSystem,
    contents: [
      { role: 'user', parts: [{ text: 'a' }, { functionResponse: { name: 'f', response: { z: 1, a: 2 } } }] },
      { role: 'model', parts: [{ functionCall: { name: 'f', args: { b: 1 } } }] },
    ],
  };
  assert.equal(JSON.stringify(toCanonical(req, NOW)), JSON.stringify(toCanonical(req, NOW)));
});

/* -------------------------------------------------------------------------- */
/* Fail-open                                                                   */
/* -------------------------------------------------------------------------- */

test('ingress fails open to an unmodified passthrough when the body is not a request', () => {
  const exploding = {
    model: 'gemini-2.5-pro',
    get contents(): readonly GeminiContent[] {
      throw new Error('body was not an object');
    },
  };
  const r = safeToCanonical(exploding, NOW);
  assert.equal(r.failedOpen, true);
  assert.match(r.error ?? '', /body was not an object/);
  assert.deepEqual(r.state.messages, []);
});

test('egress fails open to the very object it was handed', () => {
  const state = toCanonical(withSystem, NOW);
  const exploding = {
    model: 'gemini-2.5-pro',
    get generationConfig(): Record<string, unknown> {
      throw new Error('body was truncated');
    },
    contents: [],
  };
  const r = safeFromCanonical(state, exploding);
  assert.equal(r.failedOpen, true);
  assert.equal(r.request, exploding, 'identity: the client must get back exactly what it sent');
  assert.match(r.error ?? '', /body was truncated/);
});

test('a healthy request does not take the fail-open path', () => {
  const ingress = safeToCanonical(withSystem, NOW);
  const egress = safeFromCanonical(ingress.state, withSystem);
  assert.equal(ingress.failedOpen, false);
  assert.equal(ingress.error, null);
  assert.equal(egress.failedOpen, false);
});

/* -------------------------------------------------------------------------- */
/* Response metadata                                                           */
/* -------------------------------------------------------------------------- */

test('usage metadata is read off one response without touching the body otherwise', () => {
  const m = readGeminiResponseMetadata({
    responseId: 'resp-1',
    modelVersion: 'gemini-2.5-pro-002',
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'hi' }] } }],
    usageMetadata: {
      promptTokenCount: 120,
      candidatesTokenCount: 30,
      totalTokenCount: 150,
      cachedContentTokenCount: 64,
      thoughtsTokenCount: 12,
    },
  });
  assert.equal(m.responseId, 'resp-1');
  assert.equal(m.modelVersion, 'gemini-2.5-pro-002');
  assert.equal(m.finishReason, 'STOP');
  assert.equal(m.usage?.cachedContentTokenCount, 64);
  assert.equal(m.usage?.thoughtsTokenCount, 12);
});

test('a partial stream chunk reads as nulls rather than throwing', () => {
  // The observer runs on a live stream; an observer that throws takes the
  // response down with it.
  const m = readGeminiResponseMetadata({ candidates: [{ index: 0 }] });
  assert.deepEqual(m, { responseId: null, modelVersion: null, finishReason: null, usage: null });
  assert.deepEqual(readGeminiResponseMetadata(null), m);
  assert.deepEqual(readGeminiResponseMetadata('data: {...}'), m);
});

test('a non-numeric counter reads as 0 rather than as NaN in a cost report', () => {
  const m = readGeminiResponseMetadata({ usageMetadata: { promptTokenCount: 'many' } });
  assert.equal(m.usage?.promptTokenCount, 0);
});
