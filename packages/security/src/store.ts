import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ArtifactRef } from '@strata-ctx/core-types';
import { sha256 } from '@strata-ctx/core-types';

import type { ArtifactBucket } from './acl.js';
import { ArtifactAcl, ArtifactAclError, parseArtifactUri } from './acl.js';
import type { AuditLog } from './audit.js';
import { AuditLog as Audit, AuditWriteError, PURGE_LOG_NAME } from './audit.js';
import type { RedactionOptions, RedactionResult, SecretKind } from './redact.js';
import { RedactionEngine, SecretLeakError } from './redact.js';

/**
 * I-2 + I-3: the content-addressed artifact store, and the write path that
 * makes "redact before you write" a property of the type rather than a habit.
 *
 * ## The layout
 *
 *     <root>/objects/<aa>/<sha256>            the stored bytes, addressed by their own digest
 *     <root>/objects/<aa>/<sha256>.json       sidecar: writtenAt, kind, redaction summary
 *     <root>/aliases/<aa>/<sha256>            pre-redaction digest -> stored digest
 *     <root>/named/<bucket>/<segments>        caller-named artifacts, ACL-validated
 *     <root>/audit/purge-log.jsonl            I-5 evidence
 *
 * Objects are addressed by the digest of the bytes that are *actually stored*,
 * which is the only addressing scheme that keeps "verify" meaningful: a
 * content-addressed store whose key is a digest of something else is a store
 * with a permanent, invisible integrity gap.
 *
 * ## I-3: the order, and why the alias exists
 *
 * Redaction happens first, so the digest is computed on redacted bytes and the
 * key of a file the agent has not read yet is not a digest of the secret it
 * replaced. That collides with B-3, which pointer-izes using
 * `sha256(originalText)` and publishes that URI in the transcript. Without help,
 * every redacted artifact would be unreachable by the pointer the transcript
 * already contains.
 *
 * So the store records the *inbound* digest as an alias for the stored one, and
 * resolution follows it. `read(pointerUri)` therefore keeps working, and it
 * reports `integrity: 'redacted'` rather than pretending the digests matched --
 * because a resolution that silently reported `exact` would be a lie the audit
 * trail could not correct. This is the interop contract with B-3: the ACL is
 * what authorises the URI, and the alias is what makes an already-published
 * pointer survive the redaction that protects the bytes behind it.
 *
 * ## What this class refuses
 *
 * - a write whose bytes still contain a certain-confidence secret, in any mode
 *   (`assertPersistable` is a persistence gate, not a mode);
 * - a write through a symlink, at the leaf (`O_EXCL`) or through a parent
 *   (`realpath` + containment in ./acl.ts);
 * - a read of a URI it did not mint, in any form the parser rejects;
 * - a binary artifact it would have to corrupt to redact -- refused, not mangled.
 *
 * ## Durability
 *
 * The file is `fsync`ed before the sidecar is written and the directory is
 * `fsync`ed before `put` returns. R12 makes "fsync-before-evict" a P0 concern
 * (an evict without a store write loses the user's evidence), and an
 * un-fsync'd write is that bug one crash later.
 */

export type ArtifactIntegrity =
  /** The requested digest is the digest of the stored bytes. */
  | 'exact'
  /**
   * The requested digest was the pre-redaction digest and an alias carried the
   * request to the stored object. Not a tamper: this is the B-3 pointer case.
   */
  | 'redacted'
  /** A named artifact. Nothing to compare; the name is the only integrity claim. */
  | 'named';

export interface ArtifactStat {
  readonly uri: string;
  readonly digest: string;
  readonly bytes: number;
  readonly kind: ArtifactRef['kind'];
  readonly writtenAt: number;
  /** True when the stored bytes differ from the bytes as they were submitted. */
  readonly redacted: boolean;
  readonly redactionKinds: readonly SecretKind[];
  /** Digest of the submitted bytes; present only when they differ. */
  readonly sourceDigest: string;
  readonly integrity: ArtifactIntegrity;
  /** Resolved, contained, and safe to read. Never a caller-supplied string. */
  readonly path: string;
}

export interface PutResult extends ArtifactRef {
  readonly writtenAt: number;
  readonly redacted: boolean;
  readonly redactionKinds: readonly SecretKind[];
  /** Set when the stored digest differs from the submitted digest. */
  readonly sourceDigest: string;
  /** True when the object was already present (content-addressed writes are idempotent). */
  readonly deduped: boolean;
}

export interface ReadResult {
  readonly text: string;
  readonly stat: ArtifactStat;
  readonly integrity: ArtifactIntegrity;
}

export type VerifyFailure = 'missing' | 'digest_mismatch' | 'unreadable' | 'dangling_alias';

export interface VerifyResult {
  readonly ok: boolean;
  readonly uri: string;
  readonly expected: string;
  readonly actual: string;
  readonly failure: VerifyFailure | undefined;
}

export interface ArtifactStoreOptions {
  readonly root: string;
  readonly redaction?: Partial<RedactionOptions>;
  readonly now?: () => number;
  /** Off in tests that measure throughput; on by default because R12. */
  readonly fsync?: boolean;
  readonly audit?: AuditLog;
}

const SIDECAR_VERSION = 1;

interface Sidecar {
  readonly v: number;
  readonly digest: string;
  readonly bytes: number;
  readonly kind: ArtifactRef['kind'];
  readonly writtenAt: number;
  readonly redacted: boolean;
  readonly redactionKinds: readonly SecretKind[];
  readonly sourceDigest: string;
}

const KIND_BUCKET: Readonly<Record<ArtifactRef['kind'], ArtifactBucket>> = {
  raw_transcript: 'transcript',
  tool_log: 'log',
  file_snapshot: 'file',
  patch: 'patch',
  other: 'other',
};

/**
 * The URI B-3 mints, byte for byte.
 *
 * Exported from here rather than re-derived in the pipeline so there is one
 * definition of the string both sides compare. B-3 pointer-izes a *file* read,
 * so its bucket is `file`, and `put(..., 'file_snapshot')` produces exactly this
 * shape -- which is what lets a published pointer resolve without a translation
 * step (see the alias discussion in the module header).
 */
export const artifactUriFor = (digest: string): string => `artifact://file/${digest}`;

/** Content-addressed URI for any artifact kind. The bucket is a label, not a path. */
export const uriFor = (kind: ArtifactRef['kind'], digest: string): string =>
  `artifact://${KIND_BUCKET[kind]}/${digest}`;

const emptySidecarKinds: readonly SecretKind[] = [];

/**
 * `fsync` a directory so a rename or a create inside it survives a crash.
 *
 * Best-effort by design and commented as such: on a platform that refuses to
 * open a directory for sync, failing the write would make the store unusable on
 * a filesystem that is in fact durable for this purpose. The refusal is by
 * `errno`, not by guess, so a genuine I/O failure still propagates.
 */
async function fsyncDir(dir: string): Promise<void> {
  let handle;
  try {
    handle = await fs.open(dir, 'r');
  } catch (e) {
    if (IGNORED_FSYNC_ERRORS.has(errnoOf(e) ?? '')) return;
    throw e;
  }
  try {
    await handle.sync();
  } catch (e) {
    if (!IGNORED_FSYNC_ERRORS.has(errnoOf(e) ?? '')) throw e;
  } finally {
    await handle.close();
  }
}

const IGNORED_FSYNC_ERRORS = new Set(['EISDIR', 'EPERM', 'EINVAL', 'EACCES', 'ENOTSUP', 'EBADF']);

const errnoOf = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string'
    ? e.code
    : undefined;

/**
 * Sidecars are written whole or not at all.
 *
 * A sidecar is a hint about the object next to it, not the object itself, so a
 * torn one is a GC-age inaccuracy rather than a data-loss event. The tmp+rename
 * is still the right shape: it is two lines, and it means a crash mid-write
 * leaves the previous complete sidecar rather than a half-parsed one that reads
 * as a corrupt store.
 */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, path);
}

export class ArtifactStore {
  readonly acl: ArtifactAcl;
  readonly audit: AuditLog;
  private readonly engine: RedactionEngine;
  private readonly now: () => number;
  private readonly doFsync: boolean;

  private constructor(acl: ArtifactAcl, options: ArtifactStoreOptions) {
    this.acl = acl;
    this.engine = new RedactionEngine(options.redaction ?? {});
    this.now = options.now ?? Date.now;
    this.doFsync = options.fsync ?? true;
    this.audit =
      options.audit ??
      // Conditional spread rather than `{ redaction: options.redaction }`:
      // `exactOptionalPropertyTypes` distinguishes "absent" from "present and
      // undefined", and an explicit `undefined` is not the same as absent.
      Audit.open(acl.realRoot, PURGE_LOG_NAME, {
        ...(options.redaction === undefined ? {} : { redaction: options.redaction }),
        now: this.now,
      });
  }

  static async open(options: ArtifactStoreOptions): Promise<ArtifactStore> {
    await fs.mkdir(join(options.root, 'objects'), { recursive: true });
    await fs.mkdir(join(options.root, 'aliases'), { recursive: true });
    await fs.mkdir(join(options.root, 'named'), { recursive: true });
    await fs.mkdir(join(options.root, 'audit'), { recursive: true });
    // `ArtifactAcl.open` resolves the root's real path, which is the value every
    // containment check compares against -- so the ACL is constructed after the
    // directories exist and never against a path that has moved.
    const acl = await ArtifactAcl.open(options.root);
    return new ArtifactStore(acl, options);
  }

  get root(): string {
    return this.acl.realRoot;
  }

  // ---------------------------------------------------------------- I-3 write

  /**
   * Store content. The only write path in the package.
   *
   * Order, and it is the order the task is about:
   *
   *   1. `redact`   -- before the bytes exist anywhere durable
   *   2. `digest`   -- of the *redacted* bytes
   *   3. `write`    -- O_EXCL, so a symlink at the leaf is not followed
   *   4. `verify`   -- re-read from disk and gate the bytes that actually landed
   *   5. `record`   -- audit, or the write is rolled back
   *
   * Redacting after the write, or verifying before it, both leave a window in
   * which a secret is on disk. There is no window here because the first thing
   * that touches `content` is a function whose only output is a string.
   */
  async put(
    content: string | Uint8Array,
    kind: ArtifactRef['kind'],
    options: { readonly at?: number } = {},
  ): Promise<PutResult> {
    const at = options.at ?? this.now();
    const inbound = typeof content === 'string' ? content : Buffer.from(content).toString('latin1');
    const binary = typeof content !== 'string';
    // A latin1 view of binary content is byte-faithful, so the gate below sees
    // every byte, and the placeholder substitution is skipped for binary input:
    // rewriting a PNG as text would corrupt it, and a corrupted artifact is
    // worse than a refused one because it is silent.
    const redaction: RedactionResult = binary
      ? { text: inbound, changed: false, findings: [] }
      : this.engine.redact(inbound);

    // Step 1 is complete; step 4 asserts the same property on the bytes that
    // reached the filesystem rather than on the ones we intended to write.
    this.engine.assertPersistable(redaction.text, `put(${kind})`);

    const bytes = binary
      ? // No cast needed: `binary` and the `content` branches agree, so the
        // narrowing survives.
        Buffer.from(content)
      : Buffer.from(redaction.text, 'utf8');
    const sourceDigest = sha256(inbound);
    const digest = sha256(redaction.text);
    const redacted = redaction.changed;
    const kinds = [...new Set(redaction.findings.map((f) => f.kind))].sort();

    const objectPath = this.acl.objectPath(digest);
    // Authorise the write destination: a symlinked parent directory would send
    // this file outside the store, and `O_EXCL` only protects the leaf.
    const auth = await this.acl.authorize(dirname(objectPath), digest, false);
    if (auth.realPath !== dirname(objectPath)) {
      // realpath differs from the literal path: a symlink is in the chain. The
      // post-resolution containment check in `authorize` already refused an
      // escape; this refuses the *ambiguity*, because a store whose own object
      // path resolves somewhere other than where it wrote is not verifiable.
      throw new ArtifactAclError('symlink_escape', digest, auth.realPath);
    }

    const existing = await this.exists(digest);
    if (!existing) {
      // The fan-out directory is derived from the digest, so it is this call's
      // job to create it. `mkdir` before the ACL check would be creating
      // directories for a path we have not authorised; the check is first.
      await fs.mkdir(dirname(objectPath), { recursive: true });
      const handle = await fs.open(objectPath, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        if (this.doFsync) await handle.sync();
      } finally {
        await handle.close();
      }
    }
    if (this.doFsync) await fsyncDir(dirname(objectPath));

    if (!existing) {
      const sidecar: Sidecar = {
        v: SIDECAR_VERSION,
        digest,
        bytes: bytes.byteLength,
        kind,
        writtenAt: at,
        redacted,
        redactionKinds: kinds,
        sourceDigest: redacted ? sourceDigest : '',
      };
      await writeJsonAtomic(`${objectPath}.json`, sidecar);
    }

    if (redacted) {
      // The B-3 interop alias, written *outside* the `!existing` branch on
      // purpose. Two different files can redact to the same stored bytes, and
      // the second one arrives here as a dedupe: its object and sidecar already
      // exist, but its own published pointer still has to resolve. Writing the
      // alias only for new objects left that pointer dangling for the rest of
      // the store's life, with nothing recording that it had ever been written.
      // Written only when redaction changed the bytes, so a store with nothing
      // to hide has no alias entries to GC.
      const aliasPath = this.acl.aliasPath(sourceDigest);
      await fs.mkdir(dirname(aliasPath), { recursive: true });
      await fs.writeFile(aliasPath, digest, { encoding: 'utf8', mode: 0o600 });
    }

    // Step 4: read the bytes back. The claim "the secret is not on disk" is only
    // worth anything if it was checked against the disk.
    const written = await fs.readFile(objectPath);
    this.engine.assertPersistable(written.toString('latin1'), `verify(${kind})`);

    const uri = uriFor(kind, digest);
    const record = {
      action: 'artifact_written' as const,
      target: uri,
      detail: redacted ? `redacted ${kinds.join(',')}` : kind,
      count: redaction.findings.length,
      bytes: bytes.byteLength,
      kinds,
    };
    try {
      await this.audit.append({ ...record, at });
    } catch (e) {
      // An artifact nobody can find out about is not data minimisation, it is
      // litter. Roll back rather than leave it.
      if (!existing) await fs.rm(objectPath, { force: true });
      throw e;
    }

    return {
      uri,
      sha256: digest,
      bytes: bytes.byteLength,
      kind,
      writtenAt: existing ? (await this.sidecar(digest))?.writtenAt ?? at : at,
      redacted,
      redactionKinds: kinds,
      sourceDigest: redacted ? sourceDigest : '',
      deduped: existing,
    };
  }

  /** Store content under a caller-chosen name. ACL-validated like every other path. */
  async putNamed(
    uri: string,
    content: string | Uint8Array,
    kind: ArtifactRef['kind'],
    options: { readonly at?: number } = {},
  ): Promise<PutResult> {
    const parsed = parseArtifactUri(uri);
    if (parsed.contentAddressed) {
      throw new ArtifactAclError('illegal_segment', uri, 'a digest address cannot be written by name');
    }
    const at = options.at ?? this.now();
    const target = this.acl.namedPath(parsed);
    const auth = await this.acl.authorize(target, uri, false);
    if (auth.realPath !== target) {
      throw new ArtifactAclError('symlink_escape', uri, auth.realPath);
    }

    const inbound = typeof content === 'string' ? content : Buffer.from(content).toString('latin1');
    const binary = typeof content !== 'string';
    const redaction = binary
      ? { text: inbound, changed: false, findings: [] }
      : this.engine.redact(inbound);
    this.engine.assertPersistable(redaction.text, `putNamed(${uri})`);

    const bytes = binary
      ? // Same narrowing note as `put`.
        Buffer.from(content)
      : Buffer.from(redaction.text, 'utf8');
    await fs.mkdir(dirname(target), { recursive: true });
    const handle = await fs.open(target, 'w', 0o600);
    try {
      await handle.writeFile(bytes);
      if (this.doFsync) await handle.sync();
    } finally {
      await handle.close();
    }
    if (this.doFsync) await fsyncDir(dirname(target));

    const written = await fs.readFile(target);
    this.engine.assertPersistable(written.toString('latin1'), `verify(${uri})`);

    const kinds = [...new Set(redaction.findings.map((f) => f.kind))].sort();
    const digest = sha256(redaction.text);
    await this.audit.append({
      at,
      action: 'artifact_written',
      target: uri,
      detail: redaction.changed ? `redacted ${kinds.join(',')}` : kind,
      count: redaction.findings.length,
      bytes: bytes.byteLength,
      kinds,
    });
    return {
      uri,
      sha256: digest,
      bytes: bytes.byteLength,
      kind,
      writtenAt: at,
      redacted: redaction.changed,
      redactionKinds: kinds,
      sourceDigest: redaction.changed ? sha256(inbound) : '',
      deduped: false,
    };
  }

  // ----------------------------------------------------------------- I-2 read

  /**
   * Resolve a URI to a contained, post-`realpath` path. Authorisation happens
   * here and nowhere else; a caller cannot obtain a store path by any other
   * route, which is what makes "the ACL authorises every resolution" a property
   * rather than a convention.
   *
   * Follows at most one alias hop: an alias pointing at another alias is a
   * cycle waiting to be built, and the loop bound is the defence.
   */
  async resolve(uri: string): Promise<{ path: string; stat: ArtifactStat; integrity: ArtifactIntegrity }> {
    const parsed = parseArtifactUri(uri);

    if (!parsed.contentAddressed) {
      const target = this.acl.namedPath(parsed);
      const auth = await this.acl.authorize(target, uri, true);
      const stat = await fs.stat(auth.realPath);
      return {
        path: auth.realPath,
        integrity: 'named',
        stat: {
          uri,
          digest: '',
          bytes: stat.size,
          kind: 'other',
          writtenAt: stat.mtimeMs,
          redacted: false,
          redactionKinds: emptySidecarKinds,
          sourceDigest: '',
          integrity: 'named',
          path: auth.realPath,
        },
      };
    }

    const requested = parsed.segments[0] ?? '';
    // `objectExists`, not `exists`: the first question `resolve` asks is "is
    // there an object under *this* digest", and `exists` answers the broader
    // "can this uri be read" by consulting the alias index. Asking the broad
    // question here and treating yes as a direct hit would send a published
    // alias straight back into `statFor` under the wrong digest.
    const direct = await this.objectExists(requested);
    if (direct) {
      const stat = await this.statFor(requested, 'exact', uri);
      return { path: this.acl.objectPath(requested), stat, integrity: 'exact' };
    }
    const alias = await this.aliasTarget(requested);
    if (alias !== undefined) {
      // Re-authorise the alias *target* as a digest rather than trusting the
      // file's contents: a hand-edited alias file naming `../..` or a digest
      // outside the store must fail the same check a URI would.
      if (!/^[0-9a-f]{64}$/.test(alias)) {
        throw new ArtifactAclError('malformed_digest', uri, 'alias target is not a digest');
      }
      if (!(await this.exists(alias))) {
        throw new ArtifactAclError('not_found', uri, 'dangling alias');
      }
      const stat = await this.statFor(alias, 'redacted', uri);
      return { path: this.acl.objectPath(alias), stat, integrity: 'redacted' };
    }

    throw new ArtifactAclError('not_found', uri, requested);
  }

  /**
   * `resolve`, with the refusal recorded.
   *
   * decisions R9 lists auth events among the records that must never age out,
   * and a denied artifact read is precisely that: the one event an operator
   * wants to see after the fact, because it is either a bug or an attack. The
   * audit write cannot be allowed to become the error the caller sees -- the
   * refusal is the answer either way -- so a failed append is swallowed here
   * and the ACL error propagates untouched.
   */
  private async resolveAudited(uri: string): ReturnType<ArtifactStore['resolve']> {
    try {
      return await this.resolve(uri);
    } catch (e) {
      if (e instanceof ArtifactAclError) {
        try {
          await this.audit.append({
            action: 'acl_denied',
            target: uri,
            detail: e.violation,
            count: 0,
            bytes: 0,
            kinds: [],
          });
        } catch {
          // The audit is unavailable. The read is still refused.
        }
      }
      throw e;
    }
  }

  async read(uri: string): Promise<ReadResult> {
    const resolved = await this.resolveAudited(uri);
    const text = (await fs.readFile(resolved.path)).toString('utf8');
    await this.audit.append({
      action: 'artifact_read',
      target: uri,
      detail: resolved.integrity,
      count: 1,
      bytes: text.length,
      kinds: [],
    });
    return { text, stat: resolved.stat, integrity: resolved.integrity };
  }

  /**
   * "Can this be read?"
   *
   * Deliberately the same question `resolve` answers, alias included. The two
   * used to disagree: `exists` looked only at the object, so a published B-3
   * URI -- which addresses the *pre-redaction* digest -- reported false while
   * `read` on it succeeded. A caller that gates on `exists` (gist validation,
   * the pointer rehydration path) would have refused a pointer that resolves.
   * One definition of "resolvable", used by both.
   */
  async exists(uriOrDigest: string): Promise<boolean> {
    if (uriOrDigest.startsWith('artifact://')) {
      const parsed = parseArtifactUri(uriOrDigest);
      if (!parsed.contentAddressed) {
        // The named form has no digest to test, so this is the same question
        // `resolve` asks: does the authorised named path exist? Answering it
        // here as "not a digest, so no" made every named artifact report as
        // missing while reading fine.
        try {
          const auth = await this.acl.authorize(this.acl.namedPath(parsed), uriOrDigest, true);
          return (await fs.stat(auth.realPath)).isFile();
        } catch {
          return false;
        }
      }
    }
    const digest = uriOrDigest.startsWith('artifact://') ? parseArtifactUri(uriOrDigest).segments[0] : uriOrDigest;
    if (digest === undefined || !/^[0-9a-f]{64}$/.test(digest)) return false;
    if (await this.objectExists(digest)) return true;
    // No object under this digest. It may still be a published alias, in which
    // case `read` will succeed and this must say so.
    const alias = await this.aliasTarget(digest);
    if (alias === undefined || !/^[0-9a-f]{64}$/.test(alias)) return false;
    return this.objectExists(alias);
  }

  /** Narrow: is there an object stored under exactly this digest? */
  private async objectExists(digest: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(digest)) return false;
    try {
      const auth = await this.acl.authorize(this.acl.objectPath(digest), digest, true);
      return (await fs.stat(auth.realPath)).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Recompute the digest of the stored bytes.
   *
   * This is the check that makes "content-addressed" a claim rather than a
   * naming convention, and it is separate from `read` so a caller can audit the
   * whole store without reading it all into memory.
   */
  async verify(uri: string): Promise<VerifyResult> {
    const digest = parseArtifactUri(uri).segments[0] ?? '';
    let stored = digest;
    if (!(await this.exists(digest))) {
      const alias = await this.aliasTarget(digest);
      if (alias === undefined) {
        return { ok: false, uri, expected: digest, actual: '', failure: 'missing' };
      }
      if (!/^[0-9a-f]{64}$/.test(alias)) {
        return { ok: false, uri, expected: stored, actual: alias, failure: 'dangling_alias' };
      }
      if (!(await this.exists(alias))) {
        return { ok: false, uri, expected: alias, actual: '', failure: 'dangling_alias' };
      }
      stored = alias;
    }
    try {
      const auth = await this.acl.authorize(this.acl.objectPath(stored), uri, true);
      const actual = sha256((await fs.readFile(auth.realPath)).toString('utf8'));
      if (actual !== stored) {
        return { ok: false, uri, expected: stored, actual, failure: 'digest_mismatch' };
      }
      return { ok: true, uri, expected: stored, actual, failure: undefined };
    } catch {
      // A refused path or an unreadable file: the store cannot prove the bytes,
      // so it must not claim that it can.
      return { ok: false, uri, expected: stored, actual: '', failure: 'unreadable' };
    }
  }

  async stat(uri: string): Promise<ArtifactStat | undefined> {
    try {
      const resolved = await this.resolve(uri);
      return resolved.stat;
    } catch (e) {
      if (e instanceof ArtifactAclError) return undefined;
      throw e;
    }
  }

  /** Every stored object, for the retention planner. Reads sidecars, not bytes. */
  async list(): Promise<readonly ArtifactStat[]> {
    const objectsRoot = join(this.root, 'objects');
    const out: ArtifactStat[] = [];
    let prefixes: string[];
    try {
      prefixes = (await fs.readdir(objectsRoot)).sort();
    } catch {
      return out;
    }
    for (const prefix of prefixes) {
      const dir = join(objectsRoot, prefix);
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries.sort()) {
        if (entry.endsWith('.json')) continue;
        const digest = entry;
        if (!/^[0-9a-f]{64}$/.test(digest)) continue;
        const sidecar = await this.sidecar(digest);
        out.push({
          uri: uriFor(sidecar?.kind ?? 'other', digest),
          digest,
          bytes: sidecar?.bytes ?? 0,
          kind: sidecar?.kind ?? 'other',
          writtenAt: sidecar?.writtenAt ?? 0,
          redacted: sidecar?.redacted ?? false,
          redactionKinds: sidecar?.redactionKinds ?? emptySidecarKinds,
          sourceDigest: sidecar?.sourceDigest ?? '',
          integrity: sidecar?.redacted === true ? 'redacted' : 'exact',
          path: this.acl.objectPath(digest),
        });
      }
    }
    return out;
  }

  /** Remove an artifact by URI. Aliases that point at it go with it. */
  async remove(uri: string): Promise<boolean> {
    let resolved: { stat: ArtifactStat };
    try {
      resolved = await this.resolveAudited(uri);
    } catch (e) {
      // A refusal here is a `false`, not an exception: "delete this" against a
      // uri the ACL will not authorise means nothing was deleted. The denial is
      // still recorded by `resolveAudited`.
      if (e instanceof ArtifactAclError) return false;
      throw e;
    }
    const { stat } = resolved;
    await fs.rm(stat.path, { force: true });
    await fs.rm(`${stat.path}.json`, { force: true });
    if (stat.sourceDigest !== '') {
      await fs.rm(this.acl.aliasPath(stat.sourceDigest), { force: true });
    }
    await this.audit.append({
      action: 'artifact_deleted',
      target: stat.uri,
      detail: `integrity=${stat.integrity}`,
      count: 1,
      bytes: stat.bytes,
      kinds: [],
    });
    return true;
  }

  /**
   * Remove every alias that points at `digest`, so nothing dangles.
   *
   * Walks the alias directory rather than the object list. The alias filename
   * *is* the pre-redaction digest, so the index is the directory; the object
   * list is the wrong place to look, and looking there meant this returned zero
   * in the only situation it is ever called -- after the object was removed, so
   * its sidecar no longer exists either.
   */
  async pruneAliases(digest: string): Promise<number> {
    let pruned = 0;
    const root = join(this.acl.realRoot, 'aliases');
    let fanouts: string[];
    try {
      fanouts = await fs.readdir(root);
    } catch {
      return 0; // No aliases have ever been written.
    }
    for (const fanout of fanouts) {
      if (!/^[0-9a-f]{2}$/.test(fanout)) continue;
      let entries: string[];
      try {
        entries = await fs.readdir(join(root, fanout));
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!/^[0-9a-f]{64}$/.test(entry)) continue;
        const aliasPath = join(root, fanout, entry);
        try {
          if ((await fs.readFile(aliasPath, 'utf8')).trim() === digest) {
            await fs.rm(aliasPath, { force: true });
            pruned += 1;
          }
        } catch {
          // Raced with another prune, or the alias was never written.
        }
      }
    }
    return pruned;
  }

  // -------------------------------------------------------------- internals

  private async sidecar(digest: string): Promise<Sidecar | undefined> {
    try {
      const raw = await fs.readFile(this.acl.objectMetaPath(digest), 'utf8');
      const parsed = JSON.parse(raw) as Sidecar;
      if (parsed.digest !== digest) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async statFor(digest: string, integrity: ArtifactIntegrity, uri: string): Promise<ArtifactStat> {
    const auth = await this.acl.authorize(this.acl.objectPath(digest), uri, true);
    const sidecar = await this.sidecar(digest);
    const size = (await fs.stat(auth.realPath)).size;
    return {
      uri: uriFor(sidecar?.kind ?? 'other', digest),
      digest,
      bytes: sidecar?.bytes ?? size,
      kind: sidecar?.kind ?? 'other',
      writtenAt: sidecar?.writtenAt ?? 0,
      redacted: sidecar?.redacted ?? false,
      redactionKinds: sidecar?.redactionKinds ?? emptySidecarKinds,
      sourceDigest: sidecar?.sourceDigest ?? '',
      integrity,
      path: auth.realPath,
    };
  }

  private async aliasTarget(sourceDigest: string): Promise<string | undefined> {
    try {
      const auth = await this.acl.authorize(this.acl.aliasPath(sourceDigest), sourceDigest, true);
      return (await fs.readFile(auth.realPath, 'utf8')).trim();
    } catch {
      return undefined;
    }
  }
}

export const bucketForKind = (kind: ArtifactRef['kind']): ArtifactBucket => KIND_BUCKET[kind];

/** Re-exported so a caller can fail with the right type without a second import. */
export { ArtifactAclError, SecretLeakError, AuditWriteError };
