import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { sha256, taskId } from '@strata-ctx/core-types';
import { ArtifactStore } from '@strata-ctx/security';

import { createStoreBackedContext } from '../src/artifact-context.js';
import type { MCPServer } from '../src/mcp-server.js';
import { createStrataMcpServer } from '../src/mcp-server.js';

/**
 * C-14: the object the gateway wrote and the answer an MCP client gets back.
 *
 * Every case runs against a real `ArtifactStore` on a real temp directory, for
 * the same reason `artifact-persistence.test.ts` does: a stub store passes the
 * bug these cover, which is that `get_artifact` reported a perfectly good
 * on-disk object as missing.
 */

const TEXT = 'const estimate = (chars: number): number => Math.ceil(chars / 4);\n';

const roots: string[] = [];

const openStore = async (): Promise<ArtifactStore> => {
  const root = await mkdtemp(join(tmpdir(), 'strata-ctx-artifact-'));
  roots.push(root);
  return ArtifactStore.open({ root });
};

after(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});

async function callData(srv: MCPServer, name: string, args: Record<string, unknown> = {}) {
  const result = await srv.callTool(name, args);
  assert.equal(result.isError, undefined, `expected ${name} to succeed`);
  return { result, data: JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown> };
}

describe('artifact-context: a ContextMemory over an ArtifactStore', () => {
  test('resolves a stored artifact by uri and by bare digest', async () => {
    const store = await openStore();
    const put = await store.put(TEXT, 'file_snapshot');
    const memory = createStoreBackedContext(store);

    const byUri = await memory.lookupArtifact(put.uri);
    assert.equal(byUri.ok, true, `lookup failed: ${byUri.ok ? '' : byUri.detail}`);
    if (!byUri.ok) return;
    assert.equal(byUri.artifact.text, TEXT, 'the bytes the pointer names, verbatim');
    assert.equal(byUri.artifact.sha256, put.sha256);
    assert.equal(byUri.artifact.bytes, TEXT.length);
    assert.equal(byUri.artifact.kind, 'file_snapshot');
    assert.equal(byUri.artifact.uri, put.uri);
    assert.equal(byUri.artifact.createdAt, put.writtenAt);
    assert.equal(byUri.integrity, 'exact');

    const byDigest = await memory.lookupArtifact(put.sha256);
    assert.equal(byDigest.ok, true, 'a bare digest is the same object, not a second one');
    if (byDigest.ok) assert.equal(byDigest.artifact.uri, put.uri);
  });

  test('a ref the parser rejects is malformed_ref, before the store is touched', async () => {
    const store = await openStore();
    const memory = createStoreBackedContext(store);

    // Byte-identical to what `syncLookup` answers: one wording for "malformed",
    // so the two bindings cannot disagree about what a bad ref is.
    assert.deepEqual(await memory.lookupArtifact('artifact://nope'), {
      ok: false,
      failure: 'malformed_ref',
      uri: 'artifact://nope',
      detail: 'expected artifact://<bucket>/<64 hex sha256> or a bare 64 hex digest',
    });
  });

  test('an unknown digest is absent, in the store\'s own words', async () => {
    const store = await openStore();
    const memory = createStoreBackedContext(store);
    const missing = sha256('never written to this store');

    const lookup = await memory.lookupArtifact(missing);
    assert.equal(lookup.ok, false);
    if (lookup.ok) return;
    assert.equal(lookup.failure, 'absent', '"the store did not find it" is the only arm that may say not found');
    assert.equal(lookup.uri, `artifact://file/${missing}`);
    assert.match(lookup.detail, /\(not_found\)/, 'the refusal is the store\'s, passed through unedited');
  });

  test('a store that cannot answer is unresolved, not absent', async () => {
    const reachable = await openStore();
    await reachable.put(TEXT, 'file_snapshot');
    const unreachable = Object.create(reachable, {
      read: { value: () => Promise.reject(new Error('disk offline')) },
    }) as ArtifactStore;
    const memory = createStoreBackedContext(unreachable);

    const lookup = await memory.lookupArtifact(sha256(TEXT));
    assert.equal(lookup.ok, false);
    if (lookup.ok) return;
    assert.equal(lookup.failure, 'unresolved', 'a store that did not answer must not be reported as a miss');
    assert.match(lookup.detail, /disk offline/);
  });

  test('the sync getArtifact refuses rather than inventing a not-found', async () => {
    const store = await openStore();
    const put = await store.put(TEXT, 'patch');
    const memory = createStoreBackedContext(store);

    // The object exists. Returning `undefined` here -- the interface's only
    // "no such artifact" -- would restate the original defect through a
    // different method, so the sync path is refused outright.
    assert.throws(() => memory.getArtifact(put.uri), /asynchronous ACL/);
    assert.equal(await store.exists(put.uri), true, 'and the refusal says nothing about the object itself');
  });

  test('the MCP get_artifact tool resolves through the store binding', async () => {
    const store = await openStore();
    const put = await store.put(TEXT, 'raw_transcript');
    const server = createStrataMcpServer(createStoreBackedContext(store));

    const { data } = await callData(server, 'get_artifact', { ref: put.uri });
    assert.equal(data['content'], TEXT);
    assert.equal(data['sha256'], put.sha256);
    assert.equal(data['integrity'], 'exact');

    const miss = await server.callTool('get_artifact', { ref: sha256('not in this store') });
    assert.equal(miss.isError, true);
    assert.match(miss.content[0]?.text ?? '', /artifact not found/, 'the one arm that says "not found"');
  });

  test('the seed still answers everything that never crosses the ACL', async () => {
    const store = await openStore();
    const memory = createStoreBackedContext(store, {
      notes: [
        { id: 'note-1', text: 'uploader backpressure is missing in v2', tags: ['uploader'], source: 'agent', ts: 100 },
      ],
      tasks: [
        {
          id: taskId('T-1'),
          title: 'Migrate uploader to streaming',
          goal: 'Stop buffering whole uploads',
          status: 'in_progress',
          tags: [],
          createdAt: 1,
          updatedAt: 2,
          turns: [],
        },
      ],
    });

    assert.equal(memory.getTask(taskId('T-1'))?.title, 'Migrate uploader to streaming');
    assert.equal(memory.search({ q: 'backpressure' })[0]?.id, 'note-1');
    assert.equal(memory.status().notes, 1);
    assert.equal(memory.status().artifacts, 0, 'and nothing pretends the disk objects are in memory');
  });
});
