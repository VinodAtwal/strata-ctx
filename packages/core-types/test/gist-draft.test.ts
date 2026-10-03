import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  GistDraftSchema,
  GistSchema,
  RAW_URI_UNSTORED,
  validateGist,
  validateGistDraft,
  type Gist,
  type GistDraft,
} from '../src/index.js';

/**
 * The draft half of the gist contract, and the gate that keeps it the only one.
 *
 * `GistDraft` had four definitions, three of them in packages that could not
 * see the corrections applied to the others, so the same false claim -- a
 * recoverability assertion for bytes no store holds -- shipped three times
 * before it was written down here. Two of the definitions were not the same
 * shape at all, which is the more interesting half of the story: see the
 * duplication gate at the bottom of this file.
 */

const committed: Gist = GistSchema.parse({
  v: 1,
  task_id: 't-1',
  status: 'complete',
  goal: 'add retry logic to the uploader',
  changed: [],
  current_values: {},
  decided: [],
  unresolved: [],
  artifacts: [],
  next: { question: 'does it survive a cold start?', next_command: 'npm test -- uploader', blockers: [] },
  log_gist: {
    ran: ['npm test'],
    failed: [],
    salient_errors: [],
    salient_warnings: [],
    dropped_count: 0,
    raw_uri: `artifact://transcript/${'c'.repeat(64)}`,
  },
  verification: { status: 'untested', tests_run: [] },
  constraints: ['never delete production data'],
  source_turn_range: [4, 11],
  raw_recoverable: true,
  compressed_by: 'self-gist',
});

const draft: GistDraft = { ...committed, log_gist: { ...committed.log_gist, raw_uri: RAW_URI_UNSTORED } };
delete (draft as { raw_recoverable?: true }).raw_recoverable;

test('a draft is a gist with the claim left off, and that is valid', () => {
  const r = validateGistDraft(draft);
  assert.equal(r.ok, true, JSON.stringify(r.defects));
  assert.equal(r.draft?.log_gist.raw_uri, RAW_URI_UNSTORED);
});

test('a draft cannot assert raw_recoverable: false', () => {
  // `false` is not a `Gist` at all -- `GistSchema` is `z.literal(true)` -- so an
  // object carrying it would fail its own contract further down. The schema says
  // no; the type says no; the two cannot be argued with separately.
  const { raw_recoverable: _drop, ...rest } = draft;
  assert.equal(GistDraftSchema.safeParse({ ...rest, raw_recoverable: false }).success, false);
  assert.equal(GistDraftSchema.safeParse({ ...rest, raw_recoverable: 'yes' }).success, false);
  assert.equal(GistDraftSchema.safeParse(rest).success, true);
});

test('the claim over an unstored transcript is a named defect, not a bare schema failure', () => {
  // `validateGist` cannot produce this answer, and the gap is worth stating
  // precisely because it is not a safety hole: `raw_uri` is a required
  // non-empty string and nothing in `GistSchema` knows what the marker means, so
  // a gist claiming recovery over an unstored transcript validates clean here.
  // The eviction gate still refuses it -- `assessEvictable` asks
  // `isResolvableArtifactUri` before discarding anything -- but the operator
  // reading a defect gets no sentence they can act on. This is the sentence.
  const claim = { ...draft, raw_recoverable: true };
  assert.equal(validateGist(claim).ok, true);
  assert.deepEqual(validateGist(claim).defects, []);

  const r = validateGistDraft(claim);
  assert.equal(r.ok, false);
  assert.deepEqual(r.defects, [{ kind: 'raw_uri_unstored' }]);
  assert.equal(r.draft, undefined);
});

test('a claim backed by a stored transcript is accepted', () => {
  const stored = { ...draft, log_gist: committed.log_gist, raw_recoverable: true as const };
  assert.equal(validateGistDraft(stored).ok, true);
  // And it is a `Gist` again, which is the point of the claim: the transaction
  // stamps this field after `artifactStore.put` and hands the result onward.
  assert.equal(validateGist(stored).ok, true);
});

test('the marker is a scheme no store parser would answer to', () => {
  // The reason this is a marker and not a placeholder `artifact://` URI: the
  // bundle and the digest tail are both load-bearing for the store, so a
  // synthetic URI in that costume reads as bytes to every recovery consumer.
  // A scheme the parser refuses cannot be mistaken for one.
  assert.equal(RAW_URI_UNSTORED.includes('://'), false);
  assert.equal(GistDraftSchema.safeParse({ ...committed, log_gist: { ...committed.log_gist, raw_uri: '' } }).success, false);
});

test('malformed input returns ok:false rather than throwing', () => {
  const r = validateGistDraft({ nonsense: true });
  assert.equal(r.ok, false);
  assert.equal(r.draft, undefined);
});

/* ------------------------------------------------------------------ *
 * The duplication gate.
 *
 * Four definitions of "a gist whose bytes are not stored" existed, and the
 * corrections to one of them could not reach the others because no package can
 * import any of them. That is the whole failure mode: not a bug that was
 * written once, but a rule that lives in one place while three other places
 * hold a copy. A test that only checks today's behaviour cannot see it coming
 * back, so this one asserts the shape of the tree.
 * ------------------------------------------------------------------ */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const sourcesUnder = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourcesUnder(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
};

const packageSources = (): readonly { readonly rel: string; readonly text: string }[] => {
  const packagesDir = path.join(ROOT, 'packages');
  const out: { rel: string; text: string }[] = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = path.join(packagesDir, entry.name, 'src');
    if (!existsSync(src)) continue;
    for (const file of sourcesUnder(src)) {
      out.push({ rel: path.relative(ROOT, file), text: readFileSync(file, 'utf8') });
    }
  }
  return out;
};

test('no package outside core-types redeclares the draft contract', () => {
  // `GistDraft` and the unstored marker are contract facts, not implementation
  // detail: `gist`, `integrations`, `pipeline` and `governance` all produce
  // documents that are governed by them and none of them can import any other.
  const offenders = packageSources()
    .filter((f) => !f.rel.startsWith('packages/core-types/'))
    .filter((f) => /\b(?:interface|type)\s+GistDraft\b/.test(f.text) || /['"`]unstored:/.test(f.text))
    .map((f) => f.rel);
  assert.deepEqual(
    offenders,
    [],
    'a second definition of the draft contract. Core-types owns it (gist.ts); a package that needs it imports RAW_URI_UNSTORED and GistDraft rather than writing its own.',
  );
});

test('the contract is actually reachable from every package that needs it', () => {
  // The other half. A gate that only forbids new copies passes just as happily
  // when the one true copy stops being imported, which is the same drift with
  // the sign flipped: four definitions again, one of them now lying.
  const importers = ['packages/gist', 'packages/integrations', 'packages/pipeline', 'packages/governance'];
  const missing = importers.filter((pkg) =>
    !packageSources().some((f) => f.rel.startsWith(`${pkg}/`) && /from '@strata-ctx\/core-types'/.test(f.text)),
  );
  assert.deepEqual(missing, [], 'these packages no longer import the contract at all');
});
