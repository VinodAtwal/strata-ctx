# Learning

*Intentionally empty. Append an entry when a mistake teaches something worth not repeating.*

Each entry: what went wrong → why it was not obvious → the rule that now prevents it. Rules that
belong in the operational contract get written into [`AGENTS.md`](AGENTS.md) too; this file is the
narrative of how they were learned.

---

<!-- Newest entries at the top. -->

## 2026-10-05 — A CSV edit that looked surgical and was not

**What went wrong.** Normalizing seven `est_ed` cells in `docs/tasks.csv`, I parsed each row
into fields and wrote it back with `cells.join(',')`. That silently stripped the quotes from
`"A-3,A-4"` and `"G1,G2"`, turning ten-field rows into twelve-field ones — 19 rows corrupted, in
a file I was editing to fix a formatting nit. Caught by reading the diff rather than the exit
code: the script exited 0 and printed a correct summary.

**Why it was not obvious.** Re-serialization *looks* like the honest thing to do. You parsed
the row, so writing the parsed row back feels lossless. It isn't: the parse returns values, and
the quoting was never part of the values. And this repo had already been bitten — the sibling
test in `corpus.test.ts` carries the note "a raw comma count cannot tell a quoted `G1,G2` from an
unquoted extra field". The rule existed. It just wasn't where I hit it.

**The rule.** If the edit is *inside* one cell, splice that cell's characters. Never re-serialize
a whole row to change one field. Concretely: compute the cell's `[start, end)` span, then
`line.slice(0, start) + value + line.slice(end)`. Parsing is for *reading* the value; it is not
license to rewrite the row.

## 2026-10-05 — A rendered field you never checked is not a field

**What went wrong.** `scripts/live-campaign.mjs` called
`renderUnrunAudit(auditUnrunCampaign({...}))`. `renderUnrunAudit` takes a *campaign* and calls
`auditUnrunCampaign` itself, so it received an audit object and read `campaign.model` and
`campaign.reason` off a thing that has neither. Every field rendered as the string `undefined`:
`Attempted model \`undefined\` at \`undefined\``, `the campaign did not run: undefined`.

**Why it was not obvious.** It did not crash. It printed a complete, well-formatted, 12-gate
claims audit — the exact shape of a correct report — with `undefined` where the model and endpoint
should be. Exit code was right. Nothing in the output said "broken." The failure was only visible
by reading the *content* of a report whose whole job is to be trustworthy, and the one field a
reader skims is the model name.

Worse, I had already unit-tested the exact call in isolation and it passed, because the isolated
test passed the campaign directly. The bug lived only in the composition.

**The rule.** When a function's output is a report, assert on the report's *fields*, not on its
shape. `assert.doesNotMatch(out, /undefined/)` in a test that runs the real no-credential path is
what caught this; "it exited 2 and printed UNSUPPORTED twelve times" passed happily. And in plain
JS, where the type signature cannot catch a wrong argument shape, the call site is the only place
the mistake is visible.

Related: a wrapper that composes two functions where one already calls the other is a smell. If
`renderX` internally does `auditX`, then `renderX(auditX(y))` type-checks in TypeScript, runs
without error, and is always wrong. Pass `y`.

## 2026-10-05 — A convention with no enforcer is a convention that dies

**What went wrong.** Seven of 132 `est_ed` values had drifted from the other 125: three carried a
`d` suffix (`1d`, `1.5d`), four wrote `1.0`/`2.0` where the rest write `1`/`2`. No code parses
that column, so nothing ever failed.

**Why it was not obvious.** The drift was invisible because it was harmless in the way that only
matters later — someone eyeballing `1.5d` cannot tell whether it means something the bare `1.5`
does not. The unit is already in the column *name*, so the suffix carried no information, only
the appearance of one.

**The rule.** A convention held only in practice will not survive a year of edits by people who
did not learn it. When a column has an implicit format, a test should assert it. That test lives
in `packages/eval/test/corpus.test.ts` now, and it reads the real board rather than a fixture —
a fixture would keep passing after the board drifted, which is the same bug wearing a hat.

## 2026-10-05 — Renumbering a document invalidates every pointer to it

**What went wrong.** Cutting `AGENTS.md` from 482 to 280 lines renumbered its sections. The new
`scripts/status.mjs` printed "§5 (git) §6 (workflow) §9 (forbidden)" — pointing at *Dispatch and
parallelism*, *Forbidden patterns*, and *Traps*. Three of four labels wrong, and it looked fine,
because it was printing section numbers and section numbers still exist.

**Why it was not obvious.** The numbers are real; only their meanings moved. Nothing checks a
pointer's *meaning*, so the failure mode is a confident wrong answer rather than an error. A
sibling ref in `docs/wiring-ledger.md` had gone stale the same way.

**The rule.** After any structural edit to a document others cite, grep for pointers into it and
verify each against the new headings: `grep -roh "AGENTS\.md §[0-9.]*" README.md docs/*.md`.
Prefer *named* pointers ("§6 Forbidden patterns") over bare numbers, so a mismatch is visible to
a reader rather than only to someone who remembers what §6 used to be.