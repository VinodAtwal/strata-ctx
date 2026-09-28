/**
 * I-1, the deterministic half: the secret pattern catalogue.
 *
 * ## Why these are hand-written
 *
 * No dependency may be added to this package, and every off-the-shelf regex
 * secret scanner is a dependency. So the catalogue is written here, one entry per
 * credential class the task names: AWS keys, GitHub tokens, PEM private keys,
 * bearer tokens, JWTs, `key=`/`secret=`/`password=` assignments, and connection
 * strings. Four more are included because they are zero-false-positive by
 * construction (a fixed prefix plus a fixed length) and cover credentials a
 * coding agent plausibly reads out of a repo: npm, Slack, Google, and the
 * LLM-provider keys.
 *
 * The provider keys (`sk-ant-...`, `sk-proj-...`) are the headline case *for this
 * product specifically*: strata-ctx is a proxy that reads `ANTHROPIC_API_KEY` out
 * of the environment, so the one credential guaranteed to exist in the process is
 * the one credential a `env` dump, a `.env` read, or a stack trace in a tool
 * result can capture. It is first in the certain group because of that, and the
 * generic `sk-` rule is listed after it so a specific shape wins the span.
 * (Stream G carries its own two rules for telemetry; this is the canonical
 * catalogue, and the overlap is deliberate rather than a drift to reconcile.)
 *
 * ## The two axes that keep a catalogue from being either useless or hostile
 *
 * - `confidence` -- `certain` means the shape admits no innocent reading (a PEM
 *   header; `AKIA` plus 16 uppercase alphanumerics). `probable` means a named
 *   pattern a careful codebase might legitimately contain. `minConfidence` lets
 *   a deployment keep only the certain set and still get real protection.
 * - `rejectValue` -- the false-positive brake on assignment patterns. Without it
 *   every `${VAR}`, `os.environ[...]` and masked `********` in a fixture or a
 *   README reads as a "secret", and a redactor that cries wolf gets switched
 *   off, which is a worse outcome than no redactor.
 *
 * `secretGroup` exists for the same reason: a redacted `password=[...]` still
 * reads as a password and stays reviewable, whereas redacting the whole
 * `password=...` line hides the fact that a credential was present at all.
 */

export type Confidence = 'certain' | 'probable' | 'possible';

export type SecretKind =
  | 'anthropic_api_key'
  | 'openai_style_key'
  | 'aws_access_key_id'
  | 'aws_secret_access_key'
  | 'github_token'
  | 'private_key'
  | 'bearer_token'
  | 'jwt'
  | 'assigned_secret'
  | 'connection_string'
  | 'url_userinfo_password'
  | 'slack_token'
  | 'google_api_key'
  | 'npm_token'
  | 'high_entropy';

export interface SecretPattern {
  readonly id: string;
  readonly kind: SecretKind;
  readonly confidence: Confidence;
  /** Must carry the `g` flag. Shared instances are safe: callers use `matchAll`. */
  readonly regex: RegExp;
  /** Capture group holding the secret itself; 0 means the whole match. */
  readonly secretGroup: number;
  /** Returns true when a match is documentation rather than a stored credential. */
  readonly rejectValue?: (value: string, allowDocPlaceholders: boolean) => boolean;
}

export const REDACTION_MARKER = '[strata:redacted';

/**
 * The placeholder carries no prefix, no suffix and no length, on purpose. A
 * "helpful" `AKIA…MPLE` is a partial disclosure: it turns a 2^36 search into a
 * 2^8 one and names the key family to attack. The `kind` survives because an
 * operator needs to know *which* credential to rotate, and it is not a function
 * of the secret's bytes.
 */
export const placeholderFor = (kind: SecretKind): string => `${REDACTION_MARKER}:${kind}]`;

const DOC_PLACEHOLDER_WORDS = new Set([
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

/** Shell/PHP-style interpolation: a value that will be filled in later. */
const INTERPOLATION =
  /^(?:\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$\([^)]*\)|\{\{[^}]*\}\}|<[^>]*>|%[svdq](?:\([^)]*\))?[#0\- +]?\d*(?:\.\d+)?[svdq]?)$/;

/** A reference to where a credential lives, not the credential. */
const ENV_REFERENCE =
  /^(?:\$\{?env\b.*|(?:process\.env|os\.environ|os\.getenv|System\.getenv|ENVIRON|ENV|getenv|env)\b.*)$/i;

/**
 * Public so the engine and the tests share one definition of "this value is not
 * a secret". `allowDocPlaceholders` exists because the decision is deployment
 * specific: a doc that says `password=changeme` is noise in a research repo and
 * a real, if terrible, password on a device that talks to a dev database.
 */
export function isDocPlaceholderValue(value: string, allowDocPlaceholders: boolean): boolean {
  const v = value.trim();
  if (v === '') return true;
  if (INTERPOLATION.test(v)) return true;
  if (ENV_REFERENCE.test(v)) return true;
  // Fully masked: a documentation stand-in, never a usable credential.
  if (/^[xX*•._-]+$/.test(v)) return true;
  if (!allowDocPlaceholders) return false;
  return DOC_PLACEHOLDER_WORDS.has(v.toLowerCase());
}

/**
 * `key = value` assignments.
 *
 * The left edge is `(?<![A-Za-z0-9])(?:[A-Za-z0-9]{1,8}[_-])?` rather than `\b`
 * for two reasons. `\b` never matches between `_` and a letter, so the single
 * most common spelling in a real `.env` -- `DB_PASSWORD=hunter2` -- would be
 * invisible; and `\b` would *also* match inside `monkey=` and `keyboard=`,
 * which is the false positive that makes a keyword list unusable. One
 * underscore-or-hyphen-separated segment of prefix is allowed, so
 * `APP_API_KEY` matches and `FOO_BAR_PASSWORD` still does.
 *
 * The value class excludes quotes, angle brackets, braces and backticks so a
 * placeholder token (`token: <your-token-here>`) is not mistaken for a secret,
 * while a real token is still matched whole.
 *
 * Capture groups: 1 = the opening quote, 2 = the value. `secretGroup` is 2 and
 * the closing delimiter is the `\1` backreference; the engine in ./redact.ts
 * re-derives the span from the match offset plus the group, and asserts at
 * construction that the index is real, so an off-by-one here is a startup
 * failure rather than a redactor that quietly blanks the wrong characters.
 */
const ASSIGNED_SECRET =
  /(?<![A-Za-z0-9])(?:[A-Za-z0-9]{1,8}[_-])?(?:api[_-]?key|secret[_-]?key|client[_-]?secret|secret[_-]?access[_-]?key|encryption[_-]?key|signing[_-]?key|private[_-]?token|private[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|api[_-]?token|credentials?|passphrase|password|passwd|pwd|secret|token|apikey)\s*[:=]\s*(["']?)([^\s"',;<>(){}[\]`\\]{4,})\1/gi;

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: 'private_key_pem',
    kind: 'private_key',
    confidence: 'certain',
    // The body is optional on purpose. The common leak is a diff or a truncated
    // terminal scroll that captured the header and nothing else, and a pattern
    // demanding the full PEM block misses exactly the case that matters.
    regex:
      /-----BEGIN (?:[A-Z0-9]{0,32} )?PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END (?:[A-Z0-9]{0,32} )?PRIVATE KEY(?: BLOCK)?-----)?/g,
    secretGroup: 0,
  },
  {
    id: 'aws_access_key_id',
    kind: 'aws_access_key_id',
    confidence: 'certain',
    // The documented resource-type prefixes. A bare `[A-Z0-9]{20}` would be a
    // false-positive machine; requiring the prefix keeps this at zero FP.
    regex: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA)[A-Z0-9]{16}\b/g,
    secretGroup: 0,
  },
  {
    id: 'github_token',
    kind: 'github_token',
    confidence: 'certain',
    // ghp_ personal, gho_ OAuth, ghs_ server-to-server, ghu_ user-to-server,
    // ghr_ refresh, plus the fine-grained github_pat_ form.
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,251}|github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59})\b/g,
    secretGroup: 0,
  },
  {
    id: 'anthropic_api_key',
    kind: 'anthropic_api_key',
    confidence: 'certain',
    // 16 characters minimum: the `sk-ant-` prefix plus a fixed-ish body. A
    // shorter match is a documentation stand-in (`sk-ant-xxx`), and treating
    // that as a credential would redact the README that explains the product.
    regex: /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
    secretGroup: 0,
  },
  {
    id: 'openai_style_key',
    kind: 'openai_style_key',
    confidence: 'probable',
    // Listed *after* `anthropic_api_key` on purpose. Both match the same text
    // from the same offset, and the merge in ./redact.ts breaks that tie on
    // catalogue order, so the specific shape is the one that survives. The
    // confidence is `probable` rather than `certain` because `sk-` is a
    // two-character prefix on an otherwise arbitrary alphabet, and a lockfile
    // can plausibly contain one by accident.
    regex: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
    secretGroup: 0,
  },
  {
    id: 'npm_token',
    kind: 'npm_token',
    confidence: 'certain',
    regex: /\bnpm_[A-Za-z0-9]{36}\b/g,
    secretGroup: 0,
  },
  {
    id: 'slack_token',
    kind: 'slack_token',
    confidence: 'certain',
    regex: /\bxox[abposr]-[A-Za-z0-9-]{10,72}\b/g,
    secretGroup: 0,
  },
  {
    id: 'google_api_key',
    kind: 'google_api_key',
    confidence: 'certain',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    secretGroup: 0,
  },
  {
    id: 'jwt',
    kind: 'jwt',
    confidence: 'probable',
    // `eyJ` is base64 of `{"`, so the leading segment plus the three-part shape
    // is what separates a JWT from an ordinary dotted identifier.
    regex: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    secretGroup: 0,
  },
  {
    id: 'aws_secret_access_key',
    kind: 'aws_secret_access_key',
    confidence: 'certain',
    // Groups: 1 = opening quote, 2 = the 40-character secret. The closing
    // backreference is `\1`, not `\2`: writing `\2` makes the whole pattern
    // unmatchable for a *quoted* value -- which is how the example appears in
    // every AWS doc -- while the unquoted form still works, so the bug is
    // invisible until a real quoted key shows up. The `i` flag rather than an
    // inline `(?i:...)` group: modifiers are ES2025 and throw a SyntaxError at
    // parse time on Node 20, which would take the entire module down.
    regex: /aws_?secret_?access_?key\s*[:=]\s*(["']?)([A-Za-z0-9/+=]{40})\1/gi,
    secretGroup: 2,
  },
  {
    id: 'connection_string',
    kind: 'connection_string',
    confidence: 'certain',
    // Only the password is redacted; the username stays visible because it is
    // the part that tells an operator *which* database was exposed.
    // Square brackets are excluded from the password class so a redaction
    // placeholder is not itself a password-shaped match: the engine runs a
    // second pass over its own output (a substitution can bring a new shape
    // into view) and a placeholder that matched would be "redacted" again,
    // destroying the marker and reporting a finding for text that was already
    // safe. A literal `[` in a URL password must be percent-encoded anyway.
    regex: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver|clickhouse|cassandra|elasticsearch):\/\/([^\s:@/]{1,128}):([^\s/@[\]]{1,128})@/gi,
    secretGroup: 2,
  },
  {
    id: 'url_userinfo_password',
    kind: 'url_userinfo_password',
    confidence: 'probable',
    // Scheme-agnostic backstop for a credential in userinfo: `https://`, an
    // internal service scheme, anything a database-scheme list would miss.
    // Same bracket exclusion as `connection_string`, for the same reason.
    regex: /\b[a-z][a-z0-9+.-]{1,31}:\/\/([^\s:@/]{1,128}):([^\s/@[\]]{1,128})@/gi,
    secretGroup: 2,
  },
  {
    id: 'bearer_token',
    kind: 'bearer_token',
    confidence: 'probable',
    // 16 characters minimum: shorter `Authorization` values are placeholders
    // (`Bearer <token>`, `Bearer null`) rather than credentials.
    regex: /\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{16,512})/g,
    secretGroup: 1,
  },
  {
    id: 'assigned_secret',
    kind: 'assigned_secret',
    confidence: 'probable',
    regex: ASSIGNED_SECRET,
    secretGroup: 2,
    rejectValue: isDocPlaceholderValue,
  },
];

/** Ids of the set that fires on shapes with no innocent reading. */
export const CERTAIN_PATTERN_IDS: readonly string[] = SECRET_PATTERNS.filter(
  (p) => p.confidence === 'certain',
).map((p) => p.id);
