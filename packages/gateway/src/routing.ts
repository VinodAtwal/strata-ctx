import type { ContextState } from '@strata-ctx/core-types';
import { fromCanonical, toCanonical, type AnthropicRequest } from './anthropic-adapter.js';
import { PROVIDERS, type Provider as ConfigProvider } from './config.js';
import {
  fromCanonical as geminiFromCanonical,
  toCanonical as geminiToCanonical,
  type GeminiRequest,
} from './gemini-adapter.js';
import {
  fromCanonical as openaiFromCanonical,
  toCanonical as openaiToCanonical,
  type OpenAiCompatRequest,
} from './openai-compat-adapter.js';

/**
 * Re-exported under the same name the package barrel gives it, so `server.ts`
 * and the eventual `index.ts` export cannot disagree about which `PROVIDERS`
 * set a `ConfigProvider` belongs to. `credentials.ts` exports a *different*
 * `PROVIDERS`; that one is key-holding, this one is routable. See AGENTS.md §10.
 */
export type { ConfigProvider };

/**
 * A-7: the provider seam.
 *
 * `openai-compat` and `gemini` ship as separate modules (A-9, A-10) that this
 * file must not import: a package cannot be half-linked, and a static import of
 * a module that is not there yet is a build error, not a TODO. So the adapters
 * are *values passed in* rather than symbols resolved here, and this module owns
 * only the three things that have to be true regardless of which provider is
 * configured: what an adapter is, which one is used, and which HTTP routes
 * exist at all.
 *
 * The `unknown` in the signatures is deliberate and is not laziness. An adapter
 * is the boundary between operator-supplied bytes and the canonical model, and
 * the whole point of `toCanonical` is to be the one place that narrows. Typing
 * the parameter as the provider's wire type would push that narrowing back onto
 * every caller, which is how a provider quirk leaks into the pipeline.
 */
export interface ProviderAdapter {
  readonly provider: ConfigProvider;
  /**
   * Whether this adapter's provider can stream. A `false` here does not make the
   * gateway buffer -- requirement N3 forbids it for every provider -- it means
   * the *upstream* is configured non-streaming and the response will simply
   * arrive whole. Recorded, not enforced: the value is what a client is told
   * and what an operator debugs with.
   */
  readonly supportsStreaming: boolean;
  toCanonical(req: unknown, now?: number): ContextState;
  fromCanonical(state: ContextState, req: unknown): unknown;
}

/** Adapter table keyed by the configured upstream, for `GatewayOptions.adapters`. */
export type AdapterTable = Readonly<Partial<Record<ConfigProvider, ProviderAdapter>>>;

/**
 * The default ingress. It is wrapped rather than reimplemented: the wire format
 * belongs to `anthropic-adapter.ts` and the seam belongs here, and a second
 * definition of the Anthropic shape is a second thing to keep in sync.
 */
export const ANTHROPIC_ADAPTER: ProviderAdapter = {
  provider: 'anthropic',
  supportsStreaming: true,
  toCanonical: (req: unknown, now?: number): ContextState =>
    now === undefined
      ? toCanonical(asAnthropicRequest(req))
      : toCanonical(asAnthropicRequest(req), now),
  fromCanonical: (state: ContextState, req: unknown): unknown =>
    fromCanonical(state, asAnthropicRequest(req)),
};

/**
 * `toCanonical` wants its own request type and the gateway hands it `unknown`.
 * This is the narrowing point the seam is allowed to have: a body that is not a
 * Messages request throws here, and the caller fails open by forwarding the
 * original bytes rather than by inventing a request shape. Asserting the whole
 * object would defeat the check that actually matters -- the fields the adapter
 * reads, which `toCanonical` itself validates by throwing.
 */
const asAnthropicRequest = (req: unknown): AnthropicRequest => {
  if (typeof req !== 'object' || req === null) {
    throw new TypeError('request body is not a JSON object');
  }
  return req as AnthropicRequest;
};

/**
 * A-9 and A-10 landed after the seam above was written, so the two extra
 * built-ins are registered here rather than in the A-7 modules. Each is wrapped
 * in exactly the same shape as `ANTHROPIC_ADAPTER`: the wire format belongs to
 * its own module, and the seam is the only place that narrows `unknown`.
 */
export const OPENAI_COMPAT_ADAPTER: ProviderAdapter = {
  provider: 'openai-compat',
  supportsStreaming: true,
  toCanonical: (req: unknown, now?: number): ContextState =>
    now === undefined
      ? openaiToCanonical(req as OpenAiCompatRequest)
      : openaiToCanonical(req as OpenAiCompatRequest, now),
  fromCanonical: (state: ContextState, req: unknown): unknown =>
    openaiFromCanonical(state, req as OpenAiCompatRequest),
};

export const GEMINI_ADAPTER: ProviderAdapter = {
  provider: 'gemini',
  supportsStreaming: true,
  toCanonical: (req: unknown, now?: number): ContextState =>
    now === undefined
      ? geminiToCanonical(req as GeminiRequest)
      : geminiToCanonical(req as GeminiRequest, now),
  fromCanonical: (state: ContextState, req: unknown): unknown =>
    geminiFromCanonical(state, req as GeminiRequest),
};

/** The adapters compiled into this build. Everything else arrives by injection. */
export function builtinAdapters(): AdapterTable {
  return BUILTIN_ADAPTERS;
}

const BUILTIN_ADAPTERS: AdapterTable = Object.freeze({
  anthropic: ANTHROPIC_ADAPTER,
  'openai-compat': OPENAI_COMPAT_ADAPTER,
  gemini: GEMINI_ADAPTER,
});

/**
 * Which adapter serves `provider`.
 *
 * Injection wins over the built-ins, and returns `undefined` rather than
 * throwing: "this build has no adapter for that provider" is a routable
 * condition (HTTP 501, an operator-visible configuration error) and not an
 * exceptional one. Throwing here would make the failure mode depend on which
 * provider happens to be configured, which is the kind of asymmetry that is
 * only ever discovered in production.
 */
export function resolveAdapter(
  provider: ConfigProvider,
  injected?: AdapterTable,
): ProviderAdapter | undefined {
  return injected?.[provider] ?? builtinAdapters()[provider];
}

/**
 * Narrow an untrusted provider name. `GatewayOptions` is built from an operator
 * config document, and a bad value there must not become a lookup that returns
 * `undefined` three frames later with no idea why.
 */
export function isConfigProvider(value: unknown): value is ConfigProvider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

// ------------------------------------------------------------------- routes

export type RouteKind = 'health' | 'status' | 'ingress';

export interface Route {
  readonly kind: RouteKind;
  readonly method: string;
  /**
   * An exact path, or a prefix ending in `*` for the provider paths that carry
   * the model in the URL (`/v1beta/models/gemini-2.0:generateContent`). A
   * prefix route exists because the Gemini surface genuinely has no fixed path,
   * and matching it with a route table keeps the 404 honest rather than turning
   * every unknown POST into a proxy.
   */
  readonly path: string;
}

/**
 * The whole surface. Anything not here is a 404 with a JSON body -- a proxy
 * that answers `200 {}` for a path it does not understand is how a typo in an
 * agent's base URL turns into a silently degraded conversation.
 */
export const ROUTES: readonly Route[] = Object.freeze([
  { kind: 'health', method: 'GET', path: '/healthz' },
  { kind: 'status', method: 'GET', path: '/strata/status' },
  { kind: 'ingress', method: 'POST', path: '/v1/messages' },
  { kind: 'ingress', method: 'POST', path: '/v1/chat/completions' },
  { kind: 'ingress', method: 'POST', path: '/v1beta/*' },
]);

export type RouteMatch =
  | {
      readonly kind: 'match';
      readonly route: Route;
      /** Query string stripped. This is the path, for logs and for the 404 body. */
      readonly path: string;
    }
  /**
   * The path exists but not for this method. Reported separately from `not_found`
   * so the response can carry `Allow`, which is the only part of a 405 a client
   * actually reads.
   */
  | { readonly kind: 'method_not_allowed'; readonly path: string; readonly allow: readonly string[] }
  | { readonly kind: 'not_found'; readonly path: string };

const stripQuery = (url: string): string => {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
};

/**
 * `/healthz` and `/healthz/` are the same route to a human and a different route
 * to `path ===`, and an agent base URL written by hand will contain the second.
 */
const normalize = (path: string): string =>
  path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;

const pathMatches = (route: Route, path: string): boolean => {
  if (route.path.endsWith('*')) return path.startsWith(route.path.slice(0, -1));
  return route.path === path;
};

/**
 * Pure: no sockets, no clock, no config. Route resolution is the thing most
 * likely to grow a case nobody tested -- trailing slashes, query strings, a
 * POST to a GET route -- so it is separated from the request handler to be
 * testable without one.
 */
export function matchRoute(method: string, url: string | undefined): RouteMatch {
  const path = normalize(stripQuery(url ?? '/'));
  const verb = method.toUpperCase();

  for (const route of ROUTES) {
    if (route.method === verb && pathMatches(route, path)) {
      return { kind: 'match', route, path };
    }
  }

  const allow = ROUTES.filter((r) => pathMatches(r, path)).map((r) => r.method);
  if (allow.length > 0) {
    return { kind: 'method_not_allowed', path, allow: Object.freeze([...new Set(allow)].sort()) };
  }
  return { kind: 'not_found', path };
}
