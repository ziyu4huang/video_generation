# Dynamic Tool Gate

> Keeps core tools always active while gating heavy domain-specific tools behind prompt keyword matching — saving ~16,290 tokens per request (~74%; the ~16,290 gross claim is the single source of truth in `qa/savings.ts` — locked to measured reality by a ±20% deviation-band test; figures drift as the gate set changes — re-run `bun run qa:savings` for live numbers; zai-mcp adds ~1.1k when registered).

## The Problem

Every registered tool adds to the API request's tools schema. With a full extension ecosystem loaded, a single pi session can carry **~72 tools → ~21,900 tokens per request** — a fixed overhead charged on every turn, even when 95% of those tools are never used.

This extension solves that by keeping lightweight core tools always active and hiding heavy domain-specific tools (video generation, image generation, movie orchestration, etc.) behind keyword gates. When the user's prompt mentions a relevant keyword, the matching gate fires instantly and the tool becomes available for the rest of the session.

```
Baseline:  ~72 tools → ~21,900 tok/req   (measured via `bun run qa`)
Gated:    ON at start ~5,700 tok/req   (saves ~16,290 tok/turn gross, ~74%; **net ~15,980** after the ~312 tok `enable_tool` escape-hatch overhead — audit I-6; zai-mcp env-gated)
```

> Figures are measured by `bun run qa` (power-tool `schema-cost`). Only
> `zai-mcp` (~1.1k tok) is env-gated — it loads only when `ZAI_API_KEY` is set,
> so the default run is a slight lower bound. Re-run `bun run qa` after changing
> the gate set for live numbers.

## How It Works

### Three concepts

| Concept | Description |
|---|---|
| **CORE_TOOLS** | A set of lightweight tools that are **always active** — file I/O, memory, search, user interaction, vault access. These never gate. |
| **GATES** | An array of tool groups. Each gate has `names` (the tools it controls), `keywords` (trigger words), and an optional `requires` co-occurrence rule. |
| **sticky** | A `Set<string>` accumulator. Starts as a copy of `CORE_TOOLS`. When a gate fires, its tool names are added to `sticky`. Once added, they **never leave** — tools are sticky for the entire session. |

### The per-turn pipeline

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

**Fail-open design**: any tool not explicitly tracked by this extension (not in `CORE_TOOLS` and not in any gate) is always active. This ensures new tools from other extensions are never accidentally hidden.

### Sticky activation — why tools never re-gate

A gate that fires once stays active for the rest of the session. This is deliberate:

> A workflow using `flux2` must not lose the tool mid-task just because a follow-up prompt like *"make it bigger"* doesn't repeat the trigger keyword.

Once you've shown intent to use a domain tool, the gate trusts you and keeps it available.

## Architecture (post-refactor)

The original monolithic `computeActiveTools()` was split into two functions with clear separation of concerns:

| Function | Type | Responsibility |
|---|---|---|
| `updateSticky(prompt, sticky)` | **Mutate** | Evaluate gates against the prompt; add matching tool names to `sticky` |
| `filterActive(allToolNames, sticky)` | **Pure** | Filter the full tool list to the active set; fail-open for untracked tools |
| `matchIntent(intent, gates, sticky)` | **Pure** | Find dormant gates matching a natural-language intent (used by `enable_tool`) |
| `gateFires(gate, promptLower)` | **Pure** | Does a gate fire? (keyword match OR co-occurrence) |
| `matchesKeyword(keyword, promptLower)` | **Pure** | Does a keyword appear in the prompt? (word-boundary vs substring) |

**Why split?** `enable_tool` only needs to filter the tool list — it should not re-evaluate gate keywords against a stale prompt (which could silently activate unrelated gates). The split lets `enable_tool` call `filterActive` directly.

## Gate Configuration

The current gate definitions (`GATES` array in `extensions/tool-gate.ts`):

| Gate | Tools | Keywords (sample) | Co-occurrence | Description |
|---|---|---|---|---|
| **flux2** | `flux2`, `flux2_help` | flux, t2i, 圖像, 生成圖, 去背 | `nouns` ∩ `verbs` | Flux2 image generation — t2i, i2i, faceswap, outpaint, upscale |
| **krea2** | `krea2`, `krea2_help` | krea, 草圖, 快速生成 | *(none — keywords are narrow enough)* | Krea2 fast image generation — real-time draft to image |
| **ltx** | `ltx`, `ltx_help` | ltx, t2v, i2v, vbvr | `nouns` ∩ `verbs` | LTX video generation — t2v, i2v, upscale, vbvr |
| **file2md** | `file2md`, `vision_ask` | file2md, ocr, caption, 識別 | `nouns` ∩ `verbs` | Document/image understanding — file→markdown, VLM, OCR |
| **inspect** | `inspect_context`, `inspect_agent`, `inspect_extensions`, `inspect_pathology`, `inspect_tui` | schema cost, pathology, extension health | `nouns` ∩ `verbs` | Agent/extension introspection |
| **workflow** | `workflow`, `workflow_help`, `subagent`, `workflow_control` | workflow, pipeline, orchestrate | *(none)* | Multi-agent fan-out/pipeline orchestration |
| **research** | `collect_videos`, `organize_vault_notes`, `import_memory_to_vault` | bilibili, youtube, 收集影片 | *(none)* | Research — collect videos, organize vault |
| **movie** | `movie`, `movie_help` | montage, storyboard, 分鏡, 剪輯 | *(none)* | Movie orchestrator — idea→script→scene→edit pipeline |
| **zai-mcp** | `zai_web_search_web_search_prime`, `zai_web_reader_webReader` | zai search, zai reader | *(none)* | Z.ai MCP web tools (redundant with core web_search/fetch_content) |
| **arxiv** | `arxiv_search`, `arxiv_fetch2md`, `arxiv_paper` | arxiv, 論文 | `nouns` ∩ `verbs` | ArXiv paper retrieval — search, fetch-to-markdown |
| **cost** | `cost` | 成本估算, cost estimate | `nouns` ∩ `verbs` | Movie-production cost lifecycle — estimate/reserve/reconcile |
| **pi_deploy** | `pi_deploy`, `pi_verify` | build bundle, bundle pi-agent | `nouns` ∩ `verbs` | Build/verify/deploy the pi-agent bundle |

### Co-occurrence gating (`requires`)

Some core nouns like *image*, *video*, and *pdf* false-fire on common phrases ("docker image", "video call") but must survive on real intents ("generate an image", "make a video"). These gates use a **co-occurrence** trigger: the gate fires only when the prompt contains **≥1 noun AND ≥1 verb** from the `requires` lists.

```typescript
{
  names: ["flux2", "flux2_help"],
  keywords: ["flux", "t2i", "圖像", ...],
  requires: {
    nouns: ["image", "picture", "photo", "圖"],
    verbs: ["generate", "create", "make", "draw", "render", ...],
  },
}
```

Gates whose keywords are already narrow enough (krea2, workflow, research, movie, zai-mcp, pi_deploy) skip `requires` entirely.

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
🔧 Tool gate: 24/52 active
saves ~9800 tok/req
```

The banner uses `setWidget` (not `notify`) so it never clobbers or is clobbered by other extensions' startup messages. It auto-dismisses after 8 seconds.

## Adding a new gate

1. **Add a `ToolGate` entry** to the `GATES` array in `extensions/tool-gate.ts`:

```typescript
{
  names: ["my_tool", "my_tool_help"],
  keywords: ["my tool", "special keyword", "特定詞"],
  // Optional: add co-occurrence if your keywords are broad nouns
  requires: {
    nouns: ["thing"],
    verbs: ["do", "make"],
  },
  description: "What this tool does — used for enable_tool matching + list output",
}
```

2. **Do NOT add the tool names to `CORE_TOOLS`** — that defeats the gate.

3. **`TRACKED_TOOLS` updates automatically** — it's computed from `CORE_TOOLS ∪ GATES`.

4. **Test keyword precision**: verify your keywords don't false-fire on common phrases. If a bare noun like "image" over-matches, use `requires` co-occurrence instead.

5. **Run tests**:
```bash
bun test --cwd bun-apps/pi-agent-ext-tool-gate
```

## Core tools (always active)

```
read, write, edit, bash           — file I/O & shell
todo, goal_complete                — task & goal tracking
memory, memory_search              — persistent memory
session_search                     — past session search
ask_user_question                  — user interaction
enable_tool                        — escape hatch for dormant gates
skill_manage                        — procedural skills
grill_decision                      — grilling decision capture
obsidian, obsidian_help            — vault I/O
zk_card, zk_ask, zk_ingest         — Zettelkasten knowledge graph
knowledge_query                    — knowledge graph query
web_search, fetch_content          — web access
get_search_content                 — retrieve stored search results
```

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

Validates the "~16,290 tok/req saved" claim by measuring the actual token cost difference between the ungated baseline and the gated configuration. Uses the same schema-cost measurement as the runtime telemetry (`(desc+params)/4` heuristic) to ensure offline and runtime numbers agree by construction.

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
