---
ticket: 12-guard-and-docs
effort: archify-view-pptx-bun
type: task
status: open
created: 2026-08-21
blocks-on: [11]
---
# 12 — both: browser-dep guard + docs + map sync

> Spec §5.2 / §6. A rule with no executable guard is the rule that gets skipped.

## What to build

1. **`__tests__/no-browser-deps.test.ts`** (archify; mirror in webui): assert neither
   package's `package.json` lists `playwright` / `playwright-core` / `puppeteer` in any
   dependency field, and no source file imports them. Explicitly scoped to these two
   packages — `pi-agent-ext-power-tool` and `gui-movie-director` legitimately use Playwright
   and are out of scope (and post-Bun-1.4 are no longer a pure-Bun problem).
2. **archify README**: replace the "Playwright + pptxgenjs, dev-only" deck section with the
   ShapeIR pipeline, the `archify_export_pptx` tool, the `<a:blip> === 0` acceptance
   contract, and the `defaults.scale` accepted-and-ignored note.
3. **webui README**: document `webui:deck`, the `diagram_deck` / `diagram_open` frames, the
   Diagram pane, `#deck` / `#deck-<id>` hashes, and add both frames to the documented frame
   diet list.
4. **`map.md`**: close tickets, move Frontier, record any decision that changed during build.
   Per `.planning/CONVENTIONS.md` this happens in the SAME session as the work.

## Acceptance

- The guard test fails if `playwright` is re-added to either `package.json`.
- READMEs describe what shipped, not what was planned.

## Gate

Both package gates (§6).
