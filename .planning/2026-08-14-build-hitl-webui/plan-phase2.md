# HITL webui Phase 2 — `webui_present` tool + `webui:present` event (present-as-view) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the blocking HITL gate (spec Components 2+3): a `webui_present` tool whose `execute()` blocks on a pending-Promise until the browser responds via the Phase-1 `appexec` return transport, plus the `webui:present` event that mints a present-as-view (Decision A) carrying declarative controls — and discharge the Phase-1 review-ledger obligations (HitlResponse union, duplicate-id fix, stale JSDoc, manifest verify).

**Architecture:** A present is a special render view: the new `webui:present` event handler (mirroring `render-event-handler.ts`) validates `{content, controls, id?, mode?, view?, title?}` and calls `RenderService.render()` with two NEW additive optional fields (`controls`, `presentId`) on `RenderView`/`RenderInput` — no new endpoint, the existing SSE `{viewId, updatedAt}` notify is unchanged, controls ride the `/api/view/:id` fetch. The `webui_present` tool is a factory `createPresentTool(deps)` in a new `src/present-tool.ts` (same pattern as `render-tool.ts`), composed inside `wireWebui` where it generates `present_<now>_<seq>`, emits via a `present` dep (which fires the event → handler → registry), awaits `registerPending(id)` with NEW signal-abort wiring, and returns `{content:[{type:"text",text}], details:{action?, tweak?, cancelled?}}`. One-pending-at-a-time guard returns an error RESULT (never throws), mirroring ask-user's local error envelope style.

**Tech Stack:** TypeScript (Bun runtime), TypeBox (`typebox` v1.x, import specifier `"typebox"` — NOT `@sinclair/typebox`), `bun:test`, the package's existing `RenderService`/`WebServer`/`WebTransport` modules. Type-only import of `ToolDefinition` from `@earendil-works/pi-coding-agent` (already used by `src/render-tool.ts` — NOT a new dependency).

## Global Constraints

- **Loopback-only, auth-off**: no token auth, no non-loopback binding, no shell-token injection (spec: "Loopback-only, auth-off"). Nothing in this phase touches auth.
- **Webui test quirk**: this package's `tsconfig` includes only `src/**` — the gate is FULL `bun test` (run from `bun-apps/pi-agent-ext-webui`), NOT typecheck; `bun run build` (`bunx tsc`) covers `src/**` only. Update test fixtures in-task.
- **No new cross-package dependencies** unless already present: `webui_present` must NOT import ask-user's `response-envelope.ts` from `pi-agent-ext-core-task` (webui has zero cross-package imports today — `package.json` deps are `marked` only). Keep the error-result envelope pattern LOCAL.
- **Exact paths**: all files live under `bun-apps/pi-agent-ext-webui/` (`src/`, `tests/`); wiring also touches nothing outside this package.
- **TypeBox schemas** for tool parameters (ecosystem standard; import specifier `"typebox"`).
- **Blocking, no timeout** (loopback HITL): `execute()` blocks until response OR abort; there is NO watchdog/timeout on the pending presentation.
- **One pending presentation at a time** (v1): a second `webui_present` while one is pending → tool ERROR result (not a throw).
- **Response shape**: `{action: <controlId>, tweak?}` or `{cancelled: true}` — structured, NOT text formulations, in `details`.
- **CI/merge workflow**: never wait for remote GitHub Actions — open PR, run local gates (`bun test` + `bun run build` in the package), squash-merge immediately (`gh ship`). Remote CI is intentionally disabled in this repo.
- **Do NOT change extension registration** in this phase (manifest verify-only step in Task 1).
- **WS-close refresh tension — DOCUMENTED, not changed**: WS close keeps cancelling ALL pending (`cancelAllPending`). A browser refresh mid-presentation therefore resolves the blocked `execute()` as `{cancelled:true}`; the agent is expected to re-present. (Decision A/C's "reconnecting browser re-fetches the pending presentation" remains future work; the replace-only view store means the present view survives a refresh for display, but the pending gate does not.) Recorded as a code comment in Task 1 — behavior unchanged.

## File Structure

```
bun-apps/pi-agent-ext-webui/
  src/
    render-service.ts          # MODIFY — Control type + RenderView/RenderInput additive fields
    render-routes.ts           # MODIFY — /api/view/:id carries controls + presentId (md + html branches)
    present-event-handler.ts   # CREATE — webui:present event → registry.render (mirror of render-event-handler.ts)
    webui-wiring.ts            # MODIFY — HitlResponse union + export, registerPending duplicate-id fix,
    #                          #         register webui:present handler, WS-close tension comment (T1);
    #                          #         compose createPresentTool + present/cancelPending/hasPending closures (T2)
    web-transport.ts           # MODIFY — refresh stale parseCommand class-header JSDoc (L45-48)
    present-tool.ts            # CREATE — webui_present ToolDefinition factory (blocking gate)
  tests/
    render-service.test.ts     # MODIFY — controls/presentId round-trip + clean shape
    render-routes.test.ts      # MODIFY — view JSON carries controls/presentId
    present-event-handler.test.ts  # CREATE — handler validation + mint tests
    webui-wiring.test.ts       # MODIFY — duplicate-id test (T1); present-tool integration tests (T2)
    present-tool.test.ts       # CREATE — unit tests over fake deps
```

Responsibilities: `present-event-handler.ts` owns inbound event validation + view minting; `present-tool.ts` owns the tool schema, id generation, one-pending guard, signal-abort wiring, and human-readable result text; `webui-wiring.ts` remains the ONE composition root (event registration, tool registration, pending-registry closures).

---

### Task 1: present-as-view model + `webui:present` event handler + ledger fixes

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/src/render-service.ts:17-43` (Control type + RenderView/RenderInput + render() spread)
- Modify: `bun-apps/pi-agent-ext-webui/src/render-routes.ts:82-104` (/api/view/:id JSON branches)
- Create: `bun-apps/pi-agent-ext-webui/src/present-event-handler.ts`
- Modify: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts:128-137` (WebuiWiring.registerPending type), `:227-246` (HitlResponse + registerPending + cancelAllPending), `:331-332` (event registration), `:345-347` (WS-close comment)
- Modify: `bun-apps/pi-agent-ext-webui/src/web-transport.ts:45-48` (stale JSDoc)
- Test: `bun-apps/pi-agent-ext-webui/tests/render-service.test.ts` (add describe block)
- Test: `bun-apps/pi-agent-ext-webui/tests/render-routes.test.ts` (add tests)
- Test: `bun-apps/pi-agent-ext-webui/tests/present-event-handler.test.ts` (CREATE)
- Test: `bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts` (add HITL tests)

**Interfaces:**
- Consumes: `RenderService` (`bun-apps/pi-agent-ext-webui/src/render-service.ts:39` — `render(input: RenderInput): RenderResult`, `getView(id)`, replace-only Map store, `RenderListener`); the Phase-1 pending registry closures in `wireWebui` (`webui-wiring.ts:227-246`: `pending: Map<string, {resolve}>`, `registerPending(id)`, `cancelAllPending()`); the Phase-1 test fixtures `setup()` / `dispatch()` (`tests/webui-wiring.test.ts:89-103`).
- Produces:
  - `export interface Control { id: string; label: string; takesInput?: boolean }` (render-service.ts)
  - `RenderView`/`RenderInput` gain optional `controls?: Control[]` and `presentId?: string`
  - `createPresentEventHandler(registry: RenderService): PresentEventHandler` in `src/present-event-handler.ts`, with `export interface PresentEventPayload { content: string; controls: Control[]; id?: string; mode?: RenderMode; view?: string; title?: string }`
  - `export type HitlResponse = { action: string; tweak?: string } | { cancelled: true }` (webui-wiring.ts, module level) and `WebuiWiring.registerPending(id: string): Promise<HitlResponse>`
  - `registerPending` resolves a stale duplicate id as `{cancelled: true}` (never silently overwrites)

- [ ] **Step 1: Write the failing tests — render-service controls round-trip**

Add to `tests/render-service.test.ts` (after the existing describes; import stays `../src/render-service.js`):

```ts
describe("RenderService — present-as-view fields (spec Decision A)", () => {
  it("render() round-trips controls + presentId onto the stored view", () => {
    const r = new RenderService({ urlFor: () => "#", now: () => 100 });
    r.render({
      content: "# approve?",
      view: "present",
      controls: [
        { id: "approve", label: "Approve" },
        { id: "regenerate", label: "Regenerate…", takesInput: true },
      ],
      presentId: "present_123_1",
    });
    expect(r.getView("present")).toMatchObject({
      id: "present",
      mode: "md",
      content: "# approve?",
      controls: [
        { id: "approve", label: "Approve" },
        { id: "regenerate", label: "Regenerate…", takesInput: true },
      ],
      presentId: "present_123_1",
      updatedAt: 100,
    });
  });

  it("render() does NOT store controls/presentId keys when absent (clean shape)", () => {
    const r = new RenderService({ urlFor: () => "#", now: () => 1 });
    r.render({ content: "a", view: "v" });
    const v = r.getView("v")!;
    expect(v).not.toHaveProperty("controls");
    expect(v).not.toHaveProperty("presentId");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-service.test.ts )`
Expected: FAIL — the `controls`/`presentId` properties are absent from the stored view (and tsc-level: `RenderInput` has no such keys; bun-test reports the toMatchObject mismatch).

- [ ] **Step 3: Implement render-service.ts — Control type + additive fields**

In `src/render-service.ts`, add the `Control` type after `export type RenderMode = "md" | "html";` (line 14):

```ts
/**
 * A declarative HITL response control (spec #05 contract): the browser renders
 * one button per control; `takesInput` reveals a free-text tweak field next to
 * it. Lives HERE (not protocol.ts) because Control is a view-model concept that
 * rides RenderView + /api/view/:id — it never appears in a WS frame.
 */
export interface Control {
  id: string;
  label: string;
  takesInput?: boolean;
}
```

Extend `RenderView` (was lines 17-24) and `RenderInput` (was lines 32-38) — additive optional fields only:

```ts
export interface RenderView {
  id: string;
  mode: RenderMode;
  content: string;
  title?: string;
  /** Present-as-view (spec Decision A): declarative HITL controls, when this view is a presentation. */
  controls?: Control[];
  /** The pending-presentation id this view answers to (the appexec respond id). */
  presentId?: string;
  updatedAt: number;
}

export interface RenderInput {
  content: string;
  mode?: RenderMode;
  view?: string;
  title?: string;
  controls?: Control[];
  presentId?: string;
}
```

In `render()` (was ~L51-69), add the two conditional spreads to the `view` literal, right after the `title` spread:

```ts
    const view: RenderView = {
      id: viewId,
      mode,
      content: input.content,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.controls !== undefined ? { controls: input.controls } : {}),
      ...(input.presentId !== undefined ? { presentId: input.presentId } : {}),
      updatedAt,
    };
```

(The Map store, replace-only semantics, `RenderListener`, and the `{viewId, updatedAt}` notify signature are UNCHANGED — controls ride the `/api/view/:id` fetch.)

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-service.test.ts )`
Expected: PASS (all render-service tests).

- [ ] **Step 5: Write the failing tests — /api/view/:id carries controls/presentId**

Add to `tests/render-routes.test.ts` inside the existing `describe("createRenderRoutes — GET /api/view/:id", ...)` block:

```ts
  it("md present view includes controls + presentId (spec Decision A)", async () => {
    const { registry, server } = setup(() => 5);
    registry.render({
      content: "# approve?",
      view: "present",
      controls: [
        { id: "approve", label: "Approve" },
        { id: "regenerate", label: "Regenerate…", takesInput: true },
      ],
      presentId: "present_9_1",
    });
    const res = await fetch(`${server.url}/api/view/present`);
    expect(res.status).toBe(200);
    const v = await res.json();
    expect(v.id).toBe("present");
    expect(v.html).toContain("<h1");
    expect(v.controls).toEqual([
      { id: "approve", label: "Approve" },
      { id: "regenerate", label: "Regenerate…", takesInput: true },
    ]);
    expect(v.presentId).toBe("present_9_1");
  });

  it("html present view includes controls + presentId", async () => {
    const { registry, server } = setup(() => 5);
    registry.render({
      content: "<p>pick</p>",
      view: "p",
      mode: "html",
      controls: [{ id: "ok", label: "OK" }],
      presentId: "present_9_2",
    });
    const v = await (await fetch(`${server.url}/api/view/p`)).json();
    expect(v.mode).toBe("html");
    expect(v.controls).toEqual([{ id: "ok", label: "OK" }]);
    expect(v.presentId).toBe("present_9_2");
  });

  it("a non-present view omits controls/presentId keys (clean shape)", async () => {
    const { registry, server } = setup(() => 5);
    registry.render({ content: "a", view: "plain" });
    const v = await (await fetch(`${server.url}/api/view/plain`)).json();
    expect(v).not.toHaveProperty("controls");
    expect(v).not.toHaveProperty("presentId");
  });
```

- [ ] **Step 6: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-routes.test.ts )`
Expected: FAIL — `v.controls` is undefined (routes don't forward the new fields yet).

- [ ] **Step 7: Implement render-routes.ts — carry controls/presentId in both branches**

In `src/render-routes.ts`, in the `/api/view/` handler, extend BOTH JSON branches. The html branch (was ~L90-99) becomes:

```ts
      if (view.mode === "html") {
        return json({
          id: view.id,
          mode: view.mode,
          content: view.content,
          title: view.title ?? null,
          updatedAt: view.updatedAt,
          ...(view.controls !== undefined ? { controls: view.controls } : {}),
          ...(view.presentId !== undefined ? { presentId: view.presentId } : {}),
        });
      }
      return json({
        id: view.id,
        mode: view.mode,
        html: renderMarkdown(view.content),
        title: view.title ?? null,
        updatedAt: view.updatedAt,
        ...(view.controls !== undefined ? { controls: view.controls } : {}),
        ...(view.presentId !== undefined ? { presentId: view.presentId } : {}),
      });
```

`viewSummary` (for `/api/views`) and the `/api/events` SSE payload stay UNCHANGED.

- [ ] **Step 8: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-routes.test.ts )`
Expected: PASS.

- [ ] **Step 9: Write the failing tests — present-event-handler**

Create `tests/present-event-handler.test.ts` (mirrors `tests/render-event-handler.test.ts`):

```ts
import { describe, expect, it } from "bun:test";
import { createPresentEventHandler } from "../src/present-event-handler.js";
import { RenderService } from "../src/render-service.js";

describe("createPresentEventHandler", () => {
  const CONTROLS = [
    { id: "approve", label: "Approve" },
    { id: "regenerate", label: "Regenerate…", takesInput: true },
  ];

  it("a valid payload mints the DEFAULT view 'present' with controls + presentId", () => {
    const registry = new RenderService({ urlFor: () => "#", now: () => 7 });
    const handler = createPresentEventHandler(registry);
    handler({ content: "# pick", controls: CONTROLS, id: "present_1_1" });
    expect(registry.getView("present")).toMatchObject({
      id: "present",
      mode: "md",
      content: "# pick",
      controls: CONTROLS,
      presentId: "present_1_1",
      updatedAt: 7,
    });
  });

  it("forwards an explicit view/mode/title; id is optional inbound (view minted without presentId)", () => {
    const registry = new RenderService({ urlFor: () => "#", now: () => 7 });
    const handler = createPresentEventHandler(registry);
    handler({ content: "<p>x</p>", mode: "html", view: "v1", title: "T", controls: CONTROLS });
    const v = registry.getView("v1")!;
    expect(v).toMatchObject({ id: "v1", mode: "html", content: "<p>x</p>", title: "T", controls: CONTROLS });
    expect(v).not.toHaveProperty("presentId");
  });

  it("ignores an invalid mode (falls back to 'md')", () => {
    const registry = new RenderService({ urlFor: () => "#" });
    const handler = createPresentEventHandler(registry);
    handler({ content: "x", mode: "bogus", controls: CONTROLS });
    expect(registry.getView("present")?.mode).toBe("md");
  });

  it("ignores malformed payloads without throwing (missing/malformed controls, bad id)", () => {
    const registry = new RenderService({ urlFor: () => "#" });
    const handler = createPresentEventHandler(registry);
    expect(() => handler(null)).not.toThrow();
    expect(() => handler(undefined)).not.toThrow();
    expect(() => handler({})).not.toThrow();
    expect(() => handler({ content: 123, controls: CONTROLS })).not.toThrow();
    expect(() => handler({ content: "x" })).not.toThrow(); // missing controls
    expect(() => handler({ content: "x", controls: [] })).not.toThrow(); // empty is VALID (schema-validated upstream)
    expect(() => handler({ content: "x", controls: [{ label: "no id" }] })).not.toThrow();
    expect(() => handler({ content: "x", controls: [{ id: "a", label: "A", takesInput: "yes" }] })).not.toThrow();
    expect(() => handler({ content: "x", controls: CONTROLS, id: 42 })).not.toThrow(); // non-string id
    expect(registry.listViews()).toEqual([]);
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/present-event-handler.test.ts )`
Expected: FAIL — `Cannot find module '../src/present-event-handler.js'`.

- [ ] **Step 11: Create src/present-event-handler.ts**

```ts
/**
 * present-event-handler.ts — the `webui:present` producer entry point
 * (spec Component 3, Decision A: present-as-view).
 *
 * `createPresentEventHandler(registry)` returns the handler registered as
 * `pi.events.on("webui:present", handler)` by wireWebui. The webui_present
 * tool's `present` dep (and any extension) emits
 * `pi.events.emit("webui:present", { content, controls, id?, mode?, view?, title? })`;
 * this validates the payload and mints a render view DEFAULTING to view id
 * "present", carrying `controls` + `presentId` so the browser can render the
 * content plus a declarative button bar. `id` is optional INBOUND (a non-tool
 * emitter may omit it); the tool path always supplies it. Invalid payloads are
 * ignored (never throw — the shared event bus must stay robust), mirroring
 * render-event-handler.ts.
 */
import type { Control, RenderMode, RenderService } from "./render-service.js";

export interface PresentEventPayload {
  content: string;
  controls: Control[];
  /** The pending-presentation id (the appexec respond id). Optional inbound. */
  id?: string;
  mode?: RenderMode;
  view?: string;
  title?: string;
}

export type PresentEventHandler = (data: unknown) => void;

function isControl(c: unknown): c is Control {
  if (typeof c !== "object" || c === null) return false;
  const o = c as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.label === "string" &&
    (o.takesInput === undefined || typeof o.takesInput === "boolean")
  );
}

function isPayload(d: unknown): d is PresentEventPayload {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  if (typeof o.content !== "string") return false;
  if (!Array.isArray(o.controls) || !o.controls.every(isControl)) return false;
  if (o.id !== undefined && typeof o.id !== "string") return false;
  return true;
}

export function createPresentEventHandler(registry: RenderService): PresentEventHandler {
  return (data) => {
    if (!isPayload(data)) return;
    registry.render({
      view: data.view ?? "present",
      content: data.content,
      ...(data.mode === "md" || data.mode === "html" ? { mode: data.mode } : {}),
      ...(typeof data.title === "string" ? { title: data.title } : {}),
      controls: data.controls,
      ...(data.id !== undefined ? { presentId: data.id } : {}),
    });
  };
}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/present-event-handler.test.ts )`
Expected: PASS.

- [ ] **Step 13: Write the failing tests — wiring ledger fixes + present event registration**

Add to `tests/webui-wiring.test.ts`, inside the existing `describe("HITL appexec return transport (respond resolve + registry + abort)", ...)` block (after the "WS close resolves all pending" test, ~L435):

```ts
    test("registerPending resolves a stale DUPLICATE id as {cancelled:true} (no silent overwrite)", async () => {
      const { pi, wiring } = setup();
      pi.emit("session_start", { type: "session_start", reason: "startup" });
      const first = wiring.registerPending("dup");
      const second = wiring.registerPending("dup");
      // The FIRST registration must not hang forever — it resolves as cancelled.
      await expect(first).resolves.toEqual({ cancelled: true });
      // The second registration stays pending (it now owns the id).
      let resolved = false;
      second.then(() => { resolved = true; });
      await Promise.resolve();
      expect(resolved).toBe(false);
      // Clean up + re-assert session_shutdown cancels the surviving registration.
      pi.emit("session_shutdown", { type: "session_shutdown", reason: "done" });
      await expect(second).resolves.toEqual({ cancelled: true });
    });
```

And a NEW top-level describe at the end of the file (before the singleton describe):

```ts
describe("wireWebui — webui:present event (present-as-view, spec Decision A)", () => {
  test("a webui:present payload mints the 'present' view carrying controls + presentId", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    pi.events.emit("webui:present", {
      content: "# pick one",
      id: "p9",
      controls: [
        { id: "approve", label: "Approve" },
        { id: "regenerate", label: "Regenerate…", takesInput: true },
      ],
    });
    // Observe the minted view through the installed HTTP routes (the registry
    // is wiring-internal; httpRoutes closes over it).
    expect(server.httpRoutes).not.toBeNull();
    const res = server.httpRoutes!(new Request("http://t/api/view/present"), {} as never);
    const body = await res.json();
    expect(body).toMatchObject({
      id: "present",
      mode: "md",
      presentId: "p9",
      controls: [
        { id: "approve", label: "Approve" },
        { id: "regenerate", label: "Regenerate…", takesInput: true },
      ],
    });
    expect(body.html).toContain("<h1");
  });

  test("an invalid webui:present payload mints nothing (no throw)", () => {
    const { pi, server } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    expect(() => pi.events.emit("webui:present", { content: "no controls" })).not.toThrow();
    const res = server.httpRoutes!(new Request("http://t/api/view/present"), {} as never);
    expect(res.status).toBe(404);
  });
});
```

Note: the Phase-1 HITL tests (`respond resolves … {action:"approve"}`, `session_shutdown … {cancelled:true}`, WS close) already assert the union shapes behaviorally via `toEqual` — they keep passing unchanged under the tightened type.

- [ ] **Step 14: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/webui-wiring.test.ts )`
Expected: FAIL — duplicate-id test (the first promise never resolves → bun-test times out or `resolved` stays true path absent; concretely the `await expect(first)` hangs and the run errors) and the `webui:present` tests fail (404 — no handler registered).

- [ ] **Step 15: Implement webui-wiring.ts — HitlResponse union + export + duplicate-id fix + present handler registration**

In `src/webui-wiring.ts`:

**(a)** Add the import next to `createRenderEventHandler` (line ~21):

```ts
import { createPresentEventHandler } from "./present-event-handler.js";
```

**(b)** Replace the `WebuiWiring.registerPending` member (was lines ~128-137) and add the exported union at module level right ABOVE `export interface WebuiWiring`:

```ts
/**
 * The structured HITL answer a blocked webui_present execute() resolves with:
 * a control response `{action: <controlId>, tweak?}` OR an abort
 * `{cancelled: true}` (session_shutdown / WS close / signal abort). Phase-2
 * ledger: tightened to a DISCRIMINATED UNION (was an all-optional bag) so a
 * consumer MUST branch on `cancelled` before reading `action`. Exported
 * alongside WebuiWiring (render-tool exports its types; same convention).
 */
export type HitlResponse = { action: string; tweak?: string } | { cancelled: true };

export interface WebuiWiring {
  /** Neutralize every handler + tear the server down (tests / session end). */
  dispose(): void;
  /**
   * Create + await a pending HITL presentation keyed by `id` (spec Component 1).
   * The `webui_present` tool calls this, then awaits the returned Promise.
   * Resolves with `{action, tweak?}` when an appexec `respond` arrives for the
   * id; resolves with `{cancelled:true}` on abort (session_shutdown / WS close /
   * tool-signal abort — `action` is ABSENT on a cancelled response by type).
   */
  registerPending(id: string): Promise<HitlResponse>;
}
```

**(c)** Replace the closure-local type + registry (was lines ~227-246). The closure-local `type HitlResponse = …` line is DELETED (the module-level export replaces it); `registerPending` gains the duplicate-id fix:

```ts
  // --- HITL pending-Promise registry (return transport; spec Component 1) ----
  // Keyed by the respond `id`. registerPending creates + awaits a pending; the
  // dispatch appexec case resolves it; abort (session_shutdown / WS close /
  // tool-signal abort) resolves all pending as {cancelled:true}. The
  // webui_present tool is the producer (Phase 2, Task 2). In-memory only (spec
  // Decision C); cleared on resolve/abort. HitlResponse is the module-level
  // exported UNION — branch on "cancelled" in r before reading r.action.
  const pending = new Map<string, { resolve: (r: HitlResponse) => void }>();

  function registerPending(id: string): Promise<HitlResponse> {
    return new Promise<HitlResponse>((resolve) => {
      // Duplicate-id safety (Phase-2 ledger): never silently overwrite — a
      // stale entry under the same id is resolved as {cancelled:true} FIRST so
      // its awaiter returns cleanly instead of hanging forever.
      const stale = pending.get(id);
      if (stale) {
        pending.delete(id);
        stale.resolve({ cancelled: true });
      }
      pending.set(id, { resolve });
    });
  }

  /** Resolve every pending as {cancelled:true} (session_shutdown / WS close). */
  function cancelAllPending(): void {
    for (const entry of pending.values()) entry.resolve({ cancelled: true });
    pending.clear();
  }
```

The `dispatch` appexec case (resolving `{action, tweak?}`) and `cancelAllPending` callers need NO code change — both already produce exactly the union members.

**(d)** Register the present handler right after the render handler (was line ~332):

```ts
  pi.registerTool?.(createRenderTool(registry));
  pi.events?.on("webui:render", createRenderEventHandler(registry));
  const presentHandler = createPresentEventHandler(registry);
  pi.events?.on("webui:present", presentHandler);
```

(The `const presentHandler` binding is deliberate: Task 2's `present` closure reuses it as the no-event-bus fallback.)

**(e)** Document the WS-close refresh tension at the `setWsCloseHandler` call (was ~line 346):

```ts
  // WS-close abort seam (spec Component 1): a disconnect mid-HITL resolves all
  // pending as {cancelled:true} so a blocked execute() returns cleanly.
  // KNOWN TENSION (Phase-2 ledger, DOCUMENTED not changed): a browser REFRESH
  // mid-presentation also closes the WS, so the blocked execute() resolves
  // {cancelled:true} and the agent must RE-PRESENT. The minted present view
  // survives in the replace-only store (a reconnecting browser can re-fetch it
  // via /api/view/:id for display), but the pending GATE does not survive.
  // Re-attaching a pending presentation to a reconnect is deferred (spec
  // Decision A/C future work).
  server.setWsCloseHandler(() => cancelAllPending());
```

- [ ] **Step 16: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/webui-wiring.test.ts )`
Expected: PASS (all wiring tests incl. the Phase-1 HITL block + the two new describes).

- [ ] **Step 17: Refresh the stale parseCommand JSDoc (web-transport.ts:45-48) + full package gate**

In `src/web-transport.ts`, replace the stale bullet in the `parseCommand` class-header JSDoc (lines 45-48):

```ts
   * - `appexec` → `{ kind:"appexec", op }` with NO `source` field. This is the
   *   contract Task 3 branches on (`kind === "agentic"`) to bypass the mutex
   *   entirely (spec §6: appexec must NOT be routed through the input gate). v1
   *   defines no concrete appexec ops — this is a forward seam (spec §3).
```

with (Phase-1 reality — the `respond` op shipped):

```ts
   * - `appexec` → `{ kind:"appexec", op:"respond", id, action, tweak? }` with
   *   NO `source` field. This is the contract the wiring branches on
   *   (`kind === "agentic"`) to bypass the mutex entirely (spec §6: appexec
   *   must NOT be routed through the input gate). `respond` is the HITL return
   *   transport (spec Component 1, shipped in Phase 1): it resolves the pending
   *   Promise registered under `id`. An unknown op or a malformed respond
   *   resolves to `null` (ignored — spec §6 forward-compat).
```

Then run the full gates:

```bash
( cd bun-apps/pi-agent-ext-webui && bun test )
( cd bun-apps/pi-agent-ext-webui && bun run build )
```

Expected: all tests PASS; `bunx tsc` (src/**) exits 0.

- [ ] **Step 18: VERIFY-ONLY — extension registration double-check (do NOT change anything)**

Run (from repo root):

```bash
python3 - <<'EOF'
import json
m = json.load(open("bun-apps/pi-agent/run-dir/manifest.json"))
dyn = [e if isinstance(e, str) else e["name"] for e in m.get("extensions", [])]
print("dynamic extensions[]:", dyn)
print("staticExtensions:", m.get("staticExtensions"))
print("webui in dynamic:", "pi-agent-ext-webui" in dyn)
print("webui in staticExtensions:", "pi-agent-ext-webui" in m.get("staticExtensions", []))
EOF
grep -n "pi-agent-ext-webui" bun-apps/pi-agent/src/static-extensions.ts
```

Expected (as of authoring): `pi-agent-ext-webui` appears in `staticExtensions` (name-only list) AND as a `{name, factory}` row in `src/static-extensions.ts` — that pair is the CONSISTENT single (static) registration; it is NOT in the dynamic `extensions[]` list, so there is NO double registration. IF the output ever shows it in BOTH `extensions[]` and `staticExtensions`, that IS a genuine double registration: note it in the task report for the controller and still DO NOT change registration in this phase.

- [ ] **Step 19: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/render-service.ts \
        bun-apps/pi-agent-ext-webui/src/render-routes.ts \
        bun-apps/pi-agent-ext-webui/src/present-event-handler.ts \
        bun-apps/pi-agent-ext-webui/src/webui-wiring.ts \
        bun-apps/pi-agent-ext-webui/src/web-transport.ts \
        bun-apps/pi-agent-ext-webui/tests/render-service.test.ts \
        bun-apps/pi-agent-ext-webui/tests/render-routes.test.ts \
        bun-apps/pi-agent-ext-webui/tests/present-event-handler.test.ts \
        bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts
git commit -m "feat(webui): webui:present event + present-as-view fields + ledger fixes (Phase 2 / spec Components 3 + Decision A)

- RenderView/RenderInput gain optional controls + presentId (additive; SSE notify unchanged)
- /api/view/:id carries controls + presentId in md + html branches
- present-event-handler.ts: validate + mint default 'present' view
- HitlResponse tightened to exported union {action,tweak?} | {cancelled:true}
- registerPending resolves stale duplicate ids as cancelled (no silent overwrite)
- refresh stale parseCommand JSDoc; document WS-close refresh tension"
```

---

### Task 2: `webui_present` tool — the blocking gate

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/present-tool.ts`
- Modify: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts:21-22` (import), `:227-246` (add `cancelPending` closure), `:331-335` (compose `createPresentTool` next to `createRenderTool`)
- Test: `bun-apps/pi-agent-ext-webui/tests/present-tool.test.ts` (CREATE)
- Test: `bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts` (add integration describe)

**Interfaces:**
- Consumes (from Task 1): `Control` and `RenderMode` from `src/render-service.js`; `HitlResponse` (`export type HitlResponse = { action: string; tweak?: string } | { cancelled: true }`) from `src/webui-wiring.js`; `createPresentEventHandler` + the `const presentHandler` binding + `registerPending` + the `pending` Map inside `wireWebui`; the ToolDefinition shape from `src/render-tool.ts` (`execute(_callId, params, signal, _onUpdate, _ctx)` returning `{content:[{type:"text",text}], details}`); `MockPi.registeredTools` + `MockPi.events` (`tests/helpers/mock-pi.ts`) and the `setup()`/`dispatch()` fixtures (`tests/webui-wiring.test.ts:89-103`).
- Produces:
  - `export const PresentParameters` (TypeBox: `content`, `mode?`, `view?`, `title?`, REQUIRED `controls: Array<{id, label, takesInput?}>`)
  - `export interface PresentInput { content: string; controls: Control[]; id: string; mode?: RenderMode; view?: string; title?: string }`
  - `export type PresentFn = (input: PresentInput) => string` (returns the presentId)
  - `export interface PresentToolDeps { present: PresentFn; registerPending: (id: string) => Promise<HitlResponse>; hasPending: () => boolean; cancelPending: (id: string) => void }`
  - `export interface PresentToolDetails { action?: string; tweak?: string; cancelled?: boolean; error?: string }`
  - `export function describeHitlResponse(r: HitlResponse): string`
  - `export function createPresentTool(deps: PresentToolDeps): ToolDefinition<typeof PresentParameters, PresentToolDetails>` — the `webui_present` tool registered by `wireWebui`

- [ ] **Step 1: Write the failing tests — present-tool unit (fake deps)**

Create `tests/present-tool.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { createPresentTool, describeHitlResponse } from "../src/present-tool.js";
import type { HitlResponse } from "../src/webui-wiring.js";

/**
 * Fake dependency set mirroring the wiring's pending registry: registerPending
 * stores the resolver; resolve/cancelPending drive it exactly like the wiring's
 * appexec dispatch / abort paths do.
 */
function fakeDeps() {
  const resolvers = new Map<string, (r: HitlResponse) => void>();
  const presented: Array<Record<string, unknown> & { id: string }> = [];
  const deps = {
    presented,
    present: (input: Record<string, unknown> & { id: string }): string => {
      presented.push(input);
      return input.id;
    },
    registerPending: (id: string): Promise<HitlResponse> =>
      new Promise<HitlResponse>((resolve) => resolvers.set(id, resolve)),
    hasPending: (): boolean => resolvers.size > 0,
    cancelPending: (id: string): void => {
      const r = resolvers.get(id);
      if (r) {
        resolvers.delete(id);
        r({ cancelled: true });
      }
    },
    /** Test-side: resolve like the appexec dispatch does. */
    respond: (id: string, action: string, tweak?: string): void => {
      const r = resolvers.get(id);
      if (r) {
        resolvers.delete(id);
        r(tweak !== undefined ? { action, tweak } : { action });
      }
    },
  };
  return deps;
}

const CONTROLS = [
  { id: "approve", label: "Approve" },
  { id: "regenerate", label: "Regenerate…", takesInput: true },
];

describe("createPresentTool", () => {
  it("returns a tool named webui_present with controls as a REQUIRED param", () => {
    const tool = createPresentTool(fakeDeps());
    expect(tool.name).toBe("webui_present");
    expect(tool.parameters.type).toBe("object");
    expect(tool.parameters.properties).toHaveProperty("content");
    expect(tool.parameters.properties).toHaveProperty("controls");
    expect(tool.parameters.required).toContain("controls");
    expect(tool.parameters.properties.controls.type).toBe("array");
  });

  it("execute() presents, blocks, and resolves {action} on respond", async () => {
    const deps = fakeDeps();
    const tool = createPresentTool(deps);
    const p = tool.execute("c1", { content: "# hi", controls: CONTROLS }, undefined, undefined, {} as never);
    // The present dep fired with the full payload + a generated unique id.
    expect(deps.presented).toHaveLength(1);
    expect(deps.presented[0]).toMatchObject({ content: "# hi", controls: CONTROLS });
    const id = deps.presented[0].id;
    expect(id).toMatch(/^present_\d+_\d+$/);
    // respond resolves the blocked execute.
    deps.respond(id, "approve");
    const out = await p;
    expect(out.content).toEqual([{ type: "text", text: "User approved (action: approve)." }]);
    expect(out.details).toEqual({ action: "approve" });
  });

  it("execute() surfaces a tweak in text + details", async () => {
    const deps = fakeDeps();
    const tool = createPresentTool(deps);
    const p = tool.execute("c2", { content: "img", controls: CONTROLS }, undefined, undefined, {} as never);
    deps.respond(deps.presented[0].id, "regenerate", "more red");
    const out = await p;
    expect(out.content[0].text).toBe('User requested regenerate with tweak: "more red".');
    expect(out.details).toEqual({ action: "regenerate", tweak: "more red" });
  });

  it("execute() forwards mode/view/title to the present dep", async () => {
    const deps = fakeDeps();
    const tool = createPresentTool(deps);
    const p = tool.execute(
      "c3",
      { content: "<p>x</p>", mode: "html", view: "review", title: "Review", controls: CONTROLS },
      undefined, undefined, {} as never
    );
    expect(deps.presented[0]).toMatchObject({ mode: "html", view: "review", title: "Review" });
    deps.respond(deps.presented[0].id, "approve");
    await p;
  });

  it("aborting the tool signal cancels the pending → {cancelled:true}", async () => {
    const deps = fakeDeps();
    const tool = createPresentTool(deps);
    const ac = new AbortController();
    const p = tool.execute("c4", { content: "x", controls: CONTROLS }, ac.signal, undefined, {} as never);
    const id = deps.presented[0].id;
    ac.abort();
    const out = await p;
    expect(out.content).toEqual([{ type: "text", text: "User cancelled / connection lost." }]);
    expect(out.details).toEqual({ cancelled: true });
    // cancelPending was invoked with the registered id (the wiring's registry cleared).
    expect(deps.hasPending()).toBe(false);
    expect(id).toMatch(/^present_\d+_\d+$/);
  });

  it("a SECOND webui_present while one is pending → error result (no throw, no second view)", async () => {
    const deps = fakeDeps();
    const tool = createPresentTool(deps);
    const first = tool.execute("c5", { content: "a", controls: CONTROLS }, undefined, undefined, {} as never);
    const second = await tool.execute("c6", { content: "b", controls: CONTROLS }, undefined, undefined, {} as never);
    // Error RESULT (ask-user style: text + details.error), never a thrown crash.
    expect(second.details).toEqual({ error: "already_pending" });
    expect(second.content[0].text).toContain("already pending");
    // Only the FIRST presentation was minted.
    expect(deps.presented).toHaveLength(1);
    // The first is still pending; cancelling it clears the guard.
    deps.cancelPending(deps.presented[0].id);
    const firstOut = await first;
    expect(firstOut.details).toEqual({ cancelled: true });
    const third = tool.execute("c7", { content: "c", controls: CONTROLS }, undefined, undefined, {} as never);
    expect(deps.presented).toHaveLength(2); // guard released — a new present is allowed
    deps.respond(deps.presented[1].id, "approve");
    await third;
  });

  it("generated ids are unique across calls", async () => {
    const deps = fakeDeps();
    const tool = createPresentTool(deps);
    const a = tool.execute("c8", { content: "a", controls: CONTROLS }, undefined, undefined, {} as never);
    deps.cancelPending(deps.presented[0].id);
    await a;
    const b = tool.execute("c9", { content: "b", controls: CONTROLS }, undefined, undefined, {} as never);
    deps.cancelPending(deps.presented[1].id);
    await b;
    expect(deps.presented[0].id).not.toBe(deps.presented[1].id);
  });
});

describe("describeHitlResponse", () => {
  it("approve without tweak", () => {
    expect(describeHitlResponse({ action: "approve" })).toBe("User approved (action: approve).");
  });
  it("any action with tweak", () => {
    expect(describeHitlResponse({ action: "regenerate", tweak: "more red" })).toBe(
      'User requested regenerate with tweak: "more red".'
    );
  });
  it("generic action without tweak", () => {
    expect(describeHitlResponse({ action: "reject" })).toBe('User chose action "reject".');
  });
  it("cancelled", () => {
    expect(describeHitlResponse({ cancelled: true })).toBe("User cancelled / connection lost.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/present-tool.test.ts )`
Expected: FAIL — `Cannot find module '../src/present-tool.js'`.

- [ ] **Step 3: Create src/present-tool.ts**

```ts
/**
 * present-tool.ts — the LLM-callable BLOCKING HITL gate (spec Component 2).
 *
 * `createPresentTool(deps)` builds the `webui_present` ToolDefinition. Its
 * execute() presents content + declarative controls to the browser (via the
 * `present` dep → the `webui:present` event → the present-as-view registry),
 * then BLOCKS on the pending-Promise registry keyed by the generated
 * `present_<now>_<seq>` id until the browser posts an appexec respond (Phase-1
 * return transport) or an abort fires (session_shutdown / WS close resolve all
 * pending; the tool's own `signal` cancels just this one via `cancelPending`).
 *
 * Deliberately a FACTORY over explicit deps (mirroring createRenderTool) so the
 * blocking/guard/abort logic is unit-testable with fakes — no live wiring, no
 * Bun.serve. The error path returns a tool RESULT (text + `details.error`),
 * mirroring ask-user's local envelope style — NEVER a thrown crash. No
 * cross-package import: the webui package has zero today and gains none.
 */
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Control, RenderMode } from "./render-service.js";
import type { HitlResponse } from "./webui-wiring.js";

export const PresentParameters = Type.Object({
  content: Type.String({ description: "Markdown or HTML to present to the user." }),
  mode: Type.Optional(
    Type.Union([Type.Literal("md"), Type.Literal("html")], {
      description: "Render mode. Default 'md'.",
    })
  ),
  view: Type.Optional(Type.String({ description: "Named view id. Default 'present'." })),
  title: Type.Optional(Type.String({ description: "Optional presentation title shown in the shell." })),
  controls: Type.Array(
    Type.Object({
      id: Type.String({ description: "Control id — returned to you as the response `action`." }),
      label: Type.String({ description: "Button label shown to the user." }),
      takesInput: Type.Optional(
        Type.Boolean({ description: "If true, a free-text tweak input is revealed next to this control." })
      ),
    }),
    { minItems: 1, description: "Declarative response controls (the user picks exactly one)." }
  ),
});

/** What the tool hands its `present` dep; `id` is the tool-generated presentId. */
export interface PresentInput {
  content: string;
  controls: Control[];
  id: string;
  mode?: RenderMode;
  view?: string;
  title?: string;
}

/** Mints the presentation (view + event) and returns the presentId. */
export type PresentFn = (input: PresentInput) => string;

export interface PresentToolDeps {
  present: PresentFn;
  registerPending: (id: string) => Promise<HitlResponse>;
  hasPending: () => boolean;
  cancelPending: (id: string) => void;
}

export interface PresentToolDetails {
  action?: string;
  tweak?: string;
  cancelled?: boolean;
  error?: string;
}

const ERROR_ALREADY_PENDING =
  "Another webui_present is already pending (one presentation at a time in v1). " +
  "Wait for the user to respond to it — or for it to be cancelled — before presenting again.";

/** Module-level sequence so ids are unique within a process. */
let presentSeq = 0;
function nextPresentId(): string {
  presentSeq += 1;
  return `present_${Date.now()}_${presentSeq}`;
}

/** Human-readable one-liner for the tool result text (structured data rides `details`). */
export function describeHitlResponse(r: HitlResponse): string {
  if ("cancelled" in r) return "User cancelled / connection lost.";
  if (r.tweak !== undefined) return `User requested ${r.action} with tweak: "${r.tweak}".`;
  if (r.action === "approve") return "User approved (action: approve).";
  return `User chose action "${r.action}".`;
}

/**
 * Await the pending response, wiring the tool's abort signal: on abort, cancel
 * THIS pending (cancelPending resolves it as {cancelled:true}, so the outer
 * promise settles normally). No timeout — loopback HITL blocks indefinitely
 * until response or abort (spec).
 */
function awaitPendingWithAbort(
  p: Promise<HitlResponse>,
  signal: AbortSignal | undefined,
  onCancel: () => void
): Promise<HitlResponse> {
  if (!signal) return p;
  return new Promise<HitlResponse>((resolve) => {
    const onAbort = () => onCancel();
    signal.addEventListener("abort", onAbort, { once: true });
    void p.then((r) => {
      signal.removeEventListener("abort", onAbort);
      resolve(r);
    });
  });
}

export function createPresentTool(
  deps: PresentToolDeps
): ToolDefinition<typeof PresentParameters, PresentToolDetails> {
  return {
    name: "webui_present",
    label: "Present",
    description:
      "Present content (markdown or HTML, e.g. a generated image as markdown) to the user in the " +
      "browser TOGETHER with declarative response controls, and BLOCK until the user picks one. " +
      "Each control is a button ({id, label}); controls with takesInput reveal a free-text tweak " +
      "field. Returns {action: <controlId>, tweak?} when the user responds, or {cancelled: true} " +
      "if the user cancels / the connection drops. One presentation at a time.",
    promptSnippet:
      "Use to show the user content and WAIT for their decision via declarative controls (blocking HITL gate).",
    parameters: PresentParameters,
    async execute(_callId, params, signal, _onUpdate, _ctx) {
      // One-pending-at-a-time guard (spec: v1) — an error RESULT, not a crash.
      if (deps.hasPending()) {
        return {
          content: [{ type: "text", text: ERROR_ALREADY_PENDING }],
          details: { error: "already_pending" },
        };
      }
      const id = nextPresentId();
      const presentId = deps.present({
        content: params.content,
        controls: params.controls,
        id,
        ...(params.mode !== undefined ? { mode: params.mode as RenderMode } : {}),
        ...(params.view !== undefined ? { view: params.view } : {}),
        ...(params.title !== undefined ? { title: params.title } : {}),
      });
      const response = await awaitPendingWithAbort(
        deps.registerPending(presentId),
        signal,
        () => deps.cancelPending(presentId)
      );
      // Branch on `cancelled` BEFORE reading `action` (Phase-2 ledger: the
      // HitlResponse union makes this the only narrowing path).
      if ("cancelled" in response) {
        return {
          content: [{ type: "text", text: "User cancelled / connection lost." }],
          details: { cancelled: true },
        };
      }
      return {
        content: [{ type: "text", text: describeHitlResponse(response) }],
        details:
          response.tweak !== undefined
            ? { action: response.action, tweak: response.tweak }
            : { action: response.action },
      };
    },
  };
}
```

(`import type { HitlResponse } from "./webui-wiring.js"` is type-only — it erases at runtime, so the mutual `webui-wiring.ts` ↔ `present-tool.ts` imports create NO runtime cycle.)

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/present-tool.test.ts )`
Expected: PASS.

- [ ] **Step 5: Write the failing tests — wiring integration (MockPi)**

Add to `tests/webui-wiring.test.ts` (a NEW top-level describe after the `webui:present` describe added in Task 1):

```ts
describe("wireWebui — webui_present blocking gate (integration via MockPi)", () => {
  function presentToolOf(pi: MockPi): any {
    const tool = pi.registeredTools.find((t: any) => t?.name === "webui_present");
    expect(tool).toBeDefined();
    return tool;
  }

  test("present → view minted with controls; respond → execute resolves {action, tweak}", async () => {
    const { pi, server } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    const tool = presentToolOf(pi);
    const blocked = tool.execute(
      "c1",
      {
        content: "![image](/output/0/img.png)",
        controls: [
          { id: "approve", label: "Approve" },
          { id: "regenerate", label: "Regenerate…", takesInput: true },
        ],
      },
      undefined, undefined, {} as never
    );
    // The present path minted the DEFAULT 'present' view (webui:present event →
    // handler → registry); observe it via the installed HTTP routes.
    expect(server.httpRoutes).not.toBeNull();
    const res = server.httpRoutes!(new Request("http://t/api/view/present"), {} as never);
    const body = await res.json();
    expect(body).toMatchObject({
      id: "present",
      mode: "md",
      controls: [
        { id: "approve", label: "Approve" },
        { id: "regenerate", label: "Regenerate…", takesInput: true },
      ],
    });
    // The generated presentId is discoverable from the view — use it to respond.
    dispatch(pi, server, {
      type: "appexec",
      extra: { kind: "respond", id: body.presentId, action: "regenerate", tweak: "more red" },
    });
    const out = await blocked;
    expect(out.content[0].text).toBe('User requested regenerate with tweak: "more red".');
    expect(out.details).toEqual({ action: "regenerate", tweak: "more red" });
  });

  test("a SECOND webui_present while one pending → error result", async () => {
    const { pi } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    const tool = presentToolOf(pi);
    const first = tool.execute(
      "c1", { content: "a", controls: [{ id: "approve", label: "Approve" }] },
      undefined, undefined, {} as never
    );
    const second = await tool.execute(
      "c2", { content: "b", controls: [{ id: "approve", label: "Approve" }] },
      undefined, undefined, {} as never
    );
    expect(second.details).toEqual({ error: "already_pending" });
    expect(second.content[0].text).toContain("already pending");
    // The first presentation survives and still resolves on shutdown.
    pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    const out = await first;
    expect(out.details).toEqual({ cancelled: true });
    expect(out.content[0].text).toBe("User cancelled / connection lost.");
  });

  test("session_shutdown mid-pending → execute resolves {cancelled:true}", async () => {
    const { pi } = setup();
    pi.emit("session_start", { type: "session_start", reason: "startup" });
    const tool = presentToolOf(pi);
    const blocked = tool.execute(
      "c1", { content: "a", controls: [{ id: "approve", label: "Approve" }] },
      undefined, undefined, {} as never
    );
    pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    const out = await blocked;
    expect(out.details).toEqual({ cancelled: true });
    expect(out.content[0].text).toBe("User cancelled / connection lost.");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/webui-wiring.test.ts )`
Expected: FAIL — `pi.registeredTools` contains only `webui_render`; `presentToolOf` throws `expect(tool).toBeDefined()` failure.

- [ ] **Step 7: Compose createPresentTool inside wireWebui**

In `src/webui-wiring.ts`:

**(a)** Add the imports next to the render ones (after line ~22, `createPresentEventHandler` import from Task 1):

```ts
import { createPresentTool, type PresentInput } from "./present-tool.js";
```

**(b)** Add a single-pending `cancelPending` closure right AFTER `cancelAllPending` (inside `wireWebui`, ~line 250):

```ts
  /** Cancel ONE pending as {cancelled:true} (the webui_present tool's signal-abort path). */
  function cancelPending(id: string): void {
    const entry = pending.get(id);
    if (entry) {
      pending.delete(id);
      entry.resolve({ cancelled: true });
    }
  }
```

**(c)** Compose the tool. The registration block (Task-1 state, ~lines 331-335) is:

```ts
  pi.registerTool?.(createRenderTool(registry));
  pi.events?.on("webui:render", createRenderEventHandler(registry));
  const presentHandler = createPresentEventHandler(registry);
  pi.events?.on("webui:present", presentHandler);
```

Replace it with:

```ts
  pi.registerTool?.(createRenderTool(registry));
  pi.events?.on("webui:render", createRenderEventHandler(registry));
  const presentHandler = createPresentEventHandler(registry);
  pi.events?.on("webui:present", presentHandler);

  // webui_present (the blocking HITL gate, spec Component 2): the `present` dep
  // emits the webui:present event (the registered handler mints the view). If
  // the host has NO shared event bus (guarded seam), fall back to invoking the
  // handler directly so the view is still minted. Returns the presentId that
  // keys the pending registry.
  const present = (input: PresentInput): string => {
    const payload = {
      content: input.content,
      controls: input.controls,
      id: input.id,
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.view !== undefined ? { view: input.view } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
    };
    if (pi.events) pi.events.emit("webui:present", payload);
    else presentHandler(payload);
    return input.id;
  };
  pi.registerTool?.(
    createPresentTool({
      present,
      registerPending,
      hasPending: () => pending.size > 0,
      cancelPending,
    })
  );
```

(Guard soundness: from the `hasPending()` check through `registerPending` there is no `await`, so two concurrent `execute()` calls cannot interleave before the first registers its pending — the second observes `pending.size > 0`.)

- [ ] **Step 8: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/webui-wiring.test.ts )`
Expected: PASS (all wiring tests, including the Task-1 HITL block and the new integration describe).

- [ ] **Step 9: Full package gates**

```bash
( cd bun-apps/pi-agent-ext-webui && bun test )
( cd bun-apps/pi-agent-ext-webui && bun run build )
```

Expected: FULL `bun test` suite PASS (the gate for this package — typecheck is NOT the gate; `bun run build` covers `src/**` via `bunx tsc` and must exit 0).

- [ ] **Step 10: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/present-tool.ts \
        bun-apps/pi-agent-ext-webui/src/webui-wiring.ts \
        bun-apps/pi-agent-ext-webui/tests/present-tool.test.ts \
        bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts
git commit -m "feat(webui): webui_present blocking HITL tool + wiring composition (Phase 2 / spec Component 2)

- present-tool.ts factory over explicit deps (createPresentTool): TypeBox params
  with REQUIRED controls, present_<now>_<seq> ids, one-pending guard returning an
  error RESULT (never throws), signal-abort wiring via cancelPending
- humanReadable result text (approve / tweak / cancelled) + structured details
- wireWebui composes: present dep (event emit + no-bus fallback), hasPending,
  cancelPending closure; branches on cancelled before reading action"
```

---

## Self-Review (performed at authoring time)

**1. Spec coverage (Phase-2 slice = Components 2+3 + ledger):**
- Component 2 (`webui_present` tool): Task 2 — params with required `controls` (TypeBox), blocking execute, generated `present_<now>_<seq>` id, signal-abort → `{cancelled:true}`, `{content:[text], details:{action?,tweak?,cancelled?}}` return, humanReadable strings, one-pending guard with explicit test. ✅
- Component 3 (`webui:present` event, Decision A): Task 1 — handler validates `{content, controls, id?, mode?, view?, title?}` (id optional inbound), mints view `view ?? "present"` with `controls`/`presentId`; `RenderView` additive fields; SSE notify unchanged; `/api/view/:id` carries both. ✅
- Ledger items: HitlResponse union + export + Task-1/Phase-1 test compatibility (Task 1 Step 13 note + Step 15); duplicate-id resolve-old-as-cancelled (Step 15c, tested Step 13); one-pending guard test (Task 2 Steps 1 & 5); stale JSDoc refresh (Step 17); manifest verify-only (Step 18); WS-close tension documented not changed (Step 15e). ✅
- Explicitly deferred to later phases (per spec phasing): browser toolbar rendering, image-presentation helper, mirror drop.

**2. Placeholder scan:** No TBD/TODO/"add validation"/"similar to Task N" — every step carries complete code; the only prose-only steps are run/verify/commit, which is the intended shape.

**3. Type consistency:** `HitlResponse` is defined once (webui-wiring.ts, Task 1) and imported type-only by present-tool.ts (Task 2) and both test files; `Control` is defined once in render-service.ts and flows through RenderView/RenderInput/routes/handler/tool; `PresentInput`/`PresentFn`/`PresentToolDeps` names match between present-tool.ts, the wiring composition, and the unit-test fakes; `cancelPending` is defined in Task 2 Step 7b and consumed in 7c and the deps object; `presentHandler` is bound in Task 1 Step 15d and reused in Task 2 Step 7c (declared in Consumes). Ask-user's envelope is pattern-mirrored locally (no cross-package import — verified webui has zero today).
