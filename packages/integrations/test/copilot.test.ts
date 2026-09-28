import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COPILOT_AGENT_ID,
  COPILOT_MCP_JSON_PATH,
  COPILOT_VSCODE_SETTINGS_PATH,
  DEFAULT_GATEWAY_URL,
  DEFAULT_MCP_COMMAND,
  DEFAULT_MCP_SERVER_NAME,
  DEFAULT_POLICY_FILE,
  GUARANTEE_ORDER,
  STRATA_MCP_TOOLS,
  buildCopilotMcpConfig,
  compareGuarantees,
  governanceLabel,
  knownAgents,
  rankGuarantee,
  type CopilotMcpConfig,
  type CopilotMcpJsonFile,
  type CopilotMcpServerConfig,
  type CopilotVsCodeSettingsSnippet,
  type GovernanceLabel,
} from '../src/copilot.js';

function parse<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

// A sentence may discuss enforcement only to deny it. This is the machine
// version of "the docs must say so in those words" from decisions.md R11.
const AFFIRMATIVE_ENFORCEMENT = /\b(enforc\w*|guarantee\w*|never erased|cannot be dropped)\b/i;
const NEGATION = /\b(not|no|never|nothing|cannot|advisory|unverifiable|undetectable|weaker|does not|is not)\b/i;

function parseConfig(overrides: Parameters<typeof buildCopilotMcpConfig>[0] = {}): CopilotMcpConfig {
  return buildCopilotMcpConfig(overrides);
}

describe('buildCopilotMcpConfig()', () => {
  it('emits .mcp.json that parses as valid JSON', () => {
    const config = parseConfig();
    const parsed = parse<Record<string, unknown>>(config.mcpJson);

    assert.deepEqual(Object.keys(parsed), [
      'mcpServers',
      'x-strata-governance',
      'x-strata-guarantee-tier',
    ]);
    assert.ok(parsed.mcpServers);
  });

  it('registers the strata MCP server under mcpServers with a stdio transport', () => {
    const config = parseConfig();
    const file = parse<CopilotMcpJsonFile>(config.mcpJson);
    const server = file.mcpServers[DEFAULT_MCP_SERVER_NAME];

    assert.ok(server, 'server must be registered under mcpServers');
    assert.equal(server.type, 'stdio');
    assert.equal(server.command, DEFAULT_MCP_COMMAND);
    assert.deepEqual([...server.args], []);
  });

  it('emits a VS Code settings.json snippet nested under mcp.servers', () => {
    const config = parseConfig();
    const snippet = parse<CopilotVsCodeSettingsSnippet>(config.vscodeSettings);

    assert.ok(snippet.mcp);
    assert.ok(snippet.mcp.servers[DEFAULT_MCP_SERVER_NAME]);
    assert.equal(snippet.mcp.servers[DEFAULT_MCP_SERVER_NAME]?.command, DEFAULT_MCP_COMMAND);
  });

  it('describes the same server in .mcp.json and in the settings.json snippet', () => {
    const config = parseConfig();
    const file = parse<CopilotMcpJsonFile>(config.mcpJson);
    const snippet = parse<CopilotVsCodeSettingsSnippet>(config.vscodeSettings);

    assert.deepEqual(
      file.mcpServers[DEFAULT_MCP_SERVER_NAME],
      snippet.mcp.servers[DEFAULT_MCP_SERVER_NAME],
    );
  });

  it('carries the governance notice in both emitted documents', () => {
    const config = parseConfig();
    const file = parse<CopilotMcpJsonFile>(config.mcpJson);
    const snippet = parse<CopilotVsCodeSettingsSnippet>(config.vscodeSettings);

    assert.equal(file['x-strata-governance'], governanceLabel().notice);
    assert.equal(snippet['x-strata-governance'], governanceLabel().notice);
    assert.equal(file['x-strata-guarantee-tier'], 'advisory_only');
  });

  it('omits the notice when includeGovernanceNotice is false', () => {
    const config = parseConfig({ includeGovernanceNotice: false });
    const file = parse<CopilotMcpJsonFile>(config.mcpJson);

    assert.deepEqual(Object.keys(file), ['mcpServers']);
    assert.equal(file['x-strata-governance'], undefined);
    assert.equal(file['x-strata-guarantee-tier'], undefined);
  });

  it('never emits a hooks key, because this agent has no hook surface', () => {
    const config = parseConfig();
    const file = parse<CopilotMcpJsonFile>(config.mcpJson);
    const snippet = parse<CopilotVsCodeSettingsSnippet>(config.vscodeSettings);

    assert.equal('hooks' in file, false);
    assert.equal('hooks' in snippet, false);
    assert.equal(compareGuarantees(COPILOT_AGENT_ID).hooks, false);
  });

  it('sets the gateway URL and policy file in the server environment', () => {
    const config = parseConfig();
    const file = parse<CopilotMcpJsonFile>(config.mcpJson);
    const env = file.mcpServers[DEFAULT_MCP_SERVER_NAME]?.env ?? {};

    assert.equal(env.STRATA_GATEWAY_URL, DEFAULT_GATEWAY_URL);
    assert.equal(env.STRATA_POLICY_FILE, DEFAULT_POLICY_FILE);
  });

  it('honours custom command, args, gateway URL and policy file', () => {
    const config = parseConfig({
      command: 'node',
      args: ['./dist/mcp.js', '--stdio'],
      gatewayUrl: 'http://127.0.0.1:9001',
      policyFile: './ctx-policy.yaml',
    });
    const file = parse<CopilotMcpJsonFile>(config.mcpJson);
    const server = file.mcpServers[DEFAULT_MCP_SERVER_NAME];

    assert.equal(server?.command, 'node');
    assert.deepEqual([...(server?.args ?? [])], ['./dist/mcp.js', '--stdio']);
    assert.equal(server?.env.STRATA_GATEWAY_URL, 'http://127.0.0.1:9001');
    assert.equal(server?.env.STRATA_POLICY_FILE, './ctx-policy.yaml');
  });

  it('honours a custom server name', () => {
    const config = parseConfig({ serverName: 'strata' });
    const file = parse<CopilotMcpJsonFile>(config.mcpJson);

    assert.ok(file.mcpServers.strata);
    assert.equal(file.mcpServers[DEFAULT_MCP_SERVER_NAME], undefined);
  });

  it('merges extra environment and keeps it sorted for determinism', () => {
    const a = parseConfig({ env: { ZED: 'z', ALPHA: 'a' } });
    const b = parseConfig({ env: { ALPHA: 'a', ZED: 'z' } });

    assert.equal(a.mcpJson, b.mcpJson);
    assert.deepEqual(Object.keys(a.env), ['STRATA_GATEWAY_URL', 'STRATA_POLICY_FILE', 'ALPHA', 'ZED']);
  });

  it('is byte-for-byte deterministic across calls', () => {
    const first = parseConfig();
    const second = parseConfig();

    assert.equal(first.mcpJson, second.mcpJson);
    assert.equal(first.vscodeSettings, second.vscodeSettings);
    assert.deepEqual(first, second);
  });

  it('reports the paths the CLI should write to', () => {
    const config = parseConfig();

    assert.equal(config.mcpJsonPath, COPILOT_MCP_JSON_PATH);
    assert.equal(config.vscodeSettingsPath, COPILOT_VSCODE_SETTINGS_PATH);
  });

  it('lists the six strata MCP tools', () => {
    const config = parseConfig();

    assert.deepEqual([...config.tools], [...STRATA_MCP_TOOLS]);
    assert.equal(config.tools.length, 6);
    assert.ok(config.tools.includes('ctx_search'));
    assert.ok(config.tools.includes('ctx_get_task'));
  });

  it('ends emitted documents with a trailing newline', () => {
    const config = parseConfig();

    assert.ok(config.mcpJson.endsWith('}\n'));
    assert.ok(config.vscodeSettings.endsWith('}\n'));
  });

  it('attaches the governance label and a setup procedure', () => {
    const config = parseConfig();

    assert.equal(config.governance.tier, 'advisory_only');
    assert.ok(config.instructions.includes(COPILOT_MCP_JSON_PATH));
    assert.ok(config.instructions.includes(COPILOT_VSCODE_SETTINGS_PATH));
    assert.ok(config.instructions.includes(governanceLabel().notice));
  });

  it('produces a server definition that satisfies the MCP stdio shape', () => {
    const config = parseConfig();
    const file = parse<CopilotMcpJsonFile>(config.mcpJson);
    const server = file.mcpServers[DEFAULT_MCP_SERVER_NAME] as CopilotMcpServerConfig;

    assert.equal(typeof server.command, 'string');
    assert.ok(server.command.length > 0);
    assert.ok(Array.isArray(server.args));
    for (const [key, value] of Object.entries(server.env)) {
      assert.equal(typeof key, 'string');
      assert.equal(typeof value, 'string');
    }
  });
});

describe('governanceLabel()', () => {
  const label: GovernanceLabel = governanceLabel();

  it('names the agent as GitHub Copilot', () => {
    assert.equal(label.agent, COPILOT_AGENT_ID);
    assert.equal(label.agent, 'github-copilot');
    assert.ok(label.headline.includes('GitHub Copilot'));
  });

  it('classifies the path as advisory only', () => {
    assert.equal(label.tier, 'advisory_only');
    assert.equal(label.advisory, true);
    assert.equal(label.promptLayerGovernance, 'advisory');
  });

  it('states that prompt-layer governance is advisory only, in those words', () => {
    const statement = label.notGuaranteed.find((s) => s.includes('Prompt-layer governance'));

    assert.ok(statement, 'an explicit advisory-only statement is required');
    assert.match(statement, /advisory only/i);
    assert.match(statement, /ignore/i);
  });

  it('states that pins are not byte-enforced at the transport layer', () => {
    const statement = label.notGuaranteed.find((s) => s.includes('byte-enforced'));

    assert.ok(statement, 'an explicit transport-layer statement is required');
    assert.match(statement, /not byte-enforced at the transport layer/i);
  });

  it('never claims byte enforcement or hook enforcement', () => {
    assert.equal(label.transportByteEnforcement, false);
    assert.equal(label.hookEnforcement, false);
    assert.equal(compareGuarantees(COPILOT_AGENT_ID).byteEnforcedAtTransport, false);
  });

  it('disclaims enforcement in every sentence that mentions it', () => {
    for (const statement of label.statements) {
      if (AFFIRMATIVE_ENFORCEMENT.test(statement)) {
        assert.match(
          statement,
          NEGATION,
          `sentence asserts a guarantee without a negation: ${statement}`,
        );
      }
    }
  });

  it('never asserts enforcement in the affirmative guarantee list', () => {
    for (const guarantee of label.guarantees) {
      assert.equal(
        /\b(enforc\w*|guarantee\w*)\b/i.test(guarantee),
        false,
        `guarantee list must not claim enforcement: ${guarantee}`,
      );
    }
  });

  it('phrases every non-guarantee as an explicit absence', () => {
    assert.ok(label.notGuaranteed.length >= 5);
    for (const statement of label.notGuaranteed) {
      assert.match(statement, NEGATION, `not-guarantee is not phrased as an absence: ${statement}`);
    }
  });

  it('names the hook-capable agents it is weaker than', () => {
    assert.ok(label.weakerThan.includes('claude-code'));
    assert.ok(label.weakerThan.includes('gemini-cli'));
    assert.ok(label.weakerThan.includes('cursor'));
    for (const agent of label.weakerThan) {
      assert.equal(
        compareGuarantees(agent).rank > label.rank,
        true,
        `${agent} must rank above copilot`,
      );
    }
  });

  it('says explicitly that the guarantees are weaker than a hook-capable agent', () => {
    const statement = label.notGuaranteed.find((s) => s.includes('strictly weaker'));

    assert.ok(statement);
    assert.match(statement, /weaker than those on a hook-capable agent/i);
  });

  it('admits the client never echoes the system prompt, so drift is undetectable', () => {
    const echo = label.notGuaranteed.find((s) => s.includes('echoing the system prompt'));

    assert.ok(echo);
    assert.match(echo, /cannot run/i);

    const drift = label.notGuaranteed.find((s) => s.includes('pin_missing_pre_apply'));
    assert.ok(drift);
    assert.match(drift, /undetectable/i);
  });

  it('admits that policy enforcement levels cannot fire without a hook surface', () => {
    const statement = label.notGuaranteed.find((s) => s.includes('block, rewrite, log'));

    assert.ok(statement);
    assert.match(statement, /cannot fire/i);
    assert.match(statement, /no hook surface/i);
  });

  it('still lists what the path genuinely provides', () => {
    assert.ok(label.guarantees.length >= 3);
    assert.ok(label.guarantees.some((g) => g.includes('ctx_get_task')));
    assert.ok(label.guarantees.some((g) => g.includes('reversible')));
  });

  it('carries a one-sentence notice that says advisory only', () => {
    assert.match(label.notice, /advisory only/i);
    assert.match(label.notice, /no/i);
    assert.equal(label.notice.split('.').filter((s) => s.trim().length > 0).length, 1);
  });

  it('renders a text block that leads with the headline and both lists', () => {
    assert.ok(label.text.startsWith(label.headline));
    assert.ok(label.text.includes('advisory_only'));
    assert.ok(label.text.includes('What this path DOES guarantee:'));
    assert.ok(label.text.includes('What this path does NOT guarantee:'));
    assert.ok(label.text.includes('claude-code'));
  });

  it('is deterministic and frozen', () => {
    const again = governanceLabel();

    assert.deepEqual(again, label);
    assert.equal(again.text, label.text);
    assert.equal(Object.isFrozen(label), true);
  });

  it('agrees with compareGuarantees for the same agent', () => {
    const copilot = compareGuarantees(COPILOT_AGENT_ID);

    assert.equal(copilot.tier, label.tier);
    assert.equal(copilot.rank, label.rank);
    assert.equal(copilot.pinEnforcement, 'advisory');
  });
});

describe('compareGuarantees()', () => {
  it('returns advisory_only for GitHub Copilot', () => {
    const copilot = compareGuarantees(COPILOT_AGENT_ID);

    assert.equal(copilot.known, true);
    assert.equal(copilot.tier, 'advisory_only');
    assert.equal(copilot.rank, rankGuarantee('advisory_only'));
    assert.equal(copilot.rank, 1);
  });

  it('returns hook_enforced for claude-code', () => {
    const claude = compareGuarantees('claude-code');

    assert.equal(claude.known, true);
    assert.equal(claude.tier, 'hook_enforced');
    assert.equal(claude.hooks, true);
    assert.equal(claude.rank, 3);
  });

  it('ranks Copilot below every hook-capable agent', () => {
    const copilot = compareGuarantees('copilot');
    const hookCapable = ['claude-code', 'gemini-cli', 'cursor'];

    for (const agent of hookCapable) {
      const other = compareGuarantees(agent);
      assert.equal(other.tier, 'hook_enforced');
      assert.equal(
        copilot.rank < other.rank,
        true,
        `copilot (${copilot.rank}) must rank below ${agent} (${other.rank})`,
      );
    }
  });

  it('ranks Copilot below the transport-enforced agents it sits near', () => {
    const copilot = compareGuarantees('copilot');

    for (const agent of ['aider', 'cline', 'roo', 'copilot-api', 'openwebui']) {
      const other = compareGuarantees(agent);
      assert.equal(other.tier, 'transport_enforced');
      assert.equal(copilot.rank < other.rank, true, `copilot must rank below ${agent}`);
    }
  });

  it('resolves the copilot alias to the same record as the canonical id', () => {
    // `query` is the only field allowed to differ: it echoes the caller's input.
    const { query: _query, ...canonical } = compareGuarantees('github-copilot');

    for (const alias of ['copilot', 'Copilot', '  COPILOT  ', 'github_copilot', 'GitHub Copilot', 'vscode-copilot']) {
      const { query, ...resolved } = compareGuarantees(alias);
      assert.equal(query, alias, `query should be echoed verbatim: ${alias}`);
      assert.deepEqual(resolved, canonical, `alias failed: ${alias}`);
    }
  });

  it('normalizes case, whitespace and underscores', () => {
    assert.equal(compareGuarantees('Claude_Code').agent, 'claude-code');
    assert.equal(compareGuarantees('GEMINI CLI').agent, 'gemini-cli');
    assert.equal(compareGuarantees('  Roo-Code ').agent, 'roo');
  });

  it('echoes the raw query back to the caller', () => {
    assert.equal(compareGuarantees('Copilot').query, 'Copilot');
    assert.equal(compareGuarantees('Copilot').agent, 'github-copilot');
  });

  it('handles an unknown agent without throwing', () => {
    const unknown = compareGuarantees('not-an-agent');

    assert.doesNotThrow(() => compareGuarantees('not-an-agent'));
    assert.equal(unknown.known, false);
    assert.equal(unknown.tier, 'none');
    assert.equal(unknown.rank, rankGuarantee('none'));
    assert.equal(unknown.rank, 0);
    assert.equal(unknown.pinEnforcement, 'none');
    assert.match(unknown.summary, /Unknown agent/);
  });

  it('ranks an unknown agent below Copilot', () => {
    assert.equal(
      compareGuarantees('not-an-agent').rank < compareGuarantees('copilot').rank,
      true,
    );
  });

  it('derives pin enforcement from the tier rather than storing it', () => {
    const expectations = [
      ['claude-code', 'enforced'],
      ['gemini-cli', 'enforced'],
      ['aider', 'enforced'],
      ['copilot', 'advisory'],
      ['not-an-agent', 'none'],
    ] as const;

    for (const [agent, expected] of expectations) {
      assert.equal(compareGuarantees(agent).pinEnforcement, expected, agent);
    }
  });

  it('derives byte enforcement at the transport layer from the tier', () => {
    assert.equal(compareGuarantees('copilot').byteEnforcedAtTransport, false);
    assert.equal(compareGuarantees('claude-code').byteEnforcedAtTransport, true);
    assert.equal(compareGuarantees('aider').byteEnforcedAtTransport, true);
    assert.equal(compareGuarantees('not-an-agent').byteEnforcedAtTransport, false);
  });

  it('marks inbound corruption as undetectable for the non-echoing Copilot path', () => {
    assert.equal(compareGuarantees('copilot').detectsInboundCorruption, false);
    assert.equal(compareGuarantees('claude-code').detectsInboundCorruption, true);
    assert.equal(compareGuarantees('aider').detectsInboundCorruption, true);
  });

  it('records the mechanism each agent is reachable through', () => {
    const copilot = compareGuarantees('copilot');

    assert.equal(copilot.mcp, true);
    assert.equal(copilot.proxy, false);
    assert.equal(copilot.hooks, false);

    const claude = compareGuarantees('claude-code');
    assert.equal(claude.mcp, true);
    assert.equal(claude.proxy, true);
    assert.equal(claude.hooks, true);
  });

  it('distinguishes the Copilot API path from the VS Code extension', () => {
    assert.equal(compareGuarantees('copilot-api').tier, 'transport_enforced');
    assert.equal(compareGuarantees('copilot-cli').agent, 'copilot-api');
    assert.equal(
      compareGuarantees('copilot-api').rank > compareGuarantees('copilot').rank,
      true,
    );
  });

  it('gives every known agent a one-line, non-empty summary', () => {
    for (const agent of knownAgents()) {
      const record = compareGuarantees(agent);
      assert.equal(record.known, true, agent);
      assert.ok(record.summary.length > 20, `${agent} summary is too thin`);
    }
  });

  it('orders GUARANTEE_ORDER weakest to strongest', () => {
    assert.deepEqual([...GUARANTEE_ORDER], [
      'none',
      'advisory_only',
      'transport_enforced',
      'hook_enforced',
    ]);
    for (let i = 1; i < GUARANTEE_ORDER.length; i += 1) {
      assert.equal(rankGuarantee(GUARANTEE_ORDER[i]!) > rankGuarantee(GUARANTEE_ORDER[i - 1]!), true);
    }
  });

  it('lists copilot in the known agents', () => {
    const agents = knownAgents();

    assert.ok(agents.includes(COPILOT_AGENT_ID));
    assert.deepEqual([...agents], [...agents].sort());
  });
});
