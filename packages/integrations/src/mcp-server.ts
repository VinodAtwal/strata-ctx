/**
 * MCP (Model Context Protocol) server for strata-ctx. WS-E, task E-1.
 *
 * This is the "universal Tier 1" integration in docs/integrations.md §5: one
 * server, six tools, usable from every agent that speaks MCP. It is the escape
 * hatch that makes aggressive compression safe to ship -- `get_task` pulls back
 * a transcript range that compaction dropped, which is how the iterative
 * refinement degradation reported in docs/evaluation.md is undone.
 *
 * Two honest limitations, stated here because the docs require them to be stated:
 *
 *  1. This path is **advisory**. The agent *chooses* to call these tools. We
 *     cannot enforce dedupe, truncation or governance pinning on context the
 *     model already holds. Pinned constraints are reported by `status`, not
 *     guaranteed on this path.
 *  2. There is no MCP SDK dependency. The protocol surface we need is small
 *     (initialize / tools/list / tools/call) and vendoring a 200kb runtime to
 *     parse six messages is a poor trade for a package that has to stay
 *     dependency-light. The wire shapes below follow the 2024-11-05 revision.
 */

import { breakevenOk, runId, sha256 } from '@strata-ctx/core-types';
import type { ArtifactRef, ContextState, Role, TaskId } from '@strata-ctx/core-types';
import { taskId as brandTaskId } from '@strata-ctx/core-types';

/* ------------------------------------------------------------------ *
 * JSON-RPC envelope
 * ------------------------------------------------------------------ */

export const JSONRPC_VERSION = '2.0';

/** The MCP protocol revision this server speaks. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

export const SERVER_NAME = 'strata-ctx';
export const SERVER_VERSION = '0.1.0';

export type JSONRPCId = string | number | null;

export interface JSONRPCRequest {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: JSONRPCId;
  readonly method: string;
  readonly params?: unknown;
}

export type JSONRPCErrorCode =
  /** malformed JSON on the wire */
  | -32700
  /** well-formed JSON, invalid request object */
  | -32600
  /** method not found */
  | -32601
  /** invalid params, including unknown tool and failed arg validation */
  | -32602
  /** handler threw */
  | -32603
  /** a tool that exists but failed at execution time */
  | -32000;

export interface JSONRPCErrorObject {
  readonly code: JSONRPCErrorCode;
  readonly message: string;
  readonly data?: unknown;
}

export interface JSONRPCSuccessResponse {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: JSONRPCId;
  readonly result: unknown;
}

export interface JSONRPCFailureResponse {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: JSONRPCId;
  readonly error: JSONRPCErrorObject;
}

export type JSONRPCResponse = JSONRPCSuccessResponse | JSONRPCFailureResponse;

/**
 * Thrown by the dispatcher and by `callTool` for protocol-level problems.
 *
 * The split matters: a tool that *fails* returns `{ isError: true }` in its
 * result (the model should see and can reason about it), while a tool that
 * cannot be addressed or whose arguments do not parse is a protocol error and
 * must not reach the model as a result.
 */
export class MCPError extends Error {
  readonly code: JSONRPCErrorCode;
  readonly data: unknown;

  constructor(code: JSONRPCErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = 'MCPError';
    this.code = code;
    this.data = data;
  }
}

/* ------------------------------------------------------------------ *
 * Tool schema + result types
 * ------------------------------------------------------------------ */

export type JSONSchemaType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null';

/**
 * The subset of JSON Schema the MCP tool surface actually uses. Not a general
 * implementation: if a tool needs more than this, the schema vocabulary grows
 * here rather than by pulling in a dependency.
 */
export interface JSONSchema {
  readonly type: JSONSchemaType;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JSONSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: JSONSchema;
  readonly enum?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly default?: unknown;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
}

export interface ToolSchema {
  readonly description: string;
  readonly inputSchema: JSONSchema;
}

export interface ToolTextContent {
  readonly type: 'text';
  readonly text: string;
}

export interface ToolResult {
  readonly content: readonly ToolTextContent[];
  /** Execution-time failure. Distinct from a JSON-RPC `error`. */
  readonly isError?: boolean;
  /**
   * Parsed payload for in-process callers. Stripped from the wire response so
   * we never emit a field the protocol did not negotiate.
   */
  readonly data?: unknown;
}

export type ToolArgs = Readonly<Record<string, unknown>>;

export type ToolHandler = (args: ToolArgs) => ToolResult | Promise<ToolResult>;

interface RegisteredTool {
  readonly definition: ToolDefinition;
  readonly handler: ToolHandler;
}

/** JSON body in a `ToolResult`, which is the only content type we emit. */
export function toolJson(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], data };
}

export function toolError(message: string, data?: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
    ...(data !== undefined ? { data } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Argument validation
 * ------------------------------------------------------------------ */

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly value: ToolArgs }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

interface Coerced {
  readonly valid: boolean;
  readonly value: unknown;
}

const INVALID: Coerced = { valid: false, value: undefined };

const typeOf = (value: unknown): JSONSchemaType | 'unknown' => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return t === 'string' || t === 'boolean' || t === 'object' ? t : 'unknown';
};

const typeMatches = (schema: JSONSchema, actual: JSONSchemaType | 'unknown'): boolean => {
  if (schema.type === 'number') return actual === 'number' || actual === 'integer';
  return actual === schema.type;
};

function coerce(schema: JSONSchema, value: unknown, path: string, issues: ValidationIssue[]): Coerced {
  if (value === undefined) {
    return schema.default === undefined
      ? INVALID
      : { valid: true, value: schema.default };
  }

  const actual = typeOf(value);
  if (!typeMatches(schema, actual)) {
    issues.push({ path, message: `expected ${schema.type}, got ${actual}` });
    return INVALID;
  }

  if (schema.enum !== undefined) {
    if (typeof value !== 'string' || !schema.enum.includes(value)) {
      issues.push({ path, message: `must be one of: ${schema.enum.join(', ')}` });
      return INVALID;
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path, message: `must be >= ${schema.minimum}` });
      return INVALID;
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path, message: `must be <= ${schema.maximum}` });
      return INVALID;
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({ path, message: `must be at least ${schema.minLength} character(s)` });
      return INVALID;
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({ path, message: `must be at most ${schema.maxLength} character(s)` });
      return INVALID;
    }
  }

  if (Array.isArray(value)) {
    if (schema.items === undefined) return { valid: true, value };
    const out: unknown[] = [];
    let ok = true;
    value.forEach((item, i) => {
      const c = coerce(schema.items as JSONSchema, item, `${path}[${i}]`, issues);
      if (c.valid) out.push(c.value);
      else ok = false;
    });
    return ok ? { valid: true, value: out } : INVALID;
  }

  if (typeOf(value) === 'object') {
    return coerceObject(schema, value as Record<string, unknown>, path, issues);
  }

  return { valid: true, value };
}

function coerceObject(
  schema: JSONSchema,
  value: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
): Coerced {
  const properties = schema.properties ?? {};
  const out: Record<string, unknown> = {};

  for (const key of schema.required ?? []) {
    if (value[key] === undefined) {
      issues.push({ path: path === '' ? key : `${path}.${key}`, message: 'is required' });
    }
  }

  for (const [key, sub] of Object.entries(properties)) {
    const c = coerce(sub, value[key], path === '' ? key : `${path}.${key}`, issues);
    if (c.valid && c.value !== undefined) out[key] = c.value;
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        issues.push({ path: path === '' ? key : `${path}.${key}`, message: 'unknown argument' });
      }
    }
  }

  return { valid: issues.length === 0, value: out };
}

/**
 * Validate tool arguments against a schema, applying declared defaults.
 * Never throws: the caller turns the issue list into an `MCPError`.
 */
export function validateArgs(schema: JSONSchema, args: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (args === undefined || args === null) {
    const c = coerceObject(schema, {}, '', issues);
    return c.valid ? { ok: true, value: c.value as ToolArgs } : { ok: false, issues };
  }

  if (typeOf(args) !== 'object') {
    return { ok: false, issues: [{ path: '', message: 'arguments must be an object' }] };
  }

  const c = coerceObject(schema, args as Record<string, unknown>, '', issues);
  return c.valid ? { ok: true, value: c.value as ToolArgs } : { ok: false, issues };
}

/* ------------------------------------------------------------------ *
 * Stored-context model
 * ------------------------------------------------------------------ */

export type NoteSource = 'agent' | 'user' | 'tool' | 'system';

export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'done' | 'abandoned';

export type SearchKind = 'task' | 'turn' | 'note' | 'fact' | 'artifact';

export interface StoredTurn {
  readonly turn: number;
  readonly role: Role;
  readonly text: string;
  readonly tokens: number;
}

export interface StoredTask {
  readonly id: TaskId;
  readonly title: string;
  readonly goal: string;
  readonly status: TaskStatus;
  readonly turns: readonly StoredTurn[];
  readonly tags: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface StoredNote {
  readonly id: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly source: NoteSource;
  readonly ts: number;
}

export interface StoredFact {
  readonly id: string;
  readonly key: string;
  readonly value: string;
  readonly tags: readonly string[];
  readonly source: NoteSource;
  readonly ts: number;
  /** Promoted facts are the durable tier; see `remember`. */
  readonly durable: boolean;
}

export interface StoredArtifact extends ArtifactRef {
  readonly text: string;
  readonly createdAt: number;
  readonly taskId?: TaskId;
}

export interface NoteInput {
  readonly text: string;
  readonly tags?: readonly string[];
  readonly source?: NoteSource;
}

export interface RememberInput {
  readonly key: string;
  readonly value: string;
  readonly tags?: readonly string[];
  readonly source?: NoteSource;
}

export interface SearchQuery {
  readonly q: string;
  readonly limit?: number;
  readonly kinds?: readonly SearchKind[];
  readonly taskId?: TaskId;
}

export interface SearchHit {
  readonly kind: SearchKind;
  readonly id: string;
  readonly uri: string;
  readonly score: number;
  readonly snippet: string;
  readonly tokens: number;
  readonly updatedAt: number;
  readonly taskId?: TaskId;
}

/**
 * Everything `status` reports. Numeric savings fields are the point of the
 * tool: gross reduction is easy and meaningless unless the report also carries
 * the net figure, because an intervention can look like a win on gross while
 * spending more than it saves (see core-types `breakevenOk`).
 */
export interface StatusReport {
  readonly runId: string;
  readonly turn: number;
  readonly turns: number;

  readonly tasks: number;
  readonly notes: number;
  readonly facts: number;
  readonly artifacts: number;

  /** Tokens a run with no compression would have sent. */
  readonly inputTokensGross: number;
  /** Tokens actually sent after the pipeline. */
  readonly inputTokensNet: number;
  readonly outputTokens: number;
  /** Baseline output, the denominator of the expansion factor. */
  readonly outputTokensBaseline: number;

  readonly tokensSavedGross: number;
  readonly tokensSavedNet: number;
  /** `r`: gross input reduction fraction, 0..1. */
  readonly savingsRatio: number;
  /** `eps`: output expansion factor, >= 0. */
  readonly expansionFactor: number;
  readonly breakevenOk: boolean;

  readonly tokenEstimate: number;
  readonly searches: number;
  readonly lookups: number;
  readonly lookupHits: number;
  readonly lookupMisses: number;
  /** Share of retrievals (get_task / get_artifact) that resolved. */
  readonly hitRate: number;
  readonly cachePrefixHits: number;
  readonly cachePrefixInvalidations: number;
  readonly cacheHitRate: number;

  readonly constraintsPinned: number;
  readonly constraintsMissing: number;
  /** False once raw turns have been evicted without a recoverable pointer. */
  readonly rawRecoverable: boolean;
}

/**
 * The capability surface the MCP server needs from whatever holds context.
 *
 * This is deliberately narrower than `ArtifactStore`: the MCP path is read-mostly
 * plus two writes (note, remember), and binding it to the full store API would
 * make the server untestable without a filesystem. The gateway wires the real
 * implementation in; tests and `createInMemoryContext` wire this one.
 */
export interface ContextMemory {
  search(query: SearchQuery): readonly SearchHit[];
  getTask(id: TaskId): StoredTask | undefined;
  /** Resolves an `artifact://` uri *or* a bare sha256 digest. */
  getArtifact(ref: string): StoredArtifact | undefined;
  addNote(input: NoteInput): StoredNote;
  rememberFact(input: RememberInput): StoredFact;
  status(): StatusReport;
}

/* ------------------------------------------------------------------ *
 * Artifact refs
 * ------------------------------------------------------------------ */

const ARTIFACT_REF = /^(?:artifact:\/\/(?:[a-z][a-z0-9_-]*\/)*)?([0-9a-f]{64})$/;

export interface ParsedArtifactRef {
  readonly digest: string;
  /** The uri we will hand back, normalised to the bucket form. */
  readonly uri: string;
}

export function parseArtifactRef(ref: string): ParsedArtifactRef | undefined {
  const m = ARTIFACT_REF.exec(ref.trim());
  const digest = m?.[1];
  if (digest === undefined) return undefined;
  return { digest, uri: `artifact://file/${digest}` };
}

/* ------------------------------------------------------------------ *
 * In-memory ContextMemory
 * ------------------------------------------------------------------ */

export interface TelemetrySeed {
  readonly turns?: number;
  readonly inputTokensGross?: number;
  readonly inputTokensNet?: number;
  readonly outputTokens?: number;
  readonly outputTokensBaseline?: number;
  readonly cachePrefixHits?: number;
  readonly cachePrefixInvalidations?: number;
  readonly lookups?: number;
  readonly lookupHits?: number;
}

/** Mutable accumulator. `Required<TelemetrySeed>` would keep the read-only
 *  modifiers and there is nothing read-only about a running counter. */
interface TelemetryCounters {
  turns: number;
  inputTokensGross: number;
  inputTokensNet: number;
  outputTokens: number;
  outputTokensBaseline: number;
  cachePrefixHits: number;
  cachePrefixInvalidations: number;
  lookups: number;
  lookupHits: number;
}

export interface MemorySeed {
  readonly state?: ContextState;
  readonly tasks?: readonly StoredTask[];
  readonly notes?: readonly StoredNote[];
  readonly facts?: readonly StoredFact[];
  readonly artifacts?: readonly StoredArtifact[];
  readonly telemetry?: TelemetrySeed;
}

const EMPTY_STATE: ContextState = {
  messages: [],
  pinned: [],
  tokenEstimate: 0,
  policyHash: '',
  runId: runId('none'),
  turn: 0,
  gists: [],
  artifacts: [],
};

const NOTE_SOURCES: readonly NoteSource[] = ['agent', 'user', 'tool', 'system'];
export const SEARCH_KINDS: readonly SearchKind[] = ['task', 'turn', 'note', 'fact', 'artifact'];
export const NOTE_SOURCE_VALUES: readonly NoteSource[] = NOTE_SOURCES;

const round6 = (n: number): number => Number(n.toFixed(6));
const approxTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

/**
 * Highest `<prefix><n>` in a seeded id set.
 *
 * Without this, a store seeded with `note-1` hands out `note-1` again on the
 * first write and silently overwrites a note. Generated ids have to start
 * past anything the caller seeded, or "durable" is a lie.
 */
function maxNumericSuffix(ids: Iterable<string>, prefix: string): number {
  let max = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const n = Number(id.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}

/** Lowercase, punctuation-stripped, whitespace-collapsed. */
export function tokenize(q: string): string[] {
  const cleaned = q.toLowerCase().replace(/[^a-z0-9_./-]+/g, ' ').trim();
  if (cleaned === '') return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of cleaned.split(/\s+/)) {
    if (t !== '' && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Term coverage plus a phrase bonus, in [0, 1.5]. Deterministic and cheap: an
 * embedding index is the right answer at 10k+ records, and the wrong answer
 * here, where a local lexical scan is auditable and has no network egress.
 */
export function scoreText(haystack: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const h = haystack.toLowerCase();
  let hits = 0;
  for (const t of terms) if (h.includes(t)) hits += 1;
  if (hits === 0) return 0;
  const coverage = hits / terms.length;
  const phrase = h.includes(terms.join(' ')) ? 0.5 : 0;
  return round6(coverage + phrase);
}

export function snippetFor(text: string, terms: readonly string[], radius = 48): string {
  const h = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = h.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

interface Candidate {
  readonly kind: SearchKind;
  readonly id: string;
  readonly uri: string;
  readonly text: string;
  readonly tokens: number;
  readonly updatedAt: number;
  readonly taskId?: TaskId;
}

export class InMemoryContextStore implements ContextMemory {
  private state: ContextState;
  private readonly tasks = new Map<string, StoredTask>();
  private readonly notes = new Map<string, StoredNote>();
  private readonly facts = new Map<string, StoredFact>();
  private readonly artifacts = new Map<string, StoredArtifact>();
  private readonly factsByKey = new Map<string, string>();
  private readonly counters = { note: 0, fact: 0, clock: 1_700_000_000_000 };
  private t: TelemetryCounters;
  private searches = 0;

  constructor(seed: MemorySeed = {}) {
    this.state = seed.state ?? EMPTY_STATE;
    this.t = {
      turns: seed.telemetry?.turns ?? 0,
      inputTokensGross: seed.telemetry?.inputTokensGross ?? 0,
      inputTokensNet: seed.telemetry?.inputTokensNet ?? 0,
      outputTokens: seed.telemetry?.outputTokens ?? 0,
      outputTokensBaseline: seed.telemetry?.outputTokensBaseline ?? 0,
      cachePrefixHits: seed.telemetry?.cachePrefixHits ?? 0,
      cachePrefixInvalidations: seed.telemetry?.cachePrefixInvalidations ?? 0,
      lookups: seed.telemetry?.lookups ?? 0,
      lookupHits: seed.telemetry?.lookupHits ?? 0,
    };
    for (const t of seed.tasks ?? []) this.tasks.set(t.id, t);
    for (const n of seed.notes ?? []) this.notes.set(n.id, n);
    for (const f of seed.facts ?? []) {
      this.facts.set(f.id, f);
      this.factsByKey.set(f.key, f.id);
    }
    for (const a of seed.artifacts ?? []) this.artifacts.set(a.sha256, a);
    this.counters.note = maxNumericSuffix(this.notes.keys(), 'note-');
    this.counters.fact = maxNumericSuffix(this.facts.keys(), 'fact-');
  }

  /** Monotonic fake clock: keeps note/fact ids and timestamps deterministic. */
  private tick(): number {
    this.counters.clock += 1;
    return this.counters.clock;
  }

  setState(state: ContextState): void {
    this.state = state;
  }

  getState(): ContextState {
    return this.state;
  }

  putTask(task: StoredTask): StoredTask {
    this.tasks.set(task.id, task);
    return task;
  }

  putArtifact(input: {
    readonly text: string;
    readonly kind?: ArtifactRef['kind'];
    readonly taskId?: TaskId;
    readonly sha256?: string;
  }): StoredArtifact {
    const digest = input.sha256 ?? sha256(input.text);
    const artifact: StoredArtifact = {
      uri: `artifact://file/${digest}`,
      sha256: digest,
      bytes: input.text.length,
      kind: input.kind ?? 'file_snapshot',
      text: input.text,
      createdAt: this.tick(),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    };
    this.artifacts.set(digest, artifact);
    return artifact;
  }

  putNote(note: StoredNote): StoredNote {
    this.notes.set(note.id, note);
    return note;
  }

  recordRequest(input: {
    readonly grossTokens: number;
    readonly netTokens: number;
    readonly outputTokens: number;
    readonly baselineOutputTokens?: number;
  }): void {
    this.t.turns += 1;
    this.t.inputTokensGross += input.grossTokens;
    this.t.inputTokensNet += input.netTokens;
    this.t.outputTokens += input.outputTokens;
    this.t.outputTokensBaseline += input.baselineOutputTokens ?? input.outputTokens;
  }

  recordCache(prefixHit: boolean): void {
    if (prefixHit) this.t.cachePrefixHits += 1;
    else this.t.cachePrefixInvalidations += 1;
  }

  recordLookup(hit: boolean): void {
    this.t.lookups += 1;
    if (hit) this.t.lookupHits += 1;
  }

  private candidates(query: SearchQuery): Candidate[] {
    const kinds = query.kinds ?? SEARCH_KINDS;
    const want = new Set<SearchKind>(kinds);
    const out: Candidate[] = [];

    for (const t of this.tasks.values()) {
      if (query.taskId !== undefined && t.id !== query.taskId) continue;
      if (want.has('task')) {
        out.push({
          kind: 'task',
          id: t.id,
          uri: `ctx://task/${t.id}`,
          text: `${t.title}\n${t.goal}\n${t.tags.join(' ')}`,
          tokens: approxTokens(t.goal),
          updatedAt: t.updatedAt,
          taskId: t.id,
        });
      }
      if (want.has('turn')) {
        for (const turn of t.turns) {
          out.push({
            kind: 'turn',
            id: `${t.id}#${turn.turn}`,
            uri: `ctx://task/${t.id}/turn/${turn.turn}`,
            text: turn.text,
            tokens: turn.tokens,
            updatedAt: t.updatedAt,
            taskId: t.id,
          });
        }
      }
    }

    if (want.has('note')) {
      for (const n of this.notes.values()) {
        if (query.taskId !== undefined) continue;
        out.push({
          kind: 'note',
          id: n.id,
          uri: `ctx://note/${n.id}`,
          text: `${n.text}\n${n.tags.join(' ')}`,
          tokens: approxTokens(n.text),
          updatedAt: n.ts,
        });
      }
    }

    if (want.has('fact')) {
      for (const f of this.facts.values()) {
        if (query.taskId !== undefined) continue;
        out.push({
          kind: 'fact',
          id: f.id,
          uri: `ctx://fact/${f.id}`,
          text: `${f.key} ${f.value}\n${f.tags.join(' ')}`,
          tokens: approxTokens(f.value),
          updatedAt: f.ts,
        });
      }
    }

    if (want.has('artifact')) {
      for (const a of this.artifacts.values()) {
        if (query.taskId !== undefined && a.taskId !== query.taskId) continue;
        out.push({
          kind: 'artifact',
          id: a.sha256,
          uri: a.uri,
          text: a.text,
          tokens: approxTokens(a.text),
          updatedAt: a.createdAt,
          ...(a.taskId !== undefined ? { taskId: a.taskId } : {}),
        });
      }
    }

    return out;
  }

  search(query: SearchQuery): readonly SearchHit[] {
    this.searches += 1;
    const terms = tokenize(query.q);
    if (terms.length === 0) return [];

    const scored: Array<{ hit: SearchHit; score: number }> = [];
    for (const c of this.candidates(query)) {
      const score = scoreText(c.text, terms);
      if (score === 0) continue;
      scored.push({
        score,
        hit: {
          kind: c.kind,
          id: c.id,
          uri: c.uri,
          score,
          snippet: snippetFor(c.text, terms),
          tokens: c.tokens,
          updatedAt: c.updatedAt,
          ...(c.taskId !== undefined ? { taskId: c.taskId } : {}),
        },
      });
    }

    // score desc, then recency, then id. The id tiebreak is what makes two
    // runs over the same seed produce byte-identical responses.
    scored.sort((a, b) =>
      b.score - a.score || b.hit.updatedAt - a.hit.updatedAt || (a.hit.id < b.hit.id ? -1 : a.hit.id > b.hit.id ? 1 : 0),
    );

    const limit = Math.max(1, query.limit ?? 10);
    return scored.slice(0, limit).map((s) => s.hit);
  }

  getTask(id: TaskId): StoredTask | undefined {
    const task = this.tasks.get(id);
    this.recordLookup(task !== undefined);
    return task;
  }

  getArtifact(ref: string): StoredArtifact | undefined {
    const parsed = parseArtifactRef(ref);
    if (parsed === undefined) {
      this.recordLookup(false);
      return undefined;
    }
    const found = this.artifacts.get(parsed.digest);
    this.recordLookup(found !== undefined);
    return found;
  }

  addNote(input: NoteInput): StoredNote {
    this.counters.note += 1;
    const note: StoredNote = {
      id: `note-${this.counters.note}`,
      text: input.text,
      tags: input.tags ?? [],
      source: input.source ?? 'agent',
      ts: this.tick(),
    };
    this.notes.set(note.id, note);
    return note;
  }

  /** Upsert by key: `remember` promotes something, it does not duplicate it. */
  rememberFact(input: RememberInput): StoredFact {
    const existingId = this.factsByKey.get(input.key);
    if (existingId !== undefined) {
      const prior = this.facts.get(existingId);
      if (prior !== undefined) {
        const updated: StoredFact = {
          ...prior,
          value: input.value,
          tags: input.tags ?? prior.tags,
          source: input.source ?? prior.source,
          ts: this.tick(),
          durable: true,
        };
        this.facts.set(existingId, updated);
        return updated;
      }
    }
    this.counters.fact += 1;
    const fact: StoredFact = {
      id: `fact-${this.counters.fact}`,
      key: input.key,
      value: input.value,
      tags: input.tags ?? [],
      source: input.source ?? 'agent',
      ts: this.tick(),
      durable: true,
    };
    this.facts.set(fact.id, fact);
    this.factsByKey.set(fact.key, fact.id);
    return fact;
  }

  status(): StatusReport {
    const gross = this.t.inputTokensGross;
    const net = this.t.inputTokensNet;
    const savedGross = gross - net;
    // Net accounts for the tokens we caused the model to emit. Reporting gross
    // alone is the failure mode docs/architecture.md §8 is about.
    const savedNet = savedGross - (this.t.outputTokens - this.t.outputTokensBaseline);
    const r = gross > 0 ? round6(Math.max(0, savedGross / gross)) : 0;
    const eps = this.t.outputTokensBaseline > 0
      ? round6(this.t.outputTokens / this.t.outputTokensBaseline)
      : 0;
    const lookups = this.t.lookups;
    const cacheTotal = this.t.cachePrefixHits + this.t.cachePrefixInvalidations;

    return {
      runId: this.state.runId,
      turn: this.state.turn,
      turns: this.t.turns,
      tasks: this.tasks.size,
      notes: this.notes.size,
      facts: this.facts.size,
      artifacts: this.artifacts.size,
      inputTokensGross: gross,
      inputTokensNet: net,
      outputTokens: this.t.outputTokens,
      outputTokensBaseline: this.t.outputTokensBaseline,
      tokensSavedGross: savedGross,
      tokensSavedNet: savedNet,
      savingsRatio: r,
      expansionFactor: eps,
      breakevenOk: breakevenOk(r, eps, 4, 0.5),
      tokenEstimate: this.state.tokenEstimate,
      searches: this.searches,
      lookups,
      lookupHits: this.t.lookupHits,
      lookupMisses: lookups - this.t.lookupHits,
      hitRate: lookups > 0 ? round6(this.t.lookupHits / lookups) : 0,
      cachePrefixHits: this.t.cachePrefixHits,
      cachePrefixInvalidations: this.t.cachePrefixInvalidations,
      cacheHitRate: cacheTotal > 0 ? round6(this.t.cachePrefixHits / cacheTotal) : 0,
      constraintsPinned: this.state.pinned.length,
      constraintsMissing: this.state.gists.filter((g) => g.constraints.length === 0).length,
      rawRecoverable: this.state.gists.every((g) => g.raw_recoverable),
    };
  }
}

export function createInMemoryContext(seed: MemorySeed = {}): InMemoryContextStore {
  return new InMemoryContextStore(seed);
}

/* ------------------------------------------------------------------ *
 * Tool argument accessors (post-validation readers)
 * ------------------------------------------------------------------ */

const str = (args: ToolArgs, key: string): string => {
  const v = args[key];
  return typeof v === 'string' ? v : '';
};

const optionalInt = (args: ToolArgs, key: string): number | undefined => {
  const v = args[key];
  return typeof v === 'number' ? v : undefined;
};

const strList = (args: ToolArgs, key: string): readonly string[] => {
  const v = args[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
};

const isSearchKind = (v: string): v is SearchKind =>
  (SEARCH_KINDS as readonly string[]).includes(v);

/* ------------------------------------------------------------------ *
 * Tool schemas
 * ------------------------------------------------------------------ */

const STR = { type: 'string' } as const;
const INT = { type: 'integer' } as const;
const STRINGS = { type: 'array', items: STR } as const;

const SEARCH_KINDS_SCHEMA: JSONSchema = {
  type: 'array',
  items: { type: 'string', enum: SEARCH_KINDS },
  description: 'Restrict to these record kinds. Defaults to all of them.',
};

const NOTE_SOURCE_SCHEMA: JSONSchema = {
  type: 'string',
  enum: NOTE_SOURCES,
  default: 'agent',
  description: 'Who authored the note.',
};

const ARTIFACT_URI_SCHEMA: JSONSchema = {
  type: 'string',
  minLength: 1,
  description: 'An artifact:// uri or a bare 64-char sha256 digest.',
};

export const TOOL_SCHEMAS = {
  ctx_search: {
    description:
      'JIT retrieval over the local context store: tasks, turns, notes, remembered facts and artifacts. ' +
      'Use this instead of re-reading a large file into context.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { ...STR, minLength: 1, description: 'Free-text query. Terms are ANDed.' },
        limit: { ...INT, minimum: 1, maximum: 100, default: 10 },
        kinds: SEARCH_KINDS_SCHEMA,
        task_id: { ...STR, minLength: 1, description: 'Scope to a single task.' },
      },
      required: ['q'],
      additionalProperties: false,
    },
  },
  get_task: {
    description:
      'Fetch a stored task, optionally a single turn range. This is the reversibility escape hatch: ' +
      'it returns the original turns that compaction dropped.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { ...STR, minLength: 1 },
        from_turn: { ...INT, minimum: 0 },
        to_turn: { ...INT, minimum: 0 },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  get_artifact: {
    description: 'Resolve an artifact:// pointer (or sha256 digest) to its stored content.',
    inputSchema: {
      type: 'object',
      properties: { ref: ARTIFACT_URI_SCHEMA },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  note: {
    description: 'Record a durable note in the local store. It survives compaction.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { ...STR, minLength: 1 },
        tags: STRINGS,
        source: NOTE_SOURCE_SCHEMA,
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  status: {
    description:
      'Report telemetry: gross and net token savings, hit rate, token counts, pin status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  remember: {
    description:
      'Promote a fact into durable memory. Calling it again with an existing key updates that fact in place.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { ...STR, minLength: 1 },
        value: { ...STR, minLength: 1 },
        tags: STRINGS,
        source: NOTE_SOURCE_SCHEMA,
      },
      required: ['key', 'value'],
      additionalProperties: false,
    },
  },
} as const satisfies Record<string, ToolSchema>;

/**
 * Canonical tool names, plus the `ctx_`-prefixed aliases named in
 * docs/integrations.md §5. Agents configured from the docs write
 * `ctx_get_task`; the tool list we publish uses the short names, so both
 * resolve and only one spelling is ever advertised.
 */
export const TOOL_ALIASES: Readonly<Record<string, string>> = {
  ctx_search: 'ctx_search',
  ctx_get_task: 'get_task',
  ctx_get_artifact: 'get_artifact',
  ctx_note: 'note',
  ctx_status: 'status',
  ctx_remember: 'remember',
};

export const TOOL_NAMES = [
  'ctx_search',
  'get_task',
  'get_artifact',
  'note',
  'status',
  'remember',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export function resolveToolName(name: string): string {
  return TOOL_ALIASES[name] ?? name;
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export class MCPServer {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly serverInfo: { readonly name: string; readonly version: string };

  constructor(info: { readonly name: string; readonly version: string } = {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  }) {
    this.serverInfo = info;
  }

  registerTool(name: string, schema: ToolSchema, handler: ToolHandler): void {
    if (!TOOL_NAME_RE.test(name)) {
      throw new MCPError(-32602, `invalid tool name: ${JSON.stringify(name)}`);
    }
    if (this.tools.has(name)) {
      throw new MCPError(-32602, `tool already registered: ${name}`);
    }
    if (schema.inputSchema.type !== 'object') {
      throw new MCPError(-32602, `tool ${name}: inputSchema.type must be "object"`);
    }
    this.tools.set(name, {
      definition: { name, description: schema.description, inputSchema: schema.inputSchema },
      handler,
    });
  }

  listTools(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  hasTool(name: string): boolean {
    return this.tools.has(resolveToolName(name));
  }

  /**
   * Validate then invoke. Throws `MCPError` for an unknown tool or bad
   * arguments; returns `{ isError: true }` when the tool itself fails, which is
   * the distinction the MCP spec draws between protocol and execution errors.
   */
  async callTool(name: string, args: ToolArgs = {}): Promise<ToolResult> {
    const canonical = resolveToolName(name);
    const tool = this.tools.get(canonical);
    if (tool === undefined) {
      throw new MCPError(-32602, `unknown tool: ${name}`, { tool: name });
    }

    const validated = validateArgs(tool.definition.inputSchema, args);
    if (!validated.ok) {
      throw new MCPError(-32602, `invalid arguments for ${canonical}`, {
        tool: canonical,
        issues: validated.issues,
      });
    }

    try {
      return await tool.handler(validated.value);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return toolError(`${canonical}: ${message}`);
    }
  }

  /**
   * Dispatch one decoded JSON-RPC message.
   *
   * Returns `null` for notifications (a message with no `id`), which the stdio
   * transport turns into "write nothing" rather than "reply with null id".
   */
  async handleRequest(input: unknown): Promise<JSONRPCResponse | null> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return this.error(null, -32600, 'request must be a JSON object');
    }
    const msg = input as Record<string, unknown>;
    const hasId = Object.hasOwn(msg, 'id') && msg['id'] !== undefined;
    const id = hasId ? normalizeId(msg['id']) : null;

    if (msg['jsonrpc'] !== JSONRPC_VERSION) {
      return hasId ? this.error(id, -32600, 'jsonrpc must be "2.0"') : null;
    }
    if (typeof msg['method'] !== 'string' || msg['method'] === '') {
      return hasId ? this.error(id, -32600, 'method must be a non-empty string') : null;
    }
    if (!hasId) {
      // A notification we understand. Unrecognised notifications are dropped
      // silently, per JSON-RPC: there is nobody to answer.
      this.handleNotification(msg['method']);
      return null;
    }

    const method = msg['method'];
    try {
      switch (method) {
        case 'initialize':
          return this.ok(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: this.serverInfo,
          });
        case 'ping':
          return this.ok(id, {});
        case 'tools/list':
          return this.ok(id, { tools: this.listTools() });
        case 'tools/call':
          return this.ok(id, await this.callToolFromParams(msg['params']));
        default:
          return this.error(id, -32601, `method not found: ${method}`);
      }
    } catch (err) {
      if (err instanceof MCPError) return this.error(id, err.code, err.message, err.data);
      const message = err instanceof Error ? err.message : String(err);
      return this.error(id, -32603, message);
    }
  }

  private handleNotification(method: string): void {
    if (method === 'notifications/initialized') {
      // Nothing to do: this server holds no per-client session state.
    }
  }

  private async callToolFromParams(params: unknown): Promise<Record<string, unknown>> {
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      throw new MCPError(-32602, 'tools/call requires params with a `name`');
    }
    const p = params as Record<string, unknown>;
    if (typeof p['name'] !== 'string' || p['name'] === '') {
      throw new MCPError(-32602, 'tools/call requires params.name');
    }
    const args = p['arguments'];
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      throw new MCPError(-32602, 'params.arguments must be an object');
    }
    const result = await this.callTool(p['name'], (args ?? {}) as ToolArgs);
    // `data` is an in-process convenience; the wire result carries content only.
    return result.isError === true ? { content: result.content, isError: true } : { content: result.content };
  }

  private ok(id: JSONRPCId, result: unknown): JSONRPCSuccessResponse {
    return { jsonrpc: JSONRPC_VERSION, id, result };
  }

  private error(
    id: JSONRPCId,
    code: JSONRPCErrorCode,
    message: string,
    data?: unknown,
  ): JSONRPCFailureResponse {
    return {
      jsonrpc: JSONRPC_VERSION,
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    };
  }
}

function normalizeId(value: unknown): JSONRPCId {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

/* ------------------------------------------------------------------ *
 * The six strata-ctx tools
 * ------------------------------------------------------------------ */

/** Build a server with all six strata-ctx tools bound to `memory`. */
export function createStrataMcpServer(
  memory: ContextMemory,
  info?: { readonly name: string; readonly version: string },
): MCPServer {
  const server = new MCPServer(info);

  server.registerTool('ctx_search', TOOL_SCHEMAS.ctx_search, (args) => {
    const limit = optionalInt(args, 'limit') ?? 10;
    const kinds = strList(args, 'kinds').filter(isSearchKind);
    const rawTask = str(args, 'task_id');
    const hits = memory.search({
      q: str(args, 'q'),
      limit,
      ...(kinds.length > 0 ? { kinds } : {}),
      ...(rawTask !== '' ? { taskId: brandTaskId(rawTask) } : {}),
    });
    return toolJson({
      query: str(args, 'q'),
      total: hits.length,
      truncated: hits.length >= limit,
      hits,
    });
  });

  server.registerTool('get_task', TOOL_SCHEMAS.get_task, (args) => {
    const id = brandTaskId(str(args, 'task_id'));
    const task = memory.getTask(id);
    if (task === undefined) return toolError(`task not found: ${id}`, { task_id: id });

    const from = optionalInt(args, 'from_turn');
    const to = optionalInt(args, 'to_turn');
    if (from !== undefined && to !== undefined && from > to) {
      return toolError(`from_turn ${from} is after to_turn ${to}`, { from_turn: from, to_turn: to });
    }
    const turns = task.turns.filter(
      (t) => (from === undefined || t.turn >= from) && (to === undefined || t.turn <= to),
    );
    return toolJson({
      task_id: task.id,
      title: task.title,
      goal: task.goal,
      status: task.status,
      tags: task.tags,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      turn_count: task.turns.length,
      returned_turn_count: turns.length,
      range: { from: turns[0]?.turn ?? 0, to: turns[turns.length - 1]?.turn ?? 0 },
      turns,
    });
  });

  server.registerTool('get_artifact', TOOL_SCHEMAS.get_artifact, (args) => {
    const ref = str(args, 'ref');
    const parsed = parseArtifactRef(ref);
    if (parsed === undefined) {
      return toolError(`not an artifact ref: ${ref}`, { ref });
    }
    const artifact = memory.getArtifact(ref);
    if (artifact === undefined) return toolError(`artifact not found: ${parsed.uri}`, { ref: parsed.uri });
    return toolJson({
      uri: artifact.uri,
      sha256: artifact.sha256,
      kind: artifact.kind,
      bytes: artifact.bytes,
      content: artifact.text,
    });
  });

  server.registerTool('note', TOOL_SCHEMAS.note, (args) => {
    const note = memory.addNote({
      text: str(args, 'text'),
      tags: strList(args, 'tags'),
      source: (str(args, 'source') || 'agent') as NoteSource,
    });
    return toolJson({ id: note.id, ts: note.ts, source: note.source, tags: note.tags, text: note.text });
  });

  server.registerTool('status', TOOL_SCHEMAS.status, () => toolJson(memory.status()));

  server.registerTool('remember', TOOL_SCHEMAS.remember, (args) => {
    const fact = memory.rememberFact({
      key: str(args, 'key'),
      value: str(args, 'value'),
      tags: strList(args, 'tags'),
      source: (str(args, 'source') || 'agent') as NoteSource,
    });
    return toolJson({
      id: fact.id,
      key: fact.key,
      value: fact.value,
      tags: fact.tags,
      source: fact.source,
      durable: fact.durable,
      ts: fact.ts,
    });
  });

  return server;
}

/* ------------------------------------------------------------------ *
 * stdio transport
 * ------------------------------------------------------------------ */

export interface StdioServer {
  /** Resolves once the readable has ended and every response is flushed. */
  readonly done: Promise<void>;
  /** Stop accepting trailing input. Idempotent. */
  close(): void;
}

function writeLine(writable: NodeJS.WritableStream, response: JSONRPCResponse): void {
  writable.write(`${JSON.stringify(response)}\n`);
}

async function dispatchLine(
  writable: NodeJS.WritableStream,
  server: MCPServer,
  line: string,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    writeLine(writable, {
      jsonrpc: JSONRPC_VERSION,
      id: null,
      error: { code: -32700, message: 'parse error' },
    });
    return;
  }

  const response = await server.handleRequest(parsed);
  if (response !== null) writeLine(writable, response);
}

/**
 * Newline-delimited JSON over a pair of streams, which is what an MCP host
 * spawns a stdio server with.
 *
 * Both streams are injected rather than opened here so the transport is
 * testable without a child process, and so a caller can wrap them (TLS, a
 * size-capped logger) without this function knowing.
 */
export function serveStdio(
  readable: AsyncIterable<unknown>,
  writable: NodeJS.WritableStream,
  server: MCPServer,
): StdioServer {
  let buffer = '';
  let closed = false;

  const done = (async (): Promise<void> => {
    for await (const chunk of readable) {
      buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line !== '' && !closed) await dispatchLine(writable, server, line);
        nl = buffer.indexOf('\n');
      }
    }
    const tail = buffer.trim();
    if (tail !== '' && !closed) await dispatchLine(writable, server, tail);
  })();

  return {
    done,
    close: () => {
      closed = true;
    },
  };
}
