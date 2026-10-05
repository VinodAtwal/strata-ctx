import type {
  BlockSubject,
  ContentBlock,
  ContextState,
  Message,
  Origin,
  Role,
  Severity,
  Tier,
} from '@strata-ctx/core-types';
import { runId, sha256 } from '@strata-ctx/core-types';

/**
 * A-9. The OpenAI-compatible `/chat/completions` shape <-> the canonical model.
 *
 * ## Why this one matters as much as the Anthropic one
 *
 * `docs/integrations.md` §7: the Anthropic adapter is the flagship because Claude
 * Code is the primary target, but `/chat/completions` is the shape *most* agents
 * speak -- Aider via `--openai-api-base`, Cline, Roo, LM Studio, OpenWebUI,
 * Continue all point a base URL at us and speak this. If the canonical model
 * cannot round-trip this shape, the adapters are a Claude Code feature.
 *
 * ## What this module is, and is not
 *
 * A **normalization** boundary, not a transform. That is the whole of the design
 * and every choice below follows from it:
 *
 * - Messages are never merged, hoisted, sorted or dropped. One canonical message
 *   becomes one wire message, at the same index, except where the wire format
 *   makes a single message unrepresentable (a `tool_result` is its own message
 *   here and a block inside a user message on Anthropic; that direction is
 *   handled and tested).
 * - Blocks are never reordered. Where the wire cannot interleave two kinds of
 *   block inside one message -- text and `tool_calls` are siblings, not a
 *   sequence -- the canonical order is preserved by putting each kind in the slot
 *   the format gives it. The one shape that cannot be expressed is a message whose
 *   blocks alternate between a tool result and more text: the wire has one `content`
 *   field, so such a message comes out with its text before its tool results, and
 *   no adapter can do better than that.
 * - `tier: 'governance'` blocks therefore cannot be lost or moved, which is the
 *   property AGENTS.md §12 asks for, and it is a *property* rather than a
 *   promise: `test/openai-compat-adapter.test.ts` round-trips an enforced pin set
 *   through egress and back and asserts the text is intact, in order, and
 *   prefix-stable.
 *
 * Because it is total rather than lossy, this module takes `ContextState` and not
 * `NonGovernanceMessage[]`. The narrowing in `core-types/guards.ts` exists to keep
 * governance out of operators that can *destroy* something; an adapter that
 * cannot destroy anything is not the thing it is guarding against, and typing the
 * parameter that way would only move the proof somewhere it is not checked.
 *
 * ## The system prompt: the one asymmetry with Anthropic
 *
 * Anthropic has a top-level `system` field, so `toCanonical` has to *invent* a
 * message for it. OpenAI puts the same text in a leading `role: 'system'`
 * message, which is already what the canonical model wants. So the mapping is the
 * identity in both directions and this adapter is the cheap one:
 *
 * - ingress: each `system` (or `developer`) message becomes one canonical
 *   `role: 'system'` message, in place;
 * - egress: each canonical `role: 'system'` message becomes one `role: 'system'`
 *   message, in place.
 *
 * The deliberate part is *in place*. A `system` message in the middle of the
 * conversation stays in the middle rather than being hoisted to the front: the
 * format puts no ordering constraint on `role`, so a mid-conversation system
 * message is expressible, and hoisting one is a reordering -- of the very prefix
 * that determines whether the provider's cache is hit.
 *
 * Tier follows the Anthropic adapter exactly: system text is `user_intent`, not
 * `governance`. `governance` is reserved for the pin set minted by
 * `enforcePins`; the agent's own system prompt is a user intent that has to
 * survive compaction but is not a policy constraint the gateway owns.
 *
 * ## Cache prefixes, and the field that is deliberately absent
 *
 * `cache_control` is an Anthropic field. The OpenAI-compatible format has no
 * per-block cache marker at all -- caching is automatic and keyed on a prefix of
 * the request -- so this adapter does not set `ContentBlock.cacheControl` on the
 * way in and does not emit it on the way out. Emitting it would be inventing a
 * field the endpoint does not read, and a gateway that invents fields is a
 * gateway whose clients cannot tell which of its fields are real. What survives
 * instead is the thing caching actually depends on: the order of the messages.
 * A-13 owns the prefix-stability policy; this module's contribution is that
 * nothing here can disturb it.
 *
 * `meta.cacheable` is the gateway's *own* declared prefix, which is a narrower
 * claim than the provider's cache boundary and deliberately so -- see
 * `isCacheableBlock`.
 *
 * ## Streaming
 *
 * Exports the frame shapes and the `[DONE]` sentinel, and nothing else. The
 * passthrough itself is `sse.ts` (`pipeSseUpstream`), which is byte-for-byte and
 * unbuffered, and this module has no stream-reading code path at all. That is not
 * an omission: a streamed tool call arrives as many `tool_calls` deltas whose
 * `function.arguments` are *fragments of one JSON string*, joined by `index`.
 * Reassembling them is a buffer, and a buffer on that path is the N3 violation --
 * the bytes the client receives would stop being the bytes the provider sent.
 */

/* -------------------------------------------------------------------------- */
/* The wire format                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Roles `chat/completions` accepts.
 *
 * Two of these are not in `core-types`' `Role`, which is the interesting part:
 *
 * - `developer` is the newer name for a system message (o1 and later). It maps to
 *   canonical `system`; the distinction is a product decision by the model vendor
 *   about *whose* instructions these are, not a different kind of message, and
 *   the canonical model has no field to keep it in.
 * - `function` is the pre-`tool_calls` spelling of a tool result. It maps to
 *   canonical `tool` with `name` standing in for the correlation id, because that
 *   is the only identity a legacy function message has.
 *
 * Egress emits `system` and `tool` only. The normalisation is one-way and is the
 * right direction: every server that accepts this format accepts `system` and
 * `tool`, and not every one accepts the other two.
 */
export type OpenAiCompatRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'function';

export interface OpenAiCompatTextPart {
  readonly type: 'text';
  readonly text: string;
}

export interface OpenAiCompatImagePart {
  readonly type: 'image_url';
  readonly image_url: {
    readonly url: string;
    /** Render-fidelity hint. Accepted, not preserved -- see the module header. */
    readonly detail?: 'auto' | 'low' | 'high';
  };
}

export type OpenAiCompatContentPart = OpenAiCompatTextPart | OpenAiCompatImagePart;

/** `null` is a real, load-bearing value: it is what an assistant tool call sends. */
export type OpenAiCompatContent = string | readonly OpenAiCompatContentPart[] | null;

export interface OpenAiCompatFunctionCall {
  readonly name: string;
  /**
   * A JSON **string**, not a parsed value. That is the wire format's own choice
   * and this adapter keeps it that way end to end; see `toolUseBlock`.
   */
  readonly arguments: string;
}

export interface OpenAiCompatToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: OpenAiCompatFunctionCall;
}

export interface OpenAiCompatMessage {
  readonly role: OpenAiCompatRole;
  readonly content?: OpenAiCompatContent;
  /**
   * Participant name. Accepted and **dropped** -- the canonical model has no
   * per-message name and `meta.subject` is the wrong place for it: a subject is
   * a dedupe and supersession key, so a `name: 'user'` on two different user
   * turns would let a lossy stage treat the second as a stale copy of the first.
   * That is a dropped user instruction, which is the one outcome worse than
   * losing a name. See the core-types proposal in the task report.
   */
  readonly name?: string;
  readonly tool_calls?: readonly OpenAiCompatToolCall[];
  /** Required on `role: 'tool'`; absent elsewhere. */
  readonly tool_call_id?: string;
  /**
   * Reasoning trace, from the de-facto extension (OpenRouter, vLLM, DeepSeek and
   * the other `openai-compatible` servers) rather than from the format itself.
   * Mapped to the canonical `thinking` block and back, which is what keeps a
   * thinking block from being re-emitted as visible assistant content; a server
   * that does not implement the field ignores it, and ignoring a reasoning trace
   * is better than presenting one to the model as something it said.
   */
  readonly reasoning_content?: string;
}

export interface OpenAiCompatStreamOptions {
  /** The only way to get `usage` on a streamed response. */
  readonly include_usage?: boolean;
}

export interface OpenAiCompatRequest {
  readonly model: string;
  readonly messages: readonly OpenAiCompatMessage[];
  readonly stream?: boolean;
  readonly stream_options?: OpenAiCompatStreamOptions | null;
  /** Everything else -- `tools`, `temperature`, `response_format` -- passes through. */
  [k: string]: unknown;
}

/* -------------------------------------------------------------------------- */
/* Streaming shapes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The terminal frame, byte for byte.
 *
 * Source: the OpenAI API reference, Chat Completions, "Streaming" -- a stream
 * ends with the literal line `data: [DONE]` after a blank line.
 * TODO(WS-A, A-9): add the canonical URL to `docs/decisions.md` at integration
 * time. Named here rather than linked because an unverified link in a comment is
 * worse than a named source.
 */
export const OPENAI_COMPAT_SSE_DONE = 'data: [DONE]';

/**
 * Whether one frame's `data:` payload is the end-of-stream sentinel.
 *
 * Takes the joined payload `parseSseFrames` produces for a single frame -- not a
 * stream, not a prefix of one. A predicate over one frame is O(frame); the same
 * predicate over accumulated text is how a stream gets buffered, and this is the
 * line where that mistake would be made.
 */
export const isOpenAiCompatStreamDone = (frameData: string): boolean =>
  frameData.trim() === '[DONE]';

export type OpenAiCompatFinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'function_call';

export interface OpenAiCompatUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

/**
 * One `tool_calls` delta. Every field is optional except `index`, and that is the
 * whole reason this type exists: a streamed tool call is one JSON string split
 * across frames, and the pieces are only joinable by `index`.
 */
export interface OpenAiCompatDeltaToolCall {
  readonly index: number;
  readonly id?: string;
  readonly type?: 'function';
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

export interface OpenAiCompatDelta {
  readonly role?: OpenAiCompatRole;
  readonly content?: string | null;
  readonly reasoning_content?: string;
  readonly tool_calls?: readonly OpenAiCompatDeltaToolCall[];
}

export interface OpenAiCompatStreamChoice {
  readonly index: number;
  readonly delta: OpenAiCompatDelta;
  readonly finish_reason?: OpenAiCompatFinishReason | null;
}

export interface OpenAiCompatStreamChunk {
  readonly id: string;
  readonly object: 'chat.completion.chunk';
  readonly created: number;
  readonly model: string;
  readonly choices: readonly OpenAiCompatStreamChoice[];
  /** Present only on the final chunk, and only when `stream_options.include_usage`. */
  readonly usage?: OpenAiCompatUsage | null;
}

/* -------------------------------------------------------------------------- */
/* Role mapping                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Wire role -> canonical role. See `OpenAiCompatRole` for the two aliases.
 *
 * The `default` branch is unreachable for the declared union and is there for the
 * caller that lied: a role this adapter has not heard of keeps its *content*,
 * filed as a user turn, rather than 502-ing a request over a string. A normalizer
 * that throws on an unfamiliar role is a normalizer that takes down requests
 * because a server added a role.
 */
const canonicalRole = (role: OpenAiCompatRole): Role => {
  switch (role) {
    case 'system':
    case 'developer':
      return 'system';
    case 'assistant':
      return 'assistant';
    case 'tool':
    case 'function':
      return 'tool';
    case 'user':
      return 'user';
    default:
      return 'user';
  }
};

/** `Role` is a subset of `Origin`, so the two are the same map. */
const originFor = (role: Role): Origin => role;

const isSystemRole = (role: Role): boolean => role === 'system';

/* -------------------------------------------------------------------------- */
/* Block construction                                                          */
/* -------------------------------------------------------------------------- */

/** Text projection of an image, matching the Anthropic adapter's `textOf`. */
const IMAGE_PROJECTION = '[image]';

interface BlockSpec {
  readonly type: ContentBlock['type'];
  readonly text: string;
  readonly origin: Origin;
  readonly tier: Tier;
  readonly cacheable: boolean;
  readonly id?: string;
  readonly toolName?: string;
  readonly subject?: BlockSubject;
  readonly severity?: Severity;
}

/**
 * A content hash over the *canonical meaning* of a block, never over the wire
 * envelope it arrived in.
 *
 * Two consequences, and the first is the important one: a block that makes the
 * round trip keeps its hash, so dedupe and staleness detection do not see a
 * provider change as a content change. The second is deliberate too -- text
 * blocks hash their text alone, which is what `enforcePins` does for a
 * governance block, so a pinned constraint and an ordinary text block with the
 * same text are the same block to a dedupe stage. Tool blocks cannot agree with
 * the Anthropic adapter's hash, because the two adapters project a tool input
 * differently; text is where the context mass is and text agrees.
 */
const blockHash = (spec: BlockSpec): string =>
  spec.type === 'text'
    ? sha256(spec.text)
    : sha256(JSON.stringify([spec.type, spec.text, spec.id ?? null, spec.toolName ?? null]));

function toBlock(spec: BlockSpec): ContentBlock {
  return {
    type: spec.type,
    text: spec.text,
    // Conditional spreads rather than `id: spec.id`: with exactOptionalPropertyTypes
    // an absent field and an explicit `undefined` are different values, and a
    // correlation id that was never on the wire must not be minted as one.
    ...(spec.id === undefined ? {} : { id: spec.id }),
    ...(spec.toolName === undefined ? {} : { toolName: spec.toolName }),
    meta: {
      origin: spec.origin,
      sha256: blockHash(spec),
      ...(spec.subject === undefined ? {} : { subject: spec.subject }),
      tier: spec.tier,
      bytes: spec.text.length,
      cacheable: spec.cacheable,
      ...(spec.severity === undefined ? {} : { severity: spec.severity }),
    },
  };
}

/**
 * `tool_calls` identity: the *call*, not the function's name.
 *
 * The wire block is `{ id, type, function: { name, arguments } }`, so a call is
 * identified by `name` together with `arguments`. This adapter used to stamp
 * `ref: name` for the call, which made every `read_file` in a turn one subject
 * (`other\0read_file`): dedupe dropped the loser and left the loser's result
 * behind, because a `role: tool` message is keyed on `tool_call_id`
 * (`toolResultSubject`) and so never co-dropped. A `tool_result` with no
 * `tool_use` is a request `/v1/chat/completions` rejects.
 *
 * `subject.kind` stays `'other'`: it is a closed union and no shared tool-name
 * table exists in this repo to classify a call by (see the A-10 report).
 *
 * `arguments` is a **JSON string** and is used verbatim, for the reason
 * `toolUseBlock` gives: re-serialising it would make every tool call in a cached
 * prefix a cache miss. The cost is that two byte-different encodings of the same
 * document are two identities, so a drop is missed. Missing a drop costs bytes;
 * making one wrongly costs a rejected request, so the direction is right.
 *
 * `id` is deliberately not in the key: it is unique per call, so keying on it
 * would make every call its own subject and dedupe would never fire for
 * `tool_use` at all. `id` pairs a call with its result, which is its actual job.
 */
const toolUseSubject = (call: OpenAiCompatToolCall): BlockSubject => ({
  kind: 'other',
  ref: `${call.function.name}\u0000${call.function.arguments}`,
});

/**
 * `role: tool` identity: the `tool_call_id`, which is the field the format pairs
 * on (`OpenAiCompatMessage.tool_call_id`), falling back to `name` for the
 * pre-`tool_calls` spelling. Never the same shape as `toolUseSubject`: a result
 * that shared its call's subject would read as a newer version of the call.
 */
const toolResultSubject = (resultId: string): BlockSubject => ({ kind: 'other', ref: resultId });

const tierFor = (type: ContentBlock['type'], role: Role): Tier => {
  if (type === 'tool_use' || type === 'tool_result') return 'tool_state';
  return isSystemRole(role) ? 'user_intent' : 'episodic';
};

/**
 * Which blocks this adapter is willing to call cacheable.
 *
 * The claim being made is deliberately narrower than the provider's: it is "this
 * block is in the prefix the *gateway* rewrites every turn", not "the provider is
 * caching this". The OpenAI-compatible format gives no way to observe the second
 * -- caching is automatic and keyed on an implicit prefix -- so claiming it would
 * be a claim with no evidence behind it.
 *
 * That is the system prompt plus the head of the first user turn, the same pair
 * the Anthropic adapter marks. The conversational tail is left `false` on purpose:
 * it is append-only from the provider's point of view, and marking it cacheable
 * would make `assertPrefixPreserved` assert a stability guarantee over exactly the
 * blocks the pipeline is built to supersede and drop.
 */
const isCacheableBlock = (role: Role, indexInMessage: number): boolean =>
  isSystemRole(role) || (role === 'user' && indexInMessage === 0);

/* -------------------------------------------------------------------------- */
/* Ingress                                                                     */
/* -------------------------------------------------------------------------- */

/** `undefined` and `null` are both "no content"; an empty string is *not*. */
const partsOf = (content: OpenAiCompatContent | undefined): readonly OpenAiCompatContentPart[] => {
  if (content === undefined || content === null) return [];
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
};

/**
 * The text projection of a `role: 'tool'` message's content.
 *
 * A tool result is a string on the wire; the array form is tolerated because
 * `content: [{type:'text'}]` is what a client that builds tool results the same
 * way it builds user messages actually sends, and rejecting it would drop a tool
 * result that the model needs.
 */
const toolResultText = (content: OpenAiCompatContent | undefined): string => {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  return content.map((p) => (p.type === 'text' ? p.text : IMAGE_PROJECTION)).join('\n');
};

const isJson = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/**
 * The `arguments` of a `tool_call`, kept exactly as it arrived.
 *
 * Not re-serialised, and that is the whole point: `{"a": 1}` and `{"a":1}` are the
 * same JSON document and different byte strings, and the bytes are what the
 * provider emitted and what a prefix cache was keyed on. Parsing to "validate" and
 * re-stringifying would make every tool call in a cached prefix a cache miss, so
 * the string is validated by *being carried* and used verbatim.
 */
const toolUseBlock = (
  call: OpenAiCompatToolCall,
  origin: Origin,
): ContentBlock => {
  const args = call.function.arguments;
  // `''` is the de-facto encoding of a no-argument call -- several runtimes send it
  // rather than `{}` -- so it is not the malformed case and is not flagged as one.
  const malformed = args !== '' && !isJson(args);
  return toBlock({
    type: 'tool_use',
    text: args,
    origin,
    tier: 'tool_state',
    cacheable: false,
    id: call.id,
    toolName: call.function.name,
    subject: toolUseSubject(call),
    // Surfaced rather than normalised away: `warn` is the benign end of the
    // severity scale, so a tool call whose arguments are not JSON is *more* likely
    // to be retained by truncate, which is the fail-toward-more-context direction
    // (N5). The arguments are still passed through untouched.
    ...(malformed ? { severity: 'warn' as const } : {}),
  });
};

export function toCanonical(req: OpenAiCompatRequest, now = Date.now()): ContextState {
  const messages: Message[] = [];

  for (const m of req.messages) {
    const role = canonicalRole(m.role);
    const origin = originFor(role);
    const blocks: ContentBlock[] = [];

    // Content before tool calls, because that is the order the format itself
    // serialises them in: `content` and `tool_calls` are siblings of one message,
    // so there is no wire input in which a tool call precedes the text of the
    // message it was made in. Keeping the canonical order the same way means the
    // egress path can put each kind back in its own slot without a guess.
    if (role === 'tool') {
      const resultId = m.tool_call_id ?? m.name;
      blocks.push(
        toBlock({
          type: 'tool_result',
          text: toolResultText(m.content),
          origin,
          tier: 'tool_state',
          cacheable: false,
          ...(resultId === undefined ? {} : { id: resultId }),
          ...(resultId === undefined ? {} : { subject: toolResultSubject(resultId) }),
        }),
      );
    } else {
      let index = 0;
      if (m.reasoning_content !== undefined && m.reasoning_content !== '') {
        blocks.push(
          toBlock({
            type: 'thinking',
            text: m.reasoning_content,
            origin,
            tier: 'episodic',
            cacheable: false,
          }),
        );
        index += 1;
      }
      for (const part of partsOf(m.content)) {
        blocks.push(
          part.type === 'text'
            ? toBlock({
                type: 'text',
                text: part.text,
                origin,
                tier: tierFor('text', role),
                cacheable: isCacheableBlock(role, index),
              })
            : toBlock({
                // The canonical model has no image payload field, so the image
                // *is* its URL. That is a reference, not a copy, which is the same
                // position the Anthropic adapter takes -- and it is why an inline
                // `data:` URL is large here. See the task report for the
                // core-types proposal this wants.
                type: 'image',
                text: part.image_url.url,
                origin,
                tier: 'episodic',
                cacheable: isCacheableBlock(role, index),
              }),
        );
        index += 1;
      }
    }

    for (const call of m.tool_calls ?? []) blocks.push(toolUseBlock(call, origin));

    messages.push({ role, content: blocks, ts: now });
  }

  return {
    messages,
    pinned: [],
    // 0 is the "not counted yet" sentinel, and it is a real one in this codebase:
    // consumers read `state.tokenEstimate > 0 ? ... : estimateTokens(state)`
    // (integrations/src/claude-code-observers.ts, pipeline/src/gist/assembly.ts).
    // A normalizer that guessed a token count would make that fallback unreachable
    // and quietly take the estimate away from whoever owns the budget.
    tokenEstimate: 0,
    policyHash: '',
    runId: runId('pending'),
    turn: 0,
    gists: [],
    artifacts: [],
  };
}

/**
 * Ids of `role: 'tool'` messages that answer no `tool_call` in the same request.
 *
 * Exported because it is a wire defect the canonical model has no room to
 * describe and the gateway needs to be able to see: an agent that drops a tool
 * result is an agent whose next turn is reasoning about a call it can no longer
 * see the output of. Nothing is repaired here -- the block is kept either way
 * (fail-open) -- so this is a signal, not a fix.
 */
export function unpairedToolResultIds(req: OpenAiCompatRequest): string[] {
  const called = new Set<string>();
  for (const m of req.messages) for (const call of m.tool_calls ?? []) called.add(call.id);

  const unpaired: string[] = [];
  for (const m of req.messages) {
    if (canonicalRole(m.role) !== 'tool') continue;
    const id = m.tool_call_id ?? m.name;
    if (id === undefined || called.has(id) || unpaired.includes(id)) continue;
    unpaired.push(id);
  }
  return unpaired;
}

/* -------------------------------------------------------------------------- */
/* Egress                                                                      */
/* -------------------------------------------------------------------------- */

const wireRole = (role: Role): OpenAiCompatRole => role;

/**
 * The `content` field for one message.
 *
 * Plain string whenever every part is text, which is the overwhelmingly common
 * case and the one every server accepts. A string is the *normalisation* for a
 * multi-part text array, and it is the same `\n` join the Anthropic adapter uses
 * for its `system` field: the wire has no way to say "two text parts", so the
 * block boundaries are not representable outbound. They are not lost inbound --
 * they come back as one block either way -- and the text is identical, which is
 * the field that carries meaning.
 */
const contentField = (
  parts: readonly OpenAiCompatContentPart[],
  hasToolCalls: boolean,
): OpenAiCompatContent => {
  if (parts.length === 0) return hasToolCalls ? null : '';
  const text: string[] = [];
  let allText = true;
  for (const part of parts) {
    if (part.type === 'text') text.push(part.text);
    else allText = false;
  }
  return allText ? text.join('\n') : parts;
};

const toolCallOf = (b: ContentBlock): OpenAiCompatToolCall => ({
  // The same fail-open the Anthropic adapter uses: a call with no correlation id
  // and no name is still a call the model made, and emitting it malformed beats
  // emitting a request that silently omits the call.
  id: b.id ?? '',
  type: 'function',
  function: { name: b.toolName ?? 'unknown', arguments: b.text ?? '' },
});

const toolResultMessage = (b: ContentBlock): OpenAiCompatMessage => ({
  role: 'tool',
  content: b.text ?? '',
  // Omitted rather than emptied when the canonical block has no id. An empty id
  // is a correlation to nothing and looks like a real one on the wire.
  ...(b.id === undefined ? {} : { tool_call_id: b.id }),
});

/**
 * Canonical -> `/chat/completions`.
 *
 * Lossy in exactly two places, both named in the module header, both about
 * decoration rather than content: `meta.cacheControl` is not emitted (the field
 * does not exist on this wire) and a `reasoning_content` sibling is the only
 * place a `thinking` block can go.
 */
export function fromCanonical(state: ContextState, req: OpenAiCompatRequest): OpenAiCompatRequest {
  const messages: OpenAiCompatMessage[] = [];

  for (const m of state.messages) {
    const parts: OpenAiCompatContentPart[] = [];
    const toolCalls: OpenAiCompatToolCall[] = [];
    const results: OpenAiCompatMessage[] = [];
    const leading: OpenAiCompatMessage[] = [];
    const thinking: string[] = [];

    // `leading` is the run of `tool_result` blocks at the head of the message.
    // Nothing in this format produces one -- a tool result is always its own wire
    // message -- but the *other* adapters can: Anthropic files a `tool_result`
    // block inside a `user` message, and a client that puts one before the text of
    // the same turn is legal there. Emitting those first is what keeps a canonical
    // block order that this module did not create from being reordered on the way
    // out. Once a non-`tool_result` block has been seen the remaining results join
    // the tail instead, because the wire has no way to interleave the two.
    let inLeadingRun = true;
    for (const b of m.content) {
      switch (b.type) {
        case 'tool_use':
          inLeadingRun = false;
          toolCalls.push(toolCallOf(b));
          break;
        case 'tool_result':
          (inLeadingRun ? leading : results).push(toolResultMessage(b));
          break;
        case 'image':
          inLeadingRun = false;
          parts.push({ type: 'image_url', image_url: { url: b.text ?? '' } });
          break;
        case 'thinking':
          inLeadingRun = false;
          thinking.push(b.text ?? '');
          break;
        case 'cache_control':
          // A synthetic block from the Anthropic shape. Preserved as an empty
          // text part so that positions and block counts still line up, and
          // dropped as *meaning*: there is no per-block cache marker to put here,
          // and inventing one is the failure mode this adapter is avoiding.
          inLeadingRun = false;
          parts.push({ type: 'text', text: '' });
          break;
        case 'text':
          inLeadingRun = false;
          parts.push({ type: 'text', text: b.text ?? '' });
          break;
      }
    }

    const hasBody = parts.length > 0 || toolCalls.length > 0 || thinking.length > 0;
    // A message whose blocks are all tool results has no body of its own, and
    // emitting an empty placeholder for it would *add* a message that the
    // canonical state does not have. A message with no blocks at all is a real
    // position in the conversation and does get its placeholder.
    for (const result of leading) messages.push(result);
    if (hasBody || (results.length === 0 && leading.length === 0)) {
      messages.push({
        role: wireRole(m.role),
        content: contentField(parts, toolCalls.length > 0),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(thinking.length > 0 ? { reasoning_content: thinking.join('\n') } : {}),
      });
    }
    for (const result of results) messages.push(result);
  }

  // `messages` is replaced wholesale, so nothing from `req` can leak: there is no
  // equivalent of the Anthropic adapter's `system` field to strip, because a
  // system message is a message and messages are the thing being rebuilt.
  return { ...req, messages };
}
