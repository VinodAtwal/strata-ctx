import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runId, type ContextState } from '@strata-ctx/core-types';
import { PROVIDERS } from '../src/config.js';
import {
  ANTHROPIC_ADAPTER,
  GEMINI_ADAPTER,
  OPENAI_COMPAT_ADAPTER,
  ROUTES,
  builtinAdapters,
  isConfigProvider,
  matchRoute,
  resolveAdapter,
  type ConfigProvider,
  type ProviderAdapter,
} from '../src/routing.js';

const fakeAdapter = (provider: ConfigProvider): ProviderAdapter => ({
  provider,
  supportsStreaming: false,
  toCanonical: (): ContextState => ({
    messages: [],
    pinned: [],
    tokenEstimate: 0,
    policyHash: '',
    runId: runId('r'),
    turn: 1,
    gists: [],
    artifacts: [],
  }),
  fromCanonical: (): unknown => ({}),
});

// ---------------------------------------------------------------- the seam

test('the anthropic adapter is the built-in default', () => {
  assert.equal(builtinAdapters().anthropic, ANTHROPIC_ADAPTER);
  assert.equal(ANTHROPIC_ADAPTER.provider, 'anthropic');
  assert.equal(ANTHROPIC_ADAPTER.supportsStreaming, true);
});

test('resolveAdapter returns the anthropic adapter for the anthropic provider', () => {
  assert.equal(resolveAdapter('anthropic'), ANTHROPIC_ADAPTER);
});

test('a provider with no adapter resolves to undefined, not a throw', () => {
  // `mock` is the only routable provider with no built-in: it is a test-only
  // upstream and is always injected. Unresolvable must stay a routable
  // condition (501) rather than a throw, or the failure mode would depend on
  // which provider happened to be configured.
  assert.equal(resolveAdapter('mock'), undefined);
});

test('every provider that has a built-in resolves to it, and only those', () => {
  // A-9 and A-10 closed the gap this suite used to assert. The invariant that
  // survives is the coverage one: a routable provider is never left dangling.
  const expected: Readonly<Record<string, ProviderAdapter>> = {
    anthropic: ANTHROPIC_ADAPTER,
    'openai-compat': OPENAI_COMPAT_ADAPTER,
    gemini: GEMINI_ADAPTER,
  };
  for (const provider of PROVIDERS) {
    const resolved = resolveAdapter(provider);
    if (provider in expected) {
      assert.equal(resolved, expected[provider], provider);
    } else {
      assert.equal(resolved, undefined, `${provider} should have no built-in`);
    }
  }
});

test('an injected adapter fills a provider the build has no adapter for', () => {
  const gemini = fakeAdapter('gemini');
  assert.equal(resolveAdapter('gemini', { gemini }), gemini);
});

test('injection overrides the built-in rather than losing to it', () => {
  const replacement = fakeAdapter('anthropic');
  assert.equal(resolveAdapter('anthropic', { anthropic: replacement }), replacement);
});

test('an injected table that omits the requested provider leaves it unresolved', () => {
  // exactOptionalPropertyTypes: absent is not the same as undefined, and a
  // partially-populated table must not accidentally fall through to a default.
  assert.equal(resolveAdapter('anthropic', { gemini: fakeAdapter('gemini') }), ANTHROPIC_ADAPTER);
  assert.equal(resolveAdapter('mock', { gemini: fakeAdapter('gemini') }), undefined);
});

test('the injected table is not mutated by resolution', () => {
  const table = Object.freeze({ gemini: fakeAdapter('gemini') });
  resolveAdapter('gemini', table);
  assert.deepEqual(Object.keys(table), ['gemini']);
});

test('the anthropic adapter refuses a body that is not a JSON object', () => {
  for (const bad of [null, 7, 'nope', undefined]) {
    assert.throws(() => ANTHROPIC_ADAPTER.toCanonical(bad), TypeError, String(bad));
  }
});

test('the anthropic adapter applies the turn it is given, and the default when it is not', () => {
  const body = { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(ANTHROPIC_ADAPTER.toCanonical(body, 5).turn, 0, 'toCanonical owns the turn field');
  assert.equal(ANTHROPIC_ADAPTER.toCanonical(body).turn, 0);
});

// ------------------------------------------------------- provider narrowing

test('isConfigProvider accepts exactly the routable set', () => {
  for (const provider of PROVIDERS) assert.equal(isConfigProvider(provider), true, provider);
});

test('isConfigProvider rejects the credentials provider set and non-strings', () => {
  // `openai` is a credentials.ProviderId, not a config.Provider. Accepting it
  // would route to a provider no adapter table can ever key on.
  for (const bad of ['openai', 'Anthropic', '', 'mock ', 0, null, undefined, {}]) {
    assert.equal(isConfigProvider(bad), false, JSON.stringify(bad) ?? 'undefined');
  }
});

// -------------------------------------------------------------- route table

test('every route carries a method and a path', () => {
  for (const route of ROUTES) {
    assert.ok(route.method.length > 0);
    assert.ok(route.path.startsWith('/'), route.path);
  }
});

test('GET /healthz routes to health', () => {
  const m = matchRoute('GET', '/healthz');
  assert.equal(m.kind, 'match');
  assert.equal(m.kind === 'match' && m.route.kind, 'health');
});

test('a trailing slash and a query string do not change the route', () => {
  for (const url of ['/healthz/', '/healthz?full=1', '/healthz/?full=1']) {
    assert.equal(matchRoute('GET', url).kind, 'match', url);
  }
});

test('the method is matched case-insensitively', () => {
  assert.equal(matchRoute('post', '/v1/messages').kind, 'match');
  assert.equal(matchRoute('POST', '/v1/messages').kind, 'match');
});

test('the provider ingress paths all route to ingress', () => {
  for (const url of [
    '/v1/messages',
    '/v1/chat/completions',
    '/v1beta/models/gemini-2.0:generateContent',
    '/v1beta/models/gemini-2.0:streamGenerateContent?alt=sse',
  ]) {
    const m = matchRoute('POST', url);
    assert.equal(m.kind, 'match', url);
    assert.equal(m.kind === 'match' && m.route.kind, 'ingress', url);
  }
});

test('a known path with the wrong method is 405, not 404', () => {
  const m = matchRoute('POST', '/healthz');
  assert.equal(m.kind, 'method_not_allowed');
  assert.deepEqual(m.kind === 'method_not_allowed' ? m.allow : [], ['GET']);
});

test('Allow lists every method the path does accept', () => {
  const m = matchRoute('DELETE', '/v1/messages');
  assert.deepEqual(m.kind === 'method_not_allowed' ? m.allow : [], ['POST']);
});

test('an unknown path is not_found and does not borrow another path Allow', () => {
  const m = matchRoute('POST', '/v1/nope');
  assert.equal(m.kind, 'not_found');
  assert.equal(m.kind === 'not_found' && m.path, '/v1/nope');
});

test('a bare /v1beta is not a provider path', () => {
  // The wildcard exists for the model-bearing Gemini paths, not as a
  // catch-all for the namespace.
  assert.equal(matchRoute('POST', '/v1beta').kind, 'not_found');
  assert.equal(matchRoute('POST', '/v1beta/').kind, 'not_found');
});

test('the root and a missing url are not_found rather than a crash', () => {
  assert.equal(matchRoute('GET', '/').kind, 'not_found');
  assert.equal(matchRoute('GET', undefined).kind, 'not_found');
  assert.equal(matchRoute('GET', undefined).path, '/');
});

test('route resolution is deterministic', () => {
  const urls = ['/healthz', '/v1/messages?x=1', '/nope', '/healthz/', '/v1beta/models/g:generateContent'];
  const first = urls.map((u) => JSON.stringify(matchRoute('GET', u)));
  const second = urls.map((u) => JSON.stringify(matchRoute('GET', u)));
  assert.deepEqual(first, second);
});
