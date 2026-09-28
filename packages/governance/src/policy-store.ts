import type { ContextState, PinnedConstraint, StrataPolicy } from '@strata-ctx/core-types';
import { StrataPolicySchema, hashCanonical, pinSetText, sha256 } from '@strata-ctx/core-types';
import { parseYaml, YamlError } from './yaml.js';

/**
 * D-3: the policy store.
 *
 * F19: "policy-as-code store with versioning + per-project policy files". Two
 * distinct problems hide in that sentence and they pull in opposite directions.
 *
 * **Integrity of one file.** A policy file is untrusted input off disk, so it
 * goes through the frozen `StrataPolicySchema` (which is `.strict()` on
 * purpose) and then through two checks that schema cannot express: every
 * constraint's declared `sha256` has to match its text, and constraint ids have
 * to be unique. A digest that does not match its text is how a policy file ends
 * up "verified" against something it does not say.
 *
 * **Authority between two files.** A per-project policy file lives *in the
 * repository*, and the repository is the least trusted input in the system: you
 * clone it, so its author is a stranger who now gets to write a file that names
 * itself policy. Its constraint list is **unioned** onto the base, never
 * substituted for it: the base keeps its order and its contents, and the
 * project's own constraints are appended. It may add anything. It may not
 * modify an inherited constraint id, may not switch `governance.pinning` off,
 * and may not turn redaction off or into a pass-through. Those are refused,
 * with the path and the reason, rather than merged: a partial merge that
 * silently keeps the safe value leaves the operator believing their override
 * did something it did not.
 *
 * ## Versioning
 *
 * `revision` is a monotonic counter within a store lineage (base = 1, each
 * derived store +1). It is what hot reload (A-16) compares to decide whether
 * anything changed and what to re-assert. It is deliberately *not* the durable
 * identity: across a restart the counter resets, so `documentHash` and
 * `pinHash` are what anything outside this process should compare.
 */

/** A file (or an already-parsed document) that declares policy. */
export interface PolicySource {
  readonly label: string;
  readonly text?: string | undefined;
  readonly document?: unknown;
}

export type PolicyDiff = {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  /** Dot paths outside `constraints`, e.g. `governance.pinning`. */
  readonly settingsChanged: readonly string[];
  readonly pinHashBefore: string;
  readonly pinHashAfter: string;
};

export type MergeRejection = {
  /** Where in the document the attempt was, e.g. `governance.pinning`. */
  readonly path: string;
  readonly reason: string;
};

export interface MergeResult {
  readonly policy: StrataPolicy;
  readonly rejections: readonly MergeRejection[];
  readonly diff: PolicyDiff;
}

export class PolicyError extends Error {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(issues.length === 0 ? message : `${message}: ${issues.join('; ')}`);
    this.name = 'PolicyError';
    this.issues = issues;
  }
}

export class PolicyMergeError extends Error {
  readonly rejections: readonly MergeRejection[];

  constructor(label: string, rejections: readonly MergeRejection[]) {
    super(
      `${label} tried to weaken governance and was refused: ${rejections
        .map((r) => `${r.path} (${r.reason})`)
        .join('; ')}`,
    );
    this.name = 'PolicyMergeError';
    this.rejections = rejections;
  }
}

const AUTO_ID_PREFIX = 'auto.';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A constraint may be written as a bare string:
 *
 * ```yaml
 * constraints:
 *   - never force push to main
 * ```
 *
 * The digest and the id are then derived here, never trusted from the file. The
 * id is content-addressed (`auto.<12 hex>`) so it is stable across restarts and
 * independent of file order, which matters because a reordering by a formatter
 * must not read as a policy change. The default kind is `soft_policy`, not
 * `hard_safety`: an unlabelled constraint is the kind that decays, and labelling
 * it as the kind that alignment training already holds in place would be a
 * flattering default.
 */
export type ConstraintInput = string | Partial<PinnedConstraint>;

function expandConstraint(input: ConstraintInput, source: PinnedConstraint['source']): PinnedConstraint {
  if (typeof input === 'string') {
    const text = input.trim();
    return {
      id: `${AUTO_ID_PREFIX}${sha256(text).slice(0, 12)}`,
      text,
      sha256: sha256(text),
      source,
      kind: 'soft_policy',
      enforcement: 'block',
    };
  }

  if (!isRecord(input)) throw new PolicyError('a constraint must be a string or an object');
  const text = typeof input.text === 'string' ? input.text.trim() : undefined;
  if (text === undefined || text === '') {
    throw new PolicyError('a constraint must have non-empty text');
  }
  const digest = sha256(text);
  if (input.sha256 !== undefined && input.sha256 !== digest) {
    // The digest is the thing step 4c and the byte-equality check trust. A
    // mismatch means the file is not describing the constraint it claims to.
    throw new PolicyError(
      `constraint ${JSON.stringify(input.id ?? AUTO_ID_PREFIX)} declares sha256 that does not match its text`,
    );
  }
  // No assertion on `source`/`kind`/`enforcement`: `input` is a
  // `Partial<PinnedConstraint>`, so those are already the right types, and a
  // hand-written string that is not one of the enum members is caught by
  // `StrataPolicySchema` two lines below. A cast here would be a cast that only
  // looks like validation, on the one field a typo in a YAML file reaches first.
  return {
    id: typeof input.id === 'string' && input.id !== '' ? input.id : `${AUTO_ID_PREFIX}${digest.slice(0, 12)}`,
    text,
    sha256: digest,
    source: typeof input.source === 'string' ? input.source : source,
    kind: typeof input.kind === 'string' ? input.kind : 'soft_policy',
    enforcement: typeof input.enforcement === 'string' ? input.enforcement : 'block',
  };
}

function constraintsOf(doc: unknown, source: PinnedConstraint['source']): PinnedConstraint[] {
  const raw = isRecord(doc) ? doc.constraints : undefined;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new PolicyError('constraints must be a list');

  const out = raw.map((c) => expandConstraint(c as ConstraintInput, source));
  const seen = new Set<string>();
  for (const c of out) {
    if (seen.has(c.id)) throw new PolicyError(`duplicate constraint id ${JSON.stringify(c.id)}`);
    seen.add(c.id);
  }
  return out;
}

function formatIssues(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string[] {
  return error.issues.map((i) => `${i.path.map(String).join('.') || '<root>'}: ${i.message}`);
}

/**
 * Parse a policy document of any accepted shape into a validated
 * `StrataPolicy`. The schema does the field work; this does the two integrity
 * checks a schema cannot express.
 */
export function normalizePolicyDocument(
  document: unknown,
  source: PinnedConstraint['source'] = 'org_policy',
): StrataPolicy {
  if (!isRecord(document)) throw new PolicyError('a policy document must be a mapping');
  if (document.version !== 1) {
    throw new PolicyError('a policy document must set version: 1 explicitly');
  }

  // `constraints` is expanded before the schema runs so the schema never sees a
  // bare string, and so a declared-but-wrong digest is caught with the
  // constraint's own id in the message.
  const withConstraints: Record<string, unknown> = { ...document, constraints: [] };
  if (document.constraints !== undefined) {
    withConstraints.constraints = constraintsOf(document, source);
  }

  const parsed = StrataPolicySchema.safeParse(withConstraints);
  if (!parsed.success) throw new PolicyError('invalid policy document', formatIssues(parsed.error));

  for (const c of parsed.data.constraints) {
    if (c.sha256 !== sha256(c.text)) {
      throw new PolicyError(`constraint ${JSON.stringify(c.id)} text does not match its own digest`);
    }
  }
  return parsed.data;
}

/** YAML in, validated policy out. Throws {@link YamlError} or {@link PolicyError}. */
export function parsePolicyYaml(text: string, label = '<policy>'): StrataPolicy {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (e) {
    if (e instanceof YamlError) throw new PolicyError(`${label} is not readable: ${e.message}`);
    throw e;
  }
  return normalizePolicyDocument(document);
}

function readSource(source: PolicySource): unknown {
  if (source.document !== undefined) return source.document;
  if (source.text !== undefined) {
    try {
      return parseYaml(source.text);
    } catch (e) {
      if (e instanceof YamlError) throw new PolicyError(`${source.label} is not readable: ${e.message}`);
      throw e;
    }
  }
  throw new PolicyError(`${source.label} has neither text nor document`);
}

/** Content digest of the prompt-visible pin set. */
export function pinHashOf(policy: StrataPolicy): string {
  // Byte-identical to `verifyPinIntegrity(pinSetText(policy), ...).policyHash`,
  // which is what makes the step-4c comparison a byte comparison rather than a
  // judgement call. There is a test asserting the two agree.
  return sha256(pinSetText(policy).join('\n'));
}

/**
 * What makes two versions of a constraint the same constraint.
 *
 * `source` is excluded here for the same reason `sameConstraint` excludes it:
 * the diff has to agree with the merge about what "unchanged" means, or a
 * project file that restates an inherited rule is accepted by the merge and
 * then reported as an edit by the diff -- and since `documentHash` covers
 * provenance, that makes a pin set that did not move look like a policy change
 * to hot reload.
 */
function constraintFingerprint(c: PinnedConstraint): string {
  return JSON.stringify([c.text, c.kind, c.enforcement]);
}

export function diffPolicy(before: StrataPolicy, after: StrataPolicy): PolicyDiff {
  const beforeById = new Map(before.constraints.map((c) => [c.id, c]));
  const afterById = new Map(after.constraints.map((c) => [c.id, c]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [id, c] of afterById) {
    const prev = beforeById.get(id);
    if (prev === undefined) added.push(id);
    else if (constraintFingerprint(prev) !== constraintFingerprint(c)) changed.push(id);
  }
  for (const id of beforeById.keys()) if (!afterById.has(id)) removed.push(id);

  const settingsChanged: string[] = [];
  for (const key of Object.keys(after).sort()) {
    if (key === 'constraints') continue;
    // Indexed as a record: `after` is a schema output, not a dictionary, but
    // this loop is over its keys and a dotted-path reader is the honest way to
    // write that without enumerating every policy section.
    const a = (after as Record<string, unknown>)[key];
    const b = (before as Record<string, unknown>)[key];
    if (hashCanonical(a) !== hashCanonical(b)) settingsChanged.push(key);
  }

  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
    settingsChanged,
    pinHashBefore: pinHashOf(before),
    pinHashAfter: pinHashOf(after),
  };
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isRecord(override)) return override;
  if (!isRecord(base)) return override;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isRecord(v) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function getPath(doc: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => (isRecord(acc) ? acc[k] : undefined), doc);
}

/** Paths a project file may not weaken. Each entry is a hard security rule. */
const PROTECTED_SETTINGS: readonly { readonly path: string; readonly reason: string }[] = Object.freeze([
  {
    path: 'governance.pinning',
    reason: 'pinning is the product; a repository cannot switch it off',
  },
  {
    path: 'governance.autoPin',
    reason: 'a repository cannot disable auto-pinning of detected constraints',
  },
]);

export interface MergeOptions {
  /** `project` enables the anti-downgrade guard. */
  readonly source: 'base' | 'project';
  readonly label?: string;
  /** `throw` (default) refuses the whole file; `report` keeps the safe values. */
  readonly onRejection?: 'throw' | 'report' | undefined;
}

/**
 * Constraint identity, ignoring `source`.
 *
 * `source` is excluded on purpose: a project file that restates an inherited
 * constraint verbatim will have expanded it with `source: 'project'`, and
 * treating that as a modification would reject the single most natural way for
 * a project file to add a rule to an existing set.
 */
function sameConstraint(a: PinnedConstraint, b: PinnedConstraint): boolean {
  return a.text === b.text && a.kind === b.kind && a.enforcement === b.enforcement;
}

/**
 * Base constraints in base order, plus the project's new ones.
 *
 * See the call site for why this is a union and not a replacement.
 */
function unionConstraints(
  base: readonly PinnedConstraint[],
  override: unknown,
  label: string,
  rejections: MergeRejection[],
): PinnedConstraint[] {
  let attempt: PinnedConstraint[];
  try {
    attempt = constraintsOf(override, 'project');
  } catch (e) {
    if (e instanceof PolicyError) throw new PolicyError(`${label} is not a usable policy`, e.issues);
    throw e;
  }

  const inherited = new Map(base.map((c) => [c.id, c]));
  const extra: PinnedConstraint[] = [];
  for (const raw of attempt) {
    // Provenance is stamped, never taken from the file. A repository is not
    // entitled to declare a rule of its own to be `org_policy`: provenance is
    // what an operator reads to decide whose rule they are looking at, and a
    // file that can write its own authorship can forge it. `expandConstraint`
    // honours a declared `source` for the org's own file, which is the one
    // input entitled to make that claim.
    const c: PinnedConstraint = { ...raw, source: 'project' };
    const prior = inherited.get(c.id);
    if (prior === undefined) {
      extra.push(c);
      continue;
    }
    if (sameConstraint(prior, c)) continue;
    rejections.push({
      path: `constraints.${c.id}`,
      reason: 'a project file cannot modify an inherited constraint; declare a new id instead',
    });
  }
  return [...base, ...extra];
}

/**
 * Merge a project policy file onto the base.
 *
 * Tightening is always allowed: a project may add any constraint it likes,
 * including `hard_safety` ones. Weakening is refused and reported, never
 * applied. See the module doc for why the repository file is treated as hostile.
 */
export function mergePolicy(
  base: StrataPolicy,
  override: unknown,
  options: MergeOptions,
): MergeResult {
  const label = options.label ?? options.source;
  const rejections: MergeRejection[] = [];
  const merged = deepMerge(base, override) as Record<string, unknown>;

  if (options.source === 'project') {
    for (const rule of PROTECTED_SETTINGS) {
      const attempted = getPath(override, rule.path);
      if (attempted !== undefined && attempted !== getPath(base, rule.path)) {
        rejections.push({ path: rule.path, reason: rule.reason });
        // Restore the base value. Under `throw` this is moot, under `report` it
        // is the difference between a refused override and a silently ignored
        // one. Restoring rather than deleting the key matters: `merged` is
        // already the deep merge, so deleting the key falls back to the
        // *schema* default, which is not the same thing as the base value
        // whenever the org policy set that field explicitly.
        const keys = rule.path.split('.');
        const head = keys[0] as string;
        const tail = keys[1];
        if (tail === undefined) merged[head] = getPath(base, rule.path);
        else if (isRecord(merged[head])) {
          merged[head] = { ...merged[head], [tail]: getPath(base, rule.path) };
        }
      }
    }
    const redaction = merged.redaction;
    if (isRecord(redaction)) {
      if (redaction.mode === 'off' && base.redaction.mode !== 'off') {
        rejections.push({ path: 'redaction.mode', reason: 'a repository cannot switch redaction off' });
        merged.redaction = { ...redaction, mode: base.redaction.mode };
      } else if (redaction.onFail === 'forward' && base.redaction.onFail === 'block') {
        rejections.push({
          path: 'redaction.onFail',
          reason: 'a repository cannot turn a redaction failure into a pass-through',
        });
        merged.redaction = { ...redaction, onFail: base.redaction.onFail };
      }
    }

    // The constraint list is unioned, not replaced.
    //
    // `deepMerge` overwrites `constraints` outright, because an array is not a
    // mapping -- so a project file that declares one constraint of its own
    // silently deletes every constraint the org declared. That is the exact
    // failure this package exists to prevent, arriving through the config path
    // instead of the compaction path, and it lands hardest on the constraints
    // that are hardest to notice going missing: Governance Decay found decay is
    // 8.3x worse for soft organisational policies than for hard safety norms.
    //
    // Union by id instead: the base list keeps its order and its contents, and
    // the project's entries are appended. A project file that restates an
    // inherited constraint verbatim is accepted and ignored, because restating
    // is the natural way to keep a rule while adding one; a project file that
    // *modifies* an inherited id is refused loudly rather than silently
    // dropped, because there is no safe reading of "change someone else's
    // safety rule from a repository you just cloned".
    merged.constraints = unionConstraints(base.constraints, override, label, rejections);
  }

  let policy: StrataPolicy;
  try {
    policy = normalizePolicyDocument(merged, options.source === 'project' ? 'project' : 'org_policy');
  } catch (e) {
    if (e instanceof PolicyError) throw new PolicyError(`${label} is not a usable policy`, e.issues);
    throw e;
  }

  if (options.source === 'project') {
    // Post-condition on the union. A union by id cannot drop or reword an
    // inherited constraint, so this cannot fire -- it is here because this is
    // the security-critical boundary in the package, it runs once at load, and
    // a future change to `deepMerge` or to the union rule would otherwise be a
    // silent loss of pins rather than a loud one.
    const byId = new Map(policy.constraints.map((c) => [c.id, c]));
    for (const inherited of base.constraints) {
      const next = byId.get(inherited.id);
      if (next === undefined || !sameConstraint(next, inherited)) {
        throw new PolicyError(`merge did not preserve inherited constraint ${JSON.stringify(inherited.id)}`, [
          `constraints.${inherited.id}`,
        ]);
      }
    }
  }

  if (rejections.length > 0 && (options.onRejection ?? 'throw') === 'throw') {
    throw new PolicyMergeError(label, rejections);
  }

  return { policy, rejections, diff: diffPolicy(base, policy) };
}

export interface PolicyStoreInit {
  readonly sources: readonly PolicySource[];
  readonly policy: StrataPolicy;
  readonly revision: number;
  readonly rejections: readonly MergeRejection[];
  readonly loadedAt: number;
}

/**
 * An immutable, versioned policy. Every mutating-looking method returns a new
 * store with a new revision: a `PinnedBuffer` built from a store holds a frozen
 * snapshot, so there has to be no way to change the snapshot out from under it.
 */
export class PolicyStore {
  readonly #policy: StrataPolicy;
  readonly #sources: readonly PolicySource[];
  readonly #rejections: readonly MergeRejection[];
  readonly #revision: number;
  readonly #loadedAt: number;
  readonly #textToId: ReadonlyMap<string, string>;

  private constructor(init: PolicyStoreInit) {
    this.#policy = init.policy;
    this.#sources = Object.freeze([...init.sources]);
    this.#rejections = Object.freeze([...init.rejections]);
    this.#revision = init.revision;
    this.#loadedAt = init.loadedAt;
    this.#textToId = new Map(init.policy.constraints.map((c) => [c.text, c.id]));
  }

  static create(
    policy: StrataPolicy,
    sources: readonly PolicySource[] = [{ label: '<inline>' }],
    rejections: readonly MergeRejection[] = [],
    now: number = Date.now(),
  ): PolicyStore {
    return new PolicyStore({ policy, sources, rejections, revision: 1, loadedAt: now });
  }

  /** Base policy, optionally overlaid with a per-project file. */
  static load(
    base: PolicySource,
    project?: PolicySource,
    options: { readonly onRejection?: 'throw' | 'report' | undefined; readonly now?: number | undefined } = {},
  ): PolicyStore {
    const now = options.now ?? Date.now();
    const basePolicy = normalizePolicyDocument(readSource(base), 'org_policy');
    if (project === undefined) {
      return new PolicyStore({
        policy: basePolicy,
        sources: [base],
        rejections: [],
        revision: 1,
        loadedAt: now,
      });
    }
    const result = mergePolicy(basePolicy, readSource(project), {
      source: 'project',
      label: project.label,
      onRejection: options.onRejection,
    });
    return new PolicyStore({
      policy: result.policy,
      sources: [base, project],
      rejections: result.rejections,
      revision: 1,
      loadedAt: now,
    });
  }

  get policy(): StrataPolicy {
    return this.#policy;
  }
  get revision(): number {
    return this.#revision;
  }
  get loadedAt(): number {
    return this.#loadedAt;
  }
  get sources(): readonly PolicySource[] {
    return this.#sources;
  }
  get rejections(): readonly MergeRejection[] {
    return this.#rejections;
  }
  get constraints(): readonly PinnedConstraint[] {
    return this.#policy.constraints;
  }
  /** The prompt-visible pin text, in the same deterministic order as policy. */
  get texts(): readonly string[] {
    return Object.freeze(pinSetText(this.#policy));
  }
  /** The hash step 4c compares byte-wise. */
  get pinHash(): string {
    return pinHashOf(this.#policy);
  }
  /** Whole-document identity, for hot reload. */
  get documentHash(): string {
    return hashCanonical(this.#policy);
  }
  idFor(text: string): string | undefined {
    return this.#textToId.get(text);
  }

  /** Same document, new revision number. Used to prove identity is unchanged. */
  bump(): PolicyStore {
    return new PolicyStore({
      policy: this.#policy,
      sources: this.#sources,
      rejections: this.#rejections,
      revision: this.#revision + 1,
      loadedAt: this.#loadedAt,
    });
  }

  diffTo(other: PolicyStore): PolicyDiff {
    return diffPolicy(this.#policy, other.policy);
  }

  supersedes(other: PolicyStore): boolean {
    return this.#revision > other.revision && this.documentHash !== other.documentHash;
  }

  withOverrides(
    override: unknown,
    options: { readonly label?: string; readonly onRejection?: 'throw' | 'report' | undefined } = {},
  ): PolicyStore {
    const result = mergePolicy(this.#policy, override, {
      source: 'project',
      label: options.label ?? '<overrides>',
      onRejection: options.onRejection,
    });
    return new PolicyStore({
      policy: result.policy,
      sources: [...this.#sources, { label: options.label ?? '<overrides>' }],
      rejections: [...this.#rejections, ...result.rejections],
      revision: this.#revision + 1,
      loadedAt: this.#loadedAt,
    });
  }

  /**
   * Add a constraint at runtime, e.g. when a user says "from now on, never
   * touch legacy/". The digest is computed here; the caller cannot hand us a
   * digest that does not match the text.
   */
  pin(input: ConstraintInput): PolicyStore {
    const constraint = expandConstraint(input, 'user');
    if (this.#policy.constraints.some((c) => c.id === constraint.id)) {
      throw new PolicyError(`constraint ${JSON.stringify(constraint.id)} is already pinned`);
    }
    return this.withRawConstraints([...this.#policy.constraints, constraint], constraint.source);
  }

  /**
   * Remove a constraint. Refuses to remove `hard_safety`: the same anti-downgrade
   * rule a project file gets, applied to the runtime API, because "the agent
   * asked me to drop a safety rule" is a sentence that has been said before.
   * Q6 in docs/decisions.md (does pinning extend to preferences) is a separate
   * question and does not change this rule.
   */
  unpin(id: string): PolicyStore {
    const target = this.#policy.constraints.find((c) => c.id === id);
    if (target === undefined) throw new PolicyError(`no constraint with id ${JSON.stringify(id)}`);
    if (target.kind === 'hard_safety') {
      throw new PolicyError(
        `constraint ${JSON.stringify(id)} is hard_safety and cannot be unpinned; edit the org policy file`,
      );
    }
    return this.withRawConstraints(
      this.#policy.constraints.filter((c) => c.id !== id),
      'org_policy',
    );
  }

  /** Stamps the pin hash onto a context. See the note on `pinHash`. */
  stamp(state: ContextState): ContextState {
    return { ...state, policyHash: this.pinHash };
  }

  private withRawConstraints(
    constraints: readonly PinnedConstraint[],
    source: PinnedConstraint['source'],
  ): PolicyStore {
    const policy = normalizePolicyDocument(
      { ...this.#policy, constraints },
      source,
    );
    return new PolicyStore({
      policy,
      sources: this.#sources,
      rejections: this.#rejections,
      revision: this.#revision + 1,
      loadedAt: this.#loadedAt,
    });
  }
}
