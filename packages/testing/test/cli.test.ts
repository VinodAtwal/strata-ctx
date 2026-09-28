import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { FIXTURE_FORMAT_VERSION, serializeFixtureFile } from '../src/index.js';

import { dataFrame, entry, fixtureFile, tempDir } from './fixtures.js';

/**
 * The CLI as a subprocess.
 *
 * Run out of process on purpose. The exit code *is* the contract -- CI runs
 * `validate` and the only useful thing it can do is fail -- and an in-process
 * test cannot observe an exit code or a `process.exitCode` assignment. Spawning
 * also proves the entrypoint actually runs under `node --import tsx` rather
 * than only type-checking.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

const run = (args: readonly string[]): { status: number; stdout: string; stderr: string } => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
};

const goodFixture = (): string =>
  serializeFixtureFile(
    fixtureFile({
      name: 'anthropic-turn-1',
      entries: [
        entry({ name: 'turn-1', responseBody: { id: 'msg_1' } }),
        entry({
          name: 'turn-2',
          events: [dataFrame('{"type":"message_start"}'), dataFrame('{"type":"message_stop"}', { delayMs: 4, complete: false })],
          redactedHeaders: ['authorization'],
        }),
      ],
    }),
  );

describe('fixtures CLI', () => {
  it('prints usage for --help and exits 0', () => {
    const { status, stdout } = run(['--help']);
    assert.equal(status, 0);
    assert.match(stdout, /list <dir>/);
    assert.match(stdout, /validate <path/);
    assert.match(stdout, /summary <path/);
  });

  it('lists the fixtures in a directory', (t) => {
    const dir = tempDir(t);
    writeFileSync(join(dir, 'b.json'), goodFixture(), 'utf8');
    writeFileSync(join(dir, 'a.json'), goodFixture(), 'utf8');
    writeFileSync(join(dir, 'ignored.txt'), 'not a fixture', 'utf8');

    const { status, stdout } = run(['list', dir]);
    assert.equal(status, 0);
    assert.match(stdout, /a\.json/);
    assert.match(stdout, /b\.json/);
    assert.ok(!stdout.includes('ignored.txt'), 'only .json files are fixtures');
    // Sorted, so the output is the same on every machine.
    assert.ok(stdout.indexOf('a.json') < stdout.indexOf('b.json'));
    assert.match(stdout, /entries=2\s+sse-events=2/);
  });

  it('summarises entries with the fields a reviewer needs', (t) => {
    const dir = tempDir(t);
    const path = join(dir, 'turns.json');
    writeFileSync(path, goodFixture(), 'utf8');

    const { status, stdout } = run(['summary', path]);
    assert.equal(status, 0);
    assert.match(stdout, /turn-1 POST \/v1\/messages -> 200 json hash=[0-9a-f]{12} bytes=\d+ events=0/);
    assert.match(stdout, /turn-2 POST \/v1\/messages -> 200 sse .*events=2 delayMs=4/);
    assert.match(stdout, /\[truncated-tail redacted-headers=1\]/, 'the cut and the redaction are both visible');
  });

  it('emits machine-readable output with --json', (t) => {
    const dir = tempDir(t);
    const path = join(dir, 'turns.json');
    writeFileSync(path, goodFixture(), 'utf8');

    const { status, stdout } = run(['summary', path, '--json']);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout) as { name: string; version: number; entries: { truncatedTail: boolean }[] }[];
    assert.equal(parsed[0]?.name, 'anthropic-turn-1');
    assert.equal(parsed[0]?.version, FIXTURE_FORMAT_VERSION);
    assert.equal(parsed[0]?.entries[1]?.truncatedTail, true);
  });

  it('validates a good corpus with exit 0', (t) => {
    const dir = tempDir(t);
    writeFileSync(join(dir, 'a.json'), goodFixture(), 'utf8');

    const { status, stdout } = run(['validate', dir]);
    assert.equal(status, 0);
    assert.match(stdout, /^ok /m);
  });

  it('exits 1 and names the file when a fixture is stale', (t) => {
    // The behaviour CI depends on. A version this harness cannot read is a hard
    // failure, never a warning and never a silent skip.
    const dir = tempDir(t);
    const path = join(dir, 'stale.json');
    writeFileSync(path, serializeFixtureFile(fixtureFile({ version: 0 })), 'utf8');

    const { status, stdout } = run(['validate', path]);
    assert.equal(status, 1);
    assert.match(stdout, /^FAIL /m);
    assert.match(stdout, /stale\.json/);
    assert.match(stdout, /fixture format version 0/);
  });

  it('exits 1 and reports a malformed fixture without stopping at the first one', (t) => {
    // A corpus is checked in one pass, so one bad file must not hide the rest.
    const dir = tempDir(t);
    writeFileSync(join(dir, 'good.json'), goodFixture(), 'utf8');
    writeFileSync(join(dir, 'broken.json'), '{ not json', 'utf8');
    writeFileSync(join(dir, 'wrong-shape.json'), JSON.stringify({ fixtureFormatVersion: 1 }), 'utf8');

    const { status, stdout } = run(['validate', dir]);
    assert.equal(status, 1);
    assert.match(stdout, /^ok .*good\.json/m);
    assert.match(stdout, /^FAIL .*broken\.json/m);
    assert.match(stdout, /not valid JSON/);
    assert.match(stdout, /^FAIL .*wrong-shape\.json/m);
    assert.match(stdout, /invalid fixture file/);
  });

  it('reports every failure in --json form with a non-zero exit', (t) => {
    const dir = tempDir(t);
    writeFileSync(join(dir, 'stale.json'), serializeFixtureFile(fixtureFile({ version: 3 })), 'utf8');

    const { status, stdout } = run(['validate', dir, '--json']);
    assert.equal(status, 1);
    const parsed = JSON.parse(stdout) as { path: string; ok: boolean; error: string }[];
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.ok, false);
    assert.match(parsed[0]?.error ?? '', /format version 3/);
  });

  it('exits 2 for a command that does not exist', (t) => {
    const dir = tempDir(t);
    writeFileSync(join(dir, 'a.json'), goodFixture(), 'utf8');

    const { status, stderr } = run(['frobnicate', dir]);
    assert.equal(status, 2);
    assert.match(stderr, /unknown command 'frobnicate'/);
  });


  it('exits 2 when no path is given', () => {
    const { status, stderr } = run(['summary']);
    assert.equal(status, 2);
    assert.match(stderr, /needs at least one path/);
  });

  it('exits 2 for a misspelled flag rather than ignoring it', () => {
    // `--jsno` silently ignored would be a command that runs and produces output
    // nobody downstream can consume.
    const { status, stderr } = run(['summary', '--jsno']);
    assert.equal(status, 2);
    assert.match(stderr, /--jsno/);
  });

  it('exits 2 and says so when no command is given', () => {
    // No default command. A bare path would be silently reinterpreted as one,
    // and a mistyped command name has to be an error rather than a summary of
    // a corpus that happens to be called `validat`.
    const { status, stderr } = run([]);
    assert.equal(status, 2);
    assert.match(stderr, /a command is required/);
    assert.match(stderr, /list <dir>/, 'and the usage is printed rather than a stack trace');
  });

  it('treats a bare path as a mistyped command, not as a corpus', (t) => {
    const dir = tempDir(t);
    writeFileSync(join(dir, 'a.json'), goodFixture(), 'utf8');

    const { status, stderr } = run([dir]);
    assert.equal(status, 2);
    assert.match(stderr, /unknown command/);
  });

  it('rejects a command name that does not exist rather than guessing', (t) => {
    const dir = tempDir(t);
    writeFileSync(join(dir, 'a.json'), goodFixture(), 'utf8');

    const { status, stderr } = run(['validat', dir]);
    assert.equal(status, 2);
    assert.match(stderr, /unknown command 'validat'/);
    assert.match(stderr, /validate <path/, 'and points at the real one');
  });

  it('lists bare paths for scripting', (t) => {
    const dir = tempDir(t);
    writeFileSync(join(dir, 'a.json'), goodFixture(), 'utf8');
    writeFileSync(join(dir, 'b.json'), goodFixture(), 'utf8');

    // Bare, one per line, no `--json` needed. Scripting should not have to know
    // about a flag to get filenames.
    const plain = run(['paths', dir]);
    assert.equal(plain.status, 0);
    assert.deepEqual(plain.stdout.trimEnd().split('\n'), [join(dir, 'a.json'), join(dir, 'b.json')]);

    const { status, stdout } = run(['paths', dir, '--json']);
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(stdout) as string[], [join(dir, 'a.json'), join(dir, 'b.json')]);
  });

  it('lists paths without parsing, so a broken corpus is still listable', (t) => {
    const dir = tempDir(t);
    writeFileSync(join(dir, 'good.json'), goodFixture(), 'utf8');
    writeFileSync(join(dir, 'broken.json'), '{ not json', 'utf8');

    // Often the reason you are listing is to find what is broken. A command
    // that died on the content would be useless for exactly that job.
    const { status, stdout, stderr } = run(['paths', dir]);
    assert.equal(status, 0);
    assert.match(stdout, /broken\.json$/m, 'the broken file is still named');
    assert.equal(stderr, '');

    // `list` is the parsing command, and it is supposed to fail here.
    assert.equal(run(['list', dir]).status, 1);
  });
});
