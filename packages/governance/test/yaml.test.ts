import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { coerceScalar, parseYaml, YamlError } from '../src/yaml.js';

const throwsWith = (text: string, pattern: RegExp): YamlError => {
  try {
    parseYaml(text);
  } catch (e) {
    assert.ok(e instanceof YamlError, `expected a YamlError, got ${String(e)}`);
    assert.match(e.message, pattern);
    assert.match(e.message, /^policy YAML line \d+: /, 'every rejection carries a line number');
    return e;
  }
  assert.fail(`expected ${JSON.stringify(text)} to be rejected`);
};

describe('the subset that is supported', () => {
  it('reads block mappings', () => {
    assert.deepEqual(parseYaml('version: 1\nname: strata\n'), { version: 1, name: 'strata' });
  });

  it('reads nested block mappings', () => {
    assert.deepEqual(parseYaml('governance:\n  pinning: required\n  autoPin: "on"\n'), {
      governance: { pinning: 'required', autoPin: 'on' },
    });
  });

  it('reads block sequences of scalars', () => {
    assert.deepEqual(parseYaml('items:\n  - one\n  - two\n'), { items: ['one', 'two'] });
  });

  it('reads block sequences of mappings, which is how a policy file is written', () => {
    // The shape every hand-written `constraints:` list has. If this does not
    // parse, the file format cannot express a constraint with an id and a kind,
    // and the whole of D-3 is unreachable.
    assert.deepEqual(
      parseYaml(`version: 1
constraints:
  - id: safety.delete
    text: never delete production data
    kind: hard_safety
  - id: soft.email
    text: never email the client directly
`),
      {
        version: 1,
        constraints: [
          { id: 'safety.delete', text: 'never delete production data', kind: 'hard_safety' },
          { id: 'soft.email', text: 'never email the client directly' },
        ],
      },
    );
  });

  it('lines a sequence item up with the column its key started at', () => {
    // Extra whitespace after the dash is allowed, and the continuation keys have
    // to line up with the first one rather than with the dash.
    assert.deepEqual(parseYaml('items:\n  -   id: a\n      text: b\n'), {
      items: [{ id: 'a', text: 'b' }],
    });
  });

  it('reads a deeply indented sequence of mappings', () => {
    assert.deepEqual(parseYaml('a:\n  b:\n    - k: 1\n      v: 2\n'), { a: { b: [{ k: 1, v: 2 }] } });
  });

  it('reads nested flow sequences, and refuses nested block sequences', () => {
    // The flow form is supported because it is one line and unambiguous; the
    // block form is refused because a bare `- -` is the shape this reader has
    // to treat as an error rather than guess at.
    assert.deepEqual(parseYaml('a: [1, [2, 3]]\n'), { a: [1, [2, 3]] });
    assert.throws(() => parseYaml('matrix:\n  - - 1\n    - 2\n'), /nested sequences on one line/);
  });

  it('reads a sequence at the same indentation as its key', () => {
    // This is ordinary YAML and is the one same-indent form that is not
    // ambiguous: there is no second reading of where the list belongs.
    assert.deepEqual(parseYaml('items:\n- one\n- two\n'), { items: ['one', 'two'] });
  });

  it('reads nested flow sequences of scalars', () => {
    assert.deepEqual(parseYaml('stages: [dedupe, pin, compact]\n'), { stages: ['dedupe', 'pin', 'compact'] });
    assert.deepEqual(parseYaml('m: [[1, 2], [3]]\n'), { m: [[1, 2], [3]] });
  });

  it('reads flow mappings, including nested ones', () => {
    assert.deepEqual(parseYaml('governance: { pinning: required, budget: { max: 3 } }\n'), {
      governance: { pinning: 'required', budget: { max: 3 } },
    });
  });

  it('reads quoted scalars, including ones that look like structure', () => {
    assert.deepEqual(parseYaml('a: "1"\nb: \'1\'\nc: "true"\nd: "x: y"\n'), {
      a: '1',
      b: '1',
      c: 'true',
      d: 'x: y',
    });
  });

  it('reads a key that needs quoting', () => {
    assert.deepEqual(parseYaml('"a:b": 1\n'), { 'a:b': 1 });
  });

  it('reads literal block scalars', () => {
    assert.deepEqual(parseYaml('text: |\n  line one\n  line two\n'), { text: 'line one\nline two\n' });
  });

  it('reads folded block scalars', () => {
    assert.deepEqual(parseYaml('text: >\n  line one\n  line two\n'), { text: 'line one line two\n' });
  });

  it('honours chomping indicators', () => {
    assert.deepEqual(parseYaml('a: |-\n  no trailing\nb: |+\n  keep it\n\nc: >-\n  folded\n'), {
      a: 'no trailing',
      b: 'keep it\n',
      c: 'folded',
    });
  });

  it('keeps a literal block scalar inside a sequence item', () => {
    assert.deepEqual(parseYaml('items:\n  - text: |\n      never delete production data\n    kind: hard_safety\n'), {
      items: [{ text: 'never delete production data\n', kind: 'hard_safety' }],
    });
  });

  it('reads a document with a leading --- and nothing else', () => {
    assert.deepEqual(parseYaml('---\nversion: 1\n'), { version: 1 });
  });

  it('strips comments without being fooled by one inside a scalar or a url', () => {
    assert.deepEqual(parseYaml('# leading\na: 1 # trailing\nb: http://x/y#z\nc: "has # inside"\n'), {
      a: 1,
      b: 'http://x/y#z',
      c: 'has # inside',
    });
  });

  it('treats a blank document and an all-comment document as null', () => {
    assert.equal(parseYaml(''), null);
    assert.equal(parseYaml('\n\n'), null);
    assert.equal(parseYaml('# just a comment\n'), null);
  });

  it('reads an empty mapping and an empty sequence as null and []', () => {
    // `constraints:` with nothing under it must reach the schema as null and be
    // rejected there -- a parser that invented `[]` would pin nothing silently.
    assert.deepEqual(parseYaml('constraints:\n'), { constraints: null });
    assert.deepEqual(parseYaml('items:\n  -\n'), { items: [null] });
  });
});

describe('the scalar types, and the one that is deliberately not coerced', () => {
  it('reads the YAML 1.2 core types', () => {
    assert.equal(coerceScalar('1'), 1);
    assert.equal(coerceScalar('-2'), -2);
    assert.equal(coerceScalar('1.5'), 1.5);
    assert.equal(coerceScalar('1e3'), 1000);
    assert.equal(coerceScalar('true'), true);
    assert.equal(coerceScalar('null'), null);
    assert.equal(coerceScalar('~'), null);
    assert.equal(coerceScalar('plain text'), 'plain text');
  });

  it('keeps a leading-zero integer as a string', () => {
    // `id: 007` is an identifier. Turning it into `7` changes which constraint a
    // user believes they are editing.
    assert.equal(coerceScalar('007'), '007');
    assert.equal(coerceScalar('0'), 0);
    assert.equal(coerceScalar('00'), '00');
  });

  it('keeps yes and no as strings, because they are too ambiguous', () => {
    // YAML 1.1 read both as booleans and it is the single largest source of
    // "why did my config change" reports.
    assert.equal(coerceScalar('yes'), 'yes');
    assert.equal(coerceScalar('no'), 'no');
    assert.equal(coerceScalar('on'), 'on');
    assert.equal(coerceScalar('off'), 'off');
  });

  it('keeps a quoted number as a string', () => {
    // `coerceScalar` takes an *unquoted* token -- quoting is resolved before it
    // is reached, since a quote has to be matched before a value is known at
    // all. The observable behaviour is asserted through the parser.
    assert.deepEqual(parseYaml('a: "1"\nb: 1\n'), { a: '1', b: 1 });
  });

  it('reads escapes in a double-quoted scalar', () => {
    assert.deepEqual(parseYaml('a: "a\\nb"\nb: "a\\u0041b"\nc: "say \\"hi\\""\n'), {
      a: 'a\nb',
      b: 'aAb',
      c: 'say "hi"',
    });
  });

  it('reads a doubled single quote as one quote', () => {
    assert.deepEqual(parseYaml("a: 'it''s'\n"), { a: "it's" });
  });
});

describe('what is rejected, and why each one matters', () => {
  it('refuses duplicate keys rather than taking the last one', () => {
    // On a policy file, a duplicated key means the operator believes they wrote
    // one thing and the process read another -- exactly the invisible failure
    // `.strict()` exists to prevent, one level up.
    const e = throwsWith('version: 1\nversion: 1\n', /duplicate key "version"/);
    assert.equal(e.line, 2);
  });

  it('refuses duplicate keys inside a sequence item', () => {
    throwsWith('items:\n  - id: a\n    id: b\n', /duplicate key "id"/);
  });

  it('refuses duplicate keys in a flow mapping', () => {
    throwsWith('m: { a: 1, a: 2 }\n', /duplicate key "a"/);
  });

  it('refuses anchors and aliases', () => {
    // Aliases are the billion-laughs DoS against a recursive-descent reader, and
    // they are also how a file says "this text is the same as that text"
    // without saying what the text is.
    // An anchor after a colon is caught while reading the value, an anchor on
    // a line of its own while scanning -- both have to be refused.
    throwsWith('a: &anchor 1\nb: *anchor\n', /anchors, aliases and tags/);
    throwsWith('&anchor 1\n', /anchors and aliases/);
    throwsWith('a: [1, &x 2]\n', /anchors, aliases and tags/);
  });

  it('refuses tags', () => {
    // Constructing arbitrary objects out of a policy file is not a thing this
    // project should be able to do.
    throwsWith('a: !!python/object/apply:os.system ["id"]\n', /tags are not supported/);
  });

  it('refuses multiple documents', () => {
    // Which document is live is a decision, and this reader does not get to make
    // it.
    throwsWith('a: 1\n---\nb: 2\n', /multi-document/);
    throwsWith('---\na: 1\n---\nb: 2\n', /multi-document/);
  });

  it('refuses tabs for indentation', () => {
    // Ambiguous between indentation and content, and every second YAML bug
    // report is someone's tab.
    throwsWith('a:\n\tb: 1\n', /tabs may not be used for indentation/);
  });

  it('refuses a nested block at the parent indent, rather than guessing', () => {
    // Real YAML accepts this and reads it as `governance: { pinning: required }`.
    // Read as a sibling instead it is `governance: null` with a stray top-level
    // `pinning`, which is a silently disabled safety setting. Two readings that
    // disagree about governance is exactly what this reader will not pick
    // between.
    throwsWith('governance:\npinning: required\n', /ambiguous; indent it further/);
    throwsWith('redaction:\nmode: off\n', /ambiguous; indent it further/);
  });

  it('refuses a nested block at the parent indent even when the key was a list', () => {
    // `constraints:` followed by a mapping at the same indent is the same
    // ambiguity: a list whose items are mappings, or a null with a stray key.
    throwsWith('constraints:\ntext: never delete production data\n', /ambiguous; indent it further/);
  });

  it('refuses an unbalanced flow collection', () => {
    throwsWith('a: [1, 2\n', /unterminated flow sequence/);
    throwsWith('a: { b: 1\n', /unterminated flow mapping/);
    // The trailing bracket cannot be reached once the value is recognised as a
    // flow mapping that never closes, so the closer's own message is not the one
    // that fires.
    throwsWith('a: { b: 1 } ]\n', /unterminated flow mapping/);
    throwsWith('a: [1, [2, 3]\n', /unbalanced flow collection/);
  });

  it('refuses an unterminated string', () => {
    throwsWith('a: "never closed\n', /unterminated quoted string/);
    // A backslash cannot escape the newline that ends the line, so the string is
    // still open when the line ends.
    throwsWith('a: "dangling \\\n', /unterminated quoted string/);
  });

  it('refuses a bad escape', () => {
    throwsWith('a: "bad \\q escape"\n', /unsupported escape/);
    throwsWith('a: "short \\u12"\n', /bad \\u escape/);
    throwsWith('a: "dangling \\z', /unterminated quoted string/);
  });

  it('refuses a mapping key with no key in it', () => {
    // `: 1` looks like a scalar that starts with a colon. It is not: a line
    // that opens a mapping has to have a key, and reading this one as a scalar
    // would turn a broken policy file into a document that parses.
    throwsWith(': 1\n', /empty key/);
    throwsWith('a:\n  : 1\n', /empty key/);
  });

  it('refuses a line that is neither a key nor a sequence item', () => {
    // At the top level a bare word is a legitimate scalar document; inside a
    // mapping it is a broken file.
    assert.equal(parseYaml('just some words\n'), 'just some words');
    // Inside a mapping, a line at the mapping's own indent that is not a key is
    // a broken file. (A *deeper* one is caught earlier, as bad indentation.)
    throwsWith('a: 1\n}\n', /expected "key: value"/);
  });

  it('refuses YAML directives and document end markers', () => {
    throwsWith('%YAML 1.2\n---\na: 1\n', /directives are not supported/);
    throwsWith('a: 1\n...\n', /document end markers are not supported/);
  });

  it('refuses content after the end of the document', () => {
    throwsWith('a: 1\n  b: 2\n', /unexpected indentation/);
  });

  it('names the line, so an operator does not have to count', () => {
    assert.equal(throwsWith('a: 1\nb: 2\nc: 3\nd: 4\nb: 5\n', /duplicate key "b"/).line, 5);
  });

  it('reports one problem at a time, and the first one is the real one', () => {
    // Stopping at the first rejection is deliberate: after a mis-parse the rest
    // of the document is not trustworthy either, and ten messages about one
    // broken file is how a real error gets missed.
    assert.equal(throwsWith('a: 1\na: 2\nb: 3\nb: 4\n', /line 2/).line, 2);
  });
});

describe('the property that matters: a mis-parse must not weaken policy', () => {
  it('never invents a value for a key that had none', () => {
    // The failure mode this reader is built to avoid: a document that reads as
    // `{}` where the author wrote something, or as `[]` where they wrote a
    // constraint list. `constraints:` with nothing under it has to reach the
    // schema as null, because the schema is what refuses it.
    assert.deepEqual(parseYaml('governance:\n'), { governance: null });
    assert.deepEqual(parseYaml('constraints:\n\n\n# nothing here\n'), { constraints: null });
  });

  it('round-trips a policy-shaped document exactly', () => {
    const source = `version: 1
governance:
  pinning: required
  autoPin: 'on'
redaction:
  mode: block
  onFail: block
constraints:
  - id: safety.delete
    text: never delete production data
    kind: hard_safety
    enforcement: block
  - id: soft.email
    text: never email the client directly
    kind: soft_policy
    enforcement: rewrite
budgets:
  contextLimit: 200000
`;
    const doc = parseYaml(source) as {
      constraints: { text: string }[];
      governance: Record<string, unknown>;
    };
    // The texts are byte-exact, because everything downstream is a byte
    // comparison against them.
    assert.deepEqual(
      doc.constraints.map((c) => c.text),
      ['never delete production data', 'never email the client directly'],
    );
    assert.deepEqual(doc.governance, { pinning: 'required', autoPin: 'on' });
  });

  it('is deterministic, and does not depend on anything outside the text', () => {
    const source = 'version: 1\nconstraints:\n  - a\n  - b\n';
    assert.deepEqual(parseYaml(source), parseYaml(source));
  });
});
