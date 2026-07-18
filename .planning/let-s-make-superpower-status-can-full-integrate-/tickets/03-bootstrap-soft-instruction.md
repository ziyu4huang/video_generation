# 03 — Bootstrap soft-instruction

## Question

[01 — Plan convention](01-plan-convention.md) settled that the agent already writes plans to `docs/superpowers/plans/` **by default** (`writing-plans` `SKILL.md` line 18) — so in the common case the coordination layer has a plan to read with **zero** instruction. This ticket decides whether any soft-instruction is needed at all:

- If the default suffices → close as **no-op / out of scope** (just confirm the layer reads the default location).
- If the `writing-plans` escape hatch — *"User preferences for plan location override this default"* — must be neutralized so the layer always finds plans → the **minimal** nudge: extend `piToolMapping()` in `src/superpowers.ts` with one line noting the coordination layer syncs from `docs/superpowers/plans/`, so the agent keeps plans there.

Produce the line (or the no-op decision) and wire it. This is the small "soft companion" the convention path accepts — now likely tiny.

### Context

- `getBootstrapContent()` in `superpowers.ts` assembles the injected payload; `piToolMapping()` is the existing Pi-specific glue appended to it — the natural, lowest-risk place for the nudge.
- The bootstrap is re-armed on `session_start` / `session_compact` and disarmed on `agent_end`.

type: prototype
blocked by: 01 (Plan convention)
