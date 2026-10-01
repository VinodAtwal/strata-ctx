/**
 * @strata-ctx/gateway
 *
 * The insertion point. A local reverse proxy beats an in-process SDK because an
 * SDK can only help users of agents we ship code into, whereas a proxy works
 * for every agent that can be pointed at a different base URL.
 */
// Each provider adapter exports its own `toCanonical`/`fromCanonical`, so
// star-exporting all of them would leave ambiguous names that resolve to
// nothing at runtime. The Anthropic pair stays top-level because it was the
// original default and `server.ts` and downstream callers read it unqualified;
// the others are namespaced. Callers that need a specific provider go
// through `resolveAdapter()` (A-7's seam) rather than importing a converter
// directly, because that is the only place the `unknown` narrowing is allowed.
//
// `ollamaAdapter` is namespaced for a different reason: it is not a
// `ProviderAdapter` at all. It is the Tier 3 local-model narration backend, and
// it deliberately has no `toCanonical`/`fromCanonical`, because narration runs
// on an already-canonical context during compaction and never routes a request.
// It is therefore absent from `PROVIDERS` on purpose — adding it there would let
// `validateConfig` accept an `ollama` upstream that `resolveAdapter` cannot
// serve, which is the advertised-vs-registered mismatch in AGENTS.md §10.
export * from './anthropic-adapter.js';
export * as openaiCompatAdapter from './openai-compat-adapter.js';
export * as geminiAdapter from './gemini-adapter.js';
export * as ollamaAdapter from './ollama-adapter.js';
export * from './routing.js';
export * from './server.js';
export * from './sse.js';
export * from './token-estimator.js';
export * from './credentials.js';

// `config.PROVIDERS` is the set of *upstreams* a request can be routed to
// (includes `openai-compat` and `mock`); `credentials.PROVIDERS` is the set of
// providers we can hold an API key for. They are different sets that happened
// to share a name, so the config one is renamed rather than star-exported.
export {
  LOG_LEVELS,
  DEFAULT_CONFIG,
  DEFAULT_DEBOUNCE_MS,
  ConfigError,
  ConfigWatcher,
  validateConfig,
  safeParseConfig,
  parseConfig,
  loadConfig,
  PROVIDERS as CONFIG_PROVIDERS,
} from './config.js';
export type {
  LogLevel,
  Provider as ConfigProvider,
  ListenConfig,
  TimeoutConfig,
  GatewayConfig,
  ConfigIssueCode,
  ConfigIssue,
  ParseResult,
  ReloadResult,
  ConfigWatcherOptions,
} from './config.js';
