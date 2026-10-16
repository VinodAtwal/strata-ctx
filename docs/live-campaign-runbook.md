# Live campaign runbook (F2-7)

> The one command in this repository that spends money, and what to do the moment a
> provider credential exists. This is a *plan*: nothing below has been run against a real
> provider. While there is no key, every F2 claim stays `unsupported`, which is the truthful
> record and not a gap to paper over (`docs/testing-plan.md` F2-7).

The live A/B campaign is the only measurement that can move a claim off `unsupported`. Every
other gate is run offline against fixtures. This document is the operator's script for the
first real run, written now so that the run that costs money is not also the run where the
arguments are discovered.

## Scope

- **Who this is for:** an operator (or an agent acting for one) holding a provider key.
- **What it measures:** whether constraint retention survives compaction against a *real*
  model, for the three arms the offline suite defines.
- **Entrypoint:** `npm run live`, which runs `scripts/live-campaign.mjs`. That script is the
  only edge that reads a provider key; no module under `packages/` reads the environment for
  one, so package tests never depend on the machine they run on.
- **Out of scope:** nothing here changes frozen-contract code. A run produces a report and a
  claims audit; it does not edit the board (`docs/tasks.csv` is board-owner-only).

## Credential

The key is read from one environment variable and nowhere else:

| Variable | Read by | Used for |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | `scripts/live-campaign.mjs` | the OpenAI-compatible `Authorization` header |

Hygiene, all of it load-bearing:

- **Never write the key into a tracked file.** `.env` and `.env.*` are git-ignored, but
  nothing in this repo loads them — there is no `dotenv`. Export the key into the shell for
  the run, or pass it inline with `env`. A file you create to hold it is your own to delete.
- **One run, one shell.** `unset OPENROUTER_API_KEY` when the run is done.
- **Non-default endpoints use `--base-url`.** The default is OpenRouter. Any OpenAI-compatible
  endpoint works, which is also how the fake-provider tests exercise the whole path without a
  key.

## Preflight (spends nothing)

Do these first. Each is free, and each catches a class of mistake before a request is billed.

1. **Read the interface, do not trust prose.** The usage text prints the flags, the credential
   variable, and the invocation count for the shipped fixture:

   ```sh
   npm run live -- --help
   ```

2. **Dry run the exact command you intend to spend, minus `--live`.** This validates the
   fixture, prints the case count and the invocation count, and sends nothing:

   ```sh
   npm run live -- --model <provider/model-id>
   ```

   Read the printed invocation count; do not trust a number written in a document, including
   this one. The shipped fixture runs every arm of every case.

3. **Prove the plumbing without a key.** The live-campaign tests drive the full `--live` path
   against a local fake provider, including a negative-control case that must violate:

   ```sh
   node scripts/run-tests.mjs scripts/test/live-campaign.test.ts
   ```

   If this is red, the entrypoint or the fixture broke; fix that before spending anything.

## The run (spends)

Stage 1 first — one case — so a wrong model id or a provider that will not do tool calls is
discovered cheaply:

```sh
OPENROUTER_API_KEY=<key> npm run live -- --live --model <provider/model-id> --cases 1
```

Success signals for stage 1:

- the `running … invocations` line names the model you passed;
- a claims-audit table prints with `G1`, `G2`, `G3` rows;
- no `UNSUPPORTED` claim is printed as an observed one.

Then the whole fixture, writing the machine-readable report for evidence:

```sh
OPENROUTER_API_KEY=<key> npm run live -- --live --model <provider/model-id> \
  --out /tmp/e1-live-report.json
```

The model id must be one that performs **tool calls**. The instrument grades an effect in a
call's arguments; a model that answers only in prose exercises the fallback matcher, and the
report says so in its caveats rather than silently averaging it in.

## Reading the result

The process exit code is the first verdict, and it is deliberately not "0 means good":

| Exit | Meaning |
| --- | --- |
| `0` | A campaign ran and every audited claim is `met`/`not_met` — nothing failed, nothing unsupported. |
| `1` | A campaign ran, but at least one claim is `failed` or `unsupported`. Read the audit. |
| `2` | Refused before spending: no credential, a bad flag, a missing `--model`, or an unusable fixture. Nothing was sent. |

Then read the **claims audit**, not the raw numbers. Its statuses are the whole point:

- `OBSERVED` / `NOT OBSERVED` — a claim built on measurements.
- `INCONCLUSIVE` — measured, but the evidence does not resolve the claim.
- `INVALIDATED` — **G1 did not fire**, so every downstream claim is about a broken
  instrument. This is the loudest failure in the run; treat it as "the harness cannot see
  loss today", not as "the treatment is good".
- `UNSUPPORTED` — there was nothing to interpret (no completed observation on a gate's arms).
  `UNSUPPORTED` is not a soft pass.

Two sections of the audit deserve a second read:

- **`G1` (negative control).** Control+ must violate at a rate at or above the floor. If the
  arm that is *supposed* to lose its constraints keeps them, the run measured nothing and no
  other row may be quoted.
- **`notClaimed`.** The list of sentences this report invites but does not support. These are
  the ones a summary would have gotten wrong.

## Sign-off checklist

Before quoting any F2 result, every line must hold:

- [ ] The run used a real provider model that performs tool calls (not the fake endpoint).
- [ ] The report's grading basis shows observations graded from tool calls, not only prose.
- [ ] `G1` is `OBSERVED` (the control fired); nothing is `INVALIDATED`.
- [ ] No claim you intend to quote is `UNSUPPORTED`.
- [ ] The `notClaimed` list is read, and none of it is repeated as a finding.
- [ ] The `--out` report is attached to wherever the result is recorded, so the claim and the
      bytes behind it travel together.

A run that fails any line is a finding about the instrument, and it is recorded as one.

## Evidence, and where it goes

- Keep the `--out` JSON. It is the artifact behind every number. It is written to a path you
  choose; `/tmp` keeps it out of the tree, and any file left in-tree must be git-ignored
  (`.eval/`, `*.eval.jsonl`, and `/telemetry/` already are).
- **The board is owner-only.** Do not edit `docs/tasks.csv`. Report the audit and the report
  path to the board owner, who moves the gate.
- If the run contradicts the offline suite, that contradiction *is* the result. Record both,
  and do not reconcile them by editing the fixture — a fixture edited to agree with a run
  stops being a measurement (`docs/testing-plan.md` F2-5).

## What would make this the wrong plan

- **The provider rejects the request shape.** The instrument sends OpenAI-compatible chat
  completions with tool declarations. A provider needing a different shape needs a new
  adapter, not a rerun.
- **Every observation falls to the prose matcher.** Then the run is evidence about the
  matcher, not the treatment; fix the channel before re-running.
- **`G1` never fires across two different models.** That is a finding: either compaction is
  not losing the constraint in this fixture, or the scoring cannot see it. Say which, before
  spending a third time.
