import type {
  ContentBlock,
  ContextState,
  GistArtifact,
  GistChanged,
  GistDecision,
  GistDraft,
  GistLog,
  GistNext,
  GistStatus,
  GistVerification,
  PinApplication,
  PinIntegrity,
  StrataPolicy,
} from '@strata-ctx/core-types';
import {
  RAW_URI_UNSTORED,
  collectGovernanceText,
  enforcePins,
  estimateTokens,
  pinSetText,
  sha256,
  validateGistDraft,
  verifyPinIntegrity,
} from '@strata-ctx/core-types';
import {
  MemorySink,
  ZERO_USAGE,
  breakdownSavings,
  savingsEvent,
  type ModelPricing,
  type SavingsBreakdown,
  type SavingsEvent,
  type SavingsGate,
  type SpendLine,
  type StrataTelemetryEvent,
  type TelemetrySink,
  type TokenUsage,
} from '@strata-ctx/telemetry';

/**
 * E-3: the three Claude Code lifecycle observers that are not about tool calls.
 *
 * `claude-code.ts` (E-2) covers PreToolUse/PostToolUse, which rewrite what the
 * model is about to read. These three cover the rest of the lifecycle, and each
 * one exists because of a specific way governance fails:
 *
 * - **PreCompact** (docs/integrations.md §3b) is the only place we observe the
 *   *host's* compaction rather than our own. The host compacts on its own
 *   schedule and we are not consulted, so the draft written here is the
 *   governance carrier across a boundary we do not control. Compaction Cliff
 *   measured 53% of safety rules surviving one production `/compact` and 10%
 *   after five; the fix is not "detect that later", it is "have written
 *   something that still contains the pins before it happens".
 * - **UserPromptSubmit** is the *every request* half of pinning. D-1 replaces
 *   the buffer from an immutable snapshot on every outbound request, and the
 *   failure mode is not that it breaks, it is that it gets optimised into
 *   running only on the first turn -- a one-shot pin looks correct in testing
 *   and decays silently in production. This observer has no state to optimise
 *   away: it is a pure function of the event, so "every request" is the only
 *   thing it can do.
 * - **Session** opens and closes the measurement window, so a session's token
 *   and savings counters are attributable rather than smeared across whatever
 *   else the process was doing.
 *
 * ## Why these are pure functions with an injected sink
 *
 * The pipeline is a chain of pure functions (architecture §1) and the observers
 * hold to the same rule: no internal mutable state, no wall clock, no file
 * handle. Everything that accumulates lives in a sink the caller supplies, and
 * every clock is injected. Two consequences worth stating:
 *
 * 1. A caller can hand the *same* event to the same observer twice and get the
 *    same answer, which is what makes the "re-pins on every call" property
 *    checkable rather than aspirational.
 * 2. `createClaudeHookRouter` isolates failures per observer, so a throwing
 *    PreCompact cannot take UserPromptSubmit down with it. Hooks run on the
 *    user's request path: the product fails *open* toward more context, never
 *    toward losing it.
 *
 * ## What is not here
 *
 * No settings.json scaffolding (E-2 owns it), no CLAUDE.md template (E-4), and
 * no Gemini mapping (E-5) -- `docs/integrations.md` §4 asks for all three to be
 * built from one parameterised adapter, and that is a refactor of this file into
 * a shared hook builder, not a second hand-rolled one.
 */

// --- event shapes -----------------------------------------------------------

/**
 * The hooks this module handles. Anything else is ignored: an agent surface
 * that grows a new lifecycle event must not turn into a crash in the ones we
 * already handle (E-8's surface-check exists to catch exactly that drift).
 */
export type ClaudeHookName = 'PreCompact' | 'UserPromptSubmit' | 'SessionStart' | 'SessionEnd';

export const CLAUDE_HOOK_NAMES: readonly ClaudeHookName[] = Object.freeze([
  'PreCompact',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
]);

export type PreCompactTrigger = 'auto' | 'manual';
export type SessionStartReason = 'startup' | 'resume' | 'clear' | 'compact';
export type SessionEndReason = 'exit' | 'logout' | 'prompt_input_exit' | 'other';

export type MaybePromise = void | Promise<void>;

/** `(event) => void | Promise<void>`. The shape every observer here is. */
export type HookHandler<E = ClaudeHookEvent> = (event: E) => MaybePromise;

export interface PreCompactEvent {
  readonly hook: 'PreCompact';
  readonly sessionId: string;
  readonly runId: string;
  readonly turn: number;
  readonly trigger: PreCompactTrigger;
  readonly state: ContextState;
  readonly taskId?: string;
  /** Everything the host flushed. `raw_uri` is stamped from the draft. */
  readonly log?: Omit<GistLog, 'raw_uri'>;
  /** Where the raw transcript was flushed, when the caller knows. */
  readonly rawUri?: string;
}

export interface UserPromptSubmitEvent {
  readonly hook: 'UserPromptSubmit';
  readonly sessionId: string;
  readonly runId: string;
  readonly turn: number;
  readonly prompt: string;
  readonly state: ContextState;
}

export interface SessionStartEvent {
  readonly hook: 'SessionStart';
  readonly sessionId: string;
  readonly runId: string;
  readonly reason: SessionStartReason;
  readonly state?: ContextState;
  /** Present when `reason` is `resume` or `clear`. */
  readonly resumedSessionId?: string;
}

export type SessionUsage = TokenUsage & {
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
};

/**
 * Session-scoped counters. The token counts come from the provider's own usage
 * field; the governance counts are ours. They are kept apart because a report
 * that mixes "tokens the model read" with "tokens the constraints cost" cannot
 * answer either question.
 */
export interface SessionCounters {
  readonly turns: number;
  readonly prompts: number;
  readonly compactions: number;
  readonly pinApplications: number;
  readonly violations: number;
  /** Input tokens attributable to the pinned set, as a fraction-of-a-session estimate. */
  readonly governanceTokens: number;
  /** What the same session's input would have cost with no transforms at all. */
  readonly baselineInputTokens: number;
}

export interface SessionEndEvent {
  readonly hook: 'SessionEnd';
  readonly sessionId: string;
  readonly runId: string;
  readonly reason: SessionEndReason;
  readonly usage?: SessionUsage;
  readonly counters?: Partial<SessionCounters>;
}

export type SessionEvent = SessionStartEvent | SessionEndEvent;
export type ClaudeHookEvent = PreCompactEvent | UserPromptSubmitEvent | SessionEvent;

const HOOK_NAMES: readonly string[] = CLAUDE_HOOK_NAMES;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Runtime gate for everything arriving off a hook's stdin.
 *
 * A hook payload is untrusted input like any other (I-6): the host is a moving
 * surface, and `E-8` exists because those payloads drift. Narrowing here means
 * the router can be handed `unknown` and still be safe, which is the only way
 * it is ever going to be called for real.
 */
export function isClaudeHookEvent(value: unknown): value is ClaudeHookEvent {
  if (!isRecord(value)) return false;
  const hook = value['hook'];
  if (typeof hook !== 'string' || !HOOK_NAMES.includes(hook)) return false;
  if (typeof value['sessionId'] !== 'string') return false;
  if (typeof value['runId'] !== 'string') return false;
  switch (hook) {
    case 'PreCompact':
    case 'UserPromptSubmit':
      return typeof value['turn'] === 'number';
    default:
      return typeof value['reason'] === 'string';
  }
}

// --- shared plumbing --------------------------------------------------------

export interface HookFailure {
  /** Which observer or sink, for a message that says *where*. */
  readonly scope: string;
  readonly message: string;
}

export type HookErrorReporter = (failure: HookFailure) => void;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Policy ids for a set of constraint *texts*.
 *
 * A violation record that names every constraint tells a reader nothing; one
 * that names the three that went missing is the difference between a log you
 * can act on and a log you have to re-derive from.
 */
function constraintIdsForTexts(policy: StrataPolicy, texts: readonly string[]): readonly string[] {
  return Object.freeze(policy.constraints.filter((c) => texts.includes(c.text)).map((c) => c.id));
}

const noop = (): void => undefined;

function isPromiseLike(value: MaybePromise): value is Promise<void> {
  return typeof (value as PromiseLike<void> | undefined)?.then === 'function';
}

/**
 * Run effects in order, degrading to a plain synchronous loop when none of them
 * returns a promise.
 *
 * The observers need a *fixed* order (a draft is written before the compaction
 * is reported, a session is closed after its savings are computed) and a sink
 * is allowed to be async -- the real artifact store is. Returning `void` on the
 * all-sync path keeps the common case synchronous and therefore exactly
 * ordered; once something is async, the rest chain behind it rather than
 * racing.
 */
function runInOrder(effects: readonly (() => MaybePromise)[]): MaybePromise {
  let pending: Promise<void> | undefined;
  for (const effect of effects) {
    if (pending === undefined) {
      const result = effect();
      if (isPromiseLike(result)) pending = result.then(noop);
      continue;
    }
    pending = pending.then(() => {
      const deferred = effect();
      return isPromiseLike(deferred) ? deferred.then(noop) : undefined;
    });
  }
  return pending;
}

/**
 * Telemetry must never be able to take a request down, and a failure must never
 * be swallowed either -- `0 violations` from a log that stopped recording is the
 * failure this project exists to prevent, so it is reported to the caller.
 */
function emitSafely(
  sink: TelemetrySink,
  event: StrataTelemetryEvent,
  onError: HookErrorReporter | undefined,
): void {
  try {
    sink.emit(event);
  } catch (error) {
    onError?.({ scope: `telemetry:${event.type}`, message: describeError(error) });
  }
}

// --- PreCompactDraft (B-8) --------------------------------------------------

/**
 * What the PreCompact observer writes, before the model has narrated anything.
 *
 * This is deliberately *not* a `Gist` and not the contract's `GistDraft`: tier 2
 * self-gist means the agent writes its own compression inside its own turn, and
 * PreCompact fires *before* the compaction happens -- at that point the
 * narrative does not exist yet. What exists is the set of facts only we hold:
 * the task identity, the turn range, the raw pointer, and the pins.
 *
 * Named for what it is because `SelfGistBlockDraft` (templates.ts) and the
 * compactor's working set (pipeline/src/self-gist.ts) shipped under this same
 * name while sharing no field with it. One name, three meanings, and no way for
 * a reader to tell which one an import brought.
 *
 * `constraints` is the load-bearing field. It is copied from the policy buffer
 * with `pinSetText` and never derived from anything the model said, which is
 * what lets step 4c be a byte-equality comparison instead of a judgement call.
 * The invariant it protects: **a compaction that happens without us is still
 * preceded by a document containing the pins.**
 */
export interface PreCompactDraft {
  readonly v: 1;
  readonly task_id: string;
  readonly run_id: string;
  readonly session_id: string;
  readonly trigger: PreCompactTrigger;
  readonly compression_by: 'self-gist';
  readonly source_turn_range: readonly [number, number];
  /** Byte-identical to `pinSetText(policy)`. Never model-written. */
  readonly constraints: readonly string[];
  readonly constraint_ids: readonly string[];
  /** Digest of `constraints.join('\n')`, i.e. the step-4c comparison key. */
  readonly policy_hash: string;
  readonly directive: string;
  readonly log: GistLog;
  readonly raw_uri: string;
  /**
   * Present only when `raw_uri` names bytes a store already holds.
   *
   * `raw_recoverable` is a governance predicate, not a description: the eviction
   * gate branches on it (governance/src/byte-equality.ts) to decide whether the
   * transcript may be discarded. Asserting it here -- before the transaction has
   * written anything -- let a draft vouch for bytes no store holds.
   */
  readonly raw_recoverable?: true;
  readonly before_tokens: number;
}

export const GIST_SENTINEL = 'ctx-gist';

/**
 * The instruction handed to the model so it narrates its own gist. E-4 puts the
 * same text in the CLAUDE.md template; keeping one source means a change to the
 * block shape cannot drift between the prompt and the parser.
 */
export const SELF_GIST_DIRECTIVE = [
  `<!-- ${GIST_SENTINEL}-directive -->`,
  'A compaction is imminent. Governance constraints are pinned above and survive it unchanged;',
  `do not restate, paraphrase, renumber or "improve" them. At the end of your next turn emit exactly one`,
  'fenced block tagged ' + GIST_SENTINEL + ' containing a JSON object with the keys',
  'status, goal, changed, current_values, decided, unresolved, artifacts, next and verification.',
  'The gateway writes the constraints field; a constraints key in your block is ignored.',
].join('\n');

/**
 * Where the raw transcript is, or an admission that nothing stored it.
 *
 * The minted `artifact://strata/raw/<session>/<turn>` this replaced was a
 * content-addressed URI naming no object: `strata` is not one of the store's
 * buckets and the tail is a session id and a turn, not a digest, so
 * `parseArtifactUri` refuses it (acl.ts, `unknown_bucket`) and every consumer
 * of a recovery claim treats it as bytes that exist. `RAW_URI_UNSTORED` is the
 * one address a store cannot be asked for, which is exactly the truth here:
 * PreCompact fires *before* the transaction has written anything, so unless the
 * caller says where it flushed the transcript, no bytes exist yet.
 */
function draftRawUri(event: PreCompactEvent): string {
  return event.rawUri ?? RAW_URI_UNSTORED;
}

/** Token count for the pre-compaction snapshot, preferring the caller's own. */
function tokensOf(state: ContextState): number {
  return state.tokenEstimate > 0 ? state.tokenEstimate : estimateTokens(state);
}

/**
 * Pure: same event and policy in, byte-identical draft out.
 *
 * `raw_recoverable` rides along only with a caller-supplied `rawUri`, by the
 * same conditional spread `GistAssembler` uses (gist/src/assembly.ts:352-359).
 * Writing `false` instead would not be a more honest draft -- `false` is not a
 * `Gist` at all (`z.literal(true)`, core-types/src/gist.ts) -- and writing
 * `true` unconditionally is the defect this replaces.
 */
export function buildPreCompactDraft(event: PreCompactEvent, policy: StrataPolicy): PreCompactDraft {
  const constraints = Object.freeze(pinSetText(policy));
  const rawUri = draftRawUri(event);
  const lastTurn = Number.isFinite(event.turn) && event.turn > 0 ? Math.floor(event.turn) : 0;
  const emptyLog: GistLog = {
    ran: [],
    failed: [],
    salient_errors: [],
    salient_warnings: [],
    dropped_count: 0,
    raw_uri: rawUri,
  };

  return Object.freeze({
    v: 1 as const,
    task_id: event.taskId ?? `${event.sessionId}:${event.turn}`,
    run_id: event.runId,
    session_id: event.sessionId,
    trigger: event.trigger,
    compression_by: 'self-gist' as const,
    source_turn_range: Object.freeze([0, lastTurn] as [number, number]),
    constraints,
    constraint_ids: Object.freeze([...policy.constraints].sort((a, b) => (a.id < b.id ? -1 : 1)).map((c) => c.id)),
    policy_hash: sha256(constraints.join('\n')),
    directive: SELF_GIST_DIRECTIVE,
    log: Object.freeze({ ...emptyLog, ...(event.log ?? {}) }),
    raw_uri: rawUri,
    ...(event.rawUri === undefined ? {} : { raw_recoverable: true as const }),
    before_tokens: tokensOf(event.state),
  });
}

/** The narrative the model supplies, minus every field the gateway owns. */
export interface SelfGistNarrative {
  readonly status: GistStatus;
  readonly goal: string;
  readonly changed: readonly GistChanged[];
  readonly current_values: Readonly<Record<string, string>>;
  readonly decided: readonly GistDecision[];
  readonly unresolved: readonly string[];
  readonly artifacts: readonly GistArtifact[];
  readonly next: GistNext;
  readonly verification: GistVerification;
  readonly log: Omit<GistLog, 'raw_uri'>;
}

/**
 * The seam B-8 leaves: draft in, narrative in, gist out.
 *
 * `constraints`, `raw_recoverable` and `source_turn_range` come from the draft
 * and are *not* fields of `SelfGistNarrative`, so the narrative has no way to
 * express them. A summariser that wanted to drop a constraint has to forge a
 * field the type does not offer, and the byte-equality check would catch it.
 *
 * The return type is the contract's `GistDraft`, not `Gist`, and that is the
 * point rather than a compromise. This runs at PreCompact, which fires *before*
 * the compaction, so on the ordinary path the transcript has not been written
 * and `draft.raw_uri` is still the unstored marker. A `Gist` carries
 * `raw_recoverable: z.literal(true)` with no way to leave it off, so returning
 * one here meant asserting the claim on every call -- the same false claim
 * `GistAssembler` was fixed for, reachable by a second door. A caller holding
 * stored bytes passes them in on the event and gets the claim back.
 */
export function assembleGist(draft: PreCompactDraft, narrative: SelfGistNarrative): GistDraft {
  const [from, to] = draft.source_turn_range;
  // `GistDraft` is a zod-inferred shape, so its arrays are mutable. The freeze
  // here is on the top level only; the transaction parses and re-shapes it.
  const assembled: GistDraft = {
    v: 1,
    task_id: draft.task_id,
    status: narrative.status,
    goal: narrative.goal,
    changed: [...narrative.changed],
    current_values: { ...narrative.current_values },
    decided: [...narrative.decided],
    unresolved: [...narrative.unresolved],
    artifacts: [...narrative.artifacts],
    next: { ...narrative.next },
    log_gist: { ...narrative.log, raw_uri: draft.raw_uri },
    verification: { ...narrative.verification },
    constraints: [...draft.constraints],
    source_turn_range: [from, to],
    ...(draft.raw_recoverable === true ? { raw_recoverable: true as const } : {}),
    compressed_by: draft.compression_by,
  };

  // Same discipline as `GistAssembler`: validate the object about to be handed
  // on, rather than trusting that the two fields it owns cannot disagree.
  const validation = validateGistDraft(assembled);
  if (!validation.ok) {
    throw new Error(
      `Gist draft validation failed: ${validation.defects.map((d) => d.kind).join(', ')}`,
    );
  }
  return Object.freeze(assembled);
}

/** Step 4c against an assembled gist: the gate, as a reusable function. */
export function verifyGistGovernance(gist: GistDraft, policy: StrataPolicy): PinIntegrity {
  return verifyPinIntegrity(pinSetText(policy), gist.constraints);
}

// --- PreCompactObserver -----------------------------------------------------

export interface PreCompactDraftSink {
  /**
   * Called on every PreCompact. Contract: the returned draft is the *only*
   * copy of the pins that will exist after the host compacts, so implementations
   * must persist it durably before resolving.
   */
  write(draft: PreCompactDraft): MaybePromise;
}

export interface PreCompactObserverOptions {
  readonly policy: StrataPolicy;
  readonly sink: PreCompactDraftSink;
  readonly telemetrySink?: TelemetrySink;
  /**
   * Replace the draft builder. Exists so the byte-equality check below guards
   * *any* builder and not only the built-in one: a caller that carries
   * extra provider-specific fields into the draft gets the same gate, and a
   * lossy builder becomes a reportable violation rather than a silent one.
   */
  readonly buildDraft?: (event: PreCompactEvent, policy: StrataPolicy) => PreCompactDraft;
  readonly onError?: HookErrorReporter;
}

/**
 * Flushes a self-gist draft before an imminent compaction, and checks its own
 * output against the pin buffer before reporting success.
 *
 * The self-check is not decoration. The draft is the last governance carrier
 * across a boundary we do not control, and a draft that silently lost a
 * constraint would be discovered one compaction too late. So the bytes are
 * compared (`verifyPinIntegrity`, the same function step 4c uses) and a mismatch
 * is emitted as a `pin_post_compact_missing` violation.
 *
 * The draft is written **even when that check fails**. Failing toward more
 * context is the documented direction: a draft missing one line is still worth
 * far more than no draft at all, and the violation is what makes it visible.
 */
export function createPreCompactObserver(options: PreCompactObserverOptions): HookHandler<PreCompactEvent> {
  const { policy, sink } = options;
  const telemetry = options.telemetrySink ?? new MemorySink();
  const onError = options.onError;
  const build = options.buildDraft ?? buildPreCompactDraft;

  return (event) => {
    const draft = build(event, policy);
    const integrity = verifyPinIntegrity(pinSetText(policy), draft.constraints);
    const beforeTokens = draft.before_tokens;

    return runInOrder([
      () => sink.write(draft),
      () =>
        emitSafely(
          telemetry,
          {
            type: 'compaction',
            runId: event.runId,
            trigger: `pre_compact:${event.trigger}`,
            beforeTokens,
            afterTokens: 0,
            droppedCount: 0,
            compressionBy: 'self-gist',
            validationPassed: integrity.ok,
          },
          onError,
        ),
      () =>
        integrity.ok
          ? undefined
          : emitSafely(
              telemetry,
              {
                type: 'violation',
                runId: event.runId,
                kind: 'pin_post_compact_missing',
                constraintIds: constraintIdsForTexts(
                  policy,
                  integrity.defects.filter((d) => d.kind === 'missing').map((d) => d.text),
                ),
                blocked: false,
              },
              onError,
            ),
    ]);
  };
}

// --- UserPromptSubmitObserver -----------------------------------------------

/** The governance state of one outgoing request, after pinning. */
export interface RepinnedContext {
  readonly hook: 'UserPromptSubmit';
  readonly sessionId: string;
  readonly runId: string;
  readonly turn: number;
  /** The state to send. Carries a complete, freshly materialised pin set. */
  readonly state: ContextState;
  /** `pinSetText(policy)`, in the order the blocks appear. */
  readonly expected: readonly string[];
  /** Expected pins that were absent from the inbound state. */
  readonly missingBefore: readonly string[];
  /** True when the incoming state did not already carry the full pin set. */
  readonly repinned: boolean;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

export interface RepinSink {
  write(context: RepinnedContext): MaybePromise;
}

export interface UserPromptSubmitObserverOptions {
  readonly policy: StrataPolicy;
  readonly sink: RepinSink;
  readonly telemetrySink?: TelemetrySink;
  /**
   * Tag the user turn `tier: 'user_intent'`. On by default; the tag is what
   * anchors the recency tail, and the user turn is the one thing a compacted
   * context must never have paraphrased.
   */
  readonly tagUserIntent?: boolean;
  readonly onError?: HookErrorReporter;
}

const userIntentBlockSha = (prompt: string): string => sha256(`user_intent:${prompt}`);

/**
 * Appends the user turn as `user_intent`, unless it is already there.
 *
 * Idempotent on purpose: Claude Code can deliver the same prompt event more
 * than once (a retry, a re-render), and a hook that appends on every delivery
 * grows the context on every delivery. The sha comparison makes the second
 * delivery a no-op rather than a duplicate.
 */
export function appendUserIntent(state: ContextState, event: UserPromptSubmitEvent): ContextState {
  const digest = userIntentBlockSha(event.prompt);
  const already = state.messages.some((m) => m.content.some((b) => b.meta.sha256 === digest));
  if (already) return state;

  const block: ContentBlock = {
    type: 'text',
    text: event.prompt,
    meta: {
      origin: 'user',
      sha256: digest,
      tier: 'user_intent',
      bytes: event.prompt.length,
      severity: 'info',
      // The prompt changes every turn, so caching it would invalidate the
      // prefix for nothing. The governance blocks are the cacheable ones.
      cacheable: false,
    },
  };

  return { ...state, messages: [...state.messages, { role: 'user', content: [block], ts: 0 }] };
}

/** Pure: the pin set the policy declares, in the order it must appear. */
export function expectedPins(policy: StrataPolicy): readonly string[] {
  return Object.freeze(pinSetText(policy));
}

/** Which expected pins the inbound state was missing. */
export function missingPins(state: ContextState, policy: StrataPolicy): readonly string[] {
  const present = collectGovernanceText(state);
  return Object.freeze(pinSetText(policy).filter((text) => !present.includes(text)));
}

/** Pure: the full pin-and-materialise step, with no sink and no telemetry. */
export function repin(
  event: UserPromptSubmitEvent,
  policy: StrataPolicy,
  options: { readonly tagUserIntent?: boolean } = {},
): { readonly context: RepinnedContext; readonly application: PinApplication } {
  const expected = expectedPins(policy);
  const missingBefore = missingPins(event.state, policy);
  const staged = options.tagUserIntent === false ? event.state : appendUserIntent(event.state, event);
  const tokensBefore = tokensOf(event.state);

  // `enforcePins` strips every existing governance block and prepends the
  // policy buffer fresh -- replace, never merge (D-1). That is what makes this
  // safe to run on turn 40 as well as turn 1: a gist that appended text to the
  // governance channel is removed, not extended.
  const application = enforcePins(staged, policy);
  const state: ContextState = {
    ...application.state,
    turn: event.turn,
    tokenEstimate: estimateTokens(application.state),
  };

  return {
    context: {
      hook: 'UserPromptSubmit',
      sessionId: event.sessionId,
      runId: event.runId,
      turn: event.turn,
      state,
      expected,
      missingBefore,
      repinned: missingBefore.length > 0,
      tokensBefore,
      tokensAfter: state.tokenEstimate,
    },
    application,
  };
}

/**
 * Re-materialises the pinned set into the outgoing context on *every* prompt.
 *
 * The property this exists to guarantee is "every request", and the
 * implementation is what makes it true: there is no `lastSent` field, no
 * `alreadyPinned` short-circuit, no turn counter that could skip a call. Each
 * invocation is a pure function of its event, so calling it once, twice or
 * three hundred times produces the same complete pin set every time.
 *
 * A missing pin is reported as `pin_missing_pre_apply` (D-2's P0) from turn 2
 * onward. Turn 1 is excluded on purpose: `pinDrift` is meaningless when nothing
 * has been sent yet, and a check that fires on the first turn of every session
 * is a check that gets disabled.
 */
export function createUserPromptSubmitObserver(
  options: UserPromptSubmitObserverOptions,
): HookHandler<UserPromptSubmitEvent> {
  const { policy, sink } = options;
  const telemetry = options.telemetrySink ?? new MemorySink();
  const onError = options.onError;
  const tagUserIntent = options.tagUserIntent !== false;

  return (event) => {
    const { context } = repin(event, policy, { tagUserIntent });

    return runInOrder([
      () => sink.write(context),
      () =>
        emitSafely(
          telemetry,
          {
            type: 'pin',
            runId: event.runId,
            missingBefore: context.missingBefore.length,
            constraints: context.expected.length,
          },
          onError,
        ),
      () =>
        event.turn > 1 && context.missingBefore.length > 0
          ? emitSafely(
              telemetry,
              {
                type: 'violation',
                runId: event.runId,
                kind: 'pin_missing_pre_apply',
                constraintIds: constraintIdsForTexts(policy, context.missingBefore),
                blocked: false,
              },
              onError,
            )
          : undefined,
      () =>
        emitSafely(
          telemetry,
          {
            type: 'request_in',
            runId: event.runId,
            turn: event.turn,
            inputTokens: context.tokensAfter,
            messages: context.state.messages.length,
          },
          onError,
        ),
    ]);
  };
}

// --- SessionObserver --------------------------------------------------------

export interface SessionOpenRecord {
  readonly sessionId: string;
  readonly runId: string;
  readonly reason: SessionStartReason;
  readonly at: number;
  readonly policyHash: string;
  readonly constraints: number;
  readonly resumedSessionId?: string;
  /** Context footprint at session start, when the caller can supply one. */
  readonly startingTokens: number;
}

export interface SessionCloseRecord {
  readonly sessionId: string;
  readonly runId: string;
  readonly reason: SessionEndReason;
  readonly at: number;
  readonly usage: TokenUsage;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly counters: SessionCounters;
  readonly savings: SavingsEvent;
  readonly gate: SavingsGate;
  readonly verdict: string;
}

export interface SessionTelemetrySink {
  open(session: SessionOpenRecord): MaybePromise;
  close(session: SessionCloseRecord): MaybePromise;
}

export interface SessionObserverOptions {
  readonly policy: StrataPolicy;
  readonly sink: SessionTelemetrySink;
  readonly telemetrySink?: TelemetrySink;
  /** Reported on the savings event. `unknown` when the caller does not know. */
  readonly model?: string;
  /** null (the default) means unpriceable, which is not the same as free. */
  readonly pricing?: ModelPricing | null;
  /** The control arm. Without one, savings are reported as `unknown`, not 0. */
  readonly baseline?: TokenUsage;
  /** Gist + probe cost. Deliberately not folded into the treatment arm. */
  readonly overhead?: readonly SpendLine[];
  readonly now?: () => number;
  readonly onError?: HookErrorReporter;
}

const nonNegative = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/** Pure: the open record for a SessionStart event. */
export function buildSessionOpen(
  event: SessionStartEvent,
  policy: StrataPolicy,
  at: number,
): SessionOpenRecord {
  const base = {
    sessionId: event.sessionId,
    runId: event.runId,
    reason: event.reason,
    at,
    policyHash: sha256(pinSetText(policy).join('\n')),
    constraints: policy.constraints.length,
    startingTokens: event.state === undefined ? 0 : tokensOf(event.state),
  };
  return Object.freeze(
    event.resumedSessionId === undefined
      ? base
      : { ...base, resumedSessionId: event.resumedSessionId },
  );
}

/** Pure: the close record and the cost breakdown for a SessionEnd event. */
export function buildSessionClose(
  event: SessionEndEvent,
  options: SessionObserverOptions,
  at: number,
): { readonly record: SessionCloseRecord; readonly breakdown: SavingsBreakdown } {
  const model = options.model ?? 'unknown';
  const pricing = options.pricing ?? null;
  const usage: TokenUsage = {
    inputTokens: nonNegative(event.usage?.inputTokens),
    outputTokens: nonNegative(event.usage?.outputTokens),
  };
  const baseline = options.baseline ?? ZERO_USAGE;
  const overhead = options.overhead ?? [];
  const savingsInput = {
    runId: event.runId,
    model,
    baseline,
    treatment: usage,
    overhead,
    pricing,
  };
  const breakdown = breakdownSavings(savingsInput);
  const counters: SessionCounters = {
    turns: nonNegative(event.counters?.turns),
    prompts: nonNegative(event.counters?.prompts),
    compactions: nonNegative(event.counters?.compactions),
    pinApplications: nonNegative(event.counters?.pinApplications),
    violations: nonNegative(event.counters?.violations),
    governanceTokens: nonNegative(event.counters?.governanceTokens),
    baselineInputTokens: nonNegative(event.counters?.baselineInputTokens),
  };

  const record: SessionCloseRecord = {
    sessionId: event.sessionId,
    runId: event.runId,
    reason: event.reason,
    at,
    usage,
    cacheReadTokens: nonNegative(event.usage?.cacheReadTokens),
    cacheCreationTokens: nonNegative(event.usage?.cacheCreationTokens),
    counters,
    savings: savingsEvent(savingsInput),
    gate: breakdown.gate,
    verdict: breakdown.verdict,
  };

  return { record: Object.freeze(record), breakdown };
}

/**
 * Opens and closes the measurement window, and records the token and savings
 * counters at the end of it.
 *
 * The interesting decision is the *absence* of state: this observer does not
 * remember which sessions it opened. Accumulation belongs to the sink, which is
 * where the rest of the codebase keeps it, and keeping the observer stateless is
 * what lets the same instance serve a process with fifty concurrent sessions.
 *
 * Ordering on close is savings-then-close, so a `savings` event exists for every
 * closed session. Telemetry is emitted through `emitSafely`, so a broken log
 * cannot stop the session from being closed -- a half-closed session is an
 * orphan state, and `docs/integrations.md` §3b names orphan state as the thing
 * SessionEnd exists to prevent.
 */
export function createSessionObserver(options: SessionObserverOptions): HookHandler<SessionEvent> {
  const telemetry = options.telemetrySink ?? new MemorySink();
  const now = options.now ?? Date.now;
  const onError = options.onError;

  return (event) => {
    if (event.hook === 'SessionStart') {
      const open = buildSessionOpen(event, options.policy, now());
      return runInOrder([() => options.sink.open(open)]);
    }

    const { record } = buildSessionClose(event, options, now());
    return runInOrder([
      () => emitSafely(telemetry, record.savings, onError),
      () => options.sink.close(record),
    ]);
  };
}

// --- routing / isolation ----------------------------------------------------

export interface HookObserver {
  /**
   * Every hook this observer answers. A list rather than a single name because
   * `createSessionObserver` legitimately covers two: SessionStart and
   * SessionEnd are the two ends of one record.
   */
  readonly hooks: readonly ClaudeHookName[];
  /**
   * Declared as a method, not a `HookHandler` property, and that is load
   * bearing: `strictFunctionTypes` exempts method declarations, so a handler
   * narrowed to one event (`HookHandler<PreCompactEvent>`) can be registered
   * here. As a property it would be checked contravariantly and *no* real
   * observer could ever be registered -- the same reason the DOM declares
   * `addEventListener` the way it does.
   */
  handle(event: ClaudeHookEvent): MaybePromise;
}

export interface HookDispatchReport {
  /** The hook name, or `''` when the event was not one we handle. */
  readonly hook: string;
  readonly handled: readonly string[];
  readonly failures: readonly HookFailure[];
  /** True when the event was ignored: unknown hook, or no observer registered. */
  readonly skipped: boolean;
}

export interface HookRouterOptions {
  readonly telemetrySink?: TelemetrySink;
  readonly onError?: HookErrorReporter;
  /** Opaque, included in the report so a caller can attribute a failure. */
  readonly name?: string;
}

function errorEvent(runId: string, message: string): StrataTelemetryEvent {
  return {
    type: 'error',
    runId,
    stage: 'pin',
    code: 'observer_failed',
    message,
    failedOpen: true,
  };
}

/**
 * Fans one hook event out to every observer registered for it, isolating
 * failures.
 *
 * The isolation is the point. These handlers run on the user's request path,
 * and a PreCompact that throws (a full disk, a corrupt log) must not stop
 * UserPromptSubmit from re-pinning the next request -- losing governance on a
 * compaction we merely observed is survivable; losing it on every request after
 * that is not. So each observer is invoked independently, a throw is recorded
 * rather than propagated, and the caller gets a report saying exactly which ones
 * failed.
 *
 * An unrecognised event is a no-op, not an error. Agents add hook events between
 * releases (E-8's surface-check is what catches that in CI), and crashing on a
 * hook we do not implement would make this module the reason an agent upgrade
 * breaks.
 */
export function createClaudeHookRouter(
  observers: readonly HookObserver[],
  options: HookRouterOptions = {},
): (event: unknown) => Promise<HookDispatchReport> {
  const telemetry = options.telemetrySink;
  const onError = options.onError;
  const nameOf = (index: number, observer: HookObserver): string =>
    `${options.name ?? 'observer'}[${index}]:${observer.hooks.join('|')}`;

  return async (event: unknown): Promise<HookDispatchReport> => {
    if (!isClaudeHookEvent(event)) {
      return { hook: '', handled: [], failures: [], skipped: true };
    }

    const hook = event.hook;
    const matched = observers
      .map((observer, index) => ({ observer, label: nameOf(index, observer) }))
      .filter((entry) => entry.observer.hooks.includes(hook));

    if (matched.length === 0) {
      return { hook, handled: [], failures: [], skipped: true };
    }

    const handled: string[] = [];
    const failures: HookFailure[] = [];

    for (const { observer, label } of matched) {
      try {
        const result = observer.handle(event);
        if (isPromiseLike(result)) await result;
        handled.push(label);
      } catch (error) {
        const failure: HookFailure = { scope: label, message: describeError(error) };
        failures.push(failure);
        onError?.(failure);
        if (telemetry !== undefined) emitSafely(telemetry, errorEvent(event.runId, failure.message), onError);
      }
    }

    return { hook, handled, failures, skipped: handled.length === 0 };
  };
}
