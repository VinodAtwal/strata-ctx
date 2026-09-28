import type { RedactionPolicy } from '@strata-ctx/core-types';
import { sha256 } from '@strata-ctx/core-types';

import type { Confidence, SecretKind } from './patterns.js';
import { SECRET_PATTERNS, placeholderFor } from './patterns.js';
import type { EntropyOptions } from './entropy.js';
import { DEFAULT_ENTROPY_OPTIONS, analyzeEntropy } from './entropy.js';

/**
 * I-1: the redaction engine. Pattern matching plus entropy, four modes, and a
 * persistence gate that is separate from all of them.
 *
 * ## The rule that shapes this file
 *
 * A redactor is judged on one thing: after it runs, the secret is not anywhere
 * downstream. So every design choice here is about *where* the redaction has to
 * have happened, and none of them is about being clever:
 *
 * 1. **Deterministic patterns are the defence.** Entropy is a second pass. The
 *    catalogue can be reasoned about -- every entry has a shape that admits no
 *    innocent reading -- and entropy cannot.
 * 2. **Findings carry no secret and no offsets.** A finding is a
 *    telemetry-shaped value, and telemetry-shaped values get logged, shipped to
 *    a dashboard and pasted into an issue. Carrying `secret` or even a byte
 *    offset would turn "we redacted it" into "here is where it is". A digest of
 *    the secret is enough to correlate against a candidate an operator already
 *    suspects, and it discloses nothing to anyone else.
 * 3. **The placeholder leaks nothing.** No prefix, no suffix, no length, no
 *    family. See `placeholderFor` in ./patterns.ts.
 * 4. **The store gate is not the mode.** `redaction.mode: 'off'` means "do not
 *    rewrite the text". It does *not* mean "a secret may be persisted": a
 *    persistence sink refuses a write that still contains a certain-confidence
 *    secret regardless of mode, which is the same fail-closed rule stream G
 *    applies to telemetry in `packages/telemetry/src/redact.ts` and for the same
 *    reason. `mode` and the persistence gate are two different controls and
 *    conflating them is how a "redaction: off" line in a config file silently
 *    becomes a credential on disk.
 *
 * ## Modes
 *
 * | mode         | text rewritten | findings reported | throw |
 * |--------------|----------------|-------------------|-------|
 * | `off`        | no             | no                | no    |
 * | `log`        | no             | yes               | no    |
 * | `placeholder`| yes            | yes               | no    |
 * | `block`      | yes            | yes               | on any eligible finding |
 *
 * `log` exists so a deployment can measure its own false-positive rate (E6)
 * before trusting the rewriting, and `block` exists for the one place where
 * continuing is worse than failing: a gist that must not be committed.
 *
 * ## Why the frozen policy enum needs a mapping
 *
 * `RedactionPolicySchema.mode` in core-types is `off | log | block` -- there is
 * no `placeholder`. The weakest thing that frozen enum can ask for is `log`, and
 * `log` under this engine rewrites nothing, so a default policy would write
 * unredacted artifacts. `redactionModeFromPolicy` therefore maps the frozen
 * `log` onto the engine's `placeholder`: a policy can turn rewriting *off*
 * explicitly, and can never turn it off by accident.
 */

export type RedactionMode = 'off' | 'log' | 'placeholder' | 'block';

/** Higher is stronger. Used for `minConfidence` and for the persistence gate. */
const RANK: Readonly<Record<Confidence, number>> = { certain: 3, probable: 2, possible: 1 };

export const rankOf = (c: Confidence): number => RANK[c];

export interface RedactionFinding {
  readonly ruleId: string;
  readonly kind: SecretKind;
  readonly confidence: Confidence;
  /**
   * Length of the matched secret. Reported because an operator needs to know
   * whether a 40-character AWS secret and a 20-character key id were the same
   * finding; it is deliberately the *only* size-ish datum exposed, and it is
   * useless on its own.
   */
  readonly length: number;
  /**
   * `sha256` of the secret, so an operator holding a suspected credential can
   * confirm a match by hashing it locally. Not reversible, and identical for
   * identical secrets -- the one property a redactor actually wants to avoid
   * publishing is a *per-finding* value that identifies a specific secret to a
   * third party, which is why this is a hash and not a prefix.
   */
  readonly digest: string;
}

export interface RedactionResult {
  readonly text: string;
  readonly changed: boolean;
  readonly findings: readonly RedactionFinding[];
}

export interface RedactionOptions {
  readonly mode: RedactionMode;
  /**
   * Default `probable`. `certain` keeps only shapes with no innocent reading;
   * `possible` additionally accepts an unlabelled high-entropy token, which is
   * the setting most likely to eat a lockfile integrity hash.
   */
  readonly minConfidence: Confidence;
  readonly entropy: Partial<EntropyOptions>;
  /**
   * Shared with the pattern catalogue's `rejectValue`, so a `password=changeme`
   * in a README is not a finding in either layer. Resolved once, below, so the
   * two layers cannot disagree about the same value.
   */
  readonly allowDocPlaceholders: boolean;
}

export const DEFAULT_REDACTION_OPTIONS: RedactionOptions = {
  mode: 'placeholder',
  minConfidence: 'probable',
  entropy: {},
  allowDocPlaceholders: DEFAULT_ENTROPY_OPTIONS.allowDocPlaceholders,
};

/**
 * A certain-confidence secret survived redaction and was about to be persisted.
 *
 * The counterpart to the product's fail-open default, and the exception to it.
 * Failing open is right for context (losing a user's context to a bug is
 * catastrophic) and wrong for a write (writing a credential to a file the user
 * believes is local costs them the product's central claim, N4).
 */
export class SecretLeakError extends Error {
  readonly kinds: readonly SecretKind[];

  constructor(kinds: readonly SecretKind[], detail: string) {
    super(`refusing to persist ${kinds.join(', ')} (${detail})`);
    this.name = 'SecretLeakError';
    this.kinds = kinds;
  }
}

/** `block` mode refused to process text containing an eligible finding. */
export class SecretBlockedError extends Error {
  readonly findings: readonly RedactionFinding[];

  constructor(findings: readonly RedactionFinding[]) {
    super(
      `redaction blocked: ${findings.map((f) => `${f.ruleId}(${f.confidence})`).join(', ')}`,
    );
    this.name = 'SecretBlockedError';
    this.findings = findings;
  }
}

/**
 * Resolve the entropy options once, folding the top-level
 * `allowDocPlaceholders` in so the pattern layer and the entropy layer cannot
 * be configured to disagree about `changeme`.
 */
export function resolveEntropyOptions(options: RedactionOptions): EntropyOptions {
  return {
    ...DEFAULT_ENTROPY_OPTIONS,
    ...options.entropy,
    allowDocPlaceholders: options.allowDocPlaceholders,
  };
}

export function optionsFromPolicy(
  policy: RedactionPolicy,
  over: Partial<RedactionOptions> = {},
): RedactionOptions {
  return { ...DEFAULT_REDACTION_OPTIONS, mode: redactionModeFromPolicy(policy), ...over };
}

/**
 * `log` on the frozen policy means "placeholder" here, for the reason in the
 * module header: `log` is the *default* frozen value, and a default that leaves
 * artifacts unredacted is a default that fails F18.
 */
export function redactionModeFromPolicy(policy: RedactionPolicy): RedactionMode {
  return policy.mode === 'off' ? 'off' : policy.mode === 'block' ? 'block' : 'placeholder';
}

interface Span {
  readonly start: number;
  readonly end: number;
  readonly ruleId: string;
  readonly kind: SecretKind;
  readonly confidence: Confidence;
  /** Catalogue index: the tiebreak that lets a specific shape beat a generic one. */
  readonly order: number;
}

/**
 * Assert the catalogue is self-consistent before it is used.
 *
 * The bug this exists to catch is real and was in this file's first draft: a
 * `secretGroup` index that pointed one group too high blanks the *wrong*
 * characters, and nothing fails -- the text comes out plausible and the secret
 * is still there. Checking at construction turns a silent leak into a startup
 * error. Cheap: once per engine, and only because the catalogue is fixed.
 */
export function assertCatalogueWellFormed(
  patterns: readonly SecretPatternLike[] = SECRET_PATTERNS,
): void {
  for (const p of patterns) {
    if (!p.regex.flags.includes('g')) {
      throw new Error(`secret pattern ${p.id} must carry the g flag`);
    }
    // Appending `|` makes an empty alternative match, which is the only way to
    // count capture groups of a pattern that does not match the empty string.
    // A fresh RegExp each time: `lastIndex` on a shared /g instance is stateful,
    // and a pattern that only "works" on its first call misses on the second.
    const groups = new RegExp(`${p.regex.source}|`, p.regex.flags).exec('');
    const available = groups === null ? 0 : groups.length - 1;
    if (p.secretGroup > available) {
      throw new Error(
        `secret pattern ${p.id} declares secretGroup ${p.secretGroup}, but it has ${available} capture group(s)`,
      );
    }
  }
}

/** Structural view of a catalogue entry, so the assertion above can be tested with a bad one. */
export interface SecretPatternLike {
  readonly id: string;
  readonly regex: RegExp;
  readonly secretGroup: number;
}

/**
 * Span priority. Ordered so the winner is chosen on the property that matters:
 *
 * 1. **confidence** -- a certain PEM header must not lose its span to a
 *    high-entropy token that happens to overlap it.
 * 2. **length** -- where a specific and a generic rule match the same text from
 *    the same offset (`sk-ant-...` and `sk-...`), the longer span is the more
 *    complete redaction.
 * 3. **catalogue order** -- `anthropic_api_key` before `openai_style_key`.
 */
const better = (a: Span, b: Span): boolean => {
  if (RANK[a.confidence] !== RANK[b.confidence]) return RANK[a.confidence] > RANK[b.confidence];
  if (a.end - a.start !== b.end - b.start) return a.end - a.start > b.end - b.start;
  return a.order < b.order;
};

function collect(text: string, options: RedactionOptions): Span[] {
  const spans: Span[] = [];
  const entropyOptions = resolveEntropyOptions(options);

  SECRET_PATTERNS.forEach((pattern, order) => {
    // `matchAll` clones the regex, so the shared module-level /g instances keep
    // a clean `lastIndex` across calls and the engine stays pure.
    for (const match of text.matchAll(pattern.regex)) {
      const whole = match[0];
      const index = match.index;
      if (whole === undefined || index === undefined) continue;
      const captured = match[pattern.secretGroup];
      const secret = captured ?? whole;
      if (secret === '') continue;
      const valueStart = index + whole.lastIndexOf(secret);
      // The value-side filter. This is the false-positive brake, and it is the
      // reason `${DB_PASSWORD}` and `********` do not read as credentials.
      if (pattern.rejectValue?.(secret, entropyOptions.allowDocPlaceholders) === true) continue;
      spans.push({
        start: valueStart,
        end: valueStart + secret.length,
        ruleId: pattern.id,
        kind: pattern.kind,
        confidence: pattern.confidence,
        order,
      });
    }
  });

  if (entropyOptions.enabled) {
    for (const verdict of analyzeEntropy(text, entropyOptions)) {
      if (verdict.verdict !== 'high_entropy') continue;
      // An entropy hit is capped at `probable` by the analyser; a standalone
      // unlabelled token is `possible` and therefore below the default
      // `minConfidence`. That is the structural half of "entropy is never the
      // sole defence" -- the default configuration cannot redact on entropy
      // alone, so a false positive cannot become a silent deletion.
      spans.push({
        start: verdict.start,
        end: verdict.end,
        ruleId: 'high_entropy',
        kind: 'high_entropy',
        confidence: verdict.confidence ?? 'possible',
        order: SECRET_PATTERNS.length,
      });
    }
  }

  return spans;
}

function eligible(spans: readonly Span[], minConfidence: Confidence): Span[] {
  const floor = RANK[minConfidence];
  const kept = spans
    .filter((s) => RANK[s.confidence] >= floor)
    // Position first, because the dedupe below is a single left-to-right pass
    // and it only holds if the spans arrive sorted; priority only breaks ties
    // between spans that start at the same offset.
    .sort(
      (a, b) => a.start - b.start || b.end - a.end || (better(a, b) ? -1 : better(b, a) ? 1 : 0),
    );
  return dedupeOverlap(kept);
}

/**
 * Keep one span per overlapping region.
 *
 * Overlap is normal, not exceptional: a `DATABASE_URL=postgres://u:p@h/db`
 * matches both the assignment rule and the connection-string rule, and the JWT
 * inside an `Authorization: Bearer` header matches three. Left alone, the second
 * replacement would corrupt the first one's offsets; the naive fix (re-running
 * the match after each substitution) loses a span entirely. Resolving overlaps
 * once, up front, keeps the strongest and the geometry consistent.
 */
function dedupeOverlap(sorted: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last === undefined) {
      out.push(span);
      continue;
    }
    if (span.start < last.end) {
      if (better(span, last)) out[out.length - 1] = span;
      continue;
    }
    out.push(span);
  }
  return out;
}

const MAX_PASSES = 2;

const findingFor = (span: Span, text: string): RedactionFinding => {
  const secret = text.slice(span.start, span.end);
  return {
    ruleId: span.ruleId,
    kind: span.kind,
    confidence: span.confidence,
    length: secret.length,
    digest: sha256(secret),
  };
};

const applySpans = (text: string, spans: readonly Span[]): string => {
  let out = text;
  // Right to left, so each replacement's offsets stay valid: a left-to-right
  // loop over a string that is being shortened desynchronises every later span.
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    const span = spans[i];
    if (span === undefined) continue;
    out = out.slice(0, span.start) + placeholderFor(span.kind) + out.slice(span.end);
  }
  return out;
};

export class RedactionEngine {
  readonly options: RedactionOptions;

  constructor(options: Partial<RedactionOptions> = {}) {
    this.options = { ...DEFAULT_REDACTION_OPTIONS, ...options };
    assertCatalogueWellFormed();
  }

  /**
   * Never rewrites. The measurement path, and the one every persistence gate
   * runs, so "is there a secret here" is one function with one answer.
   */
  scan(text: string): readonly RedactionFinding[] {
    if (this.options.mode === 'off' || text === '') return [];
    return eligible(collect(text, this.options), this.options.minConfidence).map((s) =>
      findingFor(s, text),
    );
  }

  containsSecret(text: string): boolean {
    return this.scan(text).length > 0;
  }

  /**
   * Apply the configured mode.
   *
   * Bounded at two passes, and the second only runs if the first changed
   * anything: removing the text between two spans can bring a new shape into
   * view (a PEM header whose body was the redacted part), and an unbounded
   * `while (changed)` loop over a text this function also rewrites is a way to
   * hang the request path.
   */
  redact(text: string): RedactionResult {
    const mode = this.options.mode;
    if (mode === 'off' || text === '') {
      return { text, changed: false, findings: [] };
    }

    const findings: RedactionFinding[] = [];
    let current = text;
    let changed = false;

    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      const spans = eligible(collect(current, this.options), this.options.minConfidence);
      findings.push(...spans.map((s) => findingFor(s, current)));
      if (spans.length === 0) break;
      current = applySpans(current, spans);
      changed = true;
    }

    if (mode === 'block' && findings.length > 0) throw new SecretBlockedError(findings);
    return { text: current, changed, findings };
  }

  /**
   * The persistence gate. Separate from `redact` on purpose: it answers "may
   * these bytes be written", and the answer is no if a certain-confidence
   * secret is still in them -- *whatever the mode says*.
   *
   * The threshold is fixed at `certain` rather than inherited from
   * `minConfidence`, because `minConfidence` is tuned for a false-positive rate
   * on text a human reads, and a false positive on a disk write is a refused
   * write. An operator who wants the stricter gate on borderline shapes sets
   * `minConfidence: 'certain'` too and gets both.
   */
  assertPersistable(text: string, context: string): void {
    const spans = collect(text, this.options).filter((s) => RANK[s.confidence] >= RANK['certain']);
    if (spans.length === 0) return;
    const kinds = [...new Set(spans.map((s) => s.kind))].sort();
    throw new SecretLeakError(kinds, context);
  }
}

/** Convenience for the common case; a fresh engine per call is a few field copies. */
export function redactText(text: string, options: Partial<RedactionOptions> = {}): RedactionResult {
  return new RedactionEngine(options).redact(text);
}

/**
 * Deep redaction of a JSON-shaped value.
 *
 * Depth-bounded because this runs on the request path, and an unbounded walk of
 * a value that arrived from a model is a denial of service on a control that is
 * supposed to be free. Past the bound the value is replaced with a marker
 * rather than walked: an unexamined subtree is exactly the thing that must not
 * reach a gist or a file.
 *
 * Keys are left alone. A key is a name, not a value, and redacting keys would
 * break the shape a caller is about to validate.
 */
const MAX_DEPTH = 12;
const DEPTH_MARKER = '[strata:redacted:depth-limit]';

export function redactDeep<T>(value: T, options: Partial<RedactionOptions> = {}): T {
  const engine = new RedactionEngine({ mode: 'placeholder', ...options });
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) return DEPTH_MARKER;
    if (typeof v === 'string') return engine.redact(v).text;
    if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
    if (typeof v === 'object' && v !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val, depth + 1);
      return out;
    }
    return v;
  };
  return walk(value, 0) as T;
}

export function scanSecrets(
  text: string,
  options: Partial<RedactionOptions> = {},
): readonly RedactionFinding[] {
  return new RedactionEngine(options).scan(text);
}

export function containsSecret(text: string, options: Partial<RedactionOptions> = {}): boolean {
  return new RedactionEngine(options).containsSecret(text);
}

export { CERTAIN_PATTERN_IDS, SECRET_PATTERNS, placeholderFor, REDACTION_MARKER } from './patterns.js';
export type { Confidence, SecretKind } from './patterns.js';
export { analyzeEntropy, shannonEntropy, DEFAULT_ENTROPY_OPTIONS } from './entropy.js';
export type {
  EntropyOptions,
  EntropyRejection,
  EntropyVerdict,
} from './entropy.js';
