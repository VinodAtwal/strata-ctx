/**
 * @strata-ctx/gateway
 *
 * The insertion point. A local reverse proxy beats an in-process SDK because an
 * SDK can only help users of agents we ship code into, whereas a proxy works
 * for every agent that can be pointed at a different base URL.
 */
export * from './anthropic-adapter.js';
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
