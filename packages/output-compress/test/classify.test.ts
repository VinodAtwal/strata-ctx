import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { JsonValue } from '../src/index.js';
import {
  PASSTHROUGH_REASONS,
  classifyMachineBlock,
  classifyMachineText,
  classificationDefect,
  isMachineBlock,
} from '../src/index.js';

import { AWKWARD_ROWS, FILE_ROWS, block, meta, toolResult } from './fixtures.js';

const text = (s: string): ReturnType<typeof classifyMachineText> => classifyMachineText(s);

const tableText = (t: { readonly rows: readonly unknown[] }): string => JSON.stringify(t.rows);

describe('H-3 classifier: the one way to yes', () => {
  it('accepts a JSON array of uniform records', () => {
    const result = text(tableText(FILE_ROWS));
    assert.equal(result.machine, true);
    assert.equal(result.reason, 'json_table');
    assert.equal(result.rows, FILE_ROWS.rows.length);
  });

  it('accepts records whose field types differ across rows', () => {
    // Types may vary; only the *fields* must agree. A column is not typed.
    assert.equal(text('[{"a":1},{"a":"x"},{"a":null},{"a":[1]}]').machine, true);
  });

  it('accepts a single-row table', () => {
    assert.equal(text('[{"a":1,"b":2}]').machine, true);
  });

  it('accepts a table whose every value needs quoting', () => {
    assert.equal(text(tableText(AWKWARD_ROWS)).machine, true);
  });

  it('rejects a bare string, even though it is valid JSON', () => {
    const result = text('"hello"');
    assert.equal(result.machine, false);
    assert.equal(result.reason, 'not_an_array');
  });

  it('rejects a single number tool result', () => {
    const result = text('42');
    assert.equal(result.machine, false);
    assert.equal(result.reason, 'not_an_array');
  });
});

describe('H-3 classifier: the structural vetoes, in order', () => {
  const toolBlock = (over: Parameters<typeof toolResult>[0]) => toolResult(over);

  it('refuses a thinking block even when its text is a perfect table', () => {
    const result = classifyMachineBlock(
      block({ type: 'thinking', text: tableText(FILE_ROWS), meta: meta({ tier: 'episodic' }) }),
    );
    assert.equal(result.reason, 'thinking_block');
  });

  it('refuses a governance block even when its text is a perfect table', () => {
    // Unreachable through `NonGovernanceMessage`, which is the point: this is the
    // runtime check that survives a cast. The fixture has to build a wide block to
    // reach it, and the cast is confined to this one test.
    const wide = block({
      type: 'text',
      text: tableText(FILE_ROWS),
      // @ts-expect-error testing governance tier rejection (NonGovernanceTier excludes governance)
      meta: { ...meta(), tier: 'governance' },
    });
    const result = classifyMachineBlock(wide);
    assert.equal(result.reason, 'governance_tier');
    assert.equal(result.machine, false);
  });

  it('refuses an assistant-authored block', () => {
    // The model writing JSON-looking text is the single most likely source of a
    // false positive, and the most expensive: we would rewrite the model's own
    // output and call it a payload.
    const b = toolBlock({
      text: tableText(FILE_ROWS),
      ref: 'x',
    });
    const result = classifyMachineBlock({ ...b, meta: { ...b.meta, origin: 'assistant' } });
    assert.equal(result.reason, 'assistant_origin');
  });

  it('refuses a plain text block, whatever the text looks like', () => {
    const result = classifyMachineBlock(block({ type: 'text', text: tableText(FILE_ROWS) }));
    assert.equal(result.reason, 'text_block');
  });

  it('refuses an image block', () => {
    const result = classifyMachineBlock(
      block({ type: 'image', text: tableText(FILE_ROWS), meta: meta() }),
    );
    assert.equal(result.reason, 'other_block_type');
  });

  it('refuses a tool_use block whose text is null', () => {
    const result = classifyMachineBlock({
      type: 'tool_use',
      meta: meta({ tier: 'tool_state' }),
    });
    assert.equal(result.reason, 'no_text');
  });

  it('checks the vetoes before it looks at the text at all', () => {
    // A governance block full of invalid JSON must still be refused as governance,
    // not as "not json": the first answer would be a fact about policy, the
    // second a fact about a string.
    const wide = block({
      type: 'text',
      text: 'not json at all',
      // @ts-expect-error testing governance tier rejection (NonGovernanceTier excludes governance)
      meta: { ...meta(), tier: 'governance' },
    });
    assert.equal(classifyMachineBlock(wide).reason, 'governance_tier');
  });
});

describe('H-3 classifier: the syntactic floor', () => {
  const refuses = (s: string, reason: string, why: string): void => {
    it(`refuses ${why}`, () => {
      const result = text(s);
      assert.equal(result.machine, false);
      assert.equal(result.reason, reason);
    });
  };

  refuses('', 'no_text', 'an empty string');
  refuses('   \n\t ', 'empty_text', 'whitespace only');
  refuses('[strata:reference] files: 4', 'strata_marker', 'text carrying our own marker');
  refuses('```json\n[{"a":1}]\n```', 'code_fence', 'a fenced JSON payload');
  refuses('```\n[{"a":1}]\n```', 'code_fence', 'an unfenced-labelled code block');
  refuses('Sure, here you go:\n[{"a":1}]', 'not_json', 'prose before the table');
  refuses('[]', 'empty_array', 'an empty array');
  refuses('[1,2,3]', 'not_records', 'an array of primitives');
  refuses('[{"a":1},"x"]', 'not_records', 'an array mixing records and primitives');
  refuses('[[{"a":1}]]', 'not_records', 'an array of arrays');
  refuses('[{"a":1},{"b":2}]', 'not_uniform', 'rows with different fields');
  refuses('[{"a":1,"b":2},{"a":3}]', 'not_uniform', 'a row missing a field');
  refuses('[{"a":1},{"b":1}]', 'not_uniform', 'the same fields in a different order');
  refuses('{"a":1}', 'not_an_array', 'an object rather than an array');
  refuses('42', 'not_an_array', 'a number');
  refuses('null', 'not_an_array', 'null');
  refuses('"a string"', 'not_an_array', 'a string');
  refuses('[[[[[[1]]]]]]', 'not_records', 'deeply nested arrays');
});

describe('H-3 classifier: domain limits', () => {
  it('refuses a value JSON cannot represent', () => {
    // Cannot be produced by JSON.parse, so this is reached through the exported
    // text entry point only if a caller hands one in -- which is the point of
    // checking: the classifier and the serializer must agree on the domain.
    const impossible = '[{"a":1e999}]';
    const result = text(impossible);
    // 1e999 parses to Infinity, which JSON cannot represent, so the payload is
    // outside the domain even though it is syntactically an array of records.
    assert.equal(result.machine, false);
    assert.equal(result.reason, 'out_of_domain');
  });

  it('refuses a value nested too deeply to re-serialize', () => {
    let deep: JsonValue = 1;
    for (let i = 0; i < 80; i += 1) deep = { d: deep };
    const result = text(JSON.stringify([{ a: deep }]));
    assert.equal(result.machine, false);
    assert.equal(result.reason, 'out_of_domain');
  });
});

describe('H-3 classifier: uncertainty is passthrough', () => {
  it('reports a reason for every refusal, so nothing is refused silently', () => {
    const cases = [
      '',
      '   ',
      '[strata:reference] x',
      '```\nx\n```',
      'prose',
      '[]',
      '[1]',
      '[{"a":1},{"b":1}]',
      '{}',
    ];
    for (const s of cases) {
      const result = text(s);
      assert.equal(result.machine, false, `expected passthrough for ${JSON.stringify(s)}`);
      assert.notEqual(result.reason, 'json_table');
      assert.ok(result.detail.length > 0, `expected a detail for ${JSON.stringify(s)}`);
    }
  });

  it('lists every passthrough reason, with no duplicates', () => {
    assert.equal(new Set(PASSTHROUGH_REASONS).size, PASSTHROUGH_REASONS.length);
    assert.ok(!PASSTHROUGH_REASONS.includes('json_table'));
  });

  it('never reports a row count for a refusal', () => {
    // A count alongside `machine: false` is how a report ends up claiming it
    // handled 40 rows it never touched.
    for (const s of ['prose', '[]', '[1]']) {
      assert.equal(text(s).rows, 0);
    }
  });

  it('gives a defect for a refusal, naming the uniform-record rule', () => {
    const defect = classificationDefect(text('[{"a":1},{"b":1}]'));
    assert.equal(defect?.code, 'not_a_table');
    assert.ok(defect?.message.includes('order'));
  });

  it('gives no defect for an acceptance', () => {
    assert.equal(classificationDefect(text(tableText(FILE_ROWS))), undefined);
  });
});

describe('H-3 classifier: the predicate form', () => {
  it('agrees with the classification', () => {
    const good = toolResult({ text: tableText(FILE_ROWS), ref: 'files' });
    const bad = toolResult({ text: 'here is your table', ref: 'files' });
    assert.equal(isMachineBlock(good), true);
    assert.equal(isMachineBlock(bad), false);
  });
});

describe('H-3 classifier: the cases a future relaxation must not admit', () => {
  // Named individually, because the failure mode of loosening this classifier is
  // a prose block being rewritten into a table, and that is not visible in a
  // test count.
  const mustStayPassthrough: readonly (readonly [string, string])[] = [
    ['a fenced payload', '```json\n[{"a":1}]\n```'],
    ['a table with a sentence before it', 'Here is the result.\n[{"a":1}]'],
    ['a table with a sentence after it', '[{"a":1}]\nLet me know if you need more.'],
    ['two tables concatenated', '[{"a":1}]\n[{"a":2}]'],
    ['a JSON Lines stream, which is not this format', '{"a":1}\n{"a":2}'],
    ['a paginated envelope with rows inside', '{"rows":[{"a":1}],"total":1}'],
    ['an array of arrays, which a spreadsheet would call a table', '[[1,2],[3,4]]'],
    ['a two-element array of scalars', '[1,2]'],
  ];

  for (const [why, payload] of mustStayPassthrough) {
    it(`refuses ${why}`, () => {
      assert.equal(
        classifyMachineText(payload).machine,
        false,
        `${JSON.stringify(payload)} was admitted as machine data`,
      );
    });
  }

  it('refuses a bare table arriving in a text block, which is how a model replies', () => {
    // The text classifier says yes to `[{"a":1}]` -- correctly, in isolation: it
    // has no way to know whose bytes these are. The *block* classifier is where
    // the question "whose is it" gets answered, so this case belongs here and not
    // in the list above. It is the most likely false positive there is: a model
    // answering a request for a table, which we must not rewrite as if it were a
    // payload we received.
    assert.equal(classifyMachineText('[{"a":1}]').machine, true);
    assert.equal(classifyMachineBlock(block({ type: 'text', text: '[{"a":1}]' })).machine, false);
  });

  it('refuses the same table when the assistant wrote it into a tool_use block', () => {
    const b = toolResult({ text: '[{"a":1}]', ref: 'x' });
    const assistant = { ...b, meta: { ...b.meta, origin: 'assistant' as const } };
    assert.equal(classifyMachineBlock(assistant).machine, false);
  });

  it('refuses a table-shaped block that is the assistant thinking out loud', () => {
    const thinking = block({ type: 'thinking', text: '[{"a":1}]' });
    assert.equal(isMachineBlock(thinking), false);
  });

  it('refuses a table-shaped block in a tool_result that is an error', () => {
    // An `is_error` tool result whose text happens to be a table is a failure
    // report, not data. Rewriting it would hide the failure behind a
    // well-formed table.
    const b = toolResult({ text: '[{"a":1}]', ref: 'x', severity: 'error' });
    assert.equal(classifyMachineBlock(b).machine, false);
  });
});
