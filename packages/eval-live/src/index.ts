export {
  DEFAULT_BASE_URL,
  completeOnce,
  completeWithRetries,
  detectRetention,
  detectViolations,
  liveArm,
  newRunStats,
  renderConstraintBlock,
  renderNegativeControlBlock,
  renderPrompt,
  resolveLiveArm,
  retentionScore,
  RETENTION_THRESHOLD,
} from './live-arm.js';
export type {
  CompletionResult,
  LiveArmOptions,
  LiveCompletion,
  LiveRunStats,
  LiveUsage,
  ResolvedLiveArm,
} from './live-arm.js';
export {
  confidenceFor,
  EVALUATED_GATES,
  evaluateG1,
  evaluateG2,
  evaluateNonInferiority,
  GATES,
  G2_SCENARIO_FLOOR,
  MIN_CLAIM_OBSERVATIONS,
  unevaluatedGates,
} from './gates.js';
export type {
  Confidence,
  ConfidenceInput,
  GateInput,
  GateOutcome,
  GateSpec,
  GateStatus,
} from './gates.js';
export { DEFAULT_RETENTION_THRESHOLD, LIVE_ARMS, LIVE_CAVEATS, runCampaign, statsOf } from './campaign.js';
export type { CampaignMetadata, CampaignOptions, LiveRunReport, RunCampaignOptions } from './campaign.js';
export { auditClaims, renderClaimsAudit } from './claims.js';
export type { AuditedClaim, AuditedStatus, ClaimsAudit } from './claims.js';