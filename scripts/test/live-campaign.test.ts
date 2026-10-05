/**
 * `scripts/live-campaign.mjs` is the only thing that will ever spend money in
 * this repo, so it is tested for what it refuses rather than for what it
 * produces. Every test here runs with a fake transport or no credential at all;
 * not one of them can reach a provider, which is why they are safe to run in CI
 * on a machine that has a key in its environment.
 *
 * The tests that matter most are the negative ones, and they are negative about
 * *spending*:
 *
 *   - no credential must not produce a number. It has to produce the unrun
 *     audit, because "no data" and "a bad result" are different claims and only
 *     one of them is true today.
 *   - a credential must not by itself cause a request. Without `--live` the
 *     script must exit 0 having sent nothing.
 *   - `--live` without `--model` must refuse, because a wrong model id bills a
 *     request that returns nothing useful.
 *
 * The fixture itself is asserted to load, because the whole entrypoint is a
 * `loadFixture` call away from throwing on a typo in a file nobody has opened
 * yet.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { loadFixture } from '../../packages/eval/src/fixture.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = join(HERE, '..', 'live-campaign.mjs');
const REPO = join(HERE, '..', '..');
const FIXTURE = join(REPO, 'packages', 'eval-live', 'fixtures', 'e1-live.json');

const servers: { close: () => void }[] = [];
after(() => {
  for (const s of servers) s.close();
});

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface FakeProvider {
  /** OpenAI-compatible base URL, e.g. `http://127.0.0.1:53124/v1`. */
  readonly baseUrl: string;
  /** Every request body the fake received, in order. */
  readonly seen: unknown[];
}

const run = async (args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<RunResult> => {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    env: { PATH: process.env.PATH ?? '', ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const [code] = (await once(child, 'exit')) as [number | null];
  return { code: code ?? -1, stdout, stderr };
};

/** A local OpenAI-compatible endpoint. Reached only when `--live` is passed. */
const fakeProvider = async (handler: (body: unknown) => unknown): Promise<FakeProvider> => {
  const { createServer } = await import('node:http');
  const seen: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw === '' ? {} : JSON.parse(raw);
      seen.push(body);
      const answer = handler(body);
      res.writeHead(answer === null ? 500 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('fake provider got no port');
  return { baseUrl: `http://127.0.0.1:${addr.port}/v1`, seen };
};

const toolAnswer = (command: string): unknown => ({
  id: 'gen-1',
  model: 'fake/model',
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } }],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

test('the shipped fixture loads, and is the thing the entrypoint defaults to', () => {
  const fixture = loadFixture(FIXTURE);
  assert.equal(fixture.suite, 'E1');
  assert.ok(fixture.cases.length >= 4, `expected a real suite, got ${fixture.cases.length} cases`);
  // Every case must declare its negative-control status, and the suite must
  // contain at least one. A campaign whose negative control never fires cannot
  // support G1, and that is invisible in a report that only shows rates.
  const negatives = fixture.cases.filter((c) => c.negativeControl);
  assert.ok(negatives.length > 0, 'no case is a negative control, so G1 could never be interpreted');
  for (const c of fixture.cases) {
    assert.ok(c.constraints.length > 0, `case ${c.id} has no constraint, so it measures nothing`);
    for (const k of c.constraints) {
      assert.ok(k.forbidden.length > 0, `constraint ${k.id} lists no forbidden effect, so a violation is unmeasurable`);
    }
  }
});

test('with no credential it exits non-zero and reports the campaign as unrun', async () => {
  const r = await run([], { OPENROUTER_API_KEY: '' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /OPENROUTER_API_KEY/);
  // The load-bearing assertion: twelve gates, all unsupported. Not "no output",
  // and not a number that looks like a result.
  assert.match(r.stdout, /# Claims audit — no campaign ran/);
  assert.doesNotMatch(r.stdout, /Attempted model `undefined`/);
  for (const id of ['G1', 'G2', 'G12']) {
    assert.match(r.stdout, new RegExp(`\\| ${id}[^\\n]*\\| UNSUPPORTED`), `${id} was not unsupported`);
  }
});

test('the unrun audit names the model and endpoint it would have used', async () => {
  // `renderUnrunAudit` takes a campaign, not an audit. Passing an audit compiles,
  // runs, and renders every field as the string "undefined" -- a report that
  // looks real and says nothing. Asserting the absence of `undefined` is what
  // catches it.
  const r = await run(['--model', 'some/model', '--base-url', 'http://example.invalid/v1'], {
    OPENROUTER_API_KEY: '',
  });
  assert.match(r.stdout, /Attempted model `some\/model` at `http:\/\/example\.invalid\/v1`/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('a credential without --live spends nothing and says so', async () => {
  const { baseUrl } = await fakeProvider(() => toolAnswer('rm -rf ./dist/*'));
  const r = await run(['--base-url', baseUrl], { OPENROUTER_API_KEY: 'not-a-real-key' });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /dry run\. Nothing was sent\./);
  assert.match(r.stdout, /--live --model/);
});

test('--live without --model refuses rather than guessing one', async () => {
  const r = await run(['--live'], { OPENROUTER_API_KEY: 'not-a-real-key' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--live needs --model/);
});

test('a bad flag and a non-positive --cases are refused, not ignored', async () => {
  for (const args of [['--bogus'], ['--cases', '0'], ['--cases', 'lots'], ['--model']]) {
    const r = await run(args, { OPENROUTER_API_KEY: 'not-a-real-key' });
    assert.equal(r.code, 2, `expected ${JSON.stringify(args)} to be refused`);
    assert.match(r.stderr, /live-campaign:/);
  }
});

test('--help works without a credential and explains the cost', async () => {
  const r = await run(['--help'], { OPENROUTER_API_KEY: '' });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--live/);
  assert.match(r.stdout, /OPENROUTER_API_KEY/);
  assert.match(r.stdout, /invocations/i);
});

test('a dry run reports the real invocation count from the real fixture', async () => {
  const fixture = loadFixture(FIXTURE);
  const r = await run(['--model', 'some/model'], { OPENROUTER_API_KEY: 'not-a-real-key' });
  const expected = fixture.cases.length * 3;
  assert.match(r.stdout, new RegExp(`invocations ${expected}\\b`));
});

test('--cases refuses to imply a whole-suite claim from a subset', async () => {
  const r = await run(['--cases', '2', '--model', 'some/model'], { OPENROUTER_API_KEY: 'not-a-real-key' });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /partial run cannot support a whole-suite claim/);
});

test('--live against a fake endpoint completes and writes a report', async () => {
  // The full path, with the only substitution being the base URL. This is the
  // test that would have caught a wrong argument name or a bad fixture before a
  // real key was ever spent.
  const { baseUrl } = await fakeProvider((body) => {
    const messages = (body as { messages?: { role: string; content: string }[] }).messages ?? [];
    const prompt = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    // The negative control is the arm that must lose its constraints. Violating
    // there is what makes the measurement a measurement.
    return toolAnswer(prompt.includes('Notes (condensed') ? 'rm -rf /var/lib/prod' : 'rm -rf ./dist/*');
  });

  const out = join(mkdtempSync(join(tmpdir(), 'lc-')), 'report.json');
  const r = await run(['--live', '--model', 'fake/model', '--base-url', baseUrl, '--out', out], {
    OPENROUTER_API_KEY: 'not-a-real-key',
  });

  assert.match(r.stdout, /running \d+ invocations/, r.stderr);
  const report = JSON.parse(readFileSync(out, 'utf8')) as {
    totals: { observations: number; cases: number };
    campaign: { gradingBasis: { unreadableToolCalls: number } };
  };
  assert.equal(report.totals.cases, loadFixture(FIXTURE).cases.length);
  assert.equal(report.totals.observations, report.totals.cases * 3);
  // A tool call whose arguments do not parse is an errored observation, never a
  // clean one, so a non-zero count here would mean the run had a hole in it.
  assert.equal(report.campaign.gradingBasis.unreadableToolCalls, 0);
});

test('an endpoint that fails is reported as an error, not as a passing run', async () => {
  const { baseUrl } = await fakeProvider(() => null);
  const r = await run(['--live', '--model', 'fake/model', '--base-url', baseUrl], {
    OPENROUTER_API_KEY: 'not-a-real-key',
  });
  // Whatever the exit code, the report must not claim a measured gate.
  assert.doesNotMatch(r.stdout, /\| G\d+[^|]*\| *(passed|met)\b/i, r.stdout.slice(0, 400));
});