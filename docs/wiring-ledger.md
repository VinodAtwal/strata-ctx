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

### Reference confidence

A reference only counts as a caller when it is one of `call`, `new`, `value`, or
`import`. Of the 429 wired entries the current tree reports: 202 `call`, 186 `value`, 41 `new`, 0 bare
`import`.

`value` is the weakest of these and the most likely source of a false negative;
see §6.

## 3. The three gates

All three live in `packages/testing/test/wiring-ledger.test.ts`.

**Gate 1 — per-operator.** Every locally unwired symbol needs a row in
`UNWIRED_OPERATORS` naming its declaring file and why it is allowed to be
uncalled. A symbol that is unwired but not declared fails. A row whose symbol has
since become wired is meant to fail too — that is the direction which stops the
table decaying into a graveyard of excuses — **but that direction is currently
vacuous and proved as such, not assumed**: the test builds each key with the
`describe` helper, which appends `(declared <file>)` for its failure message, so
the membership check looks for a key no table has. Stripping that suffix — what
Gate 1's other direction already does — turns 16 pre-existing rows red. Every one
of the 16 has exactly one `value`-strength reference and it sits inside the
module that declares the symbol, which is the confidence class §6 already names
as the weakest and the likeliest false positive. So whether a self-reference
counts as a caller is a question with a surface-wide answer, it is the ledger
owner's to decide, and until it is answered the forward direction is the only
one carrying weight.

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
| Exported runtime values | 1084 |
| Wired | 429 |
| Unwired | 655 |
| — unwired only because the package is unreachable | 552 |
| — unwired inside a reachable package (**need a declared reason**) | 103 |

The 103 need one reason each: `core-types` 11, `gateway` 19, `integrations` 23,
`pipeline` 16, `security` 15, `telemetry` 19.

The 552 are inherited. Reachable packages: `cli`, `core-types`, `gateway`,
`integrations`, `pipeline`, `security`, `telemetry`. Unreachable: `canary` (28
exports), `eval` (343), `eval-live` (29), `gist` (6), `governance` (36),
`output-compress` (60), `testing` (50).

That `eval` and `eval-live` together hold 372 of the 1081 exports and are
unreachable says more about the evaluation harness being wired separately than
about the product being unwired. It is still counted honestly.

## 5. Named inert subsystems

**`gist` — 6 exports, unreachable.** `packages/gist/src/index.ts` re-exports only
`transaction.js` and `reversibility.js`, giving six runtime values including
`runCompactionTransaction` and `verifyGovernanceRoundTrip`. No package imports
`@strata-ctx/gist`. The compaction engine described in the architecture is not
connected to the server.

**`output-compress` — 60 exports, unreachable.**
`applyOutputCompression` is declared at
`packages/output-compress/src/compress.ts:340`. Its only other references are the
barrel at `packages/output-compress/src/index.ts:109` and tests at
`packages/output-compress/test/reference.test.ts:11` and `:319`. The compression
step is exercised by tests that call it directly and by nothing else.

**`B-3` — reachable and still inert.** `pointerizeBlocks` is called at
`packages/pipeline/src/truncate.ts:326`, and it is the only thing the
`pointerize` pipeline stage does, so the stage reports success. But
`isFileRead` at `packages/pipeline/src/pointer.ts:73` requires
`meta.subject.kind === 'file'`, and no reachable production source ever assigns
that. The stage runs, succeeds, and does nothing. Declared in `DEAD_GATES` as
`B-3-file-subject` with producer `/kind:\s*'file'/`.

This is the case the ledger exists for. Every signal the project had — types,
tests, the presence of the call — said this code was live.

## 6. False negatives, stated plainly

The ledger reports references, not execution. These are ways an uncalled
operator can still look wired:

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

The conservative bias is consistent: when unsure, the ledger prefers to look
wired and let a human add a row, rather than cry wolf on every type annotation.
Gate 3 inverts the bias, because there the cost of a false negative is a hidden
defect and the cost of a false positive is one deleted table row.

## 7. Adding an operator

1. Write it and export it. That is the normal path — nothing here is unusual.
2. `npm test` fails, naming the symbol and its declaring file.
3. Call it. The test goes green on its own; no table edit needed.
4. If it genuinely should not be called yet, add one row to `UNWIRED_OPERATORS`
   with the reason. A vague reason is the only thing that will be reviewed out
   of band, so make it specific enough to be falsifiable.

Run it with:

```
node --import tsx --test packages/testing/test/wiring-ledger.test.ts
```

## 8. Verification

The gate's own claim — that a new uncalled export fails the build — was checked
by temporary probes, each reverted immediately:

| Probe | Result |
|---|---|
| Two exported operators added to a reachable package | Gate 1 fails, naming both symbols and their file |
| One export added to `gist`, a declared-unreachable package | Gate 2 fails: `gist: declared 6, found 7` |
| A real `kind: 'file'` producer added to `pointer.ts` | Gate 3 fails: `B-3-file-subject: packages/pipeline/src/pointer.ts:287 now produces it` |
| The same pattern as a comment in `pointer.ts` | Gate stays closed; 24 tests pass |
| A real call site added for a symbol Gate 1 declares unwired | **Gate stays closed too** — the reverse direction does not work. Recorded in §3 rather than quietly fixed, because the fix exposes 16 rows that are not this table's business to re-adjudicate |

The fourth row is the one that matters for trusting the third: it shows the dead
gate responds to code and not to prose. The fifth is the one that matters for not
trusting the first: a gate with a direction that cannot fail is half a gate, and
half is worth knowing about.

## 9. Limitations

The scanner is lexical, not a parser. It tracks braces well enough to skip
`export type { ... }` clauses, but it does not build an AST and does not resolve
scoping, shadowing, or re-binding. It searches `packages/` and `tools/`; adding a
production source tree elsewhere means adding it to the scan roots.