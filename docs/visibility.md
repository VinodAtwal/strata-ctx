# Seeing what happened

*Why this document exists, and what still needs building.*

**The argument.** A tool that silently changes your context is a tool you cannot trust. Every
design decision in this repo that sounds fussy — pinning, byte-equality validation, fail-open,
`fsync`-before-evict — exists for one reason: so that **what the tool did to your work is
something you can find out afterward.** That property has a name in adjacent fields: auditability.
Here it is called visibility, and it is the difference between a proxy you run and a proxy you
trust.

This document covers what a user can see today, what they can't, and the concrete work to close
the gap. The engineering counterpart is [`operations.md`](operations.md) factors 4–7; this one is
written for the person deciding whether the product is usable *for them*.

---

## 1. What a user can see today

**Response headers, on every request.** After each turn you get:

| Header | Meaning |
|---|---|
| `x-strata-pinned: <n>` | How many constraints are in this request |
| `x-strata-fail-open: 1` | Present when a stage failed and your **original, uncompressed** context was sent instead |

That second header is the important one. It is the difference between "compression happened" and
"compression was *attempted* and declined." It is set on exactly one path — the pipeline failing
open — and it means **your work went upstream intact, uncompressed.**

**`strata status`.** Reads the local telemetry log and reports:

- Token budget consumed and remaining
- Compaction count, and how many passed validation
- Constraint count and any drift between turns
- Gross and **net** savings, separated
- Violations, by kind
- Warnings when the log itself is damaged

The warnings matter more than they look. A "0 violations" line is worthless if the log dropped
lines, so `status` checks log integrity *before* printing any count. A zero it cannot vouch for is
reported as unknown, not as healthy.

**The distinction that makes cost numbers mean anything.** Gross savings is how many tokens the
stages removed. Net savings accounts for what the intervention itself cost — generating a summary,
running a probe. Reporting only the gross number is how most tools make compression look free when
it isn't. This repo reports both, and the cost gate is on net.

---

## 2. What you cannot see

This is the honest list. Every item is a real gap, not a future idea.

**Per-request detail.** The stage telemetry — tokens in and out per stage, duration, whether the
cached prefix survived — is recorded and correlated by `runId`, but nothing surfaces it
per request. You can get session aggregates; you cannot ask "what did it do to *that* turn?"

**Every degradation code.** Every type in `STRATA_EVENT_TYPES` reaches a report, but *surfaced* and *aggregated* are
not the same. `strata status` collapses them into counts: several codes — including
`eviction_skipped`, which tells you transcript growth is *not* being bounded — appear in the log
and in aggregate totals, but the report never names them, so you cannot find out *which* turn hit
one without reading the JSONL by hand.

**Why the destructive-command floor said no.** It refuses enumerated patterns and reports a code,
but the refusal doesn't always name the rule that matched. A refusal that doesn't tell you what to
do differently is a dead end.

**Anything semantic.** Nothing reads the *meaning* of a constraint and judges a command against it.
The floor is a list of patterns. `mv /data /dev/null` gets through.

**Latency budget in practice.** The targets are documented. Whether your session hits them depends
on your content, and there's no per-request view of where time went.

---

## 3. The transparency work

Concrete tasks. Each states what a user could not answer before, and what they can after. The
first two are the high-value ones.

### T1 — Per-request explain

**Now:** a session summary. **After:** for any request, the stages that ran, tokens in and out per
stage, what was compressed, what the constraint count was, and whether anything failed open —
correlated by `runId`.

*Why first:* it's the difference between trusting a number and being able to check it. Every other
claim in this product rests on "the stages did what they said," and this is where a user can
confirm it for themselves.

*Acceptance:* given a `runId` from the log, an operator can reconstruct what that request cost and
what was done to it, without reading source.

### T2 — No silent degradation

**Now:** codes reach aggregate counts but are not *named* in the report, so a specific degradation
is invisible without reading raw JSONL. **After:** every degradation code is named in `status`
output. `eviction_skipped` should be visible whenever transcript growth is unbounded, because that
is the condition the product exists to prevent.

*Acceptance:* enumerate the telemetry event union and assert every variant appears in status
output. Checkable as a test, which means it can't rot.

### T3 — Actionable refusals

Every refusal message names either the setting to change or the file and line to look at.

*Acceptance:* each refusal names an action. `artifact_write_refused` already distinguishes the two
failure kinds; the rest should follow.

### T4 — Guard coverage in the status output

**Now:** a deterministic floor refuses enumerated destructive patterns. **After:** the report says
what the floor does *not* catch — no intent analysis, no protection against commands assembled at
runtime. A user deciding whether to trust it needs the boundary, not just the capability.

*Acceptance:* `status` states the enforcement boundary in one line: what's enforced, what isn't.

### T5 — Time-to-first-token visibility

**Now:** latency targets are documented, and per-stage `durationMs` is recorded. **After:** those
timings appear alongside token counts in the report, so a user can see whether compression is
costing them responsiveness.

### T6 — Session story

Per *session* rather than per request: what was dropped, what was kept, what was referenced
instead, and how to get any of it back. The reversal capability exists — every gist records the
turns it replaced — but there's no surface telling a user it exists.

*Acceptance:* from a session report, a user can name what was evicted and how to recover it.

---

## 4. Why these are structured this way

**Every task is an observable difference, not a feature.** "Add an `explain` command" is a feature.
"Given a `runId`, reconstruct what that request cost" is a test. The second one can be falsified,
which means it stays true.

**The safety-relevant ones come first.** T2 and T4 are about degradation being visible. A tool that
does less than you expected should be the *loudest* thing in the room, not the quietest.

**Honesty is a feature, including about limits.** T4 deliberately surfaces what the system *cannot*
do. A tool that overstates its coverage is worse than one that admits a gap, because the user stops
looking.

---

## 5. For someone evaluating this

The test is simple. Turn it on, work for an hour, then ask:

1. **Can I tell what it did?** Aggregate `status` output should be enough to be *oriented*.
2. **Can I tell when it declined to act?** The `x-strata-fail-open` header should make this obvious.
3. **Can I tell what it cost me, net?** Both numbers, or it's marketing.
4. **Can I tell what it can't do?** If the answer is no, treat every capability claim as suspect.

If the answer to (4) is no, that's the finding. Not a blocker — a signal that you'd be adopting on
faith rather than evidence, which is the exact situation this product exists to prevent for *itself*.

---

## Related

- [`operations.md`](operations.md) factors 4–7 — the engineering version of this document
- [`how-it-works.md`](how-it-works.md) — what the product does
- [`maturity.md`](maturity.md) — what is done vs. inert
- [`evaluation.md`](evaluation.md) — how the claims are measured