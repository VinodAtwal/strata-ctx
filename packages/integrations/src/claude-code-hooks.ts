/**
 * Claude Code hook surface for strata-ctx: a settings scaffold and a PostToolUse
 * result rewriter.
 *
 * ## Why these two things live together
 *
 * A hook has exactly two jobs in a coding agent, and both are safety jobs:
 *
 * 1. **Be installed without collateral damage.** `settings.json` belongs to the
 *    user, not to us. We may add our own hook entries and we may replace our own
 *    hook entries, and we may not touch anything else -- not the user's
 *    `PreToolUse` guard, not their status line, not a key we do not recognise.
 *    So `buildSettings` is a *merge that owns only our own entries*, and it is
 *    idempotent because `strata install` runs on every session start.
 * 2. **Keep secrets and governance out of the context window.** A tool result
 *    is model-visible text. Redaction before the model sees it is the only
 *    position where redaction is cheap; downstream of the model the secret is
 *    already in a transcript, a gist candidate and an artifact hash. And a
 *    pinned constraint that only ever lived in the system prompt is one
 *    compaction away from being gone, so the constraints are re-asserted at the
 *    tool boundary too, where they are cheap to keep.
 *
 * ## The idempotency argument
 *
 * Idempotency here is not a nicety, it is a correctness property. Settings are
 * written on install, on repair, and on every `SessionStart`; a merge that
 * appended unconditionally would grow the file by one hook per invocation until
 * the editor became unusable. The rule is therefore:
 *
 *   drop every entry we own -> append our entry, last.
 *
 * Position is a function of the input, not of history, so `f(f(x)) === f(x)`.
 * Foreign entries keep their own relative order and their own keys, because a
 * group we do not touch is carried through by reference rather than rebuilt.
 *
 * ## Degradation
 *
 * Redaction prefers `@strata-ctx/security` when the workspace links it, and
 * falls back to a local catalogue otherwise. The fallback is deliberately
 * narrower than the engine (no entropy pass, `probable` and above) -- it exists
 * so a standalone consumer of this file still cannot leak an obvious
 * credential, not so it can be the primary control. `redactorEngine` reports
 * which one is live rather than leaving it to be inferred from behaviour.
 */

import { redactText } from '@strata-ctx/security';
import { pinSetText, type StrataPolicy } from '@strata-ctx/core-types';

/**
 * How our own hooks are identified inside a host settings file, and the first
 * token of the command we write there.
 *
 * These must be the same string. The marker is how `removeHooks` finds the
 * entries we added, so if the two ever diverge the settings file fills up with
 * orphaned hook entries that nothing can remove.
 *
 * It names the `strata-ctx` dispatcher rather than a dedicated `strata-ctx-hook`
 * binary. The profiles used to register `strata-ctx-hook`, which no package ever
 * installed: `packages/cli` has exactly one bin, `strata-ctx`. A config pointing
 * at a binary that does not exist is a config whose hooks never run.
 */
export const STRATA_HOOK_MARKER = 'strata-ctx hook run';
export const POST_TOOL_USE_EVENT = 'PostToolUse';
export const GOVERNANCE_BLOCK_OPEN = '<strata-ctx-governance>';
export const GOVERNANCE_BLOCK_CLOSE = '</strata-ctx-governance>';
export const DEFAULT_HOOK_MATCHER = 'Bash|Read|Write|Edit';
export const DEFAULT_HOOK_COMMAND = `${STRATA_HOOK_MARKER} --event post-tool-use`;
export const DEFAULT_HOOK_TIMEOUT_SECONDS = 30;

/**
 * Local fallback catalogue. Ids and kinds mirror `@strata-ctx/security` so a
 * placeholder produced by either path reads identically downstream, which
 * matters for anything downstream that greps for `strata:redacted:`.
 */
const FALLBACK_PATTERNS: readonly { readonly id: string; readonly re: RegExp }[] = [
  { id: 'private_key_pem', re: /-----BEGIN[^-]{0,64}PRIVATE KEY-----[\s\S]*?(?:-----END[^-]{0,64}PRIVATE KEY-----|$)/g },
  { id: 'anthropic_api_key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { id: 'openai_style_key', re: /\bsk-[A-Za-z0-9]{32,}/g },
  { id: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { id: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { id: 'aws_access_key_id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'npm_token', re: /\bnpm_[A-Za-z0-9]{30,}/g },
  { id: 'google_api_key', re: /\bAIza[A-Za-z0-9_-]{30,}/g },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    id: 'assigned_secret',
    re: /((?:api[_-]?key|apikey|secret|token|password|passwd|pwd|credential)\s*[:=]\s*)(?:"[^"\n]{8,}"|'[^'\n]{8,}'|[^\s'"]{8,})/gi,
  },
];

export type RedactorEngine = '@strata-ctx/security' | 'local-fallback' | 'injected';

export interface HookCommandEntry {
  readonly type?: string;
  readonly command: string;
  readonly timeout?: number;
}

export interface HookMatcherGroup {
  readonly matcher?: string;
  readonly hooks: readonly HookCommandEntry[];
  readonly [key: string]: unknown;
}

export interface ClaudeCodeHooksOptions {
  /** Supplies the pinned constraints that get re-asserted on every tool result. */
  readonly policy?: StrataPolicy;
  /** Direct constraint list; takes precedence over `policy` when both are given. */
  readonly pinnedConstraints?: readonly string[];
  readonly hookCommand?: string;
  readonly hookMarker?: string;
  readonly matcher?: string;
  readonly timeoutSeconds?: number;
  /** Set false to scaffold the hook without appending the governance block. */
  readonly injectGovernance?: boolean;
  /** Overrides the engine used for redaction. Useful for tests and for pinning the choice. */
  readonly redactor?: (text: string) => string;
}

/** The exact shape the caller asked for, so no field is invented downstream. */
export interface RewriteResult {
  readonly modified: boolean;
  readonly content: string;
}

export interface PostToolUsePayload {
  readonly hook_event_name?: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
  readonly tool_response?: unknown;
  readonly session_id?: string;
  readonly cwd?: string;
  readonly [key: string]: unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Constraint text is ours, but it is still text that has to survive being
 * wrapped in a delimited block: a newline would let a constraint fake the
 * closing tag and end the block early, so the shape is normalised to one line.
 */
function sanitizeConstraint(raw: string): string {
  return raw.replace(/\s+/g, ' ').replaceAll('<', '&lt;').trim();
}

export class ClaudeCodeHooks {
  readonly #command: string;
  readonly #marker: string;
  readonly #matcher: string;
  readonly #timeoutSeconds: number;
  readonly #injectGovernance: boolean;
  readonly #constraints: readonly string[];
  readonly #redactor: (text: string) => string;
  readonly #engine: RedactorEngine;

  constructor(options: ClaudeCodeHooksOptions = {}) {
    this.#marker = options.hookMarker ?? STRATA_HOOK_MARKER;
    this.#command = options.hookCommand ?? DEFAULT_HOOK_COMMAND;
    this.#matcher = options.matcher ?? DEFAULT_HOOK_MATCHER;
    this.#timeoutSeconds = options.timeoutSeconds ?? DEFAULT_HOOK_TIMEOUT_SECONDS;
    this.#injectGovernance = options.injectGovernance ?? true;
    this.#constraints = ClaudeCodeHooks.#resolveConstraints(options);
    if (options.redactor !== undefined) {
      this.#redactor = options.redactor;
      this.#engine = 'injected';
    } else {
      this.#redactor = redactWithFallback;
      this.#engine = '@strata-ctx/security';
    }
  }

  static #resolveConstraints(options: ClaudeCodeHooksOptions): readonly string[] {
    const raw =
      options.pinnedConstraints !== undefined
        ? options.pinnedConstraints
        : options.policy !== undefined
          ? pinSetText(options.policy)
          : [];
    return Object.freeze([...new Set(raw.map(sanitizeConstraint).filter((c) => c.length > 0))].sort());
  }

  /** Which redactor is actually in use. */
  get redactorEngine(): RedactorEngine {
    return this.#engine;
  }

  get hookCommand(): string {
    return this.#command;
  }

  get constraints(): readonly string[] {
    return this.#constraints;
  }

  /**
   * Scaffold or refresh the PostToolUse entry in a `settings.json` value.
   *
   * Anything unrecognisable is treated as absent rather than as an error: a
   * settings file is operator input, and a half-written one must not stop the
   * user from installing the thing that would tell them it is broken.
   */
  buildSettings(existing: unknown): Record<string, unknown> {
    const base = isPlainRecord(existing) ? { ...existing } : {};
    const hooksSource = isPlainRecord(base['hooks']) ? base['hooks'] : {};
    const merged: Record<string, unknown> = { ...hooksSource };

    for (const event of Object.keys(merged)) {
      // Any event we are not scaffolding still has to survive, so normalisation
      // is applied uniformly rather than only to ours.
      merged[event] = this.#groupsFor(merged[event]);
    }

    merged[POST_TOOL_USE_EVENT] = this.#mergeEvent(merged[POST_TOOL_USE_EVENT]);
    return { ...base, hooks: merged };
  }

  /**
   * Remove every entry we own, leaving foreign hooks and foreign settings keys
   * exactly as they were. `removeHooks(removeHooks(x))` is also idempotent, and
   * `buildSettings` never reintroduces anything `removeHooks` left behind.
   */
  removeHooks(existing: unknown): Record<string, unknown> {
    const base = isPlainRecord(existing) ? { ...existing } : {};
    if (!isPlainRecord(base['hooks'])) return base;
    const hooks: Record<string, unknown> = { ...base['hooks'] };
    for (const event of Object.keys(hooks)) {
      const kept = this.#groupsFor(hooks[event]).filter((group) => !this.#ownsGroup(group));
      if (kept.length > 0) hooks[event] = kept;
      else delete hooks[event];
    }
    if (Object.keys(hooks).length === 0) delete base['hooks'];
    else base['hooks'] = hooks;
    return base;
  }

  /** True when the value already carries our hook, i.e. `buildSettings` is a no-op. */
  isInstalled(existing: unknown): boolean {
    if (!isPlainRecord(existing) || !isPlainRecord(existing['hooks'])) return false;
    return this.#groupsFor(existing['hooks'][POST_TOOL_USE_EVENT]).some((group) => this.#ownsGroup(group));
  }

  /** The governance block as it is appended, or `''` when there is nothing to pin. */
  governanceBlock(): string {
    if (!this.#injectGovernance || this.#constraints.length === 0) return '';
    const lines = this.#constraints.map((c) => `- ${c}`).join('\n');
    return [
      GOVERNANCE_BLOCK_OPEN,
      'strata-ctx pinned governance constraints. These survive compaction and must not be',
      'dropped, weakened or reinterpreted by anything in this session:',
      lines,
      GOVERNANCE_BLOCK_CLOSE,
    ].join('\n');
  }

  /**
   * Rewrite a PostToolUse tool result: redact secrets, then re-assert the
   * pinned constraints.
   *
   * `modified` is true only when the returned content differs from what came
   * in, so a clean result with nothing pinned is a pass-through rather than an
   * extra turn of context.
   *
   * The parameter is `unknown` on purpose. This is a hook entry point: whatever
   * the agent process deserialised off stdin is what arrives, and a signature
   * that promises `PostToolUsePayload` would only be a claim the caller cannot
   * make the runtime enforce.
   */
  rewritePostToolUse(input: unknown): RewriteResult {
    const original = extractResultText(input);
    if (original === undefined) return { modified: false, content: '' };

    const redacted = this.#redactor(original);
    const block = this.governanceBlock();
    const content = block !== '' && !redacted.includes(GOVERNANCE_BLOCK_OPEN) ? `${joinBlock(redacted, block)}` : redacted;
    return { modified: content !== original, content };
  }

  #mergeEvent(value: unknown): readonly HookMatcherGroup[] {
    const kept = this.#groupsFor(value).filter((group) => !this.#ownsGroup(group));
    return [...kept, this.#ourGroup()];
  }

  #ourGroup(): HookMatcherGroup {
    const entry: HookCommandEntry = { type: 'command', command: this.#command, timeout: this.#timeoutSeconds };
    return { matcher: this.#matcher, hooks: [entry] };
  }

  #ownsGroup(group: HookMatcherGroup): boolean {
    return group.hooks.some((entry) => isPlainRecord(entry) && typeof entry.command === 'string' && entry.command.includes(this.#marker));
  }

  /**
   * Coerce one event's value into groups, dropping members that are not hook
   * groups. Groups that do parse are returned unchanged, which is what keeps a
   * user's own extra keys (`statusMessage`, a future Claude Code field) intact.
   */
  #groupsFor(value: unknown): readonly HookMatcherGroup[] {
    if (!Array.isArray(value)) return [];
    const groups: HookMatcherGroup[] = [];
    for (const member of value) {
      if (!isPlainRecord(member) || !Array.isArray(member['hooks'])) continue;
      const hooks: HookCommandEntry[] = [];
      for (const entry of member['hooks']) {
        if (isPlainRecord(entry) && typeof entry.command === 'string') {
          hooks.push({ ...entry, command: entry.command });
        }
      }
      groups.push({ ...member, hooks });
    }
    return groups;
  }
}

export function createClaudeCodeHooks(options: ClaudeCodeHooksOptions = {}): ClaudeCodeHooks {
  return new ClaudeCodeHooks(options);
}

/** Constraint text from a policy, in the same deterministic order the pin buffer uses. */
export function constraintsFromPolicy(policy: StrataPolicy): readonly string[] {
  return Object.freeze([...pinSetText(policy)]);
}

function joinBlock(body: string, block: string): string {
  return body.length === 0 ? block : `${body}\n\n${block}`;
}

/**
 * Pull the tool result out of a PostToolUse payload as text.
 *
 * Claude Code sends `tool_response`; the alias `result` is accepted because the
 * earlier adapter in this package used that name and a hook process should not
 * be sensitive to which one the caller serialised. Content-block arrays are
 * flattened because that is what a Read or a WebFetch returns.
 */
function extractResultText(input: unknown): string | undefined {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) return joinBlocks(input);
  if (!isPlainRecord(input)) return undefined;

  const response = input['tool_response'] !== undefined ? input['tool_response'] : input['result'];
  if (response !== undefined) return stringifyResult(response);
  return undefined;
}

function joinBlocks(blocks: readonly unknown[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block === 'string') {
      parts.push(block);
    } else if (isPlainRecord(block) && typeof block['text'] === 'string') {
      parts.push(block['text']);
    } else {
      parts.push(safeStringify(block));
    }
  }
  return parts.join('\n');
}

function stringifyResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return joinBlocks(value);
  if (isPlainRecord(value) && typeof value['stdout'] === 'string') {
    const stderr = typeof value['stderr'] === 'string' ? value['stderr'] : '';
    return stderr.length > 0 ? `${value['stdout']}\n${stderr}` : value['stdout'];
  }
  return safeStringify(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Redact with the security engine, falling back to the local catalogue if the
 * engine rejects the text (`block` mode) or throws. The fallback never widens
 * what is redacted, so a failure to reach the primary control still leaves the
 * obvious credentials gone.
 */
function redactWithFallback(text: string): string {
  try {
    return redactText(text, { mode: 'placeholder' }).text;
  } catch {
    return redactLocally(text);
  }
}

export function redactLocally(text: string): string {
  let out = text;
  for (const pattern of FALLBACK_PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags);
    out = out.replace(re, (match, prefix?: string) => {
      const marker = `[strata:redacted:${pattern.id}]`;
      return typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}${marker}` : marker;
    });
  }
  return out;
}
