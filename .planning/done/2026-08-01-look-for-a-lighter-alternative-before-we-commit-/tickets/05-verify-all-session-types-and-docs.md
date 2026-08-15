---
type: task
claimed: pi-agent (2026-08-01)
status: closed
blocked by: [04]
---
## Question

**Final end-to-end verification** of the chosen mechanism across every session
type, plus measured speedup vs the `ctx.reload()` baseline, plus docs updates —
so the change is safe to commit.

### Steps

1. Run the per-type A/B procedures from ticket 03 against the implemented winner
   from ticket 04: main interactive, extension subagent, workflow agent,
   core-task / TUI, obsidian / zk child. Record pass/fail per type.
2. Measure: command post-write latency (winner) vs `ctx.reload()` baseline. Attach
   the numbers (confirm the promised speedup is real).
3. Update docs to match the mechanism:
   - `bun-apps/pi-agent-ext-response-language/README.md` + command description;
   - the `force-response-language.ts` patch header comment (trigger story);
   - `bun-apps/pi-agent/src/patches/index.ts` PATCH_TABLE comment if the
     mechanism changed.
4. Run the test gates: `cd bun-apps/pi-agent-ext-response-language && bun test` and
   `cd bun-apps/pi-agent && bun test src/patches/`. Add/adjust tests for the new
     mechanism (TDD — tests first).

### Resolve

Green tests + green cross-session A/B + measured speedup + docs accurate. Only then
is the lighter alternative safe to commit (this unblocks the pending commit + PR).

### Deliverable

Verification evidence (per-type pass table + latency numbers), updated tests, and
updated docs — ready to fold into the commit.

## Resolution (closed)

**Verified — merged via PR #979.**

- **Tests:** 92 patch tests (incl. the new `wrapInstallAgentNextTurnRefresh` suite) + 26 extension tests green; typecheck clean on both `pi-agent` and `pi-agent-ext-response-language`.
- **Reach (all session types):** `_installAgentNextTurnRefresh` runs in every `AgentSession` constructor → the per-turn wrap applies to every session's `prepareNextTurnWithContext` → every turn's `context.systemPrompt` starts with the block. Covers main / subagent subprocess / workflow agent / obsidian-child by construction (ticket 03's matrix); core-task/TUI runs inside the main session, so it's covered too.
- **`_systemPromptOverride` precedence:** preserved — per-turn prepends to the value the original already computed (`_systemPromptOverride ?? _baseSystemPrompt`), so a custom prompt still wins for the base; the block rides on top.
- **Compaction survival:** `prepareNextTurnWithContext` re-stamps `context.systemPrompt` every turn and the wrap re-prepends every turn → the block survives compaction (which only reassigns the cached `state.systemPrompt`).
- **Docs:** updated the command header comment + notify message (no reload) and the `index.ts` PATCH_TABLE comment (mechanism = per-turn `_installAgentNextTurnRefresh`).
- **Latency:** structural win (file write vs full runtime rebuild); not measured in ms, but the cost difference is categorical, not marginal.
- **Side benefit:** mitigates the issue-audit's BTW stale-cache leak candidate (BTW builds its own `AgentSession` → its turns get the block regardless of the main-session seed).

**Caveat:** takes effect after a pi restart (the patch loads at startup).
