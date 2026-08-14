# Phase 5 — Drop the Mirror + open-ledger hardening (FINAL) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the HITL-webui build (spec Component 6 + Decision B): delete the generic tool-mirror and the `webui_render` tool (pure subtraction), prove the removal with negative tests against the real-server harness, and close the three open-ledger items from `sdd/progress.md`.

**Architecture:** Phase 5 is the final subtraction phase of the 5-phase SDD effort. The `webui_present` tool (Phase 2) is now the only registered producer tool; the tool-mirror (a third producer accumulating a "tools" view from `tool_result` events) and the `webui_render` tool (non-blocking render) are deleted outright. The `webui:render` event handler stays DORMANT (Decision B), and the outbound `tool_result` broadcast stays untouched (protocol fidelity). Task 2/3 harden pure functions flagged in the Phase-4 final review.

**Tech Stack:** Bun + `bun:test`, TypeScript (strict), TypeBox, no new dependencies.

## Global Constraints (carried from prior phases — verbatim values)

- Loopback-only, auth OFF — `server.setTokenAuth(null)` and the loopback/originAllowed boundary are UNTOUCHED by this phase.
- Test gate: `( cd bun-apps/pi-agent-ext-webui && bun run test )` — the package `test` script is `bun run build && bun test` (build = `bunx tsc`). The package `tsconfig` includes only `src/**`, so `bun test` (not typecheck alone) is the gate. **Expected final count: 290 passing, 0 failing** (derivation below).
- Zero cross-package imports; no new deps (package.json untouched).
- SSE payload + heartbeat + `/api/logs` untouched.
- `render-shell.ts` (shell HTML) is NOT touched by any task in this phase.
- All written artifacts (code, comments, commit messages) in English.

## Ground already verified (do not re-litigate)

- `grep` for `createRenderTool|createToolMirror|formatToolResult|RenderParameters|tool-mirror|render-tool` across `src/`, `tests/`, `extensions/`: the ONLY consumers are `src/webui-wiring.ts` (imports + 2 call sites), the 5 deleted test files, and 3 comment-only references (`src/webui-wiring.ts:154`, `src/present-tool.ts:12`, `tests/helpers/mock-pi.ts:87`). `extensions/webui.ts` and `src/index.ts` have ZERO references — deletion is safe.
- `tool_result` remains in `OUTBOUND_EVENTS` (webui-wiring.ts), so `tests/webui-wiring.test.ts:150`'s expected pi.on event SET is UNCHANGED by this phase — no edit to that file.
- `render-shell.ts` is view-id agnostic (zero occurrences of `"tools"`) — the mirror's "tools" view vanishes silently from the shell with no shell change.
- KNOWN STALE REFERENCE (controller note — DO NOT TOUCH): `bun-apps/pi-agent-ext-devops/scripts/deploy.ts:572` cites `pi-agent-ext-webui's src/tool-mirror.ts` in a comment about bare-specifier resolution. It is a DIFFERENT package and the comment's point (sibling extensions import bare specifiers) remains true after deletion. Leave it; log it in the final review report.
- Expected test-count derivation (from files read): current suite = 312 (Phase-4 final review). DELETED test files: `tool-mirror.test.ts` (6 tests), `tool-mirror-format.test.ts` (10), `tool-mirror-accumulation.test.ts` (5), `tool-mirror-integration.test.ts` (3), `render-tool.test.ts` (3) = **27 removed**. `render-integration.test.ts`: 6 → 7 (remove 1 tool-execute test, add 2 negatives). `image-presentation.test.ts`: 18 → 21 (+3). `present-event-handler.test.ts`: 4 → 5 (+1). Total: **312 − 27 − 1 + 2 + 3 + 1 = 290**.

## File Structure

- Delete: `bun-apps/pi-agent-ext-webui/src/tool-mirror.ts` (mirror + `formatToolResult`), `bun-apps/pi-agent-ext-webui/src/render-tool.ts` (`webui_render` tool), `tests/tool-mirror.test.ts`, `tests/tool-mirror-format.test.ts`, `tests/tool-mirror-accumulation.test.ts`, `tests/tool-mirror-integration.test.ts`, `tests/render-tool.test.ts`.
- Modify: `bun-apps/pi-agent-ext-webui/tests/render-integration.test.ts` (surgical rewrites + 2 negative tests), `src/webui-wiring.ts` (2 imports, 2 registrations, 2 comments), `tests/helpers/mock-pi.ts` (comment only), `src/present-tool.ts` (comment only), `src/image-presentation.ts` (percent-encode), `tests/image-presentation.test.ts` (+3 tests), `src/present-event-handler.ts` (`view` guard), `tests/present-event-handler.test.ts` (+1 test), `tests/output-routes.test.ts` (drop unused import).
- KEEP (verified decoupled — the plan states this as invariant, NOT touched): `src/render-event-handler.ts` + its tests (Decision B: dormant, retained for a future non-blocking render), `src/render-service.ts`, `src/render-routes.ts`, `src/render-shell.ts` (view-id agnostic — "tools" view vanishes silently), the outbound `tool_result` broadcast in `OUTBOUND_EVENTS` (protocol fidelity), announce-on-first-render (event/registry-driven, no tool dependency).

---

### Task 1: Drop the tool-mirror + `webui_render` tool (pure subtraction, TDD red→green)

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/tests/render-integration.test.ts` (5 surgical edits: L130-143, L145-154, L163-170, L201-217, append a new describe)
- Delete: `bun-apps/pi-agent-ext-webui/src/tool-mirror.ts`, `bun-apps/pi-agent-ext-webui/src/render-tool.ts`
- Delete: `bun-apps/pi-agent-ext-webui/tests/tool-mirror.test.ts`, `tests/tool-mirror-format.test.ts`, `tests/tool-mirror-accumulation.test.ts`, `tests/tool-mirror-integration.test.ts`, `tests/render-tool.test.ts`
- Modify: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts` (L46, L50, L103-104, L154, L375, L415-421), `tests/helpers/mock-pi.ts` (L87 comment), `src/present-tool.ts` (L12 comment)

**Interfaces:**
- Consumes: `wireWebui(pi, { server })` + the real-server MockPi harness already in `render-integration.test.ts` (setup/afterEach/withTimeout untouched); `pi.events.emit("webui:render", …)` (the dormant channel, Decision B); `pi.registeredTools` (MockPi records every `registerTool` call).
- Produces: NOTHING new. Net removal: exports `createToolMirror`, `formatToolResult`, `ToolMirrorHandler`, `ToolMirrorOptions` (tool-mirror.ts) and `createRenderTool`, `RenderParameters` (render-tool.ts) cease to exist. No other file imports them (verified). Later tasks depend on nothing from this task except a green suite.

**Context for the implementer:** the mirror was a THIRD producer of RenderService accumulating every `tool_result` into a "tools" view; the spec's Destination line says "Passive tool-result mirroring is **dropped**" and Component 6 + Decision B resolve to: mirror gone, `webui_render` tool gone, `webui:render` event handler stays dormant. The `webui_present` tool (Phase 2) is the only registered tool after this task. Note on the local MockPi in `render-integration.test.ts`: its `handlers` map keeps ONE handler per event (`this.handlers.set(event, handler)` — last registration wins), and wiring registers the outbound broadcast loop AFTER the mirror, so even pre-subtraction the broadcast is the live `tool_result` handler in THIS harness — negative test (ii) may already pass before the subtraction; negative test (i) is the true red signal.

- [ ] **Step 1: Rewrite the four tool-dependent tests in `tests/render-integration.test.ts`**

Edit 1 — first test (L130-135): drop the `webui_render` assertion, assert `webui_present` instead. KEEP the `webui:render` → `/api/view/preview` half verbatim.

Old:

```ts
  it("registers the webui_render tool + webui:render subscription during wiring", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const tools = pi.registeredTools as Array<{ name: string }>;
    expect(tools.some((t) => t.name === "webui_render")).toBe(true);
```

New:

```ts
  it("registers the webui_present tool + webui:render subscription during wiring", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const tools = pi.registeredTools as Array<{ name: string }>;
    expect(tools.some((t) => t.name === "webui_present")).toBe(true);
```

Edit 2 — delete the tool-execute test (L145-154) entirely, including its trailing blank line:

```ts
  it("the tool execute() path lands in the same registry and is served", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const tool = (pi.registeredTools as Array<{ name: string; execute: (...a: any[]) => Promise<any> }>)
      .find((t) => t.name === "webui_render")!;
    const out = await tool.execute("c1", { content: "**bold**", view: "toolview" }, undefined, undefined, {});
    expect(out.details.url).toContain("/#toolview");
    const v = await (await fetch(`${server.url}/api/view/toolview`)).json();
    expect(v.html).toContain("<strong>bold</strong>");
  });

```

Edit 3 — the loopback-URL test (L163-170): the URL was only observable via the deleted tool's return value, so rewrite it event-driven. The registry's `urlFor` composes `${server.url}/#<id>`; the fragment is client-side routing, so fetching that address is a GET / → the render shell. This is the minimal rewrite (registry is internal to `wireWebui`, so the fetch path is the only real-server observation point).

Old:

```ts
  it("render() returns the loopback URL composed from server.url", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const tool = (pi.registeredTools as Array<{ name: string; execute: (...a: any[]) => Promise<any> }>)
      .find((t) => t.name === "webui_render")!;
    const out = await tool.execute("c", { content: "x", view: "z" }, undefined, undefined, {});
    expect(out.details.url).toBe(`${server.url}/#z`);
  });
```

New:

```ts
  it("the loopback view URL (server.url/#id) is a live address (event-driven; webui_render is gone)", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    pi.events.emit("webui:render", { content: "x", view: "z" });
    const views = await (await fetch(`${server.url}/api/views`)).json();
    expect(views).toMatchObject([{ id: "z" }]);
    // The URL form the framework composes is `${server.url}/#z`; the fragment
    // is client-side routing, so that address is a GET / -> the render shell.
    const body = await (await fetch(`${server.url}/#z`)).text();
    expect(body).toContain("webui-render-shell");
  });
```

Edit 4 — decoupling test (L201-217): keep the event half + both assertions, drop the tool-execute half.

Old:

```ts
    // Drive BOTH producer paths.
    pi.events.emit("webui:render", { content: "# via-event" });
    const tool = (pi.registeredTools as Array<{ name: string; execute: (...a: any[]) => Promise<any> }>)
      .find((t) => t.name === "webui_render")!;
    await tool.execute("c", { content: "# via-tool", view: "t" }, undefined, undefined, {});
```

New:

```ts
    // Drive the event producer path (webui_render is dropped — spec Decision B).
    pi.events.emit("webui:render", { content: "# via-event", view: "t" });
```

- [ ] **Step 2: Append the two negative tests (spec Tests section — "Drop mirror")**

Append this describe block at the END of `tests/render-integration.test.ts` (after the existing `describe("wireWebui render framework — decoupling (spec D8)")` block; it reuses the same harness — `setup()`, `pi.emit`, real `server.url`):

```ts
describe("wireWebui render framework — mirror removal (spec Component 6, Decision B)", () => {
  it("NEGATIVE: registeredTools has NO webui_render; webui_present IS registered", () => {
    const { pi } = setup();
    pi.emit("session_start", {}, pi.ctx());
    const tools = pi.registeredTools as Array<{ name: string }>;
    expect(tools.some((t) => t.name === "webui_render")).toBe(false);
    expect(tools.some((t) => t.name === "webui_present")).toBe(true);
  });

  it("NEGATIVE: a tool_result event mints NO 'tools' view (only the outbound broadcast fires)", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", {}, pi.ctx());
    // A realistic tool_result on the AGENT bus (pi.on path). Before Phase 5 the
    // mirror rendered this into an accumulating "tools" view; after, the only
    // tool_result handler is the OUTBOUND_EVENTS broadcast loop (this MockPi
    // keeps ONE handler per event, and the broadcast registers LAST).
    pi.emit("tool_result", {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "call-abcd1234efgh",
      input: {},
      content: [{ type: "text", text: "hello" }],
      isError: false,
    });
    const views = await (await fetch(`${server.url}/api/views`)).json();
    expect(views).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the suite to verify the red signal**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-integration.test.ts )`
Expected: the first NEGATIVE test FAILS (`webui_render` is still registered). The second negative may PASS pre-subtraction (mock keeps one handler per event — see context note); the rewritten tests 1/3/4 PASS (`webui_present` is already registered; the event channel is untouched).

- [ ] **Step 4: Delete the source files + their dedicated test files**

```bash
git rm bun-apps/pi-agent-ext-webui/src/tool-mirror.ts \
       bun-apps/pi-agent-ext-webui/src/render-tool.ts \
       bun-apps/pi-agent-ext-webui/tests/tool-mirror.test.ts \
       bun-apps/pi-agent-ext-webui/tests/tool-mirror-format.test.ts \
       bun-apps/pi-agent-ext-webui/tests/tool-mirror-accumulation.test.ts \
       bun-apps/pi-agent-ext-webui/tests/tool-mirror-integration.test.ts \
       bun-apps/pi-agent-ext-webui/tests/render-tool.test.ts
```

- [ ] **Step 5: Edit `src/webui-wiring.ts` — remove the two imports**

Delete these two lines (L46 and L50):

```ts
import { createRenderTool } from "./render-tool.js";
```

```ts
import { createToolMirror } from "./tool-mirror.js";
```

- [ ] **Step 6: Edit `src/webui-wiring.ts` — drop the `webui_render` registration (~L375)**

Delete exactly this line (the guarded-seam comment block above it stays — it still accurately describes the `events`/`registerTool` guards used by `webui_present`):

```ts
  pi.registerTool?.(createRenderTool(registry));
```

- [ ] **Step 7: Edit `src/webui-wiring.ts` — drop the tool-mirror registration (~L415-421)**

Delete this whole block (comment + registration + its blank line):

```ts
  // --- tool-mirror (ticket 05) — third producer of RenderService ----------
  // Subscribes tool_result on the AGENT bus (pi.on) via the SAME reg() guard as
  // the outbound broadcast. tool_result is already in OUTBOUND_EVENTS (a second
  // handler that broadcasts verbatim); the pi bus fires ALL handlers, so this is
  // additive. NOT pi.events (that is the separate "webui:render" channel).
  reg("tool_result", createToolMirror(registry));

```

- [ ] **Step 8: Edit `src/webui-wiring.ts` — reword the two stale comments**

L103-104 (`WebuiHost.registerTool` JSDoc) — old:

```ts
  /** Tool registrar (ticket 06 registers "webui_render"). Optional — see
   *  {@link events}; guarded so a host without the seam boots cleanly. */
```

new:

```ts
  /** Tool registrar (the wiring registers "webui_present"). Optional — see
   *  {@link events}; guarded so a host without the seam boots cleanly. */
```

L154 (`HitlResponse` JSDoc) — old:

```ts
 * alongside WebuiWiring (render-tool exports its types; same convention).
```

new:

```ts
 * alongside WebuiWiring (present-tool exports its types; same convention).
```

- [ ] **Step 9: Comment-only edits in two other files**

`tests/helpers/mock-pi.ts` L87 — old:

```ts
  /** Register a tool (ticket 06 render framework registers "webui_render"). */
```

new:

```ts
  /** Register a tool (the wiring registers "webui_present"). */
```

`src/present-tool.ts` L12 (references the deleted `createRenderTool`) — old:

```ts
 * Deliberately a FACTORY over explicit deps (mirroring createRenderTool) so the
```

new:

```ts
 * Deliberately a FACTORY over explicit deps so the
```

(Read the surrounding comment first; replace ONLY that one line's symbol reference, keeping the sentence coherent.)

- [ ] **Step 10: Run the FULL gate — expect exactly 286 passing**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run test )`
Expected: build (`bunx tsc`) exits 0 — no dangling imports of the deleted modules anywhere in `src/`; then `bun test` passes with **286 tests, 0 failing** (312 − 27 deleted-file tests − 1 removed render-integration test + 2 new negatives = 286). If `tsc` reports a missing module, some file still imports `./tool-mirror.js` or `./render-tool.js` — grep `rg -n "tool-mirror|render-tool" src/ tests/` and remove the stray import (only comments should remain).

- [ ] **Step 11: Commit**

```bash
git add bun-apps/pi-agent-ext-webui
git commit -m "feat(webui): drop tool-mirror + webui_render tool (spec Component 6, Decision B)

Pure subtraction: webui_present is the only registered producer tool; the
webui:render event handler stays dormant (Decision B); outbound tool_result
broadcast untouched. Negative tests pin the removal against the real server."
```

---

### Task 2: `imageMd` percent-encodes the rel path (ledger [P4-final] #1)

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/src/image-presentation.ts` (the `imageMd` return line)
- Test: `bun-apps/pi-agent-ext-webui/tests/image-presentation.test.ts` (3 new tests in the `describe("imageMd")` block)

**Interfaces:**
- Consumes: `imageMd(absPath: string, outputDir: string): string | null` — unchanged signature; existing 8 tests in the `imageMd` describe must keep passing.
- Produces: same signature, now percent-encoded URL: `![image](/output/0/<encodeURI(rel)>)`. The `/output` serving route decodes with `decodeURIComponent` (output-routes.ts), so `%20` round-trips to the real filename — no serving change needed.

**Context:** the Phase-4 final review flagged that a filename like `a b.png` produced `![image](/output/0/a b.png)` — marked rejects unescaped spaces in link destinations, so the image renders as literal text. Latent today (MLX output names are space-free) but a real bug. `encodeURI` is the prescribed fix: it encodes spaces (`%20`) while leaving balanced parens and the path separators/word chars intact (CommonMark-safe destination). Run separator normalization FIRST (`rel.split(path.sep).join("/")`), then encode the whole rel path.

- [ ] **Step 1: Write the failing tests**

In `tests/image-presentation.test.ts`, inside `describe("imageMd", () => { … })`, append after the `..foo.png` test:

```ts
  test("space in the filename is percent-encoded (marked rejects raw spaces)", () => {
    expect(imageMd(path.join(OUT, "a b.png"), OUT)).toBe("![image](/output/0/a%20b.png)");
  });

  test("parens: space encoded, balanced parens preserved (CommonMark-safe destination)", () => {
    expect(imageMd(path.join(OUT, "shot (1).png"), OUT)).toBe("![image](/output/0/shot%20(1).png)");
  });

  test("a clean path is unchanged by percent-encoding (encodeURI no-op)", () => {
    expect(imageMd(path.join(OUT, "plain_shot.png"), OUT)).toBe("![image](/output/0/plain_shot.png)");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/image-presentation.test.ts )`
Expected: the space test and the parens test FAIL (current output is `![image](/output/0/a b.png)` / `![image](/output/0/shot (1).png)`); the clean-path test PASSES.

- [ ] **Step 3: Implement — percent-encode the rel path**

In `src/image-presentation.ts`, replace the final return of `imageMd`:

Old:

```ts
  return `![image](/output/0/${rel.split(path.sep).join("/")})`;
```

New:

```ts
  // Percent-encode AFTER separator normalization: marked rejects raw spaces in
  // link destinations (ledger [P4-final]); encodeURI keeps "/" and balanced
  // parens intact, and the /output route decodeURIComponent round-trips it.
  return `![image](/output/0/${encodeURI(rel.split(path.sep).join("/"))})`;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/image-presentation.test.ts )`
Expected: ALL pass — 21 tests in this file (18 prior + 3 new).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/image-presentation.ts bun-apps/pi-agent-ext-webui/tests/image-presentation.test.ts
git commit -m "fix(webui): percent-encode imageMd rel path (spaces/parens in output filenames)"
```

---

### Task 3: `isPayload` view type-guard + unused-import cleanup (ledger [P4-final] #2, Phase-2 [T1-review])

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/src/present-event-handler.ts` (`isPayload` gains a `view` guard)
- Test: `bun-apps/pi-agent-ext-webui/tests/present-event-handler.test.ts` (1 new test in the existing describe)
- Modify: `bun-apps/pi-agent-ext-webui/tests/output-routes.test.ts` (L11 import only)

**Interfaces:**
- Consumes: `isPayload` is module-private; the public surface is `createPresentEventHandler(registry): PresentEventHandler`. `RenderService.listViews()` is used to assert nothing was minted.
- Produces: behavior change only — `handler({content, controls, view: 42})` is now IGNORED (previously `data.view ?? "present"` forwarded the raw `42` as a view id, minting a view keyed by a number). No signature changes.

**Context:** the Phase-2 T1 review flagged that `isPayload` type-guards `content`, `controls`, and `id` but NOT `view` — a non-string `view` from a non-tool emitter forwarded as a raw key. The tool path is unaffected (TypeBox schema-validated upstream), so this is hardening for the shared event bus. Mirror the existing `id` guard style. Also remove the `rmSync` import in `output-routes.test.ts` (imported-but-unused since Phase 4 — `tests/webui-wiring.test.ts` legitimately uses `rmSync`; do NOT touch that file).

- [ ] **Step 1: Write the failing test**

In `tests/present-event-handler.test.ts`, inside the existing `describe("createPresentEventHandler", () => { … })`, append after the "ignores an invalid mode" test (before the malformed-payloads test):

```ts
  it("ignores a non-string view (hardened type-guard; previously forwarded raw as a view id)", () => {
    const registry = new RenderService({ urlFor: () => "#" });
    const handler = createPresentEventHandler(registry);
    handler({ content: "x", controls: CONTROLS, view: 42 });
    expect(registry.listViews()).toEqual([]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/present-event-handler.test.ts )`
Expected: FAIL — the current handler mints a view (keyed by the number `42`), so `listViews()` is non-empty.

- [ ] **Step 3: Implement the view guard**

In `src/present-event-handler.ts`, edit `isPayload`:

Old:

```ts
  if (typeof o.content !== "string") return false;
  if (!Array.isArray(o.controls) || !o.controls.every(isControl)) return false;
  if (o.id !== undefined && typeof o.id !== "string") return false;
  return true;
```

New:

```ts
  if (typeof o.content !== "string") return false;
  if (!Array.isArray(o.controls) || !o.controls.every(isControl)) return false;
  if (o.id !== undefined && typeof o.id !== "string") return false;
  if (o.view !== undefined && typeof o.view !== "string") return false;
  return true;
```

- [ ] **Step 4: Remove the unused `rmSync` import in `tests/output-routes.test.ts`**

Old (L11):

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
```

New:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
```

(No other change to that file — fixture cleanup stays as-is per the minimal-fix ledger decision.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/present-event-handler.test.ts tests/output-routes.test.ts )`
Expected: ALL pass — 5 in present-event-handler (4 prior + 1 new), 20 in output-routes.

- [ ] **Step 6: Run the FULL gate — final count**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run test )`
Expected: build exits 0; **290 tests passing, 0 failing** (286 from Task 1 + 3 imageMd + 1 isPayload).

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/present-event-handler.ts \
        bun-apps/pi-agent-ext-webui/tests/present-event-handler.test.ts \
        bun-apps/pi-agent-ext-webui/tests/output-routes.test.ts
git commit -m "hardening(webui): isPayload view type-guard; drop unused rmSync import"
```

---

## Final verification (controller / final whole-branch review)

- [ ] `( cd bun-apps/pi-agent-ext-webui && bun run test )` → **290 / 0**, build exit 0.
- [ ] `rg -n "tool-mirror|render-tool|createToolMirror|createRenderTool|webui_render" bun-apps/pi-agent-ext-webui/src bun-apps/pi-agent-ext-webui/tests bun-apps/pi-agent-ext-webui/extensions` → ZERO hits (comments included).
- [ ] Log the known stale reference for the record: `bun-apps/pi-agent-ext-devops/scripts/deploy.ts:572` still cites `src/tool-mirror.ts` (different package, intentionally untouched).
- [ ] Confirm invariants held: `render-event-handler.ts` + tests still present (Decision B dormant); `tool_result` still in `OUTBOUND_EVENTS`; `webui-wiring.test.ts` event-set assertion untouched and green; `render-shell.ts` untouched; loopback/auth untouched; no new deps.
- [ ] Update `.planning/2026-08-14-build-hitl-webui/sdd/progress.md` with Phase-5 completion + ledger items CLOSED ([P4-final] #1 percent-encode, [P4-final] #2 rmSync, Phase-2 [T1-review] view guard).

## Spec coverage self-review

- Spec Component 6 "Drop the mirror": remove `tool-mirror.ts` + wiring reg → Task 1 Steps 4/7; "tools" view gone → negative test (ii) Task 1 Step 2; `webui_render` removed → Task 1 Steps 4/6 + negative test (i).
- Spec Decision B: `webui_render` tool removed, `webui:render` handler retained dormant → Task 1 (KEEP list + invariant checks).
- Spec Tests "Drop mirror" row: `tool_result` no longer mirrors (neg ii), "tools" view gone (neg ii), `webui_render` removed (neg i) → Task 1 Steps 1-2.
- sdd/progress.md ledger [P4-final] #1 (percent-encode) → Task 2; #2 (rmSync) → Task 3; Phase-2 [T1-review] (view guard) → Task 3.
- Out of scope items (video player, annotation, resumable-SSE) — correctly absent.
