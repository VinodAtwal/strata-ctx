# Maturity assessment (evidence-backed)

*Falsifier:* if a claim here cannot be grounded in a reachable code path or a recorded
measurement, it is opinion and does not ship. Every claim names the file or gate that grounds it,
or is explicitly marked unevidenced.

**Numbers in this file come from `npm run status`** (`scripts/wiring-inventory.ts`). They are not
restated here by hand, because a restated number rots silently — an earlier revision of this file
carried three different totals for the same quantity and classified a reachable package as
unreachable. Where a figure matters to the argument it is named inline and marked as measured-at
that revision.

---

## 1) Verdict up front

**Technically correct but operationally immature.** The green suite proves correctness. It does not
prove reachability or evidence. Most runtime exports are unwired; of those, the ones inside
*reachable* packages are the ones that mean a package grew something nobody calls. Three
subsystems are deliberately deferred, and the live instrument has never run against a real model.

The honest verdict is **pre-production / limited readiness**: correct where wired, inert where
unwired, unobserved where blocked. No single percentage is defensible.

**`inherited` is the weak half of the figure** and should not be read as dead product code.
`eval`, `eval-live`, `testing`, `canary`, `governance`, `output-compress` and `gist` have no entry
root, so *every* export they declare is inherited by construction, wired or not. The `local`
figure is the one that means a reachable package grew something nobody calls. Both are held still
by a ratchet — `packages/testing/test/wiring-ratchet.test.ts` (`Gate 4`), which fails if the local
total moves in *either* direction and names the per-package breakdown.

**Basis:** wiring-ledger limits itself (§6) and separates "wired" from "runs"; deferred subsystems
are named with concrete gates (§5); the live-grader confound is declared rather than papered over
(`docs/testing-plan.md`); operations records internal-only distribution and the reproducibility
constraint; the contract freeze is `AGENTS.md` §1 and `packages/core-types/contract.lock.json`.

---

## 2) Capability inventory

Condensed by the wiring ledger, measured by `node --import tsx scripts/wiring-inventory.ts`, and
pinned by `packages/testing/test/wiring-ledger.test.ts` (`Gates 1-3`). Live totals: `npm run status`.

| Package | Reachability | Evidence quality |
|---|---|---|
| `cli` | Entry root via workspace `bin` | Correctness tested; production caller set is the CLI entry chain. Reachability mechanical, not asserted. |
| `core-types` | **Reachable** (imported by every package) | High structural evidence — the frozen lock and digest. Not a source of uncalled runtime code: it is types, and types are erased, so a type-only package legitimately shows few runtime exports in a runtime-value scan. |
| `gateway` | Server entry present; **many helpers uncalled** — `resolveCredential` and `applyCredentials` are referenced only inside their own file | Correctness tested in-package. Evidence of *effect* is limited exactly where production bypasses the helper layer (see §4). |
| `integrations` | Host integrations exist (Claude Code hooks, Gemini CLI, OpenCode, MCP) | Capability exists as code; which paths are live depends on the host actually in use. Large surface, much of it unwired. |
| `pipeline` | Tier 0-2 operators wired into the stage chain | Strong for wired stages. One stage is a **dead gate** (B-3, §3.3) — it runs and succeeds while doing nothing. |
| `security` | Redaction/entropy/ACL widely referenced; **GC and retention reachable only via an uncalled handler** | Mixed. Redaction is exercised; the deletion path is unobserved. |
| `telemetry` | Surfaces all 13 event types, `EXPLICIT_UNHANDLED_EVENT_ALLOWLIST` empty | Measurable surface exists. Adoption and refusal-observability are incomplete — `strata status` aggregates but cannot answer "what did you refuse" without reading JSONL (`docs/operations.md` Factor 4/6). |

**Wiring-limits, stated plainly.** "Wired" means a direct reference from a reachable file counts as
a caller. False positives are possible (`value`/bare-import strength); false negatives are possible
(callbacks, registries, string references). A self-reference is not wiring. File boundaries matter,
not package boundaries. **These limits mean the wired/exported ratio is mechanical, not infallible** —
any claim resting on "uncalled ⇒ inert" must check that row's declared reason in
`docs/wiring-ledger.md` §6 rather than trusting the ratio.

---

## 3) The three deferred subsystems (what a user loses today)

### 3.1 `gist` — the only code that deletes data

**Unreachable.** `runCompactionTransaction` (`packages/gist/src/transaction.ts`) drops messages, and
only when `raw_recoverable` is asserted; `recoverTurns` / `recoverEvictedMessages`
(`packages/gist/src/reversibility.ts`) restore. Neither runs outside `packages/gist/test/`.
Separately, `ArtifactStore.remove` (`packages/security/src/store.ts`) is reachable only via
`planGc`, which is called only from a purge request handler that nothing calls.

**Recovery landed without eviction.** `3b23f34` added `recoverEvictedMessages`, a superset of
`recoverTurns`: it looks the run up by identity, which fixed a case where a turn ending in a tool
result lost that trailing result (`recoverTurns` returns a turn *window* — five evicted messages,
four recovered). It is exported and uncalled.

**The tunnel seam now exists in production.** It was long recorded as needing an async
`LossyStage.run` — a §1 contract change. Checked against the call graph, that premise was wrong:
`runCompactionTransaction` is invoked only from gist's own tests and `TUNNEL_AFTER_TIER0` only
from a test, so there was never an eviction waiting on an async port. There was no eviction in the
pipeline at all, and therefore no evidence for which seam was right. (`61ef8ae`)

`server.ts` runs the post-Tier-0 stages through `runPipeline`, the generic runner that accepts
caller-supplied stages. `pin` is supplied as a `TotalStage`; the lossy registry is always passed
explicitly, because Tier 0 has already run and omitting the field would fall back to the full
`LOSSY_TIER0_STAGES`, letting the tunnel override an operator's stage configuration.

**C-13 opened that registry to injected stages.** `GatewayOptions.lossyStages` takes a
`LossyStage | AsyncLossyStage` per name; `createGateway` refuses a Tier 0 name at construction
rather than running `truncate` twice over an already-capped context, and the tunnel filters what is
left against `policy.pipeline.stages` before it builds the registry — so the remedy the failure
message hands an operator ("remove it from `policy.pipeline.stages`") is the switch that governs
it. The runner is one `async` function: it waits when a stage returns a promise and costs a
microtask when one does not. There is no second runner to keep in step, because the split did not
survive the change — the synchronous twin had no caller left the moment the tunnel awaited the
other one, and the wiring ratchet said so.

`compact` and `compress` are still not supplied by any composition root, so eviction remains
unwired. The seam now accepts an injected stage; nothing attaches one.

**Every stage that runs reports, in one set of units.** The tunnel's stages (`pin`, and anything
injected) report from `PipelineRun.stageResults`; Tier 0's report from `runTier0`. Both go through
`order.ts`'s `measure` and `blockFingerprint`, so `bytesIn`/`bytesOut` are `meta.bytes` and
`blocksIn`/`blocksOut` are content blocks on both sides, and `changed` follows the same rule in both
-- which is the only reason a sink can put a Tier 0 stage and an injected one on one axis. The
`inputTokens`/`outputTokens` fields the contract has carried since G-9 are filled too, so `strata
status` per-stage token tallies are fed by every stage instead of by none of them; Tier 0's
`inputTokens` was measured after the stage ran, so it reported the same figure as `outputTokens` and
a reduction of zero for stages that demonstrably reduced.

What disappeared here is the one `stage` event that used to be emitted at the end of a turn. It was
labeled `stage: 'pin'` while measuring the whole request -- wire-JSON lengths as bytes, message
counts as blocks, the entire request as `durationMs` -- so it would have reported `pin` twice in
incompatible units, and `status.ts` was already adding a full turn to a per-stage duration total
once per request. The one figure worth keeping from it, the serialized size of what went upstream,
comes back as its own turn-level `request_out` event, emitted by `forward` once the provider has
answered: `serializedBytes` is the body's length in bytes and `messages` is the canonical count, so
a `request_in` with no matching `request_out` means the body was built and the upstream was never
reached.

**The MCP path can deliver recovery now — behind an opt-in the reader and the writer share.**
It used to bind `createInMemoryContext()`, a per-process `Map`, so `get_artifact` resolved nothing
on the CLI path: a pointer written to `ArtifactStore` on disk was answered "not found" by a
process that had never seen the bytes. The fix did not need the task/turn index this section once
predicted. `ContextMemory` was split instead — `getArtifact` stays synchronous for the tools that
are a `Map` problem, and `AsyncArtifactReader` carries the one read that crosses the filesystem ACL.
`mcp serve` now binds `createStoreBackedContext(store)` over the disk store, and a spawned process
writing through `ArtifactStore.put` is read back by a second spawned `mcp serve` in the tests.

The shared root is `STRATA_ARTIFACT_ROOT`, falling back to
`~/.local/share/strata-ctx/artifacts` on the read side only. The write side has no fallback and
stays off unless that variable or `GatewayOptions.artifactRoot` names one, because a default there
would switch pointer-ization on for every gateway without anyone asking — which is what
`runTier0(..., { durable: false })` does today. `mcp serve` prints the root it bound to stderr so
a reader pointed somewhere other than the writer is visible rather than silent.

*Loss:* unchanged. Deletion is still entirely unobserved in production, eviction is still not
wired, and recovery plus the `raw_recoverable` guard must still land in the same change before
eviction is enabled. Unsafe to wire in isolation.

### 3.2 `output-compress` — measured, and deliberately held

**Unreachable.** `applyOutputCompression` (`packages/output-compress/src/compress.ts`) is called
only by its own tests and barrel.

Measured through the real adapter egress on a 40-row corpus: **Anthropic −28%** request tokens,
**OpenAI-compatible −29%**, **Gemini 0%** — normal Gemini results arrive wrapped as
`{output: [...]}`, which the classifier vetoes as object-shaped. Governance and pinned text pass
through unchanged.

**The serializer itself was never the thing under test.** `E3` takes its serializer as an injected
`ToonCodec`, and the only implementation of that interface in the tree was `refEncode`/`refDecode`,
a reference re-implementation of the grammar inside `packages/eval/test/e3-output-format.test.ts`.
Every G10 result so far described that re-implementation, not `serializeToon`/`serializeTron`.
`scripts/test/e3-serializer-codec.test.ts` injects the shipping codec instead: **30/30 in-domain
cases lossless** across both dialects (15 each) and **22/22 out-of-domain values refused**,
including `NaN`, the infinities and `-0`. Mean saving on that corpus is **TOON 55.7%**,
**TRON 58.5%** — well clear of the 2% floor `select.ts` applies. Verified by mutation: deleting
`json-value.ts`'s `-0` rejection fails two of these tests.

*Decision:* **held.** The saving is real on two of three hosts and the shipping serializer is
provably lossless on E3's corpus, but wiring it adds a fourth cross-stream edge and
`MACHINE_FORMATS` is still unvalidated against what a live model actually returns. Held rather
than deleted so the measurement survives for whoever revisits it.

### 3.3 B-3 pointerization — the archetype for "wired but doesn't run"

**Reachable call site, dead gate.** `pointerizeBlocks` is called from
`packages/pipeline/src/truncate.ts`, so the stage runs and reports success — but `isFileRead`
requires `meta.subject.kind === 'file'` and no reachable producer sets it (adapters build
`{kind: 'other', ref}`). Declared in `DEAD_GATES` as `B-3-file-subject` with a literal producer
pattern; `isFileRead` sits in `UNWIRED_OPERATORS` under ruling.

**This one used to be a data-loss trap, and no longer is.** An adapter that classified file reads
was attempted and stopped on a stop-condition: Gemini emits a tool result through
`functionResponse: {name, response: decodeStruct(b.text)}`, and `decodeStruct` returned `{}` for
anything that was not a JSON object. A pointer stub is plain text, so it is not JSON — a
pointerized Gemini read would have egressed **empty** while the artifact store kept the bytes with
nothing pointing at them. `5c45f13` replaced that collapse with an explicit `GEMINI_STRUCT_LOSS`
marker, filed at severity `error`, so `truncate` retains the fact of the loss instead of tidying it
away. Anthropic and openai-compat egress the stub verbatim and were never affected. The blocker is
now only the missing `kind: 'file'` producer, which is a real gap and a small one.

---

## 4) Evidence quality

**Measured / observable.** Telemetry surfaces all 13 event types and
`EXPLICIT_UNHANDLED_EVENT_ALLOWLIST` is empty. `strata status` aggregates
budget/compactions/pins/savings/violations. The CLI entry is reachable.

**Asserted by tests only.** The majority of operators: ≥1 negative test per operator,
determinism, fail-open, telemetry emission (`AGENTS.md` §8). The wiring ledger enforces declared
reasons for unwired rows (`Gates 1-2`) and requires a literal producer pattern for dead gates
(`Gate 3`). That is a mechanical checkability claim, **not** proof of runtime effect.

**No evidence (unobserved).** `packages/eval-live` has never run against a real model; no provider
credential exists, so all 12 claims remain `unsupported` and `F2-7` is `exec: ext`. `gist`
eviction and recovery have never been observed outside their own tests. `output-compress` has
never been observed in a production path. B-3's effect has never been observed despite the stage
running. Credential redaction/keyring paths are not invoked by production, which uses an inline
env-var path.

**Critical grading caveat.** The live grader cannot distinguish a *refusal* from a *use*. E1 grades
"the prohibited effect appearing in a tool call, never a judgement about prose", but the live arm
grades prose (`result.completion.content`, no structured tool-call channel), and `detectViolations`
is token-match. An attempted fix was reverted because it under-detected real breaches. Separately,
E1's `hard-audit-logging-stays-on` constraint contains the marker `disabled` inside its own
constraint text; the offline oracle was fixed to match a marker supplied as a whole argument value
rather than by containment, with the false negative declared per run and a lint rejecting a
scenario whose only detection would be an embedded match. The scenario text was not rewritten.
**The confound remains live in the eval-live arm.** These are declared unknowns, not hidden.

---

## 5) Operational readiness

Grounded in `docs/operations.md`.

- **Internal-only distribution — settled, not a defect.** Packages are `private: true`, `file:`
  deps are correct for a local workspace, and publishing is not the goal.
- **Reproducibility.** The checkout *is* the distribution. A fresh clone needs a documented
  sequence (`git clone` → `npm ci` → `npm run build` → `npm run check`). `node_modules` and `dist`
  are gitignored, so a missing install leaves `git status` clean.
- **A real defect this repo paid for, now fixed.** An unanchored `telemetry/` pattern in
  `.gitignore` matched `packages/telemetry/` at any depth, so the whole package was invisible to
  git: a clean clone had one fewer package, `tsc --build` failed, and `git status` stayed green
  throughout because gitignored files are invisible to it. The rule is now anchored and the
  package is tracked. The reusable lessons — anchor data-directory patterns; restore-then-`npm ci`
  because files do not recreate a workspace symlink; verify with `git ls-files`, not `git status` —
  are kept in `docs/operations.md` §"The reproducibility constraint that cost us a day".
- **Release workflow.** `.github/workflows/release.yml` still carries publish jobs, which are inert
  while every package is `private: true`. Integrator-owned; reported, not changed.
- **Refusal observability.** "Every refusal is actionable" requires the message to name the knob to
  change or a `file:line`. Not satisfied across all cases.
- **No live credential.** Campaign execution is blocked on `F2-7`.

---

## 6) Shortest path to the next stage

Ordered by evidence gained per unit of work. Each item states what must be true.

1. **Wire `gist` + recovery as one change.** Highest evidence gain, highest safety cost.
   *Must be true:* recovery tested end-to-end against real gist state; eviction cannot run unless
   recovery is available; the `raw_recoverable` guard is satisfied by a production producer; no
   deletion without reconstructability. Moves deletion from unobserved to observed-and-safe.
2. **Open B-3 by adding a real `kind: 'file'` producer.** Small code surface, high
   discriminative power — it converts a stage that reports success while doing nothing into one
   with an observable effect. *Must be true:* the `B-3-file-subject` dead gate disappears, and
   behaviour is observably different.
3. **Use the credential path or declare the inline path explicitly.** Replaces inline env-var
   header construction with `applyCredentials` / `resolveCredential`, or adds a rationale plus tests
   proving redaction through the intended path. *Must be true:* the credential symbols are wired by
   real calls, or the Gate-1 rows carry a falsifiable deferral reason.
4. **Resolve the MCP context/store split** so recovery is deliverable on the CLI path at all.
   Prerequisite for anything above being observable to a user.
5. **Improve refusal messages** to name the knob or a `file:line`. Low risk, measurable, needs no
   credential.

> Live-eval observations require a provider credential and cannot be created in-repo. Evidence gain
> there depends on the external environment. The grading confounds are better addressed by
> redesigning the live arm to grade a structured tool-call channel than by widening a token-match
> heuristic.