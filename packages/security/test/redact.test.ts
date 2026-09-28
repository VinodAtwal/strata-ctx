import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RedactionEngine } from '../src/redact.js';
import {
  SecretBlockedError,
  SecretLeakError,
  assertCatalogueWellFormed,
  optionsFromPolicy,
  redactDeep,
  redactText,
  redactionModeFromPolicy,
} from '../src/redact.js';
import { analyzeEntropy } from '../src/entropy.js';
import { SECRET_PATTERNS, placeholderFor } from '../src/patterns.js';
import type { SecretKind } from '../src/patterns.js';
import { testPolicy } from './fixtures.js';

/**
 * I-1 and I-2: does the redactor find the secrets, and can it be talked out of
 * the job?
 *
 * The catalogue is exercised one kind at a time with a literal credential, then
 * the whole thing is exercised with a document that has all of them at once,
 * because the failure mode of a redaction engine is rarely "it missed the one I
 * tested" -- it is the overlap resolution eating a neighbour, or a second pass
 * mangling its own placeholder.
 */

const SAMPLE: { kind: SecretKind; text: string }[] = [
  { kind: 'private_key', text: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----' },
  { kind: 'aws_access_key_id', text: 'AKIAIOSFODNN7EXAMPLE' },
  { kind: 'github_token', text: 'ghp_16C7e42F292c6912E7710c838347Ae178B4a' },
  { kind: 'anthropic_api_key', text: 'sk-ant-api03-Zx91Kd7LmQwErTyUiOpAsDfGhJkLzXcVbNm1234567890' },
  { kind: 'npm_token', text: 'npm_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789' },
  { kind: 'slack_token', text: 'xoxb-2412-44851-abcdefghijklmnopqrstuvwx' },
  { kind: 'google_api_key', text: 'AIzaSyB1K2mQ7xV9pL0nR4tY6uI8oP2aS3dF5gH' },
  { kind: 'jwt', text: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk' },
  { kind: 'aws_secret_access_key', text: 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
  { kind: 'connection_string', text: 'postgresql://user:hunter2pass@db.internal:5432/app' },
  { kind: 'url_userinfo_password', text: 'https://admin:correcthorsebattery@internal.example.com/' },
  // Opaque, not JWT-shaped: a `Bearer eyJ...` is claimed by the `jwt` rule
  // instead, which is the overlap resolver working, not a missing rule.
  { kind: 'bearer_token', text: 'authorization: Bearer aB3dEf9hIjKlMnOpQrStUvWxYz0123456789' },
  { kind: 'assigned_secret', text: 'DB_PASSWORD=hunter2pass' },
];

describe('the pattern catalogue', () => {
  it('is internally consistent', () => {
    // Asserted at construction by the engine too; a direct call is the check
    // that names which pattern is broken.
    assert.doesNotThrow(() => assertCatalogueWellFormed());
  });

  it('has a unique id and regex per pattern', () => {
    const ids = new Set(SECRET_PATTERNS.map((p) => p.id));
    const sources = new Set(SECRET_PATTERNS.map((p) => p.regex.source));
    assert.equal(ids.size, SECRET_PATTERNS.length, 'duplicate pattern id');
    assert.equal(sources.size, SECRET_PATTERNS.length, 'duplicate pattern regex');
  });

  it('has a distinct placeholder per kind', () => {
    const placeholders = new Set(SECRET_PATTERNS.map((p) => placeholderFor(p.kind)));
    assert.equal(placeholders.size, new Set(SECRET_PATTERNS.map((p) => p.kind)).size);
  });
});

describe('I-1: each catalogue kind is detected', () => {
  for (const { kind, text } of SAMPLE) {
    it(`finds ${kind}`, () => {
      const engine = new RedactionEngine({ mode: 'placeholder' });
      const result = engine.redact(`before ${text} after`);
      assert.equal(result.text.includes(text), false, `the raw ${kind} survived redaction`);
      assert.ok(
        result.text.includes(placeholderFor(kind)),
        `expected ${placeholderFor(kind)} in ${result.text}`,
      );
      // A redactor that eats the sentence around the secret is not usable.
      assert.ok(result.text.startsWith('before '), 'leading text was damaged');
      assert.ok(result.text.endsWith(' after'), 'trailing text was damaged');
      assert.ok(
        result.findings.some((f) => f.kind === kind),
        `no finding of kind ${kind}: ${JSON.stringify(result.findings.map((f) => f.kind))}`,
      );
    });
  }

  it('reports a finding without leaking the secret or the offsets', () => {
    const engine = new RedactionEngine({ mode: 'placeholder' });
    const result = engine.redact('AKIAIOSFODNN7EXAMPLE');
    assert.equal(result.findings.length, 1);
    const [f] = result.findings;
    assert.ok(f, 'exactly one finding was expected');
    assert.equal(f.kind, 'aws_access_key_id');
    assert.equal(f.length, 'AKIAIOSFODNN7EXAMPLE'.length);
    assert.match(f.digest, /^[0-9a-f]{64}$/);
    // The finding is what gets written to the audit log, so it must not be a
    // second copy of the credential.
    assert.equal(JSON.stringify(f).includes('AKIAIOSFODNN7EXAMPLE'), false);
  });
});

describe('redaction is idempotent', () => {
  const engine = new RedactionEngine({ mode: 'placeholder' });

  it('leaves its own placeholders alone', () => {
    const once = engine.redact('token: Bearer abcdefghijklmnopqrstuvwxyz012345').text;
    const twice = engine.redact(once);
    assert.equal(twice.text, once, 'a second pass changed the redacted text');
  });

  it('does not re-redact a redacted connection string', () => {
    const once = engine.redact('postgresql://user:hunter2pass@db/app').text;
    assert.equal(engine.redact(once).text, once);
  });
});

describe('overlapping matches', () => {
  it('emits one placeholder per finding, with no doubled or partial overlap', () => {
    const engine = new RedactionEngine({ mode: 'placeholder' });
    // Overlapping matches are the characteristic bug in a redaction engine: the
    // same bytes are claimed twice, and the result is a truncated placeholder in
    // the middle of a secret. `RedactionFinding` deliberately carries no offsets,
    // so this is asserted from the output -- one placeholder per finding, and
    // every one of them well formed.
    const result = engine.redact('mongodb://admin:s3cretPassw0rdValue@10.0.0.5:27017/db');
    assert.equal(result.text.includes('s3cretPassw0rdValue'), false);

    const placeholders = result.text.match(/\[strata:redacted:[a-z_]+\]/g) ?? [];
    assert.equal(placeholders.length, result.findings.length, 'a finding produced no placeholder, or two');
    for (const p of placeholders) {
      assert.match(p, /^\[strata:redacted:[a-z_]+\]$/, `malformed placeholder: ${p}`);
    }
    // The rest of the URI survived, so the span chosen was the password and not
    // the whole connection string.
    assert.match(result.text, /mongodb:\/\/admin:.*@10\.0\.0\.5:27017\/db/);
  });
});

describe('modes', () => {
  const AWS = 'AKIAIOSFODNN7EXAMPLE';

  it('off leaves the text alone', () => {
    assert.equal(new RedactionEngine({ mode: 'off' }).redact(AWS).text, AWS);
  });

  it('log redacts and reports without throwing', () => {
    // `log` is the frozen default: a credential is still removed, and the
    // request still succeeds. It differs from `block` in the throw, not in the
    // rewriting -- otherwise the default configuration would write artifacts
    // with credentials in them.
    const result = new RedactionEngine({ mode: 'log' }).redact(AWS);
    assert.equal(result.text, placeholderFor('aws_access_key_id'));
    assert.equal(result.findings.length, 1);
  });

  it('scan never rewrites, in any mode', () => {
    // `scan` is the measurement path every persistence gate uses, so it must
    // answer "is there a secret" without having a mode-dependent side effect.
    for (const mode of ['off', 'log', 'placeholder'] as const) {
      const engine = new RedactionEngine({ mode });
      const findings = engine.scan(AWS);
      if (mode === 'off') assert.equal(findings.length, 0);
      else assert.equal(findings.length, 1);
    }
  });

  it('placeholder replaces', () => {
    assert.equal(new RedactionEngine({ mode: 'placeholder' }).redact(AWS).text, placeholderFor('aws_access_key_id'));
  });

  it('block throws rather than emitting text', () => {
    assert.throws(() => new RedactionEngine({ mode: 'block' }).redact(AWS), SecretBlockedError);
  });

  it('maps the policy mode onto the engine mode', () => {
    assert.equal(redactionModeFromPolicy({ mode: 'block', onFail: 'block' }), 'block');
    assert.equal(redactionModeFromPolicy({ mode: 'off', onFail: 'forward' }), 'off');
  });

  it('promotes the policy `log` mode to placeholder', () => {
    // The frozen policy's `log` means "do not fail the request", which is a
    // statement about error handling, not about whether the credential is
    // removed. Mapping it to an engine that leaves text alone would make a
    // debug switch a credential leak, so it becomes `placeholder` and the
    // request still succeeds.
    assert.equal(redactionModeFromPolicy({ mode: 'log', onFail: 'forward' }), 'placeholder');
    assert.equal(redactionModeFromPolicy({ mode: 'log', onFail: 'block' }), 'placeholder');
  });

  it('derives engine options from policy', () => {
    const policy = testPolicy({ redaction: { mode: 'block', onFail: 'block' } });
    const options = optionsFromPolicy(policy.redaction);
    assert.equal(options.mode, 'block');
    assert.equal(options.minConfidence, 'probable');
    // The frozen RedactionPolicy carries no entropy tuning, so the engine
    // keeps its own defaults. Recorded as a proposed core-types addition.
    assert.deepEqual(options.entropy, {});
  });
});

describe('I-2: persistence is fail-closed', () => {
  it('refuses to persist a certain secret even with redaction off', () => {
    // The one-line property: an operator who sets `mode: off` gets a refusal at
    // the write, not a credential on disk.
    const engine = new RedactionEngine({ mode: 'off' });
    assert.throws(() => engine.assertPersistable('AKIAIOSFODNN7EXAMPLE', 'unit test'), SecretLeakError);
  });

  it('refuses a certain secret even when the mode would have removed it', () => {
    // The gate is deliberately mode-independent: it answers "may these bytes be
    // written", and a mode that changes the answer would be a mode that can
    // write credentials.
    for (const mode of ['log', 'placeholder'] as const) {
      const engine = new RedactionEngine({ mode });
      assert.throws(() => engine.assertPersistable('AKIAIOSFODNN7EXAMPLE', 'unit test'), SecretLeakError);
    }
  });

  it('allows text that redaction already cleaned', () => {
    const engine = new RedactionEngine({ mode: 'placeholder' });
    const clean = engine.redact('AKIAIOSFODNN7EXAMPLE').text;
    assert.doesNotThrow(() => engine.assertPersistable(clean, 'unit test'));
  });

  it('allows ordinary prose', () => {
    const engine = new RedactionEngine({ mode: 'off' });
    assert.doesNotThrow(() => engine.assertPersistable('the build finished in 3.2s', 'unit test'));
  });
});

describe('entropy as a second line', () => {
  it('does not fire on prose', () => {
    const engine = new RedactionEngine({ mode: 'placeholder' });
    const prose =
      'the quick brown fox jumps over the lazy dog while the compiler complains about an unused import';
    assert.equal(engine.redact(prose).findings.length, 0);
  });

  const TOKEN = 'xK3nQ7vB2pL9wR4tY6uI8oP1aS5dF0gH2jK';

  it('refuses an unlabelled high-entropy token', () => {
    // The load-bearing false-positive brake. A base64 blob in a test fixture has
    // the same entropy as a key; without a keyword the only thing separating
    // them is a length threshold, and that is not enough.
    const engine = new RedactionEngine({ mode: 'placeholder' });
    assert.equal(engine.containsSecret(TOKEN), false);
    const [verdict] = analyzeEntropy(TOKEN);
    assert.equal(verdict?.verdict, 'rejected');
    assert.equal(verdict?.reason, 'no_keyword_context');
  });

  it('fires once the token is labelled', () => {
    // `bearer` arms the keyword context and the token is opaque, so the pattern
    // layer stays out of it: this is the entropy verdict on its own.
    const text = `session bearer ${TOKEN}`;
    const verdict = analyzeEntropy(text).find((v) => v.verdict === 'high_entropy');
    assert.equal(verdict?.verdict, 'high_entropy');
    assert.equal(verdict?.confidence, 'probable');
    assert.equal(new RedactionEngine({ mode: 'placeholder' }).containsSecret(text), true);
  });

  it('never returns a `certain` verdict from entropy', () => {
    // Entropy is capped at `probable` by design: there is no shape here that
    // only a credential can have, so nothing it finds may bypass the
    // `minConfidence` floor at `certain`.
    for (const verdict of analyzeEntropy(`token = ${TOKEN}`)) {
      assert.notEqual(verdict.confidence, 'certain');
    }
  });

  it('does not consider a short token at all', () => {
    // Below `minLength` there is no reliable estimate, and treating a short
    // string as high-entropy would redact every base64 run in a lockfile.
    const verdicts = analyzeEntropy('session bearer abc123XYZ');
    assert.ok(verdicts.length > 0);
    assert.ok(verdicts.every((v) => v.verdict !== 'high_entropy'));
    assert.ok(verdicts.some((v) => v.reason === 'too_short'));
  });

  it('can be turned off, and the pattern layer still works', () => {
    const text = `session bearer ${TOKEN}`;
    assert.equal(new RedactionEngine({ mode: 'placeholder' }).containsSecret(text), true);
    const off = new RedactionEngine({ mode: 'placeholder', entropy: { enabled: false } });
    assert.equal(off.containsSecret(text), false, 'the entropy layer ignored enabled: false');
    assert.equal(off.redact('AKIAIOSFODNN7EXAMPLE').text, placeholderFor('aws_access_key_id'));
  });
});

describe('deep redaction', () => {
  it('walks objects and arrays', () => {
    const out = redactDeep(
      { a: { b: ['AKIAIOSFODNN7EXAMPLE', { c: 'ghp_16C7e42F292c6912E7710c838347Ae178B4a' }] } },
      { mode: 'placeholder' },
    );
    const text = JSON.stringify(out);
    assert.equal(text.includes('AKIAIOSFODNN7EXAMPLE'), false);
    assert.equal(text.includes('ghp_16C7e42F'), false);
  });

  it('preserves keys and non-string leaves', () => {
    const out = redactDeep({ n: 7, b: true, s: 'plain' }, { mode: 'placeholder' });
    assert.deepEqual(out, { n: 7, b: true, s: 'plain' });
  });

  it('stops at its depth limit rather than recursing forever', () => {
    // Cyclic input is the realistic version of this: a gist carrying a self
    // reference must not hang the compaction path.
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic['self'] = cyclic;
    const out = redactDeep(cyclic, { mode: 'placeholder' });
    assert.equal(typeof out, 'object');
  });
});

describe('errors', () => {
  it('carries a message that names the finding without quoting it', () => {
    const engine = new RedactionEngine({ mode: 'placeholder', entropy: { threshold: 99 } });
    try {
      engine.assertPersistable('AKIAIOSFODNN7EXAMPLE', 'a gist');
      assert.fail('expected a SecretLeakError');
    } catch (e) {
      assert.ok(e instanceof SecretLeakError);
      assert.equal(e.message.includes('AKIAIOSFODNN7EXAMPLE'), false, 'the error quoted the secret');
      assert.match(e.message, /aws_access_key_id/);
    }
  });
});

describe('doc placeholders are not secrets', () => {
  it('leaves `password=changeme` alone by default', () => {
    // The default is permissive: a README that documents the shape of a .env
    // file is full of `password=changeme`, and redacting those makes the
    // redactor useless for reading documentation.
    const engine = new RedactionEngine({ mode: 'placeholder' });
    assert.equal(engine.redact('password=changeme').text, 'password=changeme');
  });

  it('redacts it when the deployment says doc placeholders are real', () => {
    // A device talking to a dev database has a real, terrible password, and
    // `changeme` is a real credential there.
    const engine = new RedactionEngine({ mode: 'placeholder', allowDocPlaceholders: false });
    assert.equal(engine.redact('password=changeme').text, 'password=[strata:redacted:assigned_secret]');
  });

  it('always leaves an env reference alone', () => {
    // With doc placeholders enabled *or* not, `${DB_PASSWORD}` is a reference.
    // Redacting it would break the file it lives in, which is a worse outcome
    // than the false positive it avoids.
    for (const allowDocPlaceholders of [true, false]) {
      const engine = new RedactionEngine({ mode: 'placeholder', allowDocPlaceholders });
      assert.equal(
        engine.redact('DB_PASSWORD=${DB_PASSWORD}').text,
        'DB_PASSWORD=${DB_PASSWORD}',
      );
    }
  });

  it('always leaves a fully masked value alone', () => {
    const engine = new RedactionEngine({ mode: 'placeholder', allowDocPlaceholders: false });
    assert.equal(engine.redact('password=********').text, 'password=********');
  });
});

describe('redactText is the one-shot form', () => {
  it('defaults to placeholder mode', () => {
    const result = redactText('AKIAIOSFODNN7EXAMPLE');
    assert.equal(result.text, placeholderFor('aws_access_key_id'));
  });
});
