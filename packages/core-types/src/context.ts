import type { RunId, TaskId } from './ids.js';
import type { Gist } from './gist.js';

/**
 * The canonical model. Provider-neutral: adapters convert at the edge and the
 * pipeline only ever sees this. See docs/architecture.md §3.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type BlockType =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'image'
  | 'cache_control';

export type Origin = 'system' | 'user' | 'assistant' | 'tool' | 'synthetic';

/**
 * `governance` is not a flag checked at the end of a pipeline, it is a distinct
 * tier. Every lossy stage accepts `NonGovernanceMessage[]` only
 * (see ./guards.ts), so a lossy operator cannot even be handed one.
 */
export type Tier = 'governance' | 'episodic' | 'tool_state' | 'artifact_ref' | 'user_intent';

export type Severity = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export type SubjectKind = 'file' | 'command' | 'search' | 'web' | 'other';

/** Tool results carry the file/command identity; this is the dedupe key. */
export interface BlockSubject {
  readonly kind: SubjectKind;
  readonly ref: string;
  readonly version?: string;
}

export interface BlockMeta {
  readonly origin: Origin;
  /** Content hash, for dedupe and for detecting a block that changed under us. */
  readonly sha256: string;
  readonly subject?: BlockSubject;
  readonly tier: Tier;
  readonly bytes: number;
  /** Drives head/tail/severity retention in the truncate stage. */
  readonly severity?: Severity;
  /**
   * True when this block sits inside a provider's cached prefix. Reordering or
   * moving these invalidates the cache and destroys the unit economics of the
   * whole system, so transforms must be prefix-preserving. See decisions R4.
   */
  readonly cacheable: boolean;
  /** Set when a newer version of the same subject supersedes this block. */
  readonly supersededBy?: string;
}

export interface ContentBlock {
  readonly type: BlockType;
  readonly text?: string;
  /** tool_use / tool_result correlation id. */
  readonly id?: string;
  readonly toolName?: string;
  readonly meta: BlockMeta;
  /** Provider cache hints must survive every transform. */
  readonly cacheControl?: { readonly type: 'ephemeral' } | null;
}

export interface Message {
  readonly role: Role;
  readonly content: readonly ContentBlock[];
  readonly ts: number;
}

export interface ArtifactRef {
  readonly uri: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly kind: 'raw_transcript' | 'tool_log' | 'file_snapshot' | 'patch' | 'other';
}

/**
 * The whole context. Arrays are readonly because the pipeline is a chain of pure
 * functions (docs/architecture.md §1): a stage that mutates its input in place is
 * a bug, and the types should say so.
 */
export interface ContextState {
  readonly messages: readonly Message[];
  /**
   * The pinned buffer P. Replaced wholesale from the immutable policy buffer
   * before every outbound request -- never merged -- so that a gist or summary
   * cannot append text that looks like policy. See docs/architecture.md §7.
   */
  readonly pinned: readonly string[];
  readonly tokenEstimate: number;
  readonly policyHash: string;
  readonly runId: RunId;
  readonly turn: number;
  readonly taskId?: TaskId;
  /** Completed-task gists currently resident in context. */
  readonly gists: readonly Gist[];
  readonly artifacts: readonly ArtifactRef[];
}

/** Rough byte size of a block, used for budgeting when no tokenizer is available. */
export function blockBytes(b: ContentBlock): number {
  return b.meta.bytes;
}

/** True when this block is inside a provider's cached prefix. */
export const isCacheable = (b: ContentBlock): boolean => b.meta.cacheable;

/** Blocks at error or above are never dropped by the truncate stage. */
export const isHighSeverity = (b: ContentBlock): boolean =>
  b.meta.severity === 'error' || b.meta.severity === 'fatal';
