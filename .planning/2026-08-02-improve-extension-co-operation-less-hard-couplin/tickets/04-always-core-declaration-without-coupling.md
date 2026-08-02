---
type: grilling
blocked by: [02]
status: closed
---
## Question

**How does a tool declare "I am always-core" (always-on, never gated) without coupling?** Today tool-gate's `CORE_TOOLS` Set hardcodes core-task's tools (`todo`, `goal_complete`, `ask_user_question`) and others by name — the always-on analog of the `GATES` mirroring problem. If core-task adds/renames a tool, `CORE_TOOLS` drifts (a tool silently becomes gated-off).

Depends on ticket 02's chosen mechanism:

- If 02 picks a discovery channel where a tool-owner declares gating metadata (e / c / a), does the SAME channel declare always-core membership — or is always-core a tool-gate-side default ("gate everything unless declared core")?
- The direction matters: "opt-in core" (owner declares) vs "opt-out core" (tool-gate default) flips who bears the drift risk.

Grill only after 02 lands the mechanism; the answer may fold into 02's contract rather than stand alone.

## Resolution (2026-08-02)

Resolved by ticket 02: the `gating.core?: boolean` field lets a tool-owner declare "always-on, never gated" on its own def — opt-in core, owner-owned, no separate mechanism. The direction is **opt-in core** (owner declares `core: true`), not tool-gate-default. Closed.
