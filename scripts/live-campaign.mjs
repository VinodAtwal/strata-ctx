/**
 * F2-7: run the live A/B campaign.
 *
 * This exists because `runCampaign` was fully built and fully tested but had no
 * caller. F2-1 and F2-2 built the harness; nothing outside `packages/eval-live/test`
 * invoked it, so the moment a credential arrived someone would have had to write
 * the entrypoint *and* discover the arguments at the same time, on the one run
 * that costs money. This is that entrypoint, written against a credential.
 *
 * Two deliberate boundaries:
 *
 * 1. **The credential is read here and nowhere else.** No module under
 *    `packages/` reads `process.env` for a provider key, so their tests never
 *    depend on the machine they run on. The env read belongs at the edge, and
 *    this is the edge.
 * 2. **Dry run is the default.** `--live` is required to spend anything. A
 *    script whose happy path costs money should make spending opt-in, because
 *    the failure mode of getting that backwards is a real invoice.
 *
 * On a missing credential it does not print nothing, and it does not print a
 * result. It prints the plan, names what is missing, and emits the *unrun*
 * claims audit -- the twelve `unsupported` claims, which is the truthful record
 * of a campaign that did not happen. Silence and a fake number are the two
 * things this repo exists to avoid.
 */

import { realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadFixture } from '@strata-ctx/eval';
import {
  LIVE_ARMS,
  auditClaims,
  renderClaimsAudit,
  renderUnrunAudit,
  runCampaign,
} from '@strata-ctx/eval-live';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DEFAULT_FIXTURE = join(ROOT, 'packages', 'eval-live', 'fixtures', 'e1-live.json');
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const KEY_VAR = 'OPENROUTER_API_KEY';

const USAGE = `strata-ctx live campaign (F2-7)

  npm run live -- --live --model <provider/model-id>

Options
  --live               Actually send requests and spend money. Omit for a dry run.
  --model <id>         Provider model id. Required with --live.
  --base-url <url>     OpenAI-compatible endpoint. Default ${DEFAULT_BASE_URL}
  --cases <n>          Run only the first n cases. Default: all.
  --fixture <path>     Default ${DEFAULT_FIXTURE.replace(ROOT + '/', '')}
  --out <path>         Write the full run report as JSON.
  -h, --help           This text.

Credential
  ${KEY_VAR} in the environment. Read here, never inside packages/, so package
  tests stay independent of the machine they run on.

Cost
  One invocation per case per arm: ${LIVE_ARMS.length} arms. A full run of the
  shipped fixture is 18 invocations. Nothing is sent without --live.`;

const fail = (msg) => {
  process.stderr.write(`live-campaign: ${msg}\n`);
  process.exit(2);
};

/**
 * @param {readonly string[]} argv
 * @returns {{live: boolean, model: string | null, baseUrl: string, cases: number | null, fixture: string, out: string | null, help: boolean, error: string | null}}
 */
export const parseArgs = (argv) => {
  const opts = {
    live: false,
    model: null,
    baseUrl: DEFAULT_BASE_URL,
    cases: null,
    fixture: DEFAULT_FIXTURE,
    out: null,
    help: false,
    error: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        opts.error ??= `${arg} needs a value`;
        return null;
      }
      i += 1;
      return v;
    };
    if (arg === '--live') opts.live = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--model') opts.model = next();
    else if (arg === '--base-url') opts.baseUrl = next() ?? opts.baseUrl;
    else if (arg === '--cases') {
      const raw = next();
      const n = raw === null ? NaN : Number(raw);
      if (!Number.isInteger(n) || n < 1) opts.error ??= `--cases needs a positive integer, got "${raw}"`;
      else opts.cases = n;
    } else if (arg === '--fixture') opts.fixture = next() ?? opts.fixture;
    else if (arg === '--out') opts.out = next();
    else opts.error ??= `unknown argument ${JSON.stringify(arg)}. Try --help.`;
  }
  return opts;
};

/**
 * `renderUnrunAudit` takes the campaign, not an audit -- it calls
 * `auditUnrunCampaign` itself. Passing a `ClaimsAudit` in compiles, runs, prints
 * a plausible-looking report, and renders every field as `undefined`, because
 * `campaign.model` and `campaign.reason` do not exist on an audit. The type
 * signature is the only thing that catches it, and this file is plain JS.
 */
const unrun = (reason, model, baseUrl) => {
  process.stdout.write(renderUnrunAudit({ model, baseUrl, reason }));
};

const main = async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error !== null) fail(opts.error);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  // Validate the fixture before anything else. A bad fixture found now costs a
  // round trip; found after the first request it costs money.
  let fixture;
  try {
    fixture = loadFixture(opts.fixture);
  } catch (err) {
    fail(`fixture ${opts.fixture.replace(ROOT + '/', '')} is not usable: ${err.message}`);
  }
  // Captured before the slice: comparing the subset against itself is always
  // false, so the "this is a partial run" note below would never print -- the
  // one warning a partial run most needs.
  const totalCases = fixture.cases.length;
  if (opts.cases !== null) fixture = { ...fixture, cases: fixture.cases.slice(0, opts.cases) };

  const invocations = fixture.cases.length * LIVE_ARMS.length;
  const model = opts.model ?? '(not chosen)';
  const apiKey = process.env[KEY_VAR];

  process.stdout.write(
    `live-campaign\n` +
      `  fixture    ${fixture.suite} "${fixture.name}" -- ${fixture.cases.length} cases\n` +
      `  arms       ${LIVE_ARMS.join(', ')}\n` +
      `  invocations ${invocations}\n` +
      `  model      ${model}\n` +
      `  base url   ${opts.baseUrl}\n`,
  );

  if (fixture.cases.length < totalCases) {
    process.stdout.write(
      `  note       ${fixture.cases.length} of ${totalCases} cases selected; a partial run cannot support a whole-suite claim\n`,
    );
  }

  // No credential: say so, and record the campaign as unrun rather than as a
  // result. This is the path this repo is in today.
  if (apiKey === undefined || apiKey === '') {
    process.stderr.write(`\nlive-campaign: no credential. ${KEY_VAR} is not set.\n`);
    process.stderr.write(
      `  Nothing was sent. This is a dry run, and the record below says so:\n\n`,
    );
    unrun(
      `no provider credential: ${KEY_VAR} was not set, so no request was sent and no gate was measured`,
      model,
      opts.baseUrl,
    );
    process.exit(2);
  }

  // A credential but no model: refuse before spending, not after.
  if (!opts.live) {
    process.stdout.write(
      `\n  dry run. Nothing was sent. Add --live --model <id> to spend ${invocations} invocations.\n`,
    );
    return;
  }
  if (opts.model === null) fail('--live needs --model <provider/model-id>. Not guessing one: a wrong id bills a request that returns nothing.');

  process.stdout.write(`\n  running ${invocations} invocations against ${opts.model}...\n`);
  const report = await runCampaign({
    fixture,
    apiKey,
    model: opts.model,
    baseUrl: opts.baseUrl,
  });

  if (opts.out !== null) {
    writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`  report     ${opts.out}\n`);
  }

  const audit = auditClaims(report);
  process.stdout.write(`\n${renderClaimsAudit(audit)}\n`);

  const failed = audit.claims.filter((c) => c.status === 'failed').length;
  const unsupported = audit.claims.filter((c) => c.status === 'unsupported').length;
  if (failed > 0 || unsupported > 0) {
    process.stderr.write(
      `\nlive-campaign: ${failed} claim(s) failed, ${unsupported} unsupported. See the audit above.\n`,
    );
    process.exit(1);
  }
};

/**
 * Resolved real paths, not string equality. macOS `/tmp` is a symlink to
 * `/private/tmp`, so `process.argv[1]` and `import.meta.url` disagree on the very
 * first character for any script run from a temp directory -- which is exactly
 * where a test harness runs a copy. `scripts/wiring-inventory.ts` printed nothing
 * at all there for this reason. See that file's note; this guard is the same fix.
 */
const isMain =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isMain) {
  await main();
}