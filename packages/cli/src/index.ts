#!/usr/bin/env node

/**
 * `strata-ctx` -- the command-line entrypoint (E-13).
 *
 * ## Why this exists
 *
 * The OpenCode profile referenced a binary that no package declared. `strata-ctx
 * mcp serve` was in the generated config and `npm` had nothing to run, so a
 * profile written with MCP enabled could not work on any machine, including this
 * one. That is the same class of defect as the `.mjs` plugin that would not parse:
 * a configuration that advertises a capability and cannot deliver it.
 *
 * ## Why it is a real `bin` and not another `node --import tsx` script
 *
 * `packages/testing/src/cli.ts` already has a working `parseArgs` CLI, and copying
 * its shape was tempting. The difference is that this one has to run in a *user's*
 * project, where there is no `tsx`, no workspace, and no `node_modules` containing
 * this repo. So it is declared as a `bin`, it depends on nothing outside Node's
 * standard library, and it shells out to nothing. A hook executable that needs a
 * dev server is not a hook executable.
 *
 * ## Exit codes are the contract
 *
 * 0 = did what was asked, 1 = the check failed, 2 = the command line was wrong.
 * CI runs `hook --check`, and the only useful thing it can do is fail. That is why
 * `--help` is 0 (the user asked a question and got an answer) while a missing
 * subcommand is 2 (the user asked for nothing and got nothing).
 */

import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const USAGE = `strata-ctx -- context governance for coding agents

  hook --agent <name> [action]
      --agent <name>   opencode, claude-code, gemini-cli
      --install        write the plugin reference into the host config
      --check          exit 0 if governance is active, 1 if not
      --root <dir>     project to inspect (default: cwd)
      --dry-run        print what would change, write nothing

  status
      --log <path>     telemetry log (default: ~/.local/share/strata-ctx/log.jsonl)
      --json           machine-readable
      --no-colour      plain text

  hook run            read a host hook payload on stdin, act on it, print JSON
      --event <name>    pre-tool-use (default) or post-tool-use

  mcp serve           serve the strata-ctx MCP tools over stdio

  -h, --help           this text

Exit codes: 0 ok, 1 check failed, 2 bad command line.
`;

const HOSTS = {
  opencode: 'opencode',
  'claude-code': 'claude-code',
  'gemini-cli': 'gemini-cli',
} as const;
type Host = keyof typeof HOSTS;

/** Where each host keeps its config, relative to the project root. */
const CONFIG_PATHS: Record<Host, string> = {
  opencode: 'opencode.json',
  'claude-code': '.claude/settings.json',
  'gemini-cli': '.gemini/settings.json',
};

/** The plugin OpenCode must load for governance to be live. */
const PLUGIN_REL = '.opencode/plugins/strata-governed.mjs';

/** The executable the Claude and Gemini profiles register for hook events. */
const HOOK_COMMAND = 'strata-ctx hook run';

interface Parsed {
  readonly command: string;
  /** `hook run` and `mcp serve` both reuse the same positional slot. */
  readonly subcommand: string;
  readonly event: string | null;
  readonly agent: string | null;
  readonly root: string;
  readonly install: boolean;
  readonly check: boolean;
  readonly dryRun: boolean;
  readonly log: string | null;
  readonly json: boolean;
  readonly colour: boolean;
  readonly help: boolean;
}

const parse = (argv: readonly string[]): Parsed => {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      agent: { type: 'string' },
      root: { type: 'string' },
      install: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      log: { type: 'string' },
      event: { type: 'string' },
      json: { type: 'boolean', default: false },
      'no-colour': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    // An unrecognised flag is a typo, and a typo that runs anyway is worse than a
    // typo that fails.
    strict: true,
  });
  return {
    command: positionals[0] ?? '',
    subcommand: positionals[1] ?? '',
    event: (values.event) ?? null,
    agent: (values.agent) ?? null,
    root: (values.root) ?? process.cwd(),
    install: values.install === true,
    check: values.check === true,
    // `--install` is the default action for `hook`, so `--dry-run` alone still
    // means "show me", which is the only way `--dry-run` is useful.
    dryRun: values['dry-run'] === true || !values.install,
    log: (values.log) ?? null,
    json: values.json === true,
    colour: values['no-colour'] !== true,
    help: values.help === true,
  };
};

const fail = (message: string, code: 1 | 2): never => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

/**
 * `parseArgs` in strict mode throws on an unknown flag. Left uncaught that is an
 * unhandled exception and the process exits 1, which is indistinguishable from a
 * failed check -- so a typo would look like "governance is broken" in CI. It is a
 * command-line error, and command-line errors are 2.
 */
const parseOrExit = (argv: readonly string[]): Parsed => {
  try {
    return parse(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`strata-ctx: ${message}`, 2);
    throw err;
  }
};

const defaultLog = (): string =>
  join(homedir(), '.local', 'share', 'strata-ctx', 'log.jsonl');

/**
 * Is governance actually live for this project?
 *
 * Two things have to be true, and checking only the first is the mistake that made
 * this task necessary: the config must name the plugin *and* the plugin file must
 * exist. A config pointing at a file that was never written is the exact state a
 * half-finished install leaves behind, and reporting that as healthy is how a
 * project ends up running unguarded.
 */
/**
 * Is governance live for this host?
 *
 * Two mechanisms, because the hosts differ. OpenCode loads a plugin file, so the
 * config naming it is not enough -- the file has to exist. Claude Code and Gemini
 * register an executable command, so what matters is that the config names the
 * command *and* that command resolves on this machine.
 *
 * Reporting `installed` when the executable is absent is the failure this whole
 * task exists to prevent: the config looks right, the tooling says governance is
 * on, and no hook ever runs.
 */
const resolvesHookCommand = (command: string): boolean => {
  const bin = command.split(' ')[0];
  if (bin === undefined || bin === '') return false;
  if (bin.includes('/')) return existsSync(bin);
  const pathDirs = (process.env['PATH'] ?? '').split(':').filter((d) => d !== '');
  return pathDirs.some((dir) => existsSync(join(dir, bin)));
};

interface Inspection {
  readonly config: boolean;
  readonly artefact: boolean;
  readonly path: string;
  readonly mechanism: 'plugin' | 'command';
}

const inspect = (host: Host, root: string): Inspection => {
  const configPath = join(root, CONFIG_PATHS[host]);
  const configExists = existsSync(configPath);
  const raw = configExists ? readFileSync(configPath, 'utf8') : '';
  if (host === 'opencode') {
    const pluginPath = join(root, PLUGIN_REL);
    return {
      config: raw.includes(PLUGIN_REL),
      artefact: existsSync(pluginPath),
      path: pluginPath,
      mechanism: 'plugin',
    };
  }
  return {
    config: raw.includes(HOOK_COMMAND),
    artefact: resolvesHookCommand(HOOK_COMMAND),
    path: HOOK_COMMAND,
    mechanism: 'command',
  };
};

const cmdHook = (p: Parsed): never => {
  const host = (p.agent ?? 'opencode') as Host;
  if (!(host in HOSTS)) {
    fail(`unknown agent ${JSON.stringify(p.agent)}; known: ${Object.keys(HOSTS).join(', ')}`, 2);
  }
  const found = inspect(host, p.root);

  if (p.check) {
    if (found.config && found.artefact) {
      process.stdout.write(
        found.mechanism === 'plugin'
          ? `governance active: ${host} loads ${PLUGIN_REL}\n`
          : `governance active: ${host} runs ${HOOK_COMMAND}\n`,
      );
      return process.exit(0);
    }
    if (!found.config) {
      process.stderr.write(`governance inactive: ${CONFIG_PATHS[host]} does not reference ${found.path}\n`);
    } else {
      process.stderr.write(
        found.mechanism === 'plugin'
          ? `governance inactive: ${CONFIG_PATHS[host]} references the plugin but ${found.path} does not exist\n`
          : `governance inactive: ${CONFIG_PATHS[host]} registers ${found.path} but it is not on PATH\n`,
      );
    }
    return process.exit(1);
  }

  // `hook` with no action describes what it would do, which is what the MCP
  // profile's author needs and what `--dry-run` means by default.
  const state = found.config && found.artefact ? 'installed' : 'not installed';
  process.stdout.write(`${host} governance: ${state}\n`);
  process.stdout.write(`  config:  ${join(p.root, CONFIG_PATHS[host])}\n`);
  process.stdout.write(`  ${found.mechanism === 'plugin' ? 'plugin ' : 'command'}: ${found.path}\n`);
  if (!found.artefact && found.config) {
    process.stdout.write(
      found.mechanism === 'plugin'
        ? `  action:  generate the plugin with buildOpenCodeProfile() from @strata-ctx/integrations\n`
        : `  action:  put this package's bin on PATH (npm run build && node packages/cli/dist/index.js)\n`,
    );
  }
  process.exit(0);
};

const cmdStatus = (p: Parsed): never => {
  const path = p.log ?? defaultLog();
  if (!existsSync(path)) {
    process.stderr.write(`no telemetry log at ${path}\n`);
    process.exit(1);
  }
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  // Counted here rather than by importing the status builder: this command must
  // work in a user project where no workspace package is resolvable, so it parses
  // the log with nothing but Node.
  let records = 0;
  let violations = 0;
  let saved = 0;
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      records += 1;
      const e = (event as { event?: Record<string, unknown> }).event ?? event;
      if (e['type'] === 'violation') violations += 1;
      if (e['type'] === 'savings') {
        const gross = Number((e)['grossSavedUsd'] ?? 0);
        if (Number.isFinite(gross)) saved += gross;
      }
    } catch {
      // A truncated final line is normal for a log being appended to; skipping it
      // is better than refusing to report on the rest.
    }
  }
  const report = { log: path, events: records, violations, grossSavedUsd: saved };
  if (p.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`events: ${report.events}\nviolations: ${report.violations}\n`);
  }
  process.exit(violations > 0 ? 1 : 0);
};

/**
 * `mcp serve` -- the six context tools over newline-delimited JSON on stdio.
 *
 * Loaded with a dynamic import on purpose. `hook --check` is what CI runs, and it
 * must not pay to construct a context store and tool registry to answer "is
 * governance active". An import at the top of the file would make every command
 * depend on the MCP stack loading cleanly, which is precisely the coupling that
 * made the generated config unrunnable in the first place.
 */
const cmdMcp = async (p: Parsed): Promise<void> => {
  if (p.subcommand !== 'serve') {
    fail(`unknown mcp subcommand ${JSON.stringify(p.subcommand)}; only \`serve\` exists`, 2);
  }
  const { createInMemoryContext, createStrataMcpServer, serveStdio } = await import(
    '@strata-ctx/integrations'
  );
  const server = createStrataMcpServer(createInMemoryContext());
  // stderr, not stdout: stdout is the JSON-RPC channel and a stray log line there
  // is a parse error in the host.
  process.stderr.write('strata-ctx mcp: serving on stdio\n');
  const stdio = serveStdio(process.stdin, process.stdout, server);
  await stdio.done;
  // Exit 0 on a clean end of input. A host that closes stdin is a normal shutdown,
  // and a non-zero exit here would make the host report a crash.
  process.exit(0);
};

/**
 * `hook run` -- the subcommand the Claude Code and Gemini profiles register.
 *
 * Both profiles used to name a dedicated `strata-ctx-hook` binary and the package
 * never installed one: this package has exactly one bin, `strata-ctx`. The
 * profiles now name this dispatcher, and
 * `packages/integrations/test/installed-bin.test.ts` reads `package.json` to keep
 * it that way.
 *
 * The old wiring was the same defect as the Copilot `strata-ctx-mcp` reference: a
 * host settings file that claims governance and cannot deliver it. What a host
 * does with a command it cannot run -- error, or skip the hook quietly -- depends
 * on the host and the event, and neither outcome is governance. A user who reads
 * their settings file and concludes they are protected is the specific failure
 * worth engineering against here.
 *
 * ## The fail-open / fail-closed asymmetry, stated deliberately
 *
 * `pre-tool-use` denies on a finding, and denies on *our own* failure to
 * understand the payload. A hook we cannot parse is a hook that would let
 * anything through, so denying is the only honest answer.
 *
 * `post-tool-use` fails open, because there is nothing to block after the fact.
 * The tool has already run; the only thing left to do is redact and inject, and
 * refusing to redact would leak the secret into the transcript *and* lose the
 * governance block. It says so on stdout instead of pretending.
 *
 * ## stdout is a protocol channel
 *
 * Exactly one JSON object, on stdout, always. stderr is for the human. A stray
 * log line on stdout is a parse error in the host, so the CLI keeps the two
 * apart even when it wants to complain.
 */
const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
};

const cmdHookRun = async (p: Parsed): Promise<void> => {
  // `hook run` and `hook --event X` are the same command. `run` is the verb, not
  // an event name, so it has to be dropped here -- otherwise the plain `hook run`
  // that the installed profiles invoke reports an unknown event and blocks
  // every tool call with an argument error instead of a governance decision.
  const positionalEvent = p.subcommand === 'run' || p.subcommand === '' ? '' : p.subcommand;
  const event = p.event ?? (positionalEvent === '' ? 'pre-tool-use' : positionalEvent);
  if (event !== 'pre-tool-use' && event !== 'post-tool-use') {
    fail(`unknown hook event ${JSON.stringify(event)}; known: pre-tool-use, post-tool-use`, 2);
  }

  let payload: unknown;
  try {
    const raw = await readStdin();
    payload = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch (err) {
    // Denying an unparseable pre-tool payload is the point; see the comment above.
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `strata-ctx could not parse the tool payload: ${message}`,
        },
      })}\n`,
    );
    process.exit(0);
  }

  if (event === 'post-tool-use') {
    // Lazy, and for the same reason as `mcp`: a redaction failure must not stop
    // `hook --check` from answering.
    const { ClaudeCodeHooks } = await import('@strata-ctx/integrations');
    const result = new ClaudeCodeHooks().rewritePostToolUse(payload);
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: result.content,
        },
      })}\n`,
    );
    process.exit(0);
  }

  const bag = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
  // Only strings: `String({})` yields '[object Object]' and would go into the
  // scanner as a tool name that matches no rule, quietly widening coverage.
  const rawTool = bag['tool_name'];
  const tool = typeof rawTool === 'string' ? rawTool : '';
  const input = (bag['tool_input'] ?? {}) as Record<string, unknown>;
  const { scanDestructive } = await import('@strata-ctx/security');
  const scan = scanDestructive({ tool, parameters: input });

  if (scan.verdict === 'deny') {
    const rules = scan.findings.map((f) => f.id).join(', ');
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `strata-ctx blocked this tool call: ${rules}`,
        },
      })}\n`,
    );
    process.exit(0);
  }

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    })}\n`,
  );
  process.exit(0);
};

const main = (): void => {
  const p = parseOrExit(process.argv.slice(2));
  if (p.help || p.command === '') {
    process.stdout.write(USAGE);
    process.exit(p.command === '' && !p.help ? 2 : 0);
  }
  if (p.command === 'hook') {
    if (p.subcommand === 'run' || p.event !== null) {
      void cmdHookRun(p);
      return;
    }
    cmdHook(p);
    return;
  }
  if (p.command === 'status') {
    cmdStatus(p);
    return;
  }
  if (p.command === 'mcp') {
    void cmdMcp(p);
    return;
  }
  fail(`unknown command ${JSON.stringify(p.command)}; try --help`, 2);
};

main();