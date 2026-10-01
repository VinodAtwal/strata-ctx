import { homedir } from 'node:os';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type {
  StrataPolicy,
  ContextState,
  RunId,
} from '@strata-ctx/core-types';
import {
  sha256,
  estimateTokens,
  partitionForLossy,
  restoreHeld,
  enforcePins,
  pinSetText,
} from '@strata-ctx/core-types';
import { MemorySink, type TelemetrySink, type StrataTelemetryEvent } from '@strata-ctx/telemetry';

export interface ClaudeCodeHookConfig {
  readonly hooks: readonly HookDefinition[];
}

export interface HookDefinition {
  readonly type: 'pre_tool_use' | 'post_tool_use';
  readonly command: string;
  readonly timeout?: number;
}

export interface PreToolUseInput {
  readonly tool: string;
  readonly parameters: Record<string, unknown>;
  readonly sessionId: string;
  readonly runId: string;
  readonly turn: number;
}

export interface PostToolUseInput {
  readonly tool: string;
  readonly parameters: Record<string, unknown>;
  readonly result: unknown;
  readonly sessionId: string;
  readonly runId: string;
  readonly turn: number;
}

export interface ToolCallContext {
  readonly tool: string;
  readonly parameters: Record<string, unknown>;
  readonly sessionId: string;
  readonly runId: RunId;
  readonly turn: number;
  readonly state: ContextState;
}

const INTERCEPTED_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Task'] as const;
export type InterceptedTool = (typeof INTERCEPTED_TOOLS)[number];

const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
/** The dispatcher subcommand. Must be a bin this repo actually installs. */
const STRATA_HOOK_COMMAND = 'strata-ctx hook run';

export interface ClaudeCodeHooksOptions {
  readonly policy: StrataPolicy;
  readonly telemetrySink?: TelemetrySink;
  readonly settingsPath?: string;
  readonly hookCommand?: string;
}

export class ClaudeCodeHooks {
  readonly #policy: StrataPolicy;
  readonly #telemetry: TelemetrySink;
  readonly #settingsPath: string;
  readonly #hookCommand: string;
  readonly #sessions = new Map<string, { state: ContextState; lastSent: readonly string[] }>();

  constructor(options: ClaudeCodeHooksOptions) {
    this.#policy = options.policy;
    this.#telemetry = options.telemetrySink ?? new MemorySink();
    this.#settingsPath = options.settingsPath ?? CLAUDE_SETTINGS_PATH;
    this.#hookCommand = options.hookCommand ?? STRATA_HOOK_COMMAND;
  }

  get policy(): StrataPolicy {
    return this.#policy;
  }

  get telemetry(): TelemetrySink {
    return this.#telemetry;
  }

  install(): void {
    const settings = this.#readSettings();
    const hookConfig = this.#buildHookConfig();
    const updated = this.#mergeHooks(settings, hookConfig);
    this.#writeSettings(updated);
    this.#emitTelemetry({
      type: 'request_in',
      runId: 'install',
      turn: 0,
      inputTokens: 0,
      messages: 0,
    });
  }

  uninstall(): void {
    const settings = this.#readSettings();
    const updated = this.#removeHooks(settings);
    this.#writeSettings(updated);
    this.#emitTelemetry({
      type: 'request_in',
      runId: 'uninstall',
      turn: 0,
      inputTokens: 0,
      messages: 0,
    });
  }

  handlePreToolUse(input: PreToolUseInput): PreToolUseResult {
    if (!INTERCEPTED_TOOLS.includes(input.tool as InterceptedTool)) {
      return { action: 'allow' };
    }

    const session = this.#getOrCreateSession(input.sessionId, input.runId, input.turn);
    const context = {
      tool: input.tool,
      parameters: input.parameters,
      sessionId: input.sessionId,
      runId: input.runId as RunId,
      turn: input.turn,
      state: session.state,
    };

    this.#emitTelemetry({
      type: 'request_in',
      runId: input.runId,
      turn: input.turn,
      inputTokens: session.state.tokenEstimate,
      messages: session.state.messages.length,
    });

    const constrained = this.#injectConstraints(context);
    session.state = constrained.state;
    session.lastSent = constrained.expected;

    this.#emitTelemetry({
      type: 'pin',
      runId: input.runId,
      missingBefore: 0,
      constraints: constrained.expected.length,
    });

    return { action: 'allow', context: constrained.state };
  }

  handlePostToolUse(input: PostToolUseInput): PostToolUseResult {
    const session = this.#sessions.get(input.sessionId);
    if (!session) {
      return { action: 'allow' };
    }

    this.#emitTelemetry({
      type: 'stage',
      runId: input.runId,
      stage: 'pin',
      bytesIn: 0,
      bytesOut: 0,
      blocksIn: session.state.messages.length,
      blocksOut: session.state.messages.length,
      durationMs: 0,
      changed: false,
    });

    return { action: 'allow' };
  }

  #readSettings(): Record<string, unknown> {
    if (!existsSync(this.#settingsPath)) {
      return {};
    }
    try {
      const content = readFileSync(this.#settingsPath, 'utf8');
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  #writeSettings(settings: Record<string, unknown>): void {
    const dir = dirname(this.#settingsPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(this.#settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  }

  #buildHookConfig(): ClaudeCodeHookConfig {
    return {
      hooks: [
        {
          type: 'pre_tool_use',
          command: this.#hookCommand,
          timeout: 30000,
        },
        {
          type: 'post_tool_use',
          command: this.#hookCommand,
          timeout: 30000,
        },
      ],
    };
  }

  #mergeHooks(settings: Record<string, unknown>, hooks: ClaudeCodeHookConfig): Record<string, unknown> {
    const existing = (settings.hooks as HookDefinition[] | undefined) ?? [];
    const filtered = existing.filter(
      (h) => h.command !== this.#hookCommand || !['pre_tool_use', 'post_tool_use'].includes(h.type),
    );
    return { ...settings, hooks: [...filtered, ...hooks.hooks] };
  }

  #removeHooks(settings: Record<string, unknown>): Record<string, unknown> {
    const existing = (settings.hooks as HookDefinition[] | undefined) ?? [];
    const filtered = existing.filter((h) => h.command !== this.#hookCommand);
    return { ...settings, hooks: filtered };
  }

  #getOrCreateSession(sessionId: string, runId: string, turn: number): { state: ContextState; lastSent: readonly string[] } {
    let session = this.#sessions.get(sessionId);
    if (!session) {
      const initialState: ContextState = {
        messages: [],
        pinned: [],
        tokenEstimate: 0,
        policyHash: sha256(pinSetText(this.#policy).join('\n')),
        runId: runId as RunId,
        turn,
        gists: [],
        artifacts: [],
      };
      session = { state: initialState, lastSent: [] };
      this.#sessions.set(sessionId, session);
    } else if (session.state.turn !== turn) {
      // Update turn for new request in same session
      session = { ...session, state: { ...session.state, turn } };
      this.#sessions.set(sessionId, session);
    }
    return session;
  }

  #injectConstraints(context: ToolCallContext): PinApplication {
    if (this.#policy.constraints.length === 0) {
      return {
        state: context.state,
        expected: [],
        inboundGovernance: [],
      };
    }
    const lossy = partitionForLossy(context.state, this.#policy);
    const restored = restoreHeld(lossy, { ...context.state, tokenEstimate: estimateTokens(context.state) });
    return enforcePins(restored, this.#policy);
  }

  #emitTelemetry(event: StrataTelemetryEvent): void {
    try {
      this.#telemetry.emit(event);
    } catch {
      // Telemetry failures must not block the hook
    }
  }
}

export interface PinApplication {
  readonly state: ContextState;
  readonly expected: readonly string[];
  readonly inboundGovernance: readonly string[];
}

export interface PreToolUseResult {
  readonly action: 'allow' | 'block';
  readonly context?: ContextState;
  readonly message?: string;
}

export interface PostToolUseResult {
  readonly action: 'allow' | 'block';
  readonly message?: string;
}

export function createClaudeCodeHooks(options: ClaudeCodeHooksOptions): ClaudeCodeHooks {
  return new ClaudeCodeHooks(options);
}