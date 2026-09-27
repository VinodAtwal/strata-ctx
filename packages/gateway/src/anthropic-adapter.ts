import type {
  BlockMeta,
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

const metaFor = (
  block: AnthropicContentBlock,
  cacheable: boolean,
  origin: BlockMeta['origin'],
): BlockMeta => {
  const subject =
    block.type === 'tool_result' || block.type === 'tool_use'
      ? { kind: 'other' as const, ref: block.type === 'tool_use' ? block.name : block.tool_use_id }
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
        return { type: 'tool_use', id: b.id ?? '', name: b.toolName ?? 'unknown', input: {} };
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
