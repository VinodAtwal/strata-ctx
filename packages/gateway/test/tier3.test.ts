import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ContextState, StrataPolicy } from '@strata-ctx/core-types';
import { runId, sha256, StrataPolicySchema, type ContentBlock, type Tier } from '@strata-ctx/core-types';
import {
  DISABLED_NARRATION_CONFIG,
  enabledNarrationConfig,
  type NarrationConfig,
  type OllamaHttpClient,
  type OllamaHttpRequest,
} from '../src/ollama-adapter.js';
import { runTier3 } from '../src/tier3.js';

const PIN = 'never delete production data without explicit approval';

const policy = (overrides: Partial<StrataPolicy> = {}): StrataPolicy =>
  StrataPolicySchema.parse({
    version: 1,
    constraints: [
      { id: 'c1', text: PIN, sha256: sha256(PIN), source: 'org_policy', kind: 'hard_safety', enforcement: 'block' },
    ],
    ...overrides,
  });

const block = (text: string, tier: Tier): ContentBlock => ({
  type: 'text',
  text,
  meta: { origin: 'user', sha256: sha256(text), tier, bytes: text.length, cacheable: false },
});

const state = (blocks: readonly ContentBlock[]): ContextState => ({
  runId: runId('run-1'),
  turn: 3,
  messages: [{ role: 'user', content: blocks, ts: 1 }],
  pinned: [PIN],
  tokenEstimate: ABOVE,
  policyHash: sha256('p'),
  gists: [],
  artifacts: [],
});

const config = (overrides: Partial<NarrationConfig> = {}): NarrationConfig =>
  enabledNarrationConfig({ minTokens: 10, ...overrides });

const recording = (content = '{"goal":"ship it","decided":[],"unresolved":[],"next":[]}') => {
  const calls: OllamaHttpRequest[] = [];
  const client: OllamaHttpClient = (request) => {
    calls.push(request);
    return Promise.resolve({
      status: 200,
      body: JSON.stringify({
        model: 'gemma3:1b',
        done: true,
        done_reason: 'stop',
        message: { role: 'assistant', content },
      }),
    });
  };
  return { calls, client };
};

const ABOVE = 5_000;
const reply = '{"goal":"g","decided":[],"unresolved":[],"next":[]}';

describe('B-9: the Tier 3 edge', () => {
  it('is off when no config is supplied, so the field cannot be set alone', async () => {
    const { calls, client } = recording(reply);
    const out = await runTier3({
      state: state([block('some work happened', 'episodic')]),
      policy: policy(),
      policyTokens: ABOVE,
      config: undefined,
      client,
    });
    assert.equal(out.ran, false);
    assert.equal(calls.length, 0, 'must not reach the transport without a config');
  });

  it('is off when the operator supplied no model, even with a client present', async () => {
    const { calls, client } = recording(reply);
    const out = await runTier3({
      state: state([block('some work happened', 'episodic')]),
      policy: policy(),
      policyTokens: ABOVE,
      config: DISABLED_NARRATION_CONFIG,
      client,
    });
    assert.equal(out.ran, false);
    assert.equal(out.reason, 'disabled');
    assert.equal(calls.length, 0);
  });

  it('holds below the token floor rather than calling a model that cannot pay off', async () => {
    const { calls, client } = recording(reply);
    const out = await runTier3({
      state: state([block('short', 'episodic')]),
      policy: policy(),
      policyTokens: 10,
      config: config(),
      client,
    });
    assert.equal(out.ran, false);
    assert.equal(out.reason, 'below_min_tokens');
    assert.equal(calls.length, 0, 'the floor is the whole point of the opt-in');
  });

  it('narrates and reports itself as a cost, not as a saving', async () => {
    const { calls, client } = recording(reply);
    const events: { type: string }[] = [];
    const out = await runTier3({
      state: state([block('we chose to defer the migration', 'episodic')]),
      policy: policy(),
      policyTokens: ABOVE,
      config: config(),
      client,
      telemetry: (e) => events.push(e),
    });
    assert.equal(out.ran, true);
    assert.equal(calls.length, 1);
    const cost = events.find((e) => e.type === 'cost') as
      | { eps: number; breakevenOk: boolean }
      | undefined;
    assert.ok(cost, 'a spent model call has to be reported as spend');
    assert.equal(cost.breakevenOk, false, 'Tier 3 must never look like it paid for itself');
  });

  it('never sends the pin text to the narration model', async () => {
    const { calls, client } = recording(reply);
    await runTier3({
      // The constraint is quoted inside an ordinary block as well as standing on
      // its own, because that is the case a tier filter alone does not catch.
      state: state([block(PIN, 'governance'), block(`we agreed: ${PIN}`, 'episodic')]),
      policy: policy(),
      policyTokens: ABOVE,
      config: config(),
      client,
    });
    assert.equal(calls.length, 1);
    const body = JSON.stringify(calls[0]?.body ?? '');
    assert.equal(
      body.includes(PIN),
      false,
      'a second model must never receive the constraint text, paraphrased or not',
    );
  });

  it('fails open: a dead Ollama is a skipped narration, never a failed request', async () => {
    const client: OllamaHttpClient = () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' });
    };
    const out = await runTier3({
      state: state([block('work', 'episodic')]),
      policy: policy(),
      policyTokens: ABOVE,
      config: config(),
      client,
    });
    assert.equal(out.ran, true);
    assert.equal(out.result?.status, 'failed');
    assert.equal(out.result?.failedOpen, true);
  });
});