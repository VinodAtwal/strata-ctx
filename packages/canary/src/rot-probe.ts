import type { ProbeId } from '@strata-ctx/core-types';

/**
 * F1-11 — the runtime context-rot probe.
 *
 * ## What this is, and what it is not
 *
 * docs/architecture.md §2 places `packages/canary` as *"Rot + constraint probes,
 * scheduler"*, and docs/evaluation.md §E2 asks a question about a **shape**:
 *
 * > does the gateway keep the *shape* of the degradation curve, or just move the
 * > endpoint?
 *
 * The offline suite that answers that question for a campaign is
 * `packages/eval/src/suites/e2-rot-probe.ts` (F1-6), which renders four synthetic
 * haystacks at 5/20/50/80% of a 200k window and fits a slope. This module is the
 * **same methodology aimed at a live session**, and it deliberately borrows that
 * file's *shape* rather than importing it: the eval package exists to depend on
 * nothing (AGENTS.md §12.1 — "the measuring apparatus must not be able to drift
 * with the thing it measures"), and this package is not that apparatus. It is the
 * product feature, and it runs inside somebody's turn. So the tier ladder, the
 * degradation axis, the excluded-not-failed rule and the NIAH negative control
 * are mirrored here, each with the file it came from named next to it.
 *
 * ## The tier ladder is the x-axis, not a corpus
 *
 * E2 renders four haystacks because offline it chooses the fill. A live session
 * cannot: the fill is whatever the conversation has grown to, which is the whole
 * point of watching it. So the runtime probe does not render tiers — it
 * **classifies** each observation into the nearest of the same four tiers and
 * accumulates a series. A session that walks 5% → 20% → 50% → 80% produces the
 * same curve E2 renders, one observation per turn instead of one per fixture.
 * `rotTierForFill` is the join between the two, and `rot_canary.at_frac_of_window`
 * is emitted with every observation because a score without its position on the
 * x-axis is not a measurement of rot — it is a measurement of the session.
 *
 * ## Slope, never endpoint
 *
 * E2 is explicit that *"A treatment scoring 0.80 at 80% while control scores 0.82
 * may have a worse slope — growing degradation with a flattering endpoint."* An
 * endpoint is one point on a curve the session has not finished drawing, so
 * `rotDegradationSlope` is exported here and the per-firing number is reported
 * beside it rather than instead of it.
 *
 * ## The sign convention is inherited, not re-chosen
 *
 * Every slope here is `d(1 − score) / d(fill)`: **positive means getting worse.**
 * E2 had to choose that reading of the doc's `treatment slope ≤ control slope`
 * because the literal wording admits the opposite, under which a treatment that
 * degraded six times more would pass. Mirroring the convention rather than
 * re-deciding it is the only way the two slope numbers can ever be placed on the
 * same axis; see `ROT_DEGRADATION_AXIS` and the `TODO(WS-F, F1-6)` in E2's header
 * for the open question.
 *
 * ## NIAH is a negative control on *this* probe
 *
 * docs/evaluation.md §E2: *"If NIAH stays ~100% while realistic tasks degrade,
 * we've reproduced the original finding and validated that our probe detects
 * something NIAH cannot. If NIAH also degrades, the probe is probably just
 * measuring 'long input is hard' and needs redesign."*
 *
 * At runtime this matters more than offline, because a live context is also
 * getting longer for reasons that have nothing to do with rot — a user pasting a
 * file, a tool returning a wall of output. A rot score that falls alongside NIAH
 * is not a rot finding, and `RotProbeResult.state` says `confounded` instead of
 * letting the number be read. NIAH cases are declared per case (`niah: true`),
 * excluded from the score, and reported separately, because a control folded into
 * the thing it controls is not a control.
 *
 * ## The probe grades; the subject never grades itself
 *
 * `RotProbeSubject` returns *answer strings*, and `gradeRotProbe` compares them
 * to the case's `correctAnswer`. A subject reporting its own accuracy has an
 * incentive to report a flattering one, and the whole measurement is the
 * comparison. Unknown case ids and unanswered cases are **excluded and counted**,
 * never scored as failures — a delivery failure is not a wrong answer, and
 * counting it as one puts a broken subject into the rot curve.
 */

/** docs/evaluation.md §E2, mirrored from `E2_TIER_IDS` in the F1-6 suite. */
export const ROT_TIER_IDS = ['t05', 't20', 't50', 't80'] as const;
export type RotTierId = (typeof ROT_TIER_IDS)[number];

export interface RotTier {
  readonly id: RotTierId;
  /** Fraction of the context window a session at this tier fills. */
  readonly fill: number;
}

/**
 * The four difficulty tiers, as window fractions.
 *
 * Fractions, not token counts: the window is `BudgetPolicy.contextLimit`, which
 * the gateway owns and this package must not assume. A tier is therefore
 * position, and a session at 80% of a 128k window and one at 80% of a 200k window
 * are the same point on this curve.
 */
export const ROT_TIERS: Readonly<Record<RotTierId, RotTier>> = Object.freeze({
  t05: Object.freeze({ id: 't05', fill: 0.05 }),
  t20: Object.freeze({ id: 't20', fill: 0.2 }),
  t50: Object.freeze({ id: 't50', fill: 0.5 }),
  t80: Object.freeze({ id: 't80', fill: 0.8 }),
});

/**
 * Largest NIAH drop across the tiers before the probe is declared confounded.
 *
 * Mirrors `E2_NIAH_MAX_DROP` (0.1) rather than restating a number of my own: two
 * probes reading the same control with two thresholds cannot be compared, and the
 * comparison is the only reason both exist. The value is a reading of §E2's
 * *"if NIAH stays ~100%"*, not a published constant.
 *
 * TODO(WS-F, F1-11): the same pre-registration `E2_NIAH_MAX_DROP` carries in
 * F1-6 — this copy inherits that open item rather than resolving it.
 */
export const ROT_NIAH_MAX_DROP = 0.1;

/**
 * Which quantity the slope is taken over.
 *
 * Named so a report states the convention instead of leaving a reader to guess
 * which way the number runs, and asserted by the test file rather than trusted.
 */
export const ROT_DEGRADATION_AXIS =
  'degradation (1 - score) per unit window fill; positive = worse';

// --------------------------------------------------------------------- cases

/**
 * One probe question, and the answer that counts as passing.
 *
 * The `prompt` is a *question*, not a context. A runtime subject renders it
 * against the live session; the offline suite renders a haystack around it first.
 * That is the only structural difference between the two, and it is why nothing
 * here needs a corpus.
 */
export interface RotProbeCase {
  readonly id: string;
  readonly prompt: string;
  /**
   * Compared by `gradeRotProbe` after trimming. Not reported by the subject:
   * the answer key stays in the apparatus, not in the thing being measured.
   */
  readonly correctAnswer: string;
  /**
   * True for the negative control.
   *
   * NIAH cases are excluded from `score` and from the slope and reported as
   * `niahScore`. A control that is folded into the quantity it controls cannot
   * detect that the quantity stopped being about rot.
   */
  readonly niah: boolean;
}

/** What the subject is handed for one firing. */
export interface RotProbeRequest {
  readonly probeId: ProbeId;
  readonly turn: number;
  /** The tier this observation is classified into. */
  readonly tier: RotTierId;
  /** The session's actual fill, which is what `at_frac_of_window` reports. */
  readonly fill: number;
  readonly cases: readonly RotProbeCase[];
}

/** One answer, verbatim. Graded by the probe, never self-assessed. */
export interface RotProbeAnswer {
  readonly caseId: string;
  readonly answer: string;
}

/**
 * The thing that answers a rot probe, injected.
 *
 * A parameter rather than an import for the reason the eval harness has the same
 * one (E2's `E2Subject`): the offline tests supply a deterministic degradation
 * model and F2 supplies the real gateway and a real provider, and nothing here
 * can tell the difference — which is what lets a measuring apparatus be tested
 * against something that measurably fails.
 *
 * It may throw. The scheduler owns the fail-open path, so a throwing subject
 * becomes a `canary_fail` violation and the user's turn continues.
 */
export interface RotProbeSubject {
  readonly id: string;
  answerRot(request: RotProbeRequest): Promise<readonly RotProbeAnswer[]>;
}

// -------------------------------------------------------------------- result

/**
 * Why a firing is or is not readable.
 *
 * - `ok` — NIAH held and at least one rot case was scored.
 * - `confounded` — NIAH fell too. The number is reported, and §E2 says the probe
 *   needs redesign rather than that rot was found.
 * - `unscored` — nothing to grade: no rot case came back, or the case list had no
 *   rot case in it. Never a pass; a probe that measured nothing and reported a
 *   score would be the flattering failure mode this package exists to avoid.
 */
export type RotProbeState = 'ok' | 'confounded' | 'unscored';

export interface RotProbeResult {
  readonly probeId: ProbeId;
  readonly turn: number;
  readonly tier: RotTierId;
  readonly fill: number;
  /** Rot-case accuracy, or null when nothing was scorable. Never NaN. */
  readonly score: number | null;
  readonly scored: number;
  readonly correct: number;
  /** Cases dropped: unknown ids, and ids that came back with no answer. */
  readonly excluded: number;
  /** Ids the subject reported that it was never asked about, sorted. */
  readonly unknownIds: readonly string[];
  /** NIAH accuracy over the control cases only. Null when none were scored. */
  readonly niahScore: number | null;
  readonly niahScored: number;
  readonly state: RotProbeState;
  /**
   * The frozen `canary` event's `passed`, and it means one thing only: **this
   * score can be read.** It is not a health verdict on the session.
   *
   * The floor is zero, and zero is not a tuned threshold — it is the only floor
   * that needs no invented constant. A firing where every rot case failed is the
   * failure this probe exists to catch; anything above zero is reported as a
   * number and left to the slope, because a cutoff chosen here would be a number
   * no campaign ever agreed to and would fire for reasons that have nothing to do
   * with rot.
   *
   * TODO(WS-F, F1-11): F2 sets a real floor from live sessions, or G5's slope
   * comparison becomes the only pass condition. Neither is available offline.
   */
  readonly passed: boolean;
}

// ------------------------------------------------------------------- grading

const isAnswered = (answers: readonly RotProbeAnswer[], caseId: string): RotProbeAnswer | undefined =>
  answers.find((answer) => answer.caseId === caseId);

const accuracyOf = (correct: number, total: number): number | null => (total === 0 ? null : correct / total);

/**
 * Grade one firing. Pure: no clock, no I/O, same input ⇒ same output.
 *
 * Excluded case ids are surfaced as `unknownIds` rather than being counted, so a
 * subject that answers a question it was never asked is visible instead of being
 * averaged into a denominator it quietly widened.
 */
export function gradeRotProbe(
  request: RotProbeRequest,
  answers: readonly RotProbeAnswer[],
): RotProbeResult {
  const caseIds = new Set(request.cases.map((entry) => entry.id));
  const unknownIds = [
    ...new Set(
      answers
        .map((answer) => answer.caseId)
        .filter((caseId) => !caseIds.has(caseId)),
    ),
  ].sort();

  let scored = 0;
  let correct = 0;
  let excluded = 0;
  let niahScored = 0;
  let niahCorrect = 0;

  for (const entry of request.cases) {
    const answer = isAnswered(answers, entry.id);
    if (answer === undefined) {
      // Not a wrong answer. The subject did not deliver a measurement, and
      // scoring a delivery failure as a task failure would put the subject's
      // plumbing into the rot curve.
      excluded += 1;
      continue;
    }
    const right = answer.answer.trim() === entry.correctAnswer.trim();
    if (entry.niah) {
      niahScored += 1;
      if (right) niahCorrect += 1;
      continue;
    }
    scored += 1;
    if (right) correct += 1;
  }
  excluded += unknownIds.length;

  const score = accuracyOf(correct, scored);
  const niahScore = accuracyOf(niahCorrect, niahScored);
  const state: RotProbeState = score === null ? 'unscored' : niahConfounded(niahScore) ? 'confounded' : 'ok';
  const passed = state === 'ok' && score !== null && score > 0;

  return Object.freeze({
    probeId: request.probeId,
    turn: request.turn,
    tier: request.tier,
    fill: request.fill,
    score,
    scored,
    correct,
    excluded,
    unknownIds,
    niahScore,
    niahScored,
    state,
    passed,
  });
}

/**
 * Whether the control fell far enough to make the rot reading untrustworthy.
 *
 * `null` is not confounded. A subject that returned no NIAH answer at all has not
 * demonstrated that NIAH degrades; it has demonstrated nothing about NIAH, and
 * the honest verdict for a control that did not report is `unscored`, not
 * `confounded`.
 */
function niahConfounded(niahScore: number | null): boolean {
  return niahScore !== null && niahScore < 1 - ROT_NIAH_MAX_DROP;
}

/** Ask the subject and grade it. The throwing path belongs to the scheduler. */
export async function runRotProbe(
  subject: RotProbeSubject,
  request: RotProbeRequest,
): Promise<RotProbeResult> {
  return gradeRotProbe(request, await subject.answerRot(request));
}

// ------------------------------------------------------------------ the curve

/**
 * One retained observation. Scored firings only — an unscored firing carries no
 * number, and a series that admitted nulls would have to be filtered at every
 * read instead of once at the write.
 */
export interface RotObservation {
  readonly turn: number;
  readonly tier: RotTierId;
  readonly fill: number;
  readonly score: number;
}

export function observationOf(result: RotProbeResult): RotObservation | null {
  if (result.score === null) return null;
  return Object.freeze({ turn: result.turn, tier: result.tier, fill: result.fill, score: result.score });
}

export interface RotTierAccuracy {
  readonly tier: RotTierId;
  readonly fill: number;
  readonly observations: number;
  readonly score: number | null;
  /**
   * NIAH accuracy pooled at this tier, or null when no NIAH case reported here.
   *
   * Carried per tier rather than as one session-wide number because "NIAH fell"
   * is a statement about a fill level: a control that holds at 5% and falls at 80%
   * is the confound, and a single pooled average over both would average the
   * finding away.
   */
  readonly niahScore: number | null;
}

/**
 * Which tier a live fill belongs to.
 *
 * Nearest tier by absolute distance, and ties resolved toward the *harder* tier:
 * at exactly 0.35 the distance to `t20` and to `t50` is equal, and rounding a
 * session up puts a point on the steep half of the curve where a rounding the
 * other way would have put it on the flat half. The conservative direction is
 * the one that can raise an alarm rather than lower one.
 */
export function rotTierForFill(fill: number): RotTierId {
  let best: RotTierId = ROT_TIER_IDS[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const id of ROT_TIER_IDS) {
    const tier = ROT_TIERS[id];
    const distance = Math.abs(fill - tier.fill);
    // `<=`, not `<`: on an exact tie the later (harder) tier wins, per the header
    // comment. A strict `<` keeps the earlier tier and rounds the session *up* the
    // curve instead — the direction that can hide a degradation.
    if (distance <= bestDistance) {
      best = id;
      bestDistance = distance;
    }
  }
  return best;
}

/** Pool the series by tier. Tiers with no observations report `score: null`. */
export function rotTierAccuracy(
  observations: readonly RotObservation[],
  niahByTier: Readonly<Record<RotTierId, number | null>> = Object.freeze({
    t05: null,
    t20: null,
    t50: null,
    t80: null,
  }),
): readonly RotTierAccuracy[] {
  return Object.freeze(
    ROT_TIER_IDS.map((id) => {
      const at = observations.filter((observation) => observation.tier === id);
      const score = at.length === 0 ? null : at.reduce((sum, o) => sum + o.score, 0) / at.length;
      return Object.freeze({
        tier: id,
        fill: ROT_TIERS[id].fill,
        observations: at.length,
        score,
        // The NIAH control is read per tier, because "NIAH fell" is a statement
        // about a fill level and not about the session as a whole.
        niahScore: niahByTier[id],
      });
    }),
  );
}

export interface RotSlopeFit {
  /** Degradation per unit window fill. **Positive means getting worse.** */
  readonly slope: number;
  readonly intercept: number;
  /** Tiers that carried at least one observation. */
  readonly points: number;
  /**
   * How linear the tiers are, or null when they do not vary at all.
   *
   * Reported because a slope is a summary: a curve that is flat and then crashes
   * has a slope and an `r²` that tell different stories, and the crash is the
   * thing an operator needs to see.
   */
  readonly rSquared: number | null;
}

/**
 * Ordinary least squares of degradation against window fill, over tier means.
 *
 * Unweighted and one point per tier, for the reason E2 gives: the tiers are the
 * design, so weighting them by how many observations happened to land in each
 * would fit the sampling rather than the sweep.
 *
 * `NaN` rather than a number when fewer than two tiers survived. A slope through
 * one point is infinite, and printing `Infinity` in a dashboard is a number
 * nobody can act on.
 */
export function rotDegradationSlope(tierAccuracy: readonly RotTierAccuracy[]): RotSlopeFit {
  const points = tierAccuracy.filter((tier) => tier.score !== null);
  if (points.length < 2) {
    return { slope: Number.NaN, intercept: Number.NaN, points: points.length, rSquared: null };
  }
  const n = points.length;
  const meanX = points.reduce((sum, point) => sum + point.fill, 0) / n;
  const meanY = points.reduce((sum, point) => sum + (1 - (point.score ?? 0)), 0) / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const point of points) {
    const dx = point.fill - meanX;
    const dy = 1 - (point.score ?? 0) - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (sxx === 0) {
    return { slope: Number.NaN, intercept: Number.NaN, points: n, rSquared: null };
  }
  const slope = sxy / sxx;
  return {
    slope,
    intercept: meanY - slope * meanX,
    points: n,
    rSquared: syy === 0 ? null : (sxy * sxy) / (sxx * syy),
  };
}

// ------------------------------------------------------------- probe validity

/**
 * Whether a *series* measures rot or just input length.
 *
 * The per-firing `RotProbeState` asks "is this number readable"; this asks the
 * §E2 question about the curve as a whole, and it needs at least two tiers
 * before it has an opinion. Mirrors `evaluateE2ProbeValidity` in the F1-6 suite.
 */
export type RotProbeValidityStatus = 'distinguishing' | 'blind' | 'confounded' | 'undetermined';

export interface RotProbeValidity {
  readonly status: RotProbeValidityStatus;
  /** Easy tier to hard tier, rot score. Negative is a drop. */
  readonly rotDrop: number;
  /** Easy tier to hard tier, NIAH score. Negative is a drop. */
  readonly niahDrop: number;
  /** Pooled score at the easiest tier that has an observation. */
  readonly easiestTierScore: number | null;
  readonly statement: string;
}

/**
 * `confounded` — NIAH fell by more than `ROT_NIAH_MAX_DROP` at the same fill
 *   comparison. The probe is measuring "long input is hard" and §E2 says it needs
 *   redesign.
 * `blind` — the rot score did not fall either. Nothing is being measured, and a
 *   flat curve is not a pass.
 * `undetermined` — fewer than two tiers carry observations, or the control
 *   degraded without the rot families following it. Two different faults under
 *   one label, because a single label would assert a diagnosis the data does not
 *   support.
 * `distinguishing` — NIAH held and rot fell. The finding §E2 predicts.
 */
export function evaluateRotProbeValidity(
  tierAccuracy: readonly RotTierAccuracy[],
  niahByTier: Readonly<Record<RotTierId, number | null>>,
): RotProbeValidity {
  const scored = tierAccuracy.filter((tier) => tier.score !== null);
  if (scored.length < 2) {
    return {
      status: 'undetermined',
      rotDrop: Number.NaN,
      niahDrop: Number.NaN,
      easiestTierScore: scored[0]?.score ?? null,
      statement:
        'fewer than two tiers carry an observation, so the series has no curve and its shape cannot be read',
    };
  }
  const easiest = scored[0];
  const hardest = scored[scored.length - 1];
  const rotDrop = (hardest?.score ?? 0) - (easiest?.score ?? 0);
  const niahEasy = niahByTier[easiest?.tier ?? 't05'];
  const niahHard = niahByTier[hardest?.tier ?? 't80'];
  const niahDrop = niahEasy === null || niahEasy === undefined || niahHard === null || niahHard === undefined
    ? Number.NaN
    : niahHard - niahEasy;

  const niahFell = Number.isFinite(niahDrop) && niahDrop < -ROT_NIAH_MAX_DROP;
  const rotFell = rotDrop < -ROT_NIAH_MAX_DROP;

  if (niahFell && !rotFell) {
    return {
      status: 'undetermined',
      rotDrop,
      niahDrop,
      easiestTierScore: easiest?.score ?? null,
      statement: 'the NIAH control fell while the rot cases held, so neither hypothesis is supported',
    };
  }
  if (niahFell) {
    return {
      status: 'confounded',
      rotDrop,
      niahDrop,
      easiestTierScore: easiest?.score ?? null,
      statement:
        'NIAH degraded alongside the rot cases, so this is probably measuring "long input is hard" ' +
        'rather than context rot; the probe needs redesign',
    };
  }
  if (!rotFell) {
    return {
      status: 'blind',
      rotDrop,
      niahDrop,
      easiestTierScore: easiest?.score ?? null,
      statement: 'nothing degraded across the tiers, so the probe is measuring nothing',
    };
  }
  return {
    status: 'distinguishing',
    rotDrop,
    niahDrop,
    easiestTierScore: easiest?.score ?? null,
    statement: 'NIAH held while the rot cases degraded, which is the rot finding this probe exists to detect',
  };
}
