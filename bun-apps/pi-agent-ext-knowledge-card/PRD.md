# PRD — pi-agent-ext-knowledge-card

> **Current-state snapshot: 2026-07-13.** Grounded in the live extension
> registration (`extensions/knowledge-card.ts` registers **4** agent tools),
> `package.json` peer deps, and the in-flight integration roadmap. The
> `docs/TOOL-ORCHESTRATION.md` (2026-07-10) snapshot listed 6 tools — two have
> since moved/merged (see "Tool history" below).

## Problem

Structured and unstructured knowledge (workflow findings, session memories,
human notes) lives in isolated silos — per-workflow `.knowledge.jsonl` files,
hermes memory entries, auto-memory topics. There is no single queryable,
graph-linked, deduplicated knowledge base that spans across all sources.

## Solution

Zettelkasten knowledge-management tools for Pi. The package is the **hub** that
owns every agent-facing knowledge tool. It splits cleanly into two lanes, each
with a deterministic path (no LLM, zero-token, idempotent) and an LLM path
(subagent over `pi-agent-ext-obsidian`):

- **WRITE (converge):** `zk_ingest` (deterministic — the convergence sink) and
  `zk_card` (LLM CRUD).
- **READ (retrieve):** `knowledge_query` (deterministic tag digest) and
  `zk_ask` (LLM graph-RAG answer).

The deterministic `zk_ingest` is the convergence sink: it dissolves per-source
silos into one shared, backlinked graph — one atomic card per record, dedup'd by
canonical id, cross-linked by shared tags, lossless and idempotent (re-ingest is
a no-op).

## Tools (current — 4 agent-facing)

| Tool | Lane | LLM? | Backed by | Description |
|------|------|:----:|-----------|-------------|
| `zk_ingest` | WRITE | ❌ | `src/ingest.ts` `ingestRecords` | Deterministic convergence: `.knowledge.jsonl` / auto-memory / hermes → one card per record |
| `zk_card` | WRITE | ✅ | subagent → `obsidian_*` | CRUD: add / find / update / remove / check — dedup + backlink safety |
| `zk_ask` | READ | ✅ | subagent → graph-RAG (`buildRagTask`) | seed → graph-expand → rank (lexical+graph) → synthesized answer (zh-TW) |
| `knowledge_query` | READ | ❌ | `src/retrieve.ts` `retrieveRecords` | Tag/query digest (gotchas/patterns/levers) |

### Tool history (where the other two went)

- **`zk_extract`** → superseded by `obsidian_distill`. The `buildDistillTask`
  builder remains exported (CLI `zk-extract` + parity tests still use it) but no
  agent tool is registered under that name — call `obsidian_distill` directly.
- **`graph_health` / `healGraph`** → registered with `pi-agent-ext-obsidian` so
  the obsidian `garden` tool surfaces them. Logic still lives in
  `src/retrieve.ts` (`graphHealth` / `healGraph`).

## Pipeline (end-to-end)

```
WRITE ─► ingest: parse (.jsonl / auto-memory / hermes) → renderCard (1/record, dedup by id)
                       │
                       ▼        write card.md + ## 連結 (shared-tag neighbours) → regen MOC
                       │
READ  ─► retrieve: scan folder → parseFrontmatter each → rank (shared-tag + callout boost)
                       │
                       ▼        digest (gotchas/patterns/levers) → agent
                       │
AUDIT ─► graphHealth → healGraph (prune dead links, regen MOC, re-scan)
```

**Key invariant:** both WRITE paths land cards in the **same** folder
(`Zettelkasten/knowledge-graph`) so cross-source `[[edges]]` form by shared tags.
`zk_ask` ranks from `obsidian_search` (frontmatter not available until after
ranking → callouts *surfaced*, not boosted); `knowledge_query` reads frontmatter
at rank time → bounded callout boost applies. Drift-guarded by `retrieve.test.ts`.

## Architecture

- `extensions/knowledge-card.ts` — the hub: tool registration, task-builder
  single source of truth (`buildAdd/Find/Update/Remove/Rag/DistillTask`), tool
  allowlists, vault resolution (delegates to pi-obsidian's multi-tier
  `resolveVault`).
- `src/` — deterministic library (no LLM): `ingest`, `retrieve`, `merge`,
  `emit`, `entities`, `similarity`, `semantic`, `host-fns`.

## `zk_spawn` — internal subagent spawn seam

`zkSpawn` is **not a registered tool** — it is the private, swappable
subagent-spawning seam (`extensions/knowledge-card.ts:92`,
`let zkSpawn = spawnSubagent` from `@repo/pi-agent-ext-subagent`) that the
LLM-backed `zk_*` tools route through. It converged the transport onto **one
in-process path** (`createAgentSession`) instead of pi-obsidian's older
child-process runner (sub-project ①, PR #545). `__setZkSpawnForTest` swaps it
in tests (`__tests__/zk-spawn-parity.test.ts` verifies routing parity).

**When it fires** — only on the two LLM tools; the deterministic pair never
spawns:

| Tool | Spawns? | Call site |
|------|:-------:|----------|
| `zk_card` (add/find/update/remove/check) | ✅ | `knowledge-card.ts:828` |
| `zk_ask` (graph-RAG) | ✅ | `knowledge-card.ts:975` |
| `zk_ingest` (deterministic convergence) | ✗ | — |
| `knowledge_query` (deterministic digest) | ✗ | — |

The table above is the **internal** spawn trigger — *which* tools route through
`zkSpawn`. The **conversational** trigger is broader and agent-judged: what
makes the model call *any* `zk_*` tool mid-conversation.

### When the agent calls `zk_*` in a conversation (behavioral trigger)

**Availability.** `knowledge-card` is a **static** extension
(`pi-agent/src/static-extensions.ts:85`) — the four `zk_*` tools are present in
the tool list of **every** session; the only question is whether the model
decides to call them.

**Two layers prime the decision each turn:**

1. **Always-visible tool descriptions** — strongest is `knowledge_query`'s:
   *"Call this BEFORE answering a question that may benefit from past workflow
   lessons."* (`knowledge-card.ts:1343`).
2. **The `using-knowledge-cards` skill** (`skills/using-knowledge-cards/SKILL.md`)
   loads on demand for knowledge work and carries the `zk_*`-vs-`obsidian`
   hand-off matrix.

**Trigger matrix (READ vs WRITE lanes):**

| Lane | Tool | Fires when the agent… |
|------|------|-----------------------|
| READ (ground an answer) | `knowledge_query` | is about to answer something past lessons may inform (cheap, deterministic, no LLM) |
| READ | `zk_ask` | needs a synthesized graph-RAG answer across the vault (LLM → spawns) |
| WRITE (capture) | `zk_ingest` | has a distillable record (`.knowledge.jsonl` / hermes `§` / auto-memory / generic `.md`) to land in the graph |
| WRITE | `zk_card add` | wants one curated, dup-checked atomic card |
| AUDIT | `zk_card check/find/update/remove` | is doing vault hygiene |

**⚠ Not automatic.** There is no cron, event hook, or proactive loop that
fires `zk_*` mid-conversation — every call is a per-turn **model judgment**,
guided by the descriptions + skills. Two things commonly confused with
auto-triggers:

- **`maybeProactiveConsolidate` (hermes-memory) ≠ `zk_ingest`.** That proactive
  loop consolidates *within* the hermes memory store (heat-based eviction); it
  does **not** call `zk_ingest` into the vault.
- **Non-conversation triggers exist but are outside the chat loop**: the
  `pipeline run` CLI, and self-improve **workflows** (e.g. `closed-loop-proof`
  calls `zk-ingest` via Bash at its Persist phase).

```
            knowledge-card = STATIC extension (loaded every session)
            zk_card / zk_ask / zk_ingest / knowledge_query always present
                                  │
                ┌─────────────────┴──────────────────┐
                │  per-turn MODEL JUDGMENT (no auto) │
                └─────────────────┬──────────────────┘
                                  │
        ┌─────────────────────────┴─────────────────────────┐
        ▼ READ lane (ground)                       WRITE lane (capture)
  "past lessons may help?"                 "I have a record / lesson"
   → knowledge_query  (no spawn)            structured records → zk_ingest (no spawn)
   → zk_ask           (spawns)              one curated card  → zk_card add (spawns)

  OUTSIDE the chat loop (still not auto-fired by conversation):
    • `pipeline run` CLI       → zk_ingest
    • self-improve workflows    → zk-ingest / zk-query via Bash
```

**Input** (`SpawnSubagentOptions`, built at the call site):

```
{ cwd, task, tools, model, excludeTools, externalSignal, extensionTools }
```

- `task`  — built by the single-source-of-truth `build<Add|Find|Update|Remove|Check|Rag>Task`.
- `tools` — frozen per-action allowlist (`ADD_TOOLS`/`FIND_TOOLS`/…/`RAG_TOOLS`),
  all collapsed to `["read", "obsidian", "obsidian_help"]` after obsidian's
  Phase-3 fold of 18 granular tools into one action-dispatched `obsidian`.
- `model` — `resolveDistillModel(params.model)` =
  `params.model ?? KC_SUBAGENT_MODEL ?? "google/gemma-4-12b"`.
- `extensionTools` — `parentExtensionTools`, captured at `session_start` (the R2
  bridge so the child's `obsidian` tool is reachable in manifest AND `-e` dev mode).

**Output** (`SpawnSubagentResult`) → tool handler wraps it:

```
{ output: string, exitCode: number, stderr: string, timedOut: boolean }
  timedOut          → isError  "… timed out"
  exitCode≠0 && !output → isError  "… failed (exit N)"
  otherwise         → content text (subagent output, vault-prefixed)
```

### Config that affects it (gotchas)

zkSpawn reads **environment variables**, not `~/.pi/agent/settings.json`:

| Knob | Affects | Default / note |
|------|---------|----------------|
| `KC_SUBAGENT_MODEL` (env) | child model | `google/gemma-4-12b` — a **LOCAL** LM Studio model, keeping kcard's LLM spend off the cloud. Per-call `model` arg overrides. |
| `OB_VAULT_PATH` / `OB_VAULT_DIR` (env) | vault path | resolved via pi-obsidian `resolveVault` (env → config → app → `cwd/vault`). |
| `OB_SUBAGENT_TIMEOUT_MS` (env) | timeout | ⚠ **documented in the header comment but stale for the migrated path**: the in-process `zkSpawn` call sites pass no `timeoutMs`, and `spawnSubagent` only arms a timer when `timeoutMs` is truthy (`spawn-subagent.ts:228`). zk_* subagents therefore run with **no timeout gate** today. (This env is still honored by pi-obsidian's separate `obsidian_distill`/`garden` child-process tools.) |

⚠ **`settings.json` does NOT feed zkSpawn.** `obsidian.subagentModel` and the
session `defaultModel` are ignored — `resolveDistillModel` always returns a
concrete model, so the `mainModel` fallback never engages for `zk_*`. To change
the zk_* subagent model, set `KC_SUBAGENT_MODEL` (or pass the tool's `model` arg).

### Flow

```
 CONFIG  (env / arg — NOT settings.json; see gotchas above)
   KC_SUBAGENT_MODEL (env) ......... child model  [default local gemma-4-12b]
   OB_VAULT_PATH / OB_VAULT_DIR .... vault path  (resolveVault)
   per-call `model` arg ............ overrides KC_SUBAGENT_MODEL
   ✗ settings.json obsidian.subagentModel + defaultModel → IGNORED
   ✗ OB_SUBAGENT_TIMEOUT_MS → doc'd, not threaded (no timer on zk_* today)
        │
 ┌──────▼─────────────────────────┐   fires ONLY on:
 │ agent  ──calls a zk_* tool──►  │   zk_card {add|find|update|remove|check}  ✅
 │ (parent session)               │   zk_ask  {question}                      ✅
 └──────┬─────────────────────────┘   zk_ingest / knowledge_query             ✗
        │ action + params
 ┌──────▼──────────────────────────────────────────────────────────────┐
 │ extensions/knowledge-card.ts  (the hub = "kcard")                    │
 │   task  = build<Add|Find|Update|Remove|Check|Rag>Task(params) ← SoT  │
 │   tools = <ACTION>_TOOLS  e.g. ["read","obsidian","obsidian_help"]    │
 │   model = resolveDistillModel(params.model)                          │
 └──────┬──────────────────────────────────────────────────────────────┘
        │ SpawnSubagentOptions { cwd, task, tools, model, excludeTools,
        │   externalSignal, extensionTools: parentExtensionTools }
 ┌──────▼───────────────────────────────┐
 │ zkSpawn  (private seam, line 92)      │  = spawnSubagent (in-process),
 │ let zkSpawn = __defaultSpawnSubagent  │   NOT pi-obsidian child-process
 └──────┬───────────────────────────────┘
        │
 ┌──────▼─────────────────────────────────────────────────────────────┐
 │ @repo/pi-agent-ext-subagent · spawnSubagent → createAgentSession    │
 │   ISOLATED child (no parent history) · tools frozen to the allowlist │
 │   child loads `obsidian` via manifest + extensionTools (R2 bridge)   │
 │   ⚠ no timeoutMs passed → no timer (runs until done / budget)        │
 └──────┬─────────────────────────────────────────────────────────────┘
        │
 ┌──────▼──────────────────────────────────────────┐
 │ isolated subagent  (LLM = local gemma default)   │
 │   reads/writes the vault via the `obsidian` tool │
 └──────┬──────────────────────────────────────────┘
        │ SpawnSubagentResult { output, exitCode, stderr, timedOut }
 ┌──────▼─────────────────────────────────────────────────────────────┐
 │ tool handler wraps the result:                                      │
 │   timedOut          → isError  "… timed out"                        │
 │   exitCode≠0, !out  → isError  "… failed (exit N)"                  │
 │   ok                → content text (subagent output, vault-prefixed) │
 └──────┬─────────────────────────────────────────────────────────────┘
        │
 ┌──────▼───────────┐
 │ agent (returns)  │
 └──────────────────┘
```

## Key Dependencies (verified `package.json`)

- `@repo/pi-agent-ext-obsidian` (hard peer) — vault access, `runSubagentWithRetry`
  legacy path, `parseFrontmatter` / `validateZettelNote` / index/graph helpers.
- `@repo/pi-agent-ext-workflow` (hard peer) — the **single spawn path** since ①
  (`createAgentSession` / `spawnSubagent`) and the host-fn registry for ②'s
  deterministic `call('zk.*')`.
- `pi-agent` (reverse consumer) — hosts the `zk-extract` / `zk-card` /
  `zk-ask` / `zk-ingest` / `zk-query` commands and `knowledge-pipeline`.

> Note: `pi-agent-ext-power-tool` is **no longer a dependency** —
> `knowledge_query` + `graph_health` were migrated *from* power-tool *into* this
> hub (PR #351/#354, 2026-07-07). power-tool is self-contained diagnostics again.

## Integration roadmap — knowledge-card × workflow (in flight)

Four sub-projects converging the kcard onto the `workflow` extension's runtime
(see `.planning/kg-subagent-workflow-integration/design.md`):

| # | Sub-project | Status |
|---|-------------|--------|
| ① | Converge `zk_*` onto a single spawn path | ✅ Shipped (PR #545) |
| ② | Deterministic `call()` primitive (host-fn registry; `zk.retrieve/ingest/health/heal`) | ✅ Complete (`feat/kg-call-primitive`, 862+307 tests green) |
| ③ | Knowledge-aware workflow agentTypes + auto-primer | ⏳ Planned |
| ④ | Learning feedback loop → KG | ⏳ Planned |

## Use

```bash
# CLI
bun bun-apps/pi-agent/src/cli.ts cli zk-ask "question"
bun bun-apps/pi-agent/src/cli.ts cli zk-ingest <file.knowledge.jsonl>
bun bun-apps/pi-agent/src/cli.ts cli zk-query --tags flux2,vae        # retrieve digest
bun bun-apps/pi-agent/src/cli.ts cli zk-query --json                  # deterministic JSON
# Or via the extension (registers the 4 agent tools)
pi -e bun-apps/pi-agent-ext-knowledge-card
```

## Cross-reference

- [`docs/TOOL-ORCHESTRATION.md`](./docs/TOOL-ORCHESTRATION.md) — full dependency + data-flow graph (2026-07-10 snapshot; 2 tools since moved — see "Tool history" above)
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — module map, two ingestion modes
- [`docs/DATA-MODEL.md`](./docs/DATA-MODEL.md) — 12-key record → zettel schema
- [`docs/DEPENDENCIES.md`](./docs/DEPENDENCIES.md) — cross-package coupling graph
- [`docs/kg-improvement-plan.md`](./docs/kg-improvement-plan.md) — retrieval-improvement backlog (P1–P8; arc closed 2026-07-08)
- [`docs/SAG-LEARNINGS.md`](./docs/SAG-LEARNINGS.md) — entity/IDF study behind P8
- [`docs/PR-HISTORY.md`](./docs/PR-HISTORY.md) — knowledge-layer arc
