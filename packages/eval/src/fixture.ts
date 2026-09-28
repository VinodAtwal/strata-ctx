import { readFileSync } from 'node:fs';

import {
  ARMS,
  CONSTRAINT_KINDS,
  SUITE_IDS,
  type Arm,
  type ConstraintKindName,
  type EvalCase,
  type EvalConstraint,
  type EvalFixture,
  type SuiteId,
} from './types.js';

/**
 * F1-1: the eval fixture format and its validator.
 *
 * A fixture is a versioned suite file: a list of cases, each naming the arms it
 * runs, the constraints it expects to survive, and whether it is a negative
 * control. It is operator-authored untrusted input, the same category as a
 * gateway config or a policy file, so it gets the same three properties
 * `packages/gateway/src/config.ts` gives a config document, and for the same
 * reasons:
 *
 * **Validation is total, not fail-fast.** `validateFixture` walks the whole
 * document and returns *every* problem at once. A suite author fixing a
 * fixture should spend one round trip, not one per typo. Worse, a fail-fast
 * loader on a 200-case suite can burn an afternoon: the first bad case hides the
 * other 199.
 *
 * **Unknown keys are errors.** A mis-spelled `negativeControl` on a case would
 * default to false and quietly remove the case from the negative-control set --
 * and a negative control that silently stops being a negative control is exactly
 * the failure this whole package exists to prevent. Strictly more annoying than
 * silently ignoring a key, which is the point.
 *
 * **Version is checked before anything else.** A v0 fixture parsed by a v1
 * harness is the worst outcome in a test harness: the suite is green and it
 * tested nothing.
 *
 * JSON only, for the same reason the gateway config is JSON-only: one syntax is
 * one thing to get right, and this file is a small machine-checked record.
 */

export const EVAL_FIXTURE_FORMAT_VERSION = 1;

export type FixtureIssueCode =
  | 'missing'
  | 'type'
  | 'enum'
  | 'format'
  | 'unknown_key'
  | 'not_object'
  | 'version'
  | 'duplicate'
  | 'rule'
  | 'json'
  | 'io';

export interface FixtureIssue {
  /** Dot path into the document, e.g. `cases[3].arms[1]`. Empty = the document. */
  readonly path: string;
  readonly code: FixtureIssueCode;
  readonly message: string;
}

export type FixtureParseResult =
  | { readonly ok: true; readonly fixture: EvalFixture }
  | { readonly ok: false; readonly issues: readonly FixtureIssue[] };

/** Every reason a fixture was refused, at once. */
export class FixtureError extends Error {
  readonly issues: readonly FixtureIssue[];
  /** File the document came from, when it came from one. */
  readonly source: string | undefined;

  constructor(issues: readonly FixtureIssue[], source?: string) {
    super(
      `${source ?? 'fixture'}: ${issues
        .map((i) => (i.path === '' ? i.message : `${i.path} ${i.message}`))
        .join('; ')}`,
    );
    this.name = 'FixtureError';
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
  switch (typeof v) {
    case 'string':
      return `the string "${v}"`;
    case 'number':
      return `the number ${v}`;
    case 'boolean':
      return `the boolean ${v}`;
    case 'undefined':
      return 'nothing';
    default:
      return typeof v;
  }
};

/** Levenshtein, capped: only a near miss is worth a "did you mean". */
const editDistance = (a: string, b: string): number => {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = Math.min(
        (row[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = row[j] ?? 0;
      row[j] = current;
    }
  }
  return row[b.length] ?? 0;
};

/** The key the author meant, or undefined. Backs the "did you mean" suffix. */
const closestKey = (key: string, known: readonly string[]): string | undefined => {
  const lower = key.toLowerCase();
  const caseOnly = known.find((k) => k.toLowerCase() === lower);
  if (caseOnly !== undefined) return caseOnly;
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of known) {
    const distance = editDistance(lower, candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
};

// ---------------------------------------------------------------- resolution

const FIXTURE_KEYS = ['evalSuiteFormatVersion', 'suite', 'name', 'description', 'cases'] as const;

const CASE_KEYS = ['id', 'title', 'arms', 'negativeControl', 'prompt', 'notes', 'constraints'] as const;

const CONSTRAINT_KEYS = ['id', 'text', 'kind', 'forbidden'] as const;

const rejectUnknownKeys = (
  obj: Record<string, unknown>,
  known: readonly string[],
  prefix: string,
  noun: string,
  add: (path: string, code: FixtureIssueCode, message: string) => void,
): void => {
  for (const key of Object.keys(obj).sort()) {
    if (known.includes(key)) continue;
    const hint = closestKey(key, known);
    const path = prefix === '' ? key : `${prefix}.${key}`;
    add(
      path,
      'unknown_key',
      `is not a ${noun} key${hint === undefined ? '' : ` (did you mean "${hint}"?)`}`,
    );
  }
};

/**
 * One pass: collect every issue *and* build the fixture, so a caller that has
 * already paid for validation does not repeat the narrowing. A field that
 * failed validation falls back to a placeholder -- it never escapes, because any
 * issue at all makes the parse fail.
 */
const resolve = (input: unknown): FixtureParseResult => {
  const issues: FixtureIssue[] = [];
  const add = (path: string, code: FixtureIssueCode, message: string): void => {
    issues.push({ path, code, message });
  };

  if (!isRecord(input)) {
    add('', 'not_object', `must be a JSON object, got ${typeName(input)}`);
    return { ok: false, issues: Object.freeze(issues) };
  }

  rejectUnknownKeys(input, FIXTURE_KEYS, '', 'fixture', add);

  // Version first and separately, so a stale fixture reports "your harness is
  // wrong" rather than a list of consequences.
  const version = input.evalSuiteFormatVersion;
  if (version === undefined) {
    add('evalSuiteFormatVersion', 'missing', 'is required');
  } else if (typeof version !== 'number') {
    add('evalSuiteFormatVersion', 'type', `must be a number, got ${typeName(version)}`);
  } else if (version !== EVAL_FIXTURE_FORMAT_VERSION) {
    add(
      'evalSuiteFormatVersion',
      'version',
      `${version} cannot be read by this harness (it reads version ${EVAL_FIXTURE_FORMAT_VERSION}); ` +
        'a mis-parsed fixture is the worst outcome in a harness -- the suite is green and it tested nothing',
    );
  }

  let suite: SuiteId = 'E1';
  const suiteRaw = input.suite;
  if (suiteRaw === undefined) {
    add('suite', 'missing', `is required (one of ${SUITE_IDS.join(', ')})`);
  } else if (typeof suiteRaw !== 'string') {
    add('suite', 'type', `must be a string, got ${typeName(suiteRaw)}`);
  } else if (!(SUITE_IDS as readonly string[]).includes(suiteRaw)) {
    add('suite', 'enum', `must be one of ${SUITE_IDS.join(', ')}, got "${suiteRaw}"`);
  } else {
    suite = suiteRaw as SuiteId;
  }

  const requiredText = (
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
      add(path, 'format', `must not be empty (a ${noun} cannot be graded against nothing)`);
      return undefined;
    }
    return value;
  };

  let name = '';
  const nameRaw = requiredText(input, 'name', 'name', 'suite name');
  if (nameRaw !== undefined) name = nameRaw;

  let description: string | undefined;
  const descriptionRaw = input.description;
  if (descriptionRaw !== undefined) {
    if (typeof descriptionRaw !== 'string') {
      add('description', 'type', `must be a string, got ${typeName(descriptionRaw)}`);
    } else {
      description = descriptionRaw;
    }
  }

  const resolveConstraint = (raw: unknown, path: string): EvalConstraint => {
    if (!isRecord(raw)) {
      add(path, 'not_object', `must be an object, got ${typeName(raw)}`);
      return { id: '', text: '', kind: 'soft_policy', forbidden: [] };
    }
    rejectUnknownKeys(raw, CONSTRAINT_KEYS, path, 'constraint', add);
    const id = requiredText(raw, 'id', `${path}.id`, 'constraint id') ?? '';
    const text = requiredText(raw, 'text', `${path}.text`, 'constraint') ?? '';

    let kind: ConstraintKindName = 'soft_policy';
    const kindRaw = raw.kind;
    if (kindRaw === undefined) {
      add(`${path}.kind`, 'missing', `is required (one of ${CONSTRAINT_KINDS.join(', ')})`);
    } else if (typeof kindRaw !== 'string') {
      add(`${path}.kind`, 'type', `must be a string, got ${typeName(kindRaw)}`);
    } else if (!(CONSTRAINT_KINDS as readonly string[]).includes(kindRaw)) {
      add(
        `${path}.kind`,
        'enum',
        `must be one of ${CONSTRAINT_KINDS.join(', ')}, got "${kindRaw}"`,
      );
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
          const markerPath = `${path}.forbidden[${i}]`;
          if (typeof marker !== 'string') {
            add(markerPath, 'type', `must be a string, got ${typeName(marker)}`);
          } else if (marker.trim() === '') {
            add(markerPath, 'format', 'must not be empty (an empty marker can never be detected)');
          } else {
            forbidden.push(marker);
          }
        });
      }
    }

    return { id, text, kind, forbidden };
  };

  const resolveCase = (raw: unknown, index: number): EvalCase => {
    const path = `cases[${index}]`;
    if (!isRecord(raw)) {
      add(path, 'not_object', `must be an object, got ${typeName(raw)}`);
      return {
        id: '',
        title: '',
        arms: [],
        negativeControl: false,
        prompt: '',
        constraints: [],
        notes: undefined,
      };
    }
    rejectUnknownKeys(raw, CASE_KEYS, path, 'case', add);

    const id = requiredText(raw, 'id', `${path}.id`, 'case id') ?? '';
    const title = requiredText(raw, 'title', `${path}.title`, 'case title') ?? '';
    const prompt = requiredText(raw, 'prompt', `${path}.prompt`, 'prompt') ?? '';

    let notes: string | undefined;
    const notesRaw = raw.notes;
    if (notesRaw !== undefined) {
      if (typeof notesRaw !== 'string') {
        add(`${path}.notes`, 'type', `must be a string, got ${typeName(notesRaw)}`);
      } else {
        notes = notesRaw;
      }
    }

    const arms: Arm[] = [];
    const armsRaw = raw.arms;
    if (armsRaw === undefined) {
      add(`${path}.arms`, 'missing', `is required (at least one of ${ARMS.join(', ')})`);
    } else if (!Array.isArray(armsRaw)) {
      add(`${path}.arms`, 'type', `must be an array, got ${typeName(armsRaw)}`);
    } else if (armsRaw.length === 0) {
      add(`${path}.arms`, 'format', 'must list at least one arm; a case with no arms measures nothing');
    } else {
      armsRaw.forEach((arm, i) => {
        const armPath = `${path}.arms[${i}]`;
        if (typeof arm !== 'string') {
          add(armPath, 'type', `must be a string, got ${typeName(arm)}`);
        } else if (!(ARMS as readonly string[]).includes(arm)) {
          add(armPath, 'enum', `must be one of ${ARMS.join(', ')}, got "${arm}"`);
        } else if (arms.includes(arm as Arm)) {
          add(armPath, 'duplicate', `lists "${arm}" twice; each arm runs once per case`);
        } else {
          arms.push(arm as Arm);
        }
      });
    }

    let negativeControl = false;
    const negativeRaw = raw.negativeControl;
    if (negativeRaw === undefined) {
      add(
        `${path}.negativeControl`,
        'missing',
        'is required: every case must say whether it is a negative control, because a case that ' +
          'silently defaults to "no" is a case that silently stops protecting the claim',
      );
    } else if (typeof negativeRaw !== 'boolean') {
      add(`${path}.negativeControl`, 'type', `must be a boolean, got ${typeName(negativeRaw)}`);
    } else {
      negativeControl = negativeRaw;
      if (negativeControl && arms.length < 2) {
        add(
          `${path}.arms`,
          'rule',
          `a negative control that runs ${arms.length} arm(s) cannot reproduce anything; it needs at ` +
            'least two arms to show the hazard is real in one configuration and removed in another',
        );
      }
    }

    const constraints: EvalConstraint[] = [];
    const constraintsRaw = raw.constraints;
    if (constraintsRaw === undefined) {
      add(
        `${path}.constraints`,
        'missing',
        'is required: a case with no expected constraint set cannot fail',
      );
    } else if (!Array.isArray(constraintsRaw)) {
      add(`${path}.constraints`, 'type', `must be an array, got ${typeName(constraintsRaw)}`);
    } else if (constraintsRaw.length === 0) {
      add(
        `${path}.constraints`,
        'format',
        'must list at least one expected constraint; a case that expects nothing passes in every arm ' +
          'and measures nothing',
      );
    } else {
      constraintsRaw.forEach((raw2, i) => {
        constraints.push(resolveConstraint(raw2, `${path}.constraints[${i}]`));
      });
      const seen = new Set<string>();
      for (const [i, constraint] of constraints.entries()) {
        if (constraint.id === '') continue;
        if (seen.has(constraint.id)) {
          add(
            `${path}.constraints[${i}].id`,
            'duplicate',
            `reuses id "${constraint.id}" in the same case; constraint ids are matched by name`,
          );
        }
        seen.add(constraint.id);
      }
    }

    return {
      id,
      title,
      arms,
      negativeControl,
      prompt,
      constraints,
      notes,
    };
  };

  const cases: EvalCase[] = [];
  const casesRaw = input.cases;
  if (casesRaw === undefined) {
    add('cases', 'missing', 'is required');
  } else if (!Array.isArray(casesRaw)) {
    add('cases', 'type', `must be an array, got ${typeName(casesRaw)}`);
  } else if (casesRaw.length === 0) {
    add('cases', 'format', 'must contain at least one case; an empty suite reports a green light');
  } else {
    casesRaw.forEach((raw, index) => {
      cases.push(resolveCase(raw, index));
    });
    const seen = new Map<string, number>();
    for (const [index, evalCase] of cases.entries()) {
      if (evalCase.id === '') continue;
      const first = seen.get(evalCase.id);
      if (first !== undefined) {
        add(
          `cases[${index}].id`,
          'duplicate',
          `reuses id "${evalCase.id}" (already used by cases[${first}]); case ids index the report`,
        );
      }
      seen.set(evalCase.id, index);
    }
  }

  if (issues.length > 0) return { ok: false, issues: Object.freeze(issues) };
  return {
    ok: true,
    fixture: deepFreeze<EvalFixture>({
      formatVersion: EVAL_FIXTURE_FORMAT_VERSION,
      suite,
      name,
      description,
      cases,
    }),
  };
};

// ------------------------------------------------------------------ the API

/** All problems in `input`, in a stable order. Empty means valid. */
export function validateFixture(input: unknown): readonly FixtureIssue[] {
  const result = resolve(input);
  return result.ok ? [] : result.issues;
}

/** Non-throwing validation, for callers that treat a bad fixture as a state. */
export function safeParseFixture(input: unknown): FixtureParseResult {
  return resolve(input);
}

/** Throws `FixtureError` with every issue; returns a frozen fixture otherwise. */
export function parseFixture(input: unknown, source?: string): EvalFixture {
  const result = resolve(input);
  if (!result.ok) throw new FixtureError(result.issues, source);
  return result.fixture;
}

const readDocument = (path: string): unknown => {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new FixtureError([{ path: '', code: 'io', message: `cannot be read: ${detail}` }], path);
  }
  if (text.trim() === '') {
    throw new FixtureError([{ path: '', code: 'json', message: 'is empty' }], path);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new FixtureError(
      [{ path: '', code: 'json', message: `is not valid JSON: ${detail}` }],
      path,
    );
  }
};

/** Read + validate. Throws `FixtureError` for an unreadable, unparseable, or invalid file. */
export function loadFixture(path: string): EvalFixture {
  try {
    return parseFixture(readDocument(path), path);
  } catch (err) {
    if (err instanceof FixtureError && err.source !== undefined) throw err;
    const issues =
      err instanceof FixtureError
        ? err.issues
        : [{ path: '', code: 'io' as const, message: `cannot be read: ${String(err)}` }];
    throw new FixtureError(issues, path);
  }
}

/** Canonical JSON, keys sorted at every level, so a fixture diffs cleanly. */
export function serializeFixture(fixture: EvalFixture): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (isRecord(value)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        const inner = value[key];
        if (inner === undefined) continue;
        out[key] = canonical(inner);
      }
      return out;
    }
    return value;
  };
  return `${JSON.stringify(canonical(fixture), null, 2)}\n`;
}
