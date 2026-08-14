# HITL webui build — Phase 1: appexec return transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the no-op `appexec` bypass-mutex seam into a working HITL response return path — `parseCommand` surfaces a typed `respond`, an in-memory pending-Promise registry resolves by id, and `session_shutdown` / WS-close abort every pending — exposing `registerPending(id)` for Phase 2's `webui_present` tool.

**Architecture:** Two tasks over the existing webui deep-module stack. Task 1 tightens the *descriptor* layer (`protocol.ts` `DispatchAction` + `web-transport.ts` `parseCommand`) so a `{type:"appexec", extra:{kind:"respond",…}}` frame becomes a typed `{kind:"appexec", op:"respond", id, action, tweak?}` while unknown/malformed ops parse to `null` (ignored, never schema-rejected). Task 2 tightens the *wiring* layer (`webui-wiring.ts` `dispatch` + a new pending-Promise `Map` + `registerPending`) so a `respond` resolves its pending by id, and adds a `setWsCloseHandler` seam (`web-server.ts` real impl + `WebuiServer` interface + `FakeWebServer`) so `session_shutdown` + WS-close both resolve all pending as `{cancelled:true}`.

**Tech Stack:** TypeScript (Bun transpile for tests; `bunx tsc` / `bun run build` for `src/**` type-checking), TypeBox (`typebox` v1.x) for the wire schema, `bun:test` for tests. No MLX, no `Bun.serve` in the unit tests (the wiring uses a `FakeWebServer`; only one focused real-`WebServer` test binds an ephemeral port).

## Global Constraints

Each task's requirements implicitly include all of the following (copied verbatim from the spec / repo where they bind).

- **Transport boundary**: "Loopback-only, auth-off." — `wireWebui` keeps `server.setTokenAuth(null)`; do not add auth. (spec §Destination; `src/webui-wiring.ts:191`)
- **Test gate**: "webui quirk: `tsconfig` includes only `src/**` → run FULL `bun test`, not typecheck; update fixtures in-task" — the package's `tsc` does NOT cover `tests/**`, so the test gate is `bun test` (run from inside the package). `src/**` types ARE checked: run `bun run build` (`= bunx tsc`) before each commit to catch descriptor/interface type regressions that `bun test`'s transpiler skips. (spec §Tests)
- **Shell discipline**: Never top-level `cd` (`no-cd-drift.sh` blocks it). Run package commands as `( cd bun-apps/pi-agent-ext-webui && <cmd> )`. (repo CLAUDE.md)
- **Schema stance**: TypeBox, specifier `"typebox"` (NOT `@sinclair/typebox`). `AppExecCommandSchema.extra` stays LOOSE (`Type.Optional(Type.Record(Type.String(), Type.Unknown()))`) — unknown-op frames must VALIDATE then be IGNORED at parse time, never rejected by the schema. (spec §Tests / `src/protocol.ts:42-45`)
- **Purity**: `protocol.ts` + `web-transport.ts` keep zero runtime pi/Bun imports; the volatile adapter is `web-server.ts`. (`src/protocol.ts` header, `src/web-server.ts` header)
- **File paths**: all work is under `bun-apps/pi-agent-ext-webui/` — `src/protocol.ts`, `src/web-transport.ts`, `src/webui-wiring.ts`, `src/web-server.ts`, and `tests/{web-transport,webui-wiring,web-server}.test.ts`.

---

## Phase context

This plan covers **spec Phase 1 only** (`spec.md` Component 1 — "appexec resolver + pending-Promise registry (return transport)"). `spec.md` is the master 5-phase outline; Phases 2–5 (`webui_present` tool + `webui:present` event; browser declarative-controls toolbar; image presentation via `/output`; drop the mirror + `webui_render`) get their own plan increments as they are reached. This plan's Task 2 **Produces** `registerPending(id)`, which Phase 2's `webui_present.execute()` Consumes (it calls `registerPending(id)`, emits `webui:present`, and `await`s the returned Promise). `render-event-handler.ts` (the `webui:render` channel) is read-only context here — Phase 2 will add the sibling `webui:present` handler next to it; Phase 1 does not touch it. (Context only — no placeholders, no task.)

---

## File Structure

- **Modify**: `bun-apps/pi-agent-ext-webui/src/protocol.ts` — the schema layer; tighten the `DispatchAction` appexec variant from a loose `{op:string; [k:string]:unknown}` to the typed respond shape. `AppExecCommandSchema` itself is UNCHANGED (comment-only update).
- **Modify**: `bun-apps/pi-agent-ext-webui/src/web-transport.ts` — the pure deep module; rewrite `parseCommand`'s `case "appexec"` to validate `extra` and surface the typed respond descriptor, returning `null` for unknown/malformed ops.
- **Modify**: `bun-apps/pi-agent-ext-webui/tests/web-transport.test.ts` — rewrite the single appexec-parse test (currently asserts the drop) into a focused set asserting the typed respond surface + ignore semantics.
- **Modify**: `bun-apps/pi-agent-ext-webui/src/web-server.ts` — the volatile adapter; add the `setWsCloseHandler(cb)` seam (field + method + invoke `cb` in the WS `close` handler).
- **Modify**: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts` — the composition root; add the pending-Promise registry + `registerPending` + `cancelAllPending`, resolve by id in `dispatch`'s appexec case, wire `setWsCloseHandler` + call `cancelAllPending` in `session_shutdown`/`dispose`, extend `WebuiServer` (add `setWsCloseHandler`) and `WebuiWiring` (add `registerPending`).
- **Modify**: `bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts` — extend `FakeWebServer` with `wsCloseHandler`, rewrite the appexec-dispatch no-op test into the HITL transport tests (resolve-by-id, unknown-id ignored, session_shutdown abort, WS-close abort).
- **Modify**: `bun-apps/pi-agent-ext-webui/tests/web-server.test.ts` — add ONE focused real-`WebServer` test asserting `setWsCloseHandler`'s callback fires on WS close (the `FakeWebServer` only proves wiring CALLS `setWsCloseHandler`; this proves the real server INVOKES cb on close).

---

### Task 1: appexec respond shape (protocol.ts descriptor + web-transport.ts parseCommand)

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/src/protocol.ts:37-45` (update `AppExecCommandSchema` JSDoc only; schema unchanged)
- Modify: `bun-apps/pi-agent-ext-webui/src/protocol.ts:116-127` (tighten `DispatchAction` appexec variant to the typed respond shape)
- Modify: `bun-apps/pi-agent-ext-webui/src/web-transport.ts:64-70` (rewrite `parseCommand` `case "appexec"`)
- Test: `bun-apps/pi-agent-ext-webui/tests/web-transport.test.ts:58-66` (rewrite the appexec-parse test)

**Interfaces:**
- Consumes: `AppExecCommandSchema` (`src/protocol.ts:42-45`, UNCHANGED) — its static type gives `ClientFrame`'s appexec member `{ type:"appexec"; extra?: Record<string, unknown> }`, which is what `parseCommand` reads.
- Produces: the `DispatchAction` appexec variant `{ kind:"appexec"; op:"respond"; id:string; action:string; tweak?:string }` (Task 2 Consumes this exact shape — `dispatch` narrows on `kind:"appexec"` then reads `action.id` / `action.action` / `action.tweak`).

- [ ] **Step 1: Write the failing test (rewrite the appexec-parse test)**

In `tests/web-transport.test.ts`, replace the single `it("appexec -> bypass descriptor (NOT agentic; NO source field)", …)` block (currently asserts the drop) with this focused set:

```ts
  it("appexec respond (id+action) -> typed bypass descriptor", () => {
    const d = t.parseCommand({ type: "appexec", extra: { kind: "respond", id: "p1", action: "approve" } });
    expect(d).toEqual({ kind: "appexec", op: "respond", id: "p1", action: "approve" });
  });

  it("appexec respond with tweak surfaces tweak", () => {
    const d = t.parseCommand({
      type: "appexec",
      extra: { kind: "respond", id: "p2", action: "regenerate", tweak: "more red" },
    });
    expect(d).toEqual({
      kind: "appexec", op: "respond", id: "p2", action: "regenerate", tweak: "more red",
    });
  });

  it("appexec respond is NOT agentic (NO source field) — bypasses the mutex", () => {
    // Task 2's wiring branches on `kind === "agentic"` BEFORE touching the mutex;
    // a respond has kind "appexec" and no `source`, so it is never routed through
    // handleInput (spec §6).
    const d = t.parseCommand({
      type: "appexec", extra: { kind: "respond", id: "p3", action: "approve" },
    }) as DispatchAction;
    expect(d.kind).toBe("appexec");
    expect((d as { source?: unknown }).source).toBeUndefined();
  });

  it("appexec with no extra (unknown op) -> null (ignored at parse time, spec §6)", () => {
    expect(t.parseCommand({ type: "appexec" })).toBeNull();
  });

  it("appexec with an unknown op in extra -> null (ignored, NOT rejected by schema)", () => {
    expect(t.parseCommand({ type: "appexec", extra: { kind: "nope", id: "x" } })).toBeNull();
  });

  it("appexec respond missing id or action (malformed) -> null (ignored)", () => {
    expect(t.parseCommand({ type: "appexec", extra: { kind: "respond", id: "x" } })).toBeNull();
    expect(t.parseCommand({ type: "appexec", extra: { kind: "respond", action: "a" } })).toBeNull();
  });

  it("appexec respond with a non-string tweak -> null (ignored)", () => {
    expect(
      t.parseCommand({ type: "appexec", extra: { kind: "respond", id: "x", action: "a", tweak: 5 } })
    ).toBeNull();
  });
```

The `DispatchAction` type import already exists at the top of the file (`import type { ClientFrame, DispatchAction, EventLike, WebFrame } from "../src/protocol.js";`); no import change needed.

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/web-transport.test.ts )`
Expected: FAIL. The current `parseCommand` appexec case returns `{ kind: "appexec", op: frame.type }` and drops `extra`, so:
- the first test gets `{ kind: "appexec", op: "appexec" }` (no `op:"respond"`, no `id`/`action`) → `toEqual` mismatch;
- the `expect(...).toBeNull()` tests get a non-null object → fail.

- [ ] **Step 3: Write minimal implementation (tighten the descriptor + surface respond)**

3a. In `src/protocol.ts`, update the `AppExecCommandSchema` JSDoc (the schema object literal stays byte-identical). Replace the comment block at `src/protocol.ts:37-41` with:

```ts
/**
 * `appexec` is the HITL return transport (spec Component 1): it BYPASSES the
 * mutex entirely. The optional `extra` bag carries a concrete op; Phase 1
 * recognizes `{ kind: "respond", id, action, tweak? }`. The SCHEMA stays loose
 * (an unknown-op frame must still VALIDATE here so it can be IGNORED at parse
 * time — never rejected by the schema, spec §6 forward-compat). The
 * `{ type: "appexec" }` shape alone must validate.
 */
const AppExecCommandSchema = Type.Object({
  type: Type.Literal("appexec"),
  extra: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
```

3b. In `src/protocol.ts`, tighten the `DispatchAction` appexec variant. Replace the JSDoc + variant at `src/protocol.ts:116-127` (the `/** ... */` through `| { kind: "appexec"; op: string; [k: string]: unknown }`) with:

```ts
  /**
   * `appexec` BYPASSES the mutex entirely. Phase 1 surfaces exactly one op —
   * `respond` — the HITL response a browser posts back for a pending
   * presentation (`{ kind:"respond", id, action, tweak? }` carried in `extra`).
   * {@link WebTransport.parseCommand} validates the respond sub-shape and
   * resolves THIS descriptor; an unknown op or a malformed respond resolves to
   * `null` (ignored at parse time, NOT rejected by the schema — spec §6). The
   * `op:"respond"` literal lets the wiring narrow `action.id` / `action.action`
   * / `action.tweak` without an `as`. Future ops (e.g. an explicit cancel) add
   * union members here.
   */
  | {
      kind: "appexec";
      op: "respond";
      id: string;
      action: string;
      tweak?: string;
    }
```

3c. In `src/web-transport.ts`, rewrite the `case "appexec":` block. Replace `src/web-transport.ts:64-70` (the `case "appexec":` through `return { kind: "appexec", op: frame.type };`) with:

```ts
      case "appexec": {
        // HITL return transport (spec Component 1): validate the respond
        // sub-shape in `extra` and surface a typed descriptor. Unknown op or
        // malformed respond -> null (IGNORED at parse time; the schema stays
        // loose so such frames still VALIDATE, spec §6). This seam MUST bypass
        // the mutex gate (the wiring branches on `kind === "agentic"` first).
        const extra = frame.extra;
        if (
          extra?.kind === "respond" &&
          typeof extra.id === "string" &&
          typeof extra.action === "string" &&
          (extra.tweak === undefined || typeof extra.tweak === "string")
        ) {
          const out: {
            kind: "appexec";
            op: "respond";
            id: string;
            action: string;
            tweak?: string;
          } = { kind: "appexec", op: "respond", id: extra.id, action: extra.action };
          if (typeof extra.tweak === "string") out.tweak = extra.tweak;
          return out;
        }
        return null;
      }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/web-transport.test.ts )`
Expected: PASS — all seven appexec tests green, plus the pre-existing prompt/steer/followUp/abort/control/unknown tests untouched. Then run `bun run build` to confirm `src/**` types still check: `( cd bun-apps/pi-agent-ext-webui && bun run build )` — `tsc` must exit 0 (the narrowed `DispatchAction` union + the `out` literal are self-consistent).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/protocol.ts bun-apps/pi-agent-ext-webui/src/web-transport.ts bun-apps/pi-agent-ext-webui/tests/web-transport.test.ts
git commit -m "feat(webui): appexec respond shape — typed DispatchAction + parseCommand surface"
```

---

### Task 2: HITL pending-Promise registry + dispatch resolve + abort (webui-wiring.ts + web-server.ts setWsCloseHandler seam)

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/src/web-server.ts:151` (add `onWsClose` field)
- Modify: `bun-apps/pi-agent-ext-webui/src/web-server.ts:212-215` (add `setWsCloseHandler` method after `setTokenAuth`)
- Modify: `bun-apps/pi-agent-ext-webui/src/web-server.ts:336-338` (invoke `onWsClose` in the WS `close` handler)
- Modify: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts:115-116` (extend `WebuiServer` with `setWsCloseHandler`)
- Modify: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts:134-136` (extend `WebuiWiring` with `registerPending`)
- Modify: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts:206-207` (insert registry + `registerPending` + `cancelAllPending` after `let disposed = false;`)
- Modify: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts:244-246` (rewrite `dispatch` `case "appexec"` to resolve by id)
- Modify: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts:254` (wire `server.setWsCloseHandler(...)` after `server.setCommandHandler(onCommand);`)
- Modify: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts:318-322` (add `cancelAllPending()` to `session_shutdown`)
- Modify: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts:345-355` (add `setWsCloseHandler(null)` + `cancelAllPending()` to `dispose`, expose `registerPending` on the return)
- Test: `bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts:45-46` (add `wsCloseHandler` field to `FakeWebServer`)
- Test: `bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts:70-72` (add `setWsCloseHandler` to `FakeWebServer`)
- Test: `bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts:313-321` (rewrite the appexec-dispatch no-op test into the HITL transport tests)
- Test: `bun-apps/pi-agent-ext-webui/tests/web-server.test.ts:388-396` (add ONE real-`WebServer` test: `setWsCloseHandler` cb fires on WS close)

**Interfaces:**
- Consumes (from Task 1): the `DispatchAction` appexec variant `{ kind:"appexec"; op:"respond"; id:string; action:string; tweak?:string }`. `dispatch`'s `case "appexec":` narrows `action` to this member (discriminator `kind:"appexec"`) and reads `action.id`, `action.action`, `action.tweak` — all defined in Task 1.
- Produces (for Phase 2): `WebuiWiring.registerPending(id: string): Promise<{ action: string; tweak?: string; cancelled?: boolean }>`. Phase 2's `webui_present.execute()` calls `registerPending(id)`, emits `webui:present`, and `await`s the returned Promise; it resolves with `{action, tweak?}` on a matching respond or `{cancelled:true}` on abort. Phase 1 tests `registerPending` directly (no tool yet).
- Consumes (existing seam): `WebServer.setCommandHandler` / `setHttpRoutes` / `setTokenAuth` (`src/web-server.ts:194,202,212`); the `dispatch(action, session)` helper and `reg(event, handler)` registrar (`src/webui-wiring.ts:223,288`); `FakeWebServer implements WebuiServer` + the `setup()` / `dispatch()` test helpers (`tests/webui-wiring.test.ts:36,79,89`).

- [ ] **Step 1: Write the failing tests (FakeWebServer seam + HITL transport tests + real close→cb test)**

1a. In `tests/webui-wiring.test.ts`, extend `FakeWebServer`. After the `tokenAuth` field at `tests/webui-wiring.test.ts:45-46` add:

```ts
  /** Recorded WS-close handler (spec Component 1; the test fires it to assert abort). */
  wsCloseHandler: (() => void) | null = null;
```

And after the `setTokenAuth` method at `tests/webui-wiring.test.ts:70-72` add:

```ts
  setWsCloseHandler(cb: (() => void) | null): void {
    this.wsCloseHandler = cb;
  }
```

1b. In `tests/webui-wiring.test.ts`, replace the appexec-dispatch no-op test at `tests/webui-wiring.test.ts:313-321` (the `test("appexec → NO sendUserMessage, NO lock acquired", …)` block) with this HITL transport describe block:

```ts
  describe("HITL appexec return transport (respond resolve + registry + abort)", () => {
    test("respond resolves the pending registered under id with {action}", async () => {
      const { pi, server, wiring } = setup();
      pi.emit("session_start", { type: "session_start", reason: "startup" });
      const pending = wiring.registerPending("p1");
      dispatch(pi, server, { type: "appexec", extra: { kind: "respond", id: "p1", action: "approve" } });
      await expect(pending).resolves.toEqual({ action: "approve" });
    });

    test("respond with tweak surfaces tweak", async () => {
      const { pi, server, wiring } = setup();
      pi.emit("session_start", { type: "session_start", reason: "startup" });
      const pending = wiring.registerPending("p2");
      dispatch(pi, server, {
        type: "appexec",
        extra: { kind: "respond", id: "p2", action: "regenerate", tweak: "more red" },
      });
      await expect(pending).resolves.toEqual({ action: "regenerate", tweak: "more red" });
    });

    test("respond for an unknown id is ignored (the registered pending stays pending)", async () => {
      const { pi, server, wiring } = setup();
      pi.emit("session_start", { type: "session_start", reason: "startup" });
      const p3 = wiring.registerPending("p3");
      // A respond for a DIFFERENT id must NOT resolve p3.
      dispatch(pi, server, { type: "appexec", extra: { kind: "respond", id: "nope", action: "approve" } });
      let resolved = false;
      p3.then(() => { resolved = true; });
      await Promise.resolve(); // drain microtasks — resolve() is synchronous, so this is enough.
      expect(resolved).toBe(false);
      // Clean up the dangling pending via abort (also re-asserts session_shutdown cancels).
      pi.emit("session_shutdown", { type: "session_shutdown", reason: "done" });
      await expect(p3).resolves.toEqual({ cancelled: true });
    });

    test("session_shutdown resolves all pending as {cancelled:true}", async () => {
      const { pi, wiring } = setup();
      pi.emit("session_start", { type: "session_start", reason: "startup" });
      const a = wiring.registerPending("a");
      const b = wiring.registerPending("b");
      pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
      await expect(a).resolves.toEqual({ cancelled: true });
      await expect(b).resolves.toEqual({ cancelled: true });
    });

    test("WS close resolves all pending as {cancelled:true}", async () => {
      const { pi, server, wiring } = setup();
      pi.emit("session_start", { type: "session_start", reason: "startup" });
      const pending = wiring.registerPending("ws1");
      // wireWebui registered the close handler on the fake server.
      expect(server.wsCloseHandler).not.toBeNull();
      server.wsCloseHandler!();
      await expect(pending).resolves.toEqual({ cancelled: true });
    });
  });
```

1c. In `tests/web-server.test.ts`, add ONE real-`WebServer` test inside the existing `describe("WebServer broadcast over a real WS", …)` block (it already defines `makeServer`, `openWs`, `withTimeout`, `waitFor`). Insert it right after the "prunes a client after it disconnects" test (`tests/web-server.test.ts:388-396`):

```ts
  it("fires the setWsCloseHandler callback when a client disconnects", async () => {
    const s = makeServer({ port: 0 });
    let closeCount = 0;
    s.setWsCloseHandler(() => { closeCount++; });
    s.start();
    const ws = await withTimeout(openWs(`${s.url.replace("http", "ws")}/ws`), 2000, "ws open");
    await waitFor("client registered", () => s.clientCount === 1);
    expect(closeCount).toBe(0); // not fired on connect
    ws.close();
    await waitFor("ws-close handler fired", () => closeCount >= 1);
    expect(closeCount).toBe(1); // fired exactly once on disconnect
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/webui-wiring.test.ts tests/web-server.test.ts )`
Expected: FAIL. Red reasons: `wiring.registerPending is not a function` (registry not exposed), the respond tests never resolve (dispatch appexec is a no-op), `server.wsCloseHandler` is `null` (wireWebui doesn't call `setWsCloseHandler` yet) so the WS-close test's `server.wsCloseHandler!()` throws, and the real-`WebServer` test fails with `s.setWsCloseHandler is not a function`. (If `bun test` reports a different surface, that's fine — any failure rooted in the missing seam is the expected red.)

- [ ] **Step 3: Write minimal implementation (registry + resolve + abort + the setWsCloseHandler seam)**

3a. In `src/web-server.ts`, add the `onWsClose` field. After `private token: string | null = null;` (`src/web-server.ts:151`) add:

```ts
  /** Optional WS-close handler (spec Component 1); null => none (the default). */
  private onWsClose: (() => void) | null = null;
```

3b. In `src/web-server.ts`, add the setter. After the `setTokenAuth` method (`src/web-server.ts:212-214`) add:

```ts
  /**
   * Inject the WS-close abort handler (spec Component 1). Invoked on EVERY ws
   * close so the wiring can resolve all pending HITL presentations as
   * `{cancelled:true}`. `null` removes it. Mirrors setCommandHandler/
   * setHttpRoutes/setTokenAuth.
   */
  setWsCloseHandler(cb: (() => void) | null): void {
    this.onWsClose = cb;
  }
```

3c. In `src/web-server.ts`, invoke the handler on close. Replace the `close` arm of the `websocket` block (`src/web-server.ts:336-338`):

```ts
            close: (ws) => {
              this.clients.delete(ws);
              if (this.onWsClose) this.onWsClose();
            },
```

3d. In `src/webui-wiring.ts`, extend the `WebuiServer` interface. After the `setTokenAuth` member (`src/webui-wiring.ts:115`) add:

```ts
  /** WS-close abort seam (spec Component 1): invoked on each WS close so the
   *  wiring can resolve all pending HITL presentations as {cancelled:true}.
   *  Mirrors setCommandHandler/setHttpRoutes. */
  setWsCloseHandler(cb: (() => void) | null): void;
```

3e. In `src/webui-wiring.ts`, extend the `WebuiWiring` interface. Replace the interface at `src/webui-wiring.ts:134-136` with:

```ts
export interface WebuiWiring {
  /** Neutralize every handler + tear the server down (tests / session end). */
  dispose(): void;
  /**
   * Create + await a pending HITL presentation keyed by `id` (spec Component 1).
   * Phase 2's `webui_present` tool calls this, then awaits the returned Promise.
   * Resolves with `{action, tweak?}` when an appexec `respond` arrives for the
   * id; resolves with `{cancelled:true}` on abort (session_shutdown / WS close).
   */
  registerPending(id: string): Promise<{ action: string; tweak?: string; cancelled?: boolean }>;
}
```

3f. In `src/webui-wiring.ts`, add the registry. After `let disposed = false;` (`src/webui-wiring.ts:206`) and before the `// --- inbound dispatch seam ...` comment, insert:

```ts
  // --- HITL pending-Promise registry (return transport; spec Component 1) ----
  // Keyed by the respond `id`. registerPending creates + awaits a pending; the
  // dispatch appexec case resolves it; abort (session_shutdown / WS close)
  // resolves all pending as {cancelled:true}. Phase 2's webui_present tool is
  // the producer; Phase 1 tests registerPending directly. In-memory only (spec
  // Decision C); cleared on resolve/abort.
  type HitlResponse = { action: string; tweak?: string; cancelled?: boolean };
  const pending = new Map<string, { resolve: (r: HitlResponse) => void }>();

  function registerPending(id: string): Promise<HitlResponse> {
    return new Promise<HitlResponse>((resolve) => {
      pending.set(id, { resolve });
    });
  }

  /** Resolve every pending as {cancelled:true} (session_shutdown / WS close). */
  function cancelAllPending(): void {
    for (const entry of pending.values()) entry.resolve({ cancelled: true });
    pending.clear();
  }
```

3g. In `src/webui-wiring.ts`, rewrite `dispatch`'s `case "appexec":`. Replace `src/webui-wiring.ts:244-246` (the `case "appexec":` through its `break;`) with:

```ts
      case "appexec": {
        // Phase 1 return transport (spec Component 1): `action` is the typed
        // respond descriptor (Task 1). Resolve the pending Promise keyed by id;
        // an unknown id is ignored (no pending was registered for it). MUST
        // bypass the mutex (the wiring already branched on `kind === "agentic"`).
        const entry = pending.get(action.id);
        if (entry) {
          pending.delete(action.id);
          entry.resolve(
            action.tweak !== undefined
              ? { action: action.action, tweak: action.tweak }
              : { action: action.action }
          );
        }
        break;
      }
```

3h. In `src/webui-wiring.ts`, wire the WS-close seam. After `server.setCommandHandler(onCommand);` (`src/webui-wiring.ts:254`) add:

```ts
  // WS-close abort seam (spec Component 1): a disconnect mid-HITL resolves all
  // pending as {cancelled:true} so a blocked execute() returns cleanly.
  server.setWsCloseHandler(() => cancelAllPending());
```

3i. In `src/webui-wiring.ts`, abort on `session_shutdown`. Replace the `session_shutdown` registrar (`src/webui-wiring.ts:318-322`) with:

```ts
  reg("session_shutdown", () => {
    controller.handleShutdown();
    cancelAllPending();
    server.dropSession();
    bound = null;
  });
```

3j. In `src/webui-wiring.ts`, finish teardown + expose `registerPending`. Replace the `return { dispose(){…} };` block (`src/webui-wiring.ts:345-355`) with:

```ts
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      server.setHttpRoutes(null);
      server.setCommandHandler(null);
      server.setWsCloseHandler(null);
      cancelAllPending();
      controller.handleShutdown();
      server.dropSession();
      bound = null;
      server.stop();
    },
    registerPending,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/webui-wiring.test.ts tests/web-server.test.ts )`
Expected: PASS — the five HITL transport tests (resolve, tweak, unknown-id ignored, session_shutdown abort, WS-close abort) green, the real-`WebServer` close→cb test green, and every pre-existing wiring/web-server test green (the `setWsCloseHandler` seam defaults to `null`, so existing WS-close tests that never set it are unaffected). Then confirm `src/**` types with `( cd bun-apps/pi-agent-ext-webui && bun run build )` — `tsc` must exit 0 (`dispatch`'s `action.id`/`action.action`/`action.tweak` narrow correctly against Task 1's variant; `WebuiServer`/`WebuiWiring`/`FakeWebServer implements WebuiServer` are consistent). Finally run the FULL gate once: `( cd bun-apps/pi-agent-ext-webui && bun test )` — all green.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/web-server.ts bun-apps/pi-agent-ext-webui/src/webui-wiring.ts bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts bun-apps/pi-agent-ext-webui/tests/web-server.test.ts
git commit -m "feat(webui): HITL pending-Promise registry + appexec resolve + abort (session_shutdown/ws-close)"
```

---

## Self-Review

**1. Spec coverage (Phase-1 bullets from `spec.md` Component 1 + the task label `zk-spawn` scope):**

- *"web-transport.ts parseCommand: STOP dropping extra; surface a typed {kind:"appexec", op:"respond", id, action, tweak?} (validate the respond sub-shape; IGNORE unknown ops)."* → **Task 1** (`src/web-transport.ts:64-70` rewrite; the typed descriptor is `src/protocol.ts:116-127`).
- *"protocol.ts: tighten the DispatchAction appexec variant … keep AppExecCommandSchema.extra loose (unknown-op frames accepted then ignored at parse time, NOT rejected by schema)."* → **Task 1** (variant tightened `src/protocol.ts:116-127`; `AppExecCommandSchema` schema UNCHANGED `src/protocol.ts:42-45`, JSDoc-only update at `:37-41`; the "ignore unknown op" return-null is the parseCommand rewrite + asserted by two tests).
- *"webui-wiring.ts dispatch appexec case: an in-memory Map<id, {resolve, reject}> registry; on respond → resolve the pending Promise with {action, tweak?}; unknown id → ignore."* → **Task 2** (`Map` + `registerPending`/`cancelAllPending` at `:206-207`; resolve-by-id at `:244-246`; unknown-id-ignored + resolve asserted). (Note: the registry stores only `resolve` — there is no `reject` path because abort RESOLVES with `{cancelled:true}`, per the spec's "reject/resolve all pending as {cancelled:true}" — the chosen resolution semantics are tested explicitly.)
- *"Abort: on session_shutdown AND WS-close → resolve all pending as {cancelled:true}."* → **Task 2** (`session_shutdown` `:318-322` + the new `setWsCloseHandler` seam wired `:254`; both abort paths tested).
- *"WS-close seam (DECISION: option A — include it): ADD a setWsCloseHandler(cb) seam (interface + real impl calling cb on ws close + FakeWebServer records it). Wire it in wireWebui to clear all pending."* → **Task 2** (`WebuiServer` iface `:115-116`; real `WebServer` field/method `src/web-server.ts:151,212-215,336-338`; `FakeWebServer` field/method `tests/webui-wiring.test.ts:45-46,70-72`; wiring `:254`; real close→cb test `tests/web-server.test.ts`).
- *"Registry API for Phase 2 (Produces): expose registerPending(id) … Phase 1 tests it directly (no tool yet)."* → **Task 2** (`WebuiWiring.registerPending` `:134-136`; exposed on return `:345-355`; tested directly).

No Phase-1 spec bullet is left without a task.

**2. Placeholder scan:** No "TBD/TODO/implement later". Every code step carries the actual code (the new descriptor, the new `parseCommand` case, the registry fns, the dispatch resolve, the `setWsCloseHandler` field/method/close/wiring, and every test body). Every referenced type/fn resolves to a definition in a task: `DispatchAction` appexec variant (Task 1) ← read by `dispatch` (Task 2); `HitlResponse` / `pending` / `registerPending` / `cancelAllPending` (Task 2 3f) ← used by Task 2 3g/3h/3i/3j + tests; `WebuiServer.setWsCloseHandler` (Task 2 3d) ← implemented by `WebServer` (3b) + `FakeWebServer` (1a) + asserted by the real close test (1c). The `HitlResponse` type alias is defined in the SAME closure that uses it (no cross-file reference).

**3. Type consistency:** Task 2 **Consumes** exactly Task 1 **Produces**: `{ kind:"appexec"; op:"respond"; id:string; action:string; tweak?:string }`. Inside `dispatch`'s `case "appexec":` the `action.kind === "appexec"` discriminator narrows to that member, so `action.id` (`string`), `action.action` (`string`), `action.tweak` (`string | undefined`) are all in-scope and correctly typed — `bun run build` (`tsc`) in Task 2 Step 4 verifies this. `registerPending`'s return type `Promise<{ action: string; tweak?: string; cancelled?: boolean }>` matches `WebuiWiring.registerPending`'s signature (3e) and the test assertions (`{ action: "approve" }`, `{ action, tweak }`, `{ cancelled: true }`). The `entry.resolve(...)` calls pass exactly that shape (a plain `{action}` / `{action,tweak}` / `{cancelled:true}` object literal — all valid `HitlResponse`). `setWsCloseHandler(cb: (() => void) | null)` is identical across `WebuiServer` (3d), real `WebServer` (3b), and `FakeWebServer` (1a).
