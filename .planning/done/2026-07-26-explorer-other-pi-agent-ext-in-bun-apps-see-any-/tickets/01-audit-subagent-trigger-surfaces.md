---
type: research
status: closed (2026-07-26) — audit complete; findings below
---

# 01 — Audit: every subagent-triggering surface

## Question

Enumerate + classify every surface in `bun-apps/pi-agent-ext-*` (and sibling
packages) that triggers a subagent — tools, skills, prompts, and code runners —
and assess which already use the unified path vs diverge.

## Resolution (audit findings)

### Unified path — `spawnSubagent` / `WorkflowAgent` (already strong)

These consumers dispatch through the unified runner, inheriting `timeoutMs` +
`retryOnTransient` (default true) + in-flight registry + run-persistence +
model-config (`tiers`/`capabilities`):

- **hermes-memory** — `config.ts` + handlers (`auto-consolidate`,
  `background-review`, `correction-detector`, `session-flush`).
- **knowledge-card** — `zk_card` / `zk_ask` (`extensions/knowledge-card.ts`).
- **file2md** — `vision-inference.ts`.
- **workflow** — the `agent()`/`parallel()`/`pipeline()` engine (many files).
- **memory-to-vault CLI** — `commands/memory-to-vault*.ts` (2).

### Divergent runners (4, two models)

| # | package | file | model | likely lacks |
|---|---------|------|-------|--------------|
| ① | **obsidian** | `src/lib/subagent.ts` | `child_process.spawn` (**subprocess**) | model-config, telemetry (invisible to `/subagents`), unified retry/timeout |
| ② | **tool-gate** | `qa/l2.ts` | `spawn("bun", [pi-agent/cli.ts])` (**subprocess**) | telemetry, model-config |
| ③ | **btw** | `src/btw/session.ts` | `createAgentSession` direct (**in-process, bypasses runner**) | runner retry/timeout, telemetry |
| ④ | **core-task** | `src/goal/auditor.ts` | `createAgentSession` direct (**in-process, bypasses runner**) | runner retry/timeout, telemetry |

### Ruled OUT (not subagent dispatch — binary/command spawns)

- **archify** `lib/run.ts` — spawns its OWN vendored diagram-renderer CLI
  (`process.execPath [VENDORED_BIN]`), not pi. Comment: "Never shells out to
  ../archify."
- **deploy** `src/run.ts` — generic `spawn(opts.cmd, opts.args)` (deploy steps).
- **wayfind** `src/commands.ts` — `spawnSync` (git/file ops) + skill-instruction
  text in messages (it tells the user to load the SDD skill — it doesn't spawn
  subagents in code).
- **movie-director / flux2 / krea2 / ltx** — ffmpeg / mlx / whisper binary
  invocation.

### Skills that drive subagent use (instruction surface)

- **superpowers** (biggest): `subagent-driven-development`,
  `dispatching-parallel-agents`, `executing-plans`, `requesting-code-review`,
  `writing-plans`, `brainstorming` — the SDD ecosystem.
- **knowledge-card**: `using-knowledge-cards`.
- **obsidian**: `using-obsidian-vault`.
- **wayfind**: `wayfinder` (research passes).

### Prompts

None found — skills are the instruction surface (no prompt-template files
mention subagent directly).

## What this unblocks

03 (per-divergence strategy) — the 4 divergences + their models + likely gaps
are now known. 02 (contract) runs in parallel.
