# strata-ctx

> **A context firewall for coding agents.** Local proxy + SDK + MCP server that sits between a
> coding agent and the model provider. It compresses context deterministically, replaces
> completed-task transcripts with a validated structured **gist**, and — critically —
> **prevents compaction from erasing your safety constraints.**

Every agent compacts its context. Almost none can tell you whether the compaction was **safe**,
whether it cost you **accuracy**, or what it actually **saved**. That's the gap.

```
Claude Code / Gemini CLI / Aider
        │  messages + stream
        ▼
┌─────────────────────────────────────────────────────────────┐
│  strata-ctx  (local, 127.0.0.1)                        │
│                                                             │
│   Dedupe ──▶ Truncate ──▶ Triage ──▶ Pin ──▶ Compact ──▶    │
│                                       Compress(opt) ──▶     │
│                                        Serialize ──▶        │
│                                                             │
│   Gist Engine        Canary Scheduler     Telemetry         │
│   (self-gist,        (rot + constraint    (tokens, $,       │
│    schema, store)     probes, alerts)      savings, net Δ)  │
└─────────────────────────────────────────────────────────────┘
        │  messages + stream  (byte-transparent when idle)
        ▼
   Anthropic / Gemini / OpenAI-compatible
```

## Why this exists

Two independent 2026 papers, both peer-reviewed or closely reviewed, found that compaction is a
**security failure surface** — not just a cost optimization:

| Finding | Source | Number |
|---|---|---|
| Safety rules surviving production `/compact` | Compaction Cliff, **CIKM 2026** | 53% after 1 round, **10% after 5** |
| Policy violations caused *purely* by compaction | Governance Decay | **0% → 30%** (up to 59%), 1,323 episodes |
| Violation rate conditional on constraint survival | Governance Decay | survives → **0%**, dropped → **38%** |
| Decay asymmetry: soft org policies vs hard safety norms | Governance Decay | **8.3×** worse — alignment training **masks** the damage |
| Compaction-Eviction Attack | Governance Decay | optimized injection defeats **all** tested models |

And the counter-pressure from the other direction: context *rot* degrades quality **continuously**,
long before a window fills — universal across 18 frontier models, and invisible to Needle-in-a-
Haystack probes.

So: agents must compress, compression is unsafe by default, and nobody is measuring either. This
project is the layer that compresses *and proves it didn't break anything*.

## Three rules

**1 — Governance is code, never a model.** The best safety result in the research came from
*deterministic* operators, not a better LLM compactor. Constraints live in an immutable buffer,
re-injected on every compaction: `Final_Context = Compact(H) ∪ P`. A model may summarize episodic
content; a model may never decide whether a safety rule is worth keeping.

**2 — Deterministic before learned.** Dedup, truncate, pointer-ize, TOON-serialize, and
**self-gist** (the agent writes its own summary inside its normal turn — ~200 tokens, **zero extra
model calls**) all cost $0 and ship before any learned compressor exists.

**3 — Claim non-inferiority, not improvement.** The bar is: same task quality, fewer net tokens,
zero policy violations. If a test can't clear a pre-registered gate, the feature doesn't ship. The
negative control is a release blocker.

## Status

Wave 0 in progress. Contract frozen, gateway runnable, no lossy stages yet.

| | |
|---|---|
| ✅ | `core-types` contract frozen (114 exports, drift-checked) |
| ✅ | Anthropic ingress/egress adapter + SSE passthrough |
| ✅ | Pin buffer materialised into the outbound request |
| ✅ | 51 tests, CI with a self-check that the contract gate can fail |
| ⬜ | Tier 0 operators (dedupe, truncate, triage) |
| ⬜ | Gist engine + the compaction transaction |
| ⬜ | Canary probes, eval harness, other agent integrations |

Tasks: 94 across 10 workstreams — [`docs/tasks.csv`](docs/tasks.csv) · 144.5 engineer-days ·
7–9 weeks at 2 engineers + agent swarm. Gates G1–G12: [`docs/evaluation.md`](docs/evaluation.md).

## Documentation

| Doc | Contents |
|---|---|
| [`docs/spec.md`](docs/spec.md) | Requirements, non-goals, success criteria, glossary |
| [`docs/architecture.md`](docs/architecture.md) | Canonical model, pipeline order, key interfaces, the compaction transaction |
| [`docs/integrations.md`](docs/integrations.md) | Per-agent feasibility matrix + integration recipes (Claude Code, Gemini, Aider, Copilot) |
| [`docs/development.md`](docs/development.md) | 10 workstreams, the 3 parallelism rules, Definition of Done, milestones, scope-cut ladder |
| [`docs/evaluation.md`](docs/evaluation.md) | 3-arm A/B methodology, statistics, 12 gates, 6 eval suites |
| [`docs/decisions.md`](docs/decisions.md) | 16 ADRs, open questions, risk register, the "delete all logs" position |
| [`docs/tasks.csv`](docs/tasks.csv) | Machine-readable board — import into Linear/Jira/Tracker |

Research basis: [`../context-compression`](../context-compression). Every non-obvious constant in
the code links to a source or carries a `TODO(owner)`.

## Quick start

```bash
npm install
npm run check        # typecheck + lint + test + contract drift
npm run dev          # gateway :8787 + mock provider :8799, no API key needed
```

`npm run dev` pins two demo constraints, sends a real request through the proxy, and asserts they
arrive intact at the provider:

```
  [telemetry] request_in
  [telemetry] pin constraints=2 missingBefore=0
  [telemetry] stage
  smoke: pinned constraints intact at the provider = true
```

Point a real agent at it by changing one environment variable:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
```

That works today for pinning, telemetry and passthrough. It does **not** yet compress anything —
the lossy stages land next, and until they do, the honest claim is "context is preserved and
measured", not "context is reduced".

```bash
strata eval --tasks ./my-tasks.yaml   # not built yet
```

## Naming

| Thing | Name |
|---|---|
| Repo | `strata-ctx` |
| npm scope | `@strata-ctx/*` |
| CLI | `strata` |
| Config file | `strata-ctx.yaml` |
| Data dir | `~/.strata/` |

## License

[Apache-2.0](LICENSE). Permissive, patent-granting, and the default for a tool that expects to be
embedded in other people's agent stacks.

`[NOTICE](NOTICE)` records the research the design is informed by. The papers are cited by
identifier in the docs; no code is vendored and no endorsement is claimed. If a constant in the docs
is wrong, the citation is the fastest route to finding that out — corrections are welcome and
preferred over quietly adjusting a number.
