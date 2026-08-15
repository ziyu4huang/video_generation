# webui Generic Tool-Mirror (Ticket 05) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **generic tool-mirror** to `pi-agent-ext-webui` — a third producer of the ticket-06 `RenderService` that subscribes to the agent `tool_result` event, formats each result's typed `details` into markdown, and renders an accumulating "tools" view in the browser shell — **without** any dedicated renderer (image/video inline preview, manifest/table, diff viewer, file-tree), **without** any binary-artifact serving route, and **without** coupling to the chat/mutex transport or widening `WebuiHost`.

**Architecture:** `createToolMirror(registry)` is a factory mirroring the existing producer factories (`createRenderTool`/`createRenderEventHandler`). It subscribes to `tool_result` on the **agent** bus (`pi.on`, via the wiring's `reg()`/`disposed` guard for parity — `tool_result` lives on `pi.on`, NOT on the separate `pi.events` `"webui:render"` channel). A pure, extracted `formatToolResult(event): string` does the per-toolName-aware formatting: built-in tools via the SDK type guards (`isBashToolResult`/`isReadToolResult`/`isEditToolResult`/`isWriteToolResult`/`isGrepToolResult`/`isFindToolResult`/`isLsToolResult`), custom tools (incl. image/video-gen) as generic key-value markdown of their `details` with paths shown as TEXT. Because `RenderService` is **replace-only** (`views.set`, no append), the mirror keeps its **own** in-memory log, appends each formatted entry, enforces a rolling cap (last N entries OR ≤ ~20000 chars), and re-renders the whole log on every `tool_result`.

**Tech Stack:** plain TypeScript over the SDK types (`ToolResultEvent` + the `is*ToolResult` guards, both exported from `@earendil-works/pi-coding-agent`) and the existing `RenderService`. **No new runtime dependency** (no `marked`/TypeBox/sanitizer addition — `marked` is already a ticket-06 dep used server-side by the routes; the mirror emits raw markdown and lets the route render it).

## Global Constraints

Copied verbatim from the spec decisions (every task's requirements implicitly include these):

- **D1 — Mechanism.** `createToolMirror(registry)` returns a `ToolMirrorHandler = (event: ToolResultEvent) => void`. The wiring subscribes it via the existing `reg("tool_result", …)` seam (the `disposed`-guard wrapper used by the outbound broadcast) — `tool_result` is an agent event on `pi.on`, **exact-name only, no wildcard/prefix**; it is NOT on the `pi.events` `"webui:render"` channel. Each handler invocation calls `registry.render({ content: <log>, mode: "md", view: "tools", title: "Tools" })`. (`tool_result` is already in `OUTBOUND_EVENTS`; the mirror is a SECOND `reg("tool_result", …)` handler — the pi bus fires all handlers, so this is additive and does not displace the verbatim web broadcast.)
- **D2 — Formatting (generic, per-toolName-aware, NO dedicated renderers).** A pure `formatToolResult(event): string`: header line `### 🔧 <toolName>` + status emoji (✅ ok / ❌ error via `event.isError`) + short `toolCallId` (first 8 chars); then `edit`→fenced ` ```diff ` from `details.diff` (+ `firstChangedLine?` note); `bash`→stdout snippet from `content` text (+ `truncation` note + `fullOutputPath` text); `read`/`grep`/`find`/`ls`→one-line metadata note only (**no content dump**); `write`→"(no details)"; custom tools→generic key-value markdown of the stable `details` fields with paths as inline code (narrow by `event.toolName` string — there is no `isImageToolResult`/`isVideoToolResult`); unknown shape→truncated `JSON.stringify(details)`. **Paths are filesystem strings shown as TEXT — no `<img>`/`<video>`/`<a href>`, no binary/URL serving.**
- **D3 — View strategy (single accumulating "tools" view).** The mirror owns `private log: string` (or an entry array joined). On each `tool_result`: append the formatted entry, enforce a **rolling cap** (last N=50 entries OR total ≤ ~20000 chars, drop oldest, whichever trips first; a single over-budget entry is itself truncated), then `registry.render({ content: this.log, view:"tools", title:"Tools", mode:"md" })`. Replace-only `RenderService` + mirror-local accumulation. **Per-tool-call tabs deferred.**
- **D4 — Robustness.** The handler **never throws** (format gracefully on unknown/malformed `details` → truncated JSON fallback); **truncate long fields** (stdout/output/command ~2000 chars, ellipsis); **cap the log** (D3). Defensive narrowing: built-ins via SDK guards, custom by `event.toolName` string.
- **D5 — Deferred (the scope-creep boundary, recorded explicitly).** Dedicated image/video inline preview; manifest/table renderer; diff viewer; file-tree renderer; **binary-artifact serving route**; `tool_execution_start`/`tool_execution_update` live streaming into the view; per-tool-call view tabs; client-side syntax highlighting; debouncing/batching. NONE of these are built in v1.
- **D8 preserved (ticket-06 load-bearing invariant).** The mirror is a pure producer: it does **not** call `sendUserMessage`, does **not** broadcast `mutex_blocked`, does **not** touch `/ws`. It is strictly additive to `wireWebui` (one `reg("tool_result", createToolMirror(registry))` line). **No `WebuiHost` widening** (the host interface is unchanged; the mirror subscribes through the wiring's existing `reg()` seam). The negative-control test in T4 guards this permanently.
- **⚠️ tsconfig-tests gotcha (memory 3be99b98).** The package `tsconfig.json` `include` is `src/**/*.ts` only — `bun run typecheck` does NOT typecheck `tests/`. The conformance gate is the FULL `bun run typecheck && bun test`, never typecheck alone. (This ticket does **not** widen any interface a test implements, so no test-fixture churn is expected — but the gate is still the full suite.)
- **Staging discipline.** `git add` ONLY the explicit paths listed in each task's Commit step — **never** `git add -A` / `.` / `-u`. **Never commit** `python/embed-bench/backends/mlx_native.py`, `.agents/memory/MEMORY.md`, or `history.txt` (these are working-tree-local and unrelated to this ticket). No top-level `cd` — run package commands as `( cd bun-apps/pi-agent-ext-webui && … )`.

## File Structure

**Create (all under `bun-apps/pi-agent-ext-webui/`):**
- `src/tool-mirror.ts` — the mirror factory `createToolMirror(registry): ToolMirrorHandler` + the pure `formatToolResult(event): string` + the rolling-cap accumulation. Single responsibility: turn `tool_result` events into the rolling "tools" view. (T1 creates it with the minimal format + mechanism; T2 expands `formatToolResult`; T3 adds the cap — all in this one file.)
- `tests/tool-mirror.test.ts` (T1) — mechanism: `createToolMirror` + minimal `formatToolResult` (header + truncated-JSON fallback) → "tools" view created/updated; never throws.
- `tests/tool-mirror-format.test.ts` (T2) — `formatToolResult` per-tool: built-in type guards + custom key-value + per-field truncation. **This is the 04-spec §8 `details`-shape pinning.**
- `tests/tool-mirror-accumulation.test.ts` (T3) — rolling cap (last N entries OR ≤ ~20000 chars; over-budget single entry truncated).
- `tests/tool-mirror-integration.test.ts` (T4) — live `wireWebui` e2e (`tool_result` → "Tools" tab + SSE `view_update`) + the D8 decoupling negative control.

**Modify:**
- `src/webui-wiring.ts` (T4) — `import { createToolMirror }`; add `reg("tool_result", createToolMirror(registry));` in the `pi.on` registration section (after `const reg = …` is defined — the mirror needs the `disposed` guard, and `tool_result` is an agent event, not a `pi.events` channel). **No other change** to the wiring; `WebuiHost` is unchanged.

**No change to:**
- `src/render-service.ts` / `src/render-routes.ts` / `src/render-shell.ts` / `src/render-tool.ts` / `src/render-event-handler.ts` — the registry, routes, shell, and the other two producers are unchanged. The mirror is a pure client of the registry.
- `src/web-server.ts` / `src/protocol.ts` / `src/mutex*.ts` — no transport/mutex change.
- `extensions/webui.ts` — the cast `pi as unknown as WebuiHost` still holds; the mirror adds no host surface.
- `package.json` — **no new dependency**.

---

### Task 1: ToolMirror core mechanism (`createToolMirror` + minimal `formatToolResult`)

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/tool-mirror.ts`
- Test: `bun-apps/pi-agent-ext-webui/tests/tool-mirror.test.ts`

**Interfaces:**
- Consumes: `RenderService` (ticket 06) — `render({ content, mode?, view?, title? }): RenderResult`. `ToolResultEvent` + the `is*ToolResult` guards from `@earendil-works/pi-coding-agent` (all exported from the SDK root `index.d.ts`).
- Produces:
  - `export type ToolMirrorHandler = (event: ToolResultEvent) => void`
  - `export function formatToolResult(event: ToolResultEvent): string` — the pure formatter. **T1 ships the MINIMAL version:** the header line (`### 🔧 <toolName>` + status emoji + short `toolCallId`) + a truncated-`JSON.stringify(details)` body fallback. T2 expands the body with the built-in guards + custom key-value. (Splitting the format work across T1/T2 keeps each task's RED/GREEN tight; the header is the stable scaffold both build on.)
  - `export function createToolMirror(registry: RenderService, opts?: ToolMirrorOptions): ToolMirrorHandler` — holds the in-memory log, appends `formatToolResult(event)`, and calls `registry.render({ content: log, mode: "md", view: "tools", title: "Tools" })` on each event. `ToolMirrorOptions` is `{ maxEntries?: number; maxChars?: number }` (T3 enforces them; T1 accepts and ignores them so the signature is stable).
  - **Behavior contract (D1):** a `tool_result` → a `"tools"` view exists in the registry with `mode:"md"`, `title:"Tools"`, and `content` containing the formatted header; the handler never throws on any event shape.

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-webui/tests/tool-mirror.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { createToolMirror, formatToolResult } from "../src/tool-mirror.js";
import { RenderService } from "../src/render-service.js";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

/** Build a synthetic tool_result (TextContent/ImageContent aren't SDK-root-
 *  exported; cast through Partial like the 06 plan's `{} as never`). */
function mkResult(over: Partial<ToolResultEvent> & { toolName: string }): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: "call-abcdef1234",
    input: {},
    content: [],
    isError: false,
    ...over,
  } as ToolResultEvent;
}

describe("formatToolResult (T1 minimal: header + JSON fallback)", () => {
  it("emits the header line: ### 🔧 <toolName> + ✅ status + short toolCallId", () => {
    const out = formatToolResult(mkResult({ toolName: "bash", toolCallId: "abcdef1234567890" }));
    expect(out).toContain("### 🔧 bash");
    expect(out).toContain("✅");
    expect(out).toContain("abcdef1"); // first 8 chars of the toolCallId
  });

  it("uses ❌ when isError is true", () => {
    const out = formatToolResult(mkResult({ toolName: "bash", isError: true }));
    expect(out).toContain("❌");
  });

  it("falls back to truncated JSON for an unknown details shape (no throw)", () => {
    const out = formatToolResult(
      mkResult({ toolName: "mystery", details: { weird: [1, 2, { deep: true }] } })
    );
    expect(out).toContain("### 🔧 mystery");
    expect(out).toContain("```json");
    expect(out).toContain('"weird"');
  });

  it("never throws on a missing/undefined details", () => {
    expect(() => formatToolResult(mkResult({ toolName: "write", details: undefined }))).not.toThrow();
  });
});

describe("createToolMirror (T1 mechanism)", () => {
  it("a tool_result creates/updates the 'tools' view with mode 'md' and title 'Tools'", () => {
    const registry = new RenderService({ urlFor: () => "#", now: () => 1 });
    const handle = createToolMirror(registry);
    handle(mkResult({ toolName: "bash", toolCallId: "cccc1111" }));
    const view = registry.getView("tools");
    expect(view).toBeDefined();
    expect(view!.mode).toBe("md");
    expect(view!.title).toBe("Tools");
    expect(view!.content).toContain("### 🔧 bash");
    expect(view!.content).toContain("cccc1111".slice(0, 8));
  });

  it("does not throw on any event shape", () => {
    const registry = new RenderService();
    const handle = createToolMirror(registry);
    expect(() => handle(mkResult({ toolName: "x", details: null }))).not.toThrow();
    expect(() => handle(mkResult({ toolName: "x", details: undefined }))).not.toThrow();
    expect(() => handle(mkResult({ toolName: "x", content: [{ type: "text", text: "hi" }] }))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/tool-mirror.test.ts )`
Expected: FAIL — `Cannot find module "../src/tool-mirror.js"` (file does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `bun-apps/pi-agent-ext-webui/src/tool-mirror.ts`:

```ts
/**
 * tool-mirror.ts — the generic tool-mirror (specs/05 D1–D5). A THIRD producer
 * of the ticket-06 RenderService (alongside the `webui_render` tool and the
 * `"webui:render"` event channel). Subscribes to the AGENT `tool_result` event
 * (on `pi.on`, NOT `pi.events`), formats each result's typed `details` into
 * markdown, and renders an accumulating "tools" view.
 *
 * v1 is GENERIC only: built-in tools format via the SDK type guards; custom
 * tools (incl. image/video-gen) format their `details` as key-value text. NO
 * dedicated renderer, NO binary/URL serving, NO live tool_execution_* streaming
 * (all §Out of Scope). Paths are filesystem strings shown as TEXT.
 *
 * RenderService is REPLACE-ONLY (views.set, never append), so the mirror keeps
 * its OWN in-memory log and re-renders the whole log on every tool_result.
 *
 * Decoupled (ticket-06 D8): a pure producer — no sendUserMessage, no
 * mutex_blocked, no /ws touch; additive to wireWebui; no WebuiHost widening.
 */
import {
  isBashToolResult,
  isEditToolResult,
  isFindToolResult,
  isGrepToolResult,
  isLsToolResult,
  isReadToolResult,
  isWriteToolResult,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { RenderService } from "./render-service.js";

export type ToolMirrorHandler = (event: ToolResultEvent) => void;

export interface ToolMirrorOptions {
  /** Rolling cap: keep at most this many entries (default 50). Enforced in T3. */
  maxEntries?: number;
  /** Rolling cap: total log ≤ this many chars (default 20000). Enforced in T3. */
  maxChars?: number;
}

/** Cap for a single field (stdout/output/command) before it enters the log. */
const FIELD_CAP = 2000;

/** Truncate a string to `cap` chars + ellipsis. */
function cap(s: string, n: number = FIELD_CAP): string {
  return s.length <= n ? s : `${s.slice(0, n)} …[truncated ${s.length - n} chars]`;
}

/**
 * Pure formatter. T1 ships the MINIMAL body (header + truncated-JSON fallback);
 * T2 expands the body with the built-in type guards + custom key-value. The
 * header is the stable scaffold both build on. NEVER throws.
 */
export function formatToolResult(event: ToolResultEvent): string {
  const status = event.isError ? "❌" : "✅";
  const id = (event.toolCallId ?? "").slice(0, 8);
  const header = `### 🔧 ${event.toolName} ${status} \`${id}\``;

  // T1 minimal body: truncated JSON of details. (T2 narrows built-ins via the
  // guards above and custom tools by toolName; the fallback below stays as the
  // unknown-shape path.) Guard references keep the imports live for T2.
  void isBashToolResult;
  void isReadToolResult;
  void isEditToolResult;
  void isWriteToolResult;
  void isGrepToolResult;
  void isFindToolResult;
  void isLsToolResult;

  let body: string;
  try {
    body =
      event.details === undefined
        ? "_(no details)_"
        : "```json\n" + cap(JSON.stringify(event.details, null, 2)) + "\n```";
  } catch {
    body = "_(unserializable details)_";
  }
  return `${header}\n\n${body}`;
}

/**
 * Build a mirror handler bound to a registry. The wiring subscribes the
 * returned handler via `reg("tool_result", createToolMirror(registry))` so it
 * inherits the `disposed` guard used by the outbound broadcast.
 */
export function createToolMirror(
  registry: RenderService,
  _opts: ToolMirrorOptions = {}
): ToolMirrorHandler {
  let log = "";
  return (event) => {
    try {
      const entry = formatToolResult(event);
      log = log ? `${log}\n\n---\n\n${entry}` : entry;
      // T3 enforces the rolling cap here (maxEntries / maxChars). T1 renders the
      // raw accumulating log so the mechanism is testable in isolation.
      registry.render({ content: log, mode: "md", view: "tools", title: "Tools" });
    } catch {
      // A mirror handler must NEVER crash the host event bus.
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/tool-mirror.test.ts )`
Expected: PASS — all cases green.

- [ ] **Step 5: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck )`
Expected: PASS (no output, exit 0) — confirms the `ToolResultEvent` + guard imports from `@earendil-works/pi-coding-agent` type-check.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/tool-mirror.ts bun-apps/pi-agent-ext-webui/tests/tool-mirror.test.ts
git commit -m "feat(webui): add tool-mirror factory + minimal formatToolResult (ticket 05 D1)"
```

> **Review protocol.** Base = previous task's HEAD (the branch tip). Dispatch a **medium-tier implementer** to land T1 RED→GREEN→commit, then a **medium reviewer** to verify (test RED first, then GREEN; typecheck clean; commit scope = exactly the two paths above; no `mlx_native.py`/`MEMORY.md`/`history.txt` staged). Reviewer green → T2 branches from this commit.

---

### Task 2: `formatToolResult` per-tool formatting (built-in guards + custom key-value) — **pins 04-spec §8 `details` shapes**

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/src/tool-mirror.ts` (expand `formatToolResult`'s body)
- Test: `bun-apps/pi-agent-ext-webui/tests/tool-mirror-format.test.ts`

**Interfaces:**
- Consumes: the SDK `is*ToolResult` guards + the `details` shapes verified against `dist/core/tools/*.d.ts` (see the spec's Pins-04-spec-§8 table). The `TruncationResult` carries `{ truncated, truncatedBy, outputLines, totalLines, firstLineExceedsLimit, maxLines, maxBytes }` — the mirror reads only `truncated` (a boolean note).
- Produces: the **expanded** `formatToolResult(event): string` body —
  - **`edit`** (`isEditToolResult`): fenced ` ```diff ` from `details.diff`; `firstChangedLine?` as a one-line navigation note.
  - **`bash`** (`isBashToolResult`): the stdout snippet from `content` text (entries where `type==="text"`, joined, capped) + a `_truncated_` note when `details.truncation?.truncated` + the `details.fullOutputPath` as inline code when present.
  - **`read`** (`isReadToolResult`) / **`grep`** (`isGrepToolResult`) / **`find`** (`isFindToolResult`) / **`ls`** (`isLsToolResult`): a **one-line metadata note** only (`truncation?.truncated`, `matchLimitReached?`, `linesTruncated?`, `resultLimitReached?`, `entryLimitReached?`) — **no content dump**.
  - **`write`** (`isWriteToolResult`): `_(no details)_` (`details` is `undefined` by SDK type).
  - **custom** (none of the guards match — incl. image/video-gen): generic key-value markdown of the **stable string/number/boolean** `details` fields, paths as inline code. Known stable fields: `ok`, `command`, `exitCode`, `outputs[]`/`output`, `manifestPath`/`manifest`, `model`, `elapsedSeconds`, `gate`, `stdout`. Unknown object keys → still rendered generically; non-object `details` → truncated JSON fallback.
  - **per-field truncation:** stdout/output/command strings capped at ~2000 chars (ellipsis).

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-webui/tests/tool-mirror-format.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { formatToolResult } from "../src/tool-mirror.js";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

function mkResult(over: Partial<ToolResultEvent> & { toolName: string }): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: "call-xyz",
    input: {},
    content: [],
    isError: false,
    ...over,
  } as ToolResultEvent;
}

describe("formatToolResult — built-in tools (pins 04-spec §8 details shapes)", () => {
  it("edit -> fenced diff block from details.diff + firstChangedLine note", () => {
    const out = formatToolResult(
      mkResult({
        toolName: "edit",
        details: { diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new", patch: "@@@", firstChangedLine: 3 },
      })
    );
    expect(out).toContain("### 🔧 edit");
    expect(out).toContain("```diff");
    expect(out).toContain("-old");
    expect(out).toContain("+new");
    expect(out).toContain("first changed line");
    expect(out.toLowerCase()).toContain("3");
  });

  it("bash -> stdout snippet from content text + fullOutputPath as inline code (no dump of details)", () => {
    const out = formatToolResult(
      mkResult({
        toolName: "bash",
        content: [{ type: "text", text: "hello stdout\nline2" }],
        details: { truncation: undefined, fullOutputPath: "/tmp/out.log" },
      })
    );
    expect(out).toContain("### 🔧 bash");
    expect(out).toContain("hello stdout");
    expect(out).toContain("`/tmp/out.log`"); // path shown as TEXT (inline code)
    expect(out).not.toContain("```diff");
  });

  it("bash -> shows a truncation note when details.truncation.truncated", () => {
    const out = formatToolResult(
      mkResult({
        toolName: "bash",
        content: [{ type: "text", text: "x" }],
        details: { truncation: { truncated: true, truncatedBy: "bytes", outputLines: 10, totalLines: 100, firstLineExceedsLimit: false, maxLines: 10, maxBytes: 50000 } },
      })
    );
    expect(out.toLowerCase()).toContain("truncat");
  });

  it("read/grep/find/ls -> ONE-LINE metadata note only, NO content dump", () => {
    const grep = formatToolResult(
      mkResult({ toolName: "grep", details: { matchLimitReached: 50, linesTruncated: true } })
    );
    expect(grep).toContain("### 🔧 grep");
    expect(grep).toContain("50"); // matchLimitReached surfaced
    // a one-line note — assert the body has no big content dump (no fenced block)
    expect(grep).not.toContain("```");
  });

  it("ls -> entryLimitReached surfaced as a one-line note", () => {
    const ls = formatToolResult(
      mkResult({ toolName: "ls", details: { entryLimitReached: 100 } })
    );
    expect(ls).toContain("### 🔧 ls");
    expect(ls).toContain("100");
    expect(ls).not.toContain("```");
  });

  it("write -> '(no details)' (details is undefined by SDK type)", () => {
    const out = formatToolResult(mkResult({ toolName: "write", details: undefined }));
    expect(out).toContain("### 🔧 write");
    expect(out).toMatch(/\(no details\)/);
  });
});

describe("formatToolResult — custom tools (generic key-value, paths as TEXT)", () => {
  it("image-gen details -> key-value md of stable fields; outputs[] paths as inline code", () => {
    const out = formatToolResult(
      mkResult({
        toolName: "image", // custom toolName (no guard matches)
        details: {
          ok: true,
          command: "run.py image t2i",
          exitCode: 0,
          outputs: ["/out/a.png", "/out/b.png"],
          manifestPath: "/out/manifest.json",
          model: "z-image",
          elapsedSeconds: 12.5,
          stdout: "done",
        },
      })
    );
    expect(out).toContain("### 🔧 image");
    expect(out).toContain("ok");
    expect(out).toContain("run.py image t2i");
    expect(out).toContain("`/out/a.png`"); // path as TEXT (inline code), NOT <img>
    expect(out).toContain("z-image");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<video");
  });

  it("video-gen details -> key-value md; output/manifest/gate as text", () => {
    const out = formatToolResult(
      mkResult({
        toolName: "video",
        details: { ok: true, exitCode: 0, output: "/out/v.mp4", manifest: "/out/m.json", gate: "passed", stdout: "rendered" },
      })
    );
    expect(out).toContain("### 🔧 video");
    expect(out).toContain("`/out/v.mp4`");
    expect(out).toContain("passed");
    expect(out).not.toContain("<video");
  });

  it("per-field truncation: an oversized stdout is capped (ellipsis)", () => {
    const big = "x".repeat(5000);
    const out = formatToolResult(
      mkResult({ toolName: "bash", content: [{ type: "text", text: big }], details: undefined })
    );
    expect(out).toContain("truncat");
    expect(out.length).toBeLessThan(big.length);
  });

  it("unknown custom details (non-object) -> truncated JSON fallback, no throw", () => {
    const out = formatToolResult(mkResult({ toolName: "weird", details: "just a string" }));
    expect(out).toContain("```json");
    expect(out).toContain("just a string");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/tool-mirror-format.test.ts )`
Expected: FAIL — the T1 minimal body emits `json` fenced blocks for every tool (so the `edit`→`diff`, `bash`→stdout, `read/grep/find/ls`→one-line-note, custom→key-value assertions all fail).

- [ ] **Step 3: Write minimal implementation**

Replace the body of `formatToolResult` in `bun-apps/pi-agent-ext-webui/src/tool-mirror.ts`. (Remove the T1 `void is*ToolResult` lines — the guards are now used.) Keep `cap()` and the header; rewrite the body:

```ts
/** Pull the concatenated text content (bash stdout / generic text). */
function textContent(event: ToolResultEvent): string {
  return (event.content ?? [])
    .filter((c): c is { type: "text"; text: string } => c && (c as { type?: string }).type === "text")
    .map((c) => (c as { text?: string }).text ?? "")
    .join("\n");
}

/** One-line truncation/limit note for read/grep/find/ls. */
function limitNote(d: { truncation?: { truncated?: boolean } } & Record<string, unknown>): string {
  const bits: string[] = [];
  if (d.truncation?.truncated) bits.push("output truncated");
  for (const k of ["matchLimitReached", "resultLimitReached", "entryLimitReached"]) {
    if (typeof d[k] === "number") bits.push(`${k}=${d[k]}`);
  }
  if (d.linesTruncated) bits.push("lines truncated");
  return bits.length ? `_${bits.join("; ")}_` : "";
}

/** Generic key-value markdown of a custom tool's details (paths as inline code). */
function formatCustomDetails(details: unknown): string {
  if (details === null || typeof details !== "object") {
    // non-object fallback -> truncated JSON
    try {
      return "```json\n" + cap(JSON.stringify(details)) + "\n```";
    } catch {
      return "_(unserializable details)_";
    }
  }
  const known = ["ok", "command", "exitCode", "output", "outputs", "manifestPath", "manifest", "model", "elapsedSeconds", "gate", "stdout"] as const;
  const lines: string[] = [];
  const o = details as Record<string, unknown>;
  for (const k of known) {
    if (!(k in o)) continue;
    const v = o[k];
    if (typeof v === "string") {
      // paths/commands as inline code; long stdout/command capped
      lines.push(`- **${k}**: \`${cap(v)}\``);
    } else if (typeof v === "number" || typeof v === "boolean") {
      lines.push(`- **${k}**: ${String(v)}`);
    } else if (Array.isArray(v)) {
      const items = v.map((x) => (typeof x === "string" ? `\`${cap(x)}\`` : String(x)));
      lines.push(`- **${k}**: ${items.join(", ")}`);
    }
  }
  return lines.length ? lines.join("\n") : "_(no stable fields)_";
}

export function formatToolResult(event: ToolResultEvent): string {
  const status = event.isError ? "❌" : "✅";
  const id = (event.toolCallId ?? "").slice(0, 8);
  const header = `### 🔧 ${event.toolName} ${status} \`${id}\``;

  let body: string;
  try {
    if (isEditToolResult(event) && event.details) {
      const d = event.details;
      body = "```diff\n" + cap(d.diff) + "\n```" + (d.firstChangedLine ? `\n\n_first changed line: ${d.firstChangedLine}_` : "");
    } else if (isBashToolResult(event)) {
      const out = cap(textContent(event));
      const note = event.details?.truncation?.truncated ? "\n\n_output truncated_" : "";
      const full = event.details?.fullOutputPath ? `\n\nfull output: \`${event.details.fullOutputPath}\`` : "";
      body = out ? "```\n" + out + "\n```" + note + full : "_(no stdout)_" + note + full;
    } else if (isWriteToolResult(event)) {
      body = "_(no details)_";
    } else if (isReadToolResult(event) || isGrepToolResult(event) || isFindToolResult(event) || isLsToolResult(event)) {
      const note = event.details ? limitNote(event.details as Record<string, unknown> & { truncation?: { truncated?: boolean } }) : "";
      body = note || "_(no metadata)_";
    } else {
      // custom tool (incl. image/video-gen) — generic key-value, paths as TEXT
      body = formatCustomDetails(event.details);
    }
  } catch {
    body = "_(formatting failed)_";
  }
  return `${header}\n\n${body}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/tool-mirror-format.test.ts )`
Expected: PASS — all built-in + custom + truncation cases green.

- [ ] **Step 5: Run the T1 suite to confirm no regression**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/tool-mirror.test.ts )`
Expected: PASS — the T1 mechanism cases still pass against the expanded `formatToolResult` (header unchanged; the `write`/unknown cases now hit the dedicated branches, which still satisfy the T1 assertions).

- [ ] **Step 6: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck )`
Expected: PASS (no output, exit 0).

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/tool-mirror.ts bun-apps/pi-agent-ext-webui/tests/tool-mirror-format.test.ts
git commit -m "feat(webui): expand formatToolResult — built-in guards + custom key-value (pins 04-spec §8 details shapes) (ticket 05 D2)"
```

> **Review protocol.** Base = T1's commit. **Medium implementer** lands T2 RED→GREEN→commit; **medium reviewer** confirms the `details`-shape assertions match the verified SDK shapes (spec Pins-04-spec-§8 table), the D5 deferrals hold (no `<img>`/`<video>`/binary serving — paths are inline code), and the commit scope is exactly the two paths. Reviewer green → T3 branches from this commit.

---

### Task 3: Accumulation + rolling cap (last N entries OR ≤ ~20000 chars)

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/src/tool-mirror.ts` (enforce `ToolMirrorOptions.maxEntries`/`maxChars` in `createToolMirror`)
- Test: `bun-apps/pi-agent-ext-webui/tests/tool-mirror-accumulation.test.ts`

**Interfaces:**
- Consumes: `formatToolResult` (T2) + `RenderService.render`. `ToolMirrorOptions` (T1 — accepted and ignored there; now honored): `{ maxEntries?: number; maxChars?: number }` (defaults 50 / 20000).
- Produces: the **capped** `createToolMirror` — on each event, after appending the formatted entry to the log, enforce the rolling cap:
  - **Entry cap:** if the entry count exceeds `maxEntries`, drop the oldest entries.
  - **Char cap:** if the total log length exceeds `maxChars`, drop oldest entries until under budget; if a **single** entry alone exceeds `maxChars`, truncate that entry so the view never exceeds the budget.
  - The split is `"\n\n---\n\n"` between entries (a horizontal rule, markdown-friendly). The cap is computed on the joined log.

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-webui/tests/tool-mirror-accumulation.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { createToolMirror } from "../src/tool-mirror.js";
import { RenderService } from "../src/render-service.js";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

function mkResult(toolName: string, id: string, text = "x"): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: id,
    input: {},
    content: [{ type: "text", text }],
    isError: false,
    toolName,
  } as ToolResultEvent;
}

function logOf(r: RenderService): string {
  return r.getView("tools")?.content ?? "";
}

describe("createToolMirror — rolling accumulation + cap", () => {
  it("accumulates entries separated by a horizontal rule", () => {
    const r = new RenderService({ urlFor: () => "#", now: () => 1 });
    const handle = createToolMirror(r, { maxEntries: 50, maxChars: 20000 });
    handle(mkResult("bash", "id1"));
    handle(mkResult("bash", "id2"));
    expect(logOf(r)).toContain("### 🔧 bash");
    expect(logOf(r)).toContain("`id1`".slice(0, 0) + "id1".slice(0, 8)); // id1 present
    expect(logOf(r)).toContain("---"); // entry separator
    expect(logOf(r).match(/### 🔧 bash/g)?.length).toBe(2);
  });

  it("drops the OLDEST entry once maxEntries is exceeded", () => {
    const r = new RenderService({ urlFor: () => "#", now: () => 1 });
    const handle = createToolMirror(r, { maxEntries: 3, maxChars: 100000 });
    handle(mkResult("bash", "aaaa1111"));
    handle(mkResult("bash", "bbbb2222"));
    handle(mkResult("bash", "cccc3333"));
    handle(mkResult("bash", "dddd4444")); // exceeds 3 -> drop aaaa
    const log = logOf(r);
    expect(log).not.toContain("aaaa1");
    expect(log).toContain("bbbb2");
    expect(log).toContain("dddd4");
    expect(log.match(/### 🔧 bash/g)?.length).toBe(3);
  });

  it("enforces the char budget by dropping oldest entries", () => {
    const r = new RenderService({ urlFor: () => "#", now: () => 1 });
    const handle = createToolMirror(r, { maxEntries: 1000, maxChars: 500 });
    for (let i = 0; i < 10; i++) handle(mkResult("bash", `id${i}00000000`, "y".repeat(80)));
    expect(logOf(r).length).toBeLessThanOrEqual(500);
    // the most recent entry is present; the earliest are dropped
    expect(logOf(r)).toContain("id9000000".slice(0, 8));
  });

  it("a SINGLE entry larger than maxChars is itself truncated (never exceeds budget)", () => {
    const r = new RenderService({ urlFor: () => "#", now: () => 1 });
    const handle = createToolMirror(r, { maxEntries: 50, maxChars: 300 });
    handle(mkResult("bash", "big00000", "z".repeat(5000)));
    expect(logOf(r).length).toBeLessThanOrEqual(300);
    expect(logOf(r)).toContain("### 🔧 bash");
  });

  it("rapid tool_results never grow the log unbounded (count AND size bounded)", () => {
    const r = new RenderService({ urlFor: () => "#", now: () => 1 });
    const handle = createToolMirror(r); // defaults 50 / 20000
    for (let i = 0; i < 500; i++) handle(mkResult("bash", `${i}0000000000`, "w".repeat(50)));
    const log = logOf(r);
    expect(log.length).toBeLessThanOrEqual(20000);
    expect(log.match(/### 🔧 bash/g)?.length ?? 0).toBeLessThanOrEqual(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/tool-mirror-accumulation.test.ts )`
Expected: FAIL — T1's `createToolMirror` ignores `opts`, so the log grows unbounded (the `maxEntries`/`maxChars` assertions all fail).

- [ ] **Step 3: Write minimal implementation**

Rewrite `createToolMirror` in `bun-apps/pi-agent-ext-webui/src/tool-mirror.ts` to honor the cap (replace the T1 body that ignored `_opts`):

```ts
const SEP = "\n\n---\n\n";

export function createToolMirror(
  registry: RenderService,
  opts: ToolMirrorOptions = {}
): ToolMirrorHandler {
  const maxEntries = opts.maxEntries ?? 50;
  const maxChars = opts.maxChars ?? 20000;
  let entries: string[] = [];

  const flush = (): void => {
    registry.render({ content: entries.join(SEP), mode: "md", view: "tools", title: "Tools" });
  };

  return (event) => {
    try {
      let entry = formatToolResult(event);
      // single entry larger than the whole budget: truncate it in place
      if (entry.length > maxChars) entry = entry.slice(0, maxChars);
      entries.push(entry);

      // entry cap
      if (entries.length > maxEntries) entries = entries.slice(entries.length - maxEntries);

      // char cap: drop oldest until under budget
      let joined = entries.join(SEP);
      while (joined.length > maxChars && entries.length > 1) {
        entries.shift();
        joined = entries.join(SEP);
      }
      flush();
    } catch {
      // a mirror handler must NEVER crash the host event bus
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/tool-mirror-accumulation.test.ts )`
Expected: PASS — all cap cases green.

- [ ] **Step 5: Run the T1 + T2 suites to confirm no regression**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/tool-mirror.test.ts tests/tool-mirror-format.test.ts )`
Expected: PASS — the mechanism (T1) and per-tool formatting (T2) cases still pass; the default cap (50/20000) is large enough that none of those tests trip it.

- [ ] **Step 6: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck )`
Expected: PASS (no output, exit 0).

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/tool-mirror.ts bun-apps/pi-agent-ext-webui/tests/tool-mirror-accumulation.test.ts
git commit -m "feat(webui): tool-mirror rolling cap (last N entries OR ≤ maxChars) (ticket 05 D3)"
```

> **Review protocol.** Base = T2's commit. **Medium implementer** lands T3 RED→GREEN→commit; **medium reviewer** confirms both caps (count + size) bound the log under a flood, the over-budget-single-entry truncation holds, and T1/T2 suites still green. Reviewer green → T4 branches from this commit.

---

### Task 4: Integration — wire `createToolMirror` into `wireWebui` + e2e + D8 negative control

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts` (add the import + one `reg("tool_result", createToolMirror(registry))` line)
- Test: `bun-apps/pi-agent-ext-webui/tests/tool-mirror-integration.test.ts`

**Interfaces:**
- Consumes: `createToolMirror` (T1+T2+T3), the wiring's `reg(event, handler)` seam + `registry` (both already in `wireWebui`), the live `WebServer` + SSE (`GET /api/events`), and the `wiring-live-smoke.test.ts` harness pattern (`MockPi`/`makeServer`/`withTimeout`/`waitFor`/`setup`). `tool_result` is the agent event the `MockPi.emit(event, payload, ctx)` helper already replays.
- Produces:
  - The **wired** mirror: inside `wireWebui`, after `const reg = …` is defined (the mirror needs the `disposed` guard, and `tool_result` is an agent event, not a `pi.events` channel), add `reg("tool_result", createToolMirror(registry));`. `registry` is already in scope (constructed in the render-framework block above). **No other wiring change** — `WebuiHost` is unchanged.
  - **Integration behavior:** through the REAL `wireWebui`, a `tool_result` replayed via `MockPi.emit("tool_result", event, ctx)` → (a) a `"tools"` view appears (`GET /api/views` lists it; `GET /api/view/tools` returns server-rendered md HTML containing the formatted header), (b) the SSE channel delivers a `view_update` for `tools`. **D8 negative control:** the mirror path does **not** call `sendUserMessage` and does **not** broadcast a `mutex_blocked`/chat frame on `/ws`. Whole-package suite green.

- [ ] **Step 1: Write the failing integration test**

Create `bun-apps/pi-agent-ext-webui/tests/tool-mirror-integration.test.ts`:

```ts
/**
 * tool-mirror-integration.test.ts — end-to-end for the generic tool-mirror
 * (ticket 05), driving the REAL wireWebui composition root against a minimal
 * MockPi host + a REAL WebServer. Mirrors wiring-live-smoke.test.ts's harness
 * (withTimeout / waitFor / openWs / MockPi). The mirror is wired by T4; this
 * suite proves a tool_result -> "Tools" tab + SSE update + D8 preserved.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { WebServer } from "../src/web-server.js";
import {
  wireWebui,
  type WebuiHost,
  type WebuiWiring,
  type RenderHostEvents,
  type WebuiSessionCtx,
} from "../src/webui-wiring.js";

// --- harness (copied from wiring-live-smoke.test.ts) -----------------------

const started: WebServer[] = [];
function makeServer(): WebServer {
  const s = new WebServer({ port: 0 });
  started.push(s);
  return s;
}
const wirings: WebuiWiring[] = [];
const openClients: WebSocket[] = [];
afterEach(() => {
  while (wirings.length) { try { wirings.pop()!.dispose(); } catch { /* ignore */ } }
  for (const ws of openClients) { try { ws.close(); } catch { /* ignore */ } }
  openClients.length = 0;
  while (started.length) { try { started.pop()!.stop(); } catch { /* ignore */ } }
});
function withTimeout<T>(p: Promise<T>, ms = 2000, label = "timed out"): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error(label)), ms))]);
}
async function waitFor(name: string, predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (predicate()) return; await Bun.sleep(5); }
  throw new Error(`waitFor(${name}) timed out after ${ms}ms`);
}
function openWs(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  openClients.push(ws);
  return new Promise<WebSocket>((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("ws open failed"));
  });
}

/** Minimal WebuiHost matching wiring-live-smoke's MockPi (events + registerTool
 *  already required by ticket 06). No new surface — the mirror needs none. */
class MockPi implements WebuiHost {
  readonly handlers = new Map<string, (event: any, ctx: any) => any>();
  readonly sent: Array<{ content: string | unknown[]; opts?: { deliverAs?: "steer" | "followUp" } }> = [];
  readonly registeredTools: unknown[] = [];
  readonly events: RenderHostEvents;
  constructor() {
    const channels = new Map<string, Set<(data: unknown) => void>>();
    this.events = {
      on(channel, handler) {
        let set = channels.get(channel);
        if (!set) { set = new Set(); channels.set(channel, set); }
        set.add(handler);
        return () => { set!.delete(handler); };
      },
      emit(channel, data) { channels.get(channel)?.forEach((h) => h(data)); },
    };
  }
  on(event: string, handler: (event: any, ctx: any) => any): void { this.handlers.set(event, handler); }
  sendUserMessage(content: string | unknown[], opts?: { deliverAs?: "steer" | "followUp" }): void {
    this.sent.push({ content, opts });
  }
  registerTool(tool: unknown): void { this.registeredTools.push(tool); }
  emit(event: string, payload: any = {}, ctx: any = undefined): any {
    const h = this.handlers.get(event);
    return h ? h(payload, ctx) : undefined;
  }
  ctx(): WebuiSessionCtx {
    const self = this;
    return { abort() {}, ui: { notify() {}, setStatus() {} } };
  }
}

function setup(): { pi: MockPi; server: WebServer; wiring: WebuiWiring } {
  const pi = new MockPi();
  const server = makeServer();
  const wiring = wireWebui(pi, { server });
  wirings.push(wiring);
  return { pi, server, wiring };
}

// ---------------------------------------------------------------------------

describe("wireWebui tool-mirror — end-to-end", () => {
  it("a tool_result -> 'tools' view appears with formatted md", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    // replay a real tool_result into the wiring's registered handler
    pi.emit("tool_result", {
      type: "tool_result",
      toolCallId: "deadbeefcafe",
      toolName: "edit",
      input: {},
      content: [],
      isError: false,
      details: { diff: "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y", patch: "@@@", firstChangedLine: 1 },
    }, pi.ctx());
    const views = await (await fetch(`${server.url}/api/views`)).json();
    expect(views.some((v: { id: string }) => v.id === "tools")).toBe(true);
    const v = await (await fetch(`${server.url}/api/view/tools`)).json();
    expect(v.mode).toBe("md");
    expect(v.html).toContain("🔧 edit"); // server-rendered md -> html
    expect(v.html).toContain("```diff".replace(/```/, "")); // diff surfaced
    expect(v.html).toContain("-x");
  });

  it("a tool_result -> SSE delivers a view_update for 'tools'", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const ctrl = new AbortController();
    const res = await fetch(`${server.url}/api/events`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    await withTimeout(reader.read(), 2000, "no initial chunk"); // swallow :connected
    pi.emit("tool_result", { type: "tool_result", toolCallId: "c1", toolName: "bash", input: {}, content: [{ type: "text", text: "hi" }], isError: false, details: undefined }, pi.ctx());
    let payload: { viewId?: string } | null = null;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !payload) {
      const chunk = await Promise.race([reader.read(), new Promise<{ done: true }>((r) => setTimeout(() => r({ done: true }), 40))]);
      if ("value" in chunk && chunk.value) buf += dec.decode(chunk.value, { stream: true });
      const m = buf.match(/data: (\{.*\})\n\n/);
      if (m) payload = JSON.parse(m[1]);
    }
    expect(payload).toMatchObject({ viewId: "tools" });
    ctrl.abort();
  });
});

describe("wireWebui tool-mirror — decoupling (spec D8)", () => {
  it("the mirror path does NOT call sendUserMessage and does NOT broadcast a /ws frame", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const ws = await withTimeout(openWs(`${server.url.replace("http", "ws")}/ws`), 2000, "ws open");
    await waitFor("client registered", () => server.clientCount === 1);
    let gotFrame = false;
    ws.onmessage = () => { gotFrame = true; };
    // drive the mirror with several tool_results
    for (let i = 0; i < 5; i++) {
      pi.emit("tool_result", { type: "tool_result", toolCallId: `c${i}`, toolName: "bash", input: {}, content: [{ type: "text", text: "x" }], isError: false, details: undefined }, pi.ctx());
    }
    await Bun.sleep(120); // give any (absent) broadcast time to never arrive
    expect(pi.sent).toEqual([]); // mirror never injects a user message
    expect(gotFrame).toBe(false); // no mutex_blocked / no chat frame on the mirror path
    ws.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/tool-mirror-integration.test.ts )`
Expected: FAIL — the mirror is not wired yet, so `pi.emit("tool_result", …)` updates no view (`GET /api/views` has no `tools`); the SSE case never sees a `view_update` for `tools`.

- [ ] **Step 3: Write minimal implementation**

3a. In `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts`, add the import near the existing render-module imports:

```ts
import { createToolMirror } from "./tool-mirror.js";
```

3b. Wire the mirror. Locate the `// --- pi.on registration (each handler guarded by 'disposed') ---` block and the `const reg = (event, handler) => { … };` definition. **Immediately after** that `const reg = …;` line (so `reg` is in scope), add:

```ts
  // --- tool-mirror (ticket 05) — third producer of RenderService ----------
  // Subscribes tool_result on the AGENT bus (pi.on) via the SAME reg() guard as
  // the outbound broadcast. tool_result is already in OUTBOUND_EVENTS (a second
  // handler that broadcasts verbatim); the pi bus fires ALL handlers, so this is
  // additive. NOT pi.events (that is the separate "webui:render" channel).
  reg("tool_result", createToolMirror(registry));
```

(No other change. `registry` is already in scope — constructed in the render-framework block above. `WebuiHost` is unchanged.)

- [ ] **Step 4: Run the new integration test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/tool-mirror-integration.test.ts )`
Expected: PASS — the "tools" view appears with formatted md; the SSE delivers a `view_update` for `tools`; the D8 negative control holds (no `sendUserMessage`, no `/ws` frame).

- [ ] **Step 5: Run the FULL suite + typecheck (the real conformance gate)**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck && bun test )`
Expected: typecheck PASS (no output, exit 0); every test file green — including the pre-existing `wiring-live-smoke.test.ts`, `render-integration.test.ts`, `web-server.test.ts`, and the T1/T2/T3 mirror suites. Sanity spot-checks: a `tool_result` updates the "tools" view; the mirror is a second `tool_result` handler alongside the outbound broadcast (the broadcast still works); no `WebuiHost` widening (the wiring adds one line); render/chat/mutex behavior unchanged (ticket-06 D8 still holds).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/webui-wiring.ts bun-apps/pi-agent-ext-webui/tests/tool-mirror-integration.test.ts
git commit -m "feat(webui): wire tool-mirror into wireWebui + e2e (tool_result -> tools view; D8 preserved) (ticket 05 D1+D8)"
```

> **Review protocol.** Base = T3's commit. **Medium implementer** lands T4 RED→GREEN→commit; **medium reviewer** confirms: the wiring is a single additive `reg("tool_result", createToolMirror(registry))` line (no `WebuiHost` change), the D8 negative control passes (no `sendUserMessage`/`mutex_blocked`/`/ws` frame), the SSE `view_update` fires for `tools`, the existing `wiring-live-smoke`/`render-integration` suites stay green, and the commit scope is exactly the two paths. Reviewer green → ticket 05 EXECUTE complete.

---

## Notes for the implementer

- **D8 is load-bearing.** If any mirror code path needs to call `pi.sendUserMessage`, acquire a mutex, or send a `/ws` frame, stop — that is a design violation. The negative-control test in T4 guards this permanently. The mirror is a pure producer of one view.
- **`tool_result` is on `pi.on`, NOT `pi.events`.** The `"webui:render"` channel (the second ticket-06 producer) is on the separate `pi.events` `EventBus`; the mirror must NOT subscribe there. `tool_result` is an agent event, **exact-name only, no wildcard/prefix** (the SDK bus offers none). The mirror subscribes via the wiring's `reg("tool_result", …)` seam.
- **The pi bus fires ALL handlers for an event.** `tool_result` is already registered via `reg()` for the outbound broadcast (it is in `OUTBOUND_EVENTS`). The mirror is a SECOND `reg("tool_result", …)` handler that runs alongside (not instead of) the broadcast — both fire on each `tool_result`. Do not remove or displace the broadcast.
- **`RenderService` is replace-only.** `render()` does `views.set(viewId, view)` (overwrite, never append); there is NO append/log capability. The mirror keeps its OWN in-memory log and re-renders the whole log on every `tool_result`. Never assume the registry accumulates.
- **No new dependency.** The mirror is plain TS over the SDK types (`ToolResultEvent` + the `is*ToolResult` guards, both exported from the `@earendil-works/pi-coding-agent` root) and the existing `RenderService`. `marked` is already a ticket-06 dep; the mirror emits raw markdown and lets `/api/view/:id` render it server-side.
- **`TextContent`/`ImageContent` are NOT SDK-root-exported.** Tests build synthetic events via the `mkResult(…)` cast helper (the `as ToolResultEvent` cast through `Partial`), mirroring the 06 plan's `{} as never` for un-exported internal types. Production code reads `content` defensively (`c.type === "text"`).
- **The `details` shapes are pinned by T2.** T2's `tool-mirror-format.test.ts` is the 04-spec §8 pinning this ticket owns. If a future SDK rename drops a field the formatter reads (`diff`, `fullOutputPath`, `matchLimitReached`, …), T2 goes RED and the formatter is updated before the field round-trips silently — exactly the η-class failure the 04 deferral guarded against.
- **No binary serving.** Paths (`outputs[]`/`output`/`manifestPath`/`fullOutputPath`) are filesystem strings shown as **inline code text** — never `<img>`/`<video>`/`<a href>`, and the webui serves **no** binary route in v1 (§Out of Scope). A dedicated image/video inline preview + artifact-serving route are explicitly deferred (D5).
- **Staging discipline (every commit).** `git add` ONLY the explicit paths in each task's Commit step — never `git add -A`/`.`/`-u`. Never commit `python/embed-bench/backends/mlx_native.py`, `.agents/memory/MEMORY.md`, or `history.txt`. No top-level `cd` — run package commands as `( cd bun-apps/pi-agent-ext-webui && … )`.
