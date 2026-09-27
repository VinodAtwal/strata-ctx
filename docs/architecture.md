# Architecture

*[Spec](spec.md) · [Integrations](integrations.md) · [Development](development.md) · [Evaluation](evaluation.md) · [Decisions](decisions.md)*

---

## 1. Design decisions (and why)

| Decision | Choice | Rejected alternative | Rationale |
|---|---|---|---|
| Deployment | Local reverse proxy, `127.0.0.1` | In-process SDK only | An SDK can't help users of agents we don't control (Copilot, Cursor). A proxy is the universal insertion point. |
| Streaming | Pass-through; never buffer to transform output | Buffer-and-rewrite | Output tokens are emitted before you can see them. Output compression is therefore done at the **tool/MCP boundary** and via **prompt directives**, not by rewriting the stream. |
| Pipeline shape | Fixed-order pipeline of pure functions | Free-form plugin chain | Order is a safety property, not a preference. Deduping after compacting is a bug. |
| Governance placement | Immutable pinned buffer, re-injected post-compaction | System-prompt-only; or LLM-compacted | Governance Decay: violations 0%→30% from compaction; survives→0% vs dropped→38%. Only *quarantine* works. |
| Compaction trigger | Task-boundary (sawtooth) + size backstop | Pure size threshold | Focus observed the sawtooth; task-boundary compaction holds quality better. Monotonic for one-shot reasoning. |
| Gist generation | **Self-gist** (agent emits it in its own turn) as default | Second call to a separate summarizer model | ~200 output tokens, **zero extra calls** — the agent already has the context. |
| Narrative model | Local (Ollama) optional; deterministic fields from event log | Frontier model for all fields | Deterministic fields are already in the tool log; a model adds cost and hallucination risk for free data. |
| Serialization | TOON/CSV for machine blocks | JSON | 20–27% fewer tokens, no model. But **see the diversity tax** — never wrap reasoning answers. |
| Failure mode | Fail-open (pass through) | Fail-closed | Losing user context to save tokens is unacceptable. |
| Monorepo | TS + npm workspaces | Polyglot | Every target extension surface (Claude Code hooks, VS Code, MCP SDK) is TS/JS. One language, one toolchain. |

## 2. Topology

```
                    ┌──────────────────────────────────────┐
                    │        config/policy.{yaml,json}     │
                    │   pin set · budgets · redaction ·    │
                    │   per-project overrides              │
                    └──────────────────┬───────────────────┘
                                       │
  ┌──────────────┐   HTTP/SSE   ┌───────▼────────────────────────────────┐
  │ Claude Code  ├─────────────▶│              GATEWAY (core)            │
  │ Gemini CLI   ├─────────────▶│                                        │
  │ Aider        ├─────────────▶│  ┌──────────────┐   ┌───────────────┐  │
  │ Cline / Roo  ├─────────────▶│  │ INGRESS      │──▶│ CANONICAL     │  │
  │ Cursor       ├─────────────▶│  │ adapter-in   │   │ MODEL         │  │
  │ Copilot*     ├─────────────▶│  └──────────────┘   │ (packages/    │  │
  └──────────────┘              │                      │  core-types)  │  │
                                │                      └───────┬───────┘  │
                                │                              │          │
                                │  ┌───────────────────────────▼───────┐  │
                                │  │  CONTEXT PIPELINE (pure fns)      │  │
                                │  │   1 dedupe    3 triage            │  │
                                │  │   2 truncate  4 pin   5 compact   │  │
                                │  │               6 compress(opt)    │  │
                                │  │               7 serialize        │  │
                                │  └───────────────┬───────────────────┘  │
                                │                  │                      │
        ┌───────────────────────┼──────────────────┼──────────────────┐   │
        ▼                       ▼                  ▼                  ▼   │
  ┌───────────┐        ┌─────────────┐    ┌──────────────┐   ┌──────────┐ │
  │ GIST      │        │ CANARY      │    │ TELEMETRY    │   │ ARTIFACT │ │
  │ ENGINE    │        │ SCHEDULER   │    │              │   │ STORE    │ │
  │ (C)       │        │ (D/F)       │    │ (G)          │   │ (B)      │ │
  └───────────┘        └─────────────┘    └──────────────┘   └──────────┘ │
                                │                                           │
                                └───────────▶ EGRESS adapter ───────────────┘
                                                     │
                                              Anthropic / Gemini / OpenAI
```

\* Copilot (VS Code extension) has no hook surface — see `integrations` §6.

**Package layout**

```
context-gateway/
├─ packages/
│  ├─ core-types/      # WS-A. Canonical model, policy, pipeline interfaces. ZERO deps.
│  ├─ gateway/         # WS-A. HTTP server, ingress/egress adapters, SSE passthrough
│  ├─ pipeline/        # WS-B. Tiers 0-2 operators
│  ├─ gist/            # WS-C. Schema, self-gist parsing, store, memory tiers
│  ├─ governance/      # WS-D. Pin buffer, policy store, validators
│  ├─ canary/          # WS-F*. Rot + constraint probes, scheduler
│  ├─ output-compress/ # WS-H. TOON/CSV, severity log compression, pointer-ization
│  ├─ telemetry/       # WS-G. Metrics, cost engine, CLI dashboard
│  ├─ security/        # WS-I. Redaction, store ACL
│  ├─ integrations/    # WS-E. Claude Code hooks, Gemini config, MCP server
│  └─ evals/           # WS-F. Suites, A/B runner, statistics
└─ plugins/            # local model adapters (ollama, etc.) — WS-C
```

**The one hard dependency:** `core-types` defines every interface. All streams import from it and
**nothing else**. This is what makes the parallel plan work; see `development` §2.

## 3. The canonical model

Provider-neutral. Adapters convert at the edge; the pipeline only ever sees this.

```ts
// packages/core-types/src/context.ts
export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'image' | 'cache_control';
  text?: string;
  id?: string;                    // tool_use / tool_result correlation
  toolName?: string;
  // Provenance is the key field: dedupe, eviction and gist all key off it.
  meta: BlockMeta;
  cacheControl?: { type: 'ephemeral' } | null;  // provider cache hints must survive transforms
}

export interface BlockMeta {
  origin: 'system' | 'user' | 'assistant' | 'tool' | 'synthetic';
  /** content hash for dedupe/staleness */
  sha256: string;
  /** tool results carry the file/command identity */
  subject?: { kind: 'file' | 'command' | 'search' | 'web' | 'other'; ref: string; version?: string };
  /** tier for triage: governance is NEVER summarized */
  tier: 'governance' | 'episodic' | 'tool_state' | 'artifact_ref' | 'user_intent';
  bytes: number;
  /** set by ops; drives head/tail/severity retention */
  severity?: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  /** true if this block is a cached-prefix segment — never reorder across these */
  cacheable: boolean;
  /** populated when the block has been superseded by a newer version of the same subject */
  supersededBy?: string;
}

export interface Message { role: Role; content: ContentBlock[]; ts: number; }
export interface ContextState {
  messages: Message[];
  /** immutable, re-injected every compaction */
  pinned: string[];
  tokenEstimate: number;
  policyHash: string;
  /** bookkeeping across turns */
  runId: string; turn: number; taskId?: string;
  gists: Gist[];                  // completed-task gists currently in context
  artifacts: ArtifactRef[];
}
```

**Design notes worth defending in review**

- `meta` on every block is what makes the pipeline possible. Dedupe, staleness, triage routing, gist
  assembly and eviction all key off it. If you strip it you lose Tier 0 entirely.
- `cacheable` exists because moving or reordering blocks inside a provider's cached prefix
  **invalidates the cache** and silently destroys the economics of the whole system. Transforms
  must be prefix-preserving or cache-aware. This is a real trap; see `decisions` R4.
- `tier: 'governance'` is a *type*, not a flag checked at the end. Making it a type means the
  compaction code literally cannot receive a governance block without handling it. **Prefer
  making the bug unrepresentable.**

## 4. Pipeline order (a safety property)

```
inbound canonical request
   │
   ├─▶ 1. DEDUPE          drop blocks whose (subject, version) is superseded
   │                      key: meta.subject.ref + meta.subject.version
   │
   ├─▶ 2. TRUNCATE        per-tier caps. tool_result: head + tail + all ERROR/FATAL lines.
   │                      if subject.kind==='file' && oversized → pointer-ize (op 8)
   │
   ├─▶ 3. TRIAGE          route by meta.tier. governance → verbatim, untouched. (TypeRetrieve:
   │                      "pin in-scope rules ahead of relevance")
   │
   ├─▶ 4. PIN             append pinned buffer LAST. Do this every single turn, not just at
   │                      compaction. Final_Context = Compact(H) ∪ P
   │
   ├─▶ 5. COMPACT         only if trigger fires. See §5. Replaces episodic ranges with gists.
   │                      Governed content is re-asserted here by construction (4 + 5).
   │
   ├─▶ 6. COMPRESS        OPTIONAL Tier 3 (local model). Gated on >5k tokens, scoped to the
   │                      background/retrieval span ONLY. Must never see tier==='governance'.
   │                      Disabled by default (product N: gains only appear beyond ~5k tokens,
   │                      and the compressor's own latency can exceed the saving below that).
   │
   └─▶ 7. SERIALIZE       machine-readable blocks → TOON/CSV. Never reasoning text. (§ output)
                             │
                             ▼
                       outbound provider request
```

**Why this exact order**

- **1 before 2**: dedupe is free; truncating a block you're about to drop is wasted work.
- **2 before 5**: compaction is the expensive, lossy stage. Never spend it summarizing garbage you
  can delete for free. This is Claude Code's "tiered eviction" insight.
- **3 before 5**: triage is what makes the Compaction Cliff fixable — you cannot safely summarize a
  context that mixes policy with logs under one retention policy.
- **4 after 3, before 5**: pinning is re-asserted *after* any triage and *around* any compaction, so
  no lossy stage can remove it. Pinning **last** also exploits recency (lost-in-the-middle).
- **6 after 5**: token-level compression is the most lossy input stage; doing it before compaction
  would mean compacting already-compressed noise.
- **7 last**: serialization is lossless and reversible; it must be the final transform so nothing
  downstream needs to parse TOON.

## 5. Compaction

### Trigger policy (defaults; tune on your own eval)

```ts
interface TriggerPolicy {
  strategy: 'sawtooth' | 'monotonic';
  softTriggerFrac: number;   // 0.85 default; LOWER to ~0.6 for rot-sensitive agents
  hardTriggerFrac: number;   // 0.95 — emergency structural eviction only
  keepRecentTokens: number;  // 8192 — recency tail stays verbatim
  reserveTokens: number;     // 8192 — headroom for the next tool result
  userMessageTailTokens: number; // 20000 — last user turn(s) preserved verbatim (CWL)
  taskBoundarySignals: string[]; // 'result_extracted','decision_superseded','before_large_read'
}
```

**`softTriggerFrac` should be well below capacity, not near it.** Rot is continuous, so the trigger
for an *agent* is a quality decision, not a capacity one. Starting at 0.85 is conservative; 0.6 is
probably correct for coding agents.

### The transaction (fail-safe ordering)

```
ON task_boundary(runId):
  1. FLUSH      drain in-flight tool results; close log stream
  2. WRITE      raw transcript + tool log → artifact store, content-addressed, fsync
  3. GIST       deterministic fields from event log; narrative fields from the self-gist block
                already present in the transcript (Tier 2), else from a local model (Tier 3)
  4. VALIDATE   schema + invariants:
                  a. every changed[].path has a sha
                  b. unresolved[] round-trips (don't drop the scary one)
                  c. pinned set byte-equals policy (SECURITY GATE — fail ⇒ abort)
                  d. artifacts[].uri resolves in the store
  5. COMMIT     atomically swap the episodic range for gist://<taskId> + inline gist
  6. RE-PIN     re-assert P (cheap; belt-and-braces with step 4c)
  7. EVICT      drop raw turns. Assert raw_recoverable === true first.
  8. LOG        emit tokens_before/after, dropped_count, compression_by, validation_passed
```

**If step 4 fails → abort, keep the transcript.** Fail toward *more* context. Step 2 must be
committed and fsync'd before step 7, or you have deleted evidence. Step 7 asserts
`raw_recoverable === true` — belt-and-braces against a lost store write.

## 6. Gist schema (v1)

```yaml
gist:
  v: 1
  task_id: string
  status: complete | partial | blocked | abandoned
  goal: string                     # forward + backward
  changed:                         # DETERMINISTIC — from tool-call log
    - path: string
      what: string                 # narrative
      why: string                  # narrative
      sha: string
  decided:                         # narrative
    - id: D1
      choice: string
      why: string
      alternatives_rejected: [string]
  unresolved: [string]             # narrative — the "scary one" must survive
  current_values:                  # DETERMINISTIC — concrete state, anti-drift
    env: { [k: string]: string }
  artifacts:                       # DETERMINISTIC
    - { uri: string, sha256: string, bytes: number }
  next:                            # FORWARD-looking, the part generic summaries lose
    question: string
    next_command: string
    blockers: [string]
  log_gist:                        # DETERMINISTIC + severity retention
    ran: [string]; failed: [string]
    salient_errors: [string]       # every ERROR/FATAL line survives
    dropped_count: int
    raw_uri: string                # artifact:// → re-injectable
  constraints: [string]            # NOT in the gist proper — lives in the pinned buffer.
                                   # Present here ONLY as a byte-equality check target.
  source_turn_range: [int, int]    # enables re-injection (reversibility)
  raw_recoverable: true
  compressed_by: self-gist | local-model | none
```

Two structural choices worth arguing for in review:

- **`constraints` is not a field the compactor can write.** It exists as a *verification target* —
  step 4c compares it byte-wise against the policy. This makes "the model dropped a safety rule" a
  detectable, testable condition rather than an invisible one.
- **`current_values` and `artifacts` are anti-drift instruments.** Progressive amnesia (§ failure
  modes) is the quiet killer: each compaction is individually reasonable, so nothing breaks, but
  the agent ends up operating on a partly-invented state. Carrying *concrete* values forward is
  what stops it.

## 7. Constraint pinning — the security core

```ts
// packages/governance/src/pin.ts
export class PinnedBuffer {
  private readonly buf: Readonly<string[]>;
  constructor(policy: PolicyStore) {
    this.buf = Object.freeze(policy.pinnedConstraints);
  }
  get size() { return this.buf.length; }

  /**
   * MUST be called on every outbound request, after every transform.
   * Final_Context = Compact(H) ∪ P
   */
  apply(ctx: ContextState): ContextState {
    const present = new Set(ctx.pinned);
    const missing = this.buf.filter((c) => !present.has(c));
    if (missing.length) recordViolation('pin_missing_pre_apply', missing);
    return { ...ctx, pinned: [...this.buf] };   // replace, never merge: no duplicates, no tampering
  }
}
```

Three properties, each from the research:

1. **Replace, don't merge.** A gist or a summary that *appends* to `pinned` could inject text that
   looks like policy. Overwriting from the immutable buffer makes policy injection structurally
   impossible.
2. **`recordViolation` on the pre-apply check.** If a constraint is already missing when we get
   here, something upstream removed it. That is a **P0 event**, not a warning.
3. **Called every turn, not just at compaction.** Governance Decay measured that decay *scales
   with compaction aggressiveness* but the mechanism is generic. Belt-and-braces is free here.

## 8. Telemetry (what we must measure to tune anything)

Emitted per request and per compaction:

```
r                input token reduction fraction
eps              output token expansion factor
breakeven_ok     eps < 1 + (1-r)/(rho*k)     # N2 spec: net cost must improve
compaction       { trigger, method, before_tokens, after_tokens, dropped_count }
gist             { schema_valid, constraints_intact, raw_recoverable, compression_by }
violations       { pin_missing_pre_apply, pin_post_compact_missing, canary_fail }
cache            { prefix_hit, prefix_invalidated }   # see R4
rot_canary       { score, at_frac_of_window }
```

**`breakeven_ok` is the metric that keeps us honest.** Gross input reduction is easy and
meaningless if the intervention makes the model verbose. `ε` must clear
`1 + (1−r)/(ρk)` or we are losing money while reporting a win. With ρ ≈ 4–5 and typical coding-agent
`k ≈ 0.1`, a 50% input cut allows ~2× output expansion before it's a wash — a generous budget, but
it is a budget, and on output-heavy workloads the same cut permits almost none.

## 9. Streaming

- **Pass-through by default.** No transform ⇒ forward chunks as they arrive, unmodified, so
  time-to-first-token is unaffected.
- **Self-gist parsing is the exception.** The gist is emitted by the model inside its own response,
  so we must scan the stream for the fenced block. Buffer *only* the tail after the sentinel; forward
  everything before it immediately. Cost: one small ring buffer, no perceptible TTFT hit.
- **Tool-result rewriting happens on the next inbound request**, not on the response stream. This is
  the honest constraint of streaming and it shapes the whole output-compression design: TOON lives at
  the tool/MCP boundary, verbosity lives in directives.
