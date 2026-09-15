All evidence is in. The pre-adjudication is complete — including two live corrections to my own probe (section-extraction bug found and fixed, rankings re-verified). Here is the plan.

---

# Plan — `kcard-hit3-residual`: hit@3 0.744 → 0.85 pre-adjudicated

**Playbook applied:** PB-01 (sync at open), PB-10 (PRE-fix per-class evidence before the lever), PB-11 (pre-registered decision trees below), PB-12 (adjudicated from the receipt's preserved per-question bytes + offline probes, not prose), PB-13/15 (failing/unreachable cells preserved and labeled, never passes), PB-14 (≤2 variants per lever, no green-light re-rolling), PB-16/18 (cross-links both maps; evidence committed under `evidence/`), PB-03/04/05/06/17 (close-out chain).

## 0. Pre-adjudication verdict (the brief's question 5) — measured, not argued

**The gate is reachable ONLY if two independent levers land near-perfectly in sequence; the amendment path is the likely honest terminal and is pre-registered below.** All numbers from `receipts/production-mrr-final-tree.json` detail rows (offline re-derivation, deterministic classifier):

| class (derived) | n | hit@3 | MRR | rank histogram |
|---|---|---|---|---|
| REL-anchored | 8 | 0.125 | 0.151 | 0×4, 4×3, 8×1, 3×1(hit) |
| REL-bare | 4 | 0.000 | 0.000 | 0×4 |
| PAGE (第幾頁/頁碼) | 5 | 0.600 | 0.558 | 1×2, 2, 6, 8 |
| topical/other | 61 | 0.885 | 0.844 | incl. 7 non-hits |
| **total** | **78** | **0.744** (58 hits) | **0.711** | need 67 hits (0.858) |

1. **REL-bare (4 questions) is unfixable by ANY content ranker — proven with a probe, not argued.** Three of them are the *byte-identical* string 「這張卡與哪兩張卡片有「相關」連結？」 targeting three *different* cards; the fourth differs only by template. Offline probe (`/tmp/probe-rel.mjs`, to be committed as evidence): after removing relation/deixis template vocabulary, **all four score exactly 0 distinctive tokens**. A query-independent prior (link centrality) cannot serve 3 identical queries → 3 different targets without catastrophic collateral. These are zk_ask-shaped (the asker is *reading* the card); the retrieval lane has no context card. → recorded gap (PB-15), never a pass.
2. **REL-anchored (8) has a real, offline-proven signal.** The anchor phrases (理論側同伴 / 同為視覺表徵研究 / agentic 流程的兩種顯式化 / GPU 記憶體安全標準化評測 / …) exist **verbatim in the target cards' `## 連結` sections** (checked on the real vault AND on a fresh converged sandbox — they survive the ingest round-trip). A crude 連結-scoped distinctive-bigram overlap ranks **6/8 targets #1** among all 2364 cards; 09124 (canonical-color) lands #6 because its own 連結 lacks the phrase (backlink asymmetry — the phrase lives on the partner card).
3. **Arithmetic ceiling of the relation lever alone: 58+7 = 65/78 = 0.833 < 0.85.** Crossing requires +2 more from PAGE (2 non-hits) or topical (7 non-hits: 09153×2 benchmark-lists, 09126 三步結構, 09124 curves, 08871 p.2-layout, 09134 h0/h∗, 08810 篇幅) — the α lever's semantic-near constituency. Expected landing: **0.82–0.85**; the amendment must be pre-registered now, not improvised at close-out.

## 1. Anything WRONG in the brief (with evidence)

1. **"34 non-rank-1 questions" (successor step 2) — wrong: it's 28** (50 at rank 1). The lift-2 map's "9 rank-0 / 78" is 9 unique *papers* but **11 rank-0 questions**. Correct both in this arc's map Context (PB-16 correction note; don't silently edit the closed map).
2. **"only ~14 relation-class questions" — it's 12, and the split is load-bearing**: 8 anchored (servable, offline-proven) / 4 bare (proven unservable). A lever "tuned to 14" overstates both the upside and the overfit surface.
3. **"`parseRelationsBlock` already runs during the flat scan (relations on every scored card)" — misleading as a lever substrate.** `parseRelationsBlock` (retrieve.ts:1014) parses frontmatter `relations:` blocks — **zero cards in this vault have one** (`grep -l "^relations:"` → 0 files). The paper links live in markdown `## 連結` sections (1867/2364 cards have one). The parsed field is empty today; it is not the signal surface.
4. **The 連結 section is invisible to the semantic surface by design** — `cardEmbedText` strips it: semantic.ts:108 `.replace(/## 連結[\s\S]*$/, "") // link-list scaffolding, not content`. It *is* in the lexical surface (`bodyTokenOverlap`, retrieve.ts:383-393, reads full content minus frontmatter) but drowned: 相關/連結/卡片 appear in ~1867 sections plus every system-meta card's body — that vocabulary *is* the corpus of the cards that currently win (receipt top-10s show `generic-tag-noise-flat-shared-tag-cross-link`, `Callout-Boost-Empirically-Neutral`…).
5. **"α-band monotone" was measured on the PRE-review-fix tree.** The final tree changed blend behavior (F5 semTop re-entrants keep `_lexOv`; 0.720→0.711 at α=0.18). Monotonicity at α>0.18 is unverified on the final tree — the 0.26/0.30 receipts are genuinely open measurements, not extrapolation.
6. **The 0.85 gate is enforced nowhere in code** — it exists only in the query-gates.ts:10 comment (and MRR 0.70 likewise). This arc must either put the gate rows in the scorecard (enforced) or amend them explicitly — leaving it prose-only repeats the pattern PB-20 exists to end.
7. **MRR-margin asymmetry the brief doesn't state:** margin is 0.011; **one** rank-1→rank-0 flip costs 0.0128 and breaks the hold. The gated relation lever cannot touch non-REL questions (MRR-safe by construction); the α lever touches everything. This dictates the execution order.

## 2. Execution order

```
T1 classify + per-class column + PRE-fix per-class evidence (offline, receipts untouched)
T2 relation lever V1 (red-first offline; ONE embed receipt; pre-registered acceptance)
T3 α-band decision (embed receipts on the LEVER tree; conditional — see D4; ≤1 variant)
T4 gate enforce-or-amend in the scorecard (+ amended floors if 0.85 unreached)
T5 reviewer → PR → merge → map Shipped-as → validated successor + LATEST → push all (PB-03/04/05/06/17)
```

Rationale: classifier first so the lever is judged on the class it claims (PB-11); lever before α because it is MRR-safe by construction and α must be judged on the shipped shape; gate wording last, from receipts in hand.

## 3. Tickets

**T1 — Per-class diagnostic column + census pin + PRE-fix evidence**
- **Goal:** `classifyQuestion(q)` in new `bun-apps/bench-kcards/src/lanes/classify.ts` (deterministic, question-text only, goldens untouched — derived like the zeroTag column): `relation-anchored` / `relation-bare` (distinctive-token set empty after relation/deixis stopword list) / `page` / `topical`. `productionMrr` (production.ts) returns `perClass: {n, hitAt3, mrr}[]`; `receipt-run.ts` (which currently hardcodes the lift-2 receipts dir — parameterize out-dir) emits it.
- **Files:** `src/lanes/classify.ts` (new), `src/lanes/production.ts`, `tests/receipt-run.ts`, `tests/classify.test.ts` (new), `tests/production.test.ts`.
- **Done when:** census test pins `{anchored:8, bare:4, page:5, topical:61}` on golden-v2; committed evidence `evidence/pre-fix/per-class-final-tree.json` (offline derivation from the existing receipt — PB-10, no embed run needed); bench + knowledge-card suites green.
- **Risks:** regex drift between my probe stopword list and the shipped classifier (pin the census, not the regexes); page-class boundary (08871 "p.2 的版面結構" classifies topical — accepted, recorded).

**T2 — Relation lever V1: gated 連結-scoped lexical term**
- **Goal:** in `retrieve.ts` flat scan: when the query is relation-intent (`連結` present AND one of 相關/互為/同屬/指向), add a bounded term `REL_TERM·min(relOv,3)/3` to `_score`, where `relOv` = |distinctive query tokens ∩ card's 連結-section tokens| (same distinctive-token set as the classifier — one shared stopword constant, exported from card-format leaf or classify); count `relOv` into `_lexOv` so the existing β term saturates for these cards. No frontmatter change; no embed-text change in V1.
- **Files:** `retrieve.ts`, `card-format.ts` (shared constant), `tests/retrieve.test.ts` + `tests/lexical-blend.test.ts` (red-first: anchored-REL fixtures rank lexical #1; non-REL queries byte-identical — gate never fires), bench receipt run.
- **Done when:** red tests land first; offline integration test shows ≥6/8 anchored targets lexical-rank 1 on a converged sandbox; ONE embed receipt `receipts/production-mrr-lever-v1.json` (α=0.18) judged against the PRE-registered acceptance (PB-11): **REL-anchored hit@3 ≥ 0.75 (6/8), overall MRR ≥ 0.711, topical hit@3 = 0.885 unchanged (must be exact — gate can't fire on topical queries), overall hit@3 ≥ 0.80.** If acceptance fails → diagnose from per-question paths (lexical #1 but blend-buried = the α-cap, see F1) → at most ONE variant V2 in T3. Never re-roll V1 (PB-14).
- **Risks:** α-cap: a lexical-#1 target carries only α·0.9167 + β·0.2 ≈ 0.365 vs a semantic winner's 0.82·1.0 — target needs cosNorm ≳ 0.5–0.67 *within the ≤24-card union pool*; canonical-color (09124) backlink asymmetry lifts the *partner* card (accepted: it's a non-hit either way; MRR cost ≤0.0016, inside margin); relation stopwords must live in ONE place or classifier and lever drift apart.

**T3 — α-band decision (conditional) + optional V2**
- **Goal, pre-registered (D4):** if T2's receipt crosses hit@3 ≥ 0.85 with MRR ≥ 0.70 → band decision = **hold 0.18**, T3 is paperwork (record the decision with the T2 receipt; saves 2 embed runs). Otherwise: embed receipts α∈{0.26, 0.30} **on the lever tree** (2 runs, one variant per run). Flip `SEMANTIC_ALPHA_DEFAULT` (semantic.ts:31) only if some receipted α shows hit@3 ≥ 0.85 AND MRR ≥ 0.70; else hold and record. If T2 diagnosed the α-cap as binding (targets lexical-#1, blend-buried), the ONE allowed variant V2 = include the 連結 section in `cardEmbedText` (semantic.ts:108) — and then the cache fingerprint MUST gain a text-version constant (see F4) — re-receipt once at α=0.18; class-scoped α is rejected (overfit-adjacent, D1).
- **Files:** `semantic.ts` (default flip or embed text), `converge-sandbox.ts` (no change — it already `rmSync`s the semantic cache per run), `tests/semantic*.test.ts`, `tests/receipt-run.ts`.
- **Done when:** `receipts/production-mrr-a26.json` / `-a30.json` (+ `-lever-v2.json` if fired) exist with per-class columns; the flip-or-hold decision is written in the map `## Decisions` citing them; MRR < 0.70 at an α → that α is dead, recorded (PB-13), no re-rolls.
- **Risks:** monotonicity may break past 0.22 (unmeasured on final tree); each run = full 2364-note re-embed (~minutes); α moves ALL classes — per-class columns are the safety eyes.

**T4 — Gate enforce-or-amend**
- **Goal:** put the production-lane gates in the scorecard as data rows, either `{mrr ≥ 0.70, hit@3 ≥ 0.85}` (if crossed) or the amended floors **{MRR ≥ 0.70 overall; REL-anchored ≥ 0.75; PAGE ≥ 0.60; topical ≥ 0.885 (no-regression); REL-bare = recorded gap "context-shaped, unservable by question-only retrieval" with the probe receipt as evidence}**. Update the query-gates.ts:10 comment to whatever ships.
- **Done when:** scorecar emits gate rows + pass/fail; suites + `bun run check`-equivalents + local-ci PASS; the amendment (if taken) cites the arithmetic in §0 (bare-4 = 5.1% of denominator; 0.85 needs 67/78 = 90.5% of ALL questions including 4 unservable ones).
- **Risks:** amendment must not read as goalpost-moving — it is justified by the committed probe evidence + per-class receipts (PB-15), and the overall hit@3 stays REPORTED even when not gated.

**T5 — Reviewer, merge, close-out**
- **Goal:** independent reviewer (fresh process) on the arc's outputs incl. re-deriving the census + one receipt from its detail (PB-06/PB-12); fix blockers same session; squash-merge + verify-merge; map `status: done` + `## Shipped-as` in the SAME PR (PB-05); supersede next-goal + validate + repoint LATEST + doctor (PB-04); everything pushed incl. `.planning/2026-09-15-kcard-hit3-residual/` + `evidence/` (PB-03/17/18); `Builds-on: 2026-09-15-kcard-retrieval-lift-2` cross-link on BOTH maps (PB-16).
- **Risks:** reviewer availability; vault submodule pointer stays uncommitted (standing rule — keep recording the working-tree sha `559cca6d` in receipts).

## 4. Decisions (with evidence)

- **D1 — V1 is a gated lexical term, not link-centrality, not embed-surface, not class-α.** Centrality is query-independent and provably cannot serve 3 identical queries → 3 different targets (probe: all-zero distinctive tokens). Embed-surface change costs a full re-embed + regression risk to 61 topical questions for a signal the lexical path already wins 6/8. Evidence: semantic.ts:108 (連結 stripped from embed), retrieve.ts:383-393 (lexical sees it), probe output (6/8 at relRank 1).
- **D2 — REL-bare is a recorded gap, never a pass** (PB-15). Evidence: probe (4/4 zero-score), 3 byte-identical questions → 3 targets (08871/09090/09143).
- **D3 — Amendment pre-registered** (PB-11): floors as in T4, triggered iff no receipted configuration reaches 0.85+0.70. Evidence: §0 arithmetic (max 0.833 via relation lever alone).
- **D4 — α runs conditional on T2 < 0.85** — saves 2 embed runs when moot; both orders judged on the LEVER tree (the shipped shape), never the pre-lever tree. Evidence: brief's own "beyond-band is a separate decision needing its own receipts" + monotonicity unproven on final tree (map: α-band rows pre-review-fix).
- **D5 — Classifier = 4 classes, question-text only, census-pinned** {8,4,5,61}. Evidence: my offline derivation above; the derived-column precedent (zeroTag, map T0).
- **D6 — MRR-hold is enforced by construction on T2** (gate fires only on relation-intent queries; none of the 61 topical/5 PAGE questions match) — assert it exactly (topical hit@3 identical to 3 decimals), because the overall margin is one flip wide (0.011 < 1/78).

## 5. Fog of war (probe at execution)

- **F1 — α-cap survival (the big one):** does a lexical-#1 relation target survive `α·0.9167 + 0.82·cosNorm + 0.2` against a semantic winner inside the 24-card union? Diagnose from per-question `paths` + a trace run (includeTrace exists) — target in lexPool-#1 but blend rank >3 = cap confirmed → V2 trigger.
- **F2 — canonical-color asymmetry:** its anchor lives on the partner card (image-tokenizers' backlink), not its own 連結 — V1 lifts the partner for 09124. Accept as non-hit; watch MRR ±0.0016.
- **F3 — Sandbox↔vault drift:** probes ran on the real vault; receipts on the converged sandbox — anchor-preservation verified on 5 key cards, but the lever calibration should re-run the offline probe against a converged sandbox (cheap, no embeds).
- **F4 — Embed-cache fingerprint trap (PB-09 class):** fingerprint = name+mtime (semantic.ts getCardEmbeddings) — any V2 text change would serve STALE vectors on the real vault (sandbox is safe: converge-sandbox rmSyncs). V2 must add a text-version constant to the fingerprint.
- **F5 — PAGE/topical residual responsiveness to α:** 09153×2 (benchmark-list), 09126 (三步結構) are lexical-starved (target mentions the term ≤1×; competitors are benchmark papers) — α's constituency; unknown whether 0.26/0.30 helps before hurting MRR.
- **F6 — Submodule pointer discipline** (carried): receipts record working-tree `559cca6d`; pointer PR remains a separate carried item.

**Bottom line for the dispatcher:** fund T1–T2 regardless (the diagnostic column is permanent instrumentation; the relation lever is offline-proven, MRR-safe, and worth +5..+7 hits → 0.81–0.833). T3's α receipts decide between flip and amend; the amendment (per-class floors + bare-REL gap with committed probe evidence) is the pre-registered honest terminal, not a fallback to be ashamed of — 4 of the 20 residual questions are unservable by question-only retrieval *by construction*, and the gate as originally worded silently charged them to the ranker.