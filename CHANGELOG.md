# Changelog

All notable changes to strata-ctx. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html), with one exception
described under [Versioning](#versioning).

Migration notes live in [`docs/releases/`](docs/releases/), one file per version. The release
workflow will not cut a tag without one.

---

## [Unreleased]

Nothing here has been published. `@strata-ctx/core-types` exists on the npm registry with **no
versions**; every other package is `"private": true`. This section is the state of the tree, not a
release.

### Added

- **The frozen contract.** `@strata-ctx/core-types@1.0.0` — 114 exports, digest `0a3c0fea6360e6d9`,
  hash-locked in `packages/core-types/contract.lock.json`. Every other package compiles against it
  and nothing else crosses a stream boundary, with two documented exceptions
  (`integrations → security`, `integrations → telemetry`, both deliberate: agent hooks are where
  untrusted text and credential headers actually arrive). [AGENTS.md §12.1](AGENTS.md)
- **The gateway.** HTTP/SSE proxy with `anthropic`, `openai-compat`, `gemini` and `mock` ingress and
  egress adapters, SSE passthrough that never buffers, credential passthrough, and a `GET /healthz`.
- **Governance pinning.** An immutable pinned set materialised into every outbound request, plus a
  byte-equality validator, post-compaction re-assertion, and a type-level guarantee that a governance
  block is *unrepresentable* on any lossy stage. This is the product: everything else is an
  efficiency claim, this one is a safety claim. [decisions R1, R8](docs/decisions.md)
- **The deterministic pipeline.** Dedupe, truncate, pointer-ize, triage, severity classification,
  with per-stage error isolation so a throwing stage degrades to unmodified passthrough rather than
  a 502.
- **The gist engine** and the `flush → write → gist → validate → commit → repin → evict → log`
  transaction, with `fsync`-before-evict and reversibility (`ctx_get_task`).
- **Telemetry**: token and cost accounting reported as gross *and* net, local-only sinks, redaction
  in every sink.
- **Agent integrations** for Claude Code (including the `PostToolUse` result-rewriting hook, the
  highest-leverage mechanism in the project), Gemini CLI, Aider, Cline/Roo, Copilot (MCP-only,
  explicitly labelled *no governance guarantee*), and an OpenCode plugin. A `surface-check` gate
  fails CI when a vendor's extension schema drifts.
- **The offline eval harness** (fixture format, interleaved runner, stable reporter, mock arm) and
  the statistics that go with it (McNemar exact, paired bootstrap, non-inferiority, Benjamini–
  Hochberg).
- **Developer infrastructure**: four CI lanes with a self-check that proves the contract gate *can*
  fail, a weekly agent-surface sweep, and a local dev loop (`docker compose up`).

### Not yet

- **Nothing compresses.** The lossy stages are in place, but no end-to-end compaction is claimed yet.
  The honest current claim is "context is preserved and measured", not "context is reduced".
- **No release has been cut.** The release pipeline exists and is green-capable; the manifests still
  need the changes listed in the first release note before a tag means anything.
- **Blocked on the outside world:** `B-9` (Tier 3 local-model narration) needs a running Ollama,
  `F1-4` needs a cleared 3-repo corpus, `F2-1`–`F2-3` need live model-provider credentials and real
  agent surfaces. None of them are startable. [AGENTS.md §7](AGENTS.md)

---

## Versioning

A release is a **train**: one tag, `v<major>.<minor>.<patch>`, and every package in the train
carries that version. The tag is the version. There is no independent per-package release, because a
monorepo release that publishes half a dependency graph produces packages that install and then
fail at runtime.

`@strata-ctx/core-types` is the one exception and it is not a special case in the tooling so much as
a policy: it is semver-locked at `1.0.0` and moves only with an explicit re-freeze
(`npm run contract:update`, in its own commit, with the contract owner). Every other package depends
on it, so a `core-types` bump is not a release, it is an event. [decisions R5](docs/decisions.md)

**The tag must be reachable from the protected release branch.** A tag that is not on `main` is not
reviewed work, and the release workflow refuses to publish it.

### Cutting a release

1. Write the release note: copy [`docs/releases/TEMPLATE.md`](docs/releases/TEMPLATE.md) to
   `docs/releases/<version>.md` and fill it in, including the `## Migration` section. Every release
   has one, even when the answer is *no migration required* — that answer is the useful part.
2. Rename the `## [Unreleased]` heading above to `## [<version>] - <today's UTC date>`.
3. Bump every publishable `packages/*/package.json` to that version. `core-types` does not move.
4. Tag and push. The workflow plans, verifies, audits the tarballs, publishes in dependency order,
   and writes the GitHub release from the two files above.

The workflow enforces steps 1 and 2 as gates rather than as conventions: a tag with an undated
changelog entry, or with no migration note, does not publish. A release process nobody has to
remember is the only kind that survives a deadline.

---

## References

- Release notes: [`docs/releases/`](docs/releases/)
- Design decisions and risk register: [`docs/decisions.md`](docs/decisions.md)
- Task board: [`docs/tasks.csv`](docs/tasks.csv)
