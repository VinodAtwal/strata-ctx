import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * I-2: the artifact store access-control layer.
 *
 * ## Why this module is the authority
 *
 * B-3 pointer-izes an oversized file read to `artifact://file/<sha256>` and puts
 * the same URI in `ctx.artifacts`. Anything that later *resolves* that URI -- the
 * gist engine, an MCP tool, a re-injection path -- is reading bytes back out of
 * the store, which is the one place in this product where "your context is
 * local" is a promise made about files on disk. So the URI is treated as
 * **attacker-controlled input**, not as an internal identifier:
 *
 * - it reaches us from model output (a gist's `artifacts[]`, `log_gist.raw_uri`),
 * - it reaches us from a repo the user just cloned (a project policy file, a
 *   hook config, a `.mcp.json`),
 * - it reaches us from any process that can talk to the local gateway.
 *
 * In all three cases the answer to "may this URI be resolved" is *no* until a
 * check has said yes, and the check lives here rather than in the store so that
 * every future caller inherits it.
 *
 * ## The one non-negotiable rule: verify containment AFTER resolution
 *
 * The obvious implementation -- check that the joined path starts with the root
 * -- is bypassable, and the bypass is not exotic. A store that contains
 *
 *     objects/ab/0f1e...        ->  symlink to /Users/victim/.ssh
 *
 * passes a string check (`.../strata-store/objects/ab/0f1e...` starts with the
 * root) and then `readFile` follows the link and hands the agent a private key.
 * Every check in this module is therefore ordered:
 *
 *   1. cheap, total rejection of the *shape* (scheme, charset, traversal, `~`,
 *      control bytes, encoding tricks) -- these need no I/O and cannot be
 *      defeated by a filesystem trick;
 *   2. a pre-resolution containment check as defence in depth;
 *   3. `realpath` of the target (or of its nearest existing ancestor) and a
 *      containment check on the *resolved* path.
 *
 * Step 3 is the one that actually holds, and it is why steps 1 and 2 exist only
 * to make the common attack cheap and to keep the error messages specific.
 *
 * ## Why the URI grammar is closed
 *
 * A closed grammar (fixed bucket vocabulary, one restricted segment charset, one
 * 64-hex digest form) means the only path components that can ever reach
 * `join()` are ones this file produced. Traversal is not "detected"; it is
 * unrepresentable. The charset is deliberately ASCII-only: rejecting `U+FF0E`
 * FULLWIDTH FULL STOP, non-ASCII lookalikes and NUL early is cheaper than
 * normalising them and hoping a downstream normaliser agrees with us.
 */

export const ARTIFACT_SCHEME = 'artifact://';

/**
 * The only bucket names that exist.
 *
 * A bucket is *metadata*, never a path component. If `artifact://objects/<x>`
 * could name a directory, the bucket itself becomes an attack surface for no
 * benefit -- the object path is derived from the digest, so the bucket is only
 * ever a label an operator reads.
 */
export const ARTIFACT_BUCKETS = ['file', 'transcript', 'log', 'patch', 'other'] as const;
export type ArtifactBucket = (typeof ARTIFACT_BUCKETS)[number];

/** Marks a URI whose single segment is a caller-chosen name rather than a digest. */
export const NAMED_PREFIX = 'named';

/** Exactly 64 lowercase hex. Deliberately narrow: no uppercase, no `sha256:` tag. */
const DIGEST = /^[0-9a-f]{64}$/;

/**
 * One path segment. `.` is inside the class and then rejected explicitly, so the
 * rejection carries a name an operator can act on instead of a generic charset
 * failure. Everything hostile is outside the class:
 *
 *   `/`  `\`  (segment split and Windows separator)
 *   `~`  (home expansion -- the store never expands it, and neither do we)
 *   `:`  (Windows drive letters, `file:`, and URI scheme smuggling)
 *   NUL  (truncation in every C-based syscall underneath)
 *   `%`  (encoding; already decoded, and a second decode is a different attack)
 *   space, quotes, control bytes, non-ASCII
 */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Long-segment cap. Not a security control -- containment is -- but a 4kB
 * segment is a way to turn a resolution failure into an `ENAMETOOLONG` crash
 * deep inside a request handler.
 */
const MAX_SEGMENT_LENGTH = 200;

/**
 * How many times a percent-encoding is peeled before the result is treated as
 * hostile. Two is enough to catch `%252e%252e` (double-encoded `..`); three is
 * the point at which this is a denial-of-service generator rather than an
 * attack, and the loop is bounded so it cannot be one.
 */
const MAX_DECODE_ROUNDS = 3;

export type AclViolation =
  | 'empty_uri'
  | 'bad_scheme'
  | 'control_character'
  | 'encoding_attack'
  | 'empty_segment'
  | 'traversal_segment'
  | 'illegal_segment'
  | 'unknown_bucket'
  | 'malformed_digest'
  | 'root_missing'
  | 'not_readable'
  | 'not_found'
  | 'outside_root'
  | 'symlink_escape';

export class ArtifactAclError extends Error {
  readonly violation: AclViolation;
  readonly uri: string;

  constructor(violation: AclViolation, uri: string, detail?: string) {
    super(
      `artifact ACL refused the uri (${violation})${detail === undefined ? '' : `: ${detail}`}`,
    );
    this.name = 'ArtifactAclError';
    this.violation = violation;
    this.uri = uri;
  }
}

const isHex64 = (s: string): boolean => DIGEST.test(s);

const errnoCode = (e: unknown): string | undefined =>
  typeof e === 'object' &&
  e !== null &&
  'code' in e &&
  typeof e.code === 'string'
    ? e.code
    : undefined;

// Control characters are exactly what this rejects: a NUL truncates a path at the
// syscall boundary on some platforms, and a newline in a URI is a log-injection
// primitive. The rule fires on the character class itself, which is the point.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface ParsedArtifactUri {
  readonly bucket: ArtifactBucket;
  /** Every path segment after the bucket, percent-decoding fully applied. */
  readonly segments: readonly string[];
  /**
   * True for `artifact://<bucket>/<64-hex>` (content-addressed), false for
   * `artifact://<bucket>/named/<...>`. A caller that only wants content
   * addresses can require `true` and thereby ignore the named surface entirely.
   */
  readonly contentAddressed: boolean;
}

/**
 * Percent-decode until stable, bounded.
 *
 * Decoding once and validating is the classic mistake: `%252e%252e%252f` decodes
 * to `%2e%2e%2f` on the first pass, which passes a charset check that permits
 * `%`, and is then decoded a second time by something further down the stack.
 * Peeling to a fixed point closes that, and the bound is what keeps a
 * pathological input from looping.
 */
function decodeFully(uri: string, original: string): string {
  let out = uri;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    if (!out.includes('%')) return out;
    let next: string;
    try {
      next = decodeURIComponent(out);
    } catch {
      // A malformed escape (`%zz`, a lone `%`) is an attempt, not a typo.
      throw new ArtifactAclError('encoding_attack', original, 'malformed percent-encoding');
    }
    if (next === out) return out;
    out = next;
  }
  throw new ArtifactAclError('encoding_attack', original, 'encoding nested too deeply');
}

/**
 * Parse and shape-check a URI. Pure and synchronous: no filesystem access, so it
 * is cheap enough to call in a hot loop and testable without a temp dir.
 *
 * Throws `ArtifactAclError`; never returns a partially-trusted value.
 */
export function parseArtifactUri(uri: string): ParsedArtifactUri {
  if (uri.trim() === '') throw new ArtifactAclError('empty_uri', uri);
  // A NUL byte truncates the path in every C library underneath us, so
  // `abc\0/../../etc/passwd` would be checked as `abc` and opened as
  // something else entirely. Reject before anything else looks at the string.
  if (CONTROL.test(uri)) throw new ArtifactAclError('control_character', uri);

  const schemeEnd = uri.indexOf('://');
  if (schemeEnd < 0 || uri.slice(0, schemeEnd).toLowerCase() !== 'artifact') {
    throw new ArtifactAclError('bad_scheme', uri);
  }

  const rawBody = uri.slice(schemeEnd + 3);
  if (rawBody.includes('#')) throw new ArtifactAclError('illegal_segment', uri, 'fragment');
  if (rawBody.includes('?')) throw new ArtifactAclError('illegal_segment', uri, 'query');

  const decoded = decodeFully(rawBody, uri);
  if (CONTROL.test(decoded)) throw new ArtifactAclError('control_character', uri);
  if (decoded.includes('%')) throw new ArtifactAclError('encoding_attack', uri, 'residual %');

  const parts = decoded.split('/');
  const bucket = parts[0] ?? '';
  if (!(ARTIFACT_BUCKETS as readonly string[]).includes(bucket)) {
    throw new ArtifactAclError('unknown_bucket', uri, bucket === '' ? '(empty)' : bucket);
  }

  const segments = parts.slice(1);
  for (const seg of segments) {
    if (seg === '') {
      // `artifact://file//etc/passwd` and a trailing slash both land here. An
      // empty segment is the one way to smuggle a `/` past a split.
      throw new ArtifactAclError('empty_segment', uri);
    }
    if (seg === '.' || seg === '..') throw new ArtifactAclError('traversal_segment', uri, seg);
    if (seg.length > MAX_SEGMENT_LENGTH) {
      throw new ArtifactAclError('illegal_segment', uri, 'segment too long');
    }
    if (!SEGMENT.test(seg)) throw new ArtifactAclError('illegal_segment', uri, seg);
  }

  const isNamed = segments.length > 0 && segments[0] === NAMED_PREFIX;
  if (isNamed) {
    const name = segments.slice(1);
    if (name.length === 0) throw new ArtifactAclError('empty_segment', uri, 'named with no name');
  } else if (segments.length === 1 && isHex64(segments[0] ?? '')) {
    return { bucket: bucket as ArtifactBucket, segments, contentAddressed: true };
  } else if (segments.length === 0) {
    throw new ArtifactAclError('empty_segment', uri);
  } else if (!isNamed) {
    // `named` is the only non-digest form. Anything else is a typo or an
    // attempt to reach a path this module does not generate.
    if (isHex64(segments[0] ?? '') || segments.length === 1) {
      throw new ArtifactAclError('malformed_digest', uri, segments[0] ?? '');
    }
    throw new ArtifactAclError('illegal_segment', uri, 'expected a digest or named/');
  }

  return { bucket: bucket as ArtifactBucket, segments, contentAddressed: false };
}

/**
 * Is `candidate` inside `root`?
 *
 * `relative` rather than `startsWith`: `/tmp/store-evil` starts with
 * `/tmp/store` and is not inside it. The empty result means the paths are the
 * same, which is also refused -- the store root itself is never a resolution
 * target, because reading a directory as a file fails and listing it as one
 * leaks the layout.
 *
 * Case sensitivity is a deliberate fail-closed choice: on a case-insensitive
 * volume (`/Users` vs `/users`) this returns false for a path that would
 * actually open. A false rejection is an error message; a false acceptance is
 * an escape.
 */
export function contains(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === '') return false;
  return !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

export interface NearestRealPath {
  /** `realpath` of the deepest existing ancestor, with the missing tail re-appended. */
  readonly realPath: string;
  /** True when the *whole* target already existed and was resolved. */
  readonly existed: boolean;
}

/**
 * `realpath` of a path that may not exist yet.
 *
 * The write path has to verify a destination before creating it, which means
 * resolving its parent; the read path needs the full target. Walking up to the
 * first existing ancestor covers both, and it is why a symlink in a *parent
 * directory* cannot be used to redirect a write.
 */
export async function realpathNearest(target: string): Promise<NearestRealPath> {
  let current = resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return { realPath: tail.length === 0 ? real : join(real, ...tail), existed: tail.length === 0 };
    } catch (e) {
      const code = errnoCode(e);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        // ELOOP (a symlink cycle) and EACCES are real answers too, just not
        // answers this function can turn into a path.
        throw new ArtifactAclError('not_readable', target, code ?? 'realpath failed');
      }
      const parent = resolve(current, '..');
      if (parent === current) {
        // Reached the filesystem root without finding anything that exists,
        // which means the store root itself is missing.
        return { realPath: resolve(target), existed: false };
      }
      tail.unshift(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

export interface ResolvedPath {
  /** The joined, pre-resolution path. Never returned to a caller as an answer. */
  readonly candidate: string;
  /** The post-`realpath` path. This is the one that is safe to open. */
  readonly realPath: string;
  readonly existed: boolean;
}

/**
 * The authority. Constructed with a root, resolves the root's *real* path once
 * and holds it, so every subsequent comparison is between two resolved paths.
 *
 * Holding the resolved root also fixes the macOS temp-dir trap: `os.tmpdir()`
 * returns `/var/folders/...` while `realpath` returns `/private/var/folders/...`,
 * so a `startsWith` check against the unresolved root rejects every legitimate
 * write (annoying) and a check against the unresolved target would accept a
 * symlinked root (fatal). Resolving both sides makes the two agree.
 */
export class ArtifactAcl {
  readonly root: string;
  private readonly rootReal: string;

  private constructor(root: string, rootReal: string) {
    this.root = root;
    this.rootReal = rootReal;
  }

  static async open(root: string): Promise<ArtifactAcl> {
    const absolute = resolve(root);
    let real: string;
    try {
      real = await fs.realpath(absolute);
    } catch {
      throw new ArtifactAclError('root_missing', absolute, 'store root does not exist');
    }
    return new ArtifactAcl(absolute, real);
  }

  /** For tests and for assertions that need the resolved root. */
  get realRoot(): string {
    return this.rootReal;
  }

  /**
   * Verify a candidate path and return the resolved one.
   *
   * `mustExist` is the only behavioural difference between the read and the
   * write path, and it is expressed here rather than by two functions so that
   * both get the identical post-resolution containment check.
   */
  async authorize(candidate: string, uri: string, mustExist: boolean): Promise<ResolvedPath> {
    const target = resolve(candidate);
    // Step 2: pre-resolution containment. Cheap, and it catches a `..` that
    // survived the shape check. It is *not* the control -- see the module
    // header -- it is a filter that keeps the specific error messages useful.
    if (!contains(this.rootReal, target)) {
      throw new ArtifactAclError('outside_root', uri, 'before resolution');
    }

    // Step 3: resolve, then verify. A symlink anywhere in the chain -- the leaf
    // or an ancestor -- lands outside the root here and nowhere earlier.
    const nearest = await realpathNearest(target);
    if (!contains(this.rootReal, nearest.realPath)) {
      throw new ArtifactAclError('symlink_escape', uri, nearest.realPath);
    }
    if (mustExist && !nearest.existed) {
      throw new ArtifactAclError('not_found', uri, nearest.realPath);
    }
    return { candidate: target, realPath: nearest.realPath, existed: nearest.existed };
  }

  /**
   * A content-addressed object path: `objects/<aa>/<rest>`.
   *
   * The two-character fan-out is a filesystem-hygiene measure (a single
   * directory with every artifact in it is unusable on most systems), and it is
   * derived from the digest rather than accepted from the caller, so it cannot
   * be steered.
   */
  objectPath(digest: string): string {
    if (!isHex64(digest)) throw new ArtifactAclError('malformed_digest', digest, 'not 64 hex chars');
    return join(this.rootReal, 'objects', digest.slice(0, 2), digest);
  }

  objectMetaPath(digest: string): string {
    return `${this.objectPath(digest)}.json`;
  }

  /** `aliases/<aa>/<digest>`: the pre-redaction digest, pointing at the stored one. */
  aliasPath(digest: string): string {
    if (!isHex64(digest)) throw new ArtifactAclError('malformed_digest', digest, 'not 64 hex chars');
    return join(this.rootReal, 'aliases', digest.slice(0, 2), digest);
  }

  /**
   * A named artifact: `named/<bucket>/<segments...>`.
   *
   * The bucket becomes a path component *here* because the whole point of the
   * named form is that a human-chosen name is the address. That makes the
   * segment charset load-bearing, which is why the parse happens before the
   * join and never after it.
   */
  namedPath(parsed: ParsedArtifactUri): string {
    const name = parsed.segments[0] === NAMED_PREFIX ? parsed.segments.slice(1) : parsed.segments;
    return join(this.rootReal, 'named', parsed.bucket, ...name);
  }

  auditPath(name: string): string {
    if (!SEGMENT.test(name) || name === '.' || name === '..') {
      throw new ArtifactAclError('illegal_segment', name, 'audit file name');
    }
    return join(this.rootReal, 'audit', name);
  }
}

/** True when the whole of `candidate` is a path this module would generate. */
export function isWellFormedDigest(s: string): boolean {
  return isHex64(s);
}
