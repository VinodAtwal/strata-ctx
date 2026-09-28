import type { JsonValue } from './json.js';

/**
 * Redaction. This runs before *anything* reaches the disk, because fixtures are
 * committed to a repository: a recorded fixture containing a live credential
 * is a leaked credential with an extra commit in its history.
 *
 * The hard part is not catching secrets, it is not eating the data the harness
 * needs. `usage.input_tokens` contains "token", and a redactor that rewrites it
 * silently destroys every cost number in E5 and every gate that reads cost
 * (G6, G7). So body keys are matched *anchored*, not by substring, and the
 * substring rule is limited to markers that cannot appear in a metric name.
 */

/** The sentinel. Chosen to be unmistakable in a diff and unmatchable by a metric. */
export const REDACTED = '[REDACTED]';

export interface RedactionResult<T> {
  readonly value: T;
  /** Dotted paths (or header names) that were rewritten, for the fixture's audit trail. */
  readonly hits: readonly string[];
  /** The raw values that were removed. Used to prove the written file is clean. */
  readonly secrets: readonly string[];
}

/**
 * Header names are matched flattened, so `X-Api-Key` and `x_api_key` collapse
 * to one entry. `token` is deliberately absent as a standalone: a header that
 * *is* a token is `authorization` or `x-api-key`, and the substring rule
 * below already covers compound names like `x-auth-token`.
 */
export const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'xapikey',
  'apikey',
  'xauthtoken',
  'anthropicauth',
  'basic',
  'digest',
  'signature',
]);

/**
 * Escapes the substring rule for headers. These are markers whose presence in a
 * header name means credential material with no plausible benign reading.
 */
const SENSITIVE_HEADER_FRAGMENTS = /authorization|apikey|secret|credential|password|token|cookie/;

/**
 * Allowlist, checked on the *original* name before flattening. The provider
 * rate-limit headers are the whole reason: `anthropic-ratelimit-tokens-limit`
 * flattens to something containing "token" and is a number the cost harness
 * needs. Allowlisting costs debuggability if it is wrong; over-redacting costs
 * measurements, which is the worse of the two.
 */
export const SAFE_HEADER_PREFIXES: readonly string[] = [
  'anthropic-ratelimit-',
  'openai-ratelimit-',
  'x-ratelimit-',
  'ratelimit-',
];

/**
 * Body keys, matched whole after flattening. See the module comment for why
 * `token` is here but `input_tokens` is not.
 */
export const SENSITIVE_BODY_KEYS: ReadonlySet<string> = new Set([
  'apikey',
  'xapikey',
  'openaiapikey',
  'accesskey',
  'accesskeyid',
  'secretaccesskey',
  'token',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'idtoken',
  'bearertoken',
  'secret',
  'clientsecret',
  'secretkey',
  'privatekey',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'authorization',
  'auth',
  'credentials',
  'credential',
  'cookie',
  'setcookie',
  'csrftoken',
  'xsrftoken',
]);

/**
 * Suffix rule for provider-prefixed names (`openai_api_key`,
 * `client_secret`, `x-csrf-token`). Restricted to markers that cannot be a
 * metric name, which keeps `input_tokens` and `max_tokens` intact while still
 * catching the long tail of vendor spellings.
 */
const SENSITIVE_BODY_SUFFIXES = [
  'apikey',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'bearertoken',
  'clientsecret',
  'privatekey',
  'secretkey',
  'csrftoken',
  'xsrftoken',
];

const flattenKey = (key: string): string => key.toLowerCase().replace(/[-_\s]/g, '');

export function isSensitiveHeader(name: string): boolean {
  const raw = name.toLowerCase().trim();
  if (SAFE_HEADER_PREFIXES.some((p) => raw.startsWith(p))) return false;
  const flat = flattenKey(raw);
  if (SENSITIVE_HEADERS.has(flat)) return true;
  return SENSITIVE_HEADER_FRAGMENTS.test(flat);
}

export function isSensitiveBodyKey(key: string): boolean {
  const flat = flattenKey(key);
  if (SENSITIVE_BODY_KEYS.has(flat)) return true;
  return SENSITIVE_BODY_SUFFIXES.some((suffix) => flat.endsWith(suffix));
}

export type HeaderMap = Readonly<Record<string, string>>;

export function redactHeaders(headers: HeaderMap): RedactionResult<Record<string, string>> {
  const out: Record<string, string> = {};
  const hits: string[] = [];
  const secrets: string[] = [];

  // Sorted so the output is byte-identical for the same input regardless of
  // header arrival order; a fixture that reorders on every record is a fixture
  // nobody can review in a diff.
  for (const name of Object.keys(headers).sort()) {
    const value = headers[name] ?? '';
    if (isSensitiveHeader(name)) {
      out[name] = REDACTED;
      hits.push(name);
      secrets.push(value);
    } else {
      out[name] = value;
    }
  }

  return { value: out, hits, secrets };
}

/**
 * A JSON object rather than an array.
 *
 * Spelled as a type predicate because `Array.isArray` does not narrow a *readonly*
 * array out of `JsonValue`: the union member is `readonly JsonValue[]`, and after
 * the array branch returns the compiler still believes an array is possible, so
 * `value[key]` on the object branch is an unchecked string index. The predicate
 * makes the narrowing explicit rather than resting on a cast.
 */
function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function redactValue(value: JsonValue, path: string, acc: Mutable): JsonValue {
  if (Array.isArray(value)) {
    const items: readonly JsonValue[] = value;
    return items.map((item, i) => redactValue(item, `${path}[${i}]`, acc));
  }
  if (isJsonObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child === undefined) continue;
      if (isSensitiveBodyKey(key)) {
        out[key] = REDACTED;
        acc.hits.push(path === '' ? key : `${path}.${key}`);
        acc.secrets.push(typeof child === 'string' ? child : JSON.stringify(child));
      } else {
        out[key] = redactValue(child, path === '' ? key : `${path}.${key}`, acc);
      }
    }
    return out;
  }
  return value;
}

interface Mutable {
  hits: string[];
  secrets: string[];
}

/**
 * Recursively rewrites sensitive fields. Keys are emitted in sorted order so
 * that `hashCanonical` input is stable and a recorded fixture does not churn
 * between runs.
 */
export function redactBody(body: JsonValue): RedactionResult<JsonValue> {
  const acc: Mutable = { hits: [], secrets: [] };
  return { value: redactValue(body, '', acc), hits: acc.hits, secrets: acc.secrets };
}

/**
 * The shortest value worth scanning a written file for.
 *
 * The post-write scan (see `record.ts`) matches secret values as substrings, so
 * a three-character value would collide with ordinary text and refuse to
 * record. Three characters is not a credential; the field-name rules above are
 * what protect short secrets, and this constant only limits what can be
 * *proven* clean afterwards.
 */
export const MIN_SCANNABLE_SECRET_LENGTH = 8;

/** Values long enough to prove absence of after the fact. */
export function scannableSecrets(secrets: readonly string[]): string[] {
  return [...new Set(secrets.filter((s) => s.length >= MIN_SCANNABLE_SECRET_LENGTH))];
}
