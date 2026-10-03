import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

/**
 * The test gate must fail loudly, and it must fail *fast*.
 *
 * `scripts/run-tests.mjs` exists because `node --import tsx --test <files>` on
 * node v20.12.1 can stop reporting: the runner prints each test's diagnostics as
 * it goes, but it prints the `# fail N` summary and derives its exit code only
 * after every test file's event loop drains. A file that leaves a live handle
 * never drains, so the gate stops mid-stream with failures already on screen and
 * no verdict -- a red suite that CI eventually kills on its job timeout, which
 * reads as infrastructure flakiness rather than as the regression it is.
 *
 * Fixtures are written to a temp dir at run time rather than committed: a fixture
 * that fails on purpose must never be reachable by the suite glob
 * (`packages` + one level + `test` + `*.test.ts`), or the gate ships permanently red.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runner = path.join(root, 'scripts/run-tests.mjs');

/** Short enough to keep the gate fast, long enough for two trivial fixtures. */
const HANG_BUDGET_MS = 1500;

/** The ceiling for the raw command above; only ever reached if it really hangs. */
const RUN_CEILING_MS = 3000;

const workDirs: string[] = [];

const workDir = (name: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), `strata-gate-${name}-`));
  workDirs.push(dir);
  return dir;
};

after(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

type Outcome = { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; out: string; err: string };

/**
 * Runs a command with a hard ceiling. Without the ceiling a regression in the
 * runner would hang this test instead of failing it, which would reproduce the
 * bug inside the test that exists to catch it.
 *
 * NODE_TEST_CONTEXT is stripped because `node --test` exports it into every test
 * process (v20.12.1 sets `child-v8`), and a `node --test` child that inherits it
 * discovers no files, prints nothing and exits 0 -- a green run of zero tests,
 * indistinguishable from a pass. The runner refuses that situation; the tests
 * here are the callers, so they have to clear it.
 */
const run = async (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<Outcome> => {
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  Object.assign(childEnv, env);

  const child = spawn(cmd, args, {
    cwd: root,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  let out = '';
  let err = '';
  let timedOut = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c: string) => { out += c; });
  child.stderr.on('data', (c: string) => { err += c; });
  child.on('error', (e) => { err += `spawn error: ${String(e)}`; });

  // `close`, not `exit`: a hung runner's own children are orphaned rather than
  // killed and can hold these pipes open, so waiting for `close` after SIGKILL
  // would hang this test -- the failure mode under test, reproduced inside the
  // test that guards it. Both promises are created up front so neither event
  // can be missed by the time the race resolves.
  const closed = once(child, 'close');
  const exited = once(child, 'exit');
  let deadline: NodeJS.Timeout | undefined = undefined;
  const overdue = new Promise<void>((resolve) => {
    deadline = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
      resolve();
    }, RUN_CEILING_MS);
  });

  await Promise.race([closed, overdue]);
  clearTimeout(deadline);

  const [code, signal] = await exited;

  // Same leak as the runner has: a killed child's orphaned grandchildren keep
  // these pipes open, and an open stdio handle would keep this test process
  // alive after its last test -- a hung gate, reproduced in miniature.
  try { child.stdout.destroy(); } catch { /* ignore */ }
  try { child.stderr.destroy(); } catch { /* ignore */ }
  try { child.unref(); } catch { /* ignore */ }

  return { code, signal, timedOut, out, err };
};

const gate = (files: string[], env: NodeJS.ProcessEnv = {}): Promise<Outcome> =>
  run(process.execPath, [runner, ...files], {
    STRATA_TEST_TIMEOUT_MS: String(HANG_BUDGET_MS),
    ...env,
  });

/**
 * The reported shape: a regression, an unrelated skip, and a handle left open.
 * On the pre-fix invocation (`node --import tsx --test <this file>`) the
 * `not ok` line below is printed and then nothing else ever is.
 */
const FAIL_AND_SKIP_AND_LEAK = `
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('regression: the gate must report this', () => {
  assert.equal(1, 2);
});

test('unrelated: skipped because the environment has no Ollama', { skip: 'no Ollama' }, () => {});

// The failure mode: a live handle that is never released, so the runner's
// event loop never drains and it never reaches its own summary.
const server = createServer(() => {});
server.listen(0);
`;

/** The same run with nothing left open, so it terminates on its own. */
const FAIL_AND_SKIP = `
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('regression: the gate must report this', () => {
  assert.equal(1, 2);
});

test('unrelated: skipped because the environment has no Ollama', { skip: 'no Ollama' }, () => {});
`;

const GREEN_AND_SKIP = `
import { test } from 'node:test';

test('passes', () => {});
test('unrelated: skipped because the environment has no Ollama', { skip: 'no Ollama' }, () => {});
`;

const fixture = (dir: string, name: string, source: string): string => {
  const file = path.join(dir, name);
  writeFileSync(file, source, 'utf8');
  return file;
};

describe('gate: a failing test is reported loudly', () => {
  test('a failure plus an unrelated skip exits non-zero and prints the failure', async () => {
    const dir = workDir('red');
    const file = fixture(dir, 'red.mjs', FAIL_AND_SKIP);

    const got = await gate([file]);

    assert.equal(got.timedOut, false, 'a run with nothing left open must terminate on its own');
    assert.notEqual(got.code, 0, 'a failing suite must not exit zero');
    assert.match(got.out, /not ok \d+ - regression: the gate must report this/);
    assert.match(got.out, /skipped 1/);
  });

  test('a green suite with a skip still exits zero', async () => {
    const dir = workDir('green');
    const file = fixture(dir, 'green.mjs', GREEN_AND_SKIP);

    const got = await gate([file]);

    assert.equal(got.timedOut, false);
    assert.equal(got.code, 0, 'a skip is not a failure and must not redden the gate');
    assert.match(got.out, /skipped 1/);
  });
});

describe('gate: a hang is a loud failure, never a silent one', () => {
  test('the unfixed runner command really does hang on this fixture', async () => {
    const dir = workDir('raw-hang');
    const file = fixture(dir, 'hang.mjs', FAIL_AND_SKIP_AND_LEAK);

    const raw = await run(process.execPath, ['--import', 'tsx', '--test', file]);

    assert.equal(raw.timedOut, true, 'if this ever stops hanging, node gained a bound of its own and the gate backstop can be simplified');
    assert.equal(raw.code, null, 'the unfixed runner must not produce a verdict to propagate');
    assert.doesNotMatch(raw.out, /# fail /, 'the summary -- and with it the exit code -- never arrives');
    assert.match(raw.out, /not ok \d+ - regression: the gate must report this/);
  });

  test('failures plus skips plus an open handle exit non-zero, bounded, and name the failure', async () => {
    const dir = workDir('gate-hang');
    const file = fixture(dir, 'hang.mjs', FAIL_AND_SKIP_AND_LEAK);

    const got = await gate([file]);

    assert.equal(got.timedOut, false, `the gate itself must terminate; elapsed output was:\n${got.out}\n${got.err}`);
    assert.notEqual(got.code, 0, 'a hang must never be reported as a pass');
    assert.match(got.err, /GATE TIMEOUT/, 'the operator has to be told this was a hang and not an ordinary red suite');
    assert.match(got.err, /not ok regression: the gate must report this/, 'the failure seen before the hang must be named, not discarded');
    assert.match(got.out, /not ok \d+ - regression: the gate must report this/, 'the failure diagnostic must survive the kill');
  });

  test('the timeout it reports is the budget it was given', async () => {
    const dir = workDir('gate-budget');
    const file = fixture(dir, 'hang.mjs', FAIL_AND_SKIP_AND_LEAK);

    const got = await gate([file], { STRATA_TEST_TIMEOUT_MS: '1500' });

    assert.match(got.err, /after 1500ms/);
  });
});

describe('gate: a suite that cannot be found is not a pass', () => {
  test('an empty suite fails loudly instead of reporting zero tests as green', async () => {
    // The runner resolves the suite relative to its own location, so running a
    // copy from an otherwise empty tree exercises the empty-enumeration path
    // without touching the real packages/.
    const dir = workDir('empty-suite');
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    mkdirSync(path.join(dir, 'packages'), { recursive: true });
    const copy = path.join(dir, 'scripts', 'run-tests.mjs');
    copyFileSync(runner, copy);

    const got = await run(process.execPath, [copy]);

    assert.equal(got.timedOut, false);
    assert.notEqual(got.code, 0, 'running zero tests must not look like passing');
    assert.match(got.err, /no test files found/);
  });

  test('the gate refuses to run inside a node:test process rather than reporting a false green', async () => {
    const dir = workDir('nested');
    const file = fixture(dir, 'green.mjs', GREEN_AND_SKIP);

    const got = await run(process.execPath, [runner, file], { NODE_TEST_CONTEXT: 'child-v8' });

    assert.equal(got.timedOut, false);
    assert.notEqual(got.code, 0, 'a nested runner that ran zero tests must not exit zero');
    assert.match(got.err, /NODE_TEST_CONTEXT=child-v8/);
    assert.equal(got.out, '', 'it must refuse before the runner produces any output');
  });

  test('the gate enumerates every package suite rather than trusting a shell glob', async () => {
    const got = await run(process.execPath, [runner, '--list']);

    assert.equal(got.code, 0);
    const listed = got.out.trim().split('\n').filter((l) => l !== '');
    // Enumeration moved out of `/bin/sh` and into the runner, so the set it
    // produces is now code. A package quietly dropped from it would shrink the
    // gate without failing anything, which is the one mistake here that cannot
    // be caught by the gate itself.
    const onDisk: string[] = [];
    for (const pkg of readdirSync(path.join(root, 'packages'), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const testDir = path.join(root, 'packages', pkg.name, 'test');
      let cases: Dirent[];
      try {
        cases = readdirSync(testDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const c of cases) {
        if (c.isFile() && c.name.endsWith('.test.ts')) onDisk.push(path.join(testDir, c.name));
      }
    }
    onDisk.sort();

    assert.deepEqual(listed.filter((f) => f.includes(`${path.sep}packages${path.sep}`)), onDisk);
    assert.ok(
      listed.some((f) => f.includes(`${path.sep}scripts${path.sep}test${path.sep}`)),
      'the gate tests themselves must be in the suite',
    );
  });
});