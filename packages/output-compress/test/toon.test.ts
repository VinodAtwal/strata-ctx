import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ToonError, parseToon, serializeToon, TOON_MAGIC, TOON_ROW_INDENT, jsonEqual } from '../src/index.js';
// Imported from the module, not the barrel: `grammar.ts` is shared machinery and
// is deliberately not public API (see src/index.ts). A test may reach inside; a
// consumer may not, and the two facts are kept apart by having two ways in.
import { tableFields, tryTableFields } from '../src/grammar.js';

import {
  AWKWARD_ROWS,
  FILE_ROWS,
  MIXED_TYPE_ROWS,
  NASTY_STRINGS,
  OBJECT_ROWS,
  RAGGED_ROWS,
  SINGLE_ROW,
  WIDE_ROWS,
  rng,
} from './fixtures.js';
import { checkRoundTrips, randomTable } from './roundtrip.js';

const rows = FILE_ROWS.rows as unknown as unknown[];

describe('TOON: framing', () => {
  it('writes the magic, an optional name, the count and the columns', () => {
    const text = serializeToon(rows, { name: 'files' });
    assert.equal(text.split('\n')[0], 'toon1 files[4]{path,size,ok}:');
  });

  it('omits the name when there is none', () => {
    assert.ok(serializeToon(rows).startsWith(`${TOON_MAGIC}[4]{path,size,ok}:`));
  });

  it('indents every row but the header', () => {
    // The trailing newline makes the last split element empty; it is not a row.
    const lines = serializeToon(rows).split('\n').filter((l) => l !== '');
    for (const line of lines.slice(1)) {
      assert.ok(line.startsWith(TOON_ROW_INDENT), `unindented row: ${line}`);
    }
  });

  it('ends with a newline', () => {
    assert.ok(serializeToon(rows).endsWith('\n'));
  });

  it('rejects a field name that is not writable in a header', () => {
    assert.throws(
      () => serializeToon([{ 'a,b': 1, c: 2 }]),
      (e: unknown) => e instanceof ToonError && e.code === 'unsupported_key',
    );
  });

  it('rejects a table name that is not writable in a header', () => {
    assert.throws(
      () => serializeToon(rows, { name: 'has space' }),
      (e: unknown) => e instanceof ToonError && e.code === 'unsupported_key',
    );
  });
});

checkRoundTrips({
  name: 'TOON',
  magic: TOON_MAGIC,
  serialize: serializeToon,
  parse: parseToon,
});

describe('TOON: what it refuses', () => {
  const refuses = (value: unknown, why: string): void => {
    it(`refuses ${why}`, () => {
      assert.throws(() => serializeToon(value), ToonError);
    });
  };

  refuses([], 'an empty array');
  refuses(OBJECT_ROWS, 'an object rather than an array of records');
  refuses(RAGGED_ROWS, 'ragged rows');
  refuses('a bare string', 'a bare string');
  refuses(null, 'null');
  refuses(42, 'a number');
  refuses([null], 'an array of nulls');
  refuses([1, 2, 3], 'an array of primitives');
  refuses([{ a: 1 }, 'x'], 'an array mixing records and primitives');
  refuses([{ a: undefined }], 'a record with an undefined value');
  refuses([{ a: NaN }], 'a record with NaN');
  refuses([{ a: Infinity }], 'a record with Infinity');
  refuses([{ '': 1 }], 'a record with an empty field name');
  refuses([{ a: 1 }, { a: 1, b: 2 }], 'rows that grow a field');
});

describe('TOON: parse errors', () => {
  it('rejects a foreign magic', () => {
    assert.throws(() => parseToon('t1 files[1]{a}:\n  x'), ToonError);
  });

  it('rejects prose that happens to contain a brace', () => {
    assert.throws(() => parseToon('Sure! Here is the table:\n{a: 1}'), ToonError);
  });

  it('rejects a header whose count disagrees with the rows', () => {
    const text = 'toon1 t[3]{a}:\n  1\n  2';
    assert.throws(
      () => parseToon(text),
      (e: unknown) => e instanceof ToonError && e.code === 'row_count_mismatch',
    );
  });

  it('rejects a row that is too wide', () => {
    const text = 'toon1 t[1]{a,b}:\n  1,2,3';
    assert.throws(
      () => parseToon(text),
      (e: unknown) => e instanceof ToonError && e.code === 'row_width_mismatch',
    );
  });

  it('rejects a row that is too narrow', () => {
    assert.throws(
      () => parseToon('toon1 t[1]{a,b}:\n  1'),
      (e: unknown) => e instanceof ToonError && e.code === 'row_width_mismatch',
    );
  });

  it('rejects a duplicate field name in the header', () => {
    assert.throws(
      () => parseToon('toon1 t[1]{a,a}:\n  1'),
      (e: unknown) => e instanceof ToonError && e.code === 'duplicate_field',
    );
  });

  it('rejects an empty column list', () => {
    assert.throws(
      () => parseToon('toon1 t[1]{}:\n  1'),
      (e: unknown) => e instanceof ToonError && e.code === 'malformed_header',
    );
  });

  it('rejects a row that is not indented', () => {
    assert.throws(
      () => parseToon('toon1 t[1]{a}:\n1'),
      (e: unknown) => e instanceof ToonError && e.code === 'unexpected_line',
    );
  });

  it('rejects a zero count with no rows', () => {
    assert.throws(() => parseToon('toon1 t[0]{a}:'), ToonError);
  });

  it('rejects a paragraph after the rows, which is what the row count is for', () => {
    const text = `${serializeToon(rows)}and here is a summary\n`;
    assert.throws(
      () => parseToon(text),
      (e: unknown) => e instanceof ToonError && e.code === 'row_count_mismatch',
    );
  });

  it('reads a bare cell that is not a JSON scalar as the string it is', () => {
    // The inverse of needsQuoting, and deliberately permissive: `1st-place.txt`
    // is a real value, so refusing digit-leading bare cells would refuse data.
    // Contamination is caught by the row count, not here.
    assert.deepEqual(parseToon('toon1 t[1]{a}:\n  1st-place.txt\n'), [{ a: '1st-place.txt' }]);
  });

  it('rejects a cell with an unterminated quote', () => {
    assert.throws(
      () => parseToon('toon1 t[1]{a}:\n  "unterminated'),
      (e: unknown) => e instanceof ToonError && e.code === 'unterminated_string',
    );
  });

  it('rejects a composite cell that is not valid JSON', () => {
    assert.throws(
      () => parseToon('toon1 t[1]{a}:\n  {"a":1,}'),
      (e: unknown) => e instanceof ToonError && e.code === 'malformed_cell',
    );
  });

  it('rejects a composite cell with a duplicate key', () => {
    // JSON.parse would happily take the last one. A tool result that says
    // `{"a":1,"a":2}` is either a bug or an attack, and silently reading it as
    // `a: 2` is the wrong answer to both.
    assert.throws(
      () => parseToon('toon1 t[1]{a}:\n  {"a":1,"a":2}'),
      (e: unknown) => e instanceof ToonError && e.code === 'malformed_cell',
    );
  });

  it('accepts CRLF, because a CR at end of line is a convention and not data', () => {
    // No cell can contain a raw CR: the writer escapes it as \r. So dropping one
    // trailing CR per line cannot lose a character, and refusing CRLF would only
    // break every tool that rewrites line endings.
    assert.deepEqual(parseToon('toon1 t[1]{a}:\r\n  1\r\n'), [{ a: 1 }]);
  });

  it('rejects an interior blank line, which is a row with no cells', () => {
    assert.throws(
      () => parseToon('toon1 t[2]{a,b}:\n  1,2\n\n  3,4\n'),
      (e: unknown) => e instanceof ToonError && e.code === 'row_count_mismatch',
    );
  });

  it('carries the offset in the error', () => {
    try {
      parseToon('toon1 t[1]{a}:\n  "unterminated');
      assert.fail('expected a throw');
    } catch (e) {
      assert.ok(e instanceof ToonError);
      assert.equal(typeof e.offset, 'number');
    }
  });
});

describe('TOON: values that need care', () => {
  it('keeps a lone high surrogate through a round trip', () => {
    const value = 'lone \ud800 high';
    const back = parseToon(serializeToon([{ a: value }]));
    assert.equal(back[0]?.a, value);
  });

  it('keeps a lone low surrogate through a round trip', () => {
    const value = 'lone \udfff low';
    const back = parseToon(serializeToon([{ a: value }]));
    assert.equal(back[0]?.a, value);
  });

  it('keeps an intact pair intact', () => {
    const value = 'pair 😀 intact';
    const back = parseToon(serializeToon([{ a: value }]));
    assert.equal(back[0]?.a, value);
  });

  it('refuses -0, because JSON.stringify(-0) is "0" and it would not survive', () => {
    // Emitting `0` for a -0 would be a silent change to the value; the honest
    // answer is to refuse the value, which sends the block to JSON, which has the
    // same opinion.
    assert.throws(
      () => serializeToon([{ a: -0 }]),
      (e: unknown) => e instanceof ToonError && e.code === 'unsupported_value',
    );
  });

  it('emits every curated nasty string unchanged', () => {
    const rows = NASTY_STRINGS.map((s, i) => ({ i, s }));
    const back = parseToon(serializeToon(rows));
    NASTY_STRINGS.forEach((s, i) => assert.equal(back[i]?.s, s, `nasty string ${i} changed`));
  });

  it('quotes a string that a bare reader would hand back as another JSON scalar', () => {
    // The class that matters is strings which *parse* as JSON: bare, they would
    // come back as a number, a boolean or a null. `007` is not in it, and is
    // correctly left bare.
    const text = serializeToon([{ a: '1' }, { a: 'null' }, { a: 'true' }, { a: '[]' }]);
    assert.ok(text.includes('"1"') && text.includes('"null"') && text.includes('"true"'), text);
    // Each comes back as the *string* it went in as. `'[]'` was quoted, so it is
    // the two-character string, not an empty array.
    assert.deepEqual(
      parseToon(text).map((r) => r.a),
      ['1', 'null', 'true', '[]'],
    );
  });

  it('leaves a numeric-looking string that JSON cannot parse bare', () => {
    const text = serializeToon([{ a: '007' }]);
    assert.ok(!text.includes('"007"'), `expected the string to be bare in ${text}`);
    assert.equal(parseToon(text)[0]?.a, '007');
  });

  it('leaves a real number unquoted', () => {
    const text = serializeToon([{ a: 7 }]);
    assert.ok(!text.includes('"7"'), `expected the number to be bare in ${text}`);
  });

  it('carries a composite value as JSON inside the cell', () => {
    const text = serializeToon([{ a: { b: [1, null, 'x'] } }]);
    assert.equal(parseToon(text)[0]?.a && JSON.stringify(parseToon(text)[0]?.a), '{"b":[1,null,"x"]}');
  });

  it('accepts mixed types across rows, because a column is not typed', () => {
    const back = parseToon(serializeToon(MIXED_TYPE_ROWS));
    assert.ok(jsonEqual(back as unknown as never, MIXED_TYPE_ROWS as never));
  });

  it('preserves field order', () => {
    const text = serializeToon([{ z: 1, a: 2, m: 3 }]);
    assert.ok(text.includes('{z,a,m}'), `field order changed in ${text}`);
    assert.deepEqual(Object.keys(parseToon(text)[0] ?? {}), ['z', 'a', 'm']);
  });
});

describe('TOON: it is smaller than JSON, and by how much', () => {
  const size = (t: string): number => Buffer.byteLength(t, 'utf8');

  it('beats JSON on a realistic file listing', () => {
    const text = serializeToon(rows, { name: 'files' });
    assert.ok(text.length < JSON.stringify(rows).length, 'TOON should be shorter than JSON here');
  });

  it('beats JSON on a wide table', () => {
    const wide = WIDE_ROWS.rows;
    assert.ok(size(serializeToon(wide)) < size(JSON.stringify(wide)));
  });

  it('does not beat JSON on a single two-field row, and the floor is what stops it', () => {
    // The one-row table is the known case where the header costs more than it
    // saves. Asserting it here means the savings floor in select.ts has a real
    // justification rather than a plausible one.
    assert.ok(serializeToon(SINGLE_ROW.rows).length > JSON.stringify(SINGLE_ROW.rows).length);
  });

  it('still round-trips when it is the bigger option', () => {
    const back = parseToon(serializeToon(SINGLE_ROW.rows));
    assert.ok(jsonEqual(back as unknown as never, SINGLE_ROW.rows as never));
  });

  it('round-trips the awkward corpus', () => {
    const back = parseToon(serializeToon(AWKWARD_ROWS.rows));
    assert.ok(jsonEqual(back as unknown as never, AWKWARD_ROWS.rows as never));
  });

  it('round-trips a table whose every cell needs quoting', () => {
    const r = rng(42);
    const generated = randomTable(r, 8);
    assert.ok(jsonEqual(parseToon(serializeToon(generated)) as unknown as never, generated as never));
  });
});

describe('TOON: the table contract', () => {
  it('accepts a generated table', () => {
    const generated = randomTable(rng(9), 3);
    assert.deepEqual(tableFields(generated as never).length, 3);
  });

  it('reports a ragged table as a verdict, not a throw', () => {
    const result = tryTableFields(RAGGED_ROWS as never);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'not_a_table');
  });

  it('reports a non-table as a verdict, not a throw', () => {
    for (const value of [OBJECT_ROWS, 'nope', [], 42, null]) {
      const result = tryTableFields(value as never);
      assert.equal(result.ok, false, `expected ${JSON.stringify(value)} to be refused`);
    }
  });

  it('does not swallow a non-ToonError into "not a table"', () => {
    // A bug in this package must not be reported to a caller as "not a table",
    // or it would be answered with plain JSON forever and never investigated.
    // The trap has to be on the key enumeration, because that is the only thing
    // `tableFields` touches: a getter that throws would never be read.
    const broken = new Proxy(
      {},
      {
        ownKeys() {
          throw new RangeError('not a ToonError');
        },
      },
    );
    assert.throws(() => tryTableFields([broken] as never), RangeError);
  });
});
