All reads spent (4 file reads + 1 surface-sweep of the knowledge-card package). The sweep resolved the fog items concretely: `retrieveRecords` at `src/retrieve.ts:429`, `embedQuery` at `src/semantic.ts:177`, `ingestRecords` at `src/ingest.ts:208`, and one surprise — `cat src/index.ts` printed **nothing** (empty or missing lib face), which matters below.

---

## 1. Execution order (dependency structure)

```
T0 scaffold + lib-face seams ──┬──> T1 fixtures + golden.json ──┬──> T6 live lanes + scorecard
                              ├──> T2 lane 1c (structural)      │        (1d, 1b, 2b, 1e)
                              ├──> T3 lane 1a (extraction)      │
                              └──> T4 convergence harness ──> T5 lanes 2c+2d (+bite check)
                                                                      │
T2 + T3 + T5 ─────────────────────────────────────────────────────────┴──> T7 gates + close-out
```

Serial order T0→T1→T2→T3→T4→T5→T6→T7; T2/T3/T4 are parallelizable after T0+T1.

## 2. Tickets

**T0 — scaffold + seam verification** (`bun-apps/bench-kcards/`, `.planning/2026-09-10-bench-kcards/`)
- Goal: plain workspace package (NOT s2-agent-ext-*), effort folder opened, and the two lib faces actually importable.
- Files: `package.json` (deps `@repo/s2-agent-ext-file2md`, `@repo/s2-agent-ext-knowledge-card`), `src/vault-sandbox.ts` (copy `vaults_root/s2-agent-vault` → `mktemp -d`, NEVER the real vault — assert real-vault mtime/hash unchanged after every test), `tsconfig.json`, biome config.
- Done-when: `import { openPdf } from "@repo/s2-agent-ext-file2md"` and `import { ingestRecords, retrieveRecords, readCardMeta } from "@repo/s2-agent-ext-knowledge-card"` both typecheck. **Probe first**: knowledge-card's `src/index.ts` is empty/absent (observed via cat) — if so, create the lib-face re-export file + `main` field as part of T0 (additive, no registry change).
- Risks: knowledge-card may export through `src/ingest.ts`-internal paths only; a lib face may pull in heavy transitive deps.

**T1 — fixture corpus + golden.json**
- Goal: frozen, committed, ground truth independent of the pipeline under test.
- Files: `bench-kcards/fixtures/papers/*.pdf` (13, plain `mv` from `output/kcard-{scale,papers}/` — uncommitted today), `fixtures/golden/<arxiv-id>.json`, `src/golden-schema.ts`.
- Done-when: 13 PDFs committed (~41 MB, see D5); per paper 8 answerable + 2 unanswerable Qs authored from **independent pdfjs `openPdf` re-extraction only** (never `output/*/md`); numeric claims are verbatim quotes with `page` + table/figure anchor; schema validation test asserts anchors resolve to real page numbers ≤ numPages; 20% human spot-check sign-off recorded in the effort receipt; `fixturesHash`/`goldenHash` computed.
- Risks: golden authoring is the quality ceiling of every downstream gate; a lazy session leaks file2md phrasing → gates become circular. Mitigate: authoring script reads only via `openPdf`, never imports file2md conversion code.

**T2 — lane 1c structural compliance** (deterministic, offline)
- Goal: format drift caught forever, zero LLM.
- Files: `src/lanes/structural.ts`, wired into `bun test`.
- Done-when: on the copied 13 real cards — frontmatter keys via `readCardMeta`/`readCardFrontmatterFields`, `id` matches `^\d{12}$`, sections 核心想法/證據・脈絡/連結 present, wiki-links resolve (incl. `[[Tags/Index]]` hub), sources non-empty, evidence anchor (table/figure + page) on every numeric bullet; generic-adapter leak regression (per-card `sources`, no wiki-link→tags harvest); collision check scoped per D8 with the known pure-CJK `generic-paper.md` fallback as a documented xfail, not a blocker.
- Risks: as literally written in successor step 3, the CJK gate deadlocks the first green run (see §5.3).

**T3 — lane 1a extraction faithfulness proxies** (deterministic, offline)
- Goal: number/span/table survival vs independent re-extraction.
- Files: `src/lanes/extraction.ts` — runs file2md conversion on fixture PDFs into tmp (vision off = deterministic), then compares against per-page `openPdf` text.
- Done-when: number-token recall ≥ 0.98 (boundary-aware, reuse ground.ts's matcher), 20+-char span coverage ≥ 0.95, golden-table row survival ≥ 0.95; scorecard fields populated.
- Risks: pdfjs-direct is the same engine file2md uses — independence is at the pageText/join layer, which is what's under test; state that in the lane docstring. Table row survival needs a tolerant row matcher (whitespace/cell-wrap).

**T4 — convergence harness** (the finding-2 bypass class, permanent red gate)
- Goal: tmp vault converged in-process, idempotently.
- Files: `src/converge-sandbox.ts` calling `ingestRecords` (import path `@repo/s2-agent-ext-knowledge-card` → `src/ingest.ts:208`) over the copied card files.
- Done-when: (a) converge completes with no bridge/model session; (b) re-ingest = no-op (0 new cards, index file hashes unchanged) — the idempotence contract; (c) orphan red-gate: hand-write one card file directly into the tmp vault, assert it is ABSENT from the semantic index and unretrievable — the gate that made finding 2 silent forever after.
- Risks: embedding required for converge (localhost BGE-M3, LM Studio :1234 — canonical per CLAUDE.md); skip-guard if unreachable. `ingestRecords` signature/seam shape unverified (probe at execution).

**T5 — lanes 2c + 2d query gates + bite check**
- Goal: retrieval quality measured, not asserted.
- Files: `src/lanes/tag-recall.ts`, `src/lanes/retrieval-mrr.ts`.
- Done-when: 2c — expected card in top-5 of the tag digest for its tags, recall@5 ≥ 0.90 across the 13; 2d — via `retrieveRecords` (`src/retrieve.ts:429`) + `embedQuery` (`src/semantic.ts:177`): MRR ≥ 0.70, hit@3 ≥ 0.85 on golden questions against the converged tmp vault; **mutation check**: delete the 13 cards' vectors from the copied semantic index → lane must FAIL at ~0.0 (proves the gate bites — the done-when in the successor); receipt kept, never deleted.
- Risks: `RetrieveOptions` may not accept an injectable embedder → offline determinism via committed pinned question-embeddings may need the seam added, else run 2d in `test:embed` tier (D7).

**T6 — BENCH_LIVE=1 lanes + scorecard**
- Goal: real-model lanes, one receipt artifact.
- Files: `src/bench.ts` (entry, `bun run bench`), `src/lanes/{card-faith,vision-ground,zk-ask,dedup}.ts`, emits `output/bench-kcards/receipt-<ts>.json` per design §3 shape.
- Done-when: 1d — every numeric card bullet judged by glm-5.3 (spawnSubagent) returning `{page, quote}`; SUPPORTED/MISATTRIBUTED/UNSUPPORTED; faithfulness ≥ 0.95 and **MISATTRIBUTED = 0 hard gate** (planted-fault: re-inject the original ReCite cross-table numbers → judge must flag); 1b — ground.ts pre-check + glm-5.3-flash entailment, grounded ratio ≥ 0.90, any hallucinated number = blocking; 2b — zk_ask graded FAITHFUL+CITED / −UNCITED / HALLUCINATED / REFUSED, hallucinated = 0, refusal-on-unanswerable ≥ 0.80; 1e — 10 planted dups (4 exact/3 light/3 heavy), exact+light catch ≥ 0.90; live subset = pinned 5-paper stratification (D6); scorecarard has `verdict` + `regressionsVs`.
- Risks: judge must read tmp page-md + rasters, not the real vault; cost ~150 calls at 5-paper subset (design's priced budget).

**T7 — gates + close-out**
- Done-when: `check` + `typecheck` + `test` green (local-ci resolves by NAME — register exactly those); live scorecard recorded; reviewer subagent verdict cited in PR body; squash-merge CLEAN; map closed Shipped-as; validated successor next-goal re-points `output/LATEST-next-goal.md` BEFORE reporting done.

## 3. Decisions

- **D1** — 2d primitive = `retrieveRecords` (`bun-apps/s2-agent-ext-knowledge-card/src/retrieve.ts:429`), query vectors via `embedQuery` (`src/semantic.ts:177`); zk_ask/knowledge_query are wrappers — measure the primitive. Rationale: named, importable, deterministic.
- **D2** — tmp-vault convergence = in-process `ingestRecords` (`src/ingest.ts:208`), never the bridge. Rationale: deterministic, no model session, and it directly exercises the upsert path the bypass skipped.
- **D3** — 1c/1d source of truth = the 13 REAL vault cards (copied, never mutated). Rationale: the bench measures production truth; regeneration from page-md is LLM authoring, covered by 1d judging the real cards.
- **D4** — scripts: `check` / `typecheck` / `test` (offline canonical trio for local-ci by name) + `test:embed` (localhost-only cross-check, skip-guarded) + `bench` (BENCH_LIVE=1 → scorecard).
- **D5** — commit all 13 PDFs (~41 MB; largest = 20 MB SyncWorld kept — it IS the figure-heavy stressor that fired the new `isCaptionFigure` band 9/9). GitHub's 100 MB/file limit nowhere near; no LFS. Reproducibility post-`git clean` (design finding 5) beats size.
- **D6** — live lanes run a pinned stratified 5-paper subset (SyncWorld, ReCite 2609.09156, Amari math-only + 2); deterministic lanes keep all 13. Rationale: design's ~150-call / one-coffee estimate was priced at 5 papers; 13×10 questions ≈ 2.6× that.
- **D7** — 2d offline determinism via committed pinned question-embeddings + Embedder injection if the seam allows; fallback = `test:embed` tier. Rationale: "plain `bun test`" and live embeddings are contradictory as written.
- **D8** — CJK-slug collision gate = assert no collisions among the 13 + xfail documenting the known pure-CJK `generic-paper.md` fallback (observed on 軟體供應鏈 card; fix is ranked next-goal #3, out of scope here).
- **D9** — golden authored exclusively from independent `openPdf` re-extraction of committed fixture bytes. Rationale: anti-leak — golden must not inherit file2md's join/heuristic layer.

## 4. Fog of war remaining (probe at execution)

1. knowledge-card lib face: `src/index.ts` empty/absent (my cat printed nothing) — T0 must create or verify it; the whole dep assumption rests on it.
2. `RetrieveOptions` shape: injectable embedder? tag-filter mode for the 2c digest? Read `retrieve.ts` at T5 start.
3. `.knowledge-semantic/*.json` index loadable standalone from a copied vault (format/version compat).
4. Corpus is 100% born-digital arXiv — the design's scanned/OCR paper class is still absent; lane 1b's OCR branch untested. Known gap, not a blocker.
5. LM Studio reachability inside local-ci context — skip-guards must skip loudly (receipt notes it), never silently pass.
6. Golden-authoring judge session quality — the 20% human spot-check is the only backstop; schedule it before any gate trusts golden.

## 5. WRONG in the successor steps (evidence)

1. **Cost inflation, unflagged**: step 2/6 imply all 13 papers × (8+2) Qs in live lanes (~130 Qs, ~2× the design's "~50 questions × (1 ask + 1 judge)" priced budget); design §3's table and cost note are per 5 papers. → D6 stratification.
2. **"2d green in plain `bun test`" is impossible as written**: MRR needs `embedQuery` → LM Studio localhost; plain offline `bun test` can't have both. → D7 pinned vectors / embed tier; amend the done-when wording.
3. **Step 3's CJK-slug collision check would deadlock the first green run**: the fallback bug is observed-this-arc (軟體供應鏈 → `generic-paper.md`) and its fix is explicitly deferred to next-goal #3. A hard gate on it blocks T2 forever. → D8 xfail.
4. **Design's lib-face assumption unverified for knowledge-card**: `cat bun-apps/s2-agent-ext-knowledge-card/src/index.ts` → empty output; if no lib face exists, step 1's "deps on the two lib faces only" needs a small additive T0 fix before anything imports.
5. **Minor, step 2**: "move" the PDFs but do NOT also commit the `output/*/{md}` conversions — the bench must regenerate page-md in tmp per run; committing stale conversions invites testing the label instead of the artifact (trap class of operating-learning 2, the same class as finding 2's "converged" label vs actual index bytes — which is exactly why T4's orphan red-gate and T5's mutation check exist).

No deployed-tree learnings applied directly (no deploy divergence in scope); learning 2's *label ≠ content* class appears twice and is countered structurally (D9, §5.5, T4/T5 bite checks).