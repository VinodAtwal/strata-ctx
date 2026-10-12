# What each capability can do to you, both ways

*Every mechanism here changes the prompt your model sees. That is the product. It is also the entire
attack surface.*

**The argument.** A context proxy that silently rewrites history is indistinguishable from a
context proxy that silently drops your instructions — unless someone can enumerate, per capability,
the ways it helps, the ways it hurts, how you would find out it hurt you, and what stops it. This
document is that enumeration. It exists because the alternative is discovering the bad column by
having it happen to you.

The uncomfortable finding, up front: **most of the scary risks in this system are not reachable
today.** `compact` and the budget trigger are not wired. That is genuinely good news. It is also a
trap, because three of them become live failures *the moment someone wires them* — and the wiring is
the next thing on the board. Those are marked **Latent** below and they are the reason this document
exists in this order.

Companion docs: [`architecture.md`](architecture.md) for how it works, [`visibility.md`](visibility.md)
for what a user sees, [`decisions.md`](decisions.md) for the decision log, [`wiring-ledger.md`](wiring-ledger.md)
for which capability is actually reachable.

---

## 1. How to read this

### Status: the word that decides urgency

| Status | Meaning | Can it bite you today? |
|---|---|---|
| **Live** | Reachable from a reachable file. A user can hit it on the current request path. | Yes |
| **Latent** | Implemented and tested, but no reachable file calls it. | No — **until wired** |
| **Design** | Inherent to the approach. Mitigated by construction; residual risk accepted. | Yes, in a narrower form |

Ordering is by **(latent and about to be wired) > live > accepted design**. A latent high-severity
risk outranks a live low one, because wiring is a scheduled event and a live low risk is a known,
bounded, already-priced cost.

### Severity

**Critical** — governance failure, silent data loss, or a hard API failure with no correct recovery.
**High** — quality or cost regression that a user would describe as "it got worse" without evidence.
**Medium** — bounded and visible. **Low** — cosmetic or theoretical.

### Sources

Findings are tied to code you can read, or to published work. Citations are listed in §7. Claims
about *this repo's current state* are checkable by reading the named file; claims about *the world*
are checkable against the cited paper. Where I could not verify something, I say so instead of
implying it.

---

## 2. Capability register

Thirteen mechanisms, one line each. Detail follows in §3–§5.

| # | Capability | Status | Worst credible outcome | Sev | Primary control |
|---|---|---|---|---|---|
| R1 | Token accounting (`BYTES_PER_TOKEN = 4`) | Live via `core-types`; P0-2 split and P0-2b canary fill done | Compaction fires too late → context-window overflow | **Critical** | **partly fixed** — pessimistic estimator guards `triggerFor`; the canary fill reads an injected one |
| R2 | Tier triage (`triage`) | **Fixed** (P0-3), residual noted | A constraint is defaulted to `episodic` — no classifier ever looked at it — then compacted away | **Critical** | **fixed** — `safety-net.ts` promotes `uncertain`/`constraint`; `promotedToVerbatim` reported |
| R3 | Gist re-injection | Latent | Model-written prose asserts a policy change; summariser rewrites governance | **Critical** | `defendGist`, `assertGistConstraintsIntact` |
| R4 | Budget trigger (`evaluateTrigger`) | Latent | Same as R1; also fires on the wrong boundary | **High** | P0-2 pessimistic input wired |
| R5 | Pointerisation (`pointerizeBlocks`) | Latent | `artifact://` ref published with no bytes behind it | **Critical** | `pending` contract, `runCompactionTransaction` |
| R6 | Fail-open (`runStageFailOpen`) | Live | A stage has been broken for weeks; nobody knows; you believe compression works | **High** | **fixed** — attribution + actionable messages |
| R7 | Output compression (TOON/TRON) | Live | Machine format costs more than the JSON it replaced, and claims a saving | Medium | `breakevenOk`, `do_not_compress` verdict |
| R8 | Eviction + recovery | Latent | Irrecoverable history | **Critical** | *nothing yet — no recovery path exists* |
| R9 | Redaction | Live | A secret format the patterns don't know about reaches disk or a provider | **High** | `RedactionEngine`, certain/advisory split |
| R10 | Cache-prefix diffing | Live | Prefix churn silently destroys the economics | Medium | `assertPrefixPreserved` |
| R11 | Dedupe / role merge | Live | A repeated turn that was *deliberate* gets merged away | High | `mergeAdjacentSameRole`, verbatim tiers |
| R12 | Artifact store + MCP recovery | Latent | Over-broad ACL, or recovery returns a gist that isn't trustworthy | High | `ArtifactAcl`, `LocalityViolationError`, `realpathNearest` |
| R13 | Canary probes | Live | The safety check itself degrades the session it is checking | Medium | `ConstraintCanary`, `evaluateRotProbeValidity` |
| R14 | Canary fill fraction | **Fixed** (P0-2b) | Safety ladder scheduled from an optimistic token count | **High** | **fixed** — required `pessimisticTokens` option, `[0, 1]` clamp, fail-open on a throw |
| R15 | `NO_STAGE` sentinel | Live | Honest "no stage" failures parked in a misleading field | Low | `errors.byCode` separates the populations |

---

## 3. The three that decide whether this product is safe

### R1 — Token accounting under-counts exactly the content this product compresses

**Status: Latent. Highest priority in this document.**

Every token number in the system comes from one constant, `BYTES_PER_TOKEN = 4`, declared twice:
`core-types/src/tokens.ts` and `output-compress/src/cost.ts`.

> **Correction after P0-2.** The sentence above was written from two greps and is wrong. There are
> **three** estimators already, plus a fourth P0-2 added:
>
> | Implementation | chars/token | Direction | Reachable? |
> |---|---|---|---|
> | `core-types/tokens.ts` | 4.0 | **optimistic** for structured data | **Live** — `runner.ts`, `order.ts`, `claude-code.ts` |
> | `output-compress/cost.ts` | 4.0 | n/a, comparative only | Live, correctly scoped to savings |
> | `gateway/token-estimator.ts` per-provider (3.5 / 4.0 / 4.5) | 3.5–4.5 | **pessimistic by choice** | **Unwired** |
> | `pipeline/token-budget.ts` per-character (P0-2) | measured rate | pessimistic, `max()`-guarded | Wired into `triggerFor` |
>
> The gateway module (tracked since `9b948a7`) already states the correct position — "Over-estimating
> is the safe direction: it compacts slightly early and costs a little money" — and picks the
> aggressive end deliberately. Its own `TODO(WS-A, A-6)` concedes the constants are un-fitted
> engineering judgement. **So the correct estimator already existed and was not connected**, while the
> optimistic one was live everywhere. The defect is a missing connection, not a missing idea — which
> is a cheaper fix and a worse oversight.
>
> **A name collision compounds it:** `core-types` and `gateway` each export a function called
> `estimateTokens`, with different constants and opposite safety directions. Anyone reaching for "the
> estimator" can silently get the optimistic one.

The code is honest about why it exists. `cost.ts` says the estimator "is a heuristic and labelled
one: we do not know the provider's tokenizer. It is fine for a *comparison*, which is all this is,
because the two numbers being compared went through the same estimator."

**For the savings comparison, that reasoning is largely sound.** Measuring JSON against TOON with
the same divisor gives a ratio, and a shared bias mostly cancels in a ratio. This is the strongest
part of the design and it should not be changed.

**For budget enforcement, it is wrong, and wrong in a directional, exploitable way.** Measured
tokenizer divergence between two providers' nominally-compatible endpoints:

| Content | Actual ÷ `chars/4` estimate |
|---|---|
| Natural prose | 0.89 – 0.97× (estimate is *pessimistic* — safe) |
| JavaScript / Python | ~0.95× (safe) |
| **JSON** | **1.43 – 1.49×** |
| **Special characters** | **2.43 – 2.49×** |

Two things make this sharp rather than theoretical:

1. **The error is one-sided in the dangerous direction for structured data.** Prose over-counts;
   structured data under-counts by up to 149%. A safety rule that only makes estimates pessimistic
   for prose is not a safety rule.
2. **This product's entire purpose is converting structured data into more structured data.** The
   content most likely to be under-counted is the content we are specifically built to handle.

So when `evaluateTrigger` (`pipeline/src/trigger.ts`) is wired, it will compare an under-counted
`input.tokens` against a real `contextLimit`, decide it is comfortably under budget, decline to
compact, and send a request that exceeds the provider's window. Depending on provider behaviour that
is an HTTP 400 with a clear message, or — worse — silent truncation of the tail of the context, which
is exactly the class of bug this product exists to prevent.

Two amplifiers from the literature: budget overrun is a catalogued production failure class with 63
documented incidents, and worst individual cases include a **31× context overflow from a single
base64-encoded image**. We have `isFileRead` and image handling; we should know this is a live shape.

There is a second, quieter version of the same bug: **we cannot verify our own savings.** `ε` and the
breakeven decision in `breakevenOk` are computed on estimated tokens. If the estimator is
directionally biased differently for JSON than for TOON, the "saving" is wrong in an unknown
direction, and `do_not_compress` fires on the wrong inputs.

**Good, genuinely:** refusing to compress is a first-class verdict here, explicitly tested as an
outcome including negative net savings. A compressor that cannot say "no" is not measuring anything.
That instinct is right and rare.

**How you'd notice:** you'd notice the overflow, because the provider rejects the request. That is
the *lucky* case. You would **not** notice the savings being wrong — that surfaces as "compression
disappoints" with no error anywhere.

**Plan — P0, and it must land before `evaluateTrigger` is wired:**

1. **Split the estimator in two and name them differently.** A *comparative* estimator (current,
   `chars/4`, ratio-safe) for savings claims, and a *pessimistic* estimator for budget decisions. Do
   not let one function serve both, because that is how the reasoning above got muddled.
2. **Make the pessimistic estimator structure-aware.** Apply a content-dependent multiplier from the
   measured table above — base 1.0 for prose, ≥1.5 for JSON-ish, ≥2.5 for special-char-dense — and
   take the max of `chars/4` and the structured estimate, never the min.
3. **Close the loop with ground truth.** The provider returns authoritative `usage` on every
   response. Feed it back as a calibration sample and emit the observed ÷ predicted ratio. This
   converts an open-ended guess into a measured, improving quantity, and it costs nothing.
4. **Never let a budget decision use a non-pessimistic number.** Make that a type-level distinction if
   the codebase allows it; otherwise a named constructor plus a lint rule.
5. **Falsification test:** a table-driven test over the measured content classes asserting the
   pessimistic estimator never returns less than the comparative one, and a calibration test asserting
   the observed ratio lands in the declared band.

The literature is unambiguous that the fix is *more* estimation, not less: adaptive estimation to
2.11× median over-reservation, tokenizer-direct to ~1.0× at ~939–1749 ms latency. We can get closer
than either by exploiting the fact that **we already receive the real count on every single call.**

### R2 — Tier triage is the load-bearing safety component, and it is a heuristic

**Status: Live.**

`triage` assigns each block to one of five tiers, and `TIER_RETENTION` then fixes what may happen to
it. Read that table as the safety policy of the whole product:

```ts
governance:   'verbatim'
user_intent:  'verbatim'
tool_state:   'truncate'
episodic:     'compact'
artifact_ref: 'reference'
```

This is a correct and well-motivated implementation of what the literature independently recommends.
The *Compaction Cliff* paper's Knowledge Triage framework independently arrives at typed knowledge
with per-type distortion tolerance, where Constraints have **zero** distortion tolerance, and shows
typed compaction preserving 2–4× more safety rules than the best single-shot compactor at every ratio,
with 96% recall across five rounds. The *Governance Decay* paper proposes Constraint Pinning —
quarantining governance constraints from lossy compaction — and restores violation rate to 0%.

The published stakes for getting this wrong are large. Across 1,323 episodes and seven model
families, compaction-induced policy violation rose from **0% to 30%**, reaching **59%** for some
models; where the constraint survived the summary violation stayed at 0%, and where it was dropped
violation reached **38%**. Compacting a policy can be *worse than never stating it* (59% against a
37% no-policy floor), because the summary normalises the pending task while discarding the rule. Soft
organisational policies decayed **8.3× more** than hard safety norms — which is the inverse of where
you would want the fragility.

**The specific failure mode this repo is exposed to, and it is not the obvious one.** LLM compactors
handle imperative, conditional, and passive constraint phrasing cleanly (1.00 recall each) but lose
**38–48 absolute points on declarative phrasing**:

> "the patient is allergic to penicillin" — recognised as a constraint by gpt-5.4-mini 62% of the
> time, by a selective cascade 52%, by regex 0%.

A regex cannot save us here, and neither can a well-meaning prompt. Constraints are frequently stated
as *facts*, not commands.

**Correction after P0-3.** The original text said "`classifyBlockText` is a heuristic" and that a
constraint gets "misclassified as `episodic`". That mechanism was wrong in a way that made the bug
look smaller than it is:

- `classifyBlockText` (`severity.ts`) returns a **`Severity`** — `info`/`error`/`fatal` — and has
  **nothing to do with tier assignment**. It is a log-severity reader.
- **No tier classifier existed at all.** `triage.ts` is the whole story:
  `(ALL_TIERS as readonly string[]).includes(b.meta.tier) ? b.meta.tier : 'episodic'` — a block
  whose *producer* declared a tier keeps it, and **anything else defaults to `episodic`**, whose
  retention is `compact`.
- `governance` is not discovered either; it reaches `held` only because a producer explicitly
  declared it and `partitionForLossy` lifted it out of reach.

So the true chain was worse than misclassification:

> a fact-shaped safety constraint in ordinary conversation → **no classifier ever looks at it** →
> default tier `episodic` → `compact` → dropped → agent violates a rule it obeyed correctly one turn
> earlier

Misclassification implies a classifier that could have been right. There was none. The only
non-governance tier that was `verbatim` was `user_intent` (a frozen union member), so a statement
like "the patient is allergic to penicillin" could only reach verbatim by being recorded as *the
task* — which is why `promoteTier` is a new pass rather than a correction to an existing one.

**P0-3 fixed this** with `packages/pipeline/src/safety-net.ts` (deliberately not barrel-exported):
`classifyRetentionText` returning `ordinary`/`uncertain`/`constraint`, and `promoteTier`, which is
structurally unable to return a looser tier (equality refused, `artifact_ref` excluded, retention
table injected so `triage.ts` keeps sole ownership). Uncertain and constraint both promote to
verbatim; `TriageReport` gained `promotedToVerbatim` so a never-firing net is distinguishable from
an always-firing one. 24 tests: declarative recall 9/9, transcribed imperative 14/14, **8 negative
controls at 0** — the negative set is what stops the fix from being satisfied by verbatiming
everything, which would destroy the product. Mutations: fail-open reverts → 6 failures; override
rewritten as a general (demoting) classifier → 8 failures.

**Residual, not fixed:** promotion runs inside `triage`, which is `TIER0_STAGE_ORDER` last — `truncate`
already ran against byte caps by then. Promotion is therefore one turn late for the cap path and on
time for compaction/gist, which is the lossy path R2 was about. Closing the cap gap means ordering
work, not better detection, and is recorded as a follow-up.

**Good, genuinely:** `user_intent` being verbatim rather than merely "tagged" is the right call, and
the comment above `TIER_RETENTION` explains why with the actual principle number. Governance is
`verbatim`, and `assertLossyContextSafe` re-verifies byte-equality of the constraint set on the write
path, refusing to evict raw transcript when a gist no longer matches. That is Constraint Pinning,
implemented.

**How you'd notice:** you would not notice from the outside. It surfaces as an agent doing something
prohibited with no error, no header, and no log entry — the worst possible signal, because there is
nothing to grep for.

**Plan:**

1. **Fail closed on classification uncertainty.** Uncertain → `verbatim`. Uncertain costs tokens;
   wrong costs governance. These must not be weighed equally.
   **DONE (P0-3)** — `classifyRetentionText` yields `ordinary`/`uncertain`/`constraint`, and both
   `uncertain` and `constraint` promote. The wording changed from "when `classifyBlockText` is not
   confident" because that function never had a confidence signal to read — see the correction above.
2. **Add a declarative-constraint detector as a separate, conservative signal.** Not replacing triage
   — *overriding* it upward. Target the shape the paper identifies: first-person-fact constructions,
   `is/has/denies`-style assertions about a subject, and prohibition restated as a fact. This must be
   allowed only to promote a tier toward verbatim, never to demote.
   **DONE (P0-3)** — `promoteTier` structurally cannot loosen: equality refused, `artifact_ref`
   excluded, table injected rather than imported so `triage.ts` keeps sole ownership.
3. **Make the promotion observable.** Emit a count of how many blocks were promoted by the safety
   net, so the intervention rate is visible. A check that never fires and a check that fires always
   are indistinguishable without this number.
   **DONE (P0-3)** — `TriageReport.promotedToVerbatim`, decomposed into
   `promotedUncertain + promotedDeclarative`, so a future operator can tell whether the net is
   catching soft uncertainty or real constraints.
4. **Measure it.** The *Classifier Context Rot* result is the reason: Opus 4.6 monitor recall fell
   from 98.6% to 88% when 800k tokens of benign actions were prepended, with the worst degradation on
   *subtle* mid-transcript violations. A safety classifier evaluated only on short inputs is
   overestimating itself. Add a long-context adversarial tier to the canary suite — R13 is where this
   belongs.

> **Items 1–3 are implemented** as `packages/pipeline/src/safety-net.ts`, wired into triage, with the
> declared recall floor and the promotion count; see §5.1 P0-3 for the premise correction (there was
> no tier classifier to fail closed *on* — `classifyBlockText` classifies log severity) and for the
> two residual findings. Item 4 is open and belongs to R13.
5. **Falsification test:** a corpus of declarative constraints in varied domains, each asserted to
   survive compaction with recall ≥ some declared floor. If triage ever routes one of them to
   `episodic`, the test fails.

### R3 — A gist is the strongest injection primitive in the product

**Status: Latent. Activated by eviction, which is not wired.**

`gist-safety.ts` opens with the correct and uncomfortable observation: a gist is *prose the model
wrote about your code*, about to be re-injected into the next turn as if it were a record of what
happened. "A gist that asserts a constraint is no longer in force is a governance change made by a
summariser, which is exactly the failure the pinned buffer exists to prevent."

The module's governing distinction is sound and worth restating because it resolves a real tension:

- **Mechanical checks are the boundary.** Byte-equality of the constraint set and ACL resolution of
  artifact URIs are exact, both already exist, and *neither can be satisfied by clever text*. A model
  cannot talk its way past a byte comparison.
- **Heuristic checks are reporting.** "This field looks like it is claiming authority" is a signal
  for a human — reported, never enforced — because a heuristic that blocks legitimate work gets
  bypassed.

**Good:** this is the correct resolution. Enforcing heuristics creates a bypass incentive; ignoring
them creates an invisible surface. Report-and-never-enforce plus exact mechanical checks is the
answer most systems get wrong.

**Bad:** the advisory channel is only as good as its visibility. `AdvisoryNotAcknowledgedError`
exists, which implies an acknowledgement loop — and an acknowledgement loop nobody reads is not a
control, it is a log line. See §5.1 for the concrete reason advisories are currently hard to see.

From the adjacent literature, note that editable/regenerated context "can become another channel
through which prompt injections or self-generated instructions persist across turns," and that
optimised Compaction-Eviction injections defeated **every** evaluated model in the Governance Decay
paper. Treat this as a solved-for-mechanically but adversarially-contested boundary.

**Plan:**

1. Keep the mechanical/heuristic split exactly as it is. It is right.
2. **Require operator acknowledgement to be a real gate, not an available error** — and make the
   blocking advisories visible in `strata status` rather than only in the thrown error.
3. **Fuzz `defendGist`** with gist-shaped injections asserting policy changes, with ACL-satisfying
   URIs, and with oversized/nested payloads. A boundary that is only tested on happy-path gists is an
   assumption.
4. **Falsification test:** a gist claiming every constraint is revoked must be refused mechanically,
   with the test asserting on the byte-equality check specifically — not on the heuristic.

---

## 4. The rest of the register

### R4 — Budget trigger fires on the wrong boundary (Latent, High)

`evaluateTrigger` derives soft/hard limits from `contextLimit`, `targetUtilization`, and
`reserveFor`, and already reports `policyMisordered` when soft ≥ hard. **Good:** it refuses to obey a
policy that orders its own thresholds nonsensically, and reports rather than silently proceeding.
**Bad:** it inherits R1 entirely, and a late trigger plus a wrong trigger compounds. It also depends
on `matchTaskBoundarySignals`, so a session with no recognised boundary signal fires purely on token
count, which is the conservative path and should stay that way.
**Detect:** the decision already returns `reason`, `matchedSignals`, `atSoftLimit`, `atHardLimit`.
Nothing consumes them yet.
**Plan:** wire it *after* R1's fix. Emit the whole `TriggerDecision` to telemetry so "why did it fire
/ why did it not" is answerable without reading source. Land a test that a misordered policy refuses.

### R5 — Pointerising with nothing behind the pointer (Latent, Critical)

`pointerizeBlocks` replaces content with `artifact://` refs. The `pending` field carries an unusually
honest contract, quoted from `order.ts`: *"A caller that publishes `state` while this is non-empty has
published a pointer to nothing. So the contract is narrow and absolute: persist these first, or
discard `state` and re-run with `durable: false`."* **Good:** the dangerous case is named, documented,
and made structurally impossible to ignore.
**Bad:** the contract is *caller-honoured*. A crash, an exception, or a forgotten branch between
`pending` and persist yields dangling references whose failure mode is confusing rather than loud —
the next turn asks for an artifact that does not exist.
**Detect:** C-14's new `ArtifactLookup` already distinguishes `malformed_ref` / `absent` /
`unresolved`, which is exactly the right shape of distinction.
**Plan:** make persistence-before-publish an enforced transaction rather than a documented duty —
`runCompactionTransaction` now runs (C-16 supplies the `compact` stage, though compaction ships
`off`); R5 and R8 should be closed together, not separately. Add a startup reconciliation that
detects artifacts referenced but absent.

### R6 — Fail-open is safe for the user's context and dangerous for the operator's trust (Live, High)

`runStageFailOpen` returns the *input* context unmodified when a stage throws, reorders the cached
prefix, or returns a non-`LossyContext`. The stated principle is right: "the user's context is worth
more than the tokens, and an exception is never a reason to lose it."

**Good, genuinely:** this is the correct default, and it is rare to see an exception swallowed in
favour of "do no harm." It also correctly distinguishes the failure codes `prefix_reordered` /
`not_a_lossy_context` / `stage_threw`.

**Bad:** fail-open is a *monitoring* hazard, not a safety hazard. A stage broken for weeks still
returns correct output; you simply stop getting savings and lose all signal that it is broken.
Meanwhile `runner.ts` recognises exactly three codes and funnels **every** other cause into
`stage_threw`, discarding the distinction — and the concrete defect is that the gateway's `fail()`
hardcodes `runId: 'unknown'` and `stage: 'pin'` for *every* failure, so the log attributes all of it
to pinning and to no particular request.

The result is precisely the failure mode this project should never have: **you must read surrounding
log lines to learn what went wrong.** That is R6's real cost, and §5.1 fixes it.

**Plan:** see P0-1 in §5.1.

### R7 — Output compression: the saving may not be a saving (Live, Medium)

`output-compress` is the most honestly-engineered part of the repo. `cost.ts` states plainly that
"gross input reduction is close to meaningless on its own," because a terser structured prompt can
invite a more verbose answer, and output prices at 4–5× input. The decision is `ε < 1 + (1-r)/(ρk)`
via `breakevenOk`, and `do_not_compress` is a first-class, tested verdict.
**Good:** refusing is a success state, not a fallback. H-10 validates the production codec against
the real corpus (30/30 lossless in-domain, 22/22 refusals honoured).
**Bad:** two ways. First, the estimator bias in R1 makes the *magnitude* unverified. Second, the
literal risk of `compress` firing on a block a downstream consumer parses as JSON — TOON is
lossless *to us*, and lossless is not the same as accepted by an arbitrary consumer. This is why
`serialize` is a distinct stage from `compress`: format choice is the consumer's decision.
**Detect:** `classificationDefect` / `jsonDefect` already exist; wire their rates into `strata status`.
**Plan:** do not compress machine-format blocks whose consumer is undeclared. Already the intent;
make it a test.

### R8 — Eviction without recovery is data loss (Latent, Critical)

`recoverTurns` / `recoverEvictedMessages` exist and are unwired. **Good:** recovery was designed
before eviction, which is backwards from most systems and exactly right.
**Bad:** eviction + no recovery = irreversible. The board's own note is the right constraint:
deletion must not be wired without the recovery path.
**Plan:** **P1, non-negotiable: no eviction until `get_artifact` resolves end-to-end from a real
`ArtifactStore`.** This is the single hardest ordering constraint in the project. The read half of
it is now met — 5.2.1 says exactly what is proven — and `recoverEvictedMessages` is still unwired,
so the constraint does not lift with it.

### R9 — Redaction knows prefixes, not secrets (Live, High)

`RedactionEngine` matches documented provider prefixes and shapes ordinary agent output does not
produce, plus a certain/advisory split and `assertGistTrustworthy`.
**Good:** fresh regex per rule per call, specifically to preserve the purity determinism (N6) depends
on — a shared `/g` regex's `lastIndex` is stateful across calls, which would make redaction
non-deterministic. That is a subtle and correct catch.
**Bad:** every pattern is a *known* format. Novel credential shapes escape. And there is an ordering
question this repo has not yet answered: **if compression runs before redaction, TOON's quoting and
delimiters can break a pattern's context**; if redaction runs first, the savings may reintroduce
structure that re-passes unredacted text. Either order has a failure mode.
**Detect:** the redaction marker must survive compression, or `REDACTED` can be optimised away.
**Plan:** redact on ingest *and* re-verify on egress after compression; assert the marker count is
non-decreasing across the pipeline. Add a test that compress(redact(x)) still contains no match.

### R10 — Cache-prefix churn silently destroys the economics (Live, Medium)

`diffCachePrefix` and `assertPrefixPreserved` guard the cached prefix; a stage that reorders it
fails open.
**Good:** caught cheaply, at development time rather than in a user's window.
**Bad:** the guard fires on *reordering*, not on *thrash* — a stage that rewrites the prefix
*consistently* passes and can silently cost the entire cache benefit. `prefixInvalidated` exists on
`Tier0Result`; check it is surfaced.
**Plan:** surface `prefixInvalidated` in telemetry and treat a sustained high rate as a first-class
alarm, not a metric.

### R11 — Dedupe can delete a deliberate repetition (Live, High)

`dedupeMessages` / `mergeAdjacentSameRole` collapse adjacent same-role messages. The good case is
real and common: providers and wrappers duplicate content, and merging is free savings.
**Bad:** repetition is sometimes semantic. "No." "Again." "I said the *other* file." are
same-role-adjacent, textually near-duplicate, and carrying the entire correction. A deduper that
looks at similarity rather than *exactness* destroys these. Since `user_intent` is verbatim, the
mitigation exists — provided dedupe respects tier.
**Plan:** assert dedupe is never applied across a verbatim tier boundary, and add a
same-role-correction corpus as a falsification test. If any correction survives, the guard is wrong.

### R12 — Recovery is a new read path with its own authz (Latent, High)

C-14's `get_artifact` lets an MCP client pull back what eviction stored. **Good:** `ArtifactAcl`,
`LocalityViolationError`, and `realpathNearest` (symlink guard) are the right three.
**Bad:** this inverts the threat model — content is now *readable by a client*, and the raw
transcript may contain exactly the material redaction and governance were meant to constrain. The
gist is the safe object; the raw transcript behind it is not.
**Plan:** recovery returns the gist by default and raw content only under an explicit,
separately-authorised capability. Record every recovery in the audit log. Assert in a test that
`get_artifact` cannot bypass `ArtifactAcl` for a bucket the caller did not hold.

### R13 — The safety check degrades the session it checks (Live, Medium)

`ConstraintCanary`, `runConstraintProbe`, `runRotProbe`, `CanaryScheduler`.
**Good:** probes have validity checks (`evaluateRotProbeValidity`, `isDecayExposedStratum`) and a
violation kind that cannot be confused with a real one (`CANARY_EMITTED_VIOLATION_KIND`) — so a
deliberately-tripped canary is never mistaken for a genuine violation. That is a detail most
monitoring systems get wrong and would produce false alarms forever.
**Bad:** probes cost tokens and latency on every run, and — the subtle part — long context degrades
the *monitor*, not just the agent. See R2.4.
**Plan:** keep the probe budget bounded and declared; never let probe tokens evict `verbatim` tiers.

### R14 — A safety-critical fill fraction read the optimistic number

**Status: Fixed (P0-2b). Kept as history — the defect below is gone, and the section reads as a
record of what was wrong and how it was closed.**

`CanaryScheduler.#fillOf` computed `tokenEstimate / windowTokens` and used it to schedule the rot
probe. The `tokenEstimate` it received was `state.tokenEstimate`, which is `core-types/estimateTokens`
— the optimistic `chars/4`. So the safety ladder was placed using a number that can under-report by up
to 149% on exactly the structured content an agent session accumulates. A probe scheduled "late" is a
probe that has to catch mid-transcript violations in a longer context — the regime where R2's monitor
recall falls from 98.6% to 88%.

Its own comment was also stale: it said the estimate came from "the gateway's estimator", which is
both untrue (it was `core-types`) and the reason it went unnoticed — the comment described the
*unwired* correct module as if it were in the path.

`canary` depends only on `core-types`, and `core-types` is frozen, so it could not import the new
pessimistic estimator without a new cross-stream package edge. **The fix injects rather than imports,
as recommended.** `CanaryTurnInput` carries `state: ContextState`, and `CanarySchedulerOptions`
gains a *required* `pessimisticTokens: (state) => number`, validated at construction with
`CanaryConfigError` — the same treatment `windowTokens` gets, because a default here would be this
package's own guess at tokenisation. The signature is deliberately that of `pessimisticStateTokens`
(`pipeline/token-budget.ts`, P0-2) so a host holding it passes it unadapted, while `canary → pipeline`
is *not* added: four cross-stream edges exist and a fifth needs the owner (`AGENTS.md` §7).

Three consequences worth recording. The estimator is host-supplied code, so its throw is caught inside
`#runRot` and reported as a `canary_fail` failure — `runTurn` still never rejects. The comment now
says which module did *not* produce the number. And `#fillOf`'s clamp gained a direction:
`+Infinity` counts as a session over budget (top of the ladder), while `NaN` and `-Infinity` are
counts that were never produced and read as 0 — under-reporting is the failure R1 is about, but a
rung derived from a count nobody computed is not a measurement either.

**Tests:** `packages/canary/test/fill-fraction.test.ts`, 10 falsifiers that read the published
`rot_canary.atFracOfWindow` and `tier` rather than the private method — the estimator's count wins in
both directions (a `state.tokenEstimate` claiming a full window still reads 0.5), the estimator
receives the turn's own state exactly once per rot firing and never on a quiet turn, same-length JSON
and prose land on different rungs using the measured 1.49× from R1 as a stand-in (the real estimator
cannot be imported, which is the point), fill is monotone in the count, the clamp holds at
`[0, 1]`, a throwing estimator fails open, and a non-function estimator is rejected at construction.
Two mutations confirmed to fail 8 of 10 and 3 of 10 respectively (count routed back to
`core-types/estimateTokens`; clamp deleted) — and each also fails pre-existing rot-telemetry tests
(2 of 20 and 1 of 20), so the defect would have been caught by the old suite once the count was
injected.

### R15 — `NO_STAGE` parks honest failures in a dishonest field

**Status: Live. Accepted debt with a named retirement condition.**

`StageNameSchema` is frozen at seven members and none means "not a stage", so a truthful sentinel for
"no stage owns this failure" does not compile. `NO_STAGE` therefore resolves to `'serialize'`
(`packages/gateway/src/server.ts`) — the one member naming gateway plumbing rather than a context
transform.

This is a *bounded, documented, separable* lie rather than the old one: the populations are split by
`errors.byCode`, and a genuine serialize failure (`adapter_unavailable`) reports itself. It is recorded
here so it is not forgotten, because the retirement condition is precise — **when `StageNameSchema`
gains a non-stage member, this constant is the only line that changes.**

**Related accepted debt:** four messages retain `detailOf(err)` in a `cause:` tail. That is safe only
because `MemorySink` and `JsonlSink` both redact by default — and `redact` is a settable option
(`sink.ts`), not an invariant. If `redact: false` is ever set, raw exception text lands in the log.

---

## 5. Plan: what to fix, in what order

### 5.1 P0 — before any further wiring

These three are cheap, and every one of them is a prerequisite for trusting the next change.

> **Status: P0-1, P0-2, P0-2b and P0-3 are done and mutation-tested.** Two new items were
> found while integrating — **R14** (the canary scheduler's fill fraction, fixed by P0-2b below) and
> **R15** (`NO_STAGE`, accepted debt). R14 belonged in P0 because it is a safety decision made from an
> optimistic number, which is exactly the R1 failure mode on a path nobody was watching.

**P0-1 · Make failures attributable and actionable.** *(fixes R6, unblocks everything other)*

**DONE.** Attribution is now a required parameter with no default to forget; `runId`/`stage` are real
on every emitted failure; `NO_RUN`/`NO_STAGE` name the two cases where no run existed instead of
claiming one did; `asStageCode` is exhaustive and forwards unknown codes as
`unrecognised_stage_code` rather than borrowing `stage_threw`; every message names a knob or a
`file:line`. Seven gateway tests plus five pipeline tests, each a falsification of the old behaviour,
with two mutations confirmed to fail four and six tests respectively. REMEDY citations are verified
against the tree, which caught three rotted ones on introduction.

The gateway's `fail()` emits `runId: 'unknown'`, `stage: 'pin'` for every failure regardless of cause,
so `pipeline_failed_open` from the pipeline is logged as a pin error on an unknown request, and
`strata status`'s `by stage` counts are built from those misattributions. Compounding it,
`runner.ts` maps four distinct causes to one code and drops the cause entirely.

Do not serialise the exception onto the wire — that stays a closed set, per the contract. Instead:
carry the true `runId` and `stage` through the failure path; keep a closed code set but make each
code correspond to one *actionable* condition; and put the resolution in the message (the knob to
change, or `file:line`). `status.ts` already prints recent errors with `seq`/`stage`/`code`/`runId`
and per-run summaries, so correct attribution makes an existing surface useful with no new surface.

*Falsification test:* throw from each of the four mapped causes and assert four distinct
`(code, stage, runId)` triples in the emitted event, and assert the message names a remedy.

**P0-2 · Split comparative from pessimistic token estimation.** *(fixes R1, gates R4)*

**DONE.** `packages/pipeline/src/token-budget.ts` adds a per-character pessimistic estimator,
branded with a module-private symbol so `TriggerInput.tokens` can no longer hold a comparative count
by accident; `triggerFor` reads it. The model is per-character rather than per-document because
solving the measured rows against a prose baseline shows *punctuation* is what costs, not JSON per
se — so density thresholds on whole blocks were tried first and killed by the falsification suite
(a mixed 75/11/14 block crossed no threshold and got filed at 1.0× when its length-weighted blend is
1.22×; a sum over characters has no cliff). 56 new tests. Four mutations confirmed to fail 8, 18, 1,
and 14 tests respectively.

Two honest caveats. The type barrier catches *accidents*, not deliberate rebranding — an explicit
`pessimisticCount(...)` around a comparative count compiles, which is the documented escape hatch.
And the calibration loop has **no consumer**: nothing feeds it the provider's `usage` yet. It is
exported, ledgered with that reason, and testable without a provider.

*Falsification test:* assert `pessimistic(x) >= comparative(x)` for every content class, and assert
the measured ratio for a known corpus lands inside a declared band. **Both done.**

**P0-2b · Give the canary scheduler a pessimistic fill fraction.** *(fixes R14 — see §4)*

**DONE.** Inject rather than add a `canary → pipeline` dependency, since `canary` depends only on
`core-types` and the cross-stream edge is exactly what the wiring ledger exists to make expensive:
`CanaryTurnInput` carries `state: ContextState` and `CanarySchedulerOptions.pessimisticTokens` is
required at construction (a non-function throws `CanaryConfigError`), with the signature of
`pessimisticStateTokens` so a host already holding it passes it unadapted. The stale comment that
credited "the gateway's estimator" is replaced by one that names what is *not* in the path. A throwing
estimator becomes a `canary_fail` rather than a rejected turn. 10 falsifiers in
`packages/canary/test/fill-fraction.test.ts` plus 2 migrated rot-telemetry assertions; two mutations
(routing the count back to `core-types/estimateTokens`; deleting the clamp) confirmed to fail 8/10
and 3/10 there, and 2/20 and 1/20 in the pre-existing suite.

**P0-3 · Fail triage closed on uncertainty, and add a declarative-constraint override.** *(fixes
R2's residual, gates R8)*

Uncertain classification → `verbatim`. A conservative detector that may only *promote* a tier toward
verbatim, never demote, targeting the declarative phrasing the literature shows LLM and regex
classifiers both miss. Emit the promotion count so a never-firing check is distinguishable from an
always-firing one.

*Falsification test:* declarative-constraint corpus with a declared recall floor, asserted across
compaction.

**DONE.** `packages/pipeline/src/safety-net.ts` classifies a block's *wording* for retention —
verdicts `ordinary` / `uncertain` / `constraint` — and `promoteTier` may only return a tier the policy
protects *more*: it refuses equality, refuses `artifact_ref` outright (a pointer's bytes are not in the
block), and reads the retention table as a parameter so the policy keeps exactly one owner. Wired into
`triageMessages` before the census, so the census describes the tiers that actually leave.
`TriageReport` gains `promotedToVerbatim` = `promotedUncertain` + `promotedDeclarative`, which is where
the count rides: `STRATA_EVENT_TYPES` is in the frozen contract, and a number that belongs to one
stage is not a reason to move it. 24 tests in `packages/pipeline/test/triage-safety-net.test.ts`:
declarative recall 9/9 (floor 1.0), a transcribed E1 imperative set 14/14 (floor 1.0), eight negative
controls at zero promotions, never-demote over every tier × every fixture text, and the chain
reassembled against a compactor that honours the published table — including the counterfactual in
which the un-promoted block *is* gisted away. Two mutations confirmed to fail 6 and 8 tests
respectively (fail-open on uncertainty; the override rewritten as a general classifier, which the
never-demote guard exists to prevent — it also breaks four pre-existing triage tests). Suite 3992
tests / 3991 pass / 1 skip, contract unchanged.

Three findings, none of which the plan anticipated:

1. **The premise of plan item 1 is wrong.** It says "when `classifyBlockText` is not confident".
   `classifyBlockText` (`severity.ts`) classifies *log severity* for F7 and returns
   `Severity | undefined`; triage does not classify text either — ingress assigns tiers from the *kind*
   of text (system → `user_intent`, message → `episodic`, tool traffic → `tool_state`). There was no
   tier classifier to make more careful. The consequence is sharper than the plan's: a constraint in
   ordinary conversation was `episodic` by *construction*, not by misclassification, so this is the
   first read of wording anywhere in Tier 0.
2. **The promotion target is a forced conflation.** `Tier` is frozen in core-types and `verbatim` has
   only two members, `governance` (unrepresentable on a `NonGovernanceBlock`) and `user_intent` — so a
   constraint about a patient is recorded as if it were the task, which is spec.md principle 4's exact
   failure mode. The honest fix is a distinct tier or a `verbatim` retention flag once
   `context.ts` can be unfrozen; it is documented in `safety-net.ts` so nobody mistakes it for an
   intention.
3. **The promotion is one turn late for the byte caps.** Stage order runs `truncate` before `triage`,
   so a promotion takes effect for the compactor and the gist immediately (which is where the
   Compaction Cliff risk lives) but for the per-tier byte caps only on the following turn. Fixing that
   means classifying at ingress, in the adapters.

The module is deliberately *not* re-exported from the pipeline barrel: a new barrel export is a new
locally-uncalled export, and Gate 4's ratchet (`UNCALLED_BASELINE.local`) is not mine to edit.
Integration — exporting it — is the integrator's call.

### 5.2 P1 — before eviction is enabled

1. **Recovery path end-to-end** (R5, R8, R12): a real `ArtifactStore` written by the gateway, read
   by `get_artifact`, over `ArtifactAcl`. No eviction before this passes.
   *Met for the read side, and only there.* `createStoreBackedContext` reads a real store through
   `ArtifactAcl`, proven across processes: a child writes through `ArtifactStore.put` and a
   separately spawned `mcp serve` hands the bytes back. The gateway's write half is proven
   separately — `STRATA_ARTIFACT_ROOT` puts a resolvable pointer on the wire, and with no variable
   the byte cap applies and no uri is minted — but no single test runs a real gateway and a real
   `mcp serve` against one root, and nothing stops an operator from naming two. Closing that
   coupling, and `recoverEvictedMessages` itself, is what is left before this item can be called
   satisfied rather than its read half.
2. **Make publish-after-persist a transaction, not a documented duty** (R5). Close with
   `runCompactionTransaction`.
3. **Re-verify redaction after compression** (R9); assert the marker count is non-decreasing.
4. **Surface `prefixInvalidated` and compression verdict rates** in `status` (R7, R10).

### 5.3 P2 — hardening

1. Advisory visibility and a real operator acknowledgement gate for gist heuristics (R3).
2. Dedupe tier-boundary assertion plus a same-role-correction corpus (R11).
3. Long-context adversarial tier in the canary suite, so the classifier is measured at the lengths
   where it degrades (R2.4, R13).
4. `defendGist` fuzzing (R3).
5. Reconcile the observability claims across `README.md`, `docs/operations.md`, and `status.ts`
   before either makes a claim to a user.

### 5.4 Accepted, not fixed

- **LLM compaction is non-deterministic and we cannot make it otherwise.** Identical snapshot and
  prompt produce a different summary on every call, with output length varying by hundreds of tokens,
  worsening with context length; instruction-following on length constraints is unreliable, and models
  exhibit verbosity compensation under uncertainty. **Consequence:** compaction is a
  *non-reproducible transform*. We can make it *auditable* — record a digest per gist, assert it on
  recovery, and never present compaction output as a reproducible function of its input. We should
  not claim reproducibility anywhere.
- **Heuristic classification is inherently imperfect.** R2's mitigation is a conservative override
  plus a declared recall floor, not a proof.
- **Context rot is real and not ours to fix.** Performance degrades non-uniformly with length even
  on simple tasks; a reproduction shows 100% at 200 tokens falling to 6.7% at 64k on a perturbed
  codebase. Reducing token count is a mitigation for a problem we cannot solve.

---

## 6. One-paragraph answer

The system is *carefully built against the known failure modes*: verbatim retention for governance
and intent is Constraint Pinning, `defendGist`'s mechanical/heuristic split is the right answer to
injection, `pending` names the dangling-pointer case precisely, fail-open protects the user's data,
`do_not_compress` is an honest first-class verdict, and recovery was designed before eviction. The
research literature's primary findings are already answered in the design.

Three things are not answered, and all three sit directly upstream of the next board items. **Token
estimation is a ratio-safe heuristic being relied on for absolute budget arithmetic it cannot
support** — and the error runs up to 149% against exactly the structured content this product
compresses; it will turn a context-window overflow the moment the trigger is wired. **Tier triage is
the load-bearing safety component and it is a heuristic, on the one phrasing class that both regex
and LLM classifiers demonstrably miss** — declarative constraints — so it should fail closed, not
open. And **fail-open without attributable telemetry is safe for users and corrosive for operator
trust**, which is the question that started this: you should never have to read surrounding log
lines to find out what went wrong. Fix those three, in that order, before wiring anything else.

**Addendum, after doing two of them.** P0-1 and P0-2 are complete and mutation-tested. Two things
changed in the picture. First, R1 was *not* a missing idea — `gateway/token-estimator.ts` already
held a correct, deliberately pessimistic, provider-aware estimator, and it was unwired while the
optimistic `chars/4` was live everywhere. The lesson is sharper than "add a guard": the correct
implementation existed and was simply not connected, which is why the ledger exists. Second, fixing
the trigger exposed that a **safety-critical path nobody was watching — the canary scheduler's fill
fraction — was reading the same optimistic number all along** (R14, closed by P0-2b). A fix applied at
one call site
does not fix the concept; it fixes the call site. Triage — the last P0 item — is now addressed by the
P0-3 safety net above, with its own residual recorded there: the detector is still a heuristic with a
declared recall floor rather than a proof, and plan item 4 (measuring it at length) is unchanged.

---

## 7. Sources

Verified by retrieval. Numbers quoted above are from these.

| Ref | Work | Used for |
|---|---|---|
| [1] | Chen, *Governance Decay: How Context Compaction Silently Erases Safety Constraints in Long-Horizon LLM Agents*, arXiv:2606.22528v2 (27 Jun 2026) | 0%→30%/59% violation over 1,323 episodes; 38% when constraint dropped; 59% vs 37% no-policy floor; 8.3× softer-policy decay; Compaction-Eviction Attack defeating all evaluated models; Constraint Pinning → 0% |
| [2] | Zerhoudi, Mitrovic, Granitzer, *The Compaction Cliff in Long-Running AI Agent Memory*, arXiv:2608.22752 (24 Aug 2026), CIKM 2026 | 53% → 10% safety-rule recall over five rounds; hierarchical truncation 50%; 38–48pt declarative-phrasing loss; "penicillin" 62%/52%/0%; Knowledge Triage, TypeCompact 2–4×/96% recall; AgentArtifactCorpus 396,934 configs from 54,628 repos |
| [3] | Hong, Troynikov, Huber, *Context Rot*, Chroma Research (2025) | Non-uniform degradation with length; NIAH overestimates capability; reproduction 100%@200 tokens → 6.7%@64k |
| [4] | *Classifier Context Rot*, arXiv:2605.12366 | Monitor recall 98.6% → 88% with 800k prefill; worse on subtle mid-transcript attacks; fine-tuning did not generalise |
| [5] | *Parallel Context Compaction*, arXiv:2605.23296 | Run-to-run instability intrinsic to LLM compaction; length-instruction unreliability; verbosity compensation |
| [6] | *Token Budgets: An Empirical Catalog of 63 LLM-Agent Budget-Overrun Incidents*, arXiv:2606.04056 | Overrun as catalogued failure class; 31× overflow from one base64 image; estimator over-reservation 4–6× / 2.11× / ~1.0× at ~939–1749 ms |
| [7] | zai-org, *Token Counting Mismatch: Anthropic-Compatible API*, issue #12 (Apr 2026) | Prose 0.89–0.97×; JSON 1.43–1.49×; special chars 2.43–2.49×; ±5% expectation vs 40–149% actual |
| [8] | *Context Language Models*, arXiv:2609.37725 | Editable context as a persistence channel for injected instructions |
| [9] | Kang et al., *ACON: Optimizing Context Compression for Long-horizon LLM Agents*, ICML 2026 | 26–54% peak-token reduction at preserved accuracy — the good case for compression |

**Not verified.** No claim in this document rests on an unretrieved source. Where the repo's own
[`market.md`](market.md) cites identifiers that have not been independently confirmed, they are
flagged there and are not relied on above.