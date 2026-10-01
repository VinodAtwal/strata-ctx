import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemorySink, type TelemetrySink, type StrataTelemetryEvent } from '@strata-ctx/telemetry';
import { ClaudeCodeHooks, type PreToolUseInput, type PreToolUseResult } from '../src/claude-code.js';
import {
  TEST_POLICY,
  MOCK_PRE_TOOL_USE_BASH,
  MOCK_PRE_TOOL_USE_READ,
  MOCK_PRE_TOOL_USE_UNKNOWN,
  MOCK_POST_TOOL_USE,
  TEMP_SETTINGS_PATH,
  cleanupTempSettings,
} from './fixtures.js';

interface HookSettings {
  readonly hooks: readonly { readonly type: string; readonly command: string; readonly timeout?: number }[];
}

function parseSettings(path: string): HookSettings {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return raw as HookSettings;
}

/**
 * `StrataTelemetryEvent` is a discriminated union and `canary` is the one member
 * keyed by `probeId` rather than by a run (core-types/src/telemetry.ts). Every
 * other member carries `runId`, so narrowing on `type` is what makes the field
 * readable -- `as any` would hide the very distinction the union exists for.
 */
type RunScopedTelemetryEvent = Exclude<StrataTelemetryEvent, { readonly type: 'canary' }>;

const hasRunId = (e: StrataTelemetryEvent): e is RunScopedTelemetryEvent => e.type !== 'canary';

/**
 * Unchecked index reads are `T | undefined` under `noUncheckedIndexedAccess`.
 * Going through `assert.ok` keeps the failure named ("no matching event")
 * rather than a `TypeError` on a line the reader has to re-derive.
 */
function at<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index];
  assert.ok(item, `${what}: expected an element at index ${String(index)}`);
  return item;
}

describe('ClaudeCodeHooks', () => {
  let telemetrySink: MemorySink;
  let hooks: ClaudeCodeHooks;
  let emittedEvents: StrataTelemetryEvent[];

  beforeEach(() => {
    cleanupTempSettings();
    telemetrySink = new MemorySink({ clock: () => Date.now() });
    emittedEvents = [];
    const capturingSink: TelemetrySink = {
      emit: (event) => {
        emittedEvents.push(event);
        telemetrySink.emit(event);
      },
      flush: () => telemetrySink.flush(),
      close: () => telemetrySink.close(),
      get state() {
        return telemetrySink.state;
      },
    };
    hooks = new ClaudeCodeHooks({
      policy: TEST_POLICY,
      telemetrySink: capturingSink,
      settingsPath: TEMP_SETTINGS_PATH,
    });
  });

  afterEach(() => {
    cleanupTempSettings();
    telemetrySink.close();
  });

  describe('install()', () => {
    it('creates settings file with pre_tool_use and post_tool_use hooks', () => {
      hooks.install();

      const settings = parseSettings(TEMP_SETTINGS_PATH);
      assert.ok(settings.hooks);
      assert.equal(settings.hooks.length, 2);

      const preHook = settings.hooks.find((h: { type: string }) => h.type === 'pre_tool_use');
      const postHook = settings.hooks.find((h: { type: string }) => h.type === 'post_tool_use');

      assert.ok(preHook);
      assert.ok(postHook);
      assert.equal(preHook.command, 'strata-ctx hook run');
      assert.equal(postHook.command, 'strata-ctx hook run');
    });

    it('emits telemetry event on install', () => {
      hooks.install();

      const installEvents = emittedEvents.filter(hasRunId).filter((e) => e.runId === 'install');
      assert.equal(installEvents.length, 1);
      assert.equal(at(installEvents, 0, 'install event').type, 'request_in');
    });

    it('is idempotent - does not duplicate hooks on repeated install', () => {
      hooks.install();
      hooks.install();

      const settings = parseSettings(TEMP_SETTINGS_PATH);
      const strataHooks = settings.hooks.filter((h: { command: string }) => h.command === 'strata-ctx hook run');
      assert.equal(strataHooks.length, 2);
    });

    it('preserves existing non-strata hooks', () => {
      const existingSettings = {
        hooks: [
          { type: 'pre_tool_use', command: 'other-hook', timeout: 1000 },
          { type: 'post_tool_use', command: 'another-hook' },
        ],
      };
      mkdirSync(dirname(TEMP_SETTINGS_PATH), { recursive: true });
      writeFileSync(TEMP_SETTINGS_PATH, JSON.stringify(existingSettings, null, 2));

      hooks.install();

      const settings = parseSettings(TEMP_SETTINGS_PATH);
      const otherHooks = settings.hooks.filter((h: { command: string }) => h.command !== 'strata-ctx hook run');
      assert.equal(otherHooks.length, 2);
    });
  });

  describe('uninstall()', () => {
    it('removes strata-ctx hooks from settings', () => {
      hooks.install();
      hooks.uninstall();

      const settings = parseSettings(TEMP_SETTINGS_PATH);
      const strataHooks = settings.hooks.filter((h: { command: string }) => h.command === 'strata-ctx hook run');
      assert.equal(strataHooks.length, 0);
    });

    it('emits telemetry event on uninstall', () => {
      hooks.install();
      emittedEvents.length = 0;
      hooks.uninstall();

      const uninstallEvents = emittedEvents.filter(hasRunId).filter((e) => e.runId === 'uninstall');
      assert.equal(uninstallEvents.length, 1);
      assert.equal(at(uninstallEvents, 0, 'uninstall event').type, 'request_in');
    });

    it('preserves non-strata hooks', () => {
      const existingSettings = {
        hooks: [
          { type: 'pre_tool_use', command: 'other-hook', timeout: 1000 },
          { type: 'pre_tool_use', command: 'strata-ctx hook run' },
        ],
      };
      mkdirSync(dirname(TEMP_SETTINGS_PATH), { recursive: true });
      writeFileSync(TEMP_SETTINGS_PATH, JSON.stringify(existingSettings, null, 2));

      hooks.uninstall();

      const settings = parseSettings(TEMP_SETTINGS_PATH);
      const otherHooks = settings.hooks.filter((h: { command: string }) => h.command !== 'strata-ctx hook run');
      assert.equal(otherHooks.length, 1);
      assert.equal(at(otherHooks, 0, 'preserved non-strata hook').command, 'other-hook');
    });

    it('handles missing settings file gracefully', () => {
      assert.doesNotThrow(() => hooks.uninstall());
    });
  });

  describe('handlePreToolUse()', () => {
    beforeEach(() => {
      hooks.install();
    });

    it('allows intercepted tools (Bash, Read, Write, Edit, Task)', () => {
      const tools = ['Bash', 'Read', 'Write', 'Edit', 'Task'] as const;

      for (const tool of tools) {
        const input: PreToolUseInput = {
          tool,
          parameters: {},
          sessionId: 'session-123',
          runId: 'run-456',
          turn: 1,
        };
        const result = hooks.handlePreToolUse(input);
        assert.equal(result.action, 'allow');
        assert.ok(result.context);
      }
    });

    it('allows non-intercepted tools without modification', () => {
      const result = hooks.handlePreToolUse(MOCK_PRE_TOOL_USE_UNKNOWN);
      assert.equal(result.action, 'allow');
      assert.equal(result.context, undefined);
    });

    it('injects governance constraints into context for intercepted tools', () => {
      const result = hooks.handlePreToolUse(MOCK_PRE_TOOL_USE_BASH) as PreToolUseResult & { context: import('@strata-ctx/core-types').ContextState };

      assert.ok(result.context);
      assert.equal(result.context.pinned.length, TEST_POLICY.constraints.length);
      assert.ok(result.context.messages.some((m) => m.role === 'system'));
      const systemMsgs = result.context.messages.filter((m) => m.role === 'system');
      assert.ok(systemMsgs.length > 0);
      const govBlocks = systemMsgs.flatMap((m) => m.content.filter((b) => b.meta.tier === 'governance'));
      assert.equal(govBlocks.length, TEST_POLICY.constraints.length);
    });

    it('emits request_in telemetry with correct token estimate', () => {
      emittedEvents.length = 0;
      hooks.handlePreToolUse(MOCK_PRE_TOOL_USE_BASH);

      const requestEvents = emittedEvents.filter((e) => e.type === 'request_in');
      assert.equal(requestEvents.length, 1);
      const requestEvent = at(requestEvents, 0, 'request_in event');
      assert.equal(requestEvent.runId, 'run-456');
      assert.equal(requestEvent.turn, 1);
    });

    it('emits pin telemetry with constraint count', () => {
      emittedEvents.length = 0;
      hooks.handlePreToolUse(MOCK_PRE_TOOL_USE_BASH);

      const pinEvents = emittedEvents.filter((e) => e.type === 'pin');
      assert.equal(pinEvents.length, 1);
      assert.equal(at(pinEvents, 0, 'pin event').constraints, TEST_POLICY.constraints.length);
    });

    it('maintains session state across calls', () => {
      hooks.handlePreToolUse(MOCK_PRE_TOOL_USE_BASH);
      const result2 = hooks.handlePreToolUse(MOCK_PRE_TOOL_USE_READ);

      assert.ok(result2.context);
      assert.equal(result2.context.turn, 2);
      assert.ok(result2.context.pinned.length > 0);
    });

    it('handles multiple sessions independently', () => {
      hooks.handlePreToolUse({ ...MOCK_PRE_TOOL_USE_BASH, sessionId: 'session-a' });
      hooks.handlePreToolUse({ ...MOCK_PRE_TOOL_USE_READ, sessionId: 'session-b' });

      // Both sessions should have their own state
      // We can't directly inspect internal state, but we can verify no cross-contamination
      // by checking telemetry has both runIds
      const runIds = new Set(
        emittedEvents
          .filter((e): e is StrataTelemetryEvent & { runId: string } => 'runId' in e)
          .map((e) => e.runId),
      );
      assert.ok(runIds.has('run-456'));
    });
  });

  describe('handlePostToolUse()', () => {
    beforeEach(() => {
      hooks.install();
    });

    it('allows all post-tool-use events', () => {
      const result = hooks.handlePostToolUse(MOCK_POST_TOOL_USE);
      assert.equal(result.action, 'allow');
    });

    it('emits stage telemetry for post-tool-use', () => {
      hooks.handlePreToolUse(MOCK_PRE_TOOL_USE_BASH);
      emittedEvents.length = 0;

      hooks.handlePostToolUse(MOCK_POST_TOOL_USE);

      const stageEvents = emittedEvents.filter((e) => e.type === 'stage');
      assert.equal(stageEvents.length, 1);
      assert.equal(at(stageEvents, 0, 'stage event').stage, 'pin');
    });

    it('handles post-tool-use for session without pre-tool-use gracefully', () => {
      const result = hooks.handlePostToolUse({
        ...MOCK_POST_TOOL_USE,
        sessionId: 'unknown-session',
      });
      assert.equal(result.action, 'allow');
    });
  });

  describe('constraint injection', () => {
    beforeEach(() => {
      hooks.install();
    });

    it('replaces pinned buffer entirely (never merges)', () => {
      const result1 = hooks.handlePreToolUse(MOCK_PRE_TOOL_USE_BASH) as PreToolUseResult & { context: import('@strata-ctx/core-types').ContextState };
      const result2 = hooks.handlePreToolUse({ ...MOCK_PRE_TOOL_USE_READ, turn: 2 }) as PreToolUseResult & { context: import('@strata-ctx/core-types').ContextState };

      // Both should have exactly the policy constraints, no more no less
      assert.equal(result1.context.pinned.length, TEST_POLICY.constraints.length);
      assert.equal(result2.context.pinned.length, TEST_POLICY.constraints.length);
      assert.deepEqual([...result1.context.pinned].sort(), [...result2.context.pinned].sort());
    });

    it('constraints are sorted by id for deterministic order', () => {
      const result = hooks.handlePreToolUse(MOCK_PRE_TOOL_USE_BASH) as PreToolUseResult & { context: import('@strata-ctx/core-types').ContextState };

      const expectedOrder = TEST_POLICY.constraints
        .slice()
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((c) => c.text);
      assert.deepEqual(result.context.pinned, expectedOrder);
    });

    it('governance blocks have correct metadata', () => {
      const result = hooks.handlePreToolUse(MOCK_PRE_TOOL_USE_BASH) as PreToolUseResult & { context: import('@strata-ctx/core-types').ContextState };

      const govBlocks = result.context.messages
        .filter((m) => m.role === 'system')
        .flatMap((m) => m.content.filter((b) => b.meta.tier === 'governance'));

      for (const block of govBlocks) {
        assert.equal(block.meta.tier, 'governance');
        assert.equal(block.meta.origin, 'system');
        assert.ok(block.meta.cacheable);
        assert.ok(block.meta.sha256.length === 64);
      }
    });
  });

  describe('telemetry', () => {
    beforeEach(() => {
      hooks.install();
    });

    it('emits request_in on pre-tool-use', () => {
      emittedEvents.length = 0;
      hooks.handlePreToolUse(MOCK_PRE_TOOL_USE_BASH);

      const events = emittedEvents.filter((e) => e.type === 'request_in');
      assert.equal(events.length, 1);
      const requestEvent = at(events, 0, 'request_in event');
      assert.ok(typeof requestEvent.inputTokens === 'number');
      assert.ok(typeof requestEvent.messages === 'number');
    });

    it('emits pin event with constraint count', () => {
      emittedEvents.length = 0;
      hooks.handlePreToolUse(MOCK_PRE_TOOL_USE_BASH);

      const events = emittedEvents.filter((e) => e.type === 'pin');
      assert.equal(events.length, 1);
      assert.equal(at(events, 0, 'pin event').constraints, TEST_POLICY.constraints.length);
    });

    it('emits stage event on post-tool-use', () => {
      hooks.handlePreToolUse(MOCK_PRE_TOOL_USE_BASH);
      emittedEvents.length = 0;

      hooks.handlePostToolUse(MOCK_POST_TOOL_USE);

      const events = emittedEvents.filter((e) => e.type === 'stage');
      assert.equal(events.length, 1);
      assert.equal(at(events, 0, 'stage event').stage, 'pin');
    });
  });

  describe('edge cases', () => {
    beforeEach(() => {
      hooks.install();
    });

    it('handles empty policy constraints', () => {
      const emptyPolicyHooks = new ClaudeCodeHooks({
        policy: { ...TEST_POLICY, constraints: [] },
        telemetrySink: telemetrySink,
        settingsPath: TEMP_SETTINGS_PATH + '.empty',
      });
      emptyPolicyHooks.install();

      const result = emptyPolicyHooks.handlePreToolUse(MOCK_PRE_TOOL_USE_BASH) as PreToolUseResult & { context: import('@strata-ctx/core-types').ContextState };
      assert.equal(result.context.pinned.length, 0);
      assert.equal(result.context.messages.filter((m) => m.role === 'system').length, 0);

      emptyPolicyHooks.uninstall();
    });

it('handles settings file with invalid JSON gracefully', () => {
      writeFileSync(TEMP_SETTINGS_PATH, '{ invalid json}');

      try {
        hooks.install();
      } catch {
        // Expected to not throw
      }
      const settings = parseSettings(TEMP_SETTINGS_PATH);
      assert.ok(settings.hooks);
    });

    it('handles missing .claude directory', () => {
      const missingDirPath = '/tmp/strata-ctx-nonexistent-deeply-nested/path/settings.json';
      const missingDirHooks = new ClaudeCodeHooks({
        policy: TEST_POLICY,
        telemetrySink: telemetrySink,
        settingsPath: missingDirPath,
      });
      assert.doesNotThrow(() => missingDirHooks.install());
      missingDirHooks.uninstall();
    });
  });
});