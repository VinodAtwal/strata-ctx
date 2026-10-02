# Operator adoption (board row E-15)

The specification behind `E-15` in `docs/tasks.csv`. This is what "easy to
integrate and monitor" has to mean for it to be checkable rather than a matter of
taste, and it records the state that made the task necessary.

## Why this row exists

Adoption is currently blocked by facts, not by polish:

- **Nothing is installable.** All 13 packages in `packages/` are
  `"private": true`, and two of them (`gateway`, `gist`) depend on
  `"@strata-ctx/security": "file:../security"`. A workspace resolves that; an
  external `npm install` cannot.
- **There is no operator documentation.** `docs/development.md` is written for
  contributors. Nothing tells an adopter how to install, configure, or verify.
- **The monitoring half is a CLI that cannot answer the question.** `G-5`
  shipped `strata status` covering budget, compactions, pins, savings and
  violations. It aggregates. It cannot answer "what did you do to my last
  request, and what did you refuse to do" without the operator reading JSONL.

## Factor 1: time to first governed request

An adopter should reach a real governed request without reading the source.

Acceptance: on a clean machine with no strata config, a documented sequence
reaches a governed request and shows a refusal — asserted by a script, in the
spirit of `F2-0`, so it fails when the path breaks rather than when someone
forgets to try it. Target: single-digit commands.

## Factor 2: a safe default, and an honest one

The default configuration must be correct without being tuned, and must not
claim more than it did.

This is the factor with the sharpest recent evidence. A default gateway does
**not** pointerize: `GatewayOptions.artifactRoot` is absent by default, so
oversized reads take the byte cap instead of becoming `artifact://` references
(`gateway/src/server.ts`). That is correct — a pointer is only worth publishing
once its bytes are stored — but it means the headline compression behavior is
opt-in. Similarly, the E4 corpus supports no non-inferiority claim at n=12
(`docs/evaluation.md`).

Acceptance: for every default, the documented behavior matches observed
behavior. No report, log line, or README claim exceeds what the default
configuration measured.

## Factor 3: every knob documented with its default and its blast radius

An operator must be able to predict what a setting does before changing it.

Acceptance: each `GatewayOptions` field and each policy field has a documented
default and a stated consequence. A setting whose absence means "this feature
does not run" says so — `artifactRoot` is the model, because its absence is
invisible from the outside.

## Factor 4: per-request visibility into what compression did

Aggregate savings hide the per-request question. The stage telemetry already
carries the numbers (`bytesIn`/`bytesOut` per stage, `cache.prefixHit`,
`prefixInvalidated`); nothing surfaces them per request.

`buildStatus` discards the two event types that would answer it. At
`telemetry/src/status.ts:329` the switch ends in:

```ts
case 'stage':
case 'error':
  break;
```

So per-stage compression numbers and every error event are read off the log and
dropped on the floor — deliberately, to keep the summary small, but the result is
that the measurements exist and no operator-facing surface consumes them.

Acceptance: for any request, an operator can see tokens in and out per stage,
what was compressed, and the resulting token estimate — correlated by `runId`.

## Factor 5: silent degradation must be visible

Every one of these currently exists as a telemetry code that `strata status`
does not show, and each means the product did less than the operator expected.
The three `violation` kinds are counted (`status.ts:136`); the rest are not
counted anywhere:

| Code | Event type | Meaning |
| --- | --- | --- |
| `pin_missing_pre_apply` / `pin_post_compact_missing` | `violation` | a constraint may not have survived |
| `canary_fail` | `violation` | a probe failed |
| `stage_failed_open` | `error` | the context went upstream uncompressed |
| `artifact_write_refused` | `error` | a pointer was not published; the read was left inline |
| `eviction_skipped` | not an event | the transcript was not evicted; it is still growing |

`eviction_skipped` is the one to watch, and it is the odd one out: it is not an
event at all. `gist/src/transaction.ts:656` puts it in a `failed:` string on the
transaction result, so it never reaches the telemetry log and `strata status`
cannot see it by construction. It is also now the *expected* path for every real
Claude Code session, because
`integrations/src/claude-code-observers.ts` mints
`artifact://strata/raw/<session>/<turn>`, a URI the artifact ACL cannot parse.
Eviction is refused rather than corrupted, so there is no data loss — but
transcript growth stops being bounded, which is the problem the product exists
to solve, and the only trace is a field nothing reads.

Acceptance: **no telemetry code is emitted that `strata status` cannot surface.**
That is checkable by enumerating the event union and asserting each variant
appears in status output.

## Factor 6: every refusal is actionable

A refusal that does not name the knob that changes it is a dead end.

Acceptance: each refusal message names either the setting to change or the file
and line to look at. `artifact_write_refused` sets the model — it names the URI,
and distinguishes a block whose declared digest was not its text from content
that redaction changed.

## Factor 7: upgrade and compatibility

Acceptance: a documented compatibility statement for each host integration
(OpenCode plugin, Claude Code hooks), and a stated upgrade procedure. The plugin
and hook surfaces are version-coupled to hosts that update on their own
schedule.

## Open question for the owner

This row is one task because adoption is one journey, but it decomposes into two
independently shippable halves: **packaging and quickstart** (factors 1–3) and
**operator observability** (factors 4–7). They share no code, and the second is
useful to anyone already running a dev checkout. Splitting into `E-15` and a
`G-8` would let them land in either order. Kept as one row until that call is
made.