import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ContextState, StrataPolicy, TelemetryEvent } from '@strata-ctx/core-types';
import {
  enforcePins,
  estimateTokens,
  partitionForLossy,
  pinDrift,
  restoreHeld,
  runId,
  StrataPolicySchema,
} from '@strata-ctx/core-types';
import { fromCanonical, toCanonical, type AnthropicRequest } from './anthropic-adapter.js';

export interface GatewayOptions {
  readonly port: number;
  readonly host: string;
  /** Upstream base URL. In dev this is the mock provider. */
  readonly upstream: string;
  /** Provider key is read from the environment, never from policy. */
  readonly apiKeyEnv: string;
  readonly policy: StrataPolicy;
  readonly telemetry?: (e: TelemetryEvent) => void;
}

interface Session {
  state: ContextState;
  /** What we actually put on the wire last turn. The only honest drift baseline. */
  lastSent: readonly string[];
}

const isGovernanceSystem = (s: ContextState): boolean =>
  s.messages.some((m) => m.role === 'system');

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

/**
 * POST /v1/messages -- the Anthropic Messages endpoint, which is what Claude Code
 * and the Anthropic SDKs speak. Streams are passed through byte-for-byte: the
 * gateway never buffers a response in order to transform it, because output
 * tokens are emitted before there is anything to transform.
 */
async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  opts: GatewayOptions,
  sessions: Map<string, Session>,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as AnthropicRequest;

  const sessionId = (req.headers['x-strata-session'] as string | undefined) ?? 'default';
  const prior = sessions.get(sessionId);
  const session: Session = prior ?? { state: toCanonical(body, 1), lastSent: [] };
  session.state = toCanonical(body, (prior?.state.turn ?? 0) + 1);
  sessions.set(sessionId, session);

  const before = session.state;
  const t0 = performance.now();
  const emit = opts.telemetry;

  // The pipeline. Wave 0 has no lossy stages wired yet, so this is partition ->
  // (nothing) -> restore -> pin. It is written in the final shape so that adding
  // a stage cannot change where pinning happens: pinning is last, always.
  const lossy = partitionForLossy(before, opts.policy);
  const restored = restoreHeld(lossy, { ...before, tokenEstimate: estimateTokens(before) });
  const { state, expected, inboundGovernance } = enforcePins(restored, opts.policy);

  // Drift is measured against what we sent last turn, not against policy: on
  // turn 1 nothing was sent, and "everything is missing" is not a finding.
  const lastSent = prior?.lastSent ?? [];
  if (lastSent.length > 0) {
    const drift = pinDrift(lastSent, inboundGovernance);
    if (!drift.ok) {
      emit?.({
        type: 'violation',
        runId: state.runId,
        kind: 'pin_missing_pre_apply',
        constraintIds: drift.defects.map((d) => d.text.slice(0, 40)),
        blocked: false,
      });
    }
  }

  emit?.({
    type: 'request_in',
    runId: state.runId,
    turn: state.turn,
    inputTokens: state.tokenEstimate,
    messages: state.messages.length,
  });
  if (expected.length > 0) {
    emit?.({
      type: 'pin',
      runId: state.runId,
      missingBefore: 0,
      constraints: expected.length,
    });
  }

  const outbound = fromCanonical(state, body);
  session.lastSent = expected;
  const upstream = await fetch(`${opts.upstream}${req.url ?? '/v1/messages'}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env[opts.apiKeyEnv] ? { 'x-api-key': process.env[opts.apiKeyEnv] as string } : {}),
    },
    body: JSON.stringify(outbound),
  });

  emit?.({
    type: 'stage',
    runId: state.runId,
    stage: 'pin',
    bytesIn: JSON.stringify(before).length,
    bytesOut: JSON.stringify(outbound).length,
    blocksIn: before.messages.length,
    blocksOut: state.messages.length,
    durationMs: performance.now() - t0,
    changed: true,
  });

  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    'cache-control': 'no-store',
    'x-strata-pinned': String(expected.length),
  });

  if (!upstream.body) {
    res.end();
    return;
  }

  // Byte-for-byte passthrough. No buffering, no transform, no TTFT penalty.
  const reader = upstream.body.getReader();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done === true) break;
    res.write(Buffer.from(chunk.value));
  }
  res.end();
}

export function createGateway(opts: GatewayOptions) {
  const sessions = new Map<string, Session>();
  return createServer((req, res) => {
    void (async () => {
      try {
        if (req.url === '/strata/status') {
          const policy = StrataPolicySchema.safeParse(opts.policy);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              policy: policy.success ? { constraints: opts.policy.constraints.length } : 'invalid',
              pinning: opts.policy.governance.pinning,
              governanceSystem: isGovernanceSystem(sessions.get('default')?.state ?? EMPTY_STATE),
            }),
          );
          return;
        }
        if (req.method === 'POST') {
          await handleMessages(req, res, opts, sessions);
          return;
        }
        res.writeHead(405, { allow: 'POST' });
        res.end();
      } catch (err) {
        // Fail open. Losing the user's context to save tokens is unacceptable,
        // and a gateway that 500s is a gateway the agent routes around.
        opts.telemetry?.({
          type: 'error',
          runId: 'unknown',
          stage: 'pin',
          code: 'unhandled',
          message: err instanceof Error ? err.message : String(err),
          failedOpen: true,
        });
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'gateway_failed_open', detail: String(err) }));
        } else {
          res.end();
        }
      }
    })();
  });
}
