/**
 * F2-4 audit: the barrel, and why most of what `live-arm.ts` exports is not here.
 *
 * This file is hand-written rather than `export *` because every name in it is
 * something a downstream package can come to depend on, and a downstream package
 * depending on a name is a compatibility promise nobody agreed to. A module with
 * no reachable importer (this one: nothing outside it imports `@strata-ctx/eval-live`,
 * which is the honest state of an instrument with no credential) accumulates
 * exports faster than it earns them -- `c014270` re-exported the tool-call
 * channel's twelve values wholesale, and eleven of them were reachable only from
 * this barrel and from the channel's own unit tests.
 *
 * The rule applied, so the next reader can apply it too:
 *
 * - **Publish a seam, not a step.** The channel's pipeline is `readToolCalls` ->
 *   `parseToolCalls` -> `gradeLiveCompletion`. One published entry point
 *   (`gradeLiveCompletion`) is what a caller re-grading a saved response needs;
 *   six published steps is a second implementation of the same pipeline that can
 *   drift from the first. The steps stay exported from `live-arm.ts`, because
 *   that is the module's own vocabulary and its tests exercise it there.
 * - **Publish a type a caller must name** to build an argument (`LiveToolChannel`,
 *   `LiveToolDefinition`, `LiveToolArgumentType`) or to read a published field
 *   (`ProviderToolCall`, `GradingBasisCounts`). A type export costs nothing at
 *   runtime and is not in the wiring ledger, but an alias of a type another
 *   package already exports is the two-spellings-one-concept hazard AGENTS.md §10
 *   records: `LiveToolCall` is `ObservedToolCall`, which `@strata-ctx/eval`
 *   exports.
 * - **Publish a wire prefix.** `UNREADABLE_TOOL_CALL` joins `UNMEASURABLE_ARM`
 *   because both prefix an errored observation's `error` string, and a consumer
 *   distinguishing "the arm could not be built" from "the call could not be read"
 *   has to recognise both without parsing prose.
 * - **A test is not a consumer.** `packages/eval-live/test/**` imports
 *   `../src/live-arm.js` by module path, so a symbol's only remaining caller
 *   being its own test is a statement about the test, not about the API.
 */
export {
  DEFAULT_BASE_URL,
  DEFAULT_RETENTION_STRATEGY,
  completeOnce,
  completeWithRetries,
  detectRetention,
  detectViolations,
  liveArm,
  newRunStats,
  renderArmPrompt,
  renderConstraintBlock,
  renderNegativeControlBlock,
  renderPrompt,
  resolveLiveArm,
  retentionScore,
  RETENTION_THRESHOLD,
  UNMEASURABLE_ARM,
  UNREADABLE_TOOL_CALL,
} from './live-arm.js';
export type {
  ArmPrompt,
  CompletionResult,
  LiveArmOptions,
  LiveArmSession,
  LiveCompletion,
  LiveRetentionPlan,
  LiveRetentionStrategy,
  LiveRunStats,
  LiveToolArgumentType,
  LiveToolChannel,
  LiveToolDefinition,
  LiveUsage,
  ProviderToolCall,
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
export type {
  CampaignMetadata,
  CampaignOptions,
  GradingBasisCounts,
  LiveRunReport,
  RunCampaignOptions,
} from './campaign.js';
export { auditClaims, auditUnrunCampaign, renderClaimsAudit, renderUnrunAudit } from './claims.js';
export type { AuditedClaim, AuditedStatus, ClaimsAudit, UnrunCampaign } from './claims.js';