/**
 * The documentation convention, enforced.
 *
 * AGENTS.md §11 states two rules this file checks: **cite sections, not line
 * numbers**, and **if a command can produce it, no doc may state it**. Both were
 * violated repeatedly and every violation survived review, because a stale fact
 * in prose reads exactly like a current one. A convention with no enforcer
 * dies, so the convention is a test.
 *
 * ## What is checked, and what is deliberately not
 *
 * Three failures are mechanical and unambiguous, so they are gated:
 *
 * 1. A `file.ext:NN` line citation in prose. It resolves to nothing after the
 *    next edit; the rule is to name the symbol or section instead.
 * 2. An `AGENTS.md §N` reference outside §0–§11 (including a subsection like
 *    `§6.2`). The file has no such section, so the pointer is already dead.
 * 3. The *current* contract export count or digest, restated in a doc. The
 *    value is read from `contract.lock.json` here, so the check follows the
 *    lock rather than a copy of it. A bare `NNN exports`/16-hex literal is not
 *    flagged in general: `docs/wiring-ledger.md` pins its own historical
 *    baseline digest on purpose, and a heuristic ban on "a number" would flag
 *    that legitimate history and mute the gate (AGENTS.md §9).
 *
 * What rule 3 cannot do is catch a *stale* number that was already wrong — an
 * arbitrary old digest is indistinguishable from a random hex string. It
 * prevents the paste-the-current-status-line error, which is the one that
 * recurs; it does not audit history.
 *
 * Fenced code blocks are skipped: a stack trace or a `curl` example is not
 * prose. A line may opt out with the marker `docs-convention:allow` when it
 * must quote a known-bad string (a defect table in the plan doc, for example).
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * `docs/releases/**` is excluded: a release note is a snapshot of what was true
 * on its date, including a pinned digest, and rewriting it would be a lie about
 * history. Everything else under `docs/` and every root markdown file is in
 * scope.
 */
const EXCLUDED_DIRS = new Set([path.join('docs', 'releases')]);

const OPT_OUT = 'docs-convention:allow';

type Doc = { rel: string; text: string };

const collectMarkdown = (dir: string, rel: string, into: Doc[]): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const childRel = path.join(rel, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(childRel)) collectMarkdown(path.join(dir, entry.name), childRel, into);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      into.push({ rel: childRel, text: readFileSync(path.join(dir, entry.name), 'utf8') });
    }
  }
};

const docs = (): Doc[] => {
  const found: Doc[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      found.push({ rel: entry.name, text: readFileSync(path.join(root, entry.name), 'utf8') });
    }
  }
  collectMarkdown(path.join(root, 'docs'), 'docs', found);
  assert.ok(found.length >= 15, `expected the doc set to be non-trivial, found ${found.length}`);
  return found;
};

/** Prose lines only: fence contents and opted-out lines are not the doc speaking. */
const proseLines = (doc: Doc): { line: string; number: number }[] => {
  const out: { line: string; number: number }[] = [];
  let inFence = false;
  doc.text.split('\n').forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence || line.includes(OPT_OUT)) return;
    out.push({ line, number: index + 1 });
  });
  return out;
};

const lock = JSON.parse(
  readFileSync(path.join(root, 'packages/core-types/contract.lock.json'), 'utf8'),
) as { digest: string; exports: unknown[] };

/** A line citation: a path with a code/data extension, then `:`, then digits. */
const LINE_CITATION = /[A-Za-z0-9_./-]+\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx|json|ya?ml):\d+/;

const AGENTS_REF = /AGENTS(?:\.md)?\s*§\s*(\d+(?:\.\d+)?)/g;

const AGENTS_MAX_SECTION = 11;

const HEX_RUN = /\b[0-9a-f]{16,}\b/g;

test('docs cite sections, not line numbers', () => {
  const offenders: string[] = [];
  for (const doc of docs()) {
    for (const { line, number } of proseLines(doc)) {
      const match = LINE_CITATION.exec(line);
      if (match !== null) offenders.push(`${doc.rel}:${number}: ${match[0]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these are line-number citations; name the symbol or section instead (AGENTS.md §11):\n${offenders.join('\n')}`,
  );
});

test('docs reference only sections AGENTS.md actually has', () => {
  const offenders: string[] = [];
  for (const doc of docs()) {
    for (const { line, number } of proseLines(doc)) {
      AGENTS_REF.lastIndex = 0;
      for (let match = AGENTS_REF.exec(line); match !== null; match = AGENTS_REF.exec(line)) {
        const section = match[1] ?? '';
        const isSubsection = section.includes('.');
        const numeric = Number.parseFloat(section);
        if (isSubsection || numeric > AGENTS_MAX_SECTION) {
          offenders.push(`${doc.rel}:${number}: AGENTS.md §${section}`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `AGENTS.md has only §0–§${AGENTS_MAX_SECTION}; these pointers are dead:\n${offenders.join('\n')}`,
  );
});

test('docs do not restate the frozen contract count or digest', () => {
  const digest = lock.digest;
  const count = lock.exports.length;
  const countPattern = new RegExp(`\\b${count}\\s+exports\\b`);
  const offenders: string[] = [];
  for (const doc of docs()) {
    for (const { line, number } of proseLines(doc)) {
      if (countPattern.test(line)) offenders.push(`${doc.rel}:${number}: "${count} exports"`);
      HEX_RUN.lastIndex = 0;
      for (let match = HEX_RUN.exec(line); match !== null; match = HEX_RUN.exec(line)) {
        const run = match[0];
        if (run.length >= 16 && digest.startsWith(run.slice(0, digest.length))) {
          offenders.push(`${doc.rel}:${number}: digest ${run.slice(0, 16)}…`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `the contract count and digest are computed; point at \`npm run status\` (AGENTS.md §11):\n${offenders.join('\n')}`,
  );
});
