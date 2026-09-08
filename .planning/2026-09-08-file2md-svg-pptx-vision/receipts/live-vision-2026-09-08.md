# Live vision receipts — 2026-09-08 (ticket 06)

Machine: darwin 25.5.0 arm64 · runtime bun 1.4.2 · branch `file2md-svg-pptx-vision`.
Vision lane: `resolveVisionLLM()` → `~/.pi/workflows/model-tiers.json`
`capabilities.vision = zai/glm-5.3-flash` (glm-preset shape), called through
`runVisionInference` → `spawnSubagent` — every vision call IS a subagent call.
Renderer: `pickRenderer()` → **quicklook** (qlmanage promote-repack; soffice
not present on PATH). Scratch outputs live under `output/f2m-receipts/`
(gitignored); the durable evidence is this file + the assertions below.

## Model resolution proof (vlm-mode stderr)

```
$ bun bun-apps/s2-agent/src/cli.ts cli file2md /tmp/file2md-smoke.svg --extract vlm
  mode:  vlm
  model: zai/glm-5.3-flash          ← capabilities.vision tier config
page-001.md → provenance: vision
```

## Receipt A — standalone SVG, smart mode

Input: 3-node pipeline svg (640×480, title/desc, rect+text+line+arrow).
Output `a-svg/file2md-smoke/pages/page-001.md`:
- frontmatter `enhanced: vision`, `width: 640 height: 480`, embed `![[page-001.png]]`
- structural body (labels Ingest/Convert/Emit + census) UNTOUCHED
- `## Figure (vision)`: glm-5.3-flash described node fills, borders, arrow
  directions, no-branch observation — then reconstructed:
  ```mermaid
  flowchart LR
      A["Ingest"] --> B["Convert"]
      B["C Emit"→"Emit"]
  ```
  (verbatim from the run: `A["Ingest"] --> B["Convert"]` / `B --> C["Emit"]`)
- renderer: WebView (Bun.WebView two-pass) · degrade notices: none

## Receipt B — html with two inline svgs, smart mode

Input: `b-fixture.html` (2 inline diagrams, no img refs).
Output `b-html/b-fixture/b-fixture.md`:
- both figures rasterized (2/2), in-place anchors `![[figure-01.png]]` /
  `![[figure-02.png]]`, zero `<text>` label leakage
- two `## Figure (vision) — NN` sections with per-figure mermaid
  (`graph LR A["Build"] --- B["Test"] --- C["Ship"]`; `Core(("Core")) <--> Plugin(("Plugin"))`)
- degrade notices: none
- Found + fixed en route (pre-existing, exposed by this receipt): `htmlToMarkdown`
  matched `<body>` as `<b>` (stray `**`) and closing `</hN>` re-emitted a heading
  marker (stray `#`) — word-boundary + split-open/close fix, suite green.

## Receipt C — real deck, smart mode

Input: `vaults_root/study-news/content/sas-mas-itemize-incose-aspice.pptx` (5 slides).
Renderer: quicklook (5 promote-repack qlmanage runs, one pass).
Manifest: pageCount 5, all pages `done`, all `png` set, all
`figure: {detected: true, enhanced: true}`.
Per-slide notes (chars): 1364 / 2816 / 2416 / 2617 / 2231 — every slide has the
ground-truth text-run body (`- [shapeId] text`) + `## Slide (vision)` + embed.
Slide 1 excerpt: swimlane structure (01 壞散文 → 02 Itemize → 03 原子 Item ×4),
arrow semantics (primary data solid teal), the 4-item legend read AND correctly
noted as mostly-unused on page 1, page footer, and a subgraph-bearing mermaid.
Degrade notices: none.

## Verdict

PASS — all three fixture classes (svg / html+svg / real pptx) convert with
embeds + glm-5.3-flash descriptions + mermaid reconstructions; no degrade path
fired on this machine (paths are pinned by the mocked E2E suites instead).
