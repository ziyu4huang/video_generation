# archify deck — IR[] → PPTX slide deck (design)

- **Date:** 2026-08-03
- **Status:** approved + implemented (2026-08-05; see `scripts/deck.ts`)
- **Owner:** `bun-apps/s2-agent-ext-archify`
- **Related:** prototype at `/tmp/archify-pptx/build-deck.ts`; note `study-news/content/sas-mas-itemize-incose-aspice.md`

## Problem

archify renders typed-JSON-IR diagrams to self-contained HTML (inline SVG) but has **no path to a presentation deck (`.pptx`)**. Today this is done with a throwaway Python script (`python-pptx`), which violates the monorepo's Bun-first convention. We want a permanent, **Bun-native, thin-bundle-safe** capability inside the archify extension.

## Goals

- Turn a set of archify IR files into a 16:9 `.pptx` — one diagram per slide, with title / accent / footer chrome.
- **Bun/TypeScript only** (`pptxgenjs` + Playwright). No Python.
- Self-contained: `bun run deck <manifest>` produces the `.pptx`.
- Reuse archify's own render (`lib/run.ts`) so each IR is validated + rendered identically to `archify_render`.
- Keep the registered extension bundle **thin**: the deck script is dev-only, **not** imported by `extensions/archify.ts`.

## Non-goals (YAGNI)

- Custom per-slide layouts / branding beyond light/dark.
- Diagram-type-specific slide styling.
- A pi *tool* surface (`archify_deck`) — deferred until usage warrants.
- Editing existing `.pptx`; streaming very large decks.

## Design

### Placement

- New file: `bun-apps/s2-agent-ext-archify/scripts/deck.ts`.
- `package.json`: add `"deck": "bun scripts/deck.ts"`.
- Not imported by `extensions/archify.ts` → manifest registration untouched, registered bundle unchanged, **schema-cost canary unaffected**.

### Manifest schema (`deck.config.json`)

```json
{
  "output": "out.pptx",
  "theme": "light",
  "defaults": { "font": "PingFang TC" },
  "slides": [
    { "ir": "slide1.json", "title": "...", "subtitle": "..." }
  ]
}
```

- `ir` — path to an archify IR JSON (absolute, or relative to the manifest).
- `title` / `subtitle` — slide chrome text.
- CLI: `bun run deck [manifest]` (default `deck.config.json`); `--theme`, `--output` override.

### Data flow (all Bun)

1. Read + parse manifest; fail fast on missing `slides` / `output`.
2. For each slide:
   1. Load IR, infer `diagram_type` (via `lib/load-ir.ts` `loadIrMeta`).
   2. `runArchify(["deliver", type, irPath, tmpHtml, "--json"], cwd)` → HTML (`deliver` includes per-IR validation + artifact check).
   3. Playwright (chromium) load `tmpHtml`, force `data-theme`, screenshot `<svg>` @ `deviceScaleFactor: 2` → tmpPng.
3. Assemble via `pptxgenjs` (16:9 `WIDE` layout): per slide → roundRect tag (top-right), title, accent rect, `addImage` with `sizing:{type:"contain"}` in the content box, footer subtitle + `n/N`.
4. `pptx.write({ outputType: "nodebuffer" })` → `Bun.write(output)`.
5. Clean temp HTML/PNGs.

### Reuse (no duplication)

- `lib/run.ts`: `runArchify`, `resolveVendoredBin`, `withTempIr`.
- `lib/load-ir.ts`: `loadIrMeta` (type inference + meta).

### Dependencies (devDependencies — runtime deps stay `{}`)

- `pptxgenjs` (^4) — PPTX assembly (pure JS).
- `playwright` — headless raster (reuses cached chromium).

## Testing

`__tests__/deck.test.ts`:

- Fixture manifest with 2 tiny IR slides (reuse `__tests__/fixtures` style).
- Run the builder → temp `.pptx`.
- Assert: file exists; it is a zip; contains `ppt/slides/slide1.xml` + `slide2.xml`; contains ≥2 `ppt/media/*` images.
- Gate the browser behind `ARCHIFY_DECK_TEST_BROWSER=1` so browserless CI can skip; runs locally by default.

## Risks / Trade-offs

- Playwright as a devDep adds install weight — mitigated by reusing cached browsers and dev-only scope.
- Text fidelity depends on the browser raster (matches archify's own HTML display — most faithful; preferred over librsvg/sharp).
- `deliver` per slide ≈ 0.3 s — fine for ≲ 50 slides.

## Decisions locked

- Input: **IR-direct** (full `IR[] → .pptx`). ✅
- Manifest: **deck manifest JSON**. ✅
- Surface: **dev script now** (thin-bundle-safe); pi tool deferred. ✅

## Future (out of scope)

- Promote to `archify_deck` pi tool when usage warrants (would add to `extensions/archify.ts` + schema-cost canary).
- Optional `--html` passthrough input if a pre-rendered workflow is ever needed.

## Implementation (2026-08-05)

Implemented per this spec:
- `scripts/deck.ts` — the builder (`bun run deck`); dev-only, **not** imported by `extensions/archify.ts` (registered bundle + schema-cost canary unaffected).
- devDeps: `pptxgenjs@4.0.1`, `playwright@1.60.0`.
- `__tests__/deck.test.ts` — `parseArgs` unit tests + a browser-gated integration test (valid OOXML zip: 2 slides + >=2 media). Runs locally by default; CI opt-in via `ARCHIFY_DECK_TEST_BROWSER=1`.

Tracked via wayfinder effort `.planning/2026-08-05-archify-deck-builder/`.
