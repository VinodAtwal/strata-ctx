/**
 * packages/security -- the local context firewall.
 *
 * ## What "firewall" means here
 *
 * Not a network egress filter. A firewall sits between trusted and untrusted
 * *network* traffic; this sits between the model and the user's context, and
 * the untrusted side is text the model itself produced, a gist that came back
 * from a tool, or a URI in a request body. The invariants have the same shape --
 * nothing crosses unchecked, and the check is the only way across -- but the
 * things being stopped are credential leaks, filesystem escapes, policy edits,
 * and evidence deletion rather than packets.
 *
 * ## The order the invariants are enforced in
 *
 * The module graph is a straight line, and the order is the design:
 *
 * ```
 *   patterns -+                     acl -------------> store --> audit   (I-4)
 *   entropy  -+-> redact (I-1,I-2) -+                    |
 *                                                          v
 *                                                      retention --> purge (I-5,I-7,I-8)
 *   locality (I-6)                 gist-safety (I-6)
 * ```
 *
 * `redact` has no dependency on the store, which is what makes I-3 checkable:
 * the store's `put` takes already-redacted text and hashes *that*, so a secret
 * cannot exist on disk even transiently, because the bytes that get written are
 * the bytes that were scanned. The ordering is carried by the type signature --
 * `put` takes `text: string`, not `data: unknown` -- rather than by convention,
 * so a caller cannot put a raw blob into the store through this API at all.
 *
 * ## What is deliberately not here
 *
 * - **Network code.** There is none, and `locality.ts` asserts it over this
 *    package's own sources. A security package that can open a socket is a
 *    package with an egress story it cannot keep.
 * - **A process-level guarantee.** These are library functions. The property
 *    that matters at runtime is that a caller cannot obtain a handle to a
 *    capability without passing the check that governs it, which is why every
 *    `ArtifactStore` method takes a URI and re-authorizes it rather than
 *    handing out a filesystem path.
 * - **The gateway.** The `/strata/purge` route is stream A's to own; `purge.ts`
 *    is the logic it calls, so the authorisation decisions are testable without
 *    binding a port.
 */

export { ARTIFACT_BUCKETS, ARTIFACT_SCHEME, NAMED_PREFIX, ArtifactAcl, ArtifactAclError, contains, isWellFormedDigest, parseArtifactUri, realpathNearest } from './acl.js';
export type { ArtifactBucket, AclViolation, NearestRealPath, ParsedArtifactUri, ResolvedPath } from './acl.js';

export { AuditLog, AuditWriteError, META_PURGE_LOG_NAME, PURGE_LOG_NAME, RETAIN_WORTHY_ACTIONS, isRetainWorthy } from './audit.js';
export type { AuditAction, AuditRecord, AuditRecordInput } from './audit.js';

export { DEFAULT_ENTROPY_KEYWORD_WINDOW, DEFAULT_ENTROPY_MIN_LENGTH, DEFAULT_ENTROPY_OPTIONS, DEFAULT_ENTROPY_THRESHOLD, analyzeEntropy, shannonEntropy } from './entropy.js';
export type { EntropyOptions, EntropyRejection, EntropyVerdict } from './entropy.js';

export { DEFAULT_REDACTION_OPTIONS, RedactionEngine, SecretBlockedError, SecretLeakError, assertCatalogueWellFormed, containsSecret, optionsFromPolicy, rankOf, redactDeep, redactText, redactionModeFromPolicy, resolveEntropyOptions, scanSecrets } from './redact.js';
export type { Confidence, RedactionFinding, RedactionMode, RedactionOptions, RedactionResult, SecretKind } from './redact.js';
export { SECRET_PATTERNS } from './patterns.js';
export {
  DESTRUCTIVE_RULES,
  assertDestructiveRulesWellFormed,
  commandSegments,
  extractTargets,
  invokes,
  scanDestructive,
} from './destructive.js';
export type {
  DestructiveFinding,
  DestructiveRule,
  DestructiveRuleId,
  DestructiveScan,
  DestructiveVerdict,
  ScanTarget,
} from './destructive.js';
export type { SecretPattern } from './patterns.js';
export type { ArtifactRef } from '@strata-ctx/core-types';

export { ArtifactStore, artifactUriFor, bucketForKind, uriFor } from './store.js';
export type { ArtifactIntegrity, ArtifactStat, PutResult, ReadResult, VerifyFailure, VerifyResult, ArtifactStoreOptions } from './store.js';

export { AdvisoryNotAcknowledgedError, DAY_MS, applyGc, assertPlanAcknowledged, expiresAt, isRetainWorthyAction, planGc, retentionClassOf, runGc, windowDaysFor } from './retention.js';
export type { GcAdvisory, GcBoundary, GcCandidate, GcOptions, GcPlan, GcReport, GcSkip, RetentionClass, SkipReason } from './retention.js';

export { META_PURGE_CONFIRMATION, PURGE_PATH, PURGE_SCOPES, digestOfAudit, handlePurgeRequest, metaPurge, parsePurgeRequest } from './purge.js';
export type { MetaPurgeReceipt, PurgeDeps, PurgeOutcome, PurgeRequest, PurgeResponse, PurgeScope, PurgeStatus } from './purge.js';

export { FORBIDDEN_BUILTINS, FORBIDDEN_GLOBALS, FORBIDDEN_PACKAGES, LOCALITY_STATEMENT, LocalityViolationError, assertLocalPackage, assertLocalSource, packageOfSpecifier, scanPackage, scanSource, stripComments, stripCommentsAndStrings } from './locality.js';
export type { LocalityReport, LocalityViolation, LocalityViolationKind } from './locality.js';

export { GistTrustError, assertGistTrustworthy, defendGist, gistArtifactUris } from './gist-safety.js';
export type { GistConstraintDefect, GistTrustOptions, GistTrustReport, GistViolation, GistViolationKind } from './gist-safety.js';
