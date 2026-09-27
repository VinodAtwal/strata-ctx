import type { ContextState, ContentBlock, Message } from './context.js';

/**
 * Token estimation.
 *
 * This is a heuristic and is labelled as one everywhere it is used. The honest
 * position: we do not know the provider's tokenizer, so a char/4 estimate is
 * good enough for *budgeting decisions* (which are coarse by design -- triggers
 * fire at 0.85 of a window, not at 0.851) and not good enough to quote in a
 * report. Any published token or dollar figure must come from the provider's own
 * `usage` field, never from here.
 *
 * Per-provider overrides are wired in at the adapter layer, not here, because
 * core-types takes no provider-specific inputs.
 */

const BYTES_PER_TOKEN = 4;

/** Structural overhead: role markers, separators, the tool_use envelope. */
const PER_BLOCK_OVERHEAD_TOKENS = 3;

export function estimateBlockTokens(b: ContentBlock): number {
  const text = b.text ?? '';
  return Math.ceil(text.length / BYTES_PER_TOKEN) + PER_BLOCK_OVERHEAD_TOKENS;
}

export function estimateMessageTokens(m: Message): number {
  const blocks = m.content.reduce((n, b) => n + estimateBlockTokens(b), 0);
  return blocks + PER_BLOCK_OVERHEAD_TOKENS;
}

export function estimateTokens(state: ContextState): number {
  return state.messages.reduce((n, m) => n + estimateMessageTokens(m), 0);
}

/**
 * Budget math, kept in one place so the trigger policy cannot drift from the
 * numbers the docs quote.
 */
export interface BudgetView {
  readonly contextLimit: number;
  readonly reserveOutput: number;
  readonly targetUtilization: number;
  /** Tokens we intend to occupy in the steady state. */
  readonly softLimit: number;
  /** Point at which emergency structural eviction is allowed. */
  readonly hardLimit: number;
  /** Where the sawtooth trigger fires. */
  readonly triggerAt: number;
}

export function budgetView(
  contextLimit: number,
  reserveOutput: number,
  targetUtilization: number,
  softTriggerFrac: number,
  hardTriggerFrac: number,
): BudgetView {
  const usable = Math.max(1, contextLimit - reserveOutput);
  return {
    contextLimit,
    reserveOutput,
    targetUtilization,
    softLimit: Math.floor(usable * targetUtilization),
    hardLimit: Math.floor(usable * hardTriggerFrac),
    triggerAt: Math.floor(usable * softTriggerFrac),
  };
}
