## Destination
Delete the hardcoded `CORE_TOOLS` set entirely: the 14 in-repo always-on tools owner-declare `gating:{ core: true }`; the 4 pi-coding-agent built-ins (`read`/`write`/`edit`/`bash`) get `core:true` via IN-REPO runtime injection (tool-gate injects it through the existing `getAllToolDefinitions` hook — pi-coding-agent is immutable + `gating` is extension-only, per ticket 01). Then remove `CORE_TOOLS` + the `fallbackCore` mechanism from `buildEffectiveGates` (mirror ticket 15's GATES deletion). TRUE owner-declaration of the 4 built-ins (a cross-repo PR to pi-coding-agent) is deferred to FOLLOWUPS #5. End state: owner-declared for in-repo tools + injected-core for built-ins; the central hardcoded set is gone.

## Notes
- **Domain**: `bun-apps/pi-agent-ext-tool-gate/` (the gating system); the 4 in-repo packages registering the 14 unmigrated core tools (pi-agent-ext-hermes-memory, -knowledge-card, -web-access, -obsidian); and `@earendil-works/pi-coding-agent` (the 4 built-ins, upstream). `pi-agent-ext-core-task` (todo/goal_complete/ask_user_question) + tool-gate's `enable_tool` are ALREADY owner-declared — no rollout needed.
- **Skills every session should consult**: the wayfinder work-through-the-map procedure (`bun-apps/pi-agent-ext-wayfind/procedures/wayfinder.md`); the just-completed GATES migration map + recall (`.planning/2026-08-02-migration-complete-end-to-end-recall-you-kicked-o/`) — same pattern, same footguns.
- **Standing preferences**: independent verify-then-commit per ticket (recall.md lesson 1 — implementers misreport; verify against git before every commit); explicit-path staging only (never `git add -A`/`.`/`-u`); the streamlined 2-dispatch cadence (implementer leaves dirty → separate verify-and-commit).
- **Fact freshness**: chart/pickup only on a synced branch (`git rev-list --count HEAD..origin/main` ≤ 1); rebase deferred to the finish-line ticket if drift accumulates. Worktree-rebase footgun (recall lesson 2): ignore rebase-replay commit-scope false-positives.
- **Key fact**: the owner-declared-core path is ALREADY implemented (`buildEffectiveGates`, tool-gate.ts ~L100-128). This migration relocates declarations from the central `CORE_TOOLS` set to each tool's `gating:{core:true}`; it does NOT change always-on behavior.

## Decisions so far
- **Destination = full deletion** (chosen at chart-time): pursue owner-declared end-to-end incl. the 4 built-ins via upstreaming pi-coding-agent; residual built-in set only if ticket 01's research proves built-ins can't be migrated. (Map framing decision, not a ticket.)
- [01 research built-in feasibility](tickets/01-research-built-in-feasibility.md) — CLOSED: pi-coding-agent immutable, gating is extension-only; Path B chosen (in-repo injection for the 4 built-ins; true upstream deferred to FOLLOWUPS #5).
- [02 in-repo core-tools rollout](tickets/02-rollout-in-repo-core-tools.md) — CLOSED: 14 tools × 4 packages owner-declared gating:{core:true} (behavior-preserving); QA corpus + drift-guard wired; 4 already-declared + CORE_TOOLS untouched.
- [03 built-in injection](tickets/03-rollout-pi-coding-agent-builtins.md) — CLOSED: injected gating:{core:true} onto read/write/edit/bash via injectBuiltinCore in getDiscovered (Path B; relocated BUILTIN_CORE residual; true upstream → FOLLOWUPS #5); built-ins now in effectiveCore (authoritative, not fallback).
- [04 delete CORE_TOOLS](tickets/04-delete-core-tools.md) — CLOSED: CORE_TOOLS deleted + buildEffectiveGates simplified (1-arg, no fallback); qa corpus completed (CORPUS_EFF.core = 22); zero cross-package refs; BUILTIN_CORE residual survives
**🎉 CORE_TOOLS MIGRATION COMPLETE (tickets 01–04): always-on is owner-declared end-to-end (14 in-repo owner-declared + 4 built-ins injected-core + 4 already-declared); CORE_TOOLS + fallback gone.** Post-migration open items: 5 ungated heavy tools (decisions), true built-in upstreaming (FOLLOWUPS #5), final rebase.

## Not yet specified
- Whether `buildEffectiveGates`'s `fallbackCore` default becomes `new Set()` (empty) or is removed entirely at the finish — mechanical, lands in ticket 04.
- TRUE owner-declaration of the 4 built-ins (cross-repo PR to pi-coding-agent) — deferred to FOLLOWUPS #5; Path B injects them in-repo meanwhile.

## Out of scope
- The 5 genuinely-ungated heavy tools (`subagents`, `sweep_branches`, `await_pr_merge`, `memory_supersede`, `wayfind_effort`) — a separate gate-vs-always-on decision effort; `qa --strict` stays red until then.
- CORE_TOOLS classification re-audit (should each tool STAY always-on vs become gated?) — this migration relocates declarations; it assumes current always-on tools stay always-on. Reclassification is a separate effort.
- Broader upstreaming of `gating` into pi-coding-agent (FOLLOWUPS #5) — incl. TRUE owner-declaration of the 4 built-ins (cross-repo PR), deferred from ticket 03.
