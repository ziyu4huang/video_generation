---
type: task
blocked by: []
claimed: pi-agent (impl)
status: closed
resolved: 2026-08-05
---

## Re-plan (2026-08-05)

Dependencies collapsed before work:
- **01 (branch):** writing `scripts/deck.ts` does not require the branch — only the commit/PR does. 01 is pre-merge hygiene, not pre-code. (Worked uncommitted; commit/PR deferred to 01.)
- **03 (manifest schema):** the schema is locked in the approved design spec (`docs/2026-08-03-deck-design.md`); 03's only open work is densifying the example IR *content* — independent data, not a code dependency. 04 implements against the locked schema.

So 04 is unblocked and takeable now. Smoke-tested against in-repo vendored example IRs (not the densified example).

## Question

Implement `bun-apps/pi-agent-ext-archify/scripts/deck.ts` — the core builder (Task: this does the build).

Pipeline (all Bun, reuse the working `/tmp/archify-pptx/build-deck.ts` as the basis):
1. Read + parse the manifest; fail fast on missing `slides` / `output`.
2. For each slide: infer `diagram_type` via `lib/load-ir.ts` (`loadIrMeta`); render with `runArchify(["deliver", type, irPath, tmpHtml, "--json"], cwd)` from `lib/run.ts`; Playwright-raster the `<svg>` @ 2–3× (forced theme) → temp PNG.
3. Assemble via `pptxgenjs` (16:9 `WIDE`): per slide → title, accent, `addImage` with `sizing:{type:"contain"}`, footer subtitle + `n/N`.
4. `pptx.write({ outputType: "nodebuffer" })` → `Bun.write(output)`; clean temp files.

Also: add `pptxgenjs` + `playwright` as **devDependencies**, and the `"deck": "bun scripts/deck.ts"` npm script. Keep the registered bundle thin — the script is **not** imported by `extensions/archify.ts`. Resolved when `bun run deck deck.config.json` produces a valid `.pptx` from the ticket-03 example.

## Resolution (2026-08-05)

Implemented (full pipeline, Bun-native) and verified:

- **`scripts/deck.ts`** — manifest → per-slide `deliver` via `lib/run.ts` (same path as `archify_render`) → Playwright raster of `<svg>` (forced theme, chrome hidden) → `pptxgenjs` 16:9 assemble (tag/title/accent/contain-image/footer/n-N) → `Bun.write`. Light + dark palettes; `--theme` / `--output` overrides; manifest-relative `ir`/`output`.
- **devDeps:** `pptxgenjs@4.0.1` + `playwright@1.60.0` (pinned to the global install → reuses cached chromium-1228, no browser download).
- **`package.json`:** added `"deck": "bun scripts/deck.ts"`. Registration/`extensions/archify.ts` untouched → registered bundle + schema-cost canary unaffected.

Verification:
- Smoke (2-slide manifest: vendored `web-app.architecture` + `incident-response.workflow`) → valid OOXML `.pptx`, 572 KB (light) / 560 KB (dark), with `ppt/slides/slide1.xml` + `slide2.xml` and 2 `ppt/media/*.png`.
- `--theme dark` + `--output` override + dark-palette path exercised.
- `tsc --noEmit` exit 0; `bun test` 49 pass / 0 fail (21 e2e skips) — no regressions.

Notes: blockers collapsed per the re-plan above (01 = pre-merge branch hygiene, not pre-code; 03 schema locked in the spec). Code is **uncommitted** on the current branch — commit/PR deferred to ticket 01. The densified ticket-03 example will be the first real end-to-end exercise (tickets 03/05).
