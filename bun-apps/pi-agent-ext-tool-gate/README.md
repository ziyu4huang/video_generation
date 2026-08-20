# Dynamic Tool Gate

> Keeps core tools always active while gating heavy domain-specific tools behind prompt keyword matching — saving ~15,186 tokens per request (~69%; the ~15,186 gross claim is the single source of truth in `qa/savings.ts` — locked to measured reality by a ±20% deviation-band test; figures drift as the gate set changes — re-run `bun run qa:savings` for live numbers; zai-mcp adds ~1.1k when registered).

## The Problem

Every registered tool adds to the API request's tools schema. With a full extension ecosystem loaded, a single pi session can carry **~72 tools → ~21,950 tokens per request** — a fixed overhead charged on every turn, even when 95% of those tools are never used.

This extension solves that by keeping lightweight core tools always active and hiding heavy domain-specific tools (video generation, image generation, movie orchestration, etc.) behind keyword gates. When the user's prompt mentions a relevant keyword, the matching gate fires instantly and the tool becomes available for the rest of the session.

```
Baseline:  ~72 tools → ~21,950 tok/req   (measured via `bun run qa`)
Gated:    ON at start ~6,750 tok/req   (saves ~15,186 tok/turn gross, ~69%; **net ~14,900** after the ~309 tok `enable_tool` escape-hatch overhead — audit I-6; zai-mcp env-gated)
```

> Figures are measured by `bun run qa` (power-tool `schema-cost`). Only
> `zai-mcp` (~1.1k tok) is env-gated — it loads only when `ZAI_API_KEY` is set,
> so the default run is a slight lower bound. Re-run `bun run qa` after changing
> the gate set for live numbers.

## How It Works

### Three concepts

| Concept | Description |
|---|---|
| **GATE_DEFS** | The shared gate registry (`@repo/pi-agent-core-interface` `GATE_DEFS`). Each owning extension declares its gate **family once by id** (`{ id, keywords?, requires?, description }`); every tool in the family references it via `gating: { gate: "<id>" }` on its `ToolDefinition`. Sibling co-firing = same id (no per-tool keyword duplication). |
| **Core** | Tools whose `gating: { core: true }` makes them **always active** — file I/O, memory, search, user interaction, diagnostics. These never gate. |
| **sticky** | A `Set<string>` accumulator, one per session (keyed by `sessionManager.getSessionId()`). Starts as a copy of the core set. When a gate fires, its tool names are added to `sticky`. Once added, they **never leave** — tools are sticky for the entire session. |

### The per-turn pipeline

The full gate-set build (discover tools → `buildEffectiveGates` → measure token costs) runs **once at session start**. Each turn is fire + filter only:

```
User prompt arrives
      │
      ▼
┌─────────────────┐
│  updateSticky()  │  Mutation: fire any gates whose keywords/co-occurrence
│                  │  match the prompt → add tool names to `sticky`
└────────┬─────────┘
         │
         ▼
┌─────────────────┐
│  filterActive()  │  Pure: filter allToolNames → keep if NOT tracked
│                  │  (fail-open) OR if in `sticky`
└────────┬─────────┘
         │
         ▼
   pi.setActiveTools(active)
```

**Fail-open design**: any tool not explicitly tracked by this extension (not core and not in any gate) is always active. This ensures new tools from other extensions are never accidentally hidden.

### Sticky activation — why tools never re-gate

A gate that fires once stays active for the rest of the session. This is deliberate:

> A workflow using `flux2` must not lose the tool mid-task just because a follow-up prompt like *"make it bigger"* doesn't repeat the trigger keyword.

Once you've shown intent to use a domain tool, the gate trusts you and keeps it available.

## Architecture (post-refactor)

The core is a **first-class, auditable gating contract** (wayfinder ticket 01, expand–contract completed): gates live in the shared `GATE_DEFS` registry keyed by id; `buildEffectiveGates` resolves every tool's `gating: { gate: id }` reference into one multi-name family gate per id (fingerprint reconstruction and the inline keywords/requires form were deleted in 01c).

| Function | Type | Responsibility |
|---|---|---|
| `buildEffectiveGates(defs, gateDefs)` | **Pure** | Resolve owner-declared `gating` → `{ gates, core, tracked }`. Reference form only since 01c |
| `updateSticky(prompt, sticky, gates)` | **Mutate** | Evaluate gates against the prompt; add matching tool names to `sticky` |
| `filterActive(allToolNames, sticky, tracked)` | **Pure** | Filter the full tool list to the active set; fail-open for untracked tools |
| `matchIntent(intent, gates, sticky)` | **Pure** | Find dormant gates matching a natural-language intent (used by `enable_tool`) |
| `gateFires(gate, promptLower)` | **Pure** | Does a gate fire? (keyword match OR co-occurrence) |
| `matchesKeyword(keyword, promptLower)` | **Pure** | Does a keyword appear in the prompt? (word-boundary vs substring) |

**Why split?** `enable_tool` only needs to filter the tool list — it should not re-evaluate gate keywords against a stale prompt (which could silently activate unrelated gates). The split lets `enable_tool` call `filterActive` directly.

**Per-session state (ticket 05):** each session (parent or in-process subagent child) owns an independent gate state keyed by `sessionManager.getSessionId()`; a child that skips `session_start` seeds its own on first `before_agent_start`. `session_shutdown` drops the state.

## Gate Configuration

Gate families are declared **in each owning extension** (`GATE_DEFS["flux2"] = {...}` at the extension's module top-level), not in tool-gate. The full registry is visible via `enable_tool({list})` or power-tool's `inspect_context` "▶ Tool gate (live state)" section (which reads tool-gate's `__piToolGateStatus` seam — per-gate fired/dormant + token cost + sticky).

Current families (each declared once by id; all tools in a family reference it):

| Gate id | Tools | Co-occurrence |
|---|---|---|
| flux2 | `flux2`, `flux2_help` | `nouns` ∩ `verbs` |
| krea2 | `krea2`, `krea2_help` | — |
| ltx | `ltx`, `ltx_help` | `nouns` ∩ `verbs` |
| file2md | `file2md`, `vision_ask` | `nouns` ∩ `verbs` |
| workflow | `workflow`, `workflow_help`, `workflow_control`, `subagent`, `subagents` | — (cross-package: workflow + subagent) |
| collect_videos | `collect_videos`, `organize_vault_notes`, `import_memory_to_vault` | — |
| arxiv | `arxiv_search`, `arxiv_fetch2md`, `arxiv_paper` | `nouns` ∩ `verbs` |
| movie | `movie`, `movie_help` | `nouns` ∩ `verbs` |
| zai | `zai_web_search_web_search_prime`, `zai_web_reader_webReader` | `nouns` ∩ `verbs` |
| deploy_pi_agent_sh | `deploy_pi_agent_sh`, `verify_pi_agent_deploy` | `nouns` ∩ `verbs` |
| merge_pr_after_local_ci / sweep_merged_branches / run_local_ci / check_main_health / sync_default_branch / run_devops_retrospect / prepare_feature_branch / verify_merge_landed | devops single-tool gates | — |
| zk_card / zk_ask / zk_ingest / knowledge_query | knowledge-card on-demand | `nouns` ∩ `verbs` |
| skill_manage / session_search / knowledge_search / knowledge_ingest / planning_stale / grill_decision / memory_supersede | hermes-memory on-demand | varies |
| wayfind_effort | wayfind | `nouns` ∩ `verbs` |
| get_search_content | web-access | `nouns` ∩ `verbs` |
| obsidian | `obsidian`, `obsidian_help` | `nouns` ∩ `verbs` |

The six `inspect_*` diagnostics (context/agent/extensions/hooks/pathology/tui) were **un-gated to core in ticket 06** — they are always-on so the agent can reach them exactly when something is wrong.

### Co-occurrence gating (`requires`)

Some core nouns like *image*, *video*, and *pdf* false-fire on common phrases ("docker image", "video call") but must survive on real intents ("generate an image", "make a video"). These gates use a **co-occurrence** trigger: the gate fires only when the prompt contains **≥1 noun AND ≥1 verb** from the `requires` lists.

```typescript
GATE_DEFS["flux2"] = {
  id: "flux2",
  keywords: ["flux", "t2i", "圖像", ...],
  requires: {
    nouns: ["image", "picture", "photo", "圖"],
    verbs: ["generate", "create", "make", "draw", "render", ...],
  },
  description: "FLUX.2 image generation",
};
```

Gates whose keywords are already narrow enough (krea2, workflow, etc.) skip `requires` entirely.

### Keyword matching rules

| Keyword type | Match strategy | Example |
|---|---|---|
| Single ASCII token (`^[a-z0-9]+$`) | **Word-boundary** regex | `flux` matches "use flux" but NOT "conflux" |
| Multi-word phrase or CJK | **Substring** | `生成圖` matches inside any prompt containing it |

Keywords are matched case-insensitively. CJK phrases use substring because Unicode word boundaries require a segmenter.

## enable_tool — the escape hatch

`enable_tool` is **always active** (it's a core tool) and lets the agent manually activate a dormant gate when keyword matching misses:

| Mode | Parameter | Behavior |
|---|---|---|
| **Intent** | `intent: "make a video"` | Runs `matchIntent` → activates the matching gate |
| **Name** | `name: "ltx"` | Activates the gate containing that exact tool name |
| **List** | `list: true` | Returns all currently dormant gates with their keywords |

```text
User: "orchestrate a montage of these scenes"
Agent: (no movie keyword fired)
       → calls enable_tool({ intent: "orchestrate a montage" })
       → movie gate activates
       → proceeds to use the movie tool
```

If the requested gate is already active, `enable_tool` reports `'already active'` instead of misleadingly claiming activation.

## Configuration (environment variables)

Telemetry is **opt-in** (silent by default):

| Variable | Effect |
|---|---|
| `TOOL_GATE_LOG=1` | Emit JSONL telemetry to **stderr** |
| `TOOL_GATE_LOG_PATH=/path/to/log.jsonl` | Write JSONL telemetry to a **file** |
| `TOOL_GATE_DEBUG_BANNER=1` | Show the startup banner immediately (skip 5s delay) + mirror to stderr |

### Telemetry event types

| Kind | When emitted | Key fields |
|---|---|---|
| `turn` | Every `before_agent_start` | `gatesFired`, `dormantGates`, `activeCount`, `savedTok` |
| `activate` | `enable_tool` is called | `via` (name/intent), `matchedGate`, `activated` |
| `miss_candidate` | A turn with no gate fired but ≥1 dormant gate exists | `dormantGates`, `promptHead` (first 80 chars) |

The `miss_candidate` event quantifies the dormant-tool miss rate — making the escape-hatch risk measurable instead of invisible.

## Startup banner

On session start, a transient above-editor widget (keyed `"tool-gate"`) shows the active/gated ratio and estimated savings:

```
🔧 Tool gate: 45/72 active
saves ~15186 tok/req
```

The banner uses `setWidget` (not `notify`) so it never clobbers or is clobbered by other extensions' startup messages. It auto-dismisses after 8 seconds.

## Adding a new gate

The gate contract is **owner-declared** — each extension declares its family once in the shared `GATE_DEFS` registry and references it from its tools. To gate a new tool:

1. **Declare the family** in your extension's module (top-level side effect, next to the tool):

```typescript
import { GATE_DEFS } from "@repo/pi-agent-core-interface";

GATE_DEFS["my_tool"] = {
  id: "my_tool",
  keywords: ["my tool", "special keyword", "特定詞"],
  // Optional: add co-occurrence if your keywords are broad nouns
  requires: {
    nouns: ["thing"],
    verbs: ["do", "make"],
  },
  description: "What this tool does — used for enable_tool matching + list output",
};
```

2. **Reference it from each tool** in the family: `gating: { gate: "my_tool" }` on the `ToolDefinition`. Sibling tools share one id — edit the family once, all tools follow.

3. **Do NOT use `gating: { core: true }`** unless the tool must be always-active (file I/O, memory, HITL interaction, diagnostics). Core tools are never gated.

4. **Test keyword precision**: verify your keywords don't false-fire on common phrases. If a bare noun like "image" over-matches, use `requires` co-occurrence instead.

5. **Add probes**: a `__GATE_PROBES__` export (gate-recall) + must-fire/must-not-fire corpus cases in `qa/probes.ts`, so `qa:gate-recall` and `qa --strict` cover the new gate.

6. **Run tests**:
```bash
bun test --cwd bun-apps/pi-agent-ext-tool-gate
```

## Core tools (always active)

The always-active core was **re-triaged in ticket 02** (14 on-demand tools demoted to gates) + **ticket 06** (diagnostics un-gated). Current core:

```
read, write, edit, bash           — file I/O & shell (injected builtins)
enable_tool                        — escape hatch for dormant gates
ask_user_question                  — HITL interaction
memory, memory_search              — persistent memory
todo, goal_complete                — task & goal tracking
web_search, fetch_content          — web access
inspect_context, inspect_agent, inspect_extensions,   — diagnostics (ticket 06)
inspect_hooks, inspect_pathology, inspect_tui          — always-on on purpose
```

Demoted to on-demand gates in ticket 02: `zk_card`, `zk_ask`, `zk_ingest`, `knowledge_query`, `wayfind_effort`, `skill_manage`, `session_search`, `knowledge_search`, `knowledge_ingest`, `planning_stale`, `grill_decision`, `get_search_content`, `obsidian`, `obsidian_help`.

## Testing

```bash
# Run all tests
bun test --cwd bun-apps/pi-agent-ext-tool-gate

# Key test files:
#   extensions/tool-gate.test.ts          — core logic (filterActive, updateSticky, gateFires)
#   __tests__/tool-gate-banner.test.ts     — startup banner + telemetry
```

## QA

### Savings (`qa/savings.ts`)

Validates the "~15,186 tok/req saved" claim by measuring the actual token cost difference between the ungated baseline and the gated configuration. Uses the same schema-cost measurement as the runtime telemetry (`(desc+params)/4` heuristic) to ensure offline and runtime numbers agree by construction.

```bash
bun run qa:savings     # standalone, shows per-gate breakdown
bun run qa              # savings included in full QA report
```

Reports total tokens saved, percentage saved, and a per-gate breakdown of which gates contribute how much. Flags any tools loaded at runtime but missing from the manifest (`gateMissing`). Since 2026-07-25 (audit I-6) it also reports **net** savings (gross minus the measured `enable_tool` overhead) plus the ~55 tok `promptSnippet`+`promptGuidelines` residual, so the always-on price of the escape hatch is visible and drift-detectable (future guideline bloat shows up as a falling net).

### Miss-rate (`qa/miss-rate.ts`)

Measures keyword recall in practice by parsing `TOOL_GATE_LOG_PATH` telemetry (turn / miss_candidate / activate events). Computes two lenses:

- **escape-rate** (headline friction): `enable_tool` calls vs gated-domain sessions
- **confirmed-miss** (gate-causation): a `miss_candidate` turn followed by an `activate` whose matched gate was dormant at that turn

Confirmed-misses are classified as **common** (intent matched gate's design — bare keyword or noun∧verb co-occurrence) or **review** (intent unclear, requires human judgment).

```bash
bun run qa:miss <log-file>     # analyze telemetry log
bun run qa:miss --json <log-file>   # machine-readable output
```

### Coverage (`qa/coverage.ts`)

A third QA axis — **structural completeness** — alongside savings (amount) and miss-rate (recall). It answers: *which registered tools are heavy (≥ threshold tok/req) but NOT tracked by any gate — i.e. candidates the author forgot to gate?*

A forgotten gate is safe (fail-open keeps the tool always-active) but silently degrades savings. This check closes the loop: schema-cost measures → coverage finds the ungated heavy → author adds a gate → savings confirms the recovery.

```bash
bun run qa:coverage                       # standalone, advisory (never fails)
bun run qa:coverage --coverage-threshold 200   # tighten the threshold for a run
bun run qa                                # coverage reported, non-gating by default
bun run qa --strict                       # ungated heavy tools → FAIL
```

Default threshold **300 tok/req** (`--coverage-threshold` overrides). Builtins are excluded (they cannot be gated). The verdict is **non-gating by default**; under `--strict`, any ungated heavy tool fails the gate.

## Installation

Registered as a dynamic extension in `bun-apps/pi-agent/run-dir/manifest.json`. No manual setup needed — the extension auto-loads on session start.
