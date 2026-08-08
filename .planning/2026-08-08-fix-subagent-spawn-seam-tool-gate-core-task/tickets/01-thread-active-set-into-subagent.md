# 01 — thread the parent's gated active set into spawned subagents (#1)

**Status:** CLOSED

## Change
In `pi-agent-ext-subagent`, when the `subagent` / `subagents` caller omits an explicit `tools` allowlist, default the child's tool set to the parent's CURRENT active set (`pi.getActiveTools()`) instead of the full `getAllToolDefinitions()` universe.

## Why
Today the child inherits all ~55 tool definitions (`subagent.ts:126` + `agent.ts:507`), re-paying the ~18,000 tok/req schema baseline the parent gated down to ~10,000. Threading the active set (~24) makes a focused subagent cost ~24, not ~55 — the dominant saving under fan-out.

## Mechanism (to confirm at implementation)
- The `subagent` tool's execute handler is a factory closure with `pi` in scope → can call `pi.getActiveTools()`.
- Pass the active set as the default `tools` allowlist into the spawn options, so `applyToolPolicy` (`agent-registry.ts:163`) narrows `customTools`.
- Caller's explicit `tools` param still overrides (agent can request tools outside the active set when the task needs them).

## Trade-off (accepted)
A child whose task needs a tool the parent has gated OUT won't have it registered. Mitigation: the calling agent can pass explicit `tools`; and the common case (focused subtask matching the parent's context) benefits hugely. enable_tool still works for tools that ARE registered.

## Verification
- `pi-agent-ext-subagent` `bun test` green; add a test asserting a no-`tools` spawn receives the parent's active set (not the full universe).
- Confirm an explicit-`tools` spawn still narrows to exactly the requested set.

## Resolution
Implemented in PR #1127 (squash commit aee00a44). Threaded a `getActiveTools` accessor (mirroring getExtensionTools/getMainModel) read lazily at spawn time; default applied at both `subagent` (singular) and `subagents` (plural) spawn seams with precedence explicit-tools > agentType-binding > parent-active-set. Explicit `tools` override preserved. 8 new tests; subagent suite 568 pass.
