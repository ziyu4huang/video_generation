type: prototype
blocked by: 03 (prototype-binary-ab-test)
claimed: work-session
status: closed

## ⚠️ REVISION (D4 — no Python): UN-SKIPPED. Hybrid is now REQUIRED.

The original gate ("only if 03's direct arm lost D2") is **overridden by D4**.
03's direct arm *won* — but only via **MinerU (Python)**. With Python ruled out,
the Bun probe (map Notes) proves a JS-only extractor is **pdftotext-class**:
faithful text but **figures lost** → fails D2 on figure-heavy papers. So the
combine is no longer avoidable — **Bun text + selective VLM for figures** is the
path. The SKIP resolution below is retained only as the historical record under
the old (MinerU) hypothesis; it no longer holds.

**Chosen combine (for the follow-on):** Bun-native text extraction (mupdf) as
the faithful base on **every** page, + VLM **only for figure-bearing content**
(two shapes to pick in implementation — see ticket 05 REVISION).

## Resolution (work-session, 2026-07-30) — SKIPPED

**Gate did not open.** Ticket 03's verdict: direct (MinerU pipeline) **met and
exceeded** the D2 functional bar on the hard (equation/table/figure) case —
faithful text, correct LaTeX, structured tables, figures extracted, **zero
hallucination**, faster than the VLM arm. Direct **won**, so per the D1 adaptive
rule the hybrid/combine arm is unnecessary.

The motivating question — *"should we combine for high quality?"* — is
**falsified by evidence**: a strong direct parser already beats the current
VLM arm on the academic-PDF regime (the VLM *hallucinated* facts MinerU got
right). Combining adds no quality benefit for text+equation+table content.

Narrow residual value of VLM (NOT a combine, just a fallback/enhancement for
the future implementation): scanned/image-only PDFs (no text layer) and
optional figure-content *description* (MinerU extracts figures as images, not
as text). Captured in ticket 05's recommendation.

- **Text-layer body + VLM figures:** use `pdftotext` for body text, but send
  figure/table page-regions (or whole figure-heavy pages) to the existing VLM
  `explainPage`. Stitch.
- **Per-page decision:** text page → `pdftotext`; figure/equation-heavy page →
  VLM. (Needs a cheap page-classifier: e.g. "page has < N chars of text" → VLM.)
- **Text-as-prior:** feed the extracted text layer into the VLM call as context
  so the VLM corrects rather than re-describes.

Pick **one** combine strategy (the cheapest to prototype for a throwaway test).
Run it on the **same corpus** as 03, measure wall-clock + D2 quality, and
produce the same side-by-side summary, now **three-way** (direct / VLM / hybrid).

### Output that feeds the verdict

Does the hybrid arm recover the quality direct lost, **at acceptable speed**
(faster than pure-VLM, slower than pure-direct)? This is the evidence ticket 05
turns into the final recommendation.

## Related (cross-effort, 2026-08-08 review)

- `2026-08-08-pi-agent-ext-knowledge-card-obsidian-surealdb-or`/02 CLOSED chose **pdf = mupdf via file2md** as the extractor for the knowledge pipeline. If this ticket's "hybrid AB arm" is now subsumed by that decision, close as superseded-by-08-08/02; otherwise note the relationship and proceed.

## Resolution (closed 2026-08-12 — settled)

Hybrid (mupdf text + selective VLM) shipped via file2md (`file2md.ts:204` `extract: vlm|text|hybrid`); ABSORBED-BY `2026-08-08-knowledge-pipeline/02`.
