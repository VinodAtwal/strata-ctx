/**
 * H-8. Per-model support registry.
 *
 * ## The rule, stated once
 *
 * **Absence of an entry means unsupported.** A model this package has never
 * heard of is served plain JSON, because a model that emits a format the agent
 * cannot read is a hard failure, and a hard failure on an unknown model is the
 * *most* likely case in a product whose users bring their own provider. R13 names
 * the risk -- TOON/TRON are not natively trained formats -- and the mitigation it
 * records is this file.
 *
 * Matching is exact, on the model id or on an explicitly registered alias. There
 * is deliberately no prefix or family matching: matching `claude-sonnet-4-5` for
 * `claude-sonnet-4-5-20260101` is a guess about a model that did not exist when
 * the entry was written, and "assume supported" is the failure mode this task
 * exists to prevent. A new model version is a one-line registry addition.
 */

/** The three wire formats a machine block can be served in. */
export type MachineFormat = 'json' | 'toon' | 'tron';

export const MACHINE_FORMATS: readonly MachineFormat[] = Object.freeze(['json', 'toon', 'tron']);

/**
 * `verified` means somebody ran the format past this model and read the answer
 * back. `unverified` means the format is plausible for it but nobody has checked,
 * and it is not served unless a caller opts in.
 */
export type SupportStatus = 'verified' | 'unverified';

export interface ModelSupport {
  readonly model: string;
  /**
   * Alternate ids that mean the same thing (`claude-...-latest` for a dated
   * release). Explicit, because an alias is a claim about a model and an
   * inferred one is a claim about every model released after it.
   */
  readonly aliases: readonly string[];
  /** Formats served to this model, best first. Always contains `json`. */
  readonly formats: readonly MachineFormat[];
  readonly status: SupportStatus;
  /** Bounded repair attempts allowed for this model's first rollout. See ./repair.ts. */
  readonly maxRepairAttempts: number;
  /** Why the entry says what it says. An entry with no note is folklore. */
  readonly note: string;
}

export type ModelRegistry = ReadonlyMap<string, ModelSupport>;

/**
 * What an unknown model gets.
 *
 * JSON only, no repair, and `verified` -- not because the JSON path has been
 * measured for this model but because it is the format the model already speaks.
 * Calling it `verified` is a claim about the *format*, not the model, and the
 * distinction is kept from mattering by the fact that no other format is listed.
 */
export const UNKNOWN_MODEL_SUPPORT: ModelSupport = Object.freeze({
  model: '',
  aliases: Object.freeze([] as readonly string[]),
  formats: Object.freeze(['json'] as readonly MachineFormat[]),
  status: 'verified',
  maxRepairAttempts: 0,
  note: 'unknown model: JSON only, no repair',
});

const entry = (
  model: string,
  formats: readonly MachineFormat[],
  status: SupportStatus,
  maxRepairAttempts: number,
  note: string,
  aliases: readonly string[] = [],
): ModelSupport =>
  Object.freeze({
    model,
    aliases: Object.freeze(aliases),
    formats: Object.freeze(formats),
    status,
    maxRepairAttempts,
    note,
  });

/**
 * The shipped registry.
 *
 * Every entry is `unverified` and that is the honest starting position, not an
 * oversight: E3 (the output-format suite) has not run, so no model has been
 * observed reading a TOON header correctly, and R13's trigger is exactly that
 * measurement. Publishing them as `verified` would be asserting a result nobody
 * has. Enabling one is a deliberate act:
 *
 *     registryWith(modelSupport('claude-sonnet-4-5', { status: 'verified' }))
 *
 * and the negative test in ./registry.test.ts is that the default registry serves
 * JSON to everything, so the feature cannot ship enabled by accident.
 */
const SEED: readonly ModelSupport[] = Object.freeze([
  entry(
    'claude-sonnet-4-5',
    ['toon', 'tron', 'json'],
    'unverified',
    1,
    'seed entry pending E3; the instructions directive may be enough to teach the header in one turn',
    ['claude-sonnet-4-5-latest'],
  ),
  entry(
    'gpt-5',
    ['toon', 'json'],
    'unverified',
    0,
    'seed entry pending E3; the diversity study found JSON-shaped output already narrows answer variety, so the terse form is preferred over a second structured form',
    ['gpt-5-latest'],
  ),
]);

function index(support: readonly ModelSupport[]): ModelRegistry {
  const map = new Map<string, ModelSupport>();
  for (const item of support) {
    map.set(item.model, item);
    for (const alias of item.aliases) map.set(alias, item);
  }
  return map;
}

export const DEFAULT_REGISTRY: ModelRegistry = index(SEED);

export function modelSupport(
  model: string,
  registry: ModelRegistry = DEFAULT_REGISTRY,
): ModelSupport {
  return registry.get(model) ?? UNKNOWN_MODEL_SUPPORT;
}

export interface SupportOptions {
  /**
   * Serve a format whose entry is `unverified`. Off by default: an unverified
   * format is a hypothesis, and the cost of being wrong is an unparseable tool
   * result, not a slightly worse answer.
   */
  readonly allowUnverified: boolean;
}

export function supportsFormat(
  model: string,
  format: MachineFormat,
  registry: ModelRegistry = DEFAULT_REGISTRY,
  options: SupportOptions = { allowUnverified: false },
): boolean {
  const support = modelSupport(model, registry);
  if (!support.formats.includes(format)) return false;
  return support.status === 'verified' || options.allowUnverified;
}

/** Formats this model may be served, best first, honouring the verify gate. */
export function supportedFormats(
  model: string,
  registry: ModelRegistry = DEFAULT_REGISTRY,
  options: SupportOptions = { allowUnverified: false },
): readonly MachineFormat[] {
  return modelSupport(model, registry).formats.filter(
    (f) => supportsFormat(model, f, registry, options),
  );
}

/** Pure: a new registry, the old one untouched. Registries are shared state. */
export function registryWith(
  support: ModelSupport,
  base: ModelRegistry = DEFAULT_REGISTRY,
): ModelRegistry {
  const next = new Map(base);
  for (const key of [support.model, ...support.aliases]) next.set(key, support);
  return next;
}

export function registryFrom(entries: readonly ModelSupport[]): ModelRegistry {
  return index(entries);
}

export interface SupportOverrides {
  readonly formats?: readonly MachineFormat[];
  readonly status?: SupportStatus;
  readonly maxRepairAttempts?: number;
  readonly note?: string;
}

/**
 * A copy of a model's entry with some fields replaced.
 *
 * Exists so a test or an operator can flip one fact without restating the rest,
 * and -- more importantly -- so flipping `status` is a *visible edit*. Rewriting
 * an entry by hand to add TOON support would leave nobody able to say afterwards
 * which entry had been asserted by whom.
 */
export function withSupport(
  model: string,
  overrides: SupportOverrides,
  registry: ModelRegistry = DEFAULT_REGISTRY,
): ModelSupport {
  const current = modelSupport(model, registry);
  const requested = overrides.formats ?? current.formats;
  // `json` is appended because it is the fallback and the order field says "best
  // first", but every entry already has it, so an unconditional push would give
  // every derived entry a duplicate. `supportedFormats` and `describeRegistry`
  // both print this list, and "toon, json, json" in a support report is the kind
  // of thing that stops a reader trusting the report.
  const formats = requested.includes('json')
    ? [...requested]
    : [...requested, 'json' as const];
  return Object.freeze({
    model: current.model === '' ? model : current.model,
    aliases: current.aliases,
    formats: Object.freeze(formats),
    status: overrides.status ?? current.status,
    maxRepairAttempts: overrides.maxRepairAttempts ?? current.maxRepairAttempts,
    note: overrides.note ?? current.note,
  });
}

/** Human-readable list, for `strata models` and for a test's failure message. */
export function describeRegistry(registry: ModelRegistry = DEFAULT_REGISTRY): string {
  return [...new Set(registry.values())]
    .map((s) => `${s.model || '(unknown)'} [${s.status}] ${s.formats.join(', ')} -- ${s.note}`)
    .join('\n');
}
