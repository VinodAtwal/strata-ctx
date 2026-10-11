# Testing plan — wave 4

> The falsifiers below are still live and still bind: each row states what would have to be
> observed for the claim to fail. The *wave-4 sequencing* is historical.

Written before the work, so that each row's *falsifier* is fixed before anyone
writes the code that satisfies it. A plan written afterwards describes whatever
was built.

## The rule this plan exists to satisfy

`AGENTS.md` §4 requires every operator to carry at least one negative test — a
"should not do this" case. That is necessary and not sufficient. A negative test
proves the operator refuses. It does not prove the operator **discriminates**.

The distinction matters because the dominant defect class in this repo is not a
wrong answer, it is an instrument that cannot tell two states apart:

| Defect | Looked like | Actually |
| --- | --- | --- |
| B-3 published a pointer whose digest was `block.meta.sha256` | passing tests | the digest of a thing that is not the bytes |
| `raw_recoverable: true` with no stored transcript | a recoverable gist | a claim with nothing behind it |
| H-6 referenced a URI resolving to nothing | a compressed response | a stub pointing at absent bytes |
| `eviction_skipped` "not an event" | a missing emit | a present emit and a missing reader |
| G1's 25% floor | an unmet gate | an instrument that removed nothing, so could not fail |
| 432 uncalled exports | a green suite | 432 operators nothing calls |

Every one of these passed a suite that was green. So each row below names the
**discrimination test**, not merely the negative test: a pair of runs that differ
in exactly one respect, where a correct instrument gives opposite verdicts.

## Per-row plan

### F2-4 — the grader cannot distinguish a refusal from a use

*Hypothesis:* `detectViolations` classifies on a token match, so a response that
names a constraint in order to decline it is scored as a violation.

*Discrimination test:* two responses, identical except for intent — one declines
while quoting the constraint, one complies while using it. Both must not score as
violations; a third that actually breaches must still score. Assert all three, so
a fix that simply widens the matcher fails the third.

*Falsifier:* if quoting-then-declining is genuinely indistinguishable from
breaching in the corpus's own terms, say so and do not ship a heuristic. That
would be a finding about the gate, not a bug to fix.

### F2-5 — a constraint text contains the token it forbids

*Hypothesis:* E1's `hard-audit-logging-stays-on` contains the literal `disabled`
inside its own constraint text, so a compliant answer that says "logging stays
enabled, not disabled" can trip a substring rule.

*Discrimination test:* a response that mentions the forbidden token while
complying must score clean; one that disables must score a violation.

*Constraint:* fixing this by editing the constraint text **rewrites the scenario
being measured**. If that is the only fix available, the row stays open and the
confound stays declared in `LIVE_CAVEATS`. A green gate on a rewritten fixture is
worse than a declared confound.

### F2-6 — maturity assessment

*Hypothesis:* the product is further from production than the green suite
suggests, and the gap is concentrated in reachability and evidence rather than in
correctness.

*Method:* no new code. For each capability, record the evidence that exists and
the evidence that does not, with `file:line`. A capability with no production
caller is not a capability, however well tested.

*Falsifier:* if the assessment cannot be grounded in a reachable code path or a
recorded measurement, it is opinion and does not ship. Every claim carries its
citation or is marked unevidenced.

### F2-7 — no provider credential

*Not testable here.* This row is `exec: ext` because the blocker is a credential,
not code. The gate's obligation is to stay **honest** while blocked: claims stay
`unsupported`, and `auditUnrunCampaign` must remain quotable.

*Test:* drive the campaign with an unreachable endpoint and assert the report
says `unsupported` and never `inconclusive`-with-a-positive-claim. This is the
one row where the negative test is the whole deliverable.

### G-8 — `cache` and token-category savings

*Hypothesis:* `cache` events and `savings.tokensByCategory` reach the log and are
dropped by `buildStatus`, so an operator cannot see an invalidation or where tokens
went.

*Discrimination test:* a log containing a `prefixInvalidated` with **no** reorder
must be visibly different from one with a reorder. The existing comment records a
past fall-through where a `cache` event entered the `canary` branch and read
`passed`/`score` off an event that has neither — so the test must assert the two
are distinguishable, not merely that `cache` is handled.

### G-9 — per-stage tokens

*Landed* (`a63bfa8`): `inputTokens`/`outputTokens` were added to `StageTelemetry`
as optional fields and the contract digest moved, with nothing else in the lock
moving. That is the whole of what this row owed — a field. Whether anything
*emits* it is G-10's question, and until G-10 the answer was "the contract has
the field and the gateway drops it on the way out": a field with no producer is
the `eviction_skipped` shape from the table above.

*Discrimination test:* a stage that removed blocks must emit `inputTokens` >
`outputTokens`, and a stage that did not must emit them equal. A producer that
measures after the stage reports equality for both — which is what Tier 0 did
before G-10 (`order.ts` read `inputTokens` off the reassigned `ctx`).

*Falsifier:* if a stage's own event cannot say what it received, only what it
produced, the token field is decoration and belongs in a report's caveats, not
in the event.

### C-13 — the tunnel takes injected stages through a DI port

*Hypothesis:* before C-13 there was no way to hand the tunnel a stage from
outside `packages/pipeline`. `runPipeline` fell back to its own
`LOSSY_TIER0_STAGES` when `lossyStages` was absent, so the only lossy operators
past `pin` were Tier 0's own — re-run over an already-restored context — and a
genuine post-pin operator was unreachable however well tested it was.

*Discrimination test:* two runs whose only difference is whether the injected
name is in `policy.pipeline.stages` must give opposite verdicts, run versus
not-run, so a hardcoded stage list cannot pass. `packages/gateway/test/server.test.ts`
holds both halves ("an injected lossy stage runs after pin…", "policy.pipeline.stages
is the switch for an injected stage, as the remedy says").

*Safety falsifier:* an injected stage must not widen the pinned set or run a
Tier 0 name a second time. `createGateway` refuses a Tier 0 name at construction,
and `pin` stays the only tunnel stage that can produce governance. If a future
injection path can emit a `pin`-shaped stage, this row's guarantee is gone even
though the port still typechecks.

### G-10 — every stage that ran reports, in one set of units

*Hypothesis:* the tunnel's stages emitted nothing, and the one `stage` event that
existed was labeled `pin` while measuring the whole turn in `JSON.stringify`
bytes and message counts — so a sink could not read the effect of a compaction,
and `pin` had two incompatible answers.

*Discrimination test:* the sharpest pair in the repo — a stage that **failed
open** and a stage that **ran and changed nothing** produce identical
`bytesIn`/`bytesOut` and opposite `changed` (`true` vs `false`).
`packages/pipeline/test/runner.test.ts` asserts the first; a producer that
reported the stage's discarded output instead of the input would credit the
failed stage a reduction it never delivered, and the pair would stop being
distinguishable.

*Falsifier:* if a `stage` event from Tier 0 and one from an injected stage need
different readers, `docs/maturity.md`'s "one axis" claim is false. The same field
list for both is asserted in `packages/gateway/test/server.test.ts`'s injected
`compact` case; it binds any producer that emits `stage` on its own rather than
through `stageEvent`.

### B-15, C-8, H-9 — the three deferred subsystems

Deferred by owner decision. The obligation is that the deferral stays
*reviewable*, not that the code gets wired.

*Test:* each row's trigger condition must be falsifiable from the register — a
reader must be able to tell from one row what would make wiring safe. For C-8
specifically, note that it is the only code in the repo that deletes data and has
never run outside its own tests; any future wiring needs a rehearsal that is not
a test.

### J-12 — fail on a rising uncalled count

*Requires owner approval; not started.* The existing ledger already fails on a
**new** unwired operator and on a changed export count. This row asks for the
stricter rule: fail when the total rises.

*Falsifier for the proposal itself:* if the count is already unstable for benign
reasons — a barrel export, a type-only export — the stricter gate produces noise
and should be rejected. Measure before adopting.

## What no row can test

- Whether the gateway survives a real provider under load.
- Whether eviction destroys a transcript in production. `packages/gist` has no
  dependent package, so this is untested by construction, and no unit test can
  change that — only wiring can.
- Whether the pinned constraints survive a real compaction. There is no live
  campaign; G1 is now *measurable* and unobserved.

These are stated so that no green row is mistaken for coverage of them.
