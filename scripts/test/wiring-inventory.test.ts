/**
 * `scripts/wiring-inventory.ts` has to be trustworthy before its numbers are
 * worth gating on, because docs/testing-plan.md made that a precondition of
 * J-12: "if the count is already unstable for benign reasons ... the stricter
 * gate produces noise and should be rejected. Measure before adopting."
 *
 * The gate in `packages/testing/test/wiring-ratchet.test.ts` computes its own
 * counts from `buildLedger` and never reads this script's output, so these
 * tests are not load-bearing for the gate -- deliberately, since a gate whose
 * numbers arrive through a subprocess fails for the wrong reason when the
 * subprocess breaks. They are here because the script is the instrument the
 * next person will use to answer "did the count move, and what moved it", and
 * an instrument that silently prints nothing is worse than no instrument.
 *
 * That is not hypothetical: the first version of this script guarded its output
 * behind `import.meta.url === 'file://' + process.argv[1]`, which is false for
 * any path containing a symlinked component -- including every path under
 * macOS `/tmp`, which is a symlink to `/private/tmp`. Run from a scratch copy
 * it exited 0 and printed nothing at all. The comparison is now on resolved
 * real paths, and "it prints from a symlinked path" is asserted below so the
 * regression cannot come back quietly.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { inventoryOf } from '../wiring-inventory.js';
import { buildLedger } from '../../packages/testing/src/wiring-ledger.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/wiring-inventory.ts');

/**
 * `--import tsx` is a bare specifier, and Node resolves it against the child's
 * cwd. Two of these tests deliberately run the script from a temp directory,
 * where there is no `node_modules` above it, so the bare form fails there with
 * ERR_MODULE_NOT_FOUND and the test measures Node's resolver instead of this
 * repo. An absolute path to the installed loader is the fix; resolved from
 * `root` rather than from `process.cwd()` so the test does not depend on where
 * the runner was started.
 */
const require_ = createRequire(path.join(root, 'package.json'));
const tsxLoader = require_.resolve('tsx');

/**
 * A full scan is ~3s, and the ceiling is for a hang rather than for slowness.
 * Without one, a regression that blocks on a read would hang this file instead
 * of failing it -- the failure mode under test, reproduced inside the test.
 */
const CEILING_MS = 60_000;

type Outcome = { code: number | null; out: string; err: string; timedOut: boolean };

/**
 * `which` defaults to the script in this repo. The symlink test needs the copy
 * inside the temp tree instead: running the *original* file with a temp cwd
 * resolves the repo from the script's own location and reports this repo, which
 * would make the assertion below pass for the wrong reason.
 */
const runScript = async (args: string[], cwd: string, which: string = script): Promise<Outcome> => {
  // NODE_TEST_CONTEXT must be cleared: a `node --test` child that inherits it
  // discovers nothing and exits 0. This script is not run under `--test` itself,
  // but the env var is inherited by every child of every test process, and the
  // existing scripts/test/run-tests.test.ts documents the hazard.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;

  const child = spawn(process.execPath, ['--import', tsxLoader, which, ...args], {
    cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c: string) => { out += c; });
  child.stderr.on('data', (c: string) => { err += c; });

  const closed = once(child, 'close');
  const exited = once(child, 'exit');
  let timer: NodeJS.Timeout | undefined;
  const overdue = new Promise<void>((resolve) => { timer = setTimeout(resolve, CEILING_MS); });

  const timedOut = await Promise.race([
    Promise.race([closed, exited]).then(() => false),
    overdue.then(() => true),
  ]);
  if (timedOut) {
    // SIGKILL the whole group: `detached: true` means the child may have
    // children of its own, and killing only the pid leaves the pipes open, so
    // waiting for 'close' afterwards would hang. Same reasoning as
    // scripts/test/run-tests.test.ts.
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    await Promise.race([closed, exited]);
  }
  if (timer) clearTimeout(timer);

  return { code: child.exitCode, out, err, timedOut };
};

const workDirs: string[] = [];
const workDir = (name: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), `strata-inventory-${name}-`));
  workDirs.push(dir);
  return dir;
};

after(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

test('the inventory is byte-identical across runs', async () => {
  const first = await runScript([], root);
  const second = await runScript([], root);
  assert.equal(first.timedOut, false, `first run hung; stderr: ${first.err}`);
  assert.equal(second.timedOut, false, `second run hung; stderr: ${second.err}`);
  assert.equal(first.code, 0, `first run exited ${String(first.code)}; stderr: ${first.err}`);
  assert.equal(second.code, 0, `second run exited ${String(second.code)}; stderr: ${second.err}`);
  assert.equal(first.out, second.out, 'two runs over one tree produced different bytes');
  // A digest that did not move between runs is the property the gate relies on,
  // so assert it directly rather than trusting that identical bytes imply it.
  assert.match(first.out, /digest\s+[0-9a-f]{16}/, 'no digest in the report; the run is not comparable across commits');
});

test('the report states the counts a developer needs, with no absolute paths', async () => {
  const { out, code } = await runScript([], root);
  assert.equal(code, 0);
  // The two halves are indented under `unwired` in the report, so match on the
  // label anywhere on the line rather than anchoring at column 0.
  const counts = ['files scanned', 'files reachable', 'runtime exports', 'wired', 'unwired', 'inherited', 'local'];
  for (const field of counts) {
    assert.match(out, new RegExp(`^\\s*${field}\\s+\\d+`, 'm'), `the report has no "${field}" line`);
  }
  // The digest is hex, so it needs its own pattern; requiring `\\d+` here is
  // what made this test fail on a report that was correct.
  assert.match(out, /^\s*digest\s+[0-9a-f]{16}$/m, 'the report has no digest line');
  // Only the root line may carry a path: a per-package absolute path would make
  // the output differ between two checkouts of the same commit and destroy the
  // "byte-identical" comparison the gate's falsifier needs.
  const pathLines = out.split('\n').filter((l) => l.includes(root));
  assert.equal(pathLines.length, 1, `expected exactly one line to contain the repo path, got: ${JSON.stringify(pathLines)}`);
});

test('--json emits one sorted array, so a diff names what moved', async () => {
  const { out, code } = await runScript(['--json'], root);
  assert.equal(code, 0);
  const records = JSON.parse(out) as { key: string; wired: boolean }[];
  assert.ok(Array.isArray(records), '--json did not emit an array');
  assert.ok(records.length > 900, `only ${records.length} records; the barrel walk is broken`);
  const keys = records.map((r) => r.key);
  assert.deepEqual(keys, [...keys].sort(), '--json is not sorted, so a diff would report reordering as change');
  assert.equal(new Set(keys).size, keys.length, '--json contains duplicate keys; the diff would be ambiguous');
  assert.ok(records.every((r) => typeof r.wired === 'boolean'), 'a record is missing its wired flag');
});

test('inventoryOf is a pure function of the ledger it is handed', () => {
  // Built once and summarised twice: the digest must not depend on call order,
  // on a previous call, or on anything outside its argument.
  const ledger = buildLedger(root);
  const a = inventoryOf(ledger);
  const b = inventoryOf(ledger);
  assert.equal(a.digest, b.digest);
  assert.deepEqual(a.unwiredByPackage, b.unwiredByPackage);
  assert.deepEqual(Object.keys(a.unwiredByPackage), [...Object.keys(a.unwiredByPackage)].sort(), 'per-package counts are not key-sorted');
});

test('the totals agree with the ledger the gate reads', () => {
  const ledger = buildLedger(root);
  const inv = inventoryOf(ledger);
  assert.equal(inv.unwired, ledger.unwired.length);
  assert.equal(inv.wired, ledger.wired.length);
  assert.equal(inv.exports, ledger.entries.length);
  assert.equal(inv.inherited + inv.local, inv.unwired, 'the two halves must partition the unwired count');
  assert.equal(
    Object.values(inv.unwiredByPackage).reduce((a, b) => a + b, 0),
    inv.unwired,
    'the per-package breakdown must sum to the total it breaks down',
  );
});

test('the script prints from a symlinked path, and finds the repo it is copied into', async () => {
  // macOS puts /tmp and /var/folders behind symlinks to /private/..., so a
  // scratch copy lives at a path whose realpath differs from its literal path.
  // A guard comparing `import.meta.url` to `'file://' + process.argv[1]` fails
  // there, silently: exit 0, no output. That is the regression this test
  // exists for, and it needs the *copied* script run -- the original resolves
  // the repo from its own location and would report this repo either way.
  const dir = workDir('symlink');
  const tree = path.join(dir, 'tree');
  mkdirSync(tree, { recursive: true });
  cpSync(root, tree, {
    recursive: true,
    filter: (p) => !/node_modules|[/\\]dist$|[/\\]\.git$|tsbuildinfo/.test(p),
  });
  assert.notEqual(realpathSync(tree), tree, 'this platform does not symlink temp dirs, so the test cannot fail as intended');

  const copied = path.join(tree, 'scripts', 'wiring-inventory.ts');
  const { out, code, err } = await runScript([], dir, copied);
  assert.equal(code, 0, `exited ${String(code)}; stderr: ${err}`);
  assert.ok(out.includes('runtime exports'), `printed nothing from a symlinked path; stderr: ${err}`);
  assert.ok(
    out.includes(realpathSync(tree)),
    `the script reported a different repo than the one it was copied into; stdout: ${out}`,
  );
});

test('a tree with no workspace root is a loud failure, not an empty report', async () => {
  // A script whose failure mode is silence gets trusted while it is lying. The
  // copied tree has its `workspaces` key removed, so `findRepoRoot` walks past it
  // and past every directory above the temp dir and throws -- which must reach
  // stderr as a non-zero exit rather than printing a report of nothing.
  const dir = workDir('noworkspace');
  const tree = path.join(dir, 'tree');
  mkdirSync(tree, { recursive: true });
  cpSync(root, tree, {
    recursive: true,
    filter: (p) => !/node_modules|[/\\]dist$|[/\\]\.git$|tsbuildinfo/.test(p),
  });
  const manifestPath = path.join(tree, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  delete manifest['workspaces'];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const copied = path.join(tree, 'scripts', 'wiring-inventory.ts');
  const got = await runScript([], dir, copied);
  assert.notEqual(got.code, 0, 'the script exited 0 with no workspace root above it');
  assert.ok(got.err.includes('npm-workspace root'), `expected the findRepoRoot error on stderr, got: ${got.err}`);
  assert.equal(got.out, '', `it printed a report anyway: ${got.out}`);
});
