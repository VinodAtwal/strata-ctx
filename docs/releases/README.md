# Release notes

One file per released version, named `<version>.md` — `0.1.0.md`, not `v0.1.0.md`, because the tag
carries the `v` and the version does not. `CHANGELOG.md` is the narrative; these are the upgrade
instructions.

**Every release has a file here, and the release workflow will not publish without one.** That
includes the ones where nothing changed: *no migration required* is an answer, and it is the most
useful answer, because it is the one a reader is least able to infer from a diff. A release note
whose whole content is a changelog link is not a release note.

## Index

| Version | Tag | Released | Notes |
|---|---|---|---|
| — | — | — | nothing published yet |

## What belongs in a note

A note answers three questions, in this order, and a reader who only reads the first one has still
got what they needed:

1. **Do I have to do anything?** The `## Migration` section says so in the first sentence. If
   nothing, say `None — no interface changed.`
2. **What will break, and how do I fix it?** Named symbols, named files, before → after. Not
   "the API has changed"; the interface *is* the answer.
3. **What should I read before upgrading?** The `## Why` section, for anyone whose decision depends
   on understanding the change rather than applying it.

Start from [`TEMPLATE.md`](TEMPLATE.md). Keep it short. A note nobody finishes is a note nobody
acts on.

## Cutting one

1. Copy the template to `<version>.md`.
2. Fill in every section, including the ones that are currently "None". A template with placeholder
   text left in it is worse than no template, because it looks finished.
3. In the root `CHANGELOG.md`, rename the `## [Unreleased]` heading to
   `## [<version>] - <today's UTC date>`.
4. Add the row to the index above, and update the version in it.
5. Tag and push. The gate in `.github/workflows/release.yml` re-checks 1–3: the changelog heading
   must match `## [<version>] - YYYY-MM-DD` exactly, `<version>.md` must exist, and it must contain
   a `## Migration` heading.

## What a release actually does

The pipeline plans the train from the manifests, verifies the same four lanes CI runs plus the
agent-surface gate, audits what each tarball would really contain, publishes in dependency order
(`core-types` first — everything compiles against it), and builds the GitHub release from
`CHANGELOG.md` and the file in this directory, so the published release and the committed changelog
cannot end up describing different trains.

Two properties worth knowing, because they are the reason a tag is not a publish button:

- **A tag has to be on the protected release branch.** The workflow checks reachability against
  `origin/main` before anything else runs. A tag on a fork, or on a branch, does not publish.
- **A publish token is required and its absence is a hard failure.** `secrets.NPM_TOKEN` must be an
  npm *automation* token; a classic token cannot publish provenance-attested packages, and the
  workflow says so rather than failing at the last step.

If you want a release reviewed before it can run, protect `main` with a required-review rule. If
you want a second pair of eyes on the tag specifically, add a GitHub environment with required
reviewers to the `publish` job and reference it by name — that is a repository setting, not a
workflow one, which is why it is not hardcoded here.
