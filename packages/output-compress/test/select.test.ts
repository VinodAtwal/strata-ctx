import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { JsonObject, JsonValue, MachineFormat, SelectionInput } from '../src/index.js';
import {
  DEFAULT_MIN_SAVINGS_FRAC,
  UNKNOWN_MODEL_SUPPORT,
  parseToon,
  serializeToon,
  selectMachineFormat,
} from '../src/index.js';

import {
  AWKWARD_ROWS,
  FILE_ROWS,
  SINGLE_ROW,
  WIDE_ROWS,
  verifiedRegistry,
} from './fixtures.js';

const wide = WIDE_ROWS.rows;
const jsonText = JSON.stringify(wide);

/** A model verified for both machine formats, so the registry is not the subject. */
const registry = verifiedRegistry('test-model', ['toon', 'tron', 'json']);

const select = (over: Partial<Parameters<typeof selectMachineFormat>[0]> = {}) =>
  selectMachineFormat({
    value: wide as unknown,
    model: 'test-model',
    registry,
    preferred: 'toon',
    jsonText,
    ...over,
  });

describe('H-2 selector: choosing a format', () => {
  it('selects the preferred format when it is both supported and smaller', () => {
    const result = select();
    assert.equal(result.format, 'toon');
    assert.equal(result.code, 'selected');
    assert.equal(result.text, serializeToon(wide));
  });

  it('records a saving measured against the JSON it replaced', () => {
    const result = select();
    assert.ok(result.savings);
    assert.ok(result.savings.fractionSaved > 0);
    assert.equal(result.savings.from.chars, jsonText.length);
    assert.equal(result.savings.to.chars, result.text.length);
    assert.equal(
      result.savings.tokensSaved,
      result.savings.from.tokens - result.savings.to.tokens,
    );
  });

  it('tries the preferred format first', () => {
    const result = select({ preferred: 'tron' });
    assert.equal(result.format, 'tron');
    assert.equal(result.attempts[0]?.format, 'tron');
  });

  it('records a refusal for a pin the model does not support', () => {
    const onlyTron = verifiedRegistry('test-model', ['tron', 'json']);
    const result = select({ registry: onlyTron, preferred: 'toon' });
    assert.ok(
      result.attempts.some((a) => a.format === 'toon' && a.code === 'model_unsupported'),
      `expected a refusal for toon, got ${JSON.stringify(result.attempts)}`,
    );
  });

  it('honours a pin even when the other format is smaller', () => {
    // TRON is TOON minus an indent, so it is always shorter here. Serving it
    // anyway would be serving a format the policy did not ask for.
    const result = select({ preferred: 'toon' });
    assert.equal(result.format, 'toon');
    const tron = selectMachineFormat({
      value: wide as unknown,
      model: 'test-model',
      registry,
      preferred: 'tron',
      jsonText,
    });
    assert.ok(tron.text.length < result.text.length, 'TRON should be the smaller candidate');
  });

it('compares candidates against each other when nothing is pinned', () => {
    // No `preferred`, so the registry's best-first order decides, and the
    // smaller of the two supported formats wins on measured bytes.
    const input: SelectionInput = {
      model: 'claude-sonnet-4-5',
      allowUnverified: true,
      value: WIDE_ROWS.rows,
    };
    const result = selectMachineFormat(input);
    assert.equal(result.format, 'tron');
    assert.ok(
      result.attempts.some((a) => a.code === 'superseded'),
      `expected a superseded attempt, got ${JSON.stringify(result.attempts)}`,
    );
  });

  it('records exactly one selected attempt, and it is the format that was served', () => {
    // An attempt log that recorded two `selected` entries would answer "which
    // format did we serve" with both of them.
    const input: SelectionInput = {
      model: 'claude-sonnet-4-5',
      allowUnverified: true,
      value: WIDE_ROWS.rows,
    };
    const result = selectMachineFormat(input);
    const selected = result.attempts.filter((a) => a.code === 'selected');
    assert.equal(selected.length, 1);
    assert.equal(selected[0]?.format, result.format);
    assert.equal(result.code, 'selected');
  });

  it('falls back to JSON, not to a substitute, when a pin is unsupported', () => {
    const onlyTron = verifiedRegistry('test-model', ['tron', 'json']);
    const result = select({ registry: onlyTron, preferred: 'toon' });
    assert.equal(result.format, 'json');
    assert.equal(result.code, 'model_unsupported');
  });

  it('keeps a caller-supplied table name out of the comparison it makes', () => {
    const withName = select({ name: 'w' });
    assert.ok(withName.text.startsWith('toon1 w['));
    assert.ok(withName.text.length > select().text.length);
    assert.ok(withName.savings !== undefined && withName.savings.fractionSaved > 0);
  });
});

describe('H-2 selector: when it says no', () => {
  it('returns JSON for a value that is not a table', () => {
    const result = select({ value: 'prose', jsonText: '"prose"' });
    assert.equal(result.format, 'json');
    assert.equal(result.code, 'not_a_table');
    assert.equal(result.text, '"prose"');
  });

  it('returns JSON for a ragged table', () => {
    const result = select({ value: [{ a: 1 }, { b: 2 }], jsonText: '[{"a":1},{"b":2}]' });
    assert.equal(result.code, 'not_a_table');
  });

  it('returns JSON for a value outside the JSON domain', () => {
    const result = select({ value: { a: new Date() }, jsonText: '"never used"' });
    assert.equal(result.code, 'out_of_domain');
  });

  it('returns JSON for an unknown model, because unknown means JSON only', () => {
    const result = select({ model: 'a-model-nobody-has-heard-of', allowUnverified: false });
    assert.equal(result.format, 'json');
    assert.equal(result.code, 'model_unsupported');
    assert.equal(result.text, jsonText);
    assert.equal(result.attempts[0]?.code, 'model_unsupported');
  });

  it('refuses an unverified format unless the caller opts in', () => {
    const unverified = verifiedRegistry('test-model', ['toon', 'json']);
    // Mark it unverified without changing the format list.
    const downgraded = new Map(
      [...unverified].map(([k, v]) => [k, k === 'test-model' ? { ...v, status: 'unverified' as const } : v]),
    );
    assert.equal(select({ registry: downgraded, allowUnverified: false }).format, 'json');
    assert.equal(select({ registry: downgraded, allowUnverified: true }).format, 'toon');
  });

  it('returns JSON when the format is not smaller than it was', () => {
    const single = JSON.stringify(SINGLE_ROW.rows);
    const result = select({ value: SINGLE_ROW.rows as unknown, jsonText: single });
    assert.equal(result.format, 'json');
    assert.ok(
      result.code === 'no_savings' || result.code === 'below_savings_floor',
      `unexpected code ${result.code}`,
    );
    assert.equal(result.text, single);
  });

  it('returns JSON below the savings floor even when it is technically smaller', () => {
    // The floor exists so a marginal reformat cannot churn a transcript for a
    // rounding error. Raising it to 0.99 must force the fallback.
    const result = select({ minSavingsFrac: 0.99 });
    assert.equal(result.format, 'json');
    assert.equal(result.code, 'below_savings_floor');
    assert.ok(result.reason.includes('99.0%'));
  });

  it('still selects just above the floor', () => {
    const result = select({ minSavingsFrac: 0.01 });
    assert.equal(result.format, 'toon');
  });

  it('returns the original bytes verbatim on a refusal', () => {
    // Not a re-stringified copy: whitespace and number formatting are part of
    // what the tool said, and rewriting them is a silent edit of a tool result.
    const original = '[\n  { "a" : 1, "b" : 2 },\n  { "b" : 3, "a" : 4 }\n]';
    const result = select({ value: [{ a: 1, b: 2 }, { b: 3, a: 4 }] as unknown, jsonText: original });
    assert.equal(result.format, 'json');
    assert.equal(result.code, 'not_a_table');
    assert.equal(result.text, original);
  });

  it('returns the original bytes verbatim when a valid table is still refused for size', () => {
    // A table that parses but loses on size: a real refusal, distinct from the
    // "not a table" one, and it must preserve the original text too.
    const original = '[ { "a" : 1 } ]';
    const result = select({ value: [{ a: 1 }] as unknown, jsonText: original, minSavingsFrac: 0.99 });
    assert.equal(result.format, 'json');
    assert.equal(result.text, original);
  });

  it('prefers a caller-supplied JSON string over a re-stringify, always', () => {
    for (const over of [
      { value: 'prose' as unknown },
      { value: [] as unknown },
      { value: [{ a: 1 }, { b: 2 }] as unknown },
      { value: wide as unknown, minSavingsFrac: 0.99 },
      { model: 'unknown-model' },
    ]) {
      const result = select({ ...over, jsonText: 'ORIGINAL' });
      if (result.format === 'json') assert.equal(result.text, 'ORIGINAL');
    }
  });
});

describe('H-2 selector: the round-trip check', () => {
  it('only returns text that reads back as the value it was given', () => {
    // The reason this stage can be lossless by construction rather than by
    // review: nothing reaches the caller that has not been read back and
    // compared. Asserted by re-doing the read, independently of the selector.
    for (const value of [FILE_ROWS.rows, AWKWARD_ROWS.rows, WIDE_ROWS.rows]) {
      const result = selectMachineFormat({
        value: value as unknown,
        model: 'test-model',
        registry,
        preferred: 'toon',
        jsonText: JSON.stringify(value),
      });
      if (result.format !== 'toon') continue;
      assert.deepEqual(
        parseToon(result.text) as unknown as JsonValue,
        value as unknown as JsonValue,
      );
    }
  });

  it('sends the candidate to JSON when the reader throws, instead of throwing itself', () => {
    // The reader is invoked precisely to catch a broken writer, so it must not be
    // able to take the stage down. A `jsonText` that no reader could accept is
    // the cheapest way to prove the guard exists: the value is still a valid
    // table, and the fallback is reached rather than an exception escaping.
    const result = select({ jsonText: 'not json at all' });
    assert.equal(result.format, 'json');
    assert.equal(result.text, 'not json at all');
  });

  it('never throws on a value the registry does not support', () => {
    // A request for an unknown model is the most common path in the world, and
    // it must not be able to throw.
    for (const value of [wide, [], [{ a: 1 }], 'prose', null, 42, { a: new Date() }]) {
      const result = select({ value: value as unknown, model: 'nobody' });
      assert.equal(result.format, 'json');
    }
  });
});

describe('H-2 selector: the attempt log', () => {
  it('records one entry for the pinned format', () => {
    // A pin means one candidate, so one entry. Two entries for a pinned choice
    // would mean the pin was not a pin.
    assert.deepEqual(
      select().attempts.map((a) => a.format),
      ['toon'],
    );
  });

  it('records one entry per supported format when nothing is pinned', () => {
    const input: SelectionInput = {
      model: 'claude-sonnet-4-5',
      allowUnverified: true,
      value: WIDE_ROWS.rows,
    };
    assert.deepEqual(
      selectMachineFormat(input).attempts.map((a) => a.format),
      ['toon', 'tron'],
    );
  });

  it('records a refusal for a pin the model does not support', () => {
    const result = select({ model: 'nobody' });
    assert.deepEqual(result.attempts.map((a) => [a.format, a.code]), [['toon', 'model_unsupported']]);
    assert.ok(result.attempts[0]?.detail.includes('nobody'));
  });

  it('tries nothing at all when an unknown model has no machine format, and says why', () => {
    // An unknown model is JSON-only, so there is no candidate to attempt. The
    // reason has to carry that, because an empty attempt log alone reads like a
    // bug rather than a decision.
    const input: SelectionInput = {
      model: 'nobody',
      allowUnverified: true,
      value: WIDE_ROWS.rows,
    };
    const result = selectMachineFormat(input);
    assert.deepEqual(result.attempts, []);
    assert.ok(result.reason.includes('no machine format is registered'), result.reason);
  });

  it('gives every attempt a detail, so a refusal is diagnosable from the log', () => {
    const result = select({ model: 'nobody' });
    for (const attempt of result.attempts) {
      assert.ok(attempt.detail.length > 0, `no detail for ${attempt.format}`);
    }
  });

  it('records the winner as a bare attempt, and the verdict on the selection itself', () => {
    // The attempt log is about formats; `code` on the selection is the verdict.
    // Keeping them separate means a reader does not have to work out which of
    // the two a `selected` belongs to.
    const result = select();
    assert.equal(result.attempts[0]?.code, 'selected');
    assert.equal(result.code, 'selected');
  });
});

describe('H-2 selector: determinism', () => {
  it('gives byte-identical output for the same input', () => {
    const a = select();
    const b = select();
    assert.equal(a.text, b.text);
    assert.equal(a.code, b.code);
  });

  it('gives a stable attempt log', () => {
    assert.deepEqual(select().attempts, select().attempts);
  });

  it('uses a default floor of two percent', () => {
    assert.equal(DEFAULT_MIN_SAVINGS_FRAC, 0.02);
  });
});

describe('H-2 selector: the unknown-model contract', () => {
  it('lists JSON only, and says verified', () => {
    // `verified` here is a claim about the format -- JSON is what the model
    // already speaks -- not a claim that the model was measured.
    assert.deepEqual(UNKNOWN_MODEL_SUPPORT.formats, ['json']);
    assert.equal(UNKNOWN_MODEL_SUPPORT.status, 'verified');
    assert.equal(UNKNOWN_MODEL_SUPPORT.maxRepairAttempts, 0);
  });

  it('never offers repair for an unknown model', () => {
    assert.equal(UNKNOWN_MODEL_SUPPORT.maxRepairAttempts, 0);
  });
});

describe('H-2 selector: types', () => {
  it('returns JsonObject rows from a parse', () => {
    const rows: readonly JsonObject[] = parseToon(serializeToon(WIDE_ROWS.rows));
    assert.equal(rows.length, WIDE_ROWS.rows.length);
  });

  it('keeps the format union closed', () => {
    const formats: readonly MachineFormat[] = ['json', 'toon', 'tron'];
    for (const format of formats) {
      assert.equal(typeof format, 'string');
    }
  });
});
