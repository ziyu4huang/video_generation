---
type: research
status: closed
---

## Question

Census the trio's user-facing features and code mass — the 80% denominator and net-negative baseline. Per package (wayfind, superpowers, subagent): (a) feature list from README + manifest + skills dirs: every command, subcommand, LLM tool, programmatic export a USER could invoke (skill = 1 feature each; count them); (b) src/tests/extensions LOC via wc -l (record exact numbers + date; this snapshot is the net-negative gate baseline); (c) TUI surface inventory (viewer modes, dock rows, inline renders). Deliverable: per-package feature-count table (N features) + LOC snapshot table, committed as the gate baseline. Method: read-only; READMEs + `find|wc` + manifest.json.

## Resolution

**Method**: READMEs + `package.json` `pi` manifest + extension entries (`extensions/*.ts`) + grep of `pi.registerTool/registerCommand/registerShortcut` in src + cross-package import grep (`@repo/pi-agent-ext-<x>` across all `bun-apps/*`, excluding the package itself, node_modules, dist) + `find | xargs wc`. All three packages load as **static always-on** extensions (`pi-agent/src/static-extensions.ts:75-84`), not manifest-dynamic. **Snapshot date: 2026-08-16.**

### Feature counts (the 80% denominator)

| package | skills | slash cmds (behaviors) | LLM tools | exports w/ ≥1 external consumer | TUI surfaces | **N** |
|---|---|---|---|---|---|---|
| wayfind | 22 | 14 | 1 | 1 | 1 | **39** |
| superpowers | 14 | 0 | 0 | 0 | 0 | **14** |
| subagent | 0 | 2 | 3 | 7 | 3 | **15** |

#### wayfind — N = 39

- **22 skills** (each dir = 1; verified 22 `SKILL.md`): `ask-matt`, `code-review`, `codebase-design`, `diagnosing-bugs`, `domain-modeling`, `grill-me`, `grill-me-with-docs`, `grilling`, `handoff`, `improve-codebase-architecture`, `prototype`, `research`, `resolving-merge-conflicts`, `subagent-dispatch-discipline`, `teach`, `to-questionnaire`, `to-spec`, `to-tickets`, `triage`, `wait-what`, `wizard`, `writing-for-agents`.
- **14 slash-command behaviors**: `/grill me`, `/grill docs` (flagship), `/grill done [--seed-plan]`, `/grill domain`; `/wayfind <destination>` (chart; `-- <destination>` force-chart is the same handler), `/wayfind` (bare = work next frontier ticket), `/wayfind status`, `/wayfind spec`, `/wayfind tickets`, `/wayfind seed`, `/wayfind sync`, `/wayfind done`, `/wayfind validate`, `/wayfind statusbar on|off` (in code, absent from README table).
- **1 LLM tool**: `wayfind_effort` (effort status/list/search/validate; registered in `src/index.ts`).
- **1 programmatic export w/ external consumer**: `globalThis.__piWayfindGrill` grill seam — consumed by hermes-memory (`src/grill-seam.ts`, `correction-detector.ts`). No package-root import consumers outside tool-gate's QA meta-harness (`qa/evaluate.ts`, `qa/collect-probes.ts` import the extension entry for gating evaluation — not a peer feature consumer).
- **1 TUI surface**: `wayfind` status-bar section (order 2) in ext-task's shared `CoreTaskStatusWidget`, one branded line `🧭 wayfind │ {emoji} {text}` (10 state emojis; `src/overlay.ts`).

#### superpowers — N = 14

- **14 skills** (byte-identical upstream port; verified 14 `SKILL.md`): `brainstorming`, `dispatching-parallel-agents`, `executing-plans`, `finishing-a-development-branch`, `receiving-code-review`, `requesting-code-review`, `subagent-driven-development`, `systematic-debugging`, `test-driven-development`, `using-git-worktrees`, `using-superpowers`, `verification-before-completion`, `writing-plans`, `writing-skills`.
- **0 commands / 0 tools / 0 exports / 0 TUI**: verified zero `register*` calls in src+extensions; zero packages import `@repo/pi-agent-ext-superpowers`. The `using-superpowers` bootstrap (context injection until first `agent_end`) is a delivery mechanism for the skills, not a separately invocable feature — noted, not counted.

#### subagent — N = 15

- **3 LLM tools**: `subagent`, `subagents` (plural batch fan-out), `subagent_runs`.
- **2 slash commands**: `/subagents` (list running+completed, view/follow runs), `/models-preset` (interactive picker + direct apply).
- **7 programmatic exports w/ ≥1 external consumer** (grouped):
  1. `spawnSubagent` (+ Options/Result types) — hermes-memory ×4 handlers (background-review, session-flush, auto-consolidate, correction-detector), knowledge-card, file2md/vlm
  2. `spawnSubagentSubprocess` (+ `SubagentFailure`) — obsidian
  3. `getSubagentInFlightRegistry` — obsidian
  4. `getSubagentRunPersistence` — obsidian
  5. `WorkflowAgent` (core-runtime facade) — pi-agent CLI `memory-to-vault`
  6. model-tier config facade (`loadModelTierConfig`, `resolveModelRole`, `saveModelTierConfig`, `getModelTierConfigPath`) — file2md
  7. trace-render helpers (`capTraceTail`, `formatSubagentTrace`, `latestMessageLine`, `STREAMING_EXPANDED_TAIL`) — ext-task subagents dock section
- **3 TUI surfaces**: `/subagents` viewer (see inventory), `alt+s` global-detach shortcut (`GLOBAL_DETACH_KEY`), inline `subagent`/`subagents` tool-call render in transcript/composer (`subagent-tool-render.ts` + `ComposerComponent`, width-aware).
- **Excluded (advertised but 0 external consumers)**: `runWatchdog` (+ watchdog suite), `createSubagentTool`/`createSubagentsTool`/`createSubagentRunsTool` factories (extension-entry re-hosting only), `convertToBackground`/`dispatchCtrlB`/`makeProdDetachDeps` (own-extension only).

### LOC snapshot (net-negative gate baseline, 2026-08-16)

| package | src `.ts` LOC | tests `.ts` LOC | extensions `.ts` LOC | skills prose (words) |
|---|---|---|---|---|
| wayfind | 4,169 (incl. `src/__tests__`) | 5,249 | 86 | 25,327 |
| superpowers | 347 | 850 | 61 | 40,812 |
| subagent | 7,463 | 10,319 | 273 | — (no skills dir) |
| **trio total** | **11,979** | **16,418** | **420** | **66,139** |

Commands: `find src -name '*.ts' | xargs wc -l | tail -1` (same for tests/, extensions/), `find skills -name '*.md' | xargs wc -w | tail -1`.

### TUI surface inventory

- **wayfind**: no viewer, no dock of its own. 1 status-bar section (`wayfind`, order 2) contributed to ext-task's shared `CoreTaskStatusWidget` via the `__piCoreTaskStatusWidget` global (no package import; ADR-wayfind-0004). Toggle: `/wayfind statusbar on|off`.
- **superpowers**: none.
- **subagent**: `/subagents` viewer with **3 stateful modes** (`src/subagent-viewer.ts`): `list` (Running live + Completed, cap 20), `output` (full run output), `follow` (live tool-call trace tail, 40 lines). In-viewer `ctrl+b` detach (raw `\x02` byte-sniff, unregistered). Global `alt+s` detach shortcut. Inline tool-call render (transcript + composer). The below-editor `aboveEditor` widget was retired (Task 04) — its collapsed behavior moved to ext-task's dock row.
- **Dock (context)**: the dock lives in `pi-agent-ext-task/src/subagents/subagents-section.ts` (subagents row) + `src/shared/status-widget.ts` (section registry: goal/loop order 0, todo order 1, subagents, wayfind order 2). The subagents row is ext-task's surface but is powered by subagent's in-flight registry + trace-render helpers imported from `@repo/pi-agent-ext-subagent`.

### Surprises

1. wayfind README's capability table says "6 skills" — **22 ship** (stale table; batches 1–2 ports doubled+ the suite).
2. `runWatchdog` is advertised public API with **zero external consumers**; ditto the three tool factories and the detach internals — 9 of 33 barrel-relevant names are dead interface for peers (cf. `tests/barrel-surface.test.ts`: barrel once carried 114 exports, 21 ever imported).
3. superpowers is a pure skill payload: 347 src LOC shepherding 40,812 words of verbatim upstream prose; nothing imports it programmatically.
4. subagent is the code-mass center: ~62% of the trio's src LOC and ~63% of test LOC.
5. `/wayfind statusbar` exists in code but not in the README command table.
