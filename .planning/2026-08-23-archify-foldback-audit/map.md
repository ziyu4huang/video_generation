---
effort: 2026-08-23-archify-foldback-audit
created: 2026-08-23
last: 2026-08-23
status: in-progress
---
# archify-foldback-audit — close the t09-review fold-back gaps in `s2-agent-ext-archify`

## Destination

The three fold-back items the `archify-general-deck` effort carried forward as **documented
behavior, not code-fixed** become real code with tests: (a) `discoverDeckSkeletons` gets an
injectable `shippedDir` seam (parity with `loadRegistry`), (b) `$ARCHIFY_TEMPLATES` is honored
when discovering deck skeletons, and (c) `deck-lint`'s `title-overflows` stops firing on layouts
whose chrome suppresses the title band. Each change is a small, contained, test-backed fix in
`bun-apps/s2-agent-ext-archify/src/`; nothing about the deck shape or the shipped templates
changes.

## Context (measured 2026-08-23 on this machine, bun 1.4.0)

- **The three gaps are real and located.** They are recorded verbatim in the `archify-general-deck`
  close-out as "carried in t10's docs as documented behavior" — the fold-back list the close-out's
  `Ranked next goals` ranks #1. This effort exists to fix them, not to re-litigate them.
- **Skeletons lag templates.** `loadRegistry` (`src/layout-registry.ts:96-194`) already takes an
  injectable `shippedDir` (`LoadRegistryOpts.shippedDir`, :86-94) and builds its user tier from
  `$ARCHIFY_TEMPLATES` (`env.ARCHIFY_TEMPLATES`, :101-107). `discoverDeckSkeletons`
  (`src/deck-lint-tool.ts:119-140`) hardcodes `dirs = [<root>/templates/decks, <pkg>/templates/decks]`
  via `pkgRoot()` — no shipped seam, no `$ARCHIFY_TEMPLATES`, no env path. The same tier discipline
  that the layout catalog has is simply missing for the skeleton catalog.
- **`$ARCHIFY_TEMPLATES` for skeletons is unexercised.** The catalog test
  (`tests/deck-lint-tool.test.ts:90-133`) asserts the four shipped skeletons and a `$ARCHIFY_TEMPLATES`
  **layout** probe, but never a `$ARCHIFY_TEMPLATES` **deck** skeleton. There is no different-root
  skeleton test (the "different-root tests absent" note).
- **`title-overflows` false positive is latent and real.** `lintDeck`
  (`src/deck-lint.ts:156-179`) skips the overflow check only for `layout === "statement"`
  (:176). The shipped templates `quote` (`chrome: { "title": false }`) and `end`
  (`chrome: false`) also suppress the title band — `loadTemplate` (`src/layout-template.ts:600-631`)
  draws chrome only when `chromeSpec === true`, and passes `{ title: false }` to `chrome()` when the
  spec is `{ "title": false }`. So an authored `quote`/`end` slide with a long `title` is flagged
  `title-overflows` even though the emitter never draws the band.
- **`lintDeck` has no template metadata.** It takes `LintableDeck { slides }`
  (`src/deck-lint.ts:47-49`) and resolves each layout via `resolveLayout` (`src/slide-model.ts:166`),
  which returns the template name for a template slide. To know which layouts suppress the title it
  needs the template `chrome` info, which today lives only inside `loadTemplate`/`loadRegistry` and is
  not exposed. The thread runs through three callers that already hold a registry:
  `buildDeck` (`src/deck-build.ts:404`), `archifyDeckLint` (`src/deck-lint-tool.ts:180-201`), and
  `archifyExportPptx` (`src/export-pptx.ts:142,166`).
- **Baseline is green.** `bun run typecheck` clean and `bun test` **619 pass / 21 skip / 0 fail**
  (measured in the `archify-general-deck` close-out; re-confirmed this session before editing).

## Tickets

- `tickets/01-skeleton-discovery-tiers.md` — task, **to-do** — injectable `shippedDir` seam +
  `$ARCHIFY_TEMPLATES` for `discoverDeckSkeletons`, with different-root + env-dir tests.
- `tickets/02-title-overflow-exemption.md` — task, **to-do** — chrome-suppressed
  `title-overflows` exemption, exposing template `titleSuppressed` + a registry set and threading a
  `suppressedTitle` set into `lintDeck`, with a test.

**Execution order:** 01 → 02 (2026-08-23, confirm-gate fast path — fully determined:
01 and 02 touch independent files/functions; 01 has no dependency on 02 and 02 has none on 01,
so the order is arbitrary and no choice exists).

## Decisions

Recorded in `spec.md` §2 (D1–D5). The two that shape the shape:

- **D1 — mirror `loadRegistry`'s tier, don't invent a parallel one.** Skeleton discovery becomes
  `discoverDeckSkeletons(opts)` with `{ root?, env?, shippedDir? }`, and the search order is the
  same precedence the layout registry uses: user tier (`$ARCHIFY_TEMPLATES` dirs, each `<dir>/decks`,
  then `<root>/templates/decks`), then the shipped tier; first hit wins and shadowed names are dropped.
- **D2 — title suppression is a template fact, threaded once.** `loadTemplate` exposes
  `titleSuppressed`; `LayoutRegistry` adds `titleSuppressedLayouts()`; `lintDeck` accepts an optional
  `suppressedTitle: ReadonlySet<string>` and always unions `statement`. The lint stays pure — it
  never opens a registry, it just receives the set.

## Frontier

Ticket 01 (the skeleton-discovery seams). It is first because the two skeleton items are the
largest gap from the layout catalogue's parity and are self-contained in one function; ticket 02's
plumbing is independent and follows cleanly.

## Fog of war

- **`discoverDeckSkeletons` is called from exactly one place** (`archifyDeckLint`, the catalog
  surface, `src/deck-lint-tool.ts:154`); no test or other module imports it today, so the opts-object
  signature change is safe at one call site. Verified by grepping the package.
- **`LoadedTemplate` has no `chrome` field today** (`src/layout-template.ts:60-63`); exposing
  `titleSuppressed` is additive and backward-compatible.
- The `$ARCHIFY_TEMPLATES` skeleton path uses `<dir>/decks` (a templates dir contributes `<dir>/decks`),
  matching how the shipped/manifest tiers stack `<templates>/decks`. This is the natural mapping but is
  only grounded by analogy — a real `$ARCHIFY_TEMPLATES` deck skeleton test pins it.

## Cross-effort links

- **Builds-on**: `.planning/2026-08-22-archify-general-deck` — this effort's charter is that effort's
  fold-back list (its close-out `Ranked next goals` #1). Its t10 docs deliberately documented these
  three behaviors in prose instead of fixing them; this effort makes them code.
- **Absorbed-by**: nothing — this is a containment cleanup, and the fold-back list has no other owner.
