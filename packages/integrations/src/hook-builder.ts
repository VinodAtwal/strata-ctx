/**
 * E-5, first half: the shared parameterized hook builder.
 *
 * ## Why this file exists
 *
 * `docs/integrations.md` §4 says the Claude Code and Gemini CLI recipes should be
 * built from "one parameterized hook adapter", because the shapes are close
 * enough that a second hand-rolled integration is a waste. This is that adapter.
 * The agent is not special-cased anywhere below: an agent is a record of *where
 * its hooks are declared*, *which tools it exposes*, *where system instructions
 * live*, and *where a credential can hide in a tool result*. Everything else --
 * pin materialisation, drift detection, redaction, telemetry, session identity --
 * is the same code for every agent, and that is the code that has to be right.
 *
 * ## The two surfaces
 *
 * Two mechanisms cover every agent in the feasibility matrix:
 *
 * - `settings-json` -- a JSON file with a list of hook entries under a key.
 *   Every key name is a parameter (`listKey`/`eventKey`/`commandKey`), because
 *   the one thing a second integration must not do is assume the first agent's
 *   spelling.
 * - `markdown` -- a managed block delimited by two marker lines inside a
 *   markdown file. There is no list and no key, so a read-modify-write over
 *   whole lines is the honest implementation; the rest of the file is
 *   preserved and uninstall restores it exactly.
 *
 * Instructions are a second, independent surface. An agent can declare hooks in
 * JSON and take its system instructions from `GEMINI.md`, and `install()` writes
 * both without either one clobbering the other. The marker pairs differ per
 * surface for the same reason: an agent whose hooks and instructions share one
 * markdown file would otherwise have one managed block swallow the other.
 *
 * ## Three rules this file will not negotiate
 *
 * 1. **Foreign state is never destroyed.** A settings file we cannot parse is
 *    *not* overwritten with a fresh object -- it is reported as `blocked` and
 *    left exactly as it was. The same goes for a hook list that is present but
 *    is not an array. A governance tool that silently eats a user's config on
 *    the way to installing itself is worse than one that does not install.
 * 2. **A constraint is a governance block, re-materialised per request.** Not a
 *    comment, not a one-shot on install. `enforcePins` replaces the buffer
 *    wholesale (never merges -- a gist that appends to the pin set is a policy
 *    escalation), and the request result carries both the canonical
 *    `ContextState` and the agent-shaped instruction text.
 * 3. **Malformed input fails open on the user's context and loud in telemetry.**
 *    A hook that cannot tell what it was called with must not block a request;
 *    it must not silently stop enforcing either, so it says so in the result
 *    (`handled: false`, `problem`) and in an `error` event with
 *    `failedOpen: true`. Secrets are the one exception: a `redaction: 'block'`
 *    policy that finds a credential in a tool result *denies*, because a tool
 *    result is written to disk and losing one turn is cheaper than persisting
 *    a key.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ContextState, StrataPolicy } from '@strata-ctx/core-types';
import {
  collectGovernanceText,
  enforcePins,
  estimateTokens,
  partitionForLossy,
  pinDrift,
  pinSetText,
  restoreHeld,
  runId as brandRunId,
  sha256,
} from '@strata-ctx/core-types';
import type { RedactionFinding } from '@strata-ctx/security';
import { RedactionEngine, SecretBlockedError, optionsFromPolicy } from '@strata-ctx/security';
import { MemorySink, type StrataTelemetryEvent, type TelemetrySink } from '@strata-ctx/telemetry';

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/** The two lifecycle events every agent in the feasibility matrix exposes. */
export const HOOK_EVENTS = ['pre_tool_use', 'post_tool_use'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Default per-hook timeout, matching the Claude Code scaffold. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Marker lines. Line-anchored on purpose: removal is then a predictable line
 * filter instead of a regex over somebody's prose.
 */
export const HOOK_BLOCK_START = '<!-- strata-ctx:hooks:begin -->';
export const HOOK_BLOCK_END = '<!-- strata-ctx:hooks:end -->';
export const INSTRUCTION_BLOCK_START = '<!-- strata-ctx:instructions:begin -->';
export const INSTRUCTION_BLOCK_END = '<!-- strata-ctx:instructions:end -->';

/** Pseudo event name used in reports for the instruction surface. */
const INSTRUCTION_ENTRY = 'instructions';

/** Bounds the result walk; a control on the request path is not a DoS vector. */
const MAX_WALK_DEPTH = 8;

/** Hooks declared as a list inside a JSON settings file. */
export interface JsonHookSurface {
  readonly kind: 'settings-json';
  readonly path: string;
  /** Key holding the list, e.g. `hooks` or `extensions`. */
  readonly listKey: string;
  /** Key naming the lifecycle event on an entry, e.g. `type` or `on`. */
  readonly eventKey: string;
  /** Key holding the command to run, e.g. `command` or `run`. */
  readonly commandKey: string;
}

/** Hooks declared as a fenced block inside a markdown file. */
export interface MarkdownHookSurface {
  readonly kind: 'markdown';
  readonly path: string;
  /** Fence language for the embedded payload, e.g. `json` or `toml`. */
  readonly fence: string;
  /** Key names used inside the fenced payload. Parameterised for the same reason. */
  readonly eventKey: string;
  readonly commandKey: string;
  readonly blockStart: string;
  readonly blockEnd: string;
}

export type HookSurface = JsonHookSurface | MarkdownHookSurface;

/** System instructions carried as an array under a settings key. */
export interface JsonInstructionSurface {
  readonly kind: 'settings-json';
  readonly path: string;
  readonly key: string;
}

/** System instructions as a managed markdown section. */
export interface MarkdownInstructionSurface {
  readonly kind: 'markdown';
  readonly path: string;
  readonly start: string;
  readonly end: string;
}

export type InstructionSurface = JsonInstructionSurface | MarkdownInstructionSurface;

/**
 * Where in a tool result a credential can be.
 *
 * `stringPaths` are the fields the agent's tools actually return -- Gemini's
 * `run_shell_command` yields `{stdout, stderr}`, Claude's yields `{output}`.
 * `wholeResult` covers the tools that return a bare string. An empty
 * `stringPaths` with `wholeResult: false` is a valid, explicitly inert spec, and
 * is what an agent with an unverified result shape should use.
 */
export interface ResultRewriteSpec {
  readonly stringPaths: readonly (readonly string[])[];
  readonly wholeResult: boolean;
}

export const DEFAULT_RESULT_REWRITE: ResultRewriteSpec = Object.freeze({
  stringPaths: Object.freeze([Object.freeze(['output'])]),
  wholeResult: true,
});

/** Everything that varies between agents. Nothing below branches on a name. */
export interface AgentHookSpec {
  /** Human-facing id, used in reports. */
  readonly agent: string;
  /** The executable the host shells out to for every hook. */
  readonly hookCommand: string;
  readonly hooks: HookSurface;
  readonly instructions: InstructionSurface;
  /** Tool names the agent exposes. Only these are intercepted. */
  readonly tools: readonly string[];
  readonly rewrite: ResultRewriteSpec;
  readonly timeoutMs?: number;
}

export interface BuildHooksOptions {
  readonly policy: StrataPolicy;
  readonly telemetrySink?: TelemetrySink;
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface HookRequest {
  readonly tool: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly sessionId: string;
  readonly runId: string;
  readonly turn: number;
  /** The agent's context, when it offers one. Pins are re-applied on the way out. */
  readonly state?: ContextState;
}

export interface HookResultInput {
  readonly tool: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly result: unknown;
  readonly sessionId: string;
  readonly runId: string;
  readonly turn: number;
}

export type HookRequestProblem = 'not_an_object' | 'missing_tool' | 'missing_session';

export type NormalizedRequest =
  | { readonly ok: true; readonly request: HookRequest }
  | { readonly ok: false; readonly problem: HookRequestProblem; readonly detail: string };

export interface PreToolUseResult {
  readonly decision: 'allow' | 'block';
  /** False when the tool is not intercepted or the input was unusable. */
  readonly handled: boolean;
  readonly tool: string;
  readonly context?: ContextState;
  /** Agent-shaped system instructions to put in front of the model. */
  readonly instructions: string;
  readonly pinned: readonly string[];
  readonly sessionId: string;
  readonly runId: string;
  readonly turn: number;
  /** Pin-integrity defects observed on this request. */
  readonly defects: readonly string[];
  readonly problem?: HookRequestProblem;
}

export interface PostToolUseResult {
  readonly decision: 'allow' | 'deny';
  readonly handled: boolean;
  /** The result the agent should use. Redacted, or refused under `block`. */
  readonly result: unknown;
  readonly changed: boolean;
  /** Telemetry-shaped: no secret and no offset, safe to log. */
  readonly findings: readonly RedactionFinding[];
  readonly sessionId: string | null;
  readonly problem?: HookRequestProblem;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export type HookAction = 'install' | 'uninstall' | 'instructions' | 'remove-instructions';

export type HookReportStatus = 'ok' | 'unchanged' | 'blocked' | 'absent';

export interface HookReport {
  readonly agent: string;
  readonly action: HookAction;
  readonly status: HookReportStatus;
  readonly changed: boolean;
  readonly path: string;
  /** Lifecycle event names added. */
  readonly added: readonly string[];
  /** Lifecycle event names removed. */
  readonly removed: readonly string[];
  /** Foreign entries or lines left in place. */
  readonly preserved: number;
  /** Set when `status` is `blocked`. */
  readonly reason?: string;
}

export interface HookBundle {
  readonly agent: string;
  readonly spec: AgentHookSpec;
  install(): HookReport;
  uninstall(): HookReport;
  refreshInstructions(): HookReport;
  removeInstructions(): HookReport;
  /** The instruction block for the current policy, markers included. */
  renderInstructions(pinned?: readonly string[]): string;
  /** The plain constraint lines, one per pin, in policy order. */
  instructionLines(): readonly string[];
  handlesTool(tool: string): boolean;
  handlePreToolUse(input: HookRequest): PreToolUseResult;
  handlePostToolUse(input: HookResultInput): PostToolUseResult;
  readonly sessionCount: number;
  reset(sessionId?: string): void;
}

// ---------------------------------------------------------------------------
// Input normalisation
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `Array.isArray` narrows to `any[]`, which would put an `any` back into the
 * walk. This guard keeps every element `unknown` all the way down.
 */
function isUnknownArray(v: unknown): v is readonly unknown[] {
  return Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Every hook entry arrives as a JSON blob from a process we do not control, so
 * the request is untrusted input in the ordinary sense. Normalising here is what
 * lets the enforcement path below be written as if the input were well formed,
 * and it means the one place it is not is a single typed value.
 */
export function normalizeHookRequest(input: unknown): NormalizedRequest {
  if (!isRecord(input)) {
    return { ok: false, problem: 'not_an_object', detail: typeof input };
  }
  const tool = input['tool'];
  if (!nonEmptyString(tool)) {
    return { ok: false, problem: 'missing_tool', detail: JSON.stringify(tool ?? null) };
  }
  const sessionId = input['sessionId'];
  if (!nonEmptyString(sessionId)) {
    return { ok: false, problem: 'missing_session', detail: JSON.stringify(sessionId ?? null) };
  }
  const rawParams = input['parameters'];
  const rawTurn = input['turn'];
  const rawRun = input['runId'];
  const rawState = input['state'];
  const base = {
    tool,
    parameters: isRecord(rawParams) ? rawParams : {},
    sessionId,
    runId: nonEmptyString(rawRun) ? rawRun : sessionId,
    turn: typeof rawTurn === 'number' && Number.isFinite(rawTurn) ? rawTurn : 0,
  };
  return {
    ok: true,
    request: isRecord(rawState) ? { ...base, state: rawState as unknown as ContextState } : base,
  };
}

// ---------------------------------------------------------------------------
// File surfaces
// ---------------------------------------------------------------------------

const MODE_FILE = 0o600;
const MODE_DIR = 0o700;

interface JsonFile {
  readonly text: string | null;
  readonly value: Record<string, unknown> | null;
  readonly malformed: boolean;
}

function readJsonFile(path: string): JsonFile {
  if (!existsSync(path)) return { text: null, value: null, malformed: false };
  const text = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { text, value: null, malformed: true };
  }
  // A settings file that parses to an array or a scalar is not a settings file
  // we understand, and spreading it would destroy whatever is in it.
  if (!isRecord(parsed)) return { text, value: null, malformed: true };
  return { text, value: parsed, malformed: false };
}

function serializeSettings(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeFileSecure(path: string, text: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: MODE_DIR });
  writeFileSync(path, text, { mode: MODE_FILE });
}

function stripBlock(text: string, start: string, end: string): { text: string; found: boolean } {
  const lines = text.split('\n');
  const out: string[] = [];
  let found = false;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]?.trim() === start) {
      const close = lines.indexOf(end, i + 1);
      found = true;
      i = close === -1 ? lines.length : close + 1;
      // The block sat between blank lines; drop one so the removal does not
      // leave a widening gap behind it.
      if (out[out.length - 1]?.trim() === '' && lines[i]?.trim() === '') out.pop();
      continue;
    }
    out.push(lines[i] ?? '');
    i += 1;
  }
  return { text: out.join('\n'), found };
}

function applyBlock(
  text: string,
  start: string,
  end: string,
  body: string | null,
): { text: string; changed: boolean } {
  const stripped = stripBlock(text, start, end);
  if (body === null) {
    if (!stripped.found) return { text, changed: false };
    let next = stripped.text.replace(/\n+$/, '');
    // Restore the file's own trailing-newline convention, so removing a block
    // we appended is a true inverse of appending it.
    if (next !== '' && text.endsWith('\n')) next += '\n';
    return { text: next, changed: next !== text };
  }
  const base = stripped.text.replace(/\s+$/, '');
  const block = [start, ...body.split('\n'), end].join('\n');
  const next = base === '' ? `${block}\n` : `${base}\n\n${block}\n`;
  return { text: next, changed: next !== text };
}

function countNonBlank(text: string): number {
  return text.split('\n').filter((line) => line.trim() !== '').length;
}

function safeBytes(value: unknown): number {
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

interface Session {
  /**
   * The context as it *arrived* on the most recent request, before pins were
   * applied. See the note in `handlePreToolUse` for why the pinned state must
   * not be what is kept.
   */
  readonly state: ContextState;
  /** The pin buffer we actually sent on the previous request. */
  lastSent: readonly string[];
}

interface RedactionOutcome {
  readonly value: unknown;
  readonly findings: readonly RedactionFinding[];
  readonly changed: boolean;
}

class ParameterizedHooks implements HookBundle {
  readonly #spec: AgentHookSpec;
  readonly #policy: StrataPolicy;
  readonly #telemetry: TelemetrySink;
  readonly #engine: RedactionEngine;
  readonly #pinnedText: readonly string[];
  readonly #policyHash: string;
  readonly #tools: ReadonlySet<string>;
  readonly #sessions = new Map<string, Session>();

  constructor(spec: AgentHookSpec, options: BuildHooksOptions) {
    this.#spec = spec;
    this.#policy = options.policy;
    this.#telemetry = options.telemetrySink ?? new MemorySink();
    this.#engine = new RedactionEngine(optionsFromPolicy(options.policy.redaction));
    this.#pinnedText = Object.freeze(pinSetText(options.policy));
    this.#policyHash = sha256(this.#pinnedText.join('\n'));
    this.#tools = new Set(spec.tools);
  }

  get agent(): string {
    return this.#spec.agent;
  }

  get spec(): AgentHookSpec {
    return this.#spec;
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  handlesTool(tool: string): boolean {
    return this.#tools.has(tool);
  }

  instructionLines(): readonly string[] {
    return this.#pinnedText;
  }

  reset(sessionId?: string): void {
    if (sessionId === undefined) this.#sessions.clear();
    else this.#sessions.delete(sessionId);
  }

  // -- instructions -------------------------------------------------------

  #instructionBody(pinned: readonly string[]): string {
    const lines = pinned.length === 0 ? ['(no governance constraints are configured)'] : pinned;
    return [
      '## Governance constraints (managed by strata-ctx)',
      '',
      'Re-asserted on every request. Do not edit or remove.',
      '',
      ...lines.map((text) => `- ${text}`),
    ].join('\n');
  }

  renderInstructions(pinned: readonly string[] = this.#pinnedText): string {
    const surface = this.#spec.instructions;
    if (surface.kind === 'markdown') {
      return [surface.start, this.#instructionBody(pinned), surface.end].join('\n');
    }
    return JSON.stringify([...pinned], null, 2);
  }

  refreshInstructions(): HookReport {
    return this.#writeInstructions(this.#pinnedText);
  }

  removeInstructions(): HookReport {
    return this.#writeInstructions(null);
  }

  #writeInstructions(pinned: readonly string[] | null): HookReport {
    const surface = this.#spec.instructions;
    const action: HookAction = pinned === null ? 'remove-instructions' : 'instructions';
    const added = pinned === null ? [] : [INSTRUCTION_ENTRY];
    const removed = pinned === null ? [INSTRUCTION_ENTRY] : [];

    if (surface.kind === 'markdown') {
      const file = existsSync(surface.path) ? readFileSync(surface.path, 'utf8') : '';
      const { text, changed } = applyBlock(
        file,
        surface.start,
        surface.end,
        pinned === null ? null : this.#instructionBody(pinned),
      );
      if (!changed) {
        const status: HookReportStatus = pinned === null ? 'absent' : 'unchanged';
        return this.#report(action, status, surface.path, added, removed, countNonBlank(file));
      }
      if (text.trim() === '') {
        // Nothing of the user's is left in the file, so it is ours to remove.
        rmSync(surface.path, { force: true });
        return this.#report(action, 'ok', surface.path, added, removed, 0);
      }
      writeFileSecure(surface.path, text);
      return this.#report(action, 'ok', surface.path, added, removed, countNonBlank(text));
    }

    const file = readJsonFile(surface.path);
    if (file.malformed) {
      return this.#report(action, 'blocked', surface.path, [], [], 0, 'unparsable_settings');
    }
    const current = file.value ?? {};
    if (pinned === null) {
      if (!(surface.key in current)) return this.#report(action, 'absent', surface.path, [], [], 0);
      const { [surface.key]: _dropped, ...rest } = current;
      const text = serializeSettings(rest);
      if (text === file.text) return this.#report(action, 'unchanged', surface.path, [], [], 0);
      writeFileSecure(surface.path, text);
      return this.#report(action, 'ok', surface.path, added, removed, 0);
    }
    const text = serializeSettings({ ...current, [surface.key]: [...pinned] });
    if (text === file.text) return this.#report(action, 'unchanged', surface.path, [], [], 0);
    writeFileSecure(surface.path, text);
    return this.#report(action, 'ok', surface.path, added, removed, 0);
  }

  // -- install / uninstall ------------------------------------------------

  install(): HookReport {
    const report = this.#writeHooks('install');
    // Instructions are a second file-level surface, so they get their own report;
    // a blocked hook install must not be followed by an instruction write that
    // would leave the agent half-configured.
    if (report.status !== 'blocked') this.refreshInstructions();
    return report;
  }

  uninstall(): HookReport {
    const report = this.#writeHooks('uninstall');
    if (report.status !== 'blocked') this.removeInstructions();
    return report;
  }

  #isOurs(entry: unknown, commandKey: string): boolean {
    return isRecord(entry) && entry[commandKey] === this.#spec.hookCommand;
  }

  #entryEvent(entry: unknown, eventKey: string): string {
    if (!isRecord(entry)) return 'foreign-entry';
    const value = entry[eventKey];
    return typeof value === 'string' ? value : 'foreign-entry';
  }

  #hookEntries(eventKey: string, commandKey: string): readonly { event: HookEvent; entry: Record<string, unknown> }[] {
    const timeout = this.#spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return HOOK_EVENTS.map((event) => ({
      event,
      entry: { [eventKey]: event, [commandKey]: this.#spec.hookCommand, timeout },
    }));
  }

  #writeHooks(action: 'install' | 'uninstall'): HookReport {
    const surface = this.#spec.hooks;
    const added = action === 'install' ? [...HOOK_EVENTS] : [];
    const removed = action === 'uninstall' ? [...HOOK_EVENTS] : [];

    if (surface.kind === 'markdown') {
      const file = existsSync(surface.path) ? readFileSync(surface.path, 'utf8') : '';
      const body =
        action === 'install'
          ? ['```' + surface.fence, ...this.#jsonFence(surface), '```'].join('\n')
          : null;
      const { text, changed } = applyBlock(file, surface.blockStart, surface.blockEnd, body);
      if (!changed) {
        // Removing a block that was never there is `absent`, not `unchanged`:
        // the caller asked for a teardown and there was nothing to tear down.
        const status: HookReportStatus = action === 'uninstall' ? 'absent' : 'unchanged';
        return this.#report(action, status, surface.path, added, removed, countNonBlank(file));
      }
      if (text.trim() === '') {
        rmSync(surface.path, { force: true });
        return this.#report(action, 'ok', surface.path, added, removed, 0);
      }
      const preserved = countNonBlank(stripBlock(text, surface.blockStart, surface.blockEnd).text);
      writeFileSecure(surface.path, text);
      return this.#report(action, 'ok', surface.path, added, removed, preserved);
    }

    const file = readJsonFile(surface.path);
    if (file.malformed) {
      return this.#report(action, 'blocked', surface.path, added, removed, 0, 'unparsable_settings');
    }
    // Nothing on disk. `install` creates the file; `uninstall` must not, or a
    // teardown of something that was never installed leaves an empty config
    // behind -- which is a file the agent will now own and the user did not.
    if (file.value === null && action === 'uninstall') {
      return this.#report(action, 'absent', surface.path, added, removed, 0);
    }
    const current = file.value ?? {};
    const raw = current[surface.listKey];
    if (raw !== undefined && !Array.isArray(raw)) {
      return this.#report(
        action,
        'blocked',
        surface.path,
        added,
        removed,
        0,
        `hook_list_not_an_array:${surface.listKey}`,
      );
    }
    const existing: readonly unknown[] = Array.isArray(raw) ? raw : [];
    // Ours are identified by the command, not by position or index, so a
    // hand-edited or reordered list cannot make install() duplicate a hook.
    // Entries that are not objects are left alone: they are not ours to delete.
    const mine = existing.filter((e) => this.#isOurs(e, surface.commandKey));
    const kept = existing.filter((e) => !this.#isOurs(e, surface.commandKey));
    const entries = action === 'install' ? this.#hookEntries(surface.eventKey, surface.commandKey) : [];
    const text = serializeSettings({
      ...current,
      [surface.listKey]: [...kept, ...entries.map((e) => e.entry)],
    });
    if (text === file.text) {
      return this.#report(
        action,
        'unchanged',
        surface.path,
        added,
        removed,
        kept.length,
      );
    }
    writeFileSecure(surface.path, text);
    return this.#report(
      action,
      'ok',
      surface.path,
      entries.map((e) => e.event),
      mine.map((e) => this.#entryEvent(e, surface.eventKey)),
      kept.length,
    );
  }

  #jsonFence(surface: MarkdownHookSurface): readonly string[] {
    const entries = this.#hookEntries(surface.eventKey, surface.commandKey).map((e) => e.entry);
    return JSON.stringify(entries, null, 2).split('\n');
  }

  // -- pre tool use -------------------------------------------------------

  handlePreToolUse(input: HookRequest): PreToolUseResult {
    const normalized = normalizeHookRequest(input);
    if (!normalized.ok) {
      this.#emitError('malformed_hook_input', normalized.problem, 'serialize', true);
      return {
        decision: 'allow',
        handled: false,
        tool: '',
        instructions: '',
        pinned: [],
        sessionId: '',
        runId: 'unknown',
        turn: 0,
        defects: [],
        problem: normalized.problem,
      };
    }
    const request = normalized.request;
    if (!this.handlesTool(request.tool)) {
      return {
        decision: 'allow',
        handled: false,
        tool: request.tool,
        instructions: '',
        pinned: [],
        sessionId: request.sessionId,
        runId: request.runId,
        turn: request.turn,
        defects: [],
      };
    }

    const prior = this.#sessions.get(request.sessionId);
    const lastSent = prior?.lastSent ?? [];
    // The session holds the state as it *arrived*, not the state we sent. Keeping
    // the pinned state instead would make the next request's
    // partition/restore round trip hoist the previous turn's pin blocks into
    // `held` and then prepend them to a message that already contains them --
    // the buffer would double, and every turn after the first would report
    // spurious `reordered` drift.
    const base = this.#baseState(request);
    const session: Session = { state: base, lastSent };
    this.#sessions.set(request.sessionId, session);

    this.#emit({
      type: 'request_in',
      runId: request.runId,
      turn: request.turn,
      inputTokens: base.tokenEstimate,
      messages: base.messages.length,
    });

    const lossy = partitionForLossy(base, this.#policy);
    const restored = restoreHeld(lossy, { ...base, tokenEstimate: estimateTokens(base) });
    const applied = enforcePins(restored, this.#policy);

    // Read the drift off the state that arrived, not off `applied`, whose
    // inbound set is the pre-pin view. Scoped to turns where we actually sent
    // something: turn 1 has no prior send to compare against, and comparing
    // against nothing reports every constraint as missing, which is exactly the
    // trivially-satisfiable check `pinDrift`'s own doc warns about.
    const inbound = collectGovernanceText(base);
    const drift = lastSent.length > 0 ? pinDrift(lastSent, inbound) : null;
    if (drift !== null && !drift.ok) {
      this.#emit({
        type: 'violation',
        runId: request.runId,
        kind: 'pin_missing_pre_apply',
        constraintIds: drift.defects.map((d) => d.text.slice(0, 64)),
        blocked: false,
      });
    }
    this.#emit({
      type: 'pin',
      runId: request.runId,
      missingBefore: drift === null ? 0 : drift.defects.filter((d) => d.kind === 'missing').length,
      constraints: applied.expected.length,
    });

    session.lastSent = applied.expected;

    return {
      decision: 'allow',
      handled: true,
      tool: request.tool,
      context: applied.state,
      instructions: applied.expected.join('\n'),
      pinned: applied.expected,
      sessionId: request.sessionId,
      runId: request.runId,
      turn: request.turn,
      defects: drift === null || drift.ok ? [] : drift.defects.map((d) => d.text),
    };
  }

  #baseState(request: HookRequest): ContextState {
    if (request.state !== undefined) {
      return { ...request.state, runId: brandRunId(request.runId), turn: request.turn };
    }
    const prior = this.#sessions.get(request.sessionId);
    if (prior !== undefined) return { ...prior.state, turn: request.turn };
    return {
      messages: [],
      pinned: [],
      tokenEstimate: 0,
      policyHash: this.#policyHash,
      runId: brandRunId(request.runId),
      turn: request.turn,
      gists: [],
      artifacts: [],
    };
  }

  // -- post tool use ------------------------------------------------------

  handlePostToolUse(input: HookResultInput): PostToolUseResult {
    const normalized = normalizeHookRequest(input);
    if (!normalized.ok) {
      this.#emitError('malformed_hook_input', normalized.problem, 'serialize', true);
      return {
        decision: 'allow',
        handled: false,
        result: undefined,
        changed: false,
        findings: [],
        sessionId: null,
        problem: normalized.problem,
      };
    }
    const request = normalized.request;
    const raw = isRecord(input) ? input['result'] : undefined;

    // No session means no pre-hook ever ran on this stream: there is no
    // governance buffer to protect, and rewriting a payload we were never asked
    // to guard is how an adapter starts corrupting results it does not own.
    if (!this.handlesTool(request.tool) || !this.#sessions.has(request.sessionId)) {
      return {
        decision: 'allow',
        handled: false,
        result: raw,
        changed: false,
        findings: [],
        sessionId: request.sessionId,
      };
    }

    let outcome: RedactionOutcome;
    try {
      outcome = this.#redactResult(raw);
    } catch (error) {
      if (!(error instanceof SecretBlockedError)) throw error;
      // Fail closed, and only here. A tool result is persisted; `block` is the
      // one policy setting that says losing this turn beats keeping the bytes.
      this.#emitError('redaction_blocked', request.tool, 'compress', false);
      const refused: Record<string, unknown> = { stdout: '[strata:redaction-blocked]', blocked: true };
      this.#emit({
        type: 'stage',
        runId: request.runId,
        stage: 'compress',
        bytesIn: safeBytes(raw),
        bytesOut: safeBytes(refused),
        blocksIn: 1,
        blocksOut: 1,
        durationMs: 0,
        changed: true,
      });
      return {
        decision: 'deny',
        handled: true,
        result: refused,
        changed: true,
        findings: error.findings,
        sessionId: request.sessionId,
      };
    }

    this.#emit({
      type: 'stage',
      runId: request.runId,
      stage: 'compress',
      bytesIn: safeBytes(raw),
      bytesOut: safeBytes(outcome.value),
      blocksIn: 1,
      blocksOut: 1,
      durationMs: 0,
      changed: outcome.changed,
    });

    return {
      decision: 'allow',
      handled: true,
      result: outcome.value,
      changed: outcome.changed,
      findings: outcome.findings,
      sessionId: request.sessionId,
    };
  }

  // -- redaction ----------------------------------------------------------

  #redactResult(result: unknown): RedactionOutcome {
    const spec = this.#spec.rewrite;
    const acc: { findings: RedactionFinding[]; changed: boolean } = { findings: [], changed: false };
    // `wholeResult` subsumes the path list: the walk has already visited every
    // string in the value, so running the paths again is a second no-op pass.
    const value =
      spec.wholeResult
        ? this.#redactAt(result, acc, 0)
        : spec.stringPaths.reduce<unknown>(
            (acc2, path) => this.#setAt(acc2, path, (v) => this.#redactAt(v, acc, 0)),
            result,
          );
    return { value, findings: acc.findings, changed: acc.changed };
  }

  #redactAt(value: unknown, acc: { findings: RedactionFinding[]; changed: boolean }, depth: number): unknown {
    if (depth > MAX_WALK_DEPTH) return value;
    if (typeof value === 'string') {
      const out = this.#engine.redact(value);
      if (out.changed) {
        acc.findings.push(...out.findings);
        acc.changed = true;
      }
      return out.text;
    }
    if (isUnknownArray(value)) return value.map((item) => this.#redactAt(item, acc, depth + 1));
    if (isRecord(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.#redactAt(v, acc, depth + 1);
      return out;
    }
    return value;
  }

  #setAt(value: unknown, path: readonly string[], replace: (v: unknown) => unknown): unknown {
    const head = path[0];
    if (head === undefined) return replace(value);
    const rest = path.slice(1);
    if (isUnknownArray(value)) {
      const index = Number(head);
      if (!Number.isInteger(index) || index < 0 || index >= value.length) return value;
      const current = value[index];
      const next = this.#setAt(current, rest, replace);
      if (next === current) return value;
      const copy = [...value];
      copy[index] = next;
      return copy;
    }
    if (isRecord(value)) {
      if (!(head in value)) return value;
      const current = value[head];
      const next = this.#setAt(current, rest, replace);
      if (next === current) return value;
      return { ...value, [head]: next };
    }
    return value;
  }

  // -- plumbing -----------------------------------------------------------

  #report(
    action: HookAction,
    status: HookReportStatus,
    path: string,
    added: readonly string[],
    removed: readonly string[],
    preserved: number,
    reason?: string,
  ): HookReport {
    return {
      agent: this.#spec.agent,
      action,
      status,
      changed: status === 'ok',
      path,
      added,
      removed,
      preserved,
      ...(reason === undefined ? {} : { reason }),
    };
  }

  #emitError(
    code: string,
    message: string,
    stage: 'serialize' | 'compress',
    failedOpen: boolean,
  ): void {
    this.#emit({ type: 'error', runId: 'hook', stage, code, message, failedOpen });
  }

  #emit(event: StrataTelemetryEvent): void {
    try {
      this.#telemetry.emit(event);
    } catch {
      // A broken log must not break a request. The sink is what records that
      // it is broken; the request path is not where that gets fixed.
    }
  }
}

/**
 * Build install/uninstall/handle functions for one agent.
 *
 * Nothing in the returned object is Gemini-specific, and nothing in it is
 * Claude-Code-specific: the agent is the `spec`, and a second agent is a second
 * call with different names.
 */
export function buildHooks(spec: AgentHookSpec, options: BuildHooksOptions): HookBundle {
  return new ParameterizedHooks(spec, options);
}

/** Narrow a spec's own tool list, for callers that hold a spec but no bundle. */
export function handlesTool(spec: AgentHookSpec, tool: string): boolean {
  return spec.tools.includes(tool);
}
