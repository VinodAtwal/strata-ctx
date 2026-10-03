# Quickstart

From a fresh clone to a running gateway and a green gate. Written for an internal
developer who has never seen this repository.

If you are looking for the *rules* rather than the commands, they are in
`AGENTS.md`. If you are looking for why the packaging is shaped the way it is,
that is `docs/operations.md`.

---

## 1. What this repository is

`strata-ctx` is a context firewall for coding agents. An agent (Claude Code, Gemini
CLI, Aider, OpenCode, ...) points its base URL at a local gateway; the gateway runs
the request through a fixed pipeline of compression operators, keeps a pin buffer so
governance constraints cannot be compacted away, writes the rest to a gist store, and
streams the response back byte-for-byte without buffering it.

The canonical data model lives in one frozen package, `packages/core-types`
(`@strata-ctx/core-types`, version `1.0.0`). Every other package compiles against it.
Its public surface is hash-locked in `packages/core-types/contract.lock.json`, and CI
fails on any drift. **You cannot add, remove, or change a public export of
`core-types` without the contract owner's decision.** See `AGENTS.md` §1.

## 2. Distribution: internal-only, and that is deliberate

**These packages are never published to a public registry.** There is no
`npm install @strata-ctx/gateway` for anyone, anywhere, ever.

Two properties of every `packages/*/package.json` are load-bearing and must not be
"cleaned up":

| Property | Status | Why it must stay |
| --- | --- | --- |
| `"private": true` | intentional, all 14 packages | This is the only thing that makes an accidental `npm publish` **fail**. Under internal-only distribution there is no registry to publish to, so a private package and a deleted package are equivalent in distribution terms; `private: true` is strictly better because it is the enforcement mechanism. Removing it re-opens a permanent, effectively-irreversible risk: an npm name, once claimed, cannot be given back. |
| `"@strata-ctx/security": "file:../security"` (in `gateway` and `gist`) | intentional | `npm publish` copies a `file:` spec verbatim, producing a manifest no consumer could resolve. That is a reason the spec is *wrong for publishing*, not a reason to change it: these packages are never published. For an internal-only tree the `file:` spec is correct, and it is load-bearing locally — it is what makes the workspace resolve `@strata-ctx/security` to `packages/security` on disk. Rewriting it to a semver range would break local resolution in exchange for a property this repository explicitly does not want. |

The consequence worth internalising: **there is no registry to fall back on, so the
`file:` graph and the npm workspace *are* the distribution.** `npm ci` is not a
convenience step; it is the thing that constructs the product. Section 10 covers what
that costs you.

## 3. Prerequisites

| Requirement | Version | Note |
| --- | --- | --- |
| Node.js | `>= 20.11` | Declared in the root `package.json` `engines.node`. |
| npm | 10.x | Ships with Node 20. The workspace and `npm ci` behaviour this repo relies on is npm 10. |
| Git | any recent | The only distribution mechanism there is. |

**Develop locally on Node 20.19 to match CI.** `engines.node` promises `>= 20.11`, but
`.github/workflows/ci.yml` pins `20.19`, and the two are not interchangeable for the
test runner. The upstream hang fix this repo would otherwise rely on,
`node --test --test-force-exit`, does not exist on Node 20.12.1 — it fails with
`node: bad option`, exit 9. A flag-only fix would therefore be green on one supported
version and a hard error on another. That is why `scripts/run-tests.mjs` is a
hand-written gate rather than a flag invocation, and why the version bound has to live
in this repository. Development on 20.12.1 works (this document was verified on
20.12.1), but if you see runner behaviour that disagrees with CI, check your Node
version before you debug the code.

You do not need an API key, a model provider account, or network access for anything
in sections 3 to 7. Section 8 runs entirely against a local mock upstream.

## 4. Clone and install

```bash
git clone https://github.com/VinodAtwal/strata-ctx.git
cd strata-ctx
npm ci
```

Use `npm ci`, not `npm install`. `npm ci` installs exactly what `package-lock.json`
pins and fails if the lockfile and the manifests disagree. `npm install` is free to
update the lockfile, which means a "fix my install" habit can silently change the
dependency tree under you.

Expected output:

```
added 139 packages, and audited 154 packages in 22s
```

What that command actually did, and why it matters: it created one symlink per
workspace package under `node_modules/@strata-ctx/`, pointing back into
`packages/`. After a successful install:

```bash
ls -l node_modules/@strata-ctx/
```

```
canary -> ../../packages/canary
cli -> ../../packages/cli
core-types -> ../../packages/core-types
...
telemetry -> ../../packages/telemetry
testing -> ../../packages/testing
```

Those symlinks are the entire internal dependency graph. There is nothing else. If a
package is missing from that listing, no amount of rebuilding will make it resolve;
re-run `npm ci`.

## 5. Build

```bash
npm run build     # tsc --build
```

This is a TypeScript project-references build. It compiles each package in dependency
order and writes `dist/` (both `.js` and `.d.ts`) inside every package. `dist/` is
gitignored; it is a build artifact, not a source of truth.

Verify the build worked:

```bash
ls packages/core-types/dist/index.d.ts
```

Cross-package type resolution depends on those emitted `.d.ts` files. A package
whose `dist/` is missing is invisible to every other package.

## 6. The gate

`npm run check` is the whole gate, and it is the same thing CI runs:

```bash
npm run check
```

which is `npm run typecheck && npm run lint && npm run test && npm run contract:check`.

Four lanes, each proving something different. `ci.yml` runs them as separate jobs so a
fast failure is not waiting behind a slow one:

| Lane | Command | Proves |
| --- | --- | --- |
| typecheck | `npm run typecheck` | `tsc --build` **and** `tsc -p tsconfig.check.json`. The second half is not optional: `packages/*/tsconfig.json` sets `"include": ["src/**/*.ts"]`, so a project build is structurally blind to `test/`. `tsconfig.check.json` is the only thing that typechecks tests, tools, and scripts. |
| tests | `npm run test` | `node scripts/run-tests.mjs`, which enumerates the suite itself, refuses to report a pass on an empty suite, pins the TAP reporter, enforces a wall-clock deadline, and refuses to run inside a `node --test` process. |
| contract | `npm run contract:check` | The `core-types` public surface still matches `contract.lock.json`. |
| lint | `npm run lint` | `eslint .`, type-aware. The enforcement point for the rules in `AGENTS.md` §3: `no-unsafe-*`, `no-explicit-any`, and `consistent-type-assertions` are errors, not warnings. |

There is a fifth lane, `selfcheck`, which is not part of `npm run check` because it
mutates the tree on purpose: it appends an export to
`packages/core-types/src/tokens.ts`, asserts `contract:check` **fails**, then reverts
and asserts it passes again. A gate that cannot fail is not a gate. If you change
anything in `core-types` or in `scripts/check-contract.mjs`, run that lane locally.

Reference numbers at commit `ba9b67f`, Node 20.12.1, macOS:

```
# tests 3641
# suites 570
# pass 3640
# fail 0
# skipped 1
contract unchanged: 120 exports, digest 4dda325007f5f2e3, frozen at 1.0.0
```

### Integration: the checks you should not run mid-development

`AGENTS.md` §7.2 is the integrator's sequence, at the end of a batch of work, not the
per-edit loop:

1. `git status` for stray scratch files, and delete them.
2. Add barrel exports, after checking for name collisions mechanically.
3. Wire new packages into `tsconfig.json`; confirm each package's declared
   dependencies match its actual imports exactly.
4. `npm run check` — the four lanes above.
5. Drive each gate to its failing state and confirm it reports the failure.
6. Only then update `docs/tasks.csv`.

## 7. Running one package's tests

**Run your own test file, by exact path.** This is not a style preference; see below.

```bash
node scripts/run-tests.mjs packages/security/test/acl.test.ts
```

That is the gate scoped to one file: same enumeration, same TAP pinning, same
deadline, same exit-code propagation. It is the form to prefer, because it keeps the
protections while narrowing the scope.

The lighter form, which is what `AGENTS.md` §6.4 specifies for verification, skips the
gate entirely:

```bash
node --import tsx --test packages/security/test/acl.test.ts
```

Either is correct. What is not correct is a glob or the whole suite, for reasons that
have already cost this repository time (`AGENTS.md` §7.1, rules I1 and I2):

| Do not | Why |
| --- | --- |
| `npm test`, `npm run check`, or `node scripts/run-tests.mjs` with no arguments | The gate enumerates **every** suite in the workspace, including files other people are mid-edit on. You will see their half-written work fail. The tempting response — editing their file, or reporting a false failure — is exactly failure mode I1. A failure in a file you do not own is not yours: report it, do not touch it. |
| `node --test packages/*/test/*.test.ts` | A shell glob that matches nothing produces `# tests 0 / # fail 0` and exit 0: a silent green run that tested nothing. A typo in the path is indistinguishable from success. |
| Leaving `tmp-*.test.ts`, `scratch-*.ts`, or any probe script in a `test/` directory | The gate enumerates `packages/*/test/*.test.ts` and `scripts/test/*.test.ts`. Anything you leave there is picked up and **ships**. Put scratch work in `/tmp`. |

One consequence of the runner's design that surprises people: `npm test` from inside a
`node --test` process discovers nothing and exits 0, because `NODE_TEST_CONTEXT` is
exported into every test process. The gate refuses to start if that variable is set,
rather than reporting a green that ran zero tests. If a test of yours shells out to
`npm test`, it will get a refusal, not a result.

Useful flags and variables:

```bash
node scripts/run-tests.mjs --list          # print the 104 file paths the gate would run, then exit
STRATA_TEST_TIMEOUT_MS=60000 npm run test  # raise the deadline if a slow machine trips it
STRATA_TEST_REPORTER=spec npm run test     # human-readable output instead of TAP
```

To see what the gate will run before you run it, `--list` is cheaper than a run.

### Verification before you call a task done

`AGENTS.md` §6.4, which is the minimum, not the whole job:

```bash
npx tsc -p packages/<pkg>/tsconfig.json --noEmit --composite false --incremental false
npx tsc -p tsconfig.check.json --noEmit
npx eslint packages/<pkg>/src/<task>.ts packages/<pkg>/test/<task>.ts
node scripts/run-tests.mjs packages/<pkg>/test/<task>.test.ts
```

All four must be clean. `tsx` transpiles without typechecking, so a test that runs
green can still be a type error, and the second command is the only one that sees it.
Three such errors reached the integrator on the first pass of a five-agent dispatch.

## 8. Running it

### The whole request path, no API key and no network

```bash
npm run dev
```

This starts a mock upstream on `http://127.0.0.1:8799` and the gateway on
`http://127.0.0.1:8787`, then immediately sends itself one request and prints a smoke
result:

```
strata-ctx dev

  gateway   http://127.0.0.1:8787   (POST /v1/messages, GET /strata/status)
  mock      http://127.0.0.1:8799
  pinned    2 constraints

  export ANTHROPIC_BASE_URL=http://127.0.0.1:8787

  [telemetry] request_in
  [telemetry] pin constraints=2 missingBefore=0
  [telemetry] stage
  ...
  smoke: pinned constraints intact at the provider = true
  smoke: upstream received 1 request(s), 410 bytes
```

The demo policy pins two constraints on purpose, one hard safety rule and one soft
organisational policy, because that split is where compaction does its damage. The
`smoke:` line is the assertion that matters: it fails the process with a non-zero exit
if a constraint did not survive the round trip. To route a real agent through it:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
```

### The CLI

`packages/cli` declares a real `bin`, so it works from a user's project where there is
no `tsx`, no workspace, and none of this repository's `node_modules`:

```bash
node packages/cli/dist/index.js --help
```

Its own dependencies are imported dynamically (`await import(...)`) rather than at the
top level, precisely so the module loads with none of them present; there is a test
asserting no top-level import crept back in. Build first — `node_modules` and `dist`
are both build-time state.

| Subcommand | What it does |
| --- | --- |
| `hook --agent <opencode\|claude-code\|gemini-cli>` | Wire governance into a host agent. `--check` exits 0 if governance is live, 1 if not; `--dry-run` prints what would change and writes nothing. |
| `hook run --event <pre-tool-use\|post-tool-use>` | Read a host hook payload on stdin, act on it, print JSON. This is the path the agents actually use. |
| `status [--log <path>] [--json] [--no-colour]` | Aggregate budget, compactions, pins, savings and violations. Default log is `~/.local/share/strata-ctx/log.jsonl`. |
| `mcp serve` | Serve the `strata-ctx` MCP tools over stdio. |

Exit codes are the contract: `0` did what was asked, `1` the check failed, `2` the
command line was wrong. CI runs `hook --check`, and the only useful thing it can do is
fail — which is why `--help` is `0` and a missing subcommand is `2`.

Operator-facing behaviour, defaults, and the per-request status work are specified in
`docs/operations.md`.

## 9. Adding a package

The dependency rules are in `AGENTS.md` §12.1 and they are enforced by review, not by
tooling. Read that section before designing the package, not after.

The rules that actually bite:

1. **`core-types` is the only shared contract (rule P1).** Every package imports from
   `core-types` and from nothing else across streams. If you need something another
   package exposes, it either goes through `core-types` — which requires the contract
   owner's decision to unfreeze — or it waits.
2. **There is exactly one documented cross-stream exception:** `integrations` may
   import `security` and `telemetry`, because agent hooks are where untrusted text and
   credential headers actually arrive, so that path must redact and must be
   measurable. There is no second exception. Adding one is an `AGENTS.md` §14
   emergency stop.
3. **`eval` depends on nothing, and must keep depending on nothing.** It mirrors
   `ConstraintKind` in its own `types.ts` with a comment recording the freeze digest,
   rather than importing it, and it has a test asserting it opens no sockets. The
   measuring apparatus must not be able to drift with the thing it measures. If you
   "clean up" that duplication into a real import, you have broken the experiment.
4. **`eval-live` may depend on `eval` and on nothing else.** A live run measures a
   prompt prefix, not a pin; pinning is a gateway property and no single-turn API call
   demonstrates it.
5. **A package's declared `dependencies` must match its actual imports exactly.** Not
   a subset, not a superset. This is checked by hand at integration time, so get it
   right when you write it.
6. **Barrels are not yours.** `packages/*/src/index.ts` is owned by the integrator.
   Create your module; the barrel export is added at integration time.

The files:

```bash
mkdir -p packages/<name>/src packages/<name>/test
```

`packages/<name>/package.json` — model it on an existing one:

```json
{
  "name": "@strata-ctx/<name>",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "One honest sentence.",
  "license": "Apache-2.0",
  "author": "The strata-ctx Authors",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "dependencies": { "@strata-ctx/core-types": "1.0.0" }
}
```

`private: true` is not optional and not aspirational; see section 2. If you need a
sibling package, use the version range, not `file:` — `gateway` and `gist` use
`file:../security` because they predate the decision, and consistency with them is not
a reason to copy it.

`packages/<name>/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../core-types" }]
}
```

One `references` entry per package you actually import from. The `workspaces` glob
(`packages/*`) picks up the package automatically, so **no root `package.json` edit is
needed to be installed** — but the `tsconfig.json` project reference and the
`package-lock.json` entry are integrator-owned (`AGENTS.md` §7), so report them rather
than editing them. After the package lands, run `npm ci` once: the new
`node_modules/@strata-ctx/<name>` symlink is created by install, and nothing else will
create it.

Tests go in `packages/<name>/test/*.test.ts`, and fixtures go **inside your test
file** (`AGENTS.md` §6.2). Do not create or modify shared fixture files. Every operator
needs at least one negative test — a "should not do this" case — plus the determinism,
fail-open, and telemetry-emission checks in `AGENTS.md` §8.

## 10. What internal-only costs you

This is the part that is easy to skip and expensive to learn. Because there is no
registry, **the workspace is the only copy of the dependency graph that exists**, and
the usual escape hatches are gone.

### Cloning without installing does not fail cleanly

Measured on a fresh clone at `ba9b67f` with no `node_modules`:

| Command | Result |
| --- | --- |
| `npm run typecheck` | `sh: tsc: command not found` |
| `npm run lint` | `sh: eslint: command not found` |
| `npm run test` | 97 files enumerated, **97 failed**, `# pass 0 / # fail 97`, every one `Cannot find package 'tsx'` |

The gate does the right thing — it reports failure rather than a false green, which is
the failure mode it was written to eliminate. But the shape of the output matters:
"97 files failed to load" is easy to misread as "the repo is broken", when the actual
diagnosis is one missing command. `git status` will be clean, because `node_modules/`
and `dist/` are both gitignored and there is no artifact of a missing install in the
tree. If you see `ERR_MODULE_NOT_FOUND` for `tsx`, `typescript`, or any
`@strata-ctx/*`, you skipped `npm ci`. Run it.

Two related traps, same root cause:

- **A package added after the last install does not exist.** If `packages/telemetry`
  appears without a `node_modules/@strata-ctx/telemetry` symlink, `tsc --build` emits
  `Cannot find module '@strata-ctx/telemetry' or its corresponding type
  declarations` from every package that imports it, and there is no registry to fetch
  it from. Re-run `npm ci`.
- **There is no fallback.** If the lockfile and the manifests disagree, `npm ci` fails
  rather than reconciling, and nothing will install a different version for you. That
  is the correct behaviour; the point is that there is no second path.

### CI reproducibility is now entirely the repository's job

With a published package, a consumer can pin a version that exists and cannot move.
Here, a build is reproducible only if `package-lock.json`, the manifests, and the
committed source agree — and the only check that they do is CI running `npm ci` on a
fresh checkout. Anything uncommitted is invisible to CI, including anything excluded by
`.gitignore`. This has a live consequence; see the known issue below.

The test suite additionally depends on the network for one file.
`packages/eval/test/e4-coding-tasks.test.ts` resolves its corpus by shelling out to
`gh issue view ... --repo VinodAtwal/aegis`, which is a live HTTPS call to
`api.github.com`. There is no retry, no timeout knob, and no offline mode. Under the
parallel load of a full-suite run it intermittently exceeds the 30-second socket
timeout and fails with `CorpusResolutionError` / `i/o timeout`; in isolation the same
file passes in about 3 seconds. On this machine it failed in 2 of 5 full-lane runs.
Treat that specific failure as a known flake with a known cause, and re-run before
investigating anything else — but do not let it become a habit of re-running until
green.

### Onboarding cannot be automated away

There is no `npx create-strata-ctx`, no installable template, no registry entry to
point a new hire at. The onboarding path is this document plus `AGENTS.md`, and it has
to stay accurate by hand. Which is the argument for treating a clean-clone install and
gate run as a thing worth doing deliberately rather than assuming.

## 11. Known issue at `ba9b67f`: `packages/telemetry` is not in git

**A clean clone does not currently build.** Recorded here because the next person to
clone will hit it, and because the symptom points at the wrong thing.

`.gitignore` contains an unanchored `telemetry/` pattern, intended to keep local
telemetry data out of the tree. An unanchored pattern matches at any depth, so it also
matches `packages/telemetry/` — the entire WS-G source package, including its
`package.json`, `src/`, `test/` and `tsconfig.json`. Those 18 source files are present
in a developer's checkout and absent from the repository:

```
$ git ls-files packages/telemetry | wc -l
0
```

Consequences, all observed:

- A clean clone has 13 packages instead of 14, and `tsc --build` fails with
  `TS5083: Cannot read file '.../packages/telemetry/tsconfig.json'` and
  `TS6053: File '.../packages/telemetry' not found`, because `tsconfig.json` and
  `packages/integrations/tsconfig.json` both reference it.
- The test gate enumerates 97 files in a clean clone against 104 in a full tree —
  precisely the 7 `packages/telemetry/test/*.test.ts` files that git is dropping.
- `git status` reports a clean tree, because gitignored files are invisible to it by
  default. Nothing in the normal loop surfaces this.

The fix is to anchor the ignore rule so it matches a data directory rather than the
package, for example `/telemetry/` (plus the existing `*.jsonl` and
`packages/*/.eslintcache` rules), and then `git add` the package. Both are
root-level changes and integrator-owned.

Until it is fixed, a clean-clone verification needs
`packages/telemetry/` restored from a full checkout **and a second `npm ci`** —
without that second install the workspace symlink is never created, and every
consumer of the package fails with `TS2307`.

## 12. Where things are

| Path | What it is |
| --- | --- |
| `AGENTS.md` | The operational contract. Rules, invariants, the agent workflow, emergency stops. Read §6 and §7 before your first change. |
| `docs/architecture.md` | Topology, pipeline order, the canonical model. |
| `docs/spec.md` | Product requirements, non-goals, success criteria. |
| `docs/development.md` | Workstreams, waves, Definition of Done. |
| `docs/integrations.md` | The three integration tiers, feasibility matrix, host configs. |
| `docs/evaluation.md` | Methodology, statistical gates, the negative control. |
| `docs/decisions.md` | Design decision log. |
| `docs/operations.md` | Operator-facing behaviour: packaging, defaults, observability. |
| `docs/tasks.csv` | The board. The only place work is queued. |
| `docs/wiring-ledger.md` | Which package wires which capability. |
| `packages/core-types/` | The frozen canonical model. Do not change its public surface. |
| `scripts/run-tests.mjs` | The test gate. Read its header comment before changing it. |
| `scripts/check-contract.mjs` | `contract:check` / `contract:update`. |
| `tools/dev.ts`, `tools/mock-upstream.ts` | `npm run dev`. |