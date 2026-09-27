/**
 * @strata-ctx/gateway
 *
 * The insertion point. A local reverse proxy beats an in-process SDK because an
 * SDK can only help users of agents we ship code into, whereas a proxy works
 * for every agent that can be pointed at a different base URL.
 */
export * from './anthropic-adapter.js';
export * from './server.js';
