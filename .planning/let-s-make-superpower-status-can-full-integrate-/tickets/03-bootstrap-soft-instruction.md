---
type: prototype
status: closed
superseded-by: 2026-07-19-a (ticket 06)
blocked by: 01
---

# 03 — Bootstrap soft-instruction

## Question

[01 — Plan convention](01-plan-convention.md) settled that the agent already writes plans to `docs/superpowers/plans/` **by default** (`writing-plans` `SKILL.md` line 18) — so in the common case the coordination layer has a plan to read with **zero** instruction. This ticket decides whether any soft-instruction is needed at all:

- If the default suffices → close as **no-op / out of scope** (just confirm the layer reads the default location).
- If the `writing-plans` escape hatch — *"User preferences for plan location override this default"* — must be neutralized so the layer always finds plans → the **minimal** nudge: extend `piToolMapping()` in `src/superpowers.ts` with one line noting the coordination layer syncs from `docs/superpowers/plans/`, so the agent keeps plans there.

Produce the line (or the no-op decision) and wire it. This is the small "soft companion" the convention path accepts — now likely tiny.

### Context

- `getBootstrapContent()` in `superpowers.ts` assembles the injected payload; `piToolMapping()` is the existing Pi-specific glue appended to it — the natural, lowest-risk place for the nudge.
- The bootstrap is re-armed on `session_start` / `session_compact` and disarmed on `agent_end`.

## Resolution

**Closed as superseded (moot).** The unified design in
[`2026-07-19-a`](../../2026-07-19-a/map.md) settled (decision 02) that the
coordination layer lives **inside `pi-agent-ext-goal-todo`** and reads plans
directly — **no superpowers skill editing and no bootstrap soft-instruction at
all**. The invariant "skills byte-identical to upstream" (2026-07-19-a/01)
removes the only place this nudge would have lived (`piToolMapping()`). The
question this ticket posed is now answered by construction: **the layer needs
zero instruction.** Folded into the unified effort; see
[2026-07-19-a/06](../../2026-07-19-a/tickets/06-close-and-supersede-prior-efforts.md).
