/**
 * Gate 4 -- the uncalled total must not rise (J-12).
 *
 * ## What this gate adds, and what it deliberately does not
 *
 * Gates 1-3 in `wiring-ledger.test.ts` are per-symbol: a new uncalled operator
 * without a row fails, a row whose symbol has become wired fails, an
 * unreachable package whose export count moved fails. All three can be
 * satisfied by *declaring the new thing*. Adding ten dead operators and ten
 * rows is a green commit under Gates 1-3.
 *
 * This gate is the only one that cannot be satisfied that way. It fails when
 * the total count of uncalled runtime exports rises above a declared baseline,
 * so accepting growth is a deliberate edit to one constant, in this file, with
 * a reason next to it -- rather than nine table rows that look like work.
 *
 * ## The falsifier came first, and it did not fire
 *
 * docs/testing-plan.md pre-registered the condition under which this row should
 * be rejected outright:
 *
 *   "if the count is already unstable for benign reasons -- a barrel export, a
 *    type-only export -- the stricter gate produces noise and should be
 *    rejected. Measure before adopting."
 *
 * The measurement is in docs/wiring-ledger.md §4 and it is reproducible:
 * `node --import tsx scripts/wiring-inventory.ts` prints the same bytes and the
 * same digest on every run. Five runs, eight concurrent runs, three timezones,
 * two locales and two working directories all produce digest `e6e681876d468322`
 * on the tree this baseline was taken against.
 *
 * The four benign cases the falsifier names, measured rather than assumed:
 *
 * | Change | Unwired |
 * |---|---|
 * | `export type { T }` / `export interface I` / a type-only module reached through a barrel | 0 |
 * | A barrel re-exporting a symbol the barrel already exports | 0 |
 * | `export * as ns` over a module no barrel reaches | +2, one per member, counted as `ns.member` |
 * | A new operator, wired, with a caller in another reachable file | **0** |
 *
 * The last row is the one that matters. Adding working code and calling it does
 * not move this gate, so the gate does not tax the thing it is supposed to
 * encourage.
 *
 * Two measured results do *not* belong in that table, and are recorded in §9 of
 * the doc instead of here, because listing them as stability would be the
 * opposite of the truth: `export declare const` is counted though it is erased
 * at runtime (zero occurrences in this tree), and `export * as ns` over a module
 * that is *already* reachable somewhere else moves nothing at all, because
 * `collectExports` dedupes by resolved path and its `seen` set ignores the
 * namespace prefix. That second one is a miss, not a neutral: the two namespaced
 * exports do not exist in the inventory. It is the only bias found that points
 * the wrong way.
 *
 * ## Where the baseline came from, and the disagreement with the old table
 *
 * docs/wiring-ledger.md §4 used to say 1089 exports / 152 wired / 937 unwired,
 * of which 383 local and 554 inherited. The measured tree says **1098 / 152 /
 * 946**, of which 384 local and 562 inherited. The measured numbers win; see
 * §4 of the doc for the nine exports they account for. Declaring the stale
 * figures here would have shipped a gate that fails on the commit that fixes
 * the doc, which is the crying-wolf outcome the falsifier exists to prevent.
 *
 * ## Why the baseline is checked in both directions
 *
 * A one-way ceiling (`unwired <= baseline`) has a hole in it that is worth
 * naming, because it is the reason this is not a `>`: wire fifty operators, the
 * count falls to 896, the baseline stays at 946, and the next fifty uncalled
 * exports pass with room to spare. The ratchet goes slack every time somebody
 * does something good, and slack is indistinguishable from permission.
 *
 * So falling below the baseline fails too, with the opposite remedy: tighten
 * `UNCALLED_BASELINE` to the measured value. That is what makes it a ratchet
 * rather than a ceiling -- the number may only move by someone editing one
 * constant on purpose, in either direction, and the direction that costs effort
 * (wiring, deleting) is the direction that must also update the constant.
 */

import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildLedger, findRepoRoot } from '../src/wiring-ledger.js';

const ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

/* ------------------------------------------------------------------ *
 * The declared baseline. One constant, one place to bump.
 *
 * Taken at 8faf398, the commit J-12 was dispatched from, against the counts
 * `node --import tsx scripts/wiring-inventory.ts` prints for that tree:
 * digest e6e681876d468322.
 *
 * Reason it is here and not derived: a derived baseline is not a baseline. The
 * ledger already refuses to hand-maintain an inventory of operators for exactly
 * this reason (docs/wiring-ledger.md §9), and a number that recomputes from the
 * tree it is meant to constrain constrains nothing.
 *
 * Reason the package breakdown is here too, when the total alone would do: the
 * total says *that* the count moved and the breakdown says *where*, and the
 * per-package figures are the only part that is not already implied by a table
 * someone else maintains. For the unreachable packages the count in
 * UNREACHABLE_PACKAGES *is* the measured count once Gate 2 passes, so
 * comparing against it would be comparing a table with itself; the local half
 * is the independent check, and it is why this is here.
 *
 * To accept growth: wire it, delete it, or edit the numbers below and say in the
 * commit body why the total is allowed to move. There is no third option and
 * no way to satisfy this gate from `UNWIRED_OPERATORS`.
 * ------------------------------------------------------------------ */

const UNCALLED_BASELINE = {
  /** Every exported runtime value the barrel walk reaches. */
  exports: 1098,
  /** Of those, the ones with a caller outside their own declaring file. */
  wired: 152,
  /** exports - wired. The number this gate is about. */
  unwired: 946,
  /** Unwired because no entry root reaches the declaring package. */
  inherited: 562,
  /** Unwired inside a reachable package; each needs a reason in Gate 1. */
  local: 384,
  /** The local half by package -- the only figure here Gate 1 does not imply. */
  localByPackage: {
    'core-types': 32,
    gateway: 72,
    integrations: 126,
    pipeline: 51,
    security: 52,
    telemetry: 51,
  },
} as const;

/** Reachability of a package is what splits `unwired` into the two halves. */
const REACHABLE = new Set([
  'cli',
  'core-types',
  'gateway',
  'integrations',
  'pipeline',
  'security',
  'telemetry',
]);

const ledger = buildLedger(ROOT);

const measured = {
  exports: ledger.entries.length,
  wired: ledger.wired.length,
  unwired: ledger.unwired.length,
  inherited: ledger.inheritedUnwired.length,
  local: ledger.locallyUnwired.length,
};

const localByPackage: Record<string, number> = {};
for (const entry of ledger.locallyUnwired) {
  localByPackage[entry.package] = (localByPackage[entry.package] ?? 0) + 1;
}

const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

/* ------------------------------------------------------------------ *
 * The baseline itself must be internally consistent.
 *
 * A typo in `localByPackage` that still summed to `local` would make the
 * per-package half of the failure message name the wrong package, which is
 * worse than not naming it. And a baseline whose parts do not add up was
 * measured against a tree nobody can reconstruct, so it is not evidence.
 * ------------------------------------------------------------------ */

test('the declared baseline is internally consistent', () => {
  const partsSum = UNCALLED_BASELINE.localByPackage;
  const perPackage = Object.values(partsSum).reduce((a, b) => a + b, 0);
  assert.equal(perPackage, UNCALLED_BASELINE.local, `localByPackage sums to ${perPackage}, not ${UNCALLED_BASELINE.local}`);
  assert.equal(
    UNCALLED_BASELINE.inherited + UNCALLED_BASELINE.local,
    UNCALLED_BASELINE.unwired,
    'inherited + local must equal the declared unwired total',
  );
  assert.equal(
    UNCALLED_BASELINE.wired + UNCALLED_BASELINE.unwired,
    UNCALLED_BASELINE.exports,
    'wired + unwired must equal the declared export total',
  );
  assert.deepEqual(
    Object.keys(partsSum).filter((p) => !REACHABLE.has(p)),
    [],
    'localByPackage names a package that is not reachable, so it cannot hold locally-unwired exports',
  );
  for (const entry of ledger.entries) {
    if (!entry.wired && REACHABLE.has(entry.package)) {
      assert.ok(
        entry.package in partsSum,
        `${entry.package} has ${localByPackage[entry.package] ?? 0} locally-unwired exports and no baseline entry; every reachable package with one needs a figure here`,
      );
    }
  }
});

/* ------------------------------------------------------------------ *
 * Gate 4 -- the ratchet.
 *
 * Fails in both directions, with different messages, because the two
 * directions have opposite remedies and one message cannot carry both.
 * ------------------------------------------------------------------ */

test('the count of uncalled runtime exports has not risen above the baseline', () => {
const drift: string[] = [];
  if (measured.unwired > UNCALLED_BASELINE.unwired) {
    drift.push(
      `total ${UNCALLED_BASELINE.unwired} -> ${measured.unwired} (${signed(measured.unwired - UNCALLED_BASELINE.unwired)})`,
      `  inherited ${UNCALLED_BASELINE.inherited} -> ${measured.inherited} (${signed(measured.inherited - UNCALLED_BASELINE.inherited)})`,
      `  local     ${UNCALLED_BASELINE.local} -> ${measured.local} (${signed(measured.local - UNCALLED_BASELINE.local)})`,
    );

    // Which packages moved. A package moving down while the total moves up means
    // work was done in one package and dead code was added in another, and the
    // per-package lines are the only place that shows.
    for (const name of Object.keys(UNCALLED_BASELINE.localByPackage).sort()) {
      const before = UNCALLED_BASELINE.localByPackage[name as keyof typeof UNCALLED_BASELINE.localByPackage];
      const after = localByPackage[name] ?? 0;
      if (after !== before) drift.push(`  ${name}: ${before} -> ${after} (${signed(after - before)}) locally uncalled`);
    }
  }

  assert.deepEqual(
    drift,
    [],
    [
      'the number of uncalled runtime exports ROSE. Gates 1 and 2 are still green, which means every one of these is declared: this is the only gate that notices growth that arrives with its own table rows.',
      '',
      'three ways out, and only three:',
      '  1. wire the new operators. The count falls and so does the baseline.',
      '  2. delete them. Deleting dead code is a legitimate answer to a ledger that says it is dead.',
      '  3. accept the growth on purpose: edit UNCALLED_BASELINE at the top of this file and say in the commit body why the total is allowed to rise.',
      'adding a row to UNWIRED_OPERATORS does not satisfy this gate, and that is the whole point of it.',
      '',
      'drift:',
      ...drift,
      '',
      'to see exactly which exports are new, diff the derived inventory over your change:',
      '  node --import tsx scripts/wiring-inventory.ts --json > /tmp/before.json   # on the base commit',
      '  node --import tsx scripts/wiring-inventory.ts --json > /tmp/after.json',
      '  diff /tmp/before.json /tmp/after.json',
    ].join('\n'),
  );
});

test('the baseline has not been left looser than the tree', () => {
  // The other half of the ratchet. A one-way ceiling goes slack every time
  // somebody wires something real: the count falls, the baseline stays, and the
  // next N uncalled exports pass for free. Slack is indistinguishable from
  // permission once it exists, so it is a failure with its own message.
  assert.ok(
    measured.unwired >= UNCALLED_BASELINE.unwired,
    [
      `the count of uncalled runtime exports FELL to ${measured.unwired}, below the baseline of ${UNCALLED_BASELINE.unwired}.`,
      'That is an improvement, and it is still a failure: while the baseline stays high it silently permits the same number of new uncalled exports to be added without anyone deciding to.',
      '',
      `  total     ${UNCALLED_BASELINE.unwired} -> ${measured.unwired} (${signed(measured.unwired - UNCALLED_BASELINE.unwired)})`,
      `  inherited ${UNCALLED_BASELINE.inherited} -> ${measured.inherited} (${signed(measured.inherited - UNCALLED_BASELINE.inherited)})`,
      `  local     ${UNCALLED_BASELINE.local} -> ${measured.local} (${signed(measured.local - UNCALLED_BASELINE.local)})`,
      '  exports   ' + `${UNCALLED_BASELINE.exports} -> ${measured.exports} (${signed(measured.exports - UNCALLED_BASELINE.exports)})`,
      '  wired     ' + `${UNCALLED_BASELINE.wired} -> ${measured.wired} (${signed(measured.wired - UNCALLED_BASELINE.wired)})`,
      '',
      'fix: tighten UNCALLED_BASELINE in this file to the measured figures above. Nothing else has to change.',
    ].join('\n'),
  );
});

/* ------------------------------------------------------------------ *
 * The gate must be able to fail, and it must be measuring the real tree.
 *
 * A gate that compares two numbers both derived from a broken scan is a gate
 * that agrees with a broken scan. These assert the two things a false green
 * would look like, using figures that are independently checkable by reading
 * docs/wiring-ledger.md §4 or by running the inventory script.
 * ------------------------------------------------------------------ */

test('the ratchet is comparing against the real inventory, not an empty one', () => {
  assert.ok(measured.exports > 900, `only ${measured.exports} exports found; the barrel walk is broken and this gate would compare two zeros`);
  assert.ok(measured.wired > 120, `only ${measured.wired} exports have a caller; the identifier search is broken and every total below is fiction`);
  assert.equal(measured.exports, measured.wired + measured.unwired, 'the three declared figures must partition the inventory');
  assert.equal(measured.unwired, measured.inherited + measured.local, 'inherited and local must partition the unwired half');
  // Both halves non-empty: a scan that put everything in one bucket would still
  // add up, and would mean the split the baseline records is not the real one.
  assert.ok(measured.inherited > 0 && measured.local > 0, 'one half of the unwired count is empty; the reachability split has collapsed');
});

test('the baseline still describes the tree it was measured against', () => {
  // Not a gate on the count -- the count is the two tests above. This one is a
  // tripwire for a *stale* baseline that still passes: if the export total and
  // the wired total have both moved a long way from the declared figures while
  // the unwired total happened to land back on the baseline, the constant is
  // describing a tree that no longer exists and nobody knows which.
  const exportsMoved = Math.abs(measured.exports - UNCALLED_BASELINE.exports);
  const wiredMoved = Math.abs(measured.wired - UNCALLED_BASELINE.wired);
  assert.ok(
    exportsMoved < 100 && wiredMoved < 25,
    [
      `UNCALLED_BASELINE describes a tree that no longer exists.`,
      `  exports ${UNCALLED_BASELINE.exports} -> ${measured.exports} (${signed(measured.exports - UNCALLED_BASELINE.exports)})`,
      `  wired   ${UNCALLED_BASELINE.wired} -> ${measured.wired} (${signed(measured.wired - UNCALLED_BASELINE.wired)})`,
      `  unwired ${UNCALLED_BASELINE.unwired} -> ${measured.unwired} (${signed(measured.unwired - UNCALLED_BASELINE.unwired)})`,
      'the unwired total landing on the baseline while both other figures have moved is not a coincidence to rely on. Re-measure and re-declare all five numbers together.',
    ].join('\n'),
  );
});
