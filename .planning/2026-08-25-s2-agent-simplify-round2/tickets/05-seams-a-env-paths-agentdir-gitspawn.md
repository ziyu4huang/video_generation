# 05 — seams A: envFlag leaf + findRepoRoot migration + agent-trends agent-dir + git-spawn helper

Source: map Context "Structure" D1-D4 clusters. No file moves (map D6).

## Scope

- **envFlag ×3 → 1**: canonical `src/patches/index.ts:151-158` stays; migrate `cli/sessions/shared.ts:246-249` (`isSkipModelsJson`). `__tests__/e2e-harness.ts:21` `truthy` CANNOT import patches — either re-host the leaf in a patches-importable-free location (e.g. src/paths.ts sibling) or document why the harness copy stays. Decide in-ticket.
- **findRepoRoot migration ×4**: `run-dir/check-deps.ts:46`, `patches/ensure-extension-deps.ts:73`, `run-dir/run-context.ts:38` → `src/paths.ts:65 findRepoRoot`. `ext-doctor.ts:32` is `PI_AGENT_DIR`-based — VERIFY deliberate-or-drift FIRST (map Fog of war); migrate only if drift, else add a one-line justification comment.
- **agent-trends agent-dir**: `cli/commands/agent-trends.ts:91,167` → `resolveAgentDir` (src/paths.ts:39) — honors `PI_CODING_AGENT_DIR` (round-1 D5 bug class; flag the behavior delta in the PR).
- **git-spawn helper**: `pipeline-gate.ts:200-215` ≡ `agent-trends.ts:114-125` (same exitCode→lines shape) → one helper; leave the other 10 ad-hoc spawn sites unless trivially adjacent (loop.ts:104, ext-new.ts:355/426, doctor.ts:385, deps-probe.ts:171) — measure, don't force.

## Acceptance criteria

- [x] ext-doctor PI_AGENT_DIR case verdict recorded in-ticket before migration (see Outcome)
- [x] PI_CODING_AGENT_DIR honored at agent-trends (delta flagged in PR body)
- [x] check-deps.ts / ensure-extension-deps.ts paths still resolve identically (their files are externally pinned — internals only, run.sh:155 proof via boot path test)
- [x] `bun run --cwd bun-apps/s2-agent test` + `typecheck` green; local_ci green; PR merged via devops chain; reviewer pass

## Outcome (2026-08-25)

- **ext-doctor verdict (map Fog resolved)**: `PI_AGENT_DIR` at ext-doctor.ts is the PACKAGE-dir resolver (`resolvePiAgentDir` from the module URL — exported + unit-tested), unrelated to the `PI_CODING_AGENT_DIR` state dir; legacy NAME, not drift. Kept; one-line verdict comment added at the const. REPO_ROOT migrated to `findRepoRoot(PI_AGENT_DIR) ?? resolve(PI_AGENT_DIR, "../..")` (schema-cost's house fallback pattern).
- **envFlag ×3 → 1 leaf `src/env-flag.ts`** (zero imports): patches/index.ts now imports + re-exports it (force-response-language.ts and both test importers unchanged); shared.ts `isSkipModelsJson` and e2e-harness `E2E_ENABLED` migrated. **Flagged widening**: the two former hand-rolls were case-sensitive "1"/"true"(/"yes") — envFlag also accepts "TRUE"/"Yes". Opt-in flags only; run-test.ts sets the literal "1".
- **findRepoRoot migration ×4**: check-deps.ts + run-context.ts now marker-walk (`findRepoRoot` → `join(root, "bun-apps")`; check-deps exits 0 when no marker — the deploy-layout no-op case; run-context's `resolveBunAppsDir` now honestly returns `undefined` there, which its signature always claimed); ensure-extension-deps.ts + ext-doctor.ts use `findRepoRoot ?? <old fixed resolve>` (behavior unchanged off-repo). All four keep their files pinned in place — internals only.
- **agent-trends**: `loadContextWindows()` reads `<resolveAgentDir()>/models-store.json` — **PI_CODING_AGENT_DIR now honored** (round-1 D5 bug class; delta in PR body); `homedir()` import dropped.
- **git-spawn ×2 → `src/cli/git.ts` `gitLines(cwd, args)`** (null = any failure; `?? []` at agent-trends' listWorktrees, null-check at pipeline-gate's changedFilesSinceBase so its gate rows keep distinguishing "git error" from "no changes"). Other ad-hoc spawn sites (loop/ext-new/doctor/deps-probe) measured and deliberately left — they spawn bun/pi, not git.
- **Verification**: tsc clean; `bun test` 969 pass / 3 fail — the 3 are the documented pre-existing `cli-sh-main-argv` set on this Linux box (memory `linux-box-merge-policy`, reproduced on clean origin/main 2026-08-21; none touch edited files); `PI_AGENT_E2E=1 bun test src/__tests__/e2e-launcher.test.ts` 13/13; live boot `./s2-agent.sh --list-models` exit 0 (exercises check-deps + ensure-extension-deps marker walks); `cli agent-trends --window 50` exit 0. Version 0.7.13 → 0.7.14.
