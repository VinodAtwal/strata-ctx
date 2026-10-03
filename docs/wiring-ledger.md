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
1089 exports wired before it, 152 after. The gap was almost entirely code that
*does* run, through a sibling in its own file that something else calls. §6 says
how each of those rows is labelled, because "the ledger says unwired" and "the
operator is inert" are different claims and only one of them is mechanical.

### Reference confidence

A reference only counts as a caller when it is one of `call`, `new`, `value`, or
`import`. Of the 152 wired entries the current tree reports: 87 `call`, 56
`value`, 5 `new`, and 4 with a bare `import` and nothing stronger.

`value` is the weakest of these and the most likely source of a false negative;
see §6. An `import` with no call is weaker still: the symbol is reachable but
nothing invokes it, so it is wired only in the sense that a module could.

## 3. The three gates

All three live in `packages/testing/test/wiring-ledger.test.ts`.

**Gate 1 — per-operator, both directions.** Every locally unwired symbol needs a
row in `UNWIRED_OPERATORS` naming its declaring file and why it is allowed to be
uncalled, and every row must still be true. An unwired symbol with no row fails;
a row whose symbol has since become wired fails. 383 rows, checked in both
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
is usually expressed as a string literal, and blanking strings erases exactly the
evidence. `findLiteralProducers` searches the comment-blanked view with strings
intact, and accepts a match only when it *begins* on a character that survived
blanking. A match that starts inside a string is prose; a match that starts in
code and merely contains a literal is a real producer.

## 4. Current inventory

| Metric | Count |
|---|---|
| Production files scanned | 134 |
| Reachable from the entry roots | 69 |
| Exported runtime values | 1089 |
| Wired | 152 |
| Unwired | 937 |
| — unwired only because the package is unreachable | 554 |
| — unwired inside a reachable package (**need a declared reason**) | 383 |

The 383 each carry one reason: `core-types` 32, `gateway` 72, `integrations` 126,
`pipeline` 51, `security` 52, `telemetry` 50. They fall into four shapes, and the
count for each is in the table's own header comment: 119 rows that predate the
ruling, plus 264 it exposed — 109 that execute through a same-file reader, 152
that are inert, 3 with no call site at all. §6 explains the difference, because it
is the difference between "nobody names this" and "nobody runs this".

The 554 are inherited. Reachable packages: `cli`, `core-types`, `gateway`,
`integrations`, `pipeline`, `security`, `telemetry`. Unreachable: `canary` (28
exports), `eval` (343), `eval-live` (31), `gist` (6), `governance` (36),
`output-compress` (60), `testing` (50).

That `eval` and `eval-live` together hold 374 of the 1089 exports and are
unreachable says more about the evaluation harness being wired separately than
about the product being unwired. It is still counted honestly.

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

**`output-compress` — 60 exports, unreachable.** `applyOutputCompression` is
declared at `packages/output-compress/src/compress.ts:340`. Its only other
references are the barrel at `packages/output-compress/src/index.ts:109` and tests
at `packages/output-compress/test/reference.test.ts:11` and `:319`. The
compression step is exercised by tests that call it directly and by nothing else.

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

Run it with:

```
node --import tsx --test packages/testing/test/wiring-ledger.test.ts
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
| **The table as it stood when the ruling landed (367 rows), run against the pre-ruling scanner** | **Gate 1's reverse direction fails with 280 rows: the 264 the ruling exposed plus the 16 §3 describes. 432 wired before, 152 after. The table has since grown to 383, with the 16 in it** |
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

## 9. Limitations

The scanner is lexical, not a parser. It tracks braces well enough to skip
`export type { ... }` clauses, but it does not build an AST and does not resolve
scoping, shadowing, or re-binding. It searches `packages/` and `tools/`; adding a
production source tree elsewhere means adding it to the scan roots. It does not
resolve dynamic `import(specifier)` with a computed argument, and it treats a
same-named export in another package as the same symbol — see §6.
