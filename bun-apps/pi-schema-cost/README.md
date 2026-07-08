# pi-schema-cost

**Measure and rank the API schema-token cost of LLM tool definitions.** Pure token-accounting — zero dependencies, runs anywhere.

> Every LLM tool-call request repeats each tool's `description` + the JSON Schema of its `parameters` in the API `tools` array. That schema text is a **per-request token tax** — the #1 demand bucket for context-window cost. `pi-schema-cost` makes it measurable, rankable, and reducible.

## Why

Context-window cost is the largest, most-recurring demand across the pi.dev ecosystem. In our own agent (30+ tools across 9 extensions), the per-request schema tax was **~328K aggregate tokens** — paid on *every* request. You can't shrink what you can't measure. This package is the measurement half: dependency-free, deterministic, offline.

It ranks tools correctly (the expensive ones float to the top) even though the absolute number is a heuristic — real cost depends on the provider's tokenizer, but the ranking is stable across changes, which is what you need to baseline and track cost reductions.

## Install

```bash
bun add pi-schema-cost      # or: npm install pi-schema-cost
```

Zero runtime dependencies.

## Quick start

```js
import { analyzeTools, formatReport } from "pi-schema-cost";

const tools = [
  {
    name: "search_web",
    description: "Search the web. Returns an AI-synthesized answer with citations.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, provider: { type: "string", enum: ["auto", "brave"] } },
      required: ["query"],
    },
  },
  { name: "beep", description: "Beep.", parameters: { type: "object" } },
];

const report = analyzeTools(tools, "example");
console.log(formatReport(report).join("\n"));
```

```
schema-cost — 2 tools · ≈39 tokens (builtins 0 + extensions 2)

top 3 — search_web(33) + beep(6) = 39 tok (100% of total)

tool        tokens  desc  params  source
search_web      33    71      60  example
beep             6     5      17  example
```

Run the bundled example:

```bash
git clone … && cd pi-schema-cost
bun run example     # → bun examples/quick.mjs
```

## API

### `estimateToolCost(def, source, opts?)` → `ToolCost`

Estimate one tool's schema-token cost. Pure + deterministic.

```js
import { estimateToolCost } from "pi-schema-cost";
const c = estimateToolCost({ name: "read", description: "Read a file.", parameters: {} }, "(builtin)");
// → { name: "read", descLen: 12, paramsLen: 2, approxTokens: 4, source: "(builtin)" }
```

### `analyzeTools(tools, source, opts?)` → `SchemaCostReport`

Rank a list of tool definitions by cost (desc), with a total + counts.

### `mergeReports(reports)` → `SchemaCostReport`

Consolidate per-source cost lists (e.g. built-ins + each extension) into one ranked report. Counts built-ins by the `"(builtin)"` source convention.

### `formatReport(report)` / `formatJson(report)` → `string[]` / `string`

Human-readable table / machine-readable JSON.

### `estimateTokens(chars, charsPerToken?)` → `number`

The underlying heuristic. Default ratio **4** (≈4 chars/token for English + JSON).

### `AnalyzeOptions.charsPerToken` (default `4`)

The chars-per-token ratio. Pass `3.7` to reproduce the live `context_analyzer` instrument's numbers; `4` matches the static `schema-cost` CLI.

## Types

```ts
interface ToolCost { name: string; descLen: number; paramsLen: number; approxTokens: number; source: string }
interface SchemaCostReport { tools: ToolCost[]; totalTokens: number; builtinCount: number; extensionCount: number; errors: {...}[] }
```

`ToolDefinitionLike` is duck-typed (`name?`, `description?`, `parameters?`) — works with pi's `ToolDefinition`, OpenAI tool objects, or any static fixture.

## The heuristic

`approxTokens = round((description.length + JSON.stringify(parameters).length) / charsPerToken)`

It's an **estimate** (real cost uses the provider's BPE tokenizer), but:
- **Deterministic + offline** — no API calls, no model needed.
- **Ranks correctly** — the relative ordering is stable, which is what matters for baselining + tracking reductions across changes.

For an exact count, swap in a real tokenizer by post-processing the `descLen`/`paramsLen` fields.

## Scope (what this package is NOT)

This is the **static schema-cost** half. It measures tool *definitions*, not live-session usage. The live half (system-prompt text, guideline snippets, real token usage from the API) is agent-coupled and lives in-tree (`context_analyzer`). The clean boundary is the point: feed this package whatever tool definitions you have and it ranks them.

## License

MIT.
