import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { NonGovernanceMessage } from '@strata-ctx/core-types';

import { dedupeMessages, mergeAdjacentSameRole } from '../src/index.js';
import { message, toolResult, unsubjected } from './fixtures.js';

/**
 * R11: the same-role-correction corpus.
 *
 * `dedupeMessages` collapses blocks that share a `(kind, ref)` identity, and
 * `mergeAdjacentSameRole` folds adjacent same-role messages together. The good
 * case is real: providers and wrappers resend identical content and merging is
 * free savings.
 *
 * The hazard is that a correction is also same-role-adjacent, textually
 * near-duplicate, and carries the whole meaning: "No." / "No." / "Again." / "I
 * said the *other* file." Deleting any one of them changes what the model is
 * being told. The mitigation in the source is that identity is the *subject*,
 * never the text (`decide`, and the "no subject means no identity" note in
 * ./dedupe.ts), and a user utterance carries no subject. This file pins that.
 *
 * It is a falsification corpus rather than an example collection: a local,
 * deliberately-wrong deduper keyed on text is run over the same corpus and
 * asserted to *lose* corrections, so the corpus is demonstrably able to see the
 * defect it exists to catch -- the property is not passing because it measures
 * nothing (`naiveTextDedupe` below, and the control that a real re-read is still
 * dropped).
 */

const CORRECTIONS = [
  'No.',
  'No.',
  'Again.',
  'I said the *other* file.',
  'not that one -- the second',
  'undo that',
  'undo that',
] as const;

const corrections = (): readonly NonGovernanceMessage[] =>
  CORRECTIONS.map((text) => message('user', [unsubjected(text)]));

const texts = (messages: readonly NonGovernanceMessage[]): string[] =>
  messages.flatMap((m) => m.content.map((b) => b.text ?? ''));

/**
 * A stand-in for the deduper R11 warns about: one that keys on *text* rather
 * than on identity. It is wrong on purpose. Its only job is to show that this
 * corpus can distinguish it from the real stage.
 */
const naiveTextDedupe = (messages: readonly NonGovernanceMessage[]): readonly NonGovernanceMessage[] => {
  const seen = new Set<string>();
  const out: NonGovernanceMessage[] = [];
  for (const m of messages) {
    const content = m.content.filter((b) => {
      const t = b.text ?? '';
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    });
    if (content.length > 0) out.push({ ...m, content });
  }
  return out;
};

describe('R11 dedupe: a same-role correction is never eaten', () => {
  it('keeps every adjacent same-role correction, including byte-identical repeats', () => {
    const { messages, report } = dedupeMessages(corrections());

    assert.deepEqual(texts(messages), [...CORRECTIONS], 'every correction survives, in order');
    assert.equal(report.dropped, 0);
    assert.equal(report.drops.length, 0);
    assert.equal(report.mergedMessages, 0, 'nothing was dropped, so nothing was merged');
    assert.equal(report.untiered, CORRECTIONS.length, 'a correction carries no subject');
  });

  it('is keyed on the subject, not the text: a correction matching a read survives', () => {
    // The read has an identity; the correction does not. Same bytes, different
    // question, so neither may be dropped.
    const { messages, report } = dedupeMessages([
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v1', text: 'No.' })]),
      message('user', [unsubjected('No.')]),
    ]);

    assert.equal(report.dropped, 0, 'text equality is not identity');
    assert.deepEqual(texts(messages), ['No.', 'No.']);
  });

  it('keeps two reads that share their bytes but not their ref', () => {
    const { messages, report } = dedupeMessages([
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v1', text: 'same' })]),
      message('user', [toolResult({ ref: 'b.ts', kind: 'file', version: 'v1', text: 'same' })]),
    ]);

    assert.equal(report.dropped, 0);
    assert.deepEqual(texts(messages), ['same', 'same']);
  });

  it('still drops a re-read, so the corpus is not asserting "dedupe never drops"', () => {
    const { messages, report } = dedupeMessages([
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v1', text: 'old' })]),
      message('user', [toolResult({ ref: 'a.ts', kind: 'file', version: 'v2', text: 'new' })]),
    ]);

    assert.equal(report.dropped, 1);
    assert.equal(report.byReason.superseded, 1);
    assert.deepEqual(texts(messages), ['new']);
  });

  it('keeps a repeated user_intent-tagged line across two turns', () => {
    // The verbatim tier, tagged explicitly. Even with the same wording in a later
    // turn the block has no identity to dedupe on, so both copies stay.
    const { messages, report } = dedupeMessages([
      message('user', [unsubjected('do it again', 'user', 'user_intent')]),
      message('user', [unsubjected('do it again', 'user', 'user_intent')]),
    ]);

    assert.equal(report.dropped, 0);
    assert.deepEqual(texts(messages), ['do it again', 'do it again']);
  });

  it('merges the adjacent user turns without losing a single correction', () => {
    const merged = mergeAdjacentSameRole(corrections());

    assert.equal(merged.length, 1, 'one user run folds into one message');
    assert.deepEqual(texts(merged), [...CORRECTIONS], 'concatenation, not deletion');
  });

  it('the corpus is sensitive: a text-keyed deduper is caught by it', () => {
    const naive = texts(naiveTextDedupe(corrections()));
    const real = texts(dedupeMessages(corrections()).messages);

    assert.ok(
      naive.length < CORRECTIONS.length,
      'the naive text-keyed deduper must lose corrections here, or this corpus cannot see R11',
    );
    assert.equal(real.length, CORRECTIONS.length, 'the real stage loses none');
  });
});
