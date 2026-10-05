import type { StageName } from './policy.js';

/**
 * What has to be measured to tune anything, and -- more importantly -- to keep
 * the cost claim honest. See docs/architecture.md §8.
 *
 * `breakeven_ok` is the metric that matters. Gross input reduction is easy and
 * meaningless if the intervention makes the model verbose.
 */

export interface StageTelemetry {
  readonly stage: StageName;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly blocksIn: number;
  readonly blocksOut: number;
  readonly durationMs: number;
  readonly changed: boolean;
  /** Optional per-stage token counts when a real token measurement exists. */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface CacheTelemetry {
  readonly prefixHit: boolean;
  readonly prefixInvalidated: boolean;
}

export interface CostTelemetry {
  /** input token reduction fraction, 0..1 */
  readonly r: number;
  /** output token expansion factor, >= 0 */
  readonly eps: number;
  /** provider price ratio output:input, ~4-5 for frontier models */
  readonly rho: number;
  /** fraction of total spend attributable to this intervention */
  readonly k: number;
  /**
   * eps < 1 + (1-r)/(rho*k). When false we are spending more than we save while
   * the headline number still looks like a win.
   */
  readonly breakevenOk: boolean;
}

export type TelemetryEvent =
  | {
      readonly type: 'request_in';
      readonly runId: string;
      readonly turn: number;
      readonly inputTokens: number;
      readonly messages: number;
    }
  | { readonly type: 'stage'; readonly runId: string } & StageTelemetry
  | {
      readonly type: 'pin';
      readonly runId: string;
      readonly missingBefore: number;
      readonly constraints: number;
    }
  | {
      readonly type: 'compaction';
      readonly runId: string;
      readonly trigger: string;
      readonly beforeTokens: number;
      readonly afterTokens: number;
      readonly droppedCount: number;
      readonly compressionBy: 'self-gist' | 'local-model' | 'none';
      readonly validationPassed: boolean;
    }
  | {
      readonly type: 'canary';
      readonly probeId: string;
      readonly kind: 'rot' | 'constraint';
      readonly arm: 'control' | 'control+' | 'treatment';
      readonly score: number;
      readonly passed: boolean;
    }
  | {
      readonly type: 'violation';
      readonly runId: string;
      readonly kind: 'pin_missing_pre_apply' | 'pin_post_compact_missing' | 'canary_fail';
      readonly constraintIds: readonly string[];
      readonly blocked: boolean;
    }
  | { readonly type: 'cache'; readonly runId: string } & CacheTelemetry
  | { readonly type: 'cost'; readonly runId: string } & CostTelemetry
  | {
      readonly type: 'error';
      readonly runId: string;
      readonly stage: StageName;
      readonly code: string;
      readonly message: string;
      /** Fail-open is the default; this records that we failed open. */
      readonly failedOpen: boolean;
    };

/**
 * eps < 1 + (1-r)/(rho*k), with division-by-zero handled: an intervention that
 * accounts for none of the spend (k=0) gets an unbounded expansion budget.
 */
export function breakevenOk(r: number, eps: number, rho: number, k: number): boolean {
  if (k <= 0) return true;
  return eps < 1 + (1 - r) / (rho * k);
}

export function costTelemetry(r: number, eps: number, rho: number, k: number): CostTelemetry {
  return { r, eps, rho, k, breakevenOk: breakevenOk(r, eps, rho, k) };
}
