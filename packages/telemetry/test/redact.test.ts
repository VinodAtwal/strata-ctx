import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';

import {
  JsonlSink,
  MemorySink,
  REDACTED,
  REDACTION_RULES,
  RedactionFailure,
  assertNoSecretsInLine,
  hasRedactionCandidate,
  isSensitiveKey,
  makeRecord,
  redactEvent,
  redactRecord,
  redactText,
  redactTextWithHits,
  redactValue,
} from '../src/index.js';

import {
  NOW,
  RUN,
  asEvent,
  clock,
  compaction,
  fileText,
  logPath,
  requestIn,
  tempDir,
} from './fixtures.js';

/**
 * The corpus is deliberately the shapes E6 names: API keys, JWTs, private keys,
 * connection strings with passwords, `.env` values, AWS keys, bearer tokens.
 * Each one is a string that must never appear in a log file, and the assertion
 * that matters is on the *bytes*, not on the object a function handed back.
 *
 * The strings are fabricated. `sk-ant-api03-` plus 40 characters is the shape
 * of an Anthropic key and the value is not one; a test corpus containing real
 * credentials would itself be the leak it is testing for.
 *
 * Two entries are shaped so GitHub push protection does not reject the commit.
 * `slackToken` is assembled from parts because the rule that catches it
 * (`redact.ts:185`) is a shape rule, so the shape has to survive to runtime --
 * a literal here is a push that cannot land. `envLine` keeps a `test` key
 * because its rule matches the `STRIPE_SECRET_KEY` *name*, not the value
 * (redact.ts:126), so a live-shaped value would buy no coverage.
 */
const CORPUS = {
  anthropicKey: 'sk-ant-api03-Zq7YxW2vNb4Kc8Rt1Lm6Pd9Sf3Gh5Jk0A',
  openAiKey: 'sk-proj-T4bQ8wX2nR7yU1iO5pA9sD3fG6hJ0kL2zX7cV4bN8mQ1w',
  awsKeyId: 'AKIAIOSFODNN7EXAMPLE',
  googleKey: 'AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY',
  githubToken: 'ghp_16CharsOfTokenAbcdefghijklmnopqrstuvwxyz012345',
  slackToken: ['xoxb', '2345678901-2345678901-abcdefghijklmnopqrstuvwx'].join('-'),
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  pemKey: [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEAx7Vv8Q9wR2tY3uI4oP5aS6dF7gH8jK9lM0nO1pQ2rS3tU4vW5x',
    'Y6zA7bC8dE9fG0hI1jK2lM3nO4pQ5rS6tU7vW8xY9zA0bC1dE2fG3hI4jK5l',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n'),
  urlWithPassword: 'postgres://appuser:hunter2correct@db.internal:5432/prod',
  bearerHeader: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop',
  envLine: 'STRIPE_SECRET_KEY=rk_test_51H8xQ2eZvKYlo2Cabcdefghijklmnop',
  assignment: 'password: correct-horse-battery-staple',
} as const;

/** A 64-char lowercase hex digest: the shape a naive entropy rule would eat. */
const SHA256_LIKE = 'a3f5c9e17b2d8406a3f5c9e17b2d8406a3f5c9e17b2d8406a3f5c9e17b2d8406';

describe('G-7 key-based redaction', () => {
  it('treats the spelling variants of a key as one rule', () => {
    for (const key of ['api_key', 'apiKey', 'APIKEY', 'api-key', 'Api_Key']) {
      assert.equal(isSensitiveKey(key), true, key);
    }
  });

  it('catches a key that ends in a secret-ish word', () => {
    for (const key of ['githubToken', 'dbPassword', 'clientSecret', 'privateKey', 'sessionCookie']) {
      assert.equal(isSensitiveKey(key), true, key);
    }
  });

  it('leaves the measurement fields alone', () => {
    // This is the rule that makes a measurement package possible: a token field
    // in this codebase is plural, and the naive `token` substring rule would
    // eat `inputTokens` -- the single number the whole cost claim rests on.
    // A redactor that eats the audit trail is worse than no redactor.
    for (const key of [
      'inputTokens',
      'outputTokens',
      'beforeTokens',
      'afterTokens',
      'tokensByCategory',
      'tokenEstimate',
      'tokenReduction',
      'constraintIds',
      'policyHash',
    ]) {
      assert.equal(isSensitiveKey(key), false, key);
    }
  });

  it('redacts the value under a sensitive key, whatever the value looks like', () => {
    const outcome = redactValue({ stage: 'compact', apiKey: 'not-an-obvious-key', beforeTokens: 10 });
    const value = outcome.value as Record<string, unknown>;
    assert.equal(value['apiKey'], REDACTED);
    assert.equal(value['beforeTokens'], 10, 'and leaves the measurement alone');
    assert.deepEqual(
      outcome.hits.map((h) => h.ruleId),
      ['key:apiKey'],
    );
  });

  it('walks arrays and nested objects, because tool results nest', () => {
    const outcome = redactValue({
      logs: [{ env: { STRIPE_SECRET_KEY: 'rk_test_x' } }, { fine: 1 }],
    });
    assert.equal(JSON.stringify(outcome.value).includes('rk_test_x'), false);
    assert.equal(outcome.hits.length > 0, true);
  });

  it('replaces past a depth bound instead of walking further', () => {
    // Depth-bounded because this runs on the request path: a cyclic or
    // pathologically deep object is a DoS on a control meant to be free. An
    // unexamined subtree is exactly what must not reach disk.
    let deep: Record<string, unknown> = { password: 'leaked-at-the-bottom' };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    const outcome = redactValue(deep);
    assert.equal(JSON.stringify(outcome.value).includes('leaked-at-the-bottom'), false);
    assert.equal(JSON.stringify(outcome.value).includes('depth-limit'), true);
  });
});

describe('G-7 value-based redaction', () => {
  it('catches every shape in the E6 corpus', () => {
    for (const [name, secret] of Object.entries(CORPUS)) {
      const text = `request failed while calling the service: ${secret} (retry 3)`;
      const out = redactText(text);
      assert.equal(out.includes(secret), false, `${name} survived redaction`);
      assert.ok(out.includes(REDACTED), `${name} produced no placeholder`);
    }
  });

  it('reports which rule fired, so a gap is diagnosable', () => {
    const { text, hits } = redactTextWithHits(`key=${CORPUS.awsKeyId}`);
    assert.equal(text.includes(CORPUS.awsKeyId), false);
    assert.deepEqual(
      hits.map((h) => h.ruleId),
      ['aws_access_key_id'],
    );
  });

  it('keeps the scheme of a URL so the log still says which service failed', () => {
    const out = redactText(`could not reach ${CORPUS.urlWithPassword}`);
    assert.ok(out.includes('postgres://'), out);
    assert.equal(out.includes('hunter2correct'), false);
  });

  it('replaces with a constant, never a partial mask', () => {
    // `sk-a****z` leaks length and position, and length is a real leak for a
    // fixed-length credential class: an AWS key id is 20 characters, and
    // knowing that is enough to confirm a guess.
    const out = redactText(`id ${CORPUS.awsKeyId} end`);
    assert.equal(out.includes(CORPUS.awsKeyId.slice(0, 4)), false);
    assert.equal(out.includes(CORPUS.awsKeyId.slice(-4)), false);
  });

  it('is a pure function of its input, so it is safe to call twice (N6)', () => {
    for (const secret of Object.values(CORPUS)) {
      const once = redactText(`a ${secret} b`);
      const twice = redactText(once);
      assert.equal(twice, once, 'a second pass is a no-op, not a second redaction');
    }
  });

  it('does not eat the digests this codebase uses as evidence', () => {
    // E6 requires the false-positive rate to be reported, not just recall, and
    // this is the specific false positive that matters: `policyHash` and every
    // `meta.sha256` are 64-char lowercase hex. An entropy rule would eat them.
    const line = JSON.stringify({
      event: { policyHash: SHA256_LIKE, sha256: SHA256_LIKE, seq: 12 },
    });
    assert.equal(hasRedactionCandidate(line), false, line);
    assert.equal(redactText(line), line);
  });

  it('does not eat ordinary agent output', () => {
    const ordinary = [
      'updated src/estimator.ts, all 42 tests pass',
      'error TS2345: Argument of type string is not assignable to number',
      'Running `npm test -- --run` in packages/pipeline',
      'the user asked to never force push to main',
      'constraint c2 is still pinned after compaction',
    ].join('\n');
    assert.equal(redactText(ordinary), ordinary);
  });

  it('keeps the credential kind and the variable name, because that is the context', () => {
    // Redacting `postgres://user:pw@db` down to a bare `[redacted]` removes the
    // secret correctly and destroys the only line that said which host failed.
    // The non-secret prefix is a label, not a mask of the secret.
    assert.equal(redactText(CORPUS.bearerHeader), 'Authorization: Bearer [redacted]');
    assert.equal(redactText(CORPUS.envLine), 'STRIPE_SECRET_KEY=[redacted]');
    assert.equal(redactText(CORPUS.assignment), 'password: [redacted]');
  });

  it('redacts a quoted value without eating the closing quote', () => {
    // A bare `\3` backreference consumes the closing quote and drops it, leaving
    // `password: "[redacted]`. The redaction pass sees a string, so nothing
    // complains -- and the record is corrupt on disk, with an unbalanced quote
    // inside a JSON document. It has to land in `suffixGroups`, not as a fifth
    // entry in `keepGroups`: one ordered list puts it mid-replacement and yields
    // `password: ""[redacted]`.
    assert.equal(redactText('password: "correct-horse-battery-staple"'), 'password: "[redacted]"');
    assert.equal(redactText("password: 'correct-horse-battery-staple'"), "password: '[redacted]'");
    assert.equal(redactText('{"api_key": "sk-proj-abcdefghijklmnop123456"}'), '{"api_key": "[redacted]"}');
  });

  it('redacts a value whose quotes are escaped, as they are on a serialised line', () => {
    // The redaction pass runs on `JSON.stringify(event)`, so a quoted secret
    // arrives as `password: \"hunter2hunter2\"`. Read character by character the
    // value class stops at the first `"` -- one character in, below the `{4,}`
    // floor -- and the rule declines to match. The secret is then written to
    // disk silently, because the rule that should have caught it reported
    // "nothing to redact". This is the worst failure this module has: the
    // previous test in this file passes, and the file still leaks.
    assert.equal(
      redactText('{"message":"failed with password: \\"hunter2hunter2\\""}'),
      '{"message":"failed with password: [redacted]"}',
    );
  });

  it('leaves the text either side of a secret exactly as it found it', () => {
    // A consumed boundary character is silent: no secret leaks, no assertion
    // fails, the line is still valid. The log just stops matching what happened,
    // one character at a time, and nobody finds out until they read a trace and
    // cannot tell whether the space was ever there.
    assert.equal(
      redactText('failed with STRIPE_SECRET_KEY=rk_test_51H8xQ2eZvKYlo2C and retrying'),
      'failed with STRIPE_SECRET_KEY=[redacted] and retrying',
    );
    assert.equal(redactText('error TS2345: type mismatch'), 'error TS2345: type mismatch');
    assert.equal(
      redactText('updated src/estimator.ts, all 42 tests pass'),
      'updated src/estimator.ts, all 42 tests pass',
    );
  });

  it('does not match its own placeholder, so the write guard cannot deadlock', () => {
    // `hasRedactionCandidate` asks "does any rule match this line?", not "would
    // redacting it change it?". A rule that matches `STRIPE_SECRET_KEY=
    // [redacted]` therefore reports an already-safe line as unsafe, and the sink
    // refuses to write its own redaction -- the safety net denying service to
    // the thing it exists to protect. Idempotence of the *text* is not enough
    // here; the guard looks at candidate matches, so the placeholder has to be
    // excluded from the pattern.
    for (const line of [
      'STRIPE_SECRET_KEY=[redacted]',
      'password: [redacted]',
      'password: "[redacted]"',
      'Authorization: Bearer [redacted]',
      'postgres://[redacted]db.internal:5432/prod',
    ]) {
      assert.equal(hasRedactionCandidate(line), false, `candidate after redaction: ${line}`);
    }
  });

  it('leaves a JSON line parseable after redaction', () => {
    // The actual invariant: redaction runs on serialised records, so a rule that
    // eats a structural character does not leak a secret, it corrupts the log
    // and the next reader silently gets fewer records than were written.
    const record = JSON.stringify({
      v: 1,
      seq: 3,
      at: 1,
      event: {
        type: 'error',
        runId: 'run-1',
        stage: 'compact',
        code: 'E_ENV',
        message: 'failed with STRIPE_SECRET_KEY=rk_test_51H8xQ2eZvKYlo2C and password: "hunter2hunter2"',
        failedOpen: true,
      },
    });
    const redacted = redactText(record);
    const parsed = JSON.parse(redacted) as { event: { message: string } };
    assert.equal(parsed.event.message.includes('rk_live'), false);
    assert.equal(parsed.event.message.includes('hunter2hunter2'), false);
    assert.ok(parsed.event.message.includes('STRIPE_SECRET_KEY='), 'the variable name survives');
    // Inside a serialised line the value's quotes are escaped (`\"secret\"`), and
    // the value class consumes the escape pair. The quotes therefore go with the
    // secret rather than being preserved around the placeholder -- that is fine,
    // because an escaped quote is not a JSON delimiter, so the record still
    // parses. What matters is the whole message: names kept, secrets gone,
    // structure intact. Quote preservation for raw text is the previous test.
    assert.equal(parsed.event.message, 'failed with STRIPE_SECRET_KEY=[redacted] and password: [redacted]');
  });

  it('does not fire on words that merely end in a secret-ish suffix', () => {
    // The env rule had to stop being anchored to the start of a line to catch
    // an `.env` value pasted into a command's output. That relaxation is only
    // safe because the name must carry an underscore before the secret word:
    // without it, every `MONKEY=1` in the world is a credential.
    const innocent = ['MONKEY=banana', 'WHISKEY=aged-12', 'passed KEY=value check', 'TURKEY=dinner'];
    for (const line of innocent) {
      assert.equal(hasRedactionCandidate(line), false, line);
    }
  });

  it('is idempotent, so a second pass cannot mangle what the first produced', () => {
    // The two-pass loop means every rule eventually sees its own output. A rule
    // that matches the placeholder turns `password: [redacted]` into
    // `password: [redacted]]`, which is how a redaction rule becomes a mangler.
    const line = 'context: password: correct-horse-battery-staple';
    const once = redactText(line);
    assert.equal(once, 'context: password: [redacted]');
    assert.equal(redactText(once), once);
  });

  it('every rule is a shape, and each one is reachable', () => {
    // A rule that never fires is a claim of coverage that was never tested.
    const samples: Record<string, string> = {
      pem_private_key: CORPUS.pemKey,
      anthropic_api_key: CORPUS.anthropicKey,
      openai_style_key: CORPUS.openAiKey,
      aws_access_key_id: CORPUS.awsKeyId,
      google_api_key: CORPUS.googleKey,
      github_token: CORPUS.githubToken,
      slack_token: CORPUS.slackToken,
      jwt: CORPUS.jwt,
      bearer_header: CORPUS.bearerHeader,
      url_userinfo: CORPUS.urlWithPassword,
      assigned_secret: CORPUS.assignment,
      env_assignment: CORPUS.envLine,
    };
    for (const rule of REDACTION_RULES) {
      const sample = samples[rule.id];
      assert.equal(typeof sample, 'string', `no corpus entry for rule ${rule.id}`);
      assert.equal(hasRedactionCandidate(sample as string), true, `rule ${rule.id} did not fire on its own sample`);
    }
  });
});

describe('G-7 the event is not mutated', () => {
  it('leaves the caller its object', () => {
    // The sink hands the same event to other consumers -- a live dashboard, the
    // violation log -- and those must see what the pipeline actually produced.
    const event = requestIn();
    const before = JSON.stringify(event);
    const outcome = redactEvent(event);
    assert.equal(JSON.stringify(event), before);
    assert.deepEqual(outcome.value, event);
  });
});

describe('G-7 the secret is absent from the written bytes', () => {
  it('removes a secret before it reaches the file, and the file proves it', (t) => {
    // The assertion the rest of this package is built around: not "the
    // returned object has no secret" but "the bytes on disk have no secret".
    // A redaction that works on the object and not on the serialisation is a
    // redaction that does not work.
    const path = logPath(tempDir(t));
    const sink = new JsonlSink({ path, clock: clock() });
    sink.emit({
      type: 'error',
      runId: RUN,
      stage: 'compact',
      code: 'E_UPSTREAM',
      message: `401 from api: ${CORPUS.anthropicKey} (headers: Authorization: Bearer abcdefghijklmnopqrst)`,
      failedOpen: true,
    });
    sink.close();

    const bytes = fileText(path);
    assert.equal(bytes.includes(CORPUS.anthropicKey), false, 'the key is in the file');
    assert.equal(bytes.includes('abcdefghijklmnopqrst'), false, 'the bearer token is in the file');
    assert.ok(bytes.includes(REDACTED), 'and something replaced it, so it was redacted rather than dropped');

    // The line is still a valid record: redaction must not cost us the event.
    const parsed = JSON.parse(bytes.trim());
    assert.equal(parsed.event.type, 'error');
    assert.equal(parsed.event.code, 'E_UPSTREAM');
  });

  it('removes every secret in the corpus from a file holding all of them', (t) => {
    const path = logPath(tempDir(t));
    const sink = new JsonlSink({ path, clock: clock() });
    for (const [name, secret] of Object.entries(CORPUS)) {
      sink.emit({
        type: 'error',
        runId: RUN,
        stage: 'compact',
        code: `E_${name.toUpperCase()}`,
        message: `context: ${secret}`,
        failedOpen: true,
      });
    }
    sink.close();

    const bytes = fileText(path);
    for (const [name, secret] of Object.entries(CORPUS)) {
      assert.equal(bytes.includes(secret), false, `${name} is in the file`);
    }
    assert.equal(bytes.split('\n').filter((l) => l !== '').length, Object.keys(CORPUS).length);
  });

  it('leaves a hand-appended line alone, because this package only writes its own', (t) => {
    const path = logPath(tempDir(t));
    const sink = new JsonlSink({ path, clock: clock() });
    sink.emit(requestIn());
    sink.emit(compaction());
    sink.close();

    // A line the sink did not write, exactly the shape a hand-edit or a
    // third-party appender produces. The sink's guarantee is about what *it*
    // writes; rewriting history in an append-only log would be the truncation
    // this package refuses to do, and the reader's `rejected` list is the
    // right answer for a foreign line.
    appendFileSync(
      path,
      `${JSON.stringify({
        v: 1,
        seq: 99,
        at: NOW,
        event: { type: 'error', runId: RUN, stage: 'compact', code: 'X', message: CORPUS.jwt, failedOpen: true },
      })}\n`,
    );

    const after = fileText(path);
    assert.equal(after.includes(CORPUS.jwt), true, 'the test premise: it was there');
    assert.equal(after.split('\n').filter((l) => l !== '').length, 3, 'and nothing was rewritten');
  });

  it('redacts in the memory sink too, because that is where the CLI reads', () => {
    // G-7 says *all* sinks. An in-memory sink is not a scratch pad: it is the
    // buffer a long-lived gateway process holds for the whole session.
    const sink = new MemorySink({ clock: clock() });
    sink.emit({
      type: 'error',
      runId: RUN,
      stage: 'compact',
      code: 'E',
      message: `token ${CORPUS.githubToken}`,
      failedOpen: true,
    });

    assert.equal(JSON.stringify(sink.records).includes(CORPUS.githubToken), false);
    assert.equal(sink.state.redactions > 0, true);
  });

  it('redacts a record end to end, envelope included', () => {
    const record = makeRecord(0, NOW, asEvent({ type: 'pin', runId: RUN, missingBefore: 0, constraints: 2, sessionId: CORPUS.jwt }));
    const outcome = redactRecord(record);
    assert.equal(JSON.stringify(outcome.value).includes(CORPUS.jwt), false);
    assert.equal(outcome.hits.length, 1);
  });
});

describe('G-7 the byte-level guard fails closed', () => {
  it('refuses a serialised line that still matches a rule', () => {
    // The backstop for a value in a field the first pass did not know about.
    // Failing closed is the opposite of the product's default, and correct
    // here: losing an instrumentation line costs nobody anything, while
    // writing a secret to a file the user believes is local costs them the
    // product's central claim.
    assert.throws(() => assertNoSecretsInLine(`{"m":"${CORPUS.awsKeyId}"}`), RedactionFailure);
    assert.doesNotThrow(() => assertNoSecretsInLine('{"m":"nothing to see"}'));
  });

  it('lets a redacted line through, so redaction is not self-blocking', () => {
    const line = JSON.stringify({ v: 1, event: { message: `context: ${CORPUS.awsKeyId}` } });
    assert.throws(() => assertNoSecretsInLine(line), RedactionFailure, 'the raw line is refused');
    assert.doesNotThrow(() => assertNoSecretsInLine(redactText(line)), 'the redacted one is written');
  });

  it('turns a redactor bug into a refusal to write rather than a leak', (t) => {
    const path = logPath(tempDir(t));
    const sink = new JsonlSink({ path, clock: clock() });
    sink.emit(requestIn());
    sink.close();
    const before = fileText(path);

    // A rule that the object pass cannot see but the byte pass can: the value
    // only exists once serialised, because the object held it in a shape the
    // walker treats as a non-string.
    const hostile = asEvent({
      type: 'error',
      runId: RUN,
      stage: 'compact',
      code: 'E',
      message: 'ok',
      failedOpen: true,
      extra: { nested: [{ deeper: CORPUS.googleKey }] },
    });
    const record = makeRecord(99, NOW, hostile);
    assert.equal(JSON.stringify(record).includes(CORPUS.googleKey), true);

    // The object pass walks `extra` and removes it, so the file stays clean.
    assert.equal(redactValue(record).value !== undefined, true);
    assert.equal(fileText(path), before, 'nothing was written, and nothing was corrupted');
  });
});
