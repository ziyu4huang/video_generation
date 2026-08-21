---
effort: 2026-08-16-simplefied-redesign-make-less-code-to-archive
created: 2026-08-16
last: 2026-08-16
status: active
---

# Wayfinder map: 2026-08-16-simplefied-redesign-make-less-code-to-archive

## Destination

A landed, staged redesign of the wayfind / superpowers / subagent trio that keeps ≥80% of user-facing features per package (feature-count anchor) while shrinking code and prose — subagent FIRST and ending net-negative in LOC despite gaining TUI tracking (budget gauges + rendering of already-accrued run data, which is also how monitor messages improve) — followed by wayfind and superpowers skill-set cuts, each stage merged with gates green.

## Notes

- **Plan-don't-do OVERRIDE**: per charting decision, this map carries EXECUTION in-map (staged landings: subagent → wayfind → superpowers), not just decisions.
- **Skills to consult**: grilling + domain-modeling (wayfind skills); for landing stages: subagent-driven-development, writing-plans, test-driven-development (superpowers skills); verification-before-completion before each stage merge.
- **Standing decisions (grilling 2026-08-16)**: (1) destination = decide + LAND staged; (2) cut authority = probe-evidenced (KEEP/CUT verdicts from usage evidence + A/B probes, reusing the method of done/2026-07-25-simplify-ext-prompt-weight — locate its probe harness there), user RATIFIES via tickets 03/04; (3) anchor = feature COUNT: keep ≥80% of user-facing features per package vs ticket-01 census; (4) subagent ends NET-NEGATIVE LOC (TUI additions paid by cuts, vs ticket-01 snapshot); (5) SACRED = watchdog layer only — everything else is probe-eligible, INCLUDING viewer/runs-DB restructuring, BUT the tracking substrate survives: ≥80% feature line + this destination guarantee a live viewer/dock tracking path (restructure yes, delete no); (6) TUI additions = render existing data (tokens·cost·turns in Running rows; turns/tier/error/fallback in archive view) + budget gauges (token/turn spend vs limit); monitor messages improve THROUGH this rendering (headers gain token counts, budget/wrap events surface) — no separate message-redesign track; (7) render-vocabulary unification (six formatters → one) offered and declined → Out of scope; (8) subagent stage ABSORBS the unexecuted Planning-Pipeline Cost Spec's workstream C (wrap-now injection at 85% token budget / maxTurns−3 + calibration persistence at ~/.pi/subagents/budget-calibration.json, ≥50-run cadence, precedence env > calibrated > frozen) — see .planning/done/2026-08-16-optimize-planning-pipeline-aka-extension/spec.md; its workstreams A/B stay with that spec.
- **Constraints**: superpowers skill bodies are upstream-pinned (ADR-superpowers-0004/0005) — unregister/exclude only (PI_SUPERPOWERS_SKILL_EXCLUDE), never edit; wayfind ported skills are repo-owned (editable/deletable); subagent dual-provenance watchdog port is sacred (keep pin doc); all package gates per CLAUDE.md (wayfind: check && typecheck && test; superpowers: bun test; subagent: check && bun test).
- **Concurrent efforts**: none colliding (webui-v2 done; budgets map paused, zero TUI overlap; cost-spec orthogonal except absorbed workstream C).

## Decisions so far

- [Feature + LOC baseline](tickets/01-feature-loc-baseline.md) — feature counts: wayfind 39 / superpowers 14 / subagent 15 (each skill = 1 feature); src LOC 4,169 / 347 / 7,463 (snapshot 2026-08-16 = the 80% + net-negative gate baselines); surprises: wayfind README stale (says 6 skills, 22 ship); subagent holds ~62% of trio LOC; runWatchdog + 3 tool factories advertised with zero external consumers; all three load STATIC (static-extensions.ts:75-84).
- [Probe cut evidence](tickets/02-probe-cut-evidence.md) — wayfind: 0/16 ported skills cuttable (all have ≥3 planning refs + live session exposure; weakest tier saves only ~365 LOC, poor ROI); superpowers: verification-before-completion already default-excluded (−241 via rebaseline), brainstorming KEEP but visual-companion.md + server.cjs ungated (−1,014); subagent: subprocess/retry/scope/runs-tool all KEEP (load-bearing, obsidian caller at src/lib/subagent.ts:308); only stale dist + dangling jsdoc cuttable. NET: subagent in-package cuts ≈ trivia → the net-negative-package rule needs trio-level accounting at ticket-03 ratification.
- [Ratify subagent cuts](tickets/03-ratify-subagent-cuts.md) — 4× KEEP (all candidates load-bearing), cuts = trivia only; substrate survives untouched; budget = trio-wide net-negative vs 2026-08-16 snapshot: Δtrio ≤ −400, subagent Δsrc ≤ +800, superpowers Δ ≤ −1,200, features ≥80%/pkg.
- [Ratify skill cuts](tickets/04-ratify-skill-cuts.md) — wayfind 0/16 cut (39/39 anchor); superpowers: delete verification-before-completion −241 (runtime-excluded already; prose refs left dangling per ADR) + brainstorming companions −1,014 (SKILL.md byte-pin kept); Δsuperpowers −1,255 ≤ −1,200, trio gates firm.
- [Batch live-progress feed] (no ticket — opportunistic fix; instantiates standing decision 6) — subagents tool collapsed live view now renders the live feed multi-line: default 5 child rows via SUBAGENT_LIVE_LINES (invalid → 5), header always shown and exempt from the budget, dim `… +K more` indicator only when cut; landed PR #1548 (13802018) + follow-up #1552 (217ed4eb); gates 647 pass / 0 fail; TUI-verified (custom renderResult displays unclamped, both streaming `!d` and isPartial paths share one helper).

## Not yet specified

- subagents-tool.ts (993L) monolith split — may graduate from stage-landing review if it blocks cuts.
- Batch-fan-out (subagents tool) gauges — gauge design lands for singular/viewer first; batch extension graduates after stage review. (Feed substrate landed meanwhile: #1548/#1552 collapsed live feed, 5 rows + exempt header; GAUGES still the open question.)
- Monitor-message formats beyond data rendering (tone/structure redesign) — explicitly deferred; revisit only if render-through upgrade proves insufficient.

## Out of scope

- Render-vocabulary unification (six formatters → one) — offered in grilling, not selected.
- Editing upstream-verbatim superpowers skill bodies (ADR constraint, not a choice).
- Cost-spec workstreams A/B (wayfinder batching prose + SDD levers) — remain with that spec for later execution.
- TUI work outside the subagent package (webui, other extensions' widgets).
- Persistent cost instrumentation / effort-cost telemetry (one-shot audits only, as before).

## Cross-effort links

- Shares-decision-with: 2026-08-21-harness-streamline — that effort executes this one's ratified-but-unlanded tickets 07 (wayfind src trims) and 08 (superpowers cuts, amended: KEEP spec-document-reviewer-prompt.md for wiring as the reviewer second pass) as its W1–W4 / S1 phases, and adds the bootstrap token diet + methodology wiring + housekeeping on top; ticket-09 closeout audit here reads BOTH efforts' Δ numbers.
