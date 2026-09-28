/**
 * E-6 — Aider / Cline / Roo profiles and launch recipes.
 *
 * The invariant this module exists to hold: **every agent points at the strata
 * gateway, and nothing else.** A profile that lets the agent reach a provider
 * directly is not a degraded profile, it is a broken one — governance pinning
 * (WS-D) is only enforceable if every request crosses the proxy, and
 * docs/integrations.md is explicit that the proxy is the durable floor that
 * survives any extension-surface drift (R10).
 *
 * Two outputs, both pure and both deterministic:
 *   buildProfile(agent)  -> the config file body to write (YAML for aider, JSON
 *                           for cline/roo)
 *   launchRecipe(agent)  -> the exact argv to spawn, plus an env *plan*
 *
 * Credentials are handled as a plan, never as a value. The recipe names the
 * env var that supplies the child credential (`from`) but never reads it, never
 * inlines it into argv (it would be visible in `ps`), and never returns it
 * (R7: never log auth headers, ever). `missingEnvVars` reports names, so a
 * caller can tell the user what to export without anything sensitive crossing
 * the boundary.
 */

import YAML from 'yaml';

export const AGENT_IDS = ['aider', 'cline', 'roo'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8787';
export const DEFAULT_API_KEY_ENV = 'STRATA_PROXY_API_KEY';
export const DEFAULT_PRE_COMMIT_COMMAND = 'strata-ctx check-constraints';
export const DEFAULT_MCP_COMMAND = 'strata-ctx';
export const DEFAULT_MODEL = 'openai/gpt-4o';
export const DEFAULT_WEAK_MODEL = 'openai/gpt-4o-mini';
export const DEFAULT_EDITOR_MODEL = 'openai/gpt-4o';
export const DEFAULT_BRIDGE_HOST = '127.0.0.1';
export const DEFAULT_BRIDGE_PORT = 3945;

/** The tools the shared MCP server exposes (docs/integrations.md §5). */
export const MCP_TOOLS = [
  'ctx_search',
  'ctx_get_task',
  'ctx_get_artifact',
  'ctx_note',
  'ctx_status',
  'ctx_remember',
] as const;

export type ProfileFormat = 'yaml' | 'json';

export interface AiderProfileDocument {
  readonly model: string;
  readonly 'weak-model': string;
  readonly 'editor-model': string;
  readonly 'openai-api-base': string;
  /** Aider reads this as `pre-commit`; dotenv-style underscore aliases are not normalized. */
  readonly 'pre-commit': readonly string[];
}

export interface McpServerEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly disabled: boolean;
  readonly autoApprove: readonly string[];
}

export interface StrataProviderProfile {
  readonly id: string;
  readonly name: string;
  readonly provider: 'openai-compatible';
  readonly baseUrl: string;
  /** The gateway holds the real credential; the agent is handed a placeholder. */
  readonly apiKeyProvider: 'none';
  readonly apiKeyEnv: string;
  readonly model: string;
}

export interface ClineProfileDocument {
  readonly mcpServers: Readonly<Record<string, McpServerEntry>>;
  readonly strata: {
    readonly agent: AgentId;
    readonly gatewayUrl: string;
    readonly requireGateway: boolean;
    readonly openAiCompatibleProvider: StrataProviderProfile;
  };
}

export interface RooCustomMode {
  readonly slug: string;
  readonly name: string;
  readonly roleDefinition: string;
  readonly groups: readonly string[];
  readonly customInstructions: string;
  readonly whenToUse: string;
}

export interface RooProfileDocument {
  readonly strata: {
    readonly agent: AgentId;
    readonly gatewayUrl: string;
    readonly requireGateway: boolean;
    readonly providerProfile: StrataProviderProfile;
  };
  readonly customModes: readonly RooCustomMode[];
  readonly mcpServers: Readonly<Record<string, McpServerEntry>>;
}

export interface AgentProfile {
  readonly agent: AgentId;
  readonly format: ProfileFormat;
  readonly fileName: string;
  readonly targetPath: string;
  readonly content: string;
  readonly gatewayUrl: string;
  readonly model: string;
  /** Env var names that must be set before this profile can be used. */
  readonly requiredEnv: readonly string[];
}

export interface ProfileOptions {
  readonly gatewayUrl?: string;
  readonly apiKeyEnv?: string;
  readonly model?: string;
  readonly weakModel?: string;
  readonly editorModel?: string;
  readonly preCommitCommand?: string;
  readonly mcpCommand?: string;
  readonly rootDir?: string;
}

export interface LaunchOptions extends ProfileOptions {
  readonly host?: string;
  readonly port?: number;
}

export interface LaunchEnvPlan {
  /** Non-secret literals for the child process. */
  readonly fixed: Readonly<Record<string, string>>;
  /** Child env var -> the name of the parent env var that supplies it. Values are never inlined. */
  readonly from: Readonly<Record<string, string>>;
  /** Source env var names required before launch, sorted. */
  readonly required: readonly string[];
}

export interface LaunchRecipe {
  readonly agent: AgentId;
  readonly executable: string;
  /** Full argv, argv[0] === executable. An array, never a shell string. */
  readonly argv: readonly string[];
  readonly configPath: string;
  readonly gatewayUrl: string;
  readonly env: LaunchEnvPlan;
  readonly governance: 'enforced';
}

export class UnknownAgentError extends Error {
  readonly agent: string;

  constructor(agent: string) {
    super(`Unknown agent ${JSON.stringify(agent)}; supported: ${AGENT_IDS.join(', ')}`);
    this.name = 'UnknownAgentError';
    this.agent = agent;
  }
}

const PROFILE_FILES: Readonly<Record<AgentId, string>> = {
  aider: '.aider.conf.yml',
  cline: '.cline/cline_mcp_settings.json',
  roo: '.roo/strata.json',
};

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'] as const;
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHELL_UNSAFE = /[;&|`$<>\n\r\0\\()]/;

interface ResolvedOptions {
  readonly gatewayUrl: string;
  readonly apiKeyEnv: string;
  readonly model: string;
  readonly weakModel: string;
  readonly editorModel: string;
  readonly preCommitCommand: string;
  readonly mcpCommand: string;
  readonly rootDir: string;
  readonly host: string;
  readonly port: number;
}

export function isSupportedAgent(value: unknown): value is AgentId {
  return typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value);
}

function requireAgent(agent: string): AgentId {
  if (!isSupportedAgent(agent)) {
    throw new UnknownAgentError(agent);
  }
  return agent;
}

/**
 * Loopback-only, http-only, no userinfo, no query. The gateway is a local
 * process (I-4: no network egress); a profile pointing anywhere else is a
 * misconfiguration we would rather fail on at build time than at prompt time.
 */
export function isLoopbackGatewayUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  if (url.username !== '' || url.password !== '') return false;
  if (url.search !== '' || url.hash !== '') return false;
  return (LOOPBACK_HOSTS as readonly string[]).includes(url.hostname);
}

function requireGatewayUrl(value: string): string {
  if (!isLoopbackGatewayUrl(value)) {
    throw new Error(
      `gatewayUrl must be a loopback http:// URL without credentials, query or fragment, got ${JSON.stringify(value)}`,
    );
  }
  return value.replace(/\/+$/, '');
}

function requireEnvVarName(value: string, label: string): string {
  if (!ENV_VAR_NAME.test(value)) {
    throw new Error(`${label} must be a POSIX env var name, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requirePlainToken(value: string, label: string): string {
  if (value === '' || SHELL_UNSAFE.test(value) || /[\s'"]/.test(value)) {
    throw new Error(`${label} must be a single shell-safe token, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireCommand(value: string, label: string): string {
  if (value.trim() === '' || SHELL_UNSAFE.test(value)) {
    throw new Error(`${label} must be a command without shell metacharacters, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireRootDir(value: string): string {
  const trimmed = value.replace(/\/+$/, '');
  if (trimmed === '') return '.';
  if (SHELL_UNSAFE.test(trimmed) || /\n/.test(trimmed)) {
    throw new Error(`rootDir must be a plain path, got ${JSON.stringify(value)}`);
  }
  return trimmed;
}

function requireLoopbackHost(value: string, label: string): string {
  if (!(LOOPBACK_HOSTS as readonly string[]).includes(value)) {
    throw new Error(`${label} must be a loopback host (${LOOPBACK_HOSTS.join(', ')}), got ${JSON.stringify(value)}`);
  }
  return value;
}

function requirePort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`port must be an integer in 1..65535, got ${String(value)}`);
  }
  return value;
}

function joinProfilePath(rootDir: string, fileName: string): string {
  return rootDir === '.' ? fileName : `${rootDir}/${fileName}`;
}

function openAiBaseUrl(gatewayUrl: string): string {
  return `${gatewayUrl}/v1`;
}

function resolve(options: LaunchOptions): ResolvedOptions {
  return {
    gatewayUrl: requireGatewayUrl(options.gatewayUrl ?? DEFAULT_GATEWAY_URL),
    apiKeyEnv: requireEnvVarName(options.apiKeyEnv ?? DEFAULT_API_KEY_ENV, 'apiKeyEnv'),
    model: requirePlainToken(options.model ?? DEFAULT_MODEL, 'model'),
    weakModel: requirePlainToken(options.weakModel ?? DEFAULT_WEAK_MODEL, 'weakModel'),
    editorModel: requirePlainToken(options.editorModel ?? DEFAULT_EDITOR_MODEL, 'editorModel'),
    preCommitCommand: requireCommand(options.preCommitCommand ?? DEFAULT_PRE_COMMIT_COMMAND, 'preCommitCommand'),
    mcpCommand: requirePlainToken(options.mcpCommand ?? DEFAULT_MCP_COMMAND, 'mcpCommand'),
    rootDir: requireRootDir(options.rootDir ?? '.'),
    host: requireLoopbackHost(options.host ?? DEFAULT_BRIDGE_HOST, 'host'),
    port: requirePort(options.port ?? DEFAULT_BRIDGE_PORT),
  };
}

function mcpServerEntry(options: ResolvedOptions): McpServerEntry {
  return {
    command: options.mcpCommand,
    args: ['mcp', 'serve', '--gateway', options.gatewayUrl],
    disabled: false,
    autoApprove: [...MCP_TOOLS],
  };
}

function providerProfile(options: ResolvedOptions): StrataProviderProfile {
  return {
    id: 'strata',
    name: 'strata-ctx',
    provider: 'openai-compatible',
    baseUrl: openAiBaseUrl(options.gatewayUrl),
    apiKeyProvider: 'none',
    apiKeyEnv: options.apiKeyEnv,
    model: options.model,
  };
}

function renderYaml(document: AiderProfileDocument, gatewayUrl: string): string {
  const doc = new YAML.Document(document);
  // The yaml writer emits the `#` itself; a leading space keeps the rendered
  // comment readable (`# text`, not `#text`).
  doc.commentBefore = [
    ' strata-ctx governed profile (E-6) - regenerate, do not hand-edit.',
    ` All model traffic goes through the local strata gateway at ${gatewayUrl}.`,
    ' No credential belongs in this file; export the key named by launchRecipe().from.',
  ].join('\n');
  // lineWidth: 0 disables folding so a long URL can never be wrapped into
  // something a dotenv/YAML reader sees as two lines.
  return doc.toString({ lineWidth: 0 });
}

function renderJson(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function buildAiderProfile(options: ResolvedOptions, targetPath: string): AgentProfile {
  const document: AiderProfileDocument = {
    model: options.model,
    'weak-model': options.weakModel,
    'editor-model': options.editorModel,
    'openai-api-base': openAiBaseUrl(options.gatewayUrl),
    'pre-commit': [options.preCommitCommand],
  };
  return {
    agent: 'aider',
    format: 'yaml',
    fileName: PROFILE_FILES.aider,
    targetPath,
    content: renderYaml(document, options.gatewayUrl),
    gatewayUrl: options.gatewayUrl,
    model: options.model,
    requiredEnv: [options.apiKeyEnv],
  };
}

function buildClineProfile(options: ResolvedOptions, targetPath: string): AgentProfile {
  const document: ClineProfileDocument = {
    mcpServers: { strata: mcpServerEntry(options) },
    strata: {
      agent: 'cline',
      gatewayUrl: options.gatewayUrl,
      requireGateway: true,
      openAiCompatibleProvider: providerProfile(options),
    },
  };
  return {
    agent: 'cline',
    format: 'json',
    fileName: PROFILE_FILES.cline,
    targetPath,
    content: renderJson(document),
    gatewayUrl: options.gatewayUrl,
    model: options.model,
    requiredEnv: [options.apiKeyEnv],
  };
}

function buildRooProfile(options: ResolvedOptions, targetPath: string): AgentProfile {
  const document: RooProfileDocument = {
    strata: {
      agent: 'roo',
      gatewayUrl: options.gatewayUrl,
      requireGateway: true,
      providerProfile: providerProfile(options),
    },
    customModes: [
      {
        slug: 'strata-governed',
        name: 'Strata Governed',
        roleDefinition: [
          'You are operating behind the strata-ctx context firewall.',
          `Every model request is routed through the local strata gateway at ${options.gatewayUrl}.`,
          'Do not contact a provider endpoint directly, and do not suggest that the user should.',
          'Use the `strata` MCP server (ctx_search, ctx_get_task, ctx_get_artifact, ctx_note,',
          'ctx_status, ctx_remember) to recover context instead of re-reading whole files.',
          'A tool result returned as artifact:// is a pointer, not the file: resolve it with',
          'ctx_get_artifact before editing the referenced path.',
        ].join(' '),
        groups: ['read', 'edit', 'browser', 'command'],
        customInstructions: [
          'Never disable, override, or route around the strata gateway.',
          'No credential ever goes in this file; the gateway credential comes from the environment.',
        ].join(' '),
        whenToUse: 'Always. This is the only mode that carries the governance guarantee.',
      },
    ],
    mcpServers: { strata: mcpServerEntry(options) },
  };
  return {
    agent: 'roo',
    format: 'json',
    fileName: PROFILE_FILES.roo,
    targetPath,
    content: renderJson(document),
    gatewayUrl: options.gatewayUrl,
    model: options.model,
    requiredEnv: [options.apiKeyEnv],
  };
}

export function buildProfile(agent: AgentId, options: ProfileOptions = {}): AgentProfile {
  const id = requireAgent(agent);
  const resolved = resolve(options);
  const targetPath = joinProfilePath(resolved.rootDir, PROFILE_FILES[id]);
  switch (id) {
    case 'aider':
      return buildAiderProfile(resolved, targetPath);
    case 'cline':
      return buildClineProfile(resolved, targetPath);
    case 'roo':
      return buildRooProfile(resolved, targetPath);
  }
}

function envPlan(options: ResolvedOptions): LaunchEnvPlan {
  return {
    fixed: { STRATA_GATEWAY_URL: options.gatewayUrl },
    from: { OPENAI_API_KEY: options.apiKeyEnv },
    required: [options.apiKeyEnv],
  };
}

export function launchRecipe(agent: AgentId, options: LaunchOptions = {}): LaunchRecipe {
  const id = requireAgent(agent);
  const resolved = resolve(options);
  const configPath = joinProfilePath(resolved.rootDir, PROFILE_FILES[id]);
  const env = envPlan(resolved);
  switch (id) {
    case 'aider':
      return {
        agent: 'aider',
        executable: 'aider',
        argv: [
          'aider',
          '--config',
          configPath,
          '--model',
          resolved.model,
          '--openai-api-base',
          openAiBaseUrl(resolved.gatewayUrl),
          '--yes',
          '--no-check-update',
        ],
        configPath,
        gatewayUrl: resolved.gatewayUrl,
        env,
        governance: 'enforced',
      };
    case 'cline':
      return {
        agent: 'cline',
        executable: 'cline',
        argv: [
          'cline',
          'serve',
          '--config',
          configPath,
          '--host',
          resolved.host,
          '--port',
          String(resolved.port),
        ],
        configPath,
        gatewayUrl: resolved.gatewayUrl,
        env,
        governance: 'enforced',
      };
    case 'roo':
      return {
        agent: 'roo',
        executable: 'roo',
        argv: [
          'roo',
          'serve',
          '--config',
          configPath,
          '--host',
          resolved.host,
          '--port',
          String(resolved.port),
        ],
        configPath,
        gatewayUrl: resolved.gatewayUrl,
        env,
        governance: 'enforced',
      };
  }
}

/**
 * Names only. A caller can tell the user what to export; a value can never
 * reach a log line through this function.
 */
export function missingEnvVars(
  recipe: LaunchRecipe,
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return recipe.env.required.filter((name) => {
    const value = env[name];
    return value === undefined || value.trim() === '';
  });
}
