---
type: prototype
status: closed
claimed: claude
---

# 01 — Verb/label mapping spec (the human render per tool event)

## Question

Pin the exact human-readable render for each subagent tool event — the foundation everything else consumes. Today every surface shows machine protocol: bare tool ids (`read`, `bash`, `grep`), raw JSON arg dumps (`→ read {"path":"parser.ts"}`), and inconsistent phrasing (inline `describeLastActivity` says `read` / `read → done`; `/subagents` `summarizeLatestAction` says `▸ read` / `read done` / `✗ read`).

Produce a concrete **spec + rendered samples** for the user to approve before any wiring:

1. **Verb table** for the common tools — the verb + the key arg to extract, e.g.:
   - `read`/`grep`/`find` → `Reading <path>` / `Searching <pattern>` / `Finding <name>`
   - `write`/`edit` → `Editing <path>` / `Writing <path>`
   - `bash` → `Running: <command first line>`
   - `web_search` → `Searching web: <query>`; `fetch_content` → `Fetching <url>`
   - `ls` → `Listing <dir>`
   - (enumerate the actual tool set in `bun-apps/pi-agent-ext-subagent/src/` + pi core tools)
2. **Arg-extraction rule** — which arg key becomes the label (path / command / query / pattern / url / name / …), and a generic fallback when none of the known keys is present.
3. **Fallback for unknown/extension/custom tools** (e.g. `krea2`, future extension tools) — graceful human phrasing, not a raw identifier (e.g. `Using <toolName>` or `Calling <toolName>`).
4. **Tense/phase consistency** — tool-call vs tool-result vs error phrasing so all surfaces agree (e.g. call = `Reading parser.ts`, result = `Read parser.ts ✓`, error = `Failed to read parser.ts`). This is the fix for the cross-surface inconsistency.
5. **Rendered samples** — show the header line, the 2-line progress block, one live-trace line, and one box row, all using the new labels, so the user can react to the actual look before ticket 02 wires four files.

This is a Prototype (HITL): raise fidelity with a cheap concrete artifact, get approval, then hand to 02.

## Resolution

**Approved 2026-08-07 (Prototype/HITL).** Two grilling decisions locked the design:

- **Visual scheme: status-led + call arrow.** In-flight calls keep `→`; results use `✓`; errors use `✗`. (Alt `→`/`←` direction-pair and text-only rejected.)
- **Verb coverage: core + high-traffic (~12) + generic fallback.** Curated verbs for read/write/edit/bash/grep/find/ls/web_search/fetch_content/subagent/subagents/ask_user_question; everything else → `Using <tool>` + heuristic arg extraction. (Exhaustive + core-only rejected.)

### Ground-truth findings (from research, fixed the design)

1. **Args are stringified-only.** `compactAgentHistory` does `text: JSON.stringify(args ?? {})` and discards the parsed object. The helper MUST parse `e.text` — tolerate `{}`, non-JSON (result text), and `... [truncated]` tails. Strategy: `JSON.parse` → regex-scrape `"key"\s*:\s*"..."` → toolName fallback.
2. **`renderSubagentCall` is NOT a tool-action labeller** — it renders the launch header from the `subagent` tool's own params (agent/model/tier/task). **Untouched.** The model-slot construction stays.
3. **Result entries carry no args** (their `text` is result prose). To render `Read src/parser.ts` on a result, pair it with its preceding same-tool `toolCall` and pass those parsed args as `matchedCallArgs`.

### The helper

```
formatToolAction(entry: AgentHistoryEntry, ctx?: { matchedCallArgs?: Record<string, unknown> }): string
```
- **toolCall** → parse `entry.text` → verb-table → present-continuous + target.
- **toolResult** → past tense + target (from `ctx.matchedCallArgs` if the caller paired it; else verb-only).
- **error** → `Failed to <verb> <target>` (+ optional `: <msg>`).
- **text/idle** → first line / `…thinking`.

**Marker ownership (stays per-surface — the helper owns the PHRASE only):**
- live trace (`formatHistoryLine`): `→ <phrase>` (call) / `✓ <phrase>` (ok) / `✗ <phrase>` (err)
- progress block (`formatSubagentProgress`): `↳ <phrase>`
- activity row (`summarizeLatestAction`): bare `<phrase>` (renderActivityRow adds its own status icon)

**Convergence:** `formatHistoryLine`, `describeLastActivity`, `summarizeLatestAction` all call `formatToolAction`. `previewPayload` is absorbed (arg-extraction moves into the helper). `renderActivityRow` + the box widget flow through unchanged (they consume the above). `renderSubagentCall` untouched.

### Verb table (grounded in real arg keys; approved coverage)

| Tool | key arg | call (present) | result (past) | error |
|---|---|---|---|---|
| `read` | `path` | Reading X | Read X | Failed to read X |
| `write` | `path` | Writing X | Wrote X | Failed to write X |
| `edit` | `path` | Editing X | Edited X | Failed to edit X |
| `bash` | `command` | Running: cmd | Ran: cmd | Failed: cmd |
| `grep` | `pattern` | Searching for "p" | Searched for "p" | Failed to search |
| `find` | `pattern` (glob) | Finding "g" | Found "g" | Failed to find |
| `ls` | `path` | Listing X | Listed X | — |
| `web_search` | `query` | Searching web for "q" | Searched web | Failed web search |
| `fetch_content` | `url` | Fetching U | Fetched U | Failed to fetch U |
| `subagent` | `task` | Dispatching subagent "t" | Dispatched subagent | Failed subagent dispatch |
| `subagents` | `tasks` | Dispatching N subagents | Dispatched N subagents | Failed subagent dispatch |
| `ask_user_question` | `questions` | Asking N questions | Asked N questions | Failed to ask |

(`edit` real keys: `path` + `edits[{oldText,newText}]` — target is `path`. `grep` real key `pattern` + `path?`/`glob?`. `fetch_content` `url`/`urls`. `web_search` `query`/`queries`.)

**Arg-extraction priority:** per-tool explicit key → else first present of [`path`,`file`,`note`,`command`,`query`,`pattern`,`url`,`name`,`task`,`action`,`id`] with generic `Using`/`Used` → else `Using <toolName>`. Paths/commands truncated ~50 chars (mid-ellipsis).

### Fallback (unknown/extension/dynamic-MCP tools)

`Using <toolName>` (call) / `Used <toolName>` (result) / `Failed (<toolName>)` (error) — with heuristic arg extraction if a common key is present. Covers krea2/flux2/ltx/movie/obsidian_*/zk_*/zai_* without per-tool curation.

### Samples (approved look)

Launch header (UNCHANGED): `subagent ▸ reviewer ▸ tier:medium ▸ "Fix the failing test in parser.ts"`

Progress block:
```
  ↳ Editing src/parser.ts
    ↳ 4.1s elapsed · 6 tool calls
```

Live trace (Ctrl-O / expanded box):
```
→ Reading test/parser.ts
→ Searching for "parseToken" in src/
✓ Read test/parser.ts
→ Editing src/parser.ts
✗ Failed to edit src/parser.ts: oldText not found
→ Running: bun test
✓ Ran: bun test
```

### Hand-off to 02

02 implements `formatToolAction` per this spec and rewires `formatHistoryLine` / `describeLastActivity` / `summarizeLatestAction` (absorbing `previewPayload`). `matchedCallArgs` pairing: trace maps with index, pairing a result to its nearest preceding same-tool `toolCall`; progress/activity pair the tail result similarly. Unit tests: verb table, arg extraction, fallback, parse-tolerance (truncated/non-JSON/`{}`), matched-call pairing.
