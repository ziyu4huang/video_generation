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
- [02 — Define the "strong unified dispatch" contract](tickets/02-define-strong-unified-dispatch-contract.md) — **contract locked**: unified = 4 guarantees (runner-path via `spawnSubagent` OR a shared subprocess-wrapper; config-only models; retry/timeout default-on; telemetry registered + visible). Mechanism secondary to guarantees. `btw`/`core-task` → in-process; `obsidian`/`tool-gate` → shared subprocess-wrapper.

## Not yet specified

- **Consolidation execution per divergence** — graduates from 03. Includes the **shared subprocess-wrapper** build ticket (the §1 vehicle for obsidian + tool-gate: config-aware + retry/timeout + phantom telemetry entry) + the `btw`/`core-task` → in-process `spawnSubagent` build tickets.
- **btw / core-task lower-level needs** — they call `createAgentSession` directly. What control does bypassing the runner buy them (streaming? history? custom hooks?)? Determines whether the move to `spawnSubagent` is drop-in or needs a runner-extension. Lives in 03.
- **Skills alignment** — superpowers SDD + knowledge-card + obsidian + wayfind skills instruct the model to dispatch subagents. The contract (02) is now the bar to check them against — could ticket independently once 03 graduates the build work.

## Out of scope

- **Binary-invocation spawns** — ffmpeg / mlx / archify's vendored renderer / deploy command-runner. These spawn binaries, not subagents. (archify `lib/run.ts` confirmed: runs its own diagram-renderer CLI, not pi.)
- **The interactive picker** — separate effort, just shipped (PR #848–#870).
