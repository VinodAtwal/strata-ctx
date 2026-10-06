import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { BudgetPolicy, TriggerPolicy } from '@strata-ctx/core-types';
import {
  budgetView,
  estimateBlockTokens,
  estimateMessageTokens,
  estimateTokens,
  partitionForLossy,
} from '@strata-ctx/core-types';

import { evaluateTrigger, reserveFor, triggerFor } from '../src/trigger.js';
import type { TriggerDecision } from '../src/trigger.js';
import {
  PESSIMISTIC_BAND,
  PUNCTUATION_EXCESS,
  TokenCalibrator,
  calibrationReport,
  calibrationSample,
  pessimisticBlockTokens,
  pessimisticCount,
  pessimisticLossyTokens,
  pessimisticMessageTokens,
  pessimisticMultiplier,
  pessimisticStateTokens,
  tokenContentClass,
} from '../src/token-budget.js';
import type { TokenContentClass } from '../src/token-budget.js';

import { block, message, policy, state } from './fixtures.js';

/**
 * P0-2 falsification suite.
 *
 * The claim under test is not "the estimate is accurate" -- no heuristic here is. It is
 * "a budget decision can never be made on an estimate that reads low". Every assertion
 * below is chosen so that replacing `max` with `min`, dropping `PUNCTUATION_EXCESS`,
 * re-admitting the comparative estimator, or un-branding the trigger input turns it red.
 */

const JSON_TEXT =
  '{"name":"strata-ctx","tags":["compress","dedupe","gists"],"n":3,"ok":true,"nested":{"a":[1,2,3]}}';
const SYMBOL_TEXT = '#$%&*!<>?~^|@+=_'.repeat(8);
const PROSE_TEXT = 'The patient is allergic to penicillin, so the order must be amended. '.repeat(12);
const CODE_TEXT = 'function add(a, b) { return a + b; }\n'.repeat(12);
const TRACE_TEXT = '  File "src/a.py", line 3\n    return {"x": [1, 2]}\nValueError: bad';
const BASE64_TEXT = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5'.repeat(40);

interface Case {
  readonly name: string;
  readonly text: string;
  readonly contentClass: TokenContentClass;
}

const CASES: readonly Case[] = [
  { name: 'empty', text: '', contentClass: 'prose' },
  { name: 'whitespace only', text: '   \n\t ', contentClass: 'prose' },
  { name: 'natural prose', text: PROSE_TEXT, contentClass: 'prose' },
  { name: 'a single short word', text: 'ok', contentClass: 'prose' },
  { name: 'source code', text: CODE_TEXT, contentClass: 'code' },
  { name: 'TOON-shaped rows', text: 'users[2]{id,name}:\n1,ada\n2,lin\n'.repeat(10), contentClass: 'code' },
  { name: 'a stack trace with a JSON payload', text: TRACE_TEXT, contentClass: 'code' },
  { name: 'pure JSON', text: JSON_TEXT, contentClass: 'json' },
  { name: 'JSON, long', text: `${JSON_TEXT}\n`.repeat(40), contentClass: 'json' },
  { name: 'mixed prose, JSON and symbols', text: `${PROSE_TEXT}${JSON_TEXT}${SYMBOL_TEXT}`, contentClass: 'code' },
  { name: 'punctuation-dense prose', text: '!!! ??? --- ...'.repeat(20), contentClass: 'symbols' },
  { name: 'special characters', text: SYMBOL_TEXT, contentClass: 'symbols' },
  { name: 'very long single token', text: 'a'.repeat(120_000), contentClass: 'prose' },
  { name: 'a very long single token of symbols', text: '#'.repeat(120_000), contentClass: 'symbols' },
  { name: 'base64 payload', text: BASE64_TEXT, contentClass: 'prose' },
  { name: 'CJK prose', text: '患者对青霉素过敏，因此必须修改医嘱。'.repeat(20), contentClass: 'prose' },
  { name: 'emoji', text: '\u{1F600}\u{1F680}\u{1F6A7}'.repeat(200), contentClass: 'prose' },
];

const at = (c: Case) => block({ text: c.text });

describe('P0-2 pessimistic estimator: classification', () => {
  for (const c of CASES) {
    it(`files ${c.name} as ${c.contentClass}`, () => {
      assert.equal(tokenContentClass(c.text), c.contentClass);
    });
  }
});

describe('P0-2 pessimistic estimator: the floor', () => {
  for (const c of CASES) {
    it(`never returns less than the comparative estimate for ${c.name}`, () => {
      const b = at(c);
      assert.ok(
        pessimisticBlockTokens(b) >= estimateBlockTokens(b),
        `${c.name}: ${pessimisticBlockTokens(b)} < ${estimateBlockTokens(b)}`,
      );
    });
  }

  it('is exactly the comparative estimate for ASCII prose', () => {
    // This is what pins the BYTES_PER_TOKEN and PER_BLOCK_OVERHEAD_TOKENS restated from
    // core-types. If either drifts, prose stops agreeing and this fails rather than the
    // drift reaching a budget decision.
    for (const text of ['', 'ok', PROSE_TEXT, 'a'.repeat(4_000), 'the quick brown fox jumps over it']) {
      const b = block({ text });
      assert.equal(pessimisticBlockTokens(b), estimateBlockTokens(b), JSON.stringify(text.slice(0, 40)));
      assert.equal(pessimisticMultiplier(text), 1.0);
    }
  });

  it('rises above the floor for every class the measurement flagged', () => {
    for (const c of CASES.filter((x) => x.contentClass === 'json' || x.contentClass === 'symbols')) {
      assert.ok(
        pessimisticBlockTokens(at(c)) > estimateBlockTokens(at(c)),
        `${c.name}: the comparative estimate was not corrected`,
      );
    }
  });

  it('monotonic: more text is never fewer tokens', () => {
    for (const c of CASES) {
      let previous = 0;
      for (let n = 0; n <= 8; n += 1) {
        const cut = Math.floor((c.text.length * n) / 8);
        const tokens = pessimisticBlockTokens(block({ text: c.text.slice(0, cut) }));
        assert.ok(tokens >= previous, `${c.name}: shrank at n=${n}`);
        previous = tokens;
      }
    }
  });
});

describe('P0-2 pessimistic estimator: the declared band', () => {
  it('derives the ASCII ceiling from PUNCTUATION_EXCESS and no further', () => {
    // A multiplier cannot exceed 1.0 + PUNCTUATION_EXCESS, because expensive is a subset
    // of ascii. If the ceiling in PESSIMISTIC_BAND ever exceeds that, it is a promise the
    // estimator cannot keep.
    const [, ceiling] = PESSIMISTIC_BAND.predictedOverComparative;
    assert.equal(ceiling, 1.0 + PUNCTUATION_EXCESS);
    for (const c of CASES.filter((x) => !/[^\p{ASCII}]/u.test(x.text))) {
      assert.ok(pessimisticMultiplier(c.text) <= ceiling, `${c.name}: ${pessimisticMultiplier(c.text)}`);
    }
  });

  it('clears the worst measured ratio for each class [7]', () => {
    // Measured maxima: prose 0.97x, code ~0.95x, JSON 1.49x, symbols 2.49x. A budget
    // decision must not be optimistic about content that has actually been measured.
    const CLEARED: readonly (readonly [string, number])[] = [
      [JSON_TEXT.repeat(40), 1.49],
      [SYMBOL_TEXT, 2.49],
    ];
    for (const [text, measuredMax] of CLEARED) {
      const b = block({ text });
      const comparative = estimateBlockTokens(b);
      const predicted = pessimisticBlockTokens(b);
      // The measured ratio is a property of the tokenizer's packing of *content*, so the
      // fixture's "real" count applies the ratio to the content term and keeps the same
      // envelope. Applying it to the envelope instead would double-count.
      const observed = Math.ceil((comparative - 3) * measuredMax) + 3;
      assert.ok(
        predicted >= observed,
        `measured ${measuredMax}x: predicted ${predicted} < observed ${observed}`,
      );
    }
  });

  for (const [name, text, ratio] of [
    ['JSON', JSON_TEXT.repeat(40), 1.43],
    ['special characters', SYMBOL_TEXT, 2.43],
  ] as const) {
    it(`lands inside the declared band for a fixture reproducing the measured ${ratio}x ${name}`, () => {
      const b = block({ text });
      const comparative = estimateBlockTokens(b);
      const observed = Math.ceil((comparative - 3) * ratio) + 3;

      const sample = calibrationSample(b, observed);
      const [low, high] = PESSIMISTIC_BAND.predictedOverComparative;
      assert.ok(
        sample.predictedOverComparative >= low && sample.predictedOverComparative <= high,
        `${name}: predicted/comparative ${sample.predictedOverComparative} outside [${low}, ${high}]`,
      );
      assert.ok(sample.predicted >= observed, `${name}: predicted ${sample.predicted} < observed ${observed}`);
      assert.ok(sample.observedOverPredicted <= 1, `${name}: under-counted at ${sample.observedOverPredicted}`);
    });
  }

  it('holds the band across every adversarial case', () => {
    const samples = CASES.map((c) => calibrationSample(at(c), estimateBlockTokens(at(c))));
    const report = calibrationReport(samples);
    assert.equal(report.observedAny, true);
    for (const s of report.samples) {
      const bound = s.nonAscii
        ? PESSIMISTIC_BAND.nonAsciiOverComparative
        : PESSIMISTIC_BAND.predictedOverComparative;
      assert.ok(
        s.predictedOverComparative >= bound[0] && s.predictedOverComparative <= bound[1],
        `${s.contentClass}/${s.nonAscii ? 'non-ascii' : 'ascii'}: ${s.predictedOverComparative} outside [${bound[0]}, ${bound[1]}]`,
      );
    }
    assert.equal(report.withinBand, true);
  });

  it('holds the non-ASCII band at the rate NON_ASCII_UNITS implies', () => {
    // A BMP code point is one UTF-16 unit, so `chars/4` gives it a quarter of a token
    // while the pessimistic estimator gives it 8 ASCII-equivalents. That ratio is 8, and
    // the declared ceiling is 8; if either number moves, one of them has to move with it.
    const sample = calibrationSample(block({ text: '患'.repeat(400) }), 0);
    const [, ceiling] = PESSIMISTIC_BAND.nonAsciiOverComparative;
    assert.equal(sample.nonAscii, true);
    assert.ok(sample.predictedOverComparative <= ceiling, `${sample.predictedOverComparative} > ${ceiling}`);
    assert.ok(sample.predictedOverComparative > 7, 'the correction is not doing anything');
  });
});

describe('P0-2 pessimistic estimator: message and state parity', () => {
  it('never returns less than the comparative estimate for a whole message', () => {
    const m = message('user', CASES.map(at));
    assert.ok(pessimisticMessageTokens(m) >= estimateMessageTokens(m));
  });

  it('never returns less than the comparative estimate for a whole state', () => {
    const s = state({ messages: [message('system', CASES.map(at)), message('user', [at(CASES[2]!)])] });
    assert.ok(pessimisticStateTokens(s) >= estimateTokens(s));
  });

  it('sums to the branded lossy estimate', () => {
    const messages = [message('user', CASES.map(at)), message('assistant', [at(CASES[7]!)])];
    const ctx = partitionForLossy(state({ messages }), policy());
    const comparative = messages.reduce((n, m) => n + estimateMessageTokens(m), 0);
    const branded = pessimisticLossyTokens(ctx);
    const structured = messages.reduce((n, m) => n + pessimisticMessageTokens(m), 0);
    assert.ok(branded.tokens >= comparative);
    assert.equal(branded.tokens, Math.max(comparative, structured));
  });
});

describe('P0-2 the comparative estimate cannot reach a budget decision', () => {
  const BUDGETS: BudgetPolicy = {
    contextLimit: 100_000,
    maxOutputTokens: 8_000,
    targetUtilization: 0.7,
  };
  const TRIGGER: TriggerPolicy = {
    strategy: 'monotonic',
    softTriggerFrac: 0.6,
    hardTriggerFrac: 0.85,
    keepRecentTokens: 8_192,
    userMessageTailTokens: 20_000,
    reserveTokens: 16_000,
    taskBoundarySignals: ['task_complete'],
  };

  it('rejects a bare comparative count at compile time', () => {
    const input: Parameters<typeof evaluateTrigger>[0] = {
      // @ts-expect-error a ratio-safe count must not be able to drive a budget decision
      tokens: estimateMessageTokens(message('user', [block({ text: JSON_TEXT })])),
      trigger: TRIGGER,
      budgets: BUDGETS,
      compaction: 'auto',
    };
    // The assertion is the @ts-expect-error above: it fails `npm run typecheck` if the
    // brand is ever dropped from TriggerInput. The runtime statement is here so the test
    // is not vacuous.
    assert.equal(input.trigger.strategy, 'monotonic');
  });

  it('rejects a fabricated brand at compile time', () => {
    const forged = { tokens: 1, basis: 'pessimistic' };
    // @ts-expect-error the brand is a module-private unique symbol, not a string key
    const accepted: Parameters<typeof evaluateTrigger>[0]['tokens'] = forged;
    assert.equal(accepted.tokens, 1);
  });

  it('accepts the pessimistic brand', () => {
    const d = evaluateTrigger({
      tokens: pessimisticCount(900),
      trigger: TRIGGER,
      budgets: BUDGETS,
      compaction: 'auto',
    });
    assert.equal(d.tokens, 900);
  });
});

describe('P0-2 triggerFor is on the pessimistic path', () => {
  it('declines a JSON-heavy context the comparative estimate would have admitted', () => {
    // The whole defect in one assertion. A context built almost entirely from API
    // responses is read ~1.5x too small by chars/4. Under the comparative estimate it
    // sits below the soft limit and nothing fires; the pessimistic estimate sees the
    // real utilisation and compacts.
    const jsonBlocks = Array.from({ length: 60 }, () => block({ text: JSON_TEXT.repeat(20) }));
    const ctx = partitionForLossy(state({ messages: [message('assistant', jsonBlocks)] }), policy());
    const comparative = ctx.messages.reduce((n, m) => n + estimateMessageTokens(m), 0);
    const pessimistic = pessimisticLossyTokens(ctx).tokens;
    assert.ok(pessimistic > comparative, 'the fixture does not exercise the under-count');

    const base = policy();
    const tp: TriggerPolicy = {
      ...base.pipeline.trigger,
      strategy: 'monotonic',
      softTriggerFrac: 0.95,
      hardTriggerFrac: 0.99,
      taskBoundarySignals: [],
    };
    // Solve for a window whose soft trigger sits strictly between the two counts, so the
    // two estimators can only disagree if they really are different numbers.
    // `triggerAt = floor((contextLimit - reserveOutput) * softTriggerFrac)`.
    const reserveOutput = reserveFor({ ...base.budgets, maxOutputTokens: 4_000 }, tp);
    // +2 so the `floor()` inside `budgetView` cannot land back on `comparative` exactly.
    const budgets: BudgetPolicy = {
      ...base.budgets,
      maxOutputTokens: 4_000,
      contextLimit: Math.floor(comparative / tp.softTriggerFrac) + 2 + reserveOutput,
    };
    const view = budgetView(
      budgets.contextLimit,
      reserveOutput,
      budgets.targetUtilization,
      tp.softTriggerFrac,
      tp.hardTriggerFrac,
    );
    assert.ok(comparative < view.triggerAt, `comparative ${comparative} vs triggerAt ${view.triggerAt}`);
    assert.ok(view.triggerAt < pessimistic, `triggerAt ${view.triggerAt} vs pessimistic ${pessimistic}`);

    const counted = (tokens: number): TriggerDecision =>
      evaluateTrigger({ tokens: pessimisticCount(tokens), trigger: tp, budgets, compaction: 'auto' });
    assert.equal(counted(comparative).fire, false, 'chars/4 reads this context as having room');
    assert.equal(counted(pessimistic).fire, true, 'the real utilisation is over the soft limit');

    // And the production entry point agrees with the pessimistic reading.
    const d = triggerFor(ctx, { ...base, pipeline: { ...base.pipeline, trigger: tp }, budgets });
    assert.equal(d.tokens, pessimistic);
    assert.equal(d.fire, true);
  });
});

describe('P0-2 calibration loop', () => {
  it('runs against an injected sampler with no provider and no network', () => {
    // The sampler stands in for the provider's `usage.input_tokens`, and it is per-class
    // because [7]'s rates are per-class: a fixture that charged every block the JSON rate
    // would report prose as under-counted, which is a statement about the fixture rather
    // than about the estimator. If this needed a provider, the loop would only ever be
    // exercised in production.
    const MEASURED_MAX: Readonly<Record<TokenContentClass, number>> = Object.freeze({
      prose: 0.97,
      code: 0.95,
      json: 1.49,
      // Deliberately below [7]'s 2.49 for symbols. [7] measured one special-character
      // fixture; `!!! ??? --- ...` is a different shape -- three characters per run, which
      // a tokenizer may well spell as one token each -- and charging it the 2.49x that
      // fixture earned would be asserting something nobody measured. The 2.49x claim is
      // asserted where it belongs, in the band suite, against the fixture it was measured
      // on. Here the rates sit under every measured maximum so that "no under-count" is a
      // statement about the plumbing rather than about the rate table.
      symbols: 2.0,
    });
    const calls: string[] = [];
    const calibrator = new TokenCalibrator({
      sampler: (text) => {
        calls.push(text);
        if (/[^\p{ASCII}]/u.test(text)) return [...text].length * 1.5;
        return 3 + Math.ceil((text.length / 4) * MEASURED_MAX[tokenContentClass(text)]);
      },
    });
    for (const c of CASES) calibrator.observe(at(c));

    assert.equal(calls.length, CASES.length, 'the sampler is the only source of observed counts');
    const report = calibrator.report();
    assert.equal(report.samples.length, CASES.length);
    assert.equal(report.observedAny, true);
    assert.deepEqual(
      report.underCounted.map((s) => s.contentClass),
      [],
      'every sample over-reserved',
    );
    assert.equal(report.withinBand, true);
    assert.ok(report.maxRatio <= 1);
    assert.equal(report.ratios.length, CASES.length);
    assert.deepEqual([...report.contentClasses].sort(), ['code', 'json', 'prose', 'symbols']);
  });

  it('names the samples where the provider charged more than predicted', () => {
    // The dangerous direction, and the one the band exists to catch: a ratio above 1
    // means the estimate read low and a real request went over budget.
    const calibrator = new TokenCalibrator({ sampler: (text) => Math.ceil(text.length / 4) * 3 });
    calibrator.observe(block({ text: JSON_TEXT.repeat(40) }));
    const report = calibrator.report();
    assert.equal(report.withinBand, false);
    assert.equal(report.underCounted.length, 1);
    assert.equal(report.underCounted[0]?.contentClass, 'json');
    assert.ok(report.maxRatio > 1);
  });

  it('reports an empty run as not passing', () => {
    // A vacuous band is not a passing band: zero samples must not read as "within band",
    // or a calibrator that was never fed looks identical to a healthy one.
    const report = new TokenCalibrator({ sampler: () => 0 }).report();
    assert.equal(report.observedAny, false);
    assert.equal(report.withinBand, false);
    assert.equal(report.ratios.length, 0);
    assert.equal(report.meanRatio, 0);
  });

  it('honours a caller-supplied band', () => {
    const tight = calibrationReport([calibrationSample(block({ text: JSON_TEXT.repeat(40) }), 900)], {
      predictedOverComparative: [1, 1.1],
      nonAsciiOverComparative: [1, 1.1],
      observedOverPredicted: [0, 1],
    });
    assert.equal(tight.withinBand, false, 'the multiplier cannot fit under 1.1');
  });
});

describe('P0-2 the declared gaps', () => {
  it('charges base64 the letters-are-free rate, which is a known under-count', () => {
    // Declared in ./token-budget.ts rather than patched with an invented penalty: sizing
    // the base64 correction needs a measurement of what a tokenizer does to base64, and
    // guessing one is the failure mode this module removes. This test exists so the gap
    // is visible and cannot be closed by accident.
    assert.equal(tokenContentClass(BASE64_TEXT), 'prose');
    assert.equal(pessimisticMultiplier(BASE64_TEXT), 1.0);
    assert.ok(pessimisticBlockTokens(block({ text: BASE64_TEXT })) >= estimateBlockTokens(block({ text: BASE64_TEXT })));
  });

  it('did not move the comparative estimator', () => {
    assert.equal(estimateBlockTokens(block({ text: 'a'.repeat(400) })), 100 + 3);
    assert.equal(estimateMessageTokens(message('user', [block({ text: 'a'.repeat(400) })])), 100 + 3 + 3);
  });
});