# <version> — <one line: what a reader needs to know>

<!--
  Copy this file to docs/releases/<version>.md and fill it in. Delete this
  comment. Replace every placeholder, including the ones whose answer is "None"
  -- a placeholder left in place reads as finished, and the release gate only
  checks that the `## Migration` heading exists, not that it says anything.
  The gate is a floor, not a substitute.
-->

**Tag:** `v<version>` · **Released:** <YYYY-MM-DD> · **Packages:** `<name>@<version>`, …

## Migration

<!-- The first sentence is the whole section for most readers. Answer it literally. -->

None — no interface changed.

<!-- Or, if something did:

  ### <what changed>

  | Before | After |
  |---|---|
  | `old.symbol()` | `new.symbol()` |

  `<why it moved, and what to do instead>`

  Breaking changes only, in the order a reader will hit them. If a change is
  additive, say so here rather than burying it -- "additive" is a migration
  note too, and it is the one people most often have to go looking for.
-->

## Why

<!--
  For the reader whose decision depends on understanding rather than applying.
  What was true before that is no longer true, and what replaces it.

  Cite the source. Every non-obvious number in this project links to a paper or
  carries a TODO(owner), and a release note is the last place a number gets
  quoted without one.
-->

## Upgrade checklist

<!--
  Ordered, and each line something you can check. "Review the changelog" is not
  a checklist item; it is the reason this file exists.
-->

- [ ] `npm install @strata-ctx/<package>@<version>`
- [ ] …

## Known issues

None known.

<!--
  Or the real list, with the version it was fixed in. A release note that says
  "none known" when three issues are open is worse than an empty section: the
  first is a claim, and a false one is the kind people stop believing.
-->
