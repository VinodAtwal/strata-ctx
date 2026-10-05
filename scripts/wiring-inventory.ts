#!/usr/bin/env node
/**
 * Print the wiring ledger's inventory, reproducibly (J-12).
 *
 * ## Why this exists
 *
 * `packages/testing/test/wiring-ledger.test.ts` holds Gates 1-4. Gate 4 fails
 * when the total count of uncalled runtime exports *rises*, which is only a
 * meaningful gate if the count it compares is stable. docs/testing-plan.md
 * pre-registered the falsifier for that row:
 *
 *   "if the count is already unstable for benign reasons -- a barrel export, a
 *    type-only export -- the stricter gate produces noise and should be
 *    rejected. Measure before adopting."
 *
 * So the measurement has to be a thing you can re-run, not a number somebody
 * once typed into a doc. This script is that thing: same tree in, byte-identical
 * report out, with a digest of the canonical inventory so "did anything move?"
 * is one `sha256` comparison rather than a diff by eye.
 *
 * ## What it deliberately does not do
 *
 * It does not decide anything. No gate reads this script, and the gate computes
 * its counts from `buildLedger` directly: a gate whose numbers come from a
 * subprocess is a gate that fails for the wrong reason when the subprocess is
 * broken. This is the instrument; the gate is the rule. The eight lines of
 * aggregation are written out in both places on purpose -- a shared helper would
 * mean a test importing `scripts/`, and `packages/` must not reach across into
 * dev tooling (AGENTS.md §9).
 *
 * ## Usage
 *
 *   node --import tsx scripts/wiring-inventory.ts          # report + digest
 *   node --import tsx scripts/wiring-inventory.ts --json   # canonical records
 *
 * `--json` emits one sorted array, so `diff <(a --json) <(b --json)` names the
 * exports that moved rather than reporting only that the total did.
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildLedger, findRepoRoot, type WiringLedger } from '../packages/testing/src/wiring-ledger.js';

export interface InventoryRecord {
  /** `package/name`, the same key shape UNWIRED_OPERATORS uses. */
  readonly key: string;
  readonly wired: boolean;
  readonly confidence: string;
  readonly declaredIn: string;
  /** False when no entry root reaches the declaring file. */
  readonly fileReachable: boolean;
}

export interface Inventory {
  readonly root: string;
  readonly files: number;
  readonly reachableFiles: number;
  readonly exports: number;
  readonly wired: number;
  readonly unwired: number;
  /** Unwired only because the declaring package is unreachable. */
  readonly inherited: number;
  /** Unwired inside a reachable package -- these need a declared reason. */
  readonly local: number;
  readonly reachablePackages: readonly string[];
  readonly unwiredByPackage: Readonly<Record<string, number>>;
  /** Sorted, so the digest below is a function of the tree and nothing else. */
  readonly records: readonly InventoryRecord[];
  readonly digest: string;
}

/**
 * Canonical form: sorted keys, fixed field order, no timestamps and no absolute
 * paths. Two runs over the same tree must produce the same string, so nothing
 * here may depend on clock, cwd, environment or directory iteration order.
 */
export function inventoryOf(ledger: WiringLedger): Inventory {
  const byPackage: Record<string, number> = {};
  for (const entry of ledger.unwired) {
    byPackage[entry.package] = (byPackage[entry.package] ?? 0) + 1;
  }
  const unwiredByPackage: Record<string, number> = {};
  for (const key of Object.keys(byPackage).sort()) unwiredByPackage[key] = byPackage[key]!;

  // Sorted by key, and not merely in the order `buildLedger` emitted. That order
  // sorts by (package, name), which is a different sequence from sorting by
  // `package/name` whenever one package name is a prefix of another -- and two
  // are: `eval-live/foo` sorts before `eval/bar` because `-` (0x2D) precedes
  // `/` (0x2F). Both orders are deterministic, so the digest is stable either
  // way, but `--json` is documented as one sorted array and is meant to be
  // diffed, so it gets sorted on the key that identifies a record.
  const records: InventoryRecord[] = ledger.entries
    .map((e) => ({
      key: `${e.package}/${e.name}`,
      wired: e.wired,
      confidence: e.confidence,
      declaredIn: e.declaredIn,
      fileReachable: e.fileReachable,
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const canonical = records.map((r) => `${r.key}\t${r.wired ? 'wired' : 'unwired'}\t${r.confidence}\t${r.declaredIn}`).join('\n');

  return {
    root: ledger.root,
    files: ledger.files.length,
    reachableFiles: ledger.reachableFiles.length,
    exports: ledger.entries.length,
    wired: ledger.wired.length,
    unwired: ledger.unwired.length,
    inherited: ledger.inheritedUnwired.length,
    local: ledger.locallyUnwired.length,
    reachablePackages: ledger.packages.filter((p) => p.reachable).map((p) => p.name),
    unwiredByPackage,
    records,
    digest: createHash('sha256').update(canonical).digest('hex').slice(0, 16),
  };
}

function report(inv: Inventory): string {
  const lines = [
    `root                ${inv.root}`,
    `files scanned       ${inv.files}`,
    `files reachable     ${inv.reachableFiles}`,
    `runtime exports     ${inv.exports}`,
    `wired               ${inv.wired}`,
    `unwired             ${inv.unwired}`,
    `  inherited         ${inv.inherited}   (declaring package unreachable)`,
    `  local             ${inv.local}   (reachable package; needs a declared reason)`,
    `reachable packages  ${inv.reachablePackages.join(', ')}`,
    `digest              ${inv.digest}`,
    'unwired by package:',
  ];
  for (const [name, count] of Object.entries(inv.unwiredByPackage)) {
    lines.push(`  ${name.padEnd(18)}${count}`);
  }
  return lines.join('\n');
}

/**
 * Compare resolved real paths, not raw strings: on macOS `/tmp` is a symlink to
 * `/private/tmp`, so `process.argv[1]` and `import.meta.url` disagree on the
 * very first character for any script run from a temp directory. Comparing the
 * strings made this file print nothing at all there -- a silent no-output is the
 * worst possible failure for the instrument whose job is to be run and compared.
 */
const isMain =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const root = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
  const inv = inventoryOf(buildLedger(root));
  process.stdout.write(`${process.argv.includes('--json') ? `${JSON.stringify(inv.records, null, 2)}\n` : `${report(inv)}\n`}`);
}
