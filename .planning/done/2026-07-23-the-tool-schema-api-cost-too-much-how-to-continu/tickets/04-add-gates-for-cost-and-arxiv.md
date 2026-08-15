---
type: grilling
status: closed
blocked by: [03]
claimed: pi-session-2026-07-23
---

## Question

**Add gates for the three ungated heavy tools** found in 03 — `cost` (536 tok), `arxiv_fetch2md` (311), `arxiv_search` (257) — recovering **~1,104 tok/req (−12.5% of the active cost)**. Expected end state: tool-gate's `bun run qa:savings` baseline drops from 8,834 → ~7,730 tok, and `bun run qa --strict` stays GREEN with new L1 probes for the added gates.

This is the map's highest-ROI, lowest-risk thread (ticket 03's measured finding). Resolve by grilling:

1. **`arxiv_*` — one gate or fold into the existing research-tool gate?** The research-tool gate already keywords `bilibili`/`youtube`/`collect videos`. `arxiv`/`paper`/`論文` are the same shape (narrow, low false-fire). Decide: extend the existing `collect_videos` gate's `names` + `keywords`, or a standalone `arxiv` gate. (Recommendation: standalone — different intent from video collection, cleaner escape-hatch routing.)
2. **`cost` — co-occurrence gate.** Bare `cost` false-fires ("what's the cost of…", "token cost"). Needs the `requires` noun∧verb pattern (ticket 00's gateFires supports it): nouns `[cost, budget, 報價, 成本, 預算]` ∧ verbs `[estimate, quote, 計算, 估]`, OR a narrow keyword `cost estimate`, `production cost`. Author must-fire / must-not-fire L1 probes per the verify-map discipline.
3. **Keep `arxiv_paper` (93 tok) ungated?** Below the 150 threshold — leave always-on, or include in the arxiv gate for free? (Recommendation: include — one more name in the gate array costs nothing and removes a light always-on tool.)

**Acceptance.** New gates authored in `extensions/tool-gate.ts` `GATES[]`; L1 probes added to `qa/probes.ts` (must-fire / must-not-fire / escape); `bun run qa --strict` GREEN; `bun run qa:savings` shows the ~1,104 tok drop.

## Resolution (2026-07-23)

**Done — all acceptance criteria met, savings beat the prediction.**

**Design decisions taken (per the ticket's recommendations):**
1. **arxiv = standalone gate** (not folded into `collect_videos`). Rationale: paper retrieval is a different intent from video collection; a separate gate gives cleaner `enable_tool` escape-hatch routing. `names: [arxiv_search, arxiv_fetch2md, arxiv_paper]`.
2. **`cost` = co-occurrence gate, bare `cost` is NOT a keyword.** `requires: nouns[cost/budget/成本/預算] ∧ verbs[estimate/calculate/...]` — only cost-ESTIMATION intent fires; generic "what's the cost" / "token cost" stay dormant.
3. **`arxiv_paper` (93 tok) included** in the arxiv gate for free — one more gated name removes a light always-on tool. (This is why the win is −1,197, not the predicted −1,104.)

**Measured (`bun run qa:savings` + `bun run qa --strict`):**
- ON baseline **8,834 → 7,637 tok/req (−1,197)**; saved **39.9% → 48.1%**.
- L1: must-fire 37/37 · must-not-fire 22/22 · escape-name 12/12 · escape-intent 12/12.
- `--strict` **GREEN** — 0 task-breaking gates; 8 benign false-fires (non-gating), incl. the 2 new ones documented below.
- `bun test` 189/189 pass.

**New benign precision risks (documented in `PRECISION_RISKS`, never gate):**
- `arxiv_search` — "read the white paper first" (noun paper ∧ verb read; doc-reading, not arxiv) — low.
- `cost` — "estimate the token cost" (noun cost ∧ verb estimate; dev/infra, not movie-production) — low.

**Files changed:** `extensions/tool-gate.ts` (+2 `GATES` entries), `qa/probes.ts` (+6 must-fire, +3 must-not-fire, +2 escape-name, +2 escape-intent, +2 precision-risk).

**Optional follow-up (not blocking, not fog):** the L2 reachability suite (`qa/l2-tasks.ts`) has no arxiv/cost task — adding representative ones would match the existing 10-task coverage but is completeness, not a decision. Deferred unless the suite is re-baselined.
