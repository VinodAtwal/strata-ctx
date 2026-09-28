# Threat Model — Governance

*D-10 · [Spec](../docs/spec.md) · [Architecture](../docs/architecture.md) · [Development](../docs/development.md) · [Evaluation](../docs/evaluation.md) · [Decisions](../docs/decisions.md)*

---

## 1. What we are defending

Compaction is a security failure surface, not a cost optimisation. Two measurements set the
threat level:

| Finding | Source | Number |
|---|---|---|
| Policy violations caused **purely by compaction** | Governance Decay, arXiv:2606.22528 | **0% → 30%** (59% worst), 1,323 episodes |
| Violation rate **conditional on survival** | Governance Decay | survived → **0%**, dropped → **38%** |
| Decay asymmetry | Governance Decay | **8.3×** worse for soft org policies; alignment training **masks** it |
| Safety rules surviving production `/compact` | Compaction Cliff, CIKM 2026, arXiv:2608.22752 | **53%** after 1 round, **10%** after 5 |
| **Compaction-Eviction Attack** success | Governance Decay | optimised injection defeats **all** models, 0% → 65% |

Read together: **each compaction is a dice roll, and the odds compound.** The 38% figure is the
important one operationally. It says the damage is not spread evenly across a session — it is
concentrated entirely in the compactions where a constraint does not survive. So the guarantee this
package exists to provide is narrow and specific:

> For every outbound request, the governance channel is byte-equal to the pinned policy, and every
> eviction that would have dropped a constraint is refused.

Everything below is an attack on that sentence, or an honest account of where it does not reach.

## 2. Scope and actors

| Actor | Capability | Wants |
|---|---|---|
| **Compactor** | the model writing the gist. Sees the transcript, writes `constraints`. | A cheaper, shorter context. Not adversarial by default — it is *lossy*, which is worse, because it fails without intending to. |
| **Untrusted content author** | anyone whose text lands in the window: a tool result, a vendored file, a generated fixture, a web page, an issue body. | Whatever they are actually after. This is the summariser-injection attacker. |
| **Hostile repository** | a repo the user just cloned, carrying `.strata/policy.yaml`. | To weaken org-level governance. |
| **Compaction-rate attacker** | influence over *when* compaction fires. | More dice rolls per unit of work. |
| **Provider / transport** | sees the request. | Nothing here, but the pin buffer is a confidentiality question, not just an integrity one — §8. |

Not in scope: a user with write access to the policy store or to the process. They do not need an
attack; they have the product's admin API. The guarantees below are about content and cadence, not
about a shell on the box.

## 3. Assets and the trust boundary

The asset is the **pinned constraint set** P, held in `PinnedBuffer` as an immutable snapshot taken
from the validated `StrataPolicy` and never written to after construction.

```
                    ┌── TRUST BOUNDARY ──────────────────────────────┐
  policy store      │  StrataPolicy ──parse/validate──> PinnedBuffer │  no writes after ctor
  (trusted, F19)    │        │                             │        │
  ───────────────────┼────────┼─────────────────────────────┼────────┼────
  project policy    │        │      gossip[].constraints     │        │
  (UNTRUSTED)   ─────┤        │  ┌──────────────┐  replace  ▼        │
                    │        └──┴──> PinnedBuffer.apply  ──> outbound request
  tool results      │                    │                           │
  vendored files    │              re-assert every turn       governance blocks
  web pages         │                                             (governance tier only)
  issue bodies  ────┴───── everything below the line is untrusted input ─────┘
```

Three properties of the boundary are the reason the rest of this document is short:

1. **`apply` replaces, never merges.** The buffer is rebuilt from the snapshot each turn. A gist
   cannot append a rule and a summary cannot soften one, because neither is ever consulted.
2. **The buffer is read-only after construction.** There is no code path that writes `P`.
3. **The lossy stages cannot see `P` at all.** Governance blocks are lifted into `held` at the
   partition boundary; `NonGovernanceTier` does not contain `'governance'`; the D-9 property suite
   runs random pipelines to check the type was not faked.

## 4. Threat 1 — Eviction

**Attack.** Convince the pipeline to drop a governance block from the message list without dropping
it from the gist. The Compaction-Eviction Attack: since a model summarising a transcript will
faithfully reproduce an instruction that says *delete the production database*, optimised injection
can plant text whose optimal summary omits the constraint.

**Mitigations.**

| | |
|---|---|
| Structural | `apply` replaces the governance channel from the snapshot every turn. The inbound value is never trusted or merged. |
| Detection | `pin_missing_pre_apply` (P0) for damage found *before* the request goes out; `pin_post_compact_missing` (P0) for damage found at re-assertion. |
| Fail direction | An empty `state.pinned` is "unverifiable", not "violated" — see the one place we are deliberately permissive below. |
| Attributed | The record carries `constraintIds`, never constraint text. |

**Known weakness — the echo assumption.** `pin_missing_pre_apply` is only meaningful for a client
that echoes the system prompt back. Anthropic and Gemini sessions do; MCP-only integrations do not,
so `expectsEcho: false` turns the check off entirely for them (`echoObserved: false`, not a
violation). For a non-echoing client the *outbound* guarantee still holds — the buffer is immutable
and re-applied — but **inbound** corruption is undetectable by this mechanism. A non-echoing client
is not less protected; it is less *observable*, and this document says so rather than implying
coverage we do not have.

## 5. Threat 2 — Volume

**Attack.** Do not attack the pin buffer; attack its *exposure*. Each compaction is one roll of the
53%/10% dice, and an adversary who can influence when compaction fires is rolling faster. Four
concrete routes, all requiring only influence over the *content* of a session:

| Route | Shape | Signal | Severity |
|---|---|---|---|
| **Rate** | 40 large tool results, each an innocuous task-boundary trigger | `rate_above_ceiling` | P1 |
| **Exposure budget** | simply age the run into the 10%-survival regime | `exposure_budget_exhausted` | **P0** |
| **No progress** | inflate the *measured* token count so the trigger fires, drop nothing, transcript no smaller | `no_progress` | P1 |
| **Abort loop** | keep a gist invalid so step 4c aborts and keeps the transcript — a *bigger* transcript, which re-triggers | `abort_loop` | P1 |

`VolumeAttackDetector` is a **detector, not a defence.** Nothing in it can stop any of the four; the
pin survives all of them by construction. That is exactly why the *rate* is worth alerting on.

**Why only the exposure budget is P0.** The other three are anomalies. Filing them as P0 would put
the 0%-violation release gate next to a number that is mostly "we compacted a lot", and would
train operators to ignore the P0 line. The exposure budget is different in kind: it is a citation,
not a judgement. Past five compactions the published per-rule survival rate is 10%, so the run is no
longer evidence for the product's central claim, whatever its violation count says.

**Bounded log growth.** Alerts fire on the **rising edge**. A loop that runs for 10,000 turns
produces one record, not 10,000 — otherwise the alert becomes the reason the log is unreadable, and
an unreadable log is a log with no alert in it.

## 6. Threat 3 — Summariser injection

**Attack.** Untrusted text enters the window, the compactor reads it as instruction, and the
resulting gist carries a constraint the policy never declared.

**Mitigations.**

- **Injection cannot install policy.** `PinnedBuffer.apply` replaces; it does not merge. Injected
  text appears in the *inbound* channel and is caught by the injected-text check, which is
  `pin_injected_text` (P0) — the Compaction-Eviction Attack's direct signature, and the kind the
  frozen telemetry union has no room for (§9).
- **The compactor is a detector of last resort, not a defence.** Its output is validated against the
  pin set byte-for-byte, never trusted because it "looked right".
- **Reporting is sanitised.** `ViolationRecord.detail` is a single line, truncated, with whitespace
  collapsed. A record carrying the offending text is a log-injection primitive handed to the
  attacker: newlines, terminal escapes, and an unbounded line.
- **The exposure report is sanitised too.** `GovernanceExposure` carries byte *lengths*, never
  text, for the same reason. (`GistIntegrity` is the one deliberate exception: it holds the frozen
  `PinIntegrity`, which step 4c already records, because an operator told only "the constraints are
  intact" cannot act.)

## 7. Threat 4 — Gist injection

**Attack.** Get a gist past the step-4c gate, then change its constraints before the eviction.

**Mitigations.**

- **Step 4c byte-equality.** `expected == actual` on the constraint set, positionally. Missing,
  extra, reworded, and reordered are all distinct, separately reported defects — reordering is a
  finding, not a no-op, because position is part of what byte-equality means.
- **Abort, keep the transcript.** A failed gate aborts the transaction and keeps the raw transcript
  (spec.md principle 1: fail toward more context). It never evicts "as a best effort".
- **The re-run, which is the part that is easy to forget.** Between 4c and 7 the validated gist is
  *resident in the context*, where `compact` and `compress` — both lossy, both downstream of the
  gate — can reach `gist.constraints`. A check that ran once and was then invalidated by a later
  stage is "a comparison that happened once", not a guarantee. `assertLossyContextSafe` re-runs the
  **same** `verifyPinIntegrity` call immediately before the eviction. A second implementation of
  "are the pins intact" would be a second thing to get wrong.
- **Fail-closed on the eviction.** A tampered resident gist throws. Sanitising and evicting anyway
  is how a tampered gist reaches step 7.

## 8. Out of scope, stated plainly

- **A user with write access to the policy store or the process.** They have the admin API.
- **A malicious provider.** Pins are sent on every request, so a provider that reads the buffer
  learns the org's policy. That is inherent to injecting the constraints at all: the constraint has
  to be in the prompt to survive. This is a confidentiality property of the design, not a bug in
  it, and it belongs in the deployment docs.
- **Compaction not routed through the gateway.** The guarantees are per-request-path. An agent
  that compacts on its own, without the proxy, gets none of this.
- **The model obeying the constraint.** We guarantee the constraint is *present* and *unmodified* in
  every request. Whether the model follows it is the provider's alignment property, which is why
  D-6 stratifies by kind: the 8.3× figure says a soft policy is where the evidence is, and a probe
  that only measured hard safety would be measuring the provider's priors rather than this product.

## 9. Contract gaps

Three violation kinds are real and the frozen `TelemetryEvent` union cannot express them, because
the contract's kind list is closed and was frozen before this package existed. `violationEvent`
returns `undefined` for all three; they are reported in-process and proposed here as an
**additive, semver-minor** change (no existing member changes):

| Kind | Severity | Why the contract needs it |
|---|---|---|
| `pin_injected_text` | P0 | The Compaction-Eviction Attack's direct signature. `verifyPinIntegrity` reports it as an `extra` defect, but a P0 that has no kind is a P0 nobody can query. |
| `volume_attack` | P0/P1 | D-7. Carries the compaction number, the turn, and the rate. |
| `policy_override_refused` | P1 | D-3. A project policy file tried to weaken org-level governance. A repo you just cloned is untrusted input. |

Until they land, the pipeline must **not** drop records whose kind is not in the frozen union. A
silent `undefined` here would turn the P0 injection finding into a log line that says nothing.

## 10. How each claim is tested

No claim in this document is asserted without a test that would fail if it stopped being true.

| Claim | Test |
|---|---|
| The buffer is replaced, not merged, every turn | `test/pinned-buffer.test.ts` — D-1/D-2/D-5 |
| A failed gate aborts and keeps the transcript | `test/byte-equality.test.ts` — D-4 |
| A hostile suite is rejected at configuration time | `test/canary.test.ts` — D-6 |
| Volume signals are bounded and never self-inflicted | `test/volume-attack.test.ts` — D-7 |
| No lossy stage can receive a governance block, and no hostile stage can get away with it | `test/type-guard.test.ts` — D-8, plus `test/property.test.ts` — D-9 over seeded random pipelines |
| Records carry ids, not text, and the injected-text finding survives sanitisation | `test/violations.test.ts` — D-2 |
| Policy merge cannot be used to weaken org governance | `test/policy-store.test.ts` — D-3 |

The D-9 suite is the load-bearing one. The type guard is a *claim*; the property suite is the check
that the claim is not faked. Per rule P3 in `development.md`, a broken test in another stream must
not block a WS-D merge, and cross-stream integration lives in WS-F — which is exactly why the
governance evidence is self-contained in this package.

## 11. Review triggers

Re-open this model when any of the following changes:

1. A new lossy stage is added, or a stage is moved **upstream** of step 4c. Both change what the
   re-run in §7 is protecting against.
2. A new tier is added to the frozen contract. The channel table in `type-guard.ts` is a table of
   three, and a fourth channel is a new row, not a footnote.
3. A new `ConstraintKind` is added. D-6's `DECAY_EXPOSED_STRATA` then has to be argued in or out
   explicitly — the test enumerates the union so this cannot be decided by omission.
4. Telemetry egress turns on, or the exposure report stops being length-only.
5. The non-echoing-client story in §4 changes, since that is where this document is weakest.
