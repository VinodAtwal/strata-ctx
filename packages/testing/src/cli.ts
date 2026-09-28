import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { FixtureError } from './errors.js';
import { loadFixtureFile, summarizeFixtureFile, type LoadedFixture } from './fixture.js';

/**
 * `fixtures` -- list, validate and summarise recorded fixtures.
 *
 *   node --import tsx packages/testing/src/cli.ts list      <dir>
 *   node --import tsx packages/testing/src/cli.ts validate  <path...>
 *   node --import tsx packages/testing/src/cli.ts summary   <path...>
 *   node --import tsx packages/testing/src/cli.ts paths     <dir>
 *
 * Built on `node:util`'s `parseArgs` and nothing else: this is a developer
 * affordance for a repo that has exactly one runtime dependency set, and a
 * dependency added for argument parsing is a dependency ten other workstreams
 * now have to audit.
 *
 * Exit codes are the contract, not a nicety: CI runs `validate`, and the only
 * useful thing it can do is fail. 0 = every fixture parsed, 1 = something did
 * not, 2 = the command line itself was wrong.
 */

const USAGE = `fixtures -- list, validate and summarise recorded provider fixtures

  list <dir>            one line per fixture file, parsed
  validate <path...>    parse every fixture; non-zero exit on any failure
  summary <path...>     per-entry detail: status, bytes, events, redactions
  paths <dir>           just the file paths, for scripting; never parsed

  --json                machine-readable output
  -h, --help            this text`;

interface CliOptions {
  readonly json: boolean;
}

const parse = (argv: readonly string[]): { command: string; positional: string[]; options: CliOptions } => {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    // An unrecognised flag is a typo. `strict` makes parseArgs throw rather than
    // quietly ignoring `--jsno`, which would otherwise be a command that runs and
    // produces output nobody can consume.
    strict: true,
  });
  // No default command. A bare path would otherwise be silently reinterpreted,
  // and a mistyped command name (`validat`) has to be an error rather than a
  // summary of a corpus called `validat`.
  const command = positionals[0] ?? '';
  return {
    command,
    positional: positionals.slice(1),
    options: { json: values.json === true },
  };
};

const expandTargets = (positional: readonly string[]): string[] =>
  positional.flatMap((target) =>
    existsSync(target) && statSync(target).isDirectory()
      ? readdirSync(target)
          .filter((n) => n.endsWith('.json'))
          .sort()
          .map((n) => join(target, n))
      : [target],
  );

const list = (targets: readonly string[], json: boolean): number => {
  // Parsed on purpose: a listing of names and entry counts that could not be
  // loaded would be a lie, and `paths` covers the don't-parse-anything case.
  const rows = targets.map((target) => {
    const file = loadFixtureFile(target);
    const events = file.entries.reduce((n, e) => n + (e.response.kind === 'sse' ? e.response.events.length : 0), 0);
    return { path: target, name: file.name, provider: file.provider, version: file.fixtureFormatVersion, entries: file.entries.length, sseEvents: events };
  });
  if (json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  for (const r of rows) {
    process.stdout.write(
      `${r.path}\t${r.name}\t${r.provider}\tv${r.version}\tentries=${r.entries}\tsse-events=${r.sseEvents}\n`,
    );
  }
  return 0;
};

/**
 * Bare paths, one per line, never parsed.
 *
 * Scripting wants the filenames even when the corpus does not validate -- that
 * is often the very reason you are asking. So this deliberately does no I/O
 * beyond the directory listing, and cannot fail on fixture content.
 */
const paths = (targets: readonly string[], json: boolean): number => {
  if (json) {
    process.stdout.write(`${JSON.stringify(targets, null, 2)}\n`);
    return 0;
  }
  for (const target of targets) {
    process.stdout.write(`${target}\n`);
  }
  return 0;
};

const summary = (targets: readonly string[], json: boolean): number => {
  const loaded: LoadedFixture[] = targets.map((t) => ({ path: t, file: loadFixtureFile(t) }));
  if (json) {
    process.stdout.write(
      `${JSON.stringify(loaded.map((l) => ({ path: l.path, ...summarizeFixtureFile(l.file) })), null, 2)}\n`,
    );
    return 0;
  }
  for (const { path, file } of loaded) {
    const s = summarizeFixtureFile(file);
    process.stdout.write(`${path}\n  ${s.name} (${s.provider}, format v${s.version})\n`);
    for (const [i, e] of s.entries.entries()) {
      const flags = [
        e.truncatedTail ? 'truncated-tail' : '',
        e.redactedHeaders > 0 ? `redacted-headers=${e.redactedHeaders}` : '',
        e.redactedBodyPaths > 0 ? `redacted-body-paths=${e.redactedBodyPaths}` : '',
      ]
        .filter((f) => f !== '')
        .join(' ');
      process.stdout.write(
        `    [${i}] ${e.name} ${e.method} ${e.path} -> ${e.status} ${e.kind} ` +
          `hash=${e.canonicalHash.slice(0, 12)} bytes=${e.responseBytes} events=${e.eventCount}` +
          `${e.totalDelayMs > 0 ? ` delayMs=${e.totalDelayMs}` : ''}${flags === '' ? '' : ` [${flags}]`}\n`,
      );
    }
  }
  return 0;
};

const validate = (targets: readonly string[], json: boolean): number => {
  const results = targets.map((path) => {
    try {
      const file = loadFixtureFile(path);
      return { path, ok: true, name: file.name, entries: file.entries.length };
    } catch (err) {
      return { path, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  if (json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    for (const r of results) {
      process.stdout.write(r.ok ? `ok   ${r.path}\n` : `FAIL ${r.path}\n  ${r.error}\n`);
    }
  }
  return results.some((r) => !r.ok) ? 1 : 0;
};

type Runner = (targets: readonly string[], json: boolean) => number;

/** The command table, so `USAGE`, dispatch and validation cannot drift apart. */
const RUNNERS: Readonly<Record<string, Runner>> = {
  list,
  paths: (targets, json) => paths(targets, json),
  validate,
  summary,
};

const run = (argv: readonly string[]): number => {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}\n`);
    return 2;
  }

  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const { command, positional, options } = parsed;
  // Resolved before the argument count is checked, so a mistyped command says
  // so rather than complaining that it was also given no files.
  const runner = RUNNERS[command];
  if (runner === undefined) {
    process.stderr.write(
      command === '' ? `fixtures: a command is required\n` : `fixtures: unknown command '${command}'\n`,
    );
    process.stderr.write(`\n${USAGE}\n`);
    return 2;
  }

  const targets = expandTargets(positional);
  if (targets.length === 0) {
    process.stderr.write(`fixtures: ${command} needs at least one path\n\n${USAGE}\n`);
    return 2;
  }

  return runner(targets, options.json);
};

try {
  process.exitCode = run(process.argv.slice(2));
} catch (err) {
  // A FixtureError carries a diagnosis; anything else is a bug in the CLI and is
  // printed with its stack so it can be fixed rather than guessed at.
  if (err instanceof FixtureError) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
