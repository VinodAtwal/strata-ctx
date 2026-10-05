# Development — Workstreams, Parallelism & Roadmap

> **Historical.** This is the plan as written before the work: ten workstreams, four waves, a
> milestone ladder, and staffing. Those waves are complete — see `npm run status` for live board
> state. Keep it for the reasoning (why the parallelism was shaped that way, what the scope-cut
> ladder was for), not as instructions to execute. The rules that still bind are in
> [`../AGENTS.md`](../AGENTS.md) §5 and §8.

*[Spec](spec.md) · [Architecture](architecture.md) · [Integrations](integrations.md) · [Evaluation](evaluation.md) · [Decisions](decisions.md)*

---

## 1. The ten workstreams

| ID | Name | Owns | Tasks | Est. | Critical path? |
|---|---|---|---|---|---|
| **A** | Core gateway & canonical model | `packages/core-types`, `packages/gateway` | 16 | 23.5 | ✅ **yes** |
| **B** | Context pipeline (Tiers 0–2) | `packages/pipeline` | 9 | 16 | ✅ yes |
| **C** | Gist engine & memory tiers | `packages/gist` | 7 | 13.5 | |
| **D** | Governance & constraint pinning | `packages/governance` | 10 | 12.5 | ✅ **security-gated** |
| **E** | Agent integrations | `packages/integrations` | 8 | 15 | |
| **F** | Eval harness & statistics | `packages/evals`, `packages/canary` | 14 | 26.5 | ✅ **yes** |
| **G** | Telemetry & cost accounting | `packages/telemetry` | 7 | 9.5 | |
| **H** | Output compression | `packages/output-compress` | 8 | 10 | |
| **I** | Security & privacy | `packages/security` | 8 | 10 | |
| **J** | Dev infra, CI, release | root, `.github/` | 7 | 8 | |
| | | **Total** | **94** | **144.5** | |

Estimates are engineer-days for someone already comfortable with TypeScript and LLM APIs,
**excluding** model-agnostic review overhead. At 2 engineers with an agent swarm, expect **~7–9
calendar weeks** to M5 (see `development` (Part 2)). Per-task detail (incl. acceptance criteria) is in `tasks.csv`; the
machine-readable board is [`tasks.csv`](tasks.csv).

## 2. The parallelism mechanism

Three rules make this actually parallel rather than three teams fighting over `main`:

### Rule P1 — `core-types` is the only shared contract

WS-A lands the canonical model, the policy types, and the pipeline/gateway interfaces as **one
reviewed PR**, early, and it is **frozen** (semver-locked) for the rest of the project. Every other
stream imports from `packages/core-types` and **nothing else cross-stream.** No stream may import
another stream's internals; if you need something, it goes through `core-types` or it waits.

*Why:* with a single frozen contract, ten workstreams can merge daily without integration meetings.
*Cost:* one hard-blocking artifact at the very start. That's the entire price of parallelism.

### Rule P2 — package-local test suites, no cross-stream test fixtures

Each stream's tests live in its own package and use only `core-types` + local fakes. Cross-stream
integration tests belong to WS-F and run in the `integration` CI lane, not in a feature branch's
unit lane. *Why:* a broken test in WS-B should never block WS-H's merge.

### Rule P3 — WS-D has a separate reviewer and a veto

Governance is merged only by a reviewer who is not the compression author, and WS-D can **block any
WS-B/WS-C merge** that could allow a governance field into a lossy path. *Why:* the entire product
claim is "compaction can't silently weaken policy." If the same person writes both sides, that
property is untested in the only sense that matters. This is a process cost we accept on purpose.

## 3. Dependency graph

```
                    ┌───────────────────────────┐
   Wave 0 (start)   │  J  Dev infra / CI        │  (no deps)
                    └───────────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  A  Core gateway   │  ← THE blocker. Freeze contract at end of Wave 0.
                    │  + core-types      │
                    └─────────┬─────────┘
                              │  (frozen contract)
      ┌───────────┬───────────┼───────────┬───────────┬───────────┐
      ▼           ▼           ▼           ▼           ▼           ▼
   ┌──B──┐     ┌──D──┐     ┌──H──┐     ┌──I──┐     ┌──G──┐     ┌──F──┐
   │pipe-│     │gov- │     │out- │     │sec- │     │tele-│     │eval │
   │line │     │ern  │     │comp │     │urity│     │metry│     │suite│
   └──┬──┘     └──┬──┘     └──┬──┘     └──┬──┘     └──┬──┘     └─────┘
      │           │           │           │           │
      │           └─────┬─────┴───────────┘           │
      │                 ▼                             │
      │          ┌──────────────┐                     │
      └─────────▶│  C  Gist     │                     │
                 │  engine      │                     │
                 └──────┬───────┘                     │
                        ▼                             ▼
                 ┌─────────────────────────────────────┐
                 │  E  Integrations (Claude Code, …)  │
                 └──────────────────┬──────────────────┘
                                    ▼
                 ┌─────────────────────────────────────┐
                 │  F* A/B runner + statistics + gates │
                 └─────────────────────────────────────┘
```

**Note where F sits.** WS-F splits:
- **F1 — eval *suites* and fixtures** start in **Wave 0/1**, against recorded fixtures. No dependency
  on A beyond `core-types`. This is deliberate: **the measurement apparatus must exist before the
  features it measures.** Retrofitting a benchmark is how the industry ended up with
  incomparable vendor leaderboards.
- **F2 — the live A/B runner and statistics** need A, and run in Wave 3.

## 4. The four waves

### Wave 0 — Contracts & apparatus (no cross-stream code)

| Stream | Work | Output |
|---|---|---|
| A | Canonical model, policy types, pipeline/gateway interfaces, **contract PR** | `core-types` **frozen** |
| J | Monorepo, CI lanes (`unit` / `integration` / `contract` / `e2e`), lint, release | Green CI on an empty repo |
| F1 | Eval harness skeleton, `mock` provider, fixture format, task-corpus curation starts | 1 trivial suite passing end-to-end |

**Gate W0:** contract PR merged and frozen; CI green; the trivial eval suite runs and reports
pass/fail/cost. *Everything downstream is blocked until this lands — it is the plan's only true
bottleneck and it should be staffed first and hardest.*

### Wave 1 — Six streams in parallel, zero merge coordination

| Stream | Focus | Depends on |
|---|---|---|
| B | Tiers 0–2: dedupe, truncate, pointer-ize, triage, self-gist plumbing | contract |
| D | Pinned buffer, policy store, byte-equality validators, violation recording | contract |
| H | TOON/CSV, severity-preserving log compression, output directives | contract |
| I | Secret redaction, artifact store ACL, threat model doc | contract |
| G | Token/cost accounting, `r`/`ε`/breakeven, JSONL sink, CLI | contract |
| F1 | Remaining eval suites (E1–E6), statistics module, canary probes | contract |

Six concurrent tracks, no shared files, daily independent merges. **This is where the project's
schedule is won or lost** — protect it by refusing scope additions.

### Wave 2 — Composition

| Stream | Focus |
|---|---|
| C | Gist engine: schema, self-gist parsing, store, memory tiers, the withdraw→gist→evict transaction |
| E | Claude Code integration (flagship) + Gemini via the shared parameterized hook adapter + MCP server |
| B∘D | **Integration checkpoint:** prove a governance block cannot reach a lossy stage. This is a *joint* task, not a merge. |

### Wave 3 — Measurement & release

| Stream | Focus |
|---|---|
| F2 | Live A/B runner, paired statistics, non-inferiority gates, report generation |
| — | Full eval campaign on the three target agents, claims-audit writeup, docs, release |

## 5. Suggested assignments

### Two engineers + agent swarm

| Owner | Wave 0 | Wave 1 | Wave 2 | Wave 3 |
|---|---|---|---|---|
| **Eng 1** | A (contract) | B | C, then E (Claude Code) | integration debugging, perf |
| **Eng 2** | F1 (suites + stats) | D, then I | C (gist schema — pairs naturally with D's invariants) | F2 runner, report |
| **Agent swarm** | J, fixtures | G, H, remaining F1 suites | E (Gemini, Aider, MCP) | docs, release, adapters |
| **Gatekeeper** (Eng 2 also holds this) | — | approves all WS-D merges; writes negative-control tests | runs the governance integration checkpoint | **owns every go/no-go** |

### Parallelization *inside* each stream

Each stream's tasks in `tasks.csv` are marked with an execution hint:

- **⟨seq⟩** — must run in order (the happy path of a single code path)
- **⟨par⟩** — independent of siblings within the stream; safe to fan out to separate agents
- **⟨ext⟩** — externally blocked (needs an agent surface verified, or a corpus downloaded)

Marking tasks `⟨par⟩` is what lets you fan work out to sub-agents within a stream without a human
coordinating. Stream D in Wave 1 is ~60% `⟨par⟩`; stream F1 is ~80% — both are excellent fan-out
targets.

## 6. Definition of Done (every task, no exceptions)

1. Unit tests in the task's own package, ≥ 1 negative test per operator (a "should not do this"
   case). A compression operator with no negative test is a bug factory.
2. **Nondeterminism test** for anything in the pipeline: same input ⇒ byte-identical output
   (product requirement N6). Flaky-by-design is fine for Tier 3 model calls; everything else is
   not.
3. Emits telemetry per `architecture` §8. If a stage can't be measured, it isn't done.
4. Fails **open**: unit test that a thrown error results in unmodified passthrough.
5. Citations: any non-obvious constant links to a source or a `TODO(owner)` comment. No folklore.
6. WS-D tasks additionally: a test proving the operation is *unrepresentable* on governance blocks
   where applicable (type-level, not runtime).
7. For WS-F: the suite runs in CI on fixtures with **zero network access** and **zero cost**.

## 7. Cross-stream risk register (top items)

| Risk | Impact | Mitigation |
|---|---|---|
| Contract churn after Wave 0 | Catastrophic — invalidates all parallelism | Contract freeze; changes require WS-A owner + gatekeeper sign-off + a migration note in every dependent stream |
| WS-D slips | Blocks the security claim; C and E both need its invariants | Staff D in Wave 1 with a second engineer, not one. It is 12 days but the highest-leverage 12 days in the plan. |
| Scope creep into "memory product" | Kills the schedule (see `spec` non-goals) | Reject any PR touching retrieval/substrate. Log it in `decisions` as a follow-up project. |
| Eval suites not ready when features land | Can't prove non-inferiority → can't ship | F1 in Wave 0/1, deliberately early. Non-negotiable. |
| Provider cache invalidation destroys economics | Silent perf/cost regression | `cache.prefix_invalidated` telemetry from day one; cache-aware transforms in WS-A |
| Copilot scope balloon | Sinks 5+ days into a path that can't meet the security claim | MCP-only, explicitly documented as no-governance. Reject the TLS path for v1. |
| Negative control doesn't reproduce the bug | Our whole test suite is worthless | E1 negative control is a **release blocker** — see `evaluation` §6 |

---

# Part 2 — Roadmap

*Assumes **2 engineers + an agent swarm**, 144.5 engineer-days. Calendar estimates assume the swarm
genuinely absorbs the `⟨par⟩` work and that WS-D gets a second pair of eyes from week 2.*

```
W0        W1        W2        W3        W4        W5        W6        W7        W8
├─────────┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────┼─────────┤
A ████████████
J ██████████
F1 ░░░░░░████████████████████████████████████████
B           ████████████████
D           ████████████
H           ████████████
I           ████████████
G           ████████████
C                      ████████████████
E                                 ████████████████
F2                                             ██████████
                  ▲          ▲          ▲          ▲          ▲
                  M0         M1         M2         M3         M4/M5
```

## M0 — Contracts frozen · end of W1 · **the only hard gate**

| | |
|---|---|
| **Deliverable** | `core-types@1.0.0` frozen; CI green on an empty repo; one trivial eval suite running end-to-end on fixtures |
| **Owners** | A (Eng 1), J (swarm), F1 (Eng 2) |
| **Gate to pass** | Contract PR merged + semver-locked · `npm run check` green · contract-diff CI job active · mock-provider suite reports pass/fail/cost |
| **If it slips** | *Everything* slips. This is the plan's only serial dependency — staff it first, staff it hardest, resist adding reviewers to it. |
| **Kill criterion** | If the contract needs >2 iterations to stabilize, cut scope: ship Tier 0 + pinning + Claude Code only. Those need ~40% of the model. |

## M1 — Six streams green · end of W3

| | |
|---|---|
| **Deliverable** | B, D, H, I, G all merged and independently tested; F1 suites E1–E6 authored and passing on fixtures |
| **Owners** | Six parallel tracks |
| **Gate to pass** | Every Definition of Done item in §6 · E1 **negative control reproduces** the violation phenomenon on fixtures · E6 recall 100% on the fixture corpus · E3 round-trip lossless |
| **Risk** | The temptation is to start integrating here. **Don't.** Integration before M2 turns six clean parallel streams into one serial debugging exercise. |
| **Note** | G1 firing on *fixtures* is a rehearsal. The real G1 is E1 on live models in M3. |

## M2 — Composition · end of W5

| | |
|---|---|
| **Deliverable** | Gist engine + the withdraw→gist→evict transaction working end-to-end; Claude Code integration live (hooks + proxy); Gemini + MCP; governance property-based suite green |
| **Owners** | C + E (parallel), joint B∘D governance checkpoint |
| **Gate to pass** | A real 2-hour Claude Code session completes a multi-subtask task with: gist committed, raw transcript recoverable, pinned set byte-intact, net savings positive on that session |
| **The critical test** | The **governance integration checkpoint**: demonstrate that no lossy stage can receive a governance block — enforced by type (D-8) *and* by a property test over random pipelines (D-9). Both must pass. If the type guard was faked, this is where it shows. |
| **Kill criterion** | If the transaction (C-3) isn't solid by W5, ship the gateway *without* automatic compaction — telemetry + pinning + Tier 0 only. A tool that compresses nothing but pins correctly is still valuable, and vastly safer than a half-working evictor. |

## M3 — Live measurement · end of W7

| | |
|---|---|
| **Deliverable** | Live A/B campaign on 3 agents; full report; claims audit with per-claim confidence |
| **Owners** | F2 (Eng 2) + swarm; gatekeeper holds the decision |
| **Gate to pass** | **G1** (negative control fires, ≥25%) · G2 (0% violations) · G3, G4 (non-inferiority) · G5 (rot slope) · G7 (net cost > 0) |
| **This is the real gate** | Everything before M3 is "does it work." M3 is "does it work *and can we prove it*." |
| **If G1 fails** | **Stop.** Do not proceed to M4. A non-reproducing negative control means either the harness or the intervention is wrong, and shipping on that basis is exactly the failure mode this project exists to prevent. |
| **If G3/G4 fail** | Ship behind a flag, keep measuring, report honestly. Do **not** quietly widen the margin — it was pre-registered. |

## M4 — Hardening · end of W8

Surface-check CI green · property-based suite in CI · `strata eval` shipped as a user-facing command · docs (including the Copilot no-governance caveat) · release pipeline.

**Gate:** zero open P0 violations in a 7-day soak on a real repository; no secret in any sink across the soak.

## M5 — v1.0

Published with a claims audit where every number is High/Medium/Low with a source, a **negative
control** result, the crossover session length above which it wins, and an explicit list of what we
do *not* claim.

---

## Critical path

```
A-1→A-2→A-3→A-4→A-5(FREEZE)→A-7→A-8→A-12→A-14 → C-3 → F2-1 → M3 gate
                                    ↓
                              E-2 (hooks) ──→ M2 test
```

**The path runs through the contract, then through the adapter, then through the transaction, then
through measurement.** Three consequences:

1. **A-5 (contract freeze) is the highest-leverage half-day in the project.** Get it right and ten
   streams fly; get it wrong and everything after is renegotiation.
2. **C-3 (the transaction) is the highest-risk single task.** Fail-open, fsync-before-evict,
   validation-abort and reversability all have to be simultaneously correct. It deserves a second
   reviewer and a property test, not a code review.
3. **Measurement is on the critical path, deliberately.** Most projects measure last. Measuring last
   means you find out at M3 that your intervention degrades refinement tasks, with no margin left to
   respond.

## Staffing the waves

| Wave | Eng 1 | Eng 2 | Swarm |
|---|---|---|---|
| W0–W1 | A contract | F1 skeleton + fixtures | J, corpus curation |
| W2–W3 | B | D (+ I) | H, G, remaining F1 suites |
| W4–W5 | C, then E (Claude Code) | C (schema) + governance checkpoint | E (Gemini/Aider/MCP), H-7/H-8 |
| W6–W8 | Integration + perf | F2 runner + campaign | Docs, release, `strata eval` UX |

**Two staffing notes that aren't negotiable:**

- **WS-D needs two people, not one.** 12.5 days, but it is the highest-leverage block in the plan and
  it gates the security claim. Eng 2 owns it in W2–W3 and the gatekeeper reviews every merge.
- **The gatekeeper is not a full-time stream.** It's a role held by whoever isn't mid-flight, and it
  owns every go/no-go. Ten parallel tracks with no single decision owner will ship three
  incompatible notions of "done."

## Scope-cut ladder (pre-agreed, so cutting isn't a negotiation)

Cut from the bottom, in this order, if the schedule slips. **Decide now, while nobody is invested.**

| Cut | Saves | What you lose | Still shippable? |
|---|---|---|---|
| Copilot path (E-7) | 1.5 ed | Copilot users get nothing | ✅ yes |
| Tier 3 local model (B-9) | 1.5 ed | Deterministic + self-gist only — the recommended default anyway | ✅ yes |
| Tier 4 token compression | ~0 | Nothing — already off by default | ✅ yes |
| TRON (H-2) | 1.5 ed | TOON only | ✅ yes |
| Gemini (E-5) | 2 ed | Claude Code only | ✅ yes |
| Memory tiers (C-4, C-6) | 3.5 ed | Single-session memory only | ✅ yes |
| **Automatic compaction (C-3)** | 3 ed | **Nothing.** Ship Tier 0 + pinning + telemetry + `strata eval` | ✅ **yes — and safest** |
| **Aider/Cline profiles (E-6)** | 1.5 ed | Loses the preferred A/B subject — cut **last** among the above | ⚠ painful |

**Never cut:** WS-D (pinning), the E1/E5 gates, D-8/D-9 (unrepresentability + property test), the
negative control, or fail-open behaviour. A version of this product without those is not a smaller
version of the product — it's a different, worse one that happens to share a name.
