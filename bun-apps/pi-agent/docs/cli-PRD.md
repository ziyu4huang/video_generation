# PRD — `pi-agent cli`

> The non-interactive command namespace of `bun-apps/pi-agent` (`src/cli/**`),
> reached as `pi-agent cli <command>`. Written while it was a separate
> `pi-agent-cli` package; merged into pi-agent 2026-08-12.

## Problem

Agent workflows like `file2md`, `zk-extract`, `zk-ask`, and `pipeline pdf-to-vault` need a self-contained, non-interactive CLI entry point — one command per run, no TUI loop, no persistent session. Each run curates only the tools it needs instead of loading every extension.

## Solution

A self-contained CLI with extensions baked in as workspace deps. Drives pi-agent via the SDK from TypeScript on Bun. Ships agent workflows (file2md, zk-extract, zk-ask, pipeline pdf-to-vault) plus a pi-compatible passthrough so the binary can serve as its own sub-agent target. Extensions are imported directly into the process (`pi-obsidian`, `pi-file2md`, `pi-agent-ext-knowledge-card` as `workspace:*` deps) without `.pi/settings.json` entries.

## Architecture

The CLI is a **thin, self-contained routing layer** over workspace extensions.
It parses args, composes a task string, and drives one agent turn. Almost no
business logic lives here — decomposition / retrieval / distillation all live
in the workspace deps (`pi-agent-ext-*`).

### Layers

```
cli.ts / args.ts        — entry + dispatch + pi-compatible arg parser
commands/*.ts           — hand-written leaf commands (thin shells)
extensions/             — extension-backed sub-commands (registry + runner)
sessions/               — runtime engine (shared services, session creation,
                          passthrough, pretty/JSON output + retry)
workspace deps          — the actual logic (obsidian, knowledge-card, distill…)
```

### Dispatch (`cli.ts`)
`main()` routes argv in order: global short-circuits → `help` →
`findCommandToken` (the first **positional**, so global flags may precede the
command) → META / `pipeline` / `workflow` namespaces / registered `COMMANDS`
→ **passthrough** (mirrors `pi -p`, lets the binary be its own sub-agent
target). Commands are plain `{ name, summary, details, run }` records in
`COMMANDS` / `PIPELINES` / `WORKFLOWS` arrays.

### Self-contained runtime (`sessions/shared.ts`)
Single source of truth. (a) `resolveLLM()` — caller > env > user settings >
fallback. (b) `buildBakedRegistry()` — `@repo/pi-agent`'s `PROVIDERS`
(lm-studio) registered explicitly over global models.json;
`PI_SKIP_MODELS_JSON=1` → hermetic in-memory. (c) `createSharedSession()` —
pi-obsidian always in `extensionFactories`, plus `validateToolNames()`
fail-fast, obsidian subagent floor, and `OB_PARENT_MODEL` publishing.

### Shared session tail (`sessions/run-agent-session.ts`)
The 5-step sequence every agent command ends with (LLM resolve → create
session → log model → one turn → dispose), so leaf commands stay thin.

### Two command patterns
- **Hand-written** (`commands/*.ts`) — resolve inputs + build task from an
  extension's builder (`buildDistillTask`, `DISTILL_TOOLS`), hand to
  `runAgentSession`.
- **Extension-backed** (`extensions/registry.ts` + `runner.ts`) — an extension
  exports an `ExtensionSubcommandSpec`; adding a sub-command = one import line.

### Output (`sessions/task-runner.ts`)
Subscribes to session events; pretty (text deltas → stdout, tool lines →
stderr) or NDJSON. Empty-turn retry recovers silent local-model failures
(the dominant `refs=0` cause in retrieval runs).

### Key design tradeoffs
- obsidian **inline import** (not run-dir manifest) — CLI curates tools
  per-command instead of loading every extension.
- baked providers sourced from `pi-agent` — one-file model catalog, no drift.
- `--dry-run` = exclude write tools (deterministic, not LLM-discipline).
- `validateToolNames` fail-fast — pi-core silently drops unknown tool names.

## Tools / Commands

| Command | Description |
|---------|-------------|
| `zk-extract` | Decompose files → Zettelkasten notes via subagent |
| `zk-ask` | Graph-enhanced RAG over Zettelkasten vault |
| `zk-ingest` | Deterministic convergence of structured records → vault cards |
| `file2md` | PDF/image → Obsidian markdown via LM Studio VLM |
| `pipeline pdf-to-vault` | Multi-stage PDF pipeline |
| `doctor` | Self-check: runtime, repo layout, run-dir manifest, MLX paths, Obsidian vault |
| `workflow run` | Headless engine runner for pi-agent-ext-workflow scripts |
| `workflow list` | Enumerate available engine workflows |
| (passthrough) | Any pi-agent subcommand in non-interactive mode |

## Key Dependencies

- `@earendil-works/pi-coding-agent` (SDK)
- `pi-agent-ext-hermes-memory` (persistent memory: memory_search, session_search, skill_manage)
- `pi-agent-ext-obsidian` (always loaded for vault access)
- `pi-agent-ext-knowledge-card` (zk-extract, zk-ask, zk-ingest, knowledge_query)
- `pi-agent-ext-knowledge-card` `zk_ingest` actions `gate`/`converge`/`status` (knowledge distillation pipeline: hermes-memory → vault → graph)
- `pi-agent-ext-file2md` (VLM describe)
- `pi-agent-ext-power-tool` (doctor diagnostics)

## Agent Knowledge Stack

Four extensions form a self-regulating knowledge pipeline: raw memories
accumulate, are filtered and enriched, then converge into a linked graph.
The combined agent tool surface is **11 tools / ~4160 schema tokens** (distill folded into zk_ingest).

```
pi-agent cli
  ├─ hermes-memory    (5 tools, ~1551 tok)  ← raw memory accumulation
  │     memory · memory_search · session_search · skill_manage · skill_manage_help
  │
  ├─ obsidian         (2 tools,  ~235 tok)  ← vault I/O
  │     obsidian · obsidian_help
  │
  ├─ knowledge-card   (4 tools, ~1928 tok)  ← Zettelkasten graph convergence
  │     zk_ask · zk_ingest · zk_card · knowledge_query
  │
  └─ distill          (1 tool,   ~121 tok)  ← pipeline orchestrator
        │     distill (actions: status / gate / converge)
        │
        └─ adaptive threshold (event-driven, default N=50, clamp [20,200])
```

### Distillation data flow

```
hermes-memory (raw, bloated)
    │
    ├─ Stage 1: GATE (rule-based, deterministic, no LLM)
    │     dedup (fuzzy Jaccard ≥0.72) · staleness prune (90d) · format validation
    │
    ├─ Stage 2: ENRICH (agent LLM, in-context — no LLM-in-extension)
    │     agent rewrites survivors: clarity · tags · wiki-links · merge fragments
    │
    └─ Stage 3: CONVERGE (deterministic, reuses knowledge-card ingestRecords)
          canonical-id dedup · tag cross-links · MOC indexing
          → knowledge-card graph (findable, traversable)
          │
          └─ THRESHOLD FEEDBACK: converge metrics → auto-adjust N
             killRate>0.7 & passRate>0.8 → N-=5 (efficient)
             passRate<0.5 → N+=10 (conservative)
```

Agent workflow: `distill status` → `distill gate` → [enrich survivors] →
`distill converge` (3 tool calls + in-context enrichment between gate and
converge). The lifecycle hook nudges the agent on session start when bloat
exceeds the threshold.

### Schema-cost regression guard

The combined tool surface is pinned by `perf-harness/tests/grand-total.regression.test.ts`
(budget: 4576 tok, baseline 4160). Per-extension guards exist in each
extension's `perf/` test directory. Any schema inflation (reverted
promptSnippet, verbose description, new tool) fails CI.

## Use

```bash
./pi-agent.sh cli <command> [options]                     # from the repo root
bun bun-apps/pi-agent/src/cli.ts cli <command> [options]  # same, no wrapper
```

## Cross-reference

- [`workflow-cli.md`](workflow-cli.md) — headless engine runner reference
- [`pi-cross-machine-setup.md`](pi-cross-machine-setup.md) — fresh-machine steps
