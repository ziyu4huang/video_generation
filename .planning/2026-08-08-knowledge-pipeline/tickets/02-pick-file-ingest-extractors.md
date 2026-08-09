type: research
claimed: claude (inline, 2026-08-08)
blocked by:

## Question

The new core capability is turning arbitrary text-extractable files into knowledge-cards. Evaluate (offline, no network) and recommend an extractor stack for the MVP input set: md, txt, pdf (text layer), docx, pptx (OCR/photos explicitly out of scope).

For each format, recommend a library (Bun/JS-native preferred; check what is already installed in bun-apps/ first), report: text-quality, structure preservation (headings/sections/pages), license/offline-friendliness, and a 1-line integration sketch into zk's zk_ingest.

Also recommend:
- **Chunking strategy**: how to split an extracted doc into card-sized units (by heading? fixed token window? one card per section/page?).
- **Provenance metadata schema**: what each card records about its source (file path, format, page/section, extractor, ingest timestamp, content hash for re-ingest dedup).

Return a concise recommendation table + the top pick per format + the chunking/metadata spec. This is AFK research (parallel-eligible); its output feeds the ingest implementation in the post-map writing-plans effort.

## Resolution (closed 2026-08-08)

AFK research complete (236k tokens, 149s). Conclusions:

**Extractor stack (MVP: md/txt/pdf/docx/pptx):**
- md, txt -> native (zero dep; reuse obsidian's `parseFrontmatter` + `adaptGenericMarkdown`).
- pdf -> **`mupdf`** via `pi-agent-ext-file2md`'s proven `extractPdfText()` (per-page StructuredText, best quality). WARNING **AGPL-3.0** — acceptable for this internal repo; **`unpdf` (MIT)** is the documented license-clean swap (same call shape, slightly lower structure fidelity).
- docx -> **`mammoth`** (MIT, new dep) — `convertToHtml`->`turndown` or `extractRawText`.
- pptx -> **`pptxtojson`** (MIT, new dep) — per-slide; fallback `jszip` manual `<a:t>` strip (zero dep, loses notes/tables).

**Reuse finding (significant):** `pi-agent-ext-file2md` already ships a tested `extractPdfText()` (mupdf). It is the natural extractor front-end — the ingest pipeline should CONSUME file2md's output rather than re-implement extraction inside kcard. Architecture refines to: file2md = extractor layer, zk_ingest = card-formation.

**Caveat (must honor at impl time):** isolated-linker + globalStore (`bun-apps/bunfig.toml`) — `jszip`/`pdfjs-dist` are global-store-transitive only; kcard CANNOT phantom-resolve them. Every lib used must be declared in `pi-agent-ext-knowledge-card/package.json` directly. New deps: `mammoth`, `pptxtojson` (+ `turndown` if docx HTML->md); mupdf/unpdf come via the file2md workspace peer.

**Chunking rule:** one card per structural unit — md/docx = heading section (split `^#{1,3}` / `<h1-3>`), pdf = page, pptx = slide, txt = paragraph cluster. Target ~512 tokens/card; split oversized (>~800) on paragraph boundaries with ~64-token overlap; never merge (corrupts provenance). Zero-heading file = one card.

**Provenance frontmatter** (additive to existing id/created/tags/source...): `source_file`, `source_format` (md|txt|pdf|docx|pptx), `extractor` (`<lib>@<ver>`), `ingested_at` (ISO), `content_hash` (sha256 of chunk -> re-ingest dedup key), `source_hash` (sha256 of source file -> change detection), `locator` {page|slide|heading|char_span} (tagged union per format), `chunk_index`, `chunk_count`. Re-ingest: same content_hash = no-op; source_hash changed = drop+re-chunk.

**Feeds:** the writing-plans implementation (ingest pipeline wiring file2md -> zk_ingest -> unified store). No further decision needed here.

closed: 2026-08-08 (extractor stack + chunking + provenance schema pinned; file2md reuse flagged; AGPL + isolated-linker caveats noted)
