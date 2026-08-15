> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Spec: Extract shared `core-runtime` package (decouple workflow → subagent)

- **Effort:** `core-runtime-extraction`
- **Date:** 2026-08-12
- **Status:** Done (shipped #1251)

## 1. Goal

Eliminate the lateral `pi-agent-ext-workflow → pi-agent-ext-subagent` npm coupling by extracting the shared agent-execution runtime into a new sibling library package `@repo/pi-agent-ext-core-runtime` that BOTH depend on downward. The two packages keep co-working — same runtime, routed through the shared package — but no longer import each other.

## 2. Background — current coupling

The other "superpowers stack" packages (wayfind, superpowers, power-tool, tool-gate) are already decoupled from this edge; they co-work via the LLM tool path + the shared `.planning/<effort>/` layout. The only heavy lateral npm edge is:

**`pi-agent-ext-workflow → pi-agent-ext-subagent`**
- 18 workflow source files import from subagent (9 lines are `import type`; 18 are runtime `import` lines).
- 11 workflow test files import from subagent.
- Declared as `peerDependencies: { "@repo/pi-agent-ext-subagent": "workspace:*" }`.
- Single load-bearing runtime line: `workflow.ts:326 → new WorkflowAgent(...)`.

`subagent → workflow`: confirmed ZERO (string occurrences are comments only).

## 3. Design

### 3.1 New package: `@repo/pi-agent-ext-core-runtime`
- **Location:** `bun-apps/pi-agent-ext-core-runtime/`.
- **Kind:** workspace LIBRARY — NOT a pi extension (no `extensions/`, no `pi.skills`, not registered in `pi-agent/run-dir/manifest.json` or `pi-agent/src/static-extensions.ts`).
- **Consumption:** `exports["."].default = "./src/index.ts"`, consumed as TS source by Bun (matches subagent + core-interface conventions; no build step).
- **Dependencies:** `peerDependencies`: `@earendil-works/pi-coding-agent` (0.84.1), `typebox` (*). `devDependencies`: `@earendil-works/pi-ai` (0.84.1), `typebox`, `typescript`, `@biomejs/biome`, `@repo/pi-agent-ext-core-interface` (workspace:* — devDep for shared module augmentations only; NO runtime use). The 15 moved files import ZERO symbols from core-interface; `rate-limiter.ts` owns the `__piRateLimitState` slot via direct `globalThis` access (no seam-API call).

### 3.2 Relationship to `core-interface`
`core-interface` is the zero-runtime **contracts** layer — 15 packages declare it (13 consume it type-only via `devDependencies` for module augmentation; 2 use it at runtime/peer level: hermes-memory, knowledge-card). `core-runtime` is a sibling **implementation** library. The 15 moved files import ZERO symbols from `core-interface`, so `core-runtime` has **no runtime dependency** on it — `core-interface` is a devDep for shared module augmentations only (matching sibling convention). The two are independent core packages with no runtime edge between them; `core-runtime`'s heavy runtime type-graph therefore cannot leak into `core-interface`'s 13 type-only consumers.

### 3.3 What moves (15 files: `subagent/src/` → `core-runtime/src/`)
A self-contained closure, lifted as one unit (verified ZERO edges into the subagent-tool layer):
`agent`, `agent-history`, `agent-registry`, `errors`, `model-tier-config`, `model-role-config`, `sdd-report`, `structured-output`, `tool-action-label`, `config`, `home`, `rate-limiter`, `worktree`, `subagent-in-flight`, plus the general-purpose `agent-row-display`.

Two internal cycles (`agent↔model-tier-config`, `agent-history↔tool-action-label`) move together.

### 3.4 What stays in subagent (capability layer)
`spawn-subagent*`, `subagent-tool*`, `subagents-tool`, `subagent-runs-tool`, `subagent-viewer`, `subagent-context-widget`, `subagent-run-persistence`, `git-scope`, `presets`. These rewire their imports of moved symbols to `@repo/pi-agent-ext-core-runtime`.

### 3.5 Public API & naming
- New primary export: **`CoreAgent`** (renamed from `WorkflowAgent`; method stays `.run()`).
- **Back-compat:** both `subagent` and `workflow` re-export `{ CoreAgent, WorkflowAgent: CoreAgent }`. Peer consumers are unbroken.
- `core-runtime` `index.ts` exports all moved symbols: `CoreAgent`; registry (`AgentRegistry`, `loadAgentRegistry`, `agentDefinitionKey`, `resolveAgentType`, `listAgentTypes`); errors (`WorkflowError`, `WorkflowErrorCode`, `isWorkflowError`, `wrapError`); rate limiting (`RateLimiter`, `getGlobalRateLimiter`, `setRateLimitCapResolver`, `getRateLimitCapResolver`, `RateLimitCapResolver`); history (`AgentHistoryEntry`, `summarizeLatestAction`, `compactAgentHistory`); SDD (`SddReport`, `parseSddReport`, `isSddReportActionable`, `SDD_REPORT_STATUSES`); model tiers (`ModelTierConfig` + tier fns); worktrees (`createWorktree`, `removeWorktree`, `Worktree`); in-flight (`SubagentInFlightRegistry`, `getSubagentInFlightRegistry`, `InFlightSubagent`); structured output (`createStructuredOutputTool`, `resolveStructuredOutput`, `extractValidated`); display (`ActivityRow`, `ThemeLike`, `ActivityStatus`, `activityGlyph`, `NO_THEME`, `shorten`, `fmtCost`, `fmtTokensShort`, `preview`, `renderActivityRow`, `shortModel`); `homeDir`; config consts.
- `subagent` `index.ts` re-exports the same surface for back-compat (its existing public API is preserved).

### 3.6 Dependency DAG (before → after)
```
BEFORE:  workflow ──peerDep──► subagent
AFTER:   core-runtime ◄── dep ── { subagent, workflow }
         (core-interface is a devDep-only sibling of both; no runtime edge to core-runtime)
```

## 4. Migration specifics

### 4.1 Deep-path imports (step 0 — audit found 16 sites, 4 packages)
`@repo/pi-agent-ext-subagent/src/*.ts` deep-path imports bypass the barrel and will silently break when files move. Audit found **16** across workflow (1), obsidian (3), hermes-memory (5 source + 1 co-located test + 8 in tests/handlers), file2md (1). Flatten ALL to root `from "@repo/pi-agent-ext-subagent"` BEFORE any move — every symbol resolves via the barrel (stayed symbols natively; moved symbols via subagent's back-compat re-export after §3.5). Separately, 3 tool-gate imports of `extensions/subagent.ts` (extension-to-extension wiring) STAY as-is — not lib symbols. Run this grep to confirm zero remain (except the 3 tool-gate `extensions/` ones): `grep -rn '@repo/pi-agent-ext-subagent/src/' --include='*.ts' . | grep -v node_modules | grep -v '/dist/'`.

### 4.2 Back-compat re-export block (workflow `index.ts` lines 4-29 + 46-82)
Audit result: **dead surface — delete.** Of 59 re-exported symbols (24 types + 35 values), exactly ONE is consumed: `WorkflowAgent` at `pi-agent-cli/src/commands/memory-to-vault.ts:21`. Every real `spawnSubagent` caller (knowledge-card, hermes-memory×4, file2md, obsidian) already imports directly from subagent. Action: repoint `memory-to-vault.ts:21` to import `WorkflowAgent` from `@repo/pi-agent-ext-subagent` (facade, back-compat alias), then DELETE both re-export blocks. (Note: this does NOT by itself remove workflow's subagent peerDep — that requires the §4.3 step-5 internal rewire, since ~12 workflow src files still import subagent symbols at runtime; all of those symbols move to core-runtime, so after step 5 the peerDep is droppable.)

### 4.3 Ordering (each step ends green)
1. Normalize deep-path imports.
2. Scaffold `core-runtime` (package.json / tsconfig / empty index).
3. Move the 15 files as a unit; wire `core-runtime` exports.
4. Rewire `subagent` → depend on `core-runtime`; re-export `CoreAgent` / `WorkflowAgent`.
5. Rewire workflow's 18 runtime imports → `core-runtime`; drop the subagent `peerDep`.
6. Handle the back-compat re-export block (split/delete).
7. Move the corresponding tests; final `typecheck` + `test` across all three.

## 5. Verification
- `core-runtime`: own test suite (tests for the 15 moved files relocate with them).
- `subagent` + `workflow`: `bun run typecheck && bun test` after each step.
- Smoke: workflow `samples/smoke-e2e.sh`; subagent self-test; confirm `CoreAgent` / `WorkflowAgent` / `spawnSubagent` still resolve from both packages' public API.
- Repo guards: `bun-apps/tests/dep-guard.test.ts` and `bun-apps/tests/seam-contract.test.ts` stay green. The `__piRateLimitState` runtime ownership moves with `rate-limiter.ts` into `core-runtime` (still via direct `globalThis` access). Verify these guards do NOT hardcode `subagent` as the owner of `__piRateLimitState` — if they do, update them to reference `core-runtime`; if they only check non-orphan/registry invariants, they pass unchanged.

## 6. Non-goals
- wayfind / superpowers / power-tool (already decoupled).
- tool-gate test/QA seams (separate effort).
- Renaming `core-interface` or its 15 consumers.
- Renaming `subagent-in-flight.ts` / `SubagentInFlightRegistry` (deferred — keep names to limit churn).

## 7. Risks
- **Public API drift:** the large re-export surfaces must stay byte-identical for peer consumers → covered by back-compat aliases + the §4.2 audit.
- **Deep-path breaks:** mitigated by step-0 normalization.
- **Test-relocation churn:** ~40 subagent tests + ~55 workflow tests; move tests with their files; keep re-exports to minimize import churn.
- **seam-contract guard:** moving `rate-limiter.ts` shifts `__piRateLimitState` runtime ownership into `core-runtime`; verify the seam stays non-orphan and the cap resolver still wires correctly.
