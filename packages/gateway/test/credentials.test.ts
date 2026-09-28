import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyCredentials,
  applyCredentialsStrict,
  authHeaderFor,
  describeCredential,
  isSensitiveHeader,
  KEYRING_SERVICE,
  KeyringAccessError,
  keyringAccount,
  MissingCredentialError,
  nullKeyring,
  PROVIDER_ENV_VAR,
  redactHeaders,
  redactSecret,
  resolveCredential,
  SENSITIVE_HEADERS,
  UnsupportedProviderError,
  type Credential,
  type KeyringAdapter,
  type ProviderId,
} from '../src/credentials.js';

/** The 36-char secret used throughout. It must never appear in any output. */
const SECRET = 'sk-ant-01REDACTEDME0123456789abcdefXYZ';
const OTHER_SECRET = 'sk-openai-zzzSECRETSECRETSECRETSECRET';

const cred = (provider: ProviderId, value = SECRET): Credential => ({
  provider,
  value,
  origin: 'option',
  envVar: PROVIDER_ENV_VAR[provider],
});

/** In-memory keyring. Records lookups so precedence can be asserted, not assumed. */
class MockKeyring implements KeyringAdapter {
  readonly lookups: [service: string, account: string][] = [];
  constructor(private readonly entries: Record<string, string> = {}) {}
  get(service: string, account: string): string | null {
    this.lookups.push([service, account]);
    return this.entries[account] ?? null;
  }
}

const throws = async (fn: () => Promise<unknown>): Promise<Error> => {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof Error, 'must throw an Error, not a string');
    return err;
  }
  assert.fail('expected a throw');
};

// --- redactHeaders: what gets redacted -------------------------------------

test('SENSITIVE_HEADERS covers the four canonical auth headers', () => {
  for (const name of ['authorization', 'x-api-key', 'proxy-authorization', 'cookie']) {
    assert.ok(SENSITIVE_HEADERS.includes(name), `${name} must be listed`);
  }
});

test('authorization is redacted to a marker, not a mask', () => {
  const out = redactHeaders({ authorization: `Bearer ${SECRET}` });
  assert.equal(out.authorization, `[redacted:len=${SECRET.length + 7}]`);
});

test('x-api-key, proxy-authorization and cookie are all redacted', () => {
  const out = redactHeaders({
    'x-api-key': SECRET,
    'proxy-authorization': `Basic ${SECRET}`,
    cookie: `session=${SECRET}`,
  });
  for (const v of Object.values(out)) assert.ok(v.startsWith('[redacted:len='));
  assert.ok(!JSON.stringify(out).includes(SECRET));
});

test('headers matching *token* are redacted even when not in the static list', () => {
  assert.ok(!SENSITIVE_HEADERS.includes('x-goog-iam-token'));
  const out = redactHeaders({ 'x-goog-iam-token': SECRET });
  assert.ok(out['x-goog-iam-token']?.startsWith('[redacted:len='));
});

test('headers matching *secret* and *api-key* variants are redacted', () => {
  const out = redactHeaders({
    'x-tenant-client-secret': SECRET,
    'x-goog-api-key': SECRET,
    'anthropic_api_key': SECRET,
  });
  for (const v of Object.values(out)) assert.ok(v.startsWith('[redacted:len='));
});

test('set-cookie is redacted', () => {
  const out = redactHeaders({ 'set-cookie': `a=b; token=${SECRET}` });
  assert.ok(out['set-cookie']?.startsWith('[redacted:len='));
});

test('a long bearer token is never partially masked', () => {
  // Partial masking is the failure mode this replaces: sk-a...XYZ with a known
  // length is enough to confirm a key against a leaked prefix list.
  const out = redactHeaders({ authorization: `Bearer ${SECRET}` }).authorization ?? '';
  assert.ok(!out.includes(SECRET.slice(0, 8)));
  assert.ok(!out.includes(SECRET.slice(-4)));
});

test('marker reports the true length, not the truncated one', () => {
  assert.equal(redactSecret('a'.repeat(97)), '[redacted:len=97]');
});

// --- redactHeaders: what is left alone -------------------------------------

test('content-type and accept survive untouched', () => {
  const out = redactHeaders({ 'content-type': 'application/json', accept: 'text/event-stream' });
  assert.deepEqual(out, { 'content-type': 'application/json', accept: 'text/event-stream' });
});

test('non-sensitive headers keep their exact values alongside a redacted one', () => {
  const out = redactHeaders({
    'content-type': 'application/json',
    authorization: `Bearer ${SECRET}`,
    'x-request-id': 'req_01H',
    'anthropic-version': '2023-06-01',
  });
  assert.equal(out['content-type'], 'application/json');
  assert.equal(out['x-request-id'], 'req_01H');
  assert.equal(out['anthropic-version'], '2023-06-01');
  assert.ok(out.authorization?.startsWith('[redacted:len='));
});

test('an empty header bag redacts to an empty header bag', () => {
  assert.deepEqual(redactHeaders({}), {});
});

test('isSensitiveHeader is the single decision point and agrees with redactHeaders', () => {
  for (const name of ['Authorization', 'X-API-Key', 'X-Goog-Iam-Token', 'Cookie', 'x-secret-thing']) {
    assert.ok(isSensitiveHeader(name), `${name} should be sensitive`);
  }
  for (const name of ['content-type', 'accept', 'x-request-id', 'x-strata-pinned']) {
    assert.ok(!isSensitiveHeader(name), `${name} should not be sensitive`);
  }
});

// --- redactHeaders: purity -------------------------------------------------

test('the input header bag is not mutated', () => {
  const input: Record<string, string> = { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' };
  const out = redactHeaders(input);
  assert.equal(input.authorization, `Bearer ${SECRET}`, 'input still holds the real value');
  assert.equal(out.authorization?.startsWith('[redacted:'), true);
  assert.notEqual(out, input);
});

test('redacting twice is stable and does not re-redact the marker', () => {
  const once = redactHeaders({ 'x-api-key': SECRET });
  assert.deepEqual(redactHeaders(once), once);
});

// --- applyCredentials -------------------------------------------------------

test('anthropic gets a bare x-api-key', () => {
  const out = applyCredentials({ 'content-type': 'application/json' }, cred('anthropic'));
  assert.equal(out['x-api-key'], SECRET);
  assert.equal(out['content-type'], 'application/json');
});

test('openai gets a bearer authorization header, not a bare key', () => {
  const out = applyCredentials({}, cred('openai', OTHER_SECRET));
  assert.equal(out.authorization, `Bearer ${OTHER_SECRET}`);
});

test('gemini gets x-goog-api-key', () => {
  const out = applyCredentials({}, cred('gemini'));
  assert.equal(out['x-goog-api-key'], SECRET);
});

test('applyCredentials replaces a differently-cased inbound auth header', () => {
  // Two auth headers on one request means which one wins is the upstream's
  // choice, and a 401 for that is indistinguishable from a bad key.
  const out = applyCredentials({ AUTHORIZATION: 'Bearer client-supplied' }, cred('openai'));
  assert.equal(out.AUTHORIZATION, undefined);
  assert.equal(out.authorization, `Bearer ${SECRET}`);
  assert.equal(Object.keys(out).length, 1);
});

test('applyCredentialsStrict drops a caller auth header the provider will not use', () => {
  // Forwarding the caller's token to Anthropic next to our key puts their
  // credential in the provider's request log under our account.
  const out = applyCredentialsStrict(
    { AUTHORIZATION: 'Bearer client-supplied', cookie: 'session=abc', 'x-api-key': SECRET, accept: 'application/json' },
    cred('anthropic'),
  );
  assert.deepEqual(Object.keys(out).sort(), ['accept', 'x-api-key']);
  assert.equal(out['x-api-key'], SECRET);
  assert.equal(out.accept, 'application/json');
});

test('applyCredentialsStrict is idempotent over its own output', () => {
  const once = applyCredentialsStrict({ 'x-goog-api-key': 'stale', accept: 'application/json' }, cred('gemini'));
  assert.deepEqual(applyCredentialsStrict(once, cred('gemini')), once);
});

test('applyCredentials does not mutate the inbound bag', () => {
  const input = { authorization: 'Bearer client-supplied' };
  applyCredentials(input, cred('anthropic'));
  assert.deepEqual(input, { authorization: 'Bearer client-supplied' });
});

test('applyCredentials then redactHeaders hides the key that was just applied', () => {
  const out = redactHeaders(applyCredentials({}, cred('openai')));
  assert.ok(out.authorization?.startsWith('[redacted:len='));
  assert.ok(!JSON.stringify(out).includes(OTHER_SECRET));
});

test('authHeaderFor names the header each provider actually reads', () => {
  assert.equal(authHeaderFor('anthropic').name, 'x-api-key');
  assert.equal(authHeaderFor('openai').name, 'authorization');
  assert.equal(authHeaderFor('openai').prefix, 'Bearer ');
  assert.equal(authHeaderFor('gemini').name, 'x-goog-api-key');
});

test('an unknown provider on a hand-built credential is rejected, not guessed', () => {
  const bogus = { ...cred('anthropic'), provider: 'cohere' as ProviderId };
  assert.throws(() => applyCredentials({}, bogus), UnsupportedProviderError);
});

// --- resolveCredential: precedence -----------------------------------------

test('an explicit option wins over env and keyring', async () => {
  const keyring = new MockKeyring({ [keyringAccount('anthropic')]: OTHER_SECRET });
  const c = await resolveCredential('anthropic', {
    credential: SECRET,
    env: { ANTHROPIC_API_KEY: OTHER_SECRET },
    keyring,
  });
  assert.equal(c.value, SECRET);
  assert.equal(c.origin, 'option');
  assert.deepEqual(keyring.lookups, [], 'keyring is not even consulted');
});

test('env wins over the keyring', async () => {
  const keyring = new MockKeyring({ [keyringAccount('anthropic')]: OTHER_SECRET });
  const c = await resolveCredential('anthropic', { env: { ANTHROPIC_API_KEY: SECRET }, keyring });
  assert.equal(c.value, SECRET);
  assert.equal(c.origin, 'env');
  assert.equal(c.envVar, 'ANTHROPIC_API_KEY');
  assert.deepEqual(keyring.lookups, [], 'keyring is not consulted once env answers');
});

test('the keyring is used when there is nothing else', async () => {
  const keyring = new MockKeyring({ [keyringAccount('openai')]: OTHER_SECRET });
  const c = await resolveCredential('openai', { env: {}, keyring });
  assert.equal(c.value, OTHER_SECRET);
  assert.equal(c.origin, 'keyring');
  assert.deepEqual(keyring.lookups, [[KEYRING_SERVICE, 'OPENAI_API_KEY']]);
});

test('a blank explicit option falls through instead of winning', async () => {
  // An empty string is the residue of `${KEY:-}` in a config file. Treating it
  // as a credential ships a zero-length key upstream and gets a 401.
  const c = await resolveCredential('anthropic', { credential: '   ', env: { ANTHROPIC_API_KEY: SECRET }, keyring: nullKeyring });
  assert.equal(c.origin, 'env');
  assert.equal(c.value, SECRET);
});

test('a blank env var falls through to the keyring', async () => {
  const keyring = new MockKeyring({ [keyringAccount('gemini')]: OTHER_SECRET });
  const c = await resolveCredential('gemini', { env: { GEMINI_API_KEY: '' }, keyring });
  assert.equal(c.origin, 'keyring');
});

test('resolved values are trimmed before they reach the wire', async () => {
  const c = await resolveCredential('anthropic', { credential: `  ${SECRET}\n` });
  assert.equal(c.value, SECRET);
});

test('an async keyring adapter is awaited', async () => {
  const asyncKeyring: KeyringAdapter = { get: () => Promise.resolve(OTHER_SECRET) };
  const c = await resolveCredential('openai', { env: {}, keyring: asyncKeyring });
  assert.equal(c.value, OTHER_SECRET);
  assert.equal(c.origin, 'keyring');
});

test('the default keyring is the null adapter, not a native import', () => {
  assert.equal(nullKeyring.get(KEYRING_SERVICE, 'ANTHROPIC_API_KEY'), null);
});

// --- resolveCredential: failure --------------------------------------------

test('a missing credential throws a typed, actionable error', async () => {
  const err = await throws(() => resolveCredential('anthropic', { env: {}, keyring: nullKeyring }));
  assert.ok(err instanceof MissingCredentialError);
  // `assert.ok` narrows, so these read the error's own fields without a cast.
  assert.equal(err.code, 'missing_credential');
  assert.equal(err.provider, 'anthropic');
  assert.ok(err.message.includes('ANTHROPIC_API_KEY'), 'names the env var');
  assert.ok(err.message.includes(KEYRING_SERVICE), 'names the keyring service');
  assert.deepEqual(err.attempted, ['option', 'env', 'keyring']);
});

test('each provider reports its own env var', async () => {
  for (const [provider, envVar] of Object.entries(PROVIDER_ENV_VAR)) {
    const err = await throws(() => resolveCredential(provider as ProviderId, { env: {} }));
    assert.ok(err.message.includes(envVar), `${provider} error must name ${envVar}`);
  }
});

test('the missing-credential error never quotes any credential value', async () => {
  // Another provider's key is sitting in the environment; the error must not
  // helpfully dump it while complaining that this one is missing.
  const err = await throws(() =>
    resolveCredential('gemini', { env: { OPENAI_API_KEY: OTHER_SECRET, ANTHROPIC_API_KEY: SECRET } }),
  );
  assert.ok(!err.message.includes(SECRET));
  assert.ok(!err.message.includes(OTHER_SECRET));
  assert.ok(!JSON.stringify(err).includes(OTHER_SECRET));
});

test('a throwing keyring reports a keyring failure, not a missing credential', async () => {
  // "set ANTHROPIC_API_KEY" is wrong advice when the real problem is a locked
  // keychain; the user would respond by pasting a key into a shell profile.
  const locked: KeyringAdapter = { get: () => { throw new Error('user cancelled keychain prompt'); } };
  const err = await throws(() => resolveCredential('anthropic', { env: {}, keyring: locked }));
  assert.ok(err instanceof KeyringAccessError);
  assert.ok(!(err instanceof MissingCredentialError));
  assert.equal(err.code, 'keyring_unavailable');
  assert.ok(err.message.includes('user cancelled keychain prompt'));
});

test('an unknown provider name is rejected before any lookup', async () => {
  const err = await throws(() => resolveCredential('cohere' as ProviderId, { env: {} }));
  assert.ok(err instanceof UnsupportedProviderError);
});

// --- describeCredential: the only loggable view -----------------------------

test('describeCredential reports origin and length but never the value', () => {
  const d = describeCredential(cred('anthropic'));
  assert.deepEqual(d, { provider: 'anthropic', origin: 'option', envVar: 'ANTHROPIC_API_KEY', length: SECRET.length });
  assert.ok(!JSON.stringify(d).includes(SECRET));
});

test('a resolved credential survives a full pass through describe + redact', async () => {
  const c = await resolveCredential('openai', { env: { OPENAI_API_KEY: OTHER_SECRET } });
  const wire = redactHeaders(applyCredentials({ accept: 'application/json' }, c));
  const report = JSON.stringify({ credential: describeCredential(c), headers: wire });
  assert.ok(!report.includes(OTHER_SECRET));
  assert.ok(report.includes('"accept":"application/json"'));
});
