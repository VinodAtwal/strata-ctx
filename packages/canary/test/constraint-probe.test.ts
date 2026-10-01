import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PinnedConstraint } from '@strata-ctx/core-types';
import { sha256 } from '@strata-ctx/core-types';

import {
  DECAY_EXPOSED_STRATA,
  gradeConstraintProbe,
  isDecayExposedStratum,
  poolConstraintRetention,
  runConstraintProbe,
  selectProbeConstraints,
  type ConstraintProbeRequest,
} from '../src/index.js';

function constraint(
  id: string,
  kind: PinnedConstraint['kind'] = 'soft_policy',
): PinnedConstraint {
  const text = `constraint ${id}`;
  return { id, text, sha256: sha256(text), source: 'org_policy', kind, enforcement: 'block' };
}

/** Deliberately soft-heavy: the stratum that decays 8.3x faster. */
const MIXED: readonly PinnedConstraint[] = Object.freeze([
  constraint('pref.legacy-adapter', 'user_preference'),
  constraint('safety.delete', 'hard_safety'),
  constraint('soft.client-email', 'soft_policy'),
  constraint('soft.schema-review', 'soft_policy'),
]);

const HARD_ONLY: readonly PinnedConstraint[] = Object.freeze([constraint('safety.delete', 'hard_safety')]);

function request(over: Partial<ConstraintProbeRequest> = {}): ConstraintProbeRequest {
  return {
    probeId: 'canary.constraint@25' as ConstraintProbeRequest['probeId'],
    turn: 25,
    constraints: MIXED,
    excludedConstraintIds: [],
    includeSoftOrgPolicies: true,
    ...over,
  };
}

describe('selection — the soft-org flag withholds, and reports what it withheld', () => {
  it('selects everything and orders by id when the flag is on', () => {
    const selection = selectProbeConstraints(MIXED, true);
    assert.deepEqual(
      selection.selected.map((entry) => entry.id),
      ['pref.legacy-adapter', 'safety.delete', 'soft.client-email', 'soft.schema-review'],
    );
    assert.deepEqual(selection.excluded, []);
    assert.equal(selection.softShare, 0.75);
  });

  it('excludes every decay-exposed stratum when the flag is off', () => {
    const selection = selectProbeConstraints(MIXED, false);
    assert.deepEqual(selection.selected.map((entry) => entry.id), ['safety.delete']);
    assert.deepEqual(selection.excluded.map((entry) => entry.id), [
      'pref.legacy-adapter',
      'soft.client-email',
      'soft.schema-review',
    ]);
  });

  it('de-duplicates by id and reports the duplicates', () => {
    const selection = selectProbeConstraints([...MIXED, constraint('soft.client-email', 'soft_policy')], true);
    assert.equal(selection.selected.length, MIXED.length);
    assert.deepEqual(selection.duplicateIds, ['soft.client-email']);
  });

  it('exposes the strata the decay finding is about', () => {
    assert.deepEqual([...DECAY_EXPOSED_STRATA], ['soft_policy', 'project_rule', 'user_preference']);
    assert.equal(isDecayExposedStratum('hard_safety'), false);
    assert.equal(isDecayExposedStratum('soft_policy'), true);
  });
});

describe('grading — retention, stratified', () => {
  it('passes only when a decay-exposed stratum was probed and nothing was lost', () => {
    const result = gradeConstraintProbe(request(), {
      retainedConstraintIds: ['pref.legacy-adapter', 'safety.delete', 'soft.client-email', 'soft.schema-review'],
    });
    assert.equal(result.score, 1);
    assert.equal(result.passed, true);
    assert.equal(result.validity, 'measuring');
    assert.deepEqual(result.missing, []);
  });

  it('fails on the first miss, and names it', () => {
    const result = gradeConstraintProbe(request(), {
      retainedConstraintIds: ['safety.delete', 'soft.client-email'],
    });
    assert.equal(result.passed, false);
    assert.deepEqual(result.missing, ['pref.legacy-adapter', 'soft.schema-review']);
    assert.equal(result.score, 0.5);
  });

  it('excludes invented ids from the score instead of letting them widen it', () => {
    const result = gradeConstraintProbe(request({ constraints: HARD_ONLY }), {
      retainedConstraintIds: ['safety.delete', 'ghost', 'ghost-2'],
    });
    assert.deepEqual(result.unknownIds, ['ghost', 'ghost-2']);
    assert.equal(result.score, 1, 'invented ids must not be added to the numerator');
  });

  it('calls a hard-safety-only suite a false green, not a pass', () => {
    const result = gradeConstraintProbe(request({ constraints: HARD_ONLY }), {
      retainedConstraintIds: ['safety.delete'],
    });
    assert.equal(result.validity, 'hard_norms_only');
    assert.equal(result.passed, false, 'a green here would be measuring the provider priors');
  });

  it('cannot pass a firing that measured nothing', () => {
    const result = gradeConstraintProbe(request({ constraints: [] }), { retainedConstraintIds: [] });
    assert.equal(result.score, null);
    assert.equal(result.validity, 'not_measurable');
    assert.equal(result.passed, false);
  });

  it('keeps the per-stratum rates visible instead of averaging the 8.3x away', () => {
    const result = gradeConstraintProbe(request(), {
      retainedConstraintIds: ['safety.delete'],
    });
    assert.equal(result.byStratum.hard_safety.rate, 1);
    assert.equal(result.byStratum.soft_policy.probed, 2);
    assert.equal(result.byStratum.soft_policy.retained, 0);
    assert.equal(result.byStratum.soft_policy.rate, 0);
    assert.equal(result.byStratum.user_preference.probed, 1);
  });
});

describe('pooling', () => {
  it('sums probed and retained per stratum across firings', () => {
    const first = gradeConstraintProbe(request(), {
      retainedConstraintIds: ['pref.legacy-adapter', 'safety.delete', 'soft.client-email', 'soft.schema-review'],
    });
    const second = gradeConstraintProbe(request(), { retainedConstraintIds: ['safety.delete'] });
    const pooled = poolConstraintRetention([first, second]);
    assert.equal(pooled.hard_safety.probed, 2);
    assert.equal(pooled.hard_safety.rate, 1);
    assert.equal(pooled.soft_policy.probed, 4);
    assert.equal(pooled.soft_policy.retained, 2);
    assert.equal(pooled.soft_policy.rate, 0.5);
  });
});

describe('runConstraintProbe', () => {
  it('lets a throwing subject reject here — the scheduler owns fail-open', async () => {
    const subject = {
      id: 'boom',
      probeConstraints: () => Promise.reject(new Error('agent unavailable')),
    };
    await assert.rejects(() => runConstraintProbe(subject, request()), /agent unavailable/);
  });

  it('grades what the subject claims to retain', async () => {
    const subject = {
      id: 'ok',
      probeConstraints: () => Promise.resolve({ retainedConstraintIds: ['safety.delete', 'soft.client-email'] }),
    };
    const result = await runConstraintProbe(subject, request());
    assert.equal(result.probed, 4);
    assert.equal(result.missing.length, 2);
  });
});
