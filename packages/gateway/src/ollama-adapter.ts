import { sha256 } from '@strata-ctx/core-types';

import type { ConfigIssue } from './config.js';

/**
 * B-9: Tier 3 narration, from a local Ollama.
 *
 * ## What this fills in, and why a model is the only thing that can
 *
 * A gist is two kinds of field (architecture §6, and the table at §2 line 17).
 * `changed[]`, `artifacts[]`, `log_gist`, `current_values` are deterministic: they
 * are already sitting in the tool log, exact, free, and verifiable. The
 * narrative ones -- `goal`, `decided[].why`, `unresolved`, `next` -- are not in
 * the log, because the thing that knows them is the turn itself. Tier 2 gets them
 * by asking the model, inside its own response, for a sentinel block it already
 * has the state for. Tier 3 is the fallback for agents that never emit one: a
 * second, separate model reads the finished transcript and writes them.
 *
 * ## Off by default, and the gate is `enabled: true` and nothing else
 *
 * Three reasons, in the order they matter:
 *
 * 1. **It is a slower path to the same answer.** Tier 2 costs zero extra input
 *    tokens because the model already holds the state; Tier 3 pays for a whole
 *    second context window on the same machine as the gateway, which is
 *    competing with the agent for the same CPU and the same memory bandwidth.
 * 2. **The failure mode is worse than doing nothing.** A summariser that
 *    hallucinates a decision writes prose that a later turn reads as session
 *    history. There is no signal that separates a plausible fabrication from a
 *    real one, and no validation step that can catch it -- step 4c byte-compares
 *    `constraints` and nothing else.
 * 3. **Below ~5k tokens it loses on arithmetic** (architecture §4 step 6,
 *    integrations.md: "gains only materialize beyond ~5k tokens and the
 *    compressor's own latency can exceed the saving below that"). Shipping a
 *    default that is a net loss on short sessions would make the feature look
 *    broken rather than absent.
 *
 * So `NARRATION_MIN_TOKENS` is a floor and `enabled` is opt-in, and the code
 * enforces both at the one place narration could happen: `narrate` re-checks the
 * gate before it touches the transport, so no caller can reach the network by
 * constructing an input directly.
 *
 * ## Governance does not leave the process, and that is checked twice
 *
 * `text` is the background/retrieval span. The architecture scopes COMPRESS to
 * exactly that span and says it "must never see `tier==='governance'`", and
 * `stripGovernanceText` enforces it a second time on the string itself: the model
 * has read the pin set by then, so a constraint can appear inside an ordinary
 * tool result, and `buildNarrationRequest` deletes those substrings before the
 * body is serialized. Mirrors `stripGovernance` in `pipeline/src/self-gist.ts` and
 * deliberately does not import it -- P1 makes `core-types` the only cross-stream
 * import, and a gateway that reached into the pipeline for one function would be
 * a second place the rule is enforced.
 *
 * The other direction is closed too. `Gist.constraints` is a byte-equality target
 * (architecture §5 step 4c), so a model-written constraint would make the check a
 * tautology. `GOVERNANCE_FIELD_NAMES` is not in the request grammar and
 * `parseNarrationReply` drops those keys even when the model volunteers them,
 * because "we did not ask for it" is not a property of a 1B model's output.
 *
 * ## No credentials, and no fake credential surface
 *
 * Ollama is a local process and takes no API key. `credentials.PROVIDERS` must
 * not grow an `ollama` entry: that set is `Record<ProviderId, string>` keyed by
 * an environment variable name, so adding one would invent `OLLAMA_API_KEY`, and
 * `resolveCredential('ollama')` would then throw `MissingCredentialError` at
 * exactly the moment the feature is used correctly. This module has no credential
 * surface at all, and the test asserts every header it sends is non-sensitive via
 * `isSensitiveHeader` rather than a local list (AGENTS §10: re-deriving that list
 * is how a header leaks).
 *
 * ## The transport is injected
 *
 * No global `fetch` anywhere in this file, for three reasons that all point the
 * same way: the unit tests must be hermetic (a test that opens a socket is a test
 * that fails on a laptop with Ollama quit and passes on CI); the repository has a
 * checker whose entire job is that no module reaches for a global egress
 * capability (`security/src/locality.ts`); and a narration call that cannot be
 * faked cannot be tested for its error taxonomy at all. `ollamaClientFromFetch`
 * exists so production wiring is one line -- the caller passes `fetch`, this file
 * still never names it.
 *
 * ## Failure taxonomy, because "it didn't work" is not actionable
 *
 * Four ways this can fail and they have four different fixes:
 *
 * | `code` | What happened | The fix in the message |
 * |---|---|---|
 * | `ollama_unreachable` | nothing is listening (ECONNREFUSED, DNS, reset) | `ollama serve`, or fix `baseUrl` |
 * | `model_not_found` | Ollama answered; it does not have that model | `ollama pull <model>` |
 * | `ollama_timeout` | it is loading a model, or wedged | raise `timeoutMs` |
 * | `ollama_bad_response` | a status or a body we cannot use | the status and a bounded snippet |
 * | `ollama_transport_error` | thrown something unclassifiable | says so, instead of guessing |
 *
 * The last one is deliberate. A classification that maps every unknown throw onto
 * `ollama_unreachable` sends the operator to restart a server that is running.
 *
 * Model-not-found is recognised from the *body*, not from the status: Ollama
 * answers `404 {"error":"model 'x' not found"}` (verified against 0.14.1), but
 * Go's own router answers a 404 with `404 page not found` for a path we got wrong,
 * and a status-only rule would report a routing bug as a missing model. The
 * recognition therefore also requires the body to name the model we asked for.
 *
 * ## Nothing here throws out of `narrate`
 *
 * N5: any stage failure fails open to uncompressed. The narration fields are the
 * *only* thing this stage can contribute, so failing open means contributing
 * none: `narrate` resolves a `NarrationFailure` carrying the typed error, the
 * caller keeps its deterministic fields, and the request the agent sent is
 * untouched. `parseNarrationReply` and `buildNarrationRequest` do throw, because
 * they are pure and a caller driving them by hand wants the error.
 *
 * ## Determinism
 *
 * No clock and no randomness anywhere in this file, so the same config and the
 * same transcript produce a byte-identical request body. The *completion* is not
 * deterministic and cannot be -- a local model at temperature 0 is not a function
 * -- which is why `format: 'json'` is requested and the parser is total: it
 * records defects instead of throwing, and returns a partial narrative rather
 * than losing the turn. docs/development.md §6 DoD 2 exempts Tier 3 model calls
 * from byte-identical output for exactly this reason.
 *
 * One measured detail worth recording, because it is the reason the parser looks
 * the way it does. Asked for `{goal, decided, unresolved, next}` with
 * `format: "json"`, `gemma3:1b` on Ollama 0.14.1 returned valid JSON in which
 * `decided` was an array of *strings* rather than objects, and it invented a
 * fifth key, `next_decided`. Constrained decoding fixed the syntax and not the
 * shape. Both are handled as defects (`malformed_decision`, `unknown_field`) and
 * neither is allowed to throw.
 */

/* -------------------------------------------------------------------------- */
/* Constants                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Where Ollama listens. A loopback literal rather than `localhost`: `localhost`
 * resolves to `::1` first on macOS and on most Linux hosts, Ollama binds
 * `127.0.0.1` by default, and the resulting `ECONNREFUSED` arrives from a config
 * that reads correctly. Same reasoning as `DEFAULT_CONFIG.listen.host`.
 */
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

/**
 * The backend name, in one place.
 *
 * AGENTS §10 records what happens when one concept has two spellings: the
 * `PROVIDERS` pair produced a gate that cried wolf on every run, and a checker
 * that compares an *advertised* name against a *registered* one reported all six
 * MCP tools as unserviceable. So the string `ollama` that appears in
 * `docs/integrations.md`, in this module, and (if someone ever adds one) in a
 * config enum is declared here, and everything else reads it from here. The
 * advertised spelling and the registered spelling cannot drift because there is
 * only one spelling in this module.
 *
 * It is deliberately NOT `config.PROVIDERS`: that is the set of *upstreams a
 * client request can be routed to*, and a `ProviderAdapter` with
 * `toCanonical`/`fromCanonical` for it. Tier 3 narration is an out-of-band call
 * the gateway makes about a transcript, not a destination an agent's traffic is
 * proxied to -- so an entry there would advertise a routable provider that no
 * adapter table can ever key, i.e. `resolveAdapter` returning `undefined` and a
 * 501 for a provider an operator believed was supported. (An Ollama reached
 * *as* an upstream is `openai-compat` with `upstream: http://127.0.0.1:11434/v1`;
 * it serves `/v1/chat/completions`. Two names for one box is precisely the trap
 * above, so there is one name and it is not this one.)
 */
export const NARRATION_BACKEND = 'ollama';

export type NarrationBackend = typeof NARRATION_BACKEND;

export const NARRATION_BACKENDS: readonly NarrationBackend[] = Object.freeze([NARRATION_BACKEND]);

export const isNarrationBackend = (value: unknown): value is NarrationBackend =>
  typeof value === 'string' && (NARRATION_BACKENDS as readonly string[]).includes(value);

/**
 * The narrative fields a narration may ask for.
 *
 * `decided`, not `why`: `docs/integrations.md` spells the field list
 * `fields: [goal, why, unresolved, next]`, and a top-level `why` is not
 * representable -- `GistSchema` puts `why` on `GistDecision` beside an `id` and a
 * non-empty `choice`, so a standalone rationale would either be dropped by the
 * schema or force inventing a decision to hang it on. Asking for `decided` and
 * reading the rationale off it keeps one shape that C-1 can assemble.
 *
 * `constraints` is not a member, which is the point: docs/integrations.md requires
 * that this list "excludes `constraints` by construction ... the type should make
 * it impossible to pass a governance field to a model". Here that is two layers,
 * the union (compile time) and `resolveNarrationConfig` (a config document is
 * untrusted input and its keys are not typechecked anywhere).
 */
export const NARRATION_FIELDS = ['goal', 'decided', 'unresolved', 'next'] as const;

export type NarrationField = (typeof NARRATION_FIELDS)[number];

export const isNarrationField = (value: unknown): value is NarrationField =>
  typeof value === 'string' && (NARRATION_FIELDS as readonly string[]).includes(value);

/**
 * Keys a model may emit that would be governance if they were kept. Dropped and
 * recorded. See the module header on why "we did not ask" is not a property of
 * model output.
 */
export const GOVERNANCE_FIELD_NAMES: readonly string[] = Object.freeze([
  'constraints',
  'constraint',
  'policy',
  'policies',
  'rules',
]);

/**
 * The token floor, from architecture §4 step 6 ("Gated on >5k tokens") and
 * integrations.md's Tier 3 note. The comparison is strictly `>` so the boundary
 * belongs to the no-narration side: integrations.md puts the break-even at *above*
 * 5k, and a compressor that runs *at* 5k is a compressor running where the
 * architecture says it loses.
 */
export const NARRATION_MIN_TOKENS = 5_000;

/**
 * Whole-request budget for one narration, generous rather than tight.
 *
 * A small local model on a laptop does tens of tokens per second and Ollama's
 * first call for a model pays the load (`load_duration` was 1.9 s of a 2.4 s call
 * for `gemma3:1b`, measured locally), so a budget that is merely adequate for a
 * warm model produces a spurious timeout on a cold one. 20 s leaves the warm path
 * (a few seconds) an order of magnitude of headroom and still bounds a wedged
 * Ollama, which matters because this call sits inside a compaction transaction.
 * Not derived from `GatewayConfig.timeouts.requestMs`: that is the budget for the
 * *agent's* request, which may legitimately run for minutes, and a narration
 * budget of five minutes would let a hung local model stall a commit.
 *
 * TODO(WS-A, B-9): calibrate from the F2 live A/B rather than from this reading.
 */
export const OLLAMA_DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Cap on the completion, because `num_predict` defaults to unbounded.
 *
 * The narrative is four short fields; a real `gemma3:1b` answer came back in 109
 * tokens. 512 is roughly 4x that, so it never truncates a legitimate answer, and
 * it bounds what a runaway local model can make the process hold while the
 * compaction transaction waits.
 */
export const OLLAMA_MAX_OUTPUT_TOKENS = 512;

/* -------------------------------------------------------------------------- */
/* Config                                                                       */
/* -------------------------------------------------------------------------- */

export interface NarrationConfig {
  /** The only way narration happens. There is no default that sets this true. */
  readonly enabled: boolean;
  readonly backend: NarrationBackend;
  /** Required, with no default: see `resolveNarrationConfig`. */
  readonly model: string;
  readonly baseUrl: string;
  readonly fields: readonly NarrationField[];
  readonly minTokens: number;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  /**
   * Escape hatch for a genuinely non-loopback Ollama -- a compose network, J-7 --
   * which turns off the locality claim for this call rather than for the process.
   */
  readonly allowNonLoopback: boolean;
}

/**
 * Tier 3 as it ships: off.
 *
 * Frozen for the reason `DEFAULT_CONFIG` is frozen -- a module-level default that
 * something can mutate is a default some other code has mutated by the time the
 * next caller reads it. The tests assert the opt-in property against this object
 * rather than against a locally-built config, because a test that constructs its
 * own `enabled: false` proves nothing about the default.
 */
export const DISABLED_NARRATION_CONFIG: NarrationConfig = Object.freeze({
  enabled: false,
  backend: NARRATION_BACKEND,
  model: '',
  baseUrl: DEFAULT_OLLAMA_BASE_URL,
  fields: Object.freeze([...NARRATION_FIELDS]),
  minTokens: NARRATION_MIN_TOKENS,
  timeoutMs: OLLAMA_DEFAULT_TIMEOUT_MS,
  maxOutputTokens: OLLAMA_MAX_OUTPUT_TOKENS,
  allowNonLoopback: false,
});

/** An enabled config for a reachable model. Tests and callers start from here. */
export function enabledNarrationConfig(overrides: Partial<NarrationConfig> = {}): NarrationConfig {
  return Object.freeze({
    ...DISABLED_NARRATION_CONFIG,
    model: 'gemma3:1b',
    enabled: true,
    ...overrides,
  });
}

export type NarrationConfigResult =
  | { readonly ok: true; readonly config: NarrationConfig }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

const NARRATION_CONFIG_KEYS = [
  'enabled',
  'backend',
  'model',
  'baseUrl',
  'fields',
  'minTokens',
  'timeoutMs',
  'maxOutputTokens',
  'allowNonLoopback',
] as const;

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

/** Same parse `parseHttpUrl` in ./config.ts accepts, inlined to keep this module standalone. */
const parseBaseUrl = (text: string): URL | undefined => {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
};

/**
 * Loopback, in the three spellings an operator actually writes.
 *
 * `::1` in brackets because `new URL('http://::1:11434')` does not parse at all,
 * and the bracket form is the only one that does.
 */
const isLoopbackHost = (host: string): boolean =>
  host === 'localhost' ||
  host === '::1' ||
  host === '[::1]' ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

/**
 * `docs/integrations.md`'s `compression.local_model` block as a type, validated
 * the way `validateConfig` validates a gateway document.
 *
 * Three properties are inherited deliberately rather than reinvented:
 *
 * - **Total, not fail-fast.** Every problem is reported at once. An operator
 *   fixing a typo in a config file should find the next typo in the same run.
 * - **Unknown keys are errors.** `modle:` or `enable:` is refused rather than
 *   ignored, because an ignored `enable` leaves Tier 3 off *and* looks applied.
 *   This is also what makes the opt-in property hold for the documented block:
 *   `docs/integrations.md` writes the keys in snake_case (`base_url`,
 *   `min_tokens`, `allow_non_loopback`), and feeding one of those in produces
 *   `unknown_key` rather than a config that is half-applied and silently off.
 *   `enabled` itself is the one spelling that is identical in both conventions, so
 *   it is the only documented key that survives being copied out of the YAML.
 * - **`enabled` defaults to false**, and `model` has no default at all. The
 *   documented model is `qwen2.5-coder:7b`, which is deliberately *not* adopted as
 *   a code default: a default nobody has installed turns the first thing a new
 *   user meets into `model_not_found`, and an error about a default we invented
 *   reads as a broken install. Requiring it puts the assumption in the config
 *   where it can be checked with `ollama list`.
 */
export function resolveNarrationConfig(input: unknown): NarrationConfigResult {
  const issues: ConfigIssue[] = [];
  const add = (path: string, code: ConfigIssue['code'], message: string): void => {
    issues.push({ path, code, message });
  };

  if (!isRecord(input)) {
    add('', 'not_object', `must be a JSON object, got ${typeName(input)}`);
    return { ok: false, issues: Object.freeze(issues) };
  }

  for (const key of Object.keys(input).sort()) {
    if (!(NARRATION_CONFIG_KEYS as readonly string[]).includes(key)) {
      add(key, 'unknown_key', `is not a local_model key (known: ${NARRATION_CONFIG_KEYS.join(', ')})`);
    }
  }

  const boolField = (key: keyof NarrationConfig, fallback: boolean): boolean => {
    const value = input[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') {
      add(key, 'type', `must be a boolean, got ${typeName(value)}`);
      return fallback;
    }
    return value;
  };

  const enabled = boolField('enabled', false);
  const allowNonLoopback = boolField('allowNonLoopback', false);

  let backend: NarrationBackend = NARRATION_BACKEND;
  if (input.backend !== undefined && !isNarrationBackend(input.backend)) {
    add('backend', 'enum', `must be one of ${NARRATION_BACKENDS.join(', ')}, got ${typeName(input.backend)}`);
  } else {
    backend = input.backend ?? NARRATION_BACKEND;
  }

  let model = '';
  if (input.model === undefined) {
    add('model', 'missing', 'is required (Tier 3 has no default model; check `ollama list`)');
  } else if (typeof input.model !== 'string') {
    add('model', 'type', `must be a string, got ${typeName(input.model)}`);
  } else if (input.model.trim() === '') {
    add('model', 'format', 'must not be empty');
  } else {
    model = input.model.trim();
  }

  let baseUrl = DEFAULT_OLLAMA_BASE_URL;
  if (input.baseUrl !== undefined) {
    if (typeof input.baseUrl !== 'string') {
      add('baseUrl', 'type', `must be a string, got ${typeName(input.baseUrl)}`);
    } else {
      const parsed = parseBaseUrl(input.baseUrl);
      if (parsed === undefined) {
        add(
          'baseUrl',
          'format',
          `must be an absolute http(s) URL such as ${DEFAULT_OLLAMA_BASE_URL}, got "${input.baseUrl}"`,
        );
      } else if (!isLoopbackHost(parsed.hostname) && !allowNonLoopback) {
        add(
          'baseUrl',
          'format',
          `must be a loopback host (Tier 3 sends the transcript to it, which leaves the process). ` +
            `"${parsed.hostname}" is not one. Set allowNonLoopback to true if that host is yours.`,
        );
      } else {
        baseUrl = input.baseUrl;
      }
    }
  }

  let fields: readonly NarrationField[] = DISABLED_NARRATION_CONFIG.fields;
  if (input.fields !== undefined) {
    if (!Array.isArray(input.fields)) {
      add('fields', 'type', `must be an array, got ${typeName(input.fields)}`);
    } else {
      const accepted: NarrationField[] = [];
      for (const entry of input.fields) {
        if (!isNarrationField(entry)) {
          // Named separately from the generic enum message: asking a model for
          // `constraints` is the one value here that would move policy, so it gets
          // said outright rather than left for the operator to infer from a list.
          const governance = GOVERNANCE_FIELD_NAMES.includes(String(entry).toLowerCase());
          add(
            'fields',
            'enum',
            governance
              ? `"${String(entry)}" is a governance field and can never be requested from a model. ` +
                `Allowed: ${NARRATION_FIELDS.join(', ')}.`
              : `must be one of ${NARRATION_FIELDS.join(', ')}, got ${typeName(entry)}`,
          );
          continue;
        }
        accepted.push(entry);
      }
      fields = Object.freeze([...new Set(accepted)]);
    }
  }

  const intField = (
    key: 'minTokens' | 'timeoutMs' | 'maxOutputTokens',
    fallback: number,
    min: number,
  ): number => {
    const value = input[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'number') {
      add(key, 'type', `must be a number, got ${typeName(value)}`);
      return fallback;
    }
    if (!Number.isInteger(value) || value < min) {
      add(key, 'range', `must be a whole number >= ${min}, got ${value}`);
      return fallback;
    }
    return value;
  };

  const minTokens = intField('minTokens', DISABLED_NARRATION_CONFIG.minTokens, 0);
  const timeoutMs = intField('timeoutMs', DISABLED_NARRATION_CONFIG.timeoutMs, 1);
  const maxOutputTokens = intField(
    'maxOutputTokens',
    DISABLED_NARRATION_CONFIG.maxOutputTokens,
    1,
  );

  if (issues.length > 0) return { ok: false, issues: Object.freeze(issues) };
  return {
    ok: true,
    config: Object.freeze({
      enabled,
      backend,
      model,
      baseUrl,
      fields,
      minTokens,
      timeoutMs,
      maxOutputTokens,
      allowNonLoopback,
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                       */
/* -------------------------------------------------------------------------- */

export type OllamaErrorCode =
  /** Nothing is listening. */
  | 'ollama_unreachable'
  /** Ollama answered; it does not have that model. */
  | 'model_not_found'
  /** No answer inside `timeoutMs`. */
  | 'ollama_timeout'
  /** A status or a body that cannot be used. */
  | 'ollama_bad_response'
  /** The transport threw something that is not classifiable. */
  | 'ollama_transport_error'
  /** The base URL is not loopback and the operator has not said it is theirs. */
  | 'ollama_not_loopback';

export abstract class OllamaError extends Error {
  readonly code: OllamaErrorCode;
  readonly baseUrl: string;

  constructor(code: OllamaErrorCode, baseUrl: string, message: string) {
    super(message);
    this.name = 'OllamaError';
    this.code = code;
    this.baseUrl = baseUrl;
  }

  /**
   * The same error, with any echo of `sent` taken out of the message.
   *
   * `message` is the string that reaches a log, and two of these carry text that
   * came from outside this module: the server's body and the model's completion. So
   * the caller hands back what it sent and gets back an error that cannot quote the
   * transcript, rather than trusting both ends of a socket it does not own.
   *
   * Returns `this` when nothing overlaps, so an error with nothing to redact costs
   * no allocation and no copy.
   */
  abstract redact(sent: string): OllamaError;
}

export class OllamaUnreachableError extends OllamaError {
  /** The syscall code, or null when the transport did not report one. */
  readonly syscall: string | null;

  constructor(baseUrl: string, syscall: string | null) {
    super(
      'ollama_unreachable',
      baseUrl,
      `No Ollama is answering at ${baseUrl}${syscall === null ? '' : ` (${syscall})`}. ` +
        'Start one with "ollama serve", or point local_model.baseUrl at the host it is bound to.',
    );
    this.name = 'OllamaUnreachableError';
    this.syscall = syscall;
  }

  /** Carries a URL and a syscall, not text, so there is nothing to take out. */
  redact(_sent: string): OllamaUnreachableError {
    return this;
  }
}

export class OllamaModelNotFoundError extends OllamaError {
  readonly model: string;

  constructor(baseUrl: string, model: string) {
    super(
      'model_not_found',
      baseUrl,
      `Ollama at ${baseUrl} does not have the model "${model}". ` +
        `Run "ollama pull ${model}", or "ollama list" to see what is installed.`,
    );
    this.name = 'OllamaModelNotFoundError';
    this.model = model;
  }

  /** Carries a model name the operator typed, not text from the transcript. */
  redact(_sent: string): OllamaModelNotFoundError {
    return this;
  }
}

export class OllamaTimeoutError extends OllamaError {
  readonly timeoutMs: number;

  constructor(baseUrl: string, timeoutMs: number) {
    super(
      'ollama_timeout',
      baseUrl,
      `Ollama at ${baseUrl} did not answer within ${timeoutMs}ms. The first call for a ` +
        'model also pays its load time, so a cold model can exceed a warm budget: ' +
        'raise local_model.timeoutMs, or pre-warm with "ollama run" once.',
    );
    this.name = 'OllamaTimeoutError';
    this.timeoutMs = timeoutMs;
  }

  /** Carries a URL and a budget, not text. */
  redact(_sent: string): OllamaTimeoutError {
    return this;
  }
}

export class OllamaBadResponseError extends OllamaError {
  /** 0 when there was no status at all (an unparseable body on a 2xx). */
  readonly status: number;
  /** Bounded excerpt of what came back, with any echo of the request taken out. */
  readonly detail: string;

  constructor(baseUrl: string, status: number, detail: string) {
    super(
      'ollama_bad_response',
      baseUrl,
      `Ollama at ${baseUrl} returned something unusable${status === 0 ? '' : ` (HTTP ${status})`}: ${detail}`,
    );
    this.name = 'OllamaBadResponseError';
    this.status = status;
    this.detail = detail;
  }

  redact(sent: string): OllamaBadResponseError {
    const detail = redactEcho(this.detail, sent);
    return detail === this.detail
      ? this
      : new OllamaBadResponseError(this.baseUrl, this.status, detail);
  }
}

export class OllamaTransportError extends OllamaError {
  readonly detail: string;

  constructor(baseUrl: string, detail: string) {
    super(
      'ollama_transport_error',
      baseUrl,
      `The HTTP transport for Ollama at ${baseUrl} threw something that is not a connection ` +
        `failure and not a timeout, so the cause is unknown: ${detail}`,
    );
    this.name = 'OllamaTransportError';
    this.detail = detail;
  }

  /** The transport is a caller-supplied function, so its throw is caller text. */
  redact(sent: string): OllamaTransportError {
    const detail = redactEcho(this.detail, sent);
    return detail === this.detail ? this : new OllamaTransportError(this.baseUrl, detail);
  }
}

export class OllamaNotLoopbackError extends OllamaError {
  constructor(baseUrl: string) {
    super(
      'ollama_not_loopback',
      baseUrl,
      `Refusing to send the transcript to ${baseUrl}: Tier 3 narration hands context to another ` +
        'process, and a non-loopback host turns that into egress (N4). Set ' +
        'local_model.allowNonLoopback to true if that host is yours.',
    );
    this.name = 'OllamaNotLoopbackError';
  }

  /** Carries a URL, not text. */
  redact(_sent: string): OllamaNotLoopbackError {
    return this;
  }
}

/* -------------------------------------------------------------------------- */
/* The transport                                                                */
/* -------------------------------------------------------------------------- */

export interface OllamaHttpRequest {
  readonly url: string;
  readonly method: 'POST' | 'GET';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /**
   * Carries the budget. The adapter does not own a timer: a `fetch` transport
   * honours `AbortSignal.timeout`, and a fake transport in a test can ignore it,
   * which is why the timeout is a *classification* below rather than a race here.
   */
  readonly signal?: AbortSignal;
}

export interface OllamaHttpResponse {
  readonly status: number;
  readonly body: string;
}

/** The whole of the I/O surface. One function, so a test can be one function. */
export type OllamaHttpClient = (request: OllamaHttpRequest) => Promise<OllamaHttpResponse>;

export interface FetchLikeInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface FetchLikeResponse {
  readonly status: number;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init?: FetchLikeInit) => Promise<FetchLikeResponse>;

/**
 * Adapt a `fetch`-shaped function to the transport, so production wiring is one
 * argument and this module still never names a global. `server.ts` already holds
 * a `fetch` reference; passing it in keeps the choice of egress capability in the
 * composition root, which is the only place that knows what the process is allowed
 * to reach.
 */
export function ollamaClientFromFetch(fetchImpl: FetchLike): OllamaHttpClient {
  return async (request) => {
    const init: FetchLikeInit = {
      method: request.method,
      headers: { ...request.headers },
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    };
    const response = await fetchImpl(request.url, init);
    return { status: response.status, body: await response.text() };
  };
}

/* -------------------------------------------------------------------------- */
/* Request shaping                                                              */
/* -------------------------------------------------------------------------- */

export interface OllamaChatMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

export interface OllamaChatOptions {
  /** Always 0. See `buildNarrationRequest`. */
  readonly temperature: 0;
  readonly num_predict: number;
}

/** The subset of `/api/chat` this module sends. Not the whole API. */
export interface OllamaChatRequest {
  readonly model: string;
  readonly messages: readonly OllamaChatMessage[];
  readonly stream: false;
  readonly format: 'json';
  readonly options: OllamaChatOptions;
}

const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'application/json',
});

const FIELD_INSTRUCTIONS: Readonly<Record<NarrationField, string>> = Object.freeze({
  goal: '"goal": one sentence saying what this stretch of work was for.',
  decided:
    '"decided": array of objects, each {"id": "D1", "choice": what was chosen, "why": the reason}.',
  unresolved: '"unresolved": array of strings; the open questions that must survive.',
  next:
    '"next": object {"question": string, "next_command": string, "blockers": array of strings}.',
});

const JSON_PREAMBLE = [
  'You are compressing part of a coding session so a later turn can pick it up.',
  'Answer with one JSON object and nothing else: no prose, no code fence.',
].join(' ');

/**
 * The instruction, assembled from the fields actually requested.
 *
 * Per-field rather than one fixed prompt: a request for `goal` alone should not
 * pay tokens for three unused keys, and a 1B model's accuracy on a four-key schema
 * is worse than on a one-key one. The governance sentence is unconditional -- it is
 * not a field the operator asked for, it is a property of the request.
 */
export function buildNarrationInstruction(fields: readonly NarrationField[]): string {
  return [
    JSON_PREAMBLE,
    `Keys: ${fields.join(', ')}.`,
    ...fields.map((f) => FIELD_INSTRUCTIONS[f]),
    'Rules, policies and constraints are stored separately and are not yours to write: never emit them.',
  ].join('\n');
}

/**
 * Delete every pinned constraint from text on its way to a model.
 *
 * Not belt-and-braces: the model has read the pin set by the time a narration
 * happens, so it can quote a constraint back inside an ordinary sentence, and a
 * constraint inside a summarisable region becomes policy the compactor may
 * paraphrase. `Gist.constraints` exists to be byte-compared, and a summariser that
 * could write one would make that comparison a tautology. Same rule and same reason
 * as `stripGovernance` in `pipeline/src/self-gist.ts`, which this cannot import (P1).
 */
export function stripGovernanceText(text: string, governance: readonly string[]): string {
  let out = text;
  for (const raw of governance) {
    const needle = raw.trim();
    if (needle.length === 0) continue;
    out = out.replaceAll(needle, '');
  }
  return out;
}

/**
 * The request, as bytes on the wire.
 *
 * Four choices, none of them defaults:
 *
 * - **`stream: false`.** Nothing is waiting on this call. It happens inside the
 *   compaction transaction, after the agent's own response is complete, and a
 *   streaming completion would mean a second NDJSON parser for a value that is
 *   read once, whole. It also cannot touch N3: N3 is about the agent's first-token
 *   delta, and this call is not on that path at all.
 * - **`format: 'json'`.** The completion is machine-read, so it is asked for as
 *   JSON rather than requested politely in prose. Requested, not depended on --
 *   an Ollama that ignores it still produces something the parser can usually
 *   read, and `parseNarrationReply` handles a fenced body for the same reason.
 * - **`temperature: 0`.** The output feeds a transaction whose one hard check is a
 *   byte comparison, and the whole product is built on the same input producing the
 *   same output. This does not make the completion deterministic -- a local model
 *   at temperature 0 is not a function -- but it removes sampling as a source of
 *   variance we did not ask for.
 * - **The transcript is the user turn.** Ollama has no separate system field worth
 *   the contortion; `role: 'system'` carries the instruction and the transcript
 *   arrives as the user turn, which is what the endpoint expects.
 *
 * The loopback check is re-read here rather than trusted from the config: a config
 * object can be built by hand, and this is the last point before context leaves.
 */
export function buildNarrationRequest(
  config: NarrationConfig,
  text: string,
  governance: readonly string[] = [],
): OllamaHttpRequest {
  const parsed = parseBaseUrl(config.baseUrl);
  if (parsed === undefined) {
    throw new OllamaBadResponseError(config.baseUrl, 0, `baseUrl is not an http(s) URL: "${config.baseUrl}"`);
  }
  if (!isLoopbackHost(parsed.hostname) && !config.allowNonLoopback) {
    throw new OllamaNotLoopbackError(config.baseUrl);
  }

  const body: OllamaChatRequest = {
    model: config.model,
    messages: [
      { role: 'system', content: buildNarrationInstruction(config.fields) },
      { role: 'user', content: stripGovernanceText(text, governance) },
    ],
    stream: false,
    format: 'json',
    options: { temperature: 0, num_predict: config.maxOutputTokens },
  };

  // `origin` would drop a path prefix an operator put in `baseUrl` for a reverse
  // proxy in front of Ollama, and silently talking to the wrong place is worse than
  // honouring the whole string.
  return {
    url: `${config.baseUrl.replace(/\/+$/, '')}/api/chat`,
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  };
}

/* -------------------------------------------------------------------------- */
/* Response parsing                                                             */
/* -------------------------------------------------------------------------- */

export type NarrationDefectKind =
  /** A key that is neither a narration field nor a governance key. */
  | 'unknown_field'
  /** A `decided` entry that is not `{id, choice}` with a non-empty choice. */
  | 'malformed_decision'
  /** `next` was not an object of the three documented keys. */
  | 'malformed_next'
  /** `decided` was not an array at all. */
  | 'malformed_decision_list'
  /** No non-empty `goal`, so the gist schema's minimum is not met. */
  | 'no_goal'
  /** A governance key arrived and was dropped. See the module header. */
  | 'governance_ignored';

export interface NarrationDefect {
  readonly kind: NarrationDefectKind;
  /** Never rendered into the narrative. For telemetry and the test suite. */
  readonly detail: string;
}

const defect = (kind: NarrationDefectKind, detail: string): NarrationDefect => ({ kind, detail });

/** Mirrors `GistDecision`; kept local because P1 forbids the cross-stream import. */
export interface NarrationDecision {
  readonly id: string;
  readonly choice: string;
  readonly why: string;
}

/** Mirrors `GistNext`. */
export interface NarrationNext {
  readonly question: string;
  readonly nextCommand: string;
  readonly blockers: readonly string[];
}

/**
 * The narrative half of a gist, in the shape C-1 assembles. There is no
 * `constraints` member and there cannot be: see the module header.
 */
export interface NarrationNarrative {
  readonly goal: string;
  readonly decided: readonly NarrationDecision[];
  readonly unresolved: readonly string[];
  readonly next: NarrationNext;
}

const EMPTY_NARRATIVE: NarrationNarrative = Object.freeze({
  goal: '',
  decided: Object.freeze([]),
  unresolved: Object.freeze([]),
  next: Object.freeze({ question: '', nextCommand: '', blockers: Object.freeze([]) }),
});

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * A list field that arrived as a bare string. Normalising rather than rejecting:
 * a single unresolved question *is* a one-element list, and the two spellings are
 * the same answer, not a different claim about the session.
 */
const lines = (v: unknown): string[] => {
  if (typeof v === 'string') {
    const one = v.trim();
    return one.length === 0 ? [] : [one];
  }
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const entry of v) {
    const line = str(entry);
    if (line.length > 0) out.push(line);
  }
  return out;
};

function parseDecided(
  value: unknown,
  defects: NarrationDefect[],
): NarrationDecision[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    defects.push(defect('malformed_decision_list', `decided was ${typeof value}, not an array`));
    return [];
  }
  const out: NarrationDecision[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      defects.push(
        defect(
          'malformed_decision',
          `decided[${index}] was ${entry === null ? 'null' : typeof entry}, not an object`,
        ),
      );
      return;
    }
    const choice = str(entry['choice']);
    if (choice.length === 0) {
      defects.push(defect('malformed_decision', `decided[${index}] carried no choice`));
      return;
    }
    // A missing id becomes a positional label. That is a key, not a claim: C-1
    // renumbers before it commits, and a fabricated *decision* would be a lie
    // where a fabricated ordinal is not.
    const id = str(entry['id']) || `D${index + 1}`;
    out.push({ id, choice, why: str(entry['why']) });
  });
  return out;
}

function parseNext(value: unknown, defects: NarrationDefect[]): NarrationNext {
  if (value === undefined) return EMPTY_NARRATIVE.next;
  if (!isRecord(value)) {
    defects.push(defect('malformed_next', `next was ${value === null ? 'null' : typeof value}, not an object`));
    return EMPTY_NARRATIVE.next;
  }
  return {
    question: str(value['question']),
    nextCommand: str(value['next_command']),
    blockers: lines(value['blockers']),
  };
}

function parseNarrative(
  obj: Record<string, unknown>,
  fields: readonly NarrationField[],
  defects: NarrationDefect[],
): NarrationNarrative {
  for (const key of Object.keys(obj).sort()) {
    const lower = key.toLowerCase();
    if (GOVERNANCE_FIELD_NAMES.includes(lower)) {
      defects.push(defect('governance_ignored', `dropped "${key}" from the completion`));
    } else if (!isNarrationField(key)) {
      // Observed in the wild, not invented: gemma3:1b invented `next_decided`
      // alongside a `decided` it had already answered.
      defects.push(defect('unknown_field', key));
    }
  }

  const goal = str(obj['goal']);
  if (goal.length === 0) defects.push(defect('no_goal', 'the gist schema requires a non-empty goal'));

  // A field the operator did not request is ignored without a defect: we did not
  // ask for it, so the model volunteering it is not a fault worth reporting.
  const asked = new Set<string>(fields);
  const decided = asked.has('decided') ? parseDecided(obj['decided'], defects) : [];
  const unresolved = asked.has('unresolved') ? lines(obj['unresolved']) : [];
  const next = asked.has('next') ? parseNext(obj['next'], defects) : EMPTY_NARRATIVE.next;

  return {
    goal: asked.has('goal') ? goal : '',
    decided,
    unresolved,
    next,
  };
}

export interface NarrationUsage {
  /** Ollama's own counters. The only real token counts available here. */
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly doneReason: string | null;
}

const intOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export interface NarrationParsed {
  readonly narrative: NarrationNarrative;
  /** Mirrors `Gist.status`: 'partial' when a defect cost us content. */
  readonly completeness: 'complete' | 'partial';
  /**
   * False when `goal` is empty. `GistSchema` requires a non-empty goal, so a
   * narration without one cannot be committed and is the same thing as no
   * narration; carried here so the caller does not have to re-derive it and
   * discover it as a schema failure three steps later.
   */
  readonly usable: boolean;
  readonly defects: readonly NarrationDefect[];
}

/**
 * Parse the completion into a narrative. Total: it records defects instead of
 * throwing for anything a model can plausibly produce.
 *
 * The one thing it does refuse is a completion that is not JSON at all, and that
 * throws -- because there is no partial narrative to salvage from it, and
 * reporting "narrated, everything empty" for a body of English prose would make
 * an unusable answer look like a used one.
 *
 * `fields` gates what is read. `promptTokens`/`completionTokens` are lifted from
 * Ollama's `prompt_eval_count`/`eval_count` because they are the only *measured*
 * counts available; `token-estimator.ts` exists to say when a ratio estimate is
 * good enough, and a published number must never come from one.
 */
export function parseNarrationReply(
  config: NarrationConfig,
  reply: unknown,
  fields: readonly NarrationField[] = config.fields,
): NarrationParsed & { readonly usage: NarrationUsage | null } {
  if (!isRecord(reply)) {
    throw new OllamaBadResponseError(
      config.baseUrl,
      200,
      `the response was ${typeName(reply)}, not a JSON object`,
    );
  }
  const message = isRecord(reply['message']) ? reply['message'] : undefined;
  const content = message === undefined ? '' : str(message['content']);
  if (content.length === 0) {
    throw new OllamaBadResponseError(config.baseUrl, 200, 'the completion carried no message content');
  }

  const obj = parseCompletionObject(config, content);
  const defects: NarrationDefect[] = [];
  const narrative = parseNarrative(obj, fields, defects);

  const promptTokens = intOrNull(reply['prompt_eval_count']);
  const completionTokens = intOrNull(reply['eval_count']);
  const doneReason = str(reply['done_reason']);

  return {
    narrative,
    completeness: defects.length === 0 ? 'complete' : 'partial',
    usable: narrative.goal.length > 0,
    defects,
    usage:
      promptTokens === null && completionTokens === null
        ? null
        : {
            promptTokens: promptTokens ?? 0,
            completionTokens: completionTokens ?? 0,
            doneReason: doneReason.length === 0 ? null : doneReason,
          },
  };
}

/** Bounded excerpt of an unusable body. Never the request, and never unbounded. */
const SNIPPET_CHARS = 200;

const snippet = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= SNIPPET_CHARS ? flat : `${flat.slice(0, SNIPPET_CHARS)}...`;
};

/**
 * Longest run of text considered "a leak". Chosen against `SNIPPET_CHARS`: a
 * shorter run would start eating ordinary English that happens to coincide, and a
 * longer one would let a 200-char excerpt quote half a file path out of the span.
 */
const ECHO_WINDOW = 24;

/**
 * Remove from `excerpt` anything that also appears in what was sent.
 *
 * Two echoes are reachable and neither is ours. A server can answer with the
 * request quoted back (`{"error":"cannot handle: <the whole prompt>"}`), and a model
 * can answer with the prompt quoted back -- then the JSON parse fails and the
 * excerpt goes into the error. `message` is what gets logged, so a bounded excerpt
 * of the transcript is still the transcript.
 *
 * Scans the excerpt for windows that the transcript contains, which is O(excerpt x
 * transcript) through `includes` -- bounded above by `SNIPPET_CHARS` and only ever
 * paid on the failure path. Replacing windows rather than dropping the excerpt
 * keeps the part of the message that is actually diagnostic.
 */
function redactEcho(excerpt: string, sent: string): string {
  let out = excerpt;
  for (let i = 0; i + ECHO_WINDOW <= out.length; i += 1) {
    if (sent.includes(out.slice(i, i + ECHO_WINDOW))) {
      out = `${out.slice(0, i)}[redacted]${out.slice(i + ECHO_WINDOW)}`;
    }
  }
  return out;
}

const parseCompletionObject = (config: NarrationConfig, content: string): Record<string, unknown> => {
  const unfenced = unfence(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unparseable';
    throw new OllamaBadResponseError(config.baseUrl, 0, `the completion was not JSON (${detail}): ${snippet(content)}`);
  }
  if (!isRecord(parsed)) {
    throw new OllamaBadResponseError(config.baseUrl, 0, `the completion was ${typeName(parsed)}, not an object`);
  }
  return parsed;
};

/**
 * Strip one ``` fence pair if the whole completion is wrapped in one.
 *
 * Tolerance, not cleverness: `format: 'json'` constrains Ollama's decoder, not
 * whatever an older build or a different backend does, and a machine whose
 * narration never works because of a leading fence is a machine that turns the
 * feature off. A fence in the *middle* of the body is left alone -- that is
 * content, not framing.
 */
function unfence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const firstNewline = trimmed.indexOf('\n');
  if (firstNewline === -1) return trimmed;
  const closing = trimmed.lastIndexOf('```');
  if (closing <= firstNewline) return trimmed;
  return trimmed.slice(firstNewline + 1, closing).trim();
}

/* -------------------------------------------------------------------------- */
/* The gate                                                                     */
/* -------------------------------------------------------------------------- */

export type NarrationHoldReason =
  /** `enabled` is not true. The only reason that needs no further argument. */
  | 'disabled'
  /** Below (or exactly at) the token floor. */
  | 'below_min_tokens'
  /** Nothing was asked for. */
  | 'no_fields'
  /** Nothing to narrate. */
  | 'no_text';

/**
 * Everything a narration attempt can report: why it held, that it ran, or how it
 * failed. Exported because the `compaction` event's `trigger` needs exactly this
 * union, and the event is the gateway's to wire, not this module's.
 */
export type NarrationReason = NarrationHoldReason | 'ready' | OllamaErrorCode;

export interface ShouldNarrateInput {
  readonly config: NarrationConfig;
  /**
   * The caller's token estimate for the span. Not re-estimated here: this package
   * does not own a ratio, and a second estimator in this module would be one more
   * constant nobody re-fits when `TODO(WS-A, A-6)` re-fits `TOKEN_PROVIDERS`.
   */
  readonly tokens: number;
  /** The span itself. An empty one is a hold, not a wasted model call. */
  readonly text?: string;
}

/**
 * Pure pre-flight, and the only place the opt-in is decided. The gateway edge
 * already has the estimate -- it has to, the compaction trigger is computed from
 * it -- so the gate reads a number rather than inventing one.
 *
 * A union rather than a `fire: boolean`, so a caller that has checked `fire` gets
 * the hold reason narrowed with it and does not have to remember that `ready` is
 * not a hold. Named for the gate rather than reusing `NarrationDecision`, which is
 * a decision the *model* made.
 */
export type NarrationGateDecision =
  | {
      readonly fire: false;
      readonly reason: NarrationHoldReason;
      readonly tokens: number;
      readonly fields: readonly NarrationField[];
    }
  | {
      readonly fire: true;
      readonly reason: 'ready';
      readonly tokens: number;
      readonly fields: readonly NarrationField[];
    };

export function shouldNarrate(input: ShouldNarrateInput): NarrationGateDecision {
  const { config, tokens } = input;
  const base = { tokens, fields: config.fields };
  const hold = (reason: NarrationHoldReason): NarrationGateDecision => ({
    fire: false,
    reason,
    ...base,
  });
  // First, because it is the only check whose failure makes the rest moot: a
  // disabled Tier 3 must not narrate even when everything else says it could.
  if (!config.enabled) return hold('disabled');
  if (config.fields.length === 0) return hold('no_fields');
  if (input.text !== undefined && input.text.trim().length === 0) return hold('no_text');
  // `>`, not `>=`: architecture §4 puts the floor at ">5k tokens", and a compressor
  // that runs at exactly the break-even is running where the architecture says it
  // loses.
  if (tokens <= config.minTokens) return hold('below_min_tokens');
  return { fire: true, reason: 'ready', ...base };
}

/* -------------------------------------------------------------------------- */
/* The result                                                                   */
/* -------------------------------------------------------------------------- */

export interface NarrationSuccess {
  readonly status: 'narrated';
  readonly backend: NarrationBackend;
  readonly model: string;
  readonly narrative: NarrationNarrative;
  readonly completeness: 'complete' | 'partial';
  readonly usable: boolean;
  /** Characters of transcript actually sent, after governance was stripped. */
  readonly promptChars: number;
  /** sha256 of that text: enough to correlate a narration with its input. */
  readonly promptDigest: string;
  readonly usage: NarrationUsage | null;
  readonly defects: readonly NarrationDefect[];
}

export interface NarrationSkip {
  readonly status: 'skipped';
  readonly reason: NarrationHoldReason;
  readonly tokens: number;
  readonly fields: readonly NarrationField[];
  readonly narrative: null;
  readonly usable: false;
}

export interface NarrationFailure {
  readonly status: 'failed';
  /** Always true: N5, and the only thing this stage can contribute is optional. */
  readonly failedOpen: boolean;
  readonly code: OllamaErrorCode;
  readonly error: OllamaError;
  readonly narrative: null;
  readonly usable: false;
}

export type NarrationResult = NarrationSuccess | NarrationSkip | NarrationFailure;

export interface NarrationInput {
  readonly config: NarrationConfig;
  readonly client: OllamaHttpClient;
  /** The background/retrieval span. Never a governance block. */
  readonly text: string;
  readonly tokens: number;
  /** Pinned constraint text, deleted before the body is serialized. */
  readonly governance?: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Classification                                                               */
/* -------------------------------------------------------------------------- */

/** Names an aborted fetch carries; both mean the same thing to this adapter. */
const TIMEOUT_NAMES: ReadonlySet<string> = new Set(['TimeoutError', 'AbortError']);

/**
 * Connection-level syscall codes. Everything here means "nothing answered",
 * which is the diagnosis; the message carries the code so the operator can tell a
 * refused connection from a reset one.
 */
const UNREACHABLE_SYSCALLS: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
]);

const syscallOf = (err: unknown): string | null => {
  if (!isRecord(err)) return null;
  const code = err['code'];
  return typeof code === 'string' ? code : null;
};

/**
 * `err.cause` chains, bounded. A `fetch` failure is a `TypeError` wrapping an
 * `Error` with the syscall code, and the code is what makes the diagnosis; how
 * deep the chain goes is a runtime detail, so the walk is capped rather than
 * assumed.
 */
const CAUSE_DEPTH = 4;

const errorChain = (err: unknown): unknown[] => {
  const chain: unknown[] = [];
  let cursor: unknown = err;
  for (let i = 0; i < CAUSE_DEPTH && cursor !== undefined && cursor !== null; i += 1) {
    chain.push(cursor);
    cursor = isRecord(cursor) ? cursor['cause'] : undefined;
  }
  return chain;
};

const describeError = (err: unknown): string => {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return typeof err === 'string' ? err : `non-error throw (${typeof err})`;
};

/**
 * Classify a throw. Unknown becomes `ollama_transport_error` on purpose: a
 * taxonomy that maps everything it has not seen onto `ollama_unreachable` tells
 * the operator to restart a server that is running.
 */
function classifyTransportFailure(err: unknown, config: NarrationConfig): OllamaError {
  if (err instanceof OllamaError) return err;
  const chain = errorChain(err);
  for (const link of chain) {
    if (link instanceof Error && TIMEOUT_NAMES.has(link.name)) {
      return new OllamaTimeoutError(config.baseUrl, config.timeoutMs);
    }
  }
  for (const link of chain) {
    const syscall = syscallOf(link);
    if (syscall !== null && UNREACHABLE_SYSCALLS.has(syscall)) {
      return new OllamaUnreachableError(config.baseUrl, syscall);
    }
  }
  return new OllamaTransportError(config.baseUrl, describeError(err));
}

/**
 * Model-not-found, from the body rather than the status.
 *
 * Ollama answers a missing model with `404 {"error":"model 'x' not found"}`
 * (0.14.1, verified locally) and older builds with `model "x" not found, try
 * pulling it first`; both carry the name. Go's router answers a wrong path with
 * `404 page not found`, which carries neither the name nor `try pulling` -- so a
 * status-only rule would report a routing bug as a missing model, which is the
 * kind of false gate AGENTS §10 says gets muted.
 */
const isModelNotFound = (status: number, body: string, model: string): boolean => {
  if (status !== 400 && status !== 404) return false;
  if (/try\s+pulling/i.test(body)) return true;
  return /not[\s-]found/i.test(body) && model.length > 0 && body.includes(model);
};

/** Ollama's error envelope is `{"error": "..."}`; a body without one is excerpted. */
const errorDetailOf = (body: string): string => {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && typeof parsed['error'] === 'string') return parsed['error'];
  } catch {
    // Not JSON. The excerpt below is the honest description of it.
  }
  return snippet(body);
};

function classifyStatusFailure(
  status: number,
  body: string,
  config: NarrationConfig,
): OllamaError {
  if (isModelNotFound(status, body, config.model)) {
    return new OllamaModelNotFoundError(config.baseUrl, config.model);
  }
  return new OllamaBadResponseError(config.baseUrl, status, errorDetailOf(body));
}

/* -------------------------------------------------------------------------- */
/* The call                                                                     */
/* -------------------------------------------------------------------------- */

/** What came back from `/api/chat`, as a value. Narrowed defensively below. */
export type OllamaChatReply = unknown;

function parseReplyBody(config: NarrationConfig, body: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unparseable';
    throw new OllamaBadResponseError(config.baseUrl, 200, `the response body was not JSON (${detail}): ${snippet(body)}`);
  }
  if (!isRecord(parsed)) {
    throw new OllamaBadResponseError(config.baseUrl, 200, `the response body was ${typeName(parsed)}`);
  }
  return parsed;
}

async function callOllama(
  request: OllamaHttpRequest,
  config: NarrationConfig,
  client: OllamaHttpClient,
): Promise<ReturnType<typeof parseNarrationReply>> {
  let response: OllamaHttpResponse;
  try {
    response = await client(request);
  } catch (err) {
    throw classifyTransportFailure(err, config);
  }
  if (response.status < 200 || response.status >= 300) {
    throw classifyStatusFailure(response.status, response.body, config);
  }
  const reply: OllamaChatReply = parseReplyBody(config, response.body);
  return parseNarrationReply(config, reply);
}

/**
 * Narration, opt-in, and total.
 *
 * Never rejects. Every path is one of: the gate held (no I/O at all), the call
 * failed (a typed error on the result), or there is a narrative. That is N5 read
 * literally -- the stage contributes optional narrative fields, so failing open
 * means contributing none and leaving the caller's request exactly as it was --
 * and it is also why a caller does not need a `try` of its own: the first
 * engineer to wire this up would forget, and a forgotten `try` in a compaction
 * transaction is a dropped turn.
 *
 * The input is not mutated, and every error it returns has had any echo of the
 * transcript taken out of it, so a failure cannot leak the context it was about.
 */
export async function narrate(input: NarrationInput): Promise<NarrationResult> {
  const { config, client } = input;
  const decision = shouldNarrate({ config, tokens: input.tokens, text: input.text });
  if (!decision.fire) {
    return {
      status: 'skipped',
      reason: decision.reason,
      tokens: input.tokens,
      fields: config.fields,
      narrative: null,
      usable: false,
    };
  }

  // Stripped once, hashed once, serialized once. The digest is of the text that
  // actually leaves, not of the input: a narration correlated against a digest of
  // text that included a constraint is a correlation of nothing.
  const sent = stripGovernanceText(input.text, input.governance ?? []);

  try {
    const request = buildNarrationRequest(config, input.text, input.governance ?? []);
    const parsed = await callOllama(request, config, client);
    return {
      status: 'narrated',
      backend: config.backend,
      model: config.model,
      narrative: parsed.narrative,
      completeness: parsed.completeness,
      usable: parsed.usable,
      promptChars: sent.length,
      promptDigest: sha256(sent),
      usage: parsed.usage,
      defects: parsed.defects,
    };
  } catch (err) {
    // Redacted on the way out, not on the way in: the server's body and the model's
    // completion both reach `message` from outside this module, and either can quote
    // the prompt back. Whatever survives is still the transcript going in here --
    // except the constraints, which were never sent at all.
    const error =
      err instanceof OllamaError
        ? err.redact(sent)
        : new OllamaTransportError(config.baseUrl, redactEcho(describeError(err), sent));
    return {
      status: 'failed',
      failedOpen: true,
      code: error.code,
      error,
      narrative: null,
      usable: false,
    };
  }
}

/**
 * The installed models, for a status surface or an operator's first question.
 *
 * A separate call rather than part of the error path on purpose: an error that
 * performs I/O to build its own message is an error that can hang while reporting,
 * and the actionable fix ("`ollama pull <model>`") does not need it. Throws the
 * same typed errors as `narrate`.
 */
export async function listOllamaModels(
  config: NarrationConfig,
  client: OllamaHttpClient,
): Promise<readonly string[]> {
  const parsed = parseBaseUrl(config.baseUrl);
  if (parsed === undefined) {
    throw new OllamaBadResponseError(config.baseUrl, 0, `baseUrl is not an http(s) URL: "${config.baseUrl}"`);
  }
  if (!isLoopbackHost(parsed.hostname) && !config.allowNonLoopback) {
    throw new OllamaNotLoopbackError(config.baseUrl);
  }
  const request: OllamaHttpRequest = {
    url: `${config.baseUrl.replace(/\/+$/, '')}/api/tags`,
    method: 'GET',
    headers: JSON_HEADERS,
    signal: AbortSignal.timeout(config.timeoutMs),
  };
  let response: OllamaHttpResponse;
  try {
    response = await client(request);
  } catch (err) {
    throw classifyTransportFailure(err, config);
  }
  if (response.status < 200 || response.status >= 300) {
    throw classifyStatusFailure(response.status, response.body, config);
  }
  const body = parseReplyBody(config, response.body);
  const raw = Array.isArray(body['models']) ? body['models'] : [];
  const names: string[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const name = str(entry['name']);
    if (name.length > 0) names.push(name);
  }
  return Object.freeze(names);
}