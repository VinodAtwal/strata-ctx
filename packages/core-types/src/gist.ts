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
