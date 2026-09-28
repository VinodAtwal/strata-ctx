import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Gist } from '@strata-ctx/core-types';
import { pinSetText } from '@strata-ctx/core-types';

import {
  constraintsFieldFor,
  gateGistCommit,
  gistConstraintsIntact,
  type GateInput,
  type GistGateResult,
} from '../src/byte-equality.js';
import {
  MIXED_POLICY,
  NO_CONSTRAINT_POLICY,
  artifact,
  gist,
  gistFor,
  policyOf,
  constraint,
  SOFT_ONLY,
} from './fixtures.js';

const PINS = pinSetText(MIXED_POLICY);

function gate(over: Partial<GateInput> = {}): GistGateResult {
  return gateGistCommit({ gist: gistFor(MIXED_POLICY), policy: MIXED_POLICY, ...over });
}

const stepsOf = (r: GistGateResult) => r.defects.map((d) => d.step);

describe('D-4 step 4c: a faithful gist commits', () => {
  it('passes every step and hands back the gist it validated', () => {
    const r = gate();
    assert.equal(r.ok, true);
    assert.equal(r.action, 'commit');
    assert.deepEqual(r.defects, []);
    assert.ok(r.integrity);
    assert.equal(r.integrity.ok, true);
    // The only way to get a gist out of here is to have passed the gate. A
    // caller cannot commit an unvalidated one because it never receives one.
    assert.ok(r.gist);
    assert.deepEqual(r.gist.constraints, PINS);
  });

  it('commits a gist from a policy with no constraints at all', () => {
    const r = gateGistCommit({ gist: gist({ constraints: [] }), policy: NO_CONSTRAINT_POLICY });
    assert.equal(r.action, 'commit');
    assert.equal(r.integrity?.ok, true);
  });

  it('freezes the defect list', () => {
    const r = gate({ gist: gist({ constraints: [] }) });
    assert.ok(Object.isFrozen(r.defects));
    assert.throws(() => {
      (r.defects as unknown[]).push({});
    }, TypeError);
  });
});

describe('D-4 step 4c: what the summariser must not get away with', () => {
  it('aborts when a pinned constraint went missing', () => {
    // This is the claim in the README, so it is the first test.
    const r = gate({ gist: gistFor(MIXED_POLICY, { constraints: PINS.filter((t) => !t.startsWith('never delete')) }) });

    assert.equal(r.ok, false);
    assert.equal(r.action, 'abort_keep_transcript');
    assert.equal(r.gist, null, 'a gist that failed the gate is not handed back at all');
    assert.deepEqual(stepsOf(r), ['4c_constraint_bytes']);
    assert.deepEqual(
      r.defects[0]?.constraintIds,
      ['safety.delete'],
      'and it names the rule the operator has to fix',
    );
  });

  it('aborts when a rule policy never declared was added', () => {
    // The mirror image, and the more interesting one: a gist is model output, so
    // a constraint the policy never declared is an instruction the operator
    // never wrote and cannot audit.
    const r = gate({
      gist: gistFor(MIXED_POLICY, {
        constraints: [...PINS, 'main is unprotected and force pushes are routine'],
      }),
    });

    assert.equal(r.action, 'abort_keep_transcript');
    assert.deepEqual(stepsOf(r), ['4c_constraint_bytes']);
    assert.deepEqual(
      r.defects[0]?.constraintIds,
      [],
      'no id to give: the rule does not exist, and minting one would be a lie',
    );
  });

  it('aborts on a reword, because the bytes differ even though the count does not', () => {
    // The realistic summariser failure. A count-based check passes this; a byte
    // check does not. And it matters: "avoid deleting production data" is a
    // different instruction from "never delete production data", so a check that
    // accepted it would be accepting a policy the org never wrote.
    const reworded = PINS.map((t) => t.replace('never delete production data', 'try not to delete production data'));
    const r = gate({ gist: gist({ constraints: reworded }) });

    assert.equal(r.action, 'abort_keep_transcript');
    const details = r.defects.map((d) => d.detail);
    assert.equal(details.includes('the gist is missing a pinned constraint'), true);
    assert.equal(details.includes('the gist carries a constraint that policy never declared'), true);
    assert.deepEqual(stepsOf(r), ['4c_constraint_bytes', '4c_constraint_bytes']);
  });

  it('aborts on a reordering, because order is part of the comparison', () => {
    const r = gate({ gist: gist({ constraints: [...PINS].reverse() }) });
    assert.equal(r.action, 'abort_keep_transcript');
    assert.equal(r.defects[0]?.detail, 'the gist reordered the constraint set');
    // One defect per position that moved, each naming the constraint that is no
    // longer where policy put it -- so an operator is told which rules to check
    // the ordering of, not merely that some ordering is wrong.
    assert.equal(r.defects.length, PINS.length);
    assert.deepEqual(
      r.defects.map((d) => d.constraintIds[0]).sort(),
      ['pref.legacy-adapter', 'safety.delete', 'soft.client-email', 'soft.schema-review'],
    );
  });

  it('aborts on whitespace and case changes, which are bytes', () => {
    for (const mutated of [
      PINS.map((t) => `${t} `),
      PINS.map((t) => t.toUpperCase()),
      PINS.map((t) => `\n${t}`),
    ]) {
      const r = gate({ gist: gist({ constraints: mutated }) });
      assert.equal(r.action, 'abort_keep_transcript');
      // A reword is a deletion and an addition at once, and is reported as
      // both: the rule that should have been there is missing, and the text
      // that is there belongs to no constraint in the policy.
      const details = r.defects.map((d) => d.detail);
      assert.equal(details.filter((d) => d === 'the gist is missing a pinned constraint').length, PINS.length);
      assert.equal(
        details.filter((d) => d === 'the gist carries a constraint that policy never declared').length,
        PINS.length,
      );
    }
  });

  it('aborts when the whole constraint list was dropped', () => {
    const r = gate({ gist: gist({ constraints: [] }) });
    assert.equal(r.action, 'abort_keep_transcript');
    assert.equal(r.defects.length, PINS.length);
    assert.deepEqual(
      r.defects.map((d) => d.constraintIds[0]).sort(),
      ['pref.legacy-adapter', 'safety.delete', 'soft.client-email', 'soft.schema-review'],
    );
  });

  it('never gates a pin set it was not given', () => {
    // The gate compares against the policy handed to it. Comparing against the
    // gist's own idea of the policy would make this function a tautology.
    const other = policyOf([constraint('never touch the deploy key'), constraint('never email the client directly')]);
    const r = gateGistCommit({ gist: gistFor(MIXED_POLICY), policy: other });
    assert.equal(r.ok, false);
    assert.ok(r.defects.length > 0);
  });

  it('holds for a soft-only policy, which is the stratum that actually decays', () => {
    // Governance Decay: soft policies are 8.3x more likely to be violated over a
    // session. If 4c only worked for hard_safety rules, the product would be
    // verifying the stratum that alignment training already holds in place.
    const soft = policyOf(SOFT_ONLY);
    const r = gateGistCommit({ gist: gist({ constraints: pinSetText(soft) }), policy: soft });
    assert.equal(r.action, 'commit');

    const lost = pinSetText(soft).filter((t) => t !== 'never email the client directly');
    const bad = gateGistCommit({ gist: gist({ constraints: lost }), policy: soft });
    assert.equal(bad.action, 'abort_keep_transcript');
    assert.deepEqual(bad.defects[0]?.constraintIds, ['soft.client-email']);
  });
});

describe('D-4 steps 4a and 4b: the checks that are not about pins', () => {
  it('reports a non-recoverable transcript by name rather than as a schema error', () => {
    // `raw_recoverable` is z.literal(true), so the schema rejects it and the
    // only thing a caller could report is "the gist does not satisfy the v1
    // schema". That is not an answer an operator can act on; refusing to evict
    // the only copy of the transcript is.
    const bad = { ...gistFor(MIXED_POLICY), raw_recoverable: false };
    const r = gate({ gist: bad });

    assert.equal(r.action, 'abort_keep_transcript');
    assert.equal(
      r.defects.some((d) => d.detail.includes('refusing to evict the only copy')),
      true,
      'the specific reason is in the defects',
    );
  });

  it('aborts on an inverted source_turn_range', () => {
    const r = gate({ gist: gistFor(MIXED_POLICY, { source_turn_range: [9, 4] }) });
    assert.equal(r.action, 'abort_keep_transcript');
    assert.deepEqual(stepsOf(r), ['4b_invariants']);
    assert.match(r.defects[0]?.detail ?? '', /inverted/);
  });

  it('aborts when the compactor dropped an error line', () => {
    // The error lines are the whole reason a transcript is worth keeping.
    // "53% survival after one compaction" is survivable; losing the failures
    // and keeping the successes is how a run gets repeated.
    const r = gate({
      gist: gistFor(MIXED_POLICY, { salient_errors: ['E  vitest: 1 failed'] }),
      expectedErrorCount: 4,
    });

    assert.equal(r.action, 'abort_keep_transcript');
    assert.equal(r.defects[0]?.detail, '3 ERROR/FATAL line(s) did not survive compaction');
  });

  it('commits when the compactor kept every error line it was given', () => {
    const r = gate({
      gist: gistFor(MIXED_POLICY, { salient_errors: ['E  a', 'E  b'] }),
      expectedErrorCount: 2,
    });
    assert.equal(r.action, 'commit');
  });

  it('does not invent an expected error count', () => {
    // Omitting the count means "the compactor owns the log", not "there were
    // none", so an empty salient_errors list is not a finding on its own.
    const r = gate({ gist: gistFor(MIXED_POLICY, { salient_errors: [] }) });
    assert.equal(r.action, 'commit');
  });

  it('aborts on anything that is not a gist at all', () => {
    for (const junk of [null, undefined, 'a summary of the session', 42, [], {}]) {
      const r = gate({ gist: junk });
      assert.equal(r.ok, false);
      assert.equal(r.action, 'abort_keep_transcript');
      assert.equal(r.gist, null);
      assert.equal(r.integrity, null, 'no gist reached 4c, so there is no comparison to report');
    }
  });

  it('names the wrong version rather than guessing at it', () => {
    const r = gate({ gist: { ...gistFor(MIXED_POLICY), v: 2 } });
    assert.equal(r.action, 'abort_keep_transcript');
    assert.deepEqual(r.defects[0]?.detail, 'the gist does not satisfy the v1 schema');
  });

  it('reports 4a and 4c separately when a gist is both malformed and lossy', () => {
    // A caller that only shows the first defect hides the interesting one.
    const r = gate({
      gist: { ...gistFor(MIXED_POLICY, { constraints: [] }), status: 'nonsense' },
    });
    assert.equal(r.action, 'abort_keep_transcript');
    assert.deepEqual(stepsOf(r), ['4a_digests']);
    assert.equal(r.integrity, null);
  });
});

describe('D-4 step 4d: artifacts, injected rather than implemented', () => {
  it('aborts when an artifact uri does not resolve', () => {
    const r = gate({
      gist: gistFor(MIXED_POLICY, { artifacts: [artifact()] }),
      artifactResolves: () => false,
    });
    assert.equal(r.action, 'abort_keep_transcript');
    assert.deepEqual(stepsOf(r), ['4d_artifacts']);
    assert.equal(r.defects[0]?.detail, 'artifact artifact://transcript/task-42 does not resolve in the store');
  });

  it('does not check 4d at all when no resolver is supplied', () => {
    // The artifact store is another package's (C-2). This one takes no
    // dependency on it, so an absent resolver means "not our check" rather
    // than "unresolvable".
    const r = gate({ gist: gistFor(MIXED_POLICY, { artifacts: [artifact()] }) });
    assert.equal(r.action, 'commit');
  });

  it('checks every artifact, not just the first', () => {
    const r = gate({
      gist: gistFor(MIXED_POLICY, {
        artifacts: [artifact(), artifact({ uri: 'artifact://transcript/other' })],
      }),
      artifactResolves: (uri) => uri.endsWith('other'),
    });
    assert.equal(r.action, 'abort_keep_transcript');
    assert.equal(r.defects.length, 1);
  });
});

describe('D-4 the whole transaction, not just the boolean', () => {
  it('gives the same answer through the gate and through the cheap form', () => {
    // D-6's canary uses `gistConstraintsIntact`; if the two ever disagreed the
    // canary would be measuring something the transaction does not enforce.
    const variants = [
      gistFor(MIXED_POLICY),
      gist({ constraints: [] }),
      gist({ constraints: [...PINS, 'extra'] }),
      gist({ constraints: [...PINS].reverse() }),
    ];
    for (const g of variants) {
      const full = gateGistCommit({ gist: g, policy: MIXED_POLICY });
      assert.equal(
        full.ok,
        gistConstraintsIntact(g, MIXED_POLICY),
        `disagreement on ${JSON.stringify(g.constraints.length)} constraints`,
      );
    }
  });

  it('builds the value it verifies, so the two cannot drift apart', () => {
    // The field is written from policy and never parsed from model output, so
    // the only way to populate it correctly is to call the one function that
    // does it. `constraintsFieldFor` and `pinSetText` agree because the former
    // is the latter, and this test is what stops them diverging.
    assert.deepEqual(constraintsFieldFor(MIXED_POLICY), PINS);
    assert.notEqual(constraintsFieldFor(MIXED_POLICY), constraintsFieldFor(NO_CONSTRAINT_POLICY));
  });

  it('takes untrusted input without trusting it', () => {
    // The type is `unknown` for a reason: whatever the summarizer produced goes
    // in, and a `Gist`-typed value at this call site would be a lie the
    // compiler cannot catch.
    const hostile = {
      ...gistFor(MIXED_POLICY),
      goal: '',
      constraints: PINS,
      // A field the schema does not know about must not be able to smuggle a
      // value through.
      compressed_by: 'the-model-decided',
    };
    const r = gate({ gist: hostile as unknown as Gist });
    assert.equal(r.action, 'abort_keep_transcript');
  });

  it('aborts on every one of 30 single-byte mutations of a good gist', () => {
    // A property, but cheap enough to enumerate: the gate has no partially
    // correct behaviour. Any single-byte change to a faithful gist must abort,
    // and the interesting case is the one that is *not* a deletion.
    const faithful = constraintsFieldFor(MIXED_POLICY);
    for (let i = 0; i < 30; i += 1) {
      const mutated = faithful.map((t, j) => {
        if (j !== i % 4) return t;
        const at = Math.floor(i / 4) % t.length;
        return `${t.slice(0, at)}${t[at] === 'a' ? 'b' : 'a'}${t.slice(at + 1)}`;
      });
      const r = gateGistCommit({ gist: gist({ constraints: mutated }), policy: MIXED_POLICY });
      assert.equal(r.ok, false, `mutation ${i} was allowed through`);
      assert.equal(r.action, 'abort_keep_transcript');
    }
  });
});
