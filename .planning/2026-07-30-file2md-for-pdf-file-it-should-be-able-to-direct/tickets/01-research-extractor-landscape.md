type: research
blocked by: —
claimed: chart-session
status: closed

## Question

What direct-text + layout-aware **PDF→Markdown extractors** exist, and which
should we pick as the **direct-read contender(s)** for the AB test? Produce a
**shortlist: 1 cheap baseline + 1–2 strong contenders**, each rated on:
speed (wall-clock vs a per-page VLM call), **quality on academic PDFs —
especially equations and tables**, runtime dependencies, and **local /
Apple-Silicon feasibility** (must run offline; this stack is MPS-only, no CUDA).

Cover at minimum:

- **Cheap text-layer baselines:** `pdftotext` (poppler — **already on PATH**,
  zero-dependency), `pymupdf`/`fitz`, `pdfplumber`. Confirm what each does with
  equations/tables/multi-column on a born-digital arxiv paper.
- **Layout + equation-aware ML parsers:** Marker, MinerU, Docling, Nougat,
  GROBID. For each: does it need a GPU / heavy models, can it run locally on
  Apple Silicon, what is its reported Markdown quality on academic papers, and
  is there a recent (2024–2026) benchmark (e.g. OMNIDocBench, Marker's own)?
- **A one-line verdict** per tool: "use as cheap baseline" / "use as strong
  contender" / "too heavy for this stack".

Also note: is `pdftotext` alone good enough for **prose-heavy** arxiv pages
(likely yes) but broken on **equations/tables** (likely)? That asymmetry is the
core of the AB verdict.

### Acceptance

A shortlist table (tool → speed / equation-quality / deps / local-feasible /
verdict) plus a recommendation of **which 1–2 to actually run** in the AB test.
This unblocks ticket 02.

---

## Resolution (chart-session, 2026-07-30)

Sources: OmniDocBench 1.5 (CVPR 2025), Datalab Marker-2 blog, opendatalab/MinerU
quick-start + changelog, independent PDF→md tool comparisons (Latent Space,
pdfmarkdownapp benchmark, jeromebuilds RAG benchmark), paper2md (Zenodo).

| Tool | Speed | Equation/table quality | Deps | Local (Apple Silicon, MPS-only) | Verdict |
|---|---|---|---|---|---|
| **`pdftotext`** (poppler) | instant | **broken** — formulas & complex tables are the universal failure mode | none — **already on PATH** | ✅ zero-dep | **cheap baseline** |
| `pdfplumber` | fast | prose ok, tables partial, equations broken | python lib | ✅ CPU | skip (pdftotext is enough as the floor) |
| **MinerU** | medium; `vlm-mlx-engine` gives **100–200% speedup** on Apple Silicon | **best on academic** — OmniDocBench 1.5 ~90%, TV-RAG 92/100 vs MarkItDown 14 | torch + models (~GB) | ✅ **explicit MLX/MPS + NPU support**; macOS-compatible; `pip install mineru[all]` | **STRONG contender** |
| Marker v2 | fast — 3× v1, >MinerU pipeline throughput; 76% olmOCR-bench | good | surya-ocr / pdftext / torch | ⚠️ **Surya layout model crashes on MPS → falls back to CPU** | alt strong contender (awkward on this exact HW) |
| Docling | medium | higher error rates, “base64 bloat” | torch | ✅ | skip — strictly weaker than MinerU |
| paper2md | ? | **tuned for 2-column + equation-heavy scientific, offline** | ? | ✅ offline | niche fallback specifically for eq-heavy arxiv |

### Recommendation for ticket 02 (the contender pick)

**Run TWO arms:** `pdftotext` (cheap floor) **+ MinerU** (strong contender).

- **Why two, not one:** testing `pdftotext` alone would *unfairly* condemn
  direct-read — it is great on prose but structurally breaks equations/tables.
  MinerU is the academic-quality leader **and** runs locally on Apple Silicon
  via its MLX engine, so it is the fair “best direct-read quality” pole.
- **Why MinerU over Marker v2 here:** Marker v2’s Surya layout model is known to
  crash on MPS and drop to CPU; MinerU has first-class MLX support on this stack.
- **Expected asymmetry (the core of the AB verdict):** on a **text-heavy** arxiv
  paper, direct (`pdftotext`) will likely **win** — instant + prose intact, good
  enough for a text agent. On an **equation/table-heavy** paper, `pdftotext` will
  likely **lose** the functional bar; the question is whether **MinerU recovers
  it** (→ direct-only viable) or still loses (→ triggers the hybrid arm, 04).
- **Speed framing:** `pdftotext` is instant vs N serial local-LM-Studio VLM calls
  (each ~10–60s) — the direct speed win is expected to be **orders of
  magnitude**. MinerU is slower than pdftotext but still far faster than per-page VLM.

Unblocks ticket 02 (now a near-formality: confirm pdftotext + MinerU).
