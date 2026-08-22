# Ticket 03 — built-in read-only agent types (explore / plan)

Status: open · Phase 2 (parallel with 02; only collision is
`subagent-tool-schema.ts` guideline text — sequence or rebase)

## Scope

Ship CC's Explore/Plan-style read-only agent types as built-in fallback
definitions so the model can dispatch `agentType: "explore" | "plan"` with zero
user setup. Per map D4: lowest-precedence tier (project > pack > user >
builtin); user files always win; built-ins ship as code, never written to
disk, never merged when shadowed.

## Approach

1. New `bun-apps/s2-agent-core-runtime/src/builtin-agents.ts` exporting
   `BUILTIN_AGENT_DEFS: AgentDefinition[]` with `source: "builtin"` (widen the
   source union in `agent-registry.ts`).
2. Resolution: after the existing project/pack/user scan misses, fall through
   to built-ins inside `loadAgentRegistry` / `resolveAgentType`
   (`agent-registry.ts:153`).
3. Read-only-ness: `disallowedTools: ["edit","write","bash", ...]` (denylist
   beats allowlist in `applyToolPolicy`). Must sit INSIDE the batch tool's
   non-overridable `READ_ONLY_EXCLUDED` notion of read-only
   (`subagents-tool.ts`) so batch parity holds (teams-parity ticket 07).
4. In-ticket decision point: denylist over coding tools (small diff, default)
   vs pi's `createReadOnlyTools` as base-tools override in `assembleSession`
   (stronger, bigger diff). Record the alternative in map Frontier if not
   taken.
5. Discoverability: extend the spawn/batch tool descriptions' `agentType`
   mention so the model knows `explore`/`plan` exist.

## Files

- New: `bun-apps/s2-agent-core-runtime/src/builtin-agents.ts`
- `bun-apps/s2-agent-core-runtime/src/agent-registry.ts`, `src/index.ts`
  (barrel)
- `bun-apps/s2-agent-ext-subagent/src/subagent-tool-schema.ts` (guideline
  text)
- spec.md §2 built-in-types row — same PR

## Risks

- `bash` denial vs read-only exploration that legitimately wants grep/find/ls
  — enumerate pi's actual read-only tool names as allowed in the definition.
- "plan" must not collide with the `request_plan_approval` vocabulary — naming
  check in tests.

## Verification

- Registry tests: user file shadows builtin completely (no merge); denylist
  binds through a real `applyToolPolicy` pass; batch tool resolves
  `agentType: "explore"` and stays inside `READ_ONLY_EXCLUDED`.
- Full gates in s2-agent-core-runtime AND s2-agent-ext-subagent AND
  s2-agent-ext-ultracode (core-runtime peer-dep surface).
