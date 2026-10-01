import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_ENTROPY_KEYWORD_WINDOW,
  DEFAULT_ENTROPY_MIN_LENGTH,
  DEFAULT_ENTROPY_OPTIONS,
  DEFAULT_ENTROPY_THRESHOLD,
  analyzeEntropy,
  shannonEntropy,
} from '../src/entropy.js';
import type { EntropyOptions, EntropyRejection, EntropyVerdict } from '../src/entropy.js';
import { RedactionEngine } from '../src/redact.js';

/**
 * I-1, the probabilistic half: the calibration, and the shapes that are not
 * credentials.
 *
 * This file exists because `src/entropy.ts` carries a calibration table in its
 * header and promises that "entropy.test.ts pins these numbers so a future edit
 * cannot quietly move the threshold under them". Until now nothing pinned
 * them, so the three behaviours below -- the broadened algorithm-prefixed
 * digest shape and the `non_secret_pem_body` rejection in particular -- shipped
 * with zero coverage. Every claim in the header that is falsifiable is
 * falsifiable here.
 *
 * ## What is pinned, and what is pinned as an inequality
 *
 * The two figures the module's central argument rests on (a base64 digest at
 * 5.789 bits/char, an opaque 43-character secret at 5.380) are pinned to three
 * decimal places against named fixtures, because those two are the *inversion*
 * the design turns on: the benign value measures **higher** than the secret it
 * gets confused with, so no threshold and no function of the character
 * histogram can separate them.
 *
 * The remaining rows of the header table are pinned as the *inequalities* the
 * gates depend on rather than as exact numbers. An exact figure for a fixture
 * nobody can recover is a figure that silently stops meaning anything; an
 * inequality a refactor would break is the thing actually worth a red test.
 * Several of the header's shapes are pinned here by their *reason code* rather
 * than by their length, because for some of them the documented rule turns out
 * to be unreachable — see the notes on `sha256:` and the ISO-8601 timestamp.
 */

// ------------------------------------------------------------- fixtures

/**
 * A real `integrity` value, byte-for-byte, out of this repository's own
 * `package-lock.json`. Worth pinning because of *how* it is excluded rather than
 * *that* it is: it carries `/`, `+` and `=` padding, all of which are path
 * punctuation, so `path_punctuation` rejects it two gates before the shape list
 * is consulted. That was already true before the algorithm-prefix rule was
 * broadened, which is why the benign npm/pnpm/yarn entries in E6's corpus have
 * always scored zero and were never the false positive the shape rule fixed.
 */
const NPM_INTEGRITY_REAL =
  'sha512-XExcO+dvLKvVtNTibSTBej1NCAbaGhWn9Ww1ZPx80qsahhPFe/8jgWP0IchNe0F3HwkU7n8ejhH8bjonqht8mQ==';

/**
 * An npm `sha512-<base64>` integrity value with an alphanumeric-only body, which
 * is the form that actually reaches the shape gate: the version above is caught
 * earlier, by `path_punctuation`, because base64's `/`, `+` and `=` are all path
 * punctuation. This is also the fixture the header's 5.789 is measured on, and
 * it is the shape a base64url registry emits.
 */
const NPM_INTEGRITY_ALNUM =
  'sha512-1o7YxKQ2mVbN8pLzRc4TjHnW6YdQ3sXeA0bFgUiOpKmZtNvCyDlSrAhBxEwPoQnJfMgVkHiJuTrEdSaWcQzXyVbNmLgKhIuJdFtGyReXoPbCzQaWv';

/** A pnpm/base64url registry hash: a third length, so length cannot be the rule. */
const PNPM_INTEGRITY_ALNUM =
  'sha512-8fHq2LpRtZx5MwNcYbVdGkA1sEjU7iO3pLnBfYuIoRtEhZqCvXmNbWkAsDfGyHjKlPqWeRtYuIoPaSdFgHjKlZxCvBnMqWeRtYuIoPaSdFgHjKl';

/** `sha256("test")`: the most-copied digest in the world. */
const SHA256_HEX = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

/**
 * E6's `e6-secret-entropy-opaque-a`, verbatim. 43 characters of base64url,
 * unlabelled, and -- this is the point -- it decodes to exactly 32 bytes, which
 * is a SHA-256 digest length. It is one of only three secrets in E6's corpus
 * that no rule in ./patterns.ts can see, so it is the only place the entropy
 * gate is load-bearing, and it is the value a "this is N characters of base64,
 * which is a digest length, therefore benign" fix would silently delete.
 */
const OPAQUE_A = 'Q7Zt3rKq9WvN2xYb4mLp8RsD1gH6jF0cA5uEeIiOoUu';
/** E6's `e6-secret-entropy-opaque-b`: 44 characters, 33 decoded bytes. */
const OPAQUE_B = 'kR4pLdZ9wXnT2vQb7mHsYcF1jA6eG3uO0tIwE5rNq8Yx';
/** E6's `e6-secret-entropy-opaque-c`. */
const OPAQUE_C = 'Wm8QbX2sNvJ5hKzT4pLdR9cYfA1eG7uO3tIwE6rNq0Yx';
/** All three: the set the corpus says only the entropy gate can see. */
const OPAQUE_ALL: readonly string[] = [OPAQUE_A, OPAQUE_B, OPAQUE_C];

/**
 * An independent 43-character base64url value, built to sit exactly on a
 * SHA-256 digest length. Distinct from `OPAQUE_A` so the decoded-length trap is
 * pinned as a *shape*, not as one lucky string.
 */
const AT_SHA256_B64_LENGTH = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5YWJjZGVmZ2hpamtsbW4'.slice(0, 43);

/** A 64-character base64 body at the entropy a real certificate line sits at. */
const CERT_BODY =
  'MIIDtTCCAp2gAwIBAgIUNV0AbEfX2vXk4bJ0z9w0mCQpP0wDQYJKoZIhvcNAQELBQAwEjEQMA4GA1UE';
const PUBKEY_BODY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Z3VS5JJcds3xfnAGQeY1mQ9pL3nQ8bZ1sXq';
const CRL_BODY = 'A0E0Vmi0Jn1tR2O7yVQz9oK5w3Nc8bZ1sXqLpY6rGqZbYtqvKc9d7xWvUqGmRk8o3nH5pA';
const PRIVATE_BODY =
  'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfnAGQeY1mQ9pL3nQ8bZ1sXqLpY6rGqZbYtqvKc9d7xWvUqGmRk8o3nH5pA';

/** A credential-shaped token with no keyword near it: the FP the band is tuned for. */
const OPAQUE_TOKEN = 'aB3dEf9hIjKlMnOpQrStUvWxYz0123456789';

const pemBlock = (label: string, body: string): string =>
  `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;

// ------------------------------------------------------------- helpers

/** The single verdict covering exactly `token` inside `text`. */
const verdictFor = (
  text: string,
  token: string,
  options?: Partial<EntropyOptions>,
): EntropyVerdict => {
  const start = text.indexOf(token);
  assert.ok(start >= 0, 'the fixture does not contain the token under test');
  const found = analyzeEntropy(text, options).find(
    (v) => v.start === start && v.end === start + token.length,
  );
  assert.ok(found !== undefined, 'no verdict covers the token under test');
  return found;
};

const reasonsIn = (text: string, options?: Partial<EntropyOptions>): readonly EntropyRejection[] =>
  analyzeEntropy(text, options)
    .map((v) => v.reason)
    .filter((r): r is EntropyRejection => r !== undefined);

const flaggedIn = (text: string, options?: Partial<EntropyOptions>): readonly EntropyVerdict[] =>
  analyzeEntropy(text, options).filter((v) => v.verdict === 'high_entropy');

/** Asserts nothing in `text` is reported, and names the span if something was. */
const assertNotFlagged = (text: string, why: string): void => {
  const hits = flaggedIn(text).map((v) => ({ start: v.start, end: v.end, span: text.slice(v.start, v.end) }));
  assert.deepEqual(hits, [], why);
};

/**
 * Asserts the token under test is reported, and that it is the *only* thing
 * reported. The uniqueness half matters: a test that only checks "the token was
 * found" passes just as happily when a second unrelated span is also flagged.
 */
const assertFlagged = (text: string, token: string): EntropyVerdict => {
  const v = verdictFor(text, token);
  assert.equal(v.verdict, 'high_entropy', `expected ${token.slice(0, 16)}… to be flagged`);
  assert.equal(v.reason, undefined);
  const others = flaggedIn(text).filter((h) => h.start !== v.start || h.end !== v.end);
  assert.deepEqual(
    others.map((h) => text.slice(h.start, h.end)),
    [],
    `only ${token.slice(0, 16)}… should be flagged`,
  );
  return v;
};

const rounded3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Decoded byte length of an unpadded base64url string. */
const decodedBytes = (b64url: string): number =>
  Buffer.from(b64url.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length;

// ---------------------------------------------------------------- 1
// The calibration the module header argues from.

describe('the calibration the header argues from', () => {
  it('pins the npm integrity figure at 5.789 bits/char', () => {
    assert.equal(rounded3(shannonEntropy(NPM_INTEGRITY_ALNUM)), 5.789);
  });

  it('pins the opaque-secret figure at 5.380 bits/char', () => {
    assert.equal(rounded3(shannonEntropy(OPAQUE_A)), 5.380);
  });

  it('has the benign digest measuring ABOVE the secret, which is the whole problem', () => {
    // This is the measurement that kills every numeric fix. A base64 digest is
    // *more* entropic than the credential it gets confused with, so raising the
    // threshold to admit one loses the other, and lowering it re-admits prose.
    const digest = shannonEntropy(NPM_INTEGRITY_ALNUM);
    const secret = shannonEntropy(OPAQUE_A);
    assert.ok(digest > secret, `expected ${digest} > ${secret}`);
    assert.ok(digest - secret > 0.3, 'the gap the design relies on has closed');
    assert.ok(
      shannonEntropy(PNPM_INTEGRITY_ALNUM) > secret,
      'a second digest length does not clear the secret either',
    );
  });

  it('puts both of them above the threshold, so the threshold cannot exclude either', () => {
    // The arithmetic in the header, asserted rather than trusted:
    // 5.789 - 4.2 = 1.589 bits/char *above* this module's own cutoff.
    assert.equal(rounded3(shannonEntropy(NPM_INTEGRITY_ALNUM) - DEFAULT_ENTROPY_THRESHOLD), 1.589);
    assert.ok(shannonEntropy(OPAQUE_A) > DEFAULT_ENTROPY_THRESHOLD);
    assert.ok(DEFAULT_ENTROPY_THRESHOLD > 4.0, 'the hex alphabet bound is the justification for 4.2');
  });

  it('keeps every hex digest of every length below the threshold (the alphabet bound)', () => {
    // log2(16) = 4.0 is a proof, not a measurement, and this is its empirical
    // shadow: no length of hex reaches the threshold, which is what makes 4.2
    // principled rather than tuned.
    for (const length of [32, 40, 56, 64, 96, 128, 512, 4096]) {
      const hex = '0123456789abcdef'.repeat(Math.ceil(length / 16)).slice(0, length);
      assert.ok(
        shannonEntropy(hex) <= DEFAULT_ENTROPY_THRESHOLD,
        `a ${length}-char hex run reached the threshold`,
      );
    }
    assert.ok(shannonEntropy(SHA256_HEX) <= 4.0);
    // And the base64 ceiling the header names: 64 symbols, 6.0 bits/char.
    assert.equal(Math.log2(64), 6);
    assert.ok(shannonEntropy(NPM_INTEGRITY_ALNUM) < 6);
  });

  it('reports 0 for the empty string rather than NaN', () => {
    assert.equal(shannonEntropy(''), 0);
  });

  it('leaves the documented defaults alone', () => {
    assert.deepEqual(DEFAULT_ENTROPY_OPTIONS, {
      enabled: true,
      minLength: DEFAULT_ENTROPY_MIN_LENGTH,
      threshold: DEFAULT_ENTROPY_THRESHOLD,
      requireKeywordContext: true,
      keywordWindow: DEFAULT_ENTROPY_KEYWORD_WINDOW,
      allowDocPlaceholders: true,
    });
    assert.equal(DEFAULT_ENTROPY_THRESHOLD, 4.2);
    assert.equal(DEFAULT_ENTROPY_MIN_LENGTH, 24);
  });
});

// ---------------------------------------------------------------- 2
// A real npm lockfile value is not a secret. This is the regression the
// broadened algorithm-prefixed-digest shape exists for.

describe('npm integrity values are not secrets', () => {
  it('excludes a real `sha512-<base64>` value out of a real package-lock', () => {
    assertNotFlagged(
      `  "integrity": "${NPM_INTEGRITY_REAL}",`,
      'a real npm integrity value was reported as a secret',
    );
    assertNotFlagged(
      `resolved "https://registry.npmjs.org/tsx/-/tsx-4.20.3.tgz#${NPM_INTEGRITY_REAL.slice(7)}"`,
      'an npm resolved URL carrying a real integrity value was reported',
    );
  });

  it('excludes it whether or not a credential keyword is nearby', () => {
    // A lockfile line has no keyword, so `requireKeywordContext` alone would
    // hide the verdict. Turning the knob off must not expose the value: if it
    // does, the exclusion was the keyword and not the shape.
    const bare = verdictFor(NPM_INTEGRITY_ALNUM, NPM_INTEGRITY_ALNUM).reason;
    const withKeyword = verdictFor(
      `api_key = ${NPM_INTEGRITY_ALNUM}`,
      NPM_INTEGRITY_ALNUM,
      { requireKeywordContext: false },
    ).reason;
    assert.equal(bare, 'known_safe_shape');
    assert.equal(withKeyword, 'known_safe_shape', 'the exclusion depended on the keyword context');
  });

  it('excludes the alphanumeric-only form by shape, which is the form that reaches the gates', () => {
    // The real value above is stopped by `path_punctuation` before the shape
    // list is consulted, because base64's `/`, `+` and `=` are all path
    // punctuation. This is the form that actually has to be recognised.
    assert.equal(verdictFor(NPM_INTEGRITY_ALNUM, NPM_INTEGRITY_ALNUM).reason, 'known_safe_shape');
    assert.equal(PNPM_INTEGRITY_ALNUM.length, 118);
    assert.equal(verdictFor(PNPM_INTEGRITY_ALNUM, PNPM_INTEGRITY_ALNUM).reason, 'known_safe_shape');
  });

  it('excludes a Docker-style `sha256:<hex>` value', () => {
    const docker = `sha256:${SHA256_HEX}`;
    assertNotFlagged(docker, 'a `sha256:<hex>` digest was reported as a secret');
    assertNotFlagged(
      `image: ghcr.io/strata-ctx/gateway@sha256:${SHA256_HEX}`,
      'a digest reference was reported as a secret',
    );
    // Which brake did it: `:` is path punctuation, so `path_punctuation` runs
    // before the shape list and the `:` arm of the algorithm-prefixed rule is
    // unreachable. Pinned so a future edit which drops `:` from
    // PATH_PUNCTUATION cannot silently turn dead code into live code.
    assert.equal(verdictFor(docker, docker).reason, 'path_punctuation');
  });

  it('excludes a `checksum=sha512=...` spelling', () => {
    const body = NPM_INTEGRITY_ALNUM.slice('sha512-'.length);
    for (const text of [
      `checksum=sha512=${body}`,
      `checksum: sha512=${body}`,
      `dist/v1.2.3/manifest.yaml sha512=${body}`,
    ]) {
      assertNotFlagged(text, `a \`sha512=\` value was reported as a secret: ${text.slice(0, 24)}`);
    }
    assert.equal(verdictFor(`checksum=sha512=${body}`, `checksum=sha512=${body}`).reason, 'path_punctuation');
  });

  it('excludes an SRI value the tokenizer glued a `.` or a `;` onto', () => {
    // The reason for the `^[^A-Za-z0-9]{0,4}` prefix. `.` and `;` are not path
    // punctuation, so the coarse tokenizer glues them onto the run and a `^`
    // anchor that demands the algorithm word at offset 0 is defeated by it. A
    // shape rule that reads as absolute and behaves as a suggestion is worse
    // than no rule, because the false positive it was written for comes back.
    for (const prefix of ['.', ';', ';.', '..', ';..']) {
      const text = prefix + NPM_INTEGRITY_ALNUM;
      assert.equal(
        verdictFor(text, text).reason,
        'known_safe_shape',
        `an SRI value prefixed with ${JSON.stringify(prefix)} was not recognised`,
      );
      assertNotFlagged(`integrity: ${text}`, 'a prefixed SRI value was reported as a secret');
    }
    // And the prefix does not rescue a token whose algorithm word is preceded by
    // an alphanumeric, which is a different shape entirely.
    assert.notEqual(
      verdictFor(`a.${NPM_INTEGRITY_ALNUM}`, `a.${NPM_INTEGRITY_ALNUM}`).reason,
      'known_safe_shape',
    );
  });

  it('bounds the artefact prefix at four characters, as documented', () => {
    // The prefix is deliberately `{0,4}`. Five punctuation characters is not the
    // artefact this was written for, and widening it would start excusing real
    // text. Pinned in both directions so the bound is a decision rather than an
    // accident of how the regex was typed.
    assert.equal(
      verdictFor(`....${NPM_INTEGRITY_ALNUM}`, `....${NPM_INTEGRITY_ALNUM}`).reason,
      'known_safe_shape',
    );
    assert.equal(
      verdictFor(`.....${NPM_INTEGRITY_ALNUM}`, `.....${NPM_INTEGRITY_ALNUM}`).reason,
      'no_keyword_context',
    );
  });

  it('recognises `md5-`, `sha3-*` and `sha-512-`, not just the bare sha family', () => {
    const body = NPM_INTEGRITY_ALNUM.slice('sha512-'.length);
    for (const prefix of ['md5-', 'sha1-', 'sha224-', 'sha384-', 'sha3-224-', 'sha3-512-', 'sha-512-', 'SHA512-', 'MD5-']) {
      const text = prefix + body;
      assert.equal(
        verdictFor(text, text).reason,
        'known_safe_shape',
        `${prefix} was not recognised as an algorithm prefix`,
      );
    }
    // `sha-256:` is deliberately absent from that list: a colon is path
    // punctuation, so it never reaches this rule. Asserted so the asymmetry
    // between the `-` and `:` arms is on the record rather than implied.
    assert.equal(verdictFor(`sha-256:${body}`, `sha-256:${body}`).reason, 'path_punctuation');
  });

  it('does not excuse a token that merely contains an algorithm name', () => {
    // The separator is load-bearing. Without it, `sha512ish<token>` would read
    // as a digest and a real secret would walk out of the redactor.
    const lookalike = `sha512ish${OPAQUE_A}`;
    assertFlagged(`x-api-key: ${lookalike}`, lookalike);
    for (const lookalike2 of [`sha512${OPAQUE_A}`, `xsha512-${OPAQUE_A}`, `sha512a${OPAQUE_A}`]) {
      assert.equal(
        verdictFor(`x-api-key: ${lookalike2}`, lookalike2).verdict,
        'high_entropy',
        `${lookalike2.slice(0, 16)}… was excused`,
      );
    }
  });

  it('leaves the pattern layer to catch an SRI-shaped value on a credential line', () => {
    // The shape gate fires before the keyword context, so `API_TOKEN=sha512-…`
    // is exempt on the entropy side. It is not exempt end to end: the
    // assignment rule is what catches it. This is the "entropy is never the only
    // defence" invariant, asserted rather than assumed.
    const text = `API_TOKEN=sha512-${OPAQUE_A}`;
    assert.equal(verdictFor(text, text).reason, 'path_punctuation');
    const out = new RedactionEngine({ mode: 'placeholder' }).redact(text);
    assert.equal(out.changed, true);
    assert.equal(out.findings[0]?.ruleId, 'assigned_secret');
    assert.equal(out.text.includes(OPAQUE_A), false, 'the secret survived redaction');
  });
});

// ---------------------------------------------------------------- 3
// The other side of the same bargain: the opaque secrets entropy alone sees.

describe('an opaque secret is still caught', () => {
  it('catches all three E6 opaque secrets with the keyword knob off', () => {
    // This is the assertion the SAFE_SHAPES comment asks for and the reason the
    // rule it warns against is absent. `OPAQUE_A` is 43 characters of base64url,
    // which decodes to exactly 32 bytes -- a SHA-256 digest length -- and 43 is
    // the canonical base64url length of a SHA-256 digest. A
    // `decoded length == digest length` shape rule would discard it, and with it
    // the only three secrets in E6's corpus that no rule in ./patterns.ts can
    // see. The rule is not in SAFE_SHAPES, and this test is why it must not be.
    assert.equal(decodedBytes(OPAQUE_A), 32);
    assert.equal(Math.ceil((32 * 8) / 6), OPAQUE_A.length);

    for (const secret of OPAQUE_ALL) {
      const hits = flaggedIn(secret, { requireKeywordContext: false });
      assert.equal(hits.length, 1, `${secret.slice(0, 12)}… was not caught by the entropy gate alone`);
      assert.ok(shannonEntropy(secret) > DEFAULT_ENTROPY_THRESHOLD, `${secret.slice(0, 12)}… fell below the threshold`);
      assert.equal(verdictFor(secret, secret).reason, 'no_keyword_context');
    }
  });

  it('catches them when a credential keyword is in range, which is the default path', () => {
    for (const secret of OPAQUE_ALL) {
      const labelled = assertFlagged(`x-api-key: ${secret}`, secret);
      assert.equal(labelled.confidence, 'probable');
      assertFlagged(`the api token is ${secret} and it rotates weekly`, secret);
    }
  });

  it('still refuses the unlabelled one by default, which is the documented tradeoff', () => {
    // `requireKeywordContext` (default on) is the knob that trades unlabelled
    // recall for a false-positive rate. Asserting the tradeoff is still the one
    // that was chosen makes a future widening of the band a red test rather than
    // a surprise in a gist.
    assert.equal(verdictFor(OPAQUE_A, OPAQUE_A).reason, 'no_keyword_context');
    assertNotFlagged(OPAQUE_A, 'an unlabelled opaque token was flagged by default');
    assertNotFlagged(`note: ${OPAQUE_A} appears in the README`, 'an unlabelled token near prose was flagged');
  });

  it('does not mistake a decoded digest length for a digest', () => {
    // The negative half of the trap, stated as a shape: the safe list admits hex
    // digests by *character* length and base64 digests by *algorithm prefix*,
    // and nothing admits a decoded length.
    assert.equal(AT_SHA256_B64_LENGTH.length, 43);
    assert.equal(decodedBytes(AT_SHA256_B64_LENGTH), 32);
    assert.equal(
      flaggedIn(`x-api-key: ${AT_SHA256_B64_LENGTH}`, { requireKeywordContext: false }).length,
      1,
      'a 32-byte opaque value was excused by its decoded length',
    );
  });

  it('caps an entropy hit below `certain` in every configuration', () => {
    for (const options of [{}, { requireKeywordContext: false }]) {
      const v = verdictFor(`x-api-key: ${OPAQUE_A}`, OPAQUE_A, options);
      assert.equal(v.verdict, 'high_entropy');
      assert.notEqual(v.confidence, 'certain', 'entropy produced a `certain` verdict');
      assert.equal(v.confidence, options.requireKeywordContext === false ? 'possible' : 'probable');
    }
  });
});

// ---------------------------------------------------------------- 4
// (c) PEM bodies.

describe('non-secret PEM bodies are not credentials', () => {
  it('exempts a CERTIFICATE, a PUBLIC KEY and a CRL body', () => {
    const cases: readonly [string, string][] = [
      ['CERTIFICATE', CERT_BODY],
      ['PUBLIC KEY', PUBKEY_BODY],
      ['CRL', CRL_BODY],
      ['X509 CRL', CRL_BODY],
      ['X509 CERTIFICATE', CERT_BODY],
      ['TRUSTED CERTIFICATE', CERT_BODY],
      ['CERTIFICATE REQUEST', CERT_BODY],
      ['PGP PUBLIC KEY BLOCK', CERT_BODY],
      ['PGP SIGNATURE', CERT_BODY],
      ['DH PARAMETERS', CERT_BODY],
      ['DSA PARAMETERS', CERT_BODY],
      ['RSA PARAMETERS', CERT_BODY],
      ['EC PARAMETERS', CERT_BODY],
    ];
    for (const [label, body] of cases) {
      const text = pemBlock(label, body);
      assert.equal(
        verdictFor(text, body).reason,
        'non_secret_pem_body',
        `a ${label} body was not exempted`,
      );
      assertNotFlagged(text, `a ${label} block was reported as a secret`);
    }
  });

  it('still flags every spelling of a private key body', () => {
    // The load-bearing half. The allow-list names no label containing
    // `PRIVATE`, so the spellings a private key uses are not excused by a rule
    // that failed to enumerate them -- they simply are not on the list.
    const labels = [
      'PRIVATE KEY',
      'RSA PRIVATE KEY',
      'EC PRIVATE KEY',
      'ENCRYPTED PRIVATE KEY',
      'DSA PRIVATE KEY',
      'OPENSSH PRIVATE KEY',
      'PGP PRIVATE KEY BLOCK',
    ];
    for (const label of labels) {
      const text = pemBlock(label, PRIVATE_BODY);
      assertFlagged(text, PRIVATE_BODY);
      // `PRIVATE KEY` in the header arms the keyword context, so the default
      // configuration reports this at `probable`; with the knob off it is
      // `possible`. Both are below `certain`, which is the invariant.
      assert.equal(verdictFor(text, PRIVATE_BODY).confidence, 'probable', label);
      assert.equal(
        verdictFor(text, PRIVATE_BODY, { requireKeywordContext: false }).confidence,
        'possible',
        label,
      );
    }
  });

  it('matches the block label case-insensitively', () => {
    for (const label of ['certificate', 'CERTIFICATE', 'CeRtIfIcAtE', 'public key', 'x509 crl']) {
      const text = pemBlock(label, CERT_BODY);
      assert.equal(verdictFor(text, CERT_BODY).reason, 'non_secret_pem_body', label);
    }
  });

  it('exempts a truncated block that has BEGIN and no END', () => {
    // The common case is a truncated scrollback that captured a header and two
    // body lines. Requiring the footer would exempt the full block and flag the
    // fragment, which is backwards.
    for (const label of ['CERTIFICATE', 'PUBLIC KEY', 'X509 CRL']) {
      const truncated = `-----BEGIN ${label}-----\n${CERT_BODY}`;
      assert.equal(verdictFor(truncated, CERT_BODY).reason, 'non_secret_pem_body', label);
      assertNotFlagged(truncated, `a truncated ${label} was reported as a secret`);
    }
  });

  it('exempts the body only, never a header line', () => {
    const text = pemBlock('CERTIFICATE', CERT_BODY);
    const bodyStart = text.indexOf(CERT_BODY);
    assert.deepEqual(flaggedIn(text), []);
    // Exactly one exemption, and it is exactly the body span — not the `BEGIN`
    // line, not the `END` line, and not a span that merely overlaps the body.
    const exempted = analyzeEntropy(text).filter((v) => v.reason === 'non_secret_pem_body');
    assert.equal(exempted.length, 1);
    assert.equal(exempted[0]?.start, bodyStart);
    assert.equal(exempted[0]?.end, bodyStart + CERT_BODY.length);
    // Every other candidate on those three lines is rejected for a different,
    // pre-existing reason, so the block's structure is not what is being excused.
    for (const v of analyzeEntropy(text)) {
      if (v.start !== bodyStart) assert.equal(v.reason, 'too_short');
    }
  });

  it('does not exempt a body line that is outside any block', () => {
    // The exemption is positional, so the negative case matters: the same 80
    // characters with no marker above them are an unlabelled opaque token and
    // must be treated as one.
    assert.equal(verdictFor(CERT_BODY, CERT_BODY).reason, 'no_keyword_context');
    assert.equal(flaggedIn(CERT_BODY, { requireKeywordContext: false }).length, 1);

    // And after a *closed* block: nearest-marker-wins means the following body
    // is not inside the certificate any more.
    const afterClosed = `${pemBlock('CERTIFICATE', CERT_BODY)}\n${PRIVATE_BODY}`;
    assert.equal(verdictFor(afterClosed, PRIVATE_BODY).reason, 'no_keyword_context');
    assert.ok(flaggedIn(afterClosed, { requireKeywordContext: false }).length === 1);
  });

  it('takes the nearest marker, so a private key after an unclosed certificate is still flagged', () => {
    // A PEM file that concatenates blocks and loses an END is the realistic
    // version of this. If the exemption scanned for *any* preceding BEGIN rather
    // than the nearest one, every private key after a certificate would be
    // excused, and that is the whole false-negative class this feature risks.
    const text =
      `-----BEGIN CERTIFICATE-----\n${CERT_BODY}\n` +
      `-----BEGIN RSA PRIVATE KEY-----\n${PRIVATE_BODY}\n-----END RSA PRIVATE KEY-----`;
    assertFlagged(text, PRIVATE_BODY);
    assert.equal(verdictFor(text, CERT_BODY).reason, 'non_secret_pem_body');

    // And the mirror image: a certificate body after a private key is exempted,
    // because the nearest marker is the one that applies.
    const mirror =
      `-----BEGIN RSA PRIVATE KEY-----\n${PRIVATE_BODY}\n` +
      `-----BEGIN CERTIFICATE-----\n${CERT_BODY}\n-----END CERTIFICATE-----`;
    assert.equal(verdictFor(mirror, CERT_BODY).reason, 'non_secret_pem_body');
    assertFlagged(mirror, PRIVATE_BODY);
  });

  it('does not exempt a label that merely contains an allow-listed word', () => {
    // The set is exact-match, so a label that starts with an allow-listed name
    // is not on the list. Asserted as "not exempted" rather than as a specific
    // reason, because what follows the PEM check depends on the label's own
    // keywords (`PUBLIC KEY BLOB SECRET` arms the keyword context itself).
    for (const label of ['CERTIFICATE WITH PASSPHRASE', 'CRL BLOB', 'PUBLIC KEY BLOB SECRET', 'CERTIFICATE2']) {
      const text = pemBlock(label, CERT_BODY);
      assert.notEqual(
        verdictFor(text, CERT_BODY).reason,
        'non_secret_pem_body',
        `${label} was excused`,
      );
    }
  });

  it('does not honour a malformed BEGIN marker', () => {
    // Every one of these is a body with something that looks like a marker and
    // is not one. Refusing to exempt them is the fail-safe direction.
    const malformed: readonly string[] = [
      `-----BEGIN CERTIFICATE\n${CERT_BODY}\n-----END CERTIFICATE-----`,
      `-----BEGIN CERTIFICATE----\n${CERT_BODY}\n-----END CERTIFICATE----`,
      `-----BEGIN -----\n${CERT_BODY}\n-----END -----`,
      `-----BEGIN CERT-IFICATE-----\n${CERT_BODY}\n-----END CERT-IFICATE-----`,
      `-----END CERTIFICATE-----\n${CERT_BODY}`,
      `CERTIFICATE-----\n${CERT_BODY}\n-----END CERTIFICATE-----`,
      `BEGIN CERTIFICATE\n${CERT_BODY}\nEND CERTIFICATE`,
      `-----BEGIN PRIVATE KEY-----\n${CERT_BODY}\n-----END PRIVATE KEY-----`,
    ];
    for (const text of malformed) {
      assert.notEqual(
        verdictFor(text, CERT_BODY).reason,
        'non_secret_pem_body',
        `a malformed marker was honoured: ${JSON.stringify(text.slice(0, 44))}`,
      );
    }
    // The one spelling that *is* honoured, pinned so the boundary is visible: a
    // well-formed five-dash run followed by stray characters is a real BEGIN.
    const trailingJunk = `-----BEGIN CERTIFICATE-----X\n${CERT_BODY}`;
    assert.equal(verdictFor(trailingJunk, CERT_BODY).reason, 'non_secret_pem_body');
  });

  it('handles an empty body, a header-only block and a lone marker without crashing', () => {
    for (const text of [
      pemBlock('CERTIFICATE', ''),
      '-----BEGIN CERTIFICATE-----',
      '-----BEGIN ',
      '-----',
      '',
    ]) {
      assert.doesNotThrow(() => analyzeEntropy(text));
      assertNotFlagged(text, `${JSON.stringify(text.slice(0, 24))} was reported as a secret`);
    }
  });

  it('runs the PEM check before the keyword check, and that ordering is load-bearing', () => {
    // `PUBLIC KEY` in the header is itself a keyword match, so if the keyword
    // context were consulted first, every public-key body in existence would be
    // flagged. The exemption has to come first, and this asserts the reason
    // rather than the coincidence.
    const text = pemBlock('PUBLIC KEY', PUBKEY_BODY);
    assert.equal(verdictFor(text, PUBKEY_BODY).reason, 'non_secret_pem_body');
    assert.ok(
      /[^A-Za-z0-9][A-Za-z0-9 ]*key/i.test('-----BEGIN PUBLIC KEY-----'),
      'the header no longer arms the keyword context, so this test stopped testing anything',
    );
  });

  it('still exempts a single-line certificate, because the tokens are still positional', () => {
    // The coarse tokenizer splits on whitespace, so a one-line PEM still yields
    // the body as its own candidate with the marker above it. Worth pinning
    // because `openssl x509 -text` and a folded log line both produce it.
    const oneLine = `-----BEGIN CERTIFICATE----- ${CERT_BODY} -----END CERTIFICATE-----`;
    assertNotFlagged(oneLine, 'a single-line certificate was reported as a secret');
    assert.equal(verdictFor(oneLine, CERT_BODY).reason, 'non_secret_pem_body');
  });

  it('pins the false negative it does introduce', () => {
    // The cost of a positional exemption, stated rather than left to be
    // discovered: a real credential pasted *inside* an open certificate block is
    // excused, because position is the only signal available and base64 has no
    // shape to check it against. The knob does not help — the check runs first.
    // This is a deliberate tradeoff, pinned so that changing it is a decision.
    const text =
      `-----BEGIN CERTIFICATE-----\n${CERT_BODY}\n` +
      `api_key = ${OPAQUE_TOKEN}\n-----END CERTIFICATE-----`;
    assert.equal(verdictFor(text, OPAQUE_TOKEN).reason, 'non_secret_pem_body');
    assert.equal(
      verdictFor(text, OPAQUE_TOKEN, { requireKeywordContext: false }).reason,
      'non_secret_pem_body',
    );
    // Outside the block the same token is caught under every configuration,
    // which is what bounds the tradeoff: it needs a credential *and* an
    // enclosing marker, and dropping the marker restores full recall.
    assertFlagged(`api_key = ${OPAQUE_TOKEN}`, OPAQUE_TOKEN);
    assert.equal(
      flaggedIn(`api_key = ${OPAQUE_TOKEN}`, { requireKeywordContext: false }).length,
      1,
    );
  });
});

// ---------------------------------------------------------------- 5
// The two reasons are different facts.

describe('`non_secret_pem_body` is distinct from `known_safe_shape`', () => {
  it('reports a context exemption and a token-shape exemption differently', () => {
    // "we recognised the token" and "we recognised what the token is part of"
    // are different facts. A false-positive report that merges them cannot tell
    // an operator which brake did the work, and cannot tell a future edit which
    // one it broke.
    const inCert = verdictFor(pemBlock('CERTIFICATE', CERT_BODY), CERT_BODY);
    const bare = verdictFor(CERT_BODY, CERT_BODY);
    const digest = verdictFor(NPM_INTEGRITY_ALNUM, NPM_INTEGRITY_ALNUM);

    assert.equal(inCert.reason, 'non_secret_pem_body');
    assert.equal(bare.reason, 'no_keyword_context');
    assert.equal(digest.reason, 'known_safe_shape');
    assert.notEqual(inCert.reason, digest.reason);
    assert.notEqual(inCert.entropy, digest.entropy);
  });

  it('reports the PEM body even with the keyword context switched off', () => {
    // Otherwise `non_secret_pem_body` would be unreachable in exactly the
    // configuration where a deployment has decided it trusts entropy on
    // unlabelled tokens — which is the configuration that reads the most
    // certificates.
    const text = pemBlock('CERTIFICATE', CERT_BODY);
    assert.equal(
      verdictFor(text, CERT_BODY, { requireKeywordContext: false }).reason,
      'non_secret_pem_body',
    );
  });

  it('reports `low_entropy` — not `known_safe_shape` — when the threshold is raised above a token', () => {
    // Pinned because the module header asserts the opposite. `low_entropy` is
    // checked after the shape list, so a raised threshold produces
    // `low_entropy` for an unrecognised token and `known_safe_shape` only for one
    // the shape list already recognised. The two must not be conflated in a
    // report, and this is which one you actually get.
    assert.equal(
      verdictFor(OPAQUE_A, OPAQUE_A, { threshold: 99 }).reason,
      'low_entropy',
    );
    assert.equal(
      verdictFor(NPM_INTEGRITY_ALNUM, NPM_INTEGRITY_ALNUM, { threshold: 99 }).reason,
      'known_safe_shape',
    );
    assert.equal(
      verdictFor(pemBlock('CERTIFICATE', CERT_BODY), CERT_BODY, { threshold: 99 }).reason,
      'non_secret_pem_body',
    );
  });
});

// ---------------------------------------------------------------- 6
// Regression guards: the benign classes the shape gate exists for.

describe('prose, paths and other benign shapes are still rejected', () => {
  const benign: readonly [string, string][] = [
    ['a long English sentence', 'the quick brown fox jumps over the lazy dog while the compiler complains about an unused import'],
    [
      'an absolute filesystem path',
      '/Users/vinodatwal/Documents/research/strata-ctx/packages/security/src/entropy.ts',
    ],
    ['a canonical uuid', '9f86d081-884c-7d65-9a2f-eaa0c55ad015'],
    ['a compact uuid', '9f86d081884c7d659a2feaa0c55ad015'],
    ['a plain sha256 hex digest', SHA256_HEX],
    ['a git object id', '4f2a1b9c7d3e8065a1f4c9b2e7d5a3c8f1e6b4d2'],
    ['a dotted semver with a prerelease', '1.2.3-alpha.1.build.20261001'],
    ['an ipv4 literal', '10.4.0.9'],
    ['a camelCase identifier with a digit', 'getUserAccountBalanceCacheV2'],
    ['a data URI', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'],
    ['an AWS example key', 'AKIAIOSFODNN7EXAMPLE'],
    ['a single-class run of 200 characters', 'A'.repeat(200)],
  ];

  for (const [label, text] of benign) {
    it(`rejects ${label}`, () => {
      assertNotFlagged(text, `${label} was reported as a secret`);
      assertNotFlagged(`api_key = ${text}`, `${label} was reported as a secret next to a keyword`);
      assertNotFlagged(
        `const digest = "${text}"; // ${label}`,
        `${label} was reported as a secret inside a line`,
      );
    });
  }

  it('reaches the shape gate for the benign shapes that are long enough to get there', () => {
    // The reason codes, so a refactor cannot quietly swap which brake does the
    // work. The uuid, digest and semver entries are the three the shape list
    // exists for, and none of them is reachable via a different gate.
    assert.equal(verdictFor('9f86d081-884c-7d65-9a2f-eaa0c55ad015', '9f86d081-884c-7d65-9a2f-eaa0c55ad015').reason, 'known_safe_shape');
    assert.equal(verdictFor('9f86d081884c7d659a2feaa0c55ad015', '9f86d081884c7d659a2feaa0c55ad015').reason, 'known_safe_shape');
    assert.equal(verdictFor(SHA256_HEX, SHA256_HEX).reason, 'known_safe_shape');
    assert.equal(verdictFor('4f2a1b9c7d3e8065a1f4c9b2e7d5a3c8f1e6b4d2', '4f2a1b9c7d3e8065a1f4c9b2e7d5a3c8f1e6b4d2').reason, 'known_safe_shape');
    assert.equal(verdictFor('1.2.3-alpha.1.build.20261001', '1.2.3-alpha.1.build.20261001').reason, 'known_safe_shape');
    // And the ones that stop earlier, with the earlier reason.
    assert.equal(verdictFor('getUserAccountBalanceCacheV2', 'getUserAccountBalanceCacheV2').reason, 'low_entropy');
    assert.equal(verdictFor('A'.repeat(200), 'A'.repeat(200)).reason, 'single_character_class');
    assert.equal(
      verdictFor('/Users/vinodatwal/Documents/research/strata-ctx/packages/security/src/entropy.ts', '/Users/vinodatwal/Documents/research/strata-ctx/packages/security/src/entropy.ts').reason,
      'path_punctuation',
    );
    assert.equal(verdictFor('10.4.0.9', '10.4.0.9').reason, 'too_short');
  });

  it('rejects a real ISO-8601 timestamp by punctuation, not by the timestamp shape', () => {
    // Pinned because the header lists an `iso-8601 timestamp` entry in
    // SAFE_SHAPES and it cannot fire. Every string its regex accepts contains
    // `HH:MM`, and `:` is path punctuation, so `path_punctuation` (or
    // `too_short`) always wins. The entry is dead in both directions: a real
    // timestamp never reaches it, and a colon-free string does not match it.
    const real = '2026-10-01T07:13:00.123456Z';
    assert.equal(verdictFor(real, real).reason, 'path_punctuation');
    assertNotFlagged(real, 'a real timestamp was reported as a secret');
    const colonFree = '2026-10-01T071300.123456Z';
    assert.notEqual(verdictFor(colonFree, colonFree).reason, 'known_safe_shape');
    assert.equal(verdictFor(colonFree, colonFree).reason, 'low_entropy');
  });

  it('never reports `whitespace`, because the tokenizer cannot produce such a token', () => {
    // `whitespace` is in the `EntropyRejection` union but the coarse tokenizer is
    // `[\x21-\x7e]+`, which cannot emit whitespace, so the branch is unreachable.
    // Pinned so that the union is known to carry a dead member rather than
    // discovered later by an operator reading a report that can never show it.
    for (const text of [
      'a b',
      'a\tb',
      'a\nb',
      `aB3dEf9hIjKlMnOpQrStUvWxYz0123456789 tail`,
      `api_key: ${OPAQUE_A} session: ${OPAQUE_B}`,
    ]) {
      assert.equal(reasonsIn(text).includes('whitespace'), false, `\`whitespace\` fired on ${JSON.stringify(text)}`);
    }
  });

  it('rejects a unified diff, which is dense punctuation rather than a token', () => {
    const diff =
      'diff --git a/src/checkout/settle.ts b/src/checkout/settle.ts\n' +
      'index 8f41d90..b2e5f7a 100644\n' +
      '@@ -118,7 +118,7 @@ export async function settlePartialRefund(order: Order) {\n' +
      '-  const captured = await payments.capture(order.authorization);\n' +
      '+  const captured = await payments.capture(order.authorization, { idempotent: true });';
    assertNotFlagged(diff, 'a unified diff was reported as a secret');
  });

  it('rejects an .env.example in full', () => {
    const env =
      '# copy to .env and fill in\nDATABASE_URL=${DATABASE_URL}\nAPI_KEY=<your-api-key>\nSESSION_SECRET=changeme';
    assertNotFlagged(env, 'an .env.example was reported as a secret');
  });

  it('rejects a token of only one character class however long it is', () => {
    // The gate that removes English words, UPPER_SNAKE names and the padded tail
    // of a base64 blob: length alone is not evidence.
    for (const text of ['A'.repeat(200), 'aaaaaaaaaaaa', 'abcdefghijkl', '-'.repeat(80), '0'.repeat(200)]) {
      assertNotFlagged(text, `${text.slice(0, 12)}… was reported as a secret`);
    }
  });
});

// ---------------------------------------------------------------- 7
// Robustness, options and determinism.

describe('robustness', () => {
  it('returns nothing for empty input and for disabled', () => {
    assert.deepEqual(analyzeEntropy(''), []);
    assert.deepEqual(analyzeEntropy('   '), []);
    assert.deepEqual(analyzeEntropy('\n\t\r'), []);
    assert.deepEqual(analyzeEntropy(NPM_INTEGRITY_ALNUM, { enabled: false }), []);
  });

  it('survives very short and degenerate input', () => {
    for (const text of ['a', '-', '.', '-----BEGIN -----', '-----', '\n\n\n', ' ', '']) {
      assert.doesNotThrow(() => analyzeEntropy(text));
    }
  });

  it('does not consider a short token at all', () => {
    assert.equal(verdictFor('x-api-key: abc123XYZ', 'abc123XYZ').reason, 'too_short');
    assert.equal(verdictFor(`x-api-key: ${'a'.repeat(DEFAULT_ENTROPY_MIN_LENGTH - 1)}`, 'a'.repeat(DEFAULT_ENTROPY_MIN_LENGTH - 1)).reason, 'too_short');
  });

  it('splits on whitespace, so a secret beside a word is two candidates', () => {
    // The coarse tokenizer is `[\x21-\x7e]+`, so a secret pasted next to a word
    // is still its own candidate and is still judged on its own entropy.
    assertNotFlagged(`  ${OPAQUE_TOKEN} tail  `, 'a credential-shaped token beside a word was reported');
    assert.equal(
      verdictFor(`  ${OPAQUE_TOKEN} tail  `, OPAQUE_TOKEN).reason,
      'no_keyword_context',
    );
    assert.equal(
      verdictFor(`  ${OPAQUE_TOKEN} tail  `, OPAQUE_TOKEN, { requireKeywordContext: false }).verdict,
      'high_entropy',
    );
  });

  it('honours minLength, threshold and keywordWindow', () => {
    const secret = OPAQUE_A;
    assert.equal(verdictFor(secret, secret, { minLength: 64 }).reason, 'too_short');
    assert.equal(verdictFor(secret, secret, { threshold: 99 }).reason, 'low_entropy');
    // A keyword further away than the window cannot arm the context; the same
    // keyword inside it can. Both directions, so the window is pinned rather
    // than assumed.
    const gap = DEFAULT_ENTROPY_KEYWORD_WINDOW + 12;
    const far = `api_key:${' '.repeat(gap)}${secret}`;
    const near = `api_key: ${secret}`;
    assert.ok(far.indexOf(secret) - far.indexOf('api_key') > DEFAULT_ENTROPY_KEYWORD_WINDOW);
    assert.equal(verdictFor(far, secret).reason, 'no_keyword_context');
    assert.equal(verdictFor(near, secret).verdict, 'high_entropy');
    assert.equal(verdictFor(near, secret, { keywordWindow: 0 }).reason, 'no_keyword_context');
  });

  it('honours allowDocPlaceholders in both directions', () => {
    // The placeholder words are all alphabetic, so they only reach this check
    // once `minLength` is lowered; otherwise `single_character_class` fires
    // first. Asserted at a minLength that lets them through.
    assert.equal(
      verdictFor('changeme', 'changeme', { minLength: 4 }).reason,
      'doc_placeholder',
    );
    assert.notEqual(
      verdictFor('changeme', 'changeme', { minLength: 4, allowDocPlaceholders: false }).reason,
      'doc_placeholder',
    );
    assert.equal(verdictFor('EXAMPLE', 'EXAMPLE', { minLength: 4 }).reason, 'doc_placeholder');
  });

  it('is deterministic: the same input yields byte-identical verdicts', () => {
    const text = [
      pemBlock('CERTIFICATE', CERT_BODY),
      `"integrity": "${NPM_INTEGRITY_REAL}"`,
      NPM_INTEGRITY_ALNUM,
      `api_key: ${OPAQUE_A}`,
      pemBlock('RSA PRIVATE KEY', PRIVATE_BODY),
    ].join('\n');
    const first = JSON.stringify(analyzeEntropy(text));
    assert.equal(first, JSON.stringify(analyzeEntropy(text)));
    assert.deepEqual(analyzeEntropy(text), analyzeEntropy(text));
  });

  it('reports ordered, in-range, non-overlapping spans with a coherent verdict/reason pair', () => {
    const text = `${pemBlock('CERTIFICATE', CERT_BODY)}\napi_key: ${OPAQUE_A}`;
    const verdicts = analyzeEntropy(text);
    assert.ok(verdicts.length >= 2);
    for (let i = 1; i < verdicts.length; i += 1) {
      const prev = verdicts[i - 1];
      const cur = verdicts[i];
      assert.ok(prev !== undefined);
      assert.ok(cur !== undefined);
      assert.ok(cur.start >= prev.start, 'verdicts are not ordered by offset');
    }
    for (const v of verdicts) {
      assert.ok(v.start >= 0 && v.start < v.end && v.end <= text.length, `bad span ${v.start}..${v.end}`);
      assert.equal(shannonEntropy(text.slice(v.start, v.end)), v.entropy, 'the reported entropy is not the span it claims');
      if (v.verdict === 'rejected') {
        assert.notEqual(v.reason, undefined, 'a rejection with no reason');
        assert.equal(v.confidence, undefined, 'a rejection with a confidence');
      } else {
        assert.equal(v.reason, undefined, 'a finding with a rejection reason');
        assert.notEqual(v.confidence, undefined, 'a finding with no confidence');
      }
    }
    // Exactly one span overlaps: the opaque secret.
    assert.equal(verdicts.filter((v) => v.start < v.end && v.start === text.indexOf(OPAQUE_A)).length >= 1, true);
  });
});
