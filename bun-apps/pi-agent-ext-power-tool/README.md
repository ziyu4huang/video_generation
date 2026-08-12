# pi-agent-ext-power-tool

A **pi extension** for agent self-diagnostics — `inspect_agent`,
`inspect_context`, `inspect_extensions`, `inspect_hooks`, `inspect_pathology`. The `src/index.ts`
factory registers only these five tools (plus the `schema-cost` export and a
CLI subcommand).

## Feature surface

| Feature | Tool(s) / surface | Notes |
|---------|-------------------|-------|
| Diagnostics | `inspect_agent`, `inspect_context`, `inspect_extensions`, `inspect_hooks` | Static state diagnostics — documented ↓ |
| Failure pathology | `inspect_pathology` | Dynamic — detects retry loops / error storms / context saturation this session (F v1) |
| Schema-cost accounting | `./schema-cost` export | Static tool-token estimator (also a publishable package, `pi-schema-cost`) |
| CLI subcommand | `./extensions/cli-subcommand.ts` | Wired into `pi-agent` |

> **Extracted (2026-07, monolith split A1–A3):** `todo`+`/todos`+`/goal`+`goal_complete`
> → `pi-agent-ext-core-task` (#504); `ask_user_question` → `pi-agent-ext-ask-user`
> (#502, merged into `pi-agent-ext-core-task` 2026-07-18 — no shared code,
> relocated as the first step of the core-task pi-ext consolidation);
> `/btw` → `pi-agent-ext-btw` (#499). Knowledge tools left earlier for
> `pi-knowledge-card` (#351/#354).

> **Note:** the diagnostics below are this extension's full public surface.
> power-tool is once again a focused diagnostics package — the 2026-07 monolith
> split completed the extraction.

### Lazy-load evaluation (candidate D — not implemented)

The 3 `inspect_*` schemas cost ≈463 tokens total (context 108 + agent 120 +
extensions 235). A Tool-Search lazy dispatcher (1 `inspect` + `inspect_help`,
as flux2/ltx use) was considered but **not implemented**: the ~263-token saving
is modest against typical 10–30k tool budgets, and `inspect_*` are *diagnostic*
tools — hiding their params behind a help round-trip would hurt the
zero-round-trip self-diagnosis they exist to provide (unlike generation tools
where discovery cost is amortized). The descriptions are already lean.

## Diagnostic Tools

### `inspect_agent`

Dump agent state to YAML: extensions, tools, skills, context files, model, cwd.
Readable by humans and agents for debugging/analysis.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `output_dir` | string? | `output/pi` | Output directory (relative to cwd) |
| `filename` | string? | `inspect-agent-<timestamp>` | Output filename (without .yaml) |
| `return_content` | boolean? | `false` | Return YAML content instead of writing to file |

**Output format (YAML):**

```yaml
agent:
  app_name: pi
  cwd: /path/to/project
  timestamp: 2025-01-01T00:00:00Z
  mode: tui
  has_ui: true
  is_idle: true
  is_project_trusted: true

model:
  id: claude-sonnet-4-20250514
  name: Claude 4 Sonnet
  provider: anthropic
  reasoning: false
  context_window: 200000
  max_tokens: 16384
  input_types: [text, image]

context_usage:  # null if no context-usage reading is available yet
  tokens: 19924
  contextWindow: 200000
  percent: 10.0

tools:
  - name: inspect_context
    description: Full context window breakdown...
    parameters: {...}
    prompt_guidelines: []
    source:
      source: extension
      scope: user
      origin: top-level
      path: bun-apps/pi-agent-ext-power-tool/src/index.ts
      base_dir: null

skills:
  - name: find-skills
    description: Helps users discover...
    file_path: ~/.agents/skills/find-skills/SKILL.md
    base_dir: ~/.agents/skills/find-skills
    disable_model_invocation: false
    source:
      source: file
      scope: user
      origin: top-level

context_files:
  - path: CLAUDE.md
    chars: 16984
    estimated_tokens: 4590

guidelines:
  - Use bash for file operations...
  - Use read to examine files...

tool_snippets:
  read: "Read a file..."
  bash: "Execute bash commands..."
```

**Usage:**

```bash
# Default: write to <cwd>/output/pi/inspect-agent-<timestamp>.yaml
call inspect_agent

# Custom output directory
call inspect_agent output_dir="debug/state"

# Custom filename
call inspect_agent filename="my-session-state"

# Return YAML content to LLM instead of writing file
call inspect_agent return_content=true
```

**Working directory detection:**

Pi does not have a dedicated `CLAUDE_PROJECT_DIR` environment variable. Instead:
- **`ctx.cwd`** provides the current working directory in `ExtensionContext`
- All extension tools receive `ctx.cwd` indicating where pi was launched
- This is the project root for file operations

The output path is computed as `<ctx.cwd>/<output_dir>/<filename>.yaml`.

---

### `inspect_context`

Reports a full breakdown of what is consuming the context window before the agent even starts working.

**Output sections:**

| Section | What it measures |
|---|---|
| Live context window | Actual tokens used / context window + fill bar |
| System prompt total | Total chars + estimated tokens (chars ÷ 4) |
| Skills (top 3) | Each skill's formatted XML size, % of total skill block |
| Tools (top 3) | Each tool's schema + description + guidelines chars |
| Context files | Every loaded file (CLAUDE.md etc.) sorted by size |
| Guidelines | All `promptGuidelines` bullets from all active tools |
| Appended system prompt | Extra text appended by extensions |

The tool calls `getSystemPromptOptions()` and `getSystemPrompt()` on the execution context at runtime (`ctx.getSystemPromptOptions()`), then reports all sizes plus the live `ctx.getContextUsage()` reading. No `before_agent_start` snapshot needed — the SDK exposes this data via the tool execution context directly.

**Note:** `getAllTools()` is on `ExtensionAPI` (`pi` in the factory), not on `ExtensionContext` (`ctx` in `execute()`). The factory passes it into the tool via closure.

---

### `inspect_extensions`

Lints the **currently-loaded extensions, tools, skills, and prompt-guidelines** for potential issues — the diagnostic the other two tools don't provide. While `inspect_context` measures token distribution and `inspect_agent` dumps state, `inspect_extensions` flags concrete problems an extension author or maintainer should act on.

**Checks** (severity → id):

| Sev | Check | Flags |
|-----|-------|-------|
| 🔴 high | `duplicate-tool-name` | Same tool name registered from ≥2 sources (silent override / `Tool "x" conflicts`) |
| 🔴 high | `missing-description` | Tool with empty/whitespace description (model can't discover it) |
| 🟡 medium | `missing-snippet` | Tool absent from the Available-tools list (no `promptSnippet`) |
| 🟡 medium | `oversized-tool-schema` | Tool API schema (desc + params) above threshold — cost repeats every request |
| 🟡 medium | `oversized-skill` | Formatted skill above the char threshold |
| 🟡 medium | `oversized-context-file` | Context file (e.g. CLAUDE.md) above the char threshold |
| 🟢 low | `stale-guideline-ref` | A guideline references a backticked `` `tool` `` that isn't registered |
| ℹ️ info | `no-guidelines` | Non-builtin tool with zero `promptGuidelines` — **informational only** (guidelines are optional in the SDK and a context *cost*; not counted as an issue) |
| ℹ️ info | `extension-token-tax` | Per-extension est. tok/req (non-builtin tools, grouped by source) + total |

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `return_json` | boolean? | `false` | Return machine-readable `{findings, summary, total_extension_tokens}` JSON instead of a text report |
| `tool_token_threshold` | number? | `1500` | Flag tools whose API schema exceeds this many tokens |
| `skill_char_threshold` | number? | `2000` | Flag skills whose formatted size exceeds this many chars |
| `context_file_char_threshold` | number? | `20000` | Flag context files exceeding this many chars |

**Output:** a severity-ranked report (clean message when zero actionable issues) followed by an **Extension token tax** table showing which extension contributes the most token cost per request, sorted desc with a % bar.

**Usage:**

```bash
# Text report against the repo's own extensions (auto-loaded via run-dir):
bun bun-apps/pi-agent/src/cli.ts --model google/gemma-4-26b-a4b-qat \
  -p "call inspect_extensions"

# Machine-readable JSON:
# call inspect_extensions return_json=true

# Tighten thresholds to surface borderline cases:
# call inspect_extensions tool_token_threshold=800 context_file_char_threshold=10000
```

**What it found in this repo (real run):** pi-obsidian's 16 tools have no Available-tools snippets or `promptGuidelines`; `skill_manage` is over the schema threshold (1244 tok); pi-obsidian is the heaviest extension tax (~35%, 3237 tok/req) out of ~9,197 tok/req total across all non-builtin tools.

---

### `inspect_hooks`

Lists every loaded extension's registered `pi.on(...)` lifecycle hooks (which events each extension listens on, handler counts) and flags any handler registered against an unknown event name (likely a typo / dead handler). Fact-finder companion to `inspect_extensions`.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `by_event` | boolean? | `false` | Group hooks by event instead of by extension |
| `return_json` | boolean? | `false` | Return machine-readable JSON instead of a text report |
| `self_test` | boolean? | `false` | Run built-in self-test and report results |

**Output:**

- **By extension (default):** For each loaded extension, shows the events it listens on and handler counts per event
- **By event (`by_event=true`):** Groups all hooks by event name, showing which extensions subscribe to each
- **Unknown event detection:** Medium-severity finding for any handler registered against an event not in the known event set

**Usage:**

```bash
# Default: show hooks grouped by extension
call inspect_hooks

# Group by event to see which extensions listen to each event
call inspect_hooks by_event=true

# Machine-readable JSON
call inspect_hooks return_json=true

# Run self-test
call inspect_hooks self_test=true
```

**Design notes:** Reads the aggregated `runner.extensions[].handlers` via a `getHooks()` polyfill on `sdk-patch.ts`'s `createContext` wrapper. Phase 2 (future): add firing counts and `never-fired` detection.

---

### `inspect_pathology`

Diagnoses **how the agent is failing this session** — the dynamic complement to
the three static `inspect_*` tools above. While they answer "what is loaded?" /
"where do tokens go?", `inspect_pathology` answers "why am I stuck / repeating /
erroring?" by analyzing recent tool-call history accumulated this session.

A factory-registered hook observes every `tool_execution_start` / `tool_execution_end`
into a bounded ring buffer (reset each `session_start`). At call time the tool
runs three **deterministic, signal-driven** detectors (the highest-impact, most-
detectable modes per the failure-pathology literature) and renders a severity-
ranked report reusing the `inspect_extensions` Severity framework.

**Detectors (v1)** (severity → id):

| Sev | Check | Flags |
|-----|-------|-------|
| 🔴 high | `retry-loop` | Identical (tool + args) repeated ≥ N× within a rolling window — the agent retrying the same call without updating strategy |
| 🔴 high | `consecutive-error` | A tool failing ≥ K× in a row (rage-quit / strategy not updated) |
| 🟡 medium | `error-storm` | A tool whose error rate ≥ threshold with enough calls — chronic failure |
| 🟡 medium | `context-saturation` | Context window fill ≥ percent threshold — recall / quality-degradation risk in long sessions |
| 🟡 medium | `long-session-recall-risk` | Completed turns ≥ threshold (default 15) — deterministic proxy for goal-drift / context-loss risk (studies show ~15–30% recall drop >10 turns) |
| ℹ️ info | `session-stats` | Call/error/tool counts — awareness only, never actionable |

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `return_json` | boolean? | `false` | Return `{findings}` JSON instead of a text report |
| `loop_repeat_threshold` | number? | `3` | Identical (tool+args) repeats at/above this → retry loop |
| `error_rate_threshold` | number? | `0.5` | Per-tool error rate at/above this → error storm |
| `saturation_percent` | number? | `85` | Context fill at/above this → saturation |

**Design notes:** the detector (`analyzePathology`) is a **pure function** over a
typed `PathologyInput` — fully unit-tested without the SDK or accumulator. The
hook-fed accumulator mirrors the core-task pattern already proven in this repo.

**Proactive warning (Phase 1.1):** in addition to the on-demand tool, the
`tool_execution_end` hook re-runs the detector after every call and, when a
**high-severity** pattern (retry-loop or consecutive-error) is active, surfaces
a non-invasive **status-line** warning via `ctx.ui.setStatus` — `⚠ retry loop:
bash ×3 — call inspect_pathology`. No context injection, no turn hijack (it is
just a status bar line, like the git-branch indicator). Dedup'd per (check, tool)
signature (warns once per active episode, re-warns on recurrence). Medium modes
(error-storm, saturation) stay on-demand only. Silently no-ops in print mode
(no UI).

**Scope note (v2):** v2 ships DETERMINISTIC only — the long-session recall-risk detector above. The true LLM-judged modes (exact goal-drift via reasoning comparison, silent quality-degradation trend) need a runtime LLM-as-judge call, which this repo's `--offline` zero-network-egress discipline rules out for a diagnostic — they remain a future architectural step (must respect offline mode: local model only).

## Usage

```bash
# One-shot diagnostic (no TUI)
bun bun-apps/pi-agent/src/cli.ts \
  -e bun-apps/pi-agent-ext-power-tool/src/index.ts \
  -p "call inspect_context"

# With another extension to see its contribution
bun bun-apps/pi-agent/src/cli.ts \
  -e bun-apps/pi-agent-ext-power-tool/src/index.ts \
  -e bun-apps/some-other-ext/src/index.ts \
  -p "call inspect_context"

# Interactive TUI session
bun bun-apps/pi-agent/src/cli.ts \
  -e bun-apps/pi-agent-ext-power-tool/src/index.ts
# then type: call inspect_context
```

## Layout

```
pi-agent-ext-power-tool/
├── package.json          # @repo/pi-agent-ext-power-tool
├── extensions/
│   └── cli-subcommand.ts  # pi-agent subcommand wiring
├── docs/                  # extension-analyzer / schema-cost / ui-conventions
└── src/
    ├── index.ts           # ExtensionFactory — registers ALL features below
    ├── sdk-patch.ts        # getSystemPromptOptions() shim on tool ctx
    ├── schema-cost/        # static tool-token estimator (exported; publishable)
    └── pathology/          # inspect_pathology — failure-pattern detection (F v1)
        ├── types.ts        #   ToolCallRecord, PathologyInput
        ├── detector.ts     #   analyzePathology() — PURE (retry-loop / error-storm / saturation)
        ├── format.ts       #   formatPathologyReport() — PURE
        ├── accumulator.ts  #   hook-fed bounded call buffer (tool_execution_start/end)
        └── index.ts        #   makeInspectPathologyTool() + re-exports
```

## Testing

```bash
./run-test.sh                  # medium (default): unit + typecheck
./run-test.sh quick            # unit only, no typecheck
./run-test.sh high             # + PI_RUN_L2=1 (blocked services SKIP)
./run-test.sh readonly         # PI_RUN_L2=1, l2-e2e.test.ts only (skip allowed)
./run-test.sh full             # + PI_REQUIRE_L2=1 (blocked services FAIL, not skip)
./run-test.sh --list           # print the tier table
```

`high`/`full` spawn the real `pi-agent` CLI and call a real LM Studio model
(`google/gemma-4-26b-a4b-qat` by default, override via `PI_L2_MODEL`).
There is no standalone "real CLI, no model" tier: invoking a tool
through the CLI always triggers model inference, so `high` and `full` run the
same suite and differ only in whether a blocked service skips (`high`) or
fails (`full`) the run. See `src/__tests__/l2-e2e.test.ts` for the per-tool
gate list.

## What the numbers mean

A fresh default pi session in this repo uses **~19,924 tokens (~10.0% of 200k)** before any conversation.
The system prompt alone is **~9,242 tokens** (34,194 chars):

```
CLAUDE.md         16,984 chars   ~4,590 tok   (50% of system prompt)
Guidelines        12,058 chars   ~3,259 tok   (all tool promptGuidelines bullets)
Skills              1,613 chars     ~436 tok
+ base pi prompt + tool snippets + tool schemas in API call
─────────────────────────────────────────────────────────
Total context:    ~19,924 tok    (~10.0% of 200k)
```

Top offenders (from a real run):

| Component | Chars | Est. tokens |
|---|---|---|
| CLAUDE.md | 16,984 | 4,590 |
| All guidelines (53 bullets) | 12,058 | 3,259 |
| `workflow` tool guidelines alone | 7,344 | 1,985 |
| `skill_manage` tool | 5,369 | 1,451 |
| `ask_user_question` tool | 5,000 | 1,351 |
| All skills | 1,613 | 436 |
