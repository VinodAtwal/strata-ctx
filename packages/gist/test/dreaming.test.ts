import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Gist, StrataPolicy } from '@strata-ctx/core-types';
import { ArtifactStore } from '@strata-ctx/security';
import type { StrataTelemetryEvent } from '@strata-ctx/telemetry';
import { createDreamingJob } from '../src/dreaming.js';
import type { MetaGist } from '../src/dreaming.js';
import { isResolvableArtifactUri } from '../src/artifact-uri.js';
import { RAW_URI_UNSTORED } from '../src/draft.js';
import { createTestGist, createTestPolicy } from './fixtures.js';

/**
 * There is no `dreaming.test.ts` in this package yet, so this file establishes
 * the baseline as well as the regression. The case under test is the claim a
 * meta gist makes about its own recoverability, because that claim is the one
 * thing about a consolidated gist a downstream gate can act on.
 *
 * `DreamingDeps.store` is a real `ArtifactStore` rather than a stub: it is the
 * real ACL that refuses `artifact://log/meta_<task-id>`, and a stub would
 * decide for itself what is well formed.
 */

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const openStore = async (): Promise<ArtifactStore> => {
  const root = await mkdtemp(join(tmpdir(), 'strata-gist-dreaming-'));
  roots.push(root);
  return ArtifactStore.open({ root });
};

const policy: StrataPolicy = createTestPolicy();

/** Two gists over the same file, which is what makes them one cluster. */
const clusterInput = (): readonly Gist[] => [
  createTestGist(),
  createTestGist({ task_id: 'task-test-789' }),
];

interface RunOutcome {
  readonly report: Awaited<ReturnType<ReturnType<typeof createDreamingJob>['run']>>;
  readonly stored: readonly MetaGist[];
  readonly removed: readonly string[];
  readonly events: readonly StrataTelemetryEvent[];
}

async function runDreaming(gists: readonly Gist[]): Promise<RunOutcome> {
  const stored: MetaGist[] = [];
  const removed: string[] = [];
  const events: StrataTelemetryEvent[] = [];
  let tick = 1_700_000_000_000;
  const clock = (): number => {
    tick += 1;
    return tick;
  };

  const job = createDreamingJob({
    store: await openStore(),
    policy,
    getGists: () => Promise.resolve(gists),
    putGist: (gist) => {
      if (!('meta' in gist)) throw new Error(`dreaming stored a non-meta gist: ${gist.task_id}`);
      stored.push(gist);
      return Promise.resolve();
    },
    removeGist: (taskId) => {
      removed.push(taskId);
      return Promise.resolve();
    },
    emitTelemetry: (event) => events.push(event),
    clock,
    config: { enabled: true, intervalHours: 24, maxGistsPerRun: 50 },
  });

  return { report: await job.run(), stored, removed, events };
}

describe('dreaming: what a meta gist claims about its own recovery', () => {
  test('a meta gist names no transcript and claims no recoverability', async () => {
    // The regression: `log_gist.raw_uri` was `artifact://log/meta_<task-id>`,
    // where the tail is a task id and a timestamp rather than a digest, so the
    // ACL refused it as `malformed_digest` and the URI addressed no object in
    // any store. `raw_recoverable: true` was stamped beside it regardless.
    const { report, stored } = await runDreaming(clusterInput());

    assert.equal(report.metaGistsCreated, 1, 'the meta gist must still be built and stored');
    const meta = stored[0];
    assert.ok(meta, 'a cluster of two must consolidate into one meta gist');

    assert.equal(meta.log_gist.raw_uri, RAW_URI_UNSTORED);
    assert.ok(
      !meta.log_gist.raw_uri.startsWith('artifact://'),
      'nothing was ever stored under a meta-gist uri, so it must not claim the scheme',
    );
    assert.equal(
      isResolvableArtifactUri(meta.log_gist.raw_uri),
      false,
      'a meta gist has no transcript, so no uri may look like one the store could serve',
    );
    assert.equal(meta.raw_recoverable, false, 'the union of N transcripts is not re-injectable');
  });

  test('a meta gist still consolidates and still evicts its constituents', async () => {
    // The positive half: reporting the claim honestly must not cost the job
    // its function. If the recoverability defect were treated as a reason to
    // refuse, this run would produce nothing and evict nobody.
    const gists = clusterInput();
    const { report, stored, removed, events } = await runDreaming(gists);

    assert.deepEqual(report.errors, []);
    assert.equal(report.clustersFormed, 1);
    assert.equal(report.metaGistsCreated, 1);
    assert.equal(report.constraintsPreserved, true);
    assert.deepEqual(removed, gists.map((g) => g.task_id));

    const meta = stored[0];
    assert.ok(meta);
    assert.deepEqual(meta.subsumedGistIds, gists.map((g) => g.task_id));
    assert.deepEqual(meta.log_gist.dropped_count, 10, 'the constituents are unioned, not dropped');
    assert.deepEqual(meta.log_gist.ran, ['npm test']);
    assert.deepEqual(meta.changed.map((c) => c.path), ['src/test.ts']);
    assert.ok(events.some((e) => e.type === 'consolidation'));
  });

  test('the recovery path is the constituent gists, and it is named', async () => {
    // What a consumer does with a meta gist that cannot be recovered from its
    // own uri: read `subsumedGistIds` and follow each constituent's own
    // `log_gist.raw_uri`. Both halves of that path have to survive
    // consolidation, or the honest `raw_recoverable: false` would be a dead
    // end rather than a redirect. The pointers compared here come from the
    // shared fixtures and are deliberately malformed, so this asserts the
    // redirect and not the ACL -- `reversibility.test.ts` covers resolution.
    const gists = clusterInput();
    const { stored } = await runDreaming(gists);

    const meta = stored[0];
    assert.ok(meta);
    for (const id of meta.subsumedGistIds) {
      const constituent = gists.find((g) => g.task_id === id);
      assert.ok(constituent, `subsumedGistIds names ${id}, which is not one of the inputs`);
      assert.notEqual(
        constituent.log_gist.raw_uri,
        meta.log_gist.raw_uri,
        'the constituent keeps its own transcript pointer; the meta gist does not take it',
      );
    }
  });

  test('a cluster whose meta gist breaks another invariant is still refused', async () => {
    // Guards the substitution in run(): a meta gist is validated as the shape
    // it would have if it could claim recovery, so every *other* invariant
    // still refuses the cluster. A schema failure is a different thing -- and
    // `validateGist` reports one as *no* defects at all
    // (core-types/src/gist.ts:127), which is why run() has to name that case
    // rather than joining an empty list of reasons.
    const undigested = createTestGist({
      changed: [{ path: 'src/test.ts', what: 'wrote a fixture', why: 'to test', sha: 'not-a-digest' }],
    });
    const { report, stored, removed } = await runDreaming([undigested, createTestGist()]);

    assert.equal(report.metaGistsCreated, 0);
    assert.deepEqual(stored, []);
    assert.deepEqual(removed, []);
    assert.equal(report.constraintsPreserved, false);
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0] ?? '', /does not satisfy the v1 schema/);
  });
});