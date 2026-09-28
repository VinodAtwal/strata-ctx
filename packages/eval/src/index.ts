/**
 * @strata-ctx/eval
 *
 * The eval harness (F1-1). Offline, deterministic, no network, no model calls.
 *
 * docs/evaluation.md §6 puts fixture eval in layer 5 of the test pyramid: six
 * suites that answer questions about quality, cost and safety without spending
 * anything. This package is the machine that runs them, and its first job is not
 * to measure anything -- it is to be *capable of measuring a failure*, which is
 * what the negative control is for. A harness in which every arm passes in every
 * configuration looks identical to a working one until the day it matters, and
 * by then the claim has already been published.
 *
 * Four parts, in dependency order:
 *
 * - `types.ts` -- the vocabulary. Designed so F1-2 (grading) and F1-3
 *   (statistics) extend it without breaking a report already committed.
 * - `fixture.ts` -- the versioned suite format and a validator that reports
 *   every problem at once, in the style of `packages/gateway/src/config.ts`.
 * - `mock-arm.ts` -- the deterministic offline arm. Seedable degradation: some
 *   arms drop declared constraints so a retention failure is observable.
 * - `runner.ts` -- runs cases against arms, interleaved per case in a seeded
 *   order so drift over time cannot masquerade as an arm effect.
 * - `reporter.ts` -- stable, diffable text and JSON, with negative controls in
 *   their own section.
 *
 * Live A/B (F2-1..F2-3) is a separate task with separate credentials and is
 * deliberately not reachable from here: nothing in `src/` opens a socket.
 */

export * from './types.js';
export * from './fixture.js';
export * from './mock-arm.js';
export * from './runner.js';
export * from './reporter.js';
