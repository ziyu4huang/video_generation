# PRD — pi-agent-ext-tool-gate

## Problem

Every tool registered by an extension is added to the per-request tools schema and charged as token overhead on **every turn of every session** — even when 95% of those tools are never used. With a full extension ecosystem loaded, a single pi session carries ~72 tools → ~21,950 tok/req of fixed overhead. The cost is paid regardless of relevance: a session that only edits code still lugs around the full schemas of image/video/movie generation, ArXiv retrieval, deploy, and Z.ai web tools.

The root cause is structural — pi activates every registered tool by default — so a session either pays full overhead or uninstalls extensions (losing them everywhere).

## Solution

A pi extension that acts as a **cost-control / visibility layer** between `pi.getAllTools()` and `pi.setActiveTools()`. It owns **no domain functionality**; it only decides which tool names reach the API on a given turn.

- **Core tools** (a lean, audited always-active set: file I/O, memory, HITL interaction, web, diagnostics) stay **always active** — re-triaged in ticket 02 (14 on-demand tools demoted) + ticket 06 (diagnostics un-gated).
- **Heavy domain tools** (~32 gates across ~24 families: image/video/movie generation, workflow orchestration, research, ArXiv, deploy, Z.ai web, knowledge/vault ops) are **gated** — hidden until the prompt shows intent, then reactivated instantly.
- **Sticky activation**: once a gate fires, its tools stay active for the rest of the session — a workflow using `flux2` never loses the tool mid-task when a follow-up like *"make it bigger"* drops the trigger keyword.
- **Fail-open**: any tool not explicitly tracked (new tools from other extensions) is always active, so tool-gate can never accidentally hide functionality it doesn't know about.

Net effect: **~21,950 → ~6,750 tok/req (~69% saved; gross ~15,186, net ~14,900 after the `enable_tool` escape-hatch overhead)**, measured by `bun run qa:savings` (re-run for live numbers; figures drift as the gate set changes).

## Main focus

**Token-cost optimization via lazy, keyword-gated tool activation.** Tool-gate is the only component that decides which tool names reach `setActiveTools()`. It does not implement any gated tool — every one of them is owned by a sibling extension. Tool-gate only flips their *visibility*.

```
pi session ── getAllTools() ──▶ tool-gate ── setActiveTools(active) ──▶ API request
                                  │
                  ┌───────────────┼───────────────────────┐
                  ▼                                       ▼
          core (always on)                    GATE_DEFS families (lazy, hidden until intent)
          lean audited set                     ~32 gates / ~24 families
          ─ never gated ─                      ─ fire on keyword / noun∧verb ─
                                                 saves ~15,186 tok/req
                                  │
                          enable_tool (always on) ◀── escape hatch for misses
```

Gates are **owner-declared**: each extension declares its family once in the shared `GATE_DEFS` registry (`@repo/pi-agent-core-interface`) and its tools reference it via `gating: { gate: "<id>" }` on their `ToolDefinition`.

## Scope reality (2026-07)

The extension is feature-complete against its original goal. Five ADRs capture the in-scope design decisions:

- **ADR-0001** — the always-active `enable_tool` escape hatch (recovery when keyword matching misses).
- **ADR-0002** — bare-word keyword removal (S2 precision audit).
- **ADR-0003** — `requires` noun∧verb co-occurrence for core nouns (`image`/`video`/`pdf`) that false-fire on "docker image" / "video call" but must survive on "generate an image".
- **ADR-0004** — opt-in telemetry (silent by default).
- **ADR-0005** — removal of the phantom `cost` gate (a tool measured offline but never loaded at runtime — gating it inflated savings by ~536 tok/req).

### Out of scope

The gating **mechanism** is not redesigned here. A semantic/embedding matcher or a declarative-DSL redesign (replacing keyword + co-occurrence matching) is a separate effort — re-evaluated on evidence in wayfinder ticket 00 (keyword matching passes 46/46 must-fire + 20/20 gate-recall, 0 task-breaking; a semantic fallback stays fog until telemetry shows a real miss-rate). The gated tools themselves are owned by their own extensions; tool-gate only controls their visibility.

## Gates (lazy) and their owning extensions

Every gate family is declared in the shared `GATE_DEFS` registry by its **owning extension** (single source of truth for who implements each tool — tool-gate owns none). Each family id is referenced by every tool in it via `gating: { gate: "<id>" }`.

| Gate id | Tools | Owning extension | Trigger |
|---|---|---|---|
| flux2 | `flux2`, `flux2_help` | pi-agent-ext-flux2 | keywords + noun∧verb |
| krea2 | `krea2`, `krea2_help` | pi-agent-ext-krea2 | keywords (narrow) |
| ltx | `ltx`, `ltx_help` | pi-agent-ext-ltx | keywords + noun∧verb |
| file2md | `file2md`, `vision_ask` | pi-agent-ext-file2md | keywords + noun∧verb |
| workflow | `workflow`, `workflow_help`, `workflow_control`, `subagent`, `subagents` | pi-agent-ext-workflow + pi-agent-ext-subagent (cross-package family) | keywords |
| collect_videos | `collect_videos`, `organize_vault_notes`, `import_memory_to_vault` | pi-agent-ext-research-tool | keywords |
| arxiv | `arxiv_search`, `arxiv_fetch2md`, `arxiv_paper` | pi-agent-ext-research-tool | keywords + noun∧verb |
| movie | `movie`, `movie_help` | pi-agent-ext-movie-director | keywords + noun∧verb |
| zai | `zai_web_search_web_search_prime`, `zai_web_reader_webReader` | pi-agent-ext-zai-mcp *(env-gated on ZAI_API_KEY)* | keywords + noun∧verb |
| deploy_pi_agent_sh | `deploy_pi_agent_sh`, `verify_pi_agent_deploy` | pi-agent-ext-devops | keywords + noun∧verb |
| merge_pr_after_local_ci, sweep_merged_branches, run_local_ci, check_main_health, sync_default_branch, run_devops_retrospect, prepare_feature_branch, verify_merge_landed | devops single-tool gates | pi-agent-ext-devops | keywords |
| zk_card, zk_ask, zk_ingest, knowledge_query | knowledge-card on-demand | pi-agent-ext-knowledge-card | keywords + noun∧verb (ticket 02) |
| skill_manage, session_search, knowledge_search, knowledge_ingest, planning_stale, grill_decision, memory_supersede | hermes-memory on-demand | pi-agent-ext-hermes-memory | keywords ± noun∧verb (ticket 02) |
| wayfind_effort | wayfind | pi-agent-ext-wayfind | keywords + noun∧verb (ticket 02) |
| get_search_content | web-access | pi-agent-ext-web-access | keywords + noun∧verb (ticket 02) |
| obsidian | `obsidian`, `obsidian_help` | pi-agent-ext-obsidian | keywords + noun∧verb (ticket 02) |

The six `inspect_*` diagnostics (context/agent/extensions/hooks/pathology/tui) were **un-gated to core in ticket 06** — always-on so the agent can reach them exactly when something is wrong.

## Core tools (always active) — owners

```
read, write, edit, bash                    → pi builtins (injected core)
todo, goal_complete                        → pi-agent-ext-task
ask_user_question                          → pi-agent-ext-task (HITL)
memory, memory_search                      → pi-agent-ext-hermes-memory
web_search, fetch_content                  → pi-agent-ext-web-access
inspect_context, inspect_agent, inspect_extensions,   → pi-agent-ext-power-tool
inspect_hooks, inspect_pathology, inspect_tui          (ticket 06 un-gate)
enable_tool                                → THIS extension (the escape hatch)
```

Demoted to on-demand gates in ticket 02: `zk_card`, `zk_ask`, `zk_ingest`, `knowledge_query`, `wayfind_effort`, `skill_manage`, `session_search`, `knowledge_search`, `knowledge_ingest`, `planning_stale`, `grill_decision`, `get_search_content`, `obsidian`, `obsidian_help`.

## How it works (per-turn pipeline)

```
session_start:  ONE full rebuild — discover tools → buildEffectiveGates (resolve
                GATE_DEFS id references) → measure token costs → per-session state.
                (ticket 05: the per-turn path does NOT rebuild.)

per turn (before_agent_start):
   │
   ▼
updateSticky(prompt, sticky, gates)   MUTATE — fire gates whose keywords or
   │                                  noun∧verb co-occurrence match → add names to sticky
   ▼
filterActive(allToolNames, sticky, tracked)  PURE — keep a tool if untracked (fail-open)
   │                                        OR present in sticky
   ▼
pi.setActiveTools(active)

session_shutdown:  drop the session's gate state.
```

The **mutate/pure split** is deliberate: `enable_tool` calls `filterActive` directly so it never re-evaluates gates against a stale prompt and silently activates unrelated gates.

## Escape hatch

`enable_tool` is a **core tool** (always active, owned by this extension). When keyword matching misses a genuine need, the agent activates the dormant gate same-turn:

- `intent: "make a video"` → `matchIntent` finds the matching gate.
- `name: "ltx"` → activates the gate containing that exact tool.
- `list: true` → returns all currently dormant gates.

This makes the gating risk **recoverable** instead of structural. Telemetry (`miss_candidate` events) quantifies the miss rate so the risk is measurable, not invisible.

## Key Dependencies

- `pi-agent` (loaded via run-dir manifest, `extensions/tool-gate.ts` is the single registration entry)
- `@earendil-works/pi-coding-agent` (ExtensionAPI; peerDependency)
- `typebox` (schema for the `enable_tool` parameters)
- Self-contained — no external services. Telemetry is opt-in (`TOOL_GATE_LOG=1` / `TOOL_GATE_LOG_PATH=<file>`).

## Use

```bash
# Auto-loaded via pi-agent's run-dir manifest (no manual setup)
# The extension gates on session_start and re-evaluates each turn.

# Verify savings (offline, same heuristic as runtime telemetry):
bun run qa:savings        # standalone, per-gate breakdown
bun run qa                # full QA report (savings + miss-rate + coverage)
bun run qa:coverage --strict   # ungated heavy tools → FAIL

# A/B kill-switch (OFF baseline for `qa --l2`):
TOOL_GATE_DISABLE=1 ...
```
