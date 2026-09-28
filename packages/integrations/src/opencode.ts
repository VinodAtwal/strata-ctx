/**
 * E-9 — OpenCode: a governed tool provider, plus the plugin that holds the line.
 *
 * ## Why OpenCode is not "another profile"
 *
 * E-6 gave aider/cline/roo a config file and stopped there, and that was the
 * right call for them: none of the three exposes a tool-execution hook, so the
 * gateway is the only place a pin can be enforced and the profile's whole job is
 * to make sure the request goes there. OpenCode is different in a way that
 * matters. It has a real plugin surface with `tool.execute.before` and
 * `tool.execute.after`, which means we can sit *in* the loop, rewrite a tool
 * result in flight, and see every tool call the model makes. That is the
 * Claude Code / Gemini tier, and this module is the reason the guarantee
 * ordering puts OpenCode at `hook_enforced` rather than `transport_enforced`.
 *
 * Two outputs, in the shape of the adapters that already exist:
 *
 *   buildOpenCodeProfile() -> the `opencode.json` fragment: a provider pointed at
 *                             the strata loopback gateway, the strata MCP server
 *                             registered, the plugin and the rules file wired in.
 *   buildOpenCodePlugin()  -> the plugin itself, delegating every governance
 *                             decision to `buildHooks` from hook-builder.ts.
 *
 * ## Credentials are a plan, and OpenCode already has a plan mechanism
 *
 * A config fragment is a file, files get committed, and a key in a committed
 * file is a key in somebody's git history. So the provider entry never carries a
 * credential. It carries OpenCode's own variable reference, `{env:NAME}` -- a
 * *name*, resolved by OpenCode at startup, which this module is structurally
 * unable to fill in because it is never given one. `credentialPlan()` reports
 * which name must be exported; `missingEnvVars()` reports which are not set yet,
 * and both speak in names only. R7 is a design constraint here, not a review
 * rule: there is no code path from a secret to this module's output.
 *
 * ## The loopback rule is inherited, not restated
 *
 * `isLoopbackGatewayUrl` is imported from profiles.ts rather than reimplemented,
 * because a second copy of "what counts as the local gateway" is a second thing
 * that can be wrong. http-only, loopback host, no userinfo, no query, no
 * fragment. The token-shaped inputs (model id, provider id, MCP command, MCP
 * args, policy file) are checked with the same two tests profiles.ts applies,
 * because OpenCode builds a `command` array and a `baseURL` string out of them
 * and neither is passed through a shell -- but a value that *looks* like shell
 * input has no business in a generated file either.
 *
 * ## Pins are re-materialized, and that is the entire product
 *
 * The plugin holds no governance state of its own. Every `tool.execute.before`
 * calls `buildHooks`' `handlePreToolUse`, which runs `enforcePins` against the
 * immutable policy buffer and hands back a fresh pin set. There is nothing to
 * accumulate, therefore nothing to merge, therefore a gist that appends to the
 * pin set has nothing to append to: the set is recomputed from policy on every
 * single request and is byte-identical every time. `pinnedConstraints()` reads
 * the last materialization for inspection; it is a mirror, not a source.
 *
 * Redaction rides the same bundle. OpenCode's tools return strings (a `bash`
 * result is a bare output string), so the rewrite spec is `wholeResult: true`
 * and the walk covers the whole payload. Under `redaction: 'block'` a tool
 * result containing a credential is denied rather than scrubbed, because a tool
 * result is persisted to the session transcript and losing one turn is cheaper
 * than writing a key to disk.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ContextState, StrataPolicy } from '@strata-ctx/core-types';
import type { TelemetrySink } from '@strata-ctx/telemetry';

import {
  GUARANTEE_ORDER,
  rankGuarantee,
  type GovernanceGuaranteeTier,
} from './copilot.js';
import {
  buildHooks,
  DEFAULT_TIMEOUT_MS,
  HOOK_EVENTS,
  INSTRUCTION_BLOCK_END,
  INSTRUCTION_BLOCK_START,
  type AgentHookSpec,
  type HookBundle,
  type HookEvent,
  type HookReport,
  type HookRequest,
  type HookResultInput,
  type PostToolUseResult,
  type PreToolUseResult,
  type ResultRewriteSpec,
} from './hook-builder.js';
import { isLoopbackGatewayUrl, MCP_TOOLS } from './profiles.js';

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

export const OPENCODE_AGENT_ID = 'opencode';
export const OPENCODE_SURFACE = 'opencode-plugin';

/** The project-level config file. `opencode.jsonc` also exists; we emit `.json`. */
export const OPENCODE_CONFIG_FILE = 'opencode.json';

/** The schema the emitted fragment validates against. */
export const OPENCODE_CONFIG_SCHEMA = 'https://opencode.ai/config.json';

/** Auto-loaded by OpenCode at startup; this is where the plugin module lives. */
export const OPENCODE_PLUGIN_DIR = '.opencode/plugins';
export const OPENCODE_PLUGIN_FILE = 'strata-governed.js';

/** OpenCode's rules file, and therefore its system-instruction surface. */
export const OPENCODE_RULES_FILE = 'AGENTS.md';

export const OPENCODE_PROVIDER_ID = 'strata';
export const OPENCODE_PROVIDER_NPM = '@ai-sdk/openai-compatible';
export const OPENCODE_MCP_SERVER_NAME = 'strata-ctx';
export const OPENCODE_MCP_COMMAND = 'strata-ctx';
export const OPENCODE_GATEWAY_URL = 'http://127.0.0.1:8787';
export const OPENCODE_API_KEY_ENV = 'STRATA_PROXY_API_KEY';
export const OPENCODE_POLICY_FILE = './.strata/policy.yaml';
export const OPENCODE_DEFAULT_MODEL = 'gpt-4o';

/**
 * The strata-owned key in `opencode.json` that records which lifecycle hooks
 * are wired to the plugin.
 *
 * OpenCode has no hook *list* in its config -- enforcement happens inside the
 * plugin module, not in a declaration -- so this list is the audit record: it is
 * what `install()` reconciles, what `uninstall()` removes, and what a reader (or
 * `strata doctor`) can check to answer "is governance actually wired here?".
 * OpenCode ignores unknown keys in a config file, and this repo already relies on
 * that with the `x-strata-*` notice keys.
 */
export const OPENCODE_HOOKS_KEY = 'strataHooks';

/** The two keys `buildHooks` names on each entry of `OPENCODE_HOOKS_KEY`. */
export const OPENCODE_HOOK_EVENT_KEY = 'event';
export const OPENCODE_HOOK_COMMAND_KEY = 'command';

/**
 * OpenCode's built-in tools.
 *
 * These are OpenCode's names, not Claude Code's. A hook that matches nothing is
 * worse than no hook, because `install` reports success.
 */
export const OPENCODE_TOOLS = [
  'bash',
  'read',
  'write',
  'edit',
  'apply_patch',
  'grep',
  'glob',
  'lsp',
  'webfetch',
  'websearch',
  'todowrite',
  'question',
  'skill',
] as const;

export type OpenCodeTool = (typeof OPENCODE_TOOLS)[number];

/**
 * OpenCode's tools hand back a bare string (`bash` returns an output string,
 * `read` returns file contents), so the whole result is walked.
 */
export const OPENCODE_RESULT_REWRITE: ResultRewriteSpec = Object.freeze({
  stringPaths: Object.freeze([Object.freeze(['output'])]),
  wholeResult: true,
});

/** Substituted for a tool result refused under `redaction: 'block'`. */
export const OPENCODE_REDACTION_BLOCKED = '[strata:redaction-blocked]';

/** The heading the plugin pushes into a compaction context, and re-replaces. */
export const OPENCODE_GOVERNANCE_HEADER = '## Governance constraints (re-asserted by strata-ctx)';

// ---------------------------------------------------------------------------
// Governance label
// ---------------------------------------------------------------------------

/**
 * OpenCode has both halves of the strong guarantee: a tool-execution hook
 * surface, and a provider that must be pointed at the gateway for the request to
 * exist at all. So it belongs in the same tier as Claude Code and Gemini, and
 * strictly above the MCP-only Copilot path -- not because Copilot is weak, but
 * because this one is not.
 */
export const OPENCODE_GUARANTEE_TIER: GovernanceGuaranteeTier = 'hook_enforced';

export const OPENCODE_HEADLINE =
  'OpenCode: hook-enforced governance. The plugin re-pins and redacts on every tool call.';

export const OPENCODE_NOTICE =
  'strata-ctx on OpenCode is hook-enforced: the strata plugin intercepts every tool call, re-materializes the pinned constraint set on every request, and redacts credentials out of tool results before they reach the model.';

const OPENCODE_GUARANTEES: readonly string[] = Object.freeze([
  'The strata plugin is registered and loaded, so every OpenCode tool call passes through tool.execute.before and tool.execute.after.',
  'The pinned constraint set is re-materialized from the immutable policy buffer on every request, byte-identical, and is never merged with anything already in the context.',
  'A constraint that arrives damaged, reordered, or with text appended is detected against our own record of what was sent, and the damage is discarded rather than carried forward.',
  'Tool results are redacted in flight, so a credential produced by a command never reaches the model or the persisted session transcript.',
  'The model provider is pinned to the local strata gateway, so the outbound request is byte-enforced on the wire as well as in the prompt.',
  'Retrieval stays available through the strata MCP server (ctx_search, ctx_get_task, ctx_get_artifact, ctx_note, ctx_status, ctx_remember), so compaction remains reversible.',
]);

const OPENCODE_NOT_GUARANTEED: readonly string[] = Object.freeze([
  'Constraints still reach the model as text. The hook guarantees the bytes are present and unmodified on the way out; it cannot make a model obey them.',
  'The pre-apply byte-equality check only has something to compare against when the same session keeps its buffer; a fresh session on turn 1 has no prior send, so the check is vacuous there by design.',
  'Tool interception covers OpenCode\'s built-in tools and anything added by other plugins. A tool a third-party plugin registers under a name not in this spec passes through ungoverned.',
  'A user who deletes the plugin entry from opencode.json gets an ungoverned OpenCode that still looks configured, because the provider block survives independently of the plugin.',
  'A user who points the provider back at a provider endpoint directly gets no gateway guarantee, and this module cannot observe that it happened.',
  'The agent can still be asked to help route around the gateway. Nothing here can make a cooperating-model guarantee against a persuasive instruction.',
]);

/** Agents whose guarantee is strictly weaker than OpenCode's. */
export const OPENCODE_WEAKER_THAN: readonly string[] = Object.freeze([
  'aider',
  'cline',
  'roo',
  'continue',
  'copilot-api',
  'lm-studio',
  'openwebui',
  'github-copilot',
]);

/**
 * `hookEnforcement` and `transportByteEnforcement` are literal `true`s, the
 * mirror of copilot.ts's literal `false`s. The type makes the claim and the code
 * makes it true, so neither can drift from the other by accident.
 */
export interface OpenCodeGovernanceLabel {
  readonly agent: typeof OPENCODE_AGENT_ID;
  readonly surface: typeof OPENCODE_SURFACE;
  readonly tier: GovernanceGuaranteeTier;
  readonly rank: number;
  readonly headline: string;
  readonly advisory: false;
  /** Whether a constraint is carried as a control rather than as advice. */
  readonly pinEnforcement: 'enforced';
  readonly promptLayerGovernance: 'enforced-by-hook';
  readonly hookEnforcement: true;
  readonly transportByteEnforcement: true;
  /** Whether inbound damage to the pin set is detectable at all. */
  readonly detectsInboundCorruption: true;
  readonly weakerThan: readonly string[];
  readonly guarantees: readonly string[];
  readonly notGuaranteed: readonly string[];
  readonly statements: readonly string[];
  readonly notice: string;
  readonly text: string;
}

function bullet(lines: readonly string[]): string {
  return lines.map((line) => `- ${line}`).join('\n');
}

export function openCodeGovernanceLabel(): OpenCodeGovernanceLabel {
  const tier: GovernanceGuaranteeTier = OPENCODE_GUARANTEE_TIER;
  const statements = Object.freeze([...OPENCODE_GUARANTEES, ...OPENCODE_NOT_GUARANTEED]);
  const text = [
    OPENCODE_HEADLINE,
    '',
    `Tier: ${tier} (rank ${rankGuarantee(tier)} of ${GUARANTEE_ORDER.length - 1}).`,
    `Stronger than: ${OPENCODE_WEAKER_THAN.join(', ')}.`,
    '',
    'What this path DOES guarantee:',
    bullet(OPENCODE_GUARANTEES),
    '',
    'What this path does NOT guarantee:',
    bullet(OPENCODE_NOT_GUARANTEED),
  ].join('\n');

  return Object.freeze({
    agent: OPENCODE_AGENT_ID,
    surface: OPENCODE_SURFACE,
    tier,
    rank: rankGuarantee(tier),
    headline: OPENCODE_HEADLINE,
    advisory: false as const,
    pinEnforcement: 'enforced' as const,
    promptLayerGovernance: 'enforced-by-hook' as const,
    hookEnforcement: true as const,
    transportByteEnforcement: true as const,
    detectsInboundCorruption: true as const,
    weakerThan: OPENCODE_WEAKER_THAN,
    guarantees: OPENCODE_GUARANTEES,
    notGuaranteed: OPENCODE_NOT_GUARANTEED,
    statements,
    notice: OPENCODE_NOTICE,
    text,
  });
}

export interface OpenCodeGuaranteeComparison {
  readonly opencode: { readonly tier: GovernanceGuaranteeTier; readonly rank: number };
  readonly githubCopilot: { readonly tier: GovernanceGuaranteeTier; readonly rank: number };
  /** True when OpenCode's rank is strictly greater. */
  readonly strongerThanCopilot: boolean;
  /** How many tiers apart they are. Always positive. */
  readonly delta: number;
  readonly summary: string;
}

/**
 * The comparison E-7 asked for, computed from E-7's own vocabulary and E-7's own
 * label rather than from a second hard-coded pair of numbers.
 */
export function compareOpenCodeToCopilot(
  copilotTier: GovernanceGuaranteeTier,
): OpenCodeGuaranteeComparison {
  const opencodeRank = rankGuarantee(OPENCODE_GUARANTEE_TIER);
  const copilotRank = rankGuarantee(copilotTier);
  const delta = opencodeRank - copilotRank;
  return Object.freeze({
    opencode: Object.freeze({ tier: OPENCODE_GUARANTEE_TIER, rank: opencodeRank }),
    githubCopilot: Object.freeze({ tier: copilotTier, rank: copilotRank }),
    strongerThanCopilot: delta > 0,
    delta,
    summary: `opencode is ${OPENCODE_GUARANTEE_TIER} (rank ${opencodeRank}); github-copilot is ${copilotTier} (rank ${copilotRank}); opencode is ${delta} tier(s) stronger.`,
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Mirrors profiles.ts. No shell metacharacters, no whitespace, no quotes. */
const SHELL_UNSAFE = /[;&|`$<>\n\r\0\\()]/;
const WHITESPACE_OR_QUOTE = /[\s'"]/;

export class UnknownOpenCodeAgentError extends Error {
  readonly agent: string;

  constructor(agent: string) {
    super(`Unknown agent ${JSON.stringify(agent)}; this module integrates ${OPENCODE_AGENT_ID} only`);
    this.name = 'UnknownOpenCodeAgentError';
    this.agent = agent;
  }
}

export class OpenCodeConfigError extends Error {
  readonly field: string;

  constructor(field: string, detail: string) {
    super(`opencode config: ${field} ${detail}`);
    this.name = 'OpenCodeConfigError';
    this.field = field;
  }
}

/**
 * The CLI entry point. Throws rather than degrading: the whole point of this
 * module is that a profile which silently pointed at something other than the
 * gateway would be a governance failure, and a typo'd agent name must not
 * produce one that looks installed.
 */
export function openCodeAgentId(agent: string): typeof OPENCODE_AGENT_ID {
  if (typeof agent !== 'string' || agent.trim().toLowerCase() !== OPENCODE_AGENT_ID) {
    throw new UnknownOpenCodeAgentError(String(agent));
  }
  return OPENCODE_AGENT_ID;
}

function requireGatewayUrl(value: string): string {
  // profiles.ts owns the definition of "the local gateway"; this only applies it.
  if (!isLoopbackGatewayUrl(value)) {
    throw new OpenCodeConfigError(
      'gatewayUrl',
      `must be a loopback http:// URL without credentials, query or fragment, got ${JSON.stringify(value)}`,
    );
  }
  if (SHELL_UNSAFE.test(value) || WHITESPACE_OR_QUOTE.test(value)) {
    throw new OpenCodeConfigError('gatewayUrl', `must not contain shell metacharacters, got ${JSON.stringify(value)}`);
  }
  return value.replace(/\/+$/, '');
}

function requireEnvVarName(value: string): string {
  if (!ENV_VAR_NAME.test(value)) {
    throw new OpenCodeConfigError('apiKeyEnv', `must be a POSIX env var name, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requirePlainToken(value: string, field: string): string {
  if (value === '' || SHELL_UNSAFE.test(value) || WHITESPACE_OR_QUOTE.test(value)) {
    throw new OpenCodeConfigError(field, `must be a single shell-safe token, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** The provider id becomes an object key and a `provider/model` prefix. */
function requireIdentifier(value: string, field: string): string {
  const token = requirePlainToken(value, field);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(token)) {
    throw new OpenCodeConfigError(
      field,
      `must be a dotted/dashed identifier with no slash, got ${JSON.stringify(value)}`,
    );
  }
  return token;
}

/**
 * A display string is rendered in a model picker, so a space is legitimate here
 * in a way it is not in `requirePlainToken`. Everything else is held to the same
 * line: a metacharacter or a control character in a product name is either a
 * mistake or an attempt, and neither is worth rendering.
 */
function requireDisplayName(value: string, field: string): string {
  if (value.trim() === '' || SHELL_UNSAFE.test(value) || /['"\t]/.test(value)) {
    throw new OpenCodeConfigError(field, `must be a plain display string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requirePathLike(value: string, field: string): string {
  if (value.trim() === '' || SHELL_UNSAFE.test(value) || WHITESPACE_OR_QUOTE.test(value)) {
    throw new OpenCodeConfigError(field, `must be a plain path, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireRootDir(value: string): string {
  const trimmed = value.replace(/\/+$/, '');
  return trimmed === '' ? '.' : requirePathLike(trimmed, 'rootDir');
}

function requireTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 600_000) {
    throw new OpenCodeConfigError('timeoutMs', `must be an integer in 1..600000, got ${String(value)}`);
  }
  return value;
}

function resolveRootDir(rootDir: string | undefined): string {
  return requireRootDir(rootDir ?? process.cwd());
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Paths and spec
// ---------------------------------------------------------------------------

export interface OpenCodePaths {
  /** `opencode.json` in the project root. */
  readonly configPath: string;
  /** `AGENTS.md` in the project root: the instruction surface. */
  readonly rulesPath: string;
  /** The plugin module inside `.opencode/plugins/`. */
  readonly pluginPath: string;
}

export interface OpenCodePathOptions {
  readonly rootDir?: string;
}

export function resolveOpenCodePaths(options: OpenCodePathOptions = {}): OpenCodePaths {
  const root = resolveRootDir(options.rootDir);
  return {
    configPath: join(root, OPENCODE_CONFIG_FILE),
    rulesPath: join(root, OPENCODE_RULES_FILE),
    pluginPath: join(root, OPENCODE_PLUGIN_DIR, OPENCODE_PLUGIN_FILE),
  };
}

export interface OpenCodeSpecOptions extends OpenCodePathOptions {
  /**
   * The identity `install()`/`uninstall()` use to recognise their own hook
   * entries. Defaults to the plugin module path, which is what the profile
   * writes into `strataHooks`, so the two cannot name different things.
   */
  readonly hookCommand?: string;
  readonly extraTools?: readonly string[];
  readonly timeoutMs?: number;
}

function resolvedHookCommand(paths: OpenCodePaths, options: OpenCodeSpecOptions): string {
  return options.hookCommand === undefined
    ? paths.pluginPath
    : requirePathLike(options.hookCommand, 'hookCommand');
}

/** The OpenCode facts, as an `AgentHookSpec` `buildHooks` can consume. */
export function openCodeHookSpec(options: OpenCodeSpecOptions = {}): AgentHookSpec {
  const paths = resolveOpenCodePaths(options);
  const tools = [...OPENCODE_TOOLS, ...(options.extraTools ?? [])];
  for (const tool of options.extraTools ?? []) {
    requirePlainToken(tool, 'extraTools');
  }
  return {
    agent: OPENCODE_AGENT_ID,
    hookCommand: resolvedHookCommand(paths, options),
    hooks: {
      kind: 'settings-json',
      path: paths.configPath,
      listKey: OPENCODE_HOOKS_KEY,
      eventKey: OPENCODE_HOOK_EVENT_KEY,
      commandKey: OPENCODE_HOOK_COMMAND_KEY,
    },
    instructions: {
      kind: 'markdown',
      path: paths.rulesPath,
      start: INSTRUCTION_BLOCK_START,
      end: INSTRUCTION_BLOCK_END,
    },
    tools,
    rewrite: OPENCODE_RESULT_REWRITE,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: requireTimeout(options.timeoutMs) }),
  };
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/**
 * How the credential reaches the agent. Names only, on purpose: this object is
 * the entire set of things a caller can learn about authentication from the
 * profile, and none of them is a value.
 */
export interface OpenCodeCredentialPlan {
  /** OpenCode resolves the reference itself at startup. */
  readonly source: 'env';
  /** The env var name that supplies the gateway credential. Never read. */
  readonly envVar: string;
  /** The literal written into the config, e.g. `{env:STRATA_PROXY_API_KEY}`. */
  readonly placeholder: string;
  /** Names that must be set before this profile works, sorted. */
  readonly required: readonly string[];
  readonly notes: readonly string[];
}

export interface OpenCodeMcpServerEntry {
  readonly type: 'local';
  /** argv[0] is the executable. An array, never a shell string. */
  readonly command: readonly string[];
  readonly enabled: true;
  readonly environment: Readonly<Record<string, string>>;
}

export interface OpenCodeProviderEntry {
  readonly npm: typeof OPENCODE_PROVIDER_NPM;
  readonly name: string;
  readonly options: {
    readonly baseURL: string;
    /** Always an `{env:NAME}` reference. This module cannot hold a value. */
    readonly apiKey: string;
  };
  readonly models: Readonly<Record<string, { readonly name: string }>>;
}

export interface OpenCodeHookDeclaration {
  readonly event: HookEvent;
  readonly command: string;
  readonly timeout: number;
}

export interface OpenCodeProfileDocument {
  readonly $schema: string;
  /** `provider/model`, the form OpenCode's picker expects. */
  readonly model: string;
  readonly provider: Readonly<Record<string, OpenCodeProviderEntry>>;
  readonly mcp: Readonly<Record<string, OpenCodeMcpServerEntry>>;
  readonly plugin: readonly string[];
  readonly instructions: readonly string[];
  /** See `OPENCODE_HOOKS_KEY`; the interface spells the literal. */
  readonly strataHooks: readonly OpenCodeHookDeclaration[];
  readonly 'x-strata-governance'?: string;
  readonly 'x-strata-guarantee-tier'?: GovernanceGuaranteeTier;
}

export interface OpenCodeProfileOptions extends OpenCodePathOptions {
  readonly gatewayUrl?: string;
  readonly apiKeyEnv?: string;
  /** Bare model id. `provider/model` is composed; a slash here is a mistake. */
  readonly model?: string;
  /** Display name in the picker. Defaults to the model id. */
  readonly modelName?: string;
  readonly providerId?: string;
  readonly providerName?: string;
  readonly mcpServerName?: string;
  readonly mcpCommand?: string;
  /** Extra argv for the MCP server, appended after `--gateway <url>`. */
  readonly mcpArgs?: readonly string[];
  readonly policyFile?: string;
  readonly timeoutMs?: number;
  /**
   * Emit the `x-strata-*` notice keys alongside the config. On by default: the
   * caveat travels with the file so nobody enables this path without reading it.
   */
  readonly includeGovernanceNotice?: boolean;
}

export interface OpenCodeProfile {
  readonly agent: typeof OPENCODE_AGENT_ID;
  readonly format: 'json';
  readonly fileName: string;
  readonly targetPath: string;
  readonly rulesPath: string;
  readonly pluginPath: string;
  /** The file body, trailing newline included. */
  readonly content: string;
  readonly document: OpenCodeProfileDocument;
  readonly gatewayUrl: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly qualifiedModel: string;
  readonly providerId: string;
  readonly mcpServerName: string;
  readonly mcpCommand: string;
  readonly mcpTools: readonly string[];
  readonly timeoutMs: number;
  readonly credential: OpenCodeCredentialPlan;
  /** Env var names that must be set before this profile can be used. */
  readonly requiredEnv: readonly string[];
  readonly governance: OpenCodeGovernanceLabel;
}

interface ResolvedProfile {
  readonly gatewayUrl: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly model: string;
  readonly modelName: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly mcpServerName: string;
  readonly mcpCommand: string;
  readonly mcpArgs: readonly string[];
  readonly policyFile: string;
  readonly timeoutMs: number;
  readonly rootDir: string;
  readonly hookCommand: string;
  readonly includeNotice: boolean;
}

function resolveProfile(options: OpenCodeProfileOptions): ResolvedProfile {
  const rootDir = resolveRootDir(options.rootDir);
  const paths = resolveOpenCodePaths({ rootDir });
  const gatewayUrl = requireGatewayUrl(options.gatewayUrl ?? OPENCODE_GATEWAY_URL);
  const mcpArgs = Object.freeze([...(options.mcpArgs ?? [])].map((arg) => requirePlainToken(arg, 'mcpArgs')));
  return {
    gatewayUrl,
    baseUrl: `${gatewayUrl}/v1`,
    apiKeyEnv: requireEnvVarName(options.apiKeyEnv ?? OPENCODE_API_KEY_ENV),
    model: requireIdentifier(options.model ?? OPENCODE_DEFAULT_MODEL, 'model'),
    modelName: requireDisplayName(options.modelName ?? options.model ?? OPENCODE_DEFAULT_MODEL, 'modelName'),
    providerId: requireIdentifier(options.providerId ?? OPENCODE_PROVIDER_ID, 'providerId'),
    providerName: requireDisplayName(options.providerName ?? 'strata-ctx gateway', 'providerName'),
    mcpServerName: requireIdentifier(options.mcpServerName ?? OPENCODE_MCP_SERVER_NAME, 'mcpServerName'),
    mcpCommand: requirePlainToken(options.mcpCommand ?? OPENCODE_MCP_COMMAND, 'mcpCommand'),
    mcpArgs,
    policyFile: requirePathLike(options.policyFile ?? OPENCODE_POLICY_FILE, 'policyFile'),
    timeoutMs: options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : requireTimeout(options.timeoutMs),
    rootDir,
    hookCommand: resolvedHookCommand(paths, options),
    includeNotice: options.includeGovernanceNotice ?? true,
  };
}

function mcpServerEntry(options: ResolvedProfile): OpenCodeMcpServerEntry {
  return {
    type: 'local',
    command: Object.freeze([
      options.mcpCommand,
      'mcp',
      'serve',
      '--gateway',
      options.gatewayUrl,
      ...options.mcpArgs,
    ]),
    enabled: true,
    environment: Object.freeze({
      STRATA_GATEWAY_URL: options.gatewayUrl,
      STRATA_POLICY_FILE: options.policyFile,
    }),
  };
}

function providerEntry(options: ResolvedProfile, placeholder: string): OpenCodeProviderEntry {
  return {
    npm: OPENCODE_PROVIDER_NPM,
    name: options.providerName,
    options: { baseURL: options.baseUrl, apiKey: placeholder },
    models: { [options.model]: { name: options.modelName } },
  };
}

function hookDeclarations(options: ResolvedProfile): readonly OpenCodeHookDeclaration[] {
  return Object.freeze(
    HOOK_EVENTS.map((event) => ({
      event,
      command: options.hookCommand,
      timeout: options.timeoutMs,
    })),
  );
}

function credentialPlan(options: ResolvedProfile): OpenCodeCredentialPlan {
  return {
    source: 'env',
    envVar: options.apiKeyEnv,
    placeholder: `{env:${options.apiKeyEnv}}`,
    required: [options.apiKeyEnv],
    notes: [
      'The provider apiKey is an OpenCode {env:NAME} reference, not a value.',
      'Export the named variable before starting OpenCode; this module never reads it.',
      'The gateway holds the upstream provider credential, not this file.',
    ],
  };
}

function relativeToRoot(rootDir: string, target: string): string {
  if (rootDir === '.') return target;
  return target.startsWith(`${rootDir}/`) ? target.slice(rootDir.length + 1) : target;
}

export function buildOpenCodeProfile(options: OpenCodeProfileOptions = {}): OpenCodeProfile {
  const resolved = resolveProfile(options);
  const paths = resolveOpenCodePaths({ rootDir: resolved.rootDir });
  const credential = credentialPlan(resolved);
  const governance = openCodeGovernanceLabel();
  const noticeKeys = resolved.includeNotice
    ? {
        'x-strata-governance': governance.notice,
        'x-strata-guarantee-tier': governance.tier,
      }
    : {};

  const document: OpenCodeProfileDocument = {
    $schema: OPENCODE_CONFIG_SCHEMA,
    model: `${resolved.providerId}/${resolved.model}`,
    provider: { [resolved.providerId]: providerEntry(resolved, credential.placeholder) },
    mcp: { [resolved.mcpServerName]: mcpServerEntry(resolved) },
    plugin: [relativeToRoot(resolved.rootDir, paths.pluginPath)],
    instructions: [relativeToRoot(resolved.rootDir, paths.rulesPath)],
    strataHooks: hookDeclarations(resolved),
    ...noticeKeys,
  };

  return Object.freeze({
    agent: OPENCODE_AGENT_ID,
    format: 'json' as const,
    fileName: OPENCODE_CONFIG_FILE,
    targetPath: paths.configPath,
    rulesPath: paths.rulesPath,
    pluginPath: paths.pluginPath,
    content: serialize(document),
    document,
    gatewayUrl: resolved.gatewayUrl,
    baseUrl: resolved.baseUrl,
    model: resolved.model,
    qualifiedModel: `${resolved.providerId}/${resolved.model}`,
    providerId: resolved.providerId,
    mcpServerName: resolved.mcpServerName,
    mcpCommand: resolved.mcpCommand,
    mcpTools: MCP_TOOLS,
    timeoutMs: resolved.timeoutMs,
    credential,
    requiredEnv: credential.required,
    governance,
  });
}

/**
 * Names only. A caller can tell the user what to export; a value can never reach
 * a log line through this function.
 */
export function missingEnvVars(
  profile: OpenCodeProfile,
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return profile.requiredEnv.filter((name) => {
    const value = env[name];
    return value === undefined || value.trim() === '';
  });
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/** The first argument of `tool.execute.before` / `tool.execute.after`. */
export interface OpenCodeToolCallInput {
  readonly tool: string;
  readonly sessionID: string;
  readonly callID: string;
}

export interface OpenCodeToolExecuteBeforeOutput {
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * `output` is mutable because redacting a tool result means replacing it: the
 * model must never see the bytes we refused to pass on.
 */
export interface OpenCodeToolExecuteAfterOutput {
  readonly title?: string;
  output: string;
  readonly metadata?: unknown;
}

export interface OpenCodeCompactingInput {
  readonly sessionID?: string;
}

export interface OpenCodeCompactingOutput {
  readonly context: string[];
  prompt?: string;
}

/** Exactly the hook names OpenCode dispatches, in the shape it dispatches them. */
export interface OpenCodePluginHooks {
  'tool.execute.before': (
    input: OpenCodeToolCallInput,
    output: OpenCodeToolExecuteBeforeOutput,
  ) => void;
  'tool.execute.after': (
    input: OpenCodeToolCallInput,
    output: OpenCodeToolExecuteAfterOutput,
  ) => void;
  'experimental.session.compacting': (
    input: OpenCodeCompactingInput,
    output: OpenCodeCompactingOutput,
  ) => void;
}

/** What one `materialize()` call produced. A report, not a source of truth. */
export interface OpenCodeMaterialization {
  readonly sessionId: string;
  readonly runId: string;
  readonly turn: number;
  readonly tool: string;
  readonly handled: boolean;
  readonly decision: 'allow' | 'block';
  /** The pin set as it went out, in policy order. */
  readonly pinned: readonly string[];
  /** The agent-shaped instruction text, byte-identical to `pinned`. */
  readonly instructions: string;
  readonly context?: ContextState;
  /** Pin-integrity defects observed against the previous send. */
  readonly defects: readonly string[];
  readonly problem?: PreToolUseResult['problem'];
}

export class StrataGovernanceError extends Error {
  readonly pinned: readonly string[];

  constructor(message: string, pinned: readonly string[]) {
    super(message);
    this.name = 'StrataGovernanceError';
    this.pinned = pinned;
  }
}

export interface OpenCodePluginOptions extends OpenCodeSpecOptions {
  readonly policy: StrataPolicy;
  readonly telemetrySink?: TelemetrySink;
  /**
   * Supplies the current context for a request, so the pin set can be
   * re-materialized over an existing buffer. Returning `undefined` is the normal
   * case: with no inbound context, `enforcePins` produces the policy set anyway.
   */
  readonly contextProvider?: (input: OpenCodeToolCallInput) => ContextState | undefined;
}

export class OpenCodePlugin {
  readonly #hooks: HookBundle;
  readonly #spec: AgentHookSpec;
  readonly #paths: OpenCodePaths;
  readonly #contextProvider: ((input: OpenCodeToolCallInput) => ContextState | undefined) | undefined;
  readonly #pluginHooks: OpenCodePluginHooks;
  /** Turn counter per session. OpenCode does not number turns for us. */
  readonly #turns = new Map<string, number>();
  /** The last pin set we sent, per session. A mirror of `enforcePins`. */
  readonly #pinned = new Map<string, readonly string[]>();
  /** The last `PostToolUseResult` per session, for tests and `strata doctor`. */
  readonly #lastResult = new Map<string, PostToolUseResult>();

  constructor(options: OpenCodePluginOptions) {
    this.#spec = openCodeHookSpec(options);
    this.#paths = resolveOpenCodePaths(options);
    this.#contextProvider = options.contextProvider;
    this.#hooks = buildHooks(this.#spec, {
      policy: options.policy,
      ...(options.telemetrySink === undefined ? {} : { telemetrySink: options.telemetrySink }),
    });
    this.#pluginHooks = {
      'tool.execute.before': (input, output) => {
        const materialization = this.materialize(input, output);
        if (materialization.decision === 'block') {
          throw new StrataGovernanceError(
            'strata-ctx blocked this tool call: the pinned governance constraints could not be materialised.',
            materialization.pinned,
          );
        }
      },
      'tool.execute.after': (input, output) => this.#applyRedaction(input, output),
      'experimental.session.compacting': (_input, output) => this.reassert(output),
    };
  }

  get agent(): string {
    return this.#hooks.agent;
  }

  get spec(): AgentHookSpec {
    return this.#spec;
  }

  /** The object an OpenCode plugin module would return. */
  get hooks(): OpenCodePluginHooks {
    return this.#pluginHooks;
  }

  get tier(): GovernanceGuaranteeTier {
    return OPENCODE_GUARANTEE_TIER;
  }

  get sessionCount(): number {
    return this.#hooks.sessionCount;
  }

  get paths(): OpenCodePaths {
    return this.#paths;
  }

  // -- the pre/post tool-use path -----------------------------------------

  /**
   * Re-materialize the pinned set for one tool call.
   *
   * Every call goes back to `enforcePins` against the immutable policy buffer, so
   * the result is byte-identical every time and structurally cannot accumulate.
   * The per-session record below is written for inspection only; it is never fed
   * back in, which is what makes "never merged" true rather than aspirational.
   */
  materialize(
    input: OpenCodeToolCallInput,
    output?: OpenCodeToolExecuteBeforeOutput,
  ): OpenCodeMaterialization {
    const turn = this.#nextTurn(input.sessionID);
    const state = this.#contextProvider?.(input);
    const request: HookRequest = {
      tool: input.tool,
      parameters: output?.args ?? {},
      sessionId: input.sessionID,
      runId: input.sessionID,
      turn,
      ...(state === undefined ? {} : { state }),
    };
    const result: PreToolUseResult = this.#hooks.handlePreToolUse(request);
    // Only a governed tool call materialises a pin set. An ungoverned tool name
    // sent nothing, so it must not clobber what the last governed call recorded.
    if (result.handled) this.#pinned.set(input.sessionID, result.pinned);
    return {
      sessionId: result.sessionId,
      runId: result.runId,
      turn: result.turn,
      tool: result.tool,
      handled: result.handled,
      decision: result.decision,
      pinned: result.pinned,
      instructions: result.instructions,
      ...(result.context === undefined ? {} : { context: result.context }),
      defects: result.defects,
      ...(result.problem === undefined ? {} : { problem: result.problem }),
    };
  }

  /**
   * Redact a tool result. Returns the builder's verdict so a caller can assert
   * on it; `tool.execute.after` folds the same call into `output.output`.
   */
  redact(input: OpenCodeToolCallInput, result: unknown): PostToolUseResult {
    const payload: HookResultInput = {
      tool: input.tool,
      sessionId: input.sessionID,
      runId: input.sessionID,
      turn: this.#turns.get(input.sessionID) ?? 0,
      result,
    };
    const out = this.#hooks.handlePostToolUse(payload);
    this.#lastResult.set(input.sessionID, out);
    return out;
  }

  #applyRedaction(input: OpenCodeToolCallInput, output: OpenCodeToolExecuteAfterOutput): void {
    const out = this.redact(input, output.output);
    if (out.decision === 'deny') {
      // Fail closed and say so: the caller gets a refusal string, never the bytes.
      output.output = OPENCODE_REDACTION_BLOCKED;
      return;
    }
    if (out.changed && typeof out.result === 'string') {
      output.output = out.result;
    }
  }

  /**
   * Post-compaction re-assertion (D-5). The block is replaced rather than
   * appended: a compaction that ran twice must not leave two copies of the same
   * constraint in the resumed context.
   */
  reassert(output: OpenCodeCompactingOutput): void {
    const lines = this.#hooks.instructionLines();
    if (lines.length === 0) return;
    const start = output.context.indexOf(OPENCODE_GOVERNANCE_HEADER);
    if (start !== -1) output.context.splice(start, output.context.length - start);
    output.context.push(OPENCODE_GOVERNANCE_HEADER, ...lines.map((text) => `- ${text}`));
  }

  // -- inspection ----------------------------------------------------------

  /** The last pin set materialised for a session. Names nothing, stores nothing. */
  pinnedConstraints(sessionId: string): readonly string[] {
    return this.#pinned.get(sessionId) ?? [];
  }

  /** The last `PostToolUseResult` for a session, or `undefined`. */
  redactionReport(sessionId: string): PostToolUseResult | undefined {
    return this.#lastResult.get(sessionId);
  }

  instructionLines(): readonly string[] {
    return this.#hooks.instructionLines();
  }

  renderInstructions(): string {
    return this.#hooks.renderInstructions();
  }

  handlesTool(tool: string): boolean {
    return this.#hooks.handlesTool(tool);
  }

  // -- file surfaces -------------------------------------------------------

  install(): HookReport {
    return this.#hooks.install();
  }

  uninstall(): HookReport {
    return this.#hooks.uninstall();
  }

  refreshInstructions(): HookReport {
    return this.#hooks.refreshInstructions();
  }

  removeInstructions(): HookReport {
    return this.#hooks.removeInstructions();
  }

  reset(sessionId?: string): void {
    this.#hooks.reset(sessionId);
    if (sessionId === undefined) {
      this.#turns.clear();
      this.#pinned.clear();
      this.#lastResult.clear();
      return;
    }
    this.#turns.delete(sessionId);
    this.#pinned.delete(sessionId);
    this.#lastResult.delete(sessionId);
  }

  #nextTurn(sessionId: string): number {
    const next = (this.#turns.get(sessionId) ?? 0) + 1;
    this.#turns.set(sessionId, next);
    return next;
  }
}

export function createOpenCodePlugin(options: OpenCodePluginOptions): OpenCodePlugin {
  return new OpenCodePlugin(options);
}

// ---------------------------------------------------------------------------
// Plugin module (the file OpenCode actually loads)
// ---------------------------------------------------------------------------

/**
 * The `export const StrataGoverned` an OpenCode plugin file provides.
 *
 * OpenCode constructs the plugin itself and hands us the context, so the module
 * is a thin adapter: it builds the plugin from the gateway environment and
 * returns its hooks. `strata-ctx` writes this file; nothing else imports it,
 * which is why it is a string rather than a second implementation.
 */
export function renderPluginModule(options: OpenCodePluginOptions): string {
  return [
    '// Generated by strata-ctx (E-9). Do not hand-edit; regenerate instead.',
    '//',
    '// Enforcement lives here, not in the config: OpenCode only guarantees that a',
    "// registered plugin's tool.execute.* hooks run. This file is that plugin.",
    "import { createOpenCodePlugin } from '@strata-ctx/integrations';",
    '',
    `const POLICY = ${JSON.stringify(options.policy, null, 2)};`,
    '',
    'export const StrataGoverned = async () => {',
    '  const plugin = createOpenCodePlugin({',
    '    policy: POLICY,',
    `    rootDir: ${JSON.stringify(resolveRootDir(options.rootDir))},`,
    '  });',
    '  return plugin.hooks;',
    '};',
    '',
  ].join('\n');
}

/** Where a globally-installed plugin would live, for `strata init --global`. */
export function globalOpenCodePluginPath(): string {
  return join(homedir(), '.config', 'opencode', 'plugins', OPENCODE_PLUGIN_FILE);
}

export type { AgentHookSpec, HookBundle, HookReport, HookRequest, HookResultInput, PostToolUseResult, PreToolUseResult, ResultRewriteSpec };
