import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  gradeRubric,
  gradeToolCalls,
  parseRubric,
  renderRubricPrompt,
  safeParseRubric,
  validateJudgement,
  validateRubric,
  JudgementError,
  RubricError,
  RUBRIC_FORMAT_VERSION,
  RUBRIC_MODEL_CALL_DEFERRED_TO,
  type ExpectedToolCall,
  type ObservedToolCall,
  type Rubric,
  type RubricArtifact,
  type RubricJudgement,
} from '../src/grading.js';

// Fixtures are inline per AGENTS.md §6.2. No shared fixture files.

const call = (
  id: string,
  tool: string,
  over: Partial<ExpectedToolCall> = {},
): ExpectedToolCall => ({ id, tool, count: 1, order: 'ordered', argMatch: 'subset', ...over });

const seen = (tool: string, args: Record<string, unknown> = {}): ObservedToolCall => ({
  tool,
  args,
});

// ------------------------------------------------------------ tool-call grading

describe('F1-2 tool-call grading: exact match', () => {
  it('passes a run that made exactly the expected ordered calls', () => {
    const result = gradeToolCalls(
      'c-1',
      [call('read-src', 'Read', { args: { path: 'a.ts' } }), call('edit-src', 'Edit')],
      [seen('Read', { path: 'a.ts' }), seen('Edit')],
    );
    assert.equal(result.passed, true);
    assert.equal(result.relation, 'exact');
    assert.equal(result.score, 1);
    assert.equal(result.recall, 1);
    assert.equal(result.precision, 1);
    assert.equal(result.orderScore, 1);
    assert.equal(result.matchedCount, 2);
    assert.deepEqual(result.expected.map((d) => d.status), ['matched', 'matched']);
    assert.deepEqual(result.unmatchedObserved, []);
  });

  it('is order-sensitive where order matters: Edit before Read is not Read before Edit', () => {
    const expected = [call('read-src', 'Read'), call('edit-src', 'Edit')];
    const correct = gradeToolCalls('c-1', expected, [seen('Read'), seen('Edit')]);
    const swapped = gradeToolCalls('c-1', expected, [seen('Edit'), seen('Read')]);

    assert.equal(correct.passed, true);
    assert.equal(swapped.passed, false, 'a Read after an Edit is a different run');
    // The graded score degrades rather than collapsing, so partial credit survives.
    assert.equal(swapped.orderScore, 0.5);
    assert.ok(swapped.score > 0 && swapped.score < 1, `expected 0 < ${swapped.score} < 1`);
    assert.equal(swapped.recall, 1, 'both calls did happen; only the order is wrong');
    assert.equal(swapped.precision, 1);
    // Both members of the swap are reported. Blaming only the one a sorting
    // pass left behind would imply `Edit` happened in order, which it did not.
    assert.deepEqual(
      swapped.expected.map((d) => d.status),
      ['order_violation', 'order_violation'],
    );
    assert.deepEqual([...swapped.provenance.failed], ['edit-src', 'read-src']);
  });

  it('is order-insensitive where it does not: an unordered expectation is exempt', () => {
    const expected = [
      call('read-src', 'Read'),
      call('grep', 'Grep', { order: 'unordered' }),
      call('edit-src', 'Edit'),
    ];
    // Read, Edit, Grep: the Grep moved, and the ordered pair is still in order.
    const result = gradeToolCalls('c-1', expected, [seen('Read'), seen('Edit'), seen('Grep')]);
    assert.equal(result.passed, true);
    assert.equal(result.orderScore, 1);
    assert.equal(result.expected[1]?.status, 'matched');
  });

  it('expresses an interleaving requirement by marking the in-between call ordered', () => {
    const interleaved = [
      call('read', 'Read'),
      call('grep', 'Grep'),
      call('edit', 'Edit'),
    ];
    const moved = gradeToolCalls('c-1', interleaved, [seen('Read'), seen('Edit'), seen('Grep')]);
    assert.equal(moved.passed, false);
    assert.ok(moved.orderScore < 1);
  });

  it('reports a zero-width order score for a reversed pair, and the LIS for a longer inversion', () => {
    // Longest increasing subsequence of [0, 2, 1, 3] has length 3 of 4.
    const expected = [
      call('a', 'A'),
      call('b', 'B'),
      call('c', 'C'),
      call('d', 'D'),
    ];
    const result = gradeToolCalls('c-1', expected, [seen('A'), seen('C'), seen('B'), seen('D')]);
    assert.equal(result.orderScore, 0.75);
    assert.equal(result.passed, false);
  });
});

describe('F1-2 tool-call grading: subset, superset, extra and missing', () => {
  it('classifies an extra call as observed_superset and still fails under exact strictness', () => {
    const result = gradeToolCalls('c-1', [call('read', 'Read')], [seen('Read'), seen('Bash')]);
    assert.equal(result.relation, 'observed_superset');
    assert.equal(result.passed, false, 'strictness exact: an unrequested tool is a difference');
    assert.equal(result.unmatchedObserved.length, 1);
    assert.equal(result.unmatchedObserved[0]?.reason, 'extra');
    assert.equal(result.unmatchedObserved[0]?.tool, 'Bash');
  });

  it('permits extras under at_least strictness without hiding them', () => {
    const result = gradeToolCalls(
      'c-1',
      [call('read', 'Read')],
      [seen('Read'), seen('Bash')],
      { strictness: 'at_least' },
    );
    assert.equal(result.passed, true);
    assert.equal(result.relation, 'observed_superset');
    assert.equal(result.unmatchedObserved.length, 1, 'permitted is not the same as unreported');
    assert.equal(result.precision, 0.5, 'the graded score still charges for the extra call');
  });

  it('classifies a missing call as expected_superset', () => {
    const result = gradeToolCalls('c-1', [call('read', 'Read'), call('edit', 'Edit')], [seen('Read')]);
    assert.equal(result.relation, 'expected_superset');
    assert.equal(result.passed, false);
    assert.equal(result.expected[1]?.status, 'missing');
    assert.equal(result.recall, 0.5);
  });

  it('classifies both directions of difference as incomparable', () => {
    const result = gradeToolCalls(
      'c-1',
      [call('read', 'Read'), call('edit', 'Edit')],
      [seen('Bash')],
    );
    assert.equal(result.relation, 'incomparable');
    assert.equal(result.unmatchedObserved[0]?.reason, 'extra');
    assert.equal(result.expected[0]?.status, 'missing');
  });
});

describe('F1-2 tool-call grading: argument matching', () => {
  it('ignores undeclared observed keys under the default subset mode', () => {
    const result = gradeToolCalls(
      'c-1',
      [call('read', 'Read', { args: { path: 'a.ts' } })],
      [seen('Read', { path: 'a.ts', mtime: 12345 })],
    );
    assert.equal(result.passed, true, 'a tool that adds a timestamp is not a different call');
  });

  it('does not care about argument key order', () => {
    const result = gradeToolCalls(
      'c-1',
      [call('edit', 'Edit', { args: { path: 'a.ts', text: 'x' } })],
      [seen('Edit', { text: 'x', path: 'a.ts' })],
    );
    assert.equal(result.passed, true);
  });

  it('reports a differing declared argument as argument_mismatch, not missing', () => {
    const result = gradeToolCalls(
      'c-1',
      [call('read', 'Read', { args: { path: 'a.ts' } })],
      [seen('Read', { path: 'b.ts' })],
    );
    assert.equal(result.expected[0]?.status, 'argument_mismatch');
    assert.equal(result.passed, false);
    assert.equal(result.recall, 0);
  });

  it('catches a spurious extra argument only under exact argMatch', () => {
    const expected = [call('edit', 'Edit', { args: { path: 'a.ts' }, argMatch: 'exact' })];
    const withExtra = gradeToolCalls('c-1', expected, [seen('Edit', { path: 'a.ts', force: true })]);
    assert.equal(withExtra.expected[0]?.status, 'argument_mismatch');
    const withoutExtra = gradeToolCalls('c-1', expected, [seen('Edit', { path: 'a.ts' })]);
    assert.equal(withoutExtra.passed, true);
  });

  it('records which criteria were graded on the tool name alone', () => {
    const result = gradeToolCalls(
      'c-1',
      [call('blind', 'Read'), call('strict', 'Edit', { args: { path: 'a.ts' } })],
      [seen('Read'), seen('Edit', { path: 'a.ts' })],
    );
    assert.deepEqual([...result.argumentBlindCriterionIds], ['blind']);
  });
});

describe('F1-2 tool-call grading: duplicates', () => {
  it('requires count: 2 to be met by two calls and reports a partial match', () => {
    const result = gradeToolCalls(
      'c-1',
      [call('read-twice', 'Read', { count: 2 })],
      [seen('Read')],
    );
    assert.equal(result.expected[0]?.status, 'missing');
    assert.equal(result.expected[0]?.matchedObservedIndices.length, 1);
    assert.equal(result.recall, 0.5);
    assert.equal(result.passed, false);
  });

  it('reports a third identical call as a duplicate rather than as harmless', () => {
    const result = gradeToolCalls(
      'c-1',
      [call('read-twice', 'Read', { count: 2 })],
      [seen('Read'), seen('Read'), seen('Read')],
      { strictness: 'at_least' },
    );
    assert.equal(result.passed, true);
    assert.equal(result.unmatchedObserved.length, 1);
    assert.equal(result.unmatchedObserved[0]?.reason, 'duplicate');
  });

  it('distinguishes a duplicate from an argument mismatch on the unclaimed call', () => {
    const result = gradeToolCalls(
      'c-1',
      [call('read', 'Read', { args: { path: 'a.ts' } })],
      [seen('Read', { path: 'a.ts' }), seen('Read', { path: 'b.ts' })],
    );
    const reasons = result.unmatchedObserved.map((u) => u.reason).sort();
    assert.deepEqual(reasons, ['argument_mismatch']);
  });

  it('rejects an expectation with a non-positive count instead of grading it', () => {
    assert.throws(
      () => gradeToolCalls('c-1', [call('bad', 'Read', { count: 0 })], []),
      RangeError,
    );
  });
});

describe('F1-2 tool-call grading: scoring and provenance', () => {
  it('emits a graded score, not a boolean', () => {
    const result = gradeToolCalls(
      'c-1',
      [call('a', 'A'), call('b', 'B'), call('c', 'C'), call('d', 'D')],
      [seen('A'), seen('B')],
    );
    assert.equal(result.passed, false);
    assert.equal(result.recall, 0.5);
    assert.equal(result.precision, 1);
    assert.equal(result.f1, round4(2 * 0.5 * 1 / 1.5));
    assert.equal(result.score, result.f1, 'a perfect order keeps the score at f1');
  });

  it('is byte-identical across calls, with no clock or randomness anywhere', () => {
    const args = {
      expected: [call('read', 'Read', { args: { path: 'a.ts' } }), call('edit', 'Edit')],
      observed: [seen('Read', { path: 'a.ts' }), seen('Edit'), seen('Bash')],
    };
    const first = gradeToolCalls('c-1', args.expected, args.observed);
    const second = gradeToolCalls('c-1', args.expected, args.observed);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  it('carries the criteria that ran and the ones that failed, for a later audit', () => {
    const result = gradeToolCalls(
      'c-1',
      [call('read', 'Read'), call('edit', 'Edit'), call('grep', 'Grep', { order: 'unordered' })],
      [seen('Edit'), seen('Read')],
    );
    assert.deepEqual([...result.provenance.criteria], ['read', 'edit', 'grep']);
    // All three failed: `read` and `edit` matched but inverted, `grep` never
    // happened. An audit that saw only "one of them is fine" would be misled.
    assert.deepEqual([...result.provenance.failed], ['edit', 'grep', 'read']);
    assert.equal(result.provenance.grader, 'toolcall-v1');
    assert.equal(result.provenance.modelCall, 'none');
    assert.match(result.provenance.inputDigest, /^[0-9a-f]{8}$/);
  });

  it('changes the digest when the expectation changes, so an audit can detect a swapped fixture', () => {
    const observed = [seen('Read'), seen('Edit')];
    const a = gradeToolCalls('c-1', [call('read', 'Read')], observed);
    const b = gradeToolCalls('c-1', [call('read', 'Read', { args: { path: 'a.ts' } })], observed);
    assert.notEqual(a.provenance.inputDigest, b.provenance.inputDigest);
  });

  it('handles an empty expectation and an empty observation without NaN', () => {
    const nothingExpected = gradeToolCalls('c-1', [], []);
    assert.equal(nothingExpected.recall, 1);
    assert.equal(nothingExpected.precision, 1);
    assert.equal(nothingExpected.f1, 1);
    assert.equal(nothingExpected.score, 1);
    assert.equal(nothingExpected.orderScore, 1);

    const nothingObserved = gradeToolCalls('c-1', [call('read', 'Read')], []);
    assert.equal(nothingObserved.recall, 0);
    assert.equal(nothingObserved.precision, 1);
    assert.equal(nothingObserved.f1, 0);
    assert.equal(nothingObserved.score, 0);
    for (const value of [nothingExpected.score, nothingObserved.score, nothingExpected.f1]) {
      assert.ok(Number.isFinite(value));
    }
  });

  it('rejects a non-finite argument rather than grading it as JSON null', () => {
    assert.throws(
      () => gradeToolCalls('c-1', [call('read', 'Read', { args: { n: Number.NaN } })], [seen('Read')]),
      RangeError,
    );
    assert.throws(
      () => gradeToolCalls('c-1', [call('read', 'Read', { args: { n: Number.POSITIVE_INFINITY } })], [seen('Read')]),
      RangeError,
    );
  });

  it('names the offending argument and value in the rejection, so the bug is findable', () => {
    // A message reading "[object Object] is not finite" tells a recorder author
    // nothing about which field to fix.
    assert.throws(
      () => gradeToolCalls('c-1', [call('read', 'Read', { args: { budget: Number.NaN } })], []),
      (error: unknown) => {
        assert.ok(error instanceof RangeError);
        assert.match(error.message, /budget/);
        assert.match(error.message, /NaN/);
        assert.doesNotMatch(error.message, /\[object Object\]/);
        return true;
      },
    );
  });
});

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

// ----------------------------------------------------------------- rubric judge

const rubricDoc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  rubricFormatVersion: RUBRIC_FORMAT_VERSION,
  id: 'patch-quality',
  name: 'Patch quality',
  criteria: [
    { id: 'c-tests-pass', prompt: 'Do the new tests pass?', weight: 3, required: true, passThreshold: 1 },
    { id: 'c-files-changed', prompt: 'Were the right files changed?', weight: 1, required: false, passThreshold: 0.5 },
  ],
  ...over,
});

const goodRubric = (): Rubric => parseRubric(rubricDoc());

const verdict = (criterionId: string, score: number, rationale?: string) => ({
  criterionId,
  score,
  rationale,
});

const fullJudgement = (judgeId = 'judge-a'): RubricJudgement => ({
  judgeId,
  rubricId: 'patch-quality',
  verdicts: [verdict('c-tests-pass', 1, 'all green'), verdict('c-files-changed', 0.5, 'two files')],
});

describe('F1-2 rubric judge: validation of the definition', () => {
  it('accepts a well-formed rubric and freezes it', () => {
    const rubric = goodRubric();
    assert.equal(rubric.criteria.length, 2);
    assert.ok(Object.isFrozen(rubric));
    assert.ok(Object.isFrozen(rubric.criteria[0]));
  });

  it('rejects an unknown key rather than silently ignoring it', () => {
    const issues = validateRubric(rubricDoc({ author: 'me' }));
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.code, 'unknown_key');
    assert.equal(issues[0]?.path, 'author');
  });

  it('rejects a negative weight, a threshold outside [0,1], and a non-numeric score field', () => {
    const issues = validateRubric({
      ...rubricDoc(),
      criteria: [
        { id: 'c', prompt: 'p', weight: -1, required: true, passThreshold: 1 },
        { id: 'd', prompt: 'p', weight: 1, required: true, passThreshold: 1.5 },
        { id: 'e', prompt: 'p', weight: '1', required: true, passThreshold: 1 },
      ],
    });
    const codes = issues.map((i) => `${i.path}:${i.code}`).sort();
    assert.deepEqual(codes, [
      'criteria[0].weight:range',
      'criteria[1].passThreshold:range',
      'criteria[2].weight:type',
    ]);
  });

  it('rejects duplicate criterion ids', () => {
    const issues = validateRubric({
      ...rubricDoc(),
      criteria: [
        { id: 'dup', prompt: 'p', weight: 1, required: true, passThreshold: 1 },
        { id: 'dup', prompt: 'q', weight: 1, required: false, passThreshold: 1 },
      ],
    });
    assert.equal(issues[0]?.code, 'duplicate');
  });

  it('rejects a rubric whose weights all cancel to nothing', () => {
    const issues = validateRubric({
      ...rubricDoc(),
      criteria: [{ id: 'c', prompt: 'p', weight: 0, required: true, passThreshold: 1 }],
    });
    assert.equal(issues[0]?.code, 'rule');
    assert.match(issues[0]?.message ?? '', /weights sum/);
  });

  it('rejects a rubric with no required criterion, because it can never fail', () => {
    const issues = validateRubric({
      ...rubricDoc(),
      criteria: [{ id: 'c', prompt: 'p', weight: 1, required: false, passThreshold: 1 }],
    });
    assert.equal(issues[0]?.code, 'rule');
    assert.match(issues[0]?.message ?? '', /no required criterion/);
  });

  it('rejects a stale format version on its own, before listing consequences', () => {
    const issues = validateRubric(rubricDoc({ rubricFormatVersion: 0 }));
    assert.deepEqual(issues.map((i) => i.code), ['version']);
  });

  it('reports every problem at once, not just the first', () => {
    const issues = validateRubric({ criteria: [] });
    assert.ok(issues.length >= 3, `expected several issues, got ${issues.length}`);
  });

  it('exposes a throwing parse and a non-throwing parse', () => {
    assert.throws(() => parseRubric({}), RubricError);
    assert.equal(safeParseRubric(rubricDoc()).ok, true);
    assert.equal(safeParseRubric({}).ok, false);
  });
});

describe('F1-2 rubric judge: the model call is injected, not made', () => {
  it('grades from an injected judgement and names the deferred model call', () => {
    const result = gradeRubric(
      goodRubric(),
      { caseId: 'e4-001', text: 'diff --git ...', evidence: ['a.ts'] },
      fullJudgement(),
    );
    assert.equal(result.status, 'pass');
    assert.equal(result.passed, true);
    assert.equal(result.score, 0.875);
    assert.equal(result.modelCallDeferredTo, RUBRIC_MODEL_CALL_DEFERRED_TO);
    assert.equal(result.provenance.modelCall, 'deferred-to-F2');
  });

  it('fails a required criterion below its threshold without touching the score', () => {
    const result = gradeRubric(
      goodRubric(),
      { caseId: 'e4-001', text: '', evidence: [] },
      { judgeId: 'j', rubricId: 'patch-quality', verdicts: [verdict('c-tests-pass', 0.9), verdict('c-files-changed', 1)] },
    );
    assert.equal(result.status, 'fail');
    assert.deepEqual([...result.failedCriterionIds], ['c-tests-pass']);
    // 0.9*0.75 + 1*0.25 = 0.925: the graded score is continuous and is not
    // moved by the gate, so a suite author cannot raise a number by moving a
    // threshold.
    assert.equal(result.score, 0.925);
  });

  it('lets an optional criterion move the score without failing the run', () => {
    const result = gradeRubric(
      goodRubric(),
      { caseId: 'e4-001', text: '', evidence: [] },
      { judgeId: 'j', rubricId: 'patch-quality', verdicts: [verdict('c-tests-pass', 1), verdict('c-files-changed', 0)] },
    );
    assert.equal(result.status, 'pass');
    assert.equal(result.failedCriterionIds.length, 0, 'an optional criterion is not a gate');
    // It is still a finding about the artifact, and the audit record keeps it.
    assert.deepEqual([...result.belowThresholdCriterionIds], ['c-files-changed']);
    assert.equal(result.score, 0.75);
  });

  it('reports a missing required verdict as inconclusive, not as a zero', () => {
    const result = gradeRubric(
      goodRubric(),
      { caseId: 'e4-001', text: '', evidence: [] },
      { judgeId: 'j', rubricId: 'patch-quality', verdicts: [verdict('c-files-changed', 1)] },
    );
    assert.equal(result.status, 'inconclusive');
    assert.equal(result.passed, false);
    assert.deepEqual([...result.missingCriterionIds], ['c-tests-pass']);
    assert.deepEqual([...result.provenance.failed], ['c-tests-pass']);
    assert.equal(result.criteria.find((c) => c.id === 'c-tests-pass')?.score, null);
  });

  it('can be opted into fail-closed on a missing verdict, explicitly', () => {
    const result = gradeRubric(
      goodRubric(),
      { caseId: 'e4-001', text: '', evidence: [] },
      { judgeId: 'j', rubricId: 'patch-quality', verdicts: [verdict('c-files-changed', 1)] },
      { missingVerdict: 'zero' },
    );
    assert.equal(result.status, 'fail');
    assert.equal(result.score, 0.25);
  });

  it('carries the criteria that ran, the ones that failed, and an input digest', () => {
    const result = gradeRubric(
      goodRubric(),
      { caseId: 'e4-001', text: 'a', evidence: [] },
      { judgeId: 'j', rubricId: 'patch-quality', verdicts: [verdict('c-tests-pass', 1), verdict('c-files-changed', 0)] },
    );
    assert.deepEqual([...result.provenance.criteria], ['c-tests-pass', 'c-files-changed']);
    assert.deepEqual([...result.provenance.failed], ['c-files-changed']);
    assert.match(result.provenance.inputDigest, /^[0-9a-f]{8}$/);
  });

  it('is byte-identical across calls', () => {
    const rubric = goodRubric();
    const artifact = { caseId: 'e4-001', text: 'same', evidence: ['a.ts'] };
    const a = gradeRubric(rubric, artifact, fullJudgement());
    const b = gradeRubric(rubric, artifact, fullJudgement());
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  it('rejects an artifact with no case id, which could not be audited', () => {
    assert.throws(
      () => gradeRubric(goodRubric(), { caseId: '  ', text: '', evidence: [] }, fullJudgement()),
      TypeError,
    );
  });
});

describe('F1-2 rubric judge: negative tests on the injected verdict', () => {
  const artifact = { caseId: 'e4-001', text: '', evidence: [] };

  it('rejects a verdict for a criterion the rubric does not define', () => {
    const issues = validateJudgement(goodRubric(), {
      judgeId: 'j',
      rubricId: 'patch-quality',
      verdicts: [verdict('c-invented', 1)],
    });
    assert.equal(issues[0]?.code, 'unknown_criterion');
    assert.throws(
      () => gradeRubric(goodRubric(), artifact, { judgeId: 'j', rubricId: 'patch-quality', verdicts: [verdict('c-invented', 1)] }),
      JudgementError,
    );
  });

  it('rejects two verdicts for one criterion, which averaging would silently invent', () => {
    const issues = validateJudgement(goodRubric(), {
      judgeId: 'j',
      rubricId: 'patch-quality',
      verdicts: [verdict('c-tests-pass', 1), verdict('c-tests-pass', 0)],
    });
    assert.equal(issues[0]?.code, 'duplicate');
  });

  it('rejects a score outside [0,1] and a NaN, before either can reach a report', () => {
    const tooBig = validateJudgement(goodRubric(), {
      judgeId: 'j', rubricId: 'patch-quality', verdicts: [verdict('c-tests-pass', 7)],
    });
    assert.equal(tooBig[0]?.code, 'range');
    const notANumber = validateJudgement(goodRubric(), {
      judgeId: 'j', rubricId: 'patch-quality', verdicts: [verdict('c-tests-pass', Number.NaN)],
    });
    assert.equal(notANumber[0]?.code, 'range');
  });

  it('rejects verdicts labelled with a different rubric, the signature of two concatenated runs', () => {
    const issues = validateJudgement(goodRubric(), {
      judgeId: 'j', rubricId: 'some-other-rubric', verdicts: [verdict('c-tests-pass', 1)],
    });
    assert.equal(issues[0]?.code, 'mismatch');
  });

  it('rejects a verdict with no judge id', () => {
    const issues = validateJudgement(goodRubric(), {
      judgeId: '', rubricId: 'patch-quality', verdicts: [verdict('c-tests-pass', 1)],
    });
    assert.equal(issues[0]?.code, 'missing');
  });

  it('accepts a verdict that omits rubricId entirely', () => {
    const issues = validateJudgement(goodRubric(), {
      judgeId: 'j', rubricId: undefined, verdicts: [verdict('c-tests-pass', 1)],
    });
    assert.deepEqual(issues, []);
  });
});

describe('F1-2 rubric judge: the blinded prompt', () => {
  it('includes every criterion and the artifact, and nothing time-dependent', () => {
    const prompt = renderRubricPrompt(goodRubric(), {
      caseId: 'e4-001',
      text: '--- a/pipeline/src/truncate.ts',
      evidence: ['pipeline/src/truncate.ts'],
    });
    assert.match(prompt, /c-tests-pass \(required\)/);
    assert.match(prompt, /c-files-changed \(optional\)/);
    assert.match(prompt, /a\/pipeline\/src\/truncate\.ts/);
    assert.doesNotMatch(prompt, /\d{4}-\d{2}-\d{2}T/);
  });

  it('is a pure function of (rubric, artifact), so a judge cannot be irreproducible', () => {
    const rubric = goodRubric();
    const artifact = { caseId: 'e4-001', text: 'same', evidence: ['a.ts'] };
    assert.equal(renderRubricPrompt(rubric, artifact), renderRubricPrompt(rubric, artifact));
  });

  it('cannot carry an arm label: the artifact type has no field that could hold one', () => {
    // The blinding guarantee is structural, not a convention. Two artifacts that
    // are equal in content but not in identity must render identically, so
    // nothing downstream of the prompt can vary by arm.
    const rubric = goodRubric();
    const artifact: RubricArtifact = { caseId: 'e4-001', text: 'same', evidence: [] };
    const twin: RubricArtifact = { caseId: 'e4-001', text: 'same', evidence: [] };
    assert.equal(renderRubricPrompt(rubric, artifact), renderRubricPrompt(rubric, twin));
  });
});
