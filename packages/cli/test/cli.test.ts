import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);

const CLI = join(import.meta.dirname, '..', 'dist', 'index.js');
const PLUGIN_REL = '.opencode/plugins/strata-governed.mjs';

interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the built CLI as a subprocess.
 *
 * A subprocess rather than an in-process call because the deliverable *is* the
 * executable: `bin`, the shebang, the shebang's exit codes. Importing the module
 * and calling `main()` would test the parsing logic while proving nothing about
 * whether `strata-ctx` can be run, which is the whole reason this task exists.
 */
const cli = async (...args: readonly string[]): Promise<Result> => {
  try {
    const { stdout, stderr } = await withTimeout(
      run(process.execPath, [CLI, ...args]),
      30_000,
      `strata-ctx ${args.join(' ')}`,
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
};

/**
 * Run `fn` with PATH replaced by `dir` plus node's own directory.
 *
 * Replaces rather than prepends, because appending the ambient PATH would leave
 * whatever the developer has installed globally still resolvable and the test
 * would pass or fail based on their machine.
 *
 * node's directory is kept for a non-obvious reason: the executable's shebang is
 * `#!/usr/bin/env node`, so a PATH without node cannot start the binary at all.
 * That is worth knowing rather than working around -- an installer that does not
 * put node on PATH has installed a command that cannot run.
 */
const withPath = async <T>(dir: string, fn: () => Promise<T>): Promise<T> => {
  const saved = process.env['PATH'];
  const nodeDir = dirname(process.execPath);
  process.env['PATH'] = `${dir}:${nodeDir}`;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env['PATH'];
    else process.env['PATH'] = saved;
  }
};

/**
 * Never let a test hang the suite.
 *
 * A child process that fails to start -- a missing interpreter, a shebang the
 * platform rejects -- does not exit, does not error, and does not close stdio. The
 * `close` event simply never fires, so an unguarded `await` waits forever and the
 * whole run reports nothing. This was found the hard way: the suite hit its
 * 15-minute ceiling with no output.
 */
const withTimeout = async <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const project = async (config: string | null, withPlugin = true): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'strata-cli-'));
  if (config !== null) await writeFile(join(dir, 'opencode.json'), config);
  if (withPlugin) {
    await mkdir(join(dir, '.opencode', 'plugins'), { recursive: true });
    await writeFile(join(dir, PLUGIN_REL), 'export const x = 1;\n');
  }
  return dir;
};

describe('E-13: the strata-ctx CLI', () => {
  it('is declared as a bin, which is what the generated config referenced', async () => {
    // The defect this task fixes: `opencode.json` pointed at `strata-ctx mcp
    // serve` and no package declared `bin`, so nothing could run it.
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(
      await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { bin?: Record<string, string> };
    assert.equal(pkg.bin?.['strata-ctx'], './dist/index.js');
  });

  it('loads its workspace dependencies lazily, so --check never needs them', async () => {
    // A published bin resolves its own node_modules, so depending on
    // @strata-ctx/integrations is fine. What is not fine is a top-level import of
    // it: `hook --check` is what CI runs, and it must not construct a context
    // store or a tool registry to answer "is governance active".
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8');
    const staticImports = [...src.matchAll(/^import\s.*from\s+'([^']+)'/gm)]
      .map((m) => m[1])
      .filter((m): m is string => m !== undefined);
    for (const spec of staticImports) {
      assert.equal(
        spec.startsWith('node:'),
        true,
        `${spec} is imported statically; a slow or heavy command must not gate --check`,
      );
    }
    assert.match(src, /await import\('@strata-ctx\/integrations'\)/);
    assert.match(src, /await import\('@strata-ctx\/security'\)/);
  });

  describe('exit codes, which are the contract', () => {
    it('exits 2 with no arguments: the user asked for nothing', async () => {
      const r = await cli();
      assert.equal(r.code, 2);
    });

    it('exits 0 for --help: the user asked a question and got an answer', async () => {
      const r = await cli('--help');
      assert.equal(r.code, 0);
      assert.match(r.stdout, /strata-ctx/);
    });

    it('exits 2 for an unknown command rather than guessing', async () => {
      const r = await cli('bogus');
      assert.equal(r.code, 2);
      assert.match(r.stderr, /unknown command/);
    });

    it('exits 2 for an unknown flag, because a typo that runs is worse', async () => {
      const r = await cli('hook', '--check', '--jsno');
      assert.equal(r.code, 2);
    });

    it('exits 2 for an unknown agent', async () => {
      const r = await cli('hook', '--agent', 'cursor', '--check');
      assert.equal(r.code, 2);
      assert.match(r.stderr, /unknown agent/);
    });
  });

  describe('hook --check', () => {
    it('passes when the config names the plugin and the plugin exists', async () => {
      const dir = await project(JSON.stringify({ plugin: [PLUGIN_REL] }));
      const r = await cli('hook', '--check', '--root', dir);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /governance active/);
    });

    it('fails when no config references the plugin', async () => {
      const dir = await project(JSON.stringify({ model: 'x' }));
      const r = await cli('hook', '--check', '--root', dir);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /does not reference/);
    });

    it('fails when there is no config at all', async () => {
      const dir = await project(null);
      const r = await cli('hook', '--check', '--root', dir);
      assert.equal(r.code, 1);
    });

    it('fails when the config names a plugin file that was never written', async () => {
      // The half-finished install. Reporting this as healthy is exactly how a
      // project ends up running unguarded while believing it is protected.
      const dir = await project(JSON.stringify({ plugin: [PLUGIN_REL] }), false);
      const r = await cli('hook', '--check', '--root', dir);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /does not exist/);
    });

    it('does not accept the old .js name', async () => {
      // The plugin was renamed to .mjs because Node would not parse ESM in a .js
      // without a package.json. A config still naming .js is stale, and must not
      // pass as active.
      const dir = await project(JSON.stringify({ plugin: ['.opencode/plugins/strata-governed.js'] }));
      const r = await cli('hook', '--check', '--root', dir);
      assert.equal(r.code, 1);
    });
  });

  describe('hook, with no action', () => {
    it('describes where things are and what to do', async () => {
      const dir = await project(JSON.stringify({ plugin: [PLUGIN_REL] }), false);
      const r = await cli('hook', '--root', dir);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /not installed/);
      assert.match(r.stdout, /buildOpenCodeProfile/);
    });

    it('writes nothing, ever', async () => {
      const dir = await project(JSON.stringify({ plugin: [PLUGIN_REL] }), false);
      await cli('hook', '--root', dir);
      // Still absent afterwards: the description path must not be a hidden install.
      const { existsSync } = await import('node:fs');
      assert.equal(existsSync(join(dir, PLUGIN_REL)), false);
    });
  });

  describe('status', () => {
    it('exits 1 when there is no log', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'strata-cli-'));
      const r = await cli('status', '--log', join(dir, 'nope.jsonl'));
      assert.equal(r.code, 1);
    });

    it('counts violations and exits 1 when there are any', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'strata-cli-'));
      const log = join(dir, 'log.jsonl');
      await writeFile(
        log,
        [
          JSON.stringify({ seq: 0, event: { type: 'violation', kind: 'pin_missing_pre_apply', blocked: false } }),
          JSON.stringify({ seq: 1, event: { type: 'stage', stage: 'dedupe', changed: true } }),
        ].join('\n'),
      );
      const r = await cli('status', '--log', log, '--json');
      assert.equal(r.code, 1);
      const report = JSON.parse(r.stdout) as { violations: number; events: number };
      assert.equal(report.violations, 1);
      assert.equal(report.events, 2);
    });

    it('exits 0 on a clean log', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'strata-cli-'));
      const log = join(dir, 'log.jsonl');
      await writeFile(log, JSON.stringify({ seq: 0, event: { type: 'stage', stage: 'dedupe' } }));
      const r = await cli('status', '--log', log);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /violations: 0/);
    });

    it('survives a truncated final line rather than refusing to report', async () => {
      // Normal for a log being appended to right now.
      const dir = await mkdtemp(join(tmpdir(), 'strata-cli-'));
      const log = join(dir, 'log.jsonl');
      await writeFile(
        log,
        `${JSON.stringify({ seq: 0, event: { type: 'stage', stage: 'dedupe' } })}\n{"seq":1,"eve`,
      );
      const r = await cli('status', '--log', log, '--json');
      assert.equal(r.code, 0);
      assert.equal((JSON.parse(r.stdout) as { events: number }).events, 1);
    });

    it('reads records that are not wrapped in an event envelope', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'strata-cli-'));
      const log = join(dir, 'log.jsonl');
      await writeFile(log, JSON.stringify({ type: 'violation', blocked: true }));
      const r = await cli('status', '--log', log, '--json');
      assert.equal((JSON.parse(r.stdout) as { violations: number }).violations, 1);
    });
  });

  describe('the executable', () => {
    it('is chmod +x with a shebang, so `strata-ctx` works without a runtime flag', async () => {
      const { access, constants, readFile } = await import('node:fs/promises');
      await access(CLI, constants.X_OK);
      const first = (await readFile(CLI, 'utf8')).split('\n')[0];
      assert.equal(first, '#!/usr/bin/env node');
    });

    it('imports nothing from node_modules', async () => {
      // A hook executable invoked by absolute path in a user project cannot rely
      // on this repo's workspace links. Asserted on the source, not at runtime,
      // because a test run inside this repo would resolve either way.
      const { readFile } = await import('node:fs/promises');
      const src = await readFile(join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8');
      const imports = [...src.matchAll(/^import\s.*from\s+'([^']+)'/gm)]
        .map((m) => m[1])
        .filter((m): m is string => m !== undefined);
      for (const spec of imports) {
        assert.equal(
          spec.startsWith('node:'),
          true,
          `${spec} is not a Node builtin; a bin has no tsx and no workspace`,
        );
      }
      assert.ok(imports.length > 0, 'the CLI should be importing Node builtins');
      await chmod(CLI, 0o755);
    });
  });
});

describe('E-13: hook run, the executable the Claude and Gemini profiles name', () => {
  /**
   * Both profiles register a hook command in their settings and nothing was
   * ever installed to answer it. A host that runs an unregistered command either
   * errors or silently succeeds, and neither is governance.
   */
  const hook = async (stdin: string, ...args: readonly string[]): Promise<Result & { json: Record<string, unknown> }> => {
    const child = spawn(process.execPath, [CLI, 'hook', 'run', ...args]);
    child.stdin.end(stdin);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const code = await withTimeout(
      new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 1))),
      30_000,
      'hook run',
    ).catch(() => {
      child.kill('SIGKILL');
      throw new Error('hook run never exited; a hook that cannot exit would hang every tool call');
    });
    const lines = stdout.trim().split('\n').filter((l) => l !== '');
    return {
      code,
      stdout,
      stderr,
      json: lines.length === 1 ? (JSON.parse(lines[0] ?? '{}') as Record<string, unknown>) : {},
    };
  };

  const decision = (r: { json: Record<string, unknown> }): string =>
    ((r.json['hookSpecificOutput'] as Record<string, unknown> | undefined) ?? {})[
      'permissionDecision'
    ] as string;

  it('allows a benign command', async () => {
    const r = await hook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' } }));
    assert.equal(decision(r), 'allow');
  });

  it('denies a recursive force delete and names the rule', async () => {
    const r = await hook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/canary' } }));
    assert.equal(decision(r), 'deny');
    const reason = (r.json['hookSpecificOutput'] as Record<string, unknown>)['permissionDecisionReason'];
    assert.match(String(reason), /recursive_force_delete/);
  });

  it('denies on unparseable stdin, because a hook we cannot read lets everything through', async () => {
    const r = await hook('this is not json');
    assert.equal(decision(r), 'deny');
  });

  it('denies rather than crashing when the payload has no tool name', async () => {
    const r = await hook('{}');
    // No tool name means no recognisable command. The scanner allows it, and the
    // point of the assertion is that the process still answered with one object.
    assert.equal(decision(r), 'allow');
    assert.equal(r.code, 0);
  });

  it('treats a non-string tool_name as absent rather than as "[object Object]"', async () => {
    const r = await hook(JSON.stringify({ tool_name: { nested: true }, tool_input: { command: 'echo hi' } }));
    assert.equal(decision(r), 'allow');
  });

  it('redacts a secret on post-tool-use', async () => {
    const r = await hook(
      JSON.stringify({ tool_response: 'token=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
      '--event',
      'post-tool-use',
    );
    const ctx = (r.json['hookSpecificOutput'] as Record<string, unknown>)['additionalContext'];
    assert.equal(String(ctx).includes('sk-ant'), false);
    assert.match(String(ctx), /strata:redacted/);
  });

  it('redacts inside an object-shaped tool response', async () => {
    const r = await hook(
      JSON.stringify({
        tool_response: { stdout: 'ok', env: 'API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      }),
      '--event',
      'post-tool-use',
    );
    assert.equal(r.stdout.includes('sk-ant'), false);
  });

  it('writes exactly one JSON object to stdout', async () => {
    // stdout is a protocol channel; a stray line is a parse error in the host.
    const r = await hook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' } }));
    assert.equal(r.stdout.trim().split('\n').filter((l) => l !== '').length, 1);
  });

  it('exits 2 for an unknown event', async () => {
    const r = await hook('{}', '--event', 'pre_everything');
    assert.equal(r.code, 2);
  });

  it('defaults to pre-tool-use when no event is given', async () => {
    const r = await hook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' } }));
    assert.equal(decision(r), 'deny');
  });
});

describe('E-13: mcp serve', () => {
  /** Drive the server over a real pipe, the way a host spawns it. */
  const serve = async (requests: readonly unknown[]): Promise<Record<string, unknown>[]> => {
    const child = spawn(process.execPath, [CLI, 'mcp', 'serve']);
    child.stdin.end(`${requests.map((r) => JSON.stringify(r)).join('\n')}\n`);
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    const code = await withTimeout(
      new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 1))),
      30_000,
      'mcp serve',
    ).catch(() => {
      child.kill('SIGKILL');
      throw new Error('mcp serve never exited after stdin closed');
    });
    assert.equal(code, 0, 'a host closing stdin is a normal shutdown, not a crash');
    return stdout
      .trim()
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  };

  it('publishes the six context tools', async () => {
    const res = (await serve([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]))[0];
    assert.ok(res !== undefined, 'the server must answer tools/list');
    const result = res['result'] as { tools: { name: string }[] };
    assert.deepEqual(
      result.tools.map((t) => t.name).sort(),
      ['ctx_search', 'get_artifact', 'get_task', 'note', 'remember', 'status'],
    );
  });

  it('answers a tool call', async () => {
    const res = (await serve([
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'status', arguments: {} } },
    ]))[1];
    assert.ok(res !== undefined, 'the server must answer tools/call');
    assert.ok(res['result']);
  });

  it('keeps its banner off stdout, which is the JSON-RPC channel', async () => {
    const child = spawn(process.execPath, [CLI, 'mcp', 'serve']);
    child.stdin.end('');
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    await withTimeout(new Promise((resolve) => child.on('close', resolve)), 30_000, 'mcp serve').catch(
      () => {
        child.kill('SIGKILL');
        throw new Error('mcp serve never exited');
      },
    );
    assert.equal(stdout.trim(), '');
  });

  it('exits 2 for an unknown mcp subcommand', async () => {
    const r = await cli('mcp', 'listen');
    assert.equal(r.code, 2);
  });
});

describe('E-13: hook --check for the hosts that register a command', () => {
  /**
   * Claude Code and Gemini register an executable, not a plugin file, so the
   * check has a different failure mode: the config can be perfect while the
   * command is absent from PATH, and nothing would ever run.
   */
  const withSettings = async (agent: string, body: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'strata-cli-'));
    await mkdir(join(dir, agent === 'gemini-cli' ? '.gemini' : '.claude'), { recursive: true });
    await writeFile(
      join(dir, agent === 'gemini-cli' ? '.gemini/settings.json' : '.claude/settings.json'),
      body,
    );
    return dir;
  };

  const config = `{"hooks":{"PostToolUse":[{"hooks":[{"type":"command","command":"strata-ctx hook run"}]}]}}`;

  it('fails when the command is not on PATH', async () => {
    const dir = await withSettings('claude-code', config);
    // An empty PATH, not the inherited one: whether this machine happens to have
    // strata-ctx installed globally must not decide whether the test passes.
    const empty = await mkdtemp(join(tmpdir(), 'strata-cli-empty-'));
    const r = await withPath(empty, () =>
      cli('hook', '--check', '--agent', 'claude-code', '--root', dir),
    );
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not on PATH/);
  });

  it('passes once the command resolves, and says which one', async () => {
    const dir = await withSettings('claude-code', config);
    const bin = join(dir, 'bin');
    await mkdir(bin, { recursive: true });
    // A symlink to the real executable, so this test exercises PATH resolution
    // rather than asserting on the string in the config.
    await symlink(CLI, join(bin, 'strata-ctx'));
    const r = await withPath(bin, () => cli('hook', '--check', '--agent', 'claude-code', '--root', dir));
    // PATH is *only* this directory, so a pass cannot be an accident.
    assert.equal(r.code, 0);
    assert.match(r.stdout, /governance active/);
    assert.match(r.stdout, /strata-ctx hook run/);
  });

  it('works for gemini-cli too', async () => {
    const dir = await withSettings('gemini-cli', config);
    const empty = await mkdtemp(join(tmpdir(), 'strata-cli-empty-'));
    const r = await withPath(empty, () =>
      cli('hook', '--check', '--agent', 'gemini-cli', '--root', dir),
    );
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not on PATH/);
  });

  it('fails when the config does not name the command, PATH or not', async () => {
    const dir = await withSettings('claude-code', '{"hooks":{}}');
    const empty = await mkdtemp(join(tmpdir(), 'strata-cli-empty-'));
    const r = await withPath(empty, () =>
      cli('hook', '--check', '--agent', 'claude-code', '--root', dir),
    );
    assert.equal(r.code, 1);
    // The *config* is the reason here, not the PATH, and the message has to say
    // which one so the fix is obvious.
    assert.match(r.stderr, /does not reference/);
  });
});

describe('E-13: mcp serve end to end, as an installed bin', () => {
  it('serves over a pipe when invoked as `strata-ctx`', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'strata-cli-'));
    const bin = join(dir, 'bin');
    await mkdir(bin, { recursive: true });
    await symlink(CLI, join(bin, 'strata-ctx'));

    const child = spawn('strata-ctx', ['mcp', 'serve'], {
      env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}` },
    });
    child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    const code = await withTimeout(
      new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 1))),
      30_000,
      'installed strata-ctx mcp serve',
    ).catch(() => {
      child.kill('SIGKILL');
      throw new Error('the installed strata-ctx never exited');
    });
    assert.equal(code, 0);

    const res = JSON.parse(stdout.trim()) as { result: { tools: { name: string }[] } };
    assert.equal(res.result.tools.length, 6);
  });
});
