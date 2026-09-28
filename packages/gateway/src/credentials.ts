/**
 * Credential handling for the gateway.
 *
 * Three rules, in order of how much damage breaking them does:
 *
 *  1. A credential is resolved once, at the edge, from exactly one place the user
 *     chose: an explicit option, the environment, or the OS keyring. It is never
 *     assembled from two of them and never cached across requests.
 *  2. Nothing in this module ever renders a credential. `redactHeaders` is the
 *     only sanctioned way to put a header bag anywhere near a log line, and it
 *     replaces rather than masks, because a mask leaks length and prefix and
 *     both are enough to confirm a stolen key.
 *  3. The keyring is an interface. This package has no OS keyring dependency and
 *     must not grow one: the gateway is the component most likely to be pointed
 *     at a headless box where a native keychain module fails to load at import
 *     time, taking the whole proxy down before a request is served.
 */

export type ProviderId = 'anthropic' | 'openai' | 'gemini';

export const PROVIDERS: readonly ProviderId[] = ['anthropic', 'openai', 'gemini'];

/** The env var read for each provider when no explicit option is given. */
export const PROVIDER_ENV_VAR: Readonly<Record<ProviderId, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

/** Keychain namespace. Changing it invalidates every stored key, so it is fixed. */
export const KEYRING_SERVICE = 'strata-ctx';

/**
 * Header names redacted by name. Matched case-insensitively and compared
 * against the full lowercased name, not a prefix, so `x-api-key` and
 * `authorization` are both caught without also eating `x-api-key-id`, which is
 * a request id rather than a secret.
 */
export const SENSITIVE_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'set-cookie',
];

/**
 * Substrings that make a header sensitive regardless of its exact name. These
 * are the names nobody can enumerate: an integrator adds `x-goog-iam-token` or
 * `x-tenant-client-secret` and it has to be redacted the first time, not after
 * an incident review.
 */
const SENSITIVE_PATTERNS: readonly string[] = ['api-key', 'api_key', 'token', 'secret', 'cookie'];

/** True when a header name must never have its value logged. */
export function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (SENSITIVE_HEADERS.includes(lower)) return true;
  return SENSITIVE_PATTERNS.some((p) => lower.includes(p));
}

const isUsable = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.trim() !== '';

/**
 * The only string a credential is ever allowed to become. Length is kept
 * because "is this key still 40 chars" is a real diagnostic question, and the
 * first and last few characters are dropped because a prefix plus a known
 * length plus a known prefix scheme is a brute-force target.
 */
const MARKER_PREFIX = '[redacted:len=';

export function redactSecret(value: string): string {
  // A marker passes through unchanged. A log line that reaches two formatters
  // (a redaction pass over a re-logged error) would otherwise report the
  // length of the marker, which is worse than no number at all.
  if (value.startsWith(MARKER_PREFIX) && value.endsWith(']')) return value;
  return `${MARKER_PREFIX}${value.length}]`;
}

/**
 * A copy of `headers` that is safe to serialize. The input is never mutated:
 * callers pass the live outbound header bag here to log it, and a logging path
 * that can corrupt the request it is describing is not a logging path.
 */
export function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isSensitiveHeader(name) ? redactSecret(value) : value;
  }
  return out;
}

export type CredentialSourceKind = 'option' | 'env' | 'keyring';

export interface Credential {
  readonly provider: ProviderId;
  readonly value: string;
  readonly origin: CredentialSourceKind;
  /** Env var consulted, or null when the provider has none. Useful in errors. */
  readonly envVar: string;
}

/**
 * A loggable view of a credential. There is no function in this module that
 * takes a `Credential` and returns its value for display; if you want to know
 * what got resolved, this is what you get.
 */
export function describeCredential(credential: Credential): {
  provider: ProviderId;
  origin: CredentialSourceKind;
  envVar: string;
  length: number;
} {
  return {
    provider: credential.provider,
    origin: credential.origin,
    envVar: credential.envVar,
    length: credential.value.length,
  };
}

export interface KeyringAdapter {
  /**
   * Returns the stored secret, or null/undefined when there is none. May be
   * sync or async. Throwing is allowed: a locked or unavailable keychain is a
   * distinct failure from an empty one and is reported as such.
   */
  get(service: string, account: string): string | null | undefined | Promise<string | null | undefined>;
}

/** Default adapter. Stores nothing and finds nothing; not an error. */
export const nullKeyring: KeyringAdapter = {
  get: () => null,
};

export interface CredentialSource {
  /** Highest priority. Wins over everything, including a stale env var. */
  readonly credential?: string;
  /** Defaults to process.env. Injectable so resolution is testable. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to a keyring that finds nothing. */
  readonly keyring?: KeyringAdapter;
}

/** Keychain account name for a provider. Also the env var name. */
export const keyringAccount = (provider: ProviderId): string => PROVIDER_ENV_VAR[provider];

export class MissingCredentialError extends Error {
  readonly code = 'missing_credential' as const;
  readonly provider: ProviderId;
  readonly envVar: string;
  /** Which sources were consulted, in the order they were consulted. */
  readonly attempted: readonly CredentialSourceKind[];

  constructor(provider: ProviderId, attempted: readonly CredentialSourceKind[]) {
    const envVar = PROVIDER_ENV_VAR[provider];
    // The message names the places to look and nothing else. It must never
    // quote a value: this string reaches logs, and an error that is only
    // actionable because it contains the secret it is complaining about turns
    // a misconfiguration into a credential exfiltration.
    super(
      `No credential for provider "${provider}". Set ${envVar}, pass an explicit ` +
        `credential, or provide a keyring adapter (service "${KEYRING_SERVICE}", ` +
        `account "${envVar}").`,
    );
    this.name = 'MissingCredentialError';
    this.provider = provider;
    this.envVar = envVar;
    this.attempted = attempted;
  }
}

export class KeyringAccessError extends Error {
  readonly code = 'keyring_unavailable' as const;
  readonly provider: ProviderId;

  constructor(provider: ProviderId, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    // The adapter's message is included because a keychain failure is almost
    // always "no such secret" vs "user cancelled the prompt" vs "no such
    // service", and those need different fixes. The adapter is contractually
    // forbidden from putting the secret in its own message.
    super(`Keyring lookup for provider "${provider}" failed: ${detail}`);
    this.name = 'KeyringAccessError';
    this.provider = provider;
  }
}

export class UnsupportedProviderError extends Error {
  readonly code = 'unsupported_provider' as const;

  constructor(provider: string) {
    super(`Unsupported provider "${provider}". Known providers: ${PROVIDERS.join(', ')}.`);
    this.name = 'UnsupportedProviderError';
  }
}

/**
 * Resolve one credential, or throw. Order is explicit option -> env var ->
 * keyring, and the first usable value stops the search, so a user who exported
 * a key for the current shell is never silently overridden by a stale keychain
 * entry and a user who set a keyring entry is never forced to export anything.
 */
export async function resolveCredential(
  provider: ProviderId,
  source: CredentialSource = {},
): Promise<Credential> {
  if (!PROVIDERS.includes(provider)) throw new UnsupportedProviderError(provider);

  const envVar = PROVIDER_ENV_VAR[provider];
  const attempted: CredentialSourceKind[] = [];

  if (isUsable(source.credential)) {
    return { provider, value: source.credential.trim(), origin: 'option', envVar };
  }
  attempted.push('option');

  const env = source.env ?? process.env;
  const fromEnv = env[envVar];
  if (isUsable(fromEnv)) {
    return { provider, value: fromEnv.trim(), origin: 'env', envVar };
  }
  attempted.push('env');

  const keyring = source.keyring ?? nullKeyring;
  attempted.push('keyring');
  let fromKeyring: string | null | undefined;
  try {
    fromKeyring = await keyring.get(KEYRING_SERVICE, keyringAccount(provider));
  } catch (err) {
    // A broken keyring is reported as a broken keyring, not as a missing key:
    // "set ANTHROPIC_API_KEY" is wrong advice when the real problem is a locked
    // keychain, and the user would then paste a key into a shell profile.
    if (err instanceof MissingCredentialError || err instanceof UnsupportedProviderError) throw err;
    throw new KeyringAccessError(provider, err);
  }
  if (isUsable(fromKeyring)) {
    return { provider, value: fromKeyring.trim(), origin: 'keyring', envVar };
  }

  throw new MissingCredentialError(provider, attempted);
}

/**
 * The header each provider actually reads. Anthropic and Gemini take a bare key;
 * OpenAI takes a bearer token, and sending a bare key there fails with a 401
 * that reads like a bad key rather than a bad header.
 */
export const authHeaderFor = (provider: ProviderId): { name: string; prefix: string } => {
  switch (provider) {
    case 'anthropic':
      return { name: 'x-api-key', prefix: '' };
    case 'openai':
      return { name: 'authorization', prefix: 'Bearer ' };
    case 'gemini':
      return { name: 'x-goog-api-key', prefix: '' };
  }
};

/**
 * Returns a new header bag carrying the provider's auth header. Any existing
 * header for that provider is removed first, case-insensitively: a caller that
 * forwarded a client-supplied `Authorization` alongside our key would otherwise
 * end up with two, and which one the upstream picks is not ours to decide.
 */
export function applyCredentials(
  headers: Readonly<Record<string, string>>,
  credential: Credential,
): Record<string, string> {
  if (!PROVIDERS.includes(credential.provider)) throw new UnsupportedProviderError(credential.provider);
  const { name, prefix } = authHeaderFor(credential.provider);
  const lower = name.toLowerCase();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) continue;
    out[k] = v;
  }
  out[name] = `${prefix}${credential.value}`;
  return out;
}

/**
 * `applyCredentials` plus the foreign auth headers the upstream would otherwise
 * see. Forwarding a client-supplied `Authorization` next to our own key is how
 * a caller's token ends up in a provider's request log under the gateway's
 * account, so any header that is sensitive and not the one we are setting is
 * dropped rather than passed along.
 */
export function applyCredentialsStrict(
  headers: Readonly<Record<string, string>>,
  credential: Credential,
): Record<string, string> {
  const { name } = authHeaderFor(credential.provider);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) continue;
    if (isSensitiveHeader(k)) continue;
    out[k] = v;
  }
  return applyCredentials(out, credential);
}
