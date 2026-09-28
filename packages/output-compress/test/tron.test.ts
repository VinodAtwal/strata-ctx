import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ToonError, parseTron, serializeTron, TRON_MAGIC, TRON_ROW_INDENT, jsonEqual } from '../src/index.js';
import { TOON_MAGIC, serializeToon } from '../src/index.js';

import { AWKWARD_ROWS, FILE_ROWS, RAGGED_ROWS, SINGLE_ROW, WIDE_ROWS } from './fixtures.js';
import { checkRoundTrips } from './roundtrip.js';

const rows = FILE_ROWS.rows as unknown as unknown[];

checkRoundTrips({
  name: 'TRON',
  magic: TRON_MAGIC,
  serialize: serializeTron,
  parse: parseTron,
});

describe('TRON: framing', () => {
  it('uses a short magic and no name', () => {
    // TRON trades the name away for bytes. A table name is the operator's
    // labelling, not the agent's business, and one word per document is the
    // difference between the format paying for itself and not.
    assert.equal(serializeTron(rows).split('\n')[0], 't1[4]{path,size,ok}:');
  });

  it('carries a name when given one, and validates it exactly as TOON does', () => {
    // The framing is shared, so a name is available to both and is validated by
    // the same rule. The savings comparison between the two formats is therefore
    // only fair when neither is given a name, which is what the test below does.
    assert.equal(serializeTron(rows, { name: 'files' }).split('\n')[0], 't1 files[4]{path,size,ok}:');
    assert.throws(
      () => serializeTron(rows, { name: 'has space' }),
      (e: unknown) => e instanceof ToonError && e.code === 'unsupported_key',
    );
  });

  it('has no row indent', () => {
    assert.equal(TRON_ROW_INDENT, '');
    const lines = serializeTron(rows).split('\n').filter((l) => l !== '');
    for (const line of lines.slice(1)) {
      assert.ok(!line.startsWith(' '), `indented row in TRON: ${line}`);
    }
  });

  it('ends with a newline', () => {
    assert.ok(serializeTron(rows).endsWith('\n'));
  });

  it('is smaller than TOON on the same table, and the difference is only the indent', () => {
    // Neither is given a name, so the two documents differ by exactly the magic
    // (`toon1` vs `t1`) and the two spaces per row. Anything else would be
    // measuring the fixture, not the format.
    const toon = serializeToon(rows);
    const tron = serializeTron(rows);
    const rowCount = rows.length;
    assert.ok(tron.length < toon.length, `TRON ${tron.length} should beat TOON ${toon.length}`);
    // The header magic is 3 characters longer in TOON, and the indent is 2 per
    // row, so the whole difference is 3 + 2n. Asserting the exact figure rather
    // than "TRON is smaller" is what catches a third format silently inheriting
    // one of the two differences.
    assert.equal(
      toon.length - tron.length,
      TOON_MAGIC.length - TRON_MAGIC.length + 2 * rowCount,
    );
    assert.equal(tron.split('\n')[1], 'src/dir0/file-0.ts,0,false');
  });

  it('rejects a foreign magic', () => {
    assert.throws(() => parseTron(serializeToon(rows)), ToonError);
  });
});

describe('TRON: what it refuses', () => {
  it('refuses a ragged table', () => {
    assert.throws(
      () => serializeTron(RAGGED_ROWS),
      (e: unknown) => e instanceof ToonError && e.code === 'not_a_table',
    );
  });

  it('refuses an empty array', () => {
    assert.throws(
      () => serializeTron([]),
      (e: unknown) => e instanceof ToonError && e.code === 'not_a_table',
    );
  });

  it('refuses a zero-row document, for the same symmetry as the reader', () => {
    assert.throws(
      () => parseTron('t1[0]{a}:'),
      (e: unknown) => e instanceof ToonError && e.code === 'not_a_table',
    );
  });

  it('cannot raise unexpected_line, because it has no indent to be missing', () => {
    // The code is TOON-only by construction. TRON accepts the bare row, which is
    // the point: a reader that demanded indentation would be a second grammar.
    assert.deepEqual(parseTron('t1[1]{a}:\n1\n'), [{ a: 1 }]);
  });

  it('rejects a row count that disagrees with the body', () => {
    assert.throws(
      () => parseTron('t1[3]{a}:\n1\n2\n'),
      (e: unknown) => e instanceof ToonError && e.code === 'row_count_mismatch',
    );
  });
});

describe('TRON: it shares the TOON grammar', () => {
  it('quotes and escapes identically', () => {
    const awkward = AWKWARD_ROWS.rows;
    assert.ok(jsonEqual(parseTron(serializeTron(awkward)) as unknown as never, awkward as never));
  });

  it('carries composites as JSON in the cell, identically', () => {
    const value = [{ a: { b: [1, null, 'x'] } }];
    assert.ok(jsonEqual(parseTron(serializeTron(value)) as unknown as never, value as never));
  });

  it('round-trips a wide table', () => {
    assert.ok(jsonEqual(parseTron(serializeTron(WIDE_ROWS.rows)) as unknown as never, WIDE_ROWS.rows as never));
  });

  it('round-trips the single-row case even though it is the bigger option', () => {
    assert.ok(jsonEqual(parseTron(serializeTron(SINGLE_ROW.rows)) as unknown as never, SINGLE_ROW.rows as never));
  });
});
