> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Wayfinder map: 2026-07-23-the-tool-schema-api-cost-too-much-how-to-continu

## Destination

Reduce the felt per-request tool-schema cost (active ~8,788 tok = **4.4% of the 200k target context**) via the **next suppression layer beyond tool-gate's L1 sticky gating** — deciding, per candidate thread (help-split re-verify, L2 dynamic re-gating, L3 guideline slimming, new gates), whether to pursue it, **gated by measured ROI**. Stop at diminishing returns.

## Notes

**Premise (settled by grilling this session).** tool-gate already ships GREEN: baseline ~14.7k tok → gated active ~8.8k tok, **saving 5,875 tok/req (39.9%)** (verify-map tickets 00 + 05; PR #767 merged the task-breaking follow-up fixes). The residual 8.8k is **felt** because tool-gate targets **200k-class context**, not only the 1M dev session: 8.8k / 200k = 4.4%. At 1M dev it is trivial (0.88%); the 200k target justifies the next layer.

**Key correction — orthogonality (do NOT re-assert the subsumption fallacy).** tool-gate (temporal: defer a tool until a keyword fires) and the `_help` split (structural: when active, `main(small) + _help(small) < main(big-inline)`) are **orthogonal and composable**. Gating `[flux2, flux2_help]` together does NOT subsume the split — when the gate fires, `2× small` is still `< 1× big`. So Q2's default answer is "keep the split," but the delta must be **re-verified under current tool defs** (the 2026-07-08 "split is measured-optimal" insight predates today's tool set, and that memory itself insists "MEASURE first").

**Instruments on the shelf (use, don't rebuild).**
- `buildSchemaCostReport` / `estimateToolCost` in `bun-apps/pi-agent-cli/src/commands/schema-cost.ts` — offline, no agent boot, `(desc+params)/4` heuristic (real ratio ~3.7). The canonical per-tool cost instrument.
- `bun run qa:savings` (this package) — wraps it for the savings verdict.
- tool-gate telemetry: `TOOL_GATE_LOG=1` / `TOOL_GATE_LOG_PATH=<file>` → `turn` / `activate` / `miss_candidate` JSONL (opt-in). The L2-upside signal lives here.
- `inspect_context` — live per-component token breakdown (this session already measured guidelines ≈ 510 tok → the L3 lever is small).

**`_help` tools in scope.** `flux2_help`, `krea2_help`, `ltx_help`, `movie_help` (all gated WITH their main tool — the orthogonal case); `obsidian_help`, `obsidian_search_help` (obsidian is CORE, always active → split defers nothing here → these are the subsumption-hypothesis pressure points).

**Skills every session should consult.** `grilling`, `domain-modeling`. ("gate" is overloaded — tool-token gate vs the verify-map's verification gate.)

**Standing preferences.** Written artifacts in English; conversation in zh-TW. **Cost-bounded:** pursue a thread into a build only if its measurement shows real ROI; stop at diminishing returns. Planning lives under `.planning/<effort>/`.

## Decisions so far

<!-- one line per closed ticket -->

- [00 Help-split re-verify](tickets/00-help-split-reverify.md) — **keep the split.** Orthogonality CONFIRMED by measurement (gated pair: dormant=0 / fired=sum; merging neutral-to-worse). 07-08 "split is optimal" holds under current defs. Real lever = 3 large `_help` schemas (flux2 307 / ltx 316 / movie 284) → graduates ticket 05.
- [02 L3 guideline slimming](tickets/02-l3-guideline-slimming-upside.md) — **defer L3.** Guidelines block ≈ 510 tok (measured via inspect_context), ~0.25% of 200k. ROI ≈ 0; guidelines axis already near-floor.
- [03 Ungated heavy-tool scan](tickets/03-ungated-heavy-tool-scan.md) — **3 ungated heavy tools found: `cost` 536 + `arxiv_fetch2md` 311 + `arxiv_search` 257 = 1,104 tok (12.5% of active)**, always-on, untaxed. Highest-ROI lever in the map → graduates ticket 04.
- [04 Add gates for cost + arxiv](tickets/04-add-gates-for-cost-and-arxiv.md) — **DONE.** Added 2 gates (arxiv standalone incl. arxiv_paper; cost co-occurrence, no bare `cost`). ON baseline **8,834 → 7,637 tok/req (−1,197)**; saved **39.9% → 48.1%**; `--strict` GREEN (0 task-breaking, 8 benign false-fires). Beat the −1,104 prediction (arxiv_paper rode along).
- [05 Slim large _help schemas](tickets/05-slim-large-help-schemas.md) — **DONE.** Removed the COMMAND_ENUM duplication from flux2_help/ltx_help/movie_help (the main tool already carries the enum → pure dedup). **−533 tok** (flux2 307→144, ltx 316→147, movie 284→83). No behavior change; split invariant strengthened. **Caveat:** qa:savings ON-startup unchanged (these _help are gated-dormant at start); the −533 pays when gates fire (transient — confirmed by 06, not per-turn).
- [06 flux2/ltx self-promotion vs tool-gate](tickets/06-flux2-ltx-self-promotion-defeats-gates.md) — **RESOLVED: no action.** Self-promotion is TRANSIENT — it wins at session_start (manifest order) but tool-gate's per-turn `before_agent_start` (the only one among the three) re-asserts gating every turn, so flux2/ltx ARE correctly gated at steady state. Proven by simulation (`extensions/self-promotion-interaction.test.ts`, 5/5). **Correction:** the ~1,509 tok "potential recovery" speculated in 05 does NOT exist; qa:savings numbers are accurate at runtime. The map's 3.8% premise holds.
- [01 L2 dynamic re-gating upside](tickets/01-l2-dynamic-regating-upside.md) — **DEFERRED (verdict: not worth building).** Ceiling concentrates on utility gates (inspect 947, research/arxiv/file2md ~661–723) and is conditional on long pivot sessions; generation gates rarely fire-then-unused + are workflow-critical. **Decisive:** prefix caching (proven ≈0 to toggle tools[]) means an idle-but-active tool already costs ~cache-read/turn, so L2 re-gating saves only ~10–25%, not full cost — and pays a transition cache-miss. Effort/risk HIGH (load-bearing safety policy, UX regression, telemetry prereq). Diminishing returns vs the 3.8% baseline. Enabler for future revisit: a ~15-line `tool_call` telemetry listener.

## Not yet specified

<!-- in-scope fog that can't be ticketed yet; graduates as the frontier advances -->

- *(all fog cleared — 01's defer verdict resolves both the L2 safety-policy fog and the stopping-bar fog. The map is complete; see closing note below.)*

## Closing note (map complete)

All 7 tickets closed; the frontier is empty and the destination is reached. The suppression story, end to end:
- **Starting point (premise, grilling-settled):** tool-gate shipped GREEN at 39.9% (5,875 tok); residual ~8.8k felt at the **200k** target (4.4%).
- **04 (built):** +2 gates (arxiv, cost) → ON-startup **8,834 → 7,637 (−1,197)**; saved → **48.1%**.
- **05 (built):** dedup'd the COMMAND_ENUM in 3 `_help` tools → **−533 tok** (transient, when gates fire).
- **00/02/03 (research):** keep the split (orthogonality confirmed); defer L3 (guidelines ~510 tok, ROI≈0); found the 3 ungated heavy tools → 04.
- **06 (research):** self-promotion is transient; gates hold at steady state; qa:savings is runtime-accurate.
- **01 (research):** defer L2 — prefix caching already eats its per-turn value; effort/risk too high for a conditional, modest ceiling.
- **Final state:** ON-startup **7,637 tok ≈ 3.8% at 200k**, confirmed runtime-accurate. The clean suppression levers are exhausted; the remaining theoretical levers (L2/L3) don't clear the ROI bar.

Deferred prizes (revisit if the regime changes — e.g. a smaller-context target, or prefix caching stops being multi-entry): **L2 dynamic re-gating** (ticket 01; enable the `tool_call` telemetry first), **L3 guideline slimming** (ticket 02; only if the guidelines block bloats past ~2k tok).

## Out of scope

<!-- work consciously ruled beyond this destination -->

- **Re-verifying tool-gate itself.** The verify-map (`2026-07-23-try-to-add-gate-to-verify-tool-gate-extension-qa`) already settled savings + capability; PR #767 fixed the task-breaking gates. This map takes "tool-gate ships GREEN" as a settled premise, not a question.
- **Non-schema cost.** Skills (~2,768 tok), context files (~1,374 tok), and conversation live in the **system prompt**, not the tools[] schema this map targets. Separate axes.
- **Changing power-tool's schema-cost heuristic.** Its 4-vs-3.7 token-ratio inconsistency is a known cleanup, explicitly deferred (per the verify-map's out-of-scope).
- **Help-split for tools that are neither gated nor core.** None currently exist — every `_help` is either gated-with-main or obsidian-core. Reopen only if a new ungated `_help` lands.
