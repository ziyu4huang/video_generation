---
effort: 2026-08-16-optimize-planning-pipeline-aka-extension
created: 2026-08-16
last: 2026-08-16
status: active
---

# Wayfinder map: 2026-08-16-optimize-planning-pipeline-aka-extension

## Destination

A spec at `.planning/2026-08-16-optimize-planning-pipeline-aka-extension/spec.md` for a cheaper end-to-end planning pipeline — measurably fewer tokens and fewer agent sessions per idea→landed-code effort across the wayfind / superpowers / subagent trio, at equal output quality — ready to hand to writing-plans/SDD for execution.

## Notes

- **Skills to consult**: `grilling` + `domain-modeling` (in `bun-apps/pi-agent-ext-wayfind/skills/`); when a ticket touches EXECUTE-side flow, read `subagent-driven-development`, `writing-plans`, `executing-plans` in `bun-apps/pi-agent-ext-superpowers/skills/`.
- **Docs to consult**: `bun-apps/pi-agent-ext-{wayfind,superpowers,subagent}/CONTEXT.md` + each package's `docs/adr/`; `.planning/CONVENTIONS.md` (cross-effort link rules); `.planning/recon/2026-08-16-planning-pipeline-recon-report.md` (factual snapshot of the trio); `.planning/REVIEW-2026-08-15-ext-four-packages.md` (code-debt findings — mostly out of scope here).
- **Standing decisions (charting grilling, 2026-08-16)**: objective = cost per effort (tokens + sessions) at equal output quality; span = end-to-end (DECIDE→SYNTHESIZE→PLAN→EXECUTE→close); baseline = one-shot audit, no persistent instrumentation; priority levers = session count + SDD task overhead; the one-ticket-per-session rule MAY be amended (single text site `procedures/wayfinder.md:131`; no pin manifest/ADR marks it upstream-verbatim — confirm during the batching-policy ticket); `2026-08-15-subagent-dynamic-budgets` is absorbed via `Shares-decision-with` cross-links.
- **Constraint**: ADR-superpowers-0004/0005 — never patch upstream-verbatim skill bodies; divergence lands in the injection/bootstrap layer. Any skill-body or procedure edit must first clear provenance.

## Decisions so far

- [Baseline cost audit](tickets/01-baseline-cost-audit.md) — 200-run window (2026-08-16, ~3.7h): truncated dispatches (budget/turns aborts) consumed 76% of measured token spend while producing 39% of output; planning-stage overhead is dwarfed by dispatch waste; $ unrecoverable (all runs $0.00); main-session tokens invisible to the runs DB.
- [SDD overhead anatomy](tickets/02-sdd-overhead-anatomy.md) — across 12 SDD workspaces: 31/40 reviewed tasks clean first review; top levers = drop per-task review for mechanical tasks (~2.4M at btw scale), plan-slice briefs (30× smaller), one-fix-wave extended to task rounds, pre-SDD plan review to kill the parked-minor tax; one per-finding wave cost 1.06M; one reset --hard pivot lost ~2.5M.

## Not yet specified

- Artifact dedup across the chain (spec / plan / wayfind tickets / SDD briefs single-sourcing) — graduates if the baseline audit shows re-derivation as a top cost line.
- Per-session fixed cost (bootstrap injection size, 22+14 skill-description surface) — revisit if the baseline shows fixed cost dominating.
- Grilling compression (AFK pre-recon to cut rounds) — shape unclear until the session-count audit lands.
- Forward seam / single-driver coordination between wayfind sessions and `/goal`/`/loop` — session-adjacent, no sharp question yet.
- Quality-guardrail metrics beyond "gates stay" (parked-findings rate, fix-loop depth as quality signals) — sharpens after the lever tickets land.
- Parallel execution of independent SDD tasks (worktrees) — inside SDD-redesign scope but may deserve its own ticket once the cost anatomy is known.

## Out of scope

- Route-clarity doc/code debt of the trio (REVIEW-2026-08-15 findings: phantom manifest entry, stale glossary, dual parser, missing superpowers CONTEXT.md, subagent TUI issues) — per-package hygiene, not cost.
- Stalled-effort hygiene automation / `.planning/` housekeeping (16 live efforts).
- Persistent cost-measurement infrastructure (this effort uses a one-shot audit only).
