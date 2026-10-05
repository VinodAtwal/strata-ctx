import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { NonGovernanceBlock, NonGovernanceMessage } from '@strata-ctx/core-types';
import { sha256 } from '@strata-ctx/core-types';

import { dedupeMessages, mergeAdjacentSameRole } from '../src/index.js';

import { block, lines, message, meta, toolResult, unsubjected } from './fixtures.js';

const texts = (messages: readonly NonGovernanceMessage[]): string[] =>
  messages.flatMap((m) => m.content.map((b) => b.text ?? ''));

const refs = (messages: readonly NonGovernanceMessage[]): (string | undefined)[] =>
  messages.flatMap((m) => m.content.map((b) => b.meta.subject?.ref));

describe('B-1 dedupe: identity and versioning', () => {
  it('drops an older version of the same file read', () => {
    const { messages, report } = dedupeMessages([
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v1', text: 'old' })]),
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v2', text: 'new' })]),
    ]);

    assert.deepEqual(texts(messages), ['new']);
    assert.equal(report.dropped, 1);
    assert.equal(report.byReason.superseded, 1);
    assert.equal(report.drops.length, 1);
    assert.equal(report.drops[0]?.ref, 'a.ts');
    assert.equal(report.drops[0]?.version, 'v1');
    assert.equal(report.drops[0]?.reason, 'superseded');
    assert.equal(report.drops[0]?.supersededBy, 'v2');
    assert.equal(report.drops[0]?.sha256?.length, 64, 'the drop names the block it removed');
  });

  it('reports a byte-identical re-read as a duplicate, not a supersession', () => {
    const body = lines(20);
    const { report } = dedupeMessages([
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v1', text: body })]),
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v1', text: body })]),
    ]);

    assert.equal(report.dropped, 1);
    assert.equal(report.byReason.duplicate, 1);
    assert.equal(report.byReason.superseded, 0);
  });

  it('keeps the last read and drops only the earlier copies', () => {
    const { messages, report } = dedupeMessages([
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v1', text: 'one' })]),
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v1', text: 'two' })]),
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v1', text: 'three' })]),
    ]);

    assert.deepEqual(texts(messages), ['three']);
    assert.equal(report.dropped, 2);
  });

  it('drops one of two reads that share a hash without dropping both', () => {
    // Same ref, same version, same length => same fixture hash. A drop keyed on
    // content would either take both out or neither; position is the only key
    // that is unambiguous here.
    const body = lines(30);
    const { messages, report } = dedupeMessages([
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v1', text: body })]),
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v1', text: body })]),
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v2', text: body })]),
    ]);

    assert.equal(report.dropped, 2);
    assert.equal(messages.flatMap((m) => m.content).length, 1);
  });

  it('does not confuse a file read with a command that mentions the same ref', () => {
    const { messages, report } = dedupeMessages([
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v1', text: 'contents' })]),
      message('user', [toolResult({ ref: 'a.ts', kind: 'command', text: 'wc -l a.ts' })]),
    ]);

    assert.equal(report.dropped, 0, 'identity is (kind, ref), not ref alone');
    assert.deepEqual(refs(messages), ['a.ts', 'a.ts'], 'and both survive, in order');
  });
});

describe('B-1 dedupe: producer signal', () => {
  it('honours an explicit supersededBy even at the same version', () => {
    const stale = toolResult({ ref: 'a.ts', kind: 'file', version: 'v2', text: 'stale read' });
    const { messages, report } = dedupeMessages([
      message('user', [
        { ...stale, meta: { ...stale.meta, supersededBy: 'v3' } },
        toolResult({ ref: 'a.ts', kind: 'file', version: 'v3', text: 'current' }),
      ]),
    ]);

    assert.deepEqual(texts(messages), ['current']);
    assert.equal(report.byReason.superseded_by_flag, 1);
    assert.equal(report.drops[0]?.supersededBy, 'v3');
  });

  it('never dedupes a block with no subject', () => {
    const { messages, report } = dedupeMessages([
      message('user', [unsubjected('run one'), unsubjected('run two')]),
    ]);

    assert.equal(report.dropped, 0);
    assert.equal(texts(messages).length, 2);
    assert.equal(report.untiered, 2);
  });
});

describe('B-1 dedupe: the severity guarantee', () => {
  it('keeps a high-severity block even when a later read supersedes it', () => {
    // The build log the agent is about to act on. Dropping it because the file
    // was re-read would be the exact failure G1 exists to prevent.
    const { messages, report } = dedupeMessages([
      message('user', [
        toolResult({ ref: 'a.ts', kind: 'file', version: 'v1', text: 'failing output', severity: 'error' }),
      ]),
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v2', text: 'clean output' })]),
    ]);

    assert.deepEqual(texts(messages), ['failing output', 'clean output']);
    assert.equal(report.dropped, 0);
    assert.equal(report.retainedHighSeverity, 1);
  });

  it('still drops a duplicate of a high-severity block', () => {
    // Byte-identical is byte-identical: keeping both wastes bytes without adding
    // a single fact, and the surviving copy is still error/fatal.
    const { messages, report } = dedupeMessages([
      message('user', [toolResult({ ref: 'build', text: 'error: boom', severity: 'error' })]),
      message('user', [toolResult({ ref: 'build', text: 'error: boom', severity: 'error' })]),
    ]);

    assert.equal(texts(messages).length, 1);
    assert.equal(messages[0]?.content[0]?.meta.severity, 'error');
    assert.equal(report.byReason.duplicate, 1);
  });

  it('reports a retained high-severity block rather than dropping it silently', () => {
    const { report } = dedupeMessages([
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v1', text: 'x', severity: 'fatal' })]),
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v2', text: 'y' })]),
    ]);
    assert.equal(report.retainedHighSeverity, 1);
    assert.equal(report.dropped, 0);
  });
});

describe('B-1 dedupe: transcript hygiene', () => {
  it('removes a message left empty by a drop and counts it', () => {
    const { messages, report } = dedupeMessages([
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v1', text: 'old' })]),
      message('assistant', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v2', text: 'new' })]),
    ]);

    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.role, 'assistant');
    assert.equal(report.dropped, 1);
  });

  it('merges adjacent same-role messages that a drop made adjacent', () => {
    const { messages, report } = dedupeMessages([
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v1', text: 'old' })]),
      message('user', [toolResult({ ref: 'other', text: 'kept' })]),
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v2', text: 'new' })]),
    ]);

    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.content.length, 2);
    assert.equal(report.mergedMessages, 1, 'one message was absorbed into its neighbour');
  });

  it('leaves role alternation alone', () => {
    const { messages } = dedupeMessages([
      message('user', [toolResult({ ref: 'a', text: 'one' })]),
      message('assistant', [toolResult({ ref: 'b', text: 'two' })]),
      message('user', [toolResult({ ref: 'c', text: 'three' })]),
    ]);
    assert.deepEqual(
      messages.map((m) => m.role),
      ['user', 'assistant', 'user'],
    );
  });

  it('counts subjectless blocks as untiered', () => {
    const { report } = dedupeMessages([
      message('user', [unsubjected('a user utterance'), toolResult({ ref: 'x', text: 'a' })]),
    ]);
    assert.equal(report.untiered, 1);
  });
});

describe('B-1 dedupe: the pairing invariant', () => {
  // For every pair that was complete in the input, the output holds both halves
  // or neither. Anthropic rejects a request whose `tool_use` ids do not pair, and
  // dedupe is the only Tier 0 stage that deletes a block outright.
  const toolUse = (over: {
    readonly id: string;
    readonly ref: string;
    readonly text?: string;
    readonly severity?: 'error' | 'fatal';
    readonly supersededBy?: string;
  }): NonGovernanceBlock => {
    const text = over.text ?? 'call';
    return block({
      type: 'tool_use',
      text,
      id: over.id,
      toolName: 'Read',
      meta: meta({
        subject: { kind: 'other', ref: over.ref },
        tier: 'tool_state',
        bytes: text.length,
        sha256: sha256(`use:${over.id}:${over.ref}`),
        ...(over.severity === undefined ? {} : { severity: over.severity }),
        ...(over.supersededBy === undefined ? {} : { supersededBy: over.supersededBy }),
      }),
    });
  };

  /** The result half, keyed on the id -- what `anthropic-adapter.ts` now stamps. */
  const result = (over: {
    readonly id: string;
    readonly text: string;
    readonly severity?: 'error' | 'fatal';
    readonly digest?: string;
  }): NonGovernanceBlock =>
    block({
      type: 'tool_result',
      text: over.text,
      id: over.id,
      meta: meta({
        subject: { kind: 'other', ref: over.id },
        tier: 'tool_state',
        bytes: over.text.length,
        sha256: over.digest ?? sha256(`result:${over.id}:${over.text}`),
        ...(over.severity === undefined ? {} : { severity: over.severity }),
      }),
    });

  const idsOf = (messages: readonly NonGovernanceMessage[], type: 'tool_use' | 'tool_result'): string[] =>
    messages.flatMap((m) => m.content.filter((b) => b.type === type).map((b) => b.id ?? ''));

  it('co-drops the result with a droppable call rather than dropping the call alone', () => {
    const { messages, report } = dedupeMessages([
      message('assistant', [toolUse({ id: 'toolu_01', ref: 'Read\u0000{"file_path":"/a.ts"}' })]),
      message('user', [result({ id: 'toolu_01', text: 'contents of a' })]),
      message('assistant', [toolUse({ id: 'toolu_02', ref: 'Read\u0000{"file_path":"/a.ts"}' })]),
      message('user', [result({ id: 'toolu_02', text: 'contents of a' })]),
    ]);

    assert.deepEqual(idsOf(messages, 'tool_use'), ['toolu_02']);
    assert.deepEqual(idsOf(messages, 'tool_result'), ['toolu_02']);
    assert.equal(report.dropped, 2, 'both halves are counted, not just the decided one');
  });

  it('labels the co-dropped result by its bytes, not by the reason the call was dropped', () => {
    // Same call made twice, same file: the call is a `duplicate`, and the result
    // is not -- its block hash covers `tool_use_id`, so the two are not the same
    // bytes and the later read supersedes the earlier one.
    const { report } = dedupeMessages([
      message('assistant', [toolUse({ id: 'toolu_01', ref: 'Read\u0000{"file_path":"/a.ts"}' })]),
      message('user', [result({ id: 'toolu_01', text: 'contents of a' })]),
      message('assistant', [toolUse({ id: 'toolu_02', ref: 'Read\u0000{"file_path":"/a.ts"}' })]),
      message('user', [result({ id: 'toolu_02', text: 'contents of a' })]),
    ]);

    const byRef = new Map(report.drops.map((d) => [d.ref, d.reason]));
    assert.equal(byRef.get('Read\u0000{"file_path":"/a.ts"}'), 'duplicate', 'the call really was made twice');
    assert.equal(byRef.get('toolu_01'), 'superseded', 'the earlier result is not the same bytes');
    assert.equal(report.byReason.superseded_by_flag, 0);
    assert.equal(report.byReason.duplicate, 1);
    assert.equal(report.byReason.superseded, 1);
  });

  it('labels the co-dropped result `duplicate` when it really is byte-identical', () => {
    // The only way a pair's two results can be byte-identical is a producer that
    // keys the result on something other than the call id -- a `sha256` fixture
    // stands in for it, because that is the same shape a byte-equality producer
    // emits.
    const digest = sha256('same result');
    const { report } = dedupeMessages([
      message('assistant', [toolUse({ id: 'toolu_01', ref: 'Read\u0000{"file_path":"/a.ts"}' })]),
      message('user', [result({ id: 'toolu_01', text: 'a', digest })]),
      message('assistant', [toolUse({ id: 'toolu_02', ref: 'Read\u0000{"file_path":"/a.ts"}' })]),
      message('user', [result({ id: 'toolu_02', text: 'a', digest })]),
    ]);

    assert.equal(report.byReason.duplicate, 2);
    assert.equal(report.byReason.superseded, 0);
  });

  it('never propagates superseded_by_flag to a half the producer did not flag', () => {
    const { report } = dedupeMessages([
      message('assistant', [
        toolUse({ id: 'toolu_01', ref: 'Read\u0000{"file_path":"/a.ts"}', supersededBy: 'v2' }),
      ]),
      message('user', [result({ id: 'toolu_01', text: 'contents of a' })]),
      message('assistant', [toolUse({ id: 'toolu_02', ref: 'Read\u0000{"file_path":"/a.ts"}' })]),
      message('user', [result({ id: 'toolu_02', text: 'contents of a' })]),
    ]);

    const flagged = report.drops.find((d) => d.ref === 'toolu_01');
    assert.equal(flagged?.reason, 'superseded', 'the flag named a version, not this block');
    assert.equal(report.byReason.superseded_by_flag, 1);
    assert.equal(report.byReason.superseded, 1);
  });

  it('refuses the drop when the id cannot say which half answers which', () => {
    // Gemini's shape: `functionResponse` has no id, so the adapter fills the
    // correlation key with the function name and two calls to one function share
    // it. Which response belonged to which call is unrecoverable, so nothing is
    // deleted.
    const { messages, report } = dedupeMessages([
      message('assistant', [toolUse({ id: 'Read', ref: 'Read\u0000{"file_path":"/a.ts"}' })]),
      message('assistant', [toolUse({ id: 'Read', ref: 'Read\u0000{"file_path":"/b.ts"}' })]),
      message('user', [result({ id: 'Read', text: 'a' }), result({ id: 'Read', text: 'b' })]),
    ]);

    assert.equal(report.dropped, 0);
    assert.deepEqual(idsOf(messages, 'tool_use'), ['Read', 'Read']);
    assert.deepEqual(idsOf(messages, 'tool_result'), ['Read', 'Read']);
  });

  it('keeps a failed read and its call when the same path is later read successfully', () => {
    // The severity guarantee (`decide`) is about one block; across a pair only
    // the result is severe, so the pair is what has to be kept.
    const { messages, report } = dedupeMessages([
      message('assistant', [toolUse({ id: 'toolu_01', ref: 'Read\u0000{"file_path":"/a.ts"}' })]),
      message('user', [result({ id: 'toolu_01', text: 'ENOENT: no such file', severity: 'error' })]),
      message('assistant', [toolUse({ id: 'toolu_02', ref: 'Read\u0000{"file_path":"/a.ts"}' })]),
      message('user', [result({ id: 'toolu_02', text: 'export const a = 1' })]),
    ]);

    assert.deepEqual(idsOf(messages, 'tool_result'), ['toolu_01', 'toolu_02']);
    assert.equal(report.dropped, 0);
    assert.equal(report.retainedHighSeverity, 1, 'only the severe block is counted');
    assert.ok(
      messages.flatMap((m) => m.content).some((b) => b.text?.includes('ENOENT')),
      'the error the model must see is still in the transcript',
    );
  });

  it('co-drops a failed read whose later twin also failed', () => {
    // Same path, same error, twice: the surviving result is equally severe, so
    // the guarantee is satisfied by the copy that stays and the bytes are freed.
    const { messages, report } = dedupeMessages([
      message('assistant', [toolUse({ id: 'toolu_01', ref: 'Read\u0000{"file_path":"/a.ts"}' })]),
      message('user', [result({ id: 'toolu_01', text: 'ENOENT', severity: 'error' })]),
      message('assistant', [toolUse({ id: 'toolu_02', ref: 'Read\u0000{"file_path":"/a.ts"}' })]),
      message('user', [result({ id: 'toolu_02', text: 'ENOENT', severity: 'error' })]),
    ]);

    assert.deepEqual(idsOf(messages, 'tool_result'), ['toolu_02']);
    assert.equal(report.dropped, 2);
    assert.equal(report.retainedHighSeverity, 0);
  });

  it('still drops a call that has no result to orphan', () => {
    // The pending call at the tail of a turn. Nothing answers it, so nothing can
    // be orphaned and the ordinary decision stands.
    const { messages, report } = dedupeMessages([
      message('assistant', [toolUse({ id: 'toolu_01', ref: 'Read\u0000{"file_path":"/a.ts"}' })]),
      message('assistant', [toolUse({ id: 'toolu_02', ref: 'Read\u0000{"file_path":"/a.ts"}' })]),
    ]);

    assert.deepEqual(idsOf(messages, 'tool_use'), ['toolu_02']);
    assert.equal(report.dropped, 1);
  });

  it('still dedupes a bare result that has no call in the transcript', () => {
    // No counterpart in the input means nothing can be orphaned, so a result
    // keyed on its own subject keeps the behaviour it has always had. This is
    // the branch that keeps every existing result-dedupe test meaningful.
    const { messages, report } = dedupeMessages([
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v1', text: 'old' })]),
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v2', text: 'new' })]),
    ]);

    assert.deepEqual(texts(messages), ['new']);
    assert.equal(report.byReason.superseded, 1);
  });

  it('leaves a pair alone when the call and the result share an identity', () => {
    // The Gemini defect in operator form: one subject for both halves means the
    // result reads as a newer version of the call, and dropping the result would
    // leave the call unanswerable. The pairing pass is what stops that.
    const shared = 'Read';
    const use = toolUse({ id: shared, ref: shared });
    const res = result({ id: shared, text: 'contents of a' });
    const { messages, report } = dedupeMessages([
      message('assistant', [use]),
      message('user', [res]),
      message('assistant', [toolUse({ id: shared, ref: shared })]),
      message('user', [result({ id: shared, text: 'contents of a' })]),
    ]);

    assert.equal(report.dropped, 0, 'a result is never the winner over the call it answers');
    assert.equal(idsOf(messages, 'tool_use').length, 2);
    assert.equal(idsOf(messages, 'tool_result').length, 2);
  });

  it('is deterministic: the same input gives the same report bytes', () => {
    const build = () => [
      message('assistant', [toolUse({ id: 'toolu_01', ref: 'Read\u0000{"file_path":"/a.ts"}' })]),
      message('user', [result({ id: 'toolu_01', text: 'contents of a' })]),
      message('assistant', [toolUse({ id: 'toolu_02', ref: 'Read\u0000{"file_path":"/a.ts"}' })]),
      message('user', [result({ id: 'toolu_02', text: 'contents of b' })]),
    ];
    assert.equal(JSON.stringify(dedupeMessages(build()).report), JSON.stringify(dedupeMessages(build()).report));
  });
});

describe('B-1 dedupe: purity', () => {
  it('returns the input untouched when there is nothing to drop', () => {
    const only = message('user', [toolResult({ ref: 'x', text: 'only' })]);
    const { messages, report } = dedupeMessages([only]);
    assert.equal(messages[0], only, 'no copy is made when no block is removed');
    assert.equal(report.dropped, 0);
    assert.equal(report.mergedMessages, 0);
  });

  it('does not mutate its input', () => {
    const first = toolResult({ ref: 'a.ts', kind: 'file', version: 'v1', text: 'old' });
    const input = [
      message('user', [first]),
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v2', text: 'new' })]),
    ];
    const snapshot = structuredClone(input);

    dedupeMessages(input);

    assert.deepEqual(input, snapshot);
  });

  it('handles an empty transcript', () => {
    const { messages, report } = dedupeMessages([]);
    assert.deepEqual(messages, []);
    assert.equal(report.dropped, 0);
    assert.equal(report.untiered, 0);
  });
});

describe('B-1 dedupe: mergeAdjacentSameRole', () => {
  it('merges only adjacent messages of the same role, preserving order', () => {
    const merged = mergeAdjacentSameRole([
      message('user', [toolResult({ ref: 'a', text: 'a' })]),
      message('user', [toolResult({ ref: 'b', text: 'b' })]),
      message('assistant', [toolResult({ ref: 'c', text: 'c' })]),
    ]);

    assert.equal(merged.length, 2);
    assert.equal(merged[0]?.content.length, 2);
    assert.equal(merged[0]?.content[0]?.text, 'a');
    assert.equal(merged[0]?.content[1]?.text, 'b');
  });
});
