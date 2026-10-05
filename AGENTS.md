# AGENTS.md — operational contract for automated contributors

Rules, invariants, and the loop. **Design lives in `docs/`; if this file and `docs/` disagree
about design, `docs/` wins and this file is the bug.**

This file is agent-facing and deliberately terse. For what the product *is*, read `README.md`.

---

## 0. Start here

```bash
npm run status     # board state, contract digest, wiring totals — never in prose
npm run check      # THE gate: typecheck + lint + tests + contract
```

Current numbers are deliberately absent from this file. `npm run status` prints them from the
repo. **If you find a count hardcoded in any doc, that is a defect** — see §11.

### Routing — where to look, and which rules apply

| Your task | Read first | Rules that bind you |
|---|---|---|
| Fix a bug in a package | `docs/architecture.md` §3 (canonical model) | §2 scope, §3 verify, §4 git, §6 forbidden |
| Touch a provider adapter | `docs/architecture.md` §2 | §2, §3, §9 traps |
| Change pipeline stage order | `docs/architecture.md` §4 | **§10 stop — this is a security change** |
| Add an operator / export | `docs/wiring-ledger.md` §7 | §2 (barrels are integrator-owned), §3 |
| Add or change a test | `docs/testing-plan.md` | §3, §6 |
| Work a board task | `docs/tasks.csv` + `docs/development.md` §6 | §5 dispatch, §8 DoD |
| Answer "is X reachable / does X run" | `docs/wiring-ledger.md` §5, §6 | §7 |
| Assess readiness / risk | `docs/maturity.md`, `docs/decisions.md` §1 | — |
| Deploy or operate it | `docs/operations.md` | — |
| Learn from a mistake | `learning.md` | §8.0 |
| Run the live A/B campaign (spends money) | `docs/evaluation.md` §Running it | §3, §8 |

---

## 1. Prime directive: the contract is frozen

`packages/core-types` is frozen. No agent may add, remove, or change its public exports — not
because nothing needs it, but because the freeze is what makes every other package's guarantee
checkable. `npm run contract:check` must stay green.

If you need a new type: **propose it in your report and stop.** The owner unfreezes via
`npm run contract:update` in a deliberate, standalone commit. Do not bundle it with a feature.

---

## 2. Scope — what you may touch

**Default: two files.**

```
packages/<pkg>/src/<task>.ts
packages/<pkg>/test/<task>.test.ts
```

**Never edit unless explicitly told:**

- `packages/core-types/**` — frozen (§1)
- Root config: `tsconfig*.json`, `package.json`, `package-lock.json`, `eslint.config.mjs`
- `packages/<other-pkg>/src/**` or `test/**`
- `packages/<pkg>/src/index.ts` — barrels are integrator-owned; create the module, export at integration
- `docs/tasks.csv` — the board owner sets status
- `.github/workflows/**`

**Fixtures are inline.** Put test fixtures inside your test file. Do not create shared fixture
files.

**No new dependencies.** The workspace deps are fixed. If you genuinely need one, report it.

**No scratch files in the repo.** Use `/tmp`. The gate enumerates `packages/*/test/*.test.ts`
and `scripts/test/*.test.ts` — anything you leave there ships.

---

## 3. Verification — run before you claim done

```bash
npx tsc -p packages/<pkg>/tsconfig.json --noEmit --composite false --incremental false
npx tsc -p tsconfig.check.json --noEmit     # REQUIRED — package configs exclude test/
npx eslint packages/<pkg>/src/<task>.ts packages/<pkg>/test/<task>.ts
node --import tsx --test packages/<pkg>/test/<task>.ts
```

All four clean. **Then** the integrator runs `npm run check`.

TypeScript config lives in `tsconfig.base.json` — read it, don't rely on a copy. Four settings
carry design weight rather than style: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitReturns`, `verbatimModuleSyntax`.

ESLint is type-aware, and three rules are **errors**, not warnings: `no-unsafe-*`,
`no-explicit-any`, `consistent-type-assertions`. Tests, `tools/` and `scripts/` get `no-unsafe-*`
and `no-floating-promises` switched off — they may reach past the type system; production code may
not. `no-console` is off only in those same three places.

`consistent-type-assertions` bans `as` on object literals. That rule is how the narrowing in
`core-types/guards.ts` gets defeated, so a considered assertion is allowed and a reflexive one is
a bug. When you need one, reach for a typed local (`const x: T = {...}`) rather than an assertion.

Two traps that make a green run a lie:

- **`tsx` does not typecheck.** A test can pass and still be a type error. Only
  `tsconfig.check.json` sees it, because `packages/*/tsconfig.json` sets
  `"include": ["src/**/*.ts"]` and is structurally blind to tests. Skipping that second command
  is not verification.
- **`npm test` / `npm run check` is integrator-only** (see §5). Run your own file by exact path.

Report other packages' errors rather than fixing them — they belong to whoever owns those files.

**A green suite that cannot fail is worth nothing.** Every new behaviour needs a test that
fails against the broken implementation. Prove it: revert or stub the fix, watch the test go
red, restore. A test you have never seen fail is a test you have not verified.

**When the output is a report, assert on its fields, not its shape.** "It printed twelve
UNSUPPORTED rows" passes while every model name in it reads `undefined`. Add
`assert.doesNotMatch(out, /undefined/)` against the real code path — that is the assertion that
catches a wrong argument shape, which in plain JS nothing else will.

---

## 4. Git

| Rule | Detail |
|---|---|
| Branch | `main` only |
| Commit style | Conventional: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:` |
| Subject | ≤ 72 chars, imperative mood |
| Body | What + **why**, not how. Reference task IDs (`E-2`, `A-14`). |
| Before push | `npm run check` green |
| Lockfiles | `package.json` and `package-lock.json` change together, in the same commit as the code that needs them |

**Declare what you import.** If you add a cross-package import, add it to that package's
`package.json` dependencies *and* its `tsconfig.json` references in the same commit. An
undeclared import resolves only because npm hoists workspace symlinks to the root
`node_modules`, so it typechecks locally and breaks on a machine that doesn't hoist. This
already happened once — see §9.

---

## 5. Dispatch and parallelism

Applies when more than one agent works the tree. **Single-agent work: ignore this section.**

`docs/tasks.csv` column `exec` has four values:

| `exec` | Meaning | Fan-out |
|---|---|---|
| `seq` | Ordered within its stream; has real predecessors | One agent, in order. Do not parallelise. |
| `par` | Independent of its siblings | Safe to hand to separate agents |
| `ext` | Externally blocked (credential, corpus, real agent surface) | Do not start |
| `agent` | Delegated to a coding agent rather than a human stream | Read the task's notes |

**`seq` is a real constraint, not a label.** Fanning out a `seq` chain buys nothing but a merge
conflict.

Run `npm run status` for which tasks are open and which are `ext`.

### Isolation rules — these exist because they were violated

| # | Failure | Rule |
|---|---------|------|
| **I1** | Agent A runs the full suite, sees agent B's half-written suite fail, and "fixes" B's file or reports a false failure | Run only your own test file, by exact path. Never a glob, never `npm test`. A failure in a file you do not own is **not yours** — report it. |
| **I2** | Agent leaves `tmp-*.test.ts` or probe scripts in a `test/` dir; the gate picks them up and CI breaks permanently | No scratch files in the repo. Use `/tmp`. |
| **I3** | Agent edits a shared file (`runner.ts`, a barrel, `docs/tasks.csv`) to unblock itself — silent behaviour change or merge conflict | Touch only your files. Report the required shared change precisely. |
| **I4** | Five agents each run `tsc --build` / `npm run check`, serialising on shared `.tsbuildinfo` | Root commands are integrator-only. |

**A cancelled agent leaves a broken tree, not an empty one.** If asked to finish partial work:
run the checks first to see the real damage, repair in place, and expect the breakage to be
subtler than "file missing". Half-written import lists and a test that *hangs* rather than fails
cost the most time.

### Integration is the integrator's job, at the end

Agents produce files. They do not integrate and do not declare the batch done.

1. Delete stray scratch files (`git status`).
2. Add barrels. **Verify export-name collisions mechanically before re-exporting.**
3. Wire new packages into `tsconfig.json`; confirm declared dependencies match actual imports.
4. Run what agents were forbidden to run: `npm run check`.
5. **Exercise the negative gates** — drive each gate to its failing state and confirm it reports.
   A gate with no failure mode is not a gate.
6. Only then update `docs/tasks.csv`, and ask before committing.

---

## 6. Forbidden patterns

| Pattern | Reason |
|--------|--------|
| `import from '../other-package/src/...'` | Cross-package coupling. Go through `core-types`, or wait |
| `any` in production code | Defeats the unrepresentability guarantee the product rests on |
| `eslint-disable` in production code | Hides real issues |
| `npm install` | Dependency drift. Report the need |
| Editing root `tsconfig.json` / `package.json` | Shared state |
| Buffering streaming SSE | Violates N3 — first-token delta must be unaffected |
| Logging auth headers | Violates N4/R7. Route every header name through `isSensitiveHeader()`, never a local list |
| Restating a derivable number in a doc | See §11 |
| Reading a digest/count from prose | Run `npm run status` |

---

## 7. Architecture — only what you must not violate

Full topology: `docs/architecture.md`. Two things here because they look like accidents:

**Pipeline order is a safety property, not a preference.** `docs/architecture.md` §4 justifies
it pair by pair. Two bite hardest: `truncate` before `compact` (don't spend a lossy stage on a
block you could have deleted free), and `pin` *after* triage and *around* compaction — the reason
governance cannot be summarized away. **Reordering is a security change** (§10).

**Three cross-stream imports exist, all deliberate:** `integrations → security`,
`integrations → telemetry`, `gist → telemetry`. Agent hooks are where untrusted text and
credential headers actually arrive, so that path must redact and be measurable. Eviction is the
only destructive operation, so it must be countable on every path where a transcript is *not*
deleted. Adding a fourth needs the owner.

`eval` depends on nothing and **mirrors** `ConstraintKind` rather than importing it, with a test
asserting the package opens no sockets. The measuring apparatus must not drift with the thing it
measures. If you "clean up" that duplication into a real import, you have broken the experiment.

---

## 8. Definition of Done

0. **Did this surprise you?** If a task taught you something the repo did not already say, append
   it to `learning.md` — what went wrong, why it was not obvious, and the rule that now prevents
   it — and promote any durable rule into this file in the same commit. A rule learned and not
   written down is a bug that ships twice.
1. Unit tests in the task's own package, **≥1 negative test** per operator. A lossy operator with
   no negative test is a bug factory.
2. Determinism: same input ⇒ byte-identical output for Tiers 0–2.
3. Emits telemetry per `docs/architecture.md` §8. If a stage can't be measured, it isn't done.
4. Fail-open: a thrown error produces unmodified passthrough.
5. Non-obvious constants cite a source or carry `TODO(owner)`. No folklore.
6. Every new test has been seen to fail against the broken code (§3).
7. Governance-touching code additionally: a type-level or property proof that the operation is
   *unrepresentable* on governance blocks.

---

## 9. Traps this repo has already paid for

Both found by verification, not review. Cheap to avoid now they're written down.

- **An alias table is part of the public surface.** The MCP server registers short names
  (`get_task`) and resolves `ctx_`-prefixed spellings through `TOOL_ALIASES` inside `callTool`.
  Comparing the *advertised* name to the *registered* name reports all six tools as unserveable —
  a permanent false advisory, and a gate that cries wolf gets muted. Assert against the
  *resolved* value.
- **`PROVIDERS` means two different things.** `gateway/src/config.ts` = routable upstreams;
  `gateway/src/credentials.ts` = key-holding providers. `index.ts` re-exports the config one as
  `CONFIG_PROVIDERS` for this reason. Do not star-export both.
- **`SELF_GIST_DIRECTIVE` is two exports, not one shared constant.** `pipeline/src/self-gist.ts`
  exports the parser's sentinels; `integrations/src/templates.ts` exports a prompt string. They
  are not byte-identical and must not be made so. The real invariant: fence and sentinel must
  agree, or the parser never fires.
- **Use `isSensitiveHeader()`, don't re-derive it.** It wraps an explicit name list *plus* a
  private substring list. The patterns are not exported, and re-deriving them is how a header
  leaks.
- **`packages/<pkg>/tsconfig.json` excludes `test/`.** See §3.
- **Undeclared workspace imports typecheck.** See §4.
- **Line-number citations rot.** See §11.

---

## 10. Stop and report — do not work around

- A test that cannot pass without `any` or `eslint-disable` in production code.
- A need to change `core-types` exports (§1).
- A cross-stream import that cannot go through `core-types` (§7 — three exist; ask before a
  fourth).
- A governance block that reaches a lossy stage (type error or property-test failure).
- A need to reorder the pipeline (§7).

**Stop. Report the blocker.** Do not route around it.

---

## 11. How to write docs in this repo

The failure mode this repo has is *silent rot*: a fact that a command can compute gets written
into prose, and prose does not update when the code does. A stale number in a doc is worse than
no number, because an agent reads it as current and reasons from it. All four of these were
real, and every one survived review:

- A "known defect: `packages/telemetry` is not in git" section lived in **two** docs, with
  `git ls-files | wc -l` → `0` written in both. The real answer was 19, and the `.gitignore`
  rule had been anchored months earlier.
- `AGENTS.md` told agents to pick up six task IDs. All were finished.
- The test-count sample in the quickstart was ~240 tests behind.
- A "maturity" doc carried 58 line-number citations into other docs; several resolved to blank
  lines and code fences.

Rules that follow:

1. **If a command can produce it, no doc may state it.** Print it (`npm run status`), or pin it in
   a test that fails when it drifts. Tests are better than prose — they cannot rot silently.
2. **Cite sections, not line numbers.** `docs/architecture.md §4` survives an edit. `:218` does not.
3. **Fix the table, don't silently diverge.** If reality differs from a doc, the doc is the bug.
   Repair it in a docs commit.
4. **Keep one copy.** Three copies of the package tree means two are wrong.
5. **A doc that describes a finished plan is history.** Label it, so no one executes it.

When you change a rule, change this file **in the same commit**.