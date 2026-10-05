#!/usr/bin/env node
/**
 * `npm run status` — the facts that change every commit, printed from the repo.
 *
 * Why this exists: every one of these numbers used to be written into prose, and
 * prose does not update when the code does. A stale count in a doc is worse than
 * no count, because an agent reads it as current and reasons from it. So the rule
 * this script enforces by existing is: if a command can produce it, no document
 * may state it.
 *
 * Read-only. Touches nothing, writes nothing.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

/* ---------------------------------------------------------------- contract */

function contract() {
  const lock = JSON.parse(read('packages/core-types/contract.lock.json'));
  const digest = lock.digest ?? '(none)';
  return {
    frozenVersion: lock.frozenVersion ?? lock.version,
    exports: lock.exports?.length ?? lock.exports ?? 0,
    digest: digest.slice(0, 16),
  };
}

/* ------------------------------------------------------------------- board */

/**
 * Quote-aware split. The `gate` column legitimately holds `"G1,G2"`, so a naive
 * comma split misreads those rows. Mirrors `splitCsvRow` in packages/eval/src/corpus.ts
 * — deliberately duplicated rather than imported, so this script needs no build.
 */
function splitCsvRow(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { quoted = false; }
      } else { cur += ch; }
    } else if (ch === '"') { quoted = true; }
    else if (ch === ',') { out.push(cur); cur = ''; }
    else { cur += ch; }
  }
  out.push(cur);
  return out;
}

function board() {
  const lines = read('docs/tasks.csv').split(/\r?\n/).filter((l) => l.trim());
  const header = splitCsvRow(lines[0]);
  const iId = header.indexOf('id');
  const iTitle = header.indexOf('title');
  const iStatus = header.indexOf('status');
  const iExec = header.indexOf('exec');
  const rows = lines.slice(1).map((l) => splitCsvRow(l));

  const byStatus = {};
  for (const r of rows) byStatus[r[iStatus]] = (byStatus[r[iStatus]] ?? 0) + 1;

  const open = rows
    .filter((r) => r[iStatus] !== 'done')
    .map((r) => ({ id: r[iId], title: r[iTitle], exec: r[iExec] }));

  return { total: rows.length, byStatus, open };
}

/* ------------------------------------------------------------------ wiring */

function wiring() {
  // ~3s. Delegated to the existing scanner rather than re-implemented here.
  let out;
  try {
    out = execFileSync('node', ['--import', 'tsx', 'scripts/wiring-inventory.ts'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  const num = (label) => {
    // Labels may be indented and carry trailing commentary, e.g.
    // "  inherited         565   (declaring package unreachable)".
    // Requiring digits right after the label keeps "unwired by package:" from
    // matching "unwired".
    const m = out.match(new RegExp(`^\\s*${label}\\s+(\\d+)`, 'm'));
    return m ? Number(m[1]) : null;
  };
  return {
    filesScanned: num('files scanned'),
    filesReachable: num('files reachable'),
    exports: num('runtime exports'),
    wired: num('wired'),
    unwired: num('unwired'),
    inherited: num('inherited'),
    local: num('local'),
    scanDigest: (out.match(/^digest\s+([0-9a-f]+)/m) ?? [])[1] ?? null,
  };
}

/* ------------------------------------------------------------------ output */

const c = contract();
const b = board();
const w = wiring();

const done = b.byStatus.done ?? 0;
const openCount = b.total - done;
const pct = b.total === 0 ? '0' : ((done / b.total) * 100).toFixed(1);

console.log(`\n  strata-ctx status  ${new Date().toISOString().slice(0, 10)}\n`);

console.log(`  contract   core-types@${c.frozenVersion}  FROZEN`);
console.log(`             ${c.exports} exports · digest ${c.digest}`);
console.log(`             change only via: npm run contract:update  (deliberate, own commit)\n`);

console.log(`  board      ${done}/${b.total} done (${pct}%) · ${openCount} open`);
if (openCount > 0) {
  for (const t of b.open) {
    console.log(`               ${t.id.padEnd(6)} [${(t.exec ?? '?').padEnd(5)}] ${t.title}`);
  }
} else {
  console.log('               (none)');
}
console.log('');

if (w) {
  console.log(`  wiring     ${w.wired}/${w.exports} runtime exports wired`);
  console.log(`             ${w.unwired} unwired (${w.inherited} inherited, ${w.local} local)`);
  console.log(`             ${w.filesReachable}/${w.filesScanned} files reachable · scan digest ${w.scanDigest}`);
  console.log('             detail: docs/wiring-ledger.md\n');
} else {
  console.log(`  wiring     scanner unavailable (run: node --import tsx scripts/wiring-inventory.ts)\n`);
}

console.log(`  gate       npm run check      typecheck + lint + tests + contract`);
console.log('             npm test           test gate alone');
console.log('             npm run contract:check\n');

console.log(`  Agent rules: AGENTS.md §1 (contract) §5 (git) §6 (workflow) §9 (forbidden)`);
console.log('');