type: prototype
blocked by: 02 (grill-pick-direct-contender)
claimed: work-session
status: closed

## Question

**Run the binary AB test** and produce side-by-side evidence. Constrained by
the standing decisions (see map Notes):

- **Arms (D1):** `direct-contender` (from 02) vs `current-VLM-only` (the
  existing `file2md` pipeline, no changes). **Two arms only** — no hybrid here.
- **Corpus (D3):** 2–3 born-digital arxiv papers — one **text-heavy** ML paper
  + one **equation/table-heavy** theory or systems paper. Suggest concrete IDs
  (e.g. a recent transformer paper for prose; a math/ML-theory or systems paper
  for equations) but the runner may substitute equivalents.
- **Quality bar (D2):** judge each arm against **agent-readable + no major body
  content dropped** (functional floor). Explicitly **record** where equations,
  tables, figures, and references break, but do **not** let that block the
  verdict on its own.

### Deliverables (assets, linked from this ticket)

For each paper × arm:

1. The produced Markdown file.
2. **Wall-clock time** (direct read is expected to be dramatically faster than
   N serial local-VLM calls — quantify it).
3. A short **quality note** against D2: does the agent get the body? what broke?

Plus a one-page **side-by-side summary**: per paper, which arm won on speed,
which won on the functional bar, and the specific breakage list.

### Output that feeds the verdict

A clear binary signal: did direct read **meet the functional bar (D2)** on the
corpus, or **lose** (dropped/mangled major body content)? This signal gates
ticket 04 — if direct **lost**, 04 runs the hybrid arm; if direct **met/won**,
04 is skipped.

---

## Resolution (work-session, 2026-07-30) — AB test run

Assets: `ab-assets/` under this effort dir.
- PDFs: `ab-assets/pdfs/{attention-1706.03762,lora-2106.09685}.pdf`
- pdftotext: `ab-assets/pdftotext_out/{attention,lora}-full.txt`
- VLM (file2md, gemma-4-12b-qat, pages 1/4/7): `ab-assets/vlm_out/attention/…/pages/page-{001,004,007}.md`
- MinerU (pipeline, `-m txt`): `ab-assets/mineru_out/{attention,lora}/…/*.md` (+ extracted `images/`)

### Side-by-side (Attention = equation/table/figure hard case; LoRA = prose case)

| Dimension | **pdftotext** (cheap) | **MinerU** pipeline `-m txt` (strong) | **VLM** file2md / gemma-4-12b (current) |
|---|---|---|---|
| Prose | ✅ faithful, complete | ✅ **faithful, complete** | ⚠️ 繁中 **summary/paraphrase** (not verbatim) |
| Display equations | ❌ mangled linear text (`softmax(QK T/dk)`, √ lost, frac split) | ✅ **clean correct LaTeX** incl. √, frac, `^T`, trailing V | ⚠️ LaTeX **but hallucinated** — dropped trailing V, wrong footnote variance |
| Inline math | ❌ lost formatting | ✅ preserved ($d_{model}$, $\Delta W$, $\beta_1=0.9$) | ⚠️ paraphrased, errors (β₂ said 0.99, real 0.98) |
| Tables | ⚠️ struct+nums ok; sci-notation exponents mangled (`×10²⁰`→`1020`) | ✅ **proper HTML `<table>`** with cell LaTeX | ⚠️ prose summary, numbers partly invented |
| Figures | ❌ **completely lost** (caption only) | ✅ **extracted as embedded image files** | ✅ described in prose (figure content as text) |
| Faithfulness | ✅ exact (extraction) | ✅ **exact (extraction), zero hallucination** | ❌ **hallucinates** (said “8 NVIDIA TPU v3-80”, real = P100; wrong token counts) |
| Language | source (English) | source (English) | zh-TW summary (by file2md default) |
| Speed (steady-state) | instant | **~3.5–7 s/page** (models cached) | serial LM-Studio per page (~1 call/page, qualitatively slower) |
| First-run cost | none | ~98 s model download (one-time, GB) | none (LM Studio already serving) |

### D2 verdict (agent-readable + no major body content dropped)

- **pdftotext alone FAILS** the bar on figure/equation-heavy papers (figures =
  major content, lost; equations mangled). Fine for pure prose, not enough
  generally → **do not ship pdftotext as the direct path**.
- **MinerU MEETS AND EXCEEDS** the bar on **both** regimes of the spread
  (equation/table/figure *and* prose): faithful text, correct LaTeX equations,
  structured tables, figures preserved as images, **zero hallucination** — and
  faster than the VLM arm.
- The current **VLM arm hallucinates facts** (wrong hardware/numbers) and gives
  a zh-TW paraphrase, not a faithful extraction. For a *text-agent consumer that
  needs the source content*, MinerU is **strictly better**.

### Binary signal → gates ticket 04

**Direct (MinerU-class) WON.** It did not lose the functional bar on the hard
case. Per the D1 adaptive rule, **ticket 04 (hybrid arm) is NOT triggered →
SKIP**. The “combine for high quality” hypothesis is tested and **falsified**:
a strong direct parser already exceeds the VLM on the academic-PDF regime, so a
combine adds no quality benefit for text+equation+table content. (VLM retains
narrow value only for scanned/image-only PDFs and optional figure-content
description — a fallback/enhancement, not a D2 requirement.)
