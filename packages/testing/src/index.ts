/**
 * @strata-ctx/testing
 *
 * Deterministic provider record/replay. Everything the eval suites (E1-E6) and
 * the gateway tests run on instead of the network.
 *
 * The reason this package exists at all: fixture replay cannot measure real-model
 * behaviour drift (docs/evaluation.md §7, risk R17), but it *can* make a round
 * trip reproducible -- including replaying the 3am provider failure, which
 * otherwise exists only in somebody's memory. A mock upstream can tell you a
 * response is plausible. Only a recorded one can tell you it is what the
 * provider actually said.
 *
 * Three rules the whole package is built around:
 *
 * 1. **Match on the canonical hash, never on raw JSON text.** `hashCanonical`
 *    sorts keys recursively, so a fixture whose keys are in a different order is
 *    the same request. Key order in a hand-edited fixture must not be a miss.
 * 2. **No default response.** An unmatched request throws, with a diff. A
 *    harness that answers unrecognised traffic with something plausible reports
 *    green for a response nobody recorded, which is worse than no test at all.
 * 3. **Redact before the bytes touch the disk.** These files are committed. A
 *    recorded credential is a leaked credential with an extra commit in its
 *    history, and it is not revokeable by deleting the file.
 *
 * The fixture format is versioned (`FIXTURE_FORMAT_VERSION`) and every object in
 * it is strict. A silently mis-parsed fixture is the worst possible outcome: the
 * suite is green and it tested nothing.
 */

export * from './errors.js';
export * from './json.js';
export * from './redact.js';
export * from './sse.js';
export * from './fixture.js';
export * from './record.js';
export * from './replay.js';
