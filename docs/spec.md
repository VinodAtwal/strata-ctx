# Spec — Product Requirements

*[Architecture](architecture.md) · [Integrations](integrations.md) · [Development](development.md) · [Evaluation](evaluation.md) · [Decisions](decisions.md)*

---

## 1. Problem statement

Coding agents accumulate a transcript that degrades in two ways at once:

1. **Overflow** — the window fills. Loud, trivially detected.
2. **Rot** — accuracy falls off *continuously* with input length, long before the window fills.
   Chroma measured universal degradation across 18 models; NIAH-style probes *overstate*
   long-context ability, so teams ship rot without noticing.

Harnesses respond with compaction. But compaction is now a known **security failure surface**:

| Finding | Source | Number |
|---|---|---|
| Safety rules surviving production `/compact` | Compaction Cliff, **CIKM 2026** | 53% after 1 round, **10% after 5** |
| Policy violations caused purely by compaction | Governance Decay | **0% → 30%** (up to 59%), 1,323 episodes |
| Violation rate *conditional on constraint survival* | Governance Decay | survives → **0%**, dropped → **38%** |
| Decay asymmetry: soft org policies vs hard safety norms | Governance Decay | **8.3×** worse — alignment training **masks** the damage |
| Compaction-Eviction Attack success | Governance Decay | optimized injection defeats **all** models (0% → 65%) |

**The gap:** every agent compresses, and almost none of them can tell you whether the compression
was safe, whether it cost you accuracy, or what it saved.

## 2. Product statement

> A local, model-agnostic **context firewall** for coding agents. It sits in the request path,
> compresses context deterministically, replaces completed-task transcripts with a validated
> structured gist, and makes context health an **auditable, continuously-measured property** —
> including a hard guarantee that compaction cannot erase governance constraints.

## 3. Requirements

### Functional

| # | Requirement | Priority |
|---|---|---|
| F1 | OpenAI-compatible **and** Anthropic-native reverse proxy, byte-transparent when no transform applies | P0 |
| F2 | Provider adapters: Anthropic, Google Gemini, OpenAI-compatible (extensible) | P0 |
| F3 | Deterministic pipeline: dedupe → truncate → triage → pin → compact | P0 |
| F4 | **Constraint pinning** — immutable policy buffer re-injected on every compaction | P0 |
| F5 | **Self-gist** — agent emits structured post-task summary inside its own turn | P0 |
| F6 | Gist schema validation with byte-equality check on the constraint set | P0 |
| F7 | **Severity-preserving log compression** (keep `ERROR`/`FATAL`, drop the boring 98%) | P0 |
| F8 | **Reference-instead-of-inline** — bulk payloads → `artifact://` URI + sha256 + gist | P0 |
| F9 | TOON/CSV serialization for machine-readable blocks | P1 |
| F10 | Canary scheduler: **rot probe** + **constraint-retention probe** | P0 |
| F11 | Telemetry: tokens in/out, cost, savings, `r`, `ε`, violations, compaction events | P0 |
| F12 | Claude Code integration (hooks + `ANTHROPIC_BASE_URL`) | P0 |
| F13 | Gemini CLI integration (hooks + base URL) | P0 |
| F14 | Aider / Cline / Roo integration via proxy | P1 |
| F15 | MCP server exposing compressed-context tools + artifact store | P1 |
| F16 | GitHub Copilot integration (constrained — see `integrations`) | P2 |
| F17 | Local-model gist narration (Ollama) for free-tier narrative fields | P1 |
| F18 | Secret redaction before anything enters a gist or the artifact store | P0 |
| F19 | Policy-as-code store with versioning + per-project policy files | P0 |
| F20 | A/B eval runner with paired statistics and non-inferiority gates | P0 |

### Non-functional

| # | Requirement | Target |
|---|---|---|
| N1 | Added p50 latency when idle | **< 5 ms** |
| N2 | Added p95 latency when transforming | **< 50 ms** for ≤ 200k tokens |
| N3 | Streaming passthrough | no buffering; first-token delta unaffected |
| N4 | Data locality | all context/gists/artifacts stay on disk; no telemetry egress by default |
| N5 | Degradation | any pipeline stage failure ⇒ **fail-open to uncompressed**, never drop context |
| N6 | Determinism | same input ⇒ byte-identical output for Tiers 0–2 |

## 4. Non-goals

Stated explicitly so we don't drift into a bigger, worse product.

- **Not a memory product.** No Mem0/Zep-style retrieval substrate. We integrate with one if present;
  we do not build one. (That market is well-funded and hard; this one is not defended.)
- **Not a model.** No fine-tuning, no learned compressor. Tier 3 is an *optional* local model for
  narrative fields only. CWL's result — deterministic typed-episode eviction with no measurable
  accuracy loss over 89 tasks / 80M tokens — is the working assumption this product is built on.
- **Not a hosted service.** Local-first. If telemetry is ever added it is opt-in and aggregate-only.
- **Not a general RAG framework.** We consume retrieval results and compress them; we don't build
  retrievers.
- **Not an IDE.** We integrate with editors; we don't replace them.
- **We will not claim compression improves accuracy.** See Rule 3.

## 5. Success criteria

### Release gates (see `evaluation` for methodology)

| Metric | Gate | Source of the bar |
|---|---|---|
| **Constraint violations, pinned mode** | **= 0%** over 200 ConstraintRot-style scenarios | Governance Decay baseline 30% (59% worst) |
| Constraint violations, pinning **disabled** | ≥ 25% (proves the test detects the problem) | *must reproduce the phenomenon or our test is broken* |
| Task pass rate, coding suite | **non-inferior**, margin **−2pp**, McNemar *p* > 0.05 | vs strongest full-context control |
| Task pass rate, refinement suite | **non-inferior**, margin −2pp | Focus found this suite is where compression *hurts* |
| Rot probe degradation slope | ≤ control slope | 18-model rot study |
| Input token reduction | **≥ 20%** median on coding tasks | Floor; we expect 30–50% on tool-heavy agents |
| **Net** cost reduction | **> 0** after accounting for gist + probe cost | The `ε` breakeven must clear, not just gross `r` |
| p95 latency overhead | < 50 ms | N2 |
| Secret redaction recall | 100% on the test secret corpus | F18 |

The **negative control** matters: with pinning off we must *reproduce* the decay phenomenon. A test
that passes in both arms proves nothing.

## 6. Design principles

1. **Fail open, never fail lossy.** If a stage errors, pass the context through unmodified. Losing a
   user's context to save tokens is a catastrophic bug; spending tokens is not.
2. **Reversibility.** Compaction is re-injectable. Every gist records `source_turn_range` and a
   pointer to the raw transcript. This is mandatory for refinement tasks, where aggressive
   compression demonstrably hurts.
3. **Structured, not prose.** Gists are versioned, schema-validated objects. Prose summaries lose
   critical details in unpredictable places (ACON's exact complaint).
4. **Separate backward state from forward intent.** `changed`/`decided`/`unresolved` (what is true
   now) vs `next`/`blockers` (what the next turn needs). Generic summarization conflates them and
   loses the second.
5. **Deterministic fields from the event log, narrative fields from a model.** `changed`, exit
   codes, artifact URIs are already in the tool log — never spend inference re-deriving them.
6. **Cite or flag.** Every non-obvious heuristic in the code links to a source or a TODO with an
   owner. No folklore constants.

## 7. Glossary

| Term | Meaning in this project |
|---|---|
| **Gateway** | the local proxy; owns the request path |
| **Canonical message** | provider-neutral representation of a conversation (see `01`) |
| **Triage** | per-type retention policy. Governance and tool-state and episodic are *not* treated alike |
| **Gist** | validated, versioned, structured replacement for a completed task's transcript |
| **Pinned buffer** | immutable governance constraints, re-injected post-compaction |
| **Artifact store** | content-addressed on-disk store for raw transcripts and bulk payloads |
| **Canary** | scheduled probe measuring a context-health property |
| **`r`** | fraction of input tokens removed by compression |
| **`ε`** | output token *expansion* factor caused by the intervention |
| **Breakeven** | `ε < 1 + (1−r)/(ρk)`; `ρ` = output/input price ratio, `k` = O/I. Below 1, the intervention loses money |
| **Pin** | add to the immutable buffer |
| **Evict** | remove from the in-context window (recoverable from the store) |
| **Compact** | lossy LLM summarization (the dangerous one) |
| **Non-inferiority** | statistically showing quality did not *decrease* beyond a pre-registered margin |
