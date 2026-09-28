import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import YAML from 'yaml';

import {
  AGENT_IDS,
  MCP_TOOLS,
  DEFAULT_GATEWAY_URL,
  DEFAULT_API_KEY_ENV,
  DEFAULT_PRE_COMMIT_COMMAND,
  UnknownAgentError,
  isLoopbackGatewayUrl,
  isSupportedAgent,
  buildProfile,
  launchRecipe,
  missingEnvVars,
  type AgentId,
  type AgentProfile,
  type AiderProfileDocument,
  type ClineProfileDocument,
  type RooProfileDocument,
  type LaunchRecipe,
} from '../src/profiles.js';

// --- inline fixtures -------------------------------------------------------

const PROXY = 'http://127.0.0.1:8787';
const PROXY_V1 = `${PROXY}/v1`;

/** Stand-in for a real key: if this string ever appears in an output, we leaked. */
const FAKE_SECRET = 'sk-live-Zx91-notARealKey-doNotLeak-0000';
const FAKE_UPSTREAM_SECRET = 'sk-ant-FaKeUpstreamKey-1111';

const DIRECT_PROVIDER_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'openrouter.ai',
  'localhost:11434',
  '127.0.0.1:11434',
];

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}/,
  /Bearer\s+\S/i,
  /"(?:api_?key|token|secret|password)"\s*:\s*"[^"$][^"]*"/i,
  /x-api-key\s*[:=]\s*\S/i,
];

const assertNoSecrets = (label: string, output: string): void => {
  for (const pattern of SECRET_PATTERNS) {
    assert.equal(pattern.test(output), false, `${label} matched a secret pattern ${pattern}`);
  }
  assert.equal(output.includes(FAKE_SECRET), false, `${label} contained the injected credential`);
  assert.equal(output.includes(FAKE_UPSTREAM_SECRET), false, `${label} contained an upstream credential`);
  assert.equal(output.includes(FAKE_SECRET.slice(0, 16)), false, `${label} leaked a credential prefix`);
};

const asAider = (profile: AgentProfile): AiderProfileDocument => YAML.parse(profile.content) as AiderProfileDocument;
const asJson = <T>(profile: AgentProfile): T => JSON.parse(profile.content) as T;

const mcpEntry = (doc: { readonly mcpServers: Readonly<Record<string, { command: string; args: readonly string[] }>> }): { command: string; args: readonly string[] } => {
  const entry = doc.mcpServers['strata'];
  assert.ok(entry, 'expected a `strata` MCP server entry');
  return entry;
};

// Credentials are set in the environment on purpose: every builder must be
// pure enough that even a live-looking value in scope changes nothing.
before(() => {
  process.env['STRATA_PROXY_API_KEY'] = FAKE_SECRET;
  process.env['OPENAI_API_KEY'] = FAKE_UPSTREAM_SECRET;
  process.env['ANTHROPIC_API_KEY'] = FAKE_UPSTREAM_SECRET;
});

after(() => {
  delete process.env['STRATA_PROXY_API_KEY'];
  delete process.env['OPENAI_API_KEY'];
  delete process.env['ANTHROPIC_API_KEY'];
});

const UNKNOWN = 'cursor' as AgentId;

// --- buildProfile ----------------------------------------------------------

describe('buildProfile / aider', () => {
  it('targets .aider.conf.yml in YAML format', () => {
    const profile = buildProfile('aider');
    assert.equal(profile.agent, 'aider');
    assert.equal(profile.format, 'yaml');
    assert.equal(profile.fileName, '.aider.conf.yml');
    assert.equal(profile.targetPath, '.aider.conf.yml');
    assert.equal(profile.requiredEnv.length, 1);
  });

  it('emits a .aider.conf.yml body that parses as a YAML mapping', () => {
    const content = buildProfile('aider').content;
    const parsed = YAML.parse(content);
    assert.equal(typeof parsed, 'object');
    assert.ok(parsed !== null && !Array.isArray(parsed));
    assert.deepEqual(
      Object.keys(parsed as AiderProfileDocument).sort(),
      ['editor-model', 'model', 'openai-api-base', 'pre-commit', 'weak-model'],
    );
  });

  it('points openai-api-base at the gateway /v1 surface', () => {
    const doc = asAider(buildProfile('aider'));
    assert.equal(doc['openai-api-base'], PROXY_V1);
  });

  it('wires the model trio through the proxy', () => {
    const doc = asAider(buildProfile('aider'));
    assert.equal(doc.model, 'openai/gpt-4o');
    assert.equal(doc['weak-model'], 'openai/gpt-4o-mini');
    assert.equal(doc['editor-model'], 'openai/gpt-4o');
  });

  it('declares a pre-commit check command', () => {
    const doc = asAider(buildProfile('aider'));
    assert.ok(Array.isArray(doc['pre-commit']));
    assert.deepEqual(doc['pre-commit'], [DEFAULT_PRE_COMMIT_COMMAND]);
  });

  it('pre-commit is overridable', () => {
    const doc = asAider(buildProfile('aider', { preCommitCommand: 'npm run lint' }));
    assert.deepEqual(doc['pre-commit'], ['npm run lint']);
  });

  it('keeps the header comment parseable YAML', () => {
    const content = buildProfile('aider').content;
    assert.ok(content.startsWith('# strata-ctx governed profile'));
    assert.ok(YAML.parse(content));
  });

  it('is deterministic across calls', () => {
    assert.equal(buildProfile('aider').content, buildProfile('aider').content);
  });
});

describe('buildProfile / cline', () => {
  it('targets cline_mcp_settings.json in JSON format', () => {
    const profile = buildProfile('cline');
    assert.equal(profile.agent, 'cline');
    assert.equal(profile.format, 'json');
    assert.equal(profile.fileName, '.cline/cline_mcp_settings.json');
    assert.equal(profile.targetPath, '.cline/cline_mcp_settings.json');
  });

  it('emits valid, pretty-printed JSON with a trailing newline', () => {
    const content = buildProfile('cline').content;
    assert.ok(content.endsWith('\n'));
    assert.ok(content.includes('\n  "mcpServers"'));
    assert.doesNotThrow(() => JSON.parse(content));
  });

  it('registers the strata MCP server command against the gateway', () => {
    const doc = asJson<ClineProfileDocument>(buildProfile('cline'));
    const entry = mcpEntry(doc);
    assert.equal(entry.command, 'strata-ctx');
    assert.deepEqual(entry.args, ['mcp', 'serve', '--gateway', PROXY]);
  });

  it('auto-approves exactly the six shared MCP tools', () => {
    const doc = asJson<ClineProfileDocument>(buildProfile('cline'));
    const entry = doc.mcpServers['strata'];
    assert.ok(entry);
    assert.equal(entry.disabled, false);
    assert.deepEqual(entry.autoApprove, [...MCP_TOOLS]);
  });

  it('declares an openai-compatible provider bound to the gateway', () => {
    const doc = asJson<ClineProfileDocument>(buildProfile('cline'));
    const provider = doc.strata.openAiCompatibleProvider;
    assert.equal(provider.provider, 'openai-compatible');
    assert.equal(provider.baseUrl, PROXY_V1);
    assert.equal(provider.apiKeyProvider, 'none');
    assert.equal(provider.apiKeyEnv, DEFAULT_API_KEY_ENV);
    assert.equal(doc.strata.gatewayUrl, PROXY);
    assert.equal(doc.strata.requireGateway, true);
  });

  it('is deterministic across calls', () => {
    assert.equal(buildProfile('cline').content, buildProfile('cline').content);
  });
});

describe('buildProfile / roo', () => {
  it('targets a strata-owned roo config in JSON format', () => {
    const profile = buildProfile('roo');
    assert.equal(profile.agent, 'roo');
    assert.equal(profile.format, 'json');
    assert.equal(profile.fileName, '.roo/strata.json');
    assert.equal(profile.targetPath, '.roo/strata.json');
  });

  it('emits valid JSON', () => {
    assert.doesNotThrow(() => JSON.parse(buildProfile('roo').content));
  });

  it('declares an openai-compatible provider profile bound to the gateway', () => {
    const doc = asJson<RooProfileDocument>(buildProfile('roo'));
    const profile = doc.strata.providerProfile;
    assert.equal(profile.provider, 'openai-compatible');
    assert.equal(profile.baseUrl, PROXY_V1);
    assert.equal(profile.apiKeyProvider, 'none');
    assert.equal(profile.apiKeyEnv, DEFAULT_API_KEY_ENV);
    assert.equal(profile.model, 'openai/gpt-4o');
    assert.equal(doc.strata.gatewayUrl, PROXY);
    assert.equal(doc.strata.requireGateway, true);
  });

  it('ships exactly one custom mode and grounds it in the gateway', () => {
    const doc = asJson<RooProfileDocument>(buildProfile('roo'));
    assert.equal(doc.customModes.length, 1);
    const mode = doc.customModes[0];
    assert.ok(mode);
    assert.equal(mode.slug, 'strata-governed');
    assert.ok(mode.roleDefinition.includes(PROXY));
    assert.ok(mode.groups.includes('read'));
    assert.ok(mode.customInstructions.length > 0);
    assert.ok(mode.whenToUse.length > 0);
  });

  it('registers the strata MCP server against the gateway', () => {
    const doc = asJson<RooProfileDocument>(buildProfile('roo'));
    const entry = mcpEntry(doc);
    assert.equal(entry.command, 'strata-ctx');
    assert.deepEqual(entry.args, ['mcp', 'serve', '--gateway', PROXY]);
  });

  it('is deterministic across calls', () => {
    assert.equal(buildProfile('roo').content, buildProfile('roo').content);
  });
});

describe('buildProfile / governance invariants', () => {
  it('routes every profile through the proxy', () => {
    for (const agent of AGENT_IDS) {
      const profile = buildProfile(agent);
      assert.ok(profile.content.includes(PROXY), `${agent} profile does not mention the gateway`);
      assert.equal(profile.gatewayUrl, PROXY);
    }
  });

  it('defaults to the documented loopback gateway', () => {
    assert.equal(DEFAULT_GATEWAY_URL, PROXY);
    assert.equal(buildProfile('aider').gatewayUrl, DEFAULT_GATEWAY_URL);
    assert.equal(launchRecipe('roo').gatewayUrl, DEFAULT_GATEWAY_URL);
  });

  it('leaves no direct provider endpoint in any profile', () => {
    for (const agent of AGENT_IDS) {
      const content = buildProfile(agent).content;
      for (const host of DIRECT_PROVIDER_HOSTS) {
        assert.equal(content.includes(host), false, `${agent} profile reaches ${host} directly`);
      }
    }
  });

  it('emits no secrets in any profile', () => {
    for (const agent of AGENT_IDS) {
      assertNoSecrets(`${agent} profile`, buildProfile(agent).content);
    }
  });

  it('emits no secret in the serialised profile record either', () => {
    for (const agent of AGENT_IDS) {
      assertNoSecrets(`${agent} profile record`, JSON.stringify(buildProfile(agent)));
    }
  });

  it('honours a custom loopback gateway', () => {
    const profile = buildProfile('aider', { gatewayUrl: 'http://localhost:9999' });
    assert.equal(profile.gatewayUrl, 'http://localhost:9999');
    assert.ok(profile.content.includes('http://localhost:9999/v1'));
    assert.equal(profile.content.includes(PROXY), false);
  });

  it('normalises a trailing slash on the gateway url', () => {
    assert.equal(buildProfile('cline', { gatewayUrl: 'http://127.0.0.1:8787///' }).gatewayUrl, PROXY);
  });

  it('honours a custom root directory', () => {
    assert.equal(buildProfile('aider', { rootDir: 'apps/api' }).targetPath, 'apps/api/.aider.conf.yml');
    assert.equal(buildProfile('roo', { rootDir: 'apps/api/' }).targetPath, 'apps/api/.roo/strata.json');
    assert.equal(buildProfile('aider', { rootDir: '.' }).targetPath, '.aider.conf.yml');
  });

  it('keeps targetPath and configPath in step across builder and recipe', () => {
    for (const agent of AGENT_IDS) {
      assert.equal(launchRecipe(agent, { rootDir: 'w' }).configPath, buildProfile(agent, { rootDir: 'w' }).targetPath);
    }
  });

  it('throws for an unknown agent', () => {
    assert.throws(() => buildProfile(UNKNOWN), UnknownAgentError);
    assert.throws(() => buildProfile(UNKNOWN), /Unknown agent "cursor"/);
  });

  it('names the supported agents in the error', () => {
    try {
      buildProfile(UNKNOWN);
      assert.fail('expected a throw');
    } catch (error) {
      assert.ok(error instanceof UnknownAgentError);
      assert.equal(error.agent, UNKNOWN);
      assert.ok(error.message.includes('aider'));
      assert.ok(error.message.includes('cline'));
      assert.ok(error.message.includes('roo'));
    }
  });

  it('rejects a non-loopback gateway url', () => {
    assert.throws(() => buildProfile('aider', { gatewayUrl: 'https://api.openai.com/v1' }), /loopback/);
  });

  it('rejects a gateway url carrying credentials', () => {
    assert.throws(() => buildProfile('aider', { gatewayUrl: 'http://user:pass@127.0.0.1:8787' }), /loopback/);
  });

  it('rejects a shell-metacharacter model', () => {
    assert.throws(() => buildProfile('aider', { model: 'gpt-4o; rm -rf /' }), /shell-safe token/);
  });

  it('rejects a shell-metacharacter pre-commit command', () => {
    assert.throws(() => buildProfile('aider', { preCommitCommand: 'lint && curl evil.test' }), /metacharacters/);
  });

  it('rejects a malformed api key env name', () => {
    assert.throws(() => buildProfile('cline', { apiKeyEnv: 'KEY; export X=1' }), /env var name/);
  });

  it('classifies agents and gateway urls', () => {
    assert.equal(isSupportedAgent('aider'), true);
    assert.equal(isSupportedAgent('roo'), true);
    assert.equal(isSupportedAgent(UNKNOWN), false);
    assert.equal(isSupportedAgent(7), false);
    assert.equal(isLoopbackGatewayUrl(PROXY), true);
    assert.equal(isLoopbackGatewayUrl('http://[::1]:8787'), true);
    assert.equal(isLoopbackGatewayUrl('https://127.0.0.1:8787'), false);
    assert.equal(isLoopbackGatewayUrl('not a url'), false);
  });
});

// --- launchRecipe ----------------------------------------------------------

describe('launchRecipe', () => {
  it('returns an argv array, never a shell string', () => {
    for (const agent of AGENT_IDS) {
      const recipe = launchRecipe(agent);
      assert.ok(Array.isArray(recipe.argv), `${agent} argv is not an array`);
      for (const part of recipe.argv) {
        assert.equal(typeof part, 'string');
      }
    }
  });

  it('spawns the agent directly - no shell interpreter in argv', () => {
    for (const agent of AGENT_IDS) {
      const argv = launchRecipe(agent).argv;
      assert.equal(argv[0], launchRecipe(agent).executable);
      assert.equal(argv.includes('sh'), false);
      assert.equal(argv.includes('bash'), false);
      assert.equal(argv.includes('-c'), false);
      assert.equal(argv.includes('--eval'), false);
    }
  });

  it('keeps argv free of shell metacharacters (no injection surface)', () => {
    const meta = /[;&|`$<>\n\r]/;
    for (const agent of AGENT_IDS) {
      for (const part of launchRecipe(agent).argv) {
        assert.equal(meta.test(part), false, `${agent} argv element carries metacharacters: ${part}`);
      }
    }
  });

  it('passes one argv element per argument (no embedded spaces)', () => {
    const argv = launchRecipe('aider').argv;
    assert.deepEqual(argv, [
      'aider',
      '--config',
      '.aider.conf.yml',
      '--model',
      'openai/gpt-4o',
      '--openai-api-base',
      PROXY_V1,
      '--yes',
      '--no-check-update',
    ]);
  });

  it('points aider at the gateway on the command line as well as the config', () => {
    const argv = launchRecipe('aider', { gatewayUrl: PROXY }).argv;
    const flag = argv.indexOf('--openai-api-base');
    assert.ok(flag > 0);
    assert.equal(argv[flag + 1], PROXY_V1);
  });

  it('points the cline bridge at loopback with a numeric port', () => {
    const argv = launchRecipe('cline', { host: '127.0.0.1', port: 4000 }).argv;
    assert.deepEqual(argv, ['cline', 'serve', '--config', '.cline/cline_mcp_settings.json', '--host', '127.0.0.1', '--port', '4000']);
  });

  it('points the roo bridge at its own config', () => {
    const argv = launchRecipe('roo').argv;
    assert.equal(argv[0], 'roo');
    assert.equal(argv[argv.indexOf('--config') + 1], '.roo/strata.json');
  });

  it('serves the gateway to the agent environment, not the provider', () => {
    for (const agent of AGENT_IDS) {
      const recipe = launchRecipe(agent);
      assert.equal(recipe.env.fixed['STRATA_GATEWAY_URL'], PROXY);
      assert.equal(recipe.gatewayUrl, PROXY);
      assert.equal(recipe.governance, 'enforced');
    }
  });

  it('names the credential source env var instead of inlining it', () => {
    for (const agent of AGENT_IDS) {
      const recipe = launchRecipe(agent);
      assert.deepEqual(recipe.env.from, { OPENAI_API_KEY: DEFAULT_API_KEY_ENV });
      assert.deepEqual(recipe.env.required, [DEFAULT_API_KEY_ENV]);
    }
  });

  it('keeps the credential out of argv', () => {
    for (const agent of AGENT_IDS) {
      const argv = launchRecipe(agent).argv;
      assert.equal(argv.join(' ').includes('sk-'), false);
      assert.equal(argv.some((part) => part === FAKE_SECRET), false);
    }
  });

  it('emits no secrets anywhere in the recipe', () => {
    for (const agent of AGENT_IDS) {
      assertNoSecrets(`${agent} recipe`, JSON.stringify(launchRecipe(agent)));
    }
  });

  it('is deterministic', () => {
    for (const agent of AGENT_IDS) {
      assert.deepEqual(launchRecipe(agent), launchRecipe(agent));
    }
  });

  it('honours a custom api key env name without reading it', () => {
    const recipe = launchRecipe('cline', { apiKeyEnv: 'MY_GATEWAY_KEY' });
    assert.deepEqual(recipe.env.from, { OPENAI_API_KEY: 'MY_GATEWAY_KEY' });
    assert.deepEqual(recipe.env.required, ['MY_GATEWAY_KEY']);
    assert.equal(JSON.stringify(recipe).includes(FAKE_SECRET), false);
  });

  it('rejects an out-of-range port', () => {
    assert.throws(() => launchRecipe('cline', { port: 0 }), /1\.\.65535/);
    assert.throws(() => launchRecipe('cline', { port: 70000 }), /1\.\.65535/);
  });

  it('rejects a non-loopback bridge host', () => {
    assert.throws(() => launchRecipe('roo', { host: '0.0.0.0' }), /loopback host/);
  });

  it('throws for an unknown agent', () => {
    assert.throws(() => launchRecipe(UNKNOWN), UnknownAgentError);
  });
});

describe('missingEnvVars', () => {
  const recipe: LaunchRecipe = launchRecipe('aider');

  it('is empty when the source variable is set', () => {
    assert.deepEqual(missingEnvVars(recipe, { STRATA_PROXY_API_KEY: 'whatever' }), []);
  });

  it('reports the name of an unset source variable', () => {
    assert.deepEqual(missingEnvVars(recipe, {}), [DEFAULT_API_KEY_ENV]);
  });

  it('treats a blank value as unset', () => {
    assert.deepEqual(missingEnvVars(recipe, { STRATA_PROXY_API_KEY: '   ' }), [DEFAULT_API_KEY_ENV]);
  });

  it('returns names only - never a value', () => {
    const names = missingEnvVars(recipe, { STRATA_PROXY_API_KEY: '   ' });
    for (const name of names) {
      assert.ok(recipe.env.required.includes(name));
      assert.equal(name.includes('sk-'), false);
    }
    assert.equal(JSON.stringify(names).includes(FAKE_SECRET), false);
  });

  it('reads the environment it is handed, not process.env', () => {
    assert.deepEqual(missingEnvVars(recipe, {}), [DEFAULT_API_KEY_ENV]);
  });
});
