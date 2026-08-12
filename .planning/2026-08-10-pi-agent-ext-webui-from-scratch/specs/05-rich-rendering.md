# Spec — webui Generic Tool-Mirror (Ticket 05, reframed)

> **Scope note.** Ticket 05 was opened as a *grilling* ticket: "for **rich rendering**, is generic 'forward all `tool_execution_*` + `details`' enough for v1, or do we build dedicated renderers for high-value artifacts (images, videos, manifests, diffs, file trees)? Where is the line for the minimal MVP?" Per session decision the answer is encoded here verbatim — **v1 = generic tool-mirror only; ALL dedicated renderers and binary-artifact serving are deferred**. The mirror subscribes to `tool_result`, formats each result's typed `details` into markdown, and renders into a single accumulating "tools" view. This is the "generic `tool_execution_*`/`details` forwarding, text only" option. It supersedes the ticket's open Question; cross-reference `tickets/05-rich-rendering-scope.md` and `map.md` at commit time.
>
> **Revision note (final scope).** An earlier reading of "rich rendering" implied dedicated inline image/video preview, a manifest/table renderer, a diff viewer, and a file-tree renderer. The **final** scope is the **minimal MVP boundary** the grilling resolved: a **generic, per-toolName-aware markdown formatter** over `tool_result.details`, rendered into one rolling "tools" view — **no binary/URL serving, no dedicated per-type renderer, no live `tool_execution_start/update` streaming**. Dedicated renderers and artifact serving are recorded explicitly in §Out of Scope (v1) so the scope-creep boundary is named, not accidental. This is consistent with the repo being video-generation-heavy: the tempting image/video/manifest/manifest inline renderers are the named scope-creep we deliberately defer.

**Status:** draft (pending user review)
**Effort:** `.planning/2026-08-10-pi-agent-ext-webui-from-scratch/`
**Depends on:** ticket 04 (web transport & protocol) — MERGED. ticket 06 (generic render framework) — MERGED. The mirror is a **third producer** of the ticket-06 `RenderService` (alongside the `webui_render` tool and the `"webui:render"` event channel); it reuses the registry's `render({content, mode, view, title}) → {viewId, url}` contract and the SSE-backed "tools" view unchanged. **Does not** depend on the 04 `/ws` chat frames or the mutex.
**Blocks:** nothing formal. Owns the **`details`-shape pinning that 04-spec §8 explicitly deferred** ("pin `.details` shapes during TDD tests in the plan") — those shapes are now pinned by this ticket's TDD tests, not left open.

---

## Problem Statement

The agent emits a structured `tool_result` event after every tool call, carrying typed `details` (`edit`→`{diff,patch,firstChangedLine?}`, `bash`→`{truncation?,fullOutputPath?}`, `read/grep/find/ls`→`{truncation?,…}`, `write`→`undefined`, plus custom tools like image/video-gen with app-defined `details`). Today this structured signal is **broadcast verbatim to web clients** (via the `OUTBOUND_EVENTS` forwarder in `webui-wiring.ts`) but is **never rendered** into the browser surface the agent serves. A user watching the webui sees raw/absent tool output; the value of `details` (the diff, the bash truncation pointer, the image/video-gen command+exit+output path) is invisible.

The grilling question was whether v1 needs **dedicated** renderers (inline image/video preview, a manifest/table view, a diff viewer, a file-tree) or whether generic forwarding suffices. The decision: **generic only**. So the problem is to build that generic forwarder — a mirror that subscribes to `tool_result`, formats `details` into markdown, and renders an accumulating "tools" view — **without** coupling to the chat/mutex transport, **without** widening `WebuiHost`, and **without** serving any binary artifact.

## Solution

A **generic tool-mirror** — a third producer of the ticket-06 `RenderService`. `createToolMirror(registry)` returns a factory that subscribes to the **agent** event bus (`pi.on("tool_result", …)`, via the wiring's `reg()`/`disposed` guard for parity with the existing producers), formats each `ToolResultEvent` into markdown, and calls `registry.render({ content, mode: "md", view: "tools", title: "Tools" })`. Because `RenderService` is **replace-only** (`views.set` — no append), the mirror keeps its **own** in-memory log string, appends each formatted entry, enforces a rolling cap, and re-renders on every `tool_result`.

It is fully decoupled from the ticket-04 chat/mutex/co-drive transport: it is a pure producer of one view, additive to `wireWebui` next to the existing render producers. It touches **none** of `/ws`, `pi.on("input")`, the mutex, or `sendUserMessage` — it preserves the ticket-06 D8 invariants exactly.

It is **generic** by design: built-in tools (`bash`/`read`/`edit`/`write`/`grep`/`find`/`ls`) are formatted via the SDK type guards; custom tools (including image/video-gen) are formatted as generic key-value markdown of their `details` — paths shown as **text**, never served. **No dedicated renderer, no binary/URL serving, no live `tool_execution_start/update` streaming.**

## User Stories

1. As a user watching the webui, I want to see each tool call's result formatted (tool name, ok/error status, short id) so I can follow what the agent did — without reading raw JSON.
2. As a user, I want `edit` results to show a fenced diff, so I can see exactly what changed.
3. As a user, I want `bash` results to show a stdout snippet plus a truncation note and the `fullOutputPath` pointer when present, so a truncated run is not silently lost.
4. As a user, I want image/video-gen (custom) tool results to show their stable fields (command, exitCode, ok, output/outputs path, gate, model, elapsedSeconds) as text, so a generation run is legible even without an inline preview.
5. As a user, I want the "tools" view to hold a rolling history, so rapid tool calls do not grow it unbounded or push earlier results off-screen instantly.
6. As a user, I want an unknown/malformed `details` shape to render gracefully (truncated JSON), so a new or buggy tool never breaks the view.
7. As a maintainer, I want the mirror to be a pure producer — no `sendUserMessage`, no `mutex_blocked`, no `/ws` touch — so adding it does not couple the render path to the chat/mutex transport (ticket-06 D8 preserved).
8. As a maintainer, I want the `details` shapes pinned in TDD tests, so the formatter does not silently regress when a `details` field is renamed or dropped (04-spec §8 deferred this pinning to the plan; ticket 05 owns it).
9. As a maintainer, I want no `WebuiHost` widening and no new binary-serving route, so the v1 surface stays minimal.

## Implementation Decisions

### D1 — Mechanism: `createToolMirror(registry)` subscribes `tool_result`

A factory mirroring the existing producer factories (`createRenderTool`/`createRenderEventHandler`):

```ts
// a third producer of RenderService, alongside the webui_render tool and the
// "webui:render" event channel.
export function createToolMirror(registry: RenderService): ToolMirrorHandler;
//   ToolMirrorHandler = (event: ToolResultEvent) => void
```

- **Subscription bus.** `tool_result` lives on the **agent** event bus (`pi.on`), NOT on the separate `pi.events` (`EventBus`) used for the `"webui:render"` channel. The mirror subscribes via `pi.on("tool_result", …)`. **Exact-name subscription only — no wildcard/prefix** (the SDK bus offers none).
- **`disposed` parity.** The wiring's `reg(event, handler)` helper wraps each `pi.on` registration in a `disposed` guard so a post-`dispose()` event is a no-op. The mirror is wired via the **same `reg()` helper** (it is registered inside `wireWebui`), so it inherits the parity for free — no bespoke guard. (Note: `tool_result` is **already** in `OUTBOUND_EVENTS` and already registered via `reg()` for the verbatim web broadcast; the mirror is a **second** `reg("tool_result", …)` handler. The pi bus fires **all** handlers for an event, so this is strictly additive and does not displace the broadcast.)
- **Render contract.** Each formatted entry re-renders the whole log: `registry.render({ content: this.log, mode: "md", view: "tools", title: "Tools" })`. The registry returns `{viewId:"tools", url}`; the mirror ignores the URL (the user discovers the surface via ticket 07's announce). `mode:"md"` so the shell renders the markdown server-side via `marked`.

### D2 — Formatting: generic, per-toolName-aware, NO dedicated renderers

A **pure, extracted** `formatToolResult(event: ToolResultEvent): string` (testable in isolation; T2 owns it). Formatting is **per-toolName-aware** but **generic** — there is exactly one renderer per built-in tool (via the SDK type guards) and one generic path for everything else; no image/video/manifest/diff/tree dedicated renderer.

- **Header line (every event).** `### 🔧 <toolName>` + a status emoji (✅ ok / ❌ error via `event.isError`) + the short `toolCallId` (first 8 chars). This is the stable, always-present scaffold.
- **Built-in tools** (narrowed via the SDK type guards `isBashToolResult`/`isReadToolResult`/`isEditToolResult`/`isWriteToolResult`/`isGrepToolResult`/`isFindToolResult`/`isLsToolResult`):
  - **`edit`** → a fenced ` ```diff ` block from `details.diff` (the display-oriented diff). `firstChangedLine?` shown as a one-line navigation note if present.
  - **`bash`** → the stdout snippet (from `content` text — NOT re-dumped from `details`, which only carries truncation metadata) + a `truncation` note (if `details.truncation?.truncated`) + `fullOutputPath` as a text path if `details.fullOutputPath` is present.
  - **`read` / `grep` / `find` / `ls`** → a **one-line truncation/limit note** only (e.g. `details.truncation`, `details.matchLimitReached`, `details.resultLimitReached`, `details.entryLimitReached`, `details.linesTruncated`). **No full content dump** — these tools already return their content to the model via `content`; the mirror surfaces the *metadata*, not the bytes.
  - **`write`** → `(no details)` (its `details` is `undefined` by SDK type).
- **Custom tools** (incl. image/video-gen) — `CustomToolResultEvent { toolName: string; details: unknown }`. Narrow by **`event.toolName` string** (there is **no** `isImageToolResult`/`isVideoToolResult` guard). Render the **stable string/number/boolean fields** of `details` as a markdown definition/bullet list. The known stable fields (from the run.py image/video-gen pipeline):
  - image-gen: `ok`, `command`, `exitCode`, `outputs[]`, `manifestPath`, `model`, `elapsedSeconds`, `stdout` (+ …).
  - video-gen: `ok`, `command`, `exitCode`, `output`, `manifest`, `gate`, `stdout` (+ …).
  - **Paths are filesystem strings shown as TEXT.** No binary/URL serving — `outputs[]`/`output`/`manifestPath` are rendered as inline code paths, never `<img>`/`<video>`/`<a href>`.
- **Fallback (unknown shape).** Truncated `JSON.stringify(details)` (capped, ellipsis). Used when the custom `details` is not a plain object, or when an unknown built-in appears.
- **Per-field truncation.** Long fields are capped (e.g. stdout/output/command strings ~2000 chars, ellipsis) so a single noisy tool call cannot blow the view or the log budget.

### D3 — View strategy: single accumulating "tools" view (replace-only registry + mirror-local log)

`RenderService` is **replace-only** (`render()` does `views.set(viewId, view)` — overwrite, never append; **no append/log capability**). So the mirror owns its own accumulation:

- The mirror holds `private log: string` (or an array of entry strings joined).
- On each `tool_result`: append the formatted entry, enforce a **rolling cap**, then `registry.render({ content: this.log, view:"tools", title:"Tools", mode:"md" })`.
- **Rolling cap:** keep the **last N entries OR total ≤ ~20000 chars**, whichever trips first; drop oldest. (N=50 entries is the default.) This bounds both the count and the byte size, so a flood of tiny tool calls and one giant bash dump are both bounded.
- **Defer per-tool-call tabs.** v1 is a single "tools" view with a rolling history. Per-tool-call tabs / per-result deep links are §Out of Scope.

### D4 — Robustness: never throw, truncate, cap

- **Never throw.** The mirror's handler must format gracefully on unknown/malformed `details` (fallback to truncated JSON). (The host EventBus swallows handler errors anyway, but graceful formatting is the contract — a `details` shape change must not blank the view.)
- **Truncate fields** (D2 per-field caps).
- **Cap the log** (D3 rolling cap).
- **Defensive narrowing.** Built-in guards are SDK-provided; custom narrowing is by `event.toolName` string with an unknown-shape fallback.

### D5 — Deferred list (recorded explicitly; the scope-creep boundary)

The following are **deliberately deferred** (the named tempting scope-creep for a video-generation repo):

- **Dedicated image inline preview** (`<img>` rendering, `outputs[]` → thumbnails).
- **Dedicated video inline preview** (`<video>` rendering, `output` → playable).
- **Manifest/table renderer** (run.py image/video manifests as structured tables).
- **Diff viewer** (a dedicated two-pane diff component — v1 shows the fenced `details.diff` text only).
- **File-tree renderer** (for `find`/`ls` outputs).
- **Binary-artifact serving route** (serving `outputs[]`/`output` files via a webui HTTP route). **Explicitly out of v1** — paths are shown as TEXT only; the webui serves no binary.
- **`tool_execution_start` / `tool_execution_update` live streaming** (v1 mirrors the **completed** `tool_result` only; the outbound broadcast already forwards `tool_execution_*` to web clients verbatim, so the live-progress frame is not lost — it is just not re-rendered into the "tools" view).
- **Per-tool-call view tabs** (D3 — single rolling "tools" view for v1).
- **Client-side syntax highlighting** (the fenced diff/code blocks render as plain `<pre><code>` via `marked`; highlighting can be added later, mirroring the ticket-06 deferral).
- **Debouncing/batching** of rapid `tool_result`s (v1 re-renders on each event; the rolling cap bounds the cost).

## Testing Decisions

Test external behavior, not internals. (⚠️ **tsconfig-tests gotcha**: the package `tsconfig.json` `include` is `src/**/*.ts` only, so `bun run typecheck` does **not** typecheck `tests/`. The conformance gate is the **full** `bun run typecheck && bun test`, never typecheck alone. This ticket does **not** widen any interface a test implements, so no test-fixture churn is expected — but the gate is still the full suite.)

- **`formatToolResult` (pure, T2):** one case per built-in (`edit`→fenced diff; `bash`→stdout snippet + truncation/fullOutputPath; `read`/`grep`/`find`/`ls`→one-line note, no content dump; `write`→"(no details)") via the SDK type guards; custom image-gen `details` → md key-value list of the stable fields with paths as inline code; custom video-gen `details` → same; unknown/missing `details` → truncated JSON; header line carries `toolName` + status emoji + short id; per-field truncation (stdout/output/command over the cap → ellipsis). **These tests PIN the `details` shapes** — they are the 04-spec §8 pinning this ticket owns (see Pins 04-spec §8 below).
- **Mechanism (pure unit, T1):** a fake `RenderService` (or a real one with a `now`/`urlFor` stub) + a synthetic `tool_result` event → the "tools" view is created/updated with `mode:"md"`, `title:"Tools"`, and content containing the formatted entry; the handler does not throw on any event shape.
- **Accumulation + rolling cap (T3):** N+1 tool_results → only the last N entries are in the log (oldest dropped); a single entry larger than the ~20000-char budget is itself truncated so the view never exceeds the budget; rapid tool_results grow the entry list to N then roll (never unbounded).
- **Integration (live, T4):** through `wireWebui`, a `tool_result` fires → a "Tools" tab appears/updates in the shell (`GET /api/views` lists `tools`; `GET /api/view/tools` returns server-rendered md HTML); the SSE `GET /api/events` delivers a `view_update` for `tools` on the next `tool_result`. **Decoupling negative control (ticket-06 D8):** the mirror path does **not** call `sendUserMessage`, does **not** broadcast a `mutex_blocked` frame on `/ws`, and does **not** widen `WebuiHost` (asserted structurally — the wiring adds only a `reg("tool_result", createToolMirror(registry))` line; the host interface is unchanged). Whole-package suite green.

## Out of Scope (v1)

- **Dedicated image/video inline preview** — `outputs[]`/`output` are filesystem paths shown as TEXT (D2/D5). No `<img>`/`<video>`, no binary serving route.
- **Manifest/table renderer, diff viewer, file-tree renderer** — fenced text only (D2/D5).
- **Binary-artifact serving route** — the webui serves no binary in v1; paths are text (D5).
- **`tool_execution_start` / `tool_execution_update` live streaming** into the "tools" view — v1 mirrors the completed `tool_result` only (D5).
- **Per-tool-call view tabs** — single rolling "tools" view (D3).
- **Client-side syntax highlighting** — fenced blocks render as plain `<pre><code>` (D5; mirrors ticket-06 deferral).
- **Debouncing/batching** of `tool_result`s (D5).
- **Persistence** — the mirror's log is in-memory, cleared at session end (mirrors ticket-06 v1).

## Pins 04-spec §8 (`details` shapes)

ticket 04 (web transport & protocol) §8 explicitly deferred pinning the per-tool `.details` shapes to "TDD tests during the plan." **This ticket owns that pinning.** The `formatToolResult` TDD tests (T2) assert the **stable, relied-upon** fields the generic formatter reads — the verified SDK shapes:

| tool | `details` shape (verified against SDK `dist/core/tools/*.d.ts`) | fields the mirror reads |
| --- | --- | --- |
| `edit` | `{ diff: string; patch: string; firstChangedLine?: number }` | `diff` (fenced), `firstChangedLine?` |
| `bash` | `{ truncation?: TruncationResult; fullOutputPath?: string }` | `truncation?.truncated`, `fullOutputPath?` |
| `read` | `{ truncation?: TruncationResult }` | `truncation?.truncated` |
| `grep` | `{ truncation?: TruncationResult; matchLimitReached?: number; linesTruncated?: boolean }` | `matchLimitReached?`, `linesTruncated?`, `truncation?` |
| `find` | `{ truncation?: TruncationResult; resultLimitReached?: number }` | `resultLimitReached?`, `truncation?` |
| `ls` | `{ truncation?: TruncationResult; entryLimitReached?: number }` | `entryLimitReached?`, `truncation?` |
| `write` | `undefined` (by type) | none → "(no details)" |
| custom (image/video-gen) | `unknown` (app-defined) | `ok`/`command`/`exitCode`/`outputs[]`/`output`/`manifestPath`/`model`/`elapsedSeconds`/`gate`/`stdout` (generic key-value; unknown keys → truncated JSON fallback) |

`TruncationResult` carries `{ truncated, truncatedBy:"lines"|"bytes"|null, outputLines, totalLines, firstLineExceedsLimit, maxLines, maxBytes }`; the mirror reads only `truncated` (a boolean note) — it does not re-dump the metadata. If a future SDK rename drops a field the mirror reads, the T2 test goes RED and the formatter is updated before the field round-trips silently — exactly the η-class failure the 04-spec §8 deferral was guarding against.

## Acceptance Criteria

1. **A `tool_result` fires → a "Tools" tab appears/updates in the shell** with formatted markdown (`GET /api/views` lists `tools`; `GET /api/view/tools` returns server-rendered md HTML; the SSE channel delivers a `view_update`).
2. **Built-in tools format via the SDK type guards** (`edit`→fenced diff; `bash`→stdout snippet + truncation note + `fullOutputPath`; `read`/`grep`/`find`/`ls`→one-line note, no content dump; `write`→"(no details)").
3. **Custom (image/video-gen) tools format their `details` fields gracefully as TEXT** — stable fields as a key-value markdown list, paths as inline code. **No binary/URL serving.**
4. **The "tools" view holds a rolling history** (last N entries OR ≤ ~20000 chars, oldest dropped); rapid `tool_result`s do not grow it unbounded.
5. **Unknown/malformed `details` renders gracefully** (truncated JSON) — never throws, never blanks the view.
6. **D8 preserved:** the mirror is a pure producer — no `sendUserMessage`, no `mutex_blocked` broadcast, no `/ws` touch; strictly additive to `wireWebui` (a `reg("tool_result", createToolMirror(registry))` line next to the existing render producers).
7. **04 `details` shapes pinned** in TDD tests (this ticket owns the 04-spec §8 pinning).
8. **No `WebuiHost` widening** (the host interface is unchanged; the mirror subscribes through the wiring's existing `reg()` seam).
9. **Whole-package suite green** (`bun run typecheck && bun test`).

## Further Notes

- **Greenfield producer.** No existing mirror/forwarder into a view to reconcile — the `OUTBOUND_EVENTS` verbatim web broadcast (ticket 04) is a *different* sink (the `/ws` chat frames) and is unchanged; the mirror is a *new* render-view producer.
- **Reuses ticket 06's `RenderService`** — the registry, the `render({content,mode,view,title})` contract, the SSE-backed shell, and the `marked` md→html rendering are all unchanged. The mirror is a pure client of the registry, exactly like `createRenderTool`/`createRenderEventHandler`.
- **The pi bus fires ALL handlers for an event.** `tool_result` is already registered via `reg()` for the outbound broadcast; adding `reg("tool_result", createToolMirror(registry))` is a second handler that runs alongside (not instead of) the broadcast. Both fire on each `tool_result`.
- **`tool_result` is on `pi.on`, not `pi.events`.** The `"webui:render"` channel (the second ticket-06 producer) is on the separate `pi.events` `EventBus`; the mirror must NOT subscribe there — `tool_result` is an agent event, exact-name only, no wildcard.
- **No new dependency.** The mirror is plain TS over the SDK types (`ToolResultEvent` + the `is*ToolResult` guards) and the existing `RenderService`. No `marked`/TypeBox/sanitizer addition.
