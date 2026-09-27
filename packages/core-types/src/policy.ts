import { z } from 'zod';

/**
 * Policy is the one place where a human states intent, so it is the one place
 * worth a runtime schema. Everything else in the pipeline is typed; this is
 * read from YAML/JSON off disk and is therefore untrusted input.
 */

export const ConstraintKindSchema = z.enum([
  'hard_safety',
  'soft_policy',
  'user_preference',
  'project_rule',
]);
export type ConstraintKind = z.infer<typeof ConstraintKindSchema>;

/**
 * `kind` is not decoration. Governance Decay found decay is 8.3x worse for soft
 * organizational policies than for hard safety norms, precisely because alignment
 * training holds the hard ones in place. An eval suite containing only
 * hard_safety constraints measures the priors, not the product.
 */
export const EnforcementSchema = z.enum(['block', 'rewrite', 'log']);
export type Enforcement = z.infer<typeof EnforcementSchema>;

export const PinnedConstraintSchema = z
  .object({
    id: z.string().min(1),
    // .trim() first: `min(1)` alone accepts "   ", and a whitespace-only
    // constraint can never be enforced or detected as missing. It would also
    // break the step-4c byte-equality check, since a gist round-trip could
    // normalise the whitespace and appear to disagree with policy.
    text: z.string().trim().min(1, 'an empty constraint can never be enforced or detected as missing'),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'expected a 64-char lowercase hex digest'),
    source: z.enum(['org_policy', 'project', 'user', 'detected']),
    kind: ConstraintKindSchema,
    enforcement: EnforcementSchema,
  })
  .strict();
export type PinnedConstraint = z.infer<typeof PinnedConstraintSchema>;

/** docs/architecture.md §5. `softTriggerFrac` defaults conservative on purpose. */
export const TriggerPolicySchema = z.object({
  strategy: z.enum(['sawtooth', 'monotonic']).default('sawtooth'),
  /** Lower for rot-sensitive agents. 0.6 is probably right for coding agents. */
  softTriggerFrac: z.number().gt(0).lt(1).default(0.85),
  /** Emergency structural eviction only. */
  hardTriggerFrac: z.number().gt(0).lt(1).default(0.95),
  /** Recency tail preserved verbatim. */
  keepRecentTokens: z.number().int().positive().default(8192),
  /** Headroom for the next tool result. */
  reserveTokens: z.number().int().positive().default(8192),
  /** Last user turn(s) preserved verbatim (command-window-loss mitigation). */
  userMessageTailTokens: z.number().int().positive().default(20_000),
  taskBoundarySignals: z
    .array(z.string().min(1))
    .default(['result_extracted', 'decision_superseded', 'before_large_read']),
});
export type TriggerPolicy = z.infer<typeof TriggerPolicySchema>;

export const RedactionPolicySchema = z.object({
  mode: z.enum(['off', 'log', 'block']).default('log'),
  onFail: z.enum(['forward', 'block']).default('forward'),
});
export type RedactionPolicy = z.infer<typeof RedactionPolicySchema>;

export const RetentionPolicySchema = z.object({
  rawTranscriptDays: z.number().int().positive().default(7),
  artifactDays: z.number().int().positive().default(30),
  /**
   * Deleting logs is not data minimization. A purge without a record of what was
   * purged is indistinguishable from a cover-up, and it destroys the only
   * evidence that lets a user audit what the agent did with their data.
   */
  keepPurgeLog: z.literal(true).default(true),
});
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

export const GovernancePolicySchema = z.object({
  /**
   * `off` is deliberately supported for debug only. With it off, the product's
   * central safety claim does not hold, and telemetry says so on every request.
   */
  pinning: z.enum(['required', 'off']).default('required'),
  autoPin: z.enum(['on', 'off']).default('on'),
  canaryIntervalTurns: z.number().int().positive().default(20),
});
export type GovernancePolicy = z.infer<typeof GovernancePolicySchema>;

export const StageNameSchema = z.enum([
  'dedupe',
  'truncate',
  'triage',
  'pin',
  'compact',
  'compress',
  'serialize',
]);
export type StageName = z.infer<typeof StageNameSchema>;

export const PipelinePolicySchema = z.object({
  /** Order is a safety property, not a preference. See docs/architecture.md §4. */
  stages: z
    .array(StageNameSchema)
    .default(['dedupe', 'truncate', 'triage', 'pin', 'compact', 'compress', 'serialize']),
  compaction: z.enum(['off', 'manual', 'auto']).default('off'),
  trigger: TriggerPolicySchema.default({}),
  /** Tier 3 local-model compression. Off by default; gated on >5k tokens. */
  tokenCompression: z.enum(['off', 'local']).default('off'),
  /** Thresholds per Tier, in bytes, before the truncate stage touches a block. */
  tierByteCaps: z
    .record(z.string(), z.number().int().positive())
    .default({ tool_state: 20_000, episodic: 40_000, artifact_ref: 8_000, user_intent: 60_000 }),
});
export type PipelinePolicy = z.infer<typeof PipelinePolicySchema>;

export const SerializationPolicySchema = z.object({
  /** Applies to machine-readable blocks only. Never reasoning prose. */
  machineFormat: z.enum(['passthrough', 'toon', 'csv']).default('passthrough'),
  verbosity: z.enum(['off', 'directive']).default('off'),
});
export type SerializationPolicy = z.infer<typeof SerializationPolicySchema>;

export const BudgetPolicySchema = z.object({
  contextLimit: z.number().int().positive().default(200_000),
  maxOutputTokens: z.number().int().positive().default(8192),
  /** Keep the steady-state footprint at a fraction of the window. */
  targetUtilization: z.number().gt(0).lt(1).default(0.7),
});
export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>;

export const StrataPolicySchema = z
  .object({
    version: z.literal(1),
    redaction: RedactionPolicySchema.default({}),
    retention: RetentionPolicySchema.default({}),
    governance: GovernancePolicySchema.default({}),
    pipeline: PipelinePolicySchema.default({}),
    serialization: SerializationPolicySchema.default({}),
    budgets: BudgetPolicySchema.default({}),
    /** The immutable pin buffer P. */
    constraints: z.array(PinnedConstraintSchema).default([]),
  })
  // .strict() is load-bearing. zod strips unknown keys by default, so a typo
  // like `token_compression: true` would be silently ignored and the operator
  // would believe a Tier 3 compressor was on when it was not. On a security
  // config, silence is the wrong failure mode.
  .strict();
export type StrataPolicy = z.infer<typeof StrataPolicySchema>;

export const DEFAULT_POLICY: StrataPolicy = StrataPolicySchema.parse({ version: 1 });

/**
 * The prompt-visible text of the pin buffer, in a deterministic order.
 *
 * `policyHash` is the digest of exactly this string, which is what makes the
 * step-4c check in the compaction transaction a byte-equality comparison rather
 * than a judgement call.
 */
export function pinSetText(policy: StrataPolicy): string[] {
  return [...policy.constraints]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => c.text);
}
