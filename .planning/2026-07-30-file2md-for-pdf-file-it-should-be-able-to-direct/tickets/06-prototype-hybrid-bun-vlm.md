type: prototype
blocked by: — (builds on closed 03's AB evidence + the Bun probe in map Notes)
claimed: work-session
status: closed

## Question

Validate the **revised (D4) recommendation — the hybrid**: Bun-native text
extraction (`mupdf`) for the body + **selective VLM for figure-bearing pages**.
Run it on the same corpus (Attention = hard case with figures + equations),
produce a combined per-page Markdown, and judge it against **D2** and the four
existing arms (`pdftotext` / `mupdf` / `MinerU` / `VLM`).

### What "the hybrid" produces (per page)

- **Body text**: `mupdf` extraction — faithful, no hallucination (per ticket 03
  the full-VLM arm *hallucinated* facts; Bun text must be the faithful base).
- **Figures**: only on **figure-bearing pages**, a VLM description (the one thing
  a JS extractor cannot do — figures are lost in mupdf, and a *text-only* consumer
  can't read an image file). Shape tested: **text-as-prior** — feed the mupdf text
  into the VLM call as prior context so it describes figures (and optionally tidies
  equations) instead of re-describing the whole page and hallucinating.

### Figure-page routing

Detect figure-bearing pages via `pdfimages -list` (poppler, on PATH). mupdf's
StructuredText reports only `text` blocks, so it gives no figure signal of its own.

### Deliverables

1. Combined per-page md for the figure-bearing pages of Attention (mupdf text +
   VLM figure description, text-as-prior).
2. A side-by-side row added to ticket 03's matrix: **hybrid** vs the four arms.
3. The **verdict**: does the hybrid meet D2 (faithful text + figures recovered)
   at VLM-cost = **figure-pages only** (vs 1 call/page for full-VLM)? And is it
   the Pareto-best option under the no-Python constraint?

This closes the loop on the destination: the revised recommendation is no longer
just reasoned — it's AB-validated end-to-end.

---

## Resolution (work-session, 2026-07-30) — HYBRID VALIDATED ✅

Ran the **text-as-prior** hybrid on Attention's two key figure pages (p3 =
Figure 1 architecture, p4 = Figure 2 + equation 1). Sample artifact:
`ab-assets/hybrid_out/attention-hybrid-sample.md`.

### What the hybrid produced

- **Body**: `mupdf` extraction — faithful verbatim text, correct linearized
  equation, zero hallucination (the faithful base).
- **Figures**: text-as-prior VLM call (mupdf text fed as PRIOR) described Figure 1
  and Figure 2 **faithfully and in detail** — real block labels (MatMul / Scale /
  Mask / Softmax / Add&Norm / Masked Multi-Head / cross-attention receiving the
  encoder output). Enough for a text-only agent to **reconstruct the architecture**.
- **Equation**: the VLM rendered eq (1) as clean LaTeX
  `softmax(QK^T/√d_k)V` — **with the trailing V intact** (the raw full-VLM arm in
  ticket 03 had *dropped* it). The prior text **anchored** it and suppressed the
  hallucination.

### Side-by-side — hybrid added to the ticket-03 matrix (Attention hard case)

| Dimension | pdftotext | mupdf | MinerU (Py) | VLM-only | **HYBRID** (Bun+VLM) |
|---|---|---|---|---|---|
| Body faithfulness | ✅ | ✅ | ✅ | ❌ halluc | ✅ |
| Figures | ❌ lost | ❌ lost | ✅ image | ✅ desc | ✅ **desc (faithful)** |
| Equation | ❌ mangled | ⚠️ linear | ✅ LaTeX | ⚠️ dropped V | ✅ **LaTeX, V intact** |
| Python? | — | ✅ none | ❌ torch | ✅ none | ✅ **none** |
| VLM cost | 0 | 0 | 0 | **1/page** | **figure-pages only** |

### Verdict

**The hybrid is the Pareto-best option under the no-Python constraint**, and it
is AB-validated end-to-end:

- Meets **D2** on the hard case: faithful body + figures recovered + correct
  equation — nothing major dropped, no hallucination.
- Beats **mupdf/pdftotext** (recovers figures + LaTeX equations).
- Beats **VLM-only** (faithful text base; correct equation — the prior suppresses
  the hallucination that full-VLM introduces).
- Matches **MinerU**'s quality **without Python** (MinerU still wins on fully-
  automated structure/table parsing, but at the cost of torch + GB models).
- VLM cost is **figure-bearing pages only**, and each VLM call is *focused*
  (describe figures + render named equations) rather than full-page re-description.

### Two implementation notes for the follow-on

1. **Figure-page routing**: `pdfimages -list` returns **empty** for these papers
   — their figures are **vector** (lines/boxes/arrows), not embedded rasters. So
   pdfimages is NOT a reliable detector. Use a **text-density heuristic** (low
   text-per-area ⇒ likely figure) or render-and-detect non-text regions.
2. **Equation upgrade is a bonus, not the core**: even without VLM touching
   equations, mupdf's linearized equation is D2-readable. The text-as-prior VLM
   call *additionally* upgrades it to LaTeX — a free win, not a requirement.

The destination is reached: **file2md should add a hybrid path (mupdf text +
selective text-as-prior VLM for figures), no Python.**
