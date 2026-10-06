import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  E3_CORPUS,
  E3_DIALECTS,
  E3_REFUSAL_CORPUS,
  runE3CorpusRoundTrip,
  type E3Dialect,
  type ToonCodec,
} from '../../packages/eval/src/suites/e3-output-format.js';
import { parseToon, parseTron, serializeToon, serializeTron } from '../../packages/output-compress/src/index.js';

/**
 * H-10's credential-free half.
 *
 * ## Why this file exists and why it is here
 *
 * `E3` is the suite that would validate TOON and TRON, and it takes its
 * serializer as an injected `ToonCodec`. Until now the only implementation of
 * that interface in the tree was `refEncode`/`refDecode`, a *reference*
 * implementation living inside `packages/eval/test/e3-output-format.test.ts`.
 * So every G10 result this repo has ever produced describes a re-implementation
 * of the grammar, not the code that ships. H-10's precondition -- "after TOON
 * and TRON are validated on real output" -- could not be met by construction:
 * the production serializer was never the thing under test.
 *
 * It lives in `scripts/test/` rather than in either package because it is the
 * seam between two packages that deliberately do not depend on each other.
 * `@strata-ctx/eval` has no dependencies and a gate enforces it (`runner.test.ts`
 * asserts it imports nothing but node builtins and its own modules); adding
 * `@strata-ctx/output-compress` to it would break the measuring apparatus's
 * independence. Conversely `output-compress` has no reason to know the eval
 * corpus exists. `scripts/live-campaign.test.ts` already reaches into
 * `packages/eval/src/` for the same reason.
 *
 * ## What this does and does not establish
 *
 * It establishes that the shipping serializer is lossless on E3's in-domain
 * corpus and refuses all of `E3_REFUSAL_CORPUS`, in both dialects, with no
 * credential and no network. That is the "real output" half of H-10's wording
 * that does not need a model: the values are real-shaped tool payloads, and the
 * fidelity oracle is E3's own.
 *
 * It does NOT establish that a model reads TOON back correctly. That half is
 * `E3` proper, and it needs a live provider. See the F2-7 / H-10 note below.
 */

const productionCodec: ToonCodec = {
  codecId: '@strata-ctx/output-compress serializeToon/parseToon, serializeTron/parseTron',
  encode: (value, dialect) => (dialect === 'toon' ? serializeToon(value) : serializeTron(value)),
  decode: (text, dialect) => (dialect === 'toon' ? parseToon(text) : parseTron(text)),
};

const cases = runE3CorpusRoundTrip(productionCodec);

describe('the production serializer against the E3 corpus', () => {
  it('covers every corpus entry in both dialects, so no case is silently skipped', () => {
    const expected = (E3_CORPUS.length + E3_REFUSAL_CORPUS.length) * E3_DIALECTS.length;
    assert.equal(cases.length, expected, 'runE3CorpusRoundTrip returned a different number of cases than the corpus implies');
  });

  it('exercises both dialects', () => {
    const dialects = new Set(cases.map((c) => c.dialect));
    for (const dialect of E3_DIALECTS) {
      assert.ok(dialects.has(dialect), `${dialect} was never evaluated`);
    }
  });

  it('is lossless on every in-domain case', () => {
    const lossy = cases.filter((c) => c.inDomain && c.state !== 'lossless');
    assert.deepEqual(
      lossy.map((c) => `${c.corpusId}/${c.dialect}: ${String(c.detail)}`),
      [],
      'the shipping serializer is not lossless on E3 in-domain values',
    );
  });

  it('refuses every out-of-domain value, rather than emitting a lossy document', () => {
    // A serializer that accepts a value it cannot represent has already
    // corrupted it, whatever the bytes say.
    const accepted = cases.filter((c) => !c.inDomain && c.state !== 'refused');
    assert.deepEqual(
      accepted.map((c) => `${c.corpusId}/${c.dialect}`),
      [],
      'the shipping serializer accepted a value outside its domain',
    );
  });

  it('refuses NaN, the infinities and -0 in both dialects', () => {
    // Named separately because these are the values that survive a JSON
    // round trip as something else entirely, so a regression here is silent
    // corruption rather than a visible parse error.
    const silent = ['e3-refuse-nan', 'e3-refuse-infinity', 'e3-refuse-negative-zero'];
    for (const id of silent) {
      const forId = cases.filter((c) => c.corpusId === id);
      assert.equal(forId.length, E3_DIALECTS.length, `${id} is no longer in the refusal corpus`);
      for (const c of forId) {
        assert.equal(c.state, 'refused', `${id}/${c.dialect} was not refused: ${String(c.detail)}`);
      }
    }
  });
});

describe('what the production serializer saved on the E3 corpus', () => {
  // Recorded, not gated. G10 asks about losslessness; token savings is E3's
  // other job and needs a model to be meaningful. Reporting the measured
  // numbers here keeps them from being asserted from memory, and makes a
  // regression in either direction visible in the test log rather than in a
  // later argument.
  const dialects: readonly E3Dialect[] = E3_DIALECTS;

  it('reports a saving fraction per in-domain case', () => {
    const rows = cases
      .filter((c) => c.inDomain && c.encodedChars > 0)
      .map((c) => ({
        id: c.corpusId,
        dialect: c.dialect,
        frac: (c.jsonChars - c.encodedChars) / c.jsonChars,
      }));
    assert.ok(rows.length > 0, 'no in-domain case carried a byte measurement');

    for (const dialect of dialects) {
      const forDialect = rows.filter((r) => r.dialect === dialect);
      const mean = forDialect.reduce((sum, r) => sum + r.frac, 0) / forDialect.length;
      // 2% is `DEFAULT_MIN_SAVINGS_FRAC`: below it, `select.ts` uses JSON
      // anyway, so a corpus averaging under it would mean the wiring has
      // nothing to gain on these shapes.
      assert.ok(
        mean > 0.02,
        `${dialect} averaged a ${(mean * 100).toFixed(1)}% saving, below the 2% floor select.ts would apply`,
      );
    }
  });
});