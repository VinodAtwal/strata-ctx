import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ROT_DEGRADATION_AXIS,
  ROT_NIAH_MAX_DROP,
  ROT_TIER_IDS,
  ROT_TIERS,
  evaluateRotProbeValidity,
  gradeRotProbe,
  observationOf,
  rotDegradationSlope,
  rotTierAccuracy,
  rotTierForFill,
  runRotProbe,
  type RotObservation,
  type RotProbeCase,
  type RotProbeRequest,
} from '../src/index.js';

const CASES: readonly RotProbeCase[] = Object.freeze([
  { id: 'rot-1', prompt: 'deploy token?', correctAnswer: 'hunter2', niah: false },
  { id: 'rot-2', prompt: 'migration name?', correctAnswer: 'add-users', niah: false },
  { id: 'niah-1', prompt: 'needle?', correctAnswer: 'needle', niah: true },
]);

function request(over: Partial<RotProbeRequest> = {}): RotProbeRequest {
  return {
    probeId: 'canary.rot@50' as RotProbeRequest['probeId'],
    turn: 50,
    tier: 't50',
    fill: 0.5,
    cases: CASES,
    ...over,
  };
}

const observationsOf = (entries: readonly RotObservation[]): readonly RotObservation[] => entries;

describe('the tier ladder mirrors E2', () => {
  it('is the four E2 fills', () => {
    assert.deepEqual([...ROT_TIER_IDS], ['t05', 't20', 't50', 't80']);
    assert.equal(ROT_TIERS.t05.fill, 0.05);
    assert.equal(ROT_TIERS.t20.fill, 0.2);
    assert.equal(ROT_TIERS.t50.fill, 0.5);
    assert.equal(ROT_TIERS.t80.fill, 0.8);
  });

  it('classifies a fill into the nearest tier', () => {
    assert.equal(rotTierForFill(0.05), 't05');
    assert.equal(rotTierForFill(0.2), 't20');
    assert.equal(rotTierForFill(0.5), 't50');
    assert.equal(rotTierForFill(0.8), 't80');
    assert.equal(rotTierForFill(0), 't05');
    assert.equal(rotTierForFill(1), 't80');
  });

  it('rounds just past a midpoint toward the harder tier', () => {
    // Nearest-tier rounding, and the tie rule bends up the curve rather than
    // down: 0.34 is closest to t20, 0.36 to t50. Rounding *up* is the direction
    // that can raise an alarm rather than lower one.
    assert.equal(rotTierForFill(0.34), 't20');
    assert.equal(rotTierForFill(0.36), 't50');
  });

  it('names the slope axis so its sign cannot be guessed wrong', () => {
    assert.match(ROT_DEGRADATION_AXIS, /positive = worse/);
  });
});

describe('grading — the probe grades, the subject never grades itself', () => {
  it('scores rot cases and keeps NIAH out of the score', () => {
    const result = gradeRotProbe(request(), [
      { caseId: 'rot-1', answer: 'hunter2' },
      { caseId: 'rot-2', answer: 'wrong' },
      { caseId: 'niah-1', answer: 'needle' },
    ]);
    assert.equal(result.scored, 2);
    assert.equal(result.correct, 1);
    assert.equal(result.score, 0.5);
    assert.equal(result.niahScored, 1);
    assert.equal(result.niahScore, 1);
    assert.equal(result.state, 'ok');
    assert.equal(result.passed, true);
  });

  it('trims answers before comparing', () => {
    const result = gradeRotProbe(request(), [
      { caseId: 'rot-1', answer: '  hunter2\n' },
      { caseId: 'rot-2', answer: 'add-users' },
    ]);
    assert.equal(result.score, 1);
  });

  it('excludes unanswered and unknown cases instead of scoring them', () => {
    const result = gradeRotProbe(request(), [
      { caseId: 'rot-1', answer: 'hunter2' },
      { caseId: 'ghost', answer: 'hunter2' },
    ]);
    assert.equal(result.scored, 1, 'rot-2 was never delivered, so it is not a wrong answer');
    assert.equal(result.excluded, 3, 'rot-2 and the NIAH case went unanswered, plus one never-asked id');
    assert.deepEqual(result.unknownIds, ['ghost']);
    assert.equal(result.score, 1);
  });

  it('is unscored, never silently perfect, when no rot case came back', () => {
    const result = gradeRotProbe(request(), [{ caseId: 'niah-1', answer: 'needle' }]);
    assert.equal(result.score, null);
    assert.equal(result.state, 'unscored');
    assert.equal(result.passed, false);
  });

  it('fails a perfect NIAH reading with every rot case wrong', () => {
    const result = gradeRotProbe(request(), [
      { caseId: 'rot-1', answer: 'nope' },
      { caseId: 'rot-2', answer: 'nope' },
      { caseId: 'niah-1', answer: 'needle' },
    ]);
    assert.equal(result.score, 0);
    assert.equal(result.state, 'ok');
    assert.equal(result.passed, false, 'zero is the only floor that needs no invented constant');
  });

  it('marks the firing confounded when the control falls too', () => {
    const result = gradeRotProbe(request(), [
      { caseId: 'rot-1', answer: 'hunter2' },
      { caseId: 'rot-2', answer: 'add-users' },
      { caseId: 'niah-1', answer: 'wrong' },
    ]);
    assert.equal(result.niahScore, 0);
    assert.equal(result.state, 'confounded');
    assert.equal(result.passed, false);
  });

  it('reads one deleted observation as no reading at all', () => {
    assert.equal(observationOf(gradeRotProbe(request(), [])), null);
    assert.deepEqual(
      observationOf(gradeRotProbe(request(), [{ caseId: 'rot-1', answer: 'hunter2' }, { caseId: 'rot-2', answer: 'add-users' }])),
      { turn: 50, tier: 't50', fill: 0.5, score: 1 },
    );
  });

  it('lets a throwing subject reject here — the scheduler owns fail-open', async () => {
    const subject = {
      id: 'boom',
      answerRot: () => Promise.reject(new Error('provider 500')),
    };
    await assert.rejects(() => runRotProbe(subject, request()), /provider 500/);
  });
});

describe('the curve — slope, never endpoint', () => {
  const degrading = observationsOf([
    { turn: 5, tier: 't05', fill: 0.05, score: 1 },
    { turn: 20, tier: 't20', fill: 0.2, score: 0.9 },
    { turn: 50, tier: 't50', fill: 0.5, score: 0.7 },
    { turn: 80, tier: 't80', fill: 0.8, score: 0.5 },
  ]);

  it('pools observations by tier', () => {
    const tiers = rotTierAccuracy(degrading);
    assert.equal(tiers.length, 4);
    assert.deepEqual(tiers.map((tier) => tier.observations), [1, 1, 1, 1]);
    assert.deepEqual(tiers.map((tier) => tier.score), [1, 0.9, 0.7, 0.5]);
    const empty = rotTierAccuracy([]);
    assert.deepEqual(empty.map((tier) => tier.score), [null, null, null, null]);
  });

  it('reports degradation per fill as positive', () => {
    const fit = rotDegradationSlope(rotTierAccuracy(degrading));
    assert.equal(fit.points, 4);
    assert.ok(fit.slope > 0, `expected a positive degradation slope, got ${fit.slope}`);
    assert.ok((fit.rSquared ?? 0) > 1 - 1e-9, 'these four points are exactly linear');
  });

  it('reports a flat curve as slope zero', () => {
    const flat = observationsOf([
      { turn: 5, tier: 't05', fill: 0.05, score: 1 },
      { turn: 80, tier: 't80', fill: 0.8, score: 1 },
    ]);
    assert.equal(rotDegradationSlope(rotTierAccuracy(flat)).slope, 0);
  });

  it('returns NaN rather than an infinite slope through one point', () => {
    const one = observationsOf([{ turn: 5, tier: 't05', fill: 0.05, score: 1 }]);
    const fit = rotDegradationSlope(rotTierAccuracy(one));
    assert.equal(fit.points, 1);
    assert.ok(Number.isNaN(fit.slope));
    assert.equal(fit.rSquared, null);
  });
});

describe('series validity — is the curve about rot, or about long input?', () => {
  const degrading = rotTierAccuracy(observationsOf([
    { turn: 5, tier: 't05', fill: 0.05, score: 1 },
    { turn: 80, tier: 't80', fill: 0.8, score: 0.4 },
  ]));
  const flat = rotTierAccuracy(observationsOf([
    { turn: 5, tier: 't05', fill: 0.05, score: 1 },
    { turn: 80, tier: 't80', fill: 0.8, score: 1 },
  ]));

  it('is distinguishing when rot falls and NIAH holds', () => {
    const validity = evaluateRotProbeValidity(degrading, { t05: 1, t20: null, t50: null, t80: 1 });
    assert.equal(validity.status, 'distinguishing');
    assert.ok(validity.rotDrop < 0);
  });

  it('is confounded when NIAH falls alongside the rot cases', () => {
    const validity = evaluateRotProbeValidity(degrading, { t05: 1, t20: null, t50: null, t80: 0.5 });
    assert.equal(validity.status, 'confounded');
    assert.match(validity.statement, /long input is hard/);
  });

  it('is blind when nothing degrades', () => {
    const validity = evaluateRotProbeValidity(flat, { t05: 1, t20: null, t50: null, t80: 1 });
    assert.equal(validity.status, 'blind');
  });

  it('is undetermined with fewer than two scored tiers', () => {
    const one = rotTierAccuracy(observationsOf([{ turn: 5, tier: 't05', fill: 0.05, score: 1 }]));
    assert.equal(evaluateRotProbeValidity(one, { t05: 1, t20: null, t50: null, t80: null }).status, 'undetermined');
  });

  it('does not call a falling control a confound when the rot cases held', () => {
    const validity = evaluateRotProbeValidity(flat, { t05: 1, t20: null, t50: null, t80: 0.5 });
    assert.equal(validity.status, 'undetermined');
  });

  it('shares E2\u2019s threshold rather than inventing one', () => {
    assert.equal(ROT_NIAH_MAX_DROP, 0.1);
  });
});
