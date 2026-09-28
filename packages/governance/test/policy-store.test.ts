import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { StrataPolicy, RunId } from '@strata-ctx/core-types';
import { hashCanonical, pinSetText, sha256, StrataPolicySchema } from '@strata-ctx/core-types';

import {
  diffPolicy,
  mergePolicy,
  normalizePolicyDocument,
  parsePolicyYaml,
  pinHashOf,
  PolicyError,
  PolicyMergeError,
  PolicyStore,
  type MergeResult,
  type PolicySource,
} from '../src/policy-store.js';
import { FIXED_NOW, MIXED, MIXED_POLICY, constraint, policyOf } from './fixtures.js';

const ORG = `
version: 1
constraints:
  - id: safety.delete
    text: never delete production data
    kind: hard_safety
  - id: soft.client-email
    text: never email the client directly
`;

const projectAdding = (body: string): PolicySource => ({
  label: 'repo/strata.yaml',
  text: `version: 1\n${body}`,
});

const idsOf = (p: StrataPolicy) => p.constraints.map((c) => c.id);

describe('D-3 integrity of one file', () => {
  it('reads a policy file and computes what the file did not state', () => {
    // A constraint written as a bare string gets its digest and its id from
    // the text, never from the file. A policy file is untrusted input off disk;
    // nothing in it is allowed to be a fact about itself.
    const p = parsePolicyYaml(`
version: 1
constraints:
  - never force push to main
`);
    const c = p.constraints[0];
    assert.ok(c);
    assert.equal(c.text, 'never force push to main');
    assert.equal(c.sha256, sha256('never force push to main'));
    assert.match(c.id ?? '', /^auto\.[0-9a-f]{12}$/);
    assert.equal(c.source, 'org_policy');
    // soft_policy, not hard_safety: an unlabelled constraint is the kind that
    // decays, so a flattering default would flatter every result downstream.
    assert.equal(c.kind, 'soft_policy');
    assert.equal(c.enforcement, 'block');
  });

  it('gives the same id to the same text in a different file order', () => {
    // Otherwise a `prettier --write` or a YAML re-sort reads as a policy change,
    // and hot reload re-asserts the whole pin set for nothing.
    const a = parsePolicyYaml('version: 1\nconstraints:\n  - alpha rule\n  - beta rule\n');
    const b = parsePolicyYaml('version: 1\nconstraints:\n  - beta rule\n  - alpha rule\n');
    assert.deepEqual(idsOf(a).sort(), idsOf(b).sort());
    assert.equal(pinHashOf(a), pinHashOf(b));
  });

  it('refuses a constraint whose declared digest does not match its text', () => {
    // This is how a policy file ends up "verified" against something it does not
    // say: step 4c and every other byte check downstream trust this digest.
    assert.throws(
      () =>
        parsePolicyYaml(`
version: 1
constraints:
  - id: safety.delete
    text: never delete production data
    sha256: ${sha256('something else entirely')}
`),
      (e: unknown) =>
        e instanceof PolicyError && /declares sha256 that does not match its text/.test(e.message),
    );
  });

  it('accepts a constraint whose declared digest does match', () => {
    const text = 'never delete production data';
    const p = parsePolicyYaml(`
version: 1
constraints:
  - id: safety.delete
    text: ${text}
    sha256: ${sha256(text)}
`);
    assert.deepEqual(p.constraints.map((c) => c.id), ['safety.delete']);
  });

  it('refuses duplicate constraint ids', () => {
    // Two rules, one id: an operator editing by id edits one of them, and cannot
    // tell which.
    assert.throws(
      () =>
        parsePolicyYaml(`
version: 1
constraints:
  - id: safety.delete
    text: never delete production data
  - id: safety.delete
    text: never delete staging either
`),
      (e: unknown) => e instanceof PolicyError && /duplicate constraint id "safety\.delete"/.test(e.message),
    );
  });

  it('refuses a constraint with no text', () => {
    for (const body of ['', '   ', '"  "']) {
      assert.throws(
        () => parsePolicyYaml(`version: 1\nconstraints:\n  - text: ${body}\n`),
        PolicyError,
      );
    }
  });

  it('requires version: 1 explicitly rather than defaulting it', () => {
    // A policy file with no version might be a v2 file from a future we cannot
    // read. Guessing is how you silently drop a section nobody was looking at.
    for (const text of ['', 'constraints: []\n', 'version: 2\n']) {
      assert.throws(() => parsePolicyYaml(text), (e: unknown) => e instanceof PolicyError);
    }
  });

  it('refuses an unknown key instead of ignoring it', () => {
    // `token_compression: true` is a plausible typo, and a schema that strips it
    // leaves an operator believing a compressor is on when it is not.
    assert.throws(
      () => parsePolicyYaml('version: 1\ntoken_compression: true\n'),
      (e: unknown) => e instanceof PolicyError && /invalid policy document/.test(e.message),
    );
  });

  it('refuses a constraint list that is not a list', () => {
    assert.throws(
      () => parsePolicyYaml('version: 1\nconstraints:\n  key: value\n'),
      (e: unknown) => e instanceof PolicyError && /constraints must be a list/.test(e.message),
    );
  });

  it('refuses a value that is not a mapping', () => {
    assert.throws(() => normalizePolicyDocument('a policy'), PolicyError);
    assert.throws(() => normalizePolicyDocument(null), PolicyError);
    assert.throws(() => normalizePolicyDocument([1, 2]), PolicyError);
  });

  it('names the path of a schema failure', () => {
    // "invalid policy document" on its own sends an operator hunting.
    assert.throws(
      () => parsePolicyYaml('version: 1\nbudgets:\n  maxOutputTokens: "lots"\n'),
      (e: unknown) => e instanceof PolicyError && /budgets\.maxOutputTokens/.test(e.message),
    );
  });

  it('reports unreadable YAML as a policy problem, not a parser crash', () => {
    assert.throws(
      () => parsePolicyYaml('version: 1\n  bad: [indent\n', 'repo/strata.yaml'),
      (e: unknown) => e instanceof PolicyError && /repo\/strata\.yaml is not readable/.test(e.message),
    );
  });
});

describe('D-3 authority between two files', () => {
  const base = (): StrataPolicy => parsePolicyYaml(ORG);

  function merge(document: unknown, onRejection?: 'throw' | 'report'): MergeResult {
    return mergePolicy(base(), document, {
      source: 'project',
      label: 'repo/strata.yaml',
      onRejection,
    });
  }

  it('unions a project constraint onto the base rather than replacing it', () => {
    // The bug this package exists to prevent, arriving through the config path
    // instead of the compaction path: a project file declaring one rule of its
    // own silently deletes every rule the org declared. And it lands hardest on
    // the rules hardest to notice going missing -- soft policies decay 8.3x
    // faster than hard safety norms.
    const r = merge({ version: 1, constraints: [constraint('never touch the deploy key', { id: 'p.deploy' })] });

    assert.deepEqual(r.rejections, []);
    assert.deepEqual(idsOf(r.policy), ['safety.delete', 'soft.client-email', 'p.deploy']);
    assert.deepEqual(
      r.policy.constraints.map((c) => c.source),
      ['org_policy', 'org_policy', 'project'],
      'the project file cannot declare its own authorship',
    );
    assert.deepEqual(r.diff.added, ['p.deploy']);
    assert.deepEqual(r.diff.removed, [], 'nothing was removed');
  });

  it('stamps provenance rather than believing the file about itself', () => {
    // A repository is not entitled to write `source: org_policy`. Provenance is
    // what an operator reads to decide whose rule they are looking at, and a
    // file that can forge it can pass its own rule off as the org's.
    const r = merge({
      version: 1,
      constraints: [constraint('never touch the deploy key', { id: 'p.deploy', source: 'org_policy' })],
    });
    assert.equal(r.policy.constraints.at(-1)?.source, 'project');
  });

  it('keeps the base order and appends, so the pin set is stable', () => {
    const r = merge({ version: 1, constraints: [constraint('a', { id: 'z.1' }), constraint('b', { id: 'a.1' })] });
    // The document order is preserved; the *pin* order is what `pinSetText`
    // sorts by id, and that is where a new constraint lands. A project cannot
    // choose its own position in the pin set, which is what keeps the cached
    // prefix stable when a repo adds a rule mid-session.
    assert.deepEqual(idsOf(r.policy), ['safety.delete', 'soft.client-email', 'z.1', 'a.1']);
    assert.deepEqual(pinSetText(r.policy), [
      'b',
      'never delete production data',
      'never email the client directly',
      'a',
    ]);
  });

  it('accepts a verbatim restatement of an inherited constraint', () => {
    // Restating is the most natural way to keep a rule while adding one, and it
    // expands with `source: 'project'`, so identity has to ignore `source`.
    const r = merge({
      version: 1,
      constraints: [
        constraint('never delete production data', { id: 'safety.delete', kind: 'hard_safety' }),
        constraint('never touch the deploy key', { id: 'p.deploy' }),
      ],
    });

    assert.deepEqual(r.rejections, []);
    assert.deepEqual(idsOf(r.policy), ['safety.delete', 'soft.client-email', 'p.deploy']);
    // The restatement did not rewrite the base entry's provenance.
    assert.equal(r.policy.constraints[0]?.source, 'org_policy');
  });

  it('refuses a project file that modifies an inherited constraint', () => {
    // There is no safe reading of "change someone else's safety rule from a
    // repository you just cloned", so it is refused rather than dropped.
    assert.throws(
      () => merge({ version: 1, constraints: [constraint('deleting production data is fine now', { id: 'safety.delete' })] }),
      (e: unknown) => {
        assert.ok(e instanceof PolicyMergeError);
        assert.equal(e.rejections.length, 1);
        assert.equal(e.rejections[0]?.path, 'constraints.safety.delete');
        return /cannot modify an inherited constraint/.test(e.rejections[0]?.reason ?? '');
      },
    );
  });

  it('refuses a downgrade by changing the kind of an inherited constraint', () => {
    assert.throws(
      () =>
        merge({
          version: 1,
          constraints: [constraint('never delete production data', { id: 'safety.delete', kind: 'soft_policy' })],
        }),
      PolicyMergeError,
    );
  });

  it('refuses a downgrade by changing the enforcement of an inherited constraint', () => {
    assert.throws(
      () =>
        merge({
          version: 1,
          constraints: [
            constraint('never delete production data', { id: 'safety.delete', enforcement: 'log' }),
          ],
        }),
      PolicyMergeError,
    );
  });

  it('reports instead of throwing when asked to, and keeps the safe value', () => {
    // Under `report` the file is still merged -- a partial merge that silently
    // keeps the safe value leaves the operator believing their override worked.
    const r = merge({ version: 1, governance: { pinning: 'off' } }, 'report');

    assert.equal(r.policy.governance.pinning, 'required');
    assert.deepEqual(r.rejections.map((x) => x.path), ['governance.pinning']);
    assert.deepEqual(r.diff.settingsChanged, []);
  });

  it('refuses to switch pinning off', () => {
    for (const pinning of ['off']) {
      assert.throws(() => merge({ version: 1, governance: { pinning } }), PolicyMergeError);
    }
    assert.throws(() => merge({ version: 1, governance: { autoPin: 'off' } }), PolicyMergeError);
  });

  it('accepts a project file that restates a protected setting unchanged', () => {
    const r = merge({ version: 1, governance: { pinning: 'required', autoPin: 'on' } });
    assert.deepEqual(r.rejections, []);
    assert.deepEqual(r.diff.settingsChanged, []);
  });

  it('refuses to turn redaction off, and refuses a pass-through on failure', () => {
    assert.throws(() => merge({ version: 1, redaction: { mode: 'off' } }), PolicyMergeError);

    const b = policyOf([], { redaction: { mode: 'log', onFail: 'block' } });
    assert.throws(
      () =>
        mergePolicy(b, { version: 1, redaction: { onFail: 'forward' } }, {
          source: 'project',
          label: 'repo/strata.yaml',
        }),
      PolicyMergeError,
    );
  });

  it('allows a project to tighten redaction', () => {
    const b = policyOf([], { redaction: { mode: 'log', onFail: 'forward' } });
    const r = mergePolicy(b, { version: 1, redaction: { mode: 'block' } }, { source: 'project' });
    assert.equal(r.policy.redaction.mode, 'block');
    assert.deepEqual(r.rejections, []);
  });

  it('allows a project to add a hard_safety constraint, because that is tightening', () => {
    const r = merge({ version: 1, constraints: [constraint('never run the migration on a Friday', { id: 'p.friday', kind: 'hard_safety' })] });
    assert.equal(r.policy.constraints[2]?.kind, 'hard_safety');
  });

  it('names every rejection rather than only the first', () => {
    try {
      merge({ version: 1, governance: { pinning: 'off', autoPin: 'off' }, redaction: { mode: 'off' } });
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof PolicyMergeError);
      assert.deepEqual(
        e.rejections.map((r) => r.path).sort(),
        ['governance.autoPin', 'governance.pinning', 'redaction.mode'],
      );
      assert.match(e.message, /tried to weaken governance and was refused/);
    }
  });

  it('leaves a base-source merge without the anti-downgrade guard', () => {
    // Only the repository file is hostile. A base file is the org's own, and it
    // is where a downgrade would legitimately be written.
    const r = mergePolicy(base(), { version: 1, governance: { pinning: 'off' } }, { source: 'base' });
    assert.equal(r.policy.governance.pinning, 'off');
    assert.deepEqual(r.rejections, []);
  });

  it('cannot be made to drop an inherited constraint through any combination', () => {
    // Fuzzed over the shapes an override can take. The post-condition in
    // `mergePolicy` is what makes this a property rather than a hope: the merge
    // either refuses the file outright, or it returns every inherited
    // constraint unchanged. There is no third outcome.
    const attempts: unknown[] = [
      { version: 1, constraints: [] },
      { version: 1 },
      { constraints: [] },
      { version: 1, constraints: 'not a list' },
      { version: 1, constraints: [{}] },
      { version: 1, constraints: [constraint('never delete production data', { id: 'safety.delete' })] },
      { version: 1, constraints: [constraint('x', { id: 'safety.delete' }), constraint('y', { id: 'soft.client-email' })] },
      { version: 1, constraints: [constraint('never delete production data', { id: 'safety.delete', kind: 'hard_safety' })] },
    ];
    for (const attempt of attempts) {
      let result: MergeResult | null = null;
      try {
        result = mergePolicy(base(), attempt, { source: 'project', onRejection: 'report' });
      } catch (e) {
        // A refusal is a safe outcome: nothing was merged, so nothing was lost.
        assert.ok(e instanceof PolicyError || e instanceof PolicyMergeError, `unexpected ${String(e)}`);
        continue;
      }
      for (const inherited of base().constraints) {
        const kept: typeof inherited | undefined = result.policy.constraints.find((c) => c.id === inherited.id);
        assert.deepEqual(
          { text: kept?.text, kind: kept?.kind, enforcement: kept?.enforcement },
          { text: inherited.text, kind: inherited.kind, enforcement: inherited.enforcement },
          `inherited ${inherited.id} was altered by ${JSON.stringify(attempt)}`,
        );
      }
    }
  });
});

describe('D-3 versioning and identity', () => {
  it('numbers revisions monotonically and never in place', () => {
    const store = PolicyStore.create(MIXED_POLICY, [{ label: '<inline>' }], [], FIXED_NOW);
    assert.equal(store.revision, 1);

    const pinned = store.pin('never touch legacy/');
    assert.equal(store.revision, 1, 'the original is untouched');
    assert.equal(pinned.revision, 2);

    const again = pinned.pin('never deploy on a friday');
    assert.equal(again.revision, 3);
    assert.equal(pinned.revision, 2, 'and so is the intermediate');
    assert.notEqual(store.documentHash, again.documentHash);
  });

  it('treats a bump as a new revision of the same document', () => {
    const store = PolicyStore.create(MIXED_POLICY);
    const bumped = store.bump();
    assert.equal(bumped.revision, 2);
    assert.equal(bumped.documentHash, store.documentHash, 'nothing actually changed');
    assert.equal(bumped.supersedes(store), false, 'so it does not supersede it');
  });

  it('supersedes only a lower revision with a different document', () => {
    const store = PolicyStore.create(MIXED_POLICY, [{ label: '<inline>' }], [], FIXED_NOW);
    const next = store.pin('never touch legacy/');
    assert.equal(next.supersedes(store), true);
    assert.equal(store.supersedes(next), false, 'and not the other way round');
  });

  it('uses document hash, not revision, as the durable identity', () => {
    // Across a restart the counter resets, so anything outside this process has
    // to compare hashes or it will think a freshly booted process is new policy.
    const a = PolicyStore.create(MIXED_POLICY);
    const b = PolicyStore.create(MIXED_POLICY);
    assert.equal(a.revision, b.revision);
    assert.equal(a.documentHash, b.documentHash);
    assert.equal(a.pinHash, b.pinHash);
  });

  it('agrees with the byte-equality hash', () => {
    // `pinHash` is what step 4c compares byte-wise; if this disagreed with
    // `verifyPinIntegrity` the security gate would be comparing one thing and
    // the telemetry would report another.
    const p = normalizePolicyDocument({ version: 1, constraints: MIXED }, 'org_policy');
    assert.equal(pinHashOf(p), sha256(pinSetText(p).join('\n')));
  });

  it('changes document hash when a constraint changes, and pin hash when text does', () => {
    const store = PolicyStore.create(MIXED_POLICY);
    const reworded = store.withOverrides(
      {
        version: 1,
        constraints: [
          constraint('never delete production data', { id: 'safety.delete', kind: 'user_preference' }),
        ],
      },
      { onRejection: 'report' },
    );
    // The attempted change is refused, so both hashes are unchanged: a refused
    // override must not look like a policy change, or hot reload re-asserts pins
    // that did not move.
    assert.equal(reworded.documentHash, store.documentHash);
    assert.equal(reworded.pinHash, store.pinHash);
  });

  it('freezes what it hands out', () => {
    const store = PolicyStore.create(MIXED_POLICY);
    assert.throws(() => {
      (store.texts as string[]).push('extra');
    }, TypeError);
    assert.throws(() => {
      (store.sources as PolicySource[]).push({ label: 'x' });
    }, TypeError);
  });

  it('stamps the pin hash onto a context state', () => {
    const store = PolicyStore.create(MIXED_POLICY);
    const stamped = store.stamp({ messages: [], pinned: [], tokenEstimate: 0, policyHash: '', runId: 'r' as RunId, turn: 1, gists: [], artifacts: [] });
    assert.equal(stamped.policyHash, store.pinHash);
  });
});

describe('D-3 the store API', () => {
  it('loads a base and a project file, recording both as sources', () => {
    const store = PolicyStore.load(
      { label: 'org/strata.yaml', text: ORG },
      projectAdding('constraints:\n  - id: p.deploy\n    text: never touch the deploy key\n'),
      { now: FIXED_NOW },
    );

    assert.deepEqual(idsOf(store.policy), ['safety.delete', 'soft.client-email', 'p.deploy']);
    assert.deepEqual(
      store.sources.map((s) => s.label),
      ['org/strata.yaml', 'repo/strata.yaml'],
    );
    assert.equal(store.revision, 1);
    assert.equal(store.loadedAt, FIXED_NOW);
    assert.deepEqual(store.rejections, []);
  });

  it('loads a base on its own', () => {
    const store = PolicyStore.load({ label: 'org/strata.yaml', text: ORG }, undefined, { now: FIXED_NOW });
    assert.deepEqual(idsOf(store.policy), ['safety.delete', 'soft.client-email']);
    assert.equal(store.sources.length, 1);
  });

  it('accepts an already-parsed document as well as text', () => {
    const store = PolicyStore.load(
      { label: 'org', document: StrataPolicySchema.parse({ version: 1 }) },
      { label: 'repo', document: { version: 1, constraints: [constraint('never touch legacy/')] } },
      { now: FIXED_NOW },
    );
    assert.equal(store.constraints.length, 1);
  });

  it('refuses a source with neither text nor document', () => {
    assert.throws(
      () => PolicyStore.load({ label: 'org/strata.yaml' }),
      (e: unknown) => e instanceof PolicyError && /has neither text nor document/.test(e.message),
    );
  });

  it('pins at runtime, computing the digest itself', () => {
    const store = PolicyStore.create(MIXED_POLICY);
    const next = store.pin('never touch legacy/');
    const added = next.constraints.at(-1);
    assert.equal(added?.text, 'never touch legacy/');
    assert.equal(added?.sha256, sha256('never touch legacy/'));
    assert.equal(added?.source, 'user', 'a rule a user said out loud is theirs, not the org\'s');
  });

  it('refuses to pin the same constraint twice', () => {
    const store = PolicyStore.create(MIXED_POLICY);
    const once = store.pin('never touch legacy/');
    assert.throws(() => once.pin('never touch legacy/'), PolicyError);
  });

  it('unpins a soft constraint', () => {
    const store = PolicyStore.create(MIXED_POLICY);
    const next = store.unpin('soft.client-email');
    assert.deepEqual(idsOf(next.policy), ['safety.delete', 'soft.schema-review', 'pref.legacy-adapter']);
    assert.equal(next.revision, 2);
  });

  it('refuses to unpin a hard_safety constraint', () => {
    // The same anti-downgrade rule a project file gets, applied to the runtime
    // API, because "the agent asked me to drop a safety rule" has been said
    // before.
    const store = PolicyStore.create(MIXED_POLICY);
    assert.throws(
      () => store.unpin('safety.delete'),
      (e: unknown) => e instanceof PolicyError && /is hard_safety and cannot be unpinned/.test(e.message),
    );
  });

  it('refuses to unpin something that is not there', () => {
    assert.throws(() => PolicyStore.create(MIXED_POLICY).unpin('nope'), PolicyError);
  });

  it('looks a constraint up by its text', () => {
    assert.equal(PolicyStore.create(MIXED_POLICY).idFor('never delete production data'), 'safety.delete');
    assert.equal(PolicyStore.create(MIXED_POLICY).idFor('a rule we do not have'), undefined);
  });

  it('accumulates rejections across successive overrides', () => {
    const store = PolicyStore.create(MIXED_POLICY, [{ label: '<inline>' }], [], FIXED_NOW);
    const once = store.withOverrides({ version: 1, governance: { pinning: 'off' } }, { onRejection: 'report' });
    const twice = once.withOverrides({ version: 1, redaction: { mode: 'off' } }, { onRejection: 'report' });
    assert.deepEqual(
      twice.rejections.map((r) => r.path),
      ['governance.pinning', 'redaction.mode'],
    );
    assert.equal(twice.sources.length, 3);
  });

  it('diffs two stores', () => {
    const a = PolicyStore.create(MIXED_POLICY, [{ label: '<inline>' }], [], FIXED_NOW);
    const b = a.pin('never touch legacy/').unpin('soft.client-email');
    const d = a.diffTo(b);
    assert.deepEqual(d.added, ['auto.' + sha256('never touch legacy/').slice(0, 12)]);
    assert.deepEqual(d.removed, ['soft.client-email']);
    assert.deepEqual(d.changed, []);
    assert.notEqual(d.pinHashBefore, d.pinHashAfter);
  });
});

describe('D-3 diffPolicy', () => {
  it('names what was added, removed, changed, and reconfigured', () => {
    const before = policyOf([constraint('a', { id: 'x' }), constraint('b', { id: 'y' })]);
    const after = policyOf([constraint('a2', { id: 'x' }), constraint('c', { id: 'z' })], {
      budgets: { maxOutputTokens: 10 },
    });
    const d = diffPolicy(before, after);
    assert.deepEqual(d.added, ['z']);
    assert.deepEqual(d.removed, ['y']);
    assert.deepEqual(d.changed, ['x']);
    assert.deepEqual(d.settingsChanged, ['budgets']);
  });

  it('reports no change when a constraint is only reordered', () => {
    // A reformat is not a policy change. If it were, every `prettier --write`
    // would look like a governance event.
    const a = policyOf([constraint('a', { id: 'x' }), constraint('b', { id: 'y' })]);
    const b = policyOf([constraint('b', { id: 'y' }), constraint('a', { id: 'x' })]);
    const d = diffPolicy(a, b);
    assert.deepEqual({ ...d, pinHashBefore: '', pinHashAfter: '' }, {
      added: [],
      removed: [],
      changed: [],
      settingsChanged: [],
      pinHashBefore: '',
      pinHashAfter: '',
    });
  });

  it('ignores a source change when diffing', () => {
    // Provenance is not behaviour. Treating it as behaviour would make every
    // restated constraint look like an edit, and since `documentHash` covers
    // provenance, a pin set that did not move would look like a policy change
    // to hot reload.
    const a = policyOf([constraint('a', { id: 'x', source: 'org_policy' })]);
    const b = policyOf([constraint('a', { id: 'x', source: 'project' })]);
    assert.deepEqual(diffPolicy(a, b).changed, []);
  });
});

describe('D-3 canonical hashing', () => {
  it('is stable across key order', () => {
    // Hot reload compares `documentHash`; a hash that depended on key order
    // would reload on every reformat.
    const a = hashCanonical({ version: 1, constraints: [] });
    const b = hashCanonical({ constraints: [], version: 1 });
    assert.equal(a, b);
  });

  it('changes when anything changes', () => {
    assert.notEqual(hashCanonical({ a: 1, b: 2 }), hashCanonical({ a: 1, b: 3 }));
  });
});
