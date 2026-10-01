# strata-ctx

> **A context firewall for coding agents.** A local proxy + SDK + MCP server that sits between a
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
│  strata-ctx  (local, 127.0.0.1)                            │
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

Coding agents accumulate a transcript that degrades in two ways at once: **overflow** (the window
fills — loud and easily detected) and **rot** (accuracy falls off continuously with input length,
long before the window fills). Harnesses respond with compaction. But compaction is now a known
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

The research is cited by identifier in [`NOTICE`](NOTICE) and [`docs/spec.md`](docs/spec.md); no
code is vendored and no endorsement is claimed.

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

## What it is, and what it does today

strata-ctx is a local reverse proxy that normalizes provider traffic into a provider-neutral
**canonical model**, applies a fixed-order pipeline of pure functions, and denormalizes back to the
upstream wire format. Around the pipeline sit four subsystems: the **gist engine** (structured
compaction + artifact store), **governance** (immutable pinning), the **canary scheduler**
(runtime probes), and **telemetry** (cost/savings accounting).

> **Read this before you read the feature list.** Tier 0 (`dedupe`, `truncate`, `triage`) is
> **wired into the gateway's request path** — `packages/gateway/src/server.ts` calls `runTier0`, then
> `enforcePins` last — so the current claim is **"context is reduced, pinned, and measured"**.
> Tiers 1–2 (`compact`, `compress`, `serialize`) remain library operators that are not yet on the
> request path, and Tier 3 narration is opt-in via `pipeline.tokenCompression: 'local'` with a
> configured model.
>
> What "enforced" means, stated plainly, because it is narrower than the word suggests:
>
> - **Pin survival, integrity, and redaction are enforced.** Constraints are materialised into the
>   request every turn, drift is detected and reported, and tool results are scanned for credentials.
> - **A deterministic floor refuses destructive tool calls** (`rm -rf`, force-push, `DROP TABLE`,
>   setuid, writes to shell profiles and `authorized_keys`, and similar). It is enumerated rules,
>   not intent: `mv /data /dev/null` and a command assembled from runtime variables are not caught.
> - **Semantic policy enforcement is not implemented.** No component reads a constraint's *meaning*
>   and judges a tool call against it, so a policy written as prose cannot yet veto an action it
>   does not have a literal rule for.

## Feature overview

Each capability below exists as implemented source in the tree, with package-local tests. Where a
feature is not yet reachable from the running gateway, that is called out.

### Deterministic context compression

Tiers 0–2 run as pure functions over the canonical model. Dedupe drops blocks whose
`(subject.ref, subject.version)` is superseded; truncate applies per-tier caps with head+tail
retention and keeps every ERROR/FATAL line; pointer-ize replaces oversized file reads with an
`artifact://` URI plus a SHA-256; triage routes by `meta.tier` (governance is never summarized);
cache-prefix awareness forbids reordering blocks inside a provider's cached prefix (dropping is
allowed, reordering is not).

- Files: `packages/pipeline/src/{dedupe,truncate,pointer,severity,triage,recency,trigger,cache-prefix}.ts`
- Determinism invariant: same input ⇒ byte-identical output for Tiers 0–2 (N6).
- **Not yet wired end-to-end** into the gateway request path.

### Self-gist engine (validated structured gists)

On task boundaries, a completed-task transcript is replaced by a structured gist (schema v1)
rather than a prose summary. Deterministic fields (`changed[]`, `artifacts[]`, `current_values`,
`log_gist`) are read from the tool/event log; narrative fields (`goal`, `decided[].why`,
`unresolved`, `next`) come from a Tier 2 self-gist block the agent emits in its own turn. The
compaction transaction is ordered `flush → write → gist → validate → commit → repin → evict → log`,
with `fsync`-before-evict and a hard rule: **if validation fails, abort and keep the transcript.**

- Files: `packages/gist/src/{assembly,transaction,artifact-store,tiers,reversibility,dreaming}.ts`,
  `packages/pipeline/src/self-gist.ts`
- Reversibility: every gist records `source_turn_range`; `ctx_get_task` re-injects the raw range.

### Pinning that survives compaction (the core safety claim)

An immutable `PinnedBuffer` is materialized into every outbound request. `apply()` **replaces** the
pinned set rather than merging (`Final_Context = Compact(H) ∪ P`), so a gist or summary cannot
inject text that looks like policy. A byte-equality validator compares gist `constraints` against
the pinned set before and after compaction; a missing constraint is a P0 violation event, not a
warning. A type-level guard makes a governance block **unrepresentable** on any lossy stage.

- Files: `packages/governance/src/{pinned-buffer,byte-equality,policy-store,violations,type-guard,volume-attack}.ts`
- Policy is YAML (`packages/governance/src/yaml.ts`), versioned with per-project overrides and a hash.

### Redaction

Credential handling redacts by explicit header list plus module-private substring patterns
(`api-key`, `api_key`, `token`, `secret`, `cookie`) through a single `isSensitiveHeader()` API. The
security package scans text (patterns + entropy heuristics) **before** anything enters a gist or the
artifact store, so the bytes written are the bytes that were scanned. Redaction runs in every
telemetry sink, and gist fields are treated as untrusted input (no policy/permission escalation).

- Files: `packages/security/src/{redact,entropy,patterns,store,acl,gist-safety,retention,purge,locality,audit}.ts`
- Modes: `block` (do not forward) or `placeholder`; the secret is never logged.
- `packages/security/src/locality.ts` asserts no network code exists in the security package.

### Canary probes

Runtime probes measure context rot and constraint retention *inside a live session*. Constraint
probes are stratified by constraint kind, and **soft organizational policies are mandatory**: probing
only hard safety rules produces a false green (the literature shows soft-policy decay is ~8.3×
worse, partly because alignment training masks hard-norm decay). A throwing probe becomes a
`canary_fail` violation and the user's turn continues (fail-open).

- Files: `packages/canary/src/{constraint-probe,rot-probe,scheduler}.ts`
- Probes are **injected**: subjects and clock are parameters, never imports. The offline tests drive
  a deterministic subject; the live A/B campaign (staged) would drive a real gateway.

### Telemetry with net-vs-gross savings

Telemetry records tokens in/out, cost, `r` (input reduction fraction), `ε` (output expansion
factor), the breakeven verdict `ε < 1 + (1−r)/(ρk)`, cache behavior, violations, and rot scores.
Crucially, it reports **gross and net separately**: gist generation and canary probes are *our* cost,
and the cost gate (G7) is on **net**, not gross. The pricing table warns when its `verifiedOn` date
is older than 90 days.

- Files: `packages/telemetry/src/{events,sink,cost,savings,pricing,status,redact}.ts`
- `strata status` (`runStatusCli`) reads the local JSONL log and exits non-zero on violations or a
  damaged log; a missing log is a usage error, not a P0.

### Output compression (TOON/TRON)

Machine-readable blocks are serialized to TOON or its TRON variant; a classifier prevents
serialization of reasoning prose (the "diversity tax" — forcing JSON has been measured to reduce
answer diversity, so machine formats are never wrapped around reasoning text). A per-model support
registry falls back to JSON for unknown models.

- Files: `packages/output-compress/src/{toon,tron,classify,select,registry,directives,repair,cost}.ts`

### Fail-open by default

Any stage that throws, reorders a cached prefix, or returns a non-conforming context results in an
**unmodified passthrough** of the input. Streaming responses are piped and never buffered to
transform output (N3), so time-to-first-token is unaffected. The only exception is a bounded
ring-tail used to scan for the self-gist sentinel.

## How it works

### Request path

```mermaid
flowchart TD
  AG["Coding agent<br/>ANTHROPIC_BASE_URL / base URL / hooks"] -->|HTTP request| SRV
  HOOK["Agent hooks (e.g. PostToolUse)<br/>compress before the model reads"] --> ING
  SRV["POST /v1/messages · /v1/chat/completions · /v1beta/*<br/>A-7: routing, health, graceful shutdown"] --> ING
  ING["ingress adapter<br/>provider wire format to canonical"] --> CAN
  CAN["canonical model (core-types)"] --> PIPE
  PIPE["pipeline: pure functions, fixed order"] --> GOV
  PIPE --> GIST
  GIST --> STORE[("artifact store<br/>content-addressed, on disk")]
  PIPE --> TEL["telemetry: tokens, cost, r, eps, violations"]
  PIPE --> EGR
  GOV["governance: pin buffer, byte-equality"] --> PIPE
  EGR["egress adapter<br/>canonical to provider wire format"] -->|SSE byte-for-byte, never buffered| UP
  UP["upstream provider<br/>anthropic · gemini · openai-compat · mock"] -->|response stream| AG
  X["any stage throws"] -.->|"fail-open: pass through unmodified"| EGR
```

### Pipeline stages

The order is fixed and enforced; a policy may decide *whether* a stage runs, never *where*. It is
a safety property, not a preference (`packages/pipeline/src/order.ts` exports the order as one
constant).

```mermaid
flowchart LR
  A["1 dedupe"] --> B["2 truncate"] --> C["3 triage"] --> D["4 pin"] --> E["5 compact"] --> F["6 compress<br/>(Tier 3, optional)"] --> G["7 serialize"]
  classDef opt fill:#f5f5f5,stroke:#999,stroke-dasharray:4 3
  class F opt
```

| # | Stage | What it does | Where implemented |
|---|---|---|---|
| 1 | **dedupe** | drop blocks whose `(subject.ref, subject.version)` is superseded | `pipeline/src/dedupe.ts` (Tier 0) |
| 2 | **truncate** | per-tier caps; tool results get head+tail + all ERROR/FATAL lines; pointer-ize oversized file reads | `pipeline/src/truncate.ts`, `pointer.ts`, `severity.ts` (Tier 0) |
| 3 | **triage** | route by `meta.tier`; governance verbatim, never summarized | `pipeline/src/triage.ts` (Tier 0) |
| 4 | **pin** | append/reassert the immutable buffer every turn; `Final_Context = Compact(H) ∪ P` | `core-types` `enforcePins` + `governance/src/pinned-buffer.ts` |
| 5 | **compact** | replace episodic ranges with validated gists on task-boundary or size trigger | `gist/src/transaction.ts`, `pipeline/src/trigger.ts`, `recency.ts` |
| 6 | **compress** | **Tier 3, optional, `enabled: false` by default**; local-model narration scoped to the background/retrieval span only; must never see `tier==='governance'` | `gateway/src/ollama-adapter.ts` (not wired) |
| 7 | **serialize** | TOON/CSV/TRON for machine blocks only; lossless and reversible | `output-compress/` + gateway egress |

Supporting operators that are not pipeline stages: **self-gist** parsing (`pipeline/src/self-gist.ts`,
Tier 2), **severity classification** (`pipeline/src/severity.ts`), **recency windowing**
(`pipeline/src/recency.ts`), **trigger policy** (`pipeline/src/trigger.ts`), and **cache-prefix
assertion** (`pipeline/src/cache-prefix.ts`).

**Why this order** (`docs/architecture.md` §4): dedupe before truncate (free before expensive);
truncate before compact (never spend a lossy stage on a block you could delete for free); triage
before compact (a context mixing policy and logs cannot be safely summarized under one retention
policy — this is the Compaction Cliff fix); pin after triage and around compact (so no lossy stage
can remove it); compress after compact (don't compact already-compressed noise); serialize last
(lossless, so nothing downstream parses TOON). Reordering the pipeline is a security change, not a
refactor.

## Packages / repository layout

| Package | Purpose |
|---|---|
| [`core-types`](packages/core-types) | Canonical, provider-neutral model every package compiles against. **Frozen**: public surface hash-locked in `contract.lock.json` (114 exports, digest `0a3c0fea6360e6d9`); CI fails on drift. Zero runtime deps except `zod`. |
| [`gateway`](packages/gateway) | Local HTTP/SSE proxy: routing, ingress/egress adapters (`anthropic`, `openai-compat`, `gemini`, `mock`), config loader/validator/hot-reload, credential handling, token estimation, health/status. |
| [`pipeline`](packages/pipeline) | Tier 0–2 operators: dedupe, truncate, pointer-ize, severity, triage, recency, trigger, self-gist, cache-prefix, plus the fail-open runner and the canonical stage order. |
| [`gist`](packages/gist) | Gist engine: schema v1, assembly, the compaction transaction, content-addressed artifact store (fsync-before-evict), memory tiers, reversibility, offline consolidation. |
| [`governance`](packages/governance) | Pin buffer (replace-don't-merge), YAML policy store with versioning/overrides/hash, byte-equality validator, violation recording, volume-attack alert, governance type guard. |
| [`output-compress`](packages/output-compress) | TOON and TRON serializers/parsers, machine-block classifier, output directives, repair path, per-model support registry, `ε`/breakeven cost. |
| [`telemetry`](packages/telemetry) | Event schema, local-only JSONL sink, pricing table (staleness warning), cost engine (`r`, `ε`, breakeven), gross-vs-net savings accounting, `strata status` report. |
| [`security`](packages/security) | Secret redaction (patterns + entropy), artifact ACL/path-traversal defense, gist safety, retention/purge, and a locality assertion that the package opens no sockets. |
| [`integrations`](packages/integrations) | Claude Code hooks/observers, Gemini adapter, Aider/Cline/Roo profiles, Copilot MCP-only path, OpenCode profile, MCP server, templates, and the `surface-check` drift gate. |
| [`canary`](packages/canary) | Runtime constraint-retention probe (soft-org flag prevents a false green), rot probe, and the turn scheduler. |
| [`eval`](packages/eval) | Offline deterministic eval harness: versioned fixture format + validator, interleaved per-case runner, stable reporter, mock arms, grading, statistics; suites E1, E2, E3, E5, E6. **Zero deps and opens no sockets by design.** |
| [`testing`](packages/testing) | Deterministic provider record/replay harness, fixture factories, and a `fixtures` CLI (`list`, `validate`, `summary`, `paths`). |

Dependency rules and the full graph: [`AGENTS.md` §12](AGENTS.md). `core-types` is the only
cross-stream contract; the only documented exceptions are `integrations → security` and
`integrations → telemetry`, because agent hooks are where untrusted text and credentials arrive.
`eval` deliberately mirrors the contract instead of importing it, so the measuring apparatus cannot
drift with the thing it measures.

## Getting started

**Prerequisites:** Node.js `>= 20.11`, npm (workspaces). No API key is needed for the dev loop.

### Quickstart

```bash
npm install
npm run check        # typecheck + lint + test + contract drift
npm run dev          # gateway :8787 + mock provider :8799, no API key needed
```

`npm run dev` starts the gateway and a deterministic mock upstream, pins two demo constraints (one
hard safety rule and one soft org policy), sends a real request through the proxy, and asserts both
constraints arrive intact at the provider:

```
  [telemetry] request_in
  [telemetry] pin constraints=2 missingBefore=0
  [telemetry] stage
  smoke: pinned constraints intact at the provider = true
  smoke: upstream received N request(s), X bytes
```

The dev script exposes:

```
gateway   http://127.0.0.1:8787   (POST /v1/messages, GET /strata/status)
mock      http://127.0.0.1:8799
```

Useful routes (from `packages/gateway/src/routing.ts`): `GET /healthz`, `GET /strata/status`,
`POST /v1/messages`, `POST /v1/chat/completions`, `POST /v1beta/*`.

### Point a real agent at the proxy

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
```

That works today for pinning, telemetry, passthrough, and the request-path transforms that are
wired. It does **not** yet compress end-to-end, because the lossy stages are not wired into the
gateway (`CHANGELOG.md`, *Not yet*). Until they are, the honest claim is "context is preserved and
measured".

### Docker Compose

`docker-compose.yml` provides a local dev loop (gateway + Ollama). Ollama is not a dependency of the
gateway; Tier 3 narration is opt-in behind the `tier3` profile:

```bash
docker compose up                     # gateway + ollama, nothing to configure
docker compose --profile tier3 up     # ...and pull the Tier 3 model (qwen2.5-coder:7b)
```

The compose file pins every image by tag, uses no secrets, and mounts a Linux-native
`node_modules` volume so host platform binaries are not shared into the container. Read its header
before changing it.

### npm scripts (verified in `package.json`)

| Script | Command |
|---|---|
| `npm run build` | `tsc --build` |
| `npm run typecheck` | `tsc --build && tsc -p tsconfig.check.json` |
| `npm run lint` | `eslint .` |
| `npm test` | `node --import tsx --test packages/*/test/*.test.ts` |
| `npm run check` | typecheck + lint + test + contract:check |
| `npm run contract:check` | `node scripts/check-contract.mjs` (frozen-surface drift) |
| `npm run contract:update` | `node scripts/check-contract.mjs --update` (re-freeze; deliberate, contract-owner only) |
| `npm run dev` | `node --import tsx tools/dev.ts` |
| `npm run clean` | `tsc --build --clean` |

There is **no** `strata eval` command yet. The eval harness is a library with five offline suites,
not an installed binary (see [Evaluation](#evaluation--safety-gates-and-what-they-do-not-prove)).

## Configuration

Two different documents are in play, and they are not interchangeable:

1. **The gateway config** — a **JSON** file read at runtime and validated by
   `packages/gateway/src/config.ts`. This is the implemented surface.
2. **The policy/integration config** — a **YAML** document described in
   [`docs/integrations.md` §8](docs/integrations.md). This is the design of record for policy,
   redaction, compaction, canaries, and Tier 3; only the parts backed by code are live.

### Gateway config (JSON, validated, hot-reloadable)

Validation is total (it reports every problem at once), **unknown keys are errors**, and a reload
never installs a config that failed validation. Only JSON is accepted.

```json
{
  "listen": { "host": "127.0.0.1", "port": 8787 },
  "upstream": "http://127.0.0.1:9000",
  "policyPath": "./policy.yaml",
  "dataDir": "./.strata",
  "logLevel": "info",
  "provider": "anthropic",
  "timeouts": { "connectMs": 5000, "requestMs": 300000, "shutdownMs": 10000 }
}
```

| Key | Type / allowed values | Default |
|---|---|---|
| `listen.host` | string; loopback by default (binding all interfaces is deliberately not the easy default) | `127.0.0.1` |
| `listen.port` | integer `0–65535` (`0` = ephemeral) | `8787` |
| `upstream` | absolute `http(s)` URL | `http://127.0.0.1:9000` |
| `policyPath` | non-empty string | `./policy.yaml` |
| `dataDir` | non-empty string | `./.strata` |
| `logLevel` | `debug` \| `info` \| `warn` \| `error` | `info` |
| `provider` | `anthropic` \| `openai-compat` \| `gemini` \| `mock` | `anthropic` |
| `timeouts.connectMs` | integer ms `>= 1` | `5000` |
| `timeouts.requestMs` | integer ms `>= 1` | `300000` |
| `timeouts.shutdownMs` | integer ms `>= 1` | `10000` |

`ConfigWatcher` watches the *directory* (surviving atomic saves), debounces writes, and keeps the
last-known-good config live when a reload is refused.

### Policy and integration config (YAML, documented target surface)

The YAML below is the documented shape from `docs/integrations.md` §8. Two lines are called out there
as non-negotiable: `local_model.fields` never includes `constraints`, and token compression is off
by default. The Tier 3 opt-in is `enabled: false` by default and gated on `enabled: true` alone;
below ~5k tokens the compressor's own latency can exceed the saving.

```yaml
# strata-ctx.yaml  (documented target/integration config; see docs/integrations.md §8)
gateway:
  listen: 127.0.0.1:8787
  upstream: anthropic            # or gemini | openai-compat
  credentials: passthrough       # never log auth headers, ever
  fail_open: true

policy:
  pin_file: ./ctx-policy.yaml    # governance constraints — the pinned set
  redaction:
    enabled: true
    patterns_file: ./redact.yaml
    on_detect: block             # block | placeholder  (never log the secret)

context:
  strategy: sawtooth
  soft_trigger_frac: 0.70        # deliberately below the 0.85 default — rot is continuous
  hard_trigger_frac: 0.95
  keep_recent_tokens: 8192
  user_message_tail_tokens: 20000
  max_tool_result_chars: 2000
  max_tool_result_lines: 120

compression:
  dedupe: true
  truncate: true
  pointerize_files: true         # big file reads -> artifact:// + sha
  self_gist: true                # Tier 2 — the default
  local_model:
    enabled: false               # Tier 3 — opt in
    backend: ollama
    model: qwen2.5-coder:7b
    fields: [goal, why, unresolved, next]   # NEVER include constraints
  token_compression:             # Tier 4
    enabled: false               # off by default
    min_tokens: 5000             # below this, the compressor loses

output:
  verbosity_directives: true
  machine_format: toon_or_csv    # never applied to reasoning text — the diversity tax

canary:
  constraint_probe: { enabled: true, interval_turns: 25 }
  rot_probe: { enabled: true, interval_turns: 50 }
  include_soft_org_policies: true   # decay is 8.3x worse here; hard norms give a false green

telemetry:
  enabled: true
  egress: none                   # local only; no default network calls, ever
  file: ./.ctx/telemetry.jsonl
```

## Integrations

There are three integration patterns; the tiers are **fallbacks for each other**, not alternatives.
T-proxy alone is a complete product; the others add fidelity.

| Tier | Mechanism | Works with | Fidelity |
|---|---|---|---|
| **T-proxy** | point the agent's base URL at `127.0.0.1:<port>` | anything with a configurable endpoint | full request-path visibility |
| **T-mcp** | gateway exposes an MCP server; the agent calls it as a tool | anything supporting MCP | high for *retrieval*, none for *existing* context |
| **T-hooks** | agent lifecycle callbacks rewrite tool results in flight | Claude Code, Gemini CLI, Cursor | highest — sees and mutates tool results |

| Agent | Proxy | MCP | Hooks | Notes |
|---|---|---|---|---|
| **Claude Code** | `ANTHROPIC_BASE_URL` | yes | richest | `PostToolUse` is the highest-leverage hook: the only place output is seen *before* the model reads it. Also `PreCompact`, `UserPromptSubmit`, `SessionStart/End`, `Stop`. |
| **Gemini CLI** | yes | yes | yes | Same shape as Claude Code (`GEMINI.md` in place of `CLAUDE.md`); shares one parameterized hook adapter. |
| **Aider** | `--openai-api-base` | yes | no | Open-source, fully scriptable — the preferred reproducible A/B subject. |
| **Cline / Roo Code** | OpenAI-compatible | yes | no | Straightforward proxy target. |
| **Cursor** | limited | yes | partial | Hook surface is narrower than Claude Code's; verify on version changes. |
| **Copilot (VS Code)** | constrained | yes | no (closed) | **MCP-only, explicitly labelled "no governance guarantee."** Governance pinning is not achievable on this path and the docs say so. |
| **OpenCode** | — | yes | plugin | OpenCode plugin + MCP profile (task E-9). |
| **OpenWebUI / LM Studio / any OpenAI-compatible** | yes | varies | no | Free wins from the proxy alone. |

The **MCP server** (universal) exposes: `ctx_search` (JIT retrieval), `ctx_get_task` (re-inject a
compacted transcript range — the reversibility escape hatch), `ctx_get_artifact` (resolve
`artifact://` URIs), `ctx_note`, `ctx_status`, `ctx_remember`.

Per-agent recipes, the feasibility matrix, and the honest Copilot assessment are in
[`docs/integrations.md`](docs/integrations.md). `packages/integrations/src/surface-check.ts` backs a
CI/scheduled gate that fails when a vendor's hook schema drifts.

## Evaluation & safety gates (and what they do *not* prove)

The repo ships an **offline** eval harness (`packages/eval`) with pre-registered gates G1–G12 and a
three-arm methodology (Control, **Control+** = negative control, Treatment). The suite files that
exist are E1, E2, E3, E5, and E6. E4 (coding-task A/B) and the live A/B runner F2 are not
implemented.

> **The limitation you must not skip.** The offline suites measure **injected fakes**, not the
> production gateway. Every arm is `packages/eval/src/mock-arm.ts`: a deterministic, seedable
> function that synthesizes arm behavior (including deliberately dropping constraints so a retention
> failure is observable). Fixtures are injected scenarios; grading runs on the resulting
> observations. Nothing in `packages/eval/src/` opens a socket, by design. **Live A/B validation
> (F2-1–F2-3) is not done** — it is marked `todo` and is externally blocked on model-provider
> credentials and real agent surfaces. The canary probes likewise take **injected subjects**; the
> offline tests drive a deterministic subject and a live gateway is what F2 would drive. Do not read
> the gate thresholds below as evidence about production behavior. They are pre-registered bars;
> the campaign that would clear or fail them has not been run.

Pre-registered gates (verbatim from [`docs/evaluation.md`](docs/evaluation.md) §5; a failed gate
blocks release, it does not trigger a re-roll):

| # | Gate | Threshold | Arm |
|---|---|---|---|
| **G1** | Negative control fires | Control+ violation rate **≥ 25%** | Control+ |
| **G2** | Constraint violations, pinned | **= 0%** over 200 scenarios | Treatment |
| **G3** | Coding task pass rate | **non-inferior**, margin −2pp, McNemar one-sided *p* > 0.05 | Treatment vs Control |
| **G4** | Refinement suite pass rate | **non-inferior**, margin −2pp | Treatment vs Control |
| **G5** | Rot probe slope | treatment slope ≤ control slope | Treatment vs Control |
| **G6** | Input token reduction | **≥ 20%** median, coding tasks | Treatment |
| **G7** | **Net** cost reduction | **> 0%** after gist + probe cost | Treatment |
| **G8** | p95 latency overhead | **< 50 ms** | Treatment |
| **G9** | Secret redaction recall | **100%** on the secret corpus | All |
| **G10** | TOON round-trip | **lossless** on 100% of the fixture corpus | — |
| **G11** | Determinism | byte-identical output on replay, Tiers 0–2 | — |
| **G12** | Cache invalidation rate | < 5% of transforms invalidate a cached prefix | Treatment |

Two methodological points that matter more than the thresholds:

- **G1 protects all the others.** If the negative control does not reproduce the known failure in
  our harness, G2's 0% is uninterpretable. A suite that cannot fail is worth nothing.
- **Hard-only constraint sets are rejected in review.** Soft organizational constraints show ~8.3×
  worse decay; hard safety norms look fine because alignment training masks the effect, producing a
  false green.

Statistics: McNemar's exact test for paired binary outcomes, paired bootstrap CIs on median
differences for continuous metrics, non-inferiority at a pre-registered −2pp margin, and
Benjamini–Hochberg FDR control across the suite family. Underpowered cases must be reported as
"inconclusive", never as "no difference". Full methodology: [`docs/evaluation.md`](docs/evaluation.md).

## Project status

From `docs/tasks.csv`, the queue of record: **89 of 95 tasks are marked done** (6 `todo`). The
contract is frozen at `core-types@1.0.0` (digest `0a3c0fea6360e6d9`, 114 exports, drift-checked in
CI).

| Item | State |
|---|---|
| Frozen contract, gateway + 4 adapters, SSE passthrough | **done** |
| Pipeline Tiers 0–2 operators (dedupe, truncate, pointer-ize, triage, severity, recency, trigger, self-gist, cache-prefix) | **done as operators**; not wired into the gateway request path |
| Gist engine, compaction transaction, artifact store, reversibility, memory tiers | **done** |
| Governance: pin buffer, byte-equality, policy store, violations, type guard | **done** |
| Security: redaction, ACL, gist safety, retention/purge, locality assertion | **done** |
| Telemetry: cost engine, gross/net savings, `strata status` | **done** |
| Output compression: TOON/TRON, classifier, directives | **done** |
| Integrations: MCP server, Claude Code/Gemini/Aider/Cline/Roo/Copilot/OpenCode, surface-check | **done** |
| Canary probes + scheduler | **done** |
| Eval harness + statistics/grading + suites E1, E2, E3, E5, E6 | **done (offline / injected subjects)** |
| `B-9` Ollama Tier 3 narration | **todo** — externally blocked on a running Ollama |
| `F1-4` corpus curation (3 repos + licensing) | **todo** — externally blocked on download/clearance |
| `F1-8` Suite E4 coding-task A/B | **todo** — depends on F1-4 |
| `F2-1`–`F2-3` live A/B runner, report generator, full campaign | **todo** — externally blocked on live credentials and real agent surfaces |

Be precise about the compression claim: the operator tasks are done, but `CHANGELOG.md` states
plainly that **nothing compresses end-to-end yet** and the honest current claim is "context is
preserved and measured". The remaining work is the wiring plus the externally blocked items above.

## Documentation

| Doc | Contents |
|---|---|
| [`docs/spec.md`](docs/spec.md) | Requirements, non-goals, success criteria, glossary |
| [`docs/architecture.md`](docs/architecture.md) | Canonical model, pipeline order, topology, the compaction transaction |
| [`docs/integrations.md`](docs/integrations.md) | Three integration tiers, per-agent feasibility, hooks, MCP, configs |
| [`docs/development.md`](docs/development.md) | Ten workstreams, parallelism rules, four waves, Definition of Done, scope-cut ladder |
| [`docs/evaluation.md`](docs/evaluation.md) | Three-arm A/B methodology, statistics, 12 gates, 6 suites, limitations |
| [`docs/decisions.md`](docs/decisions.md) | Design decision log (ADRs), risks, open questions |
| [`docs/tasks.csv`](docs/tasks.csv) | Machine-readable board — import into Linear/Jira/Tracker |
| [`AGENTS.md`](AGENTS.md) | **Operational contract for contributors and coding agents** — TypeScript/lint rules, file-ownership boundaries, isolation rules, the dependency map, the request path, Definition of Done, and the improvement loop |
| [`CHANGELOG.md`](CHANGELOG.md) | Unreleased state, versioning policy, release process |

## Contributing / development workflow

- **Read [`AGENTS.md`](AGENTS.md) first.** It is the operational contract: strict TypeScript settings,
  the file-ownership boundaries, the isolation rules for parallel agents, and the Definition of Done.
  [`docs/development.md`](docs/development.md) holds the workstreams, waves, and scope-cut ladder.
- **Plan of record:** the work is queued only in `docs/tasks.csv`. A task not on the board is not
  scheduled.
- **Verification before finishing:** scoped typecheck (`tsc -p tsconfig.check.json --noEmit`, which is
  the only pass that sees test files), `eslint`, and your own package's tests by exact path. The root
  `npm run check` is serial and belongs to the integrator after merges.
- **Isolation (from `AGENTS.md` §7.1):** run only the test files you own by exact path — never
  `npm test` or a glob; leave no scratch files in the repo (use `/tmp`); touch only the files you
  were assigned; report a shared-file change instead of making it.
- **Independence:** don't run `npm install`, `tsc --build`, or git operations in a parallel agent;
  they serialize against other work.
- **Committing:** do not commit unless explicitly asked. CI runs four lanes — typecheck, tests,
  contract, and a selfcheck that proves the contract gate *can* fail.

## Naming

| Thing | Name / reality |
|---|---|
| Repo | `strata-ctx` |
| npm scope | `@strata-ctx/*` |
| Gateway runtime config | JSON (schema in `packages/gateway/src/config.ts`) |
| Policy file | YAML (`policyPath`, default `./policy.yaml`) |
| Status report | `strata status` (`runStatusCli` in `packages/telemetry/src/status.ts`); there is no installed `strata` bin as of this writing |
| Documented integration config | `strata-ctx.yaml` (design of record in `docs/integrations.md` §8; not the gateway's JSON runtime file) |
| Default data dir | `./.strata` (configurable via `dataDir`) |

## License

[Apache-2.0](LICENSE). Permissive, patent-granting, and the default for a tool that expects to be
embedded in other people's agent stacks.

[`NOTICE`](NOTICE) records the research the design is informed by: the papers are cited by
identifier in the docs, no code is vendored, and no endorsement is claimed. If a constant in the
docs is wrong, the citation is the fastest route to finding that out — corrections are welcome and
preferred over quietly adjusting a number.
