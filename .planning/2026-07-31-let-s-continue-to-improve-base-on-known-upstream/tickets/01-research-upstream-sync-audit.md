---
type: research
blocked by: []
status: closed
resolved: 2026-07-31 (9 upstream-sync candidates surfaced; pi 0.83.0 confirmed latest)
---

# 01 — Upstream-pi sync audit (subagent + workflow)

## Question

What capabilities in **pi core** (`@earendil-works/pi-coding-agent`, 0.83.0
installed — and any release **newer** than 0.83.0) do `pi-agent-ext-subagent` and
`pi-agent-ext-workflow` **under-use or lag**?

## Resolution (researched 2026-07-31, branch behind:0)

**Method.** Read installed pi-core `@earendil-works/pi-coding-agent@0.83.0`:
`README.md`, `CHANGELOG.md`, `docs/extensions.md` (full), `docs/sdk.md`,
`docs/models.md`, `docs/environment-variables.md`, `examples/extensions/`. Grepped
both extensions' `src/`+`extensions/` for every `pi.*`/`ctx.*`/SDK API call,
TypeBox enum patterns, event subscriptions, `customType` messages. Used PR #949
(0.83.0 `ResourceLoader` change) as the reference parity-gap shape.

**Release newer than 0.83.0? — NO.** `npm view @earendil-works/pi-coding-agent
version` → `0.83.0`; installed `CHANGELOG.md` first entry is `## [0.83.0] -
2026-07-29`. All gaps below are surfaces **already exposed in 0.82–0.83 that these
extensions under-use**, not newer-release additions.

### Candidates (axis: `upstream-sync`)

1. **`constrainedSampling` not set on `structured_output`.** pi surface:
   `Tool.constrainedSampling ("prefer"|"require")` + capability flags
   `supportsStrictTools`/`supportsOpenAIGrammarTools` (0.82.0 changelog). Current:
   `structured-output.ts:27` `defineTool({...})` omits it — validity enforced via
   schema validation + `maxSchemaRetries` repair loop (`agent.ts`). Shape: set
   `constrainedSampling:"prefer"` so final calls guarantee schema conformance on
   Sonnet/Opus/GPT-5+/Gemini, shrinking the retry path.
2. **`Type.Union([Type.Literal])` → `StringEnum` (Google/Gemini compat).** pi
   surface: `docs/extensions.md` mandates `StringEnum` from `@earendil-works/pi-ai`
   ("`Type.Union`/`Type.Literal` do not work on Google's API"). Current: **18
   sites** use the union form — `subagent-runs-tool.ts:16,20`, `subagent-tool.ts:131`,
   `watchdog/model-review.ts:10`, `workflow-control-tool.ts:17–23`,
   `workflow-tool.ts:117+` (×6). Routing a sub/workflow agent to a Gemini model
   breaks these tool schemas. Shape: mechanical `StringEnum([...])` swap.
3. **`ctx.scopedModels` (0.83.0) ignored by model-tier picker.** pi surface:
   `ctx.scopedModels` (0.83.0, changelog #7191/#7215) — "use it to populate a
   picker instead of enumerating the whole catalog." Current:
   `/workflows-models` (`workflows-models-command.ts:36–44`) and
   `WorkflowAgent.getRegistry()` (`agent.ts:249–260`) use
   `registry.getAvailable()` (full catalog) — a parent dialog with `--models
   anthropic/*:high` / `enabledModels` still offers/routes out-of-scope models.
   Shape: honor `ctx.scopedModels` in the picker + propagate into
   `WorkflowAgent.resolveModel`.
4. **`model_select` event not subscribed → stale main-model tracking.** pi
   surface: `model_select` event ("fires when user switches via `/model` or
   Ctrl+P"). Current: main model captured once at `session_start`
   (`workflow.ts:156`, `subagent.ts:97`); subscriptions are `before_agent_start`×3,
   `input`×1, `session_start`×2, `turn_end`×1 — **no `model_select`**. A mid-session
   `/model` switch leaves tier-fallback bound to the original model. Shape:
   `pi.on("model_select", ...)` to keep fallback live.
5. **`event.systemPromptOptions` ignored in `before_agent_start`.** pi surface:
   `before_agent_start` carries `systemPromptOptions.{selectedTools,toolSnippets,
   promptGuidelines,appendSystemPrompt,contextFiles,skills,customPrompt}`. Current:
   `workflow.ts:87` reads only `prompt`+`systemPrompt`; both files carry comments
   complaining `getSystemPromptOptions().selectedTools` lags `setActiveTools()`
   (`subagent.ts:66`, `workflow.ts:115`) and blindly re-enable every turn. Shape:
   read `selectedTools`, re-enable only when actually missing (or append via
   `appendSystemPrompt`).
6. **`pi.appendEntry()` + `registerEntryRenderer()` unused for TUI-only cards.** pi
   surface: persistent/TUI-only entries that DON'T join LLM context. Current: all
   completion/progress reports go via `pi.sendMessage({customType,...,display:true})`
   (**10 customTypes**, all in LLM context) — zero `appendEntry`/renderer calls.
   Shape: move completion/progress cards to `appendEntry` so they stop consuming
   parent token budget.
7. **No `registerMessageRenderer()` for any of the 10 sent `customType`s.** pi
   surface: themed/compact rendering of sent messages. Current: every report is
   raw `sendMessage(..., display:true)` content (`saved-commands.ts:92`,
   `builtin-commands.ts:55,79,110,135`, `workflow-commands.ts:79,162,189`, etc.) —
   multi-line results render unthemed/un-collapsible. Shape: register a renderer
   per customType (themed header, expand toggle, cost/usage badge).
8. **No `registerShortcut()` / `registerFlag()` for effort/workflow modes.** pi
   surface: shortcuts + flags + modes (see `plan-mode/`, `preset.ts` examples).
   Current: `/effort` mode (`effort-command.ts:50,70`) and the "type `workflow(s)`
   to arm" editor trigger (`workflow-editor.ts:475`) are slash/magic-word only.
   Shape: `registerShortcut` (e.g. ctrl+e effort toggle) + `registerFlag("effort"|
   "workflow")` so modes are CLI-pre-armable / key-toggleable.
9. **`pi.getCommands()` ownership inferred by name only.** pi surface:
   `getCommands()` returns `sourceInfo.{source,scope,origin}` — docs: "do NOT
   infer ownership from command name." Current: `saved-commands.ts:13`,
   `builtin-commands.ts:15` do `some(c => c.name === name)` — pure name check to
   avoid re-registering; a same-named prompt-template/skill masquerades as
   extension-owned. Shape: also check `c.source === "extension"`.

### No gap / by-design (checked, correctly used)

`ResourceLoader` source methods (N/A — neither ext ships a custom loader; #949
applied where needed: btw/core-task); TypeBox 0.83.0-removed APIs (zero uses);
`terminate:true` on structured-output; `promptSnippet`/`promptGuidelines` (used);
`prepareArguments` (workflow-tool.ts:394); `renderCall`/`renderResult`;
`ctx.signal` (host-fn-helpers abort awareness); `ctx.waitForIdle()`;
`ctx.sessionManager.getSessionId()`; `pi.events` bus (guarded); tool
enable/getAll APIs; `ctx.ui.*` (notify/setStatus/setWidget/custom/select/confirm,
all used); `PI_SESSION_*`/`spawnHook`/`exposeSessionEnvironment` (N/A — subprocess
is deliberate isolation); `ctx.compact()`/`getContextUsage()` (N/A — in-memory
subagent sessions budget-abort by design). Unsubscribed events
(`before_provider_*`, `tool_call`/`tool_result`, `agent_*`, etc.) are out of these
extensions' declared scope — by-design/N/A.
