/**
 * @strata-ctx/telemetry
 *
 * The measurement layer, and the part of the product that decides whether the
 * cost claims are real.
 *
 * ## The five tasks and where they live
 *
 * | | | |
 * |---|---|---|
 * | G-1 | event schema + local-only JSONL sink | `./events.js`, `./sink.js` |
 * | G-2 | token/cost engine: pricing, `r`, `eps`, `rho`, `k` | `./pricing.js`, `./cost.js` |
 * | G-3 | compaction and gist event emission | `./events.js` |
 * | G-4 | savings accounting: gross vs **net** | `./savings.js` |
 * | G-5 | `strata status` | `./status.js` |
 * | G-6 | pricing-table staleness | `./pricing.js` |
 * | G-7 | redaction in every sink | `./redact.js` |
 *
 * ## What this package refuses to do
 *
 * 1. **Egress.** There is no transport here and the sink's public surface is a
 *    filesystem path, because "no telemetry egress by default" (spec N4) stops
 *    being true the moment there is a URL-shaped option. `assertLocalPath`
 *    refuses a scheme so the mistake fails at construction.
 * 2. **Read the wall clock in business logic.** Every timestamp and every
 *    "today" is injected (N6: same input, byte-identical output).
 * 3. **Flatter itself.** `netSavedUsd` can be negative and the arithmetic that
 *    produces it has no clamp. G7 is a gate on net, and a gate that cannot
 *    fail is not a gate.
 * 4. **Swallow a failure quietly.** Truncated logs, rejected lines, sequence
 *    holes, redaction hits, write errors and stale prices are all counted and
 *    surfaced, because the failure this product exists to prevent is a
 *    dashboard reporting "0 violations" from a log that stopped recording.
 *
 * ## Contract boundary
 *
 * The frozen union in `core-types/src/telemetry.ts` is the event schema and is
 * reused verbatim. Two members §8 needs have no home in it -- `gist` and
 * `savings` -- and both are declared here as *proposed additive* extensions
 * with the reasoning in `./events.js` and `./savings.js`. Nothing in
 * `core-types` is edited by this stream; see the final report for the exact
 * proposed shapes and one erratum.
 */

export * from './events.js';
export * from './redact.js';
export * from './sink.js';
export * from './pricing.js';
export * from './cost.js';
export * from './savings.js';
export * from './status.js';
