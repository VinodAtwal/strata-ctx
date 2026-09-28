import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MIN_SCANNABLE_SECRET_LENGTH,
  REDACTED,
  isSensitiveBodyKey,
  isSensitiveHeader,
  redactBody,
  redactHeaders,
  scannableSecrets,
  type JsonValue,
} from '../src/index.js';

import { TEST_API_KEY, TEST_BEARER, TEST_BODY_SECRET, TEST_SESSION_COOKIE } from './fixtures.js';

/**
 * Redaction is tested here rather than only through the recorder because the
 * recall/precision tradeoff has to be pinned in both directions. G9 asks for
 * 100% recall on the secret corpus; docs/evaluation.md §E6 also asks for the
 * false-positive rate to be *reported*, because a redactor that eats 20% of
 * ordinary output is unusable even at 100% recall.
 *
 * The false-positive half of that is mostly about `usage.input_tokens`: a
 * substring rule for "token" would rewrite the number every cost figure in E5
 * and every gate that reads cost (G6, G7) is derived from.
 */

describe('redaction: header names', () => {
  it('catches the credential headers, in any spelling', () => {
    for (const name of [
      'authorization',
      'Authorization',
      'AUTHORIZATION',
      'x-api-key',
      'X-Api-Key',
      'x_api_key',
      'cookie',
      'Cookie',
      'set-cookie',
      'x-auth-token',
      'proxy-authorization',
      'openai-api-key',
    ]) {
      assert.equal(isSensitiveHeader(name), true, `${name} should be sensitive`);
    }
  });

  it('leaves the rate-limit headers alone', () => {
    // The reason the allowlist exists at all: `anthropic-ratelimit-tokens-limit`
    // contains "token" and is a number the cost harness needs. Over-redacting
    // costs measurements, which is the worse of the two failure modes.
    for (const name of [
      'anthropic-ratelimit-tokens-limit',
      'anthropic-ratelimit-requests-remaining',
      'openai-ratelimit-tokens',
      'ratelimit-remaining',
      'x-ratelimit-reset',
    ]) {
      assert.equal(isSensitiveHeader(name), false, `${name} must survive`);
    }
  });

  it('leaves ordinary transport headers alone', () => {
    for (const name of [
      'content-type',
      'content-length',
      'accept',
      'user-agent',
      'anthropic-version',
      'x-strata-session',
      'x-strata-pinned',
    ]) {
      assert.equal(isSensitiveHeader(name), false, `${name} must survive`);
    }
  });
});

describe('redaction: body keys', () => {
  it('catches the credential field names in any spelling', () => {
    for (const key of [
      'api_key',
      'apiKey',
      'API-KEY',
      'openai_api_key',
      'token',
      'access_token',
      'refreshToken',
      'secret',
      'client_secret',
      'private_key',
      'password',
      'passphrase',
      'authorization',
      'session_token',
      'x-csrf-token',
    ]) {
      assert.equal(isSensitiveBodyKey(key), true, `${key} should be sensitive`);
    }
  });

  it('leaves the token-count fields a cost harness depends on', () => {
    // The regression this anchoring exists for. `usage.input_tokens` is matched
    // by substring by every naive redactor, and losing it silently zeroes out
    // E5 and gates G6 and G7.
    for (const key of [
      'input_tokens',
      'output_tokens',
      'max_tokens',
      'cache_creation_input_tokens',
      'token_count',
      'tokens',
      'total_tokens',
    ]) {
      assert.equal(isSensitiveBodyKey(key), false, `${key} must survive`);
    }
  });

  it('leaves ordinary request fields alone', () => {
    for (const key of ['model', 'max_tokens', 'stream', 'messages', 'system', 'stop_sequences', 'metadata']) {
      assert.equal(isSensitiveBodyKey(key), false, `${key} must survive`);
    }
  });
});

describe('redaction: headers in a map', () => {
  it('replaces the value and records the name', () => {
    const result = redactHeaders({
      authorization: TEST_BEARER,
      'content-type': 'application/json',
      'x-api-key': TEST_API_KEY,
      cookie: TEST_SESSION_COOKIE,
    });

    assert.equal(result.value['authorization'], REDACTED);
    assert.equal(result.value['x-api-key'], REDACTED);
    assert.equal(result.value['cookie'], REDACTED);
    assert.equal(result.value['content-type'], 'application/json');
    assert.deepEqual([...result.hits].sort(), ['authorization', 'cookie', 'x-api-key']);
    assert.deepEqual([...result.secrets].sort(), [TEST_API_KEY, TEST_BEARER, TEST_SESSION_COOKIE].sort());
  });

  it('emits keys in sorted order so a fixture does not churn between records', () => {
    // Header arrival order is a property of the socket, not of the request. A
    // fixture that reorders on every record is one nobody can review in a diff.
    const a = redactHeaders({ 'x-b': '1', 'x-a': '2', 'x-c': '3' });
    const b = redactHeaders({ 'x-c': '3', 'x-a': '2', 'x-b': '1' });
    assert.deepEqual(Object.keys(a.value), ['x-a', 'x-b', 'x-c']);
    assert.deepEqual(a.value, b.value);
  });

  it('handles an empty map', () => {
    const result = redactHeaders({});
    assert.deepEqual(result.value, {});
    assert.deepEqual(result.hits, []);
    assert.deepEqual(result.secrets, []);
  });
});

describe('redaction: bodies', () => {
  it('rewrites a credential field and keeps the rest of the request intact', () => {
    const body: JsonValue = {
      model: 'claude-sonnet-4',
      max_tokens: 1024,
      api_key: TEST_BODY_SECRET,
      messages: [{ role: 'user', content: 'hello' }],
    };

    const result = redactBody(body);

    assert.equal((result.value as Record<string, JsonValue>)['api_key'], REDACTED);
    assert.equal((result.value as Record<string, JsonValue>)['model'], 'claude-sonnet-4');
    assert.equal((result.value as Record<string, JsonValue>)['max_tokens'], 1024);
    assert.deepEqual(result.hits, ['api_key']);
    assert.deepEqual(result.secrets, [TEST_BODY_SECRET]);
    assert.ok(!JSON.stringify(result.value).includes(TEST_BODY_SECRET));
  });

  it('walks into nested objects and arrays, and reports the path', () => {
    const body: JsonValue = {
      outer: {
        inner: { api_key: TEST_BODY_SECRET, keep: 'yes' },
        list: [{ token: TEST_BEARER }, { safe: 1 }],
      },
    };

    const result = redactBody(body);
    const text = JSON.stringify(result.value);

    assert.ok(!text.includes(TEST_BODY_SECRET), 'nested secret removed');
    assert.ok(!text.includes(TEST_BEARER), 'array element secret removed');
    assert.ok(text.includes('"keep":"yes"'), 'the sibling survived');
    assert.ok(text.includes('"safe":1'), 'the clean array element survived');
    assert.deepEqual([...result.hits].sort(), ['outer.inner.api_key', 'outer.list[0].token']);
  });

  it('leaves a body with no credentials completely untouched, key order included', () => {
    // Reordering every body on every record would churn every fixture diff, so
    // an unredacted body must come back structurally identical.
    const body: JsonValue = { zeta: 1, alpha: { y: 2, x: 3 }, list: [1, 'two', false, null] };
    const result = redactBody(body);
    assert.deepEqual(result.value, body);
    assert.deepEqual(result.hits, []);
    assert.deepEqual(result.secrets, []);
  });

  it('passes non-object bodies through', () => {
    for (const body of [null, 42, 'text', true, [1, 2, 3]] as const) {
      const result = redactBody(body);
      assert.deepEqual(result.value, body as JsonValue);
      assert.deepEqual(result.hits, []);
    }
  });

  it('redacts a credential nested under an array of tools', () => {
    const body: JsonValue = { tools: [{ name: 'search' }, { name: 'send', config: { api_key: TEST_BODY_SECRET } }] };
    const result = redactBody(body);
    assert.deepEqual(result.hits, ['tools[1].config.api_key']);
    assert.ok(!JSON.stringify(result.value).includes(TEST_BODY_SECRET));
  });

  it('captures a non-string secret so the post-write scan can still find it', () => {
    // An object-valued credential cannot be written as `[REDACTED]`'s source
    // string, but it must still be remembered, or the scan has nothing to look
    // for and the leak ships.
    const body: JsonValue = { credentials: { user: 'admin', pass: TEST_BODY_SECRET } };
    const result = redactBody(body);
    assert.deepEqual(result.hits, ['credentials']);
    assert.equal(result.secrets.length, 1);
    assert.ok(result.secrets[0]?.includes('admin'));
  });
});

describe('redaction: the post-write scan', () => {
  it('only considers values long enough to prove absence of', () => {
    // A three-character value would collide with ordinary text and make every
    // recording fail. Three characters is not a credential; the field-name
    // rules are what protect short secrets, and this constant limits only what
    // can be *proved* clean afterwards.
    assert.equal(MIN_SCANNABLE_SECRET_LENGTH, 8);
    assert.deepEqual(scannableSecrets(['abc', 'abcdefg']), [], 'too short to prove absence of');
    assert.deepEqual(scannableSecrets(['abcdefgh', 'abcdefghi']), ['abcdefgh', 'abcdefghi']);
    assert.deepEqual(scannableSecrets([TEST_API_KEY, TEST_API_KEY]), [TEST_API_KEY], 'deduplicated');
    assert.deepEqual(scannableSecrets([]), []);
  });
});
