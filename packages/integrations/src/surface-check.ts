/**
 * E-8 — surface check: the gate that notices when a hook name moves.
 *
 * ## What this is for
 *
 * `docs/integrations.md` §2 marks four rows of the feasibility matrix `verify`
 * and says why in one sentence: "treat the *pattern* as durable and the *hook
 * names* as a moving target." The per-agent integrations depend on names that
 * live in somebody else's product — Claude Code lifecycle events, Gemini CLI
 * hook entries, the OpenCode plugin hook signature. When one of those is
 * renamed, nothing in this repository fails. The hook stops firing, compaction
 * silently stops happening in the field, and every local test is still green
 * because every local test exercises *our* side of the contract. That is the
 * worst failure mode available: invisible until a user reports it.
 *
 * So this file is a **drift detector, not a scraper**. It compares three
 * different kinds of statement and reports on the ones that disagree:
 *
 * | Statement | Where it comes from | Disagreement means |
 * |---|---|---|
 * | **assumption** | the snapshot, hand-maintained, cited to a source | a human judgement is now wrong — decide, do not re-pin |
 * | **derived** | the live adapters, recomputed on every run | our code moved and the snapshot is stale — refresh it |
 * | **observed** | a recorded capture of a real agent install | the *world* moved — fix the adapter, not the snapshot |
 *
 * Keeping those three apart is the whole design. A single "diff the snapshot"
 * gate could be satisfied by re-pinning, which is exactly the response that
 * makes a hook that no longer exists look healthy. `--update` therefore refuses
 * to write while an assumption or a recorded observation disagrees with the
 * code; only derived fields are ever rewritten. A judgement cannot be laundered
 * into a green build by running a command.
 *
 * ## Offline by construction
 *
 * The checker opens no sockets. Verifying a live surface would mean fetching a
 * vendor's docs or shelling out to the agent binary, and both make CI
 * non-deterministic and impossible on a sandboxed runner. The observed third of
 * the triangle is therefore a **probe with a recorded fixture**: a maintainer
 * with the real agent in front of them captures what the surface looks like into
 * `observations` in the snapshot, with the version, the date and where they read
 * it, and the gate compares against that. An agent with no recorded observation
 * is reported as `unverified` and does not fail — we genuinely cannot check it,
 * and a gate that cries wolf about every agent forever is a gate that gets
 * muted. An observation that *is* recorded and disagrees fails loudly, because
 * that is evidence rather than noise. `SurfaceProbe` is the seam where a
 * networked probe would be injected; none exists, on purpose.
 *
 * ## Blocking and advisory
 *
 * Findings are `blocking` or `advisory`, and the exit code follows the blocking
 * ones only. The distinction exists for a specific reason: this repository already
 * has a live mismatch it does not own — the profile layer advertises `ctx_*` MCP
 * tool names the server does not serve — and a gate that has been red since the
 * day it was written is a gate that gets muted within a week. An advisory is
 * printed on every run and compared against the snapshot like anything else, so
 * the day it *changes*, that change is a blocking `code-drift`. It just does not
 * turn a green branch red for a decision somebody else has to make.
 *
 * ## Provenance, per field
 *
 * `mechanism`, `confidence`, `declaredPayloadKeys` and — for the one agent
 * whose hook map cannot be reached without a policy — `hookEvents` are
 * **assumed**: hand-written in the snapshot and cited to the declaration they
 * rest on. `confidence` mirrors the `Conf.` column of `docs/integrations.md` §2;
 * `mechanism` is a claim we make about the agent, cross-checked against the
 * capability registry; `declaredPayloadKeys` is a payload shape as a TypeScript
 * interface declares it, which no runtime probe can read. Everything else is
 * **derived**, mostly by calling the adapter rather than by re-reading its
 * source. `hookEventsSource` on each agent says which half that agent's event
 * list is, so the finding names the right remedy.
 *
 * The keys an adapter acts on are recorded as two lists, `requestKeysInUse` and
 * `resultKeysInUse`, because they are two halves of a different protocol: keys of
 * the hook request a normaliser reads, and keys of the tool result a rewriter
 * reads. Merged into one list they produce a false positive the moment a rewriter
 * is pointed at `output` or `stdout`, because a result key is not a request key
 * and no payload interface ever declares it.
 *
 * ## What this cannot do
 *
 * It cannot prove an assumption is true. Three ways it can be wrong, all of them
 * real: a field in a TypeScript interface nobody probes; a vendor rename that
 * has not been captured as an observation yet; and a new agent appearing
 * upstream that we have not built for. The package's own test suite covers the
 * first of those. What this file does is narrower and worth stating exactly:
 * **it makes a change of assumption visible, attributed to the agent surface it
 * affects, at the moment somebody makes it.**
 *
 * ## Update path
 *
 * Also in `--help` and in the snapshot's own `note`:
 *
 * 1. A surface moved, or we started depending on a new one.
 * 2. Read the agent's docs or dump its config. Record what you saw in
 *    `observations[]` with `agentVersion`, `recordedAt` and `source`. That entry
 *    is hand-maintained on purpose — the checker will not invent evidence about
 *    itself.
 * 3. Run `--print` to see what the code currently assumes, and diff it against
 *    the observation.
 * 4. Fix the adapter so the derived facts match the observation.
 * 5. `surface-check --update` to refresh the derived half. It refuses while a
 *    surface or an assumption still disagrees, so steps 2 and 4 are not
 *    optional.
 * 6. Write the decision down. A hook name is a compatibility decision, and
 *    `docs/decisions.md` is where compatibility decisions live.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COPILOT_AGENT_ID,
  COPILOT_MCP_JSON_PATH,
  COPILOT_VSCODE_SETTINGS_PATH,
  GUARANTEE_ORDER,
  STRATA_MCP_TOOLS,
  buildCopilotMcpConfig,
  compareGuarantees,
  type GovernanceGuaranteeTier,
} from './copilot.js';
import {
  DEFAULT_HOOK_MATCHER,
  POST_TOOL_USE_EVENT,
  createClaudeCodeHooks,
} from './claude-code-hooks.js';
import { CLAUDE_HOOK_NAMES, GIST_SENTINEL } from './claude-code-observers.js';
import { GEMINI_CONTEXT_FILE, GEMINI_TOOLS, geminiHookSpec } from './gemini.js';
import { HOOK_EVENTS, normalizeHookRequest } from './hook-builder.js';
import { TOOL_SCHEMAS, resolveToolName } from './mcp-server.js';
import {
  OPENCODE_AGENT_ID,
  OPENCODE_PLUGIN_DIR,
  OPENCODE_PLUGIN_FILE,
  OPENCODE_RULES_FILE,
  OPENCODE_TOOLS,
  openCodeHookSpec,
} from './opencode.js';
import { AGENT_IDS, MCP_TOOLS, buildProfile, launchRecipe, type AgentId } from './profiles.js';
import { FENCE, SELF_GIST_DIRECTIVE, SELF_GIST_LANGUAGE, SELF_GIST_SENTINEL } from './templates.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bumped whenever the snapshot's own shape changes; checked before anything else. */
export const SURFACE_SNAPSHOT_VERSION = 1;

/** Beside `package.json`, matching `packages/core-types/contract.lock.json`. */
export const SNAPSHOT_FILE_NAME = 'surface-check.snapshot.json';

/**
 * The agent id the Claude Code adapter reports.
 *
 * `claude-code-hooks.ts` has no agent-id constant the way `gemini.ts`,
 * `opencode.ts` and `copilot.ts` do, so this literal is the only such name in the
 * package. It has to stay the capability registry's key in `copilot.ts`
 * (`AGENT_CAPABILITIES`), and `deriveGuarantee` fails the gate if the two
 * diverge — which is how a silent rename in the registry gets caught instead of
 * quietly downgrading every Claude Code claim to `none`.
 */
export const CLAUDE_CODE_AGENT_ID = 'claude-code';

/**
 * OpenCode's plugin hook names, from the `OpenCodePluginHooks` map in
 * `opencode.ts`.
 *
 * Assumed rather than derived: the map is built by a plugin constructor that
 * wants a `StrataPolicy`, and a gate that assembles a policy to read a key list
 * is a gate carrying a second copy of the policy defaults. `surface-check.test.ts`
 * asserts these three names against a real plugin instance, so the assumption is
 * exercised — just not by the gate.
 */
export const OPENCODE_PLUGIN_HOOK_NAMES: readonly string[] = [
  'tool.execute.before',
  'tool.execute.after',
  'experimental.session.compacting',
];

/**
 * A value with no secret in it. The Claude Code payload probe looks for a
 * non-empty extraction rather than a redaction marker, precisely so the probe
 * does not have to know the redaction engine's placeholder format — that format
 * is a moving target of its own and this gate must not become a second thing
 * that can be wrong.
 */
const PROBE_CANARY = 'strata-surface-check-canary';

/**
 * Candidate container keys for a Claude Code `PostToolUse` payload.
 *
 * A probe can only recognise a name it thinks to try, so this list is the honest
 * limit of the derived half: a rename to a name outside it is invisible to the
 * probe, which is the reason the snapshot also carries recorded observations. It
 * is deliberately generous for that reason — `tool_response` plus the historical
 * `result` alias, plus every container key a tool result has plausibly used.
 */
const RESULT_CONTAINER_CANDIDATES: readonly string[] = [
  'tool_response',
  'result',
  'output',
  'stdout',
  'stderr',
  'content',
  'text',
];

/**
 * Candidate spellings of the two fields a hook process reads off its host's
 * payload. `sessionID` (OpenCode) and `session_id` (Claude Code) are one fact
 * spelled two ways, and that difference is precisely what this gate exists for.
 */
const SESSION_KEY_CANDIDATES: readonly string[] = ['sessionId', 'sessionID', 'session_id', 'id'];
const TOOL_KEY_CANDIDATES: readonly string[] = ['tool', 'tool_name', 'toolName', 'name'];

/**
 * Roots used to derive path-shaped facts. Absolute and constant, so the derived
 * record has no dependency on the working directory and two runs on two machines
 * produce identical bytes.
 */
const DERIVE_ROOT = '/strata-surface-check';
const DERIVE_CONFIG_DIR = '/strata-surface-check-config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How we get governance in front of this agent. A claim, so it is cross-checked. */
export type SurfaceMechanism = 'settings-json' | 'plugin-module' | 'mcp-only' | 'proxy-only';

/** The `Conf.` column of `docs/integrations.md` §2, restated. */
export type SurfaceConfidence = 'verify' | 'high';

export type SurfaceClaimSource = 'derived' | 'assumed';

/** The declared shape of a hook entry, as the installer writes it. */
export interface SettingsShape {
  /** `''` when the adapter is handed a value and never names a file. */
  readonly file: string;
  /** Key holding the hook list in the settings file. */
  readonly listKey: string;
  /** Key naming the event on an entry; `''` when the event *is* the list key. */
  readonly eventKey: string;
  readonly commandKey: string;
  readonly entryKeys: readonly string[];
  /** `''` when the adapter owns no instruction file. */
  readonly instructionFile: string;
}

/** Where a credential can hide in a tool result, as the adapter's spec says. */
export interface ResultRewriteShape {
  readonly wholeResult: boolean;
  readonly stringPaths: readonly string[];
}

/** Everything this repository assumes about one agent's extension surface. */
export interface AgentSurface {
  /** assumed — see the module header. */
  readonly mechanism: SurfaceMechanism;
  /** assumed — `docs/integrations.md` §2, `Conf.` column. */
  readonly confidence: SurfaceConfidence;
  /** assumed — the payload shape as a TypeScript interface declares it. */
  readonly declaredPayloadKeys: readonly string[];
  /** Whether `hookEvents` is recomputed from the adapter or pinned by hand. */
  readonly hookEventsSource: SurfaceClaimSource;
  /** Provenance for a human reading a finding; not compared. */
  readonly modules: readonly string[];
  /** derived */
  readonly guaranteeTier: GovernanceGuaranteeTier;
  /** derived */
  readonly hooks: boolean;
  /** derived or assumed, per `hookEventsSource` — the external event names. */
  readonly hookEvents: readonly string[];
  /** derived — request-envelope keys the adapter reads, however that was established. */
  readonly requestKeysInUse: readonly string[];
  /** derived — keys of the result object the rewriter reads. */
  readonly resultKeysInUse: readonly string[];
  /** derived */
  readonly tools: readonly string[];
  /** derived — `null` for the E-2 adapter, which predates the shared spec. */
  readonly resultRewrite: ResultRewriteShape | null;
  /** derived */
  readonly settings: SettingsShape | null;
  /** derived — config artifacts the integration reads or writes. */
  readonly profiles: readonly string[];
  /** derived — CLI flags a launch recipe passes; empty when there is none. */
  readonly launchFlags: readonly string[];
}

export interface McpSurface {
  /** What the profile layer advertises to the agent. */
  readonly advertised: readonly string[];
  /** What the Copilot path advertises. A second copy that must agree. */
  readonly advisoryAdvertised: readonly string[];
  /** Tools the MCP server actually serves. */
  readonly served: readonly string[];
  /** Advertised names the server cannot resolve. Non-empty is a bug, not drift. */
  readonly unresolved: readonly string[];
}

/**
 * The self-gist protocol markers.
 *
 * AGENTS.md §10 is explicit that the two `SELF_GIST_DIRECTIVE` exports are
 * deliberately *not* byte-identical and must not be made so, and that the real
 * invariant is narrower: the fence and the sentinel must agree, or the parser
 * never fires. `agrees` is that invariant, computed rather than asserted.
 */
export interface SelfGistSurface {
  readonly fence: string;
  readonly language: string;
  readonly sentinel: string;
  /** The language the observer that scans the stream looks for. */
  readonly parserLanguage: string;
  readonly directiveCarriesFence: boolean;
  readonly directiveCarriesSentinel: boolean;
  readonly agrees: boolean;
}

export interface DerivationError {
  readonly agent: string;
  readonly message: string;
}

export interface DerivedSurfaces {
  readonly agents: Readonly<Record<string, AgentSurface>>;
  readonly mcp: McpSurface;
  readonly selfGist: SelfGistSurface;
  readonly errors: readonly DerivationError[];
}

/**
 * A recorded capture of a real agent install. Hand-maintained: the checker is
 * offline by design and will never write one of these itself.
 *
 * An observation missing `agentVersion`, `recordedAt` or `source` is rejected.
 * Evidence that cannot be dated or attributed is worse than none, because it
 * converts a visible "unverified" into an invisible "verified".
 */
export interface SurfaceObservation {
  readonly agent: string;
  readonly agentVersion: string;
  readonly recordedAt: string;
  /** Where the capture came from: a docs URL, a command that was run, a bug id. */
  readonly source: string;
  readonly hookEvents: readonly string[];
  readonly payloadKeys: readonly string[];
  readonly toolNames: readonly string[];
}

export interface SurfaceSnapshot {
  readonly version: number;
  readonly package: string;
  readonly note: string;
  readonly agents: Readonly<Record<string, AgentSurface>>;
  readonly mcp: McpSurface;
  readonly selfGist: SelfGistSurface;
  readonly observations: readonly SurfaceObservation[];
}

/**
 * The seam a live probe would be injected through.
 *
 * A networked or subprocess implementation belongs here: it returns the same
 * `SurfaceObservation` for an agent it could reach and `undefined` for one it
 * could not, and nothing else in this file changes. None exists, on purpose —
 * see the module header.
 */
export type SurfaceProbe = (agent: string) => SurfaceObservation | undefined;

/**
 * Why a check failed.
 *
 * `code-drift` and `surface-drift` are the two the task is really about, and
 * they have opposite remedies: the first means *we* moved, the second means the
 * agent did. `assumption-drift` is the third kind — a pinned judgement that no
 * longer holds — kept separate so `--update` can refuse to rewrite it.
 */
export type SurfaceFindingKind =
  | 'snapshot-invalid'
  | 'unknown-agent'
  | 'missing-agent'
  | 'code-drift'
  | 'assumption-drift'
  | 'surface-drift'
  | 'invariant-broken'
  | 'probe-error';

/**
 * Whether a finding should fail the gate.
 *
 * A drift detector that goes red on a pre-existing, unrelated mismatch is a gate
 * people learn to ignore, so a known fact that this repository has already decided
 * how to live with is recorded as an `advisory`: it is printed on every run, it is
 * compared against the snapshot like anything else, and a *change* to it is still
 * blocking `code-drift`. It just does not turn a green branch red on day one.
 */
export type SurfaceSeverity = 'blocking' | 'advisory';

export interface SurfaceFinding {
  readonly kind: SurfaceFindingKind;
  readonly severity: SurfaceSeverity;
  /** `''` for a module-level finding such as the MCP tool list. */
  readonly agent: string;
  /** The fact that drifted: `hookEvents`, `mcp`, `selfGist`, … */
  readonly surface: string;
  readonly message: string;
  readonly expected?: readonly string[];
  readonly actual?: readonly string[];
}

export interface SurfaceCheckResult {
  readonly ok: boolean;
  readonly derived: DerivedSurfaces;
  /** Every finding, blocking and advisory alike, in report order. */
  readonly findings: readonly SurfaceFinding[];
  /** The subset that decides the exit code. */
  readonly blocking: readonly SurfaceFinding[];
  /** Reported on every run, counted by none. */
  readonly advisories: readonly SurfaceFinding[];
  /** Agents with no recorded observation. Reported, not failed. */
  readonly unverified: readonly string[];
  readonly checkedAgents: readonly string[];
}

export interface SnapshotIssue {
  readonly path: string;
  readonly message: string;
}

export type SnapshotValidation =
  | { readonly ok: true; readonly snapshot: SurfaceSnapshot }
  | { readonly ok: false; readonly issues: readonly SnapshotIssue[] };

export interface SurfaceCheckIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface UpdateResult {
  readonly ok: boolean;
  readonly changed: boolean;
  readonly findings: readonly SurfaceFinding[];
  /** The file body to write, or `''` when nothing should be written. */
  readonly text: string;
  /** Set when the write loses something a human has to put back. */
  readonly warning?: string;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

class SurfaceDerivationError extends Error {
  readonly agent: string;

  constructor(agent: string, message: string) {
    super(message);
    this.name = 'SurfaceDerivationError';
    this.agent = agent;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The first element of a list-shaped settings value, as a record.
 *
 * `Array.isArray` narrows to `any[]`, so indexing it would hand the rest of the
 * checker an `any` to carry into places that are supposed to stay `unknown`.
 */
function firstRecord(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  const first: unknown = value[0];
  return isRecord(first) ? first : undefined;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathKey(path: readonly string[]): string {
  return path.join('.');
}

/**
 * Every payload key the adapter depends on, both halves of the protocol.
 *
 * A capture of a real agent reports the keys its hook payload carries, not which
 * half of the pipeline reads them, so an observation is compared against the union.
 */
function keysInUse(surface: AgentSurface): readonly string[] {
  return uniqueSorted([...surface.requestKeysInUse, ...surface.resultKeysInUse]);
}

/** The guarantee tier the shipped capability registry claims for an agent. */
function deriveGuarantee(agent: string): {
  readonly guaranteeTier: GovernanceGuaranteeTier;
  readonly hooks: boolean;
} {
  const guarantees = compareGuarantees(agent);
  if (!guarantees.known) {
    throw new SurfaceDerivationError(
      agent,
      `the capability registry in copilot.ts has no entry for ${JSON.stringify(agent)}; ` +
        'the agent id and the registry key have drifted apart',
    );
  }
  return { guaranteeTier: guarantees.tier, hooks: guarantees.hooks };
}

function deriveClaudeCode(): AgentSurface {
  const hooks = createClaudeCodeHooks();
  const settings = hooks.buildSettings({});
  const hooksNode = isRecord(settings['hooks']) ? settings['hooks'] : {};
  const group = firstRecord(hooksNode[POST_TOOL_USE_EVENT]);
  const entry = firstRecord(group?.['hooks']);
  // The keys actually written into a settings value, so a renamed Claude Code
  // settings key (`matcher`, `timeout`) surfaces without anyone reading a diff.
  const entryKeys = uniqueSorted([...Object.keys(group ?? {}), ...Object.keys(entry ?? {})]);
  return {
    mechanism: 'settings-json',
    confidence: 'verify',
    // `PostToolUsePayload` in claude-code-hooks.ts. `result` is the alias the
    // extractor accepts because the earlier adapter in this package used it.
    declaredPayloadKeys: [
      'cwd',
      'hook_event_name',
      'result',
      'session_id',
      'tool_input',
      'tool_name',
      'tool_response',
    ],
    hookEventsSource: 'derived',
    modules: ['src/claude-code-hooks.ts', 'src/claude-code-observers.ts'],
    ...deriveGuarantee(CLAUDE_CODE_AGENT_ID),
    hookEvents: uniqueSorted([POST_TOOL_USE_EVENT, ...CLAUDE_HOOK_NAMES]),
    requestKeysInUse: [],
    resultKeysInUse: probeResultContainerKeys(hooks),
    tools: uniqueSorted(DEFAULT_HOOK_MATCHER.split('|')),
    // No `ResultRewriteSpec` here: this adapter predates hook-builder.ts and
    // redacts the extracted text wholesale. The container key it reads is
    // already recorded in `resultKeysInUse`.
    resultRewrite: null,
    settings: {
      // The event is a *key* under `hooks`, not a field on an entry, so
      // `eventKey` is empty and `hookEvents` is the authority.
      file: '',
      listKey: 'hooks',
      eventKey: '',
      commandKey: 'command',
      entryKeys,
      // No instruction file: the adapter appends its governance block to the
      // tool result, and `templates.ts` renders `CLAUDE.md` for the caller to
      // place. The E-2 adapter on the other hand is not this one.
      instructionFile: '',
    },
    profiles: [],
    launchFlags: [],
  };
}

/**
 * Which result container keys the rewriter actually reads, found by asking it.
 *
 * `rewritePostToolUse` returns `content: ''` for a payload it cannot extract a
 * result from, so a non-empty extraction is a signal that depends on nothing but
 * the adapter: no redaction engine, no policy, no placeholder format.
 */
function probeResultContainerKeys(hooks: ReturnType<typeof createClaudeCodeHooks>): readonly string[] {
  const honoured: string[] = [];
  for (const key of RESULT_CONTAINER_CANDIDATES) {
    const payload: Record<string, unknown> = { [key]: PROBE_CANARY };
    if (hooks.rewritePostToolUse(payload).content !== '') honoured.push(key);
  }
  return uniqueSorted(honoured);
}

/** Keys the shared request normaliser actually honours, found by asking it. */
function probeSharedRequestKeys(): readonly string[] {
  const honoured: string[] = [];
  for (const key of SESSION_KEY_CANDIDATES) {
    const normalized = normalizeHookRequest({ tool: PROBE_CANARY, [key]: PROBE_CANARY });
    if (normalized.ok && normalized.request.sessionId === PROBE_CANARY) honoured.push(key);
  }
  for (const key of TOOL_KEY_CANDIDATES) {
    const normalized = normalizeHookRequest({ [key]: PROBE_CANARY, sessionId: PROBE_CANARY });
    if (normalized.ok && normalized.request.tool === PROBE_CANARY) honoured.push(key);
  }
  return uniqueSorted(honoured);
}

function deriveGemini(): AgentSurface {
  const spec = geminiHookSpec({ configDir: DERIVE_CONFIG_DIR, projectRoot: DERIVE_ROOT });
  if (spec.hooks.kind !== 'settings-json') {
    throw new SurfaceDerivationError(spec.agent, 'geminiHookSpec() no longer declares a settings-json hook surface');
  }
  return {
    mechanism: 'settings-json',
    confidence: 'verify',
    // `normalizeHookRequest` in hook-builder.ts is the wire shape of a hook
    // process's stdin; `result` is the post-tool-use payload key.
    declaredPayloadKeys: ['parameters', 'result', 'runId', 'sessionId', 'state', 'tool', 'turn'],
    hookEventsSource: 'derived',
    modules: ['src/gemini.ts'],
    ...deriveGuarantee(spec.agent),
    hookEvents: uniqueSorted(HOOK_EVENTS),
    requestKeysInUse: probeSharedRequestKeys(),
    resultKeysInUse: uniqueSorted(spec.rewrite.stringPaths.map(pathKey)),
    tools: uniqueSorted(GEMINI_TOOLS),
    resultRewrite: {
      wholeResult: spec.rewrite.wholeResult,
      stringPaths: uniqueSorted(spec.rewrite.stringPaths.map(pathKey)),
    },
    settings: {
      file: basename(spec.hooks.path),
      listKey: spec.hooks.listKey,
      eventKey: spec.hooks.eventKey,
      commandKey: spec.hooks.commandKey,
      // A restatement of the entry `buildHooks` writes, not an observation of a
      // written file: the builder needs a policy, and a gate that assembles a
      // policy to inspect a shape is a gate carrying a second copy of the policy
      // defaults.
      entryKeys: uniqueSorted([spec.hooks.eventKey, spec.hooks.commandKey, 'timeout']),
      instructionFile: GEMINI_CONTEXT_FILE,
    },
    profiles: uniqueSorted([basename(spec.hooks.path), GEMINI_CONTEXT_FILE]),
    launchFlags: [],
  };
}

function deriveOpenCode(): AgentSurface {
  const spec = openCodeHookSpec({ rootDir: DERIVE_ROOT });
  if (spec.hooks.kind !== 'settings-json') {
    throw new SurfaceDerivationError(spec.agent, 'openCodeHookSpec() no longer declares a settings-json hook surface');
  }
  const surface = spec.hooks;
  return {
    mechanism: 'plugin-module',
    confidence: 'verify',
    // `OpenCodeToolCallInput` / `OpenCodeToolExecuteBeforeOutput` /
    // `OpenCodeToolExecuteAfterOutput` in opencode.ts. `sessionID` and `tool`
    // are additionally exercised against a live plugin in
    // `surface-check.test.ts`, which can afford the policy a plugin needs.
    declaredPayloadKeys: ['args', 'callID', 'output', 'sessionID', 'tool'],
    hookEventsSource: 'assumed',
    modules: ['src/opencode.ts'],
    ...deriveGuarantee(OPENCODE_AGENT_ID),
    hookEvents: uniqueSorted(OPENCODE_PLUGIN_HOOK_NAMES),
    requestKeysInUse: [],
    resultKeysInUse: uniqueSorted(spec.rewrite.stringPaths.map(pathKey)),
    tools: uniqueSorted(OPENCODE_TOOLS),
    resultRewrite: {
      wholeResult: spec.rewrite.wholeResult,
      stringPaths: uniqueSorted(spec.rewrite.stringPaths.map(pathKey)),
    },
    settings: {
      file: basename(surface.path),
      listKey: surface.listKey,
      eventKey: surface.eventKey,
      commandKey: surface.commandKey,
      entryKeys: uniqueSorted([surface.eventKey, surface.commandKey, 'timeout']),
      instructionFile: OPENCODE_RULES_FILE,
    },
    profiles: uniqueSorted([
      basename(surface.path),
      OPENCODE_RULES_FILE,
      `${OPENCODE_PLUGIN_DIR}/${OPENCODE_PLUGIN_FILE}`,
    ]),
    launchFlags: [],
  };
}

function deriveOpenAiCompatibleAgent(agent: AgentId): AgentSurface {
  const profile = buildProfile(agent);
  const recipe = launchRecipe(agent);
  return {
    mechanism: 'proxy-only',
    // `docs/integrations.md` §2 marks all three `High`, and it is a matrix
    // judgement rather than a hook schema we are guessing at.
    confidence: 'high',
    declaredPayloadKeys: [],
    hookEventsSource: 'derived',
    modules: ['src/profiles.ts'],
    ...deriveGuarantee(agent),
    hookEvents: [],
    requestKeysInUse: [],
    resultKeysInUse: [],
    tools: [],
    resultRewrite: null,
    settings: null,
    profiles: uniqueSorted([profile.fileName]),
    // The flags are the integration: a renamed `--openai-api-base` yields a
    // profile that looks installed and talks to a provider directly.
    launchFlags: uniqueSorted(recipe.argv.filter((arg) => arg.startsWith('--'))),
  };
}

function deriveCopilot(): AgentSurface {
  const config = buildCopilotMcpConfig();
  // Read the keys off every emitted server rather than off one named server:
  // `buildCopilotMcpConfig` allows a custom `serverName`, and a check that only
  // understood the default name would pass while missing the shape users get.
  const serverEntryKeys = uniqueSorted(
    Object.values(config.mcpJsonFile.mcpServers).flatMap((server) => Object.keys(server)),
  );
  return {
    mechanism: 'mcp-only',
    // `docs/integrations.md` §2 leaves the VS Code extension row unmarked, and
    // §6 plus ADR-12 make "MCP-only, no governance guarantee" a documented
    // conclusion rather than an unverified guess.
    confidence: 'high',
    declaredPayloadKeys: [],
    hookEventsSource: 'derived',
    modules: ['src/copilot.ts'],
    ...deriveGuarantee(COPILOT_AGENT_ID),
    // A deliberately empty list, and the invariant in `liveInvariants` is what
    // keeps it that way: §6 and copilot.ts's own header both say why. Emitting
    // a hook entry for a surface that does not exist would be a claim the user
    // reads as enforcement.
    hookEvents: [],
    requestKeysInUse: [],
    resultKeysInUse: [],
    tools: [],
    resultRewrite: null,
    settings: {
      file: basename(COPILOT_MCP_JSON_PATH),
      listKey: 'mcpServers',
      eventKey: '',
      commandKey: 'command',
      entryKeys: serverEntryKeys,
      instructionFile: '',
    },
    profiles: uniqueSorted([basename(COPILOT_MCP_JSON_PATH), basename(COPILOT_VSCODE_SETTINGS_PATH)]),
    launchFlags: [],
  };
}

function deriveAgent(agent: string): AgentSurface {
  switch (agent) {
    case CLAUDE_CODE_AGENT_ID:
      return deriveClaudeCode();
    case 'gemini-cli':
      return deriveGemini();
    case OPENCODE_AGENT_ID:
      return deriveOpenCode();
    case COPILOT_AGENT_ID:
      return deriveCopilot();
    case 'aider':
      return deriveOpenAiCompatibleAgent(agent);
    case 'cline':
      return deriveOpenAiCompatibleAgent(agent);
    case 'roo':
      return deriveOpenAiCompatibleAgent(agent);
    default:
      throw new SurfaceDerivationError(agent, `no derivation is registered for agent id ${JSON.stringify(agent)}`);
  }
}

/**
 * Every agent id the adapters can produce, in one list.
 *
 * The union of the four places an id is spelled — the profile registry,
 * `gemini.ts`, `opencode.ts`, `copilot.ts` — plus the Claude Code literal above.
 * Deriving the set rather than pinning it is what makes "an agent was added"
 * visible instead of a silent widening of what the gate covers.
 */
function derivedAgentIds(): readonly string[] {
  return uniqueSorted([CLAUDE_CODE_AGENT_ID, 'gemini-cli', OPENCODE_AGENT_ID, COPILOT_AGENT_ID, ...AGENT_IDS]);
}

function deriveMcp(): McpSurface {
  const served = Object.keys(TOOL_SCHEMAS).sort();
  // `served` is the *canonical* set the handlers are registered under, which
  // is not the set the profile layer advertises: the server registers short
  // names (`get_task`) and resolves the documented `ctx_`-prefixed spellings
  // through `TOOL_ALIASES` at dispatch. Comparing the advertised names against
  // the registered names without resolving first reported all six as
  // unserveable when every one of them answers to `hasTool`. An advisory that
  // is wrong on day one is an advisory that gets muted.
  const unresolvable = (name: string): boolean => !served.includes(resolveToolName(name));
  return {
    advertised: uniqueSorted(MCP_TOOLS),
    advisoryAdvertised: uniqueSorted(STRATA_MCP_TOOLS),
    served,
    // The profile layer auto-approves these names in the generated config. A
    // name the server does not serve is a tool the agent was told to call and
    // then cannot, which surfaces as a silent loss of retrieval.
    unresolved: uniqueSorted(MCP_TOOLS.filter(unresolvable)),
  };
}

function deriveSelfGist(): SelfGistSurface {
  const directiveCarriesFence = SELF_GIST_DIRECTIVE.includes(FENCE);
  const directiveCarriesSentinel = SELF_GIST_DIRECTIVE.includes(SELF_GIST_SENTINEL);
  return {
    fence: FENCE,
    language: SELF_GIST_LANGUAGE,
    sentinel: SELF_GIST_SENTINEL,
    parserLanguage: GIST_SENTINEL,
    directiveCarriesFence,
    directiveCarriesSentinel,
    // AGENTS.md §10: the two SELF_GIST_DIRECTIVE exports must not be made
    // byte-identical; the invariant is that the markers the parser looks for are
    // the ones the directive tells the model to emit.
    agrees:
      directiveCarriesFence &&
      directiveCarriesSentinel &&
      SELF_GIST_LANGUAGE === GIST_SENTINEL &&
      SELF_GIST_LANGUAGE.length > 0,
  };
}

/**
 * Recompute every fact from the live adapters.
 *
 * Failures are collected per agent rather than thrown, so one adapter that
 * cannot be introspected does not blind the gate to the other six — and a probe
 * that throws is reported as a failing check, never as a pass.
 */
export function deriveSurfaces(): DerivedSurfaces {
  const agents: Record<string, AgentSurface> = {};
  const errors: DerivationError[] = [];
  for (const agent of derivedAgentIds()) {
    try {
      agents[agent] = deriveAgent(agent);
    } catch (error) {
      errors.push({
        agent,
        message: error instanceof SurfaceDerivationError ? error.message : errorMessage(error),
      });
    }
  }
  return { agents, mcp: deriveMcp(), selfGist: deriveSelfGist(), errors };
}

// ---------------------------------------------------------------------------
// Snapshot validation
// ---------------------------------------------------------------------------

const MECHANISMS: readonly string[] = ['settings-json', 'plugin-module', 'mcp-only', 'proxy-only'];
const CONFIDENCES: readonly string[] = ['verify', 'high'];
const CLAIM_SOURCES: readonly string[] = ['derived', 'assumed'];

function isMechanism(value: unknown): value is SurfaceMechanism {
  return typeof value === 'string' && MECHANISMS.includes(value);
}

function isConfidence(value: unknown): value is SurfaceConfidence {
  return typeof value === 'string' && CONFIDENCES.includes(value);
}

function isClaimSource(value: unknown): value is SurfaceClaimSource {
  return typeof value === 'string' && CLAIM_SOURCES.includes(value);
}

function isGuaranteeTier(value: unknown): value is GovernanceGuaranteeTier {
  return typeof value === 'string' && (GUARANTEE_ORDER as readonly string[]).includes(value);
}

class ShapeIssues {
  readonly #issues: SnapshotIssue[] = [];

  add(path: string, message: string): void {
    this.#issues.push({ path, message });
  }

  get list(): readonly SnapshotIssue[] {
    return this.#issues;
  }
}

interface ListOptions {
  readonly allowEmpty?: boolean;
}

function readStringList(
  value: unknown,
  path: string,
  issues: ShapeIssues,
  options: ListOptions = {},
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    issues.add(path, 'expected an array of strings');
    return undefined;
  }
  const names = value.filter((entry): entry is string => typeof entry === 'string');
  if (names.length !== value.length) {
    issues.add(path, `${value.length - names.length} of ${value.length} entries are not strings`);
    return undefined;
  }
  const sorted = uniqueSorted(names);
  if (options.allowEmpty === false && sorted.length === 0) {
    issues.add(path, 'expected at least one entry');
    return undefined;
  }
  return sorted;
}

function readNonEmptyString(value: unknown, path: string, issues: ShapeIssues): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.add(path, 'expected a non-empty string');
    return undefined;
  }
  return value;
}

function readBoolean(value: unknown, path: string, issues: ShapeIssues): boolean | undefined {
  if (typeof value !== 'boolean') {
    issues.add(path, 'expected a boolean');
    return undefined;
  }
  return value;
}

function readSettings(value: unknown, path: string, issues: ShapeIssues): SettingsShape | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) {
    issues.add(path, 'expected an object or null');
    return undefined;
  }
  const strings = ['file', 'listKey', 'eventKey', 'commandKey', 'instructionFile'] as const;
  const read = strings.map((key) => (typeof value[key] === 'string' ? value[key] : undefined));
  if (read.some((entry) => entry === undefined)) {
    issues.add(path, `${strings.join(', ')} must all be strings`);
    return undefined;
  }
  const entryKeys = readStringList(value['entryKeys'], `${path}.entryKeys`, issues);
  if (entryKeys === undefined) return undefined;
  const [file, listKey, eventKey, commandKey, instructionFile] = read;
  return {
    file: file ?? '',
    listKey: listKey ?? '',
    eventKey: eventKey ?? '',
    commandKey: commandKey ?? '',
    entryKeys,
    instructionFile: instructionFile ?? '',
  };
}

function readResultRewrite(value: unknown, path: string, issues: ShapeIssues): ResultRewriteShape | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) {
    issues.add(path, 'expected an object or null');
    return undefined;
  }
  if (typeof value['wholeResult'] !== 'boolean') {
    issues.add(`${path}.wholeResult`, 'expected a boolean');
    return undefined;
  }
  const stringPaths = readStringList(value['stringPaths'], `${path}.stringPaths`, issues);
  if (stringPaths === undefined) return undefined;
  return { wholeResult: value['wholeResult'], stringPaths };
}

function readAgentSurface(value: unknown, path: string, issues: ShapeIssues): AgentSurface | undefined {
  if (!isRecord(value)) {
    issues.add(path, 'expected an object');
    return undefined;
  }
  const { mechanism, confidence, hookEventsSource, guaranteeTier, hooks } = value;
  if (!isMechanism(mechanism)) {
    issues.add(`${path}.mechanism`, `expected one of ${MECHANISMS.join(', ')}`);
    return undefined;
  }
  if (!isConfidence(confidence)) {
    issues.add(`${path}.confidence`, `expected one of ${CONFIDENCES.join(', ')}`);
    return undefined;
  }
  if (!isClaimSource(hookEventsSource)) {
    issues.add(`${path}.hookEventsSource`, `expected one of ${CLAIM_SOURCES.join(', ')}`);
    return undefined;
  }
  if (!isGuaranteeTier(guaranteeTier)) {
    issues.add(`${path}.guaranteeTier`, `expected one of ${GUARANTEE_ORDER.join(', ')}`);
    return undefined;
  }
  if (typeof hooks !== 'boolean') {
    issues.add(`${path}.hooks`, 'expected a boolean');
    return undefined;
  }
  const declaredPayloadKeys = readStringList(value['declaredPayloadKeys'], `${path}.declaredPayloadKeys`, issues);
  const modules = readStringList(value['modules'], `${path}.modules`, issues, { allowEmpty: false });
  const hookEvents = readStringList(value['hookEvents'], `${path}.hookEvents`, issues);
  const requestKeysInUse = readStringList(value['requestKeysInUse'], `${path}.requestKeysInUse`, issues);
  const resultKeysInUse = readStringList(value['resultKeysInUse'], `${path}.resultKeysInUse`, issues);
  const tools = readStringList(value['tools'], `${path}.tools`, issues);
  const profiles = readStringList(value['profiles'], `${path}.profiles`, issues);
  const launchFlags = readStringList(value['launchFlags'], `${path}.launchFlags`, issues);
  if (
    declaredPayloadKeys === undefined ||
    modules === undefined ||
    hookEvents === undefined ||
    requestKeysInUse === undefined ||
    resultKeysInUse === undefined ||
    tools === undefined ||
    profiles === undefined ||
    launchFlags === undefined
  ) {
    return undefined;
  }
  const settings = readSettings(value['settings'] ?? null, `${path}.settings`, issues);
  const resultRewrite = readResultRewrite(value['resultRewrite'] ?? null, `${path}.resultRewrite`, issues);
  if (settings === undefined || resultRewrite === undefined) return undefined;
  return {
    mechanism,
    confidence,
    hookEventsSource,
    guaranteeTier,
    hooks,
    declaredPayloadKeys,
    modules,
    hookEvents,
    requestKeysInUse,
    resultKeysInUse,
    tools,
    profiles,
    launchFlags,
    settings,
    resultRewrite,
  };
}

function readObservation(value: unknown, path: string, issues: ShapeIssues): SurfaceObservation | undefined {
  if (!isRecord(value)) {
    issues.add(path, 'expected an object');
    return undefined;
  }
  const agent = readNonEmptyString(value['agent'], `${path}.agent`, issues);
  const agentVersion = readNonEmptyString(value['agentVersion'], `${path}.agentVersion`, issues);
  const recordedAt = readNonEmptyString(value['recordedAt'], `${path}.recordedAt`, issues);
  const source = readNonEmptyString(value['source'], `${path}.source`, issues);
  const hookEvents = readStringList(value['hookEvents'], `${path}.hookEvents`, issues);
  const payloadKeys = readStringList(value['payloadKeys'], `${path}.payloadKeys`, issues);
  const toolNames = readStringList(value['toolNames'], `${path}.toolNames`, issues);
  if (
    agent === undefined ||
    agentVersion === undefined ||
    recordedAt === undefined ||
    source === undefined ||
    hookEvents === undefined ||
    payloadKeys === undefined ||
    toolNames === undefined
  ) {
    return undefined;
  }
  return { agent, agentVersion, recordedAt, source, hookEvents, payloadKeys, toolNames };
}

/**
 * Structural validation of a snapshot, collecting every problem rather than
 * stopping at the first.
 *
 * Hand-rolled on purpose: `@strata-ctx/integrations` may not take a new
 * dependency, and a schema library would be one more version whose upgrade could
 * turn a green gate red. A malformed snapshot is itself a finding, not a crash —
 * the point of the gate is a diff a human can act on.
 */
export function validateSnapshot(value: unknown): SnapshotValidation {
  const issues = new ShapeIssues();
  if (!isRecord(value)) {
    issues.add('<root>', 'expected a JSON object');
    return { ok: false, issues: issues.list };
  }
  if (value['version'] !== SURFACE_SNAPSHOT_VERSION) {
    issues.add('version', `expected ${SURFACE_SNAPSHOT_VERSION}, got ${JSON.stringify(value['version'] ?? null)}`);
  }
  if (value['package'] !== '@strata-ctx/integrations') {
    issues.add('package', `expected "@strata-ctx/integrations", got ${JSON.stringify(value['package'] ?? null)}`);
  }
  const note = readNonEmptyString(value['note'], 'note', issues);

  const agents: Record<string, AgentSurface> = {};
  if (!isRecord(value['agents'])) {
    issues.add('agents', 'expected an object keyed by agent id');
  } else {
    const ids = Object.keys(value['agents']);
    if (ids.length === 0) issues.add('agents', 'expected at least one agent');
    for (const id of ids) {
      const surface = readAgentSurface(value['agents'][id], `agents.${id}`, issues);
      if (surface !== undefined) agents[id] = surface;
    }
  }

  const mcpRecord = isRecord(value['mcp']) ? value['mcp'] : null;
  let mcp: McpSurface | undefined;
  if (mcpRecord === null) {
    issues.add('mcp', 'expected an object');
  } else {
    const advertised = readStringList(mcpRecord['advertised'], 'mcp.advertised', issues, { allowEmpty: false });
    const advisoryAdvertised = readStringList(mcpRecord['advisoryAdvertised'], 'mcp.advisoryAdvertised', issues, {
      allowEmpty: false,
    });
    const served = readStringList(mcpRecord['served'], 'mcp.served', issues, { allowEmpty: false });
    const unresolved = readStringList(mcpRecord['unresolved'] ?? [], 'mcp.unresolved', issues);
    if (advertised !== undefined && advisoryAdvertised !== undefined && served !== undefined && unresolved !== undefined) {
      mcp = { advertised, advisoryAdvertised, served, unresolved };
    }
  }

  const selfGistRecord = isRecord(value['selfGist']) ? value['selfGist'] : null;
  let selfGist: SelfGistSurface | undefined;
  if (selfGistRecord === null) {
    issues.add('selfGist', 'expected an object');
  } else {
    const fence = readNonEmptyString(selfGistRecord['fence'], 'selfGist.fence', issues);
    const language = readNonEmptyString(selfGistRecord['language'], 'selfGist.language', issues);
    const sentinel = readNonEmptyString(selfGistRecord['sentinel'], 'selfGist.sentinel', issues);
    const parserLanguage = readNonEmptyString(selfGistRecord['parserLanguage'], 'selfGist.parserLanguage', issues);
    const directiveCarriesFence = readBoolean(
      selfGistRecord['directiveCarriesFence'],
      'selfGist.directiveCarriesFence',
      issues,
    );
    const directiveCarriesSentinel = readBoolean(
      selfGistRecord['directiveCarriesSentinel'],
      'selfGist.directiveCarriesSentinel',
      issues,
    );
    const agrees = readBoolean(selfGistRecord['agrees'], 'selfGist.agrees', issues);
    if (
      fence !== undefined &&
      language !== undefined &&
      sentinel !== undefined &&
      parserLanguage !== undefined &&
      directiveCarriesFence !== undefined &&
      directiveCarriesSentinel !== undefined &&
      agrees !== undefined
    ) {
      selfGist = {
        fence,
        language,
        sentinel,
        parserLanguage,
        directiveCarriesFence,
        directiveCarriesSentinel,
        agrees,
      };
    }
  }

  const observations: SurfaceObservation[] = [];
  if (!Array.isArray(value['observations'])) {
    issues.add('observations', 'expected an array');
  } else {
    value['observations'].forEach((entry, index) => {
      const observation = readObservation(entry, `observations[${index}]`, issues);
      if (observation !== undefined) observations.push(observation);
    });
  }

  if (note === undefined || mcp === undefined || selfGist === undefined || issues.list.length > 0) {
    return { ok: false, issues: issues.list };
  }
  return {
    ok: true,
    snapshot: {
      version: SURFACE_SNAPSHOT_VERSION,
      package: '@strata-ctx/integrations',
      note,
      agents,
      mcp,
      selfGist,
      observations,
    },
  };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

interface FieldSpec {
  readonly name: string;
  /** Resolved per agent, so one agent can have an assumed field another derives. */
  readonly source: (surface: AgentSurface) => SurfaceClaimSource;
  readonly read: (surface: AgentSurface) => unknown;
}

const alwaysDerived = (): SurfaceClaimSource => 'derived';
const alwaysAssumed = (): SurfaceClaimSource => 'assumed';

/**
 * Every field a finding can name, and where it came from.
 *
 * The `source` is not documentation: it decides the finding's kind and it decides
 * whether `--update` may rewrite the value. A hand-maintained judgement is never
 * rewritten by a command, because the command cannot know whether the judgement
 * is still right.
 */
const AGENT_FIELDS: readonly FieldSpec[] = [
  { name: 'mechanism', source: alwaysAssumed, read: (s) => s.mechanism },
  { name: 'confidence', source: alwaysAssumed, read: (s) => s.confidence },
  { name: 'declaredPayloadKeys', source: alwaysAssumed, read: (s) => s.declaredPayloadKeys },
  { name: 'guaranteeTier', source: alwaysDerived, read: (s) => s.guaranteeTier },
  { name: 'hooks', source: alwaysDerived, read: (s) => s.hooks },
  { name: 'hookEvents', source: (s) => s.hookEventsSource, read: (s) => s.hookEvents },
  { name: 'requestKeysInUse', source: alwaysDerived, read: (s) => s.requestKeysInUse },
  { name: 'resultKeysInUse', source: alwaysDerived, read: (s) => s.resultKeysInUse },
  { name: 'tools', source: alwaysDerived, read: (s) => s.tools },
  { name: 'resultRewrite', source: alwaysDerived, read: (s) => s.resultRewrite },
  { name: 'settings', source: alwaysDerived, read: (s) => s.settings },
  { name: 'profiles', source: alwaysDerived, read: (s) => s.profiles },
  { name: 'launchFlags', source: alwaysDerived, read: (s) => s.launchFlags },
];

function normaliseJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normaliseJson);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = normaliseJson(value[key]);
    return out;
  }
  return value;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(normaliseJson(a)) === JSON.stringify(normaliseJson(b));
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function listDiff(
  expected: readonly string[],
  actual: readonly string[],
): { readonly added: readonly string[]; readonly removed: readonly string[] } {
  return {
    added: actual.filter((entry) => !expected.includes(entry)),
    removed: expected.filter((entry) => !actual.includes(entry)),
  };
}

function renderListDiff(diff: {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}): string {
  const parts: string[] = [];
  if (diff.removed.length > 0) parts.push(`snapshot only: ${diff.removed.join(', ')}`);
  if (diff.added.length > 0) parts.push(`code only: ${diff.added.join(', ')}`);
  // The failure this gate exists for is a rename, and a rename is the one diff
  // where the fix is one line on a specific side. Say it, rather than leaving a
  // reader to infer it from two lists.
  if (diff.removed.length === 1 && diff.added.length === 1) {
    parts.push(`looks like a rename: ${diff.removed[0]} -> ${diff.added[0]}`);
  }
  return parts.join('; ');
}

const REMEDIATION: Readonly<Record<SurfaceClaimSource, string>> = {
  derived:
    'our adapter changed and the snapshot was not refreshed. Confirm the change is intentional, then run `surface-check --update`.',
  assumed:
    'a pinned assumption no longer holds. Re-read the cited source for this fact, decide, and edit the snapshot by hand; ' +
    '`--update` will not overwrite a judgement it cannot check.',
};

function finding(
  kind: SurfaceFindingKind,
  agent: string,
  surface: string,
  message: string,
  expected?: readonly string[],
  actual?: readonly string[],
): SurfaceFinding {
  return {
    kind,
    severity: 'blocking',
    agent,
    surface,
    message,
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
  };
}

/** A finding that is printed on every run but does not decide the exit code. */
function advisory(
  kind: SurfaceFindingKind,
  agent: string,
  surface: string,
  message: string,
  expected?: readonly string[],
  actual?: readonly string[],
): SurfaceFinding {
  return { ...finding(kind, agent, surface, message, expected, actual), severity: 'advisory' };
}

function describeValue(value: unknown): string {
  return isStringList(value) ? `[${value.join(', ')}]` : JSON.stringify(value);
}

function compareAgentField(
  spec: FieldSpec,
  agent: string,
  pinned: AgentSurface,
  live: AgentSurface,
): SurfaceFinding | null {
  const expected = spec.read(pinned);
  const actual = spec.read(live);
  if (sameValue(expected, actual)) return null;
  const source = spec.source(live);
  const list = isStringList(expected) && isStringList(actual);
  const detail = list
    ? renderListDiff(listDiff(expected, actual))
    : `snapshot: ${describeValue(expected)} · live: ${describeValue(actual)}`;
  return finding(
    source === 'derived' ? 'code-drift' : 'assumption-drift',
    agent,
    spec.name,
    `${detail} — ${REMEDIATION[source]}`,
    ...(list ? [expected] : []),
    ...(list ? [actual] : []),
  );
}

function observationsByAgent(
  observations: readonly SurfaceObservation[],
): ReadonlyMap<string, SurfaceObservation> {
  const map = new Map<string, SurfaceObservation>();
  for (const observation of observations) {
    if (!map.has(observation.agent)) map.set(observation.agent, observation);
  }
  return map;
}

function compareObservation(
  agent: string,
  live: AgentSurface,
  observation: SurfaceObservation,
): readonly SurfaceFinding[] {
  const pairs: readonly {
    readonly surface: string;
    readonly pinned: readonly string[];
    readonly live: readonly string[];
  }[] = [
    { surface: 'hookEvents', pinned: observation.hookEvents, live: live.hookEvents },
    { surface: 'payloadKeys', pinned: observation.payloadKeys, live: keysInUse(live) },
    { surface: 'toolNames', pinned: observation.toolNames, live: live.tools },
  ];
  const findings: SurfaceFinding[] = [];
  for (const pair of pairs) {
    const missing = pair.pinned.filter((entry) => !pair.live.includes(entry));
    if (missing.length === 0) continue;
    findings.push(
      finding(
        'surface-drift',
        agent,
        pair.surface,
        `a recorded capture of ${agent} ${observation.agentVersion} (recorded ${observation.recordedAt}, source: ` +
          `${observation.source}) reports ${missing.join(', ')}, which this adapter does not depend on. The agent's ` +
          'surface moved, so the adapter is wrong: re-pinning the snapshot cannot make a hook that no longer exists fire.',
        pair.pinned,
        pair.live,
      ),
    );
  }
  return findings;
}

/**
 * Invariants that must hold right now, independent of the snapshot.
 *
 * These are the checks that fire on a branch with no snapshot at all, and they are
 * the reason the gate is worth running on every commit rather than only when
 * somebody remembers to.
 */
function liveInvariants(derived: DerivedSurfaces): readonly SurfaceFinding[] {
  const findings: SurfaceFinding[] = [];
  for (const [agent, surface] of Object.entries(derived.agents)) {
    const claimsHooks = surface.mechanism === 'settings-json' || surface.mechanism === 'plugin-module';
    if (claimsHooks !== surface.hooks) {
      findings.push(
        finding(
          'invariant-broken',
          agent,
          'mechanism',
          `mechanism ${JSON.stringify(surface.mechanism)} and the capability registry's hooks=${String(surface.hooks)} ` +
            'disagree, so the guarantee we advertise and the interception path we built cannot both be true.',
        ),
      );
    }
    if (claimsHooks && surface.hookEvents.length === 0) {
      findings.push(
        finding(
          'invariant-broken',
          agent,
          'hookEvents',
          `mechanism ${JSON.stringify(surface.mechanism)} claims a hook surface but no lifecycle event is recorded, ` +
            `so a ${surface.guaranteeTier} guarantee is asserted with nothing behind it.`,
        ),
      );
    }
    // Every key the adapter acts on has to be explained by something this package
    // wrote down: either the declared payload interface, or the paths the declared
    // rewriter is pointed at. A key explained by neither is a wire dependency that
    // nobody pinned, which is exactly what this file exists to prevent.
    const explained = [
      ...surface.declaredPayloadKeys,
      ...(surface.resultRewrite === null ? [] : surface.resultRewrite.stringPaths),
    ];
    const undeclared = keysInUse(surface).filter((key) => !explained.includes(key));
    if (undeclared.length > 0) {
      findings.push(
        finding(
          'invariant-broken',
          agent,
          'payloadKeys',
          `the adapter acts on ${undeclared.join(', ')}, which neither the declared payload interface ` +
            `(${surface.declaredPayloadKeys.join(', ') || 'none'}) nor the result-rewrite paths ` +
            `(${surface.resultRewrite === null ? 'none' : surface.resultRewrite.stringPaths.join(', ')}) accounts for. ` +
            'The dependency is real and unpinned: add it to the interface, or stop reading it.',
          keysInUse(surface),
          explained,
        ),
      );
    }
    if (surface.resultRewrite !== null && !sameValue(surface.resultRewrite.stringPaths, surface.resultKeysInUse)) {
      findings.push(
        finding(
          'invariant-broken',
          agent,
          'resultKeysInUse',
          'the rewriter is declared, so the keys it reads must be the paths it was pointed at. ' +
            `${renderListDiff(listDiff(surface.resultRewrite.stringPaths, surface.resultKeysInUse))} — a rewriter that ` +
            'reads a key outside its own spec redacts nothing while claiming to.',
          surface.resultRewrite.stringPaths,
          surface.resultKeysInUse,
        ),
      );
    }
  }
  if (derived.mcp.unresolved.length > 0) {
    // Advisory, not blocking: the profile registry advertises `ctx_*` names while
    // the server serves unprefixed ones, and that mismatch is a live bug owned by
    // other modules — a gate that has been red since it was written is a gate that
    // gets ignored. The set is still compared against the snapshot, so the day it
    // changes, that change is a blocking code-drift.
    findings.push(
      advisory(
        'invariant-broken',
        '',
        'mcp',
        `the profile layer advertises ${derived.mcp.unresolved.join(', ')} to agents, but the MCP server does not serve ` +
          'that name. A generated profile would auto-approve a tool that cannot be called. Known and pre-existing; tracked ' +
          'outside this package, so it is reported rather than used to fail the gate.',
        derived.mcp.advertised,
        derived.mcp.served,
      ),
    );
  }
  if (!sameValue(derived.mcp.advertised, derived.mcp.advisoryAdvertised)) {
    findings.push(
      finding(
        'code-drift',
        '',
        'mcp',
        `${renderListDiff(listDiff(derived.mcp.advertised, derived.mcp.advisoryAdvertised))} — the profile registry ` +
          'and the Copilot path advertise different MCP tool lists, so one of them is describing a server that does not exist.',
        derived.mcp.advertised,
        derived.mcp.advisoryAdvertised,
      ),
    );
  }
  if (!derived.selfGist.agrees) {
    findings.push(
      finding(
        'invariant-broken',
        '',
        'selfGist',
        'the self-gist markers no longer agree: the directive must carry the fence and the sentinel, and the stream ' +
          "parser must look for the language the directive tells the model to emit. AGENTS.md §10 — if the parser never " +
          'fires, compaction silently stops producing a gist.',
      ),
    );
  }
  return findings;
}

/** Flatten a module-level record into comparable `key=value` entries. */
function flatten(value: object): readonly string[] {
  return uniqueSorted(
    Object.entries(value).map(([key, entry]) => {
      if (typeof entry === 'string' || typeof entry === 'boolean') return `${key}=${String(entry)}`;
      return `${key}=${JSON.stringify(normaliseJson(entry))}`;
    }),
  );
}

function compareModuleFact(
  name: 'mcp' | 'selfGist',
  pinned: McpSurface | SelfGistSurface,
  live: McpSurface | SelfGistSurface,
): readonly SurfaceFinding[] {
  const expected = flatten(pinned);
  const actual = flatten(live);
  if (sameValue(expected, actual)) return [];
  return [
    finding('code-drift', '', name, `${renderListDiff(listDiff(expected, actual))} — ${REMEDIATION.derived}`, expected, actual),
  ];
}

function partitionFindings(findings: readonly SurfaceFinding[]): Pick<
  SurfaceCheckResult,
  'ok' | 'blocking' | 'advisories'
> {
  const blocking = findings.filter((entry) => entry.severity === 'blocking');
  const advisories = findings.filter((entry) => entry.severity === 'advisory');
  return { ok: blocking.length === 0, blocking, advisories };
}

/**
 * Validate a snapshot against the live adapters.
 *
 * `snapshot` is `unknown` on purpose: a checker whose input is already typed has
 * decided in advance to trust the file, which is the one thing it exists to
 * doubt.
 */
export function checkSurface(
  snapshot: unknown,
  options: { readonly probe?: SurfaceProbe } = {},
): SurfaceCheckResult {
  const derived = deriveSurfaces();
  const probe = options.probe;
  const findings: SurfaceFinding[] = [];

  for (const error of derived.errors) {
    findings.push(
      finding(
        'probe-error',
        error.agent,
        'derivation',
        `could not introspect this adapter: ${error.message}. An unverifiable surface is a failing check, not a pass.`,
      ),
    );
  }

  const validation = validateSnapshot(snapshot);
  if (!validation.ok) {
    for (const issue of validation.issues) {
      findings.push(finding('snapshot-invalid', '', issue.path, issue.message));
    }
    return { ...partitionFindings(findings), derived, findings, unverified: [], checkedAgents: [] };
  }

  const recorded = validation.snapshot;
  for (const agent of Object.keys(recorded.agents).sort()) {
    if (derived.agents[agent] !== undefined) continue;
    findings.push(
      finding(
        'unknown-agent',
        agent,
        'agent',
        'the snapshot records this agent id but no adapter in packages/integrations/src produces it. If the adapter was ' +
          'removed, delete the entry by hand; if the id was renamed, fix the adapter. `--update` will not drop it for you, ' +
          'because deleting a surface record is how evidence disappears.',
      ),
    );
  }

  const observations = observationsByAgent(recorded.observations);
  const unverified: string[] = [];
  for (const agent of Object.keys(derived.agents).sort()) {
    const live = derived.agents[agent];
    if (live === undefined) continue;
    const pinned = recorded.agents[agent];
    if (pinned === undefined) {
      findings.push(
        finding(
          'missing-agent',
          agent,
          'agent',
          'an adapter produces this agent id but the snapshot does not record it, so nothing is pinned about it. Run ' +
            '`surface-check --update`; nothing is overwritten for an agent that has no record yet.',
        ),
      );
    } else {
      for (const spec of AGENT_FIELDS) {
        const drift = compareAgentField(spec, agent, pinned, live);
        if (drift !== null) findings.push(drift);
      }
    }

    const recordedObservation = observations.get(agent);
    const observed = recordedObservation ?? probe?.(agent);
    if (observed === undefined) unverified.push(agent);
    else findings.push(...compareObservation(agent, live, observed));
  }

  for (const agent of [...observations.keys()].sort()) {
    if (derived.agents[agent] !== undefined) continue;
    findings.push(
      finding(
        'surface-drift',
        agent,
        'observation',
        'an observation is recorded for an agent no adapter produces, so it is evidence for nothing.',
      ),
    );
  }

  findings.push(
    ...compareModuleFact('mcp', recorded.mcp, derived.mcp),
    ...compareModuleFact('selfGist', recorded.selfGist, derived.selfGist),
    ...liveInvariants(derived),
  );

  return {
    ...partitionFindings(findings),
    derived,
    findings,
    unverified,
    checkedAgents: Object.keys(derived.agents).sort(),
  };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

const SNAPSHOT_NOTE =
  'E-8 surface expectations. The `agents`, `mcp` and `selfGist` blocks are derived from packages/integrations/src and ' +
  'refreshed with: node --import tsx packages/integrations/src/surface-check.ts --update. That command refuses while an ' +
  'assumption or a recorded observation disagrees with the code, so it cannot launder a judgement into a green build. ' +
  '`note` and `observations` are hand-maintained: record a capture of a real agent (agentVersion, recordedAt, source) ' +
  'before changing an adapter, and write the decision down in docs/decisions.md afterwards.';

/**
 * The derived half of a snapshot, with every hand-maintained fact carried across
 * from the record that already existed.
 *
 * Written field by field on purpose: a `{ ...live, ...assumed }` spread would
 * quietly re-pin a judgement the moment somebody added a field, which is the one
 * behaviour this gate exists to prevent. An agent with no record yet is added
 * whole, because there is no judgement to overwrite; an agent in the record with
 * no adapter is carried through untouched, because dropping it would erase the
 * record of a surface that used to exist.
 */
function refreshedSurface(pinned: AgentSurface | undefined, live: AgentSurface): AgentSurface {
  if (pinned === undefined) return live;
  return {
    mechanism: pinned.mechanism,
    confidence: pinned.confidence,
    declaredPayloadKeys: pinned.declaredPayloadKeys,
    hookEventsSource: pinned.hookEventsSource,
    modules: live.modules,
    guaranteeTier: live.guaranteeTier,
    hooks: live.hooks,
    hookEvents: live.hookEvents,
    requestKeysInUse: live.requestKeysInUse,
    resultKeysInUse: live.resultKeysInUse,
    tools: live.tools,
    resultRewrite: live.resultRewrite,
    settings: live.settings,
    profiles: live.profiles,
    launchFlags: live.launchFlags,
  };
}

export function refreshSnapshot(snapshot: SurfaceSnapshot, derived: DerivedSurfaces): SurfaceSnapshot {
  const agents: Record<string, AgentSurface> = {};
  for (const [agent, live] of Object.entries(derived.agents)) {
    agents[agent] = refreshedSurface(snapshot.agents[agent], live);
  }
  for (const [agent, pinned] of Object.entries(snapshot.agents)) {
    if (agents[agent] === undefined) agents[agent] = pinned;
  }
  // The note is hand-maintained, so it is carried over rather than restated. A
  // refresh that rewrote it would silently delete the sentence somebody added
  // explaining why a surface is pinned the way it is.
  return { ...snapshot, agents, mcp: derived.mcp, selfGist: derived.selfGist };
}

/** Findings `--update` must not paper over. */
const UNREFRESHABLE: ReadonlySet<SurfaceFindingKind> = new Set<SurfaceFindingKind>([
  'surface-drift',
  'assumption-drift',
  'unknown-agent',
]);

/**
 * What to do next, per kind of refusal.
 *
 * The three unrefressable kinds have opposite remedies, and a single generic
 * sentence would send somebody to edit the wrong file.
 */
function refusalHints(findings: readonly SurfaceFinding[]): readonly string[] {
  const kinds = new Set(findings.map((entry) => entry.kind));
  const hints: string[] = [];
  if (kinds.has('assumption-drift')) {
    hints.push('a pinned judgement no longer holds: re-read the source cited for that fact, decide, and edit the snapshot by hand.');
  }
  if (kinds.has('surface-drift')) {
    hints.push('the agent moved, so the adapter is wrong: re-pinning the snapshot cannot make a hook that no longer exists fire.');
  }
  if (kinds.has('unknown-agent')) {
    hints.push('the snapshot records an agent no adapter produces: fix the adapter, or delete that entry by hand.');
  }
  return hints;
}

/**
 * `--update`. Never rewrites an assumption, never drops an observation, and
 * refuses outright while the code disagrees with either.
 */
export function updateSnapshot(snapshot: unknown, derived: DerivedSurfaces): UpdateResult {
  // Seed only when there is genuinely nothing there. A snapshot that parses but
  // does not validate is a file somebody hand-edited, and replacing it with a
  // freshly derived one would destroy their judgements without ever saying so —
  // so it is refused, and the issues are handed back to be fixed by hand.
  if (snapshot === null) {
    const seed: SurfaceSnapshot = {
      version: SURFACE_SNAPSHOT_VERSION,
      package: '@strata-ctx/integrations',
      note: SNAPSHOT_NOTE,
      agents: derived.agents,
      mcp: derived.mcp,
      selfGist: derived.selfGist,
      observations: [],
    };
    return {
      ok: true,
      changed: true,
      findings: [],
      text: `${JSON.stringify(seed, null, 2)}\n`,
      warning:
        'no snapshot existed, so one was written from the live adapters. `note` and `observations` are yours to maintain ' +
        'from here: record a capture of a real agent, with its version, the date and where the capture came from.',
    };
  }

  const validation = validateSnapshot(snapshot);
  if (!validation.ok) {
    return {
      ok: false,
      changed: false,
      findings: validation.issues.map((issue) => ({
        kind: 'snapshot-invalid',
        severity: 'blocking',
        agent: '',
        surface: issue.path,
        message:
          `${issue.message} — the file parses but does not validate, so it was hand-edited or truncated. ` +
          '`--update` will not overwrite it: fix the shape by hand, or delete the file to seed a fresh one.',
      })),
      text: '',
    };
  }

  const before = checkSurface(snapshot);
  const blocking = before.blocking.filter((entry) => UNREFRESHABLE.has(entry.kind));
  if (blocking.length > 0) return { ok: false, changed: false, findings: blocking, text: '' };

  const refreshed = refreshSnapshot(validation.snapshot, derived);
  return { ok: true, changed: true, findings: before.findings, text: `${JSON.stringify(refreshed, null, 2)}\n` };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const KIND_LABEL: Readonly<Record<SurfaceFindingKind, string>> = {
  'snapshot-invalid': 'snapshot shape is invalid',
  'unknown-agent': 'snapshot records an agent no adapter produces',
  'missing-agent': 'adapter has no snapshot record',
  'code-drift': 'our code moved; the snapshot is stale',
  'assumption-drift': 'a pinned assumption no longer holds',
  'surface-drift': 'the agent surface moved; the adapter is wrong',
  'invariant-broken': 'invariant violated',
  'probe-error': 'the adapter could not be introspected',
};

export function renderFinding(entry: SurfaceFinding): string {
  const where = entry.agent === '' ? entry.surface : `${entry.agent} · ${entry.surface}`;
  const severity = entry.severity === 'advisory' ? ' (advisory)' : '';
  return `[${entry.kind}] ${where} — ${KIND_LABEL[entry.kind]}${severity}\n    ${entry.message}`;
}

export function renderFindings(findings: readonly SurfaceFinding[]): string {
  return findings.map(renderFinding).join('\n');
}

export function renderResult(result: SurfaceCheckResult): string {
  const lines: string[] = [
    result.ok
      ? `surface check passed: ${result.checkedAgents.length} agent surfaces match the pinned snapshot`
      : `surface check FAILED: ${result.blocking.length} finding${result.blocking.length === 1 ? '' : 's'}`,
  ];
  for (const entry of result.blocking) lines.push(`  ${renderFinding(entry)}`);
  if (result.unverified.length > 0) {
    lines.push(`  unverified (no recorded observation; offline by design): ${result.unverified.join(', ')}`);
  }
  if (result.advisories.length > 0) {
    lines.push(`  advisories (reported, do not fail the gate): ${result.advisories.length}`);
    for (const entry of result.advisories) lines.push(`  ${renderFinding(entry)}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const SURFACE_CHECK_HELP = [
  'surface-check — detect hook-schema drift in the agent extension surfaces this package depends on.',
  '',
  'Usage:',
  '  node --import tsx packages/integrations/src/surface-check.ts [options]',
  '',
  'Options:',
  `  --snapshot <path>  Snapshot to read, and to write under --update. Default: ./${SNAPSHOT_FILE_NAME}`,
  '                     beside this module.',
  '  --print            Print what the live adapters currently assume, as JSON. Diff this against a recorded',
  '                     observation before changing an adapter.',
  '  --json             Print the result as JSON instead of a report.',
  '  --update           Refresh the derived half of the snapshot. Refuses, and writes nothing, while an assumption or a',
  '                     recorded observation still disagrees with the code, or while the snapshot records an agent no',
  '                     adapter produces.',
  '  --help             This text.',
  '',
  'Offline by construction: no network, no subprocess, no reads outside the repository. A live-surface check would need',
  'a fetch, so the observed third of the comparison is a recorded capture carrying version, date and provenance.',
].join('\n');

/**
 * The default snapshot path.
 *
 * `src/` and `dist/` are both one level below the package root, so the same
 * relative URL resolves to the same file whether the checker is run from source
 * under tsx or from a built `dist/`.
 */
export function defaultSnapshotPath(): string {
  return fileURLToPath(new URL(`../${SNAPSHOT_FILE_NAME}`, import.meta.url));
}

export function readSnapshotText(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export const PROCESS_IO: SurfaceCheckIo = {
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  err: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

const USAGE_EXIT = 2;
const DRIFT_EXIT = 1;

export function runCli(argv: readonly string[], io: SurfaceCheckIo = PROCESS_IO): number {
  let path = defaultSnapshotPath();
  let print = false;
  let json = false;
  let update = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--help' || arg === '-h') {
      io.out(SURFACE_CHECK_HELP);
      return 0;
    }
    if (arg === '--print') {
      print = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--update') {
      update = true;
      continue;
    }
    if (arg === '--snapshot') {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        io.err('--snapshot needs a path');
        return USAGE_EXIT;
      }
      path = resolvePath(next);
      index += 1;
      continue;
    }
    io.err(`unknown option ${JSON.stringify(arg)}\n${SURFACE_CHECK_HELP}`);
    return USAGE_EXIT;
  }

  const derived = deriveSurfaces();

  if (print) {
    io.out(JSON.stringify({ agents: derived.agents, mcp: derived.mcp, selfGist: derived.selfGist }, null, 2));
    return 0;
  }

  if (update) {
    let current: unknown = null;
    try {
      current = existsSync(path) ? readSnapshotText(path) : null;
    } catch (error) {
      // Only a file that is not JSON at all is replaced. It carries no structure
      // to preserve, and refusing here would leave a gate nobody can repair
      // without hand-deleting the file first.
      current = null;
      io.err(`note: ${path} is not readable JSON (${errorMessage(error)}); writing a fresh snapshot over it`);
    }
    const result = updateSnapshot(current, derived);
    if (!result.ok) {
      io.err('refusing to refresh the snapshot: the code disagrees with something the snapshot asserts.');
      io.err(renderFindings(result.findings));
      for (const hint of refusalHints(result.findings)) io.err(`  ${hint}`);
      return DRIFT_EXIT;
    }
    if (result.text === '') {
      io.err('nothing to write');
      return DRIFT_EXIT;
    }
    writeFileSync(path, result.text, 'utf8');
    io.out(`snapshot written: ${path}`);
    if (result.warning !== undefined) io.err(`WARNING: ${result.warning}`);
    if (result.findings.length > 0) io.err(renderFindings(result.findings));
    return 0;
  }

  let snapshot: unknown = null;
  try {
    snapshot = existsSync(path) ? readSnapshotText(path) : null;
  } catch (error) {
    io.err(`surface check FAILED: cannot read ${path}: ${errorMessage(error)}`);
    io.err('fix or delete the file, or regenerate it with `surface-check --update`');
    return DRIFT_EXIT;
  }

  const result = checkSurface(snapshot);
  if (json) {
    io.out(
      JSON.stringify(
        { ok: result.ok, checkedAgents: result.checkedAgents, unverified: result.unverified, findings: result.findings },
        null,
        2,
      ),
    );
  } else {
    (result.ok ? io.out : io.err)(renderResult(result));
  }
  return result.ok ? 0 : DRIFT_EXIT;
}

const entry = process.argv[1];
if (entry !== undefined && resolvePath(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2));
}
