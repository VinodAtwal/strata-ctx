# Documentation rework plan

**Status:** planning, transient. Archive or delete when the rows below are done.
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
| ARCH-2 | Medium | `gist` (2,337 lines) has **no dependents** in the graph; its only consumer path is the unbuilt C-16 wiring | resolve C-16, or mark the package explicitly "built, not wired" in one place | M |
| ARCH-3 | Medium | God files: `eval` suites (3,900/3,500/3,000 lines), `telemetry/status.ts` (1,834), `integrations/surface-check.ts` (1,960), `gateway/server.ts` (1,476) | targeted extraction **on touch**; do not mass-split (a working monolith beats a broken set of small files) | L |
| ARCH-4 | Low | `gist` barrel exposes 2 of 7 modules; the other 5 are unreachable from the package surface | decide the intended surface; export or document why not | S |
| ARCH-5 | Low | Version-spec inconsistency: `security` referenced as `file:../security` (gateway, gist) and `"0.1.0"` (cli, integrations) | standardise on `file:` workspace refs | S |

No package merges or splits are recommended. The graph is already a DAG with a
single sink; splitting further would add edges without buying a boundary.

## 5. Task list

Ordered by leverage. `D-*` are docs; `A-*` are code. Effort: S ≤ 1h, M ≤ 1d, L > 1d.

| ID | Task | Home touched | Effort | Depends |
|---|---|---|---|---|
| **A-1** | Declare `integrations → telemetry` in `package.json` (ARCH-1) | `packages/integrations/package.json` | S | — |
| **D-1** | Fix `CHANGELOG.md`: 114 exports / old digest → point at `npm run status`; fix dangling `AGENTS.md §12.1` | `CHANGELOG.md` | S | — |
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
