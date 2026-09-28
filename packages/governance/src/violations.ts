import type { TelemetryEvent } from '@strata-ctx/core-types';

/**
 * D-2: violation recording.
 *
 * docs/architecture.md §7: a constraint that is already missing when the pin
 * stage runs is a **P0 event, not a warning**. Something upstream removed it,
 * and the only reason we can still say anything about it is that we are looking.
 * Treating that as a warning is how a product ends up reporting a 0% violation
 * rate on a pipeline that has been shipping unpinned requests all morning.
 *
 * ## Severity
 *
 * - `P0` -- a constraint is missing from an outbound request, something has
 *   written text into the governance channel that policy never declared, or a
 *   second consecutive canary miss (see ./canary.ts). These are release-gate
 *   events: G2 is "0% violations over 200 scenarios".
 * - `P1` -- an anomaly worth a human's attention that is not itself a proven
 *   violation: a first canary miss, an anomalous compaction rate, a policy
 *   override that tried to weaken governance and was refused.
 */

type ViolationEvent = Extract<TelemetryEvent, { readonly type: 'violation' }>;

/** The three kinds the frozen contract can carry. See the note below. */
export type FrozenViolationKind = ViolationEvent['kind'];

export const FROZEN_VIOLATION_KINDS: readonly FrozenViolationKind[] = Object.freeze([
  'pin_missing_pre_apply',
  'pin_post_compact_missing',
  'canary_fail',
]);

/**
 * Adds the kinds the frozen telemetry union cannot express yet.
 *
 * Each of these is a real event that the product needs to see and that core-types
 * has no room for: the contract's violation kind list is closed, and it was
 * frozen before this package existed. They are reported here and proposed as an
 * additive contract change (semver-minor, no existing member changes):
 *
 * - `pin_injected_text`   -- inbound text in the governance channel that policy
 *   never declared. `verifyPinIntegrity` reports this as an `extra` defect, but
 *   the telemetry union has no kind for it, and it is arguably the single most
 *   important thing to alert on: it is the Compaction-Eviction Attack trying to
 *   install a rule of its own (Governance Decay: optimized injection defeats all
 *   models, 0% -> 65%).
 * - `volume_attack`        -- D-7. Anomalous compaction frequency.
 * - `policy_override_refused` -- D-3. A project policy file tried to weaken
 *   org-level governance. A repo you just cloned is untrusted input.
 */
export type ViolationKind =
  | FrozenViolationKind
  | 'pin_injected_text'
  | 'volume_attack'
  | 'policy_override_refused';

export type ViolationSeverity = 'P0' | 'P1';

export interface ViolationRecord {
  readonly kind: ViolationKind;
  readonly severity: ViolationSeverity;
  readonly runId: string;
  readonly turn: number;
  /** Constraint ids, never constraint text. */
  readonly constraintIds: readonly string[];
  /**
   * One short sanitised line. Deliberately does not carry the offending text:
   * injected text is attacker-controlled, so logging it verbatim hands the
   * attacker a log-injection primitive (newlines, terminal escapes) and an
   * unbounded log line.
   */
  readonly detail: string;
  /** True when the request carrying this violation was blocked, not just fixed. */
  readonly blocked: boolean;
  readonly at: number;
}

const MAX_DETAIL = 200;

export function sanitizeDetail(detail: string): string {
  // Injected text is attacker-controlled, so newlines and terminal escapes are
  // stripped before the line reaches a log: a violation record is the one place
  // where an attacker gets to write into our logs.
  // eslint-disable-next-line no-control-regex -- stripping control characters is the intent
  const flat = detail.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL)}...` : flat;
}

export interface ViolationSink {
  record(violation: ViolationRecord): void;
}

export interface ViolationInput {
  readonly kind: ViolationKind;
  readonly severity: ViolationSeverity;
  readonly constraintIds?: readonly string[];
  readonly detail: string;
  readonly blocked?: boolean;
  readonly at?: number;
}

/** Minimal in-memory sink. Also the fallback when nothing is wired up. */
export class ViolationLog implements ViolationSink {
  readonly #records: ViolationRecord[] = [];

  record(violation: ViolationRecord): void {
    this.#records.push(violation);
  }

  all(): readonly ViolationRecord[] {
    return Object.freeze([...this.#records]);
  }

  byKind(kind: ViolationKind): readonly ViolationRecord[] {
    return Object.freeze(this.#records.filter((r) => r.kind === kind));
  }

  p0(): readonly ViolationRecord[] {
    return Object.freeze(this.#records.filter((r) => r.severity === 'P0'));
  }

  get count(): number {
    return this.#records.length;
  }
}

/**
 * Builds the record and forwards it to every sink.
 *
 * The record is always appended to the caller's own log, so a component can be
 * asked "what did you see?" without anyone having wired telemetry up yet. A
 * security control that is only as loud as its plumbing is not a control.
 */
export class ViolationRecorder {
  readonly log = new ViolationLog();
  readonly #sinks: readonly ViolationSink[];

  constructor(
    sinks: readonly ViolationSink[] = [],
    private readonly now: () => number = Date.now,
  ) {
    this.#sinks = [this.log, ...sinks];
  }

  record(
    input: ViolationInput,
    ctx: { readonly runId: string; readonly turn: number },
  ): ViolationRecord {
    const violation: ViolationRecord = Object.freeze({
      kind: input.kind,
      severity: input.severity,
      runId: ctx.runId,
      turn: ctx.turn,
      constraintIds: Object.freeze([...(input.constraintIds ?? [])]),
      detail: sanitizeDetail(input.detail),
      blocked: input.blocked ?? false,
      at: input.at ?? this.now(),
    });
    for (const sink of this.#sinks) sink.record(violation);
    return violation;
  }

  p0(): readonly ViolationRecord[] {
    return this.log.p0();
  }
}

/**
 * Projects onto the frozen telemetry event for the three kinds core-types
 * knows, and returns undefined for the proposed ones. The record is never
 * dropped either way: it is in the `ViolationLog` regardless, so a telemetry
 * sink that is wired up later still sees the history.
 */
export function violationEvent(v: ViolationRecord): TelemetryEvent | undefined {
  const kind = v.kind as FrozenViolationKind;
  if (!FROZEN_VIOLATION_KINDS.includes(kind)) return undefined;
  return {
    type: 'violation',
    runId: v.runId,
    kind,
    constraintIds: v.constraintIds,
    blocked: v.blocked,
  };
}
