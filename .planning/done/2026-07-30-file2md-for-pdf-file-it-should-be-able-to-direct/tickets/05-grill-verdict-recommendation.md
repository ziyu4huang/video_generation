type: grilling
blocked by: 04 (prototype-hybrid-ab-arm)  <!-- 04 may resolve as SKIPPED; then this unblocks directly -->
claimed: work-session
status: closed

## Question

**Synthesize the verdict into the recommendation that ENDS this map.** This is
the destination (D0) materializing. From tickets 03 (+ 04 if it ran), decide —
with a recommended answer, one question at a time — and write:

1. **The verdict:** does file2md add a direct-text path for PDFs? Yes / No.
2. **The shape:** if Yes — **direct-only**, or **hybrid/combine**? Justify from
   the AB evidence (speed win quantified; quality against D2; the breakage list).
3. **The routing sketch** (graduates the fog from the map): in broad strokes,
   when would the future implementation trigger direct-read vs VLM? (e.g.
   born-digital text-layer with sufficient coverage → direct; scanned / figure-
   heavy → VLM; equation-heavy → hybrid.) This is a sketch for the follow-on
   implementation effort, not a spec.
4. **What to hand off:** a one-paragraph pointer to the next effort (the actual
   implementation) — what it should build, keyed to the verdict above.

### Acceptance

The recommendation is written into this ticket as the resolution, a one-line
gist is appended to the map's **Decisions so far**, and the map's
**Not yet specified** (routing logic; combine design) is either resolved here or
explicitly deferred to the follow-on effort. At that point the frontier is clear
and the map can close via `/wayfind done`.

---

## ⚠️ REVISION (D4 — no Python): recommendation SUPERSEDED → HYBRID

The original resolution below (direct-only via MinerU) is **superseded** by the
D4 no-Python constraint. MinerU/Marker/Docling are all torch-based → out. The Bun
probe (map Notes) shows the strongest JS/WASM option (`mupdf`) is
**pdftotext-class**: faithful prose + readable-but-linearized equations, but
**figures lost** and **no LaTeX** — so a pure-Bun direct-only path **fails D2**
on figure-heavy papers.

**Revised recommendation:** add a **hybrid** path —

- **Bun-native text extraction (`mupdf`) for the body on every page** — faithful,
  fast (~33 ms/page), zero-Python, and (per ticket 03) **does not hallucinate**
  the way the current full-VLM arm does.
- **VLM only for figure-bearing content** — because a *text-only* consumer can't
  read an image file, figures fundamentally need VLM description. Two shapes for
  the follow-on to pick:
  - **(a) Lazy / on-demand:** Bun extracts all text; the agent calls the existing
    `vision_ask` on a page only when it actually needs a figure. **Fewest VLM
    calls; fits file2md's existing two-tool design (file2md + vision_ask).**
  - **(b) Eager / text-as-prior:** feed the Bun-extracted page text into the VLM
    call as prior context, asking it to describe only figures (+ optionally tidy
    equations). Fuller per-page md, more VLM calls.
- **Figure-bearing detection:** `pdfimages -list` (poppler, already on PATH) per
  page, or a text-density heuristic — mupdf's `StructuredText` reports only
  `text` blocks, so it gives no figure-region signal of its own.

**Net:** the no-Python constraint makes the answer **hybrid (Bun-text + selective
VLM)**, not direct-only. The `python/venv-abtest` from the first AB test can be
deleted. The original MinerU resolution is retained below as the historical
record.

---

## Resolution (work-session, 2026-07-30) — THE RECOMMENDATION (ORIGINAL, under MinerU hypothesis — superseded above)

Backed by the AB test (ticket 03) on the small spread (Attention = hard
equation/table/figure; LoRA = prose).

### 1. The verdict

**YES — `file2md` should add a direct-text extraction path for PDFs.**

### 2. The shape — **direct-only via a MinerU-class parser; NO hybrid needed.**

- "Direct-read" must mean a **layout + formula-aware ML parser** (MinerU
  `pipeline` backend), **not naive `pdftotext`** — pdftotext loses figures and
  mangles equations, failing D2 on the hard case. MinerU aces both regimes.
- The "combine for high quality" hypothesis is **falsified**: MinerU already
  *exceeds* the current VLM arm — faithful verbatim text, correct LaTeX
  equations, structured tables, figures preserved, **zero hallucination**, and
  faster (~3.5–7 s/page steady-state vs serial per-page VLM). The VLM arm
  *hallucinated* facts (wrong GPU/token-counts) MinerU got right.
- So a combine buys **no** quality on born-digital academic PDFs.

### 3. Routing sketch (graduates the map's fog — for the follow-on effort)

```
classifyKind(pdf)
  ├─ has extractable text layer?  →  MinerU pipeline  (-m auto: txt path)
  ├─ scanned / image-only PDF     →  MinerU pipeline  (-m ocr)  OR  VLM fallback
  └─ [optional] figure regions    →  pass extracted images to VLM for content-
                                      description if the consumer needs figure
                                      CONTENT as text (enhancement, not D2)
```
The default happy path for born-digital PDFs (the arxiv case) is **MinerU
`-m auto`**, no VLM. VLM is retained only as a **fallback** (scanned/no text
layer) and an **optional** figure-describer.

### 4. Costs to weigh in the follow-on implementation (the real trade-off)

- **Dependency weight.** file2md is pure-TS + LM Studio today; MinerU pulls a
  Python venv + torch + ~GB of layout/formula/table/OCR models. Integration is
  almost certainly **shell-out to the `mineru` CLI** in a dedicated venv (the
  proven path this AB test used: `python/venv-abtest`), NOT a TS port.
- **First-run model download** (~2 min + GB) is one-time; models then cache.
- **Output normalization.** MinerU emits md + extracted images + a content-list
  JSON; the impl should normalize to file2md's existing **manifest + per-page-md
  + `![[png]]`** shape so downstream (MOC index, vault) is unchanged.
- **Untested edges** (flag, don't block): MinerU `hybrid-engine` (VLM backend,
  higher accuracy for hardest cases); scanned-PDF `-m ocr` quality; very large
  (100+ page) PDFs.

### 5. Hand-off to the next effort

> Build a `mineru` extraction branch in `runVlmDescribePipeline` (`src/pipeline.ts`),
> parallel to `rasterizePdf`, selected when the PDF has a text layer. Shell out to
> the `mineru` CLI in a dedicated venv (`python/venv-abtest`), normalize its md +
> extracted images into the existing manifest/per-page-md/vault shape, and keep
> the current VLM path as the scanned-PDF fallback + optional figure-describer.
> This is a fresh implementation effort — out of scope for *this* map.

### Deferred prizes (for the closing ceremony)

- The VLM-as-figure-describer enhancement (MinerU extracts images; optionally
  describe their content) — a quality *niche*, not a blocker.
- MinerU `hybrid-engine` benchmark vs `pipeline` on the hardest cases.
- A text-layer detection heuristic (cheap: `pdftotext` char-count per page as a
  routing signal) — implementation detail for the follow-on.
