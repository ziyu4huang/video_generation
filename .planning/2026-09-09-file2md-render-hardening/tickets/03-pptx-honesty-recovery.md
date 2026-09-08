# Ticket 03 — runPptx mid-run honesty + recovery (BOTH trap gates)

Status: done

## Goal

A renderer failure mid-run stops being a silent, permanent degrade: png-less
pages carry an in-note trace, and a later re-run with a healthy renderer
recovers the embeds. The permanent-degrade trap is plugged at BOTH gates —
`needRender` (md-only check) AND `processSlide`'s done-skip (also md-only).
Fixing only needRender, as the next-goal's step 3 literally specifies, is
INSUFFICIENT: the recovered png would land on disk but the note would never
be regenerated (map Context, pipeline.ts:1071-1073 vs :1098; map D4-D6).

## Files

- `bun-apps/s2-agent-ext-file2md/src/pipeline.ts` — runPptx :998-1221:
  - renderSlides try/catch :1077-1089 (capture `renderError: string | null`
    in a closure variable, keep the console.error)
  - needRender :1071-1073 (add the png term)
  - processSlide skip :1097-1098 (add the png term; `only` guard stays first)
  - png-less record path :1100-1110 region (append the notice per map D4)
- `bun-apps/s2-agent-ext-file2md/__tests__/pptx-lane.test.ts` (fake renderer
  already counts calls; extend its `renderSlides` with a failure mode)

## Scope

1. `needRender` also true when a SELECTED page is `done` + md exists + png
   missing on disk (`!existsSync(realLayout.pngAbs(i + 1))`) — resumability
   becomes: skip a page only when done AND md AND png all present.
2. `processSlide` skip gains the same png term, so recovered pages rebuild
   their note (embed `![[page-NNN.png]]` when the png now exists, notice when
   it still does not). `--pages`-excluded pages stay excluded.
3. Capture the renderSlides error; when a page ends png-less, append:
   - `> Slide renders incomplete (renderer failed: <msg>)` if renderError,
   - `> Slide renders incomplete (renderer <id> produced no image for this
     slide)` when the renderer returned nothing for that page (no throw).
   Status stays `done`, manifest png stays null (map D4 — the text note IS
   valid; a fake error status would render ❌ in the index note).
4. No loop risk by construction (map D5): needRender evaluates once per run;
  the renderer-null path early-returns at :1003 before it.

## Done when

- [ ] Test (midway throw): fake `renderSlides` writes slide-1.png then throws
      → pipeline COMPLETES (no throw out of runFile2mdPipeline), page-1 note
      has `![[page-001.png]]`, page-2 note contains
      `Slide renders incomplete (renderer failed:`, manifest page-2
      png=null + status=done.
- [ ] Test (recovery): re-run the same outRoot with the renderer now healthy
      → `renderCalls` increments again, page-2 note REGENERATED with
      `![[page-002.png]]` and WITHOUT the incomplete notice — proves BOTH
      gates (needRender re-attempt + processSlide skip fix).
- [ ] Test (silent-shortfall): renderer returns `[]` without throwing →
      pages carry the "produced no image" variant notice (no renderError
      wording), still no throw.
- [ ] Test (no regression): all existing pptx-lane mode-matrix tests green —
      healthy runs identical (renderCalls 1, notices absent, `--pages`
      semantics unchanged).
- [ ] `bun run test` + `typecheck` green for the package.

## Risks

- Recovery reprocess runs vision again on smart/vlm degraded pages (map D6,
  accepted — correctness beats a surgical embed patch).
- The png term must respect `only` exactly like the md term, or `--pages`
  runs would re-render unselected pages.
- Keep the notice wording STABLE — ticket 04's pipeline-level pin asserts it.

## Resolution

closed: 2026-09-09 — renderError captured; BOTH gates png-gated (needRender + processSlide with the D11 noteMatchesDisk form); two in-note wordings (throw vs silent shortfall); tests: midway-throw (D12-corrected expectations), recovery re-run (renderCalls 2, embeds restored, notice gone), non-contiguous parts, silent shortfall; existing matrix green.
