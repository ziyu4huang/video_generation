> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
---
effort: 2026-08-05-archify-deck-builder
created: 2026-08-05
last: 2026-08-05
status: complete
---

# Wayfinder map: 2026-08-05-archify-deck-builder

## Destination

A **dev-only Bun script** in `bun-apps/pi-agent-ext-archify` — `scripts/deck.ts` + a `deck` npm script + `pptxgenjs`/`playwright` devDependencies + a `__tests__/deck.test.ts` — that turns a **deck-manifest JSON** of archify IR files into a 16:9 `.pptx` (one diagram per slide, with title / accent / footer chrome), reusing archify's own `lib/run.ts` to render each IR. The registered extension bundle stays thin (the script is not imported by `extensions/archify.ts`). Canonical example = the 5 SAS/MAS slides. Per the approved design spec at `bun-apps/pi-agent-ext-archify/docs/2026-08-03-deck-design.md`.

## Notes

- **Domain:** the archify Bun/TypeScript extension (`bun-apps/pi-agent-ext-archify`); PPTX assembly via `pptxgenjs`; SVG raster via Playwright. Working prototype already exists at `/tmp/archify-pptx/build-deck.ts` — reuse it as the implementation basis.
- **Skills every session should consult:** writing-plans, test-driven-development, using-git-worktrees, verification-before-completion.
- **Standing preferences:** Bun-first (**no Python** — see user memory); keep the registered extension bundle **thin** (dev-only script + devDeps, never imported by `extensions/archify.ts`); reuse archify's own `lib/run.ts` and `lib/load-ir.ts`.
- **Execution carried into the map:** this effort overrides wayfinder's "plan, don't do" default — Task and Prototype tickets do real build work, not just decide.
- **Fact freshness:** the working branch is 74 commits behind `origin/main`, but archify is untouched there since divergence, so the premise holds. Implementation must still land on its own branch off `origin/main` (ticket 01) — not on the current unrelated feature branch.
- **Pre-map decisions already locked** (in the design spec, not re-ticketed): input = IR-direct; manifest = deck-manifest JSON; surface = dev script now (pi tool deferred).

## Decisions so far

<!-- the index — one line per closed ticket: enough to judge relevance, then open the link for the detail the ticket holds -->

- [Default visual style](tickets/02-default-visual-style.md) — default `signal-flow` + **light** theme; canonical example **densified** (real item IDs, denser cards, sub-paths) with the approved 5-slide structure preserved.
- [Implement deck script](tickets/04-implement-deck-script.md) — `scripts/deck.ts` + `pptxgenjs`/`playwright` devDeps + `deck` npm script; smoke-verified (valid `.pptx`, light+dark), `tsc`/tests green. Code uncommitted → commit/PR deferred to ticket 01.
- [Test + docs](tickets/05-test-and-docs.md) — `__tests__/deck.test.ts` (`parseArgs` unit + browser-gated OOXML integration) + README/spec; `tsc` clean, 55 pass / 0 fail.
- [Branch off origin main](tickets/01-branch-off-origin-main.md) — worktree `video_generation__archify-deck` on `feature/archify-deck-builder` off origin/main; lockfile regenerated; verified in-worktree; **PR #1037**. Also lands the ticket-04/05 code.
- [Deck manifest + example](tickets/03-deck-manifest-and-example.md) — `examples/deck/` (manifest + 5 densified SAS/MAS IRs); `bun run deck` → valid 688 KB / 5-slide `.pptx`; user study deck refreshed.

## Not yet specified

<!-- all resolved: pin versions pinned in ticket 04 (pptxgenjs@4.0.1, playwright@1.60.0); densify decided in ticket 02 -->

## Out of scope

- A `archify_deck` pi tool surface — deferred until the dev script proves useful (would add to `extensions/archify.ts` + the schema-cost canary).
- Editing existing `.pptx`; streaming very large decks; per-diagram-type slide styling; custom slide layouts.
