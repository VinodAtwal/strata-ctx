import { Server, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Readable } from 'node:stream';
import type { ContextState, StrataPolicy, TelemetryEvent } from '@strata-ctx/core-types';
import {
  enforcePins,
  estimateTokens,
  partitionForLossy,
  pinDrift,
  pinSetText,
  restoreHeld,
  runId,
  sha256,
  StrataPolicySchema,
} from '@strata-ctx/core-types';
import { DEFAULT_TAIL_BYTES, pipeSseUpstream } from './sse.js';
import {
  isConfigProvider,
  matchRoute,
  resolveAdapter,
  type AdapterTable,
  type ConfigProvider,
} from './routing.js';

export interface GatewayOptions {
  readonly port: number;
  readonly host: string;
  /** Upstream base URL. In dev this is the mock provider. */
  readonly upstream: string;
  /** Provider key is read from the environment, never from policy. */
  readonly apiKeyEnv: string;
  readonly policy: StrataPolicy;
  readonly telemetry?: (e: TelemetryEvent) => void;
  /** Which upstream wire format to speak. Defaults to `anthropic` (A-7). */
  readonly provider?: ConfigProvider;
  /**
   * Adapters for providers this build cannot link statically. A-9 and A-10 land
   * here; `createGateway` never imports them, so the gateway compiles and its
   * tests pass with them absent.
   */
  readonly adapters?: AdapterTable;
  /**
   * How long a graceful shutdown waits for in-flight requests before it destroys
   * the sockets. Defaults to `DEFAULT_CONFIG.timeouts.shutdownMs` in
   * `config.ts`; the same number written twice would drift.
   */
  readonly drainMs?: number;
  /**
   * Bytes the self-gist observer's ring retains per response. `0` disables it.
   * This is an observer copy, never a transform buffer: N3 forbids accumulating
   * a response in order to rewrite it, and nothing here reads the ring back.
   */
  readonly sseTailBytes?: number;
  /** Session table bound. TODO(WS-A, A-7): pick this from a real turn count. */
  readonly maxSessions?: number;
}

export interface Session {
  state: ContextState;
  /** What we actually put on the wire last turn. The only honest drift baseline. */
  lastSent: readonly string[];
}

const DEFAULT_DRAIN_MS = 10_000;

/**
 * Request body ceiling. The canonical budget is 200k tokens of text
 * (`BudgetPolicySchema.contextLimit`, on the order of a megabyte), so whatever
 * else a real request carries is base64 images. 64 MiB leaves orders of
 * magnitude of headroom and still refuses the one thing that can take the
 * process down: a client streaming an unbounded body.
 * TODO(WS-A, A-7): re-derive from a measured maximum once image-bearing
 * requests exist in the corpus.
 */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** TODO(WS-A, A-7): 512 is a guess at "one session per project per day". */
const DEFAULT_MAX_SESSIONS = 512;

const SESSION_HEADER = 'x-strata-session';

const isGovernanceSystem = (s: ContextState): boolean => s.messages.some((m) => m.role === 'system');

const EMPTY_STATE: ContextState = {
  messages: [],
  pinned: [],
  tokenEstimate: 0,
  policyHash: '',
  runId: runId('none'),
  turn: 0,
  gists: [],
  artifacts: [],
};

const detailOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Everything a request handler needs, resolved once at construction so the
 * provider, the adapter and the policy digest cannot drift between requests.
 */
export interface GatewayRuntime {
  readonly opts: GatewayOptions;
  readonly provider: ConfigProvider;
  readonly adapter: ReturnType<typeof resolveAdapter>;
  readonly sessions: Map<string, Session>;
  /** Byte-identical to the digest `verifyPinIntegrity` computes. */
  readonly policyHash: string;
}

interface Dispatcher {
  readonly rt: GatewayRuntime;
  server: Gateway;
  readonly drainMs: number;
  readonly startedAt: number;
  inflight: number;
  draining: boolean;
  noteInflight(delta: number): void;
}

// ------------------------------------------------------------------ responses

const sendJson = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void => {
  // A handler that fails after headers are on the wire cannot change the
  // status; writing anyway would throw inside the error path.
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};

const fail = (d: Dispatcher, code: string, message: string, failedOpen: boolean): void => {
  d.rt.opts.telemetry?.({ type: 'error', runId: 'unknown', stage: 'pin', code, message, failedOpen });
};

/**
 * `GET /healthz`.
 *
 * Everything here is derived from live state or is already a constant in
 * `core-types`. The one thing deliberately absent is the contract digest: it
 * lives in `packages/core-types/contract.lock.json` and is maintained by
 * `npm run contract:update`, so transcribing it into this file would create a
 * second copy that no gate checks. `policyHash` is the one an operator can act
 * on -- it names the pin set this process is enforcing.
 */
const handleHealth = (res: ServerResponse, d: Dispatcher): void => {
  sendJson(res, 200, {
    ok: !d.server.draining,
    provider: d.rt.provider,
    adapter: d.rt.adapter?.provider ?? null,
    draining: d.server.draining,
    uptimeMs: d.server.uptimeMs,
    sessions: d.rt.sessions.size,
    inflight: d.server.inflight,
    constraints: d.rt.opts.policy.constraints.length,
    policyHash: d.rt.policyHash,
  });
};

/** The pre-A-7 status route, kept because `tools/dev.ts` and operators depend on it. */
const handleStatus = (res: ServerResponse, d: Dispatcher): void => {
  const policy = StrataPolicySchema.safeParse(d.rt.opts.policy);
  sendJson(res, 200, {
    ok: true,
    policy: policy.success ? { constraints: d.rt.opts.policy.constraints.length } : 'invalid',
    pinning: d.rt.opts.policy.governance.pinning,
    governanceSystem: isGovernanceSystem(d.rt.sessions.get('default')?.state ?? EMPTY_STATE),
  });
};

// -------------------------------------------------------------------- ingress

const readBody = async (req: IncomingMessage): Promise<{ ok: true; text: string } | { ok: false }> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buf.length;
    // Enforced while reading, not after: concatenating first is what turns a
    // hostile body into an out-of-memory kill.
    if (bytes > MAX_BODY_BYTES) return { ok: false };
    chunks.push(buf);
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
};

const apiKeyHeader = (env: string): Record<string, string> => {
  const key = process.env[env];
  return key === undefined || key === '' ? {} : { 'x-api-key': key };
};

/**
 * Forward `body` to the upstream and pipe the response through unmodified.
 *
 * This is both the happy path and the fail-open path, which is why the
 * fail-open is honest: "unmodified passthrough" has to mean the bytes reach the
 * provider, not that the gateway answers 502 and the agent retries forever. The
 * response is streamed through `pipeSseUpstream` either way, because a
 * fail-open that buffered would make a failure slower than a success.
 */
const forward = async (
  req: IncomingMessage,
  res: ServerResponse,
  d: Dispatcher,
  body: string,
  headers: Record<string, string>,
): Promise<void> => {
  const url = `${d.rt.opts.upstream}${req.url ?? '/v1/messages'}`;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...apiKeyHeader(d.rt.opts.apiKeyEnv), ...headers },
      body,
    });
  } catch (err) {
    // Not a fail-open: there is no provider to fail open *to*. The context is
    // not lost, the request simply did not happen, and saying so is better than
    // a truncated response.
    fail(d, 'upstream_unreachable', detailOf(err), false);
    sendJson(res, 502, { error: 'upstream_unreachable', detail: detailOf(err) });
    return;
  }

  const out: Record<string, string> = {
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    'cache-control': 'no-store',
    ...headers,
  };
  const length = upstream.headers.get('content-length');
  if (length !== null) out['content-length'] = length;
  res.writeHead(upstream.status, out);

  if (upstream.body === null) {
    res.end();
    return;
  }
  // Unbuffered, requirement N3: the upstream reader is handed straight to the
  // socket. Nothing accumulates a body in order to transform it -- the ring tail
  // inside the pipeline is a bounded observer copy that nothing reads back.
  await pipeSseUpstream(Readable.fromWeb(upstream.body), res, {
    tailBytes: d.rt.opts.sseTailBytes ?? DEFAULT_TAIL_BYTES,
  }).done();
};

/**
 * `POST` on a provider ingress path.
 *
 * The order below is the pipeline order in `docs/architecture.md` §4. Pinning is
 * not simplified: `partitionForLossy` / `restoreHeld` / `enforcePins` run on
 * every request, `enforcePins` is the last thing that touches the state before
 * egress, and drift is measured against the previous turn's wire bytes rather
 * than skipped.
 */
const handleIngress = async (
  req: IncomingMessage,
  res: ServerResponse,
  d: Dispatcher,
  sessionId: string,
): Promise<void> => {
  const adapter = d.rt.adapter;
  if (adapter === undefined) {
    // 501, not 404 and not 502: the route exists, the operator asked for a
    // provider this build has no adapter for, and that is fixable by config.
    fail(d, 'adapter_unavailable', `no adapter registered for provider "${d.rt.provider}"`, false);
    sendJson(res, 501, {
      error: 'adapter_unavailable',
      detail: `no adapter is registered for provider "${d.rt.provider}"`,
      provider: d.rt.provider,
    });
    return;
  }

  const body = await readBody(req);
  if (!body.ok) {
    fail(d, 'body_too_large', `request body exceeds ${MAX_BODY_BYTES} bytes`, false);
    sendJson(res, 413, { error: 'payload_too_large', limit: MAX_BODY_BYTES });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text) as unknown;
  } catch (err) {
    // 400 and not 502: the provider would reject this too, and answering here
    // costs a round trip instead of a token spend.
    fail(d, 'bad_request', `malformed JSON body: ${detailOf(err)}`, false);
    sendJson(res, 400, { error: 'bad_request', detail: 'request body is not valid JSON' });
    return;
  }

  const session = touchSession(d, sessionId);
  const t0 = performance.now();

  let state: ContextState;
  let expected: readonly string[];
  let outbound: unknown;
  let blocksIn = 0;
  try {
    // Wall-clock, not a turn counter: the second argument is the block
    // timestamp. `ContextState.turn` belongs to the ingress adapter and the
    // pipeline, and the pre-A-7 code passed `priorTurn + 1` here, which was a
    // monotonic id in a field documented as an epoch millisecond. The value
    // never reaches the wire -- `fromCanonical` does not emit `ts` -- so this
    // stays byte-identical for a given input either way.
    // TODO(WS-A, A-8): make the turn counter actually advance; nothing in
    // Wave 0 owns it yet.
    const before = adapter.toCanonical(parsed, Date.now());
    blocksIn = before.messages.length;

    // Wave 0 has no lossy stages wired yet, so this is partition -> (nothing) ->
    // restore -> pin. It is written in the final shape so that adding a stage
    // cannot change where pinning happens: pinning is last, and it wraps any
    // transform that follows it in the real order.
    const lossy = partitionForLossy(before, d.rt.opts.policy);
    const restored = restoreHeld(lossy, { ...before, tokenEstimate: estimateTokens(before) });
    const applied = enforcePins(restored, d.rt.opts.policy);
    state = applied.state;
    expected = applied.expected;

    // Drift is measured against what we sent last turn, not against policy: on
    // turn 1 nothing was sent, and "everything is missing" is not a finding.
    if (session.lastSent.length > 0) {
      const drift = pinDrift(session.lastSent, applied.inboundGovernance);
      if (!drift.ok) {
        d.rt.opts.telemetry?.({
          type: 'violation',
          runId: state.runId,
          kind: 'pin_missing_pre_apply',
          constraintIds: drift.defects.map((x) => x.text.slice(0, 40)),
          blocked: false,
        });
      }
    }

    d.rt.opts.telemetry?.({
      type: 'request_in',
      runId: state.runId,
      turn: state.turn,
      inputTokens: state.tokenEstimate,
      messages: state.messages.length,
    });
    if (expected.length > 0) {
      d.rt.opts.telemetry?.({
        type: 'pin',
        runId: state.runId,
        missingBefore: 0,
        constraints: expected.length,
      });
    }

    outbound = adapter.fromCanonical(state, parsed);
  } catch (err) {
    // Fail open, and fail open *properly*: the original bytes go upstream
    // untouched. Losing the user's context to save tokens is unacceptable, and a
    // gateway that 500s is a gateway the agent routes around.
    fail(d, 'pipeline_failed_open', detailOf(err), true);
    // The turn is not advanced: no canonical state was produced, so counting it
    // would leave the session claiming a turn that never happened.
    await forward(req, res, d, body.text, { 'x-strata-fail-open': '1' });
    return;
  }

  session.state = state;
  session.lastSent = expected;

  d.rt.opts.telemetry?.({
    type: 'stage',
    runId: state.runId,
    stage: 'pin',
    bytesIn: JSON.stringify(parsed).length,
    bytesOut: JSON.stringify(outbound).length,
    blocksIn,
    blocksOut: state.messages.length,
    durationMs: performance.now() - t0,
    changed: true,
  });

  await forward(req, res, d, JSON.stringify(outbound), { 'x-strata-pinned': String(expected.length) });
};

/**
 * Fetch-or-create the session, evicting the oldest if the table is full.
 *
 * Bounded because `x-strata-session` is a client-supplied header, and an
 * unbounded map keyed by one is a memory exhaustion bug with an HTTP trigger.
 * `Map` preserves insertion order, so the first key is the oldest.
 */
const touchSession = (d: Dispatcher, id: string): Session => {
  const existing = d.rt.sessions.get(id);
  const session: Session = existing ?? { state: EMPTY_STATE, lastSent: [] };
  d.rt.sessions.delete(id);
  d.rt.sessions.set(id, session);
  const limit = Math.max(1, d.rt.opts.maxSessions ?? DEFAULT_MAX_SESSIONS);
  for (const key of d.rt.sessions.keys()) {
    if (d.rt.sessions.size <= limit) break;
    d.rt.sessions.delete(key);
  }
  return session;
};

// -------------------------------------------------------------------- routing

const route = async (
  req: IncomingMessage,
  res: ServerResponse,
  d: Dispatcher,
): Promise<void> => {
  const match = matchRoute(req.method ?? 'GET', req.url);

  if (match.kind === 'not_found') {
    sendJson(res, 404, { error: 'not_found', detail: `no route for ${req.method} ${match.path}` });
    return;
  }
  if (match.kind === 'method_not_allowed') {
    const allow = match.allow.join(', ');
    sendJson(res, 405, { error: 'method_not_allowed', allow }, { allow });
    return;
  }

  // A connection that was already open when shutdown began can still be
  // speaking. Refusing here is what makes "stop accepting new connections" true
  // for keep-alive and not just for new sockets.
  if (d.server.draining && match.route.kind !== 'health') {
    sendJson(res, 503, { error: 'shutting_down' }, { 'retry-after': '1' });
    return;
  }

  switch (match.route.kind) {
    case 'health':
      handleHealth(res, d);
      return;
    case 'status':
      handleStatus(res, d);
      return;
    case 'ingress':
      await handleIngress(req, res, d, sessionIdOf(req));
      return;
  }
};

const sessionIdOf = (req: IncomingMessage): string => {
  const header = req.headers[SESSION_HEADER];
  return (Array.isArray(header) ? header[0] : header) ?? 'default';
};

// --------------------------------------------------------------------- server

/**
 * What `createGateway` returns. Extends `http.Server` so `tools/dev.ts` and
 * every existing caller keep working unchanged (`listen(port, host, cb)`,
 * `close()`), with the A-7 shutdown surface added on top.
 */
export interface Gateway extends Server {
  readonly inflight: number;
  readonly draining: boolean;
  readonly sessions: number;
  readonly uptimeMs: number;
  /** Bounded, idempotent, never rejects. Resolves once nothing is in flight. */
  closeGracefully(opts?: { readonly drainMs?: number }): Promise<void>;
  /** `closeGracefully` plus a reason, for signal handlers. */
  shutdown(reason: string): Promise<void>;
}

class GatewayHttpServer extends Server {
  readonly #d: Dispatcher;
  readonly #sockets = new Set<Socket>();
  readonly #signalHandlers = new Map<NodeJS.Signals, () => void>();
  #closePromise: Promise<void> | null = null;

  constructor(d: Dispatcher, handler: RequestListener) {
    super();
    this.#d = d;
    d.server = this as unknown as Gateway;

    this.on('connection', (socket: Socket) => {
      this.#sockets.add(socket);
      socket.once('close', () => {
        this.#sockets.delete(socket);
      });
    });

    this.on('request', (req: IncomingMessage, res: ServerResponse) => {
      d.noteInflight(1);
      // `close` fires on the response for a finished request *and* for a client
      // that vanished mid-stream, which `finish` does not. A count that leaks
      // upward is a shutdown that never completes.
      res.once('close', () => {
        d.noteInflight(-1);
        // The last in-flight request finishing is the moment the drain is allowed
        // to end. `Server#close` also waits on *idle* keep-alive sockets, and a
        // pooled client's own timeout is seconds longer than any budget worth
        // having -- so without this a clean shutdown would still take the
        // keep-alive timeout, and the force path would be what actually ended it.
        if (this.#d.draining && this.#d.inflight === 0) this.closeIdleConnections();
      });
      void handler(req, res);
    });

    // Armed on `listening`, not in the constructor: a test that builds a server
    // and never binds it would otherwise leave a process-level listener behind,
    // and `process` has a default listener cap that turns that into a warning in
    // exactly the suite trying to prove shutdown is clean. The gap between
    // `listen()` and this event is a microsecond with no client in it.
    this.once('listening', () => {
      this.#armSignals();
    });
  }

  get inflight(): number {
    return this.#d.inflight;
  }

  get draining(): boolean {
    return this.#d.draining;
  }

  get sessions(): number {
    return this.#d.rt.sessions.size;
  }

  get uptimeMs(): number {
    return Date.now() - this.#d.startedAt;
  }

  /**
   * Stop accepting, with no deadline. Same contract as `Server#close` -- the
   * callback fires when the last connection has gone -- plus the drain flag, so
   * a request arriving on a keep-alive connection is refused rather than served
   * after shutdown began. `closeGracefully` is the bounded version; this one is
   * for a caller that knows its connections will end.
   */
  override close(callback?: (err?: Error) => void): this {
    this.#d.draining = true;
    this.#detachSignals();
    return super.close(callback);
  }

  /**
   * Bounded graceful shutdown: stop accepting, let in-flight requests finish,
   * and if the budget expires, destroy what is left.
   *
   * The deadline is the feature, not defensive programming. `Server#close`
   * waits on every connection, and one client holding an SSE stream open -- or
   * a keep-alive connection that never closes -- means its callback never fires.
   * That is the classic "the proxy hangs forever on Ctrl-C" bug, and a shutdown
   * that can hang is worse than one that truncates: the operator's only
   * remaining move is SIGKILL, which skips the flush the drain was for.
   */
  closeGracefully(opts: { readonly drainMs?: number } = {}): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    const budget = Math.max(0, opts.drainMs ?? this.#d.drainMs);
    this.#closePromise = new Promise<void>((resolve) => {
      let settled = false;
      // `finish` reads `timer` before the declaration below; every call site is
      // after it, including `Server#close`, whose callback Node may invoke
      // synchronously when the server was never listening.
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#detachSignals();
        resolve();
      };
      const timer = setTimeout(() => {
        fail(
          this.#d,
          'shutdown_forced',
          `drain budget of ${budget}ms expired with ${this.#d.inflight} in-flight; sockets destroyed`,
          false,
        );
        for (const socket of this.#sockets) socket.destroy();
        this.#sockets.clear();
        this.closeAllConnections();
        finish();
      }, budget);
      // Unref'd: a pending drain must never be the reason the process stays up.
      timer.unref();
      this.close(() => finish());
    });
    return this.#closePromise;
  }

  shutdown(reason: string): Promise<void> {
    this.#d.rt.opts.telemetry?.({
      type: 'error',
      runId: 'unknown',
      stage: 'pin',
      code: 'shutdown_started',
      message: reason,
      failedOpen: false,
    });
    return this.closeGracefully();
  }

  /**
   * Install SIGINT/SIGTERM handlers that drain, then exit.
   *
   * Re-armed on every `listening` and detached on every close, so a long-lived
   * process that restarts a listener does not accumulate process-level handlers.
   */
  #armSignals(): void {
    if (this.#signalHandlers.size > 0) return;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const onSignal = (): void => {
        void this.shutdown(signal).then(() => {
          process.exit(0);
        });
      };
      this.#signalHandlers.set(signal, onSignal);
      process.once(signal, onSignal);
    }
  }

  /** Detach, so a closed gateway does not keep a process-level listener alive. */
  #detachSignals(): void {
    for (const [signal, handler] of this.#signalHandlers) process.off(signal, handler);
    this.#signalHandlers.clear();
  }
}

export function createGateway(opts: GatewayOptions): Gateway {
  const provider: ConfigProvider = isConfigProvider(opts.provider) ? opts.provider : 'anthropic';
  const d: Dispatcher = {
    rt: {
      opts,
      provider,
      adapter: resolveAdapter(provider, opts.adapters),
      sessions: new Map<string, Session>(),
      // Byte-identical to the digest `verifyPinIntegrity` computes, so a health
      // check and a step-4c gate agree by construction rather than by convention.
      policyHash: sha256(pinSetText(opts.policy).join('\n')),
    },
    server: undefined as unknown as Gateway,
    drainMs: opts.drainMs ?? DEFAULT_DRAIN_MS,
    startedAt: Date.now(),
    inflight: 0,
    draining: false,
    noteInflight: (delta) => {
      d.inflight += delta;
    },
  };

  const server = new GatewayHttpServer(d, (req, res) => {
    void (async () => {
      try {
        await route(req, res, d);
      } catch (err) {
        // The last line of defence. Everything above is written not to throw;
        // a throw that lands here is a bug, and a bug in a long-lived proxy
        // must not take down the process with every other in-flight request.
        fail(d, 'unhandled', detailOf(err), true);
        if (!res.headersSent) {
          sendJson(res, 502, { error: 'gateway_failed_open', detail: detailOf(err) });
        } else {
          res.end();
        }
      }
    })();
  });

  return server;
}
