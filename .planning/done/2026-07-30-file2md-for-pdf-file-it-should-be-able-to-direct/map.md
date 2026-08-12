---
status: complete
---

# Wayfinder map: file2md — direct PDF text read vs rasterize→VLM

## Destination

A **decision backed by AB-test evidence**: should `file2md` add a direct-text
extraction path for PDFs (instead of always rasterize→PNG→VLM), and if so is
**direct-only** enough or do we need a **hybrid/combine** path for high quality?
The map ends at a written recommendation. **Shipping the chosen path into
file2md is out of scope** — it is a separate follow-on effort once the route is
clear (wayfinder default: plan, don't do).

## Notes

**Domain.** `bun-apps/pi-agent-ext-file2md` — a file→Markdown bridge for
pure-text agents. The consumer is a **text-only agent**, not a human wanting
publishable Markdown.

**Key fact — current pipeline has NO text-layer path.** `runVlmDescribePipeline`
(`src/pipeline.ts`) hard-codes: `classifyKind()` → if PDF **always**
`rasterizePdf()` (pdf2image CLI, fallback PDFKit/Swift) →
`classifyProfileFromPages()` (sampled-page VLM vote) → per-page
`explainPage()` (1 VLM call/page) → stitch to manifest + MOC note. A direct-read
branch would slot in at the `classifyKind`→extract fork, parallel to
`rasterizePdf`.

**Fact freshness.** Charted on a branch 6 commits behind `origin/main`, but
none of those commits touch `bun-apps/pi-agent-ext-file2md/` — file2md facts
are current. No rebase required for charting.

**Local extractor availability (probed at chart time).** Already on PATH:
`pdftotext`, `pdf2image`, `pdfimages`, `gs` (all poppler/ghostscript). Missing:
`marker`, `pandoc`, `mutool`. So the cheap baseline (raw `pdftotext` dump) is
zero-dependency.

**Skills every session should consult:** wayfinder, grilling, domain-modeling.
This is a decision/AB-test effort — produce evidence + recommendation, not code.

**Standing decisions (resolved during charting — constrain every ticket):**

- **D0 (destination):** Decision + AB evidence, **no shipped code**. `→ Out of scope: implement into file2md`
- **D1 (AB arms):** **Adaptive binary first** — run direct-only vs current-VLM-only.
  Only escalate to a hybrid/combine arm if direct **loses** on the quality bar.
  (Matches the user's "combine *if* we want high quality" conditional.)
- **D2 (quality bar):** **Agent-readable + no major body content dropped**
  (functional floor). Equation/table breakage is **recorded but not blocking**.
  This is the bar that decides whether direct is "good enough".
- **D3 (corpus):** **Small spread — 2–3 arxiv papers**: one text-heavy ML paper
  + one equation/table-heavy paper. A single paper can't expose where direct
  extraction breaks.
- **D4 (no Python — ADDED post-charting, supersedes the MinerU recommendation):**
  The follow-on must be **Bun/TS-native — no Python dependency**. This rules out
  MinerU / Marker / Docling (all torch-based) and the `python/venv-abtest` built
  during the first AB test. It forces a JS/WASM extractor, which the Bun probe
  (below) shows is **pdftotext-class** — so the verdict **flips from direct-only
  to hybrid** (Bun text + selective VLM for figures). See REVISION in Decisions.

**Bun-native probe (work-session, empirical — web search was down so tested directly):**

| Lib | Verdict |
|---|---|
| **`mupdf`** (Artifex, npm) ✅ | `Document.openDocument(Buffer)` → `page.toStructuredText().asText()`. **Faithful prose, √ preserved, equations linearized (NOT LaTeX), figures LOST.** StructuredText reports only `text` blocks (no figure-region signal). ~33 ms/page. Strongest Bun option. |
| `pdfjs-dist` legacy (`pdfjs-dist/legacy/build/pdf.mjs`) ⚠️ | Works but **flaky in Bun** (worker-version mismatch); `getTextContent` needs manual spacing reconstruction. |
| `unpdf` | data-format incompatibility in Bun (couldn't get working). |
| `mupdf-js` | **STUB / deprecated** — avoid. |

**Bottom line:** Bun-native extraction ≈ pdftotext-class (good text, readable-but-linearized equations, **figures lost**). It does **NOT** reach MinerU-class (LaTeX equations + figure extraction). So a pure-Bun direct-only path **fails D2 on figure-heavy papers** → forces the hybrid in the revised recommendation. Figures fundamentally need VLM for a *text-only* consumer (an image file isn't readable text), so VLM can't be dropped entirely — only made **selective** (figure-bearing pages only, or on-demand via the existing `vision_ask`).

## Decisions so far

> **⚠️ REVISION (work-session, post-D4 “no Python”):** tickets 03–05 were
> resolved under the MinerU hypothesis. Adding D4 (no Python) **invalidates the
> MinerU path** — the Bun probe proves a JS-only extractor is pdftotext-class,
> which loses figures → fails D2. **The verdict therefore flips to HYBRID**
> (Bun text extraction + selective VLM for figures). 04 is un-skipped; 05 carries
> the revised recommendation. The 03 AB evidence (MinerU beats VLM on faithfulness
> + LaTeX; VLM hallucinates facts) **still stands** as the reason the hybrid
> should keep Bun text as the faithful base and use VLM only for figures.

- [Extractor landscape surveyed](tickets/01-research-extractor-landscape.md) — shortlist: **pdftotext** (zero-dep cheap baseline, on PATH) **+ MinerU** (academic-quality leader, native MLX/Apple-Silicon); Marker v2 weaker here (Surya crashes on MPS→CPU), Docling skipped. Expected: direct wins on prose, loses on equations unless MinerU recovers.
- [Direct-read contender picked](tickets/02-grill-pick-direct-contender.md) — **two arms**: `pdftotext` (cheap floor) + `MinerU` (strong); MinerU is the decisive test of whether direct-only can avoid a hybrid recommendation.
- [Binary AB test run](tickets/03-prototype-binary-ab-test.md) — **direct (MinerU) WON** both regimes (equation/table/figure *and* prose): faithful text, correct LaTeX, structured tables, figures extracted, zero hallucination, faster than VLM. pdftotext alone FAILS (loses figures, mangles eq). Signal → 04 not triggered.
- ~~[Hybrid arm — SKIPPED](tickets/04-prototype-hybrid-ab-arm.md)~~ — **UN-SKIPPED under D4.** No-Python removes MinerU → Bun-native is pdftotext-class → figure-loss fails D2 → **the combine (Bun-text + selective VLM) is now REQUIRED**, not falsified.
- ~~[Recommendation = direct-only via MinerU](tickets/05-grill-verdict-recommendation.md)~~ — **SUPERSEDED.** Revised recommendation (D4): **add a hybrid path — Bun-native text extraction (mupdf) for the body + selective VLM for figure-bearing pages / on-demand `vision_ask`.** No Python; fits the current TS+LM-Studio stack. See ticket 05 REVISION.
- [Hybrid AB-validated (no Python)](tickets/06-prototype-hybrid-bun-vlm.md) — **text-as-prior hybrid WINS, end-to-end**: mupdf faithful body + VLM figure descriptions (Figure 1/2 faithful, detailed) + LaTeX equation with the trailing **V intact** (raw VLM had dropped it; the prior suppresses hallucination). Pareto-best under no-Python; VLM cost = figure-pages only. Footgun: `pdfimages -list` is empty (vector figures) → use text-density heuristic for routing.

## Not yet specified

<!-- cleared — routing + combine-design both resolved in ticket 05's recommendation -->

_(none — the remaining questions are implementation details for the follow-on
effort, captured as deferred prizes in ticket 05: text-layer detection heuristic,
MinerU `hybrid-engine` vs `pipeline` on hardest cases, VLM-as-figure-describer.)_

## Out of scope

- **Implementing the chosen path into file2md** — destination is decision-only;
  the implementation is a fresh follow-on effort after this map closes.
- **Non-PDF inputs** — images stay VLM-only; this effort is PDF text-layer only.
- **Replacing LM Studio / changing the VLM stack** — already a PRD non-goal.
- **Real-time / streaming UI** — already a PRD non-goal; progress via `console.error`/`emit`.
- **Python / torch extractors (MinerU, Marker, Docling) — ruled OUT by D4**
  (no-Python constraint). The `python/venv-abtest` built during the first AB test
  is now dead weight and can be deleted. JS/WASM only from here.

---

> **ABSORBED-BY `2026-08-08-knowledge-pipeline`** (2026-08-08 unification). PDF extractor verdict (mupdf body + VLM figures hybrid) feeds canonical ticket 02. This effort's live prototype ticket 04 (hybrid A/B arm) remains HERE. See `.planning/2026-08-08-knowledge-pipeline/map.md`.
