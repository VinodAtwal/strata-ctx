import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DEFAULT_HOOK_COMMAND, STRATA_HOOK_MARKER } from '../src/claude-code-hooks.js';
import { GEMINI_HOOK_COMMAND } from '../src/gemini.js';
import { DEFAULT_MCP_COMMAND } from '../src/copilot.js';

/**
 * Every command a generated profile registers must be something a user can
 * actually run.
 *
 * These profiles write commands into a host's settings file. A host that cannot
 * execute the command does not warn loudly -- it runs the tool without the
 * governance the config claims is in place, or errors, depending on the host and
 * the event. Either way the user believes governance is on and it is not, which
 * is the worst possible failure for this project.
 *
 * The check is deliberately structural: read `packages/cli/package.json` and
 * require the first token of each registered command to be a declared bin. That
 * catches the class of bug rather than one instance of it, and it would have
 * caught `strata-ctx-hook`, which three profiles registered for the lifetime of
 * this file while the package shipped exactly one bin.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CLI_PACKAGE = JSON.parse(
  readFileSync(join(here, '..', '..', 'cli', 'package.json'), 'utf8'),
) as { bin?: Record<string, string> | string };

const declaredBins = (): string[] => {
  const bin = CLI_PACKAGE.bin;
  if (bin === undefined) return [];
  return typeof bin === 'string' ? [bin] : Object.keys(bin);
};

const firstToken = (command: string): string => command.split(/\s+/)[0] ?? command;

const REGISTERED: readonly { readonly name: string; readonly command: string }[] = [
  { name: 'Claude Code hook marker', command: STRATA_HOOK_MARKER },
  { name: 'Claude Code default hook command', command: DEFAULT_HOOK_COMMAND },
  { name: 'Gemini hook command', command: GEMINI_HOOK_COMMAND },
  { name: 'Copilot MCP command', command: DEFAULT_MCP_COMMAND },
];

describe('every registered command is an installed executable', () => {
  it('has at least one bin to check against', () => {
    assert.ok(declaredBins().length > 0, 'packages/cli must declare a bin');
  });

  for (const { name, command } of REGISTERED) {
    it(`${name} runs a binary this repo installs`, () => {
      const bin = firstToken(command);
      assert.ok(
        declaredBins().includes(bin),
        `${name} registers "${command}", whose executable "${bin}" is not declared in ` +
          `packages/cli/package.json (declared: ${declaredBins().join(', ') || 'none'}). ` +
          'A host that cannot run this command has no governance, whatever the config says.',
      );
    });

    it(`${name} names only the executable, with its arguments after it`, () => {
      assert.ok(command.length > 0);
      assert.equal(command, command.trim(), 'a command with stray whitespace never resolves');
    });
  }

  it('uses one binary, not a proliferation of aliases', () => {
    const bins = new Set(REGISTERED.map((r) => firstToken(r.command)));
    assert.deepEqual([...bins], ['strata-ctx'], `unexpected executables: ${[...bins].join(', ')}`);
  });
});