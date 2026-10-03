import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { sha256 } from '@strata-ctx/core-types';

import { ArtifactAclError } from '../src/acl.js';
import { SecretLeakError } from '../src/redact.js';
import { ArtifactStore, artifactUriFor } from '../src/store.js';
import { DAY, T0, clock, tempStore, withTempDir } from './fixtures.js';

/**
 * I-3: the store writes redacted bytes, and the digest is taken after
 * redaction.
 *
 * The central test in this file is `never writes a secret, even transiently`.
 * It does not check the return value of `put`; it walks the whole store
 * directory afterwards and greps every file for the credential, because the
 * ordering claim is about the filesystem and not about the API's promises. An
 * implementation that hashed the inbound bytes, wrote them, and then redacted
 * the sidecar would pass every other test in this file.
 */

const SECRET = 'AKIAIOSFODNN7EXAMPLE';
/** A second credential of the same kind: same placeholder, different digest. */
const SECRET2 = 'AKIAIOSFODNN7EXAMPLB';

describe('put and read', () => {
  it('round-trips text and addresses it by the digest of the stored bytes', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      const put = await store.put('hello world', 'file_snapshot');
      assert.equal(put.uri, artifactUriFor(sha256('hello world')));
      assert.equal(put.sha256, sha256('hello world'));
      assert.equal(put.bytes, 'hello world'.length);
      assert.equal(put.redacted, false);
      assert.equal(put.deduped, false);
      assert.equal(put.writtenAt, T0);

      const read = await store.read(put.uri);
      assert.equal(read.text, 'hello world');
      assert.equal(read.stat.bytes, 'hello world'.length);
      assert.equal(read.integrity, 'exact');
    });
  });

  it('is idempotent for identical content', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      const first = await store.put('same', 'other');
      const second = await store.put('same', 'other');
      assert.equal(second.sha256, first.sha256);
      assert.equal(second.deduped, true, 'the second write created a second object');
      assert.equal((await store.list()).length, 1);
    });
  });

  it('uses the bucket that matches the kind', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      const t = await store.put('a', 'raw_transcript');
      const p = await store.put('b', 'patch');
      assert.match(t.uri, /^artifact:\/\/transcript\//);
      assert.match(p.uri, /^artifact:\/\/patch\//);
    });
  });
});

describe('I-3: a secret never reaches the filesystem', () => {
  it('writes redacted bytes and digests those', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      const put = await store.put(`key: ${SECRET}`, 'file_snapshot');

      assert.equal(put.redacted, true);
      assert.deepEqual(put.redactionKinds, ['aws_access_key_id']);
      // The digest is of the *stored* text, so the address a caller gets back
      // is the address of the redacted bytes. A digest of the inbound bytes
      // would hand out an address for content that is not on disk.
      const storedText = 'key: [strata:redacted:aws_access_key_id]';
      assert.equal(put.sha256, sha256(storedText));
      assert.equal(put.sourceDigest, sha256(`key: ${SECRET}`));
      assert.notEqual(put.sha256, put.sourceDigest);

      // Reading by the stored digest is an exact read: that is the object.
      const read = await store.read(put.uri);
      assert.equal(read.text, storedText);
      assert.equal(read.integrity, 'exact');
      assert.equal(read.stat.redacted, true, 'the sidecar does not record that redaction happened');
    });
  });

  it('leaves no file in the store containing the secret', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      await store.put(`key: ${SECRET}`, 'file_snapshot');
      await store.put(`another ${SECRET} here`, 'tool_log');

      // Walk everything, including sidecars and the audit log.
      const offenders: string[] = [];
      const walk = async (path: string): Promise<void> => {
        const entries = await fs.readdir(path, { withFileTypes: true });
        for (const entry of entries) {
          const full = join(path, entry.name);
          if (entry.isDirectory()) {
            await walk(full);
          } else {
            const bytes = await fs.readFile(full);
            if (bytes.includes(SECRET)) offenders.push(full);
          }
        }
      };
      await walk(store.root);
      assert.deepEqual(offenders, [], `the secret is in: ${offenders.join(', ')}`);
    });
  });

  it('refuses rather than writing when redaction is off and a secret is present', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now, redaction: { mode: 'off' } });
      // The fail-closed gate is I-2's job, reached through I-3's write path.
      await assert.rejects(() => store.put(SECRET, 'file_snapshot'), SecretLeakError);
      assert.equal((await store.list()).length, 0, 'the refused write left an object behind');
    });
  });

  it('refuses a binary artifact that contains a secret rather than corrupting it', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now, redaction: { mode: 'off' } });
      const bytes = Buffer.from(`header ${SECRET} footer`, 'utf8');
      await assert.rejects(() => store.put(bytes, 'other'), SecretLeakError);
      // A silently rewritten binary is worse than a refusal: the artifact is
      // corrupt and nothing says so.
      assert.equal((await store.list()).length, 0);
    });
  });

  it('stores binary content byte for byte when it holds no secret', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
      const put = await store.put(bytes, 'other');
      // Compared against the object on disk, not through `read().text`: the text
      // view is a utf8 decode and would turn 0x89 into U+FFFD, which says nothing
      // about what was stored.
      const onDisk = await fs.readFile(
        join(store.root, 'objects', put.sha256.slice(0, 2), put.sha256),
      );
      assert.deepEqual([...onDisk], [...bytes]);
      assert.equal(put.bytes, bytes.length);
    });
  });
});

describe('I-3: a B-3 pointer resolves after redaction', () => {
  it('resolves the pre-redaction digest to the stored object', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      const put = await store.put(`token ${SECRET}`, 'file_snapshot');

      // B-3 minted this URI *before* redaction, from the bytes of the file it
      // read. It must still resolve, or the pointer in the transcript becomes
      // a dangling reference the moment the user pastes a key.
      const published = artifactUriFor(sha256(`token ${SECRET}`));
      assert.equal(published, put.sourceDigest ? artifactUriFor(put.sourceDigest) : '');
      assert.equal(await store.exists(published), true);

      const read = await store.read(published);
      assert.equal(read.text, `token [strata:redacted:aws_access_key_id]`);
      assert.equal(read.integrity, 'redacted');
      assert.equal(read.stat.digest, put.sha256, 'the alias points at the stored digest');
    });
  });

  it('reports a dangling alias rather than a silent empty read', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      const put = await store.put(`token ${SECRET}`, 'file_snapshot');
      // Remove the object, leave the alias.
      await fs.rm(join(store.root, 'objects', put.sha256.slice(0, 2), put.sha256));
      const published = artifactUriFor(put.sourceDigest);
      const verify = await store.verify(published);
      assert.equal(verify.ok, false);
      assert.equal(verify.failure, 'dangling_alias');
    });
  });

  it('publishes the alias of a second file that redacts to the same bytes', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      // Two different credentials of the same kind redact to the same stored
      // text, so the second write is a dedupe: its object and sidecar already
      // exist. Its own published pointer still has to resolve, or a B-3 URI
      // minted for the second file dangles for the life of the store.
      const first = await store.put(SECRET, 'file_snapshot');
      const second = await store.put(SECRET2, 'file_snapshot');
      assert.equal(second.deduped, true);
      assert.equal(second.sha256, first.sha256);
      assert.notEqual(second.sourceDigest, first.sourceDigest);

      const read = await store.read(artifactUriFor(second.sourceDigest));
      assert.equal(read.text, '[strata:redacted:aws_access_key_id]');
      assert.equal(read.integrity, 'redacted');
    });
  });

  it('removes the alias along with the object, so nothing dangles', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      const put = await store.put(`token ${SECRET}`, 'file_snapshot');
      const published = artifactUriFor(put.sourceDigest);
      assert.equal(await store.remove(put.uri), true);
      assert.equal(await store.exists(published), false, 'the alias survived the object it pointed at');
      // Nothing left for a later prune to find.
      assert.equal(await store.pruneAliases(put.sha256), 0);
    });
  });

  it('prunes every alias that names a removed digest', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      const a = await store.put(SECRET, 'file_snapshot');
      const b = await store.put(SECRET2, 'file_snapshot');
      assert.equal(a.sha256, b.sha256, 'the precondition is that both stored objects are the same');
      // The sidecar records one source digest, but two aliases exist. Pruning
      // by walking the object list would only ever find one of them.
      const pruned = await store.pruneAliases(a.sha256);
      assert.equal(pruned, 2);
      assert.equal(await store.exists(artifactUriFor(a.sourceDigest)), false);
      assert.equal(await store.exists(artifactUriFor(b.sourceDigest)), false);
    });
  });

  it('does not create an alias when nothing was redacted', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      const put = await store.put('clean text', 'file_snapshot');
      assert.equal(await store.pruneAliases(put.sha256), 0);
      assert.equal((await store.list()).length, 1);
    });
  });
});

describe('named artifacts', () => {
  it('writes and reads a named uri', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      const uri = 'artifact://file/named/notes.md';
      const put = await store.putNamed(uri, '# notes', 'file_snapshot');
      assert.equal(put.uri, uri);
      assert.equal((await store.read(uri)).text, '# notes');
      assert.equal(await store.exists(uri), true);
    });
  });

  it('refuses a named uri that is not named', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      await assert.rejects(() => store.putNamed(artifactUriFor(sha256('x')), 'x', 'other'));
    });
  });
});

describe('the ACL is the only authority', () => {
  it('refuses a read of a traversal uri and records the denial', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      await assert.rejects(
        () => store.read('artifact://file/../../etc/passwd'),
        ArtifactAclError,
      );
      const log = await store.audit.read();
      assert.ok(
        log.some((e) => e.action === 'acl_denied'),
        'the denial was not audited',
      );
    });
  });

  it('refuses a read of a uri that does not exist', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      await assert.rejects(
        () => store.read(artifactUriFor(sha256('absent'))),
        (e: unknown) => e instanceof ArtifactAclError && e.violation === 'not_found',
      );
    });
  });

  it('refuses a uri whose bucket is unknown', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      await assert.rejects(() => store.read('artifact://secrets/x'), ArtifactAclError);
    });
  });

  it('refuses a malformed uri from `exists` rather than answering false', async () => {
    // `exists` is the same question `resolve` answers, so it refuses the same
    // things: "this is not a URI" and "I do not have it" are different answers,
    // and a caller gating an integrity check on the difference needs both.
    // Returning `false` here would report a truncated pointer as a missing
    // artifact, which is a defect report about the wrong thing.
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      await assert.rejects(
        () => store.exists('artifact://file/abc123'),
        (e: unknown) => e instanceof ArtifactAclError && e.violation === 'malformed_digest',
      );
      // The digest form still answers, so a caller that resolved its own
      // reference first is unaffected.
      assert.equal(await store.exists(sha256('never written')), false);
    });
  });
});

describe('verify', () => {
  it('confirms a good object', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      const put = await store.put('intact', 'other');
      const result = await store.verify(put.uri);
      assert.equal(result.ok, true);
      assert.equal(result.failure, undefined);
    });
  });

  it('detects a digest mismatch', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      const put = await store.put('intact', 'other');
      // Corrupt the object behind the store's back: a bit-rot simulation, and
      // the only way `verify` earns its keep.
      await fs.writeFile(join(store.root, 'objects', put.sha256.slice(0, 2), put.sha256), 'tampered');
      const result = await store.verify(put.uri);
      assert.equal(result.ok, false);
      assert.equal(result.failure, 'digest_mismatch');
      assert.equal(result.actual, sha256('tampered'));
    });
  });

  it('reports a missing object', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      const result = await store.verify(artifactUriFor(sha256('never written')));
      assert.equal(result.ok, false);
      assert.equal(result.failure, 'missing');
    });
  });
});

describe('list', () => {
  it('returns one stat per object, with the age the retention planner needs', async () => {
    await withTempDir(async (dir) => {
      const t = clock(T0);
      const store = await tempStore(dir, { now: t.now });
      await store.put('one', 'raw_transcript', { at: T0 });
      await store.put('two', 'file_snapshot', { at: T0 + DAY });

      const stats = await store.list();
      assert.equal(stats.length, 2);
      const raw = stats.find((s) => s.kind === 'raw_transcript');
      const art = stats.find((s) => s.kind === 'file_snapshot');
      assert.equal(raw?.writtenAt, T0);
      assert.equal(art?.writtenAt, T0 + DAY);
    });
  });

  it('is empty for a fresh store', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      assert.deepEqual(await store.list(), []);
    });
  });
});

describe('remove', () => {
  it('removes the object and its sidecar', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      const put = await store.put('bye', 'other');
      assert.equal(await store.remove(put.uri), true);
      assert.equal(await store.exists(put.uri), false);
      const objects = await fs.readdir(join(store.root, 'objects', put.sha256.slice(0, 2)));
      assert.deepEqual(objects, [], 'the sidecar outlived the object');
    });
  });

  it('returns false for something that is not there', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      assert.equal(await store.remove(artifactUriFor(sha256('absent'))), false);
    });
  });
});

describe('the audit log records every write', () => {
  it('records the kind, the digest, and that a redaction happened', async () => {
    await withTempDir(async (dir) => {
      const store = await tempStore(dir, { now: clock(T0).now });
      const put = await store.put(`k: ${SECRET}`, 'file_snapshot');
      const records = await store.audit.read();
      const written = records.find((e) => e.action === 'artifact_written');
      assert.ok(written);
      assert.equal(written.target, put.uri);
      assert.equal(written.count, 1);
      assert.deepEqual(written.kinds, ['aws_access_key_id']);
      // The record names the credential it found, and not the credential.
      assert.equal(JSON.stringify(records).includes(SECRET), false);
    });
  });
});

describe('a store refuses to open on a path that is not a directory', () => {
  it('rejects a file', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'not-a-dir');
      await fs.writeFile(file, 'x');
      await assert.rejects(() => ArtifactStore.open({ root: file }));
    });
  });
});
