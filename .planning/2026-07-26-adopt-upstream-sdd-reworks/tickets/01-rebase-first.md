## Question

**RE-SCOPED (2026-07-26):** the rebase is **NOT a gate on the SDD re-pin.** Ancestry check (`git merge-base`): this branch diverged from `origin/main` (24 commits mine, 13 theirs) — but origin/main's 13 parallel commits (subagent TUI unification #821/#827/#813, obsidian #816, core-task/goal #814/#818, ltx-video #815) touch **ZERO SDD-rework files** (`subagent-driven-development/`, `superpowers.ts`, `bootstrap.test.ts` all untouched). The SDD work is fully isolated.

The real integration conflict is **`pi-agent-ext-subagent/`**: my Phase-1 schema-slimming (`c25b9243`, ~550 tok/req) overlaps origin/main's model-role unification (`b97e8975` #827) + `/subagents` TUI refactor (`4fe905e1` #821, `2c04d284` #813). That belongs to the **simplify-ext-prompt-weight** workstream's merge — NOT this SDD map.

**type:** task (AFK) — now **OUT OF SCOPE** for this map (see map Out-of-scope)
**claimed:** _(deferred to the prompt-weight workstream's integration)_
**blocked by:** —
**blocks:** nothing in this map (05 unblocked 2026-07-26)

## Resolution

_(deferred — not this map's concern. The SDD re-pin (05) proceeds without it. See map Out-of-scope for the subagent-ext integration pointer.)_
