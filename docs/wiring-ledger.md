# Wiring ledger

*[Spec](spec.md) · [Architecture](architecture.md) · [Development](development.md) · [Decisions](decisions.md)*

---

## 1. The problem

A repository can have a full test suite, clean typechecking, and a large exported
surface in which a meaningful fraction of the code never runs. Nothing in the
toolchain notices, because `export` is not a promise that anything calls you.

This ledger makes that measurable and then makes the measurement hard to lie to.
It is a **mechanical** inventory: it walks the real module graph from the real
entry points and counts real references in real production sources. It does not
model what the code means, and it does not pretend to. Where it cannot be sure,
it says so rather than guessing.

The contract it enforces is narrow and checkable:

> Every exported runtime symbol that nothing reachable calls must appear in
> `packages/testing/test/wiring-ledger.test.ts` with a specific reason. Adding a
> new uncalled export breaks the build until someone writes down why it is
> allowed to be uncalled.

## 2. How the scan works

| Step | Behaviour |
|---|---|
| **Entry roots** | Derived, never hardcoded: the workspace `bin` in `package.json` (`packages/cli/src/index.ts`) and any root `npm` script naming a `packages/` or `tools/` `.ts` file (`tools/dev.ts`). Adding an entry point automatically widens the scan. |
| **Reachability** | Follows `import`/`export ... from` edges transitively from those roots, including barrels. 134 production files are scanned; 69 are reachable. |
| **Inventory** | Walks each reachable package's barrel and the modules it re-exports, collecting **runtime** values only. `export type` is skipped. Types are erased at build time, so an uncalled type cannot misbehave. |
| **References** | Every identifier occurrence in reachable production sources is classified as `call`, `new`, `value`, `import`, `member`, `propertyKey`, `typeOnly`, `declaration`, or `reexport`. |
| **Exclusions** | `packages/**/test/**`, `*.test.ts`, `dist/`, `node_modules/`, `.git/`, `coverage/`, and `scripts/`. A test-only caller is not a caller. |

The first cut of any such scanner is prose. Comments, string bodies, and regex
bodies are therefore blanked before the identifier search, with offsets and line
breaks preserved so positions stay reportable. A second view with only comments
blanked is retained for parsing barrels, where a module specifier *is* a string.

`export { runTier0 }`, a declaration site, `obj.runTier0`, and a property key are
all not callers. Neither is a mention in a comment, a string, or a regular
expression. Verified against the real tree: `integrations/renderPluginModule`
appears inside generated string data at
`packages/integrations/src/opencode.ts:1205` and is still correctly unwired.

### The ruling: a self-reference is not wiring

The three clauses that decide whether a reference is a caller are stated in one
place, on `isCallingSite` in `packages/testing/src/wiring-ledger.ts`, and each is
asserted individually by the test:

1. **The reference must be in a caller-shaped position** — `call`, `new`, `value`
   or `import`. A declaration, re-export, member access, property key and type
   position are not callers.
2. **A reference inside the module that declares the symbol is never a caller**,
   for any kind. A symbol named only in its own file is called by nothing, and
   finding those is the entire purpose of the ledger. This covers direct
   recursion and same-file helper chains: an operator that reaches itself, or is
   reached by a sibling three functions below, stays unwired until a *different*
   file names it.
3. **A reference from a module no entry root reaches is not a caller**, because
   nothing can get there. `packages/eval/src/*` referencing `packages/eval/src/*`
   is the case that made the first cut of this ledger useless.

File boundaries are the test, not package ones. `pointerizeBlocks` is declared in
`packages/pipeline/src/pointer.ts` and called from
`packages/pipeline/src/truncate.ts:326`, and it stays wired.

Clause 2 is a decision, not a bug fix, and it moved the number a long way: 432 of
1089 exports wired before it, 152 after. (1089 was the tree's total *then*; §4
records the nine exports it has gained since.) The gap was almost entirely code
that *does* run, through a sibling in its own file that something else calls. §6
says how each of those rows is labelled, because "the ledger says unwired" and
"the operator is inert" are different claims and only one of them is mechanical.

### Reference confidence

A reference only counts as a caller when it is one of `call`, `new`, `value`, or
`import`. Of the 152 wired entries the current tree reports: 87 `call`, 56
`value`, 5 `new`, and 4 with a bare `import` and nothing stronger.

`value` is the weakest of these and the most likely source of a false negative;
see §6. An `import` with no call is weaker still: the symbol is reachable but
nothing invokes it, so it is wired only in the sense that a module could.

## 3. The four gates

All four live in `packages/testing/test/wiring-ledger.test.ts`, except Gate 4,
which is in `packages/testing/test/wiring-ratchet.test.ts`. It is a separate file
because it declares a different kind of thing — one number about the whole tree
rather than a table of exceptions — and because it needs the ledger built twice
in the suite otherwise.

**Gate 1 — per-operator, both directions.** Every locally unwired symbol needs a
row in `UNWIRED_OPERATORS` naming its declaring file and why it is allowed to be
uncalled, and every row must still be true. An unwired symbol with no row fails;
a row whose symbol has since become wired fails. 384 rows, checked in both
directions on every run.

Both directions needed a fix to work at all, and the reason is worth recording.
The test builds each key with a `describe` helper that appends
`(declared <file>)` for its failure message, so the original membership check
looked for a key no table has and could not fail for any input. Stripping that
suffix — what Gate 1's forward direction already did — turned 16 pre-existing
rows red. Every one of the 16 had exactly one `value`-strength reference, sitting
inside the module that declares the symbol: the confidence class §6 already names
as the weakest and the likeliest false positive. Those 16 rows, plus 264 more the
ruling exposed, are now declared with the reason each one deserves. The reverse
direction is no longer decorative, and no row depends on it being weak.

**Gate 2 — per-package.** A package with no reachable entry point cannot run, so
every one of its exports is unwired by inheritance. Those are declared in
`UNREACHABLE_PACKAGES` with an export count, and the count is re-derived and
compared. A new export in an unreachable package changes the count and fails.

**Gate 3 — dead gates.** Some operators are reachable *and* still cannot run
because the data they need is never produced. Those are declared in
`DEAD_GATES` together with the pattern that would prove the gate has opened. If
a producer ever appears, the declaration must be deleted and the gap fixed.
Gate 3 needs one accommodation the identifier search cannot give it: a dead gate
is usually expressed as a string literal, and blanking strings erases exactly
the evidence. `findLiteralProducers` searches the comment-blanked view with strings
intact, and accepts a match only when it *begins* on a character that survived
blanking. A match that starts inside a string is prose; a match that starts in
code and merely contains a literal is a real producer.

**Gate 4 — the ratchet on the total.** Gate 1 can be satisfied by declaring the
new thing: ten dead operators and ten rows is a green commit. Gate 4 is the only
gate that cannot be satisfied that way. It fails when the total count of uncalled
runtime exports rises above `UNCALLED_BASELINE`, so accepting growth is a
deliberate edit to one constant with a reason beside it.

`docs/testing-plan.md` made its own falsifier a precondition, and §4 records the
measurement it asked for. In short: the count is deterministic (five runs, eight
concurrent runs, three timezones, two locales and two working directories all
produce digest `e6e681876d468322` on the tree the baseline was taken against),
it ignores type-only exports and duplicate barrel re-exports, and adding one
operator *and calling it* moves it by zero.

**Why it fails in both directions.** A one-way ceiling goes slack every time
somebody wires something real: the count falls to 942, the baseline stays at 946,
and the next four uncalled exports pass with nobody deciding to allow them. Slack
is indistinguishable from permission once it exists. So falling below the
baseline fails too, with the opposite remedy — tighten the constant to the
measured value. That is what makes it a ratchet: the number moves only by someone
editing one constant on purpose, and the direction that costs effort is the
direction that obliges the edit.

## 4. Current inventory

Measured, not carried forward. `node --import tsx scripts/wiring-inventory.ts`
prints these figures and a digest of the canonical inventory; `--json` emits one
key-sorted array, so `diff` over your change names which exports moved rather
than only that the total did.

| Metric | Count |
|---|---|
| Production files scanned | 134 |
| Reachable from the entry roots | 69 |
| Exported runtime values | 1098 |
| Wired | 152 |
| Unwired | 946 |
| — unwired only because the package is unreachable | 562 |
| — unwired inside a reachable package (**need a declared reason**) | 384 |

The 384 each carry one reason: `core-types` 32, `gateway` 72, `integrations` 126,
`pipeline` 51, `security` 52, `telemetry` 51. They fall into four shapes, and the
count for each is in the table's own header comment: 120 rows that predate the
ruling, plus 264 it exposed — 109 that execute through a same-file reader, 152
that are inert, 3 with no call site at all. §6 explains the difference, because it
is the difference between "nobody names this" and "nobody runs this".

The 562 are inherited. Reachable packages: `cli`, `core-types`, `gateway`,
`integrations`, `pipeline`, `security`, `telemetry`. Unreachable: `canary` (28
exports), `eval` (348), `eval-live` (34), `gist` (6), `governance` (36),
`output-compress` (60), `testing` (50).

That `eval` and `eval-live` together hold 382 of the 1098 exports and are
unreachable says more about the evaluation harness being wired separately than
about the product being unwired. It is still counted honestly.

### This table was stale by nine exports, and the measurement is what corrected it

An earlier version of this section said **1089 exports / 152 wired / 937
unwired**, of which 383 local and 554 inherited. The tree says 1098 / 152 / 946.
The nine are accounted for, and every one of them was already visible in
`UNWIRED_OPERATORS` or `UNREACHABLE_PACKAGES` — the prose was what was stale,
not the declarations:

| Where | Then | Now | Where it happened |
|---|---|---|---|
| `eval` exports (inherited) | 343 | 348 | the hermetic corpus resolver, `1afd8b2` |
| `eval-live` exports (inherited) | 31 | 34 | the claims-audit operators `e151617`, then the subtractive arm `a03dbc3` |
| `telemetry` uncalled (local) | 50 | 51 | `EXPLICIT_UNHANDLED_EVENT_ALLOWLIST`, declared at `31539a6` |

That the numbers were stale for four commits while the gates stayed green is the
point of recording it here rather than quietly overwriting: the gates are
per-symbol and per-package, and none of them asserts a total. A per-symbol gate
cannot notice that the summary above it is wrong. Gate 4 is the assertion that
does, and it was written against the measured figures — declaring 937 would have
shipped a gate that failed on the commit that fixed this paragraph.


## 5. Named inert subsystems

A row in `UNWIRED_OPERATORS` says a symbol has no caller. These say what it would
take to give it one, and what would have to be true before that is safe.

**`gist` — 6 exports, unreachable, and the only code that deletes user data.**
No package in the workspace depends on `@strata-ctx/gist`; its own
`package.json` is the only reference to that name outside the package. The
eviction/recovery pair lives here: `runCompactionTransaction`
(`packages/gist/src/transaction.ts:322`) drops messages, and refuses to unless the
gist asserts `raw_recoverable` (`transaction.ts:155`), and `recoverTurns`
(`packages/gist/src/reversibility.ts:64`) is the code that puts them back. Neither
has ever run outside `packages/gist/test/`, which calls both directly. The
retention side is inert too: `ArtifactStore.remove`
(`packages/security/src/store.ts:702`) is called from `planGc`
(`packages/security/src/retention.ts:282`), which is only reachable from the
purge request handler, which nothing calls.

That makes this the one subsystem where "unwired" and "unsafe to wire" are the
same sentence. Turning on compaction without turning on recovery deletes
transcripts that nothing can reconstruct, and the guard that prevents it is a
field on a draft that no production path produces. If gist is ever connected, the
recovery path and the `raw_recoverable` guard have to land in the same change, and
the Gate 2 count has to be re-declared with the reason.

**`output-compress` — 60 exports, unreachable, held by decision.** `applyOutputCompression` is
declared at `packages/output-compress/src/compress.ts:340`. Its only other
references are the barrel at `packages/output-compress/src/index.ts:109` and tests
at `packages/output-compress/test/reference.test.ts:11` and `:319`. The
compression step is exercised by tests that call it directly and by nothing else.

*Measured before deciding whether to keep it* (2026-10-05, 40-row corpus, driven
through the real adapter egress paths rather than through the compressor alone):

| Host | estimated request tokens | chars | note |
|---|---|---|---|
| Anthropic | 1224 → 878 (**−28%**) | 4284 → 3072 | TOON raw string egresses intact |
| OpenAI-compatible | 1060 → 757 (**−29%**) | 4238 → 3026 | TOON raw string egresses intact |
| Gemini | 845 → 845 (**0%**) | — | normal results arrive as `{output: [...]}`, an object shape the classifier vetoes |

Governance and pinned text pass through unchanged in all three. **Held, not
deleted** (`docs/maturity.md` §3.2): the two-host saving is large enough to
revisit, but wiring it would add a fourth cross-stream edge (§12.1) and
`MACHINE_FORMATS` is unvalidated against real model output. Keeping the number
here is the point — "deferred" without a measurement is a guess, and a guess
cannot be revisited later by anyone who was not in the room.

**`B-3` — reachable and still inert.** `pointerizeBlocks` is called at
`packages/pipeline/src/truncate.ts:326`, and it is the only thing the
`pointerize` pipeline stage does, so the stage reports success. But
`isFileRead` at `packages/pipeline/src/pointer.ts:73` requires
`meta.subject.kind === 'file'`, and no reachable production source ever assigns
that: `anthropic-adapter.ts:49`, `gemini-adapter.ts:219` and
`openai-compat-adapter.ts:368` all build `{ kind: 'other', ref }`. The stage runs,
succeeds, and does nothing. `pointerizeBlocks` stays in `DEAD_GATES` as
`B-3-file-subject` with producer `/kind:\s*'file'/`; `isFileRead` moved to
`UNWIRED_OPERATORS`, because under the ruling nothing outside `pointer.ts` names
it either. One gate for the wired half, one row for the unwired half.

This is the case the ledger exists for. Every signal the project had — types,
tests, the presence of the call — said this code was live.

**`gateway` credential resolution — 16 rows, and production bypasses it.** The
whole of `packages/gateway/src/credentials.ts` is uncalled: `resolveCredential`
(`:206`), `applyCredentials` (`:268`), `applyCredentialsStrict` (`:291`),
`authHeaderFor` (`:251`), `redactHeaders` (`:87`), `redactSecret` (`:74`),
`isSensitiveHeader` (`:57`), `describeCredential` (`:110`), `nullKeyring`
(`:134`), `keyringAccount` (`:148`), `KEYRING_SERVICE` (`:31`),
`PROVIDER_ENV_VAR` (`:24`) and four error classes. Nothing calls any of them in
any file, including their own. Meanwhile `apiKeyHeader`
(`packages/gateway/src/server.ts:299`) reads the environment variable and
returns `{ 'x-api-key': key }` directly, so the key does reach the upstream — but
the header map is never redacted by name and no keyring, provider mapping or
failure mode in that file is ever consulted. Four of these rows previously gave
reasons describing call chains that do not exist; they now say what is actually
there.

Wiring this is not a matter of calling one function. `server.ts:301` is a
deliberate inline path, and until it is replaced by `applyCredentials` the
sensitive-header list is documentation rather than enforcement.

## 6. What the ledger cannot tell you

The ledger reports references, not execution, and the ruling in §2 moved the
error in both directions. Both halves matter, so both are stated.

### Live operators reported unwired (264 rows, 109 of them executing)

A symbol read only by a sibling function in its own file, which some other file
then calls, does run. The ledger still reports it unwired, because it counts
direct references and a grep-derived "wired" is not proof either. Those rows say
so in the reason — `no file outside X names it directly — it runs only through F,
which G:line calls` — and F is named with the file and line that invokes it.

Proving that chain needs one thing the name alone does not give: the citing file
must **import** the reader, or the chain is a coincidence of naming. That check
is not theoretical. `packages/integrations/src/claude-code-hooks.ts:388` calls
`redactText` — imported from `@strata-ctx/security` at line 46, not the identically
named `telemetry/redact.ts` export. `packages/gateway/src/gemini-adapter.ts:634`
is a `readonly usage:` interface field, not a call. An earlier pass of this
analysis reported both as live callers of telemetry exports, and both were wrong;
requiring the import binding moved three rows from live to inert and corrected
four witnesses.

### Uncalled operators that still run (false negatives, unchanged)

- **Callback and registry indirection.** A symbol stored in a map, passed to
  `register()`, or referenced by string key is one reference and no call site.
- **A reference that does not execute.** The name appears in a reachable file, in
  a branch that never runs. This is exactly how `B-3` was live-looking for so
  long; the ledger caught it only because someone wrote down the missing
  producer.
- **Unreachable code inside a reachable file.** Reachability is per module. A
  function nothing calls in a file that *is* imported still reads as wired.
- **Bare `:` type positions.** `const x: SomeClass` is lexically indistinguishable
  from a value, so it counts as a `value` reference and can mask a genuinely
  uncalled class. This is a deliberate trade: the alternative, treating every
  `: T` as a type position, would report `run: applyTruncate` at
  `packages/pipeline/src/truncate.ts:353` as unwired. It is a shorthand property
  value in a real object literal, so the conservative direction is correct.
- **Same-name exports in different packages.** `testing/isSensitiveHeader` and
  `gateway/isSensitiveHeader` are different symbols with the same name. The scan
  is per-name, so a caller of one can look like a caller of the other. It cannot
  invent a false *unwired* verdict, but it can invent a false *wired* one, and
  `output-compress/MACHINE_FORMATS` is currently in that position.

### Which way the bias points

Two different questions, two different safe directions. For "is this operator
called?", the ruling prefers to report **unwired** and make a human write down
why, because a false "wired" is invisible and a false "unwired" costs one row.
For "does this reference run?", the scan still prefers to count the reference,
because the cost of a false negative is a hidden defect and the cost of a false
positive is a deleted table row. Gate 3 inverts the bias again, for the same
reason: a dead gate that opens silently is the worst outcome this repository has
already lived through once.

## 7. Adding an operator

1. Write it and export it. That is the normal path — nothing here is unusual.
2. `npm test` fails, naming the symbol and its declaring file.
3. Call it. The test goes green on its own; no table edit needed.
4. If it genuinely should not be called yet, add one row to `UNWIRED_OPERATORS`
   with the reason. A vague reason is the only thing that will be reviewed out
   of band, so make it specific enough to be falsifiable — and if the operator
   runs through a same-file reader, say so and name the line that calls the
   reader.
5. **If the count moved at all, tighten `UNCALLED_BASELINE`.** Step 3 and step 4
   both change the total in step 4's case, and Gate 4 fails on the change in
   *either* direction. This is the step that surprises people: wiring an operator
   is an improvement and it still needs a one-line edit, because a baseline left
   high is permission for the next N dead exports. Wiring thirty operators and
   leaving the number alone is how a ceiling becomes a suggestion.

Run it with:

```
node --import tsx --test packages/testing/test/wiring-ledger.test.ts
node --import tsx --test packages/testing/test/wiring-ratchet.test.ts
```

## 8. Verification

The gate's own claim — that a new uncalled export fails the build, and that a row
which stops being true fails too — was checked by running the new declarations
against the *previous* implementation in a scratch copy of the tree, and by
temporary probes, each reverted immediately:

| Probe | Result |
|---|---|
| Two exported operators added to a reachable package | Gate 1 fails, naming both symbols and their file |
| One export added to `gist`, a declared-unreachable package | Gate 2 fails: `gist: declared 6, found 7` |
| A real `kind: 'file'` producer added to `pointer.ts` | Gate 3 fails: `B-3-file-subject: packages/pipeline/src/pointer.ts:287 now produces it` |
| The same pattern as a comment in `pointer.ts` | Gate stays closed |
| **The table as it stood when the ruling landed (367 rows), run against the pre-ruling scanner** | **Gate 1's reverse direction fails with 280 rows: the 264 the ruling exposed plus the 16 §3 describes. 432 wired before, 152 after. The table has since grown to 384, with the 16 in it** |
| A real call site added for a symbol Gate 1 declares unwired | Gate 1's reverse direction fails, naming the symbol |

The fourth row is the one that matters for trusting the third: it shows the dead
gate responds to code and not to prose. The fifth is the one that matters for not
trusting the first: a gate with a direction that cannot fail is half a gate, and
half is worth knowing about.

The 280-row result is also why the two claims in §6 are kept apart. The scanner
change and the table were developed against each other, and the table's reasons
were checked one at a time rather than generated and trusted: a claim that a
symbol runs through a reader is only written down when a reachable file imports
that reader and calls it.

### Gate 4, measured before it was adopted

`docs/testing-plan.md` made the falsifier a precondition, so the probes came
first. Every one ran in a scratch copy of the tree (`rsync` excluding
`node_modules`, `dist`, `.git`, `*.tsbuildinfo`), never in the working tree,
because three other agents were editing it at the same time. Two rounds: the
first asked what moves the count, the second asked whether the benign cases move
it. The scratch copy is itself checked first — it reads 1098 / 562 / 384 before
any mutation, so a delta is the mutation and not the copy.

**Determinism.** Five sequential runs, eight concurrent runs, three timezones, two
locales, and two working directories (`/` and the repo) all produced byte-identical
reports and digest `e6e681876d468322`. `collectProductionFiles` sorts by path,
`collectExports` dedupes by `package|name`, and `buildLedger` sorts its entries, so
nothing depends on `readdirSync` order.

**What moves the count.** Each row is one change to the scratch tree:

| Change | Δunwired | Reading |
|---|---|---|
| `export type { T }`, `export interface I` | 0 | types are erased; §2's claim holds |
| A type-only module reached through a barrel | 0 | the barrel walk skips it |
| `export type` added to an unreachable package | 0 | same rule, inherited half |
| `export {}` naming nothing new | 0 | no new name, no new entry |
| Barrel re-exports a symbol the barrel already exports | 0 | counted once, not twice |
| The same symbol re-exported through two modules | 0 | deduped by `package\|name` |
| A new module no barrel reaches | 0 | not reachable |
| A comment mentioning a function | 0 | comments are blanked |
| Trailing whitespace on a live line | 0 | formatting cannot move a count |
| A new `*.test.ts` exporting an operator | 0 | excluded |
| A `dist/` copy exporting a new name | 0 | excluded |
| `import '@strata-ctx/eval'` from a reachable file | 0 | **a bare import is not a reachability edge** — see below |
| **One new operator, wired, one caller in another reachable file** | **0** | **+1 export, +1 wired: the gate does not tax working code** |
| An unwired operator | +1 | what the gate is for |
| Two unwired operators | +2 | linear |
| Deleting an unwired operator | −1 | the ratchet must respond |
| Wiring 1 / 2 / 3 declared-unwired `gateway` exports | −1 / −2 / −3 | linear, and exactly `local` |
| One caller named `redactHeaders` added to `gateway` | −2 | −1 local, **−1 inherited**: it also flips `testing/redactHeaders` wired — §6 |
| An alias (`export { x as y }`) of a wired symbol | +1 | a rename is a new name on the surface |
| `export * as ns` over a module no barrel reaches | +2 | counted as `ns.member`, one per member |
| `export * as ns` over an already-reachable module | 0 | **missed** — §9 |
| `export declare const`, `export declare function` | +1 each | the one counted non-runtime; §9 |
| A new package nobody imports | +2 inherited | total rises too |
| `export * from '@strata-ctx/eval'` in a reachable barrel | **+301** | 946 → 1247; 562 → 213 inherited, 384 → 1034 local |
| `export * from` a *new* package in a reachable barrel | +4 local | 2 symbols, counted twice — §9 |

Four results in that table are worth more than the rest.

**The falsifier predicted noise and got none.** The plan's stated risk was that
barrel exports and type-only exports would make the count move for reasons that
have nothing to do with dead code. Neither does. One entry *is* counted without a
runtime binding — `export declare`, which `DECLARES` and `INLINE_DECL` both
accept — and the tree contains zero occurrences of it. §9 records that rather
than fixing it: changing the scanner's acceptance rules would move every declared
row, which is the blast radius §6 warns about, for a gain nobody can point at.

**Adding an operator and calling it moves the total by zero.** That is the row
that decides the whole design. A gate that fired on it would be taxing the one
behaviour §1 asks for, and it would be muted within a week — the fate
AGENTS.md §10 records for the `TOOL_ALIASES` checker, which reported six working
tools as unserveable until someone noticed the names went through a resolver.

**A bare import is not a reachability edge, and that surprised the probe.** Adding
`import '@strata-ctx/eval'` to a reachable file moved nothing at all: still 69
reachable files, still 562 inherited. Reachability follows *barrel re-exports*
only, so what actually pulls a package in is `export * from '@strata-ctx/eval'`
in a barrel somebody already reaches — and that one line moves 301 exports at
once, 47 of which the re-export makes newly wired. It is the largest single-step
move in the table, and Gate 4 reports it as `total 946 -> 1247` with no
interpretation required. Gates 1 and 2 also fail on it, for the same edit.

**Reaching another package's barrel attributes its symbols to the re-exporter.**
`export * from '@strata-ctx/eval'` records eval's exports under `pipeline`,
which is why inherited drops and local rises by nearly the same amount. The
symbols are the same; only the key they are filed under moves. Worth knowing
before reading a `local` jump as new dead code.

**Gate 4's own two directions, probed against the real gate file.** Each row runs
both `wiring-ledger.test.ts` and `wiring-ratchet.test.ts` in a scratch copy:

| Probe | Gates 1–3 | Gate 4 |
|---|---|---|
| Three unwired operators, each with a declared `UNWIRED_OPERATORS` row | **green, 30/30** | red: `total 946 -> 949 (+3)`, `local 384 -> 387 (+3)`, `pipeline: 51 -> 54 (+3)` |
| One new operator, wired by a caller in another reachable file | **green, 35/35** | **green** |
| A module exporting only `export type` + `export interface` | **green, 35/35** | **green** |
| The barrel re-exports a symbol it already exports | **green, 35/35** | **green** |
| Three declared-unwired `gateway` exports gain a caller | Gate 1 red: the three rows are no longer true | red: `total 946 -> 943 (−3)`, `local 384 -> 381 (−3)`, `wired 152 -> 155 (+3)` |
| An unwired export is deleted | Gate 1 red: stale rows | red: `total 946 -> 945 (−1)`, `local 384 -> 383 (−1)` |

The first row is the row's whole justification. Three dead operators and three
honest reasons for them is a green commit under every pre-existing gate, and it
should not be.

The last two rows are the price, and they were accepted deliberately rather than
discovered later. A ceiling that never tightens is a number nobody maintains, and
the cost is one line in a file whose owner is the person who made the change.

**Three of these probes were wrong before they were measured, in the same way.**
The first "wired operator is benign" probe exported a *helper* to make the call
reachable, and the helper was itself an uncalled export — so Gate 1 failed and
Gate 4 rose, and the probe "proved" the opposite of its point. The second had a
module re-exported both plainly and as a namespace, and its own +1 export hid
the −2 it was measuring. The third wired three names and reported −2. The rule
that came out of it: reachability is a property of the *file*, not of the
reference, so a probe's caller must export nothing — and a probe that adds an
export has to add it to both sides of the arithmetic or it is measuring itself.
The rows above are the re-run versions; the four wrong numbers never reached this
table.

## 9. Limitations

The scanner is lexical, not a parser. It tracks braces well enough to skip
`export type { ... }` clauses, but it does not build an AST and does not resolve
scoping, shadowing, or re-binding. It searches `packages/` and `tools/`; adding a
production source tree elsewhere means adding it to the scan roots. It does not
resolve dynamic `import(specifier)` with a computed argument, and it treats a
same-named export in another package as the same symbol — see §6.

Four limitations were found by the §8 probes rather than by reading the code, and
all four are recorded here instead of being fixed, because each fix would move
the declared rows:

- **`export declare const` / `function` is counted though it is erased at
  runtime.** `DECLARES` and `INLINE_DECL` both accept it, so it is an export with
  no runtime binding. Zero occurrences in the tree, so the 946 baseline is
  unaffected today; the first one added would cost a declared row it should not
  need.
- **`export * as ns` over an already-reachable module is missed entirely.**
  `collectExports` dedupes by resolved path and its `seen` set ignores the
  namespace prefix, so once a module has been visited under any prefix, the
  namespaced visit adds nothing. Measured: the same module reached both plainly
  and as `ns` yields +0 where two new names exist. This is the one bias that
  points the wrong way — an uncalled namespaced operator would not be counted, so
  neither Gate 1 nor Gate 4 would see it.
- **Reaching another package's barrel files its symbols under the re-exporting
  package.** `collectExports` takes the package from the barrel being walked, so
  `export * from '@strata-ctx/eval'` in `pipeline`'s barrel records eval's
  exports as `pipeline/*`. The count is not wrong; the attribution is. A
  cross-package runtime re-export also double-counts, since the symbol then
  appears under both package keys. The tree has exactly one cross-package
  re-export and it is `export type`, so nothing is double-counted today.
- **Reachability follows barrel re-exports only.** A bare
  `import '@strata-ctx/eval'` in a reachable file makes no package reachable and
  changes no count. That is a defensible definition — the inventory is about what
  the public barrels expose — but it means an import nobody re-exports is
  invisible to all four gates.
