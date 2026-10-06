# How strata-ctx works

*A plain-language guide. No jargon you don't need, no numbers that a command could compute.*

If you want the engineering detail, go to [`architecture.md`](architecture.md). If you want to
evaluate whether this product is real, go to [`maturity.md`](maturity.md), which is written to be
believed only when it disagrees with you. This document is for someone deciding whether the idea
makes sense.

---

## 1. The problem, stated honestly

You use a coding agent. It reads files, runs commands, and works for hours. Everything it sees goes
into a fixed-size window called **context**. Two things happen as that window fills.

**Overflow.** The window runs out. You get an error. Annoying, but honest — the system tells you
something is wrong.

**Rot.** Accuracy starts slipping *long before* the window fills. The agent gets vaguer, starts
re-reading things it already read, contradicts instructions it followed ten minutes ago. Nothing
tells you. The window isn't full. It just isn't working as well as it did at the start.

Every agent framework responds the same way: **compact** — throw away the transcript, replace it
with a summary. That is where this project starts, because compaction turned out to be dangerous
in a specific and measurable way.

### The finding that motivates everything

Recent research measured what happens to your safety rules when an agent compacts. The results
(cited in [`spec.md`](spec.md) §1 and `NOTICE`; numbers live there so they cannot rot here):

- After five rounds of ordinary compaction, **only about 10% of original safety rules survived**.
- Policy violations caused *purely by compaction* — the agent behaved fine until it summarized —
  ran from near-zero to **30%**.
- The strongest signal: when a rule survived, violations were **0%**. When it was dropped,
  violations were **38%**.

That last row is the whole argument. **The summarizer is not deciding what to keep, it is deciding
what your safety rules are worth.** And it does not know.

There's a second, sneakier finding: soft organizational policies — "prefer the existing style,"
"ask before migrating the database" — decayed roughly **8× worse** than hard rules like "never
commit secrets." Because the models were trained to never violate hard rules, they *looked* fine.
The damage was happening in the policies nobody was measuring.

### So what is the gap?

Every agent compresses. Almost none of them can answer three questions afterward:

1. Was the compression **safe** — are my constraints still in there?
2. Did it cost me **accuracy** — is the agent still as good at the task?
3. What did it actually **save** — in tokens, in dollars, net of what the compression itself cost?

Most tooling answers none of these. Some answer #3 badly, by reporting gross savings while the
summary it generated costs almost as much as the tokens it removed.

---

## 2. What this product is

A **local proxy** that sits between your agent and the model provider. Your agent talks to it; it
talks to Anthropic, Gemini, or anything OpenAI-compatible. It runs on your machine, on
`127.0.0.1`, and it doesn't send your code anywhere new.

```
  your agent  ──▶  strata-ctx  ──▶  Anthropic / Gemini / OpenAI-compatible
                 (127.0.0.1)
```

It does three jobs, in priority order:

**Keep your rules in.** Your constraints are held in a buffer that summaries can't write to. They
go into every request, every turn, no matter what happened to the transcript in between.

**Shrink the boring parts.** Duplicate file reads collapse. Enormous log dumps get replaced with a
reference plus a checksum. Already-resolved issues get triaged out of the working context. None of
this uses a model, so it costs nothing and behaves the same every time you run it.

**Tell you the truth about cost.** Every stage reports what it took in and gave out. The report
separates *gross* savings from *net* savings, because generating a summary costs tokens too, and a
tool that reports only the flattering half is lying by omission.

### What it is not

Worth being blunt, because these are the pitches it looks like it should be making:

- **Not a memory system.** No vector store, no retrieval substrate. Those are real products and
  hard ones. If you run one, this complements it.
- **Not a model.** No fine-tuning, no learned compressor. Everything above the deterministic floor
  is optional and off by default.
- **Not a hosted service.** It runs on your laptop. Your transcripts stay there.
- **Not an IDE.** It works with the one you have.
- **Not going to claim compression makes your agent smarter.** The bar is *no worse, and cheaper*.
  That is a lower, more boring, more honest bar, and it is the one the tests enforce.

---

## 3. The three ideas

Everything in this codebase traces back to one of these.

### Idea 1 — Governance is code, never a model

The best safety results in the research came from **deterministic mechanisms**, not from a better
LLM summarizer. So constraints live in an immutable buffer, re-injected on every request:

```
  Final_Context = Compact(history)  ∪  PinnedRules
```

A model may summarize your work. **A model may never decide whether a safety rule is worth
keeping.** The type system enforces this too — the compiler rejects code that would let a lossy
stage touch a governance block, so this isn't a convention you can forget.

### Idea 2 — Deterministic before learned

Deduplication, truncation, log severity filtering, and self-gist all cost **zero** model calls.
The gist trick is the neat one: the agent writes a short structured summary **inside a turn it was
going to send anyway**. No extra request. No extra cost. The agent summarizes itself because it was
already talking.

Learned compression, if it ever arrives, sits *above* this floor and can only ever be an
improvement — never a dependency.

### Idea 3 — Claim non-inferiority, not improvement

The release bar is: **same task quality, fewer net tokens, zero policy violations.**

This is deliberately unambitious. It is also the only bar that's verifiable. A feature that can't
clear a pre-registered test doesn't ship. And the test suite includes a **negative control** — with
the safety features switched off, the tests must *reproduce* the failure. A safety test that passes
either way is not a test.

---

## 4. How a request actually flows

Concrete, because "it just works" is not a description.

**You** type a request in Claude Code, Gemini CLI, or anything else.

**The proxy receives it** and translates the provider's format into one internal representation —
the *canonical model* — so the rest of the system doesn't care which provider you're using.

**Tier 0 runs.** Three pure functions, fixed order, no model calls:

| Stage | What it does | Why |
|---|---|---|
| `dedupe` | Drops file reads already superseded by a newer version | Re-reading is pure waste |
| `truncate` | Caps oversized blocks, head and tail, **keeps every ERROR/FATAL line** | The error is the signal; the middle is noise |
| `triage` | Routes by content type — **governance never gets summarized** | Safety text is not compressible by definition |

**Your rules go in.** The pinned buffer is materialized into the request. Last thing that touches
the state, deliberately: anything before it could be dropped by the next stage, which would make
the guarantee true in a test that never compacts and false in the only place it matters.

**Bits get verified.** Tool output is scanned for credentials before anything is stored or
summarized.

**Telemetry is emitted** — per stage, in and out — *before* the response leaves. So a logging
failure can never cost you your work.

**The request goes upstream.** If no transform applies, the bytes are byte-identical. The proxy is
invisible when it's not doing anything.

### When something goes wrong

**Fail open, always.** Any stage that errors, or produces something malformed, gets discarded and
the original context is sent unmodified. Losing your session to save tokens is not an acceptable
trade, and a proxy that returns a 500 is a proxy the agent routes around.

This is worth being precise about, though, because there's one deliberate exception. If the
**pinning** stage fails, the turn fails open rather than proceeding — the original bytes go
upstream *and* the failure is reported loudly. The content isn't better either way, but silence
would be worse: you'd have a request quietly missing a safety rule and a report claiming success.

---

## 5. Where it stands today

Stated plainly, because a product page that oversells gets discovered later and costs more trust
than it earned.

**Working on the request path:** the three Tier 0 stages, constraint pinning with drift detection,
secret redaction, telemetry with net-vs-gross cost accounting, and a deterministic floor that
refuses enumerated destructive commands (`rm -rf`, force-push, `DROP TABLE`, setuid, writes to
`authorized_keys`).

**Built but not wired:** gist eviction (the code that actually deletes transcripts) and output
compression. Eviction is off on purpose — it's the only destructive code here, so recovery landed
first and enabling deletion comes later.

**Not implemented:** semantic policy enforcement. Nothing reads the *meaning* of your constraint and
judges a command against it. The floor is enumerated rules, not intent — `mv /data /dev/null` and a
command assembled from variables at runtime get through. A policy written as prose cannot yet veto
an action it has no literal rule for.

**Never run:** the live A/B campaign against real models. No provider credential, so every live
claim is currently `unsupported`. The offline harnesses are done and passing.

For the evidence behind each of these, [`maturity.md`](maturity.md) is written specifically to be
falsifiable — it names what each claim rests on and what the wiring scan cannot tell you.

---

## 6. Who this is for

**Good fit:** you run a coding agent for hours at a stretch; you work somewhere with rules that
matter (production systems, regulated data, shared infrastructure); you have been burned by an
agent forgetting an instruction; you want to *see* what your tooling is doing to your context.

**Poor fit:** you want a smarter model. This doesn't make models smarter. You want a chat memory
that remembers things across projects — use a memory product, this isn't one. You're curious
whether compaction is dangerous — this is a strong signal that it's worth caring about, and the
research in `NOTICE` is a fine starting point on its own.

---

## 7. The honest objection

> *"Won't compressing the context just make my agent dumber?"*

Sometimes, yes. Iterative refinement tasks — where you keep saying "no, do it this other way" — are
exactly where compression hurts most. That's a known failure mode, not a surprise, and it's a
**hard release gate**: if the agent gets meaningfully worse at refinement, the feature doesn't ship.

Which is why the design leans on reversal rather than cleverness. Every gist records which turns it
replaced, so the original can be pulled back. And the ambitious half of the system — the part that
deletes transcripts — is currently switched off.

The realistic claim is not "compression is free." It's: **"compression that you can audit, reverse,
and measure."** That is a smaller promise than the market is currently making, and it is one that
can be kept.