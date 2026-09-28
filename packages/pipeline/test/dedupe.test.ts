import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { NonGovernanceMessage } from '@strata-ctx/core-types';

import { dedupeMessages, mergeAdjacentSameRole } from '../src/index.js';

import { lines, message, toolResult, unsubjected } from './fixtures.js';

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
