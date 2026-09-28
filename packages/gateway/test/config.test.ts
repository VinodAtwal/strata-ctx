import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { describe, it, test } from 'node:test';

import {
  ConfigError,
  ConfigWatcher,
  DEFAULT_CONFIG,
  DEFAULT_DEBOUNCE_MS,
  loadConfig,
  parseConfig,
  safeParseConfig,
  validateConfig,
  type ConfigIssue,
  type GatewayConfig,
} from '../src/config.js';

/**
 * A-16: config validation and hot reload.
 *
 * The two halves belong in one suite because they answer one question.
 * Validation exists to decide what may become the live config; the watcher's
 * entire job is to make "what happens when the operator saves a broken file"
 * have a single answer, and the only acceptable one is that the last-known-good
 * config keeps serving.
 *
 * Fixtures are inline on purpose: this is the only place in the repo that needs
 * a config document, and a shared fixture would freeze the schema shape for
 * every future caller.
 */

// ------------------------------------------------------------------ fixtures

/** The smallest document that validates. */
const minimal = {
  listen: { host: '127.0.0.1', port: 8787 },
  upstream: 'https://api.anthropic.com',
  policyPath: '/etc/strata/policy.yaml',
  dataDir: '/var/lib/strata',
} as const;

/** Every key present, nothing left to default. */
const complete = {
  ...minimal,
  logLevel: 'debug',
  provider: 'mock',
  timeouts: { connectMs: 1_000, requestMs: 2_000, shutdownMs: 3_000 },
} as const;

const doc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...minimal,
  ...over,
});

const issueAt = (issues: readonly ConfigIssue[], path: string): ConfigIssue => {
  const found = issues.find((i) => i.path === path);
  assert.ok(
    found,
    `expected an issue at "${path}", got ${JSON.stringify(issues.map((i) => `${i.path}:${i.code}`))}`,
  );
  return found;
};

/** Asserts that every named path is reported, and returns all the issues. */
const expectIssues = (input: unknown, ...paths: readonly string[]): readonly ConfigIssue[] => {
  const issues = validateConfig(input);
  for (const path of paths) issueAt(issues, path);
  return issues;
};

const summarise = (issues: readonly ConfigIssue[]): readonly string[] =>
  issues.map((i) => `${i.path}:${i.code}`);

/** The ConfigError a call threw, or undefined if it did not throw one. */
const caught = (fn: () => unknown): ConfigError | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof ConfigError ? err : undefined;
  }
};

/**
 * A temp directory that removes itself when the test ends. Cleanup is
 * registered on the test context rather than left to a `finally`, because a
 * failed assertion throws out of the callback.
 */
const tempDir = (t: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), 'strata-config-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
};

/** Writes a document (or a raw string, for malformed-JSON cases) and returns its path. */
const writeConfig = (dir: string, value: unknown): string => {
  const path = join(dir, 'config.json');
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return path;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (label: string, predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
};

interface Watched {
  readonly watcher: ConfigWatcher;
  readonly seen: readonly GatewayConfig[];
  readonly errors: readonly ConfigError[];
}

/** A started watcher that always closes itself at the end of the test. */
const watch = (
  t: TestContext,
  path: string,
  opts: { debounceMs?: number; initial?: GatewayConfig } = {},
): Watched => {
  const seen: GatewayConfig[] = [];
  const errors: ConfigError[] = [];
  const watcher = new ConfigWatcher({
    path,
    onChange: (config) => seen.push(config),
    onError: (error) => errors.push(error),
    debounceMs: opts.debounceMs ?? 30,
    ...(opts.initial === undefined ? {} : { initial: opts.initial }),
  }).start();
  t.after(() => {
    watcher.close();
  });
  return { watcher, seen, errors };
};

/** Live fs.watch handles. A watcher that is never closed shows up here forever. */
const fsWatchHandles = (): number =>
  (process.getActiveResourcesInfo?.() ?? []).filter((r) => r === 'FSEventWrap').length;

// ------------------------------------------------------------------ parsing

describe('parseConfig: a valid document', () => {
  it('parses every required field', () => {
    const config = parseConfig(minimal);
    assert.deepEqual(config.listen, { host: '127.0.0.1', port: 8787 });
    assert.equal(config.upstream, 'https://api.anthropic.com');
    assert.equal(config.policyPath, '/etc/strata/policy.yaml');
    assert.equal(config.dataDir, '/var/lib/strata');
  });

  it('parses the optional fields when they are given', () => {
    assert.deepEqual(parseConfig(complete), {
      listen: { host: '127.0.0.1', port: 8787 },
      upstream: 'https://api.anthropic.com',
      policyPath: '/etc/strata/policy.yaml',
      dataDir: '/var/lib/strata',
      logLevel: 'debug',
      provider: 'mock',
      timeouts: { connectMs: 1_000, requestMs: 2_000, shutdownMs: 3_000 },
    });
  });

  it('reports no issues for a valid document', () => {
    assert.deepEqual(validateConfig(complete), []);
  });

  it('accepts the exported baseline as a document', () => {
    // DEFAULT_CONFIG and the schema are one thing, not two that can drift.
    assert.deepEqual(parseConfig(DEFAULT_CONFIG), DEFAULT_CONFIG);
  });

  it('keeps an upstream path prefix intact', () => {
    const config = parseConfig(doc({ upstream: 'http://127.0.0.1:9000/v1' }));
    assert.equal(config.upstream, 'http://127.0.0.1:9000/v1', 'kept verbatim, not normalized');
  });

  it('accepts port 0 as a request for an ephemeral port', () => {
    assert.equal(parseConfig(doc({ listen: { host: '0.0.0.0', port: 0 } })).listen.port, 0);
  });
});

describe('parseConfig: defaults', () => {
  it('applies every optional default when they are absent', () => {
    const config = parseConfig(minimal);
    assert.equal(config.logLevel, DEFAULT_CONFIG.logLevel);
    assert.equal(config.provider, DEFAULT_CONFIG.provider);
    assert.deepEqual(config.timeouts, DEFAULT_CONFIG.timeouts);
  });

  it('keeps a partial timeouts block and defaults the rest', () => {
    const config = parseConfig(doc({ timeouts: { requestMs: 45_000 } }));
    assert.deepEqual(config.timeouts, {
      connectMs: DEFAULT_CONFIG.timeouts.connectMs,
      requestMs: 45_000,
      shutdownMs: DEFAULT_CONFIG.timeouts.shutdownMs,
    });
  });

  it('does not alias the frozen default objects', () => {
    // A resolved config that shares the frozen baseline cannot be safely
    // mutated by whoever consumes it, so the nested objects are copied.
    const config = parseConfig(minimal);
    assert.notEqual(config.listen, DEFAULT_CONFIG.listen);
    assert.notEqual(config.timeouts, DEFAULT_CONFIG.timeouts);
  });
});

describe('parseConfig: required fields', () => {
  it('reports every missing required field at once', () => {
    // Fail-fast validation costs the operator one round trip per typo.
    const issues = expectIssues({}, 'listen', 'upstream', 'policyPath', 'dataDir');
    assert.equal(issues.length, 4);
    for (const issue of issues) assert.equal(issue.code, 'missing');
  });

  it('reports one missing field by name', () => {
    const { policyPath: _omitted, ...rest } = minimal;
    const issues = expectIssues(rest, 'policyPath');
    assert.equal(issues.length, 1);
    assert.match(issues[0]?.message ?? '', /is required/);
  });

  it('reports a missing listen.port without also reporting listen.host', () => {
    const issues = expectIssues(doc({ listen: { host: '127.0.0.1' } }), 'listen.port');
    assert.equal(issues.length, 1);
  });

  it('reports a missing listen.host', () => {
    expectIssues(doc({ listen: { port: 8787 } }), 'listen.host');
  });

  it('treats an empty required string as a format problem, not a missing one', () => {
    assert.equal(issueAt(validateConfig(doc({ dataDir: '   ' })), 'dataDir').code, 'format');
  });

  it('rejects a document that is not an object', () => {
    for (const bad of [[], 'config', 42, null, true]) {
      assert.equal(issueAt(validateConfig(bad), '').code, 'not_object');
    }
  });

  it('rejects a listen block that is not an object', () => {
    assert.equal(issueAt(validateConfig(doc({ listen: '127.0.0.1:8787' })), 'listen').code, 'not_object');
  });
});

describe('parseConfig: unknown keys', () => {
  it('rejects a typo and names the key it was probably meant to be', () => {
    // A silently ignored `dtaDir` is a setting that looks applied and is not:
    // the gateway starts, writes state next to the real data directory, and
    // the operator's file has nothing wrong with it.
    const issue = issueAt(validateConfig(doc({ dtaDir: '/tmp' })), 'dtaDir');
    assert.equal(issue.code, 'unknown_key');
    assert.match(issue.message, /did you mean "dataDir"/);
  });

  it('reports several unknown keys together, sorted', () => {
    assert.deepEqual(
      summarise(validateConfig(doc({ zzz: 1, aaa: 2 }))),
      ['aaa:unknown_key', 'zzz:unknown_key'],
    );
  });

  it('rejects a case-only near miss as an error rather than accepting it', () => {
    const issue = issueAt(validateConfig(doc({ DTA_DIR: '/tmp' })), 'DTA_DIR');
    assert.equal(issue.code, 'unknown_key');
    assert.match(issue.message, /did you mean "dataDir"/);
  });

  it('rejects an unknown key inside listen', () => {
    const issue = issueAt(
      validateConfig(doc({ listen: { host: '::1', port: 1, porrt: 2 } })),
      'listen.porrt',
    );
    assert.equal(issue.code, 'unknown_key');
    assert.match(issue.message, /did you mean "port"/);
  });

  it('rejects an unknown key inside timeouts', () => {
    expectIssues(doc({ timeouts: { connectMs: 1, requestMS: 2 } }), 'timeouts.requestMS');
  });
});

describe('parseConfig: ports', () => {
  it('rejects a port of the wrong type', () => {
    const issue = issueAt(validateConfig(doc({ listen: { host: '127.0.0.1', port: '8787' } })), 'listen.port');
    assert.equal(issue.code, 'type');
    assert.match(issue.message, /must be a number/);
  });

  it('rejects a port above the valid range', () => {
    const issue = issueAt(validateConfig(doc({ listen: { host: '127.0.0.1', port: 70_000 } })), 'listen.port');
    assert.equal(issue.code, 'range');
  });

  it('rejects a negative or fractional port', () => {
    assert.equal(issueAt(validateConfig(doc({ listen: { port: -1 } })), 'listen.port').code, 'range');
    assert.equal(issueAt(validateConfig(doc({ listen: { port: 80.5 } })), 'listen.port').code, 'range');
  });
});

describe('parseConfig: upstream', () => {
  it('rejects an upstream of the wrong type', () => {
    assert.equal(issueAt(validateConfig(doc({ upstream: 9000 })), 'upstream').code, 'type');
  });

  it('rejects a string that is not a URL', () => {
    assert.equal(issueAt(validateConfig(doc({ upstream: 'api.anthropic.com' })), 'upstream').code, 'format');
  });

  it('rejects a non-http scheme', () => {
    // A missing or exotic scheme is a typo that would otherwise resolve to a
    // local path or an unsupported protocol at connect time.
    assert.equal(issueAt(validateConfig(doc({ upstream: 'ftp://host/' })), 'upstream').code, 'format');
    assert.equal(issueAt(validateConfig(doc({ upstream: 'file:///etc/passwd' })), 'upstream').code, 'format');
  });

  it('rejects an empty upstream', () => {
    assert.equal(issueAt(validateConfig(doc({ upstream: '' })), 'upstream').code, 'format');
  });
});

describe('parseConfig: enums and timeouts', () => {
  it('rejects an unknown log level and lists the levels', () => {
    const issue = issueAt(validateConfig(doc({ logLevel: 'verbose' })), 'logLevel');
    assert.equal(issue.code, 'enum');
    assert.match(issue.message, /debug, info, warn, error/);
  });

  it('rejects an unknown provider and lists the providers', () => {
    const issue = issueAt(validateConfig(doc({ provider: 'bedrock' })), 'provider');
    assert.equal(issue.code, 'enum');
    assert.match(issue.message, /anthropic, openai-compat, gemini, mock/);
  });

  it('rejects a non-string log level', () => {
    assert.equal(issueAt(validateConfig(doc({ logLevel: 3 })), 'logLevel').code, 'type');
  });

  it('rejects a timeouts block of the wrong type', () => {
    assert.equal(issueAt(validateConfig(doc({ timeouts: 30_000 })), 'timeouts').code, 'not_object');
  });

  it('rejects a fractional or non-positive timeout', () => {
    assert.equal(
      issueAt(validateConfig(doc({ timeouts: { connectMs: 1.5 } })), 'timeouts.connectMs').code,
      'range',
    );
    assert.equal(issueAt(validateConfig(doc({ timeouts: { connectMs: 0 } })), 'timeouts.connectMs').code, 'range');
  });

  it('rejects a non-number timeout', () => {
    const issue = issueAt(validateConfig(doc({ timeouts: { requestMs: '30s' } })), 'timeouts.requestMs');
    assert.equal(issue.code, 'type');
  });
});

describe('parseConfig: error reporting', () => {
  it('collects unrelated problems from every field in one pass', () => {
    const issues = expectIssues(
      { listen: { port: -1 }, upstream: 'nope', dtaDir: '/tmp', logLevel: 'loud' },
      'dtaDir',
      'listen.host',
      'listen.port',
      'upstream',
      'policyPath',
      'dataDir',
      'logLevel',
    );
    assert.equal(issues.length, 7);
  });

  it('throws a ConfigError carrying every issue', () => {
    const error = caught(() => parseConfig({ listen: { port: -1 }, bogus: true }));
    assert.ok(error);
    assert.equal(error.issues.length, 6);
    assert.match(error.message, /listen\.port must be an integer/);
    assert.match(error.message, /bogus is not a config key/);
    assert.equal(error.name, 'ConfigError');
  });

  it('throws the same issues it would have returned', () => {
    const input = doc({ logLevel: 'loud', dtaDir: '/tmp' });
    const returned = safeParseConfig(input);
    const error = caught(() => parseConfig(input));

    assert.ok(error);
    assert.equal(returned.ok, false);
    assert.deepEqual(returned.ok ? [] : summarise(returned.issues), summarise(error.issues));
  });

  it('safeParseConfig returns a config instead of throwing on a valid document', () => {
    const result = safeParseConfig(complete);
    assert.ok(result.ok);
    assert.equal(result.ok && result.config.provider, 'mock');
  });

  it('safeParseConfig returns the issues instead of throwing on a bad one', () => {
    const result = safeParseConfig(doc({ dataDir: 5 }));
    assert.equal(result.ok, false);
    assert.equal(result.ok ? 0 : result.issues.length, 1);
  });
});

// ----------------------------------------------------------- DEFAULT_CONFIG

describe('DEFAULT_CONFIG', () => {
  it('is deeply frozen, including the nested objects', () => {
    assert.ok(Object.isFrozen(DEFAULT_CONFIG));
    assert.ok(Object.isFrozen(DEFAULT_CONFIG.listen));
    assert.ok(Object.isFrozen(DEFAULT_CONFIG.timeouts));
  });

  it('throws when anything tries to mutate it', () => {
    // A module-level default that some code mutated is a default the next
    // caller no longer gets.
    assert.throws(() => Object.assign(DEFAULT_CONFIG, { listen: { host: '0.0.0.0', port: 1 } }), TypeError);
  });

  it('binds to loopback by default rather than every interface', () => {
    // This proxy holds the conversation and the provider API key.
    assert.equal(DEFAULT_CONFIG.listen.host, '127.0.0.1');
  });

  it('exports a debounce window long enough to coalesce one save', () => {
    assert.ok(DEFAULT_DEBOUNCE_MS > 0);
  });
});

// -------------------------------------------------------------- loadConfig

describe('loadConfig', () => {
  it('loads and validates a file from disk', (t) => {
    const path = writeConfig(tempDir(t), complete);
    assert.deepEqual(loadConfig(path), parseConfig(complete));
  });

  it('does not care about the key order in the file', (t) => {
    const dir = tempDir(t);
    const shuffled = {
      dataDir: minimal.dataDir,
      listen: { port: 8787, host: '127.0.0.1' },
      upstream: minimal.upstream,
      policyPath: minimal.policyPath,
    };
    assert.deepEqual(loadConfig(writeConfig(dir, shuffled)), parseConfig(minimal));
  });

  it('throws a ConfigError with an io issue when the file does not exist', (t) => {
    const path = join(tempDir(t), 'absent.json');
    const error = caught(() => loadConfig(path));
    assert.ok(error);
    assert.equal(error.issues[0]?.code, 'io');
    assert.equal(error.source, path);
  });

  it('throws a ConfigError with a json issue for a malformed document', (t) => {
    const error = caught(() => loadConfig(writeConfig(tempDir(t), '{ "listen": ')));
    assert.ok(error);
    assert.equal(error.issues[0]?.code, 'json');
  });

  it('treats an empty file as broken rather than as "use the defaults"', (t) => {
    // An editor that truncates on save is the most common way this file is
    // briefly invalid, and it must not silently resolve to a different gateway.
    const error = caught(() => loadConfig(writeConfig(tempDir(t), '   \n')));
    assert.ok(error);
    assert.match(error.message, /is empty/);
  });

  it('surfaces schema issues with the file named as the source', (t) => {
    const path = writeConfig(tempDir(t), doc({ prot: 'anthropic' }));
    const error = caught(() => loadConfig(path));
    assert.ok(error);
    assert.equal(error.source, path);
    assert.deepEqual(summarise(error.issues), ['prot:unknown_key']);
  });
});

// ------------------------------------------------------------ ConfigWatcher

describe('ConfigWatcher: reloading', () => {
  it('starts from the config on disk', (t) => {
    const path = writeConfig(tempDir(t), complete);
    const { watcher } = watch(t, path);
    assert.equal(watcher.current.logLevel, 'debug');
    assert.equal(watcher.closed, false);
  });

  it('emits a new config when the file changes', async (t) => {
    const dir = tempDir(t);
    const { watcher, seen } = watch(t, writeConfig(dir, complete));

    writeConfig(dir, doc({ listen: { host: '127.0.0.1', port: 9999 } }));
    await waitFor('the reloaded config', () => seen.length === 1);

    assert.equal(watcher.current.listen.port, 9999);
    assert.equal(seen[0]?.listen.port, 9999);
  });

  it('keeps emitting across successive changes', async (t) => {
    const dir = tempDir(t);
    const { watcher, seen } = watch(t, writeConfig(dir, complete));

    for (const port of [9001, 9002, 9003]) {
      writeConfig(dir, doc({ listen: { host: '127.0.0.1', port } }));
      await waitFor(`port ${port}`, () => watcher.current.listen.port === port);
    }
    assert.equal(seen.length, 3);
  });

  it('survives an atomic save, which is what a file watch loses', async (t) => {
    // Write-then-rename is what editors and deploy tooling do, and it replaces
    // the inode an fs.watch on the file itself was attached to.
    const dir = tempDir(t);
    const path = writeConfig(dir, complete);
    const { watcher, seen } = watch(t, path);
    const staging = join(dir, 'config.json.tmp');

    writeFileSync(staging, JSON.stringify(doc({ listen: { host: '127.0.0.1', port: 9100 } })));
    renameSync(staging, path);
    await waitFor('the renamed save', () => seen.length === 1);

    writeFileSync(staging, JSON.stringify(doc({ listen: { host: '127.0.0.1', port: 9101 } })));
    renameSync(staging, path);
    await waitFor('the second renamed save', () => seen.length === 2);
    assert.equal(watcher.current.listen.port, 9101);
  });

  it('survives a delete and recreate', async (t) => {
    const dir = tempDir(t);
    const path = writeConfig(dir, complete);
    const { watcher, seen } = watch(t, path);

    unlinkSync(path);
    writeConfig(dir, doc({ listen: { host: '127.0.0.1', port: 9200 } }));
    await waitFor('the recreate', () => seen.length === 1);
    assert.equal(watcher.current.listen.port, 9200);
  });

  it('ignores writes to other files in the same directory', async (t) => {
    // The watch is on the directory, so the filename filter is the only thing
    // standing between a temp file and a spurious reload.
    const dir = tempDir(t);
    const { watcher, seen } = watch(t, writeConfig(dir, complete), { debounceMs: 20 });

    writeFileSync(join(dir, 'notes.txt'), 'unrelated');
    writeFileSync(join(dir, 'config.json.bak'), JSON.stringify(complete));
    await sleep(200);

    assert.deepEqual(seen, []);
    assert.deepEqual(watcher.current, parseConfig(complete));
  });

  it('does not emit when the resolved config is unchanged', async (t) => {
    // A formatter reordering keys, or an editor merely touching the file, is
    // not a configuration change and must not restart anything downstream.
    const dir = tempDir(t);
    const { seen, errors } = watch(t, writeConfig(dir, complete), { debounceMs: 20 });

    writeFileSync(join(dir, 'config.json'), JSON.stringify(complete));
    await sleep(150);

    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        timeouts: { shutdownMs: 3_000, requestMs: 2_000, connectMs: 1_000 },
        dataDir: minimal.dataDir,
        listen: { port: 8787, host: '127.0.0.1' },
        provider: 'mock',
        upstream: minimal.upstream,
        logLevel: 'debug',
        policyPath: minimal.policyPath,
      }),
    );
    await sleep(150);

    assert.deepEqual(seen, [], 'same settings, different bytes');
    assert.deepEqual(errors, []);
  });

  it('honours a custom debounce window', async (t) => {
    const dir = tempDir(t);
    const { seen } = watch(t, writeConfig(dir, complete), { debounceMs: 250 });

    writeConfig(dir, doc({ listen: { host: '127.0.0.1', port: 9300 } }));
    await sleep(120);
    assert.deepEqual(seen, [], 'still inside the debounce window');

    await waitFor('the debounced reload', () => seen.length === 1);
  });
});

describe('ConfigWatcher: debounce', () => {
  it('collapses a burst of writes into one reload of the final document', async (t) => {
    // Every write here is a *different* config, so an undebounced watcher would
    // publish four of them and restart the gateway four times.
    const dir = tempDir(t);
    const path = writeConfig(dir, complete);
    const { watcher, seen } = watch(t, path, { debounceMs: 150 });

    for (const port of [9401, 9402, 9403, 9404]) {
      writeFileSync(path, JSON.stringify(doc({ listen: { host: '127.0.0.1', port } })));
      await sleep(10);
    }
    await sleep(400);

    assert.equal(seen.length, 1, 'one burst of writes, one reload');
    assert.equal(watcher.current.listen.port, 9404, 'the last write, not the first');
  });
});

describe('ConfigWatcher: last-known-good', () => {
  it('keeps serving the last good config when a reload is malformed', async (t) => {
    const dir = tempDir(t);
    const { watcher, seen, errors } = watch(t, writeConfig(dir, complete));

    writeConfig(dir, '{ "listen": { "port": ');
    await waitFor('the refusal', () => errors.length === 1);

    assert.equal(errors[0]?.issues[0]?.code, 'json');
    assert.deepEqual(watcher.current, parseConfig(complete), 'never swapped in a broken config');
    assert.deepEqual(seen, [], 'a refused reload is not a change');
  });

  it('keeps the last good config when a reload violates the schema', async (t) => {
    const dir = tempDir(t);
    const { watcher, seen, errors } = watch(t, writeConfig(dir, complete));

    writeConfig(dir, { ...complete, listen: { host: '127.0.0.1', port: 70_000 } });
    await waitFor('the refusal', () => errors.length === 1);

    assert.equal(errors[0]?.issues[0]?.code, 'range');
    assert.equal(watcher.current.listen.port, 8787);
    assert.deepEqual(seen, []);
  });

  it('reports every problem in a refused reload, not just the first', async (t) => {
    const dir = tempDir(t);
    const { errors } = watch(t, writeConfig(dir, complete));

    writeConfig(dir, { listen: { port: -1 }, dtaDir: '/tmp' });
    await waitFor('the refusal', () => errors.length === 1);

    assert.deepEqual(summarise(errors[0]?.issues ?? []), [
      'dtaDir:unknown_key',
      'listen.host:missing',
      'listen.port:range',
      'upstream:missing',
      'policyPath:missing',
      'dataDir:missing',
    ]);
  });

  it('recovers when the operator fixes the file', async (t) => {
    const dir = tempDir(t);
    const { watcher, seen, errors } = watch(t, writeConfig(dir, complete));

    writeConfig(dir, 'not json at all');
    await waitFor('the refusal', () => errors.length === 1);

    writeConfig(dir, doc({ listen: { host: '127.0.0.1', port: 9500 } }));
    await waitFor('the recovery', () => seen.length === 1);

    assert.equal(watcher.current.listen.port, 9500);
    assert.equal(errors.length, 1, 'the broken write was still reported');
  });

  it('survives a watcher with no onError callback', async (t) => {
    // Refusing a reload is the whole behaviour; reporting it is optional.
    const dir = tempDir(t);
    const seen: GatewayConfig[] = [];
    const watcher = new ConfigWatcher({
      path: writeConfig(dir, complete),
      onChange: (config) => seen.push(config),
      debounceMs: 20,
    }).start();
    t.after(() => {
      watcher.close();
    });

    writeConfig(dir, '{{{');
    await sleep(150);
    writeConfig(dir, doc({ listen: { host: '127.0.0.1', port: 9600 } }));
    await waitFor('the recovery', () => seen.length === 1);

    assert.equal(watcher.current.listen.port, 9600);
  });
});

describe('ConfigWatcher: manual reload and construction', () => {
  it('reload() reads once, now, and reports the outcome', (t) => {
    const dir = tempDir(t);
    const { watcher, seen } = watch(t, writeConfig(dir, complete));

    writeConfig(dir, doc({ listen: { host: '127.0.0.1', port: 9700 } }));
    const result = watcher.reload();

    assert.ok(result.ok);
    assert.equal(result.ok && result.config.listen.port, 9700);
    assert.equal(result.ok && result.changed, true);
    assert.equal(seen.length, 1);
  });

  it('reload() reports a no-op when nothing changed', (t) => {
    const { watcher, seen } = watch(t, writeConfig(tempDir(t), complete));

    const result = watcher.reload();
    assert.equal(result.ok && result.changed, false);
    assert.deepEqual(seen, []);
  });

  it('reload() refuses an invalid file and hands back the config still live', (t) => {
    const dir = tempDir(t);
    const { watcher, seen, errors } = watch(t, writeConfig(dir, complete));

    writeConfig(dir, { ...complete, dataDir: 7 });
    const result = watcher.reload();

    assert.equal(result.ok, false);
    assert.equal(result.ok ? 0 : result.config === watcher.current, true);
    assert.deepEqual(watcher.current, parseConfig(complete));
    assert.deepEqual(summarise(errors[0]?.issues ?? []), ['dataDir:type']);
    assert.deepEqual(seen, []);
  });

  it('refuses to construct on a file that is already invalid', (t) => {
    // The watcher starts from a known-good config; it is not a supervisor that
    // boots the gateway into an unknown state and waits for a fix.
    const path = writeConfig(tempDir(t), doc({ listen: { host: '127.0.0.1' } }));
    const error = caught(
      () =>
        new ConfigWatcher({
          path,
          onChange: () => undefined,
        }),
    );
    assert.ok(error);
    assert.deepEqual(summarise(error.issues), ['listen.port:missing']);
  });

  it('accepts an initial config without reading the file', (t) => {
    const dir = tempDir(t);
    const { watcher } = watch(t, writeConfig(dir, { nonsense: true }), {
      initial: parseConfig(complete),
    });
    assert.deepEqual(watcher.current, parseConfig(complete));
  });
});

describe('ConfigWatcher: teardown', () => {
  it('releases the watch handle on close', async (t) => {
    // The handle is a live libuv resource: a watcher left open keeps the event
    // loop alive and re-reads the file for the rest of the process's life.
    const before = fsWatchHandles();
    const { watcher } = watch(t, writeConfig(tempDir(t), complete));

    assert.ok(fsWatchHandles() > before, 'the watch is live while started');
    watcher.close();
    await waitFor('the handle to be released', () => fsWatchHandles() <= before);
  });

  it('is idempotent and stops updating after close', async (t) => {
    const dir = tempDir(t);
    const { watcher, seen } = watch(t, writeConfig(dir, complete));

    watcher.close();
    watcher.close();
    assert.equal(watcher.closed, true);

    writeConfig(dir, doc({ listen: { host: '127.0.0.1', port: 9800 } }));
    await sleep(200);
    assert.deepEqual(seen, []);
    assert.deepEqual(watcher.current, parseConfig(complete));
  });

  it('clears a pending reload, so a close is immediate', async (t) => {
    const dir = tempDir(t);
    const { watcher, seen } = watch(t, writeConfig(dir, complete), { debounceMs: 120 });

    writeConfig(dir, doc({ listen: { host: '127.0.0.1', port: 9900 } }));
    watcher.close();
    await sleep(300);

    assert.deepEqual(seen, [], 'the debounce timer was cleared, not left to fire');
  });

  it('start() is idempotent and refused after close', (t) => {
    const before = fsWatchHandles();
    const { watcher } = watch(t, writeConfig(tempDir(t), complete));

    watcher.start();
    assert.equal(fsWatchHandles(), before + 1, 'a second start does not open a second watch');

    watcher.close();
    assert.throws(() => watcher.start(), /cannot be restarted/);
  });
});

test('no watcher handle survives this suite', async () => {
  // The last test is the only one that can see every watcher this file ever
  // opened, so it is the only place a leak would be observable. Closing a
  // watch releases the handle on a later tick, hence the wait.
  await waitFor('every watch handle to be released', () => fsWatchHandles() === 0);
  assert.equal(fsWatchHandles(), 0);
});
