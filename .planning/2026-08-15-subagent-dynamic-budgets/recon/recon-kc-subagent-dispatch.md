# Read-only recon: knowledge-extraction subagent dispatch

Date: 2026-02-27. Repo: video_generation__memory. Scope: `bun-apps/pi-agent-ext-knowledge-card` (src + extensions), cross-checked against hermes-memory. NO edits made.

## (a) Dispatch mechanism

- Extraction (`zk_card` CRUD, `zk_ask` graph-RAG — the two LLM-touching tools) dispatches via **`spawnSubagent` from `@repo/pi-agent-ext-subagent`** — an in-process `createAgentSession` child, NOT the pi subagent tool and NOT its own child process.
- Import: `extensions/knowledge-card.ts:120-124`.
- Seam: `extensions/knowledge-card.ts:151-162` (`ZkSpawnFn`, `let zkSpawn = __defaultSpawnSubagent`, test-only override `__setZkSpawnForTest`).
- Call sites: `extensions/knowledge-card.ts:463` (zk_card) and `:611` (zk_ask) — `const { output, failure } = await zkSpawn({...})`.
- Comment at `zk-task-config.ts:5-7`: the tool allowlists are passed as the `tools` array to zkSpawn ("was runSubagentWithRetry's `toolsCsv` parameter pre-migration") — i.e. migrated from a retry-wrapping runner to plain spawnSubagent.
- `parentExtensionTools` captured at `session_start` (`extensions/knowledge-card.ts:268-276`) to bridge obsidian tools into the child (manifest AND `-e` dev mode).
- Model resolution: `src/zk-task-config.ts:53-56` — `resolveDistillModel()` precedence: explicit `model` arg → `KC_SUBAGENT_MODEL` env → `DISTILL_MODEL_DEFAULT = "google/gemma-4-12b"` (local LM Studio; keeps LLM spend off cloud).
- Tool allowlists per command: `DISTILL_TOOLS/ADD_TOOLS/FIND_TOOLS/UPDATE_TOOLS/REMOVE_TOOLS/CHECK_TOOLS/RAG_TOOLS` (`zk-task-config.ts:23-30`) — all collapse to `["read", "obsidian", "obsidian_help"]` after obsidian's Phase-3 fat-tool refactor.
- Distill prompt: `src/task-builders.ts` `buildDistillTask` (pure string templates, shared with CLI zk-* commands).
- Deterministic paths (zk_ingest convergence, knowledge_query digest, zk_retrieve/health/heal) use NO subagent — registered at `extensions/knowledge-card.ts:1092-1095` with their own timeoutMs (30s/120s/60s/60s).
- Contrast (hermes-memory, different package): uses `spawnSubagent` too, e.g. `src/handlers/background-review.ts:15,37,90` with injectable spawn seam. Same shared dependency, separate pipelines.

## (b) Budgets on the extraction path

- **None/defaults at the zkSpawn call sites**: no `maxTurns`, no token budget, no per-spawn timeout is passed in `zk_card`/`zk_ask` (read at `extensions/knowledge-card.ts:463` and `:611` — only prompt/model/tools-style options; exact option object not fully re-read before budget cutoff, but grep for `maxTurns|timeout|budget` over the extension file returns NO zkSpawn-related hits).
- Tool-level `timeoutMs` values exist only for the deterministic no-LLM tools (30s/60s/120s, `extensions/knowledge-card.ts:1092-1095`).
- Header comment mentions `OB_SUBAGENT_TIMEOUT_MS` ("subagent timeout (default 5 min)") at `extensions/knowledge-card.ts:33` — env knob documented for the OLD pi-obsidian child-process runner; whether spawnSubagent honors it today is unverified (recon cutoff).
- Hierarchy LLM budget exists but is separate: `HIERARCHY_DEFAULTS` in `zk-task-config.ts` — chars-proxy `baseBudget: 10_000` halving per layer (floor 1200), `threshold: 0.72`, `maxDepth: 3`.

## (c) Failure / observability handling

- zkSpawn returns `{ output, failure }` — failure surfaced as tool error at the call sites (463/611).
- **No retries** on the new path: the pre-migration `runSubagentWithRetry` wrapper was removed (per `zk-task-config.ts:6-7` comment); grep shows no retry/backoff around zkSpawn.
- **No circuit-breaker on the subagent path**. The only breaker constant is `summaryBreaker: 3` in `HIERARCHY_DEFAULTS` (`zk-task-config.ts`) — consecutive empty summarize results tolerated per hierarchy layer before skipping further LLM summaries. That is the hierarchy-build path, not zk_card/zk_ask.
- Best-effort/silent-fail patterns elsewhere: `session_shutdown` auto-converge swallows errors (`extensions/knowledge-card.ts`, `catch { /* Silent fail */ }`), gated by `OB_HERMES_AUTOCONVERGE=0`.
- Test seams for failure injection exist: `__setZkSpawnForTest`, `__setVaultResolverForTest` (`extensions/knowledge-card.ts:160-163, ~213-224`).

## Open follow-ups (not verified before cutoff)

- Exact option keys passed to zkSpawn at lines 463/611 (read `extensions/knowledge-card.ts` offset ~430-560 for the zk_card call, ~600-660 for zk_ask).
- Whether `spawnSubagent`'s own defaults (`@repo/pi-agent-ext-subagent`) include turn limits/timeouts — check that package's `SpawnSubagentOptions`.
