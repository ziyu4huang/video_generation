## Destination
Delete the hardcoded `CORE_TOOLS` set entirely: every always-on tool owner-declares `gating:{ core: true }` on its registering package — including the 4 pi-coding-agent built-ins (`read`/`write`/`edit`/`bash`) via upstreaming — then remove `CORE_TOOLS` and the `fallbackCore` mechanism from `buildEffectiveGates`, exactly as ticket 15 deleted `GATES`. Owner-declared end-to-end for core/always-on tools; full parity with the GATES migration. (Safe behaviorally — `buildEffectiveGates` already honors `gating.core === true` as authoritative; `CORE_TOOLS` is only the fallback for undeclared names.)

## Notes
- **Domain**: `bun-apps/pi-agent-ext-tool-gate/` (the gating system); the 4 in-repo packages registering the 14 unmigrated core tools (pi-agent-ext-hermes-memory, -knowledge-card, -web-access, -obsidian); and `@earendil-works/pi-coding-agent` (the 4 built-ins, upstream). `pi-agent-ext-core-task` (todo/goal_complete/ask_user_question) + tool-gate's `enable_tool` are ALREADY owner-declared — no rollout needed.
- **Skills every session should consult**: the wayfinder work-through-the-map procedure (`bun-apps/pi-agent-ext-wayfind/procedures/wayfinder.md`); the just-completed GATES migration map + recall (`.planning/2026-08-02-migration-complete-end-to-end-recall-you-kicked-o/`) — same pattern, same footguns.
- **Standing preferences**: independent verify-then-commit per ticket (recall.md lesson 1 — implementers misreport; verify against git before every commit); explicit-path staging only (never `git add -A`/`.`/`-u`); the streamlined 2-dispatch cadence (implementer leaves dirty → separate verify-and-commit).
- **Fact freshness**: chart/pickup only on a synced branch (`git rev-list --count HEAD..origin/main` ≤ 1); rebase deferred to the finish-line ticket if drift accumulates. Worktree-rebase footgun (recall lesson 2): ignore rebase-replay commit-scope false-positives.
- **Key fact**: the owner-declared-core path is ALREADY implemented (`buildEffectiveGates`, tool-gate.ts ~L100-128). This migration relocates declarations from the central `CORE_TOOLS` set to each tool's `gating:{core:true}`; it does NOT change always-on behavior.

## Decisions so far
- **Destination = full deletion** (chosen at chart-time): pursue owner-declared end-to-end incl. the 4 built-ins via upstreaming pi-coding-agent; residual built-in set only if ticket 01's research proves built-ins can't be migrated. (Map framing decision, not a ticket.)

## Not yet specified
- The built-in MECHANISM: can this repo augment pi-coding-agent's `read`/`write`/`edit`/`bash` with `gating` (sibling-repo edit? in-repo global augmentation? a cross-repo PR?), or must it stay upstream? Graduates from ticket 01.
- Whether the built-in rollout (ticket 03) is in-repo, a cross-repo PR, or blocked on pi-coding-agent ownership — reshapes after 01.
- Whether `buildEffectiveGates`'s `fallbackCore` default becomes `new Set()` (empty) or is removed entirely at the finish — mechanical, lands in ticket 04.

## Out of scope
- The 5 genuinely-ungated heavy tools (`subagents`, `sweep_branches`, `await_pr_merge`, `memory_supersede`, `wayfind_effort`) — a separate gate-vs-always-on decision effort; `qa --strict` stays red until then.
- CORE_TOOLS classification re-audit (should each tool STAY always-on vs become gated?) — this migration relocates declarations; it assumes current always-on tools stay always-on. Reclassification is a separate effort.
- Broader upstreaming of `gating` into pi-coding-agent beyond the 4 built-ins (FOLLOWUPS #5).
