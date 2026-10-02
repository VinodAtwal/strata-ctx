import type { LossyContext, LossyStageName } from '@strata-ctx/core-types';

/**
 * The shape every Tier 0 operator returns.
 *
 * `LossyStage` in core-types has no room for a report, and the frozen contract
 * cannot grow one, so this package keeps its richer shape internally and
 * projects down to `LossyStage` in ./order.ts for the gateway's generic runner
 * (A-14). One implementation, two views: the operators are not duplicated and
 * cannot drift.
 */
export interface StageApplied<T> {
  readonly ctx: LossyContext;
  /** What the stage decided. Counts, not booleans, so telemetry can be diffed. */
  readonly report: T;
}

/**
 * Stage-wide switches the caller knows and a stage cannot infer.
 *
 * `durable` is the important one. A stage must not mint an `artifact://` URI
 * unless the caller has somewhere to put the bytes, and a synchronous stage has
 * no way to ask -- so the answer arrives here, from the only party that knows
 * whether a store was opened. Stages that need nothing ignore it.
 */
export interface Tier0StageOptions {
  readonly durable?: boolean;
}

export interface Tier0Stage<T> {
  readonly name: LossyStageName;
  run(ctx: LossyContext, opts?: Tier0StageOptions): StageApplied<T>;
}
