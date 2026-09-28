import type {
  ArtifactRef,
  ContextState,
  ContentBlock,
  Gist,
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
import { sha256 } from '@strata-ctx/core-types';

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

function extractTurnRange(state: ContextState): [number, number] {
  const turns = state.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m, i) => i);
  if (turns.length === 0) return [0, 0];
  const first = turns[0];
  const last = turns[turns.length - 1];
  return [first ?? 0, last ?? 0];
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
  artifactRef: ArtifactRef,
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
    raw_uri: artifactRef.uri,
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
  assemble(input: GistAssemblyInput): Gist {
    const { state, policy, budget: _budget, taskId, status, goal, selfGistBlock } = input;

    const sourceTurnRange = extractTurnRange(state);
    const _inputTokensBefore = state.tokenEstimate > 0 ? state.tokenEstimate : estimateTokens(state);

    const parsed = selfGistBlock ? parseSelfGist(selfGistBlock) : {};

    const artifacts = buildArtifacts(state.artifacts);
    const artifactRef = state.artifacts[0] ?? { uri: 'artifact://empty', sha256: sha256(''), bytes: 0, kind: 'other' as const };

    const logGist = buildLogGist(state.messages, artifactRef);

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

    const gist: Gist = {
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
      raw_recoverable: true,
      compressed_by: compressedBy,
    };

    const validation = validateGist(gist, logGist.salient_errors.length);
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