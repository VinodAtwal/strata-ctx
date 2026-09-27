#!/usr/bin/env node
/**
 * Contract freeze check (A-5 / J-3).
 *
 * The whole parallel plan rests on `packages/core-types` not moving underneath
 * ten streams. This computes a digest of the package's public API surface and
 * compares it to `contract.lock.json`. A change is either:
 *   - no change to the surface  -> pass
 *   - a surface change           -> fail unless `--update` was passed
 *
 * Run with `--update` deliberately, in its own commit, so that a reviewer sees
 * the contract move as a reviewable event rather than as noise inside a
 * feature PR. A silent contract change is how a 7-week plan becomes a 12-week
 * one.
 *
 * Deliberately compares *shape*, not behaviour: exported names, kinds, and
 * declaration signatures. It cannot tell you a function now returns the wrong
 * value, only that its signature changed.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(root, 'packages/core-types/src/index.ts');
const PKG_DIR = path.join(root, 'packages/core-types');
const LOCK = path.join(PKG_DIR, 'contract.lock.json');
const update = process.argv.includes('--update');

const readCompilerOptions = () => {
  const cfgPath = path.join(root, 'tsconfig.base.json');
  const raw = ts.readConfigFile(cfgPath, ts.sys.readFile);
  return ts.convertCompilerOptionsFromJson(raw.config.compilerOptions, root).options;
};

const surface = () => {
  const options = {
    ...readCompilerOptions(),
    composite: false,
    declaration: false,
    noEmit: true,
  };
  const program = ts.createProgram([ENTRY], options);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(ENTRY);
  if (!sf) throw new Error(`cannot read entry point: ${ENTRY}`);

  const moduleSymbol = checker.getSymbolAtLocation(sf);
  if (!moduleSymbol) throw new Error('entry point has no module symbol');

  const normalise = (text) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const entries = checker.getExportsOfModule(moduleSymbol).map((sym) => {
    const decls = sym.declarations ?? [];
    const decl = decls[0];
    const kind = decl ? ts.SyntaxKind[decl.kind] : 'Unknown';
    const sig = decl ? normalise(decl.getText()) : '';
    return { name: sym.getName(), kind, signature: sig };
  });

  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
};

const main = () => {
  const entries = surface();
  const digest = createHash('sha256').update(JSON.stringify(entries, null, 2)).digest('hex');
  const doc = { package: '@strata-ctx/core-types', digest, exports: entries };

  if (update) {
    writeFileSync(LOCK, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`contract updated: ${entries.length} exports, digest ${digest.slice(0, 16)}`);
    return;
  }

  if (!existsSync(LOCK)) {
    console.error('contract.lock.json is missing. Run: npm run contract:check -- --update');
    process.exit(1);
  }

  const locked = JSON.parse(readFileSync(LOCK, 'utf8'));
  if (locked.digest === digest) {
    console.log(`contract unchanged: ${entries.length} exports, digest ${digest.slice(0, 16)}`);
    return;
  }

  const before = new Map((locked.exports ?? []).map((e) => [e.name, e.signature]));
  const after = new Map(entries.map((e) => [e.name, e.signature]));

  const added = entries.filter((e) => !before.has(e.name)).map((e) => e.name);
  const removed = [...before.keys()].filter((n) => !after.has(n));
  const changed = entries
    .filter((e) => before.has(e.name) && before.get(e.name) !== e.signature)
    .map((e) => e.name);

  console.error('\nCONTRACT DRIFT detected.\n');
  if (added.length) console.error(`  added:   ${added.join(', ')}`);
  if (removed.length) console.error(`  removed: ${removed.join(', ')}`);
  if (changed.length) console.error(`  changed: ${changed.join(', ')}`);
  console.error(`\n  expected ${locked.digest?.slice(0, 16)}  got ${digest.slice(0, 16)}`);
  console.error('\nIf this change is intended, re-run: npm run contract:check -- --update');
  console.error('and land it in its own commit so reviewers see it as a contract move.\n');
  process.exit(1);
};

main();
