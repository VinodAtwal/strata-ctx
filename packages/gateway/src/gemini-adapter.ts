import type {
  BlockMeta,
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
 * Google Gemini `generateContent` <-> the canonical model.
 *
 * The sibling of ./anthropic-adapter.ts, and deliberately not a rename of it.
 * Gemini's turn is `contents: [{ role, parts: [...] }]` where a `Part` is a
 * one-of union, and three of the differences are load-bearing rather than
 * cosmetic:
 *
 * 1. **The system prompt is not a message.** It is a top-level
 *    `systemInstruction` field, addressed separately from `contents`; there is
 *    no `role: 'system'` entry in the conversation to preserve. See
 *    `systemInstructionMessage` for what that becomes and why.
 * 2. **Tool correlation is by function *name*.** Anthropic pairs a
 *    `tool_result` with a `tool_use` through `tool_use_id`; a Gemini
 *    `functionResponse` carries a `name` and no id, so the name is the
 *    correlation key. The canonical `id` is filled with it and `toolName` is
 *    set alongside, so a canonical block is self-describing whichever field a
 *    downstream stage reaches for.
 * 3. **Results ride in a `user` turn.** A `functionResponse` is a part of a
 *    `user` content, so the message role cannot tell you the block came from a
 *    tool. The part kind has to, or `meta.origin` is a lie and dedupe, triage
 *    and gist assembly all key off a field that says `user`.
 *
 * ## Order stability
 *
 * Both directions are single forward walks with no sort, no grouping, no
 * dedupe and no merge of adjacent turns. Canonical message order is wire order,
 * with the system message hoisted to index 0 because `systemInstruction` is
 * itself the provider's first segment and hoisting it is therefore also
 * prefix-preserving; block order inside a message is `parts` order. This is what
 * A-13 needs: a stage that reorders blocks inside the cached prefix invalidates
 * the provider's cache and destroys the unit economics of the whole system
 * (decisions R4), and the cheapest way to keep that guarantee is for the adapter
 * never to have introduced an order the wire did not have. Two calls with the
 * same body produce byte-identical output (DoD 8.2); the only value that varies
 * is `now`, which the caller pins in tests.
 *
 * ## Lossy fields, listed
 *
 * Every one of these is a field the canonical model has nowhere to put, kept in
 * one list so the set cannot grow silently:
 *
 * | Wire | Canonical | Loss |
 * |---|---|---|
 * | `functionCall.args` (a Struct) | `ContentBlock.text` (JSON) | structured only as text; a stage that rewrites the text leaves a value that no longer parses, and egress then sends `{}` |
 * | `functionCall.id` | `ContentBlock.id` | kept when present; absent (the common case) it is filled with the function name, which is the correlation key Gemini actually uses |
 * | `functionResponse.response` (a Struct) | `ContentBlock.text` (JSON) | as `args` above |
 * | `inlineData.data` (base64 bytes) | `ContentBlock.text` (the mime type) | **the bytes are gone.** The canonical model has no binary field. Egress emits a `fileData` pointer when the block kept a `fileUri`, and a visible `[image]` placeholder otherwise -- never an empty `inlineData`, which is a part the provider rejects and would turn a lossy adapter into a failed request (N5: fail toward more context) |
 * | `thoughtSignature` | -- | dropped, exactly as the Anthropic adapter drops `thinking.signature`. Proposal in the A-10 report: `ContentBlock` needs a provider-opaque field |
 * | `systemInstruction.role` | -- | dropped. The provider ignores it on this field |
 * | `executableCode`, `codeExecutionResult`, any part kind not in `GeminiPart` | `ContentBlock.text` (`[unsupported part: ...]`, `origin: 'synthetic'`) | downgraded to a visible placeholder rather than dropped, and never mapped onto `tool_use`/`tool_result`: a Gemini code-execution part is not a function call, and re-emitting it as one would have the model wait for a tool response the gateway invented |
 *
 * ## Structural garbage versus a garbage part
 *
 * A body that is not a `generateContent` request at all throws out of the
 * converters, and `safeToCanonical` / `safeFromCanonical` turn that into an
 * unmodified passthrough. A body whose *elements* are wrong degrades one block
 * at a time instead, because one bad part in a 400-part transcript is not a
 * reason to refuse the turn. What that degradation preserves is the part *kind*
 * wherever the kind is legible: a `functionCall` whose `name` is missing is
 * still a call, and flattening it to a placeholder would throw away an
 * argument object the gateway can still see. What it never does is invent the
 * missing half -- no name, no id, no subject, no orphan verdict.
 */

/* -------------------------------------------------------------------------- */
/* Wire types                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `model` is not `assistant`. Gemini names the model's own turn `model` and
 * keeps `user` for everything the caller sent, including tool results.
 */
export type GeminiRole = 'user' | 'model';

export interface GeminiFunctionCall {
  /** Present only on some SDKs; correlation does not depend on it. See module header. */
  readonly id?: string;
  readonly name: string;
  readonly args?: Record<string, unknown>;
}

export interface GeminiFunctionResponse {
  readonly name: string;
  /** A Struct, not a string: the result envelope, usually `{ output }` or `{ error }`. */
  readonly response: Record<string, unknown>;
}

export interface GeminiTextPart {
  readonly text: string;
  /** Marks a reasoning part rather than something the user said. */
  readonly thought?: boolean;
  /** Opaque provider token; see the loss table. */
  readonly thoughtSignature?: string;
}

export interface GeminiInlineDataPart {
  readonly inlineData: { readonly mimeType: string; readonly data: string };
}

export interface GeminiFileDataPart {
  readonly fileData: { readonly mimeType?: string; readonly fileUri: string };
}

export type GeminiPart =
  | GeminiTextPart
  | { readonly functionCall: GeminiFunctionCall }
  | { readonly functionResponse: GeminiFunctionResponse }
  | GeminiInlineDataPart
  | GeminiFileDataPart;

export interface GeminiContent {
  /** Absent means `user`; the field is optional on the wire and defaulted here. */
  readonly role?: GeminiRole;
  readonly parts: readonly GeminiPart[];
}

export interface GeminiRequest {
  readonly contents: readonly GeminiContent[];
  readonly systemInstruction?: GeminiContent;
  readonly model?: string;
  readonly tools?: readonly unknown[];
  readonly toolConfig?: unknown;
  readonly generationConfig?: Readonly<Record<string, unknown>>;
  readonly safetySettings?: readonly unknown[];
  readonly cachedContent?: string;
  readonly stream?: boolean;
  /** Everything else (`candidates`, `labels`, future fields) rides through untouched. */
  readonly [k: string]: unknown;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asArray = (v: unknown): readonly unknown[] => (Array.isArray(v) ? (v as readonly unknown[]) : []);

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * `JSON.parse` is typed `any`, and the only rule standing between that and a
 * lossy stage is the one in AGENTS 3. The assertion is to `unknown`, which is a
 * widening rather than a claim about the value: everything below re-narrows it
 * from scratch.
 */
const tryParse = (text: string): { ok: true; value: unknown } | { ok: false } => {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { ok: false };
  }
  return { ok: true, value };
};

/**
 * The canonical `text` of a tool block, and back again.
 *
 * A Struct has no home in `ContentBlock`, so `args` and `response` are carried
 * as their JSON encoding. The encoding is exact for a given body, so an
 * untouched block round-trips; a block a lossy stage rewrote (head+tail
 * truncation, a summary) produces something that no longer parses, and the
 * honest answer to that is `{}` rather than a struct the model never emitted.
 */
const encodeStruct = (v: unknown): string => (isRecord(v) ? JSON.stringify(v) : '{}');

const decodeStruct = (text: string | undefined): Record<string, unknown> => {
  if (text === undefined || text === '') return {};
  const parsed = tryParse(text);
  if (!parsed.ok) return {};
  return isRecord(parsed.value) ? parsed.value : {};
};

/**
 * Block size, in the unit the rest of the gateway budgets in.
 *
 * Characters, not bytes: every row of `TOKEN_PROVIDERS`
 * (./token-estimator.ts) is a characters-per-token ratio, so a byte count would
 * be compared against a character denominator and quietly under-charge every
 * multibyte request. The payload hashed and measured here is the wire
 * projection the block was built from, which is what a later stage can still
 * find.
 */
const blockMeta = (
  payload: string,
  origin: Origin,
  tier: Tier,
  cacheable: boolean,
  extra?: { readonly subject?: BlockSubject; readonly severity?: Severity },
): BlockMeta => ({
  origin,
  sha256: sha256(payload),
  tier,
  bytes: payload.length,
  cacheable,
  ...(extra?.subject ? { subject: extra.subject } : {}),
  ...(extra?.severity ? { severity: extra.severity } : {}),
});

/** `subject.kind` is a closed union and no shared tool-name table exists. See the A-10 report. */
const toolSubject = (ref: string): BlockSubject => ({ kind: 'other', ref });

/**
 * `functionCall` identity: the *call*, not the function's name.
 *
 * The wire part is `{ functionCall: { id?, name, args? } }`, so a call is
 * identified by `name` together with `args`. This file used to stamp
 * `ref: name` for the call and the *same* `ref: name` for its
 * `functionResponse`, which is worse than the Anthropic adapter's version of the
 * same mistake: the two halves of one Gemini pair shared one identity, so dedupe
 * read the response as a newer version of the call and deleted the call, and
 * then deleted the *other* call too. Measured on a two-`Read` turn: both calls
 * dropped, both responses orphaned, `byReason.duplicate: 3`.
 *
 * `encodeStruct` is the projection the block is already hashed and text-carried
 * with (`blockMeta`, and the loss table above), so the identity cannot disagree
 * with the bytes. It collapses a non-Struct `args` to `'{}'`, which is the same
 * collapse the canonical `text` makes -- two calls with non-Struct arguments
 * that differ get one identity, and the loser's args are unrepresentable in the
 * canonical model either way (B-15, `decodeStruct`).
 *
 * `id` is not in the key because Gemini usually has none
 * (`GeminiFunctionCall.id`, above) and this adapter fills it with the name; using
 * it would make every call distinct in the good case and collide in the bad one.
 */
const toolUseSubject = (name: string, args: unknown): BlockSubject => ({
  kind: 'other',
  ref: `${name}\u0000${encodeStruct(args)}`,
});

/**
 * `functionResponse` identity: the `name`, which is the only correlation Gemini
 * carries (the module header, "Results ride in a `user` turn"; `GeminiFunctionResponse`
 * has no `id` field). Deliberately different from `toolUseSubject` so a call and
 * its own answer are never the same subject -- and deliberately not richer than
 * `name`, because there is nothing on the wire to make it richer.
 *
 * The consequence is that two calls to the same function in one turn are
 * indistinguishable, so `enforcePairAtomicity` in the pipeline refuses to drop
 * either rather than guess which response belonged to which call.
 */
const toolResultSubject = (name: string): BlockSubject => ({ kind: 'other', ref: name });

/* -------------------------------------------------------------------------- */
/* Ingress                                                                     */
/* -------------------------------------------------------------------------- */

/** Absent means `user`; the field is optional on the wire and defaulted here. */
const canonicalRole = (role: unknown): Role => (role === 'model' ? 'assistant' : 'user');

interface WalkState {
  /** Function names already called, in wire order. See the orphan rule below. */
  readonly calls: Set<string>;
  readonly origin: Origin;
  readonly cacheable: boolean;
}

/**
 * The keys of a part, sorted.
 *
 * Sorted because this string is a placeholder's *content* and therefore feeds
 * `meta.sha256`; two clients that send the same unknown part with their JSON
 * keys in a different order must produce the same hash or dedupe treats one as
 * new. `Object.keys` order is the sender's, so it cannot be relied on.
 */
const partKeys = (part: unknown): string => {
  if (Array.isArray(part)) return 'array';
  if (!isRecord(part)) return typeof part;
  return Object.keys(part).sort().join(',');
};

const unsupportedText = (part: unknown): string => `[unsupported part: ${partKeys(part)}]`;

const textPart = (part: unknown): GeminiTextPart | null => {
  if (!isRecord(part)) return null;
  const text = str(part['text']);
  return text === undefined ? null : { text, ...(part['thought'] === true ? { thought: true } : {}) };
};

const toBlock = (part: unknown, state: WalkState): ContentBlock => {
  const text = textPart(part);
  if (text !== null) {
    // A reasoning part becomes `thinking`, not `text` with a marker, so a stage
    // that must not summarise reasoning never has to parse a convention out of
    // prose to know it is looking at it.
    const type: ContentBlock['type'] = text.thought === true ? 'thinking' : 'text';
    return {
      type,
      text: text.text,
      cacheControl: null,
      // `episodic`, like every other prose block. Tool traffic is the only thing
      // that is `tool_state`, and a part kind is what says so.
      meta: blockMeta(text.text, state.origin, 'episodic', state.cacheable),
    };
  }

  if (isRecord(part)) {
    const call = part['functionCall'];
    if (isRecord(call)) {
      const name = str(call['name']);
      // Recorded even when the name is missing, so a response below is measured
      // against the same key the call would have had.
      if (name !== undefined) state.calls.add(name);
      const payload = encodeStruct(call['args']);
      const resolved = name ?? '';
      return {
        type: 'tool_use',
        text: payload,
        ...(resolved === '' ? {} : { id: str(call['id']) ?? resolved, toolName: resolved }),
        cacheControl: null,
        meta: blockMeta(payload, state.origin, 'tool_state', false, {
          ...(resolved === '' ? {} : { subject: toolUseSubject(resolved, call['args']) }),
        }),
      };
    }

    const response = part['functionResponse'];
    if (isRecord(response)) {
      const name = str(response['name']);
      const payload = encodeStruct(response['response']);
      const resolved = name ?? '';
      // Gemini has no `is_error` flag on a tool result, so an error is a
      // convention: a Struct carrying an `error` key. Missing the flag is not
      // cosmetic -- `truncate` keeps every ERROR/FATAL line of a tool result and
      // drops the rest, so a result that failed silently becomes the part most
      // likely to be cut.
      // TODO(WS-A, A-10): promote this to a first-class field once the frozen
      // contract can carry it; today the canonical model has no way to say
      // "this result failed" other than a severity it was not designed to
      // interpret from provider folklore.
      const failed = isRecord(response['response']) && 'error' in response['response'];
      // A response with no earlier call is either a truncated history or an
      // injected result. It is kept -- dropping a block the client sent is the
      // one thing a proxy must not do -- and marked `warn` so it is countable
      // without earning the retention that a real `error` earns.
      const orphan = resolved !== '' && !state.calls.has(resolved);
      const severity: Severity | undefined = failed ? 'error' : orphan ? 'warn' : undefined;
      return {
        type: 'tool_result',
        text: payload,
        ...(resolved === '' ? {} : { id: resolved, toolName: resolved }),
        cacheControl: null,
        // `tool`, not the enclosing role: the enclosing content is a `user`
        // turn because that is where Gemini puts results, and provenance is
        // what dedupe, triage and gist assembly key off. The Anthropic adapter
        // can read the role and get the right answer; Gemini cannot.
        meta: blockMeta(payload, 'tool', 'tool_state', false, {
          ...(resolved === '' ? {} : { subject: toolResultSubject(resolved) }),
          ...(severity === undefined ? {} : { severity }),
        }),
      };
    }

    const inline = part['inlineData'];
    if (isRecord(inline)) {
      // The mime type is the whole canonical projection: it is what identifies
      // the block to a human reading a transcript, and it is all egress can use.
      const mime = str(inline['mimeType']) ?? '';
      return {
        type: 'image',
        text: mime,
        cacheControl: null,
        meta: blockMeta(mime, state.origin, 'episodic', state.cacheable),
      };
    }

    const file = part['fileData'];
    if (isRecord(file)) {
      const mime = str(file['mimeType']) ?? '';
      const uri = str(file['fileUri']);
      return {
        type: 'image',
        text: mime,
        ...(uri === undefined || uri === '' ? {} : { id: uri }),
        cacheControl: null,
        meta: blockMeta(mime, state.origin, 'episodic', state.cacheable, {
          ...(uri === undefined || uri === '' ? {} : { subject: toolSubject(uri) }),
        }),
      };
    }
  }

  const marker = unsupportedText(part);
  // `synthetic`, not the enclosing role: this text was written by the gateway,
  // and provenance is what dedupe, eviction and the self-gist key off.
  return {
    type: 'text',
    text: marker,
    cacheControl: null,
    meta: blockMeta(marker, 'synthetic', 'episodic', state.cacheable),
  };
};

const toMessage = (content: unknown, calls: Set<string>, now: number): Message => {
  const parts = isRecord(content) ? asArray(content['parts']) : [];
  const role = canonicalRole(isRecord(content) ? content['role'] : undefined);
  const origin: Origin = role === 'assistant' ? 'assistant' : 'user';
  return {
    role,
    ts: now,
    content: parts.map((part, i) =>
      // The cacheable heuristic is deliberately the same one the Anthropic
      // adapter uses -- head of a user turn -- so A-13 has one rule to
      // cache-key on rather than one per provider.
      toBlock(part, { calls, origin, cacheable: i === 0 && role === 'user' }),
    ),
  };
};

/**
 * The `systemInstruction` text, or null when there is nothing to carry.
 *
 * Joined with `\n` across its text parts, mirroring the Anthropic adapter so
 * both providers produce an isomorphic canonical state for the same input.
 */
const instructionText = (sys: unknown): string | null => {
  if (!isRecord(sys)) return null;
  const texts = asArray(sys['parts'])
    .map((p) => textPart(p)?.text ?? '')
    .filter((t) => t.trim() !== '');
  return texts.length === 0 ? null : texts.join('\n');
};

/**
 * `systemInstruction` -> a leading canonical `system` message at tier
 * `user_intent`.
 *
 * The choice is between three tiers and two of them are wrong in ways that only
 * show up weeks later:
 *
 * - **Not `governance`.** `enforcePins` deletes every governance-tier block and
 *   replaces the set with the immutable policy buffer, so a `GEMINI.md` marked
 *   governance would be *erased* on the next turn and replaced by org policy --
 *   the user's own instructions would silently stop applying. An adapter also
 *   cannot honestly assert it: it has no way to know whether the text is an
 *   org constraint or a request to be terse. Only the policy store may write
 *   that tier.
 * - **Not `episodic`, and not a `user` message.** `episodic` is the tier
 *   `compact` replaces with a gist and `truncate` caps, and
 *   `TIER_RETENTION` (pipeline/src/triage.ts) gives it `compact`. A system
 *   prompt filed there is a `GEMINI.md` that survives until the first
 *   compaction and then does not.
 * - **`user_intent`**, whose retention is `verbatim`. The same argument the
 *   triage table already makes for the intent statement: the thing generic
 *   summarisation loses first is the standing instruction, and
 *   `spec.md` principle 4 is the reason.
 *
 * The role stays `system` so that `server.ts` sees the same shape it sees for
 * Anthropic and so the block stays addressable by the governance sweep, which
 * keys on tier, not role.
 */
const systemInstructionMessage = (sys: unknown, now: number): Message | null => {
  const text = instructionText(sys);
  if (text === null) return null;
  return {
    role: 'system',
    ts: now,
    content: [
      {
        type: 'text',
        text,
        cacheControl: null,
        // The most stable segment of the request there is: the same bytes every
        // turn until the user edits the file.
        meta: blockMeta(text, 'system', 'user_intent', true),
      },
    ],
  };
};

export function toCanonical(req: GeminiRequest, now = Date.now()): ContextState {
  const messages: Message[] = [];
  const head = systemInstructionMessage(req.systemInstruction, now);
  if (head !== null) messages.push(head);

  const calls = new Set<string>();
  for (const content of asArray(req.contents)) {
    if (!isRecord(content)) continue;
    messages.push(toMessage(content, calls, now));
  }

  return {
    messages,
    pinned: [],
    tokenEstimate: 0,
    policyHash: '',
    runId: runId('pending'),
    turn: 0,
    gists: [],
    artifacts: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Egress                                                                      */
/* -------------------------------------------------------------------------- */

const toPart = (b: ContentBlock): GeminiPart => {
  switch (b.type) {
    case 'text':
      return { text: b.text ?? '' };
    case 'thinking':
      // `thought: true` is what makes the model read this as its own reasoning
      // rather than as a user turn. Without it a replayed transcript turns the
      // model's own chain of thought into input.
      return { text: b.text ?? '', thought: true };
    case 'image': {
      const mime = b.text === undefined || b.text === '' ? undefined : b.text;
      const uri = b.id;
      // A kept `fileUri` round-trips as a pointer the provider can still fetch.
      // Without one the bytes are gone and an empty `inlineData` would be a
      // malformed part the provider rejects -- a failed request where a
      // placeholder serves the turn. See the loss table.
      if (uri === undefined || uri === '') {
        return { text: mime === undefined ? '[image]' : `[image ${mime}]` };
      }
      return { fileData: { ...(mime === undefined ? {} : { mimeType: mime }), fileUri: uri } };
    }
    case 'tool_use': {
      const name = b.toolName ?? b.id ?? 'unknown';
      // A `functionCall.id` that equals its own name is the SDK filling in the
      // correlation key Gemini already correlates on, and re-emitting it would
      // add a field the request never had. Anything else is a real provider id
      // -- two parallel calls of the same function -- and round-trips.
      const id = b.id;
      return {
        functionCall: {
          name,
          ...(id === undefined || id === name ? {} : { id }),
          args: decodeStruct(b.text),
        },
      };
    }
    case 'tool_result':
      return {
        functionResponse: { name: b.toolName ?? b.id ?? 'unknown', response: decodeStruct(b.text) },
      };
    case 'cache_control':
      return { text: '' };
  }
};

export function fromCanonical(state: ContextState, req: GeminiRequest): GeminiRequest {
  const system: Message[] = [];
  const contents: GeminiContent[] = [];

  for (const m of state.messages) {
    if (m.role === 'system') {
      system.push(m);
      continue;
    }
    contents.push({
      // `tool` becomes `user` because that is where Gemini puts a tool result:
      // a `user` content whose parts are `functionResponse`. There is no role on
      // this wire that means "the tool spoke", and inventing one would be a
      // request the provider rejects.
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: m.content.map(toPart),
    });
  }

  // `systemInstruction` is dropped rather than carried through from `req`:
  // with exactOptionalPropertyTypes an explicit `undefined` is not an absent
  // key, and canonical is the source of truth for what the system turn says.
  const { systemInstruction: _reqSystem, contents: _reqContents, ...base } = req;
  // One text part per system message, its blocks joined the same way ingress
  // joined the instruction's parts, so a round trip through a single
  // instruction is byte-identical.
  const instruction: readonly GeminiTextPart[] = system.map((m) => ({
    text: m.content.map((b) => b.text ?? '').join('\n'),
  }));
  return instruction.length === 0
    ? { ...base, contents }
    : { ...base, contents, systemInstruction: { parts: instruction } };
}

/* -------------------------------------------------------------------------- */
/* Fail-open envelope                                                          */
/* -------------------------------------------------------------------------- */

export interface GeminiIngress {
  readonly state: ContextState;
  /** True when the body could not be normalized; the caller must send it as received. */
  readonly failedOpen: boolean;
  /** Why, for telemetry. Null on success. Reported, never thrown -- see sse.ts on why. */
  readonly error: string | null;
}

export interface GeminiEgress {
  /** The original `req` object, by identity, when `failedOpen`; a new object otherwise. */
  readonly request: GeminiRequest;
  readonly failedOpen: boolean;
  readonly error: string | null;
}

const describe = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown error';

const EMPTY_INGRESS_STATE: ContextState = {
  messages: [],
  pinned: [],
  tokenEstimate: 0,
  policyHash: '',
  runId: runId('pending'),
  turn: 0,
  gists: [],
  artifacts: [],
};

/**
 * `toCanonical` with N5 attached: a body that is not a `generateContent`
 * request is passed through unmodified rather than dropped or half-converted.
 * The returned `state` is the empty state, which is never a safe thing to send
 * -- `failedOpen` is the flag that says so, and the caller must send `req`.
 */
export function safeToCanonical(req: GeminiRequest, now = Date.now()): GeminiIngress {
  try {
    return { state: toCanonical(req, now), failedOpen: false, error: null };
  } catch (err) {
    return { state: EMPTY_INGRESS_STATE, failedOpen: true, error: describe(err) };
  }
}

/** `fromCanonical` with N5 attached, on the same terms as `safeToCanonical`. */
export function safeFromCanonical(state: ContextState, req: GeminiRequest): GeminiEgress {
  try {
    return { request: fromCanonical(state, req), failedOpen: false, error: null };
  } catch (err) {
    return { request: req, failedOpen: true, error: describe(err) };
  }
}

/* -------------------------------------------------------------------------- */
/* Response metadata (N3: observed, never buffered)                           */
/* -------------------------------------------------------------------------- */

/**
 * The `usageMetadata` counters worth having. `cachedContentTokenCount` is the
 * cache-hit measurement A-13 needs and `thoughtsTokenCount` is the part of the
 * bill a reasoning model adds that never appears in `candidatesTokenCount`.
 * TODO(WS-A, A-10): confirm these names against a recorded response once the
 * F1 record/replay harness has fixtures; a provider that renames one should
 * degrade to 0 here rather than crash the observer.
 */
export interface GeminiUsageMetadata {
  readonly promptTokenCount: number;
  readonly candidatesTokenCount: number;
  readonly totalTokenCount: number;
  readonly cachedContentTokenCount: number;
  readonly thoughtsTokenCount: number;
}

export interface GeminiResponseMetadata {
  readonly responseId: string | null;
  readonly modelVersion: string | null;
  readonly finishReason: string | null;
  readonly usage: GeminiUsageMetadata | null;
}

const readUsage = (v: unknown): GeminiUsageMetadata | null => {
  if (!isRecord(v)) return null;
  return {
    promptTokenCount: num(v['promptTokenCount']),
    candidatesTokenCount: num(v['candidatesTokenCount']),
    totalTokenCount: num(v['totalTokenCount']),
    cachedContentTokenCount: num(v['cachedContentTokenCount']),
    thoughtsTokenCount: num(v['thoughtsTokenCount']),
  };
};

/**
 * Read the counters off one `generateContent` response, or off one chunk the SSE
 * layer has already framed.
 *
 * The argument is a single already-delimited JSON value, never a stream and
 * never a concatenation: N3 is that a response is not accumulated in order to
 * be transformed afterwards, and this is the only place in the adapter that
 * looks at response bytes at all. `sse.ts` already owns the framing and the
 * bounded tail; wiring the two together is integration work, not adapter work.
 *
 * Total by construction -- it returns an all-null record for anything it does
 * not recognise, including `null`, because it is called from a `data:` observer
 * on a live stream and an observer that throws takes the response down with it.
 */
export function readGeminiResponseMetadata(value: unknown): GeminiResponseMetadata {
  if (!isRecord(value)) {
    return { responseId: null, modelVersion: null, finishReason: null, usage: null };
  }
  const candidates = asArray(value['candidates']);
  const first = candidates.length > 0 ? candidates[0] : undefined;
  return {
    responseId: str(value['responseId']) ?? null,
    modelVersion: str(value['modelVersion']) ?? null,
    finishReason: isRecord(first) ? (str(first['finishReason']) ?? null) : null,
    usage: readUsage(value['usageMetadata']),
  };
}
