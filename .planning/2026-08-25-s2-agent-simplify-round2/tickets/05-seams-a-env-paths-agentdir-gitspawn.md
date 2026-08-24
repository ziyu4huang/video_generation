# 05 — seams A: envFlag leaf + findRepoRoot migration + agent-trends agent-dir + git-spawn helper

Source: map Context "Structure" D1-D4 clusters. No file moves (map D6).

## Scope

- **envFlag ×3 → 1**: canonical `src/patches/index.ts:151-158` stays; migrate `cli/sessions/shared.ts:246-249` (`isSkipModelsJson`). `__tests__/e2e-harness.ts:21` `truthy` CANNOT import patches — either re-host the leaf in a patches-importable-free location (e.g. src/paths.ts sibling) or document why the harness copy stays. Decide in-ticket.
- **findRepoRoot migration ×4**: `run-dir/check-deps.ts:46`, `patches/ensure-extension-deps.ts:73`, `run-dir/run-context.ts:38` → `src/paths.ts:65 findRepoRoot`. `ext-doctor.ts:32` is `PI_AGENT_DIR`-based — VERIFY deliberate-or-drift FIRST (map Fog of war); migrate only if drift, else add a one-line justification comment.
- **agent-trends agent-dir**: `cli/commands/agent-trends.ts:91,167` → `resolveAgentDir` (src/paths.ts:39) — honors `PI_CODING_AGENT_DIR` (round-1 D5 bug class; flag the behavior delta in the PR).
- **git-spawn helper**: `pipeline-gate.ts:200-215` ≡ `agent-trends.ts:114-125` (same exitCode→lines shape) → one helper; leave the other 10 ad-hoc spawn sites unless trivially adjacent (loop.ts:104, ext-new.ts:355/426, doctor.ts:385, deps-probe.ts:171) — measure, don't force.

## Acceptance criteria

- [ ] ext-doctor PI_AGENT_DIR case verdict recorded in-ticket before migration
- [ ] PI_CODING_AGENT_DIR honored at agent-trends (delta flagged in PR body)
- [ ] check-deps.ts / ensure-extension-deps.ts paths still resolve identically (their files are externally pinned — internals only, run.sh:155 proof via boot path test)
- [ ] `bun run --cwd bun-apps/s2-agent test` + `typecheck` green; local_ci green; PR merged via devops chain; reviewer pass
