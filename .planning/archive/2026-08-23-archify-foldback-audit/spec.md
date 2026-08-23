# archify-foldback-audit — spec

The three fold-back items that `archify-general-deck` carried as documented prose become
code + tests. Scope is `bun-apps/s2-agent-ext-archify/` only.

## 1. Problem

1. **Skeleton discovery has no shipped seam (t09-review item a).** `discoverDeckSkeletons(root)`
   locates the shipped tier through `pkgRoot()` only. Unlike `loadRegistry`, there is no way for a
   caller — above all a test — to point it at a different-root shipped tree without dropping files
   into the package, so the "different-root tests absent" gap persists.
2. **`$ARCHIFY_TEMPLATES` is ignored for skeletons (item b).** The user-tier env dir that
   `loadRegistry` honors for layouts is invisible to skeleton discovery. A user who puts a
   deck outline under `$ARCHIFY_TEMPLATES/decks/` never sees it in the catalog.
3. **`title-overflows` fires on title-suppressed layouts (item c).** `quote` (`chrome: {title:false}`)
   and `end` (`chrome: false`) never draw the title band, but `lintDeck` only exempts `statement`.
   An authored long `title` on either is a false `error` that blocks a build that would render fine.

## 2. Decisions

- **D1 — mirror the layout-registry tier for skeletons.** `discoverDeckSkeletons(opts)` where
  `opts = { root?, env?, shippedDir? }`. Search order, first hit wins, shadowed names dropped:
  user tier = each `$ARCHIFY_TEMPLATES` dir `<dir>/decks` (in env order), then
  `<root>/templates/decks`; shipped tier = `opts.shippedDir/decks` (or `<pkgRoot>/templates/decks`).
  `root`/`env`/`shippedDir` all default to current behavior when omitted (`root` required only via the
  one call site; default from `ctx.cwd`).
- **D2 — title suppression is a template fact, threaded once.** `LoadedTemplate.titleSuppressed: boolean`
  is set inside `loadTemplate` from `chromeSpec` (`false` or `{title:false}`). `LayoutRegistry`
  gains `titleSuppressedLayouts(): string[]` (the code layout `statement` always, plus every template
  with `titleSuppressed`). `lintDeck(deck, { suppressedTitle })` unions `suppressedTitle` with
  `statement` when deciding to skip the overflow check; `LintableDeck.suppressedTitle` is optional so
  all existing `lintDeck({ slides })` callers and tests keep working unchanged.
- **D3 — the lint stays pure.** `lintDeck` never opens a registry; every caller that has one passes
  the set. E.g. `buildDeck` already builds `registry` (`deck-build.ts:404`) and `archifyDeckLint`
  already builds `reg`.
- **D4 — additive, no behavior change to shipped templates or deck shape.** No `.layout.json`,
  no manifest schema, no emitter change. The only observable deltas are (a) the skeleton catalog can
  now find user-tier decks and accepts a different-root shipped tree, and (b) the overflow note stops
  firing on suppressed-chrome layouts.
- **D5 — no new CLI/tool surface.** This is internal parity + a lint-correctness fix; the `deck-lint`
  tool description and parameters are unchanged.

## 3. Acceptance

- `discoverDeckSkeletons({ root, shippedDir })` finds a skeleton tree rooted at a *different* dir than
  `pkgRoot()`, and its silhouette (`name`, `description` from the first H1 after frontmatter, `source`)
  is identical to the shipped-tree shape.
- `discoverDeckSkeletons({ root, env: { ARCHIFY_TEMPLATES: dir } })` finds `<dir>/decks/*.outline.md`
  and the user tier shadows the shipped tier by name.
- `archifyDeckLint({}, { cwd, env: { ARCHIFY_TEMPLATES: dir } })` lists a user-tier deck skeleton in
  the catalog text/details.
- A `quote` or `end` slide whose `title` would overflow produces **no** `title-overflows` note; the
  same `title` on a `bullets` slide still does (`error`/`warn` by severity).
- `bun run typecheck` clean and `bun test` green (no regression; the suite stays at or above the
  recorded baseline).

## 4. Gates

- Package canonical gates: `bun run typecheck` and `bun test` from `bun-apps/s2-agent-ext-archify`.
- Change-scoped local CI via `devops local-ci-cli.ts` before the PR; `bun test:adr` from `bun-apps/`
  (an ADR is not added by this effort, but the monorepo gate must stay green).
