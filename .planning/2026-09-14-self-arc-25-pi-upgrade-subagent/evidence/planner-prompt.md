# Arc-25 planning task — pi upgrade 0.84.4 → 0.85.1 + s2-agent-ext-subagent improvements

You are the arc planner for self-arc-25 of this repo's self-develop loop. Read the repo (you have filesystem access from the repo root). Produce a strict wayfinder map + tickets. Effort folder: `.planning/2026-09-14-self-arc-25-pi-upgrade-subagent/` (already created; research evidence already committed there).

## User directive (verbatim intent)

pi (the upstream framework: `@earendil-works/pi-coding-agent` et al.) has a new version. Upgrade it, study the upstream extension sources (pi.dev / github earendil-works/pi), and improve `bun-apps/s2-agent-ext-subagent` with what's worth taking. Verify on the DEPLOYED s2-agent in an ISOLATED work env.

## Verified research facts (do not re-derive; evidence files in the effort folder)

- `evidence/local-tarball-diff.md` — authoritative npm-dist diff. ZERO removed symbols that s2-agent imports (root-import embedder; the 0.85.1 experimental-surface removal — createCodingAgentHarness/RemoteSession*/PiCommand*/TranscriptState — does not touch us). `SessionManager.inMemory(cwd?, options?, entries?: FileEntry[])` gained the entries restore param (0.85.x "restorable in-memory sessions"). New: ChatViewport, per-tool *Renderers, ThemeJsonValidator, setupCli, getLatestVersion.
- Behavior changes that can bite: (1) setModel/setThinkingLevel now SESSION-SCOPED (restored on resume; do not change defaults for new sessions); (2) RPC abort waits for idle; (3) built-in tools bash/edit/find/grep/ls/read/write now honor per-call ctx.cwd (children with different cwd resolve paths correctly — improvement); (4) write tool no longer reports UTF-16 byte counts (tests asserting on that will break); (5) session forks preserve compaction boundary; isIdle() counts branch summary as busy; BranchSummaryMessage.fromId nullable.
- `evidence/cc-ext-sources-digest.md` — upstream `examples/extensions/` study (80+ first-party examples; subagent/index.ts is the official spawn extension: `pi --mode json -p --no-session`, PER_TASK_OUTPUT_CAP=50KB with full output preserved in tool details, per-message usage ledger, SIGTERM→5s→SIGKILL, project-local agents behind a ui.confirm trust gate, hasUI=false policy questions made explicit). Also: plan-mode (setActiveTools + appendEntry persistence), todo.ts (state in tool-result details → fork-safe), handoff.ts, agent core steer/followUp queues, experimental SessionWorker/coordinator infra, RPC mode as the full bidirectional steering protocol.
- `evidence/sdk-changes-digest.md` — risk list ranked; top: client subpath removal (unaffected — root imports only), ctx.cwd inversion (real for multi-cwd children), transitive dep reshuffle (pi-client/pi-protocol out, chord in → lockfile recompute), prompt-cache ttl field rename for GPT-5.6+ Responses, pi-tui env-default removals (PI_DEBUG_REDRAW→PI_TUI_DEBUG_REDRAW), scrollbarThumb theme key class move, write-tool byte-count removal (test assertions), editor working-indicator embedding.

## What s2-agent already has (verified by grep — do not plan duplicates)

- SIGTERM→5s grace→SIGKILL ladder: `core-runtime/src/spawn-subagent-subprocess.ts:307-318` ✅ (upstream parity already)
- `SessionManager.inMemory()` in use: `core-runtime/src/agent.ts:446`
- Child→parent plan approval with timeout-default-DENY: `ext-subagent/src/request-plan-approval-tool.ts` (children ask the PARENT, who owns the UI — our architecture's answer to hasUI=false)
- Steering a live child exists (`send_message` deliverAs:"steer", per-run steer lever, arc-19/23)
- Usage tracking exists in viewer snapshots (tokens per agent)

## Known-open gaps (candidates — verify each, then shape tickets; reject with reasons where our architecture already covers it)

1. **t-upgrade (P0):** bump all `@earendil-works/pi-*` 0.84.4→0.85.1 across ~28 package.json files (deps + peerDeps), bun install, fix fallout, all gates green. Explicitly verify: (a) typecheck across every bun-apps package; (b) grep tests for write-tool byte-count assertions; (c) audit setModel/setThinkingLevel usage for cross-session assumptions; (d) model registry resolution for `zai/glm-5.3` still works post-registry-churn (GPT-6 Astra added, Grok Build 0.1 removed, ZAI China models added).
2. **ctx.cwd exploitation (P1):** 0.85.0 fixed built-in tools to honor per-call ctx.cwd. Check whether our child-session paths (git-scope.ts spawnCwd vs runCwd, subagents-tool cwd handling) can now delegate cwd to pi instead of working around it — simplify if the workaround is now redundant, or document why not.
3. **Output cap + details full-preserve (P1):** upstream caps per-task child output at 50KB for the parent LLM, full output in tool `details` for UI expand. Verify whether `subagents-tool.ts` returns unbounded child output into the parent context today; if yes, add the cap+details split (upstream parity, context economics).
4. **Per-message usage ledger (P2):** upstream aggregates input/output/cacheRead/cacheWrite/cost/turns per child from message_end events. Ours tracks tokens in snapshots — check granularity; upgrade only if cheap.
5. **Restorable child sessions (P2, likely CHART-ONLY this arc):** `inMemory(cwd, {id}, entries)` restore could let a persistent child's transcript be journaled and restored after parent restart. Assess size honestly; likely successor-arc material.
6. **Model registry freshness (P2):** after upgrade, expose/verify GPT-6 Astra + ZAI catalog changes through our models-preset/tiers config if applicable.

## Constraints

- GLM-5.3 everywhere (never flash) for any LLM work in tickets.
- Devops CLIs own git phases (prepare-feature-branch-cli, local-ci-cli, merge-pr-after-ci-cli). This branch is already claimed: self-arc-25-pi-upgrade-subagent, ledger entry 25 active.
- Deployed verification at the END uses the freshly deployed version in an isolated scratch-repo work env (arc-24 pattern: scratch git repo + worktree isolation proof + headless drive).
- Version bump touches `bun-apps/s2-agent/**` transitively → version-bump step in the merge chain applies.
- Biome: warnings ≠ failures (bun run check exits 0 with warnings); never `--unsafe` autofix; never pipe-gate exit codes.
- The sibling loop worktrees (video_generation__memory/__movie) are off-limits.

## Deliverable

Write `.planning/2026-09-14-self-arc-25-pi-upgrade-subagent/plan.md`: wayfinder map (status, goal, scope-in/out, tickets t01..tN with file surfaces + tests + receipt requirements, fog-of-war list, successor next-goal sketch). Keep tickets small and independently mergeable; t01 (upgrade) must land FIRST since later tickets build on 0.85.1. Every ticket needs a verification clause (test + deployed-verification contribution).
