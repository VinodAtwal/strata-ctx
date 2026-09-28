import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';

/**
 * A-16: the gateway config document.
 *
 * The config file is operator-owned untrusted input, the same category as a
 * policy file, and it gets the same three properties a policy file gets:
 *
 * **Validation is total, not fail-fast.** `validateConfig` walks the whole
 * document and returns *every* problem. A loader that throws on the first one
 * makes an operator fix a typo, re-run, and find the next typo; a report of all
 * of them is the difference between one round trip and five.
 *
 * **Unknown keys are errors.** A silently ignored `dtaDir` is worse than no
 * config at all: the gateway starts, writes state next to the real data
 * directory, and the operator's setting looks applied because nothing threw.
 * Stricter than strictly necessary, on purpose -- that is the whole point of
 * having a schema.
 *
 * **A reload never breaks a running gateway.** `ConfigWatcher` holds the
 * last-known-good config and only ever publishes a document that validated. A
 * config that fails to parse is reported, not installed. Operators edit files
 * in place, and the file is briefly a half-written JSON document more often
 * than anyone expects.
 *
 * JSON only. Policy is YAML (D-3) because humans write long prose constraints;
 * this file is a small machine-checked record of ports and paths, and one
 * syntax is one thing to get right.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Which adapter the upstream speaks. `mock` is the deterministic fixture replay. */
export const PROVIDERS = ['anthropic', 'openai-compat', 'gemini', 'mock'] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface ListenConfig {
  readonly host: string;
  /** 0 asks the OS for an ephemeral port; anything else must be 1-65535. */
  readonly port: number;
}

export interface TimeoutConfig {
  /** Socket connect budget. */
  readonly connectMs: number;
  /** Whole-response budget, SSE tail included: a long agent turn is not a hang. */
  readonly requestMs: number;
  /** Grace period for in-flight requests on shutdown. */
  readonly shutdownMs: number;
}

/** A fully resolved config: every required field present, every default applied. */
export interface GatewayConfig {
  readonly listen: ListenConfig;
  readonly upstream: string;
  readonly policyPath: string;
  readonly dataDir: string;
  readonly logLevel: LogLevel;
  readonly provider: Provider;
  readonly timeouts: TimeoutConfig;
}

export type ConfigIssueCode =
  | 'missing'
  | 'type'
  | 'enum'
  | 'range'
  | 'format'
  | 'unknown_key'
  | 'not_object'
  | 'json'
  | 'io';

export interface ConfigIssue {
  /** Dot path into the document, e.g. `listen.port`. Empty means the document itself. */
  readonly path: string;
  readonly code: ConfigIssueCode;
  readonly message: string;
}

export type ParseResult =
  | { readonly ok: true; readonly config: GatewayConfig }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

export type ReloadResult =
  | { readonly ok: true; readonly config: GatewayConfig; readonly changed: boolean }
  /** `config` is the last-known-good config, unchanged by this failure. */
  | { readonly ok: false; readonly error: ConfigError; readonly config: GatewayConfig };

/** Every reason a config document was refused, at once. */
export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];
  /** File the document came from, when it came from one. */
  readonly source: string | undefined;

  constructor(issues: readonly ConfigIssue[], source?: string) {
    super(
      `${source ?? 'config'}: ${issues
        .map((i) => (i.path === '' ? i.message : `${i.path} ${i.message}`))
        .join('; ')}`,
    );
    this.name = 'ConfigError';
    this.issues = issues;
    this.source = source;
  }
}

// ------------------------------------------------------------------- helpers

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** JSON has six types and one of them is null, so "what did you actually put there". */
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
    let previous = row[0] ?? 0; // D[i-1][0]
    row[0] = i; // D[i][0]
    for (let j = 1; j <= b.length; j += 1) {
      const current = Math.min(
        (row[j] ?? 0) + 1, // delete
        (row[j - 1] ?? 0) + 1, // insert
        previous + (a[i - 1] === b[j - 1] ? 0 : 1), // substitute
      );
      previous = row[j] ?? 0; // D[i-1][j] for the next column
      row[j] = current;
    }
  }
  return row[b.length] ?? 0;
};

/** The key the typist meant, or undefined. Backs the "did you mean" suffix. */
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

const parseHttpUrl = (text: string): URL | undefined => {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
};

/** Stable because a resolved config is built field by field in a fixed order. */
const fingerprintOf = (config: GatewayConfig): string => JSON.stringify(config);

// ---------------------------------------------------------------- resolution

/**
 * The baseline. Frozen, because a module-level default that something can
 * mutate is a default some other code will have mutated by the time the next
 * caller reads it.
 *
 * `listen.host` is loopback and not `0.0.0.0`: this proxy holds the user's
 * conversation and the provider API key, and binding it to every interface is
 * not something to make the easy default.
 */
export const DEFAULT_CONFIG: GatewayConfig = deepFreeze<GatewayConfig>({
  listen: { host: '127.0.0.1', port: 8787 },
  upstream: 'http://127.0.0.1:9000',
  policyPath: './policy.yaml',
  dataDir: './.strata',
  logLevel: 'info',
  provider: 'anthropic',
  timeouts: { connectMs: 5_000, requestMs: 300_000, shutdownMs: 10_000 },
});

const TOP_LEVEL_KEYS = [
  'listen',
  'upstream',
  'policyPath',
  'dataDir',
  'logLevel',
  'provider',
  'timeouts',
] as const;

const LISTEN_KEYS = ['host', 'port'] as const;

const TIMEOUT_KEYS = ['connectMs', 'requestMs', 'shutdownMs'] as const;

const rejectUnknownKeys = (
  obj: Record<string, unknown>,
  known: readonly string[],
  prefix: string,
  noun: string,
  add: (path: string, code: ConfigIssueCode, message: string) => void,
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
 * One pass: collect every issue *and* build the config, so a caller that has
 * already paid for validation does not repeat the narrowing a second time. A
 * value that failed validation falls back to its default -- it never escapes,
 * because any issue at all makes the parse fail.
 */
const resolve = (input: unknown): ParseResult => {
  const issues: ConfigIssue[] = [];
  const add = (path: string, code: ConfigIssueCode, message: string): void => {
    issues.push({ path, code, message });
  };

  if (!isRecord(input)) {
    add('', 'not_object', `must be a JSON object, got ${typeName(input)}`);
    return { ok: false, issues: Object.freeze(issues) };
  }

  rejectUnknownKeys(input, TOP_LEVEL_KEYS, '', 'config', add);

  const requiredString = (
    obj: Record<string, unknown>,
    key: string,
    path: string = key,
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
      add(path, 'format', 'must not be empty');
      return undefined;
    }
    return value;
  };

  const enumField = <T extends string>(
    obj: Record<string, unknown>,
    key: string,
    allowed: readonly T[],
    fallback: T,
  ): T => {
    const value = obj[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'string') {
      add(key, 'type', `must be a string, got ${typeName(value)}`);
      return fallback;
    }
    if (!(allowed as readonly string[]).includes(value)) {
      add(key, 'enum', `must be one of ${allowed.join(', ')}, got "${value}"`);
      return fallback;
    }
    return value as T;
  };

  let host = DEFAULT_CONFIG.listen.host;
  let port = DEFAULT_CONFIG.listen.port;
  const listenRaw = input.listen;
  if (listenRaw === undefined) {
    add('listen', 'missing', 'is required (host and port)');
  } else if (!isRecord(listenRaw)) {
    add('listen', 'not_object', `must be an object, got ${typeName(listenRaw)}`);
  } else {
    rejectUnknownKeys(listenRaw, LISTEN_KEYS, 'listen', 'listen', add);
    const listenHost = requiredString(listenRaw, 'host', 'listen.host');
    if (listenHost !== undefined) host = listenHost;

    const listenPort = listenRaw.port;
    if (listenPort === undefined) {
      add('listen.port', 'missing', 'is required');
    } else if (typeof listenPort !== 'number') {
      add('listen.port', 'type', `must be a number, got ${typeName(listenPort)}`);
    } else if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65_535) {
      add(
        'listen.port',
        'range',
        `must be an integer in 0-65535 (0 means an ephemeral port), got ${listenPort}`,
      );
    } else {
      port = listenPort;
    }
  }

  let upstream = DEFAULT_CONFIG.upstream;
  const upstreamRaw = input.upstream;
  if (upstreamRaw === undefined) {
    add('upstream', 'missing', 'is required (the provider base URL)');
  } else if (typeof upstreamRaw !== 'string') {
    add('upstream', 'type', `must be a string, got ${typeName(upstreamRaw)}`);
  } else if (upstreamRaw.trim() === '') {
    add('upstream', 'format', 'must not be empty');
  } else if (parseHttpUrl(upstreamRaw) === undefined) {
    add(
      'upstream',
      'format',
      `must be an absolute http(s) URL such as http://127.0.0.1:9000, got "${upstreamRaw}"`,
    );
  } else {
    upstream = upstreamRaw;
  }

  const policyPath = requiredString(input, 'policyPath') ?? DEFAULT_CONFIG.policyPath;
  const dataDir = requiredString(input, 'dataDir') ?? DEFAULT_CONFIG.dataDir;
  const logLevel = enumField(input, 'logLevel', LOG_LEVELS, DEFAULT_CONFIG.logLevel);
  const provider = enumField(input, 'provider', PROVIDERS, DEFAULT_CONFIG.provider);

  const timeout = (obj: Record<string, unknown>, key: keyof TimeoutConfig): number => {
    const value = obj[key];
    if (value === undefined) return DEFAULT_CONFIG.timeouts[key];
    if (typeof value !== 'number') {
      add(`timeouts.${key}`, 'type', `must be a number, got ${typeName(value)}`);
      return DEFAULT_CONFIG.timeouts[key];
    }
    if (!Number.isInteger(value) || value < 1) {
      add(`timeouts.${key}`, 'range', `must be a whole number of milliseconds >= 1, got ${value}`);
      return DEFAULT_CONFIG.timeouts[key];
    }
    return value;
  };

  let timeouts: TimeoutConfig = { ...DEFAULT_CONFIG.timeouts };
  const timeoutsRaw = input.timeouts;
  if (timeoutsRaw === undefined) {
    // defaults, already copied above
  } else if (!isRecord(timeoutsRaw)) {
    add('timeouts', 'not_object', `must be an object, got ${typeName(timeoutsRaw)}`);
  } else {
    rejectUnknownKeys(timeoutsRaw, TIMEOUT_KEYS, 'timeouts', 'timeout', add);
    timeouts = {
      connectMs: timeout(timeoutsRaw, 'connectMs'),
      requestMs: timeout(timeoutsRaw, 'requestMs'),
      shutdownMs: timeout(timeoutsRaw, 'shutdownMs'),
    };
  }

  if (issues.length > 0) return { ok: false, issues: Object.freeze(issues) };
  return {
    ok: true,
    config: {
      listen: { host, port },
      upstream,
      policyPath,
      dataDir,
      logLevel,
      provider,
      timeouts,
    },
  };
};

/** All problems in `input`, in a stable order. Empty means valid. */
export function validateConfig(input: unknown): readonly ConfigIssue[] {
  const result = resolve(input);
  return result.ok ? [] : result.issues;
}

/** Non-throwing validation, for callers that treat a bad config as a state. */
export function safeParseConfig(input: unknown): ParseResult {
  return resolve(input);
}

/** Throws `ConfigError` with every issue; returns a fully resolved config otherwise. */
export function parseConfig(input: unknown): GatewayConfig {
  const result = resolve(input);
  if (!result.ok) throw new ConfigError(result.issues);
  return result.config;
}

const readDocument = (path: string): unknown => {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError([{ path: '', code: 'io', message: `cannot be read: ${detail}` }], path);
  }
  if (text.trim() === '') {
    throw new ConfigError([{ path: '', code: 'json', message: 'is empty' }], path);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError(
      [{ path: '', code: 'json', message: `is not valid JSON: ${detail}` }],
      path,
    );
  }
};

/** Read + validate. Throws `ConfigError` for an unreadable, unparseable, or invalid file. */
export function loadConfig(path: string): GatewayConfig {
  try {
    return parseConfig(readDocument(path));
  } catch (err) {
    if (err instanceof ConfigError && err.source !== undefined) throw err;
    // Schema issues, which the loader has to name the file for.
    const issues =
      err instanceof ConfigError
        ? err.issues
        : [{ path: '', code: 'io' as const, message: `cannot be read: ${String(err)}` }];
    throw new ConfigError(issues, path);
  }
}

// ------------------------------------------------------------------- watcher

/** One logical save is several syscalls, so events are coalesced before reading. */
export const DEFAULT_DEBOUNCE_MS = 40;

export interface ConfigWatcherOptions {
  readonly path: string;
  /** Called with a config that validated. Never called with one that did not. */
  readonly onChange: (config: GatewayConfig) => void;
  /** Called when a reload is refused. The last-known-good config stays live. */
  readonly onError?: (error: ConfigError) => void;
  readonly debounceMs?: number;
  /** Seed the last-known-good config instead of reading `path` in the constructor. */
  readonly initial?: GatewayConfig;
}

/**
 * Hot reload.
 *
 * **Watches the directory, not the file.** Editors, formatters and most deploy
 * tooling save atomically: write a sibling temp file, rename over the target.
 * That replaces the target's inode, and an `fs.watch` on the old inode goes
 * permanently quiet -- a watcher that appears to work until the first real save
 * is worse than no watcher. Watching the parent and filtering on the basename
 * survives rename, delete-and-recreate, and a file that does not exist yet.
 *
 * **Debounces.** A burst of writes is several events resolving to the same
 * final content. Every event restarts the timer, so the reload happens once,
 * after the writing settles, and reads the document that is on disk rather than
 * a half-written one.
 *
 * **Never installs a broken config.** The new document is validated before it is
 * published; a failure is reported and the previous config stays live.
 *
 * **`start()` re-reads once.** Reading the file and then arming the watch leaves
 * a window in which a write is not an event anybody will ever see. One
 * debounced re-read on start closes it, and is a no-op when nothing changed.
 *
 * Callbacks must not throw: they run inside a timer, where a throw becomes an
 * uncaught exception.
 */
export class ConfigWatcher {
  private readonly path: string;
  private readonly fileName: string;
  private readonly onChange: (config: GatewayConfig) => void;
  private readonly onError: ((error: ConfigError) => void) | undefined;
  private readonly debounceMs: number;
  private config: GatewayConfig;
  private fingerprint: string;
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(opts: ConfigWatcherOptions) {
    this.path = opts.path;
    this.fileName = basename(opts.path);
    this.onChange = opts.onChange;
    this.onError = opts.onError;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.config = opts.initial ?? loadConfig(opts.path);
    this.fingerprint = fingerprintOf(this.config);
  }

  /** The last-known-good config. Only ever a config that validated. */
  get current(): GatewayConfig {
    return this.config;
  }

  get closed(): boolean {
    return this.stopped;
  }

  /** Idempotent. Throws if called after `close()`: a closed watcher stays closed. */
  start(): this {
    if (this.stopped) throw new Error('ConfigWatcher cannot be restarted after close()');
    if (this.watcher !== undefined) return this;
    this.watcher = watch(dirname(this.path), (_event, name) => {
      this.onFsEvent(name);
    });
    this.watcher.on('error', (err: Error) => {
      this.report(
        new ConfigError([{ path: '', code: 'io', message: `watch failed: ${err.message}` }], this.path),
      );
    });
    // The constructor read the file before the watch existed, and a write
    // landing in that window is not an event anybody will ever see. One
    // debounced re-read closes the gap; it is a no-op when nothing changed.
    this.schedule();
    return this;
  }

  /** Read once, now. Same contract as an event-triggered reload. */
  reload(): ReloadResult {
    let result: ParseResult;
    try {
      result = safeParseConfig(readDocument(this.path));
    } catch (err) {
      const error =
        err instanceof ConfigError
          ? err
          : new ConfigError([{ path: '', code: 'io', message: String(err) }], this.path);
      this.report(error);
      return { ok: false, error, config: this.config };
    }
    if (!result.ok) {
      const error = new ConfigError(result.issues, this.path);
      this.report(error);
      return { ok: false, error, config: this.config };
    }
    const next = fingerprintOf(result.config);
    if (next === this.fingerprint) return { ok: true, config: this.config, changed: false };
    this.config = result.config;
    this.fingerprint = next;
    this.onChange(this.config);
    return { ok: true, config: this.config, changed: true };
  }

  /** Idempotent. Clears a pending debounce and releases the watch handle. */
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const watcher = this.watcher;
    this.watcher = undefined;
    if (watcher !== undefined) {
      try {
        watcher.close();
      } catch {
        // The runtime already closed it after a fatal watch error; nothing to release.
      }
    }
  }

  private onFsEvent(name: string | Buffer | null): void {
    if (this.stopped) return;
    // A null filename is a platform that declines to say; the only safe reading
    // is that something in the directory changed.
    if (name !== null && name.toString() !== this.fileName) return;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.reload();
    }, this.debounceMs);
  }

  private report(error: ConfigError): void {
    this.onError?.(error);
  }
}
