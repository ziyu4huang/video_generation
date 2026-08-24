# 02 — src/paths.ts shared leaf

Phase A · risk MED · gate: package gates + bundle-mode-anchor · depends: none

## Receipt (2026-08-24)

Implemented on branch `s2-agent-simplify-t02-paths-leaf`. Net −63 lines; 14 files rewired + new src/paths.ts.

- Precondition proven empirically: real deploy bundle build (same flags as deploy/run.ts) greps 0 hits for any cli/ path; cli-sh.ts static import closure contains no cli/ (cli namespace rejected at :83-91 before applyPatches).
- Rewires: 3 patch settings readers → leaf (subagent-model-floor now zero @earendil-works imports); agent-dir sites per plan EXCEPT **ensure-model-tiers charted-but-rejected** — its reader `getModelTierConfigPath` (s2-agent-core-runtime/src/model-role-config.ts:29) keys on `$HOME` only, so env-honor in the writer would be a silent no-op (map D5 amended). memory/memory-to-vault/knowledge-pipeline gain PI_CODING_AGENT_DIR (intended delta).
- Deviation: findRepoRoot keys on the `bun-apps/` marker, not `.git` — doctor.test.ts:42-52 pins that marker (fixture has no .git). Result identical for all callers.
- Kept wrappers (real importers or test pins): readUserSettings (shared.ts), resolveRepoRoot (schema-cost.ts), resolveSessionsDir (tools-metrics.ts; agent-trends' is semantically distinct — PI_SESSIONS_DIR).
- Gates: tsc clean; bun test 1046 pass / 0 fail; bundle-mode-anchor 1 pass. Independent reviewer verdict READY (2 Info semantic notes: no tilde expansion / `??` vs truthy env check — immaterial for real callers).

## Scope

New `src/paths.ts` (node-builtins only — no @earendil-works, no workspace imports; patches must stay SDK-free in its importers where required):

- `resolveAgentDir(env)` — `env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")`.
- `readAgentSettings()` — best-effort read of `<agentDir>/settings.json` → undefined on error.
- `findRepoRoot(fromDir)` — ascend from caller-provided dir to the git root; callers pass `import.meta.dir`.

Rewire:

- Settings readers ×4 → one: patches/default-model-env.ts:182, patches/force-response-language.ts:152, patches/subagent-model-floor.ts:70, cli/sessions/shared.ts:451 (shared.ts version stays exported for its importers).
- Agent-dir sites (~6 beyond the readers): cli/commands/tools-metrics.ts:418, cli/commands/doctor.ts:238+325, memory.ts:142, memory-to-vault.ts:30, knowledge-pipeline.ts:38, patches/ensure-model-tiers.ts:60. The last four gain PI_CODING_AGENT_DIR honor — flagged behavior delta (map D5).
- Repo-root ×5: doctor.ts findRepoRoot, schema-cost.ts resolveRepoRoot, and the `join(import.meta.dir, "../../../../..")` literals in cli/commands/{loop.ts:161, dispatch-log.ts:158, pipeline-gate.ts:309}.

## Preconditions

- EMPIRICALLY verify cli/ files never enter the cli-sh cjs bundle (import.meta.dir folds at bundle time — memory: cjs traps). Run a real bundle build (bundle-mode-anchor test does); only then trust import.meta.dir in cli/ call sites.

## Done-when

Package gates + bundle-mode-anchor green; PI_CODING_AGENT_DIR delta flagged in PR; grep census shows one definition each of the three helpers.
