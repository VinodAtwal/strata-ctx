/**
 * E-5, second half: the Gemini CLI adapter.
 *
 * ## The whole adapter is a spec
 *
 * `docs/integrations.md` §4: "WS-E should build the Claude Code and Gemini
 * recipes from one parameterized hook adapter -- the shapes are close enough
 * that a second hand-rolled integration is a waste." So there is no
 * Gemini-specific control flow below this line. `geminiHookSpec()` returns the
 * four facts that make Gemini Gemini, `buildHooks()` turns them into
 * install/uninstall/handle functions, and `GeminiAdapter` is the façade the rest
 * of the codebase holds.
 *
 * Those four facts, and why each is what it is:
 *
 * 1. **Settings live in `settings.json` under the Gemini config dir.** T-proxy
 *    configuration (`GOOGLE_GEMINI_BASE_URL`, auth) and the hook list share one
 *    file, which is exactly why the builder's foreign-key preservation is a
 *    correctness requirement rather than a nicety: dropping a sibling key here
 *    breaks the user's proxy setup.
 * 2. **System instructions come from `GEMINI.md`,** the same role `CLAUDE.md`
 *    plays for Claude Code. It is markdown, so it gets the managed-block
 *    surface and the user's own prose survives install and uninstall.
 * 3. **The tool names are Gemini's, and they are not Claude's.** `run_shell_command`,
 *    `read_file`, `write_file`, `replace` -- intercepting `Bash`/`Read`/`Write`
 *    here would be a hook that fires on nothing and looks installed.
 * 4. **A credential can be in `stdout`, `stderr`, or a bare string result,**
 *    because that is what `run_shell_command` and `read_file` return. A
 *    `run_shell_command` that cat'd the environment is the single most likely
 *    way a key reaches a transcript in this agent.
 *
 * ## The surface is a moving target
 *
 * The feasibility matrix marks Gemini CLI `verify`: it is open source, so the
 * hook surface is inspectable, but it moves. Everything the spec declares is
 * therefore a named constant rather than an inline literal, so the E-8
 * surface-check job has exactly one place per fact to diff against a real
 * install, and a drift is a one-line change here instead of a search.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { StrataPolicy } from '@strata-ctx/core-types';
import type { TelemetrySink } from '@strata-ctx/telemetry';
import {
  buildHooks,
  INSTRUCTION_BLOCK_END,
  INSTRUCTION_BLOCK_START,
  type AgentHookSpec,
  type HookBundle,
  type HookReport,
  type HookRequest,
  type HookResultInput,
  type PostToolUseResult,
  type PreToolUseResult,
  type ResultRewriteSpec,
} from './hook-builder.js';

/** The config directory Gemini CLI reads, relative to `$HOME`. */
export const GEMINI_CONFIG_DIR = '.gemini';

/** The settings file shared by the proxy configuration and the hook list. */
export const GEMINI_SETTINGS_FILE = 'settings.json';

/** The context file Gemini reads for system instructions, at the project root. */
export const GEMINI_CONTEXT_FILE = 'GEMINI.md';

/** The executable registered for both lifecycle events. */
export const GEMINI_HOOK_COMMAND = 'strata-ctx-hook';

/**
 * Gemini CLI's file-touching tools.
 *
 * Deliberately not Claude Code's names. A hook that matches nothing is worse
 * than an absent hook, because `install` reports success.
 */
export const GEMINI_TOOLS = [
  'run_shell_command',
  'read_file',
  'write_file',
  'replace',
  'glob',
  'search_file_content',
  'web_fetch',
  'google_web_search',
] as const;

export type GeminiTool = (typeof GEMINI_TOOLS)[number];

/**
 * Where `run_shell_command` puts its output and `read_file` puts its payload.
 * `wholeResult` covers the tools that hand back a bare string.
 */
export const GEMINI_RESULT_REWRITE: ResultRewriteSpec = Object.freeze({
  stringPaths: Object.freeze([
    Object.freeze(['stdout']),
    Object.freeze(['stderr']),
    Object.freeze(['output']),
  ]),
  wholeResult: true,
});

export interface GeminiPaths {
  readonly configDir: string;
  readonly settingsPath: string;
  readonly contextPath: string;
}

export interface GeminiAdapterOptions {
  readonly policy: StrataPolicy;
  readonly telemetrySink?: TelemetrySink;
  /** Overrides `~/.gemini`. */
  readonly configDir?: string;
  /** Root for `GEMINI.md`. Defaults to the process working directory. */
  readonly projectRoot?: string;
  readonly hookCommand?: string;
  /** Adds or removes tool names without forking the spec. */
  readonly extraTools?: readonly string[];
  /** Per-hook timeout, passed through to the settings entries. */
  readonly timeoutMs?: number;
}

export function resolveGeminiPaths(options: Partial<GeminiAdapterOptions> = {}): GeminiPaths {
  const configDir = options.configDir ?? join(homedir(), GEMINI_CONFIG_DIR);
  const projectRoot = options.projectRoot ?? process.cwd();
  return {
    configDir,
    settingsPath: join(configDir, GEMINI_SETTINGS_FILE),
    contextPath: join(projectRoot, GEMINI_CONTEXT_FILE),
  };
}

/** The four Gemini facts, as a spec `buildHooks` can consume. */
export function geminiHookSpec(options: Partial<GeminiAdapterOptions> = {}): AgentHookSpec {
  const paths = resolveGeminiPaths(options);
  return {
    agent: 'gemini-cli',
    hookCommand: options.hookCommand ?? GEMINI_HOOK_COMMAND,
    hooks: {
      kind: 'settings-json',
      path: paths.settingsPath,
      listKey: 'hooks',
      eventKey: 'type',
      commandKey: 'command',
    },
    instructions: {
      kind: 'markdown',
      path: paths.contextPath,
      start: INSTRUCTION_BLOCK_START,
      end: INSTRUCTION_BLOCK_END,
    },
    tools: [...GEMINI_TOOLS, ...(options.extraTools ?? [])],
    rewrite: GEMINI_RESULT_REWRITE,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}

export class GeminiAdapter {
  readonly #hooks: HookBundle;

  constructor(options: GeminiAdapterOptions) {
    this.#hooks = buildHooks(geminiHookSpec(options), {
      policy: options.policy,
      ...(options.telemetrySink === undefined ? {} : { telemetrySink: options.telemetrySink }),
    });
  }

  get agent(): string {
    return this.#hooks.agent;
  }

  get spec(): AgentHookSpec {
    return this.#hooks.spec;
  }

  get settingsPath(): string {
    return this.#hooks.spec.hooks.path;
  }

  get contextPath(): string {
    return this.#hooks.spec.instructions.path;
  }

  install(): HookReport {
    return this.#hooks.install();
  }

  uninstall(): HookReport {
    return this.#hooks.uninstall();
  }

  /** Re-assert the instruction block, e.g. after the policy changes. */
  refreshInstructions(): HookReport {
    return this.#hooks.refreshInstructions();
  }

  removeInstructions(): HookReport {
    return this.#hooks.removeInstructions();
  }

  renderInstructions(): string {
    return this.#hooks.renderInstructions();
  }

  instructionLines(): readonly string[] {
    return this.#hooks.instructionLines();
  }

  handlesTool(tool: string): boolean {
    return this.#hooks.handlesTool(tool);
  }

  handlePreToolUse(input: HookRequest): PreToolUseResult {
    return this.#hooks.handlePreToolUse(input);
  }

  handlePostToolUse(input: HookResultInput): PostToolUseResult {
    return this.#hooks.handlePostToolUse(input);
  }

  get sessionCount(): number {
    return this.#hooks.sessionCount;
  }

  reset(sessionId?: string): void {
    this.#hooks.reset(sessionId);
  }
}

export function createGeminiAdapter(options: GeminiAdapterOptions): GeminiAdapter {
  return new GeminiAdapter(options);
}

export type { AgentHookSpec, HookBundle, HookReport, HookRequest, HookResultInput, PostToolUseResult, PreToolUseResult, ResultRewriteSpec };
