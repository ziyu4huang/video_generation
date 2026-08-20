**ID:** `ADR-tool-gate-0001` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# ADR-0001: Escape hatch (`enable_tool`) for dormant gated tools

Date: 2026-07-20 (S1)
Status: accepted
See: [spec `2026-07-20-tool-gate-s1-escape-hatch-design.md`](../../../../.planning/specs/2026-07-20-tool-gate-s1-escape-hatch-design.md), [CONTEXT.md](../../CONTEXT.md)

## Context

Gating heavy tools saves ~47% of the per-request schema tokens, but it creates a recovery risk: if keyword matching misses a genuine need (the agent wants a tool whose gate didn't fire), the tool is dormant and there is no in-session way to reach it short of restarting — which loses all session context. A gate that can strand the agent undermines trust in the whole mechanism.

## Decision

Add an **always-active `enable_tool` tool** (a member of `CORE_TOOLS`, so it is never itself gated) that activates any dormant gate **same-turn**, by:

- `intent` — natural-language description → `matchIntent` finds the matching gate(s);
- `name` — exact tool/gate name → activates that gate;
- `list` — returns all currently-dormant gates.

Activation is **sticky**: once enabled, the tool stays available for the rest of the session (matches the fire-once-stays-active semantics of keyword gates). `enable_tool` computes the active list via `filterActive` directly — it does **not** re-evaluate gates against the turn prompt (the F1 fix: doing so would silently activate unrelated gates beyond the one requested).

## Consequences

- **Gating is fully recoverable.** A missed gate is one `enable_tool` call away, not a session restart. This is why the prior QA verdict was NET POSITIVE even with task-breaking blind gates: they're recoverable via `enable_tool({name})`.
- **Cost:** `enable_tool`'s own schema (~243 tok) is always-on overhead. The "net" savings figure subtracts it so the always-on price of the escape hatch is visible + drift-detectable.
- **Reliance on agent inference:** the agent must notice a missing tool and read `enable_tool`'s self-describing description to use it. Empirically zero friction (effort `2026-07-30` ticket 00: 0 escape-hatch activates for the workflow gate in 201 turns), but it is a latent reliance.

## Alternatives considered

- **No escape hatch.** *Rejected:* an unrecoverable miss strands the agent for the whole session — unacceptable for a mechanism layered on every session.
- **Re-evaluate gates every turn and auto-activate any plausibly-needed tool.** *Rejected:* re-introduces the over-activation gating exists to prevent, and is non-deterministic across turns.
- **Escape via a slash-command.** *Rejected:* not same-turn, not agent-callable — defeats the purpose.
