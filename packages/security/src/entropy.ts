import type { Confidence } from './patterns.js';

/**
 * I-1, the probabilistic half: Shannon-entropy analysis.
 *
 * ## This is a filter, not a detector, and the calibration below says why
 *
 * Measured per-character Shannon entropy of realistic inputs (see
 * entropy.test.ts, which pins these numbers so a future edit cannot quietly move
 * the threshold under them):
 *
 * | input                                    | bits/char |
 * |------------------------------------------|-----------|
 * | sha256 hex digest                        |    3.700  |
 * | `AKIAIOSFODNN7EXAMPLE` (real AWS key)    |    3.684  |
 * | camelCase identifier, 31 chars           |    4.300  |
 * | a 24-char base64 secret                  |    4.220  |
 * | an English sentence                      |    4.292  |
 * | an absolute filesystem path              |    4.124  |
 * | a base64 PNG data blob                   |    4.450  |
 *
 * Two consequences, and they are the whole design of this module:
 *
 * 1. **Threshold alone cannot work.** A real secret at 4.22 sits *below* a
 *    sentence at 4.29 and a path at 4.12. Any cutoff low enough to catch the
 *    secret fires on prose, paths and identifiers; any cutoff above them misses
 *    the secret. Entropy is therefore applied only after a shape gate rejects
 *    prose, paths and single-class tokens, and it is a *second* line of defence
 *    behind the pattern catalogue in ./patterns.ts. Never the only one.
 * 2. **A threshold above 4.0 bits/char is principled, not tuned.** Entropy is
 *    bounded by log2(alphabet): a 16-symbol alphabet such as hex cannot exceed
 *    4.0 bits/char, so any threshold above 4.0 can *never* fire on a hex digest,
 *    however long. That is a proof, not a measurement, and it is why
 *    `DEFAULT_ENTROPY_THRESHOLD` is 4.2 rather than something someone chose.
 *
 * The residual false-positive class is a long mixed-class token that is neither
 * prose nor a known digest shape -- a lockfile `integrity` value, a truncated
 * blob. `requireKeywordContext` (default on) is the knob that removes those by
 * demanding a credential keyword near the token, at the cost of recall on
 * unlabelled secrets.
 */

export const DEFAULT_ENTROPY_MIN_LENGTH = 24;
export const DEFAULT_ENTROPY_THRESHOLD = 4.2;
export const DEFAULT_ENTROPY_KEYWORD_WINDOW = 48;

export interface EntropyOptions {
  readonly enabled: boolean;
  readonly minLength: number;
  /** bits per character; see the table above for the calibration. */
  readonly threshold: number;
  /**
   * When true a high-entropy token is only a finding if a credential keyword
   * appears within `keywordWindow` characters. Default true: it is the
   * difference between "flags lockfile hashes" and "flags unlabelled secrets".
   */
  readonly requireKeywordContext: boolean;
  readonly keywordWindow: number;
  /**
   * Treat `changeme`/`example`/`placeholder` as documentation rather than
   * credentials. Default true, which trades a little recall for a materially
   * better false-positive rate; set false on a deployment where a weak literal
   * password is still a real password.
   */
  readonly allowDocPlaceholders: boolean;
}

export const DEFAULT_ENTROPY_OPTIONS: EntropyOptions = {
  enabled: true,
  minLength: DEFAULT_ENTROPY_MIN_LENGTH,
  threshold: DEFAULT_ENTROPY_THRESHOLD,
  requireKeywordContext: true,
  keywordWindow: DEFAULT_ENTROPY_KEYWORD_WINDOW,
  allowDocPlaceholders: true,
};

export type EntropyRejection =
  | 'too_short'
  | 'whitespace'
  | 'path_punctuation'
  | 'single_character_class'
  | 'known_safe_shape'
  | 'doc_placeholder'
  | 'low_entropy'
  | 'no_keyword_context';

export interface EntropyVerdict {
  readonly verdict: 'high_entropy' | 'rejected';
  readonly start: number;
  /** exclusive */
  readonly end: number;
  readonly entropy: number;
  readonly confidence: Confidence | undefined;
  readonly reason: EntropyRejection | undefined;
}

/**
 * Per-character Shannon entropy in bits, `0` for the empty string. Computed over
 * code units: the tokenizer operates on ASCII token characters, so surrogate
 * handling never reaches this.
 */
export function shannonEntropy(input: string): number {
  if (input.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of input) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / input.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Structural shapes that look high-entropy and are not credentials.
 *
 * A hex digest of a recognised length is the headline case: it is exactly the
 * false positive the task calls out. The `threshold` already excludes it (see
 * the module header), and this list is the belt-and-braces for the digests that
 * are *not* pure hex -- `sha512-` prefixed base64 lockfile integrity values,
 * compact UUIDs, semver ranges.
 */
const SAFE_SHAPES: readonly { readonly re: RegExp; readonly why: string }[] = [
  { re: /^[0-9a-f]{32}$/i, why: 'md5 digest' },
  { re: /^[0-9a-f]{40}$/i, why: 'git object id / sha1 digest' },
  { re: /^[0-9a-f]{56}$/i, why: 'sha224 digest' },
  { re: /^[0-9a-f]{64}$/i, why: 'sha256 digest' },
  { re: /^[0-9a-f]{96}$/i, why: 'sha384 digest' },
  { re: /^[0-9a-f]{128}$/i, why: 'sha512 digest' },
  { re: /^(?:sha1|sha224|sha256|sha384|sha512)[-:=]/i, why: 'algorithm-prefixed digest' },
  {
    re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    why: 'canonical uuid',
  },
  { re: /^[0-9a-f]{8}[0-9a-f]{4}[0-9a-f]{4}[0-9a-f]{4}[0-9a-f]{12}$/i, why: 'compact uuid' },
  { re: /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, why: 'semver / version' },
  { re: /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/, why: 'iso-8601 timestamp' },
  { re: /^\d{1,3}(?:\.\d{1,3}){3}$/, why: 'ipv4 literal' },
  { re: /^[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){7}$/i, why: 'ipv6 literal' },
];

/**
 * Credential keywords. Deliberately requires a non-alphanumeric boundary on the
 * left so `keyboard` and `monkey` do not arm the keyword context, and allows
 * `SNAKE_CASE` segments so `AWS_SECRET_ACCESS_KEY` arms it.
 */
const KEYWORD_CONTEXT =
  /[^A-Za-z0-9](?:[A-Za-z0-9]*[_-])*(?:api[_-]?key|secret|token|passw|auth|cred|bearer|session|cookie|private|signing|salt|key)/i;

const DOC_PLACEHOLDERS = new Set([
  'changeme',
  'change_me',
  'change-me',
  'example',
  'placeholder',
  'redacted',
  'dummy',
  'sample',
  'todo',
  'tbd',
]);

/** Characters that mean "this run is a path, a URL or quoted text, not a token". */
const PATH_PUNCTUATION = /[/\\:?#"'<>(){}[\]|@=,+*!$^~`]/;

/** Non-space printable ASCII: the coarse candidate tokenizer. */
const CANDIDATE = /[\x21-\x7e]+/g;
/** The same, but stopping at path punctuation: the fine tokenizer. */
const TOKEN = /[A-Za-z0-9._~+\-!$*'^{}()[\]/\\:?#&=<>@%,]+/g;

interface Candidate {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const evaluate = (
  cand: Candidate,
  text: string,
  options: EntropyOptions,
): EntropyVerdict => {
  const { start, end, text: token } = cand;
  const entropy = shannonEntropy(token);
  const reject = (reason: EntropyRejection): EntropyVerdict => ({
    verdict: 'rejected',
    start,
    end,
    entropy,
    confidence: undefined,
    reason,
  });

  if (token.length < options.minLength) return reject('too_short');
  if (/\s/.test(token)) return reject('whitespace');
  if (PATH_PUNCTUATION.test(token)) return reject('path_punctuation');
  if (options.allowDocPlaceholders && DOC_PLACEHOLDERS.has(token.toLowerCase())) {
    return reject('doc_placeholder');
  }

  const hasLetter = /[A-Za-z]/.test(token);
  const hasDigit = /[0-9]/.test(token);
  // Mixed classes only. This is the gate that removes English words, camelCase
  // identifiers and UPPER_SNAKE env names, all of which measure *higher* than
  // the threshold (a 31-char camelCase identifier is 4.30) and would otherwise
  // be the dominant false-positive class.
  if (!hasLetter || !hasDigit) return reject('single_character_class');

  for (const shape of SAFE_SHAPES) {
    if (shape.re.test(token)) return reject('known_safe_shape');
  }
  if (entropy < options.threshold) return reject('low_entropy');

  if (options.requireKeywordContext) {
    const from = Math.max(0, start - options.keywordWindow);
    const to = Math.min(text.length, end + options.keywordWindow);
    if (!KEYWORD_CONTEXT.test(text.slice(from, to))) return reject('no_keyword_context');
  }

  return {
    verdict: 'high_entropy',
    start,
    end,
    entropy,
    // Entropy alone is a heuristic, so a hit can never outrank a structural
    // match: `possible` is the ceiling regardless of how extreme the entropy.
    confidence: options.requireKeywordContext ? 'probable' : 'possible',
    reason: undefined,
  };
};

const overlaps = (a: Candidate, b: Candidate): boolean => a.start < b.end && b.start < a.end;

/**
 * Tokenize then gate then measure. Both verdicts are reported: a rejection
 * carries the reason, which is what makes the false-positive behaviour
 * assertable in a test instead of a matter of opinion.
 */
export function analyzeEntropy(text: string, options?: Partial<EntropyOptions>): readonly EntropyVerdict[] {
  const opts: EntropyOptions = { ...DEFAULT_ENTROPY_OPTIONS, ...options };
  if (!opts.enabled || text.length === 0) return [];

  const coarse: Candidate[] = [];
  for (const m of text.matchAll(CANDIDATE)) {
    const start = m.index;
    if (start === undefined) continue;
    coarse.push({ start, end: start + m[0].length, text: m[0] });
  }

  // A secret pasted inside a path-ish line (`fixtures/base64blob/notes`) is one
  // sub-token, not the whole run, so the fine tokenizer is evaluated too. Both
  // sets are scanned and overlapping candidates are dropped from the results so
  // one span cannot be reported twice.
  const fine: Candidate[] = [];
  for (const c of coarse) {
    if (!PATH_PUNCTUATION.test(c.text)) continue;
    const slice = text.slice(c.start, c.end);
    for (const m of slice.matchAll(TOKEN)) {
      const offset = m.index;
      if (offset === undefined) continue;
      fine.push({ start: c.start + offset, end: c.start + offset + m[0].length, text: m[0] });
    }
  }

  const verdicts: EntropyVerdict[] = [];
  for (const cand of coarse) verdicts.push(evaluate(cand, text, opts));
  for (const cand of fine) {
    if (coarse.some((c) => overlaps(c, cand))) continue;
    verdicts.push(evaluate(cand, text, opts));
  }

  verdicts.sort((a, b) => a.start - b.start || a.end - b.end);
  return verdicts;
}
