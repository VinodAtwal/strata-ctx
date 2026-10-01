import type { ContextState, StrataPolicy, TelemetryEvent } from '@strata-ctx/core-types';
import { pinSetText } from '@strata-ctx/core-types';
import {
  narrate,
  shouldNarrate,
  type NarrationConfig,
  type NarrationResult,
  type OllamaHttpClient,
} from './ollama-adapter.js';

/**
 * B-9: the edge that makes Tier 3 reachable.
 *
 * ## Why this module exists at all
 *
 * `ollama-adapter.ts` shipped 72 tests and no caller. `narrate` was correct,
 * gated, and unreachable -- so `policy.pipeline.tokenCompression: 'local'` was a
 * field the operator could set and see nothing happen, which is the same failure
 * as the OpenCode plugin that advertised `hook_enforced` and registered nothing:
 * a setting that reads like a promise the system does not keep. Either wire it or
 * stop offering it, and since the adapter is written and tested, this is the wire.
 *
 * ## The two properties this file is actually about
 *
 * 1. **It is off unless the operator turned it on.** `tokenCompression` defaults
 *    to `'off'` in the frozen policy, and a config that is not supplied is not
 *    narration. There is no path here that can reach the network otherwise.
 *
 * 2. **Governance text never reaches the narration model.** The narration model
 *    is a second, unrelated model reading the transcript. The pin set is the one
 *    thing in the context that must never be paraphrased by something that is not
 *    the governed agent -- a narration that restates a constraint in its own words
 *    would put an unverified copy of it into session history, which is exactly the
 *    failure the adapter's own docstring calls "worse than doing nothing". So the
 *    span is assembled from non-governance blocks only, and the pin text is
 *    deleted from what remains rather than trusted to have been filtered.
 *
 * Narration is awaited inline rather than detached. It is opt-in and slower than
 * Tier 2 by construction, but a detached call would race the response, make the
 * result unobservable from a test, and mean a shutdown could drop it silently.
 * Ordering stays deterministic and a failure is a telemetry event, not a hang.
 */

export interface Tier3Input {
  readonly state: ContextState;
  readonly policy: StrataPolicy;
  readonly policyTokens: number;
  readonly config: NarrationConfig | undefined;
  readonly client: OllamaHttpClient | undefined;
  readonly telemetry?: ((e: TelemetryEvent) => void) | undefined;
}

export type Tier3Result =
  | { readonly ran: false; readonly reason: string; readonly result: null }
  | { readonly ran: true; readonly result: NarrationResult };

/**
 * The background/retrieval span, with governance removed.
 *
 * Governance is excluded structurally rather than by matching names: a block is
 * either a governance block or it is not, and deciding that by looking for the
 * word "constraint" is a filter that a paraphrase walks straight through.
 */
const narrationSpan = (state: ContextState): string => {
  const parts: string[] = [];
  for (const message of state.messages) {
    for (const block of message.content) {
      if (block.meta.tier === 'governance') continue;
      parts.push(block.text ?? `[${block.type}]`);
    }
  }
  return parts.join('\n\n');
};

/**
 * Delete the pin text from a span. Defence in depth against the filter above: if a
 * constraint were ever quoted inside an ordinary block, the narration model still
 * must not receive it, and a substring delete is the only check that catches that
 * case without knowing where it came from.
 */
const stripPinText = (span: string, policy: StrataPolicy): string => {
  const pins = pinSetText(policy);
  return pins.length === 0 ? span : pins.reduce((acc, pin) => acc.split(pin).join(''), span);
};

export const runTier3 = async (input: Tier3Input): Promise<Tier3Result> => {
  const { config, client } = input;
  if (config === undefined || client === undefined) {
    return { ran: false, reason: 'not_configured', result: null };
  }
  const span = stripPinText(narrationSpan(input.state), input.policy);
  const gate = shouldNarrate({ config, tokens: input.policyTokens, text: span });
  if (!gate.fire) {
    return { ran: false, reason: gate.reason, result: null };
  }
  const result = await narrate({
    config,
    client,
    text: span,
    tokens: input.policyTokens,
    governance: pinSetText(input.policy),
  });
  // Reported as cost, not as a stage. A stage event would read as a saving, and
  // this spends tokens to produce a summary; `k` is the honest place for it, and
  // `breakevenOk: false` is the assertion that Tier 3 has to earn its keep.
  input.telemetry?.({
    type: 'cost',
    runId: input.state.runId,
    r: 0,
    eps: result.status === 'narrated' ? 1 + 1 / Math.max(1, gate.tokens) : 0,
    rho: 1,
    k: result.usable ? 0.5 : 0,
    breakevenOk: false,
  });
  return { ran: true, result };
};

