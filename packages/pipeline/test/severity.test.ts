import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { LossyContext, NonGovernanceMessage } from '@strata-ctx/core-types';
import { partitionForLossy } from '@strata-ctx/core-types';

import {
  POINTER_MARKER,
  RETAINED_MARKER,
  TRUNCATION_MARKER,
  applySeverityClassification,
  applyTruncate,
  classifyBlockSeverity,
  classifyExitCode,
  classifySeverity,
  extractExitCode,
  lineSeverity,
  maxSeverity,
  pointerStub,
  severityAtLeast,
  truncateText,
} from '../src/index.js';

import { lines, message, policy, state, toolResult } from './fixtures.js';

const ctxOf = (messages: readonly NonGovernanceMessage[]): LossyContext =>
  partitionForLossy(state({ messages: [...messages] }), policy());

describe('B-4 severity: line classification', () => {
  it('reads crash evidence as fatal', () => {
    for (const line of [
      'fatal: cannot continue',
      'panic: runtime error: index out of range',
      'Traceback (most recent call last):',
      'Segmentation fault (core dumped)',
      'signal: 9',
      'Killed',
    ]) {
      assert.equal(lineSeverity(line), 'fatal', line);
    }
  });

  it('does not read prose as a crash', () => {
    assert.notEqual(lineSeverity('the migration killed the old table'), 'fatal');
    assert.notEqual(lineSeverity('signal handling looks wrong'), 'fatal');
  });

  it('reads ordinary failure evidence as error', () => {
    for (const line of [
      "src/a.ts(1,1): error TS2304: Cannot find name 'foo'",
      'npm ERR! code ELIFECYCLE',
      'Exception in thread "main"',
      'bash: command not found: frobnicate',
      'failing test: expected 1 to equal 2',
    ]) {
      assert.equal(lineSeverity(line), 'error', line);
    }
  });

  it('does not let a zero count escalate a passing build log', () => {
    for (const line of [
      'Found 0 errors in 2 files.',
      'warnings: 0',
      'failures: none',
      'no errors detected',
      '0 warnings, 0 errors',
      '0 failing',
      'failing: 0',
    ]) {
      assert.notEqual(lineSeverity(line), 'error', line);
    }
  });

  it('reads warnings, debug and noise as themselves', () => {
    assert.equal(lineSeverity('warning: deprecated api'), 'warn');
    assert.equal(lineSeverity('note: this is a note'), 'warn');
    assert.equal(lineSeverity('[debug] entering loop'), 'debug');
    assert.equal(lineSeverity('compiled 12 files in 3.2s'), 'info');
    assert.equal(lineSeverity(''), 'info');
  });

  it('is case-insensitive where a build log is', () => {
    assert.equal(lineSeverity('ERROR: it broke'), 'error');
    assert.equal(lineSeverity('FATAL'), 'fatal');
  });

  it('never classifies a strata marker as evidence', () => {
    // The failure this prevents: `[strata:retained] 2 error/fatal lines` reads as
    // a crash report to a regex, so a block Tier 0 already truncated would be
    // marked fatal and then skipped by the cap, the pointer-izer and the deduper
    // on every later turn.
    for (const line of [
      `${RETAINED_MARKER} 2 error/fatal lines`,
      `${TRUNCATION_MARKER} 217 lines / 3495 chars elided`,
      POINTER_MARKER,
      '  [strata:truncated] 4 lines elided',
    ]) {
      assert.equal(lineSeverity(line), 'info', line);
    }
  });

  it('classifies no marker this package emits above info', () => {
    // Guards the namespace convention itself: every marker a Tier 0 operator
    // writes must survive the classifier untouched, whatever it says.
    const rendered = [
      pointerStub(toolResult({ ref: 'f.ts', kind: 'file', text: lines(50) }), 'artifact://file/abc', 'abc'),
      truncateText(lines(500, 'noisy'), 200).text,
      truncateText(`${lines(60, 'head')}\nfatal: disk full\n${lines(60, 'tail')}`, 300).text,
    ];
    for (const text of rendered) {
      for (const line of text.split('\n')) {
        if (line.trim().startsWith('[strata:')) {
          assert.equal(lineSeverity(line), 'info', line);
        }
      }
    }
  });
});

describe('B-4 severity: block classification', () => {
  it('takes the maximum severity in the block, not the first', () => {
    assert.equal(
      classifySeverity('all good\nall fine\nfatal: the disk is gone'),
      'fatal',
    );
    assert.equal(classifySeverity('all good\nsrc/a.ts: error TS1'), 'error');
  });

  it('returns undefined for empty or absent text rather than a fake severity', () => {
    assert.equal(classifySeverity(''), undefined);
    assert.equal(classifySeverity(undefined), undefined);
    assert.equal(classifySeverity('   \n\n  '), undefined);
  });

  it('prefers a producer-declared severity and never downgrades it', () => {
    const declared = toolResult({ ref: 'x', text: 'nothing interesting', severity: 'error' });
    assert.equal(classifyBlockSeverity(declared), 'error');
  });

  it('reads an exit code out of the output when there is no field for it', () => {
    assert.equal(extractExitCode('process exited with code 1'), 1);
    assert.equal(extractExitCode('exit status: 2'), 2);
    assert.equal(extractExitCode('exit_code=137'), 137);
    assert.equal(extractExitCode('no code here'), undefined);
  });

  it('maps a non-zero exit code to error and zero to info', () => {
    assert.equal(classifyExitCode(0), 'info');
    assert.equal(classifyExitCode(1), 'error');
    assert.equal(classifyExitCode(137), 'error');
  });
});

describe('B-4 severity: severity algebra', () => {
  it('orders severity and never downgrades on merge', () => {
    assert.equal(maxSeverity('info', 'warn'), 'warn');
    assert.equal(maxSeverity('fatal', 'error'), 'fatal');
    assert.equal(maxSeverity('error', 'error'), 'error');
    assert.ok(severityAtLeast('fatal', 'error'));
    assert.ok(severityAtLeast('error', 'error'));
    assert.ok(!severityAtLeast('warn', 'error'));
  });
});

describe('B-4 severity: application over a context', () => {
  it('labels inferred blocks and leaves declared ones alone', () => {
    const ctx = ctxOf([
      message('user', [
        toolResult({ ref: 'build', text: 'src/a.ts: error TS2304' }),
        toolResult({ ref: 'ok', text: 'compiled cleanly' }),
        toolResult({ ref: 'warn', text: 'warning: deprecated' }),
        toolResult({ ref: 'declared', text: 'looks fine to me', severity: 'fatal' }),
        toolResult({ ref: 'empty', text: '' }),
      ]),
    ]);

    const { ctx: out, report } = applySeverityClassification(ctx);
    const byRef = new Map(
      out.messages.flatMap((m) => m.content.map((b) => [b.meta.subject?.ref, b.meta.severity])),
    );

    assert.equal(byRef.get('build'), 'error');
    assert.equal(byRef.get('ok'), 'info');
    assert.equal(byRef.get('warn'), 'warn');
    assert.equal(byRef.get('declared'), 'fatal');
    assert.equal(byRef.get('empty'), undefined, 'an empty result has no severity to claim');

    assert.equal(report.classified, 3);
    assert.equal(report.raised, 0, 'a label is only raised, never lowered');
    assert.equal(report.deferredToProducer, 1);
    assert.equal(report.empty, 1);
  });

  it('never lowers a severity the producer already set', () => {
    const ctx = ctxOf([
      message('user', [toolResult({ ref: 'x', text: 'all clean here', severity: 'error' })]),
    ]);
    const { ctx: out, report } = applySeverityClassification(ctx);
    assert.equal(out.messages[0]?.content[0]?.meta.severity, 'error');
    assert.equal(report.raised, 0);
  });

  it('does not mutate the input context', () => {
    const original = toolResult({ ref: 'build', text: 'src/a.ts: error TS2304' });
    const before = structuredClone(original);
    const ctx = ctxOf([message('user', [original])]);
    applySeverityClassification(ctx);
    assert.deepEqual(original, before);
  });
});

describe('B-4 severity: interaction with the cap', () => {
  it('does not let an inferred severity buy a block immunity from the cap', () => {
    // A failing build log is the largest thing in most transcripts. If B-4's own
    // label exempted it, Tier 0 would skip the payload it exists for.
    const { ctx: out, report } = applyTruncate(
      ctxOf([
        message('user', [
          toolResult({ ref: 'build', text: `${lines(400, 'ok')}\nfatal: out of disk\n${lines(400, 'ok')}` }),
        ]),
      ]),
    );
    const result = out.messages[0]?.content[0];
    assert.ok(result);
    assert.equal(result.meta.severity, 'fatal', 'the label is still written');
    assert.ok((result.text ?? '').length < 700, 'and the cap still applied');
    assert.ok((result.text ?? '').includes('fatal: out of disk'), 'but every fatal line survives');
    assert.equal(report.pointerize.pointerized, 0);
  });
});
