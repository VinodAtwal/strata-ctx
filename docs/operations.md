# Operator adoption (board row E-15)

The specification behind `E-15` in `docs/tasks.csv`. This is what "easy to
integrate and monitor" has to mean for it to be checkable rather than a matter of
taste, and it records the state that made the task necessary.

## Why this row exists

Adoption is currently blocked by facts, not by polish:

- **There is no operator documentation.** `docs/development.md` is written for
  contributors. Nothing tells an adopter how to install, configure, or verify.
  `docs/quickstart.md` now covers clone-to-running for an internal developer; the
  operator-facing surface (factor 1) is still unwritten.
- **The monitoring half is a CLI that cannot answer the question.** `G-5`
  shipped `strata status` covering budget, compactions, pins, savings and
  violations. It aggregates. It cannot answer "what did you do to my last
  request, and what did you refuse to do" without the operator reading JSONL.

## Distribution: internal-only, decided

The owner has decided that these packages are **never published to a public
registry**. This section records that decision and what follows from it. It replaces
the original framing of this row, which was written when publishable packages were
the goal.

That original framing was: *"publishable packages (drop `private`/`file:` deps)"*.
It is now explicitly not the goal, and it was the right call. An npm name is
effectively permanent once taken — there is no release-it-back — and this is an
internal tool. Paying an irreversible cost to make a package installable by a
hypothetical external consumer is a bad trade.

### The two properties that must not be "cleaned up"

Both of the things the original row would have removed are load-bearing now, in the
opposite sense.

**`"private": true` is the enforcement mechanism.** All 14 packages carry it, and it
is the only thing standing between a stray command and a public publish. Under
internal-only distribution a private package and a deleted package are equivalent in
distribution terms — neither is reachable by anyone — so `private: true` is strictly
better than removing it, because it also fails loudly. If you find a package with
`private` absent or `false` and you are tempted to leave it, read this paragraph
again.

**The `file:` dependencies are correct, not a defect.** `gateway` and `gist` depend on
`"@strata-ctx/security": "file:../security"`. The original argument against them was
that `npm publish` copies a `file:` spec verbatim, producing a manifest no consumer
could resolve. That argument is correct and irrelevant, because these packages are
never published. The spec is what makes the local workspace resolve
`@strata-ctx/security` to `packages/security` on disk. Rewriting it to a semver range
would break local resolution in exchange for a property this repository has decided it
does not want.

New packages should use version ranges like every other package rather than copying
the `file:` form from `gateway` and `gist`. Consistency with those two is not a reason
to propagate a spec that only makes sense for a tree nobody publishes.

### What internal-only actually costs

There is no registry to fall back on, so **the `file:` graph and the npm workspace
*are* the distribution**. That is a stronger statement than it looks, and it has three
consequences that were previously absorbed by npm.

**Onboarding is manual and cannot be automated away.** There is no installable
template, no `create-strata-ctx`, no registry entry to send someone to. Every new
developer runs `git clone`, `npm ci`, `npm run build`, `npm run check`, in that order,
from a document that therefore has to be kept accurate by hand. `docs/quickstart.md`
is that document; it is load-bearing in a way an equivalent published README would not
be, because there is no fallback path if it drifts.

**A build is reproducible only if the repository is complete.** With a published
package, a consumer pins a version that exists and cannot move. Here, `npm ci` on a
fresh checkout is the *only* check that `package-lock.json`, the manifests, and the
committed source agree, and CI is the only place that runs it. Anything git is not
tracking is invisible to CI — including anything `.gitignore` is silently dropping.

That is not hypothetical. See the next section.

**Cloning without installing has no clean failure mode.** With a registry, a missing
install is recoverable: `npm install <pkg>` fetches it. Here there is nothing to fetch.
On a clone with no `node_modules`, `npm run typecheck` and `npm run lint` fail with
`command not found`, and every file the gate enumerates fails to load with
`Cannot find package 'tsx'`. The gate reports failure rather than a false green,
which is the behaviour it was written to guarantee — but "every file failed to load"
reads like a broken repository when the diagnosis is one missing command. Because
`node_modules/` and `dist/` are both gitignored, `git status` is clean and nothing in
the tree records that install never happened. The same shape appears when a package is
added after the last install: the workspace symlink is created by `npm ci` and nothing
else creates it, so every consumer of the new package fails with `TS2307` and there is
no registry to satisfy them from.

## The reproducibility constraint that cost us a day

This section used to describe a live defect: `packages/telemetry` was excluded by an unanchored
`telemetry/` pattern in `.gitignore`, so a clean clone had 13 packages instead of 14,
`tsc --build` failed with `TS5083`, and the gate enumerated 97 test files against a full tree's 104.
`git status` reported clean throughout, because gitignored files are invisible to it by default —
the working tree stayed green locally the whole time and the omission surfaced on someone else's machine.

**It is fixed** (the rule is anchored `/telemetry/`, and the package is tracked). Kept because the
failure mode is the reusable part, not the incident:

- **An unanchored `.gitignore` pattern matches at any depth.** `telemetry/` matches
  `packages/telemetry/`. Anchor data-directory rules with a leading `/`.
- **The workspace is the distribution.** Restoring files by any means does not create the
  `node_modules/@strata-ctx/*` symlink, and without it every consumer fails with `TS2307` while
  `dist/index.d.ts` sits right there looking correct. Re-run `npm ci` after restoring a package.
- **Check the clone, not the checkout.** `git status` cannot see what `.gitignore` hides. Verify with
  `git ls-files <pkg> | wc -l`, or clone to a scratch dir and build.
- **A green local tree is not evidence a clean clone builds.** See `docs/quickstart.md` §6.

## Factor 1: time to first governed request

An adopter should reach a real governed request without reading the source.

Under internal-only this is a claim about a *checkout*, not about a registry. Nobody
runs `npm install @strata-ctx/gateway`; they clone a repository and run `npm ci`, and
the acceptance target moves accordingly: the failure mode to design against is no
registry, not a slow download.

Acceptance: on a clean machine with no strata config, a documented sequence
reaches a governed request and shows a refusal — asserted by a script, in the
spirit of `F2-0`, so it fails when the path breaks rather than when someone
forgets to try it. Target: single-digit commands.

`docs/quickstart.md` is the current state of this factor and is close: a clean clone
plus `npm ci` plus `npm run dev` reaches a governed request with a pinned-constraint
assertion printed, in three commands. What it does not yet do is reach a *refusal* —
the demo policy pins two constraints and shows they survived, which is the
`raw_recoverable` direction, not the "the product said no" direction this factor asks
for. The gap is the refusal, not the onboarding.

## Factor 2: a safe default, and an honest one

The default configuration must be correct without being tuned, and must not
claim more than it did.

This is the factor with the sharpest recent evidence. A default gateway does
**not** pointerize: `GatewayOptions.artifactRoot` is absent by default, so
oversized reads take the byte cap instead of becoming `artifact://` references
(`gateway/src/server.ts`). That is correct — a pointer is only worth publishing
once its bytes are stored — but it means the headline compression behavior is
opt-in. Similarly, the E4 corpus supports no non-inferiority claim at n=12
(`docs/evaluation.md`).

Acceptance: for every default, the documented behavior matches observed
behavior. No report, log line, or README claim exceeds what the default
configuration measured.

## Factor 3: every knob documented with its default and its blast radius

An operator must be able to predict what a setting does before changing it.

Acceptance: each `GatewayOptions` field and each policy field has a documented
default and a stated consequence. A setting whose absence means "this feature
does not run" says so — `artifactRoot` is the model, because its absence is
invisible from the outside.

## Factor 4: per-request visibility into what compression did

Aggregate savings hide the per-request question. The stage telemetry already
carries the numbers (`bytesIn`/`bytesOut` per stage, `cache.prefixHit`,
`prefixInvalidated`); nothing surfaces them per request.

`buildStatus` discards the two event types that would answer it. At
`telemetry/src/status.ts:329` the switch ends in:

```ts
case 'stage':
case 'error':
  break;
```

So per-stage compression numbers and every error event are read off the log and
dropped on the floor — deliberately, to keep the summary small, but the result is
that the measurements exist and no operator-facing surface consumes them.

Acceptance: for any request, an operator can see tokens in and out per stage,
what was compressed, and the resulting token estimate — correlated by `runId`.

## Factor 5: silent degradation must be visible

Every one of these currently exists as a telemetry code that `strata status`
does not show, and each means the product did less than the operator expected.
The three `violation` kinds are counted (`status.ts:136`); the rest are not
counted anywhere:

| Code | Event type | Meaning |
| --- | --- | --- |
| `pin_missing_pre_apply` / `pin_post_compact_missing` | `violation` | a constraint may not have survived |
| `canary_fail` | `violation` | a probe failed |
| `stage_failed_open` | `error` | the context went upstream uncompressed |
| `artifact_write_refused` | `error` | a pointer was not published; the read was left inline |
| `eviction_skipped` | `error` (`EVICTION_SKIPPED_UNVERIFIED`) | the transcript was not evicted; it is still growing |

`eviction_skipped` is the one to watch. It *is* emitted —
`gist/src/transaction.ts:679-685` pushes a real `error` event through both
`emit()` and `telemetry.push()`, and `transaction.ts:705` repeats it as a
`failed:` string on the transaction result. What was missing was a reader:
`status.ts` had `case 'error': break;` alongside `case 'stage': break;`, so
every error was dropped on the way to a report. The event existed and was
wired; nothing consumed it.

It is also the *expected* path for every real Claude Code session, because
`integrations/src/claude-code-observers.ts` mints
`artifact://strata/raw/<session>/<turn>`, a URI the artifact ACL cannot parse.
Eviction is refused rather than corrupted, so there is no data loss — but
transcript growth stops being bounded, which is the problem the product exists
to solve.

Acceptance: **no telemetry code is emitted that `strata status` cannot surface.**
That is checkable by enumerating the event union and asserting each variant
appears in status output.

## Factor 6: every refusal is actionable

A refusal that does not name the knob that changes it is a dead end.

Acceptance: each refusal message names either the setting to change or the file
and line to look at. `artifact_write_refused` sets the model — it names the URI,
and distinguishes a block whose declared digest was not its text from content
that redaction changed.

## Factor 7: upgrade and compatibility

Acceptance: a documented compatibility statement for each host integration
(OpenCode plugin, Claude Code hooks), and a stated upgrade procedure. The plugin
and hook surfaces are version-coupled to hosts that update on their own
schedule.

Internal-only changes what "upgrade" means, and shrinks what has to be documented.
There is no version compatibility matrix between a published `strata-ctx` and a
consumer's project, because there is no published `strata-ctx`. The upgrade
procedure is therefore:

```bash
git pull
npm ci
npm run build
```

That is the whole procedure, and it is deliberately boring — there is no migration
step, no changelog to reconcile against an installed copy, and nothing to coordinate
across a fleet, because every operator is working from the same repository. The cost
moves to reproducibility instead: because the checkout *is* the distribution, a
half-finished upgrade is a broken working tree rather than a stale-but-working
install, and `npm ci` after `git pull` is what resolves it. Note that `git pull`
followed by a *forgotten* `npm ci` is the same failure as the missing-symlink case
above, and it will present identically.

What still needs documenting, and is unchanged by the decision: the compatibility
between the host integrations and their hosts, which version-coupled on their own
schedule and know nothing about our release process.

## What is settled, and what is still open

Settled by the owner: distribution is internal-only, and `private: true` plus the
`file:` specs are the intended shape of a never-published tree, not debt to be
repaid. The quickstart half of this row (factors 1–3, minus the refusal gap noted
above) is `docs/quickstart.md`.

Still open, and the split argument is unchanged by the decision: this row is one task
because adoption is one journey, but it decomposes into two independently shippable
halves — **packaging and quickstart** (factors 1–3) and **operator observability**
(factors 4–7). They share no code, and the second is useful to anyone already running a
dev checkout. Splitting into `E-15` and a `G-8` would let them land in either order.

Two follow-ups the decision creates, for whoever picks this up next:

- **`.github/workflows/release.yml` still publishes.** It builds a release train from
  the manifests whose `private` is not `true`, and runs `npm publish --access public
  --provenance` on it. Before this row's change, that train was exactly one package:
  `@strata-ctx/core-types`, which carried `private: false`, `files: ["dist"]` and a
  `publishConfig` block naming public access. Its `file:` gate is scoped to train
  members, so the two `file:` dependencies did not trip it. With `core-types` now
  `private: true` the train is empty and the workflow fails its own gate — *"no
  package is publishable: every `packages/*/package.json` still has `private: true`"* —
  which is the correct outcome, and a loud one. That leaves a publish workflow that
  can never succeed and can only ever be a source of confusion. `.github/workflows/**`
  is integrator-owned, so this is reported rather than changed: the honest options are
  to delete the publish jobs and keep the pack/plan lanes, or to keep the file and add a
  comment recording that the empty train is intentional.
- **`packages/eval/test/e4-coding-tasks.test.ts` depends on the network.** It resolves
  its corpus by shelling out to `gh issue view ... --repo VinodAtwal/aegis`, a live
  HTTPS call to `api.github.com`, with no retry, no timeout knob and no offline mode.
  Under full-suite parallelism it intermittently exceeds the socket timeout and fails
  the lane with `CorpusResolutionError` / `i/o timeout`; it failed in 2 of 5 full-lane
  runs on this machine, and passes in about 3 seconds when run alone. This is
  orthogonal to packaging, but it is the other thing standing between "the gate passes"
  and "the gate passes every time", and it will be read as a packaging failure if
  nobody has written down that it is not one.
