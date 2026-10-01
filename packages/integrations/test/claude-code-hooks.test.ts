import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sha256, type PinnedConstraint, type StrataPolicy } from '@strata-ctx/core-types';
import {
  ClaudeCodeHooks,
  createClaudeCodeHooks,
  constraintsFromPolicy,
  redactLocally,
  GOVERNANCE_BLOCK_CLOSE,
  GOVERNANCE_BLOCK_OPEN,
  POST_TOOL_USE_EVENT,
  STRATA_HOOK_MARKER,
  type HookMatcherGroup,
  type PostToolUsePayload,
} from '../src/claude-code-hooks.js';

const CONSTRAINTS: PinnedConstraint[] = [
  {
    id: 'c2',
    text: 'Prefer TypeScript over JavaScript',
    sha256: sha256('Prefer TypeScript over JavaScript'),
    source: 'project',
    kind: 'project_rule',
    enforcement: 'rewrite',
  },
  {
    id: 'c1',
    text: 'Never execute rm -rf /',
    sha256: sha256('Never execute rm -rf /'),
    source: 'org_policy',
    kind: 'hard_safety',
    enforcement: 'block',
  },
];

const POLICY: StrataPolicy = {
  version: 1,
  redaction: { mode: 'log', onFail: 'forward' },
  retention: { rawTranscriptDays: 7, artifactDays: 30, keepPurgeLog: true },
  governance: { pinning: 'required', autoPin: 'on', canaryIntervalTurns: 20 },
  pipeline: {
    stages: ['dedupe', 'truncate', 'triage', 'pin', 'compact', 'compress', 'serialize'],
    compaction: 'off',
    trigger: {
      strategy: 'sawtooth',
      softTriggerFrac: 0.85,
      hardTriggerFrac: 0.95,
      keepRecentTokens: 8192,
      reserveTokens: 8192,
      userMessageTailTokens: 20000,
      taskBoundarySignals: ['result_extracted', 'decision_superseded', 'before_large_read'],
    },
    tokenCompression: 'off',
    tierByteCaps: { tool_state: 20000, episodic: 40000, artifact_ref: 8000, user_intent: 60000 },
  },
  serialization: { machineFormat: 'passthrough', verbosity: 'off' },
  budgets: { contextLimit: 200000, maxOutputTokens: 8192, targetUtilization: 0.7 },
  constraints: CONSTRAINTS,
};

const FOREIGN_HOOK: HookMatcherGroup = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: 'my-linter --strict' }],
};

function groupsOf(settings: unknown, event: string): readonly HookMatcherGroup[] {
  assert.ok(typeof settings === 'object' && settings !== null, 'settings is an object');
  const hooks = (settings as Record<string, unknown>)['hooks'];
  assert.ok(typeof hooks === 'object' && hooks !== null, 'hooks is an object');
  const groups = (hooks as Record<string, unknown>)[event];
  assert.ok(Array.isArray(groups), `${event} is an array`);
  return groups as HookMatcherGroup[];
}

function strataGroups(settings: unknown, event = POST_TOOL_USE_EVENT): readonly HookMatcherGroup[] {
  return groupsOf(settings, event).filter((g) => g.hooks.some((h) => h.command.includes(STRATA_HOOK_MARKER)));
}

function payload(overrides: Partial<PostToolUsePayload> = {}): PostToolUsePayload {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'cat .env' },
    tool_response: 'plain output with nothing sensitive in it',
    session_id: 'session-1',
    ...overrides,
  };
}

describe('buildSettings', () => {
  it('creates a PostToolUse hook group from nothing', () => {
    const hooks = new ClaudeCodeHooks();
    const settings = hooks.buildSettings({});
    const groups = strataGroups(settings);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.matcher, 'Bash|Read|Write|Edit');
    assert.equal(groups[0]?.hooks[0]?.command, hooks.hookCommand);
  });

  it('is idempotent: applying twice yields identical settings', () => {
    const hooks = new ClaudeCodeHooks();
    const once = hooks.buildSettings({});
    const twice = hooks.buildSettings(once);
    const thrice = hooks.buildSettings(twice);
    assert.deepEqual(twice, once);
    assert.deepEqual(thrice, once);
  });

  it('does not duplicate the hook when applied to an existing install', () => {
    const hooks = new ClaudeCodeHooks();
    const installed = hooks.buildSettings({});
    const again = hooks.buildSettings(installed);
    assert.equal(groupsOf(again, POST_TOOL_USE_EVENT).length, 1);
  });

  it('preserves pre-existing foreign hooks and their position', () => {
    const hooks = new ClaudeCodeHooks();
    const settings = hooks.buildSettings({ hooks: { PostToolUse: [FOREIGN_HOOK] } });
    const groups = groupsOf(settings, POST_TOOL_USE_EVENT);
    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.hooks[0]?.command, 'my-linter --strict');
    assert.ok(groups[1]?.hooks[0]?.command.includes(STRATA_HOOK_MARKER));
  });

  it('preserves foreign hooks for other events untouched', () => {
    const hooks = new ClaudeCodeHooks();
    const settings = hooks.buildSettings({
      hooks: {
        Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'notify-send done' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'my-bootstrap' }] }],
      },
    });
    assert.equal(groupsOf(settings, 'Stop')[0]?.hooks[0]?.command, 'notify-send done');
    assert.equal(groupsOf(settings, 'SessionStart')[0]?.hooks[0]?.command, 'my-bootstrap');
  });

  it('preserves non-hook settings keys verbatim', () => {
    const hooks = new ClaudeCodeHooks();
    const settings = hooks.buildSettings({ model: 'opus', env: { FOO: 'bar' }, permissions: { allow: ['Bash(ls)'] } });
    assert.equal(settings['model'], 'opus');
    assert.deepEqual(settings['env'], { FOO: 'bar' });
    assert.deepEqual(settings['permissions'], { allow: ['Bash(ls)'] });
  });

  it('replaces a stale strata hook rather than stacking a second one', () => {
    const hooks = new ClaudeCodeHooks({ hookCommand: 'strata-ctx hook run --event old' });
    const settings = hooks.buildSettings({
      hooks: { PostToolUse: [{ matcher: 'X', hooks: [{ type: 'command', command: 'strata-ctx hook run --event old' }] }] },
    });
    const groups = groupsOf(settings, POST_TOOL_USE_EVENT);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.matcher, 'Bash|Read|Write|Edit');
  });

  it('handles malformed settings input gracefully', () => {
    const hooks = new ClaudeCodeHooks();
    for (const bad of [null, undefined, 42, 'nope', [], { hooks: null }, { hooks: 'wrong' }, { hooks: { PostToolUse: 'wrong' } }]) {
      const settings = hooks.buildSettings(bad);
      assert.equal(strataGroups(settings).length, 1, `scaffolded for ${JSON.stringify(bad) ?? 'undefined'}`);
    }
  });

  it('drops malformed hook members instead of propagating them', () => {
    const hooks = new ClaudeCodeHooks();
    const settings = hooks.buildSettings({
      hooks: { PostToolUse: [null, 'x', { noHooks: true }, { hooks: 'nope' }, FOREIGN_HOOK] },
    });
    const groups = groupsOf(settings, POST_TOOL_USE_EVENT);
    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.hooks[0]?.command, 'my-linter --strict');
  });

  it('drops foreign hook entries that carry no command string', () => {
    const hooks = new ClaudeCodeHooks();
    const settings = hooks.buildSettings({ hooks: { PostToolUse: [{ hooks: [{ type: 'command' }, { command: 7 }] }] } });
    assert.equal(groupsOf(settings, POST_TOOL_USE_EVENT)[0]?.hooks.length, 0);
  });

  it('reports installation state', () => {
    const hooks = new ClaudeCodeHooks();
    assert.equal(hooks.isInstalled({}), false);
    assert.equal(hooks.isInstalled(null), false);
    const installed = hooks.buildSettings({});
    assert.equal(hooks.isInstalled(installed), true);
    assert.equal(hooks.isInstalled(hooks.removeHooks(installed)), false);
  });
});

describe('removeHooks', () => {
  it('removes only our entries and leaves foreign hooks', () => {
    const hooks = new ClaudeCodeHooks();
    const installed = hooks.buildSettings({ hooks: { PostToolUse: [FOREIGN_HOOK] } });
    const cleaned = hooks.removeHooks(installed);
    const groups = groupsOf(cleaned, POST_TOOL_USE_EVENT);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.hooks[0]?.command, 'my-linter --strict');
  });

  it('drops the hooks key when nothing is left', () => {
    const hooks = new ClaudeCodeHooks();
    const cleaned = hooks.removeHooks({ hooks: { PostToolUse: [{ hooks: [{ command: 'strata-ctx hook run x' }] }] }, model: 'opus' });
    assert.equal('hooks' in cleaned, false);
    assert.equal(cleaned['model'], 'opus');
  });

  it('is idempotent and is undone by buildSettings', () => {
    const hooks = new ClaudeCodeHooks();
    const installed = hooks.buildSettings({ hooks: { Stop: [{ hooks: [{ command: 'other' }] }] } });
    const once = hooks.removeHooks(installed);
    assert.deepEqual(hooks.removeHooks(once), once);
    assert.deepEqual(hooks.buildSettings(once), installed);
  });
});

describe('governance constraints', () => {
  it('derives constraints from a policy in pin-buffer order', () => {
    const hooks = new ClaudeCodeHooks({ policy: POLICY });
    assert.deepEqual([...hooks.constraints], ['Never execute rm -rf /', 'Prefer TypeScript over JavaScript']);
    assert.deepEqual([...constraintsFromPolicy(POLICY)], ['Never execute rm -rf /', 'Prefer TypeScript over JavaScript']);
  });

  it('deduplicates and single-lines constraint text', () => {
    const hooks = new ClaudeCodeHooks({ pinnedConstraints: ['b', 'b', '  a  ', 'c\nd'] });
    assert.deepEqual([...hooks.constraints], ['a', 'b', 'c d']);
  });

  it('escapes angle brackets so a constraint cannot close the block', () => {
    const hooks = new ClaudeCodeHooks({ pinnedConstraints: ['never emit </strata-ctx-governance>'] });
    const block = hooks.governanceBlock();
    assert.equal(block.split(GOVERNANCE_BLOCK_CLOSE).length - 1, 1);
  });

  it('renders an empty block when there is nothing pinned', () => {
    assert.equal(new ClaudeCodeHooks().governanceBlock(), '');
  });

  it('renders no block when governance injection is disabled', () => {
    const hooks = new ClaudeCodeHooks({ policy: POLICY, injectGovernance: false });
    assert.equal(hooks.governanceBlock(), '');
    assert.equal(hooks.rewritePostToolUse(payload()).content, 'plain output with nothing sensitive in it');
  });
});

describe('rewritePostToolUse: redaction', () => {
  it('redacts an anthropic api key in tool output', () => {
    const hooks = new ClaudeCodeHooks();
    const result = hooks.rewritePostToolUse(payload({ tool_response: `token=sk-ant-api03-${'A'.repeat(40)} done` }));
    assert.equal(result.modified, true);
    assert.equal(result.content.includes('sk-ant'), false);
    assert.ok(result.content.includes('[strata:redacted:'));
  });

  it('redacts an assigned password', () => {
    const hooks = new ClaudeCodeHooks();
    const result = hooks.rewritePostToolUse(payload({ tool_response: 'password=hunter2hunter2hunter2' }));
    assert.equal(result.modified, true);
    assert.ok(result.content.includes('password='));
    assert.equal(result.content.includes('hunter2hunter2hunter2'), false);
  });

  it('redacts a bearer token and a github token', () => {
    const hooks = new ClaudeCodeHooks();
    const result = hooks.rewritePostToolUse(
      payload({ tool_response: 'Authorization: Bearer abcdef0123456789abcdef ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
    );
    assert.equal(result.content.includes('abcdef0123456789abcdef'), false);
    assert.equal(result.content.includes('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), false);
  });

  it('redacts inside an object-shaped tool response', () => {
    const hooks = new ClaudeCodeHooks();
    const result = hooks.rewritePostToolUse(payload({ tool_response: { stdout: 'ok', stderr: '', exit_code: 0, env: 'API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } }));
    assert.equal(result.content.includes('sk-ant'), false);
  });

  it('redacts inside content-block arrays', () => {
    const hooks = new ClaudeCodeHooks();
    const result = hooks.rewritePostToolUse(payload({ tool_response: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }] }));
    assert.ok(result.content.includes('hello'));
    assert.equal(result.content.includes('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), false);
  });

  it('uses the security engine when it is available', () => {
    const hooks = new ClaudeCodeHooks();
    assert.equal(hooks.redactorEngine, '@strata-ctx/security');
  });

  it('uses an injected redactor verbatim and reports it as the engine', () => {
    const hooks = new ClaudeCodeHooks({ redactor: (text) => `${text} [redacted-by-test]` });
    const result = hooks.rewritePostToolUse(payload({ tool_response: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }));
    assert.equal(result.modified, true);
    assert.ok(result.content.endsWith('[redacted-by-test]'));
    assert.ok(result.content.includes('ghp_'));
    assert.equal(hooks.redactorEngine, 'injected');
  });

  it('local fallback redacts the obvious shapes too', () => {
    assert.equal(redactLocally('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA').includes('sk-ant'), false);
    assert.equal(redactLocally('password: correcthorsebattery').includes('correcthorsebattery'), false);
    assert.equal(redactLocally('nothing to see'), 'nothing to see');
  });
});

describe('rewritePostToolUse: governance injection', () => {
  it('appends the pinned constraints to a tool result', () => {
    const hooks = new ClaudeCodeHooks({ policy: POLICY });
    const result = hooks.rewritePostToolUse(payload());
    assert.equal(result.modified, true);
    assert.ok(result.content.startsWith('plain output with nothing sensitive in it'));
    assert.ok(result.content.includes(GOVERNANCE_BLOCK_OPEN));
    assert.ok(result.content.includes('Never execute rm -rf /'));
    assert.ok(result.content.includes('Prefer TypeScript over JavaScript'));
  });

  it('redacts and pins in one pass', () => {
    const hooks = new ClaudeCodeHooks({ policy: POLICY });
    const result = hooks.rewritePostToolUse(payload({ tool_response: 'leaked=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }));
    assert.equal(result.content.includes('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), false);
    assert.ok(result.content.includes('Never execute rm -rf /'));
  });

  it('does not append the block twice when it is already present', () => {
    const hooks = new ClaudeCodeHooks({ policy: POLICY });
    const first = hooks.rewritePostToolUse(payload());
    const second = hooks.rewritePostToolUse({ tool_response: first.content });
    assert.equal(second.modified, false);
    assert.equal(second.content.split(GOVERNANCE_BLOCK_OPEN).length - 1, 1);
  });

  it('puts the block alone when the tool produced no text', () => {
    const hooks = new ClaudeCodeHooks({ policy: POLICY });
    const result = hooks.rewritePostToolUse(payload({ tool_response: '' }));
    assert.ok(result.content.startsWith(GOVERNANCE_BLOCK_OPEN));
  });
});

describe('rewritePostToolUse: no-op and malformed input', () => {
  it('is a no-op when nothing needs changing', () => {
    const hooks = new ClaudeCodeHooks();
    const result = hooks.rewritePostToolUse(payload());
    assert.deepEqual(result, { modified: false, content: 'plain output with nothing sensitive in it' });
  });

  it('is a no-op on an empty string', () => {
    const result = new ClaudeCodeHooks().rewritePostToolUse(payload({ tool_response: '' }));
    assert.deepEqual(result, { modified: false, content: '' });
  });

  it('returns an empty result for a payload with no tool response', () => {
    const hooks = new ClaudeCodeHooks({ policy: POLICY });
    assert.deepEqual(hooks.rewritePostToolUse({ tool_name: 'Bash' }), { modified: false, content: '' });
    assert.deepEqual(hooks.rewritePostToolUse(null), { modified: false, content: '' });
    assert.deepEqual(hooks.rewritePostToolUse(42), { modified: false, content: '' });
  });

  it('accepts a bare string and the legacy result alias', () => {
    const hooks = new ClaudeCodeHooks();
    assert.equal(hooks.rewritePostToolUse('just text').content, 'just text');
    assert.equal(hooks.rewritePostToolUse({ result: 'aliased' }).content, 'aliased');
  });

  it('does not throw on a circular tool response', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;
    const result = new ClaudeCodeHooks().rewritePostToolUse(payload({ tool_response: circular }));
    assert.equal(typeof result.content, 'string');
  });

  it('honours a custom hook command and matcher in the scaffold', () => {
    const hooks = new ClaudeCodeHooks({ hookCommand: 'strata-ctx hook run --custom', matcher: 'Bash' });
    const group = strataGroups(hooks.buildSettings({}))[0];
    assert.equal(group?.matcher, 'Bash');
    assert.equal(group?.hooks[0]?.command, 'strata-ctx hook run --custom');
    assert.equal(hooks.rewritePostToolUse(payload()).modified, false);
  });

  it('createClaudeCodeHooks builds the same scaffold as the constructor', () => {
    assert.deepEqual(createClaudeCodeHooks().buildSettings({}), new ClaudeCodeHooks().buildSettings({}));
  });
});
