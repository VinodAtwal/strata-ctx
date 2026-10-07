import { Server, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Readable } from 'node:stream';
import type { ContextState, LossyStage, LossyStageName, PinDefect, StageName, StrataPolicy, TelemetryEvent } from '@strata-ctx/core-types';
import {
  enforcePins,
  type PinApplication,
  pinDrift,
  pinSetText,
  runId,
  sha256,
  StrataPolicySchema,
} from '@strata-ctx/core-types';
import {
  asStageCode,
  runPipeline,
  runTier0,
  type StageErrorCode,
  type Tier0Result,
} from '@strata-ctx/pipeline';
import type { AsyncLossyStage, PendingArtifact } from '@strata-ctx/pipeline';
import { ArtifactStore } from '@strata-ctx/security';
import { DEFAULT_TAIL_BYTES, pipeSseUpstream } from './sse.js';
import { ollamaClientFromFetch, type NarrationConfig } from './ollama-adapter.js';
import { runTier3 } from './tier3.js';
import {
  isConfigProvider,
  matchRoute,
  resolveAdapter,
  type AdapterTable,
  type ConfigProvider,
} from './routing.js';

/**
 * Resolve pin-drift defects to the policy ids of the constraints involved.
 *
 * The drift detector works in text, because that is what the pin buffer holds,
 * but the telemetry event's field is `constraintIds`. Reporting the text there
 * -- truncated to fit, as this once did -- put cut-off prose in a field callers
 * are meant to join against, and the truncation meant the value matched
 * nothing: not the policy, not another event, not a digest.
 *
 * Defects whose text is not a policy constraint are dropped from the list.
 * They are inbound governance we did not author, so there is no id to report,
 * and inventing one would be a worse lie than an empty list. The event still
 * fires, so their occurrence remains countable.
 */
function driftConstraintIds(
  defects: readonly { readonly kind: PinDefect; readonly text: string }[],
  policy: StrataPolicy,
): string[] {
  const idByText = new Map<string, string>();
  for (const constraint of policy.constraints) {
    if (!idByText.has(constraint.text)) idByText.set(constraint.text, constraint.id);
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const defect of defects) {
    const id = idByText.get(defect.text);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

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
   * The lossy stages the tunnel runs after Tier 0 -- `compact`, `compress`, and
   * whatever a workstream attaches later. Supplied, never imported: the
   * implementations live in packages this one does not depend on, so the
   * composition root (`tools/dev.ts`) builds them and hands them in, the same
   * way `adapters` carries providers this build cannot link statically
   * (AGENTS.md §7 -- a fourth cross-stream edge needs the owner, so there is
   * not one).
   *
   * Two gates decide whether an entry runs, and neither is this option's. The
   * name must appear in `policy.pipeline.stages`, which is the operator's
   * switch and makes the remedy in `stageFailureMessage` literally true. And
   * Tier 0 names are refused outright at construction: `runTier0` has already
   * run dedupe, truncate and triage over this same state, and a second
   * truncate pass would see a context that had already been capped and could
   * drop content the first pass deliberately kept.
   *
   * Omitting this is "no lossy stages in the tunnel", which is what the tunnel
   * passed explicitly before it existed. Whether `compact` *fires* is
   * `policy.pipeline.compaction` and the trigger inside the stage; the
   * gateway's job is the registry and the order, both of which it owns.
   */
  readonly lossyStages?: Readonly<Partial<Record<LossyStageName, LossyStage | AsyncLossyStage>>>;
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
  /**
   * Tier 3, opt-in. Absent means off, and the policy's
   * `pipeline.tokenCompression` is the other half of the switch: this supplies the
   * model, that says whether to run it. Both must agree, so an operator who sets
   * the policy field without supplying a config gets a hold rather than a model
   * call made with a default they never chose.
   */
  readonly narration?: NarrationConfig;
  /** Injected so the Tier 3 tests do not reach a socket. Defaults to `fetch`. */
  readonly narrationFetch?: typeof fetch;
  /**
   * Where `artifact://` pointers go. Absent means pointer-ization is off.
   *
   * Not a default for convenience. A pointer replaces a file read's text with a
   * URI, and that URI is only worth anything if something can resolve it -- so
   * a gateway with no store configured must not mint them, which is why this
   * feeds `runTier0`'s `durable` flag rather than being a fallback path inside
   * the store. With no root, oversized reads take the byte cap instead: still
   * lossy, but the loss is visible in a report instead of silent in a URI.
   */
  readonly artifactRoot?: string;
  /**
   * Where `STRATA_ARTIFACT_ROOT` is read from. Defaults to `process.env`.
   *
   * Injectable so resolution is testable: a suite that exported the variable to
   * prove the wiring would mutate process state shared with every other test in
   * the run. `artifactRoot` still wins over it -- this is the same precedence
   * `CredentialSource` uses, and the same reason: an explicit option is a
   * decision, an env var is a default.
   */
  readonly env?: Record<string, string | undefined>;
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
  /**
   * The artifact store, opened once and reused.
   *
   * Memoized as a promise rather than a value because `ArtifactStore.open`
   * creates directories and resolves the root's real path; doing that per
   * request would be a filesystem round trip on the hot path, and doing it at
   * startup would make an unreachable root a boot failure for a gateway whose
   * default configuration never uses the store at all.
   */
  artifacts(): Promise<ArtifactStore>;
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

/* ------------------------------------------------------------------ failures
 *
 * P0-1. Three things used to be wrong about every failure this file reported,
 * and all three made `strata status`'s `errors.byStage` and `perRequest.byRun`
 * unreadable:
 *
 * 1. `runId` was the literal `'unknown'` for every failure, so no error could be
 *    joined to the run that produced it. It is now the run's real id, or the
 *    `NO_RUN` sentinel when no run existed yet.
 * 2. `stage` was the literal `'pin'` for every failure. A stage that threw, a
 *    body that was too large, an unreachable upstream and a forced shutdown all
 *    landed in the bucket of the one stage whose failure is a safety signal --
 *    so `byStage.pin` counted things that had nothing to do with pinning, and
 *    `byStage.truncate` was silently always zero.
 * 3. The cause was flattened. `stage_threw`, `prefix_reordered` and
 *    `not_a_lossy_context` all arrived as one `code` with the real cause stuffed
 *    into `message`, where no dashboard can reach it.
 *
 * ## The sentinels, and why they are not `undefined`
 *
 * Two failures genuinely have no run and no stage: a request the gateway refuses
 * before it can parse it, and a lifecycle event with no request at all. Inventing
 * a value for either would put the lie back, so both are named:
 *
 * - `NO_RUN` says *there was no run*, where `'unknown'` claimed there was one and
 *   the gateway had lost track of it. `EMPTY_STATE` above already mints
 *   `runId('none')` for the same reason.
 * - `NO_STAGE` is the honest part and the dishonest part, and it needs stating
 *   plainly. `TelemetryEvent`'s `error.stage` is `StageName`, a closed
 *   seven-member set in the frozen contract
 *   (`packages/core-types/src/policy.ts` -- `StageNameSchema`), and it has no
 *   member meaning "not a stage". `stage: 'unknown'` does not compile against
 *   the frozen type, so a truthful sentinel is not available without unfreezing
 *   the contract (AGENTS.md §1, §10).
 *
 *   `serialize` is the deliberate pick and it is a bucket, not a claim. It is the
 *   one member of the set that names the gateway's own request/response plumbing
 *   rather than a transform of the context, which is true of the four
 *   request-refusal codes below and is the least misleading home for the
 *   lifecycle codes. What it does *not* claim is that the egress adapter ran and
 *   failed: `errors.byCode` is what separates the two populations in this
 *   bucket, and `adapter_unavailable` -- which genuinely *is* a serialize-stage
 *   failure -- reports its own condition there. **When `StageNameSchema` gains a
 *   non-stage member, this constant is the only thing that changes.**
 *
 * ## What is deliberately not here
 *
 * A serialised exception. `code` is a closed set (below) and `StageErrorCode` is
 * forwarded rather than rebuilt, so nothing a stage threw can become a code.
 * `message` is composed from constants, a stage name, a provider name and a
 * citation; the four codes that already quoted `detailOf(err)` keep doing so, in
 * a `cause:` tail, because removing an operator's only view of the underlying
 * error is a worse trade than keeping text that `telemetry/src/redact.ts` already
 * scrubs on the way into every sink.
 */

/** The closed set of codes this file can emit. Anything else is a bug here. */
type GatewayFailureCode = StageErrorCode | RequestFailureCode;

/**
 * Codes for conditions that are not a pipeline stage's fault. Each one is a
 * single condition with a single remedy, which is the property the whole set is
 * built for: two conditions under one code means an operator has to read prose to
 * tell them apart, and prose is not a thing a monitor can count.
 */
type RequestFailureCode =
  /** The provider this build routes to has no adapter registered. A build/config gap. */
  | 'adapter_unavailable'
  /** The client sent more than `MAX_BODY_BYTES`. Refused before parsing. */
  | 'body_too_large'
  /** The body is not JSON. The provider would reject it too. */
  | 'bad_request'
  /** The upstream could not be reached. No fail-open: there is nowhere to fail open to. */
  | 'upstream_unreachable'
  /** A `artifact://` pointer was not backed by bytes on disk. See `persistPending`. */
  | 'artifact_write_refused'
  /** The request pipeline raised; the original bytes went upstream unprocessed. */
  | 'pipeline_failed_open'
  /** An exception escaped the whole request handler. A bug in the gateway. */
  | 'unhandled'
  /** `shutdown()` was called. Lifecycle, not a request. */
  | 'shutdown_started'
  /** The drain budget expired and sockets were destroyed. Lifecycle, not a request. */
  | 'shutdown_forced';

/** See the block comment above: no run existed when this failed. */
const NO_RUN = 'no-run';

/** See the block comment above: no stage owns this. Retire when `StageNameSchema` allows. */
const NO_STAGE: StageName = 'serialize';

/**
 * Where a failure happened and which run it belongs to.
 *
 * Mutable, and updated in place as a request advances, because the alternative is
 * every intermediate function returning a pair nobody else needs. One object per
 * request, created in the request wrapper -- deliberately not a field on
 * `Dispatcher`, where two in-flight requests would write each other's
 * attribution and a `by run` summary would be a coin toss.
 */
interface Attribution {
  runId: string;
  stage: StageName;
}

const attribute = (where: Attribution, stage: StageName, runId?: string): void => {
  where.stage = stage;
  if (runId !== undefined) where.runId = runId;
};

/**
 * The attribution for an event that belongs to the process rather than to a
 * request: both sentinels, said out loud.
 *
 * Frozen and shared, which is safe precisely because no request ever touches it
 * -- `fail` only reads. The per-request `Attribution` is the opposite: mutable,
 * one per request, never on the dispatcher.
 */
const LIFECYCLE: Attribution = Object.freeze({ runId: NO_RUN, stage: NO_STAGE });

/**
 * The one place an `error` event is emitted from.
 *
 * `where` is a parameter rather than something `fail` infers, because inference
 * is what produced the bug: there is no honest default for either field, and a
 * default that has to be overridden at every call site is a default that will be
 * forgotten at the thirteenth.
 */
const fail = (
  d: Dispatcher,
  where: Attribution,
  code: GatewayFailureCode,
  message: string,
  failedOpen: boolean,
): void => {
  d.rt.opts.telemetry?.({ type: 'error', runId: where.runId, stage: where.stage, code, message, failedOpen });
};

/**
 * Where each remedy points.
 *
 * Every one of these is checked against the tree by
 * `packages/gateway/test/server.test.ts` -- the file has to exist and the symbol
 * has to still be declared in it -- because a citation that has rotted is worse
 * than none. It sends an operator to the right file and the wrong function, and
 * it looks right while doing it. The line number is here because
 * `docs/operations.md` Factor 6 asks for a file *and line*; the symbol is here
 * because AGENTS.md §9 records that line numbers rot, so the test asserts on the
 * symbol and the line is only ever the hint.
 */
const REMEDY = {
  bodyCeiling: { at: 'packages/gateway/src/server.ts:172', symbol: 'MAX_BODY_BYTES' },
  jsonParse: { at: 'packages/gateway/src/server.ts:691', symbol: 'JSON.parse(body.text)' },
  upstreamFetch: { at: 'packages/gateway/src/server.ts:579', symbol: 'upstream = await fetch' },
  adapterResolution: { at: 'packages/gateway/src/routing.ts:137', symbol: 'resolveAdapter' },
  lossyFailOpen: { at: 'packages/pipeline/src/order.ts:144', symbol: 'runStageFailOpen' },
  totalFailOpen: { at: 'packages/pipeline/src/runner.ts:235', symbol: 'isolateTotal' },
  ingressPipeline: { at: 'packages/gateway/src/server.ts:637', symbol: 'handleIngress' },
  lastDefence: { at: 'packages/gateway/src/server.ts:1394', symbol: "'unhandled'" },
  drainBudget: { at: 'packages/gateway/src/server.ts:1226', symbol: "'shutdown_forced'" },
} as const;

/** `file:line (symbol)` -- the shape operations.md Factor 6 asks for. */
const cite = (anchor: { readonly at: string; readonly symbol: string }): string =>
  `${anchor.at} (${anchor.symbol})`;

const isLossyStageName = (stage: StageName): stage is LossyStageName => stage !== 'pin' && stage !== 'serialize';

/**
 * One message per cause, with the remedy in it.
 *
 * `docs/operations.md` Factor 6: "a refusal that does not name the knob that
 * changes it is a dead end." `docs/maturity.md` records the same gap as unsatisfied
 * across all cases. So every string here names either a config knob an operator
 * can turn or the file and line to read -- and the stage is named in the prose,
 * because `stage_failed_open` used to put the stage in the `code` and nothing
 * else, which is a fact no monitor can group on.
 *
 * Two parts, and they are not interchangeable. The knob is what an operator with
 * a running gateway acts on (`policy.pipeline.stages` removes a stage from the
 * run without a rebuild). The citation is what a developer follows when the knob
 * is not the answer.
 */
const stageFailureMessage = (stage: StageName, code: StageErrorCode): string => {
  const where = isLossyStageName(stage) ? REMEDY.lossyFailOpen : REMEDY.totalFailOpen;
  const what: Record<StageErrorCode, string> = {
    stage_threw: `${stage} raised, so its output was discarded and its input went upstream unmodified: this context was NOT ${stage === 'truncate' ? 'truncated' : stage === 'dedupe' ? 'deduped' : stage === 'triage' ? 'triaged' : 'transformed'}`,
    prefix_reordered: `${stage} moved a cacheable block inside the provider's cached prefix, so the prompt cache was destroyed for the rest of this prefix (decisions R4) and the stage was reverted`,
    not_a_lossy_context: `${stage} returned something that is not a LossyContext, so its declared return type is wrong and its output was discarded`,
    not_a_context_state: `${stage} returned something that is not a ContextState, so its declared return type is wrong and its output was discarded`,
    unrecognised_stage_code: `${stage} failed with a cause this gateway does not recognise, so the real condition was not reported`,
  };
  return (
    `${what[code]}. Remedy: drop "${stage}" from policy.pipeline.stages to stop it running, ` +
    `or fix the stage; fail-open was decided in ${cite(where)}.`
  );
};

/**
 * The turn-level report: the pipeline raised and the original bytes went upstream.
 *
 * Deliberately one code rather than one per phase. The `stage` field already says
 * which phase -- that is what it is for, and adding `parse_failed` /
 * `tier0_failed` would be a second answer to a question the event already
 * answers. What this code adds is the one thing the stage cannot: that the
 * request was forwarded *unprocessed*, which is degradation the caller never
 * sees.
 */
const pipelineFailureMessage = (err: unknown, stage: StageName): string => {
  const scope = stage === NO_STAGE ? 'no stage owns this failure' : `it failed in "${stage}"`;
  return (
    `the request pipeline raised (${scope}), so the original request body was forwarded upstream ` +
    `unprocessed and no pin or tier cap was applied to it. Remedy: read the stage named above -- the ` +
    `ingress pipeline runs in ${cite(REMEDY.ingressPipeline)} -- and fix it, or set ` +
    `policy.governance.pinning to "off" so the log stops implying a guarantee it did not apply. ` +
    `(cause: ${detailOf(err)})`
  );
};

/**
 * Write what a Tier 0 run pointer-ized, or say why it could not.
 *
 * The URI in the pointer was minted by the pipeline before anything reached
 * disk, from the digest the producer put on the block. `ArtifactStore.put`
 * digests what it *stored*, so the two agree only when that declared digest was
 * the digest of the block's text and redaction left the bytes untouched. Either
 * way the object is filed under a URI nothing in the transcript points at, and
 * publishing the pointer would trade a large inline read for a reference that
 * cannot be followed -- so a mismatch is a refusal, not a warning. The
 * mismatching URI is returned either way; it names the block to look at.
 *
 * Exported because the guarantee is only worth something if it can be exercised
 * against a real store on a real filesystem -- a mock that records `put` calls
 * passes whether or not the URI it was handed actually resolves.
 */
export async function persistPending(
  store: ArtifactStore,
  pending: readonly PendingArtifact[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (const item of pending) {
    let landed: string;
    try {
      landed = (await store.put(item.text, item.kind)).uri;
    } catch (e) {
      return {
        ok: false,
        reason: `artifact write failed for ${item.uri}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (landed !== item.uri) {
      return {
        ok: false,
        reason:
          `pointer ${item.uri} does not name the object that was stored (${landed}); either the ` +
          `block's declared digest was not the digest of its text, or redaction changed the content`,
      };
    }
  }
  return { ok: true };
}

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
  where: Attribution,
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
    //
    // `where.runId` is the request's real run when Tier 0 got far enough to mint
    // one, and `NO_RUN` when it did not -- either is a fact, where the old
    // `'unknown'` was a guess that happened to be true of neither.
    attribute(where, NO_STAGE);
    fail(
      d,
      where,
      'upstream_unreachable',
      `the provider at ${d.rt.opts.upstream} could not be reached, so the request did not happen at all -- ` +
        `the context is not lost, there is simply no answer. Remedy: check that the provider is up and ` +
        `that GatewayOptions.upstream is the URL you meant; the fetch is at ${cite(REMEDY.upstreamFetch)}. ` +
        `(cause: ${detailOf(err)})`,
      false,
    );
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
  where: Attribution,
  sessionId: string,
): Promise<void> => {
  const adapter = d.rt.adapter;
  if (adapter === undefined) {
    // 501, not 404 and not 502: the route exists, the operator asked for a
    // provider this build has no adapter for, and that is fixable by config.
    //
    // `serialize` is the truthful stage here and not the NO_STAGE bucket: the
    // egress adapter *is* the serialize stage, and it is missing. Nothing ran,
    // so `runId` stays `NO_RUN`.
    attribute(where, 'serialize');
    fail(
      d,
      where,
      'adapter_unavailable',
      `this build routes provider "${d.rt.provider}" but no adapter is registered for it, so no request ` +
        `in this provider's wire format can be served. Remedy: pass one in GatewayOptions.adapters, or ` +
        `set GatewayOptions.provider to a provider this build has an adapter for; adapters are resolved ` +
        `at ${cite(REMEDY.adapterResolution)}.`,
      false,
    );
    sendJson(res, 501, {
      error: 'adapter_unavailable',
      detail: `no adapter is registered for provider "${d.rt.provider}"`,
      provider: d.rt.provider,
    });
    return;
  }

  const body = await readBody(req);
  if (!body.ok) {
    // Refused while reading, so no bytes of this request were ever interpreted.
    attribute(where, NO_STAGE);
    fail(
      d,
      where,
      'body_too_large',
      `the client sent more than the ${MAX_BODY_BYTES}-byte request ceiling, so the body was abandoned ` +
        `mid-read and never parsed. Remedy: send a smaller request, or raise MAX_BODY_BYTES at ` +
        `${cite(REMEDY.bodyCeiling)} -- it is 64 MiB because image-bearing requests are the only thing ` +
        `expected to be large and they have not been measured yet (TODO(WS-A, A-7)).`,
      false,
    );
    sendJson(res, 413, { error: 'payload_too_large', limit: MAX_BODY_BYTES });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text) as unknown;
  } catch (err) {
    // 400 and not 502: the provider would reject this too, and answering here
    // costs a round trip instead of a token spend.
    attribute(where, NO_STAGE);
    fail(
      d,
      where,
      'bad_request',
      `the request body is not JSON, so it was refused before any stage ran and never reached the ` +
        `provider. Remedy: fix the client that sent it; the gateway parses the body at ` +
        `${cite(REMEDY.jsonParse)}. (cause: ${detailOf(err)})`,
      false,
    );
    sendJson(res, 400, { error: 'bad_request', detail: 'request body is not valid JSON' });
    return;
  }

  const session = touchSession(d, sessionId);
  const t0 = performance.now();

  let state: ContextState;
  let expected: readonly string[];
  let outbound: unknown;
  let blocksIn = 0;
  // Declared outside the `try` because the telemetry below reads it, and it is
  // read after the stages have run. Initialised to a zero-delta result rather
  // than left undefined so the telemetry loop is unconditional: a stage that
  // never ran must not be silently reported as a stage that ran and saved
  // nothing.
  let tier0Run: Tier0Result | null = null;
  try {
    // Wall-clock, not a turn counter: the second argument is the block
    // timestamp. `ContextState.turn` belongs to the ingress adapter and the
    // pipeline, and the pre-A-7 code passed `priorTurn + 1` here, which was a
    // monotonic id in a field documented as an epoch millisecond. The value
    // never reaches the wire -- `fromCanonical` does not emit `ts` -- so this
    // stays byte-identical for a given input either way.
    // TODO(WS-A, A-8): make the turn counter actually advance; nothing in
    // Wave 0 owns it yet.
    //
    // The stage is set *before* the call, not after: a `toCanonical` that raises
    // is a `serialize` failure, and attributing it to the stage it was about to
    // enter is the whole point of threading the context. The runId comes after,
    // because `toCanonical` is what mints it -- before it, the truth is `NO_RUN`.
    attribute(where, 'serialize');
    const before = adapter.toCanonical(parsed, Date.now());
    where.runId = before.runId;
    blocksIn = before.messages.length;

    // Tier 0 (partition -> dedupe, truncate, triage -> restore) -> pin.
    //
    // `runTier0` does the partition and restore internally, so this replaces
    // both rather than wrapping them; running them here as well would apply
    // partition twice and the second pass would see a context already restored.
    //
    // Pinning stays last, and that is not incidental. The stages above are lossy,
    // and a pin restored before them could be dropped by the very next stage --
    // which would make the safety claim true in a test that never compacts and
    // false in the only place it matters. Order is a safety property
    // (docs/architecture.md §4), which is why `runTier0` takes the stage order
    // from `TIER0_STAGE_ORDER` and reports `policyOrderIgnored` rather than
    // obeying a config file that reorders it.
    //
    // Whether the stages run at all is the policy's call, not this file's: the
    // default policy lists all three, so a default gateway compresses. That was
    // already the documented intent -- `order.ts` describes Tier 0 as running on
    // every outbound request -- and this request path was simply not honoring it.
    const durable = d.rt.opts.artifactRoot !== undefined;
    // `NO_STAGE`, and deliberately not `dedupe`. `runTier0` isolates each of its
    // three stages itself, so anything that reaches the catch below left the
    // runner, not a stage -- and guessing one of the three would send an
    // operator to a stage that worked. `NO_STAGE` says the truth and the code
    // still says it was the pipeline.
    attribute(where, NO_STAGE, before.runId);
    let tier0 = runTier0(before, d.rt.opts.policy, { durable });
    if (tier0.pending.length > 0) {
      // Tier 0 is synchronous, so the bytes it dropped are already out of the
      // messages and nothing has written them yet. Until this returns, the
      // state about to be published is a set of pointers to nothing.
      //
      // `truncate` is the truthful stage, not a guess: `pointer.ts` runs inside
      // the truncate stage and `runTier0` is the only producer of `pending`.
      attribute(where, 'truncate', before.runId);
      let refusal: string | undefined;
      try {
        const store = await d.rt.artifacts();
        const outcome = await persistPending(store, tier0.pending);
        if (!outcome.ok) refusal = outcome.reason;
      } catch (e) {
        refusal = `artifact store unavailable: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (refusal !== undefined) {
        fail(
          d,
          where,
          'artifact_write_refused',
          `${refusal}. Remedy: the pointer was not published and the read stayed inline, so no context was ` +
            `lost -- check GatewayOptions.artifactRoot is a writable directory, or leave it unset to take ` +
            `the byte cap instead of pointer-ization.`,
          true,
        );
        // Re-run rather than un-pointer-ize what came back: the cap stage has
        // already run, and putting the text back afterwards would leave an
        // oversized block past its cap with nothing downstream to catch it. A
        // second Tier 0 from the same input is cheap, deterministic, and yields
        // metrics for the context that is actually sent -- the refused run's
        // savings never happened, so they are not reported.
        tier0 = runTier0(before, d.rt.opts.policy, { durable: false });
      }
    }
    // The tunnel: everything after Tier 0 that this package does not own, run
    // through the generic runner so the seam exists in production (C-13).
    //
    // The registry is built here rather than passed through, and both halves of
    // it are load-bearing.
    //
    // An explicit object is always passed, never omitted: `runPipeline`
    // defaults to the full `LOSSY_TIER0_STAGES` registry when the field is
    // absent, and Tier 0 has already run above. Omitting it would run dedupe,
    // truncate and triage a second time over an already-restored state. That is
    // not a duplicate costing tokens; a second truncate pass sees a context that
    // has already been capped and could drop content the first pass deliberately
    // kept.
    //
    // What the caller injected is then intersected with `policy.pipeline.stages`.
    // The runner does not read that list -- its only gate is whether a name is
    // in the registry it was handed -- so without this an operator who removed
    // "compact" from the policy would still get compaction from whoever composed
    // the gateway, and the remedy `stageFailureMessage` prints ("drop X from
    // policy.pipeline.stages") would be advice that does nothing. Tier 0 names
    // cannot reach here at all: `createGateway` refuses them at construction.
    //
    // `pin` is adapted from `enforcePins` because the two signatures disagree.
    // `TotalStage.run` returns a `ContextState`; `enforcePins` returns a
    // `PinApplication` that also carries `expected` and `inboundGovernance`,
    // which the drift telemetry below needs. Rather than widen the frozen
    // `TotalStage` port or add a second return channel to it, the adapter
    // stashes the application on the way past. One implementation, two views --
    // the same concession `runner.ts` makes when it projects `LossyStage` onto
    // `Tier0Stage`.
    //
    // A pin that does not run is NOT allowed to pass silently, and the reason is
    // specific to this stage. The other stages here may revert to their input
    // because their input is a superset: a truncated context still holds the
    // content, just uncapped. Reverting `pin` loses the constraint text the
    // policy declares, so a request would go out missing a hard-safety pin
    // while reporting success and `x-strata-pinned: 1`. It is not that the
    // revert strips governance -- `isolateTotal` hands back pin's input, and
    // `restoreHeld` has already put the inbound governance blocks back in it.
    // What is missing is the pin, which is synthesized and exists nowhere else.
    //
    // Failing the turn instead of shipping it is not strictly better on content:
    // the outer catch forwards the original bytes, which carry no pin either.
    // It is better on honesty. The turn reports `pipeline_failed_open` with the
    // real cause and sets `x-strata-fail-open: 1`, so an operator sees a broken
    // pin instead of a request that quietly lost one. Without this guard the
    // next line throws a TypeError on `pinned.expected` and lands in the same
    // catch reporting "cannot read properties of undefined" -- which attributes
    // a pin failure to something that is not the pin.
    //
    // `onStage` is what makes the cause reportable. `runPipeline` isolates
    // the stage and keeps going, so without this hook a pin that failed open is
    // indistinguishable from the turn-level catch below: one code, one stage,
    // and the typed cause -- `stage_threw` vs `not_a_context_state` -- discarded.
    // Two events for one failure is the right count, not double-counting: the
    // stage event says which stage is broken and how, the turn event says the
    // request went upstream with no pin on it. They have different remedies.
    let pinned: PinApplication | undefined;
    attribute(where, 'pin', before.runId);
    const enabled = new Set<StageName>(d.rt.opts.policy.pipeline.stages);
    const registry: Partial<Record<LossyStageName, LossyStage | AsyncLossyStage>> = {};
    for (const [name, stage] of Object.entries(d.rt.opts.lossyStages ?? {})) {
      if (stage === undefined || !enabled.has(name as StageName)) continue;
      registry[name as LossyStageName] = stage;
    }
    const tunnel = await runPipeline(tier0.state, {
      policy: d.rt.opts.policy,
      lossyStages: registry,
      totalStages: {
        pin: {
          name: 'pin',
          run: (s) => {
            pinned = enforcePins(s, d.rt.opts.policy);
            return pinned.state;
          },
        },
      },
      onStage: (result) => {
        const code = asStageCode(result.code);
        if (code === undefined) return;
        // Attribution follows the stage that failed. One
        // `attribute(where, 'pin')` above would have filed every tunnel failure
        // under pin while the tunnel held a single stage; with `compact` and
        // `compress` in it, that sends an operator to the one stage that worked.
        attribute(where, result.name, before.runId);
        fail(d, where, code, stageFailureMessage(result.name, code), true);
      },
    });
    if (pinned === undefined) {
      throw new Error('pin stage did not run: enforcePins threw or the tunnel returned a non-ContextState');
    }
    state = tunnel.state;
    expected = pinned.expected;
    tier0Run = tier0;

    // Drift is measured against what we sent last turn, not against policy: on
    // turn 1 nothing was sent, and "everything is missing" is not a finding.
    if (session.lastSent.length > 0) {
      const drift = pinDrift(session.lastSent, pinned.inboundGovernance);
      if (!drift.ok) {
        d.rt.opts.telemetry?.({
          type: 'violation',
          runId: state.runId,
          kind: 'pin_missing_pre_apply',
          constraintIds: driftConstraintIds(drift.defects, d.rt.opts.policy),
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

    // Per-stage telemetry, emitted for every stage that actually ran and not
    // for the ones policy left out. `runTier0` already measured each stage, so
    // re-measuring here would be a second implementation of the same number;
    // these are the numbers the pipeline produced.
    //
    // Without this the lossy half of the product is invisible: a gateway that
    // compressed 40k tokens to 6k and one that forwarded both unchanged emit an
    // identical `request_in`, and the operator has no way to tell which is
    // running. Emitted after the stages and before the response goes out, so a
    // telemetry sink that throws cannot cost the request -- the catch below
    // fails the whole turn open, and losing the user's context to a logging
    // failure is precisely the trade this design refuses to make.
    for (const stageRun of tier0Run.runs) {
      d.rt.opts.telemetry?.({
        type: 'stage',
        runId: state.runId,
        stage: stageRun.name,
        bytesIn: stageRun.telemetry.bytesIn,
        bytesOut: stageRun.telemetry.bytesOut,
        blocksIn: stageRun.telemetry.blocksIn,
        blocksOut: stageRun.telemetry.blocksOut,
        durationMs: stageRun.telemetry.durationMs,
        changed: stageRun.telemetry.changed,
      });
      // A stage that failed open is reported with its cause, not flattened into
      // one code: the context went upstream unmodified, so a report that counted
      // it as a reduction would be claiming work that did not happen -- and a
      // report that called three different failures `stage_failed_open` would be
      // claiming a cause it does not know. `asStageCode` is the pipeline's own
      // closed set, so `stage_threw`, `prefix_reordered` and `not_a_lossy_context`
      // stay three counts here and a code this gateway has never heard of
      // becomes `unrecognised_stage_code` rather than a throw.
      if (stageRun.failedOpen) {
        const code = asStageCode(stageRun.code);
        if (code !== undefined) {
          attribute(where, stageRun.name, state.runId);
          fail(d, where, code, stageFailureMessage(stageRun.name, code), true);
        }
      }
    }
    if (tier0Run.prefixInvalidated) {
      // R4: moving or editing a cacheable block destroys the economics of the
      // whole system, so it is reported rather than absorbed.
      d.rt.opts.telemetry?.({
        type: 'cache',
        runId: state.runId,
        prefixHit: false,
        prefixInvalidated: true,
      });
    }

    // Tier 3. Opt-in twice over: the operator named a model in the config *and*
    // set `tokenCompression: 'local'`. `state` is the post-Tier-0 context, so the
    // span narrated is the one the next turn will actually be answered from.
    //
    // `compress` because that is this stage's slot in `PIPELINE_STAGE_ORDER` and
    // a failure here has to be attributed to something that ran.
    attribute(where, 'compress', state.runId);
    if (d.rt.opts.policy.pipeline.tokenCompression === 'local') {
      await runTier3({
        state,
        policy: d.rt.opts.policy,
        policyTokens: tier0.tokensAfter,
        config: d.rt.opts.narration,
        client:
          d.rt.opts.narration === undefined
            ? undefined
            : ollamaClientFromFetch(d.rt.opts.narrationFetch ?? fetch),
        telemetry: d.rt.opts.telemetry,
      });
    }

    attribute(where, 'serialize', state.runId);
    outbound = adapter.fromCanonical(state, parsed);
  } catch (err) {
    // Fail open, and fail open *properly*: the original bytes go upstream
    // untouched. Losing the user's context to save tokens is unacceptable, and a
    // gateway that 500s is a gateway the agent routes around.
    //
    // `where` is whatever the request had reached, so this reports the stage that
    // raised rather than the one that happened to be hardcoded.
    fail(d, where, 'pipeline_failed_open', pipelineFailureMessage(err, where.stage), true);
    // The turn is not advanced: no canonical state was produced, so counting it
    // would leave the session claiming a turn that never happened.
    await forward(req, res, d, where, body.text, { 'x-strata-fail-open': '1' });
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

  await forward(req, res, d, where, JSON.stringify(outbound), { 'x-strata-pinned': String(expected.length) });
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
  where: Attribution,
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
      await handleIngress(req, res, d, where, sessionIdOf(req));
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
        // A lifecycle event: there is no request and therefore no run, and no
        // stage -- this is the process shutting down, not the pipeline. Reported
        // through `fail` so it is the one emit path, but with the sentinels said
        // out loud rather than dressed up as a pin failure on an unknown run.
        fail(
          this.#d,
          LIFECYCLE,
          'shutdown_forced',
          `the drain budget of ${budget}ms expired with ${this.#d.inflight} request(s) still in flight, so ` +
            `their sockets were destroyed and those callers got a truncated response. Remedy: raise ` +
            `GatewayOptions.drainMs (or pass a larger budget to closeGracefully), or find out which of ` +
            `the ${this.#d.inflight} caller(s) is holding a stream open; the budget is enforced at ` +
            `${cite(REMEDY.drainBudget)}.`,
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
    fail(
      this.#d,
      LIFECYCLE,
      'shutdown_started',
      `the gateway was asked to shut down (${reason}), so it stopped accepting connections and began ` +
        `draining. Remedy: this is not a fault -- if it was not expected, the caller holding the server ` +
        `called shutdown(); the drain budget is GatewayOptions.drainMs and the deadline is enforced at ` +
        `${cite(REMEDY.drainBudget)}.`,
      false,
    );
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

const ARTIFACT_ROOT_ENV = 'STRATA_ARTIFACT_ROOT';

/**
 * The artifact root this gateway will actually use, resolved once, at construction.
 *
 * Module-private because it is not a second API: `GatewayOptions.artifactRoot`
 * is the documented knob and this is only how it gets a value when the operator
 * did not supply one. Three sources, first usable wins:
 *
 *   1. `options.artifactRoot` -- an explicit option is a decision;
 *   2. `STRATA_ARTIFACT_ROOT` from `options.env ?? process.env` -- a default,
 *      and only a real one: empty and whitespace-only values are *unset*, so a
 *      `export STRATA_ARTIFACT_ROOT=` in a profile does not silently point the
 *      store at `''`;
 *   3. `undefined` -- pointer-ization stays off, which is the documented
 *      behaviour of a gateway with no root at all (see `GatewayOptions`).
 *
 * The result is folded back into the options the runtime reads, so both call
 * sites -- the `durable` flag on the request path and the memoized store open --
 * see one value and cannot disagree. Resolving here rather than in each site is
 * the point: reading `process.env` per request would make the mode depend on
 * when the request ran, and a store opened under one root and written under
 * another is a pointer to nowhere.
 */
const resolveArtifactRoot = (options: GatewayOptions): GatewayOptions => {
  const usable = (value: string | undefined): string | undefined =>
    value !== undefined && value.trim() !== '' ? value.trim() : undefined;
  const root = usable(options.artifactRoot) ?? usable((options.env ?? process.env)[ARTIFACT_ROOT_ENV]);
  return root === undefined ? options : { ...options, artifactRoot: root };
};

export function createGateway(options: GatewayOptions): Gateway {
  const opts: GatewayOptions = resolveArtifactRoot(options);
  const tier0Names = new Set<StageName>(['dedupe', 'truncate', 'triage']);
  for (const name of Object.keys(opts.lossyStages ?? {})) {
    if (tier0Names.has(name as StageName)) {
      // Loud at construction rather than silent per request. The alternative
      // -- filtering them out here -- would leave the caller believing a stage
      // they asked for is running while `runTier0` already ran it, which is the
      // duplicate-truncate hazard the tunnel comment at the registry warns
      // about, arrived at through a different door.
      throw new Error(
        `GatewayOptions.lossyStages: "${name}" already ran in Tier 0 and must not run again in the tunnel. ` +
          `Tier 0 stages are selected by policy.pipeline.stages; only the stages after pin are injected here.`,
      );
    }
  }
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
      artifacts: (() => {
        // Memoized as a promise, rejection included, so a root that cannot be
        // opened reports the same way on every request instead of paying for a
        // fresh `mkdir` each time and surfacing a different message.
        let opened: Promise<ArtifactStore> | undefined;
        return (): Promise<ArtifactStore> => {
          if (opts.artifactRoot === undefined) {
            // Only reachable if a caller asks for the store without configuring
            // a root, which the request path does not do -- it gates on the same
            // value. A default here would be the worst option: `ArtifactStore.open`
            // creates directories, so it would scatter `objects/`, `aliases/` and
            // `audit/` into whatever the process's working directory happens to be.
            return Promise.reject(new Error('no artifactRoot configured'));
          }
          opened ??= ArtifactStore.open({ root: opts.artifactRoot });
          return opened;
        };
      })(),
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
    // One attribution per request, allocated here so the last line of defence
    // can name the stage the request had reached instead of guessing. Not on
    // `Dispatcher`: two in-flight requests would write each other's attribution
    // and every `by run` summary would be a coin toss.
    const where: Attribution = { runId: NO_RUN, stage: NO_STAGE };
    void (async () => {
      try {
        await route(req, res, d, where);
      } catch (err) {
        // The last line of defence. Everything above is written not to throw;
        // a throw that lands here is a bug, and a bug in a long-lived proxy
        // must not take down the process with every other in-flight request.
        //
        // `where.stage === NO_STAGE` is the load-bearing part of the message: it
        // means the throw escaped before the request reached any stage, which is
        // a different bug from one raised inside the pipeline and is worth
        // saying rather than leaving the reader to guess from the code.
        const escapedStage = where.stage === NO_STAGE ? 'before any pipeline stage ran' : `in "${where.stage}"`;
        fail(
          d,
          where,
          'unhandled',
          `an exception escaped the request handler (${escapedStage}), which every layer above is written ` +
            `not to do -- this is a bug in the gateway, not in the request. Remedy: nothing was configured ` +
            `wrong and there is no knob for this; read the stack from the thrown error and fix the handler, ` +
            `starting at ${cite(REMEDY.lastDefence)}. (cause: ${detailOf(err)})`,
          true,
        );
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
