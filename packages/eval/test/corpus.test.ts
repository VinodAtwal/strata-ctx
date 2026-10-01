import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import {
  CORPUS_FORMAT_VERSION,
  CorpusError,
  CorpusResolutionError,
  loadCorpus,
  parseCorpus,
  resolveCorpus,
  validateCorpus,
  type Corpus,
  type CorpusEntry,
} from '../src/corpus.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(HERE, '..', 'corpus', 'aegis-backlog.json');

// ------------------------------------------------------------------ the file

test('the shipped corpus loads and validates', () => {
  const corpus = loadCorpus(CORPUS_PATH);
  assert.equal(corpus.formatVersion, CORPUS_FORMAT_VERSION);
  assert.ok(corpus.entries.length > 0);
});

/**
 * The reason the corpus stores references instead of text.
 *
 * aegis is private and this repository is public. If issue text ever lands in
 * this file it gets published on the next push, and no test can undo that. So
 * the guard is on the file's own bytes: no body text, and no verbatim title
 * beyond the bracketed section marker the titles are built from.
 */
test('the corpus embeds no issue text, only references', () => {
  const raw = readFileSync(CORPUS_PATH, 'utf8');
  const document = JSON.parse(raw) as { entries: { source: unknown; label: string }[] };

  for (const entry of document.entries) {
    const source = entry.source as Record<string, unknown>;
    assert.ok(
      'repo' in source && 'number' in source,
      `entry ${entry.label} must reference a repo and number, not carry text`,
    );
    assert.equal(
      Object.keys(source).filter((k) => k !== 'kind').length,
      2,
      `entry ${entry.label} source must hold exactly a repo and a number`,
    );
    // A title from the issue tracker is upstream text. A label is ours.
    assert.ok(
      entry.label.length < 60,
      `entry ${entry.label}: a label this long is probably copied title text`,
    );
    assert.ok(!entry.label.includes(']'), `entry ${entry.label} looks like a copied issue title`);
  }
});

test('every entry names a governance constraint with detectable markers', () => {
  const corpus = loadCorpus(CORPUS_PATH);
  for (const entry of corpus.entries) {
    assert.ok(entry.constraint.text.length > 40, `${entry.id}: constraint too thin to test`);
    assert.ok(
      entry.constraint.forbidden.length > 0,
      `${entry.id}: a constraint with no forbidden marker cannot fail, so it measures nothing`,
    );
    for (const marker of entry.constraint.forbidden) {
      assert.ok(marker.trim().length > 0);
    }
  }
});

test('the corpus spans more than one category and one language', () => {
  const corpus = loadCorpus(CORPUS_PATH);
  assert.ok(
    corpus.entries.some((e) => e.category === 'refinement'),
    'a corpus with no refinement tasks cannot test the case where rules break',
  );
  assert.ok(
    corpus.entries.some((e) => e.category === 'greenfield'),
    'greenfield tasks are the easier half and should be represented',
  );
  assert.ok(new Set(corpus.entries.map((e) => e.language)).size >= 1);
});

test('the corpus declares its own single-repo limit', () => {
  // The description is what a reader checks before trusting a claim from this
  // corpus, so the limitation has to be written down where it will be seen.
  const corpus = loadCorpus(CORPUS_PATH);
  const description = corpus.description ?? '';
  assert.ok(
    description.includes('single') || description.includes('Single'),
    'the corpus must state that it covers one repository',
  );
  assert.ok(
    description.includes('aegis') && description.includes('private'),
    'the corpus must state the provenance and why text is not embedded',
  );
});

// ---------------------------------------------------------------- validation

test('a valid document parses', () => {
  const corpus = parseCorpus({
    corpusFormatVersion: 1,
    name: 'ok',
    entries: [
      {
        id: 'e1',
        label: 'a label',
        source: { kind: 'github', repo: 'o/r', number: 1 },
        language: 'python',
        category: 'greenfield',
        constraint: { id: 'c1', text: 'do the thing', kind: 'hard_safety', forbidden: ['did the bad thing'] },
      },
    ],
  });
  assert.equal(corpus.entries.length, 1);
});

test('every problem is reported at once, not one per round trip', () => {
  const issues = validateCorpus({
    corpusFormatVersion: 99,
    name: '',
    entries: [
      { id: 'a', label: 'x', source: { kind: 'github', repo: 'bad', number: 0 }, language: 'py', category: 'nope', constraint: null },
    ],
  });
  const paths = issues.map((i) => `${i.path}:${i.code}`);
  assert.ok(paths.includes('corpusFormatVersion:version'));
  assert.ok(paths.includes('name:format'));
  assert.ok(paths.includes('entries[0].source.repo:format'));
  assert.ok(paths.includes('entries[0].source.number:type'));
  assert.ok(paths.includes('entries[0].category:enum'));
  assert.ok(paths.includes('entries[0].constraint:not_object'));
});

test('unknown keys are refused rather than ignored', () => {
  const issues = validateCorpus({
    corpusFormatVersion: 1,
    name: 'x',
    entries: [],
    extraKey: true,
  });
  assert.ok(issues.some((i) => i.code === 'unknown_key' && i.path === 'extraKey'));
});

test('a stale format version is refused', () => {
  const issues = validateCorpus({ corpusFormatVersion: 0, name: 'x', entries: [] });
  assert.ok(issues.some((i) => i.code === 'version'));
});

test('duplicate entry ids are refused', () => {
  const entry = (id: string): unknown => ({
    id,
    label: 'l',
    source: { kind: 'github', repo: 'o/r', number: 1 },
    language: 'py',
    category: 'greenfield',
    constraint: { id: 'c', text: 'text', kind: 'hard_safety', forbidden: ['m'] },
  });
  const issues = validateCorpus({
    corpusFormatVersion: 1,
    name: 'x',
    entries: [entry('same'), entry('same')],
  });
  assert.ok(issues.some((i) => i.code === 'duplicate'));
});

test('an empty corpus is refused: it would report a green light', () => {
  const issues = validateCorpus({ corpusFormatVersion: 1, name: 'x', entries: [] });
  assert.ok(issues.some((i) => i.code === 'format'));
});

test('parseCorpus throws with every issue attached', () => {
  assert.throws(
    () => parseCorpus({ corpusFormatVersion: 1, name: '', entries: [] }, 'inline'),
    (err: unknown) => {
      assert.ok(err instanceof CorpusError);
      assert.ok(err.issues.length >= 2);
      assert.equal(err.source, 'inline');
      return true;
    },
  );
});

// ---------------------------------------------------------------- resolution

const sampleCorpus = (): Corpus =>
  parseCorpus({
    corpusFormatVersion: 1,
    name: 'sample',
    entries: [
      {
        id: 'ok',
        label: 'fine',
        source: { kind: 'github', repo: 'o/r', number: 1 },
        language: 'py',
        category: 'greenfield',
        constraint: { id: 'c1', text: 'text long enough', kind: 'hard_safety', forbidden: ['m'] },
      },
      {
        id: 'missing',
        label: 'gone',
        source: { kind: 'github', repo: 'o/r', number: 404 },
        language: 'py',
        category: 'refinement',
        constraint: { id: 'c2', text: 'text long enough', kind: 'soft_policy', forbidden: ['m'] },
      },
    ],
  });

test('resolution produces a citable prompt per entry', async () => {
  const corpus = parseCorpus({
    corpusFormatVersion: 1,
    name: 'sample',
    entries: [
      {
        id: 'one',
        label: 'fine',
        source: { kind: 'github', repo: 'o/r', number: 7 },
        language: 'py',
        category: 'greenfield',
        constraint: { id: 'c1', text: 'text long enough', kind: 'hard_safety', forbidden: ['m'] },
        notes: 'a note',
      },
    ],
  });
  const resolved = await resolveCorpus(corpus, () => Promise.resolve('#7 a title\n\nthe body'));
  assert.equal(resolved.length, 1);
  const task = resolved[0];
  assert.ok(task !== undefined);
  assert.equal(task.prompt, '#7 a title\n\nthe body');
  assert.equal(task.citation, 'o/r#7');
  assert.equal(task.notes, 'a note');
});

test('a board entry cites the board, not a repository', async () => {
  const corpus = parseCorpus({
    corpusFormatVersion: 1,
    name: 'sample',
    entries: [
      {
        id: 'board',
        label: 'own work',
        source: { kind: 'board', id: 'F1-4' },
        language: 'ts',
        category: 'greenfield',
        constraint: { id: 'c1', text: 'text long enough', kind: 'hard_safety', forbidden: ['m'] },
      },
    ],
  });
  const resolved = await resolveCorpus(corpus, () => Promise.resolve('the board row'));
  assert.equal(resolved[0]?.citation, 'docs/tasks.csv#F1-4');
});

/**
 * The failure mode this guards: a corpus that degrades to "no task" makes every
 * arm look compliant, because there was never anything to violate.
 */
test('one unresolvable entry fails the whole resolution, naming every failure', async () => {
  await assert.rejects(
    () =>
      resolveCorpus(sampleCorpus(), (entry: CorpusEntry) => {
        if (entry.id === 'missing') return Promise.reject(new Error('HTTP 404'));
        return Promise.resolve('fine');
      }),
    (err: unknown) => {
      assert.ok(err instanceof CorpusResolutionError);
      assert.equal(err.failures.length, 1);
      assert.equal(err.failures[0]?.id, 'missing');
      assert.ok(err.message.includes('404'));
      return true;
    },
  );
});

test('an entry that resolves to empty text is a failure, not an empty task', async () => {
  await assert.rejects(
    () => resolveCorpus(sampleCorpus(), () => Promise.resolve('   ')),
    (err: unknown) => {
      assert.ok(err instanceof CorpusResolutionError);
      assert.equal(err.failures.length, 2, 'both entries resolve to nothing');
      assert.ok(err.message.includes('empty'));
      return true;
    },
  );
});