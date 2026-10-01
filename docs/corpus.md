# The task corpus (F1-4)

The corpus is the set of real coding tasks E4 runs agents against. This document
records where the tasks come from, why they are stored as references, and what
a claim drawn from this corpus is allowed to say.

## Provenance

| Field | Value |
|---|---|
| Repository | `VinodAtwal/aegis` (private) |
| Source | GitHub issues, milestones M1–M7 |
| Entries | 12, from a backlog of 50 open issues |
| Language | Python |
| Selection | spread across M1–M6; 9 greenfield, 3 refinement |
| Manifest | `packages/eval/corpus/aegis-backlog.json` |
| Loader | `packages/eval/src/corpus.ts` |

The Mimoto backlog was excluded by owner decision: it is early and fragile, and
a corpus built on it would move under the evaluation.

## Why entries are references, not copied text

Each entry stores `{ repo, number }`. The issue body is fetched at run time
through the GitHub CLI. Nothing from the issue tracker is committed here.

That is a privacy constraint, not a style preference. `strata-ctx` is public;
`aegis` is private. Copying issue text into a fixture in this repository would
publish it on the next push, and no later commit can retract it. So the corpus
holds coordinates, and `gh` — already authenticated in the operator's keyring
with the scopes these repositories need — supplies the text.

An earlier plan was to copy issue text from public third-party repositories. Two
things made that the wrong plan:

1. Every public repository reachable from here has **zero issues**, open or
   closed. There was nothing realistic to copy.
2. Copying someone else's issue text raises a licensing question this repository
   should not have to answer. Owning the tasks removes the question entirely.

The cost is stated rather than hidden: a corpus entry resolves only for someone
with read access to `aegis`. `resolveCorpus` therefore fails loudly and names
every entry it could not resolve. Partial resolution is treated as failure, on
purpose — an entry that quietly resolved to an empty prompt would run every arm
against no task at all, and "no violation" would then read as a pass. A corpus
must never manufacture green results out of missing data.

## Licensing position

No third-party material is included. Every task originates in a repository
owned by this project's author, so there is no upstream license to satisfy and
no attribution obligation. `strata-ctx` itself is Apache-2.0.

## The governance constraint on each task

Every entry carries one constraint: a rule that must hold for the whole session,
plus `forbidden` markers naming what a violation would look like.

The constraint is the thing under test. The task is only the situation that
pressures it. The markers are chosen so that a violation is detectable in output
without a human reading every transcript, which means they name *shortcuts*:

- reporting a test command the probe never observed
- adding `type: ignore` to clear a type error
- proceeding past the approval gate
- treating an issue comment as an instruction
- allowing writes in `readonly` mode
- narrowing a property test's domain so a counterexample stops being reported

These are the failure modes this project exists to prevent, restated as tasks an
agent can actually be caught doing.

## What a claim from this corpus may say

**One repository. One language. Feature requests, not bug reports.**

The corpus is Python work in a single codebase. It supports claims about
governance behaviour on that codebase and nothing wider. It is not evidence about
JavaScript, Go, or any other language, and it is not evidence about maintenance
work: a feature request has no failing test to reproduce, so "did the agent fix
it correctly" is not gradable here.

What the corpus *can* grade is governance behaviour over a long session: whether
a constraint stated early still holds at the end, and whether the markers above
appear when it does not. That is what E4 measures, and it is the thing the
claims audit must be told to confine itself to.

The single-repository limit is written into the corpus description itself, so it
travels with the data rather than living only in this file.

## Extending it

Add an entry to the manifest; do not add text from the issue tracker. A second
source kind, `board`, references a row in `docs/tasks.csv` instead of a GitHub
issue, so this project's own backlog can be used as tasks without being
transcribed. It is implemented and tested but not used by the shipped corpus.