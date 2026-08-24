# 02 — src/paths.ts shared leaf

Phase A · risk MED · gate: package gates + bundle-mode-anchor · depends: none

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
