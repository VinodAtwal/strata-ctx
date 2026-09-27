# Integrations — Agent Support

*[Spec](spec.md) · [Architecture](architecture.md) · [Development](development.md) · [Evaluation](evaluation.md) · [Decisions](decisions.md)*

---

## 1. Three tiers of integration

Everything below is an instance of one of three patterns. Build all three; the tiers are
**fallbacks for each other**, not alternatives.

| Tier | Mechanism | Works with | Fidelity | Priority |
|---|---|---|---|---|
| **T-proxy** | Point the agent's base URL at `127.0.0.1:<port>` | Anything with a configurable endpoint | Full request-path visibility | P0 — universal floor |
| **T-mcp** | Gateway exposes an MCP server; the agent calls it as a tool | Anything supporting MCP | High for *retrieval*, none for *existing* context | P1 |
| **T-hooks** | Agent lifecycle callbacks let us rewrite tool results in flight | Claude Code, Gemini CLI, Cursor | **Highest** — sees and mutates tool results | P0 |

**The strategic point:** T-proxy alone is a complete, shippable product. Everything else is
*additional fidelity*. If integration work on a specific agent slips, the product still works
through the proxy. Never let a per-agent integration become a critical-path blocker.

## 2. Feasibility matrix

**Confidence note:** extension surfaces below change between versions. Every row marked `verify`
must be confirmed against the agent's current docs at implementation time — treat the *pattern* as
durable and the *hook names* as a moving target. WS-E owns a `surface-check` CI job that fails when
a hook schema drifts.

| Agent | T-proxy | T-mcp | T-hooks | Notes | Conf. |
|---|---|---|---|---|---|
| **Claude Code** | ✅ `ANTHROPIC_BASE_URL` | ✅ | ✅ **richest** | Has a `PreCompact` lifecycle event — we can observe the host's *own* compaction, not just ours. Also beta `context-management-*` headers we can enable. | verify |
| **Gemini CLI** | ✅ | ✅ | ✅ (open source, TS) | `GEMINI.md` for directives; same extension surface shape as Claude Code | verify |
| **Aider** | ✅ `--openai-api-base` | ✅ | ❌ | Open-source Python, fully scriptable → **our preferred A/B test subject** (reproducible, cheap, deterministic) | High |
| **Cline / Roo Code** | ✅ OpenAI-compatible | ✅ | ❌ | Straightforward proxy target | High |
| **Cursor** | ⚠️ limited | ✅ | ✅ | Hooks exist but surface is narrower than Claude Code's | verify |
| **GitHub Copilot (VS Code ext)** | ⚠️ **constrained** | ✅ | ❌ closed | See §6. The hard case. | — |
| **Copilot (API / CLI)** | ✅ | ✅ | ❌ | Programmatic path is clean if they have API access | High |
| **OpenWebUI / LM Studio / any OpenAI-compatible** | ✅ | varies | ❌ | Free wins from the proxy alone | High |
| **Continue / open-source IDE assistants** | ✅ | ✅ | varies | | High |

## 3. Claude Code — the flagship integration

Highest fidelity, and it shapes the design for everything else. Four mechanisms, each with a job:

### 3a. Proxy (mandatory, universal)

```bash
# .claude/settings.json  (project) or ~/.claude/settings.json (user)
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "gateway-local-noop"
  }
}
```

`ANTHROPIC_AUTH_TOKEN` is a placeholder — the gateway does not proxy credentials by default, it
forwards the client's real headers. A `--credentials=passthrough|env|keyring` flag governs this; see
`decisions` R7.

### 3b. Hooks — where the real wins are

| Hook | What the gateway does | Why it matters |
|---|---|---|
| `UserPromptSubmit` | Tag the user turn `tier: 'user_intent'`; extend `keepRecent` window | Preserves intent verbatim (CWL) and anchors the recency tail |
| `PreToolUse` | Decide whether this tool call is worth running; reject pathological repeats | Saves tokens *before* the result is generated, not after |
| **`PostToolUse`** | **Rewrite the tool result in flight** — this is the Tier 0 win | Dedup, truncate, pointer-ize, severity-retail. The only place we see tool output before the model does |
| `PreCompact` | **Observe the host's native compaction**; verify pinned set survived | The host compacts on its own schedule. We must not be blind to it |
| `SessionStart` | Load policy, project pins, prior session gists | Session continuity |
| `SessionEnd` | Write run summary + telemetry; flush artifact store | Clean shutdown, no orphan state |
| `Stop` | Emit per-turn metrics; schedule canaries | Measurement cadence |

`PostToolUse` is the highest-leverage hook in the entire integration: it is the **only** mechanism
anywhere in this project that lets us compress data *before* the model reads it. The proxy only sees
context the model has already been given.

### 3c. `CLAUDE.md` / output directives

Output-side compression is mostly a **prompt** intervention, since we cannot rewrite a stream:

```markdown
## Output protocol
- No preamble, no restating the request. Start with the answer.
- For machine-readable blocks (lists of files, tables, tool results), use the compact
  tabular form: CSV for arrays of objects, `key: value` for scalars. No JSON braces or quotes.
- For anything exceeding 20 lines, write it to a file and return the path plus a one-line summary.
- At the end of each completed sub-task, append a single fenced block:

  ```ctx-gist
  {"v":1,"status":"complete","goal":"...","changed":[...],"unresolved":[...],
   "next":{"question":"...","next_command":"..."}}
  ```
```

That last one is **Tier 2 self-gist**: the model writes its own compression, so the gateway pays
~200 output tokens and **zero extra inference calls**. It is the cheapest compaction that exists,
and it requires no model choice at all. `evaluation` E4 measures it head-to-head against
the separate-summarizer design.

### 3d. Beta context editing (opportunistic)

If the account has `clear_tool_uses_*` / `clear_thinking_*` betas, the gateway can request them for
the *background* span and reserve its own compaction for what Anthropic won't clear. Reported +29%
from context editing alone. Treat as an adapter capability flag — never a requirement, since it is
not universally available.

## 4. Gemini CLI

Same shape, different names: settings JSON for the endpoint, `GEMINI.md` in place of `CLAUDE.md`,
same hook events (open-source TS, so the surface is inspectable and the mapping is mechanical). The
MCP server is shared between both. WS-E should build the Claude Code and Gemini recipes from **one
parameterized hook adapter** — the shapes are close enough that a second hand-rolled integration is
a waste.

## 5. The MCP server (universal Tier 1)

One server, usable from every agent that speaks MCP. Tools:

| Tool | Purpose | Tier |
|---|---|---|
| `ctx_search` | JIT retrieval over the artifact store — **don't compress, don't fetch** | 3 |
| `ctx_get_task` | Fetch a full transcript range that was compacted away (reversibility) | — |
| `ctx_get_artifact` | Resolve `artifact://` pointers to content | — |
| `ctx_note` | Write a note into the memory tiers | 3 |
| `ctx_status` | Current token budget, compaction count, pin status, savings today | — |
| `ctx_remember` | Explicitly promote something to a durable tier | 3 |

`ctx_get_task` is the escape hatch that makes aggressive compression *safe* to ship: any time a
refinement turn needs detail it no longer has, the agent can pull the original back. This is how we
honor the Focus finding that iterative-refinement tasks *degrade* under compression.

## 6. GitHub Copilot — the honest assessment

Copilot's VS Code extension is closed-source with no lifecycle hooks. Three partial paths, in
descending order of practicality:

1. **MCP only.** Copilot supports MCP servers. The agent can *choose* to call `ctx_search` /
   `ctx_get_task`. This works but is **advisory** — we can't enforce dedupe, truncation, or pinning
   on context the model already has. Governance pinning is **not achievable** on this path, and we
   must say so plainly rather than implying coverage.
2. **Network proxy via VS Code `http.proxy`.** Routes editor traffic through the gateway. Works
   technically; requires a local CA for TLS interception; brittle across extension updates; and
   carries a genuine risk of leaking unrelated editor traffic through a tool the user installed for
   AI context management. **Offer only as an explicit, documented opt-in.**
3. **Programmatic Copilot API/CLI.** If the user has API access, this is just another OpenAI-
   compatible target and the proxy covers it cleanly.

**Recommendation:** ship Copilot as **MCP-only, explicitly labelled "no governance guarantee."** Do
not build the TLS-interception path in v1. If a Copilot user installs this, they get compression and
retrieval; they do not get the safety property, and the docs must say so in those words.

## 7. Provider adapters

Independent of which agent is on the other end. The gateway normalizes, applies policy, and
denormalizes.

| Adapter | In | Out | Notes |
|---|---|---|---|
| `anthropic` | Messages API | Messages API | Beta headers, `cache_control` preservation, tool_use/tool_result blocks |
| `gemini` | `generateContent` | `generateContent` | `functionCall`/`functionResponse`, different part model |
| `openai-compat` | `/chat/completions` | `/chat/completions` | `tool_calls`/`role:tool`; also the shape most third-party agents use |
| `mock` | fixtures | fixtures | **required for the eval suite** — deterministic, zero cost |

`mock` is not a nice-to-have. The A/B harness in WS-F is built entirely on it: both arms replay
recorded fixtures, so the harness itself costs nothing and is perfectly reproducible.

## 8. Configuration

```yaml
# strata-ctx.yaml
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
    on_detect: block             # block | placeholder   (never log the secret)

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
  pointerize_files: true         # big file reads → artifact:// + sha
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
  machine_format: toon_or_csv    # never applied to reasoning text — see diversity tax

canary:
  constraint_probe: { enabled: true, interval_turns: 25 }
  rot_probe: { enabled: true, interval_turns: 50 }
  include_soft_org_policies: true   # decay is 8.3x worse here; hard norms give a false green

telemetry:
  enabled: true
  egress: none                   # local only; no default network calls, ever
  file: ./.ctx/telemetry.jsonl
```

**Two config lines are non-negotiable and must not have a "just this once" escape hatch:**

- `local_model.fields` excludes `constraints` by construction. The type should make it impossible
  to pass a governance field to a model — see WS-D.
- `token_compression.enabled: false` by default, because gains only materialize beyond ~5k tokens
  and the compressor's own latency can exceed the saving below that.
