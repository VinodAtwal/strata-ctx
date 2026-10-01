/**
 * @strata-ctx/canary
 *
 * The runtime probes (F1-11), and the scheduler that decides when they fire.
 *
 * ## Where this sits
 *
 * docs/architecture.md §2 places this package as *"Rot + constraint probes,
 * scheduler"*. It is the product's own instrument: it runs inside a live turn
 * and records whether the gateway is doing what it claims after compaction.
 *
 * | Module | What it is |
 * |---|---|
 * | `./constraint-probe` | does the agent still obey the constraints, stratified by `ConstraintKind`? |
 * | `./rot-probe` | does the context still hold, and where on the fill curve? |
 * | `./scheduler` | config, cadence, fail-open, and telemetry emission |
 *
 * ## The three things a reader should know before using this
 *
 * 1. **Probes are injected.** Both subjects and the clock are parameters, never
 *    imports. The offline tests drive a deterministic subject and F2 drives a real
 *    gateway; nothing in `src/` can tell which.
 * 2. **Fail-open is the contract, and it is loud.** A throwing subject becomes a
 *    `canary_fail` violation and the user's turn continues. Silence is the one
 *    failure mode that is not allowed.
 * 3. **`include_soft_org_policies: false` produces a false green**, so the probe
 *    reports `hard_norms_only` rather than a passing score. See
 *    `./constraint-probe.js`; the flag is the whole reason this package exists
 *    rather than living in `governance`.
 *
 * ## Contract boundary
 *
 * The frozen event union in `core-types/src/telemetry.ts` is reused verbatim for
 * `canary` and `violation`. `rot_canary` — docs/architecture.md §8's
 * `{ score, at_frac_of_window }` — has no home in it yet and is declared here as
 * a *proposed additive* extension with the reasoning in `./scheduler.js`.
 *
 * This package depends on `@strata-ctx/core-types` and nothing else. AGENTS.md
 * §12.1 rule P1 is why the constraint strata and the violation names are mirrored
 * from `governance` rather than imported; the TODOs naming the intended home are
 * in `./constraint-probe.js` and `./scheduler.js`.
 */

export * from './constraint-probe.js';
export * from './rot-probe.js';
export * from './scheduler.js';
