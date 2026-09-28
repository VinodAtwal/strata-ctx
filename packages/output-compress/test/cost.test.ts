import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { EpsInput } from '../src/index.js';
import {
  estimateTextTokens,
  inputReductionFraction,
  measureEps,
  measureFormatSavings,
  measureText,
  parseToon,
  serializeToon,
} from '../src/index.js';

import { WIDE_ROWS } from './fixtures.js';

const eps = (over: Partial<EpsInput> = {}): EpsInput => ({
  inputTokensBefore: 10_000,
  inputTokensAfter: 5_000,
  outputTokensBefore: 1_000,
  outputTokensAfter: 1_100,
  rho: 4,
  k: 1,
  ...over,
});

describe('H-5 token estimation', () => {
  it('divides by four and rounds up', () => {
    assert.equal(estimateTextTokens(''), 0);
    assert.equal(estimateTextTokens('a'), 1);
    assert.equal(estimateTextTokens('abcd'), 1);
    assert.equal(estimateTextTokens('abcde'), 2);
  });

  it('reports chars alongside tokens', () => {
    assert.deepEqual(measureText('abcde'), { chars: 5, tokens: 2 });
  });

  it('counts code units, not bytes and not graphemes', () => {
    // Documented as a rough estimate for budgeting, so the unit has to be stated:
    // an emoji is two code units and a real tokenizer sees it differently again.
    assert.equal(measureText('😀').chars, 2);
  });
});

describe('H-5 savings', () => {
  it('measures a real saving on a real table', () => {
    const json = JSON.stringify(WIDE_ROWS.rows);
    const toon = serializeToon(WIDE_ROWS.rows);
    const savings = measureFormatSavings(json, toon);
    assert.ok(savings.tokensSaved > 0);
    assert.ok(savings.worthIt);
    assert.ok(savings.fractionSaved > 0.2, `fractionSaved was ${savings.fractionSaved}`);
  });

  it('reports a negative saving when the format is longer', () => {
    const savings = measureFormatSavings('ab', 'abcdefgh');
    assert.equal(savings.tokensSaved, -1);
    assert.equal(savings.fractionSaved, -1);
    assert.equal(savings.worthIt, false);
  });

  it('is zero, not NaN, against an empty baseline', () => {
    // The default floor compares against this number, so NaN here would make
    // every empty case fail the floor for the wrong reason.
    const savings = measureFormatSavings('', 'abcd');
    assert.equal(savings.fractionSaved, 0);
    assert.equal(savings.worthIt, false);
  });

  it('agrees with the round trip it is measuring', () => {
    const json = JSON.stringify(WIDE_ROWS.rows);
    const toon = serializeToon(WIDE_ROWS.rows);
    assert.deepEqual(parseToon(toon), WIDE_ROWS.rows);
    assert.equal(measureFormatSavings(json, toon).to.chars, toon.length);
  });
});

describe('H-5 the breakeven verdict', () => {
  it('says compress when the input halved and the output barely moved', () => {
    const report = measureEps(eps());
    assert.equal(report.verdict, 'compress');
    assert.equal(report.reason, 'within_budget');
    assert.equal(report.breakevenOk, true);
    assert.equal(report.r, 0.5);
    assert.equal(report.eps, 1.1);
    assert.ok(report.netSavings > 0);
  });

  it('says do_not_compress when the output expansion eats the input saving', () => {
    // The case the whole formula exists for: a 50% input saving is worthless if
    // the model answers twice as long. The net token saving is positive (1000)
    // but the price-weighted cost is not breakeven because output is ~4x more
    // expensive than input (rho=4), so the weighted cost exceeds the input saving.
    const report = measureEps(eps({ outputTokensAfter: 2_000 }));
    assert.equal(report.verdict, 'do_not_compress');
    assert.equal(report.reason, 'breakeven_failed');
    assert.equal(report.breakevenOk, false);
    assert.ok(report.netSavings > 0, 'raw token saving is positive but weighted breakeven fails');
  });

  it('says do_not_compress when there was no input saving at all', () => {
    // `breakevenOk` calls r=0, eps=1 a pass, which is correct arithmetic and the
    // wrong decision: nothing was saved, so there is nothing to protect.
    const report = measureEps(eps({ inputTokensAfter: 10_000 }));
    assert.equal(report.reason, 'no_input_saving');
    assert.equal(report.verdict, 'do_not_compress');
    assert.equal(report.r, 0);
  });

  it('says do_not_compress when the input grew', () => {
    const report = measureEps(eps({ inputTokensAfter: 12_000 }));
    assert.equal(report.reason, 'input_grew');
    assert.equal(report.verdict, 'do_not_compress');
    assert.ok(report.r < 0, 'r is allowed to be negative and must not be clamped');
  });

  it('reports an unbounded expansion as not finite rather than as a number', () => {
    // Output from nothing to something has no ratio. Reporting `null` into a JSON
    // sink would be a number-shaped lie.
    const report = measureEps(eps({ outputTokensBefore: 0, outputTokensAfter: 500 }));
    assert.equal(report.epsFinite, false);
    assert.equal(report.eps, Number.POSITIVE_INFINITY);
    assert.equal(report.reason, 'eps_not_finite');
    assert.equal(report.verdict, 'do_not_compress');
    assert.ok(report.detail.includes('inf'));
  });

  it('treats no output on either side as a ratio of one', () => {
    const report = measureEps(eps({ outputTokensBefore: 0, outputTokensAfter: 0 }));
    assert.equal(report.eps, 1);
    assert.equal(report.epsFinite, true);
  });

  it('is unaffected by a zero k, which disables the cost model', () => {
    // `breakevenOk` returns true for k<=0, so a caller who has not measured what
    // fraction of spend this is gets a pass rather than a fabricated ratio.
    const report = measureEps(eps({ k: 0, outputTokensAfter: 9_000 }));
    assert.equal(report.k, 0);
    assert.equal(report.breakevenOk, true);
  });

  it('degrades rather than throws on a nonsensical configuration', () => {
    for (const over of [
      { rho: -4 },
      { k: -1 },
      { rho: Number.NaN },
      { k: Number.POSITIVE_INFINITY },
      { inputTokensBefore: -1 },
      { inputTokensAfter: Number.NaN },
    ]) {
      const report = measureEps(eps(over));
      assert.ok(report.rho >= 0 && report.k >= 0, `bad clamp for ${JSON.stringify(over)}`);
      assert.equal(typeof report.verdict, 'string');
    }
  });

  it('carries a decidable reason, not just prose', () => {
    // Telemetry keys off this field. A reason that has to be parsed out of a
    // sentence cannot be counted.
    const reasons = new Set<string>();
    for (const over of [{}, { outputTokensAfter: 2_000 }, { inputTokensAfter: 10_000 }, { inputTokensAfter: 12_000 }, { outputTokensBefore: 0 }]) {
      reasons.add(measureEps(eps(over)).reason);
    }
    assert.equal(reasons.size, 5);
  });

  it('agrees with core-types breakevenOk on the same numbers', () => {
    // The report must not be able to disagree with the helper the rest of the
    // system already uses, or the same measurement gets two answers.
    for (const over of [{}, { outputTokensAfter: 2_000 }, { outputTokensAfter: 1_050 }]) {
      const report = measureEps(eps(over));
      const recomputed = report.eps < 1 + (1 - report.r) / (report.rho * report.k);
      assert.equal(report.breakevenOk, recomputed);
    }
  });
});

describe('H-5 input reduction', () => {
  it('is a fraction, and can be negative', () => {
    assert.equal(inputReductionFraction(100, 50), 0.5);
    assert.equal(inputReductionFraction(100, 0), 1);
    assert.equal(inputReductionFraction(100, 200), -1);
  });

  it('is zero when there was nothing to reduce', () => {
    assert.equal(inputReductionFraction(0, 0), 0);
    assert.equal(inputReductionFraction(0, 10), -1);
  });

  it('clamps a nonsensical input rather than propagating it', () => {
    assert.equal(inputReductionFraction(Number.NaN, 10), -1);
    assert.equal(inputReductionFraction(-5, -5), 0);
  });
});
