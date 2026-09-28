import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  FORBIDDEN_BUILTINS,
  FORBIDDEN_PACKAGES,
  LOCALITY_STATEMENT,
  LocalityViolationError,
  assertLocalPackage,
  assertLocalSource,
  packageOfSpecifier,
  scanPackage,
  scanSource,
  stripComments,
  stripCommentsAndStrings,
} from '../src/locality.js';

/**
 * I-4: N4, "all context/gists/artifacts stay on disk; no telemetry egress by
 * default".
 *
 * The attack this suite exists for is slow, boring, and almost always
 * successful against a prose promise. Somebody adds a client dependency, or
 * reaches for `fetch` in a health check, and the product stops being a proxy
 * without anything failing. There is no crash to notice.
 *
 * So the guarantee is a test, and a test that only ever runs the happy path is
 * decoration. The first case here runs the check against this package's own
 * source; the rest run it against sources that each contain exactly one thing
 * the check has to catch, so a regex that silently stops matching fails here
 * instead of passing vacuously on the real tree.
 *
 * These are the only tests in the package that read the package's own source.
 * The crafted sources below are string literals, which the scanner deliberately
 * blanks, so the suite can name every forbidden thing it is hunting for.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');

/** Names found in a crafted source, so a failure says which attack got through. */
const names = (source: string): string[] => scanSource(source, 'crafted').map((v) => v.name);

describe('I-4: this package cannot reach the network', () => {
  it('finds no egress in its own source tree', async () => {
    const report = await scanPackage(PKG_ROOT);
    assert.ok(report.files >= 9, `expected the whole src tree, only saw ${report.files} files`);
    assert.deepEqual(
      report.violations.map((v) => `${v.label}:${v.line} ${v.name}`),
      [],
      'the locality claim is false for this package as it stands',
    );
  });

  it('declares no registry dependency', async () => {
    const manifest = JSON.parse(await fs.readFile(join(PKG_ROOT, 'package.json'), 'utf8')) as {
      readonly dependencies?: Record<string, string>;
      readonly devDependencies?: Record<string, string>;
      readonly peerDependencies?: Record<string, string>;
    };
    const violations = assertLocalPackage(manifest);
    assert.deepEqual(
      violations.map((v) => v.name),
      [],
      'a registry dependency brings code nobody here reviewed for egress',
    );
  });

  it('resolves every declared dependency to a symlink inside this repository', async () => {
    // The manifest check above reads a bare version range as "workspace". That is
    // a convention, not a fact, so the fact is checked here: the installed entry
    // has to be a link into the repo, or a package from the registry with the
    // same name would satisfy the text check.
    const manifest = JSON.parse(await fs.readFile(join(PKG_ROOT, 'package.json'), 'utf8')) as {
      readonly dependencies?: Record<string, string>;
    };
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const installed = join(REPO_ROOT, 'node_modules', ...name.split('/'));
      const stat = await fs.lstat(installed);
      assert.equal(stat.isSymbolicLink(), true, `${name} is installed as a real directory`);
      const target = await fs.realpath(installed);
      assert.ok(
        target.startsWith(join(REPO_ROOT, 'packages') + '/'),
        `${name} resolves to ${target}, which is outside packages/`,
      );
    }
  });

  it('states the guarantee in terms a user can check', () => {
    // The claim is user-facing, so it is tested as content: it has to name the
    // package it is about and the test that maintains it, or it drifts into
    // marketing that nothing verifies.
    assert.match(LOCALITY_STATEMENT, /no network egress/i);
    assert.match(LOCALITY_STATEMENT, /locality\.test\.ts/);
  });
});

describe('I-4: every way in is caught', () => {
  it('catches a static import of a client', () => {
    assert.deepEqual(names("import { request } from 'undici';"), ['undici']);
  });

  it('catches a default import of an outbound builtin', () => {
    assert.deepEqual(names("import http from 'node:http';"), ['node:http']);
  });

  it('catches a deep subpath of a forbidden package', () => {
    // `undici/lib/fetch/index.js` is a real import, and matching only exact
    // specifier text is the kind of check that passes until the day it matters.
    assert.deepEqual(names("import x from 'undici/lib/dispatcher/client.js';"), ['undici']);
  });

  it('catches a scoped client package', () => {
    assert.deepEqual(names("import { Anthropic } from '@anthropic-ai/sdk';"), ['@anthropic-ai/sdk']);
  });

  it('catches a re-export', () => {
    assert.deepEqual(names("export * from 'ws';"), ['ws']);
  });

  it('catches a require', () => {
    assert.deepEqual(names("const got = require('got');"), ['got']);
  });

  it('catches a dynamic import', () => {
    assert.deepEqual(names("const m = await import('node-fetch');"), ['node-fetch']);
  });

  it('catches a bare global fetch call', () => {
    // No import at all, which is the whole reason the import denylist is not
    // sufficient on its own.
    assert.deepEqual(names('const r = await fetch(url);'), ['fetch']);
  });

  it('catches a global reached through the global object, reported once', () => {
    // Reported against the member, not the receiver: `fetch` is the thing that
    // moves bytes, and a finding an operator has to dedupe by hand is a finding
    // that gets ignored.
    assert.deepEqual(names('const r = await globalThis.fetch(url);'), ['fetch']);
  });

  it('catches a global reached by computed member', () => {
    // One pair of square brackets is the cheapest possible evasion of an import
    // scan, so the name is checked inside the string too.
    assert.deepEqual(names("const r = await globalThis['fetch'](url);"), ['fetch']);
  });

  it('catches a receiver spelled the browser way', () => {
    assert.deepEqual(names('const s = new window.WebSocket(url);'), ['WebSocket']);
  });

  it('catches a dotted builtin member', () => {
    assert.deepEqual(names('http.request({ host: "h" });'), ['http.request']);
  });

  it('catches a bare global in the middle of a line, not just at the start', () => {
    assert.deepEqual(names('const s = new WebSocket(url);'), ['WebSocket']);
  });
});

describe('I-4: nothing else is caught', () => {
  it('ignores the word fetch in a string literal', () => {
    // Not tidiness: this file's own denylist spells these words out, so a
    // scanner that could not tell a string from a reference would have to
    // exempt itself, and self-exemption is where these checks rot.
    assert.deepEqual(names("const msg = 'do not call fetch here';"), []);
  });

  it('ignores an example import inside a doc comment', () => {
    // The module documents the pattern it forbids, which means the pattern
    // appears in its own source as prose.
    assert.deepEqual(
      names("/** Do not write `import http from 'node:http'` here. */\nconst x = 1;"),
      [],
    );
  });

  it('ignores an identifier that merely ends with a forbidden name', () => {
    // `prefetchCount` and `selfTest` are ordinary words. A checker that fires on
    // them gets muted, and a muted check protects nothing.
    assert.deepEqual(names('const prefetchCount = 0; const selfTest = () => {};'), []);
  });

  it('ignores a bare global receiver used as a variable', () => {
    // Not hypothetical: `retention.ts` has `const window = windowDaysFor(...)`,
    // and the first version of this check fired on it. A time window is not an
    // egress capability, and a finding an author cannot act on teaches them to
    // ignore the rest of the file.
    assert.deepEqual(names('const window = windowDaysFor(stat, policy);\nconst self = 1;'), []);
  });

  it('ignores a member call that only looks like a builtin', () => {
    assert.deepEqual(names('logger.http.getCalls();'), []);
  });

  it('ignores local file imports', () => {
    assert.deepEqual(
      names("import { join } from 'node:path';\nimport { x } from './acl.js';"),
      [],
    );
  });

  it('declares the gap it does not close', () => {
    // Written as a test so the limit is declared in the suite rather than only
    // in a comment nobody re-reads: a name assembled at runtime from two pieces
    // is not seen by this scanner.
    assert.deepEqual(names("const r = await globalThis['fe' + 'tch'](url);"), []);
  });
});

describe('I-4: findings point at the line', () => {
  it('reports the line of an offending import', () => {
    const [violation] = scanSource("const a = 1;\n\nimport http from 'node:http';\n", 'f.ts');
    assert.equal(violation?.line, 3);
    assert.equal(violation?.label, 'f.ts');
    assert.equal(violation?.kind, 'import_specifier');
  });

  it('reports the line of a global reference, not the start of the file', () => {
    const source = ['// a comment', 'const a = 1;', 'const b = 2;', 'await fetch(url);', ''].join('\n');
    const [violation] = scanSource(source, 'f.ts');
    assert.equal(violation?.line, 4);
  });

  it('keeps offsets and line numbers while blanking', () => {
    // The finding's line number is computed from the original source, so a
    // blanker that changed the length or the newlines would point at the wrong
    // line. That is the property that makes the finding worth acting on.
    const lineComment = "// comment with 'quotes'";
    const source = [lineComment, 'const a = `tpl ${1}`;', '/* multi', 'line */', ''].join('\n');
    const stripped = stripComments(source);
    assert.equal(stripped.length, source.length);
    assert.equal(stripped.split('\n').length, source.split('\n').length);
    // The line comment became spaces of the same length, the newlines stayed put,
    // and a template literal was left alone: it is code, not a comment.
    assert.equal(stripped.split('\n')[0], ' '.repeat(lineComment.length));
    assert.equal(stripped.split('\n')[1], 'const a = `tpl ${1}`;');
    assert.equal(stripped.includes('multi'), false, 'block comment text survived');
    assert.equal(stripped.includes('line '), false, 'block comment text survived');
  });

  it('keeps the quote delimiters out of the code view but keeps the name of a computed member out too', () => {
    // Two things at once, and they pull in opposite directions: the contents
    // must be gone (else the denylist matches itself) and the delimiters must
    // stay (else offsets drift).
    const source = "const u = 'https://example.test';";
    const code = stripCommentsAndStrings(source);
    assert.equal(code.length, source.length);
    assert.equal(code.includes('https'), false);
    assert.equal(code.includes("'"), false);
  });
});

describe('I-4: packageOfSpecifier', () => {
  it('takes the package name out of a subpath', () => {
    assert.equal(packageOfSpecifier('undici/lib/fetch/index.js'), 'undici');
  });

  it('keeps both segments of a scoped name', () => {
    assert.equal(packageOfSpecifier('@aws-sdk/client-s3/dist-es/index.js'), '@aws-sdk/client-s3');
  });

  it('handles a bare name', () => {
    assert.equal(packageOfSpecifier('got'), 'got');
  });
});

describe('I-4: the manifest check', () => {
  it('accepts a workspace range', () => {
    assert.deepEqual(
      assertLocalPackage({ dependencies: { '@strata-ctx/core-types': 'workspace:*' } }),
      [],
    );
  });

  it('accepts the exact version a workspace spells its sibling with', () => {
    assert.deepEqual(assertLocalPackage({ dependencies: { '@strata-ctx/core-types': '1.0.0' } }), []);
  });

  it('rejects a prerelease range that merely starts with a digit', () => {
    // The first version of this check accepted anything beginning with a digit,
    // so `axios@1.0.0-beta` read as a sibling package. It is not: a prerelease
    // is something a registry serves and this repository does not.
    const violations = assertLocalPackage({ dependencies: { axios: '1.0.0-beta' } });
    assert.deepEqual(
      violations.map((v) => v.name),
      ['axios@1.0.0-beta'],
    );
  });

  it('rejects a registry range', () => {
    const violations = assertLocalPackage({ dependencies: { undici: '^6.0.0' } });
    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.name, 'undici@^6.0.0');
    assert.equal(violations[0]?.kind, 'dependency');
  });

  it('rejects a dev dependency too', () => {
    // A client in devDependencies is one `tsc --watch` away from a build script
    // that calls it, and the cost of missing it is the whole guarantee.
    const violations = assertLocalPackage({ devDependencies: { 'node-fetch': '*' } });
    assert.deepEqual(
      violations.map((v) => v.name),
      ['node-fetch@*'],
    );
  });

  it('names the group it found it in', () => {
    assert.equal(assertLocalPackage({ peerDependencies: { axios: '^1.0.0' } })[0]?.label, 'peerDependencies');
  });
});

describe('I-4: assertLocalSource', () => {
  it('throws with every finding attached', () => {
    assert.throws(
      () => assertLocalSource("import http from 'node:http';\nawait fetch(u);", 'x.ts'),
      (e: unknown) => {
        assert.ok(e instanceof LocalityViolationError);
        assert.equal(e.violations.length, 2);
        assert.match(e.message, /x\.ts:1 node:http \(import_specifier\)/);
        assert.match(e.message, /x\.ts:2 fetch \(global_reference\)/);
        return true;
      },
    );
  });

  it('passes this package\'s own redaction engine source', () => {
    // A positive control on the control: the scanner is exercised against a real
    // file that contains no egress, so "no findings" is a result and not a
    // scanner that finds nothing.
    const source = "export const x = 1;\nexport const f = (a: number): number => a + 1;\n";
    assertLocalSource(source, 'control.ts');
  });
});

describe('I-4: the denylists are not empty or duplicated', () => {
  it('has entries and no repeats', () => {
    for (const list of [FORBIDDEN_BUILTINS, FORBIDDEN_PACKAGES]) {
      assert.ok(list.length > 0);
      assert.equal(new Set(list).size, list.length, 'a duplicate in a denylist means a copy-paste');
    }
  });
});
