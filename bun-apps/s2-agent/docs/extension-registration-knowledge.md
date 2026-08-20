# Extension Registration Knowledge

## Tool Activation: `session_start` vs `before_agent_start`

### The Problem

Calling `pi.setActiveTools()` inside a `pi.on("session_start", ...)` handler **sometimes does not propagate** to `getSystemPromptOptions().selectedTools`. This means `inspect_extensions` (which reads `selectedTools` from `getSystemPromptOptions()`) can show a tool as **lazy-loaded** (registered but not active) even though the extension explicitly activates it in `session_start`.

Root cause: the SDK's internal `_baseSystemPromptOptions` — which backs `getSystemPromptOptions()` — is built once during extension load. Although `setActiveToolsByName()` calls `_rebuildSystemPrompt()` which *does* update `_baseSystemPromptOptions`, there appears to be a timing/ordering issue in the startup sequence (extension binding → `session_start` emit → `extendResourcesFromExtensions`) that can leave some tools out of the `selectedTools` snapshot.

### The Fix

**Use BOTH `session_start` AND `before_agent_start`** to activate tools:

```typescript
const activateMyTools = () => {
  const active = pi.getActiveTools();
  const missing = ['my_tool', 'my_tool_help'].filter((nm) => !active.includes(nm));
  if (missing.length) pi.setActiveTools([...active, ...missing]);
};

// session_start: activates tools on startup for downstream hooks
pi.on('session_start', () => { activateMyTools(); });

// before_agent_start: fires BEFORE every LLM turn, ensuring the tools
// are in the active set when the system prompt + tool definitions are
// assembled for that turn. This bridges the gap when session_start
// activation doesn't propagate to getSystemPromptOptions().
pi.on('before_agent_start', () => { activateMyTools(); });
```

### Why `before_agent_start` Works

The lifecycle order is:

1. `session_start` fires (extension load complete)
2. `extendResourcesFromExtensions` rebuilds system prompt
3. User sends a prompt
4. **`before_agent_start` fires** — tool activation here takes effect
5. LLM request is built with the current `agent.state.tools` + `_baseSystemPromptOptions`
6. Provider request is sent

Since `setActiveTools()` → `setActiveToolsByName()` → `_rebuildSystemPrompt()` updates BOTH `agent.state.tools` (the tools the LLM can call) AND `_baseSystemPromptOptions.selectedTools` (the visible tool list), calling it in `before_agent_start` ensures the LLM sees and can call the tools on that very turn.

### Reference: How `inspect_extensions` Classifies Tools

The `inspect_extensions` tool (in `s2-agent-ext-power-tool`) classifies tools as **active** vs **lazy-loaded** by comparing:

- `pi.getAllTools()` — all registered tools (from extension factories)
- `getSystemPromptOptions().selectedTools` — the subset the system prompt builder knows about

```typescript
const opts = ctx.getSystemPromptOptions();
const selectedSet = new Set(opts.selectedTools ?? []);
const allTools = getAllTools();
const activeTools = allTools.filter((t) => selectedSet.size === 0 || selectedSet.has(t.name));
const inactiveRaw = allTools.filter((t) => !selectedSet.has(t.name));  // ← "lazy-loaded"
```

If `selectedSet` is non-empty and a tool's name is not in it, the tool is reported as lazy.

### Key Files

| File | Purpose |
|------|---------|
| `bun-apps/s2-agent-ext-workflow/extensions/workflow.ts` | Reference implementation with both hooks |
| `bun-apps/s2-agent-ext-power-tool/src/index.ts` | `inspect_extensions` implementation |
| `bun-apps/s2-agent/run-dir/manifest.json` | Extension registry (`extensions` array + `lazyExtensions`) |
