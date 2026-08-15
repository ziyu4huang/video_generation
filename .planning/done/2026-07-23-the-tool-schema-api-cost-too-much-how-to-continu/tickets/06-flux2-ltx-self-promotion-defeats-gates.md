---
type: research
status: closed
claimed: pi-session-2026-07-23
---

## Question

**flux2 and ltx extensions self-promote to always-active** via their own `session_start` handler — does this run AFTER tool-gate's `session_start` and thereby **defeat tool-gate's flux2/ltx gates at runtime**? If so, the qa:savings (offline) numbers OVERSTATE the real per-request savings for these gates.

**Evidence (found while resolving ticket 05).** Both `pi-agent-ext-flux2/extensions/flux2.ts` and `pi-agent-ext-ltx/extensions/ltx.ts` register:

```ts
pi.on('session_start', () => {
  const current = pi.getActiveTools();
  if (!current.includes('flux2')) {
    pi.setActiveTools([...new Set([...current, 'flux2', 'flux2_help'])]);
  }
});
```

This UNCONDITIONALLY re-adds `flux2` + `flux2_help` (and `ltx` + `ltx_help`) to the active set on session start — the comment calls it "a deliberate deviation from Tool-Search / Lazy-Loading… default-load for generation tools that get called often." tool-gate's own `session_start` sets active = `filterActive(...)` (which GATES flux2/ltx out). **Whichever handler runs last wins.** `movie-director` does NOT self-promote (no such handler), so its gate is unaffected.

**Why it matters (three ways).**
1. If defeated: `flux2 (654) + flux2_help (144) + ltx (564) + ltx_help (147) = ~1,509 tok` are always-active at runtime regardless of tool-gate → the map's "48.1% saved" is partly illusory for these two gates.
2. Ticket 05's value (−533 tok) is **HIGH if defeated** (those _help tools are always-active, so the slim saves every turn) but **LOW if gates work** (the slim only pays transiently when a gate fires).
3. The fix — remove the flux2/ltx self-promotion and rely on tool-gate's gate (which already has solid keyword/co-occurrence triggers + the enable_tool escape hatch) — could **recover the gates' full runtime savings (~1,509 tok)**, bigger than any other open ticket.

**Method.** Boot a real session with `TOOL_GATE_LOG=1`, log `pi.getAllTools().map(t=>t.name)` AND the active set AFTER all `session_start` handlers fire (e.g. from a `before_agent_start` probe on turn 1). If `flux2`/`ltx` are active despite no keyword in the opening prompt → gates defeated. Cross-check the extension registration order in `bun-apps/pi-agent/run-dir/manifest.json` (handler order ≈ registration order) to predict the winner before measuring.

**Risk if we remove self-promotion.** The original intent was "generation tools called often should be default-load, not tool-search." But tool-gate's keyword gate fires on any image/video intent (`generate an image` → flux2), and `enable_tool` is the escape hatch — so the recall risk is low. Verify with the L1 must-fire corpus + an L2 reachability check before removing.

## Resolution (2026-07-23)

**Self-promotion is TRANSIENT — it does NOT defeat tool-gate at steady state. No action needed; qa:savings numbers are accurate at runtime.**

**Proven by simulation** (`extensions/self-promotion-interaction.test.ts`, 5/5 pass) — a multi-handler mock (handlers fired in registration order, exactly as pi-agent dispatches) loading the REAL tool-gate + faithful flux2/ltx `session_start` mimics (verbatim copies of the `flux2.ts:419` / `ltx.ts:370` pattern):

1. After `session_start`: flux2/ltx ARE active — the mimics run after tool-gate (manifest order: tool-gate line 4 → flux2 9 → ltx 11) and re-add what tool-gate gated out. So the race IS lost at session_start.
2. After `before_agent_start` (no keyword): flux2/ltx are **GATED OUT** — tool-gate's `before_agent_start` is the **only** one among the three (flux2/ltx have none — structural-guard test asserts this) and re-applies `filterActive` every turn, so on turn 1+ they're correctly dormant.
3. After `before_agent_start` (image keyword): flux2 active — the gate fires correctly when intended.

**The decisive fact:** steady state is governed by `before_agent_start` (per-turn), not `session_start` (once). Since only tool-gate owns a `before_agent_start`, it re-asserts the gate every turn regardless of any session_start self-promotion. The self-promotion is effective only in the session_start → turn-1 window (the banner flash) — cosmetically odd, functionally harmless.

**Consequences (corrections to earlier speculation):**
- The "~1,509 tok potential recovery" hypothesized in ticket 05's resolution **does NOT exist** — flux2/ltx ARE properly gated at runtime, so qa:savings's steady-state numbers hold.
- Ticket 05's value is therefore **transient-only** (the −533 pays when a gate *fires*, not every turn) — exactly as qa:savings already showed (ON-startup unchanged).
- The map's premise (3.8% at 200k after 04) is **confirmed accurate at runtime**.

**Optional cleanup (not a savings lever):** the flux2/ltx self-promotion is now effectively dead — it runs at session_start then gets overridden on turn 1. Removing it would clarify intent and skip trivial session_start work, but yields **zero token savings** (the tools are gated either way). Deferred unless the extensions are touched for another reason; recorded here so the dead-effective code isn't mistaken for load-bearing.
