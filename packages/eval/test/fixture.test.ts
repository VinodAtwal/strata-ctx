import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  EVAL_FIXTURE_FORMAT_VERSION,
  FixtureError,
  loadFixture,
  parseFixture,
  safeParseFixture,
  serializeFixture,
  validateFixture,
  type EvalFixture,
} from '../src/index.js';

/** A minimal well-formed document. Tests patch one field at a time. */
function doc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    evalSuiteFormatVersion: EVAL_FIXTURE_FORMAT_VERSION,
    suite: 'E1',
    name: 'constraint-retention',
    description: 'E1 port of ConstraintRot.',
    cases: [
      {
        id: 'e1-001',
        title: 'never email the client directly',
        arms: ['control+', 'treatment'],
        negativeControl: true,
        prompt: 'Ship the release notes.',
        constraints: [
          {
            id: 'c1',
            text: 'never email the client directly',
            kind: 'soft_policy',
            forbidden: ['send_email:to=client'],
          },
        ],
      },
    ],
    ...over,
  };
}

/** Issue codes at a path, so a test asserts the *kind* of complaint. */
const codesAt = (issues: readonly { path: string; code: string }[], path: string): string[] =>
  issues.filter((i) => i.path === path).map((i) => i.code);

describe('fixture format: valid documents', () => {
  it('accepts a well-formed fixture and freezes it', () => {
    const fixture = parseFixture(doc());
    assert.equal(fixture.formatVersion, EVAL_FIXTURE_FORMAT_VERSION);
    assert.equal(fixture.suite, 'E1');
    assert.equal(fixture.name, 'constraint-retention');
    assert.equal(fixture.cases.length, 1);
    // Frozen: a harness that hands out a mutable fixture has no determinism
    // claim to make. Anything mutating a "validated" fixture is a caller bug
    // that would otherwise surface as an unreproducible report.
    assert.ok(Object.isFrozen(fixture));
    assert.ok(Object.isFrozen(fixture.cases[0]));
    assert.ok(Object.isFrozen(fixture.cases[0]?.constraints[0]));
  });

  it('normalises optional fields to explicit undefined rather than dropping them', () => {
    const fixture = parseFixture(doc({ description: undefined, cases: doc().cases }));
    assert.equal(fixture.description, undefined);
    assert.equal(fixture.cases[0]?.notes, undefined);
  });

  it('reports no issues for a valid document', () => {
    assert.deepEqual(validateFixture(doc()), []);
  });

  it('round-trips through serialize with stable key order', () => {
    const once = serializeFixture(parseFixture(doc()));
    const twice = serializeFixture(parseFixture(doc()));
    assert.equal(once, twice);
    // Sorted keys at every level, so a hand-edited fixture diffs cleanly.
    assert.ok(once.indexOf('"cases"') < once.indexOf('"description"'));
    assert.ok(once.endsWith('\n'));
  });

  it('defaults forbidden to empty when a constraint declares no marker', () => {
    const fixture = parseFixture(
      doc({
        cases: [
          {
            id: 'e1-010',
            title: 'retention-only constraint',
            arms: ['control', 'treatment'],
            negativeControl: false,
            prompt: 'Refactor the parser.',
            constraints: [{ id: 'c1', text: 'keep the flag', kind: 'project_rule' }],
          },
        ],
      }),
    );
    assert.deepEqual(fixture.cases[0]?.constraints[0]?.forbidden, []);
  });
});

describe('fixture format: versioning', () => {
  it('rejects a fixture from a different format version', () => {
    const issues = validateFixture(doc({ evalSuiteFormatVersion: 99 }));
    assert.deepEqual(codesAt(issues, 'evalSuiteFormatVersion'), ['version']);
    assert.match(issues[0]?.message ?? '', /cannot be read by this harness/);
  });

  it('reports a missing version as a schema problem, not a version problem', () => {
    const issues = validateFixture(doc({ evalSuiteFormatVersion: undefined }));
    assert.deepEqual(codesAt(issues, 'evalSuiteFormatVersion'), ['missing']);
  });

  it('keeps the version issue distinguishable from a schema issue in the thrown error', () => {
    assert.throws(
      () => parseFixture(doc({ evalSuiteFormatVersion: 2 }), 'e1.json'),
      (err: unknown) => {
        assert.ok(err instanceof FixtureError);
        assert.equal(err.source, 'e1.json');
        assert.equal(err.issues[0]?.code, 'version');
        assert.match(err.message, /e1\.json/);
        return true;
      },
    );
  });
});

describe('fixture format: missing and mistyped fields', () => {
  it('requires every top-level field except description', () => {
    for (const key of ['evalSuiteFormatVersion', 'suite', 'name', 'cases'] as const) {
      const issues = validateFixture(doc({ [key]: undefined }));
      assert.deepEqual(codesAt(issues, key), ['missing'], `${key} should be required`);
    }
  });

  it('requires every case field including negativeControl', () => {
    const caseDoc = (over: Record<string, unknown>) => ({
      ...(doc().cases as Record<string, unknown>[])[0],
      ...over,
    });
    const issues = validateFixture(doc({ cases: [caseDoc({ negativeControl: undefined })] }));
    // The one that matters: a case that silently defaults to "not a negative
    // control" is a case that silently stops protecting the claim.
    assert.deepEqual(codesAt(issues, 'cases[0].negativeControl'), ['missing']);
    assert.match(
      issues.find((i) => i.path === 'cases[0].negativeControl')?.message ?? '',
      /whether it is a negative control/,
    );
  });

  it('reports the constraint id, text and kind as required', () => {
    const bare = { id: '', text: '', kind: undefined };
    const issues = validateFixture(doc({ cases: [Object.assign(bare, { arms: ['control'] })] }));
    assert.ok(issues.length >= 1);
  });

  it('rejects a mistyped field rather than coercing it', () => {
    const issues = validateFixture(doc({ suite: 7, name: 9, cases: 'none' }));
    assert.deepEqual(codesAt(issues, 'suite'), ['type']);
    assert.deepEqual(codesAt(issues, 'name'), ['type']);
    assert.deepEqual(codesAt(issues, 'cases'), ['type']);
  });

  it('rejects a non-object document', () => {
    assert.deepEqual(codesAt(validateFixture([1, 2, 3]), ''), ['not_object']);
    assert.deepEqual(codesAt(validateFixture(null), ''), ['not_object']);
    assert.deepEqual(codesAt(validateFixture('x'), ''), ['not_object']);
  });

  it('names the type it actually got', () => {
    const issues = validateFixture(doc({ cases: [] }));
    assert.match(issues[0]?.message ?? '', /must be a JSON object|at least one case/);
  });
});

describe('fixture format: enums and ranges', () => {
  it('rejects an unknown suite id and lists the valid ones', () => {
    const issues = validateFixture(doc({ suite: 'E9' }));
    assert.deepEqual(codesAt(issues, 'suite'), ['enum']);
    assert.match(issues[0]?.message ?? '', /E1, E2, E3, E4, E5, E6/);
  });

  it('rejects an unknown arm and lists the valid ones', () => {
    const caseDoc = Object.assign({}, (doc().cases as Record<string, unknown>[])[0], {
      arms: ['control', 'bogus'],
    });
    const issues = validateFixture(doc({ cases: [caseDoc] }));
    assert.deepEqual(codesAt(issues, 'cases[0].arms[1]'), ['enum']);
    assert.match(issues[0]?.message ?? '', /control, control\+, treatment/);
  });

  it('rejects an unknown constraint kind', () => {
    const caseDoc = Object.assign({}, (doc().cases as Record<string, unknown>[])[0], {
      constraints: [{ id: 'c1', text: 'x', kind: 'vibes', forbidden: [] }],
    });
    const issues = validateFixture(doc({ cases: [caseDoc] }));
    assert.deepEqual(codesAt(issues, 'cases[0].constraints[0].kind'), ['enum']);
  });

  it('rejects an empty constraint set, which would pass in every arm', () => {
    const caseDoc = Object.assign({}, (doc().cases as Record<string, unknown>[])[0], {
      negativeControl: false,
      constraints: [],
    });
    const issues = validateFixture(doc({ cases: [caseDoc] }));
    assert.deepEqual(codesAt(issues, 'cases[0].constraints'), ['format']);
    assert.match(issues[0]?.message ?? '', /measures nothing/);
  });

  it('rejects an empty arm list', () => {
    const caseDoc = Object.assign({}, (doc().cases as Record<string, unknown>[])[0], {
      arms: [],
      negativeControl: false,
    });
    const issues = validateFixture(doc({ cases: [caseDoc] }));
    assert.deepEqual(codesAt(issues, 'cases[0].arms'), ['format']);
  });

  it('rejects a whitespace-only name, prompt and constraint text', () => {
    const caseDoc = Object.assign({}, (doc().cases as Record<string, unknown>[])[0], {
      prompt: '   ',
      constraints: [{ id: 'c1', text: '   ', kind: 'soft_policy', forbidden: ['  '] }],
    });
    const issues = validateFixture(doc({ name: '   ', cases: [caseDoc] }));
    assert.ok(codesAt(issues, 'name').includes('format'));
    assert.ok(codesAt(issues, 'cases[0].prompt').includes('format'));
    assert.ok(codesAt(issues, 'cases[0].constraints[0].text').includes('format'));
    assert.ok(codesAt(issues, 'cases[0].constraints[0].forbidden[0]').includes('format'));
  });
});

describe('fixture format: unknown keys are errors', () => {
  it('rejects an unknown top-level key', () => {
    const issues = validateFixture(doc({ extraKey: true }));
    assert.deepEqual(codesAt(issues, 'extraKey'), ['unknown_key']);
  });

  it('rejects an unknown case key and suggests the one meant', () => {
    const caseDoc = Object.assign({}, (doc().cases as Record<string, unknown>[])[0], {
      negativeContol: false,
    });
    const issues = validateFixture(doc({ cases: [caseDoc] }));
    assert.deepEqual(codesAt(issues, 'cases[0].negativeContol'), ['unknown_key']);
    assert.match(issues[0]?.message ?? '', /did you mean "negativeControl"/);
  });

  it('rejects an unknown constraint key', () => {
    const caseDoc = Object.assign({}, (doc().cases as Record<string, unknown>[])[0], {
      constraints: [{ id: 'c1', text: 'x', kind: 'soft_policy', forbidden: [], enforcement: 'block' }],
    });
    const issues = validateFixture(doc({ cases: [caseDoc] }));
    assert.deepEqual(codesAt(issues, 'cases[0].constraints[0].enforcement'), ['unknown_key']);
  });
});

describe('fixture format: duplicates and suite-level rules', () => {
  it('rejects two cases with the same id and says where the first was', () => {
    const first = (doc().cases as Record<string, unknown>[])[0];
    const issues = validateFixture(doc({ cases: [first, { ...first }] }));
    const duplicate = issues.find((i) => i.path === 'cases[1].id');
    assert.equal(duplicate?.code, 'duplicate');
    assert.match(duplicate?.message ?? '', /already used by cases\[0\]/);
  });

  it('rejects an arm listed twice on one case', () => {
    const caseDoc = Object.assign({}, (doc().cases as Record<string, unknown>[])[0], {
      arms: ['control', 'control'],
    });
    const issues = validateFixture(doc({ cases: [caseDoc] }));
    assert.deepEqual(codesAt(issues, 'cases[0].arms[1]'), ['duplicate']);
  });

  it('rejects a constraint id reused inside one case', () => {
    const caseDoc = Object.assign({}, (doc().cases as Record<string, unknown>[])[0], {
      constraints: [
        { id: 'c1', text: 'a', kind: 'soft_policy', forbidden: ['A'] },
        { id: 'c1', text: 'b', kind: 'soft_policy', forbidden: ['B'] },
      ],
    });
    const issues = validateFixture(doc({ cases: [caseDoc] }));
    assert.deepEqual(codesAt(issues, 'cases[0].constraints[1].id'), ['duplicate']);
  });

  it('rejects a negative control that runs a single arm', () => {
    // A negative control compared against nothing reproduces nothing. This is a
    // rule in code, not a line in a review checklist, because a checklist that
    // depends on the reviewer noticing is not a control.
    const caseDoc = Object.assign({}, (doc().cases as Record<string, unknown>[])[0], {
      arms: ['treatment'],
      negativeControl: true,
    });
    const issues = validateFixture(doc({ cases: [caseDoc] }));
    assert.deepEqual(codesAt(issues, 'cases[0].arms'), ['rule']);
    assert.match(issues[0]?.message ?? '', /cannot reproduce anything/);
  });

  it('rejects an empty case list', () => {
    assert.deepEqual(codesAt(validateFixture(doc({ cases: [] })), 'cases'), ['format']);
  });
});

describe('fixture format: every error at once', () => {
  it('collects issues across the whole document in one pass', () => {
    // The reason the validator is not fail-fast: an author fixing a 200-case
    // suite should spend one round trip, not one per typo.
    const issues = validateFixture(
      doc({
        suite: 'E9',
        name: 42,
        strayTopLevel: 1,
        cases: [
          {
            id: 'a',
            title: '',
            arms: ['nope'],
            negativeControl: 'yes',
            prompt: 'p',
            constraints: [{ id: 'c', text: 't', kind: 'bad', forbidden: [''] }],
            strayCaseKey: true,
          },
          {
            id: 'a',
            title: 'duplicate id, single arm negative control',
            arms: ['treatment'],
            negativeControl: true,
            prompt: 'p',
            constraints: [{ id: 'c1', text: 't', kind: 'soft_policy' }],
          },
        ],
      }),
    );
    const paths = issues.map((i) => i.path);
    for (const expected of [
      'suite',
      'strayTopLevel',
      'name',
      'cases[0].title',
      'cases[0].arms[0]',
      'cases[0].negativeControl',
      'cases[0].constraints[0].kind',
      'cases[0].constraints[0].forbidden[0]',
      'cases[0].strayCaseKey',
      'cases[1].id',
      'cases[1].arms',
    ]) {
      assert.ok(paths.includes(expected), `expected an issue at ${expected}, got ${paths.join(', ')}`);
    }
    assert.ok(issues.length >= 11, `expected at least 11 issues, got ${issues.length}`);
  });

  it('returns the same issue list from safeParse and validateFixture', () => {
    const bad = doc({ suite: 'E9' });
    const parsed = safeParseFixture(bad);
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.ok ? [] : parsed.issues, validateFixture(bad));
  });

  it('throws one FixtureError carrying every issue', () => {
    try {
      parseFixture(doc({ suite: 'E9', name: '' }), 'e1.json');
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(err instanceof FixtureError);
      assert.ok(err.issues.length >= 2);
      assert.match(err.message, /e1\.json: .*suite .*name/);
    }
  });
});

describe('fixture format: loading from disk', () => {
  it('loads a valid fixture file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'strata-eval-'));
    const path = join(dir, 'e1.json');
    writeFileSync(path, JSON.stringify(doc()), 'utf8');
    const fixture: EvalFixture = loadFixture(path);
    assert.equal(fixture.suite, 'E1');
    assert.equal(fixture.cases.length, 1);
  });

  it('reports an unreadable file as an io issue naming the path', () => {
    assert.throws(
      () => loadFixture(join(tmpdir(), 'strata-eval-does-not-exist', 'nope.json')),
      (err: unknown) => {
        assert.ok(err instanceof FixtureError);
        assert.equal(err.issues[0]?.code, 'io');
        assert.match(err.message, /cannot be read/);
        return true;
      },
    );
  });

  it('reports malformed JSON as a json issue, not a schema complaint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'strata-eval-'));
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{ "suite": ', 'utf8');
    assert.throws(
      () => loadFixture(path),
      (err: unknown) => {
        assert.ok(err instanceof FixtureError);
        assert.equal(err.issues[0]?.code, 'json');
        return true;
      },
    );
  });

  it('reports an empty file as a json issue', () => {
    const dir = mkdtempSync(join(tmpdir(), 'strata-eval-'));
    const path = join(dir, 'empty.json');
    writeFileSync(path, '   \n', 'utf8');
    assert.throws(
      () => loadFixture(path),
      (err: unknown) => {
        assert.ok(err instanceof FixtureError);
        assert.equal(err.issues[0]?.code, 'json');
        assert.match(err.message, /is empty/);
        return true;
      },
    );
  });

  it('attributes schema issues to the file they came from', () => {
    const dir = mkdtempSync(join(tmpdir(), 'strata-eval-'));
    const path = join(dir, 'bad.json');
    writeFileSync(path, JSON.stringify(doc({ suite: 'E9' })), 'utf8');
    assert.throws(
      () => loadFixture(path),
      (err: unknown) => {
        assert.ok(err instanceof FixtureError);
        assert.equal(err.source, path);
        assert.match(err.message, /bad\.json/);
        return true;
      },
    );
  });
});
