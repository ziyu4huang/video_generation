# Unified Subagent Model-Resolution + Runner — Design

**Status:** approved (brainstorm 2026-07-26) → spec self-review → user review → writing-plans
**Effort:** unify-subagent-model-config
**Packages:** `pi-agent-ext-subagent` (owner), `pi-agent-ext-file2md` (consumer migration)

## Problem

The repo has **three separate model-configuration mechanisms** and **two child-session runner paths**, so configuring "which model a child dispatch uses" is split across unrelated places and consumers reach the child session through different code:

| Config mechanism | Location | Governs |
|---|---|---|
| ① providers | `~/.pi/agent/models.json` → `{providers}` | host provider definitions |
| ② tiers | `~/.pi/workflows/model-tiers.json` → `{tiers:{small,medium,big}}` | subagent/workflow tier→model |
| ③ vision | file2md: env `PI_PROVIDER` + `"provider/modelId"` string | file2md local vision model |

| Runner path | Consumers |
|---|---|
| subagent `WorkflowAgent` (`spawnSubagent` + `subagent` tool) | knowledge-card, hermes-memory, superpowers SDD |
| file2md own `createAgentSession*` (bypass) | file2md |

The host `Model` type has **no capability/modality dimension** (only a partial `ImagesModel` signal), so "vision" is not a resolvable concept today — which is why file2md rolled its own session factory + env config.

**User pain:** to give different tasks different models (a coding subagent needs a coding model; a vision extraction needs a vision model), the user must configure three different places using three different mechanisms → confusion. And extensions reach the child session through two divergent code paths.

## Goal

One underlying subagent approach (single runner) + one configuration (tier and capability/vision resolved through one system), so users configure models in one place and every child dispatch flows through the same runner, registry, persistence, and observability.

## Decisions (locked during brainstorm)

1. **Scope** — one spec, internally phased: Phase 1 = unified config foundation; Phase 2 = runner/file2md migration built on top.
2. **Config shape** — two independent dimensions: `{ tiers: {small,medium,big}, capabilities: { vision, ... } }`. Consumers query a tier OR a capability; no tier×capability matrix.
3. **Ownership** — extension-only. The subagent package owns the unified config + resolver; it reads host providers (`models.json`) read-only for validation. No pi-coding-agent core changes; capability is an extension-layer concept.
4. **Config home** — extend `~/.pi/workflows/model-tiers.json` in place (add `capabilities`). Lowest migration friction; the tiers path + the `/workflows-models` command stay (additive). Path is workflow-scoped (mild semantic oddity for file2md) but kills the real pain (file2md's env config).

## Design overview (data flow)

```
~/.pi/workflows/model-tiers.json
  { tiers:{small,medium,big}, capabilities:{vision:"lmstudio/..."} }
        │
        ▼
  resolveModelRole({tier?|capability?|model?})   ← subagent pkg; pure config lookup + spec parse
        │   → {provider, modelId, thinkingLevel?} | null
        ▼
  spawnSubagent({model, tier?, capability?, modelRuntime?})  ──► WorkflowAgent (shared runner + registry + persistence)
  subagent tool (+ capability param)
Consumers: knowledge-card / hermes-memory / superpowers SDD / file2md (Phase 2 fully via spawnSubagent)
```

## Phase 1 — unified config + resolver (foundation)

### ① Config schema (extend `model-tiers.json`, additive, backward-compatible)

```jsonc
{
  "tiers":    { "small": "openai/gpt-4.1-mini", "medium": "...", "big": "..." },
  "capabilities": { "vision": "lmstudio/qwen2-vl-7b" }   // open map; add coding/embedding… freely
}
```

`capabilities` is optional; a legacy `tiers`-only file keeps working.

### ② Resolver (subagent pkg — extend `model-tier-config.ts` or add `model-role-resolver.ts`)

```ts
resolveModelRole(opts: { tier?: string; capability?: string; model?: string })
  : { provider: string; modelId: string; thinkingLevel?: string } | null
```

Precedence (mirrors existing spawnSubagent semantics): explicit `model` always wins > `capability` > `tier` > null (consumer falls back to session main model). Pure lookup + parse of the `provider/modelId[:thinking]` string — does NOT construct a `Model`, does NOT touch host. The consumer feeds the spec into its own session path.

### ③ Consumer wiring

- **spawnSubagent** — `SpawnSubagentOptions` gains `capability?: string`; the `subagent` tool gains a `capability` param (the LLM may request a vision-capable subagent).
- **file2md** — Phase 1 replaces its env-based `resolveLLM` (`PI_PROVIDER` + string) with `resolveModelRole({ capability: "vision" })`; it KEEPS its session-factory (uses the resolved spec to build its local-runtime session). → removes the env config pain.

### ④ Backward compatibility

file2md's env (`PI_PROVIDER`) becomes a **deprecated fallback**: used only when `capabilities.vision` is unset, falling back to env + the old default (lm-studio), with a deprecation warning. Existing file2md setups do not break.

## Phase 2 — runner unification (file2md → spawnSubagent)

### ⑤ spawnSubagent injection seam

`SpawnSubagentOptions` gains `modelRuntime?: ModelRuntime` (or `services?: AgentSessionServices`). When provided, WorkflowAgent builds the child session from the injected services (bypassing host `agentDir`/`modelRuntime` resolution); otherwise the existing path. This lets file2md pass its `InMemoryCredentialStore` `ModelRuntime` (local LM Studio vision model).

### ⑥ file2md full migration

`session-factory.ts` + `resolveLLM` are **removed**. file2md calls:

```ts
spawnSubagent({
  task,
  model: resolveModelRole({ capability: "vision" }),
  modelRuntime: <file2md's InMemoryCredentialStore runtime>,
  tools: [],   // single VLM inference, no agent tool-loop
})
```

Vision runs now flow through WorkflowAgent → registered in the in-flight registry + persisted → observable in `/subagents`.

### ⑦ Observability

After Phase 2, every file2md vision call appears as a `/subagents` run. A `kind: "inference"` filter tag (to let the viewer hide inference-only runs) is **deferred** (YAGNI) — add only if `/subagents` actually becomes noisy.

## Cross-cutting

**Error handling** — resolver: if the requested tier/capability is absent and no fallback applies, throw a clear error naming the missing key, the config path, and the available keys.

**Testing**

- resolver unit: tier lookup, capability lookup, `model`-override precedence, missing-key errors, `tiers`-only backward-compat.
- spawnSubagent: new `capability` option + `modelRuntime` injection seam (mock `ModelRuntime`).
- file2md: update tests to use the resolver (no env); verify the spawnSubagent path.
- integration: a vision dispatch appears in `/subagents` (Phase 2).

## Risks

- **Phase 2 — WorkflowAgent services injection (primary risk).** Whether `WorkflowAgent`/`agent.ts` can cleanly accept an injected `services`/`modelRuntime` is unverified. To de-risk in planning: read `agent.ts` session construction; if a clean injection point is absent, the seam shape adjusts (e.g. inject `ModelRuntime` rather than full `AgentSessionServices`). Phase 1 is unaffected and can ship first.
- **file2md env removal (Phase 2, breaking).** Phase 2 removes `PI_PROVIDER` entirely; any user still relying on env must move to `capabilities.vision`. Mitigated by Phase 1's deprecation warning.

## Out of scope

- `kind: "inference"` viewer filter (deferred — see ⑦).
- Host-core capability/modality dimension (extension-only per decision 3).
- tier×capability matrix (two independent dimensions per decision 2).
- Relocating the config to a neutral path (extend in place per decision 4).

## Open questions (resolve in planning, not blocking design)

- Exact resolver module placement (extend `model-tier-config.ts` vs new `model-role-resolver.ts`).
- Whether the `subagent` tool's `capability` param needs schema/docs surface beyond the param itself.
- Phase 2 seam: `modelRuntime?` vs `services?` — decide after reading `agent.ts`.
