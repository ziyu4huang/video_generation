# Review — pi-agent-ext-tool-gate complete redesign

**Date**: 2026-08-15
**Base**: working tree (`fix/knowledge-layer-seam-fixes`), 9 commits behind `origin/main`. Verified the 9 behind commits touch **none** of `pi-agent-ext-tool-gate`, `pi-agent-ext-core-interface`, or `pi-agent` — the tool-gate code reviewed is current.
**Method**: wayfind two-axis review (Standards × Spec, STRONG/MODERATE/WEAK/LOW) over the tool-gate core, the `gating` contract (`pi-agent-ext-core-interface`), the `pi-agent` host patch, and the cross-extension owner declarations; live QA numbers captured via `bun run qa` + `bun test`.

## 1. Current-state baseline (measured)

```
bun run qa            ✅ PASS (default)
  savings:    11,717 tok/req (51.9%) — OFF 22,588 → ON 10,871   [floor ✅ · vs ~9,800 prose: +1,917]  · net 11,474 (50.8%)
  L1:         must-fire 46/46 · must-not-fire 30/30 · escape-name 11/11 · escape-intent 11/11
  coverage:   3 ungated heavy · 27 gated-heavy   [❌ non-gating by default]
  capability: 0 task-breaking gates · 7 benign false-fires
  gate-recall: 20/20 gates pass · 0 uncovered

bun test               304 pass · 0 fail (13 files)
```

The extension is **healthy and safe**: zero task-breaking gates, zero gate-recall failures, 51.9% savings. The review below therefore targets *structure and remaining opportunity*, not a correctness emergency.

> **Post-sync correction (origin/main `c18f0363`, 20 commits ahead of the review base).** `#1464` re-architected **power-tool**: new `src/gating.ts` (`DIAGNOSTIC_GATING` — one shared predicate now referenced by all six `inspect_*` tools instead of six copy-pasted literals), new `src/cost.ts` / `src/report.ts` / `src/runner-hooks.ts`, and the registration entry moved to `extensions/power-tool.ts`. The `schema-cost` export (`estimateToolCost`) that tool-gate imports is intact. **tool-gate.ts, core-interface, and the `gating` contract are unchanged** on origin/main. This updates F9's specifics (the copy-paste drift is now consolidated upstream; the six diagnostics are *still* keyword-gated, so F9's core point stands — and is now a one-predicate flip) and narrows ticket 06. It does **not** change F1–F8, F10, or tickets 01/02/04/05.

## 2. Findings

| # | Sev | Axis | Finding | Where | Disposition |
|---|-----|------|---------|-------|-------------|
| F1 | STRONG | Spec | **Documentation drift.** `README.md`, `PRD.md`, `CONTEXT.md` all describe the **pre-2026-08-10 model** — a hardcoded `GATES` array, a `CORE_TOOLS` set, a 12-gate table, and a `TRACKED_TOOLS` term. The code migrated to **owner-declared `gating`** on each tool's `ToolDefinition` (tickets 02–15); the hardcoded arrays are deleted. A reader following the docs would rebuild a model that no longer exists. | README:78-216, PRD:51-83, CONTEXT:11-21 | **ticket 04** |
| F2 | STRONG | Spec | **Stale savings prose everywhere.** Source header (`tool-gate.ts:21-22`) and README claim "~18,000 → ~10,000 / ~9,800 saved"; reality is **OFF 22,588 → ON 10,871 / 11,717 saved (51.9%)**, ~68→71 tools. The prose is now *understated*, but locked to reality only by the ±20% deviation band in `qa/savings.ts` — the narrative figures drift independently. | tool-gate.ts:21-22, README:3,12-14,16-19, CONTEXT:7 | **ticket 04** |
| F3 | STRONG | Standards | **Ambient-global `Gating` + fingerprint-equality sibling reconstruction.** A "gate" (co-firing group) has no first-class representation: `buildEffectiveGates` splits each owner-declared tool into a *single-name gate*, then `gateGatingKey`/`gatesWithSameGating` re-collapses siblings by *structural fingerprint equality* (sorted keywords/requires JSON). Two tools must carry **byte-identical** `gating` or co-activation silently breaks — the Spec B hazard ("movie/movie_help duplicated verbatim; editing one side silently breaks sibling co-activation") is still open. `Gating` is an `declare global` type, invisible to imports. | core-interface/tool-gating.d.ts:48-58, tool-gate.ts:95-131, 330-353 | **ticket 01** |
| F4 | STRONG | Spec | **Always-active core bloat (biggest untapped savings).** The always-on set is ~31 tools / **10,871 tok/req** — over half the *entire* gated ON budget. Eight tools carry >5k tok with no apparent cost audit: `zk_ingest` 934, `zk_ask` 765, `todo` 737, `ask_user_question` 700, `wayfind_effort` 617, `web_search` 593, `skill_manage` 578, `fetch_content` 570. Spec C (always-active re-triage) was identified 2026-08-10 and never done. | core-interface Spec C (contract-collapse design §Follow-up), CONTEXT "core:true" owners | **ticket 02** |
| F5 | MODERATE | Spec | **3 ungated heavy tools.** `webui_present` 389, `planning_stale` 369, `knowledge_search` 309 are heavy (≥300 tok) and untracked — coverage ❌ (non-gating by default). Pure savings, no mechanism change. | `qa:coverage` report | **ticket 03** |
| F6 | MODERATE | Standards | **Per-turn rebuild waste.** `before_agent_start` re-runs `getAllToolDefinitions()` + `buildEffectiveGates()` + `measureToolTokens()` for every tool on **every turn**; only `session_start` needs the full rebuild, the per-turn path only needs `updateSticky` + `filterActive` + `setActiveTools`. A token-optimization extension is itself doing redundant per-turn work. | tool-gate.ts:486-505 | **ticket 05** |
| F7 | MODERATE | Standards | **Subagent-child seam hack.** In-process children (WorkflowAgent.run) skip `session_start`, so `sticky` starts empty; the code re-seeds via a `sticky.size === 0` sentinel. Fragile: a legitimate 0-core session would re-seed wrongly; the sentinel encodes a framework gap as a magic value. | tool-gate.ts:491-502 | **ticket 05** |
| F8 | MODERATE | Standards | **`enable_tool` hardcodes a gated-domain prose list** in its `description` + `promptGuidelines` ("flux2 image, ltx video, movie orchestrator, krea2, …"). This is exactly the centralized duplication the migration removed — now surviving as a prose string that drifts from owner-declared gates. Could be derived from the effective gate set at runtime. | tool-gate.ts:540-545 | **ticket 01** (contract-derived) |
| F9 | MODERATE | Spec | **`inspect_*` tools are themselves keyword-gated.** The diagnostic surface (`inspect_context`, `inspect_agent`, `inspect_extensions`, `inspect_pathology`, `inspect_tui`) is dormant until the prompt says "schema cost / pathology / extension health" — the exact tools you need *when something is already wrong*. Gating diagnostics is a footgun; they should be always-on (or self-describing) and should expose live tool-gate state. | power-tool inspect-context.ts:37-43 | **ticket 06** |
| F10 | MODERATE | Spec | **No live view of tool-gate state.** The agent can only `enable_tool({list})` (dormant gates). It cannot see *which gates fired, which are dormant, per-gate token cost, or why a tool is missing*. `inspect_context` measures the tools schema generically but has no tool-gate semantics. | tool-gate.ts:551-567, power-tool inspect-context.ts | **ticket 06** |
| F11 | WEAK | Standards | **QA harness is tool-gate-specific.** 5 axes (savings/coverage/corpus/gate-recall/l2) are excellent but bespoke; gate-recall probe sets live scattered in the *owning* extensions (flux2.ts:459, ltx.ts:406, research-tool.ts:589). Generalizing into a reusable gated-extension harness is fog, not a ticket yet. | qa/* | Not-yet-specified |
| F12 | — | — | **Mechanism re-opened by user.** Keyword + noun∧verb co-occurrence is *currently passing everything* (46/46 must-fire, 20/20 gate-recall, 0 task-breaking). Prior efforts repeatedly ruled semantic/embedding redesign out of scope (2026-07-30 map; ADR-tool-gate-0003). The user's "complete redesign (allow broken if it worth)" reopens it — must be settled on *evidence*, not momentum. | — | **ticket 00** |

## 3. What is healthy — do not regress

- **Owner-declared `gating` migration direction is right** (centralized array → per-tool declaration). The *contract* is the problem, not the direction.
- **The QA harness is genuinely excellent** — encoded verdicts (savings floor ≥15%+2k, L1 corpus, gate-recall, reachability, coverage), hermetic, drift-detectable. Keep it as the redesign's safety net.
- **The mutate/pure split** (`updateSticky` mutates vs `filterActive` pure) is sound and load-bearing (the F1 fix: `enable_tool` must not re-evaluate gates against a stale prompt).
- **Fail-open** (`filterActive` keeps untracked tools active) is the correct safety posture; the coverage axis is its structural backstop.
- **Sticky semantics** (fire-once, stay-for-session) is correct and user-trusted.

## 4. The redesign core — where the leverage is

The 2026-08-02/08-10 migration moved **where** gating is declared (centralized `GATES` → per-tool `gating` field) but left the **contract that binds it** untouched: the runtime still reconstructs a gate table from defs, re-collapses siblings by fingerprint, matches by keyword, and injects built-in core by mutation. The "core" of tool-gate is therefore three things, in descending leverage:

1. **The contract (ticket 01).** Kill the ambient-global `Gating` and the fingerprint-equality sibling reconstruction; give a "gate" a first-class, exported, auditable representation (`Gate` / tool-family declared once, tools reference it by id). This removes F3, F8, and the Spec B hazard at the root.
2. **The always-active core (ticket 02).** The savings story has inverted: gating heavy domain tools is *done* (27 gated-heavy, 0 task-breaking); the remaining cost is the ~31-tool / 10,871-tok always-on core. Re-triage it. This is the single largest remaining win.
3. **The matching mechanism (ticket 00).** Re-open keyword matching on evidence; replace only if a measured alternative beats the 46/46 + 20/20 + 51.9% baseline *and* does not grow the 243-tok `enable_tool` overhead.

Cross-extension: **power-tool** (`inspect_context` already measures the tools schema; `schema-cost/estimate.ts` is the canonical estimator) is the natural home for live tool-gate introspection (ticket 06), and its `inspect_*` tools should stop being keyword-gated.

## 5. Prior-effort history — why the docs re-broke

The docs were fixed once (`.planning/done/2026-07-30-let-s-use-wayfind-superpower-ext-angle-to-review/tickets/05-context-md-and-readme-claim-correction.md`), then re-broke when the 2026-08-02/08-10 owner-declaration migration changed the model **without a docs-update ticket** in its rollout (the migration map's "resume 04… mechanical" note had no docs step). Ticket 04 must encode the root cause: any future contract/model change must carry a docs ticket in the same rollout, or the drift recurs (failure-memory pattern — a fix that didn't stick because the migration that reverted it shipped with no guard).

## 6. Cross-references

- `.planning/specs/2026-08-10-tool-gating-contract-collapse-design.md` — Spec A (landed) + **Spec B** (movie-director gating hygiene, open) + **Spec C** (always-active core re-triage, open). This review carries Spec B into ticket 01 and Spec C into ticket 02.
- `.planning/done/2026-07-30-let-s-use-wayfind-superpower-ext-angle-to-review/map.md` — prior tool-gate review; ruled mechanism redesign out of scope (now re-opened by user).
- `.planning/done/2026-07-24-continue-brainstorm-what-to-improve-tool-gate-ex/map.md` — the QA-harness brainstorm (savings/miss-rate/coverage axes originated here).
- `ADR-tool-gate-0001..0005` — the five in-scope decisions (escape-hatch, keyword precision, requires co-occurrence, opt-in telemetry, phantom cost-gate removal).
