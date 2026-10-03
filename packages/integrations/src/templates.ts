import { canonicalJson } from '@strata-ctx/core-types';
import type { GistStatus } from '@strata-ctx/core-types';

/**
 * E-4. Agent instruction templates: `CLAUDE.md`, the output protocol, and the
 * self-gist block.
 *
 * The response stream is pass-through (docs/architecture.md §9), so the only
 * lever that reaches the model's own output is a prompt. That makes this module
 * a *governance* surface, not a documentation convenience: text rendered here
 * is text an agent obeys. Two consequences shape the design.
 *
 * 1. Constraint text is copied, never restated. `renderSelfGistBlock` embeds
 *    the pin set verbatim so the step-4c byte-equality gate compares the block
 *    the model produced against the policy, not against our prose about it.
 * 2. Rendering is total. Every value interpolated here is either a constant or
 *    validated before use. A template that emits a broken fence because
 *    somebody's project name contained a backtick is a template that can
 *    silently disable the only integrity check in the system.
 *
 * Determinism is a contract, not a nicety: same options, byte-identical output.
 * Object key order is therefore never inherited from a caller's object literal;
 * payloads go through `canonicalJson`, which sorts keys recursively.
 */

export const TEMPLATE_VERSION = 1;
export const OUTPUT_PROTOCOL_VERSION = 1;

export const FENCE = '```';
export const ENVELOPE_LANGUAGE = 'strata-envelope';
export const SELF_GIST_LANGUAGE = 'ctx-gist';
export const GOVERNANCE_LANGUAGE = 'governance';

/**
 * The sentinel the stream scanner looks for before it starts buffering
 * (A-12/B-8). It is a sentinel and not merely the fence because a model that
 * emits a ```ctx-gist fence of its own accord, unprompted, is not the same
 * event as one it emitted in response to the directive; only the second is
 * evidence that the protocol is being followed.
 */
export const SELF_GIST_SENTINEL = '<<<STRATA-SELF-GIST>>>';

/** Never appears as a `compress` value in an emitted block. */
export const NEVER_COMPRESSED = 'never';
export type NeverCompressed = typeof NEVER_COMPRESSED;

export type TemplateErrorCode =
  | 'invalid_project_name'
  | 'invalid_protocol_version'
  | 'invalid_cli'
  | 'invalid_constraint'
  | 'invalid_draft_field'
  | 'delimiter_collision';

export class TemplateError extends Error {
  readonly code: TemplateErrorCode;
  readonly field: string;

  constructor(code: TemplateErrorCode, field: string, message: string) {
    super(`${code} at ${field}: ${message}`);
    this.name = 'TemplateError';
    this.code = code;
    this.field = field;
  }
}

export interface GistChangedDraft {
  readonly path: string;
  readonly what: string;
  readonly why: string;
}

export interface GistDecisionDraft {
  readonly id: string;
  readonly choice: string;
  readonly why: string;
  readonly alternatives_rejected: readonly string[];
}

export interface GistNextDraft {
  readonly question: string;
  readonly next_command: string;
  readonly blockers: readonly string[];
}

export type GistVerificationStatus = 'untested' | 'passing' | 'failing' | 'inconclusive';

export interface GistVerificationDraft {
  readonly tests_run: readonly string[];
  readonly status: GistVerificationStatus;
}

/**
 * What the agent is allowed to write. Deliberately *not* a `Gist` and not the
 * contract's `GistDraft`: it has no `constraints` written by the model, no
 * `compressed_by`, no `raw_recoverable` and no `source_turn_range`. Those are
 * gateway-owned. The `constraints` field here is an echo of the policy used as a
 * byte-equality verification target, which is what turns "the model dropped a
 * safety rule" into a detectable condition instead of an invisible one.
 *
 * Named for what it is rather than for the stage it feeds. This type, the
 * PreCompact handoff document in claude-code-observers.ts, and the compactor's
 * working set in pipeline/src/self-gist.ts all shipped under the name
 * `GistDraft` while sharing no fields at all, so a reader who imported one
 * could reasonably assume the other two meant the same thing.
 */
export interface SelfGistBlockDraft {
  readonly task_id: string;
  readonly status: GistStatus;
  readonly goal: string;
  readonly changed: readonly GistChangedDraft[];
  readonly decided: readonly GistDecisionDraft[];
  readonly unresolved: readonly string[];
  readonly current_values: Readonly<Record<string, string>>;
  readonly next: GistNextDraft;
  readonly verification: GistVerificationDraft;
  readonly constraints: readonly string[];
}

/** The exact object `renderSelfGistBlock` serialises. */
export interface SelfGistEnvelope {
  readonly v: number;
  readonly compress: NeverCompressed;
  readonly task_id: string;
  readonly status: GistStatus;
  readonly goal: string;
  readonly changed: readonly GistChangedDraft[];
  readonly decided: readonly GistDecisionDraft[];
  readonly unresolved: readonly string[];
  readonly current_values: Readonly<Record<string, string>>;
  readonly next: GistNextDraft;
  readonly verification: GistVerificationDraft;
  readonly constraints: readonly string[];
}

export type MachineFormat = 'toon' | 'csv' | 'json';

export interface EnvelopeField {
  readonly key: string;
  readonly type: string;
  readonly required: boolean;
  readonly note: string;
}

/**
 * Fixed order, always. The order is the schema: a reader that must know where
 * `self_gist` sits cannot infer it, and "the order the object literal happened
 * to be in" is not a specification.
 */
export const ENVELOPE_FIELDS: readonly EnvelopeField[] = Object.freeze([
  {
    key: 'v',
    type: '1',
    required: true,
    note: 'envelope schema version, literal 1',
  },
  {
    key: 'task_id',
    type: 'string',
    required: true,
    note: 'stable identifier for the current task',
  },
  {
    key: 'status',
    type: 'complete|partial|blocked|abandoned',
    required: true,
    note: 'same value as the self-gist status',
  },
  {
    key: 'format',
    type: 'toon|csv|json',
    required: true,
    note: 'serialization used by every entry in blocks',
  },
  {
    key: 'blocks',
    type: 'array<block>',
    required: true,
    note: 'machine-readable payload only: {id, kind, format, body, sha256}',
  },
  {
    key: 'artifacts',
    type: 'array<{uri,sha256,bytes}>',
    required: false,
    note: 'content-addressed pointers; never inline the bytes',
  },
  {
    key: 'self_gist',
    type: 'string',
    required: false,
    note: 'task_id of the ctx-gist block, when one was emitted',
  },
  {
    key: 'notes',
    type: 'array<string>',
    required: false,
    note: 'prose; excluded from compression',
  },
]);

export const SELF_GIST_DIRECTIVE =
  'At the end of every completed or explicitly halted sub-task, append exactly one ' +
  `${FENCE}${SELF_GIST_LANGUAGE} block, containing the sentinel line ` +
  `${SELF_GIST_SENTINEL} followed by a single line of compact JSON. Emit nothing ` +
  'after the closing fence. Never summarise, reorder, translate or drop an entry of ' +
  'the pinned constraint set: those entries are compared byte-for-byte against ' +
  'policy and a single altered character aborts the compaction.';

export const SELF_GIST_BODY_FIELDS: readonly EnvelopeField[] = Object.freeze([
  { key: 'v', type: '1', required: true, note: 'gist schema version, literal 1' },
  { key: 'compress', type: '"never"', required: true, note: 'this block is never a compression target' },
  { key: 'task_id', type: 'string', required: true, note: 'matches envelope.task_id' },
  { key: 'status', type: 'complete|partial|blocked|abandoned', required: true, note: 'what happened, honestly' },
  { key: 'goal', type: 'string', required: true, note: 'the task, restated so it survives compaction' },
  { key: 'changed', type: 'array<{path,what,why}>', required: true, note: 'one entry per file or command whose effect matters' },
  { key: 'decided', type: 'array<{id,choice,why,alternatives_rejected}>', required: true, note: 'decisions already taken, so they are not retaken' },
  { key: 'unresolved', type: 'array<string>', required: true, note: 'the scary thing; never drop an entry to look competent' },
  { key: 'current_values', type: 'object<string,string>', required: true, note: 'concrete state, to stop the state drifting under compaction' },
  { key: 'next', type: '{question,next_command,blockers}', required: true, note: 'forward-looking; the part generic summaries lose' },
  { key: 'verification', type: '{tests_run,status}', required: true, note: 'untested | passing | failing | inconclusive' },
  { key: 'constraints', type: 'array<string>', required: true, note: 'the pinned set, verbatim and in order' },
]);

export interface OutputProtocolOptions {
  readonly projectName?: string;
  readonly protocolVersion?: number;
  readonly machineFormat?: MachineFormat;
  readonly selfGist?: boolean;
  readonly inlineLimitLines?: number;
  readonly constraints?: readonly string[];
}

export interface ClaudeMdOptions extends OutputProtocolOptions {
  readonly agentLabel?: string;
  readonly cli?: string;
  readonly includeOutputProtocol?: boolean;
}

const DEFAULT_PROJECT_NAME = 'this project';
const DEFAULT_AGENT_LABEL = 'Claude Code';
const DEFAULT_CLI = 'strata';
const DEFAULT_MACHINE_FORMAT: MachineFormat = 'toon';
const DEFAULT_INLINE_LIMIT_LINES = 20;

const GIST_STATUSES: readonly GistStatus[] = Object.freeze([
  'complete',
  'partial',
  'blocked',
  'abandoned',
]);

const VERIFICATION_STATUSES: readonly GistVerificationStatus[] = Object.freeze([
  'untested',
  'passing',
  'failing',
  'inconclusive',
]);

const MACHINE_FORMATS: readonly MachineFormat[] = Object.freeze(['toon', 'csv', 'json']);
const CLI_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*(?: [A-Za-z0-9._/-]+)*$/;
const MAX_PROJECT_NAME = 128;
const MAX_CLI = 64;

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function mdCode(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) {
    if (run.length > longest) longest = run.length;
  }
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function mdCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function requireNonEmptyString(value: unknown, code: TemplateErrorCode, field: string): string {
  if (typeof value !== 'string') {
    throw new TemplateError(code, field, `expected a string, received ${typeof value}`);
  }
  if (value.trim() === '') {
    throw new TemplateError(code, field, 'must not be empty or whitespace-only');
  }
  return value;
}

function requireObject(value: unknown, code: TemplateErrorCode, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TemplateError(code, field, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, code: TemplateErrorCode, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TemplateError(code, field, 'expected an array');
  }
  return value;
}

function optionalString(
  value: unknown,
  fallback: string,
  code: TemplateErrorCode,
  field: string,
): string {
  if (value === undefined) return fallback;
  return requireNonEmptyString(value, code, field);
}

/**
 * A block is only parseable if its content cannot contain a delimiter. There is
 * no escape for a fence inside a fence, and a subtly corrupt block is worse
 * than no block: the scanner would treat the tail as ordinary prose and the
 * governance comparison would never run. Refuse, and say which field collided.
 */
function assertNoDelimiterCollision(text: string, field: string, code: TemplateErrorCode): void {
  if (text.includes(FENCE)) {
    throw new TemplateError(
      code,
      field,
      `must not contain the block delimiter ${JSON.stringify(FENCE)}: it cannot be escaped inside a fenced block`,
    );
  }
  if (text.includes(SELF_GIST_SENTINEL)) {
    throw new TemplateError(
      code,
      field,
      `must not contain the self-gist sentinel ${JSON.stringify(SELF_GIST_SENTINEL)}`,
    );
  }
}

interface ResolvedOutputProtocolOptions {
  readonly projectName: string;
  readonly protocolVersion: number;
  readonly machineFormat: MachineFormat;
  readonly selfGist: boolean;
  readonly inlineLimitLines: number;
  readonly constraints: readonly string[];
}

function resolveProtocolOptions(options: OutputProtocolOptions): ResolvedOutputProtocolOptions {
  const projectName = optionalString(
    options.projectName,
    DEFAULT_PROJECT_NAME,
    'invalid_project_name',
    'projectName',
  );
  if (hasControlChars(projectName) || projectName.length > MAX_PROJECT_NAME) {
    throw new TemplateError(
      'invalid_project_name',
      'projectName',
      `must be at most ${MAX_PROJECT_NAME} characters and contain no control characters or newlines`,
    );
  }

  const rawVersion = options.protocolVersion ?? OUTPUT_PROTOCOL_VERSION;
  if (typeof rawVersion !== 'number' || !Number.isSafeInteger(rawVersion) || rawVersion < 1) {
    throw new TemplateError(
      'invalid_protocol_version',
      'protocolVersion',
      `expected a positive integer, received ${JSON.stringify(rawVersion)}`,
    );
  }

  const machineFormat = options.machineFormat ?? DEFAULT_MACHINE_FORMAT;
  if (!MACHINE_FORMATS.includes(machineFormat)) {
    throw new TemplateError(
      'invalid_project_name',
      'machineFormat',
      `expected one of ${MACHINE_FORMATS.join('|')}, received ${JSON.stringify(machineFormat)}`,
    );
  }

  const inlineLimitLines = options.inlineLimitLines ?? DEFAULT_INLINE_LIMIT_LINES;
  if (typeof inlineLimitLines !== 'number' || !Number.isSafeInteger(inlineLimitLines) || inlineLimitLines < 1) {
    throw new TemplateError(
      'invalid_project_name',
      'inlineLimitLines',
      `expected a positive integer, received ${JSON.stringify(inlineLimitLines)}`,
    );
  }

  return {
    projectName,
    protocolVersion: rawVersion,
    machineFormat,
    selfGist: options.selfGist ?? true,
    inlineLimitLines,
    constraints: resolveConstraints(options.constraints),
  };
}

function resolveConstraints(constraints: readonly string[] | undefined): readonly string[] {
  if (constraints === undefined) return [];
  return Object.freeze(
    constraints.map((constraint, index) => {
      const field = `constraints[${index}]`;
      if (typeof constraint !== 'string') {
        throw new TemplateError(
          'invalid_constraint',
          field,
          `expected a string, received ${typeof constraint}`,
        );
      }
      if (constraint.trim() === '') {
        throw new TemplateError(
          'invalid_constraint',
          field,
          'must not be empty or whitespace-only: an unenforceable constraint is worse than none',
        );
      }
      assertNoDelimiterCollision(constraint, field, 'delimiter_collision');
      return constraint;
    }),
  );
}

function renderGovernanceBlock(constraints: readonly string[]): string[] {
  if (constraints.length === 0) {
    return [
      `${FENCE}${GOVERNANCE_LANGUAGE}`,
      '(no constraints pinned for this project yet)',
      FENCE,
    ];
  }
  return [FENCE + GOVERNANCE_LANGUAGE, ...constraints, FENCE];
}

function renderExampleSelfGistBlock(options: ResolvedOutputProtocolOptions): string[] {
  const example: SelfGistBlockDraft = {
    task_id: 'T1',
    status: 'partial',
    goal: `Ship the ${options.projectName} change without regressing the pinned constraint set.`,
    changed: [
      {
        path: 'src/parser.ts',
        what: 'Handle the empty-input case that threw.',
        why: 'Found by the test in tests/parser.test.ts.',
      },
    ],
    decided: [
      {
        id: 'D1',
        choice: 'Return an empty list rather than null.',
        why: 'Callers already treat null as an error.',
        alternatives_rejected: ['Throw, which turns a normal case into a failure path.'],
      },
    ],
    unresolved: ['The empty-input case is fixed; the whitespace-only case is still untested.'],
    current_values: { test_command: 'npm test', coverage: 'not measured' },
    next: {
      question: 'Does the whitespace-only case still throw?',
      next_command: 'npm test -- tests/parser.test.ts',
      blockers: [],
    },
    verification: { tests_run: ['npm test -- tests/parser.test.ts'], status: 'inconclusive' },
    constraints: options.constraints,
  };
  return renderSelfGistBlock(example).split('\n');
}

function renderBlockDelimiterTable(): string[] {
  return [
    '| Block | Open fence | Close fence | Content | Compression |',
    '| --- | --- | --- | --- | --- |',
    `| Envelope | ${mdCode(FENCE + ENVELOPE_LANGUAGE)} | ${mdCode(FENCE)} | one compact JSON line | allowed (machine-readable) |`,
    `| Self-gist | ${mdCode(FENCE + SELF_GIST_LANGUAGE)} | ${mdCode(FENCE)} | sentinel line, then one compact JSON line | ${NEVER_COMPRESSED} |`,
    `| Governance | ${mdCode(FENCE + GOVERNANCE_LANGUAGE)} | ${mdCode(FENCE)} | pinned constraint text, verbatim | ${NEVER_COMPRESSED} |`,
  ];
}

function renderEnvelopeSchema(): string[] {
  const lines = ['| Field | Type | Required | Notes |', '| --- | --- | --- | --- |'];
  for (const field of ENVELOPE_FIELDS) {
    lines.push(
      `| ${mdCode(field.key)} | ${mdCell(field.type)} | ${field.required ? 'yes' : 'no'} | ${mdCell(field.note)} |`,
    );
  }
  return lines;
}

function renderSelfGistSchema(): string[] {
  const lines = ['| Field | Type | Required | Notes |', '| --- | --- | --- | --- |'];
  for (const field of SELF_GIST_BODY_FIELDS) {
    lines.push(
      `| ${mdCode(field.key)} | ${mdCell(field.type)} | ${field.required ? 'yes' : 'no'} | ${mdCell(field.note)} |`,
    );
  }
  return lines;
}

export function renderOutputProtocol(options: OutputProtocolOptions = {}): string {
  const resolved = resolveProtocolOptions(options);
  const lines: string[] = [];

  lines.push(`# Output protocol v${resolved.protocolVersion} — ${resolved.projectName}`);
  lines.push('');
  lines.push(
    'This file is generated by `@strata-ctx/integrations` and is regenerated by ' +
      `\`${DEFAULT_CLI} init\`. Edit the policy, not this file.`,
  );
  lines.push('');
  lines.push(
    'Your response is passed through to the user unmodified, so the only compression ' +
      'lever available is what you choose to emit. The rules below are the contract.',
  );

  lines.push('');
  lines.push('## 1. Block delimiters');
  lines.push('');
  lines.push('Every machine-readable payload lives inside a fenced block. The fence is exact:');
  lines.push('');
  lines.push(...renderBlockDelimiterTable());
  lines.push('');
  lines.push(
    'Rules that are not negotiable:',
  );
  lines.push('');
  lines.push(
    `- A fence is opened and closed on their own lines. Never nest one fence inside ` +
      'another, and never emit a delimiter inside block content.',
  );
  lines.push(
    `- Block content is a single line of compact JSON. No pretty-printing: the parser ` +
      'reads until the closing fence, and a newline inside the body truncates it.',
  );
  lines.push(
    `- Governance content is the pinned constraint text, byte-for-byte, in pin-set ` +
      'order. It is never re-worded, translated, re-indented or abbreviated.',
  );
  lines.push(
    `- Prose, reasoning and code are never written into a machine-readable block and ` +
      'never passed through a compact tabular form.',
  );
  lines.push(
    `- Anything longer than ${resolved.inlineLimitLines} lines belongs in a file. ` +
      'Return the path and a one-line summary instead of pasting it.',
  );

  lines.push('');
  lines.push('## 2. Machine-readable envelope');
  lines.push('');
  lines.push(`Emit at most one ${mdCode(FENCE + ENVELOPE_LANGUAGE)} block per response:`);
  lines.push('');
  lines.push(...renderEnvelopeSchema());
  lines.push('');
  lines.push(
    `Use ${mdCode(resolved.machineFormat)} for ${mdCode('blocks')}. ` +
      'Tabular encodings are for uniform arrays of flat records; a single record with ' +
      'nested structure is clearer as JSON, and prose is never a candidate for either.',
  );

  lines.push('');
  lines.push(`## 3. Self-gist block (protocol v${resolved.protocolVersion})`);
  lines.push('');
  if (!resolved.selfGist) {
    lines.push('Self-gist is disabled for this project. Do not emit a `' + SELF_GIST_LANGUAGE + '` block.');
    lines.push('');
    return `${lines.join('\n')}\n`;
  }

  lines.push('**Directive.**');
  lines.push('');
  lines.push(SELF_GIST_DIRECTIVE);
  lines.push('');
  lines.push(
    `**Sentinel.** The first line inside the block is exactly ${mdCode(SELF_GIST_SENTINEL)}. ` +
      'The stream scanner buffers only the tail after the sentinel, so a block without ' +
      'it is not recognised and its content is treated as ordinary prose.',
  );
  lines.push('');
  lines.push(`**Body.** One line of compact JSON, with these fields in this order:`);
  lines.push('');
  lines.push(...renderSelfGistSchema());
  lines.push('');
  lines.push('**Example.**');
  lines.push('');
  lines.push(...renderExampleSelfGistBlock(resolved));
  lines.push('');
  lines.push('**Failure modes this block exists to prevent:**');
  lines.push('');
  lines.push(
    '- A constraint that is paraphrased, trimmed, re-cased or reordered. The pinned set ' +
      'is compared byte-for-byte; one altered character aborts the compaction and keeps ' +
      'the full transcript.',
  );
  lines.push(
    '- A dropped `unresolved` entry. Progressive amnesia is the quiet failure: every ' +
      'individual compaction looks reasonable while the agent is operating on a partly ' +
      'invented state.',
  );
  lines.push(
    '- A `current_values` field left empty. Concrete values are the anti-drift instrument.',
  );
  lines.push(
    `- A \`compress\` field other than ${mdCode(NEVER_COMPRESSED)}. The self-gist block is ` +
      'Tier 2: it is the one block that must reach the disk without being compressed, ' +
      'because it is the only record of the narrative a compactor cannot reconstruct.',
  );

  return `${lines.join('\n')}\n`;
}

function renderPinnedSetSection(constraints: readonly string[]): string[] {
  return [
    '### 1.3 The pinned constraint set',
    '',
    'Reproduced verbatim, in pin-set order, from the policy file. It is injected into ' +
      'every request on every turn:',
    '',
    ...renderGovernanceBlock(constraints),
  ];
}

function renderCliSection(cli: string): string[] {
  return [
    '## 4. CLI',
    '',
    'The gateway is local and the data never leaves the machine. These are the commands ' +
      'available:',
    '',
    `| Command | What it does |`,
    `| --- | --- |`,
    `| ${mdCode(`${cli} status`)} | Budget, compaction count, pin status, savings and violation counters. Run this first when something looks wrong. |`,
    `| ${mdCode(`${cli} init`)} | (Re)generate this file, the hook settings and the policy scaffold. |`,
    `| ${mdCode(`${cli} hooks install`)} | Install the ${mdCode('PreToolUse')} / ${mdCode('PostToolUse')} / ${mdCode('PreCompact')} hooks. |`,
    `| ${mdCode(`${cli} hooks uninstall`)} | Remove them. Context stops being compressed; governance stops being enforced. |`,
    `| ${mdCode(`${cli} verify-pins`)} | Recompute the pin-set digest and compare it against the last one sent. |`,
    `| ${mdCode(`${cli} purge`)} | Delete retained transcripts and artifacts under the retention policy. The purge log is kept. |`,
    '',
    'Retrieval goes through MCP rather than the shell, and is the preferred way to get ' +
      'something back:',
    '',
    `| Tool | What it does |`,
    `| --- | --- |`,
    `| ${mdCode('ctx_search')} | Just-in-time retrieval over the artifact store. Look before you re-read. |`,
    `| ${mdCode('ctx_get_task')} | Re-inject a full transcript range that was compacted away. This is why compaction is safe. |`,
    `| ${mdCode('ctx_get_artifact')} | Resolve an ${mdCode('artifact://')} pointer to its content. |`,
    `| ${mdCode('ctx_note')} | Write a note into the memory tiers. |`,
    `| ${mdCode('ctx_status')} | Current budget and pin status, from inside the session. |`,
    `| ${mdCode('ctx_remember')} | Promote something to a durable tier. |`,
  ];
}

export function renderClaudeMd(options: ClaudeMdOptions = {}): string {
  const resolved = resolveProtocolOptions(options);
  const agentLabel = optionalString(
    options.agentLabel,
    DEFAULT_AGENT_LABEL,
    'invalid_project_name',
    'agentLabel',
  );
  if (hasControlChars(agentLabel)) {
    throw new TemplateError(
      'invalid_project_name',
      'agentLabel',
      'must not contain control characters or newlines',
    );
  }
  const cli = optionalString(options.cli, DEFAULT_CLI, 'invalid_cli', 'cli');
  if (cli.length > MAX_CLI || !CLI_PATTERN.test(cli)) {
    throw new TemplateError(
      'invalid_cli',
      'cli',
      `expected a bare command name (letters, digits, ${mdCell('._-/')} and single spaces), received ${JSON.stringify(cli)}`,
    );
  }

  const lines: string[] = [];

  lines.push(`# ${resolved.projectName} — working under strata-ctx`);
  lines.push('');
  lines.push(
    `Instructions for ${agentLabel} in this repository. Generated by ` +
      `\`@strata-ctx/integrations\` v${TEMPLATE_VERSION} for output protocol ` +
      `v${resolved.protocolVersion}; ${mdCode(`${cli} init`)} regenerates it. Do not edit ` +
      'by hand: hand edits are lost on the next regeneration and, worse, they are not ' +
      'covered by the pin-set digest.',
  );
  lines.push('');
  lines.push(
    'Context is compressed automatically as the window fills. That is safe only because ' +
      'of the three rules below. They are not style guidance; they are the reason the ' +
      'rest of the system is allowed to throw anything away.',
  );

  lines.push('');
  lines.push('## 1. Governance');
  lines.push('');
  lines.push('### 1.1 Pinned constraints are immutable');
  lines.push('');
  lines.push(
    'The pinned set is the one place a human states intent, so it is the one place the ' +
      'system refuses to be flexible. It is replaced from an immutable buffer on every ' +
      'outbound request, never merged: a gist that *appended* to it could inject text ' +
      'that looks like policy, so appending is not supported at any layer.',
  );
  lines.push('');
  lines.push('Consequences you must internalise:');
  lines.push('');
  lines.push(
    '- You cannot relax, reinterpret or "temporarily ignore" a constraint to unblock ' +
      'yourself. If a constraint blocks the task, say so and stop; that is a `blocked` ' +
      'gist, not a licence.',
  );
  lines.push(
    '- You cannot add a constraint either. Policy is authored by a human, out of band.',
  );
  lines.push(
    '- If a pinned constraint is missing from your context, that is a `P0` event, not a ' +
      `hint. Report it with ${mdCode(`${cli} status`)} and do not continue on the assumption that the rules still hold.`,
  );
  lines.push(
    '- A constraint that is merely inconvenient is still a constraint. Soft policies ' +
      'decay fastest precisely because they feel optional, which is why they are pinned ' +
      'at all.',
  );

  lines.push('');
  lines.push('### 1.2 Governance blocks are byte-identical');
  lines.push('');
  lines.push(
    'Governance text is compared byte-for-byte, not by meaning. Before a compaction is ' +
      'committed, the constraints echoed in the gist are compared to the policy; a single ' +
      'altered byte — a re-worded clause, a changed case, a re-indented list, a ' +
      'reordered set — aborts the transaction and the raw transcript is kept. The check ' +
      'is deliberately unforgiving because a semantic comparison is a judgement call, and ' +
      'a judgement call in the safety gate is a gate that can be talked past.',
  );
  lines.push('');
  lines.push(
    'So: copy constraint text exactly. Do not translate it. Do not tidy it. Do not ' +
      'merge two constraints into one, or split one into two.',
  );
  lines.push('');
  lines.push(...renderPinnedSetSection(resolved.constraints));

  lines.push('');
  lines.push('### 1.4 Lossy compression never applies to prose or code');
  lines.push('');
  lines.push(
    'Compaction is typed, and the types are enforced at compile time: every lossy stage ' +
      'accepts non-governance blocks only, so an operator that would summarise a ' +
      'constraint is not representable rather than merely discouraged.',
  );
  lines.push('');
  lines.push(
    'On your side of the boundary the same rule holds in the other direction: reasoning ' +
      'prose, code and diffs are never eligible for a compact tabular encoding. Machine ' +
      'encodings apply to machine-readable blocks only — lists of files, tool results, ' +
      'tables of uniform records. A paragraph of reasoning pushed through a column ' +
      'format is not compressed, it is destroyed.',
  );
  lines.push('');
  lines.push(
    `- Structured output uses ${mdCode(resolved.machineFormat)}. Oversized content goes to ` +
      `a file and is referenced by path, never pasted past ${resolved.inlineLimitLines} lines.`,
  );
  lines.push('');
  lines.push(
    'Compaction is reversible: the raw transcript is written and fsynced before anything ' +
      'is evicted, and `ctx_get_task` re-injects it. A detail you think you have lost is ' +
      'one tool call away, which is the intended response to any pressure to compress ' +
      'harder.',
  );

  lines.push('');
  lines.push('## 2. Working agreement');
  lines.push('');
  lines.push(
    `- State the constraint set you are working under when it is not already in context; ` +
      `assume it is always in context, and never restate it in your own words.`,
  );
  lines.push(
    '- Prefer retrieving to re-reading. `ctx_search` and `ctx_get_artifact` cost a ' +
      'fraction of a re-read and preserve the cache prefix.',
  );
  lines.push(
    '- Surface a constraint conflict explicitly. Refusing a task is a correct outcome; ' +
      'working around a constraint silently is a defect.',
  );
  lines.push(
    '- The lossiest thing in the system is a plausible guess about state. Carry concrete ' +
      'values forward in the self-gist block.',
  );

  lines.push('');
  lines.push(`## 3. Output protocol v${resolved.protocolVersion}`);
  lines.push('');
  if (options.includeOutputProtocol === false) {
    lines.push(
      'The output protocol lives in a separate file for this project. Read it before ' +
        'your first response.',
    );
  } else {
    lines.push(
      'Reproduced in full below, because an output protocol that has to be fetched is ' +
        'an output protocol that will not be followed.',
    );
    lines.push('');
    lines.push(
      renderOutputProtocol(options)
        .trimEnd()
        .split('\n')
        .map((line) => (line === '' ? '' : `> ${line}`))
        .join('\n'),
    );
  }

  lines.push('');
  lines.push(...renderCliSection(cli));

  lines.push('');
  lines.push('## 5. When governance and the task conflict');
  lines.push('');
  lines.push(
    'Governance wins, and you say so. Emit a `' +
      SELF_GIST_LANGUAGE +
      '` block with `status` set to `blocked`, put the conflicting constraint in ' +
      '`unresolved`, and stop. A blocked task reported honestly is cheap; a blocked ' +
      'task worked around is a silent safety failure, and it is the only failure mode ' +
      'this system cannot detect for you.',
  );

  return `${lines.join('\n')}\n`;
}

/**
 * Tier 2 self-gist. Three properties are load-bearing and each is enforced here
 * rather than documented and hoped for:
 *
 * 1. The block is never compressed. It carries the narrative a compactor cannot
 *    reconstruct, and the scanner buffers the stream tail from the sentinel
 *    forward, so what arrives is exactly what is rendered here.
 * 2. `constraints` is copied verbatim and in order. A round trip through
 *    `canonicalJson` is lossless for strings; the byte-equality gate downstream
 *    is the check that proves it.
 * 3. The output is a pure function of the draft. `canonicalJson` sorts keys
 *    recursively, so two structurally equal drafts produce identical bytes and a
 *    diff in a transcript means the content changed.
 */
export function renderSelfGistBlock(draft: SelfGistBlockDraft): string {
  const envelope = normalizeDraft(draft);
  return [
    FENCE + SELF_GIST_LANGUAGE,
    SELF_GIST_SENTINEL,
    canonicalJson(envelope),
    FENCE,
  ].join('\n');
}

function normalizeDraft(draft: SelfGistBlockDraft): SelfGistEnvelope {
  if (typeof draft !== 'object' || draft === null) {
    throw new TemplateError('invalid_draft_field', 'draft', 'expected an object');
  }

  const taskId = requireNonEmptyString(draft.task_id, 'invalid_draft_field', 'draft.task_id');
  assertNoDelimiterCollision(taskId, 'draft.task_id', 'delimiter_collision');

  if (!GIST_STATUSES.includes(draft.status)) {
    throw new TemplateError(
      'invalid_draft_field',
      'draft.status',
      `expected one of ${GIST_STATUSES.join('|')}, received ${JSON.stringify(draft.status)}`,
    );
  }

  const goal = requireNonEmptyString(draft.goal, 'invalid_draft_field', 'draft.goal');
  assertNoDelimiterCollision(goal, 'draft.goal', 'delimiter_collision');

  const changed = requireArray(draft.changed, 'invalid_draft_field', 'draft.changed').map(
    (entry, index) => {
      const field = `draft.changed[${index}]`;
      const item = requireObject(entry, 'invalid_draft_field', field);
      const path = requireNonEmptyString(item['path'], 'invalid_draft_field', `${field}.path`);
      assertNoDelimiterCollision(path, `${field}.path`, 'delimiter_collision');
      const what = requireNonEmptyString(item['what'], 'invalid_draft_field', `${field}.what`);
      assertNoDelimiterCollision(what, `${field}.what`, 'delimiter_collision');
      const why = requireNonEmptyString(item['why'], 'invalid_draft_field', `${field}.why`);
      assertNoDelimiterCollision(why, `${field}.why`, 'delimiter_collision');
      return { path, what, why };
    },
  );

  const decided = requireArray(draft.decided, 'invalid_draft_field', 'draft.decided').map(
    (entry, index) => {
      const field = `draft.decided[${index}]`;
      const item = requireObject(entry, 'invalid_draft_field', field);
      const id = requireNonEmptyString(item['id'], 'invalid_draft_field', `${field}.id`);
      const choice = requireNonEmptyString(item['choice'], 'invalid_draft_field', `${field}.choice`);
      const why = requireNonEmptyString(item['why'], 'invalid_draft_field', `${field}.why`);
      const alternatives = requireArray(
        item['alternatives_rejected'],
        'invalid_draft_field',
        `${field}.alternatives_rejected`,
      ).map((value, alt) => {
        const altField = `${field}.alternatives_rejected[${alt}]`;
        const text = requireNonEmptyString(value, 'invalid_draft_field', altField);
        assertNoDelimiterCollision(text, altField, 'delimiter_collision');
        return text;
      });
      return { id, choice, why, alternatives_rejected: alternatives };
    },
  );

  const unresolved = stringList(draft.unresolved, 'draft.unresolved');

  const currentValuesSource = requireObject(
    draft.current_values,
    'invalid_draft_field',
    'draft.current_values',
  );
  const currentValues: Record<string, string> = {};
  for (const key of Object.keys(currentValuesSource).sort()) {
    const value = currentValuesSource[key];
    if (typeof value !== 'string') {
      throw new TemplateError(
        'invalid_draft_field',
        `draft.current_values.${key}`,
        `expected a string, received ${typeof value}`,
      );
    }
    currentValues[key] = value;
  }

  const nextSource = requireObject(draft.next, 'invalid_draft_field', 'draft.next');
  const question = requireNonEmptyString(
    nextSource['question'],
    'invalid_draft_field',
    'draft.next.question',
  );
  const nextCommand = requireNonEmptyString(
    nextSource['next_command'],
    'invalid_draft_field',
    'draft.next.next_command',
  );
  assertNoDelimiterCollision(question, 'draft.next.question', 'delimiter_collision');
  assertNoDelimiterCollision(nextCommand, 'draft.next.next_command', 'delimiter_collision');
  const next: GistNextDraft = {
    question,
    next_command: nextCommand,
    blockers: stringList(nextSource['blockers'], 'draft.next.blockers'),
  };

  const verificationSource = requireObject(
    draft.verification,
    'invalid_draft_field',
    'draft.verification',
  );
  const verificationStatus = verificationSource['status'];
  if (
    typeof verificationStatus !== 'string' ||
    !VERIFICATION_STATUSES.includes(verificationStatus as GistVerificationStatus)
  ) {
    throw new TemplateError(
      'invalid_draft_field',
      'draft.verification.status',
      `expected one of ${VERIFICATION_STATUSES.join('|')}, received ${JSON.stringify(verificationStatus)}`,
    );
  }
  const verification: GistVerificationDraft = {
    tests_run: stringList(verificationSource['tests_run'], 'draft.verification.tests_run'),
    status: verificationStatus as GistVerificationStatus,
  };

  return {
    v: OUTPUT_PROTOCOL_VERSION,
    compress: NEVER_COMPRESSED,
    task_id: taskId,
    status: draft.status,
    goal,
    changed,
    decided,
    unresolved,
    current_values: currentValues,
    next,
    verification,
    constraints: resolveConstraints(draft.constraints).slice(),
  };
}

function stringList(value: unknown, field: string): readonly string[] {
  return requireArray(value, 'invalid_draft_field', field).map((entry, index) => {
    const entryField = `${field}[${index}]`;
    const text = requireNonEmptyString(entry, 'invalid_draft_field', entryField);
    assertNoDelimiterCollision(text, entryField, 'delimiter_collision');
    return text;
  });
}
