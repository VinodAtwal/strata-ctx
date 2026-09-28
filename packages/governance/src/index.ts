/**
 * @strata-ctx/governance
 *
 * The security core. Everything here exists because compaction is known to
 * destroy safety constraints: Governance Decay (arXiv 2606.22528) measured
 * policy violations rising 0% -> 30% (59% worst) purely from compaction over
 * 1,323 episodes, 0% when the constraint survived and 38% when it was dropped,
 * with decay **8.3x worse for soft organisational policies** than for hard
 * safety norms because alignment training already holds the hard ones in place.
 * Compaction Cliff (CIKM 2026, arXiv 2608.22752) measured 53% of safety rules
 * surviving one production `/compact` and 10% after five.
 *
 * | Module | Task | What it is |
 * |---|---|---|
 * | `./policy-store` | D-3 | YAML policy store, versioning, per-project overrides, hashes |
 * | `./pinned-buffer` | D-1, D-2, D-5 | the immutable buffer, applied every turn; pre-apply P0; post-compaction re-assertion |
 * | `./byte-equality` | D-4 | the step-4c security gate: gist constraints vs the pin set |
 * | `./canary` | D-6 | constraint-retention probe, stratified by constraint kind |
 * | `./volume-attack` | D-7 | anomalous compaction frequency |
 * | `./type-guard` | D-8 | the runtime half of "governance is unrepresentable on a lossy stage" |
 * | `./violations` | D-2 | violation records, severity, sinks, telemetry projection |
 * | `./yaml` | D-3 | a deliberately small, deliberately strict YAML subset reader |
 *
 * The property suite for D-9 lives in `test/property.test.ts`; the threat model
 * for D-10 is `THREAT-MODEL.md`.
 *
 * ## The one rule the rest of the repo should know
 *
 * `PinnedBuffer.apply` **replaces** the governance channel from an immutable
 * snapshot on every outbound request. It never merges, never appends, and never
 * reads what the model sent back. That is what makes policy injection through
 * a gist or a summary structurally impossible rather than merely detected --
 * the detectors in `./byte-equality` and `./pinned-buffer` are diagnostics on
 * top of a guarantee, and should never be the thing the guarantee rests on.
 */

export * from './violations.js';
export * from './yaml.js';
export * from './policy-store.js';
export * from './byte-equality.js';
export * from './pinned-buffer.js';
export * from './canary.js';
export * from './volume-attack.js';
export * from './type-guard.js';
