import type { Gist, PinIntegrity, StrataPolicy } from '@strata-ctx/core-types';
import { pinSetText, validateGist, verifyPinIntegrity } from '@strata-ctx/core-types';

/**
 * D-4: the step-4c security gate.
 *
 * docs/architecture.md §5:
 *
 * ```
 * 4. VALIDATE   a. every changed[].path has a sha
 *               b. unresolved[] round-trips
 *               c. pinned set byte-equals policy (SECURITY GATE -- fail => abort)
 *               d. artifacts[].uri resolves in the store
 * ```
 *
 * Step 4c is the whole product claim in one comparison. A gist carries
 * `constraints`, and the field exists *only* as a verification target: it is
 * written from policy, never parsed from model output, and the compactor is
 * given no way to change it. So "the summariser dropped a safety rule" stops
 * being an invisible behaviour and becomes a boolean that aborts a
 * transaction.
 *
 * On mismatch the answer is always **abort, keep the transcript**. Fail toward
 * more context (spec.md §6.1). The cost of a false abort is tokens; the cost of
 * a false pass is the claim in the README.
 */

export type GistGateStep = '4a_digests' | '4b_invariants' | '4c_constraint_bytes' | '4d_artifacts';

export interface GistGateDefect {
  readonly step: GistGateStep;
  readonly detail: string;
  /** Constraint ids implicated, when the defect is a governance one. */
  readonly constraintIds: readonly string[];
}

export interface GistGateResult {
  readonly ok: boolean;
  readonly action: 'commit' | 'abort_keep_transcript';
  readonly defects: readonly GistGateDefect[];
  /** The step-4c comparison, present whenever a gist reached that step. */
  readonly integrity: PinIntegrity | null;
  /**
   * The validated gist. Present only when `ok`: there is no way to get a gist
   * out of this function that did not pass every check, so a caller cannot
   * accidentally commit an unvalidated one.
   */
  readonly gist: Gist | null;
}

export interface GateInput {
  /** Whatever the summarizer produced. Parsed and checked here, not trusted. */
  readonly gist: unknown;
  readonly policy: StrataPolicy;
  /**
   * ERROR/FATAL line count observed in the raw log. When supplied, the gist has
   * to retain at least that many (`validateGist` step 4b). The compactor (C-3)
   * owns the log; this only states the number.
   */
  readonly expectedErrorCount?: number;
  /**
   * Step 4d. Injected rather than implemented: the artifact store is C-2's and
   * this package takes no dependency on it. Omit it and 4d is not checked; pass
   * it and an unresolvable uri aborts the transaction.
   */
  readonly artifactResolves?: (uri: string) => boolean;
}

const idsOf = (policy: StrataPolicy, texts: readonly string[]): readonly string[] => {
  const byText = new Map(policy.constraints.map((c) => [c.text, c.id]));
  return texts.map((t) => byText.get(t) ?? `unknown:${t.slice(0, 12)}`);
};

/** True when the untrusted input plainly says the raw transcript is gone. */
const saysNotRecoverable = (raw: unknown): boolean =>
  typeof raw === 'object' &&
  raw !== null &&
  (raw as { readonly raw_recoverable?: unknown }).raw_recoverable === false;

/**
 * The security gate. Run it at step 4c of the compaction transaction; branch on
 * `action`, never on `ok` alone, so that a future addition to `ok` cannot make
 * "all good" mean something weaker than "commit".
 */
export function gateGistCommit(input: GateInput): GistGateResult {
  const defects: GistGateDefect[] = [];
  const expected = pinSetText(input.policy);

  // `raw_recoverable: false` is rejected by GistSchema itself (z.literal(true)),
  // so `validateGist` can only answer "schema" and never names the field. That
  // is the wrong answer to give an operator: "refusing to evict the only copy of
  // the transcript" is actionable and "the gist does not satisfy the v1 schema"
  // is not. One field is read out of the untrusted input purely for the
  // diagnostic; nothing here is trusted or committed on the strength of it.
  if (saysNotRecoverable(input.gist)) {
    defects.push({
      step: '4a_digests',
      detail: 'raw_recoverable is not true: refusing to evict the only copy of the transcript',
      constraintIds: [],
    });
  }

  // 4a + 4b, from the frozen contract. Returns defects rather than throwing so
  // that one call site reports all of them. The `raw_not_recoverable` and
  // `unresolved_dropped` arms below are unreachable while GistSchema keeps
  // `z.literal(true)` and `validateGist` keeps its current defect set; they stay
  // so that loosening either one cannot silently turn those conditions into a
  // bare "schema" rejection.
  const schema = validateGist(input.gist, input.expectedErrorCount);
  if (!schema.ok) {
    for (const d of schema.defects) {
      if (d.kind === 'raw_not_recoverable') {
        defects.push({
          step: '4a_digests',
          detail: 'raw_recoverable is not true: refusing to evict the only copy of the transcript',
          constraintIds: [],
        });
      } else if (d.kind === 'turn_range_inverted') {
        defects.push({
          step: '4b_invariants',
          detail: `source_turn_range is inverted (${d.range[0]} > ${d.range[1]})`,
          constraintIds: [],
        });
      } else if (d.kind === 'errors_not_retained') {
        defects.push({
          step: '4b_invariants',
          detail: `${d.missing} ERROR/FATAL line(s) did not survive compaction`,
          constraintIds: [],
        });
      } else {
        defects.push({ step: '4b_invariants', detail: 'unresolved[] was dropped', constraintIds: [] });
      }
    }
    if (schema.gist === undefined && schema.defects.length === 0) {
      // `validateGist` omits `gist` in two different situations: the value did
      // not parse, and the value parsed but has defects. Only the first leaves
      // `defects` empty, so that pair is the signature of a parse failure --
      // without the conjunction, every invariant violation would also be
      // reported as "does not satisfy the v1 schema", which is both wrong and
      // the one thing that would let a real schema problem hide in the noise.
      defects.push({
        step: '4a_digests',
        detail: 'the gist does not satisfy the v1 schema',
        constraintIds: [],
      });
    }
  }

  const gist = schema.gist ?? null;
  let integrity: PinIntegrity | null = null;

  if (gist !== null) {
    // 4c. The gate.
    integrity = verifyPinIntegrity(expected, gist.constraints);
    if (!integrity.ok) {
      for (const defect of integrity.defects) {
        defects.push({
          step: '4c_constraint_bytes',
          detail:
            defect.kind === 'missing'
              ? 'the gist is missing a pinned constraint'
              : defect.kind === 'extra'
                ? 'the gist carries a constraint that policy never declared'
                : 'the gist reordered the constraint set',
          constraintIds: defect.kind === 'extra' ? [] : idsOf(input.policy, [defect.text]),
        });
      }
    }
  }

  if (gist !== null && input.artifactResolves !== undefined) {
    for (const artifact of gist.artifacts) {
      if (!input.artifactResolves(artifact.uri)) {
        defects.push({
          step: '4d_artifacts',
          detail: `artifact ${artifact.uri} does not resolve in the store`,
          constraintIds: [],
        });
      }
    }
  }

  const ok = defects.length === 0;
  return {
    ok,
    action: ok ? 'commit' : 'abort_keep_transcript',
    defects: Object.freeze(defects),
    integrity,
    gist: ok ? gist : null,
  };
}

/**
 * True when a gist's constraint set is byte-identical to the policy's.
 *
 * The cheap form of 4c, for the canary (D-6) and for tests that do not need the
 * rest of the gate. Same comparison, same function underneath -- there is
 * deliberately no second implementation of "are the pins intact".
 */
export function gistConstraintsIntact(gist: Gist, policy: StrataPolicy): boolean {
  return verifyPinIntegrity(pinSetText(policy), gist.constraints).ok;
}

/**
 * Builds the `constraints` field for a gist from policy.
 *
 * Written here, once, so that the value being verified and the value being
 * compared come from the same place. The compactor has no reason to call it and
 * no way to be affected by it: the field is not something it can write.
 */
export function constraintsFieldFor(policy: StrataPolicy): string[] {
  return pinSetText(policy);
}
