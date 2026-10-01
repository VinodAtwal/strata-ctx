/**
 * E-7 — GitHub Copilot, MCP-only, with the governance label attached to it.
 *
 * Copilot's VS Code extension is closed-source and exposes no lifecycle hooks, so
 * there is no `PreToolUse`/`PostToolUse` equivalent to rewrite a tool result in
 * flight. The only insertion point we control is the MCP server, and an MCP
 * server is *pull*: the model decides whether to call it. That makes every
 * governance constraint on this path a sentence the model is asked to honour
 * rather than a byte range the transport is obliged to carry.
 *
 * So this module is deliberately two things and not three:
 *
 *   1. `buildCopilotMcpConfig()` — an honest, complete MCP registration for
 *      `.mcp.json` and for VS Code's `settings.json`. It never emits a `hooks`
 *      key, because emitting one would be a claim about a surface that does not
 *      exist and would fail silently in the one way that matters most: a user
 *      reading `settings.json` would believe constraints are enforced.
 *   2. `governanceLabel()` / `compareGuarantees()` — the machine-readable
 *      statement of what that registration does and does not buy.
 *
 * docs/integrations.md §6 and decisions.md ADR-12: ship Copilot as MCP-only,
 * explicitly labelled "no governance guarantee", and do not build the
 * TLS-interception path. The label is the deliverable; the config is the easy
 * half. Anything softer than a plain statement of absence would let a Copilot
 * user believe they have the safety property, which is the exact failure mode
 * R11 was opened to prevent.
 */

export const COPILOT_AGENT_ID = 'github-copilot';
export const COPILOT_SURFACE = 'vscode-extension';

export const DEFAULT_MCP_SERVER_NAME = 'strata-ctx';
/** `strata-ctx mcp serve`, not a `strata-ctx-mcp` binary that does not exist. */
export const DEFAULT_MCP_COMMAND = 'strata-ctx mcp serve';
export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8787';
export const DEFAULT_POLICY_FILE = './.strata/policy.yaml';

export const COPILOT_MCP_JSON_PATH = '.mcp.json';
export const COPILOT_VSCODE_SETTINGS_PATH = '.vscode/settings.json';

/** The tools E-1 exposes. Copilot discovers these from the server itself. */
export const STRATA_MCP_TOOLS = Object.freeze([
  'ctx_search',
  'ctx_get_task',
  'ctx_get_artifact',
  'ctx_note',
  'ctx_status',
  'ctx_remember',
] as const);
export type StrataMcpTool = (typeof STRATA_MCP_TOOLS)[number];

/**
 * Ordered weakest to strongest. The index is the rank the CLI sorts by, so the
 * order here is the claim: an MCP-only agent is strictly below anything with a
 * transport we sit in front of, which is strictly below anything with hooks.
 */
export const GUARANTEE_ORDER = Object.freeze([
  'none',
  'advisory_only',
  'transport_enforced',
  'hook_enforced',
] as const);

export type GovernanceGuaranteeTier = (typeof GUARANTEE_ORDER)[number];

export function rankGuarantee(tier: GovernanceGuaranteeTier): number {
  return GUARANTEE_ORDER.indexOf(tier);
}

// ---------------------------------------------------------------------------
// Governance label
// ---------------------------------------------------------------------------

/**
 * `hookEnforcement` and `transportByteEnforcement` are typed as the literal
 * `false`, not as `boolean`. There is no value of this type that claims
 * enforcement, so the claim cannot be made by accident and a future edit that
 * tries to make it is a compile error rather than a doc regression.
 */
export interface GovernanceLabel {
  readonly agent: string;
  readonly surface: string;
  readonly tier: GovernanceGuaranteeTier;
  readonly rank: number;
  readonly headline: string;
  /** Always true. Present so callers can branch on it without string matching. */
  readonly advisory: boolean;
  /** The only form governance takes here: text in the prompt, not a control. */
  readonly promptLayerGovernance: 'advisory';
  readonly hookEnforcement: false;
  readonly transportByteEnforcement: false;
  /** Agents whose guarantee is strictly stronger than this one. */
  readonly weakerThan: readonly string[];
  /** What a Copilot user actually gets. Never asserts enforcement. */
  readonly guarantees: readonly string[];
  /** What they do not get. Every entry is phrased as an absence. */
  readonly notGuaranteed: readonly string[];
  /** `guarantees` then `notGuaranteed`, in order. The CLI prints this. */
  readonly statements: readonly string[];
  /** One sentence. Goes into the emitted config and into `strata doctor`. */
  readonly notice: string;
  /** The whole label, rendered. */
  readonly text: string;
}

const COPILOT_GUARANTEES: readonly string[] = Object.freeze([
  'The strata MCP server is registered and callable; the agent can retrieve compressed context on request.',
  'Retrieval stays available through ctx_search, ctx_get_task and ctx_get_artifact, so compaction remains reversible on this path.',
  'Work the agent routes through the MCP tools is deduplicated, truncated and pointer-ized before the model ever sees it.',
  'Tool result compression is the only place strata pays for itself here: it reduces what the model reads without needing the model to cooperate.',
  'Telemetry records what the MCP tools served, so compression and retrieval savings are measurable on this path.',
]);

const COPILOT_NOT_GUARANTEED: readonly string[] = Object.freeze([
  'Prompt-layer governance is advisory only: a constraint reaches the model as text it may ignore, paraphrase, rank below other instructions, or drop entirely.',
  'Pins are not byte-enforced at the transport layer here; there is no transport to enforce them on, because strata never sees the request this path produces.',
  'The pre-apply byte-equality check cannot run on this path: it depends on the client echoing the system prompt back, and the Copilot MCP path never does.',
  'Inbound pin corruption is undetectable here, so no pin_missing_pre_apply event can be raised against a Copilot session.',
  'Enforcement levels in policy (block, rewrite, log) cannot fire: there is no hook surface on this path to intercept a tool call and return a decision.',
  'Compaction performed by the host is not observable to strata, so pin survival across a host-side compaction is not verifiable.',
  'Governance constraints are never silently dropped by strata itself, but nothing stops the agent from ignoring them, and this path cannot tell the difference.',
  'These guarantees are strictly weaker than those on a hook-capable agent such as Claude Code, Gemini CLI or Cursor; treat the two as different products, not different configurations.',
]);

const COPILOT_HEADLINE =
  'GitHub Copilot (VS Code extension): advisory-only governance. No governance guarantee.';

const COPILOT_NOTICE =
  'strata-ctx on GitHub Copilot is advisory only: governance constraints reach the model as prompt text, pins are not byte-enforced at the transport layer, and guarantees are weaker than on hook-capable agents.';

const COPILOT_WEAKER_THAN: readonly string[] = Object.freeze([
  'claude-code',
  'gemini-cli',
  'cursor',
]);

function bullet(lines: readonly string[]): string {
  return lines.map((line) => `- ${line}`).join('\n');
}

export function governanceLabel(): GovernanceLabel {
  const tier: GovernanceGuaranteeTier = 'advisory_only';
  const statements = [...COPILOT_GUARANTEES, ...COPILOT_NOT_GUARANTEED];
  const text = [
    COPILOT_HEADLINE,
    '',
    `Tier: ${tier} (rank ${rankGuarantee(tier)} of ${GUARANTEE_ORDER.length - 1}).`,
    `Weaker than: ${COPILOT_WEAKER_THAN.join(', ')}.`,
    '',
    'What this path DOES guarantee:',
    bullet(COPILOT_GUARANTEES),
    '',
    'What this path does NOT guarantee:',
    bullet(COPILOT_NOT_GUARANTEED),
  ].join('\n');

  return Object.freeze({
    agent: COPILOT_AGENT_ID,
    surface: COPILOT_SURFACE,
    tier,
    rank: rankGuarantee(tier),
    headline: COPILOT_HEADLINE,
    advisory: true,
    promptLayerGovernance: 'advisory',
    hookEnforcement: false,
    transportByteEnforcement: false,
    weakerThan: COPILOT_WEAKER_THAN,
    guarantees: COPILOT_GUARANTEES,
    notGuaranteed: COPILOT_NOT_GUARANTEED,
    statements: Object.freeze(statements),
    notice: COPILOT_NOTICE,
    text,
  });
}

// ---------------------------------------------------------------------------
// MCP configuration
// ---------------------------------------------------------------------------

export interface CopilotMcpServerConfig {
  readonly type: 'stdio';
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface CopilotMcpJsonFile {
  readonly mcpServers: Readonly<Record<string, CopilotMcpServerConfig>>;
  readonly 'x-strata-governance'?: string;
  readonly 'x-strata-guarantee-tier'?: GovernanceGuaranteeTier;
}

export interface CopilotVsCodeSettingsSnippet {
  readonly mcp: { readonly servers: Readonly<Record<string, CopilotMcpServerConfig>> };
  readonly 'x-strata-governance'?: string;
  readonly 'x-strata-guarantee-tier'?: GovernanceGuaranteeTier;
}

export interface CopilotMcpConfigOptions {
  readonly serverName?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly gatewayUrl?: string;
  readonly policyFile?: string;
  /** Extra environment for the server process. Sorted by key, never reordered. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Emit the `x-strata-governance` keys alongside the registration. On by
   * default: the caveat travels with the config so nobody enables this path
   * without reading it. MCP clients ignore unknown keys in the server file.
   */
  readonly includeGovernanceNotice?: boolean;
}

export interface CopilotMcpConfig {
  readonly serverName: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly mcpJsonPath: string;
  readonly vscodeSettingsPath: string;
  readonly mcpJson: string;
  readonly vscodeSettings: string;
  readonly mcpJsonFile: CopilotMcpJsonFile;
  readonly vscodeSettingsSnippet: CopilotVsCodeSettingsSnippet;
  readonly tools: readonly StrataMcpTool[];
  readonly governance: GovernanceLabel;
  /** `strata init --agent copilot` writes these two files verbatim. */
  readonly instructions: string;
}

const JSON_INDENT = 2;

function stableEnv(
  gatewayUrl: string,
  policyFile: string,
  extra: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const merged: Record<string, string> = {
    STRATA_GATEWAY_URL: gatewayUrl,
    STRATA_POLICY_FILE: policyFile,
  };
  for (const key of Object.keys(extra ?? {}).sort()) {
    const value = extra?.[key];
    if (value !== undefined) merged[key] = value;
  }
  return Object.freeze(merged);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, JSON_INDENT)}\n`;
}

export function buildCopilotMcpConfig(options: CopilotMcpConfigOptions = {}): CopilotMcpConfig {
  const serverName = options.serverName ?? DEFAULT_MCP_SERVER_NAME;
  const command = options.command ?? DEFAULT_MCP_COMMAND;
  const args = Object.freeze([...(options.args ?? [])]);
  const gatewayUrl = options.gatewayUrl ?? DEFAULT_GATEWAY_URL;
  const policyFile = options.policyFile ?? DEFAULT_POLICY_FILE;
  const env = stableEnv(gatewayUrl, policyFile, options.env);
  const governance = governanceLabel();
  const includeNotice = options.includeGovernanceNotice ?? true;

  const server: CopilotMcpServerConfig = Object.freeze({
    type: 'stdio' as const,
    command,
    args,
    env,
  });

  const noticeKeys =
    includeNotice
      ? {
          'x-strata-governance': governance.notice,
          'x-strata-guarantee-tier': governance.tier,
        }
      : {};

  const mcpJsonFile: CopilotMcpJsonFile = Object.freeze({
    mcpServers: Object.freeze({ [serverName]: server }),
    ...noticeKeys,
  });

  const vscodeSettingsSnippet: CopilotVsCodeSettingsSnippet = Object.freeze({
    mcp: Object.freeze({ servers: Object.freeze({ [serverName]: server }) }),
    ...noticeKeys,
  });

  return Object.freeze({
    serverName,
    command,
    args,
    env,
    mcpJsonPath: COPILOT_MCP_JSON_PATH,
    vscodeSettingsPath: COPILOT_VSCODE_SETTINGS_PATH,
    mcpJson: serialize(mcpJsonFile),
    vscodeSettings: serialize(vscodeSettingsSnippet),
    mcpJsonFile,
    vscodeSettingsSnippet,
    tools: STRATA_MCP_TOOLS,
    governance,
    instructions: [
      `1. Write ${COPILOT_MCP_JSON_PATH} with the contents of config.mcpJson.`,
      `2. Or merge config.vscodeSettingsSnippet into ${COPILOT_VSCODE_SETTINGS_PATH}.`,
      `3. Restart VS Code and confirm the "${serverName}" server appears in the Copilot MCP list.`,
      `4. ${governance.notice}`,
    ].join('\n'),
  });
}

// ---------------------------------------------------------------------------
// Guarantee comparison
// ---------------------------------------------------------------------------

export interface AgentGuarantees {
  /** Normalized id, or the normalized query when the agent is unknown. */
  readonly agent: string;
  /** Exactly what the caller passed, for echoing back in a CLI error. */
  readonly query: string;
  readonly known: boolean;
  readonly tier: GovernanceGuaranteeTier;
  readonly rank: number;
  readonly hooks: boolean;
  readonly proxy: boolean;
  readonly mcp: boolean;
  /** Whether a constraint is carried as a control rather than as advice. */
  readonly pinEnforcement: 'enforced' | 'advisory' | 'none';
  /** Whether the pin set is byte-enforced somewhere we actually sit. */
  readonly byteEnforcedAtTransport: boolean;
  /** Whether inbound damage to the pin set is detectable at all. */
  readonly detectsInboundCorruption: boolean;
  readonly summary: string;
}

interface AgentCapabilities {
  readonly tier: GovernanceGuaranteeTier;
  readonly hooks: boolean;
  readonly proxy: boolean;
  readonly mcp: boolean;
  readonly echoesSystemPrompt: boolean;
  readonly summary: string;
}

/**
 * Sourced from docs/integrations.md §2. Only capability bits live here; every
 * derived field is computed in `compareGuarantees` so the label and the rank
 * cannot drift apart.
 */
const AGENT_CAPABILITIES: Readonly<Record<string, AgentCapabilities>> = Object.freeze({
  'claude-code': {
    tier: 'hook_enforced',
    hooks: true,
    proxy: true,
    mcp: true,
    echoesSystemPrompt: true,
    summary:
      'PostToolUse rewrites tool results in flight, so the pinned set is re-applied and byte-checked on every request.',
  },
  'gemini-cli': {
    tier: 'hook_enforced',
    hooks: true,
    proxy: true,
    mcp: true,
    echoesSystemPrompt: true,
    summary:
      'Same hook surface shape as Claude Code via the shared parameterized builder; enforcement is equivalent.',
  },
  cursor: {
    tier: 'hook_enforced',
    hooks: true,
    proxy: false,
    mcp: true,
    echoesSystemPrompt: true,
    summary:
      'Hooks exist but the surface is narrower than Claude Code and the proxy path is limited, so coverage is partial.',
  },
  opencode: {
    tier: 'hook_enforced',
    hooks: true,
    proxy: true,
    mcp: true,
    echoesSystemPrompt: true,
    summary:
      'OpenCode plugin uses the shared parameterized hook builder for PreToolUse/PostToolUse and registers the MCP server; governance enforcement is equivalent to Claude Code and Gemini CLI.',
  },
  aider: {
    tier: 'transport_enforced',
    hooks: false,
    proxy: true,
    mcp: true,
    echoesSystemPrompt: true,
    summary:
      'OpenAI-compatible client through the proxy: the outbound pin set is immutable and re-applied, but no tool result is rewritten in flight.',
  },
  cline: {
    tier: 'transport_enforced',
    hooks: false,
    proxy: true,
    mcp: true,
    echoesSystemPrompt: true,
    summary: 'OpenAI-compatible client through the proxy; transport guarantee only.',
  },
  roo: {
    tier: 'transport_enforced',
    hooks: false,
    proxy: true,
    mcp: true,
    echoesSystemPrompt: true,
    summary: 'OpenAI-compatible client through the proxy; transport guarantee only.',
  },
  continue: {
    tier: 'transport_enforced',
    hooks: false,
    proxy: true,
    mcp: true,
    echoesSystemPrompt: true,
    summary: 'OpenAI-compatible client through the proxy; transport guarantee only.',
  },
  'copilot-api': {
    tier: 'transport_enforced',
    hooks: false,
    proxy: true,
    mcp: true,
    echoesSystemPrompt: true,
    summary:
      'The Copilot API/CLI path, not the VS Code extension: it is just another OpenAI-compatible target, so the proxy covers it.',
  },
  'lm-studio': {
    tier: 'transport_enforced',
    hooks: false,
    proxy: true,
    mcp: false,
    echoesSystemPrompt: true,
    summary: 'OpenAI-compatible local server through the proxy; transport guarantee only.',
  },
  openwebui: {
    tier: 'transport_enforced',
    hooks: false,
    proxy: true,
    mcp: false,
    echoesSystemPrompt: true,
    summary: 'OpenAI-compatible front end through the proxy; transport guarantee only.',
  },
  'github-copilot': {
    tier: 'advisory_only',
    hooks: false,
    proxy: false,
    mcp: true,
    echoesSystemPrompt: false,
    summary:
      'Closed-source VS Code extension with no hook surface. MCP is the only insertion point, so governance is advisory and pins are not byte-enforced.',
  },
});

const AGENT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  copilot: 'github-copilot',
  'copilot-vscode': 'github-copilot',
  'vscode-copilot': 'github-copilot',
  'github-copilot-cli': 'copilot-api',
  'copilot-cli': 'copilot-api',
  'copilot-api': 'copilot-api',
  claude: 'claude-code',
  claudecode: 'claude-code',
  gemini: 'gemini-cli',
  'roo-code': 'roo',
});

function normalizeAgent(query: string): string {
  return query.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function pinEnforcementFor(tier: GovernanceGuaranteeTier): 'enforced' | 'advisory' | 'none' {
  switch (tier) {
    case 'hook_enforced':
    case 'transport_enforced':
      return 'enforced';
    case 'advisory_only':
      return 'advisory';
    case 'none':
      return 'none';
  }
}

function unknownAgent(query: string, agent: string): AgentGuarantees {
  return Object.freeze({
    agent,
    query,
    known: false,
    tier: 'none',
    rank: rankGuarantee('none'),
    hooks: false,
    proxy: false,
    mcp: false,
    pinEnforcement: 'none',
    byteEnforcedAtTransport: false,
    detectsInboundCorruption: false,
    summary: `Unknown agent "${query}": no strata integration is registered for it, so there is no governance guarantee at all. Nothing is enforced and nothing is observable.`,
  });
}

/**
 * The CLI entry point: given any agent name, say how strong the governance
 * guarantee is. Unknown names resolve to the weakest tier rather than throwing,
 * because `strata init --agent <name>` should tell a user they are about to get
 * nothing instead of crashing on a typo.
 */
export function compareGuarantees(agent: string): AgentGuarantees {
  const query = typeof agent === 'string' ? agent : String(agent);
  const normalized = normalizeAgent(query);
  const resolved = AGENT_ALIASES[normalized] ?? normalized;
  const capabilities = AGENT_CAPABILITIES[resolved];

  if (capabilities === undefined) {
    return unknownAgent(query, normalized);
  }

  const { tier, hooks, proxy, mcp, echoesSystemPrompt, summary } = capabilities;
  return Object.freeze({
    agent: resolved,
    query,
    known: true,
    tier,
    rank: rankGuarantee(tier),
    hooks,
    proxy,
    mcp,
    pinEnforcement: pinEnforcementFor(tier),
    byteEnforcedAtTransport: tier === 'hook_enforced' || tier === 'transport_enforced',
    detectsInboundCorruption: echoesSystemPrompt && tier !== 'none' && tier !== 'advisory_only',
    summary,
  });
}

/** Every agent id the registry knows, sorted, for CLI help output. */
export function knownAgents(): readonly string[] {
  return Object.freeze(Object.keys(AGENT_CAPABILITIES).sort());
}
