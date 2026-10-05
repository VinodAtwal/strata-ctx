import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ContextState, NonGovernanceMessage } from '@strata-ctx/core-types';
import { dedupeMessages } from '@strata-ctx/pipeline';

import { toCanonical as anthropicToCanonical, type AnthropicRequest } from '../src/anthropic-adapter.js';
import { toCanonical as geminiToCanonical, type GeminiRequest } from '../src/gemini-adapter.js';
import {
  toCanonical as openAiToCanonical,
  type OpenAiCompatRequest,
} from '../src/openai-compat-adapter.js';

/**
 * The pairing invariant (the defect, expressed once):
 *
 *   Anthropic rejects a request in which a `tool_use` id has no `tool_result`
 *   carrying that id, or a `tool_result` references an absent `tool_use`.
 *
 * So after dedupe, for every surviving `tool_use` there must survive a
 * `tool_result` with that id, and for every surviving `tool_result` there must
 * survive a `tool_use` with that id. `dedupeMessages` is the only Tier 0 stage
 * that deletes a block outright, so it is the only place the invariant can be
 * broken between ingress and egress.
 *
 * These run through the real adapter path -- `toCanonical` then
 * `dedupeMessages` -- because the defect is not in dedupe alone. A `tool_use`
 * subject keyed on `block.name` alone (which is what every adapter here used to
 * stamp) makes every `Read` in a turn one identity, and dedupe then drops the
 * earlier call as a duplicate. A hand-built fixture would have to reproduce that
 * adapter decision in order to fail, and that decision is the thing under test.
 *
 * The identity itself is asserted in the adapter suites; this file asserts the
 * consequence, which is the only thing a provider rejects a request over.
 */

/**
 * `toCanonical` returns a `ContextState`, whose messages are wide enough to hold
 * governance. Handing them to a lossy stage is the crossing `fixtures.ts` calls
 * correct: the loss of narrowing belongs at the context boundary, not inside an
 * operator. A `Read` transcript carries no governance block, so there is nothing
 * for the cast to smuggle.
 */
const lossy = (state: ContextState): NonGovernanceMessage[] => state.messages as NonGovernanceMessage[];

const flatten = (messages: readonly NonGovernanceMessage[]): NonGovernanceMessage['content'][number][] =>
  messages.flatMap((m) => m.content);

/**
 * Ids whose pair did not survive. An empty array is the invariant; anything in
 * it is a request a provider will reject.
 */
const orphanIds = (messages: readonly NonGovernanceMessage[]): string[] => {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const b of flatten(messages)) {
    if (b.type === 'tool_use' && typeof b.id === 'string') calls.add(b.id);
    if (b.type === 'tool_result' && typeof b.id === 'string') results.add(b.id);
  }
  return [
    ...[...calls].filter((id) => !results.has(id)).map((id) => `tool_use:${id}`),
    ...[...results].filter((id) => !calls.has(id)).map((id) => `tool_result:${id}`),
  ];
};

const runAnthropic = (req: AnthropicRequest) => dedupeMessages(lossy(anthropicToCanonical(req)));

const countType = (messages: readonly NonGovernanceMessage[], type: 'tool_use' | 'tool_result'): number =>
  flatten(messages).filter((b) => b.type === type).length;

describe('B-1/B-pairing: two Reads of different files are not duplicates', () => {
  it('keeps both tool_use blocks when the name is shared and the input differs', () => {
    // Two `Read` calls in one turn, same name, different paths. The name is not
    // the identity: stamping `ref: block.name` gave both the same subject, and
    // dedupe dropped the first as a duplicate, orphaning its result.
    const { messages, report } = runAnthropic({
      model: 'claude-test',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'compare the two' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/repo/a.ts' } },
            { type: 'tool_use', id: 'toolu_02', name: 'Read', input: { file_path: '/repo/b.ts' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_01', content: 'contents of a' },
            { type: 'tool_result', tool_use_id: 'toolu_02', content: 'contents of b' },
          ],
        },
      ],
    });

    assert.equal(report.dropped, 0, 'two different files are not a duplicate');
    assert.equal(countType(messages, 'tool_use'), 2);
    assert.deepEqual(orphanIds(messages), []);
  });

  it('keeps both tool_use blocks when the names differ', () => {
    const { messages, report } = runAnthropic({
      model: 'claude-test',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'look' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/repo/a.ts' } },
            { type: 'tool_use', id: 'toolu_02', name: 'Grep', input: { pattern: 'x' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_01', content: 'contents of a' },
            { type: 'tool_result', tool_use_id: 'toolu_02', content: 'one match' },
          ],
        },
      ],
    });

    assert.equal(report.dropped, 0);
    assert.equal(countType(messages, 'tool_use'), 2);
    assert.deepEqual(orphanIds(messages), []);
  });
});

describe('B-1/B-pairing: a genuine duplicate still cannot orphan its result', () => {
  it('drops the pair together, never the call alone', () => {
    const { messages, report } = runAnthropic({
      model: 'claude-test',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'read it twice' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/repo/a.ts' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'contents of a' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_02', name: 'Read', input: { file_path: '/repo/a.ts' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: 'contents of a' }] },
      ],
    });

    assert.deepEqual(orphanIds(messages), [], 'the invariant, zero orphans');
    assert.equal(countType(messages, 'tool_use'), 1);
    assert.equal(countType(messages, 'tool_result'), 1);
    assert.equal(report.dropped, 2, 'the whole superseded pair leaves, counted as two blocks');
  });

  it('holds for three same-name calls', () => {
    const { messages, report } = runAnthropic({
      model: 'claude-test',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'read three files' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/repo/a.ts' } },
            { type: 'tool_use', id: 'toolu_02', name: 'Read', input: { file_path: '/repo/a.ts' } },
            { type: 'tool_use', id: 'toolu_03', name: 'Read', input: { file_path: '/repo/a.ts' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_01', content: 'contents of a' },
            { type: 'tool_result', tool_use_id: 'toolu_02', content: 'contents of a' },
            { type: 'tool_result', tool_use_id: 'toolu_03', content: 'contents of a' },
          ],
        },
      ],
    });

    assert.deepEqual(orphanIds(messages), []);
    assert.equal(countType(messages, 'tool_use'), 1);
    assert.equal(countType(messages, 'tool_result'), 1);
    assert.equal(report.dropped, 4);
  });
});

describe('B-1/B-pairing: every adapter', () => {
  it('anthropic leaves no orphan on a two-call turn', () => {
    const { messages } = runAnthropic({
      model: 'claude-test',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/repo/a.ts' } },
            { type: 'tool_use', id: 'toolu_02', name: 'Read', input: { file_path: '/repo/b.ts' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_01', content: 'a' },
            { type: 'tool_result', tool_use_id: 'toolu_02', content: 'b' },
          ],
        },
      ],
    });
    assert.deepEqual(orphanIds(messages), []);
  });

  it('gemini leaves no orphan on a two-call turn', () => {
    // Gemini correlates by *name*, not id: `functionCall.id` is absent on the
    // common SDK, and the adapter fills the canonical id with the function name
    // (gemini-adapter.ts:59, egress :537-553). Before the fix the call and its
    // answer also shared one *subject*, so dedupe read the response as a newer
    // version of the call and deleted the call.
    const req: GeminiRequest = {
      contents: [
        { role: 'user', parts: [{ text: 'go' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'Read', args: { file_path: '/repo/a.ts' } } },
            { functionCall: { name: 'Read', args: { file_path: '/repo/b.ts' } } },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'Read', response: { output: 'a' } } },
            { functionResponse: { name: 'Read', response: { output: 'b' } } },
          ],
        },
      ],
    };
    const { messages } = dedupeMessages(lossy(geminiToCanonical(req)));
    assert.deepEqual(orphanIds(messages), []);
  });

  it('openai-compat leaves no orphan on a two-call turn', () => {
    const req: OpenAiCompatRequest = {
      model: 'gpt-test',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_01', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/repo/a.ts"}' } },
            { id: 'call_02', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/repo/b.ts"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_01', content: 'a' },
        { role: 'tool', tool_call_id: 'call_02', content: 'b' },
      ],
    };
    const { messages } = dedupeMessages(lossy(openAiToCanonical(req)));
    assert.deepEqual(orphanIds(messages), []);
  });
});

describe('B-1/B-pairing: the ENOENT case is not a duplicate', () => {
  it('keeps a failed Read of a path that is later read successfully', () => {
    // Two identical calls on one path; the first failed and the second did not.
    // The calls are the same subject, so the first is a drop candidate -- and
    // dropping it alone would orphan the ENOENT, which is the one result the
    // model must not lose. The pairing pass refuses instead.
    const { messages, report } = runAnthropic({
      model: 'claude-test',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'read it' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/repo/a.ts' } }] },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'ENOENT: no such file', is_error: true }],
        },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_02', name: 'Read', input: { file_path: '/repo/a.ts' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: 'export const a = 1' }] },
      ],
    });

    assert.deepEqual(orphanIds(messages), []);
    assert.equal(countType(messages, 'tool_result'), 2, 'the ENOENT survives');
    assert.ok(
      flatten(messages).some((b) => b.type === 'tool_result' && b.text?.includes('ENOENT')),
      'the error the model must see is still in the transcript',
    );
    assert.equal(report.retainedHighSeverity, 1);
  });
});
