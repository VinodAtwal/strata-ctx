import type {
  BlockMeta,
  BlockSubject,
  ContentBlock,
  ContextState,
  Message,
  Role,
  Tier,
} from '@strata-ctx/core-types';
import { sha256, runId } from '@strata-ctx/core-types';

/**
 * Anthropic Messages API <-> canonical model.
 *
 * This is the default ingress because Claude Code is the primary target, but the
 * canonical model is the one the pipeline sees; every other provider gets its own
 * adapter and none of them can leak a provider quirk into the pipeline.
 */

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string | { type: string; text: string }[];
  messages: {
    role: 'user' | 'assistant';
    content: string | AnthropicContentBlock[];
  }[];
  stream?: boolean;
  [k: string]: unknown;
}

export type AnthropicContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } | null }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'image'; source: { type: string; [k: string]: unknown } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean };

/** Maps a canonical block type to the tier it should be filed under. */
const tierFor = (type: ContentBlock['type']): Tier =>
  type === 'tool_use' || type === 'tool_result' ? 'tool_state' : 'episodic';

/**
 * `tool_use` identity: the *call*, not the callee's name.
 *
 * The wire block is `{ type: 'tool_use'; id: string; name: string; input: unknown }`
 * (the union member declared above), so a call is fully identified by `name`
 * together with `input`. This file used to stamp `ref: block.name`, which made
 * every `Read` in a turn the same identity (`other\0Read`): a `Read` of
 * `/repo/a.ts` and a `Read` of `/repo/b.ts` became one subject, dedupe dropped
 * the loser as a duplicate, and the loser's `tool_result` survived with no
 * `tool_use` to answer it -- which the Messages API rejects.
 *
 * `JSON.stringify` over `input` is the same projection the block is already
 * hashed and text-projected with (`meta.sha256` and `textOf` below), so the
 * identity cannot disagree with the bytes. A client that varies its JSON key
 * order between two identical calls gets two identities and no drop, which is
 * the safe direction. `?? null` because `JSON.stringify(undefined)` is
 * `undefined` and this feeds a template; the same guard as Gemini's
 * `encodeStruct` at gemini-adapter.ts:183.
 *
 * `id` is deliberately *not* in the key: it is a correlation token, unique per
 * call, so keying on it would make every call a distinct subject and dedupe
 * would never fire for tool_use at all. `id` pairs a call with its result
 * (dedupe.ts `pairIndex`), which is the job it is actually for.
 */
const toolUseSubject = (name: string, input: unknown): BlockSubject => ({
  kind: 'other',
  ref: `${name}\u0000${JSON.stringify(input ?? null)}`,
});

/**
 * `tool_result` identity: the `tool_use_id`, which is what the wire block carries
 * and what distinguishes one call's result from another's. Kept distinct from
 * `toolUseSubject` on purpose: if the two halves shared a subject, the result
 * would read as a *newer version* of the call and the call would be dropped out
 * from under it.
 */
const toolResultSubject = (toolUseId: string): BlockSubject => ({
  kind: 'other',
  ref: toolUseId,
});

const metaFor = (
  block: AnthropicContentBlock,
  cacheable: boolean,
  origin: BlockMeta['origin'],
): BlockMeta => {
  const subject =
    block.type === 'tool_use'
      ? toolUseSubject(block.name, block.input)
      : block.type === 'tool_result'
        ? toolResultSubject(block.tool_use_id)
        : undefined;
  return {
    origin,
    sha256: sha256(JSON.stringify(block)),
    ...(subject ? { subject } : {}),
    tier: tierFor(block.type),
    bytes: JSON.stringify(block).length,
    cacheable,
    ...(block.type === 'tool_result' && block.is_error ? { severity: 'error' as const } : {}),
  };
};

const textOf = (content: AnthropicContentBlock): string => {
  switch (content.type) {
    case 'text':
      return content.text;
    case 'thinking':
      return content.thinking;
    case 'tool_use':
      return JSON.stringify({ tool: content.name, input: content.input });
    case 'tool_result':
      return typeof content.content === 'string'
        ? content.content
        : JSON.stringify(content.content);
    case 'image':
      return '[image]';
  }
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The token a caller sees when a tool_use block's arguments are not readable. */
const INPUT_LOSS = 'ANTHROPIC_INPUT_LOSS';

/**
 * The `input` for a tool_use egress, read back out of the block's `text`.
 *
 * This is a *read*, not a recovery. `textOf` puts the whole payload on ingress,
 * so for any block that has not been through a lossy stage the arguments are
 * sitting in `text` and simply have to be read. The two are written as
 * functions rather than kept in sync by hand because they are one envelope, and
 * the write side is the one that owns the shape.
 *
 * A tool_use `input` is arbitrary JSON, so a non-object argument -- `"query"`,
 * `42`, `null` -- is *legal* and passes through untouched. That is the one place
 * this differs from the Gemini adapter's decode: there the wire field is a
 * typed Struct, so a non-object is a loss, while here it is a value.
 *
 * The only true loss is text that no longer parses as the envelope, which means
 * a lossy stage rewrote it. `{}` is the wrong answer there: Anthropic treats an
 * empty object as a valid call with no arguments, and the model would run the
 * tool with arguments nobody supplied. Say so instead.
 */
const toolInputOf = (b: ContentBlock): unknown => {
  const raw = b.text;
  if (raw === undefined || raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      error: `${INPUT_LOSS}: this tool_use's arguments no longer parse, so the call is incomplete; a lossy stage rewrote them`,
    };
  }
  if (!isRecord(parsed) || !('input' in parsed)) {
    return {
      error: `${INPUT_LOSS}: this tool_use's arguments are not the envelope ingress wrote, so the call is incomplete`,
    };
  }
  return parsed['input'];
};

export function toCanonical(req: AnthropicRequest, now = Date.now()): ContextState {
  const messages: Message[] = [];

  // The system prompt is where a Claude Code user puts CLAUDE.md and any policy
  // they pasted. Treating it as ordinary context is how it gets compacted away,
  // so it is carried as a leading system message and eligible for pinning.
  if (req.system) {
    const sysText =
      typeof req.system === 'string'
        ? req.system
        : req.system.map((b) => ('text' in b ? b.text : '')).join('\n');
    if (sysText.trim() !== '') {
      messages.push({
        role: 'system',
        ts: now,
        content: [
          {
            type: 'text',
            text: sysText,
            meta: {
              origin: 'system',
              sha256: sha256(sysText),
              tier: 'user_intent',
              bytes: sysText.length,
              cacheable: true,
            },
          },
        ],
      });
    }
  }

  for (const m of req.messages) {
    const blocks: ContentBlock[] =
      typeof m.content === 'string'
        ? [
            {
              type: 'text',
              text: m.content,
              meta: {
                origin: m.role,
                sha256: sha256(m.content),
                tier: 'episodic',
                bytes: m.content.length,
                cacheable: false,
              },
            },
          ]
        : m.content.map((b, i) => ({
            type: b.type,
            text: textOf(b),
            ...('id' in b ? { id: b.id } : {}),
            ...('name' in b ? { toolName: b.name } : {}),
            ...('tool_use_id' in b ? { id: b.tool_use_id } : {}),
            cacheControl: 'cache_control' in b ? (b.cache_control ?? null) : null,
            meta: metaFor(b, i === 0 && m.role === 'user', m.role),
          }));

    messages.push({ role: m.role as Role, content: blocks, ts: now });
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

/**
 * Canonical -> Anthropic Messages. Deliberately lossy on the way out only in
 * fields the wire format cannot express; nothing is dropped, because every
 * canonical block carries a `text` projection of its payload.
 *
 * Carrying the payload in `text` is necessary but not sufficient, and this
 * function is where the difference bites: a block whose payload lives in `text`
 * is only preserved if something reads it back. `tool_use` used to send
 * `input: {}` regardless, which is how a populated call became an empty one.
 * Every `text`-backed payload on this path is now read back out; see
 * `toolInputOf`.
 */
export function fromCanonical(state: ContextState, req: AnthropicRequest): AnthropicRequest {
  const system = state.messages.filter((m) => m.role === 'system');
  const rest = state.messages.filter((m) => m.role !== 'system');

  const toWire = (b: ContentBlock): AnthropicContentBlock => {
    const cache = b.cacheControl ? { cache_control: b.cacheControl } : {};
    switch (b.type) {
      case 'text':
        return { type: 'text', text: b.text ?? '', ...cache };
      case 'thinking':
        return { type: 'thinking', thinking: b.text ?? '' };
      case 'image':
        // The canonical model keeps images as a reference, so a round trip
        // preserves the block but cannot reconstruct pixels. Anything that
        // needs the bytes keeps the original block untouched.
        return { type: 'image', source: { type: 'ref', ref: b.id ?? '' } };
      case 'tool_use':
        return { type: 'tool_use', id: b.id ?? '', name: b.toolName ?? 'unknown', input: toolInputOf(b) };
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: b.id ?? '',
          content: b.text ?? '',
          ...(b.meta.severity === 'error' ? { is_error: true } : {}),
        };
      case 'cache_control':
        return { type: 'text', text: '' };
    }
  };

  // `system` is omitted rather than set to undefined: with exactOptionalPropertyTypes
  // an explicit undefined is not the same as an absent key, and the canonical model
  // is the source of truth, so req.system must not leak through when canonical has none.
  const { system: _reqSystem, ...base } = req;
  const out: AnthropicRequest = {
    ...base,
    messages: rest.map((m) => ({
      role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: m.content.map(toWire),
    })),
  };
  if (system.length > 0) {
    out.system = system.map((m) => ({ type: 'text', text: m.content.map((b) => b.text ?? '').join('\n') }));
  }
  return out;
}
