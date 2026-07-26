# Wayfinder map: 2026-07-26-explorer-other-pi-agent-ext-in-bun-apps-see-any-

## Destination

Every subagent dispatch in the repo flows through ONE unified, strong path
(`spawnSubagent` / `WorkflowAgent`). The **4 divergent runners** found in the
audit — **obsidian** + **tool-gate** (child-process subprocess model) and **btw**
+ **core-task** (direct `createAgentSession`, bypassing the runner) — are either
consolidated onto the unified path OR consciously retained with a documented
rationale. Every dispatch inherits the four "stronger" guarantees: runner-path
unity, model-resolution via config (no hardcodes), error/retry/timeout, and
telemetry (in-flight + run-persistence visibility to `/subagents`). The map ends
when the consolidation approach for each divergence is decided + the unified
contract is locked.

## Notes

- **Domain**: pi-agent extension ecosystem (`bun-apps/pi-agent-ext-*`). The
  unified runner + its guarantees live in `pi-agent-ext-subagent`
  (`spawnSubagent` / `WorkflowAgent` — already strong: `timeoutMs` +
  `retryOnTransient` default-true + in-flight registry + run-persistence +
  model-config via `tiers`/`capabilities`).
- **Skills to consult**: `grilling` + `domain-modeling` (ticket 02 contract);
  `systematic-debugging` if a consolidation breaks a consumer.
- **Standing preference**: prefer consolidating onto the existing unified runner
  over building new abstraction. No hardcoded model ids (the no-hardcode
  principle from the model-config work applies to every divergent runner too).
- **Terminal**: macOS Terminal.app.
- Conversational language: 繁體中文; all written artifacts: English.

## Decisions so far

- [01 — Audit: every subagent-triggering surface](tickets/01-audit-subagent-trigger-surfaces.md) — **4 divergences found** (obsidian + tool-gate subprocess; btw + core-task direct `createAgentSession`) across 2 models; 5 unified consumers; skill drivers cataloged (superpowers SDD biggest). archify/deploy/wayfind/movie-binary spawns ruled out (not subagent dispatch).

## Not yet specified

- **Consolidation execution per divergence** — graduates from 03 (one build ticket per divergence once the strategy + contract are set).
- **The subprocess-vs-in-process hard question** — obsidian + tool-gate run pi as a CHILD PROCESS (isolation?). Can they move to in-process `spawnSubagent`, or is isolation load-bearing (→ needs a subprocess wrapper that still registers telemetry)? Lives in 02 (contract: does "unified" require in-process?) + 03 (per-divergence feasibility).
- **btw / core-task lower-level needs** — they call `createAgentSession` directly, bypassing the runner. What control do they need that the runner lacks (streaming? history? custom hooks?)? Lives in 03.
- **Skills alignment** — superpowers SDD + knowledge-card + obsidian + wayfind skills instruct the model to dispatch subagents. Do they steer to the unified surface, or to a divergent one? Graduates from 01 (partly independent — could ticket once the contract lands).

## Out of scope

- **Binary-invocation spawns** — ffmpeg / mlx / archify's vendored renderer / deploy command-runner. These spawn binaries, not subagents. (archify `lib/run.ts` confirmed: runs its own diagram-renderer CLI, not pi.)
- **The interactive picker** — separate effort, just shipped (PR #848–#870).
