#!/usr/bin/env node
/**
 * Test gate runner.
 *
 * `npm run test` used to be a bare `node --import tsx --test` over a shell glob,
 * which has one silent-hang and two silent-pass failure modes:
 *
 *   1. HANG (the one that matters). `node --test` runs each file in a child
 *      process and waits for that process's event loop to drain. It prints the
 *      `1..N` plan and the `# fail N` summary -- and derives its exit code --
 *      only once the loop drains. So a test file that leaves a live handle
 *      (an unclosed server, socket or timer) makes the runner wait forever and
 *      never emit the summary. Verified on node v20.12.1: a file with one
 *      failing test and one leaked `http.Server` streams `not ok 1` plus the
 *      full AssertionError, then stops dead with no `# fail` line and no exit.
 *      Run through the full suite it is worse: the runner buffers a file's
 *      output until that file exits, so the failing file's diagnostics are
 *      discarded along with it. Upstream's answer is `--test-force-exit`, which
 *      this toolchain does not have (`node --test-force-exit` -> `node: bad
 *      option`, exit 9). `engines.node` promises >= 20.11 and ci.yml pins 20.19,
 *      so the versions the manifest accepts do not agree about the flag, and a
 *      fix that leans on it is green on one and a hard `bad option` on the
 *      other. The bound therefore lives here, so it holds on every version the
 *      manifest allows.
 *   2. Not a failure mode, but the reason this was misfiled as "failures plus
 *      skips hang". The skip is correlational, not causal: a leaked handle hangs
 *      the runner identically with zero failures and zero skips. What a skip
 *      does do is hide a regression behind a run that looks like flaky
 *      infrastructure.
 *   3. SILENT PASS, glob. The glob was expanded by the shell. Zero matches meant
 *      `node --test` with no file arguments, which searches the cwd and on
 *      20.12.1 reports `# tests 0 / # fail 0` with exit 0. A gate that cannot
 *      tell "nothing to run" from "nothing failed" is not a gate.
 *   4. SILENT PASS, environment. `node --test` exports NODE_TEST_CONTEXT into
 *      every test process, and a runner inheriting it discovers no files,
 *      prints nothing and exits 0. Anything that shells out to the gate from
 *      inside a test gets a green that ran zero tests.
 *
 * This runner keeps the failure loud and bounds the hang:
 *   - refuses situation 4 outright, and fails if the suite enumerates empty;
 *   - enumerates the suite itself, so situation 3 cannot be reached;
 *   - pins `--test-reporter=tap`, because Node picks `spec` on a TTY and `tap`
 *     off one, so the gate's output otherwise differs between a developer's
 *     terminal and a CI log;
 *   - kills the runner at a deadline and reports the timeout, the failures it
 *     saw, and a non-zero exit;
 *   - otherwise propagates the runner's own exit code untouched.
 *
 * Overrides, for a slow machine and for this runner's own tests:
 *   STRATA_TEST_TIMEOUT_MS   wall-clock budget, default 600000
 *   STRATA_TEST_REPORTER     reporter name, default `tap`
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A full suite takes ~17s on this machine; 600s is ~35x that, so the deadline
// only ever fires on a runner that has stopped making progress.
const DEFAULT_TIMEOUT_MS = 600_000;

// How long to wait for the killed runner to actually die before re-sending
// SIGKILL. Bounded so the timeout path cannot become an unbounded wait.
const GRACE_MS = 5_000;

// The same grammar the TAP reporter emits for a red test: `not ok <n> - <name>`,
// optionally indented for a nested test. Used only to name the failures on the
// timeout path, never to decide the gate, so a test whose *output* contains
// this text cannot make the gate fail.
const NOT_OK = /^[ \t]*not ok \d+[ \t]*-[ \t]*(.+)$/gm;

const timeoutMs = () => {
  const raw = process.env.STRATA_TEST_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`STRATA_TEST_TIMEOUT_MS must be a positive number of milliseconds, got ${JSON.stringify(raw)}`);
  }
  return parsed;
};

const reporter = process.env.STRATA_TEST_REPORTER || 'tap';

/**
 * The suite, enumerated here rather than left to the shell so that "the glob
 * matched nothing" is a loud failure instead of a green run of zero tests.
 */
const suiteFiles = () => {
  const explicit = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (explicit.length > 0) return explicit.map((f) => path.resolve(process.cwd(), f));

  const testDirs = [];
  let packages = [];
  try {
    packages = readdirSync(path.join(root, 'packages'), { withFileTypes: true });
  } catch {
    packages = [];
  }
  for (const pkg of packages) {
    if (pkg.isDirectory()) testDirs.push(path.join(root, 'packages', pkg.name, 'test'));
  }
  testDirs.push(path.join(root, 'scripts', 'test'));

  const files = [];
  for (const dir of testDirs) {
    let cases;
    try {
      cases = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const testCase of cases) {
      if (testCase.isFile() && testCase.name.endsWith('.test.ts')) {
        files.push(path.join(dir, testCase.name));
      }
    }
  }
  // readdirSync order is filesystem-dependent; the gate's file order is not.
  files.sort();
  if (files.length === 0) {
    throw new Error('no test files found under packages/*/test/*.test.ts or scripts/test/*.test.ts -- refusing to report a pass');
  }
  return files;
};

const failingNames = (tap) => {
  const names = [];
  for (const match of tap.matchAll(NOT_OK)) {
    const name = (match[1] ?? '').trim();
    if (name !== '') names.push(name);
  }
  return names;
};

const reportHang = (tap, ms) => {
  const names = failingNames(tap);
  process.stderr.write(
    `\n` +
      `GATE TIMEOUT: the test runner was still alive after ${ms}ms and was killed.\n` +
      `\n` +
      `The runner buffers a test file's output until that file exits, and it prints the\n` +
      `'# fail' summary and derives its exit code only once every file's event loop has\n` +
      `drained. A file that leaves a live handle -- an unclosed server, socket or timer --\n` +
      `never drains, so the gate stops here: some tests reported, and then no verdict ever\n` +
      `arrived. Treat this as a failing gate, not as flaky infrastructure.\n` +
      `\n` +
      (names.length > 0
        ? `Failing tests observed before the hang (${names.length}):\n${names.map((n) => `  not ok ${n}\n`).join('')}\n`
        : `No failing test was observed. Whatever is red is in a file that never reported, so\n` +
          `its diagnostics were discarded with it -- bisect with the runner's own file\n` +
          `arguments over the list it prints:\n` +
          `  node scripts/run-tests.mjs --list\n` +
          `  node scripts/run-tests.mjs <one file at a time>\n` +
          `\n`) +
      `Raise STRATA_TEST_TIMEOUT_MS if the suite legitimately needs longer.\n` +
      `\n`,
  );
};

const main = async () => {
  // `node --test` exports NODE_TEST_CONTEXT into every test process, and a
  // runner that inherits it stops being a runner: it discovers no files, prints
  // nothing and exits 0. Verified on v20.12.1, where a test process sees
  // NODE_TEST_CONTEXT=child-v8. So anything that shells out to the gate from
  // inside a test -- `npm test` from a smoke test, a nested runner, a wrapper
  // script -- gets a green that ran zero tests. That is indistinguishable from
  // a real pass, so it is refused rather than reported.
  if (process.env.NODE_TEST_CONTEXT !== undefined) {
    throw new Error(
      `refusing to run: NODE_TEST_CONTEXT=${process.env.NODE_TEST_CONTEXT} is set, so this ` +
        `process would inherit an existing test context and report a green run of zero tests. ` +
        `Unset it in the child environment before invoking the gate.`,
    );
  }

  const budgetMs = timeoutMs();
  const files = suiteFiles();

  // `--list` answers "what does the gate actually run?" without spending the run.
  // Enumeration moved from a shell glob into this file, so the set it produces
  // is now code rather than an accident of `/bin/sh`, and it needs to be checkable.
  if (process.argv.includes('--list')) {
    process.stdout.write(`${files.join('\n')}\n`);
    return;
  }

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--test', `--test-reporter=${reporter}`, ...files],
    { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], detached: true },
  );

  let tap = '';
  let timedOut = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    tap += chunk;
    process.stdout.write(chunk);
  });

  // Deliberately not `unref()`ed: if the child handle ever failed to hold the
  // event loop open, an unref'd deadline would let this process exit 0 and
  // report the hang as a pass -- the exact failure mode this file removes.
  //
  // `close` is the wrong event to wait on. It fires only after the child's
  // stdio ends, and after SIGKILL the runner's own per-file children are
  // orphaned rather than killed -- an orphaned child still holding the stdout
  // pipe means `close` never arrives and this process would hang here, which is
  // the bug it was written to remove. `exit` fires when the process itself
  // dies, which SIGKILL guarantees.
  const closed = once(child, 'close');
  const exited = once(child, 'exit');

  let deadline;
  const overdue = new Promise((resolve) => {
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
      resolve(undefined);
    }, budgetMs);
  });

  await Promise.race([closed, overdue]);
  clearTimeout(deadline);

  // Bounded even so: SIGKILL is not supposed to be refusable, and a gate whose
  // timeout handler can itself wait forever is not a timeout.
  const grace = setTimeout(() => {
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
  }, GRACE_MS);
  const [code, signal] = await exited;
  clearTimeout(grace);

  // SIGKILL orphans the runner's per-file children rather than killing them, and
  // an orphan still holding this pipe leaves a live stdio handle here -- which
  // would keep this process alive after the timeout report and turn the fix
  // back into the hang it removes. Dropping the stream is safe either way:
  // `close` already delivered the whole stream on the normal path, and the
  // timeout path reports out of `tap` regardless.
  try { child.stdout.destroy(); } catch { /* ignore */ }
  try { if (child.stderr) child.stderr.destroy(); } catch { /* ignore */ }

  if (timedOut) {
    reportHang(tap, budgetMs);
    // Set rather than `process.exit()`: the TAP summary is already on a pipe
    // here, and exiting immediately after writing it can truncate it -- which
    // would lose the very failure report this runner exists to preserve.
    process.exitCode = 1;
    return;
  }

  // A signalled runner is a failed gate; there is no exit code to trust.
  process.exitCode = signal !== null ? 1 : code === null ? 1 : code;
};

try {
  await main();
} catch (err) {
  process.stderr.write(`\nGATE ERROR: ${err instanceof Error ? err.message : String(err)}\n\n`);
  process.exitCode = 1;
}