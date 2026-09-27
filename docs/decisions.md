# Decisions — ADRs, Open Questions & Risks

*[Spec](spec.md) · [Architecture](architecture.md) · [Development](development.md) · [Evaluation](evaluation.md)*

---

## 1. Open questions — need a decision, with an owner and a date

| # | Question | Default if unanswered | Owner |
|---|---|---|---|
| Q1 | Which model(s) for the primary A/B claim? | One pinned frontier model; a second is a *secondary* claim only | Eng 2 |
| Q2 | License for the 3 eval repos? | Public-permissive only; no copyleft tasks | Swarm + legal-ish review |
| Q3 | Do we ship the artifact store encrypted at rest? | **Yes** — it holds raw transcripts, which is the most sensitive thing we touch | Eng 1 |
| Q4 | Retention default for the artifact store? | 14 days, GC'd, purge log retained (see R9) | Eng 2 |
| Q5 | Multi-user / shared machine story? | Single-user, `127.0.0.1`-bound, refuse non-loopback binds unless `--i-understand` | Eng 1 |
| Q6 | Does pinning extend to *user preferences* or only hard policy? | Policy only by default; preferences are pinnable but off — a wrong preference pin is sticky | WS-D |
| Q7 | What is our position if a provider's own compaction (e.g. Claude Code's) is *worse* than ours? | Observe and report, never fight it — we're the layer beneath, not a replacement | Eng 1 |
| Q8 | Do we support multi-agent (sub-agent) sessions? | Out of scope v1. A sub-agent is a separate context; composable but unvalidated. Log it as a v2 project. | — |

## 2. Risk register

| # | Risk | L | I | Mitigation | Trigger |
|---|---|---|---|---|---|
| **R1** | **Negative control doesn't reproduce the violation phenomenon** | M | **Critical** | E1 is a release blocker (G1). Reuse the released ConstraintRot benchmark + Compaction Cliff reference implementation rather than inventing a weaker harness. | G1 < 25% |
| **R2** | Compression degrades **iterative refinement** tasks | **H** | High | E4 refinement category is a hard gate (G4); reversibility (`ctx_get_task`, C-5) is mandatory; conservative policy for refine-heavy projects | G4 fails |
| **R3** | **Net cost goes up** after gist + probe cost | M | High | E5 reports net, not gross; canary cadence gated on session length; publish the crossover point | G7 fails |
| **R4** | **Provider cache invalidation** destroys the economics silently | M | High | `cache_control` preserved in the canonical model; transforms prefix-preserving or cache-aware (A-13); `prefix_invalidated` telemetry from day one; G12 | G12 > 5% |
| **R5** | Contract churn after the Wave 0 freeze | M | **Critical** | J-3 fails CI on any post-freeze change without a sign-off file; semver discipline (J-5) | Any CI contract failure |
| **R6** | **Scope creep into a memory product** | **H** | High | Non-goals are explicit in `spec` §4; reject any PR touching retrieval/substrate; log as a v2 project instead | Any such PR |
| **R7** | Credential leakage | L | **Critical** | Never log auth headers (A-15, G-7); redaction in every sink; `credentials: passthrough` means we never persist them | Any secret in telemetry |
| **R8** | Gist-borne **persistent injection** | M | High | Gist fields are untrusted data at render time (I-6); a gist can never set policy or permission; `constraints` is a verification target, never a model output | Any policy change traced to a gist |
| **R9** | **"Remove all logs" vs. audit obligations** | **H** | Medium | See §3. The tool does not silently delete what it flags as retain-worthy (I-8); `meta-purge` exists but is explicit (I-7) | User request |
| **R10** | Agent extension surfaces drift | **H** | Medium | `surface-check` weekly CI (E-8, J-6); pin last-known-good; proxy is the durable floor | E-8 failure |
| **R11** | Copilot expectations exceed what we can deliver there | M | Medium | MCP-only, explicitly labelled **"no governance guarantee"**; refuse the TLS-interception path in v1 | User confusion |
| **R12** | **fsync-before-evict** bug loses user evidence | L | **Critical** | C-2/C-3: assert `raw_recoverable` before evict; test with an injected store-write failure; abort → keep transcript | Any evict without a store write |
| **R13** | TOON/TRON models aren't natively trained on the format | **H** | Medium | H-8 per-model support registry, unknown ⇒ JSON; H-7 bounded repair path; E3 allowed to kill the feature | E3 fidelity failure |
| **R14** | Structured-output **diversity tax** biases answers | M | Medium | H-3 classifier never TOON-ifies reasoning prose; YAML/CSV-shaped when diversity matters; E3 measures it directly | E3 entropy drop |
| **R15** | Underpowered studies reported as "no difference" | M | High | F1-3 reports **inconclusive** explicitly; CIs in every report; pre-registered margins (F2-2 auto-generates) | Any CI covering the margin |
| **R16** | Contract/WS-D reviewer is also the compression author | M | **Critical** | Rule P3 in `development` §2 — separate reviewer, WS-D veto. This is the control for the whole product claim. | Same reviewer on both |
| **R17** | Fixture replay misleads (no real reasoning) | **H** | Medium | Fixture layers for logic; **live A/B for `ε`, Tier 3, and model behaviour**; never report fixture `ε` as production | Any fixture `ε` in marketing |
| **R18** | Two engineers is fragile (illness, attrition) | M | High | Contract-first design means a single owner can hold a stream; docs and ADR log are the handoff; no knowledge only in one head | — |

## 3. The "delete all the logs" tension — explicit position

The original brief asked for removing logs and junk after task completion. The research forces a
distinction the product must respect, so this is written down rather than discovered later:

| Class | Examples | Post-task behaviour |
|---|---|---|
| **Ephemeral context** | tool output, intermediate reasoning, scratch narration, duplicate reads | **Evict** — the default, safe, and what the product is for |
| **Durable memory** | gists, decisions, `current_values`, artifacts | **Retain** by design (tiers + promotion, `05-gist`) |
| **Audit / security / legal** | auth events, policy-violation records, purge log | **Retain by default**, flagged, never silently deleted |

So the product does what was asked — the working context is cleaned after every task — while being
explicit that "everything, forever" is not one setting. Three consequences:

1. I-7 ships a **`meta-purge`**: purge the purge log too, for users with a genuine obligation to
   erase. It is explicit and logged-before-erasure precisely so its own use is auditable.
2. I-8: the tool **never silently deletes** something it flags as retain-worthy. It asks.
3. The purge log itself is the interesting case — a record that you deleted things is itself a
   record. We think that's correct, we think it's worth a conversation, and we make it a flag
   rather than a policy.

**Open for the user (Q4/R9):** what's the right default retention for your deployment, and does the
purge-log behaviour meet your obligation? This needs an answer before v1, not after.

## 4. Architecture decision record

| ID | Decision | Status | Rationale | Revisit if |
|---|---|---|---|---|
| ADR-1 | Local reverse proxy as the primary insertion point | Accepted | Only mechanism that covers agents we don't control | — |
| ADR-2 | TypeScript monorepo | Accepted | Every target extension surface is TS/JS | A component needs Rust for perf (see ADR-9) |
| ADR-3 | `core-types` frozen at M0 | Accepted | The only thing that makes 10-way parallelism work | R5 materializes |
| ADR-4 | Governance as a **type**, not a flag | Accepted | Makes the bug unrepresentable | — |
| ADR-5 | Constraint pinning by **replace, not merge** | Accepted | Makes gist-borne policy injection impossible | — |
| ADR-6 | Self-gist as the default narrative path | Accepted | ~200 tokens, zero extra calls; E4 tests it head-to-head | E4 shows a summarizer wins by more than it costs |
| ADR-7 | Deterministic-before-learned pipeline order | Accepted | Free, faster, auditable, safer; matches CWL's result | — |
| ADR-8 | Fail-open on stage errors | Accepted | Never lose user context to save tokens | — |
| ADR-9 | No Rust in v1 | Accepted | Node 20 is fast enough; premature native code adds build burden | p95 gate (G8) fails on the pipeline specifically |
| ADR-10 | Non-inferiority margin pre-registered at −2pp | Accepted | Prevents post-hoc margin shopping | — |
| ADR-11 | Compaction **off by default**, enabled per-project | **Proposed** | Fresh installs rot before they overflow; a first-run surprise is a bad first run. Propose: telemetry + Tier 0 + pinning on by default; auto-compaction requires explicit opt-in. | Usability testing |
| ADR-12 | Copilot: MCP-only, no TLS interception in v1 | Accepted | Cannot meet the security claim there; don't imply otherwise | A legitimate, documented need appears |
| ADR-13 | Ship the eval harness to users (`strata eval`) | Accepted | Answers "how does it perform for *me*"; strongest defense against eval-transferability criticism | — |
| ADR-14 | Negative control as a release blocker | Accepted | A suite that passes in both arms proves nothing | Never |
| ADR-15 | Three arms, not two (Control, Control+, Treatment) | Accepted | Proves the hazard is real *in our harness* and that our intervention removes it | — |
| ADR-16 | Output transform at the tool/MCP boundary, not the response stream | Accepted | Streaming makes post-hoc response rewriting impossible | A non-streaming-only mode is acceptable to all target agents |

### ADR-11 needs your call

**Proposal:** Tier 0 compression, pinning, telemetry, and canaries **on** by default; **automatic
compaction off** until the user opts in (per project).

Reasoning: rot begins well before overflow, so Tier 0 + pinning is pure upside with no behavioural
surprise. But auto-compaction is a *visible* behaviour change — the agent starts forgetting, and a
user who didn't ask for that will be alarmed. The telemetry shows them the problem first, then they
opt in. It also happens to match the Fail-safe-over-convenient principle, and it means our first
real-world sessions are the ones least likely to produce a bad report about us.

Alternatives: (a) everything on by default — maximum benefit, maximum surprise; (b) everything off —
safe but then the product does nothing until configured, and most users won't configure it.
