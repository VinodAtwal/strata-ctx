import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { NonGovernanceBlock, NonGovernanceMessage } from '@strata-ctx/core-types';
import { isHighSeverity, partitionForLossy } from '@strata-ctx/core-types';

import {
  HEAD_SHARE,
  POINTER_MARKER,
  RETAINED_MARKER,
  TRUNCATION_MARKER,
  applyTruncate,
  artifactUriFor,
  capForTier,
  isHighSeverityLine,
  truncateBlocks,
  truncateText,
} from '../src/index.js';

import { TIER_CAPS, lineArray, lines, message, policy, state, toolResult, unsubjected } from './fixtures.js';

const cap = 300;

const run = (
  messages: readonly NonGovernanceMessage[],
  caps: Readonly<Record<string, number>> = TIER_CAPS,
) => truncateBlocks(messages, { caps });

/** A command result far over the `tool_state` cap, with no errors in it. */
const oversized = (): NonGovernanceBlock =>
  toolResult({ ref: 'npm test', text: lines(200, 'test output') });

describe('B-2 truncate: head plus tail', () => {
  it('keeps the head and the tail, and says how much it dropped', () => {
    const original = lines(200, 'row');
    const result = truncateText(original, cap);

    assert.ok(result.text.startsWith('row 0'), 'the head identifies the subject');
    assert.ok(result.text.trimEnd().endsWith('row 199'), 'the tail is where the last failure is');
    assert.ok(result.text.includes(TRUNCATION_MARKER));
    assert.ok(result.elidedLines > 0);
    assert.ok(result.elidedChars > 0);
    assert.equal(result.originalChars, original.length);
  });

  it('allocates the head the documented share', () => {
    // A truncation that keeps only the head keeps the banner and loses the
    // failure; one that keeps only the tail loses what the command was. Both
    // halves are load-bearing, so the split is a named constant, not a literal.
    const result = truncateText(lines(200, 'row'), cap);
    const head = result.text.slice(0, result.text.indexOf(TRUNCATION_MARKER));
    const headLines = head.split('\n').filter((l) => l !== '').length;
    const tail = result.text.slice(result.text.indexOf(TRUNCATION_MARKER));
    const tailLines = tail.split('\n').filter((l) => l !== '').length;
    assert.ok(headLines > tailLines, `head ${headLines} should exceed tail ${tailLines}`);
    assert.equal(HEAD_SHARE, 0.6);
  });

  it('leaves text at or under the cap byte-identical', () => {
    for (const text of ['', 'short', 'x'.repeat(cap)]) {
      const result = truncateText(text, cap);
      assert.equal(result.text, text);
      assert.equal(result.elidedLines, 0);
      assert.equal(result.elidedChars, 0);
      assert.equal(result.retainedLines, 0);
    }
  });

  it('never splits a surrogate pair', () => {
    // Cutting between the halves of an emoji produces a lone surrogate, which is
    // not valid text and shows up downstream as a replacement character.
    const text = `${'a'.repeat(cap - 1)}😀${'b'.repeat(200)}`;
    const result = truncateText(text, cap);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result.text), 'no lone high surrogate');
    assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result.text), 'no lone low surrogate');
  });

  it('fits the cap when there is nothing else to keep', () => {
    const result = truncateText(lines(500, 'row'), cap);
    assert.ok(result.text.length <= cap, `${result.text.length} should fit ${cap}`);
  });
});

describe('B-2 truncate: severity retention', () => {
  it('re-injects every error line from the elided middle', () => {
    const body = [
      ...lineArray(100, 'head line'),
      'src/a.ts(1,1): error TS2304: Cannot find name foo',
      ...lineArray(100, 'middle noise'),
      'npm ERR! code ELIFECYCLE',
      ...lineArray(100, 'tail line'),
    ].join('\n');

    const result = truncateText(body, cap);

    assert.ok(result.text.includes('src/a.ts(1,1): error TS2304: Cannot find name foo'));
    assert.ok(result.text.includes('npm ERR! code ELIFECYCLE'));
    assert.ok(result.text.includes(RETAINED_MARKER));
    assert.equal(result.retainedLines, 2);
  });

  it('reports blowing the cap rather than hiding it', () => {
    // A log full of errors is a log whose every line must survive, so the cap
    // cannot be honoured. The report has to say so out loud.
    const body = [
      ...lineArray(50, 'noise'),
      ...lineArray(40, 'src/a.ts: error TS1 and more text to make the line long'),
      ...lineArray(50, 'noise'),
    ].join('\n');

    const result = truncateText(body, cap);

    assert.ok(result.capOverriddenBySeverity, 'the override is reported');
    assert.ok(result.text.length > cap, 'and the evidence really is kept');
    assert.ok(result.text.includes(RETAINED_MARKER));
  });

  it('re-injects a fatal line that sits in the elided middle', () => {
    const body = [
      ...lineArray(100, 'noise'),
      'fatal: out of disk',
      ...lineArray(100, 'noise'),
    ].join('\n');

    const result = truncateText(body, cap);

    assert.ok(result.text.includes(TRUNCATION_MARKER), 'the middle really was elided');
    assert.ok(isHighSeverityLine('fatal: out of disk'));
    assert.ok(result.text.includes('fatal: out of disk'));
  });

  it('never truncates a producer-declared error block at all', () => {
    const original = lines(2000, 'failing output');
    const { messages, report } = run([
      message('user', [toolResult({ ref: 'build', text: original, severity: 'error' })]),
    ]);

    assert.equal(messages[0]?.content[0]?.text, original, 'byte-identical');
    assert.equal(report.truncatedBlocks, 0);
    assert.equal(report.skippedHighSeverity, 1);
  });

  it('never truncates a block with no subject, however large', () => {
    // This is the rule that makes B-6's leading intent statement safe.
    const original = lines(2000);
    const { messages, report } = run([message('user', [unsubjected(original)])]);

    assert.equal(messages[0]?.content[0]?.text, original);
    assert.equal(report.truncatedBlocks, 0);
    assert.equal(report.skippedNoSubject, 1);
  });

  it('applies the cap per tier', () => {
    const { messages, report } = run([
      message('user', [
        toolResult({ ref: 'a', text: lines(50, 'tool state is 200 chars per line') }),
        toolResult({ ref: 'b', text: lines(50, 'episodic'), tier: 'episodic' }),
      ]),
    ]);

    assert.equal(report.truncatedByTier.get('tool_state'), 1);
    assert.equal(report.truncatedByTier.get('episodic'), undefined, 'under the larger episodic cap');

    const byRef = new Map(messages.flatMap((m) => m.content.map((b) => [b.meta.subject?.ref, b.text])));
    assert.ok((byRef.get('a') ?? '').length < TIER_CAPS.tool_state, 'over the tool_state cap, so capped');
    assert.equal(byRef.get('b'), lines(50, 'episodic'), 'under the episodic cap, so byte-identical');
  });

  it('leaves a tier with no configured cap alone', () => {
    const { report } = run([message('user', [oversized()])], {});
    assert.equal(report.skippedNoCap, 1);
    assert.equal(report.truncatedBlocks, 0);
  });

  it('recomputes bytes to the truncated length and leaves the hash meaningful', () => {
    const { messages } = run([message('user', [oversized()])]);
    const out = messages[0]?.content[0];
    assert.equal(out?.meta.bytes, (out?.text ?? '').length);
    assert.ok(out?.meta.sha256);
  });
});

describe('B-2 truncate: Tier 0 does not eat its own bookkeeping', () => {
  // The regression this pins: B-3 pointer-izes a deep path, B-2 then caps the
  // stub against `artifact_ref` and its head+tail window cuts out the `path:`
  // and `uri:` lines -- the two the stub exists to carry. What survived was a
  // block that still announced `[strata:pointer]` and could no longer be
  // resolved from its own text.
  const longPath = `src/${'deep/'.repeat(150)}file.ts`;

  it('leaves a pointer stub alone however small the artifact_ref cap is', () => {
    const { ctx, report } = applyTruncate(
      partitionForLossy(
        state({ messages: [message('user', [toolResult({ ref: longPath, kind: 'file', text: lines(400) })])] }),
        policy(),
      ),
    );

    const stub = ctx.messages[0]?.content[0];
    assert.ok(stub);
    assert.ok(stub.text?.startsWith(POINTER_MARKER), 'the pointer survived');
    assert.ok(stub.text?.includes(`path: ${longPath}`), 'and still names the file');
    assert.ok(stub.text?.includes(`uri: ${artifactUriFor(stub.meta.sha256)}`), 'and is still fetchable');
    assert.ok(!stub.text?.includes(TRUNCATION_MARKER), 'no truncation marker was written into it');
    assert.equal(report.skippedAlreadyPointer, 1);
    assert.equal(report.truncatedBlocks, 0);
  });

  it('counts the skip as a skip, so telemetry cannot mistake it for work done', () => {
    const stubbed = applyTruncate(
      partitionForLossy(
        state({ messages: [message('user', [toolResult({ ref: longPath, kind: 'file', text: lines(400) })])] }),
        policy(),
      ),
    );
    assert.equal(stubbed.report.pointerize.pointerized, 1, 'B-3 did the work');
    assert.equal(stubbed.report.skippedAlreadyPointer, 1, 'B-2 declined to undo it');
  });

  it('is idempotent, which is what makes the skip safe to add', () => {
    const first = applyTruncate(
      partitionForLossy(
        state({ messages: [message('user', [toolResult({ ref: longPath, kind: 'file', text: lines(400) })])] }),
        policy(),
      ),
    );
    const second = applyTruncate(first.ctx);
    assert.deepEqual(second.ctx.messages, first.ctx.messages);
  });
});

describe('B-2 truncate: the stage', () => {
  it('survives an empty transcript and absent data', () => {
    for (const messages of [[], [message('user', [])]]) {
      const { ctx, report } = applyTruncate(partitionForLossy(state({ messages }), policy()));
      assert.equal(report.truncatedBlocks, 0);
      assert.ok(Array.isArray(ctx.messages));
    }
  });

  it('does not mutate the input context', () => {
    const original = oversized();
    const input = state({ messages: [message('user', [original])] });
    const snapshot = structuredClone(input);
    applyTruncate(partitionForLossy(input, policy()));
    assert.deepEqual(input, snapshot);
  });

  it('is idempotent: a second pass changes nothing', () => {
    const first = applyTruncate(
      partitionForLossy(state({ messages: [message('user', [oversized()])] }), policy()),
    );
    const second = applyTruncate(first.ctx);
    assert.deepEqual(second.ctx.messages, first.ctx.messages);
    assert.equal(second.report.truncatedBlocks, 0);
  });
});

describe('B-2 truncate: the release gate, end to end', () => {
  it('loses no high-severity block and no error line anywhere in the chain', () => {
    // G1/G3 rest on `severity >= error` surviving. This is the assertion that
    // would fail first if any operator in the stage started eating evidence.
    const before: NonGovernanceBlock[] = [
      toolResult({ ref: 'build', text: `${lines(300, 'ok')}\nerror TS1: bad\n${lines(300, 'ok')}` }),
      toolResult({ ref: 'legacy', text: lines(300, 'legacy'), severity: 'error' }),
      toolResult({ ref: 'crash', text: lines(300, 'crash'), severity: 'fatal' }),
      unsubjected(lines(300, 'user said something long')),
    ];

    const { ctx } = applyTruncate(
      partitionForLossy(
        state({ messages: [message('user', before)] }),
        policy({ tierByteCaps: { tool_state: 400, user_intent: 400 } }),
      ),
    );

    const after = ctx.messages.flatMap((m) => m.content);
    for (const original of before) {
      if (isHighSeverity(original)) {
        const survivor = after.find((b) => b.meta.sha256 === original.meta.sha256);
        assert.ok(survivor, `a block at ${original.meta.severity} was dropped outright`);
        assert.equal(survivor.text, original.text, 'and it is byte-identical');
      }
    }

    for (const [i, original] of before.entries()) {
      const survivor = after[i];
      if (survivor?.text === original.text) continue;
      for (const line of (original.text ?? '').split('\n')) {
        if (isHighSeverityLine(line)) {
          assert.ok(
            (survivor?.text ?? '').includes(line),
            `error line lost: ${JSON.stringify(line)}`,
          );
        }
      }
    }
  });
});

describe('B-2 truncate: cap lookup', () => {
  it('resolves a cap by tier and returns undefined when the tier has none', () => {
    assert.equal(capForTier(TIER_CAPS, 'tool_state'), TIER_CAPS.tool_state);
    assert.equal(capForTier(TIER_CAPS, 'governance'), undefined);
  });
});
