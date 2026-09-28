/**
 * @strata-ctx/pipeline
 *
 * Tier 0 of the context pipeline: the deterministic operators that run on every
 * outbound request, before anything expensive or lossy is allowed near the
 * context. Pure functions of `LossyContext` (docs/architecture.md §1, §4).
 *
 * The split that matters to anyone reading this later:
 *
 * - `dedupe`  B-1  free deletions first
 * - `truncate` B-2 + B-3 + B-4  per-tier caps, head+tail, pointer-ization, and
 *                             the severity classification those depend on
 * - `triage`  B-5 + B-6  per-tier retention policy, the Compaction Cliff fix,
 *                        and the leading user-intent tag
 * - `trigger` B-7  sawtooth/monotonic compaction trigger, in ./trigger.ts
 *
 * `pin`, `compact`, `compress` and `serialize` are other workstreams'. The order
 * they slot into is exported from ./order.ts as one constant.
 *
 * Two invariants every operator in here obeys, and every test asserts:
 *
 * 1. **Purity.** `ContextState` arrays are readonly; a stage that mutated its
 *    input would be a bug, and the types are set up to make it one.
 * 2. **Prefix preservation.** Moving a block inside a provider's cached prefix
 *    invalidates the prompt cache and destroys the economics of the whole system
 *    (decisions R4). Dropping is allowed; reordering is not.
 */

export * from './stage.js';
export * from './severity.js';
export * from './dedupe.js';
export * from './pointer.js';
export * from './truncate.js';
export * from './triage.js';
export * from './recency.js';
export * from './trigger.js';
export * from './order.js';
export * from './self-gist.js';
export * from './runner.js';
