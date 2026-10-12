/**
 * @strata-ctx/gist
 *
 * The gist engine: deterministic compaction via structured summaries.
 * Implements the 8-step compaction transaction (C-3).
 *
 * ## Built, not wired (ARCH-2)
 *
 * No package declares a dependency on `@strata-ctx/gist`, so nothing in the
 * workspace reaches this code; the only consumer path is the unbuilt C-16
 * wiring. The package is deliberately kept in the tree — it is the only code
 * that deletes data, so it was written and tested before anything was allowed to
 * call it — but it does not run. The one home for that assessment is
 * `docs/maturity.md` §3.1; this header only records the package's own surface so
 * the fact is not restated.
 *
 * ## The public surface, and what is deliberately left out (ARCH-4)
 *
 * Two modules are exported: the compaction transaction and the recovery path.
 * The rest are internal:
 *
 * - `artifact-uri` — a private helper, reached by the two exported modules.
 * - `assembly`, `tiers`, `dreaming` — building blocks the unbuilt C-16 wiring
 *   would consume. They are not exported today because exporting them would add
 *   locally-uncalled exports and move Gate 4's ratchet baseline
 *   (`packages/testing/test/wiring-ratchet.test.ts`), which a surface change is
 *   not allowed to do silently. Revisit the surface when C-16 lands, not before.
 */

export * from './transaction.js';
export * from './reversibility.js';