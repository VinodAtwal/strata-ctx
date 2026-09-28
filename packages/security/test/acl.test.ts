import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { sha256 } from '@strata-ctx/core-types';

import { ARTIFACT_BUCKETS, ArtifactAcl, ArtifactAclError, contains, parseArtifactUri, realpathNearest } from '../src/acl.js';
import { withTempDir } from './fixtures.js';

/**
 * I-4: the artifact ACL.
 *
 * The property under test throughout is that the ACL is the *only* thing that
 * decides which path gets opened, and that it decides it after the filesystem has
 * had its say. A URI that a string check alone would accept -- percent-encoded
 * traversal, a symlinked ancestor, a name that looks absolute -- must still be
 * refused.
 *
 * Every refusal is checked for a *named* violation, not just a throw. "It threw"
 * is the property an attacker needs; "it threw because the resolved path was
 * outside the root, and the error says so" is the property an operator needs.
 */

const D = sha256('payload');

describe('parseArtifactUri accepts the forms the product mints', () => {
  it('accepts a content-addressed uri in every bucket', () => {
    for (const bucket of ARTIFACT_BUCKETS) {
      const uri = `artifact://${bucket}/${D}`;
      const parsed = parseArtifactUri(uri);
      assert.equal(parsed.bucket, bucket);
      assert.deepEqual(parsed.segments, [D]);
      assert.equal(parsed.contentAddressed, true);
    }
  });

  it('accepts the B-3 pointer shape byte for byte', () => {
    // `artifactUriFor` in ./store.ts and the pointer stage in the pipeline both
    // depend on this exact string; if the grammar moves, they move with it.
    const parsed = parseArtifactUri(`artifact://file/${D}`);
    assert.equal(parsed.bucket, 'file');
    assert.deepEqual(parsed.segments, [D]);
    assert.equal(parsed.contentAddressed, true);
  });

  it('accepts a named uri', () => {
    const parsed = parseArtifactUri('artifact://file/named/report-2026-09.md');
    assert.equal(parsed.contentAddressed, false);
    assert.deepEqual(parsed.segments, ['named', 'report-2026-09.md']);
  });

  it('accepts a nested named uri', () => {
    const parsed = parseArtifactUri('artifact://log/named/2026/09/28/run.jsonl');
    assert.equal(parsed.contentAddressed, false);
    assert.deepEqual(parsed.segments, ['named', '2026', '09', '28', 'run.jsonl']);
  });

  it('is case-insensitive about the scheme only', () => {
    assert.deepEqual(parseArtifactUri(`ARTIFACT://file/${D}`).segments, [D]);
    // The bucket is a path component, so it is not case-folded: `File/` and
    // `file/` would be two different directories on a case-sensitive fs.
    assert.throws(() => parseArtifactUri(`artifact://File/${D}`), ArtifactAclError);
  });
});

describe('parseArtifactUri refuses escapes', () => {
  const cases: { uri: string; violation: string; why: string }[] = [
    { uri: '', violation: 'empty_uri', why: 'the empty uri is not a thing' },
    { uri: '   ', violation: 'empty_uri', why: 'whitespace is not a uri' },
    { uri: 'file:///etc/passwd', violation: 'bad_scheme', why: 'another scheme is not ours to resolve' },
    { uri: 'artifact:/file/x', violation: 'bad_scheme', why: 'the scheme separator is required' },
    { uri: `artifact://file/${D}\0/../../etc/passwd`, violation: 'control_character', why: 'a NUL truncates the path in C' },
    { uri: 'artifact://file/a\nb', violation: 'control_character', why: 'a newline splits the log line' },
    { uri: 'artifact://nope/x', violation: 'unknown_bucket', why: 'a closed set of buckets' },
    { uri: 'artifact:///x', violation: 'unknown_bucket', why: 'no bucket at all' },
    { uri: 'artifact://file/../etc/passwd', violation: 'traversal_segment', why: 'traversal is the whole attack' },
    { uri: 'artifact://file/named/../../etc/passwd', violation: 'traversal_segment', why: 'traversal through the named form' },
    { uri: 'artifact://file/%2e%2e/etc/passwd', violation: 'traversal_segment', why: 'encoded traversal' },
    { uri: 'artifact://file/%252e%252e/etc/passwd', violation: 'traversal_segment', why: 'doubly encoded traversal' },
    { uri: 'artifact://file/%2E%2E%2Fetc%2Fpasswd', violation: 'traversal_segment', why: 'fully encoded traversal' },
    { uri: 'artifact://file/..%2f..%2fetc', violation: 'traversal_segment', why: 'half encoded traversal' },
    { uri: 'artifact://file/abc%ff', violation: 'encoding_attack', why: 'a non-utf8 byte is not a name' },
    { uri: 'artifact://file/a%00b', violation: 'control_character', why: 'an encoded NUL is still a NUL' },
    { uri: 'artifact://file//etc', violation: 'empty_segment', why: 'an empty segment is a missing name' },
    { uri: 'artifact://file/a//b', violation: 'empty_segment', why: 'an empty segment in the middle is still empty' },
    { uri: 'artifact://file/~root', violation: 'illegal_segment', why: 'no tilde expansion' },
    { uri: 'artifact://file/named/~', violation: 'illegal_segment', why: 'no tilde expansion in the named form' },
    { uri: 'artifact://file/C:/win', violation: 'illegal_segment', why: 'no drive letters' },
    { uri: 'artifact://file/name?x=1', violation: 'illegal_segment', why: 'a query is not part of an identity' },
    { uri: 'artifact://file/name#frag', violation: 'illegal_segment', why: 'a fragment is not part of an identity' },
    { uri: 'artifact://file/name with space', violation: 'illegal_segment', why: 'spaces are not in the segment charset' },
    { uri: 'artifact://file/back\\slash', violation: 'illegal_segment', why: 'a backslash is a separator on win32' },
  ];

  for (const { uri, violation, why } of cases) {
    it(`refuses ${JSON.stringify(uri)} (${why})`, () => {
      assert.throws(
        () => parseArtifactUri(uri),
        (e: unknown) => {
          assert.ok(e instanceof ArtifactAclError, `wrong error type for ${uri}: ${String(e)}`);
          assert.equal(e.violation, violation, `wrong violation for ${uri}: ${e.violation}`);
          return true;
        },
      );
    });
  }

  it('refuses a digest of the wrong length or alphabet', () => {
    for (const digest of [D.slice(0, 63), D + 'a', D.toUpperCase(), 'g'.repeat(64), `${D}0`]) {
      assert.throws(
        () => parseArtifactUri(`artifact://file/${digest}`),
        (e: unknown) => e instanceof ArtifactAclError && e.violation === 'malformed_digest',
        `accepted ${digest}`,
      );
    }
  });
});

describe('contains', () => {
  it('accepts anything under the root', () => {
    assert.equal(contains('/a/b', '/a/b/c'), true);
    assert.equal(contains('/a/b', '/a/b/c/d/e'), true);
  });

  it('does not accept the root as its own content', () => {
    // The store root is a directory, not an artifact. If `contains(root, root)`
    // were true, a uri resolving to the root would be readable, and a
    // `list`-shaped mistake would hand out the whole directory.
    assert.equal(contains('/a/b', '/a/b'), false);
  });

  it('refuses a sibling with a shared prefix', () => {
    // The string-prefix bug: `/a/bc` starts with `/a/b`.
    assert.equal(contains('/a/b', '/a/bc'), false);
    assert.equal(contains('/a/b', '/a/b-2/c'), false);
  });

  it('refuses a parent', () => {
    assert.equal(contains('/a/b', '/a'), false);
    assert.equal(contains('/a/b', '/'), false);
  });
});

describe('realpathNearest', () => {
  it('re-appends the missing tail onto the resolved ancestor', async () => {
    // A write target does not exist yet, so the function has to return a usable
    // path for it -- the resolved nearest ancestor plus the tail, with `existed`
    // false. The security-relevant part is that the *resolved* part is real:
    // if `/var` is a symlink, the returned path contains the real one.
    await withTempDir(async (dir) => {
      const real = await fs.realpath(dir);
      const nearest = await realpathNearest(join(real, 'a', 'b', 'c'));
      assert.equal(nearest.realPath, join(real, 'a', 'b', 'c'));
      assert.equal(nearest.existed, false);
    });
  });

  it('resolves a symlinked ancestor even when the leaf is missing', async () => {
    await withTempDir(async (dir) => {
      const elsewhere = join(dir, 'elsewhere');
      await fs.mkdir(elsewhere);
      const root = join(dir, 'root');
      await fs.mkdir(root);
      await fs.symlink(elsewhere, join(root, 'sub'));

      // Compared against the *real* path of the symlink target: on macOS the
      // temp dir is itself reached through `/var` -> `/private/var`, and the ACL
      // only ever compares two realpaths, so the test has to as well.
      const nearest = await realpathNearest(join(root, 'sub', 'new.txt'));
      assert.equal(nearest.realPath, join(await fs.realpath(elsewhere), 'new.txt'));
      assert.equal(nearest.existed, false);
    });
  });

  it('reports a leaf that exists', async () => {
    await withTempDir(async (dir) => {
      const real = await fs.realpath(dir);
      await fs.writeFile(join(real, 'f'), 'x');
      const nearest = await realpathNearest(join(real, 'f'));
      assert.equal(nearest.existed, true);
      assert.equal(nearest.realPath, join(real, 'f'));
    });
  });
});

describe('ArtifactAcl', () => {
  it('refuses a root that does not exist', async () => {
    await withTempDir(async (dir) => {
      await assert.rejects(() => ArtifactAcl.open(join(dir, 'absent')), (e: unknown) => {
        assert.ok(e instanceof ArtifactAclError);
        assert.equal(e.violation, 'root_missing');
        return true;
      });
    });
  });

  it('derives object paths from the digest, never from the caller', async () => {
    await withTempDir(async (dir) => {
      const acl = await ArtifactAcl.open(dir);
      const path = acl.objectPath(D);
      assert.equal(path, join(acl.realRoot, 'objects', D.slice(0, 2), D));
      // The fan-out is derived, so a digest cannot steer it.
      assert.equal(acl.objectPath(D).includes('..'), false);
    });
  });

  it('refuses a malformed digest before building a path', async () => {
    await withTempDir(async (dir) => {
      const acl = await ArtifactAcl.open(dir);
      for (const bad of ['', 'x', D.slice(0, 63), D.toUpperCase()]) {
        assert.throws(
          () => acl.objectPath(bad),
          (e: unknown) => e instanceof ArtifactAclError && e.violation === 'malformed_digest',
        );
        assert.throws(() => acl.aliasPath(bad), ArtifactAclError);
      }
    });
  });

  it('authorises a path inside the root and refuses one outside', async () => {
    await withTempDir(async (dir) => {
      const acl = await ArtifactAcl.open(dir);
      const inside = join(acl.realRoot, 'objects', 'aa', D);
      const ok = await acl.authorize(inside, `artifact://file/${D}`, false);
      assert.equal(ok.realPath, inside);

      await assert.rejects(
        () => acl.authorize('/etc/passwd', 'artifact://file/x', true),
        (e: unknown) => e instanceof ArtifactAclError && e.violation === 'outside_root',
      );
    });
  });

  it('refuses a not_found when existence is required', async () => {
    await withTempDir(async (dir) => {
      const acl = await ArtifactAcl.open(dir);
      const missing = join(acl.realRoot, 'objects', 'aa', D);
      await assert.rejects(
        () => acl.authorize(missing, `artifact://file/${D}`, true),
        (e: unknown) => e instanceof ArtifactAclError && e.violation === 'not_found',
      );
      // A write target does not exist yet, and that is not an error.
      assert.equal((await acl.authorize(missing, `artifact://file/${D}`, false)).existed, false);
    });
  });

  it('refuses a symlinked leaf that points outside the root', async () => {
    await withTempDir(async (dir) => {
      const secretDir = await fs.mkdtemp(join(dir, 'outside-'));
      await fs.writeFile(join(secretDir, 'loot'), 'credentials');
      const root = join(dir, 'root');
      await fs.mkdir(root);
      await fs.symlink(join(secretDir, 'loot'), join(root, 'link'));

      const acl = await ArtifactAcl.open(root);
      // A string check cannot see this one: the candidate is inside the root.
      assert.equal(contains(acl.realRoot, join(acl.realRoot, 'link')), true);
      await assert.rejects(
        () => acl.authorize(join(acl.realRoot, 'link'), 'artifact://file/named/link', true),
        (e: unknown) => e instanceof ArtifactAclError && e.violation === 'symlink_escape',
      );
    });
  });

  it('refuses a symlinked ancestor directory', async () => {
    await withTempDir(async (dir) => {
      const elsewhere = join(dir, 'elsewhere');
      await fs.mkdir(elsewhere);
      await fs.writeFile(join(elsewhere, 'loot'), 'credentials');
      const root = join(dir, 'root');
      await fs.mkdir(root);
      // The escape is in the middle of the path, not at the leaf.
      await fs.symlink(elsewhere, join(root, 'sub'));

      const acl = await ArtifactAcl.open(root);
      await assert.rejects(
        () => acl.authorize(join(acl.realRoot, 'sub', 'loot'), 'artifact://file/named/sub/loot', true),
        (e: unknown) => e instanceof ArtifactAclError && e.violation === 'symlink_escape',
      );
    });
  });

  it('refuses a relative path that walks out of the root', async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, 'root');
      await fs.mkdir(root);
      const acl = await ArtifactAcl.open(root);
      await assert.rejects(
        () => acl.authorize(join(acl.realRoot, '..', '..', 'etc', 'passwd'), 'artifact://file/named/x', true),
        (e: unknown) => e instanceof ArtifactAclError && e.violation === 'outside_root',
      );
    });
  });

  it('builds a named path inside named/<bucket>', async () => {
    await withTempDir(async (dir) => {
      const acl = await ArtifactAcl.open(dir);
      const parsed = parseArtifactUri('artifact://log/named/2026/run.jsonl');
      const path = acl.namedPath(parsed);
      assert.equal(path, join(acl.realRoot, 'named', 'log', '2026', 'run.jsonl'));
      assert.equal(contains(acl.realRoot, path), true);
    });
  });

  it('refuses an audit file name that is not a plain segment', async () => {
    await withTempDir(async (dir) => {
      const acl = await ArtifactAcl.open(dir);
      assert.equal(acl.auditPath('purge-log.jsonl'), join(acl.realRoot, 'audit', 'purge-log.jsonl'));
      for (const bad of ['../x', 'a/b', '.', '..', '', 'a\0b']) {
        assert.throws(() => acl.auditPath(bad), ArtifactAclError, `accepted ${JSON.stringify(bad)}`);
      }
    });
  });
});

describe('the error carries enough to act on', () => {
  it('names the violation, the uri, and the path it resolved to', () => {
    const e = new ArtifactAclError('symlink_escape', 'artifact://file/named/x', '/etc/shadow');
    assert.equal(e.violation, 'symlink_escape');
    assert.equal(e.uri, 'artifact://file/named/x');
    assert.match(e.message, /symlink_escape/);
    assert.match(e.message, /\/etc\/shadow/);
  });

  it('does not require a detail', () => {
    const e = new ArtifactAclError('bad_scheme', 'file:///etc/passwd');
    assert.match(e.message, /bad_scheme/);
  });
});
