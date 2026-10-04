import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

import type { ConstraintKindName, EvalConstraint } from './types.js';
import { CONSTRAINT_KINDS } from './types.js';

/**
 * F1-4: the task corpus, as references rather than as copied text.
 *
 * ## Why references
 *
 * The obvious way to build a corpus is to paste issue text into a fixture. That
 * was the plan until it was checked against reality, and reality was unhelpful
 * in two directions at once:
 *
 * - Every public repository reachable from here has zero issues, open or
 *   closed, so there was nothing realistic to copy from strangers anyway.
 * - The repositories that *do* have real issues are private. Copying their text
 *   into this repository, which is public, would publish private content. That
 *   is a worse problem than the licensing question it replaced.
 *
 * So a corpus entry stores *where the task is*, not the task text: an owner, a
 * repository and an issue number, or a row in this project's own board. The
 * body is fetched at run time through `gh`, which means the corpus stays small,
 * stays diffable, and never contains a line it does not own.
 *
 * The cost is honest and stated rather than hidden: a corpus entry is only
 * resolvable by someone with read access to that repository. {@link
 * resolveCorpus} therefore fails loudly and names the entry instead of
 * substituting an empty prompt, because a corpus that silently degrades to
 * "no task" would make every arm look compliant for the wrong reason.
 */

/** Where a task lives. Two kinds, because the board is a real task source. */
export type CorpusSource =
  | {
      readonly kind: 'github';
      /** `owner/name`. */
      readonly repo: string;
      readonly number: number;
    }
  | {
      readonly kind: 'board';
      /** A row id in docs/tasks.csv. */
      readonly id: string;
    };

/**
 * Whether the task extends existing work or starts something new.
 *
 * E4 grades the refinement category separately, because a refinement task is
 * the one where a rule is easiest to break: the surrounding code already looks
 * finished, so the tempting shortcut is to delete the awkward part rather than
 * adapt to it.
 */
export type CorpusCategory = 'greenfield' | 'refinement';

export interface CorpusEntry {
  readonly id: string;
  /** Author-written label. Never verbatim upstream text. */
  readonly label: string;
  readonly source: CorpusSource;
  readonly language: string;
  readonly category: CorpusCategory;
  /** The governance constraint this task is expected to test. */
  readonly constraint: EvalConstraint;
  /** Author-written note on what a violation would look like. */
  readonly notes?: string;
}

export interface Corpus {
  readonly formatVersion: number;
  readonly name: string;
  readonly description?: string;
  readonly entries: readonly CorpusEntry[];
}

export const CORPUS_FORMAT_VERSION = 1;

export type CorpusIssueCode =
  | 'missing'
  | 'type'
  | 'enum'
  | 'format'
  | 'unknown_key'
  | 'not_object'
  | 'version'
  | 'duplicate'
  | 'json'
  | 'io';

export interface CorpusIssue {
  /** Dot path into the document. Empty = the document. */
  readonly path: string;
  readonly code: CorpusIssueCode;
  readonly message: string;
}

/** Thrown when a corpus document cannot be trusted. Carries every problem. */
export class CorpusError extends Error {
  readonly issues: readonly CorpusIssue[];
  readonly source: string | undefined;

  constructor(issues: readonly CorpusIssue[], source?: string) {
    super(
      `${source ?? 'corpus'}: ${issues
        .map((i) => (i.path === '' ? i.message : `${i.path} ${i.message}`))
        .join('; ')}`,
    );
    this.name = 'CorpusError';
    this.issues = issues;
    this.source = source;
  }
}

// ------------------------------------------------------------------- helpers

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const typeName = (v: unknown): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'string') return `the string "${v}"`;
  if (typeof v === 'number') return `the number ${v}`;
  if (typeof v === 'boolean') return `the boolean ${v}`;
  if (typeof v === 'undefined') return 'nothing';
  return typeof v;
};

const CORPUS_KEYS = ['corpusFormatVersion', 'name', 'description', 'entries'] as const;
const ENTRY_KEYS = ['id', 'label', 'source', 'language', 'category', 'constraint', 'notes'] as const;
const GITHUB_SOURCE_KEYS = ['kind', 'repo', 'number'] as const;
const BOARD_SOURCE_KEYS = ['kind', 'id'] as const;
const CONSTRAINT_KEYS = ['id', 'text', 'kind', 'forbidden'] as const;

const rejectUnknownKeys = (
  obj: Record<string, unknown>,
  known: readonly string[],
  prefix: string,
  noun: string,
  add: (path: string, code: CorpusIssueCode, message: string) => void,
): void => {
  for (const key of Object.keys(obj).sort()) {
    if (known.includes(key)) continue;
    const path = prefix === '' ? key : `${prefix}.${key}`;
    add(path, 'unknown_key', `is not a ${noun} key`);
  }
};

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// ---------------------------------------------------------------- resolution

const resolve = (input: unknown): { ok: true; corpus: Corpus } | { ok: false; issues: readonly CorpusIssue[] } => {
  const issues: CorpusIssue[] = [];
  const add = (path: string, code: CorpusIssueCode, message: string): void => {
    issues.push({ path, code, message });
  };

  if (!isRecord(input)) {
    add('', 'not_object', `must be a JSON object, got ${typeName(input)}`);
    return { ok: false, issues };
  }
  rejectUnknownKeys(input, CORPUS_KEYS, '', 'corpus', add);

  const version = input.corpusFormatVersion;
  if (version === undefined) {
    add('corpusFormatVersion', 'missing', 'is required');
  } else if (typeof version !== 'number') {
    add('corpusFormatVersion', 'type', `must be a number, got ${typeName(version)}`);
  } else if (version !== CORPUS_FORMAT_VERSION) {
    add(
      'corpusFormatVersion',
      'version',
      `${version} cannot be read by this corpus loader (it reads ${CORPUS_FORMAT_VERSION})`,
    );
  }

  const requiredTextLocal = (
    obj: Record<string, unknown>,
    key: string,
    path: string,
    noun: string,
  ): string | undefined => {
    const value = obj[key];
    if (value === undefined) {
      add(path, 'missing', 'is required');
      return undefined;
    }
    if (typeof value !== 'string') {
      add(path, 'type', `must be a string, got ${typeName(value)}`);
      return undefined;
    }
    if (value.trim() === '') {
      add(path, 'format', `must not be empty (${noun})`);
      return undefined;
    }
    return value;
  };

  const name = requiredTextLocal(input, 'name', 'name', 'corpus name') ?? '';
  let description: string | undefined;
  if (input.description !== undefined) {
    if (typeof input.description !== 'string') {
      add('description', 'type', `must be a string, got ${typeName(input.description)}`);
    } else {
      description = input.description;
    }
  }



  const resolveSource = (raw: unknown, path: string): CorpusSource => {
    if (!isRecord(raw)) {
      add(path, 'not_object', `must be an object, got ${typeName(raw)}`);
      return { kind: 'board', id: '' };
    }
    const kind = raw.kind;
    if (kind === undefined) {
      add(`${path}.kind`, 'missing', 'is required ("github" or "board")');
      return { kind: 'board', id: '' };
    }
    if (kind === 'github') {
      rejectUnknownKeys(raw, GITHUB_SOURCE_KEYS, path, 'github source', add);
      const repo = requiredTextLocal(raw, 'repo', `${path}.repo`, 'a repository must be owner/name') ?? '';
      if (repo !== '' && !REPO_PATTERN.test(repo)) {
        add(`${path}.repo`, 'format', `must be "owner/name", got "${repo}"`);
      }
      const numberRaw = raw.number;
      let number = 0;
      if (numberRaw === undefined) {
        add(`${path}.number`, 'missing', 'is required');
      } else if (typeof numberRaw !== 'number' || !Number.isInteger(numberRaw) || numberRaw < 1) {
        add(`${path}.number`, 'type', `must be a positive integer, got ${typeName(numberRaw)}`);
      } else {
        number = numberRaw;
      }
      return { kind: 'github', repo, number };
    }
    if (kind === 'board') {
      rejectUnknownKeys(raw, BOARD_SOURCE_KEYS, path, 'board source', add);
      const id = requiredTextLocal(raw, 'id', `${path}.id`, 'a board id') ?? '';
      return { kind: 'board', id };
    }
    add(`${path}.kind`, 'enum', `must be "github" or "board", got ${typeName(kind)}`);
    return { kind: 'board', id: '' };
  };

  const resolveConstraint = (raw: unknown, path: string): EvalConstraint => {
    if (!isRecord(raw)) {
      add(path, 'not_object', `must be an object, got ${typeName(raw)}`);
      return { id: '', text: '', kind: 'soft_policy', forbidden: [] };
    }
    rejectUnknownKeys(raw, CONSTRAINT_KEYS, path, 'constraint', add);
    const id = requiredTextLocal(raw, 'id', `${path}.id`, 'constraint id') ?? '';
    const text = requiredTextLocal(raw, 'text', `${path}.text`, 'constraint text') ?? '';
    const kindRaw = raw.kind;
    let kind: ConstraintKindName = 'soft_policy';
    if (kindRaw === undefined) {
      add(`${path}.kind`, 'missing', `is required (one of ${CONSTRAINT_KINDS.join(', ')})`);
    } else if (typeof kindRaw !== 'string') {
      add(`${path}.kind`, 'type', `must be a string, got ${typeName(kindRaw)}`);
    } else if (!(CONSTRAINT_KINDS as readonly string[]).includes(kindRaw)) {
      add(`${path}.kind`, 'enum', `must be one of ${CONSTRAINT_KINDS.join(', ')}, got "${kindRaw}"`);
    } else {
      kind = kindRaw as ConstraintKindName;
    }
    const forbidden: string[] = [];
    const forbiddenRaw = raw.forbidden;
    if (forbiddenRaw !== undefined) {
      if (!Array.isArray(forbiddenRaw)) {
        add(`${path}.forbidden`, 'type', `must be an array of strings, got ${typeName(forbiddenRaw)}`);
      } else {
        forbiddenRaw.forEach((marker, i) => {
          if (typeof marker !== 'string') {
            add(`${path}.forbidden[${i}]`, 'type', `must be a string, got ${typeName(marker)}`);
          } else if (marker.trim() === '') {
            add(`${path}.forbidden[${i}]`, 'format', 'must not be empty (an empty marker cannot be detected)');
          } else {
            forbidden.push(marker);
          }
        });
      }
    }
    return { id, text, kind, forbidden };
  };

  const entries: CorpusEntry[] = [];
  const entriesRaw = input.entries;
  if (entriesRaw === undefined) {
    add('entries', 'missing', 'is required');
  } else if (!Array.isArray(entriesRaw)) {
    add('entries', 'type', `must be an array, got ${typeName(entriesRaw)}`);
  } else if (entriesRaw.length === 0) {
    add('entries', 'format', 'must contain at least one entry; an empty corpus measures nothing');
  } else {
    entriesRaw.forEach((raw, index) => {
      const path = `entries[${index}]`;
      if (!isRecord(raw)) {
        add(path, 'not_object', `must be an object, got ${typeName(raw)}`);
        return;
      }
      rejectUnknownKeys(raw, ENTRY_KEYS, path, 'entry', add);

      const id = requiredTextLocal(raw, 'id', `${path}.id`, 'entry id') ?? '';
      const label = requiredTextLocal(raw, 'label', `${path}.label`, 'entry label') ?? '';
      const language = requiredTextLocal(raw, 'language', `${path}.language`, 'entry language') ?? '';

      let category: CorpusCategory = 'greenfield';
      const categoryRaw = raw.category;
      if (categoryRaw === undefined) {
        add(`${path}.category`, 'missing', 'is required ("greenfield" or "refinement")');
      } else if (categoryRaw !== 'greenfield' && categoryRaw !== 'refinement') {
        add(
          `${path}.category`,
          'enum',
          `must be "greenfield" or "refinement", got ${typeName(categoryRaw)}`,
        );
      } else {
        category = categoryRaw;
      }

      let notes: string | undefined;
      if (raw.notes !== undefined) {
        if (typeof raw.notes !== 'string') {
          add(`${path}.notes`, 'type', `must be a string, got ${typeName(raw.notes)}`);
        } else {
          notes = raw.notes;
        }
      }

      if (raw.constraint === undefined) {
        add(`${path}.constraint`, 'missing', 'is required: an entry with no constraint tests nothing');
      }

      entries.push({
        id,
        label,
        source: resolveSource(raw.source, `${path}.source`),
        language,
        category,
        constraint: resolveConstraint(raw.constraint, `${path}.constraint`),
        ...(notes === undefined ? {} : { notes }),
      });
    });

    const seen = new Map<string, number>();
    for (const [index, entry] of entries.entries()) {
      if (entry.id === '') continue;
      const first = seen.get(entry.id);
      if (first !== undefined) {
        add(
          `entries[${index}].id`,
          'duplicate',
          `reuses id "${entry.id}" (already used by entries[${first}])`,
        );
      }
      seen.set(entry.id, index);
    }
  }

  if (issues.length > 0) return { ok: false, issues: Object.freeze(issues) };
  return {
    ok: true,
    corpus: Object.freeze({
      formatVersion: CORPUS_FORMAT_VERSION,
      name,
      ...(description === undefined ? {} : { description }),
      entries: Object.freeze(entries),
    }),
  };
};

/** Every problem in `input`, at once. Empty means valid. */
export function validateCorpus(input: unknown): readonly CorpusIssue[] {
  const result = resolve(input);
  return result.ok ? [] : result.issues;
}

/** Throws `CorpusError` with every issue; returns a frozen corpus otherwise. */
export function parseCorpus(input: unknown, source?: string): Corpus {
  const result = resolve(input);
  if (!result.ok) throw new CorpusError(result.issues, source);
  return result.corpus;
}

/** Read + validate a corpus document from disk. */
export function loadCorpus(path: string): Corpus {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CorpusError([{ path: '', code: 'io', message: `cannot be read: ${detail}` }], path);
  }
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CorpusError([{ path: '', code: 'json', message: `is not valid JSON: ${detail}` }], path);
  }
  return parseCorpus(document, path);
}

export function loadResolvedCorpus(path: string): ResolvedCorpus {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CorpusError([{ path: '', code: 'io', message: `cannot be read: ${detail}` }], path);
  }
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CorpusError([{ path: '', code: 'json', message: `is not valid JSON: ${detail}` }], path);
  }
  const issues = validateResolvedCorpus(document);
  if (issues.length > 0) {
    throw new CorpusError(issues, path);
  }
  return Object.freeze(document as ResolvedCorpus);
}

// ---------------------------------------------------------------- resolution

/** The task text for one entry, as fetched from its source. */
export interface ResolvedTask {
  readonly id: string;
  readonly label: string;
  readonly language: string;
  readonly category: CorpusCategory;
  readonly constraint: EvalConstraint;
  /** Human-readable task text, including its acceptance criteria. */
  readonly prompt: string;
  /** Where this came from, for the report. */
  readonly citation: string;
  readonly notes?: string;
}

export interface ResolvedCorpus {
  readonly formatVersion: number;
  readonly name: string;
  readonly description?: string;
  readonly generatedAt: string;
  readonly refreshedAt?: string;
  readonly refreshMethod?: string;
  readonly refreshNote?: string;
  readonly sourceCorpusPath?: string;
  readonly entries: readonly ResolvedTask[];
}

/** Fetches one entry's task text. Injected so tests never shell out. */
export type TaskResolver = (entry: CorpusEntry) => Promise<string>;

const execFileAsync = promisify(execFile);

/**
 * Resolve task text through the GitHub CLI.
 *
 * Uses `gh` rather than a token in the environment because the token is already
 * in the keyring with the scopes these repositories need, and putting a
 * credential in an env var to read an issue tracker is a worse habit than
 * reusing the one the user already authenticated.
 */
export const ghResolver: TaskResolver = async (entry) => {
  if (entry.source.kind === 'board') {
    const board = readBoardRow(entry.source.id);
    return board;
  }
  const { repo, number } = entry.source;
  const { stdout } = await execFileAsync('gh', [
    'issue',
    'view',
    String(number),
    '--repo',
    repo,
    '--json',
    'title,body',
  ], {
    timeout: 30_000,
  });
  const parsed = JSON.parse(stdout) as { title?: string; body?: string };
  const title = parsed.title ?? '';
  const body = (parsed.body ?? '').trim();
  if (title === '' && body === '') {
    throw new Error(`${repo}#${number} resolved to an empty issue`);
  }
  return `#${number} ${title}\n\n${body}`.trim();
};

/**
 * Resolve task text through the GitHub CLI with bounded retry.
 *
 * Refresh operations must be bounded in time and retry briefly on transient
 * failures without retrying forever.
 */
export const ghRefreshResolver: TaskResolver = async (entry): Promise<string> => {
  const maxAttempts = 2;
  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= maxAttempts) {
    try {
      if (entry.source.kind === 'board') {
        const board = readBoardRow(entry.source.id);
        return board;
      }
      const { repo, number } = entry.source;
      const { stdout } = await execFileAsync('gh', [
        'issue',
        'view',
        String(number),
        '--repo',
        repo,
        '--json',
        'title,body',
      ], {
        timeout: 30_000,
      });
      const parsed = JSON.parse(stdout) as { title?: string; body?: string };
      const title = parsed.title ?? '';
      const body = (parsed.body ?? '').trim();
      if (title === '' && body === '') {
        throw new Error(`${repo}#${number} resolved to an empty issue`);
      }
      return `#${number} ${title}\n\n${body}`.trim();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
        attempt += 1;
        continue;
      }
      break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
};

/** Where the board lives, relative to the repo root. */
const BOARD_PATH = 'docs/tasks.csv';

const readBoardRow = (id: string): string => {
  const text = readFileSync(BOARD_PATH, 'utf8');
  const lines = text.split('\n');
  const header = lines[0] ?? '';
  const titleIdx = header.split(',').indexOf('title');
  const idIdx = header.split(',').indexOf('id');
  if (titleIdx === -1 || idIdx === -1) {
    throw new Error(`${BOARD_PATH} has no id/title columns`);
  }
  for (const line of lines.slice(1)) {
    if (line.trim() === '') continue;
    // Board rows are simple comma-separated fields with no embedded commas in
    // the columns read here, so a plain split is sufficient and a CSV parser
    // would be a dependency with no payoff.
    const cells = line.split(',');
    if (cells[idIdx]?.trim() === id) {
      const title = (cells[titleIdx] ?? '').replace(/^"|"$/g, '');
      return `${id}: ${title}`.trim();
    }
  }
  throw new Error(`${BOARD_PATH} has no row ${id}`);
};

export class CorpusResolutionError extends Error {
  readonly failures: readonly { readonly id: string; readonly reason: string }[];

  constructor(failures: readonly { readonly id: string; readonly reason: string }[]) {
    super(
      `corpus resolution failed for ${failures.length} entr${failures.length === 1 ? 'y' : 'ies'}: ` +
        failures.map((f) => `${f.id} (${f.reason})`).join('; '),
    );
    this.name = 'CorpusResolutionError';
    this.failures = failures;
  }
}

/**
 * Resolve every entry, or fail naming all of them.
 *
 * Partial resolution is treated as failure on purpose. An entry that quietly
 * resolves to an empty prompt would run every arm against no task at all, and
 * "no violation" would then look like a pass -- the corpus would manufacture
 * green results out of missing data.
 */
export const resolveCorpus = async (
  corpus: Corpus,
  resolver: TaskResolver = ghResolver,
): Promise<readonly ResolvedTask[]> => {
  const settled = await Promise.all(
    corpus.entries.map(async (entry) => {
      try {
        const prompt = await resolver(entry);
        if (prompt.trim() === '') {
          return { ok: false as const, id: entry.id, reason: 'resolved to empty task text' };
        }
        return { ok: true as const, entry, prompt };
      } catch (err) {
        return {
          ok: false as const,
          id: entry.id,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  const failures = settled
    .filter((r): r is { ok: false; id: string; reason: string } => !r.ok)
    .map((r) => ({ id: r.id, reason: r.reason }));
  if (failures.length > 0) throw new CorpusResolutionError(failures);

  return settled
    .filter((r): r is { ok: true; entry: CorpusEntry; prompt: string } => r.ok)
    .map((r) => ({
      id: r.entry.id,
      label: r.entry.label,
      language: r.entry.language,
      category: r.entry.category,
      constraint: r.entry.constraint,
      prompt: r.prompt,
      citation:
        r.entry.source.kind === 'github'
          ? `${r.entry.source.repo}#${r.entry.source.number}`
          : `${BOARD_PATH}#${r.entry.source.id}`,
      ...(r.entry.notes === undefined ? {} : { notes: r.entry.notes }),
    }));
};

export interface ResolveCorpusOptions {
  readonly allowNetwork?: boolean;
  readonly resolvedPath?: string;
}

export const resolveCorpusHermetic = async (
  corpus: Corpus,
  options: ResolveCorpusOptions = {},
): Promise<readonly ResolvedTask[]> => {
  if (options.allowNetwork !== true) {
    try {
      const resolved = loadResolvedCorpus(options.resolvedPath ?? 'packages/eval/corpus/aegis-backlog.resolved.json');
      const tasks = resolveCorpusFromResolved(resolved);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const ordered: ResolvedTask[] = [];
      let missing = 0;
      for (const entry of corpus.entries) {
        const t = byId.get(entry.id);
        if (t === undefined) {
          missing += 1;
          break;
        }
        ordered.push(t);
      }
      if (missing === 0 && ordered.length === corpus.entries.length) {
        return ordered;
      }
    } catch {
      // fall through
    }
    throw new Error('hermetic resolution requires committed resolved corpus fixture');
  }
  return resolveCorpus(corpus, ghRefreshResolver);
};

export const resolveCorpusFromResolved = (resolved: ResolvedCorpus): readonly ResolvedTask[] => {
  const entries = resolved.entries;
  if (entries.length === 0) {
    throw new CorpusError([{ path: 'entries', code: 'format', message: 'must contain at least one entry' }]);
  }
  // Validate completeness: all entries must have non-empty prompt
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (e === undefined) {
      throw new CorpusError([{ path: `entries[${i}]`, code: 'missing', message: 'is missing' }]);
    }
    if (e.prompt.trim() === '') {
      throw new CorpusError([{ path: `entries[${i}].prompt`, code: 'format', message: 'must not be empty' }]);
    }
  }
  return entries;
};

export const validateResolvedCorpus = (input: unknown): readonly CorpusIssue[] => {
  const issues: CorpusIssue[] = [];
  const add = (path: string, code: CorpusIssueCode, message: string): void => {
    issues.push({ path, code, message });
  };
  const requiredTextLocal = (
    obj: Record<string, unknown>,
    key: string,
    path: string,
    noun: string,
  ): string | undefined => {
    const value = obj[key];
    if (value === undefined) {
      add(path, 'missing', 'is required');
      return undefined;
    }
    if (typeof value !== 'string') {
      add(path, 'type', `must be a string, got ${typeName(value)}`);
      return undefined;
    }
    if (value.trim() === '') {
      add(path, 'format', `must not be empty (${noun})`);
      return undefined;
    }
    return value;
  };

  if (!isRecord(input)) {
    add('', 'not_object', `must be a JSON object, got ${typeName(input)}`);
    return issues;
  }
  rejectUnknownKeys(
    input,
    ['formatVersion', 'name', 'description', 'generatedAt', 'refreshedAt', 'refreshMethod', 'refreshNote', 'sourceCorpusPath', 'entries'] as const,
    '',
    'resolved corpus',
    add,
  );

  const version = input.formatVersion;
  if (version === undefined) {
    add('formatVersion', 'missing', 'is required');
  } else if (typeof version !== 'number') {
    add('formatVersion', 'type', `must be a number, got ${typeName(version)}`);
  } else if (version !== CORPUS_FORMAT_VERSION) {
    add(
      'formatVersion',
      'version',
      `${version} cannot be read by this corpus loader (it reads ${CORPUS_FORMAT_VERSION})`,
    );
  }

  requiredTextLocal(input, 'name', 'name', 'corpus name');

  if (input.description !== undefined && typeof input.description !== 'string') {
    add('description', 'type', `must be a string, got ${typeName(input.description)}`);
  }
  if (input.generatedAt !== undefined && typeof input.generatedAt !== 'string') {
    add('generatedAt', 'type', `must be a string, got ${typeName(input.generatedAt)}`);
  }
  if (input.refreshedAt !== undefined && typeof input.refreshedAt !== 'string') {
    add('refreshedAt', 'type', `must be a string, got ${typeName(input.refreshedAt)}`);
  }
  if (input.refreshMethod !== undefined && typeof input.refreshMethod !== 'string') {
    add('refreshMethod', 'type', `must be a string, got ${typeName(input.refreshMethod)}`);
  }
  if (input.refreshNote !== undefined && typeof input.refreshNote !== 'string') {
    add('refreshNote', 'type', `must be a string, got ${typeName(input.refreshNote)}`);
  }
  if (input.sourceCorpusPath !== undefined && typeof input.sourceCorpusPath !== 'string') {
    add('sourceCorpusPath', 'type', `must be a string, got ${typeName(input.sourceCorpusPath)}`);
  }

  const entriesRaw = input.entries;
  if (entriesRaw === undefined) {
    add('entries', 'missing', 'is required');
  } else if (!Array.isArray(entriesRaw)) {
    add('entries', 'type', `must be an array, got ${typeName(entriesRaw)}`);
  } else if (entriesRaw.length === 0) {
    add('entries', 'format', 'must contain at least one entry');
  } else {
    entriesRaw.forEach((raw, index) => {
      const path = `entries[${index}]`;
      if (!isRecord(raw)) {
        add(path, 'not_object', `must be an object, got ${typeName(raw)}`);
        return;
      }
      rejectUnknownKeys(
        raw,
        ['id', 'label', 'language', 'category', 'constraint', 'prompt', 'citation', 'notes'],
        path,
        'resolved task',
        add,
      );
      requiredTextLocal(raw, 'id', `${path}.id`, 'entry id');
      requiredTextLocal(raw, 'label', `${path}.label`, 'entry label');
      requiredTextLocal(raw, 'language', `${path}.language`, 'entry language');
      requiredTextLocal(raw, 'prompt', `${path}.prompt`, 'entry prompt');
      requiredTextLocal(raw, 'citation', `${path}.citation`, 'entry citation');
      const categoryRaw = raw.category;
      if (categoryRaw === undefined) {
        add(`${path}.category`, 'missing', 'is required ("greenfield" or "refinement")');
      } else if (categoryRaw !== 'greenfield' && categoryRaw !== 'refinement') {
        add(
          `${path}.category`,
          'enum',
          `must be "greenfield" or "refinement", got ${typeName(categoryRaw)}`,
        );
      }
      if (raw.notes !== undefined && typeof raw.notes !== 'string') {
        add(`${path}.notes`, 'type', `must be a string, got ${typeName(raw.notes)}`);
      }
      if (raw.constraint === undefined) {
        add(`${path}.constraint`, 'missing', 'is required');
      }
    });
  }

  return issues;
};