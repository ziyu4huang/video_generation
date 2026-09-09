Reads used: 4 of 6 (`figure.ts`, `adapters.ts`, review receipt, effort `map.md`); greps pinned the rest. **No deploy/TUI learning applied** — no deployed-tree divergence here; the applied method piece is the core discipline: *read the artifact, not the label* (the graph-note frontmatter was read directly, which is exactly why finding W3 below is worse than the task stated).

---

# Ticket plan: `2026-09-10-file2md-kcard-scale` (working name) — broader-corpus experiment + evidence-gated fixes

## 1. Execution order

```
01 corpus+baseline (measure + thin probe, NO mass card writing)
   ├─ gates → 02 figure-caption fix      (needs 01's measured fire-rate)
   ├─ gates → 03 vision ground module    (needs 01's probe bullets; fixture in hand from 2609.09156)
   └─ independent → 04 adapter leak fix  (artifact already on disk; can start immediately, parallel to 01)
02+03+04 landed
   → 05 wave-1 cards (~5 papers incl. the LONG + FIGURE-HEAVY picks) + converge + grounding applied
   → 06 wave-2 cards + wave-1 backfill + full convergence verification
   → 07 glm-5.3 read-the-artifact reviewer audit + in-card fixes
   → 08 merge (vault PR → repo PR → map/next-goal close-out)
```

Experiment-first is real: 02/03 finalize only after 01's receipts exist; 04 is the one fix whose evidence is already committed.

## 2. Tickets

**01-corpus-baseline.md** — select ~10 papers across ≥5 categories (cs.CV multimodal, cs.AI, stat.ML theory, cs.CR, cs.LG scaling/systems; 2 each), constraints: ≥1 paper 20+ pages/survey, ≥1 born-digital figure-heavy (see W2 — must be text-provenance to stress the blind arm), spread of submission dates (not same-day). Download via `bun-apps/s2-agent-ext-research-tool/lib/arxiv.ts`, convert `file2md --extract smart --scale 2`, and run a **thin probe**: 2 papers (the long + figure-heavy) taken end-to-end to DRAFT cards (not converged). Capture per-paper telemetry: pages, text/scan provenance, per-page `figure.detected/enhanced` counts, extraction failures.
*Files:* no source changes; artifacts → `output/kcard-papers2/` + `receipts/corpus-baseline-<ts>.md` + selection manifest (committed).
*Done-when:* manifest lists 10 ids with category/why/constraints met; receipt contains the measured figure-heuristic fire-rate table; an explicit confirmed/denied verdict on the `Figure 1:` blind spot quoting page-md; a failure log (tables, math, 2-column, OCR).
*Risks:* arxiv lib may lack category filter (query strings only — fog); telemetry field names unverified (`src/vlm/manifest.ts`, `src/pipeline.ts` consume `FigureRecord` — check shape first).

**02-figure-caption-fix.md** — widen the caption heuristic, red-test first.
*Files:* `bun-apps/s2-agent-ext-file2md/src/core/figure.ts` (`FIGURE_CAPTION_RE`, line 24), `src/core/figure.test.ts` (exists).
*Done-when:* red test committed showing a caption-only page with `Figure 1:` / `Fig. 3:` body ≤ band → `isTextFigure === false` pre-fix; post-fix regex matches `Figure N:` / `Figure N.` / `Fig. N:` / legacy `Figure N-x.`; corpus re-run telemetry diff shows the expected new fires and **zero** new fires on prose pages (band `FIGURE_MAX_BODY_CHARS` unchanged, line-anchored caption required so inline "as shown in Figure 3" prose can't fire).
*Risks:* prose-drag if caption isn't line-anchored; over-firing on pages that merely cite a figure — the telemetry diff is the guard.

**03-vision-ground-module.md** — deterministic grounding pre-check for vision bullets (review finding 4; feeds bench lane 1b later).
*Files:* new `bun-apps/s2-agent-ext-file2md/src/vlm/ground.ts` + `ground.test.ts` (greenfield — confirmed absent).
*Done-when:* pure IO-free `groundClaims(visionBullets, pageText)` → grounded/ungrounded with missing tokens (numbers + named entities); tests use the verified fixture (92% / `Similarity Score: 92%` from `output/kcard-papers/md/2609.09156/pages/page-001.md`) plus a hallucinated-number fixture that MUST flag; run over this arc's probe vision bullets with a receipt listing per-fig counts; every ungrounded bullet dropped or manually verified with a note.
*Risks:* entity tokenization on CJK/mixed text; must gate admission to 證據, never silently rewrite model output (parent-map vision guarantee).

**04-generic-adapter-leak.md** — stop wiki-link pollution of generic graph notes; worse than tagged (see W3).
*Files:* `bun-apps/s2-agent-ext-knowledge-card/src/adapters.ts` (`adaptGenericMarkdown` step 4 link harvest), root-cause the `sources` derivation in `src/ingest.ts` (`sourceLabel`, lines 164/282) / graph-note writer; regression fixture = the recite graph note content.
*Done-when:* red test pins the artifact — tags contain neither `tags/index` nor `paper---procedural-graphs-…`, and `sources` is never a cross-card title; generic family harvests frontmatter tags + hashtags only (hermes/auto-memory unchanged); re-ingest the 3 existing cards converges them clean (idempotent upsert); the duplicated H1/核心想法 block in `generic-paper-recite.md` is root-caused (template echo vs double render) and fixed or ticketed.
*Risks:* link harvest intentionally drives cross-source edges for other families — don't break their semantics; converging old cards touches the real vault (bridge + explicit vault + on-disk verify).

**05-wave1-cards.md** — ~5 papers (incl. long + figure-heavy) → house-format kcards, every numeric bullet carrying a `Table/Figure N, p.X` anchor, every vision bullet provenance-labeled and ground-checked; converge via the s2-agent bridge (explicit vault + on-disk verification: graph note per card id, semantic-index grep hits, MOC update).
*Done-when:* ≥5 cards PR-ready in the vault worktree; ground-check receipt clean; convergence artifacts verified on disk, not by the session's claim (parent fog resolution).
*Risks:* long-paper distillation may hit ingest's 32k detail truncation (`card-render.ts truncateDetail`) — verify one; 2-card split only per D8.

**06-wave2-backfill-verify.md** — remaining ~5 papers; backfill wave-1 cards with newly-detected figure evidence from fix 02; final verification greps across all 10–12 cards (index + graph + MOC).
*Done-when:* 10/10 papers ≥1 card (10–12 total); backfill receipt; verification grep table in the receipt (deterministic greps per D9 — orphan detector stays bench-owned).

**07-reviewer-audit.md** — glm-5.3 read-the-artifact reviewer, same protocol as `review-glm53-2026-09-09.md`: verify every checkable number vs page-md, MISATTRIBUTED = 0 hard gate, grounding-spot-check vision bullets; blockings fixed in-card with visible correction records (parent D1).
*Done-when:* reviewer receipt filed; all blockings fixed in-content with correction notes; count/label classes (findings 3/6 last time) at zero.

**08-merge-closeout.md** — vault PR via submodule flow (pin only the merged sha — parent D2), repo PR with effort folder (map.md, receipts, tickets — never leave `.planning/<effort>/` untracked), map cross-links (`Builds-on: 2026-09-09-file2md-kcard-pipeline`, `Shares-decision-with: 2026-09-08-file2md-svg-pptx-vision`), successor `next-goal` written BEFORE reporting done (hands-off rule).

## 3. Decisions

- **D1:** Thin probe in 01 before any mass writing — fixes finalize on measured evidence, not theory.
- **D2:** Caption widening = line-anchored alternation + unchanged body band; the prose guard moves from "rare caption shape" to "line anchor + band" (one named constant, red test first — figure.ts's own house rule).
- **D3:** `ground.ts` lives in file2md `src/vlm/` as a pure module so the card lane and bench lane 1b share it; vision stays interpretation — the check gates 證據 admission.
- **D4:** Generic-family wiki-link targets stop feeding tags/sources; other families keep their harvest (their links denote real sibling topics; house-card links are structural).
- **D5:** Every numeric bullet names Table/Figure + page (auditable post-`git clean` — review finding 5).
- **D6:** PDFs/page-md stay gitignored under `output/`; committed record = selection manifest + receipts with measured numbers (bench phase 0 owns committing fixtures).
- **D7:** Convergence only via the bridge with explicit vault + on-disk verification; no direct writes.
- **D8:** 1 card/paper default; 2 only on a strong method/results split, cross-linked.
- **D9:** This arc verifies convergence by deterministic greps; the `zk_card check` orphan detector remains bench scope (no scope creep).

## 4. Fog of war (verify at execution)

1. Telemetry shape: does `--extract smart` expose per-page `figure.detected/enhanced` consumably (`src/vlm/manifest.ts` / `src/pipeline.ts`)? Verify before building 01's table.
2. Graph-note `sources` derivation path — the cross-card title suggests link-tag → label somewhere between `adapters.ts` and the graph writer; root-cause before the D4 edit.
3. `arxiv.ts` category filtering vs query-string-only.
4. Whether any corpus PDF is scan-provenance (else `isScanFigure` arm stays unmeasured — acceptable, note it in the receipt).
5. stat.ML/cs.CV 2-column + math extraction quality — unknown failure class, measured in 01.
6. Reviewer cost at 10–12 cards (last audit: ~446k tokens for 3 papers + bench design) — budget ~2–3×, pace the dispatch.

## 5. What is WRONG (or understated) in the task brief — evidence

- **W1 — "Pipeline proven … figure-page vision via `askImage`" overstates.** Review §2 finding 8 (`receipts/review-glm53-2026-09-09.md`): the heuristic fired **0 times** on the first 3 papers and "the fig descriptions came from a hand-rolled script around the same seams". The heuristic→vision **handoff** is unproven; ticket 01 exists to test it.
- **W2 — weakness 1's blind spot is narrower than stated.** `figure.ts:24` `FIGURE_CAPTION_RE = /\bfigure\s+\d+\s*[-–]\s*\d+\s*\./i` confirmed `N-x.`-only (so `Figure 1:` cannot match — TRUE), but the scan arm `isScanFigure` (`figure.ts:37-39`, OCR ≤ 200 chars) is caption-agnostic. Corollary the brief misses: the figure-heavy corpus pick must be **born-digital** or it fires via the OCR band and masks the bug entirely.
- **W3 — weakness 3 is understated: it's provenance corruption, not tag noise.** `vaults_root/s2-agent-vault/Zettelkasten/knowledge-graph/generic-paper-recite.md` frontmatter: `tags: [… paper---procedural-graphs-程序知識的圖結構與自演化, tags/index, …]` (harvested from `[[Paper - Procedural Graphs …]]` and `[[Tags/Index]]` — confirms the adapters.ts step-4 harvest) AND `sources: ["generic:Paper - Procedural Graphs 程序知識的圖結構與自演化"]` — **a different paper's title as this card's source label**. The same note also renders the H1/`## 核心想法` block twice (body echo + metadata echo) — fold into ticket 04.
- **W4 — minor:** `src/vlm/ground.ts` is greenfield (confirmed absent: `src/vlm/` holds agents/ask/classify/manifest/mermaid/retry/validate/vision-inference only), and `src/core/figure.test.ts` **already exists** — red-test-first has a home, no new test file needed.