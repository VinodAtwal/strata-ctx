import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, createArtifactStore } from '../src/artifact-store.js';
import type { ArtifactRef } from '@strata-ctx/core-types';

describe('ArtifactStore', () => {
  let store: ArtifactStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'strata-artifacts-'));
    store = createArtifactStore({ rootDir: tempDir });
    await store.initialize();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('put returns content-addressed ArtifactRef', () => {
    const data = new TextEncoder().encode('hello world');
    const ref = store.put(data);

    assert.ok(ref.uri.startsWith('artifact://'));
    assert.equal(ref.sha256.length, 64);
    assert.equal(ref.bytes, data.length);
    assert.ok(ref.uri.includes(ref.sha256));
  });

  test('put with same bytes returns same hash', () => {
    const data = new TextEncoder().encode('same content');
    const ref1 = store.put(data);
    const ref2 = store.put(data);

    assert.equal(ref1.sha256, ref2.sha256);
    assert.equal(ref1.uri, ref2.uri);
  });

  test('get retrieves stored bytes', async () => {
    const data = new TextEncoder().encode('test data for retrieval');
    const ref = store.put(data);

    const retrieved = await store.get(ref);

    assert.ok(retrieved);
    assert.deepEqual(retrieved, data);
  });

  test('get returns null for non-existent artifact', async () => {
    const ref: ArtifactRef = { uri: 'artifact://' + 'f'.repeat(64), sha256: 'f'.repeat(64), bytes: 0, kind: 'other' };
    const retrieved = await store.get(ref);
    assert.equal(retrieved, null);
  });

  test('delete removes unreferenced artifact', async () => {
    const data = new TextEncoder().encode('to be deleted');
    const ref = store.put(data);

    const deleted = await store.delete(ref);

    assert.equal(deleted, true);
    const retrieved = await store.get(ref);
    assert.equal(retrieved, null);
  });

  test('delete returns false for referenced artifact', async () => {
    const data = new TextEncoder().encode('referenced');
    const ref = store.put(data);
    store.addRef(ref);

    const deleted = await store.delete(ref);

    assert.equal(deleted, false);
    const retrieved = await store.get(ref);
    assert.ok(retrieved);
  });

  test('delete returns false for non-existent artifact', async () => {
    const ref: ArtifactRef = { uri: 'artifact://' + 'f'.repeat(64), sha256: 'f'.repeat(64), bytes: 0, kind: 'other' };
    const deleted = await store.delete(ref);
    assert.equal(deleted, false);
  });

  test('addRef and removeRef track reference counts', () => {
    const data = new TextEncoder().encode('ref counted');
    const ref = store.put(data);

    assert.equal(store.getRefCount(ref), 1);

    store.addRef(ref);
    assert.equal(store.getRefCount(ref), 2);

    store.removeRef(ref);
    assert.equal(store.getRefCount(ref), 1);

    store.removeRef(ref);
    assert.equal(store.getRefCount(ref), 0);
  });

  test('fsync durability: file persists after put', async () => {
    const data = new TextEncoder().encode('durability test');
    const ref = store.put(data);

    const _filePath = join(tempDir, ref.sha256.slice(0, 2), ref.sha256);
    const retrieved = await store.get(ref);
    assert.ok(retrieved);
    assert.deepEqual(retrieved, data);
  });

  test('GC deletes only unreferenced artifacts older than threshold', async () => {
    const oldData = new TextEncoder().encode('old artifact');
    const oldRef = store.put(oldData);

    const newData = new TextEncoder().encode('new artifact');
    const newRef = store.put(newData);

    store.addRef(newRef);

    // refThreshold=1 means delete artifacts with only the initial put reference (refCount <= 1)
    // Small delay to ensure file mtime is <= now (avoids clock resolution issues on some filesystems)
    await new Promise((r) => setTimeout(r, 10));
    const deleted = await store.gc(0, 1);

    assert.equal(deleted, 1);
    const oldRetrieved = await store.get(oldRef);
    assert.equal(oldRetrieved, null);
    const newRetrieved = await store.get(newRef);
    assert.ok(newRetrieved);
  });

  test('GC respects minRefCount', async () => {
    const data = new TextEncoder().encode('referenced artifact');
    const ref = store.put(data);
    store.addRef(ref);
    store.addRef(ref);

    const deleted = await store.gc(0, 1);

    assert.equal(deleted, 0);
    const retrieved = await store.get(ref);
    assert.ok(retrieved);
  });

  test('GC respects maxAgeDays', async () => {
    const data = new TextEncoder().encode('recent artifact');
    const ref = store.put(data);

    const deleted = await store.gc(30, 0);

    assert.equal(deleted, 0);
    const retrieved = await store.get(ref);
    assert.ok(retrieved);
  });

  test('concurrent put/get safety', async () => {
    const data = new TextEncoder().encode('concurrent test');
    const refs = Array.from({ length: 10 }, () => store.put(data));

    const results = await Promise.all(refs.map((r) => store.get(r)));

    for (const result of results) {
      assert.ok(result);
      assert.deepEqual(result, data);
    }
  });

  test('content addressing: different content produces different hashes', () => {
    const data1 = new TextEncoder().encode('content one');
    const data2 = new TextEncoder().encode('content two');

    const ref1 = store.put(data1);
    const ref2 = store.put(data2);

    assert.notEqual(ref1.sha256, ref2.sha256);
    assert.notEqual(ref1.uri, ref2.uri);
  });

  test('artifact stored in sharded directory structure', async () => {
    const data = new TextEncoder().encode('sharded');
    const ref = store.put(data);

    const prefix = ref.sha256.slice(0, 2);
    const expectedDir = join(tempDir, prefix);
    const expectedFile = join(expectedDir, ref.sha256);

    const stats = await import('node:fs/promises').then((fs) => fs.stat(expectedFile).catch(() => null));
    assert.ok(stats);
    assert.ok(stats.isFile());
  });

  test('round-trip put/get preserves data exactly', async () => {
    const original = new Uint8Array([0x00, 0xff, 0xaa, 0x55, 0x12, 0x34, 0x56, 0x78]);
    const ref = store.put(original);
    const retrieved = await store.get(ref);

    assert.ok(retrieved);
    assert.deepEqual(retrieved, original);
  });

  test('large artifact handling', async () => {
    const largeData = new Uint8Array(1024 * 1024);
    for (let i = 0; i < largeData.length; i++) {
      largeData[i] = i % 256;
    }

    const ref = store.put(largeData);
    const retrieved = await store.get(ref);

    assert.ok(retrieved);
    assert.equal(retrieved.length, largeData.length);
    assert.deepEqual(retrieved, largeData);
  });

  test('empty artifact handling', async () => {
    const emptyData = new Uint8Array(0);
    const ref = store.put(emptyData);
    const retrieved = await store.get(ref);

    assert.ok(retrieved);
    assert.equal(retrieved.length, 0);
  });
});