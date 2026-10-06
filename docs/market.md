# The market, the gap, and what it would take

*An honest read of where this product sits. Written to be useful if the answer is "no."*

**Purpose.** This document is the one to argue *against*. It states where the money and the
pressure are, what already exists that could do this job, and the specific reasons this might be
the wrong bet. A market document that only argues for the product is marketing wearing a
document's clothes.

Numbers attributed to published research are cited by identifier in [`spec.md`](spec.md) §1 and
[`NOTICE`](../NOTICE) — not restated here, because a number that lives in two places is a number
that will be wrong in one of them. Current project state comes from `npm run status`.

---

## 1. Who has this problem

Not "every developer." That's not a market. Here is who actually feels it:

**Long-horizon agent users.** People running an agent for hours — refactors, migrations, debugging
a gnarly failure — where the transcript genuinely exceeds a window and compaction kicks in
repeatedly. If your sessions are 20 minutes, you have a mild version of this problem.

**Regulated and high-blast-radius environments.** Healthcare, finance, defence, critical
infrastructure, and anywhere with a documented policy that an agent must follow. Here "did
compaction drop a rule" is not a quality complaint, it's an incident.

**Platform and tooling teams** shipping agents to other people, where they *cannot* inspect what
each user's compaction did. This is the strongest version of the problem, because the vendor owns
the answer and currently has no way to get it.

**Enterprise buyers** who have already discovered the problem the hard way — usually via an
incident, a near-miss, or a failed security review that asked "prove your agent still follows the
policy after 500 turns."

**Cost-sensitive high-volume users.** Token spend at volume makes context reduction an
accounting line item rather than a preference.

### What they have today

| Category | What it does | Why it's insufficient |
|---|---|---|
| **Framework compaction** (Claude Code, Aider, Cline) | Summarizes the transcript when the window fills | Cannot say whether rules survived; cannot reverse it; no cost accounting |
| **Long-context models** | Just make the window bigger | Rot happens continuously, not at the boundary. Cost grows linearly. Needle-in-a-haystack tests *overstate* long-context ability |
| **Memory / retrieval products** (Mem0, Zep, LangMem and similar) | Retrieve relevant facts across sessions | A different job. Doesn't touch what happens during a single session's compaction. Doesn't do policy |
| **Prompt-version management** | Manage and diff prompts | Constraints live in prompts, but nothing verifies they survived |
| **LLM guardrails** (NeMo, Guardrails AI) | Check inputs and outputs against rules | Works *around* the model, not on the context it was given. Doesn't know a rule was summarized away |
| **Observability** (LangSmith, Langfuse) | Traces, latency, token counts | Excellent at showing *cost*. Blind to *correctness* after compaction |
| **CI / policy-as-code** (OPA, etc.) | Enforce policy on infrastructure | Applies to deploys, not to an agent's working context |

The honest read: **the observability half is well-served, and the correctness half is not served at
all.** That is where the gap is, and it's a narrower gap than "AI safety" but a more defensible one.

---

## 2. The gap, precisely

> Every agent compresses. Almost none can tell you whether the compression was safe, whether it
> cost you accuracy, or what it actually saved.

Three sub-gaps, in increasing order of how hard they are to close:

**Gap 1 — Safety survives compaction?** Solvable today, deterministically, with a pinned buffer
and byte-equality validation. This is the wedge. It's boring, it's testable, and it's the thing
the research says matters most.

**Gap 2 — What did it cost me?** Solvable, but only honestly. You need paired A/B runs and net cost
accounting, which means an eval harness rather than a feature. This is where most of the actual
engineering effort in this repo has gone, and it's why the project has more test infrastructure
than product surface.

**Gap 3 — Did it make my agent worse?** Genuinely hard. Requires real reasoning, not fixture
replay. A fixture replay tells you about string handling; it tells you nothing about whether the
agent is still good at the task. This is why the live campaign is a release blocker rather than a
nice-to-have.

### Why the market hasn't closed this

Not lack of awareness — the research is published and cited. Three reasons:

1. **The harm is invisible by construction.** Nobody notices a constraint that was dropped, because
   the agent then behaves plausibly while violating it. The failure mode has no alarm.
2. **Soft policies decay worse and are measured least.** Alignment training keeps hard safety norms
   visible, so teams check those, see green, and ship. The organizational rules rot in silence.
3. **The buyer and the sufferer are different people.** The developer whose session degraded isn't
   the person who signs the security review. The gap survives the handoff.

### Where the money plausibly is

- **Platform / OEM embedding.** An agent vendor who needs to answer "prove policy survived" for
  enterprise customers. Largest contract size, longest sales cycle.
- **Compliance-driven add-on.** Sold against an audit finding rather than a feature request.
- **Cost reduction at volume.** Weakest differentiation — observability vendors already sell this.
- **Internal platform teams at large engineering orgs.** Small market, fast decisions, reference
  customers.

**The honest ranking: safety and compliance is the wedge, cost is the entry price.** Leading with
cost puts you in a fight with well-funded observability companies on their strongest ground. Leading
with "your agent silently drops safety rules" is a differentiated claim with evidence behind it.

---

## 3. What would have to be true

Conditions, not predictions. Stated so you can reject them.

### Must be true

**1. Deterministic compression is non-inferior on real tasks.** If Tier 0 makes agents measurably
worse, the whole product is a trade nobody wants. This is a hard release gate, and it is currently
**unverified** — no live campaign has run.

**2. Pinning survives in practice, not just in tests.** The mechanism is deterministic and the
research backs it. But "survives compaction" must hold for *your* agent's *actual* compaction, and
the research says rules survive ordinary compaction about half the time — meaning we have to beat
a specific, measured baseline.

**3. Someone will pay for the correctness half.** If the answer is "teams are happy with framework
compaction," the market is smaller than the research suggests.

### The honest risks

| Risk | Severity | Current state |
|---|---|---|
| Compression degrades iterative refinement | High | Known failure mode, hard gate, **unmeasured live** |
| Net cost goes *up* after gist + probe cost | Medium | Accounting is built; breakeven unproven on real traffic |
| The framework vendors fix this upstream | Medium | Plausible. Anthropic owns Claude Code and could ship pinning |
| Provenance: arXiv identifiers in `NOTICE` | Resolved | **Verified** — both identifiers resolve and their contents match the claims made here; see [`risk-analysis.md`](risk-analysis.md) §7 |
| Adoption friction: one more proxy in the path | High | Real. See `operations.md` factors 1–3 |
| Two-engineer fragility | Medium | Contract-first design mitigates; doesn't eliminate |

That provenance row was open and is now closed. Both cited papers were retrieved and read: the
governance-decay result (compaction-induced policy violation rising from 0% to 30%, up to 59% for
some models, across 1,323 episodes) and the compaction-cliff result (safety-rule recall falling from
53% to 10% over five compaction rounds) are stated as their abstracts report them. Full reference
table, with the specific figures relied on, is in [`risk-analysis.md`](risk-analysis.md) §7. Keep
that table in step with any new citation rather than adding numbers here.

---

## 4. Why not just build the guardrail

The adjacent, easier product: a middleware that checks outputs against rules and blocks bad ones.

**Why that's a worse business.** Guardrail products are crowded, and their differentiation is
model quality — which is a losing contest. More importantly, a post-hoc guardrail cannot fix a
constraint that was *never in the context*. It can only catch violations that already happened, and
only for rules it can mechanically match.

**Why the context-side position is defensible.** The research's strongest finding is that violation
rate is a function of **constraint survival** — 0% when it survives, 38% when it doesn't. That makes
constraint survival the causal variable, and a middleware that inspects after the fact is
downstream of the actual cause.

**The synthesis, eventually.** Guardrails are the natural second product: if you control what enters
the context, you can also enforce on what leaves it. Neither is strong alone; together they're a
platform. But that's a two-product story, and the second one is worthless if the first isn't true.

---

## 5. What would falsify this

Stated up front, because a thesis that can't be killed isn't a thesis.

- A frontier vendor ships verifiable constraint persistence in their own agent, and customers stop
  looking for third parties. **This is the most likely way this fails.**
- Live A/B shows deterministic Tier 0 compression is measurably worse on real coding tasks. Then the
  honest product is pinning-only, and pinning-only is a feature, not a company.
- Guardrail vendors absorb context-aware checking and the wedge disappears.
- The compliance buyer turns out not to buy developer tools. Possible, and cheap to test.

---

## 6. The recommendation

**Build it if** you can get a live campaign run — that's the single thing that converts this from a
well-reasoned thesis to a measured product. Everything else is engineering, and the engineering is
in good shape.

**Don't build it if** you're looking for a large market that moves fast. This is a
high-trust, evidence-led product for people who are already burned. Those buyers exist and they
convert, but they are not numerous, and they will ask for the A/B numbers before they ask about the
architecture.

**The narrowest honest version, if forced to choose one thing:** deterministic constraint pinning
with byte-equality validation, on the request path, with per-turn verification. Small. Shippable.
Actually differentiated. Everything else is optional.

---

## Related

- [`how-it-works.md`](how-it-works.md) — what the product does, in plain language
- [`maturity.md`](maturity.md) — what is genuinely done vs. inert, evidence-backed
- [`decisions.md`](decisions.md) §2 — the full risk register with triggers
- [`spec.md`](spec.md) §4 — explicit non-goals, so nobody drifts into a bigger product