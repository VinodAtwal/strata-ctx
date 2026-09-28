/**
 * @strata-ctx/integrations
 *
 * The agent-surface barrel. Several adapters legitimately declare the same
 * concept name (every hook builder has a `PreToolUseResult`; every profile
 * set has a `DEFAULT_MCP_COMMAND`), so the re-exports below are explicit
 * rather than `export *`. A star export would silently drop the loser's
 * binding; an explicit alias keeps both reachable and names the winner.
 *
 * Ownership of the contested names:
 * - `PreToolUseResult` / `PostToolUseResult` -> the generic builder (hook-builder)
 * - `ClaudeCodeHooks`                          -> the E-2 hooks surface
 * - `ClaudeCodeProxyHooks`                     -> the earlier interception surface
 * - `SELF_GIST_DIRECTIVE` / `GistDraft`        -> the template (B-8's parser agrees)
 * - `DEFAULT_MCP_COMMAND` / `DEFAULT_GATEWAY_URL` -> the profile registry
 * - `missingEnvVars`                           -> the profile registry
 */

// Clean surfaces — no contested names.
export * from './gemini.js';
export * from './mcp-server.js';
export * from './profiles.js';
export * from './templates.js';
export * from './claude-code-hooks.js';

// OpenCode — everything except the `missingEnvVars` the profile registry owns.
// Classes (value+type) go in the value export; pure types go in export type.
export {
  OPENCODE_AGENT_ID,
  OPENCODE_SURFACE,
  OPENCODE_CONFIG_FILE,
  OPENCODE_CONFIG_SCHEMA,
  OPENCODE_PLUGIN_DIR,
  OPENCODE_PLUGIN_FILE,
  OPENCODE_RULES_FILE,
  OPENCODE_PROVIDER_ID,
  OPENCODE_PROVIDER_NPM,
  OPENCODE_MCP_SERVER_NAME,
  OPENCODE_MCP_COMMAND,
  OPENCODE_GATEWAY_URL,
  OPENCODE_API_KEY_ENV,
  OPENCODE_POLICY_FILE,
  OPENCODE_DEFAULT_MODEL,
  OPENCODE_HOOKS_KEY,
  OPENCODE_HOOK_EVENT_KEY,
  OPENCODE_HOOK_COMMAND_KEY,
  OPENCODE_TOOLS,
  OPENCODE_RESULT_REWRITE,
  OPENCODE_REDACTION_BLOCKED,
  OPENCODE_GOVERNANCE_HEADER,
  OPENCODE_GUARANTEE_TIER,
  OPENCODE_HEADLINE,
  OPENCODE_NOTICE,
  OPENCODE_WEAKER_THAN,
  openCodeGovernanceLabel,
  compareOpenCodeToCopilot,
  UnknownOpenCodeAgentError,
  OpenCodeConfigError,
  openCodeAgentId,
  StrataGovernanceError,
  OpenCodePlugin,
  createOpenCodePlugin,
  renderPluginModule,
  globalOpenCodePluginPath,
  resolveOpenCodePaths,
  openCodeHookSpec,
  buildOpenCodeProfile,
} from './opencode.js';
export type {
  OpenCodeTool,
  OpenCodeGovernanceLabel,
  OpenCodeGuaranteeComparison,
  OpenCodePaths,
  OpenCodePathOptions,
  OpenCodeSpecOptions,
  OpenCodeCredentialPlan,
  OpenCodeMcpServerEntry,
  OpenCodeProviderEntry,
  OpenCodeHookDeclaration,
  OpenCodeProfileDocument,
  OpenCodeProfileOptions,
  OpenCodeProfile,
  OpenCodeToolCallInput,
  OpenCodeToolExecuteBeforeOutput,
  OpenCodeToolExecuteAfterOutput,
  OpenCodeCompactingInput,
  OpenCodeCompactingOutput,
  OpenCodePluginHooks,
  OpenCodeMaterialization,
  OpenCodePluginOptions,
} from './opencode.js';

// Generic hook builder: owns the Pre/PostToolUse result shapes.
export {
  HOOK_EVENTS,
  DEFAULT_TIMEOUT_MS,
  HOOK_BLOCK_START,
  HOOK_BLOCK_END,
  INSTRUCTION_BLOCK_START,
  INSTRUCTION_BLOCK_END,
  DEFAULT_RESULT_REWRITE,
  normalizeHookRequest,
  buildHooks,
  handlesTool,
} from './hook-builder.js';
export type {
  HookEvent,
  JsonHookSurface,
  MarkdownHookSurface,
  HookSurface,
  JsonInstructionSurface,
  MarkdownInstructionSurface,
  InstructionSurface,
  ResultRewriteSpec,
  AgentHookSpec,
  BuildHooksOptions,
  HookRequest,
  HookResultInput,
  HookRequestProblem,
  NormalizedRequest,
  HookAction,
  HookReportStatus,
  HookReport,
  HookBundle,
} from './hook-builder.js';

// Earlier Claude Code interception surface — aliased to stay distinct.
export {
  ClaudeCodeHooks as ClaudeCodeProxyHooks,
  createClaudeCodeHooks as createClaudeCodeProxyHooks,
} from './claude-code.js';
export type {
  ClaudeCodeHookConfig,
  HookDefinition,
  PreToolUseInput,
  PostToolUseInput,
  ToolCallContext,
  InterceptedTool,
  PinApplication,
  ClaudeCodeHooksOptions as ClaudeCodeProxyHooksOptions,
  PreToolUseResult as ProxyPreToolUseResult,
  PostToolUseResult as ProxyPostToolUseResult,
} from './claude-code.js';

// Observers — everything except the two names the template owns.
export {
  CLAUDE_HOOK_NAMES,
  GIST_SENTINEL,
  isClaudeHookEvent,
  buildGistDraft,
  assembleGist,
  verifyGistGovernance,
  createPreCompactObserver,
  appendUserIntent,
  expectedPins,
  missingPins,
  repin,
  createUserPromptSubmitObserver,
  buildSessionOpen,
  buildSessionClose,
  createSessionObserver,
  createClaudeHookRouter,
} from './claude-code-observers.js';
export type {
  ClaudeHookName,
  PreCompactTrigger,
  SessionStartReason,
  SessionEndReason,
  MaybePromise,
  HookHandler,
  PreCompactEvent,
  UserPromptSubmitEvent,
  SessionStartEvent,
  SessionUsage,
  SessionCounters,
  SessionEndEvent,
  SessionEvent,
  ClaudeHookEvent,
  HookFailure,
  HookErrorReporter,
  SelfGistNarrative,
  GistDraftSink,
  PreCompactObserverOptions,
  RepinnedContext,
  RepinSink,
  UserPromptSubmitObserverOptions,
  SessionOpenRecord,
  SessionCloseRecord,
  SessionTelemetrySink,
  SessionObserverOptions,
  HookObserver,
  HookDispatchReport,
  HookRouterOptions,
} from './claude-code-observers.js';

// Copilot — everything except the two defaults the profile registry owns.
export {
  COPILOT_AGENT_ID,
  COPILOT_SURFACE,
  DEFAULT_MCP_SERVER_NAME,
  DEFAULT_POLICY_FILE,
  COPILOT_MCP_JSON_PATH,
  COPILOT_VSCODE_SETTINGS_PATH,
  rankGuarantee,
  governanceLabel,
  buildCopilotMcpConfig,
  compareGuarantees,
  knownAgents,
} from './copilot.js';
export type {
  STRATA_MCP_TOOLS,
  StrataMcpTool,
  GUARANTEE_ORDER,
  GovernanceGuaranteeTier,
  GovernanceLabel,
  CopilotMcpServerConfig,
  CopilotMcpJsonFile,
  CopilotVsCodeSettingsSnippet,
  CopilotMcpConfigOptions,
  AgentGuarantees,
} from './copilot.js';