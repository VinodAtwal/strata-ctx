# Documentation rework plan

**Status:** docs rows **D-1–D-17 done** (D-13 verified: the target docs already carry
history labels). **ARCH-1/2/4/5 done; ARCH-3 deferred** with its extraction seams written
down in §4.1. Open: **D-18** (board owner). Transient — archive or delete when D-18 lands.
**Owner:** the repo owner (this touches `docs/tasks.csv`, which AGENTS.md §2 reserves).

This plan was produced by applying the `documentation-writing`, `software-architecture`,
and `typescript-low-level-design` skills to the repository, plus a mechanical
inventory of all 23 docs and the package dependency graph.

---

## 1. Verdict

**The code architecture is sound and needs no restructuring.** The package graph is
a strict one-way DAG: no cycles, no mutual edges, `core-types` the sole foundation.
The freeze and the wiring gates are doing their job.

**The documentation is where restructuring is required.** The repo has a
first-class rule for this (AGENTS.md §11) and the docs do not follow it: the same
facts live in three to six files, numbers a command computes are written into
prose, ~50 citations point at line numbers, several cross-references point at
sections that no longer exist, and the anchor document's topology predates eight
of the fourteen packages.

The work is therefore a **normalisation pass**, not a rewrite from scratch: the
prose is good; the duplication, the stale numbers, the line-number pointers, and
the false topology are what have to go.

## 2. Target doc architecture (four kinds)

| Kind | Reader's job | Lives at |
|---|---|---|
| **Explanation** | build a mental model | `README.md`, `how-it-works.md`, `architecture.md` |
| **Task** | do a procedure | `quickstart.md`, `operations.md`, `corpus.md` (process) |
| **Reference** | look up an exact fact | `spec.md`, `integrations.md`, `wiring-ledger.md`, `evaluation.md§5`, `risk-analysis.md` |
| **Decision** | understand a choice + when to revisit | `decisions.md`, `market.md`, `maturity.md`, `visibility.md` |

## 3. Fact-ownership map — one home per fact

Everything else **links**, never restates. This is the core of the rework.

| Fact | Single home | Today duplicated in |
|---|---|---|
| Package list & topology | `architecture.md §2` | README, development, spec |
| Pipeline order + why | `architecture.md §4` | README, AGENTS §7, spec |
| Canonical model | `architecture.md §3` | spec |
| Gate definitions G1–G12 | `evaluation.md §5` | README, spec §5 |
| Suite inventory E1–E6 | `evaluation.md` Part 2 | testing-plan |
| Config YAML | `integrations.md §8` | README (byte-identical copy) |
| Wiring counts / digest / board | computed — `npm run status` | wiring-ledger §4, maturity §2, README, CHANGELOG |
| Contract exports + digest | `packages/core-types/contract.lock.json`, `npm run status` | CHANGELOG, README |
| Event types | `packages/core-types/src/telemetry.ts` (frozen union, 10) and `packages/telemetry/src/events.ts` (`STRATA_EVENT_TYPES`, 13) | README, maturity, visibility ("13") |
| Research figures | `spec.md §1` | README, market, how-it-works, risk-analysis |
| ADRs + risk register | `decisions.md` | risk-analysis, development |
| Board | `docs/tasks.csv` | README, operations, testing-plan |

**Note on the event count.** The two sets differ and always have: the frozen
`TelemetryEvent` union has 10 members; `STRATA_EVENT_TYPES` has 13 (three are
accepted-but-unfrozen proposals: `gist`, `savings`, `consolidation`). "13 event
types" is therefore true of one set and false of the other. No doc should state a
count; it should name the source.

## 4. Code findings (not docs) — for the board owner

| ID | Severity | Finding | Fix | Effort |
|---|---|---|---|---|
| ARCH-1 | High | `integrations` imports `@strata-ctx/telemetry` in 5 files but does not declare it in `package.json`; a clean install of declared deps breaks | add `"@strata-ctx/telemetry": "file:../telemetry"` to `integrations/package.json` deps | S |
| ARCH-2 | Done | `gist` has **no dependents** in the graph; its only consumer path is the unbuilt C-16 wiring | marked built-not-wired in `packages/gist/src/index.ts`, pointing at the one docs home (`maturity.md` §3.1) | — |
| ARCH-3 | Deferred | God files: `eval` suites (3,987/3,528/3,011 lines), `telemetry/status.ts` (1,834), `integrations/surface-check.ts` (1,960), `gateway/server.ts` (1,476) | targeted extraction **on touch**; do not mass-split. Seams are written down in §4.1 so the next person taking one does not have to re-derive it | L |
| ARCH-4 | Done | `gist` barrel exposed 2 of 6 modules; the rest unreachable from the package surface | documented the intended surface and why `assembly`/`tiers`/`dreaming` stay unexported (Gate-4 ratchet), in `packages/gist/src/index.ts` | — |
| ARCH-5 | Resolved | Version-spec "inconsistency" for `security`: `file:../security` (gateway, gist) vs `"0.1.0"` (cli, integrations). Not drift — `docs/operations.md` §1 declares the `file:` forms in gateway/gist **correct** and directs new packages to version ranges, so both are the documented decision. No code change; the plan's proposed "standardise on `file:`" would have contradicted the doc home. | none | — |

No package merges or splits are recommended. The graph is already a DAG with a
single sink; splitting further would add edges without buying a boundary.

### 4.1 ARCH-3 handoff — extraction seams (deferred; take one on touch)

Do **not** mass-split. When one of these files is next changed for a reason that
already justifies opening it, take the one seam adjacent to that change. Every seam
moves a **cohesive, exported unit** into a sibling module and re-exports it from
the original file, so no consumer's import path changes and the Gate-4 ratchet
baseline (`packages/testing/test/wiring-ratchet.test.ts`) does not move. Positions
are given as symbols, not line numbers, so they survive edits.

**`packages/telemetry/src/status.ts`** — three seams, safest first:
- **Types.** The `StatusReport` interface and every summary sub-interface
  (`BudgetSummary`, `CompactionSummary`, `SavingsSummary`, `StageSummary`,
  `RunSummary`, `ErrorSummary`, …) → `status-types.ts`. Declarations only.
- **Format.** `formatStatus`, `RUN_OUTCOME_LINE`, `stageList`, `countMap` →
  `status-format.ts`. Pure string assembly over a finished `StatusReport`.
- **CLI.** `parseStatusArgs`, `runStatusCli`, `USAGE`, `EXIT_*`, `StatusIo`,
  `DEFAULT_STATUS_PATH` → `status-cli.ts`. The process boundary, separable from
  aggregation.
- **Stays:** `buildStatus` / `buildStatusFromLog` — the aggregation is the core.

**`packages/integrations/src/surface-check.ts`** — four seams:
- **Types.** `AgentSurface`, `McpSurface`, `SurfaceSnapshot`,
  `SurfaceFinding`, … → `surface-types.ts`.
- **Derivation.** `deriveClaudeCode`, `deriveGemini`, `deriveOpenCode`,
  `deriveOpenAiCompatibleAgent`, `deriveCopilot`, `deriveAgent`, `deriveMcp`,
  `deriveSelfGist`, `deriveSurfaces` → `surface-derive.ts`.
- **Snapshot read.** `readAgentSurface`, `readObservation`, `readSettings`,
  `validateSnapshot`, plus the `read*` scalar helpers → `surface-snapshot.ts`.
- **Diff / render / CLI.** `checkSurface`, the `compare*` helpers,
  `renderFinding(s)`, `renderResult`, `runCli` → `surface-report.ts`.
- **Constraint:** the package reaches all of it through
  `integrations/src/index.ts`'s `export * from './surface-check.js'`, so
  `surface-check.ts` must keep re-exporting whatever moves.

**`packages/gateway/src/server.ts`** — the session/persistence layer is the bulk:
- **Types.** `GatewayOptions`, `Session`, `GatewayRuntime` → `server-types.ts`.
- **Attribution.** `NO_RUN`, `NO_STAGE`, `LIFECYCLE`, `REMEDY`, and the `fail()`
  surface → `attribution.ts` (this is the P0-1 surface; keep it one place).
- **Sessions.** The session store, the drain path, and `persistPending` →
  `sessions.ts`. `persistPending` is exported today, so it must be re-exported.
- **Stays:** `createGateway` — the composition root.

**`packages/eval/src/suites/*`** — the size is inline *data*, not logic:
- **Corpus.** The frozen corpora (`E3_CORPUS`, `E3_REFUSAL_CORPUS`,
  `E6_SECRET_CORPUS`, `E6_BENIGN_CORPUS`, the E2 record builders, …) → a per-suite
  `corpus.ts`; the calibration/dimension constants → a per-suite `constants.ts`.
- **Stays:** the suite logic (`run*`, grading, report) in the suite file.
- **Constraint:** `eval/src/index.ts` does one `export * from './suites/eN-*.js'`
  per suite, and the suites are deliberately siloed (one owner per file). Re-export
  the moved symbols so those paths are unchanged, and do **not** introduce
  cross-suite imports — that would couple experiments the design keeps separate.

## 5. Task list

Ordered by leverage. `D-*` are docs; `A-*` are code. Effort: S ≤ 1h, M ≤ 1d, L > 1d.

| ID | Task | Home touched | Effort | Depends |
|---|---|---|---|---|
| **A-1** | Declare `integrations → telemetry` in `package.json` (ARCH-1) | `packages/integrations/package.json` | S | — |
| **D-1** | Fix `CHANGELOG.md`: 114 exports / old digest → point at `npm run status`; fix a dangling `§12.1` pointer | `CHANGELOG.md` | S | — |
| **D-2** | Fix dangling `AGENTS.md` refs (`§12`, `§12.1`, `§14`, `§6.2`, `§6.4`, `§7.1`) → §3/§5/§2 as appropriate | `README.md`, `quickstart.md`, `wiring-ledger.md`, `CHANGELOG.md` | S | — |
| **D-3** | Fix `decisions.md` duplicate `Q6`; renumber | `docs/decisions.md` | S | — |
| **D-4** | Dedupe G1–G12 gate table → keep `evaluation.md §5`; README/spec link | `README.md`, `spec.md` | M | — |
| **D-5** | Dedupe config YAML → keep `integrations.md §8`; README links | `README.md` | S | — |
| **D-6** | Rewrite `architecture.md §2` topology + package tree (14 pkgs, no `plugins/`, correct names, correct dependency claim) | `docs/architecture.md` | M | — |
| **D-7** | Replace `wiring-ledger.md §4` hardcoded inventory with `npm run status` pointer; keep the gate explanations | `docs/wiring-ledger.md` | M | — |
| **D-8** | Replace ~30 `file.ts:NN` citations in `wiring-ledger.md` with symbol/section refs | `docs/wiring-ledger.md` | M | D-7 |
| **D-9** | Replace ~14 `file.ts:NN` citations in `risk-analysis.md`; fix `§3.13`; label P0-* history | `docs/risk-analysis.md` | M | — |
| **D-10** | Replace 4 `file.ts:NN` citations in `operations.md` | `docs/operations.md` | S | — |
| **D-11** | Remove duplicated research figures from README/market/how-it-works → `spec.md §1` | `README.md`, `market.md`, `how-it-works.md` | M | — |
| **D-12** | Remove "13 event types" hardcodes; name the source instead | `README.md`, `maturity.md`, `visibility.md` | S | — |
| **D-13** | Label historical docs/parts: `testing-plan.md`, `operations.md`, `corpus.md`, `quickstart §9–11`, `evaluation §5`, `maturity §3`, `risk-analysis` P0-* | 6 files | M | — |
| **D-14** | Dedupe "internal-only" distribution → `operations.md`; quickstart links | `quickstart.md` | S | — |
| **D-15** | Dedupe capability/status lists → one home (proposed: `maturity.md`); wiring-ledger & README link | `README.md`, `wiring-ledger.md` | M | D-7 |
| **D-16** | README pass: fix npm-scripts table (contradicted by `package.json`), remove "13/200", make it an Explanation doc that links | `README.md` | L | D-4,D-5,D-11,D-12 |
| **D-17** | Add an enforcer: a test that fails when a doc states a computable number or a `file.ts:NN` citation (a convention with no enforcer dies) | `scripts/test/` | M | D-7,D-8 |
| **D-18** | Fix `tasks.csv` duplicate `C-5` (board owner only) | `docs/tasks.csv` | S | — |

## 6. Rules this plan applies (from the skills)

- If a command can produce a fact, no doc states it — print it or pin it in a test.
- Cite sections and symbols, never line numbers.
- One copy of every fact; link, do not duplicate.
- Label history so it is not executed.
- Structural changes are destructive: verify, and prefer a working whole over
  pristine parts.
