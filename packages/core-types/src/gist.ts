import { z } from 'zod';

/**
 * Gist schema v1. See docs/architecture.md §6.
 *
 * The split that matters: fields marked DETERMINISTIC come from the tool-call
 * log and cost nothing to be certain about; the narrative fields come from the
 * agent's own turn (self-gist) or a local model. `constraints` is not a field
 * the compactor can write -- it is a byte-equality verification target, which is
 * what turns "the model dropped a safety rule" into a detectable condition.
 */

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected a 64-char lowercase hex digest');
const Line = z.string().min(1);

export const GistStatusSchema = z.enum(['complete', 'partial', 'blocked', 'abandoned']);
export type GistStatus = z.infer<typeof GistStatusSchema>;

export const GistChangedSchema = z.object({
  path: z.string().min(1),
  /** narrative */
  what: z.string(),
  /** narrative */
  why: z.string(),
  /** DETERMINISTIC. Required: a change without a content hash is unverifiable. */
  sha: Sha256,
});
export type GistChanged = z.infer<typeof GistChangedSchema>;

export const GistDecisionSchema = z.object({
  id: z.string().min(1),
  choice: z.string().min(1),
  why: z.string(),
  alternatives_rejected: z.array(Line).default([]),
});
export type GistDecision = z.infer<typeof GistDecisionSchema>;

export const GistArtifactSchema = z.object({
  uri: z.string().min(1),
  sha256: Sha256,
  bytes: z.number().int().nonnegative(),
});
export type GistArtifact = z.infer<typeof GistArtifactSchema>;

export const GistNextSchema = z.object({
  /** Forward-looking. This is the part generic summaries lose. */
  question: z.string(),
  next_command: z.string(),
  blockers: z.array(Line).default([]),
});
export type GistNext = z.infer<typeof GistNextSchema>;

export const GistLogSchema = z.object({
  ran: z.array(Line).default([]),
  failed: z.array(Line).default([]),
  /** Every ERROR/FATAL line survives compaction, always. */
  salient_errors: z.array(Line).default([]),
  salient_warnings: z.array(Line).default([]),
  dropped_count: z.number().int().nonnegative().default(0),
  /** Re-injectable pointer to the untruncated log. */
  raw_uri: z.string().min(1),
});
export type GistLog = z.infer<typeof GistLogSchema>;

export const GistVerificationSchema = z.object({
  tests_run: z.array(Line).default([]),
  status: z.enum(['untested', 'passing', 'failing', 'inconclusive']),
});
export type GistVerification = z.infer<typeof GistVerificationSchema>;

export const GistSchema = z.object({
  v: z.literal(1),
  task_id: z.string().min(1),
  status: GistStatusSchema,
  /** Forward and backward. */
  goal: z.string().min(1),

  /** DETERMINISTIC -- from the tool-call log. */
  changed: z.array(GistChangedSchema).default([]),
  current_values: z.record(z.string(), z.string()).default({}),

  /** narrative */
  decided: z.array(GistDecisionSchema).default([]),
  /** narrative -- the "scary one" must survive. */
  unresolved: z.array(Line).default([]),

  /** DETERMINISTIC. */
  artifacts: z.array(GistArtifactSchema).default([]),
  next: GistNextSchema,
  log_gist: GistLogSchema,
  verification: GistVerificationSchema.default({ status: 'untested' }),

  /**
   * NOT a writable field. Step 4c compares this byte-wise against the pin
   * buffer. Written by the gateway from policy, never parsed from model output.
   */
  constraints: z.array(Line),

  /** Enables re-injection; this is what makes compaction reversible. */
  source_turn_range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  /** Step 7 asserts this before evicting raw turns. */
  raw_recoverable: z.literal(true),
  compressed_by: z.enum(['self-gist', 'local-model', 'none']),
});
export type Gist = z.infer<typeof GistSchema>;

/**
 * SuperRefine encodes the transactional invariants that a field-by-field schema
 * cannot express. All of these are abort conditions for the compaction
 * transaction: on failure we keep the transcript and fail toward more context.
 */
export type GistDefect =
  | { readonly kind: 'turn_range_inverted'; readonly range: [number, number] }
  | { readonly kind: 'errors_not_retained'; readonly missing: number }
  | { readonly kind: 'unresolved_dropped' }
  | { readonly kind: 'raw_not_recoverable' };

export interface GistValidation {
  readonly ok: boolean;
  readonly gist?: Gist;
  readonly defects: readonly GistDefect[];
}

/** Parse and enforce the invariants, returning defects rather than throwing. */
export function validateGist(input: unknown, expectedErrorCount?: number): GistValidation {
  const parsed = GistSchema.safeParse(input);
  if (!parsed.success) return { ok: false, defects: [] };

  const g = parsed.data;
  const defects: GistDefect[] = [];

  const [from, to] = g.source_turn_range;
  if (to < from) defects.push({ kind: 'turn_range_inverted', range: g.source_turn_range });

  if (
    expectedErrorCount !== undefined &&
    g.log_gist.salient_errors.length < expectedErrorCount
  ) {
    defects.push({
      kind: 'errors_not_retained',
      missing: expectedErrorCount - g.log_gist.salient_errors.length,
    });
  }

  if (g.raw_recoverable !== true) defects.push({ kind: 'raw_not_recoverable' });

  return defects.length === 0 ? { ok: true, gist: g, defects: [] } : { ok: false, defects };
}

/**
 * The `log_gist.raw_uri` a draft carries while the transcript it names has not
 * been written.
 *
 * The frozen contract leaves no third place to put that fact: `raw_uri` is a
 * required non-empty string (above, `GistLogSchema`) and `raw_recoverable` is
 * `z.literal(true)` (above, `GistSchema`), so `false` is not a schema-valid
 * `Gist` at all. The marker says it in the URI instead.
 *
 * `unstored:` rather than `artifact://` because a marker must not be mistaken
 * for a pointer. The store parses `artifact://` URIs against a bucket
 * vocabulary and a 64-hex digest form, and every reader of a recovery claim --
 * `isResolvableArtifactUri`, a grep for `artifact://` in a transcript -- treats
 * one as bytes that exist. A synthetic `artifact://` URI wearing the costume of
 * a content address is how two producers in this repo shipped a recovery claim
 * that pointed at no object anywhere; a scheme no parser accepts cannot.
 */
export const RAW_URI_UNSTORED = 'unstored:raw-transcript';

/**
 * A `Gist` that has not been written to a store.
 *
 * Narrower than `Gist` in exactly one place: the recoverability claim may be
 * absent, and when present it is `true`. Optional rather than `boolean`
 * because a draft cannot assert `false` -- that value is not a `Gist` -- so the
 * only two states a builder can produce are "claims recovery" and "has not
 * earned it yet".
 *
 * This lives beside `GistSchema` rather than in the package that first needed
 * it because four packages produce one of these and none of them can reach the
 * others. `gist`, `integrations` and `governance` all import `core-types`, and
 * a definition that had to be copied into each of them is a definition that
 * will be corrected in three of the four.
 */
export const GistDraftSchema = GistSchema.extend({
  raw_recoverable: z.literal(true).optional(),
});
export type GistDraft = z.infer<typeof GistDraftSchema>;

/**
 * The one condition a draft can violate that a `Gist` cannot: a recoverability
 * claim with nothing behind it.
 *
 * `validateGist` cannot report it. `raw_uri` is a required non-empty string and
 * nothing in `GistSchema` knows what the marker means, so a gist claiming
 * recovery over an unstored transcript validates clean and an operator is never
 * told. That is not a safety hole -- eviction still refuses, because
 * `assessEvictable` asks whether the ACL can resolve the address before it
 * discards anything -- but "the gist does not satisfy the v1 schema" is not a
 * sentence anyone can act on, and this one is.
 */
export type GistDraftDefect = { readonly kind: 'raw_uri_unstored' };

export interface GistDraftValidation {
  readonly ok: boolean;
  readonly draft?: GistDraft;
  readonly defects: readonly GistDraftDefect[];
}

/**
 * Parse a draft and refuse the claim the bytes cannot back.
 *
 * Scope is deliberately one check. Every other invariant `validateGist` owns is
 * checked by the caller against the object the draft will become -- that is the
 * existing discipline (assembly.ts:369 stamps the earned claim and re-validates
 * rather than validating the incomplete draft), and duplicating the four
 * transactional invariants here would give two functions an answer that has to
 * be kept in step. What is added here is the one thing `validateGist` is
 * structurally unable to see, because `z.literal(true)` makes the failure
 * arrive as a bare schema rejection.
 *
 * The converse is not this function's job: a `raw_uri` outside the marker is
 * still checked for resolvability wherever the store is reachable, because only
 * the ACL knows the bucket vocabulary (`isResolvableArtifactUri`, which defers
 * to `parseArtifactUri` for exactly that reason).
 */
export function validateGistDraft(input: unknown): GistDraftValidation {
  const parsed = GistDraftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, defects: [] };

  const draft = parsed.data;
  const defects: GistDraftDefect[] = [];
  if (draft.raw_recoverable === true && draft.log_gist.raw_uri === RAW_URI_UNSTORED) {
    defects.push({ kind: 'raw_uri_unstored' });
  }

  return defects.length === 0 ? { ok: true, draft, defects: [] } : { ok: false, defects };
}
