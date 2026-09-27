import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GistSchema, validateGist, type Gist } from '../src/index.js';

const valid: Gist = GistSchema.parse({
  v: 1,
  task_id: 't-1',
  status: 'complete',
  goal: 'add retry logic to the uploader',
  changed: [
    {
      path: 'src/uploader.ts',
      what: 'wrapped the send in a 3-attempt backoff',
      why: 'transient 5xx from the CDN',
      sha: 'a'.repeat(64),
    },
  ],
  current_values: { RETRY_MAX: '3' },
  decided: [{ id: 'D1', choice: 'exponential backoff', why: 'linear was not enough' }],
  unresolved: ['flaky test on CI runner 3'],
  artifacts: [{ uri: 'artifact://t-1/log', sha256: 'b'.repeat(64), bytes: 4096 }],
  next: { question: 'does it survive a cold start?', next_command: 'npm test -- uploader', blockers: [] },
  log_gist: {
    ran: ['npm test'],
    failed: ['npm test -- uploader'],
    salient_errors: ['ETIMEDOUT cdn.example.com'],
    salient_warnings: [],
    dropped_count: 12,
    raw_uri: 'artifact://t-1/raw',
  },
  verification: { tests_run: ['npm test -- uploader'], status: 'passing' },
  constraints: ['never delete production data'],
  source_turn_range: [4, 11],
  raw_recoverable: true,
  compressed_by: 'self-gist',
});

test('a complete gist round-trips unchanged', () => {
  const r = validateGist(valid);
  assert.equal(r.ok, true, JSON.stringify(r.defects));
  assert.deepEqual(r.gist, valid);
});

test('raw_recoverable is a literal, not a boolean', () => {
  const { raw_recoverable: _drop, ...rest } = valid;
  assert.equal(GistSchema.safeParse({ ...rest, raw_recoverable: false }).success, false);
  assert.equal(GistSchema.safeParse({ ...rest, raw_recoverable: 'yes' }).success, false);
});

test('a changed entry without a content hash is rejected', () => {
  const bad = { ...valid, changed: [{ path: 'a.ts', what: 'x', why: 'y', sha: 'not-a-sha' }] };
  assert.equal(GistSchema.safeParse(bad).success, false);
});

test('an inverted turn range is an abort condition', () => {
  const r = validateGist({ ...valid, source_turn_range: [11, 4] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.defects, [{ kind: 'turn_range_inverted', range: [11, 4] }]);
});

test('dropping a salient error is an abort condition', () => {
  // Every ERROR/FATAL line must survive. This is the invariant that stops a
  // summarizer from quietly swallowing the one failure that mattered.
  const r = validateGist(
    { ...valid, log_gist: { ...valid.log_gist, salient_errors: [] } },
    /* expectedErrorCount */ 1,
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.defects, [{ kind: 'errors_not_retained', missing: 1 }]);
});

test('salient_errors is not required to match when no count is supplied', () => {
  assert.equal(validateGist({ ...valid, log_gist: { ...valid.log_gist, salient_errors: [] } }).ok, true);
});

test('unresolved survives as a first-class field', () => {
  assert.deepEqual(validateGist(valid).gist?.unresolved, ['flaky test on CI runner 3']);
});

test('current_values and artifacts are required to be present for anti-drift', () => {
  const { current_values: _a, artifacts: _b, ...rest } = valid;
  // Both are defaulted, so absence is tolerated, but an empty state must be
  // explicit -- it is the difference between "nothing set" and "not recorded".
  const r = validateGist(rest);
  assert.equal(r.ok, true);
  assert.deepEqual(r.gist?.current_values, {});
  assert.deepEqual(r.gist?.artifacts, []);
});

test('constraints is a verification target, so it is allowed to be empty', () => {
  assert.equal(validateGist({ ...valid, constraints: [] }).ok, true);
});

test('a gist claiming a different schema version is rejected', () => {
  assert.equal(GistSchema.safeParse({ ...valid, v: 2 }).success, false);
});

test('malformed input returns ok:false rather than throwing', () => {
  const r = validateGist({ nonsense: true });
  assert.equal(r.ok, false);
  assert.equal(r.gist, undefined);
});
