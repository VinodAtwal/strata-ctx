import { StrataPolicySchema, sha256, type StrataPolicy } from '@strata-ctx/core-types';
import { createGateway } from '../packages/gateway/src/index.js';
import { startMockProvider } from './mock-upstream.js';

/**
 * `npm run dev` -- gateway plus a mock provider, so the whole request path can
 * be exercised with no API key and no network.
 *
 *   upstream  http://127.0.0.1:8799
 *   gateway   http://127.0.0.1:8787
 *
 *   export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
 *
 * The demo policy pins two constraints on purpose: one hard safety rule and one
 * soft org policy, because that split is exactly where the research says
 * compaction does its damage.
 */

const CONSTRAINTS = [
  {
    text: 'never delete production data or run destructive migrations without explicit approval',
    source: 'org_policy' as const,
    kind: 'hard_safety' as const,
    enforcement: 'block' as const,
  },
  {
    text: 'never email the client directly; route all outbound client communication through review',
    source: 'org_policy' as const,
    kind: 'soft_policy' as const,
    enforcement: 'block' as const,
  },
];

const policy: StrataPolicy = StrataPolicySchema.parse({
  version: 1,
  governance: { pinning: 'required' },
  constraints: CONSTRAINTS.map((c, i) => ({ ...c, id: `c${i + 1}`, sha256: sha256(c.text) })),
});

const UPSTREAM_PORT = 8799;
const GATEWAY_PORT = 8787;

const mock = startMockProvider({ port: UPSTREAM_PORT });
const telemetry: string[] = [];

const gateway = createGateway({
  port: GATEWAY_PORT,
  host: '127.0.0.1',
  upstream: `http://127.0.0.1:${UPSTREAM_PORT}`,
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  policy,
  telemetry: (e) => {
    telemetry.push(JSON.stringify(e));
    console.log(`  [telemetry] ${e.type}${e.type === 'pin' ? ` constraints=${e.constraints} missingBefore=${e.missingBefore}` : ''}`);
  },
});

gateway.listen(GATEWAY_PORT, '127.0.0.1', () => {
  console.log(`
strata-ctx dev

  gateway   http://127.0.0.1:${GATEWAY_PORT}   (POST /v1/messages, GET /strata/status)
  mock      http://127.0.0.1:${UPSTREAM_PORT}
  pinned    ${policy.constraints.length} constraints

  export ANTHROPIC_BASE_URL=http://127.0.0.1:${GATEWAY_PORT}

  curl -s localhost:${GATEWAY_PORT}/strata/status
  curl -s localhost:${UPSTREAM_PORT}/__mock/stats | head -c 400
`);

  // Smoke test: prove the pin buffer survives the round trip to the provider.
  void (async () => {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mock',
        max_tokens: 64,
        system: 'You are a coding agent. Follow the pinned constraints.',
        messages: [{ role: 'user', content: 'refactor the uploader' }],
      }),
    });
    const json = (await res.json()) as { _echo?: { system?: { text: string }[] } };
    const systemText = json._echo?.system?.[0]?.text ?? '';
    const intact = policy.constraints.every((c) => systemText.includes(c.text));
    console.log(`\n  smoke: pinned constraints intact at the provider = ${intact}`);
    console.log(`  smoke: upstream received ${mock.received.count} request(s), ${mock.received.bytes} bytes`);
    if (!intact) {
      console.error('  smoke: FAILED -- a constraint did not survive the round trip');
      process.exitCode = 1;
    }
  })();
});

const shutdown = () => {
  gateway.close();
  void mock.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
