type: grilling
blocked by: 01 (research-extractor-landscape)
claimed: work-session
status: closed

## Question

Which extractor(s) represent **"direct read"** in the AB test? Pick from the
research shortlist (ticket 01), with a recommended answer:

- **Cheap baseline arm:** `pdftotext` (poppler, already on PATH) — almost
  certainly the floor: fast, exact prose, broken equations/tables. Establishes
  the "free speed, low quality" pole.
- **Strong contender arm (optional):** the best local-feasible layout+equation
  parser from 01 (e.g. Marker / MinerU / Docling) — establishes the "best
  direct-read quality" pole. Include only if 01 found one that runs on
  Apple Silicon without unacceptable dep weight.

Decide: **one arm (cheap only)** or **two arms (cheap + strong)**. Trade-off —
two arms gives a fairer test of "can direct read ever match VLM quality", but
adds the install/setup cost of the strong contender. The recommendation depends
on what 01 surfaced about local feasibility.

This is a HITL grilling decision (the call is the user's); settle it one
question at a time with a recommended answer.

---

## Resolution (work-session, 2026-07-30)

**Contender = TWO arms: `pdftotext` (cheap floor) + `MinerU` (strong).**

- `pdftotext` gives the free-speed / prose-intact pole (zero-dep, on PATH).
- `MinerU` is the **decisive** test: it is the only thing that could make
  **direct-only** viable on equations — i.e. the only result that lets the
  verdict avoid recommending a hybrid. Skipping it would leave the destination's
  core question (“direct-only vs hybrid”) unanswered.
- Marker v2 **ruled out as contender** (Surya layout crashes on MPS → CPU
  fallback; weaker fit than MinerU's native MLX). Docling skipped (strictly
  weaker on OmniDocBench).

Env confirmed at resolve: LM Studio up with `google/gemma-4-12b-qat` (file2md
VLM default) → VLM arm ready; `pdftotext` on PATH → cheap arm ready; MinerU
needs a one-time venv + `pip install mineru[all]` + model download (disk free,
arxiv reachable). Unblocks 03.
