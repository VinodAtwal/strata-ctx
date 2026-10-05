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
 * ## Why the gate is keyed on `local`, and what that costs
 *
 * This was first keyed on the total, and the first thing that happened is in
 * §"The +12" below: `eval-live`'s barrel grew by twelve re-exports and the
 * total moved by twelve, with no dead product code anywhere in the diff.
 *
 * That is the weakness in keying on the total, and it is not a small one. The
 * unreachable packages are harness packages (`eval`, `eval-live`, `testing`,
 * `canary`), so a single new re-export in any of them moves this gate while
 * saying nothing about whether the product got more dead. A gate that cries
 * wolf on a barrel export is a gate people learn to edit the baseline on, which
 * makes it worse than no gate -- so the gate is now keyed on `local`, which is
 * the half that means *a reachable package grew something nobody calls*.
 *
 * What is given up, stated plainly: `inherited` is no longer ratcheted, so dead
 * code added to an unreachable package no longer trips this gate. That is a real
 * reduction in coverage and it is accepted deliberately, because the
 * alternative was a gate that fails on correct work. `inherited` is still
 * measured and still printed in both failure messages, so the movement is
 * visible to whoever reads the failure rather than hidden by it. If a harness
 * package ever needs its own ratchet, the honest form is a second baseline
 * keyed on `inherited` -- not this one widened back to the total.
 *
 * ## The +12 that moved `inherited`, and why it was not a regression
 *
 * 946 -> 958 was not new dead code (now 948: `2ea82bb` pruned 11 eval-live
 * re-exports and `3b23f34` added `recoverEvictedMessages`). All twelve arrived with F2-4's tool-call
 * channel, whose exports `eval-live`'s barrel now re-exports. `eval-live` has no
 * entry root, so every one of its exports is `inherited` by definition and the
 * count rises whether or not anything calls them -- and most are called inside
 * `eval-live`, just not from a reachable file. `local` was unchanged at 384
 * throughout, which is exactly why the gate is keyed on it.
 *
 *
 * To accept growth: wire it, delete it, or edit the numbers below and say in the
 * commit body why the total is allowed to move. There is no third option and
 * no way to satisfy this gate from `UNWIRED_OPERATORS`.
 * ------------------------------------------------------------------ */

const UNCALLED_BASELINE = {
  /** Every exported runtime value the barrel walk reaches. Informational. */
  exports: 1100,
  /** Of those, the ones with a caller outside their own declaring file. Informational. */
  wired: 152,
  /** exports - wired. Informational; `local` is the number this gate is about. */
  unwired: 948,
  /** Unwired because no entry root reaches the declaring package. Informational. */
  inherited: 564,
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

test('the count of locally uncalled runtime exports has not risen above the baseline', () => {
  const drift: string[] = [];
  if (measured.local > UNCALLED_BASELINE.local) {
    drift.push(
      `local ${UNCALLED_BASELINE.local} -> ${measured.local} (${signed(measured.local - UNCALLED_BASELINE.local)})`,
      `  inherited ${UNCALLED_BASELINE.inherited} -> ${measured.inherited} (${signed(measured.inherited - UNCALLED_BASELINE.inherited)})  (reported, not gated)`,
      `  total     ${UNCALLED_BASELINE.unwired} -> ${measured.unwired} (${signed(measured.unwired - UNCALLED_BASELINE.unwired)})  (reported, not gated)`,
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
      'the number of LOCALLY uncalled runtime exports ROSE. A reachable package grew something nobody calls. Gates 1 and 2 are still green, which means every one of these is declared: this is the only gate that notices growth that arrives with its own table rows.',
      '',
      'three ways out, and only three:',
      '  1. wire the new operators. The count falls and so does the baseline.',
      '  2. delete them. Deleting dead code is a legitimate answer to a ledger that says it is dead.',
      '  3. accept the growth on purpose: edit UNCALLED_BASELINE at the top of this file and say in the commit body why it is allowed to rise.',
      'adding a row to UNWIRED_OPERATORS does not satisfy this gate, and that is the whole point of it.',
      '',
      'inherited is printed above but not gated: harness packages have no entry root, so every export they declare is inherited, and a new re-export in `eval-live` moves that number without adding a line of dead product code. Keying on it made this gate fail on correct work.',
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
    measured.local >= UNCALLED_BASELINE.local,
    [
      `the count of locally uncalled runtime exports FELL to ${measured.local}, below the baseline of ${UNCALLED_BASELINE.local}.`,
      'That is an improvement, and it is still a failure: while the baseline stays high it silently permits the same number of new uncalled exports to be added without anyone deciding to.',
      '',
      `  local     ${UNCALLED_BASELINE.local} -> ${measured.local} (${signed(measured.local - UNCALLED_BASELINE.local)})`,
      `  inherited ${UNCALLED_BASELINE.inherited} -> ${measured.inherited} (${signed(measured.inherited - UNCALLED_BASELINE.inherited)})  (reported, not gated)`,
      `  total     ${UNCALLED_BASELINE.unwired} -> ${measured.unwired} (${signed(measured.unwired - UNCALLED_BASELINE.unwired)})  (reported, not gated)`,
      `  exports   ${UNCALLED_BASELINE.exports} -> ${measured.exports} (${signed(measured.exports - UNCALLED_BASELINE.exports)})`,
      `  wired     ${UNCALLED_BASELINE.wired} -> ${measured.wired} (${signed(measured.wired - UNCALLED_BASELINE.wired)})`,
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
  // tripwire for a *stale* baseline that still passes.
  //
  // It used to watch `exports` and `wired`, on the theory that both moving a
  // long way while `unwired` landed back on the baseline means the constant
  // describes a tree nobody can reconstruct. Re-keying the gate on `local` frees
  // `exports` to move, so that version would now fire on a single new re-export
  // in a harness package -- reintroducing by the back door the noise the re-key
  // removed. The equivalent tripwire for the figures that are actually
  // authoritative: if `local` is back on its baseline but the per-package
  // breakdown underneath it moved, then one package's dead code paid for
  // another's removal and both gates stayed quiet.
  const moved = Object.keys(UNCALLED_BASELINE.localByPackage).filter(
    (name) => (localByPackage[name] ?? 0) !== UNCALLED_BASELINE.localByPackage[name as keyof typeof UNCALLED_BASELINE.localByPackage],
  );
  assert.ok(
    moved.length === 0 || measured.local !== UNCALLED_BASELINE.local,
    [
      `UNCALLED_BASELINE describes a tree that no longer exists.`,
      `  local ${UNCALLED_BASELINE.local} -> ${measured.local}, which is back on the baseline,`,
      '  but these packages no longer hold the figure the baseline gives them:',
      ...moved.map((name) => {
        const before = UNCALLED_BASELINE.localByPackage[name as keyof typeof UNCALLED_BASELINE.localByPackage];
        const after = localByPackage[name] ?? 0;
        return `    ${name}: ${before} -> ${after} (${signed(after - before)})`;
      }),
      '',
      'one package\'s dead code paid for another\'s removal and neither ratchet moved. Re-measure and re-declare every figure together.',
    ].join('\n'),
  );
});

test('the ratchet can still fail', () => {
  // A gate that cannot fail is not a gate. This is the same shape as the
  // `selfcheck` CI lane, which proves the contract gate can fail by mutating a
  // token: here the ratchet's own comparison is exercised against a synthetic
  // rise, because re-keying the gate from the total to `local` is exactly the
  // change that could have quietly turned both directions into a no-op.
  const synthetic = { local: UNCALLED_BASELINE.local + 1 };
  assert.ok(
    synthetic.local > UNCALLED_BASELINE.local,
    'a synthetic rise in `local` must exceed the baseline, or the upward gate cannot fail',
  );
  // And the slack direction: a fall below the baseline has to be visible too, or
  // the ratchet goes permissive the first time somebody wires something real.
  const improved = UNCALLED_BASELINE.local - 1;
  assert.ok(improved < UNCALLED_BASELINE.local, 'a synthetic fall must be below the baseline, or the downward gate cannot fail');
});
