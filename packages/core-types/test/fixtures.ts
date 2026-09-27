import type {
  BlockMeta,
  ContentBlock,
  ContextState,
  Message,
  Tier,
} from '../src/index.js';
import { DEFAULT_POLICY, StrataPolicySchema, type StrataPolicy } from '../src/index.js';
import { runId, taskId } from '../src/ids.js';
import { sha256 } from '../src/hash.js';

export function meta(over: Partial<BlockMeta> = {}): BlockMeta {
  const text = over.subject?.ref ?? 'seed';
  return {
    origin: 'user',
    sha256: sha256(text),
    tier: 'episodic' as Tier,
    bytes: 100,
    cacheable: false,
    ...over,
  };
}

export function block(over: Partial<ContentBlock> = {}): ContentBlock {
  const text = over.text ?? 'hello';
  return { type: 'text', text, meta: meta({ bytes: text.length }), ...over };
}

export function governanceBlock(text: string): ContentBlock {
  return block({ text, meta: meta({ tier: 'governance', origin: 'system', bytes: text.length }) });
}

export function message(role: Message['role'], content: readonly ContentBlock[]): Message {
  return { role, content, ts: 1_700_000_000_000 };
}

export function state(over: Partial<ContextState> = {}): ContextState {
  return {
    messages: [message('system', [block()]), message('user', [block({ text: 'do the thing' })])],
    pinned: [],
    tokenEstimate: 0,
    policyHash: sha256(''),
    runId: runId('run-1'),
    turn: 1,
    gists: [],
    artifacts: [],
    ...over,
  };
}

export function policyWith(constraints: readonly string[]): StrataPolicy {
  return StrataPolicySchema.parse({
    version: 1,
    constraints: constraints.map((text, i) => ({
      id: `c${i + 1}`,
      text,
      sha256: sha256(text),
      source: 'org_policy',
      kind: 'soft_policy',
      enforcement: 'block',
    })),
  });
}

export { DEFAULT_POLICY, taskId };
