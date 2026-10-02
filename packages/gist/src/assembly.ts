import type {
  ArtifactRef,
  ContextState,
  ContentBlock,
  GistArtifact,
  GistChanged,
  GistDecision,
  GistLog,
  GistNext,
  GistVerification,
  Message,
} from '@strata-ctx/core-types';
import { validateGist } from '@strata-ctx/core-types';
import type { StrataPolicy } from '@strata-ctx/core-types';
import { pinSetText, collectGovernanceText } from '@strata-ctx/core-types';
import type { BudgetView } from '@strata-ctx/core-types';
import { estimateTokens } from '@strata-ctx/core-types';
import { isResolvableArtifactUri } from './artifact-uri.js';
import { RAW_URI_UNSTORED } from './draft.js';
import type { GistDraft } from './draft.js';

export interface ToolCallSummary {
  readonly name: string;
  readonly count: number;
  readonly errorCount: number;
  readonly totalDurationMs: number;
}

export interface FileOpSummary {
  readonly path: string;
  readonly readBytes: number;
  readonly writeBytes: number;
  readonly op: 'read' | 'write' | 'delete';
}

export interface GistAssemblyInput {
  readonly state: ContextState;
  readonly policy: StrataPolicy;
  readonly budget: BudgetView;
  readonly taskId: string;
  readonly status: 'complete' | 'partial' | 'blocked' | 'abandoned';
  readonly goal: string;
  readonly selfGistBlock?: ContentBlock;
}

/**
 * The index span, in the full message array, that compaction covers: from the
 * first conversational turn to the last.
 *
 * Indices must address the unfiltered array, because both consumers slice the
 * unfiltered array: eviction in transaction.ts step 6, and recovery in
 * reversibility.ts. Deriving them from a user/assistant-filtered list made
 * those two consumers address different messages, so a gist could evict a
 * range that recovery never returned. Tool messages between turns are included
 * in the span on purpose: they carry the file contents and are exactly what
 * has to stay recoverable.
 */
function extractTurnRange(state: ContextState): [number, number] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < state.messages.length; i++) {
    const role = state.messages[i]?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    if (first === -1) first = i;
    last = i;
  }
  if (first === -1) return [0, 0];
  return [first, last];
}

function _extractToolCalls(messages: readonly Message[]): ToolCallSummary[] {
  const toolCalls = new Map<string, { count: number; errorCount: number; totalDurationMs: number }>();

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.toolName) {
        const existing = toolCalls.get(block.toolName) ?? { count: 0, errorCount: 0, totalDurationMs: 0 };
        existing.count += 1;
        toolCalls.set(block.toolName, existing);
      }
    }
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.id) {
        const toolName = block.toolName ?? 'unknown';
        const existing = toolCalls.get(toolName) ?? { count: 0, errorCount: 0, totalDurationMs: 0 };
        const isError = block.meta.severity === 'error' || block.meta.severity === 'fatal';
        if (isError) existing.errorCount += 1;
        const version = block.meta.subject?.version;
        const durationMs = version ? Number(version) : 0;
        if (durationMs > 0) existing.totalDurationMs += durationMs;
        toolCalls.set(toolName, existing);
      }
    }
  }

  return Array.from(toolCalls.entries()).map(([name, data]) => ({
    name,
    count: data.count,
    errorCount: data.errorCount,
    totalDurationMs: data.totalDurationMs,
  }));
}

function _extractFileOps(messages: readonly Message[]): FileOpSummary[] {
  const fileOps = new Map<string, { path: string; readBytes: number; writeBytes: number; op: 'read' | 'write' | 'delete' }>();

  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.meta.subject?.kind === 'file') {
        const path = block.meta.subject.ref;
        const existing = fileOps.get(path) ?? { path, readBytes: 0, writeBytes: 0, op: 'read' as const };
        const bytes = block.meta.bytes;
        let updated = existing;
        if (block.toolName === 'write' || block.toolName === 'edit') {
          updated = { ...existing, writeBytes: existing.writeBytes + bytes, op: 'write' as const };
        } else if (block.toolName === 'delete') {
          updated = { ...existing, op: 'delete' as const };
        } else {
          updated = { ...existing, readBytes: existing.readBytes + bytes };
        }
        fileOps.set(path, updated);
      }
    }
  }

  return Array.from(fileOps.values());
}

function extractSalientErrors(messages: readonly Message[]): string[] {
  const errors: string[] = [];
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.meta.severity === 'error' || block.meta.severity === 'fatal') {
        if (block.text) errors.push(block.text);
      }
    }
  }
  return errors;
}

function extractRanAndFailed(messages: readonly Message[]): { ran: string[]; failed: string[] } {
  const ran: string[] = [];
  const failed: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.toolName) {
        ran.push(block.toolName);
      }
    }
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.toolName) {
        const isError = block.meta.severity === 'error' || block.meta.severity === 'fatal';
        if (isError) failed.push(block.toolName);
      }
    }
  }
  return { ran, failed };
}

function extractChanged(
  messages: readonly Message[],
): GistChanged[] {
  const changed = new Map<string, GistChanged>();

  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.meta.subject?.kind === 'file') {
        const path = block.meta.subject.ref;
        const sha = block.meta.sha256;
        const toolName = block.toolName ?? 'unknown';
        const what = `${toolName} ${path}`;
        const why = block.text?.slice(0, 200) ?? 'no description';
        if (!changed.has(path)) {
          changed.set(path, { path, what, why, sha });
        }
      }
    }
  }

  return Array.from(changed.values());
}

function extractCurrentValues(messages: readonly Message[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.meta.subject?.kind === 'command') {
        const ref = block.meta.subject.ref;
        if (ref.startsWith('env:')) {
          const [, key, value] = ref.split(':', 3);
          if (key && value) env[key] = value;
        }
      }
    }
  }
  return env;
}

function parseSelfGist(block: ContentBlock): {
  goal?: string;
  decided?: GistDecision[];
  unresolved?: string[];
  next?: { question: string; next_command: string; blockers: string[] };
} {
  if (block.type !== 'text' || !block.text) return {};
  const text = block.text;
  const goalMatch = text.match(/^goal:\s*(.+)$/im);
  const decidedMatches = text.matchAll(/^decided:\s*(\w+)\s*-\s*(.+?)\s*\(why:\s*(.+?)\)/gim);
  const unresolvedMatches = text.matchAll(/^unresolved:\s*(.+)$/gim);
  const nextQuestionMatch = text.match(/^next_question:\s*(.+)$/im);
  const nextCommandMatch = text.match(/^next_command:\s*(.+)$/im);
  const blockersMatch = text.match(/^blockers:\s*(.+)$/im);

  const decided: GistDecision[] = [];
  for (const match of decidedMatches) {
    const id = match[1];
    const choice = match[2];
    const why = match[3];
    if (id && choice && why) {
      decided.push({ id, choice, why, alternatives_rejected: [] });
    }
  }

  const unresolved: string[] = [];
  for (const match of unresolvedMatches) {
    const m = match[1];
    if (m) unresolved.push(m.trim());
  }

  const next = nextQuestionMatch || nextCommandMatch || blockersMatch
    ? {
        question: nextQuestionMatch?.[1]?.trim() ?? '',
        next_command: nextCommandMatch?.[1]?.trim() ?? '',
        blockers: blockersMatch?.[1]?.split(',').map((b) => b.trim()) ?? [],
      }
    : undefined;

  const result: {
    goal?: string;
    decided?: GistDecision[];
    unresolved?: string[];
    next?: { question: string; next_command: string; blockers: string[] };
  } = {};

  const goal = goalMatch?.[1]?.trim();
  if (goal) result.goal = goal;
  if (decided.length > 0) result.decided = decided;
  if (unresolved.length > 0) result.unresolved = unresolved;
  if (next) result.next = next;

  return result;
}

function buildLogGist(
  messages: readonly Message[],
  rawUri: string,
): GistLog {
  const { ran, failed } = extractRanAndFailed(messages);
  const salientErrors = extractSalientErrors(messages);
  const droppedCount = messages.length; // Approximation

  return {
    ran,
    failed,
    salient_errors: salientErrors,
    salient_warnings: [],
    dropped_count: droppedCount,
    raw_uri: rawUri,
  };
}

function buildArtifacts(artifacts: readonly ArtifactRef[]): GistArtifact[] {
  return artifacts.map((a) => ({
    uri: a.uri,
    sha256: a.sha256,
    bytes: a.bytes,
  }));
}

function buildNext(
  parsed: ReturnType<typeof parseSelfGist>,
  messages: readonly Message[],
): GistNext {
  if (parsed.next) return parsed.next;
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const question = lastUserMsg?.content.map((b) => b.text ?? '').join(' ') ?? 'What is the next step?';
  return {
    question,
    next_command: 'continue',
    blockers: [],
  };
}

export class GistAssembler {
  assemble(input: GistAssemblyInput): GistDraft {
    const { state, policy, budget: _budget, taskId, status, goal, selfGistBlock } = input;

    const sourceTurnRange = extractTurnRange(state);
    const _inputTokensBefore = state.tokenEstimate > 0 ? state.tokenEstimate : estimateTokens(state);

    const parsed = selfGistBlock ? parseSelfGist(selfGistBlock) : {};

    const artifacts = buildArtifacts(state.artifacts);
    // `log_gist.raw_uri` is documented as the pointer to the *untruncated log*
    // (core-types/src/gist.ts:60-61), so only a raw-transcript artifact can fill
    // it, and only when the ACL can resolve what it names. This used to be
    // `state.artifacts[0]`, which pointed the transcript claim at a file
    // snapshot whenever the context carried one first, and at the literal
    // `artifact://empty` when it carried none -- a bucket the ACL refuses, so a
    // URI that resolved to nothing, on a gist that still claimed to be
    // recoverable.
    const transcriptUri = state.artifacts.find(
      (artifact) => artifact.kind === 'raw_transcript' && isResolvableArtifactUri(artifact.uri),
    )?.uri;

    const logGist = buildLogGist(state.messages, transcriptUri ?? RAW_URI_UNSTORED);

    const constraints = pinSetText(policy);
    const inboundConstraints = collectGovernanceText(state);
    const constraintsMatch = constraints.length === inboundConstraints.length &&
      constraints.every((c, i) => c === inboundConstraints[i]);
    if (!constraintsMatch) {
      throw new Error('Constraint byte-equality check failed: gist constraints do not match pinned buffer');
    }

    const changed = extractChanged(state.messages);
    const currentValues = extractCurrentValues(state.messages);
    const decided = parsed.decided ?? [];
    const unresolved = parsed.unresolved ?? [];
    const next = buildNext(parsed, state.messages);
    const finalGoal = parsed.goal ?? goal;

    const verification: GistVerification = { tests_run: [], status: 'untested' };
    const compressedBy = selfGistBlock ? 'self-gist' : 'local-model';

    const gist: GistDraft = {
      v: 1,
      task_id: taskId,
      status,
      goal: finalGoal,
      changed,
      current_values: currentValues,
      decided,
      unresolved,
      artifacts,
      next,
      log_gist: logGist,
      verification,
      constraints,
      source_turn_range: sourceTurnRange,
      // Conditional spread, not `raw_recoverable: false`: `false` is not a
      // `Gist` (core-types/src/gist.ts:102 is `z.literal(true)`), so writing it
      // would hand back an object that fails its own schema. Absent is the only
      // honest encoding -- nothing was stored, so there is nothing to restore,
      // and the field is not this function's to assert. Absent is also what
      // makes the draft safe to pass on: `runCompactionTransaction` stamps the
      // claim it earns by putting the transcript (transaction.ts:387).
      ...(transcriptUri === undefined ? {} : { raw_recoverable: true as const }),
      compressed_by: compressedBy,
    };

    // Validated as the gist this becomes, because that is the object the
    // transaction will validate and the only difference is the one field the
    // store fills. A draft therefore cannot smuggle a defect past this gate by
    // being incomplete: everything it does own -- digests, turn range, retained
    // errors -- is checked here exactly as it will be checked again downstream.
    const validation = validateGist({ ...gist, raw_recoverable: true }, logGist.salient_errors.length);
    if (!validation.ok) {
      const defectMsgs = validation.defects.map((d) => d.kind).join(', ');
      throw new Error(`Gist validation failed: ${defectMsgs}`);
    }

    return gist;
  }
}

export function createGistAssembler(): GistAssembler {
  return new GistAssembler();
}