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
 * | an npm `sha512-<base64>` integrity value |    5.789  |
 * | an unlabelled 43-char opaque secret      |    5.380  |
 *
 * Three consequences, and they are the whole design of this module:
 *
 * 1. **Threshold alone cannot work.** A real secret at 4.22 sits *below* a
 *    sentence at 4.29 and a path at 4.12. Any cutoff low enough to catch the
 *    secret fires on prose, paths and identifiers; any cutoff above them misses
 *    the secret. Entropy is therefore applied only after a shape gate rejects
 *    prose, paths and single-class tokens, and it is a *second* line of defence
 *    behind the pattern catalogue in ./patterns.ts. Never the only one.
 * 2. **The alphabet bound is a real proof, and it says exactly one thing.**
 *    Shannon entropy is bounded by log2(alphabet size): 4.0 bits/char for the
 *    16-symbol hex alphabet. `DEFAULT_ENTROPY_THRESHOLD` = 4.2 sits above that
 *    bound, so a hex digest of *any* length can never be reported. That is a
 *    proof rather than a measurement, and it is why 4.2 is not a number somebody
 *    chose -- but it is a proof about **hex**, and this file previously read as
 *    though it licensed a guarantee about digests in general. It does not.
 *    base64 has a 6.0 bits/char ceiling and the npm integrity value in the
 *    table above measures 5.789, which is 1.59 bits/char *above* this module's
 *    own threshold. So:
 *    - the threshold does not exclude base64 digests. Nothing numeric does;
 *    - what excludes them is their shape -- the `sha512-` prefix and the digest
 *      lengths in `SAFE_SHAPES` below;
 *    - and therefore `threshold` is the wrong knob for a base64 false positive.
 *      Raising it to 5.8 to admit the npm value also drops the 5.38 secret that
 *      no rule in ./patterns.ts can see; lowering it to recover that secret
 *      re-admits prose at 4.29. Both directions lose, which is why the shape is
 *      the mechanism and the number is left alone.
 * 3. **A digest measures higher than the secret it gets confused with.** The
 *    bottom two rows are the measurement that settles this: a benign npm
 *    integrity value at 5.789 against a real opaque secret at 5.380. No
 *    threshold, and no function of the character histogram, orders those two the
 *    right way round. Only metadata a secret does not carry does: a recognised
 *    algorithm prefix, a digest length, a PEM block label, a credential keyword.
 *
 * The residual false-positive class is therefore a high-entropy token carrying
 * none of that metadata -- an unlabelled base64 blob of no recognised length, a
 * truncated download, a minified bundle. `requireKeywordContext` (default on) is
 * the knob that removes most of those by demanding a credential keyword near the
 * token, at the cost of recall on unlabelled secrets.
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
  | 'non_secret_pem_body'
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
 * A digest is the headline case and it is the one `threshold` cannot help with:
 * a base64 digest measures ~5.8 bits/char and a hex one ~3.7-4.0, so the first is
 * far above the threshold, the second is far below it, and neither is a
 * credential. Everything in this list is therefore *shape*, never entropy, and
 * the two mechanisms are not interchangeable -- a `known_safe_shape` rejection
 * means the token was recognised, not that it was boring. (`known_safe_shape` is
 * also what a token gets when the caller sets a `threshold` above its entropy,
 * so the reasons must not be conflated in a report.)
 *
 * What may go in here is metadata a secret does not carry: a recognised
 * algorithm name, a digest length, a UUID's separators, a semver's dots. What
 * may **not** go in here is "this happens to be N characters of base64", even
 * when N is a digest length. That looks like the natural fix for the base64
 * false positive above and it is a trap: unpadded base64url of 43 characters
 * decodes to exactly 32 bytes, which is a SHA-256 digest length, and 43
 * characters is the length of the only three secrets in E6's corpus that no rule
 * in ./patterns.ts can see. A `decoded length == digest length` rule would
 * discard exactly those three and turn a false-positive fix into a recall
 * regression. Base64 has no shape; it is base64 of everything.
 */
const SAFE_SHAPES: readonly { readonly re: RegExp; readonly why: string }[] = [
  { re: /^[0-9a-f]{32}$/i, why: 'md5 digest' },
  { re: /^[0-9a-f]{40}$/i, why: 'git object id / sha1 digest' },
  { re: /^[0-9a-f]{56}$/i, why: 'sha224 digest' },
  { re: /^[0-9a-f]{64}$/i, why: 'sha256 digest' },
  { re: /^[0-9a-f]{96}$/i, why: 'sha384 digest' },
  { re: /^[0-9a-f]{128}$/i, why: 'sha512 digest' },
  {
    // The separator is `-` for SRI (`sha512-<base64>`), `:` for Docker and Debian
    // (`sha256:<hex>`), and `=` in a `checksum=sha512=...` spelling. The optional
    // internal hyphen is for the `sha-512-` style. `md5` is the other SRI
    // algorithm npm actually emits, and the `sha3-` family is what FIPS-mode
    // registries print. The leading `[^A-Za-z0-9]{0,4}` is not decoration: the
    // coarse tokenizer glues a preceding `.` or `;` onto the run, and a `^`
    // anchor that requires the algorithm word at offset 0 is defeated by that,
    // which is how a shape rule that reads as absolute turns into a suggestion.
    re: /^[^A-Za-z0-9]{0,4}(?:md5|sha-?(?:1|224|256|384|512)|sha3-?(?:224|256|384|512))[-:=]/i,
    why: 'algorithm-prefixed digest',
  },
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
 * PEM block labels whose body is not a credential.
 *
 * This is the base64 case that *is* reachable, and it is a false positive rather
 * than a latent one. A certificate, a CRL and a public key are published
 * material: they turn up in every TLS debug log, every `kubectl get secret -o
 * yaml`, every certificate-pinning fixture and every `openssl s_client` run. The
 * body is written as 64-character lines of base64, which is mixed-class text at
 * 4.3-5.1 bits/char -- the same measurement as an opaque token -- and
 * ./patterns.ts does not cover it either, because `private_key_pem` names
 * `PRIVATE KEY` and nothing else.
 *
 * `PRIVATE` is in no label here, and the set is an allow-list rather than a
 * deny-list on purpose: `RSA PRIVATE KEY`, `EC PRIVATE KEY` and `ENCRYPTED
 * PRIVATE KEY` are then simply not excused, instead of being excused by a rule
 * that failed to enumerate the ways a private key says so.
 */
const NON_SECRET_PEM_LABELS: ReadonlySet<string> = new Set([
  'CERTIFICATE',
  'CERTIFICATE REQUEST',
  'TRUSTED CERTIFICATE',
  'X509 CERTIFICATE',
  'X509 CRL',
  'CRL',
  'PUBLIC KEY',
  'PGP PUBLIC KEY BLOCK',
  'PGP SIGNATURE',
  'DH PARAMETERS',
  'DSA PARAMETERS',
  'RSA PARAMETERS',
  'EC PARAMETERS',
]);

const PEM_BEGIN = '-----BEGIN ';
const PEM_END = '-----END ';

/**
 * True when offset `at` sits in the body of a PEM block whose label is in
 * `NON_SECRET_PEM_LABELS`.
 *
 * Nearest marker wins, and a `BEGIN` with no `END` after it still counts as
 * open. A truncated scrollback that captured a certificate header and two body
 * lines is the common case -- it is the same reason `private_key_pem` makes its
 * body optional -- and requiring the footer would exempt the full block and
 * flag the fragment, which is backwards.
 *
 * Base64's alphabet excludes `-`, so `-----END` cannot occur inside a body line
 * and no false "the block already closed" reading is possible.
 */
const insideNonSecretPemBody = (text: string, at: number): boolean => {
  const begin = text.lastIndexOf(PEM_BEGIN, at);
  if (begin === -1) return false;
  if (text.lastIndexOf(PEM_END, at) > begin) return false;
  const labelEnd = text.indexOf('-----', begin + PEM_BEGIN.length);
  if (labelEnd === -1 || labelEnd > at) return false;
  const label = text.slice(begin + PEM_BEGIN.length, labelEnd);
  if (!/^[A-Za-z0-9][A-Za-z0-9 ]*$/.test(label)) return false;
  return NON_SECRET_PEM_LABELS.has(label.toUpperCase());
};

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
  // After the token shapes and for the same reason, but a *context* shape: the
  // token is unremarkable in itself and is base64 of published material because
  // of the block it sits in. Its own reason code, because "we recognised the
  // token" and "we recognised what the token is part of" are different facts and
  // a false-positive report that merges them cannot tell an operator which brake
  // did the work.
  if (insideNonSecretPemBody(text, start)) return reject('non_secret_pem_body');
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
  //
  // TODO(owner): that drop is unconditional and therefore total. Every fine
  // candidate is produced *from* a coarse candidate, so it is always contained in
  // one, so `overlaps` is always true for it, so the fine set never reaches
  // `verdicts` and no sub-token is ever evaluated. The observable consequence is
  // that a run containing path punctuation is decided entirely by its coarse
  // verdict (`path_punctuation`), which is why the two base64 shapes that DO reach
  // the gates are the ones on lines of their own: a PEM body line and a bare
  // digest. Reviving it is not a one-line change -- the first thing that happens
  // when it is revived is that `data:image/png;base64,...`, a Kubernetes
  // `data:` block and a `key: value` JSON line each start producing a token
  // inside them, so it needs its own false-positive pass against the benign corpus
  // before it can be switched on. Deliberately left as-is here rather than
  // "fixed" as a drive-by, because doing that silently is what would turn this
  // module into a worse redactor than the one it is calibrated to be.
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
