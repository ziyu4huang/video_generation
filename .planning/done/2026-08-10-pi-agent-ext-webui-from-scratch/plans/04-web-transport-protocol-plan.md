# Web Transport & Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and test the web wire protocol + transport for ticket 04 — the `Bun.serve`-backed HTTP + WebSocket surface that lets a co-frontend web client drive one `AgentSession` alongside the TUI behind the ticket-03 agentic mutex. Outbound `ExtensionEvent`s map to WS frames; inbound commands route agentic ops **through** `MutexController` and **bypass** the lock for pure app-exec.

**Architecture (deep module + adapters — the Path-B migration seam):** three collaborating pieces, exactly as locked by `specs/04-web-transport-protocol.md` §3:

1. **`WebTransport`** — a *pure* deep module (no I/O, no `Bun` import, no runtime pi dependency — `ExtensionEvent` is a **type-only / structural** reference that erases at compile time). It owns the inbound dispatch decision (`parseCommand` → `DispatchAction` descriptor; agentic vs appexec-bypass vs control) and the outbound event→frame mapping (`mapEvent`). Fully testable through its interface.
2. **`Broadcaster`** — an injected one-method port (`broadcast(frame)`). A stable interface wrapped around a volatile transport, and the future Path-B swap point.
3. **`WebServer`** — the volatile adapter and the **only** `Bun.serve` touch-point: HTTP (`/health` + a stub connect-test page + `/ws` upgrade), the WS client-set + `broadcast` impl (lifted from `gui-movie-director/api/ws.ts`), the shared `originAllowed` guard (lifted from `gui-movie-director/lib/origin.ts`), an inline copy of `serveWithFallback` (copied from `gui-movie-director/server.ts` — **not** a lib export), `.unref()` (webui is embedded — gui-movie-director does **not** unref), and the module-level singleton lifecycle (lazy start on first `session_start`, re-point `pi`/`ctx` on each subsequent `session_start`, drop the session ref on `session_shutdown` — **server survives**; persistent co-frontend, NOT `closeAll()`).

A thin `protocol.ts` schema layer (TypeBox) sits under `WebTransport` and owns the frame schemas + a pure frame-builder, so the deep module's `mapEvent` is a delegation and the dispatch types are schema-derived. The mutex glue (`MutexNotifier` impl + every `pi.on(...)` handler + inbound WS→dispatch) is the `extensions/webui.ts` factory — the real wiring ticket 03 deliberately deferred.

**Tech Stack:** TypeScript (strict, NodeNext), `bun:test`, TypeBox (`typebox@^1.3.7` — ecosystem standard; zero `zod` in the repo per spec §4), bun workspace package `@repo/pi-agent-ext-webui`.

## Global Constraints

- **Workspace:** `bun-apps/` is the workspace root (`workspaces: ["./*"]`, isolated linker). `bun install` is run from `bun-apps/`, NEVER the repo root. The package `bun-apps/pi-agent-ext-webui/` already exists from ticket 03; this plan **extends** it (mutex modules stay untouched).
- **Shell:** NEVER top-level `cd` (a hook blocks it) — always use `( cd <dir> && ... )` subshells.
- **Language:** English for all written artifacts (code, comments, commit messages).
- **TypeScript:** strict; `module: NodeNext`; `moduleResolution: NodeNext`; `target: ES2022`. Import paths MUST include the `.js` extension (NodeNext). `rootDir: src`; `include: ["src/**/*.ts"]`.
- **pi:** a runtime dependency **only** of the extension entry (`extensions/webui.ts`) and the `WebServer` session-binding seam. `protocol.ts` and `web-transport.ts` have **zero** runtime pi dependency — `ExtensionEvent` is referenced type-only (structural) so it erases at compile time. This is what keeps the deep module + schema pure and fully testable in isolation.
- **TDD discipline (RED → GREEN → COMMIT per task):** write the failing test → run → see it fail → implement → run → see it pass → typecheck → commit. One commit per task minimum. Per-task review between tasks; a whole-branch final review (all tasks green, spec-coverage walk, placeholder scan) before merge.
- **Commit scope:** this plan creates files under `bun-apps/pi-agent-ext-webui/` plus ONE wiring edit to `bun-apps/pi-agent/run-dir/manifest.json` (Task 3). NEVER `git add -A`; stage explicit paths.
- **Do not touch:** `python/embed-bench/backends/mlx_native.py` (out of scope) and the existing `src/mutex.ts` / `src/mutex-controller.ts` (consumed as-is via `@repo/pi-agent-ext-webui/src/mutex-controller.js`).

---

## File Structure

```
bun-apps/pi-agent-ext-webui/
├── package.json                # +typebox devDependency (Task 0)
├── src/
│   ├── index.ts                # unchanged (ticket 03 placeholder)
│   ├── mutex.ts                # UNCHANGED (ticket 03)
│   ├── mutex-controller.ts     # UNCHANGED (ticket 03) — consumed by Task 3
│   ├── protocol.ts             # TypeBox schemas + WebFrame/ClientFrame/DispatchAction + toWebFrame/validateInbound (pure)
│   ├── web-transport.ts        # WebTransport deep module — parseCommand (dispatch descriptor) + mapEvent (delegates toWebFrame)
│   ├── broadcaster.ts          # Broadcaster port interface + MemoryBroadcaster test sink
│   ├── web-server.ts           # WebServer adapter (Bun.serve, WS client-set, originAllowed, serveWithFallback, .unref(), singleton lifecycle); implements Broadcaster
│   └── notifier.ts             # makeMutexNotifier(broadcaster) — MutexNotifier impl → mutex_blocked / mutex_force_release frames
├── extensions/
│   └── webui.ts                # factory: construct WebServer + MutexController(makeMutexNotifier); register every pi.on handler; wire inbound WS→parseCommand→dispatch
└── tests/
    ├── helpers/
    │   └── fake-clock.ts       # unchanged (ticket 03)
    ├── mutex.test.ts           # unchanged (ticket 03)
    ├── mutex-controller.test.ts# unchanged (ticket 03)
    ├── protocol.test.ts        # schema validate/parse + toWebFrame per event type (.details forwarded)
    ├── web-transport.test.ts   # parseCommand dispatch matrix + mapEvent delegation + purity
    ├── broadcaster.test.ts     # MemoryBroadcaster sink
    ├── web-server.test.ts      # origin guard, singleton lifecycle, .unref(), real-WS integration
    └── webui-wiring.test.ts    # notifier routing, no-session-bound guard, end-to-end smoke (mutex + dispatch)
```

**Responsibilities:** `protocol.ts` = schemas + pure frame construction/validation (no I/O, no pi). `web-transport.ts` = dispatch decision + outbound method (pure; uses `protocol.ts`). `broadcaster.ts` = the port + a test adapter. `web-server.ts` = the only `Bun.serve` site; owns transport + singleton lifecycle; accepts an injected `onCommand` handler so it never imports `web-transport`. `notifier.ts` = turns `MutexController` callbacks into outbound frames through the broadcaster. `extensions/webui.ts` = the factory that owns construction + every `pi.on` registration + inbound dispatch resolution.

---

### Task 0: Schema layer (`protocol.ts`) + TypeBox wiring

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/package.json` (add `"typebox"` devDependency)
- Create: `bun-apps/pi-agent-ext-webui/src/protocol.ts`
- Create: `bun-apps/pi-agent-ext-webui/tests/protocol.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 1 & 3): `type WebFrame` (the outbound union, `specs/04 §4`); `type ClientFrame` (the inbound command union); `type DispatchAction` (agentic | appexec | control); `interface EventLike` (the structural, type-only mirror of the reachable `ExtensionEvent` set — erases the runtime pi import); `function validateInbound(raw: unknown): ClientFrame | null`; `function toWebFrame(event: EventLike): WebFrame`.

- [ ] **Step 1: Add TypeBox devDependency + install**

Edit `package.json` `devDependencies`:
```json
"devDependencies": {
  "@types/bun": "^1.3.14",
  "typebox": "^1.3.7",
  "typescript": "^7.0.2"
}
```
> Rationale (spec §4): TypeBox is the ecosystem standard — `typebox@^1.3.7` is declared in `pi-agent-cli/package.json` and kept **external** in thin bundles (`pi-agent/scripts/lib/build-extensions.ts` `EXTERNAL[]` lists `"typebox"`), so at runtime inside pi-agent the import resolves from the host. webui declares it as a devDependency so its **own** `tsc` + `bun test` can resolve it. Import specifier is `"typebox"` (the v1.x package name — NOT the legacy `@sinclair/typebox`).

Run: `( cd bun-apps && bun install )` — expected: `typebox` links into the workspace; `bun-apps/pi-agent-ext-webui/node_modules/typebox` resolves.

- [ ] **Step 2: Write the failing tests `tests/protocol.test.ts`**

```typescript
import { describe, expect, it } from "bun:test";
import {
  toWebFrame,
  validateInbound,
  type EventLike,
} from "../src/protocol.js";

describe("validateInbound (schema parse/validate)", () => {
  it("accepts each valid agentic command", () => {
    expect(validateInbound({ type: "prompt", text: "hi" })).toEqual({ type: "prompt", text: "hi" });
    expect(validateInbound({ type: "steer", text: "x" })?.type).toBe("steer");
    expect(validateInbound({ type: "followUp", text: "y" })?.type).toBe("followUp");
  });
  it("accepts abort / appexec / subscribe / unsubscribe", () => {
    expect(validateInbound({ type: "abort" })?.type).toBe("abort");
    expect(validateInbound({ type: "appexec" })?.type).toBe("appexec");
    expect(validateInbound({ type: "subscribe" })?.type).toBe("subscribe");
    expect(validateInbound({ type: "unsubscribe" })?.type).toBe("unsubscribe");
  });
  it("rejects malformed: unknown type", () => {
    expect(validateInbound({ type: "nonsense" })).toBeNull();
  });
  it("rejects malformed: prompt without text", () => {
    expect(validateInbound({ type: "prompt" })).toBeNull();
    expect(validateInbound({ type: "prompt", text: 42 })).toBeNull();
  });
  it("rejects non-objects / wrong discriminator", () => {
    expect(validateInbound(null)).toBeNull();
    expect(validateInbound("prompt")).toBeNull();
    expect(validateInbound({})).toBeNull();
  });
});

describe("toWebFrame (event -> outbound, .details forwarded intact)", () => {
  const cases: Array<[string, EventLike]> = [
    ["message_start", { type: "message_start" }],
    ["message_update", { type: "message_update" }],
    ["message_end", { type: "message_end" }],
    ["turn_start", { type: "turn_start" }],
    ["turn_end", { type: "turn_end" }],
    ["agent_settled", { type: "agent_settled" }],
    ["session_compact", { type: "session_compact" }],
    ["session_before_compact", { type: "session_before_compact" }],
  ];
  for (const [label, ev] of cases) {
    it(`forwards ${label} with type intact`, () => {
      expect(toWebFrame(ev).type).toBe(label);
    });
  }
  it("forwards tool_execution_* with toolName + details", () => {
    const f = toWebFrame({ type: "tool_execution_start", toolName: "bash", details: { cmd: "ls" } });
    expect(f.type).toBe("tool_execution_start");
    expect((f as any).toolName).toBe("bash");
    expect((f as any).details).toEqual({ cmd: "ls" });
  });
  it("forwards tool_result .details verbatim (no field drop)", () => {
    const details = { diff: "x", patch: "y", extra: { nested: [1, 2] } };
    const f = toWebFrame({ type: "tool_result", details });
    expect((f as any).details).toEqual(details);
  });
  it("maps an unknown-but-reachable event shape to a generic frame (forward-compat, no throw)", () => {
    expect(() => toWebFrame({ type: "future_event", details: { a: 1 } })).not.toThrow();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/protocol.test.ts )`
Expected: FAIL — `Cannot find module "../src/protocol.js"`.

- [ ] **Step 4: Implement `src/protocol.ts`**

```typescript
/**
 * protocol.ts — the schema layer for the web wire protocol (specs/04 §4).
 * TypeBox schemas + a pure frame builder. No I/O, no Bun, no runtime pi
 * dependency: ExtensionEvent is mirrored here as a structural EventLike so the
 * SDK type erases at compile time (the deep module web-transport.ts builds on
 * this). Validation stance: TypeBox (ecosystem standard, zero zod in repo).
 */
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

// --- Inbound commands (client -> server), specs/04 §4 ---

const AgenticWithText = Type.Union([
  Type.Object({ type: Type.Literal("prompt"),   text: Type.String() }),
  Type.Object({ type: Type.Literal("steer"),    text: Type.String() }),
  Type.Object({ type: Type.Literal("followUp"), text: Type.String() }),
]);
const AbortCmd   = Type.Object({ type: Type.Literal("abort") });
const AppExecCmd = Type.Object({ type: Type.Literal("appexec") /* bypass; v1 = forward seam, no defined ops (spec §3) */, extra: Type.Optional(Type.Record(Type.String(), Type.Unknown())) });
const ControlCmd = Type.Union([
  Type.Object({ type: Type.Literal("subscribe") }),
  Type.Object({ type: Type.Literal("unsubscribe") }),
]);

export const InboundCommandSchema = Type.Union([AgenticWithText, AbortCmd, AppExecCmd, ControlCmd]);
export type ClientFrame = Static<typeof InboundCommandSchema>;

// --- Outbound frames (server -> client), specs/04 §4 ---

/** Structural mirror of the reachable ExtensionEvent set (ticket 01). Type-only:
 *  the SDK ExtensionEvent union is never imported at runtime — this shape is what
 *  toWebFrame actually inspects, so the module stays I/O- and pi-free. */
export interface EventLike {
  type: string;
  toolName?: string;
  details?: unknown;
  [k: string]: unknown;
}

export type WebFrame =
  | { type: "message_start" | "message_update" | "message_end" }
  | { type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end"; toolName: string; details?: unknown }
  | { type: "tool_result"; details?: unknown }
  | { type: "turn_start" | "turn_end" }
  | { type: "agent_settled" }
  | { type: "session_before_compact" | "session_compact" }
  | { type: "mutex_blocked"; blocked: "web" | "tui"; by: "tui" | "web" }
  | { type: "mutex_force_release"; driver: "web" | "tui" }
  // forward-compat: any other host event is forwarded generically
  | { type: string; details?: unknown; [k: string]: unknown };

// --- DispatchAction (the descriptor parseCommand returns), specs/04 §3 ---

export type DispatchAction =
  | { kind: "agentic"; op: "prompt" | "steer" | "followUp" | "abort"; text?: string; source: "extension" }
  | { kind: "appexec"; op: string; [k: string]: unknown }
  | { kind: "control"; op: "subscribe" | "unsubscribe" };

// --- Pure helpers ---

/** Schema-validate a parsed JSON object into a typed ClientFrame, or null. */
export function validateInbound(raw: unknown): ClientFrame | null {
  if (typeof raw !== "object" || raw === null) return null;
  return Value.Check(InboundCommandSchema, raw) ? (raw as ClientFrame) : null;
}

const STREAM_TYPES = new Set([
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
  "tool_result",
  "turn_start", "turn_end",
  "agent_settled",
  "session_before_compact", "session_compact",
]);

/** Structural event -> outbound frame, forwarding .details / toolName intact. */
export function toWebFrame(event: EventLike): WebFrame {
  if (event.type.startsWith("tool_execution_")) {
    return { type: event.type, toolName: typeof event.toolName === "string" ? event.toolName : "", ...(event.details !== undefined ? { details: event.details } : {}) };
  }
  if (event.type === "tool_result") {
    return event.details !== undefined ? { type: "tool_result", details: event.details } : { type: "tool_result" };
  }
  if (STREAM_TYPES.has(event.type)) return { type: event.type } as WebFrame;
  // Forward-compat: unknown event -> generic frame, never throw (spec §6 malformed handling).
  const out: WebFrame = { type: event.type };
  if (event.details !== undefined) (out as any).details = event.details;
  return out;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/protocol.test.ts )`
Expected: PASS — all tests green.

- [ ] **Step 6: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run build )`
Expected: `bunx tsc` exits 0, emits `dist/protocol.{js,d.ts}`, no errors.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/package.json bun-apps/pi-agent-ext-webui/src/protocol.ts bun-apps/pi-agent-ext-webui/tests/protocol.test.ts
git commit -m "feat(webui): protocol schema layer (TypeBox) - frames + toWebFrame (ticket 04)"
```
> If `bun.lock` changes, include it in the same commit.

---

### Task 1: `WebTransport` deep module (pure) + tests

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/web-transport.ts`
- Create: `bun-apps/pi-agent-ext-webui/tests/web-transport.test.ts`

**Interfaces:**
- Consumes: from `./protocol.js` — `ClientFrame`, `WebFrame`, `DispatchAction`, `EventLike`, `toWebFrame`.
- Produces (consumed by Task 3): `class WebTransport` with `parseCommand(frame: ClientFrame): DispatchAction` and `mapEvent(event: EventLike): WebFrame`.

- [ ] **Step 1: Write the failing tests `tests/web-transport.test.ts`**

```typescript
import { describe, expect, it } from "bun:test";
import { WebTransport } from "../src/web-transport.js";
import type { EventLike } from "../src/protocol.js";

const t = new WebTransport();

describe("WebTransport.parseCommand — dispatch matrix", () => {
  it("prompt -> agentic descriptor (source extension, no pi call)", () => {
    expect(t.parseCommand({ type: "prompt", text: "hi" })).toEqual({ kind: "agentic", op: "prompt", text: "hi", source: "extension" });
  });
  it("steer / followUp -> agentic with op preserved", () => {
    expect(t.parseCommand({ type: "steer", text: "x" }).op).toBe("steer");
    expect(t.parseCommand({ type: "followUp", text: "y" }).op).toBe("followUp");
  });
  it("abort -> agentic descriptor, no text", () => {
    expect(t.parseCommand({ type: "abort" })).toEqual({ kind: "agentic", op: "abort", source: "extension" });
  });
  it("appexec -> bypass descriptor (NOT agentic; no source field)", () => {
    const d = t.parseCommand({ type: "appexec" });
    expect(d.kind).toBe("appexec");
    expect((d as any).source).toBeUndefined();
  });
  it("subscribe / unsubscribe -> control descriptor", () => {
    expect(t.parseCommand({ type: "subscribe" })).toEqual({ kind: "control", op: "subscribe" });
    expect(t.parseCommand({ type: "unsubscribe" })).toEqual({ kind: "control", op: "unsubscribe" });
  });
});

describe("WebTransport.mapEvent — delegates toWebFrame, .details preserved", () => {
  const events: EventLike[] = [
    { type: "message_start" }, { type: "message_update" }, { type: "message_end" },
    { type: "tool_execution_start", toolName: "edit", details: { diff: "d" } },
    { type: "tool_execution_end", toolName: "bash", details: { exitCode: 0 } },
    { type: "tool_result", details: { patch: "p" } },
    { type: "turn_start" }, { type: "turn_end" }, { type: "agent_settled" },
    { type: "session_compact" }, { type: "session_before_compact" },
  ];
  for (const ev of events) {
    it(`maps ${ev.type} preserving type + details`, () => {
      const f = t.mapEvent(ev);
      expect(f.type).toBe(ev.type);
      if (ev.details !== undefined) expect((f as any).details).toEqual(ev.details);
    });
  }
});

describe("WebTransport purity", () => {
  it("parseCommand is deterministic (same input -> same output)", () => {
    const a = t.parseCommand({ type: "prompt", text: "z" });
    const b = t.parseCommand({ type: "prompt", text: "z" });
    expect(a).toEqual(b);
  });
  it("mapEvent does not mutate the input event", () => {
    const ev: EventLike = { type: "tool_result", details: { a: 1 } };
    const snapshot = JSON.parse(JSON.stringify(ev));
    t.mapEvent(ev);
    expect(ev).toEqual(snapshot);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/web-transport.test.ts )`
Expected: FAIL — `Cannot find module "../src/web-transport.js"`.

- [ ] **Step 3: Implement `src/web-transport.ts`**

```typescript
/**
 * WebTransport — the pure deep module for the web wire protocol (specs/04 §3).
 * Owns the inbound dispatch DECISION (parseCommand -> DispatchAction descriptor;
 * agentic vs appexec-bypass vs control) and the outbound event->frame MAPPING
 * (mapEvent, delegating to protocol.toWebFrame). It returns DESCRIPTORS only — it
 * does NOT call pi, does NOT touch MutexController, performs NO I/O. The extension
 * entry (extensions/webui.ts) resolves a descriptor into the real
 * pi.sendUserMessage / ctx.abort call AFTER the mutex gate. This is what makes the
 * whole protocol testable without a live session.
 *
 * op -> pi-call resolution table (spec §3), executed in Task 3, not here:
 *   prompt   -> pi.sendUserMessage(text)
 *   steer    -> pi.sendUserMessage(text, { deliverAs: "steer" })
 *   followUp -> pi.sendUserMessage(text, { deliverAs: "followUp" })
 *   abort    -> ctx.abort()
 */
import { toWebFrame, type ClientFrame, type DispatchAction, type EventLike, type WebFrame } from "./protocol.js";

export class WebTransport {
  /** Inbound: classify a validated ClientFrame into a DispatchAction descriptor. */
  parseCommand(frame: ClientFrame): DispatchAction {
    switch (frame.type) {
      case "prompt":
      case "steer":
      case "followUp":
        return { kind: "agentic", op: frame.type, text: frame.text, source: "extension" };
      case "abort":
        return { kind: "agentic", op: "abort", source: "extension" };
      case "subscribe":
      case "unsubscribe":
        return { kind: "control", op: frame.type };
      case "appexec":
      default:
        // appexec bypasses the mutex entirely (spec §3, §6). v1 has NO defined
        // appexec ops — this is a forward seam; the descriptor carries `op`.
        return { kind: "appexec", op: frame.type };
    }
  }

  /** Outbound: map a host event to a WebFrame (.details forwarded intact). */
  mapEvent(event: EventLike): WebFrame {
    return toWebFrame(event);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/web-transport.test.ts )`
Expected: PASS — all tests green.

- [ ] **Step 5: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run build )`
Expected: `bunx tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/web-transport.ts bun-apps/pi-agent-ext-webui/tests/web-transport.test.ts
git commit -m "feat(webui): WebTransport deep module - parseCommand + mapEvent (ticket 04)"
```

---

### Task 2: `Broadcaster` port + `WebServer` adapter (the volatile transport)

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/broadcaster.ts`
- Create: `bun-apps/pi-agent-ext-webui/src/web-server.ts`
- Create: `bun-apps/pi-agent-ext-webui/tests/broadcaster.test.ts`
- Create: `bun-apps/pi-agent-ext-webui/tests/web-server.test.ts`

**Interfaces:**
- Produces (consumed by Task 3): `interface Broadcaster { broadcast(frame: WebFrame): void }` (port); `class MemoryBroadcaster implements Broadcaster` (test sink); `class WebServer implements Broadcaster` with: `start(): void` (idempotent), `bindSession(pi, ctx): void` (re-point), `dropSession(): void` (null ref, server stays), `broadcast(frame: WebFrame): void`, `setCommandHandler(cb: ((frame: ClientFrame, reply: (f: WebFrame) => void) => void) | null): void`, `get url(): string`, `stop(): void` (test-only teardown).
- `WebServer` does NOT import `web-transport` — inbound commands are handed to an injected `onCommand` callback (set by Task 3). This keeps the adapter volatile and the protocol logic out of the transport.

**Lift map (verified against `origin/main`):**
- `Bun.serve` fetch (`/health` + stub connect-test page + `/ws` upgrade) + `websocket` handlers ← `gui-movie-director/server.ts` (`serverConfig`) + `api/ws.ts` (`wsHandlers`).
- `connectedClients: Set<ServerWebSocket>` + `broadcast` fan-out ← `gui-movie-director/api/ws.ts` (`connectedClients`, `broadcastMessage`).
- `originAllowed(origin, host)` ← `gui-movie-director/lib/origin.ts` (shared on HTTP fetch + WS upgrade; absent Origin allowed; non-loopback denied).
- `serveWithFallback(cfg)` ← `gui-movie-director/server.ts:65` — **copied inline** (it is not a lib export); walks `port..port+50` on `EADDRINUSE`, throws "exhausted port range".
- **`.unref()`** — webui ADDS this (gui-movie-director does not, it is a foreground dev server). webui is embedded in the agent process; the server must not keep the process alive on its own.

- [ ] **Step 1: Write the failing tests `tests/broadcaster.test.ts`**

```typescript
import { describe, expect, it } from "bun:test";
import { MemoryBroadcaster } from "../src/broadcaster.js";
import type { WebFrame } from "../src/protocol.js";

describe("MemoryBroadcaster", () => {
  it("captures broadcast frames in order", () => {
    const b = new MemoryBroadcaster();
    b.broadcast({ type: "turn_start" });
    b.broadcast({ type: "agent_settled" });
    expect(b.frames.map((f) => f.type)).toEqual(["turn_start", "agent_settled"]);
  });
  it("mutex frames are captured with payload", () => {
    const b = new MemoryBroadcaster();
    const frame: WebFrame = { type: "mutex_blocked", blocked: "web", by: "tui" };
    b.broadcast(frame);
    expect(b.frames[0]).toEqual(frame);
  });
});
```

- [ ] **Step 2: Implement `src/broadcaster.ts`**

```typescript
/**
 * Broadcaster — the injected port around the volatile transport (specs/04 §3).
 * A stable one-method interface; the real Path-B swap point. Two adapters:
 *  - WebServer  (prod, WS client-set fan-out — src/web-server.ts)
 *  - MemoryBroadcaster (test sink — this file)
 */
import type { WebFrame } from "./protocol.js";

export interface Broadcaster {
  /** Fire-and-forget fan-out of one outbound frame to all web clients. */
  broadcast(frame: WebFrame): void;
}

/** In-memory sink for unit tests; captures frames for assertions. */
export class MemoryBroadcaster implements Broadcaster {
  readonly frames: WebFrame[] = [];
  broadcast(frame: WebFrame): void {
    this.frames.push(frame);
  }
}
```

- [ ] **Step 3: Write the failing tests `tests/web-server.test.ts`**

```typescript
import { describe, expect, it } from "bun:test";
import { WebServer } from "../src/web-server.js";

describe("WebServer origin guard", () => {
  it("HTTP: non-loopback Origin -> 403", async () => {
    const s = new WebServer({ port: 0 });
    s.start();
    try {
      const url = s.url;
      const res = await fetch(`${url}/health`, { headers: { Origin: "http://evil.com" } });
      expect(res.status).toBe(403);
    } finally { s.stop(); }
  });
  it("HTTP: absent Origin -> allowed", async () => {
    const s = new WebServer({ port: 0 });
    s.start();
    try {
      const res = await fetch(`${s.url}/health`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    } finally { s.stop(); }
  });
});

describe("WebServer singleton lifecycle", () => {
  it("start is idempotent (second start is a no-op, same url)", () => {
    const s = new WebServer({ port: 0 });
    s.start();
    const url1 = s.url;
    s.start();
    expect(s.url).toBe(url1);
    s.stop();
  });
  it("bindSession / dropSession swap the live session ref without restarting", () => {
    const s = new WebServer({ port: 0 });
    s.start();
    const url1 = s.url;
    const fakePi: any = { _tag: "a" };
    const fakeCtx: any = { _tag: "a" };
    s.bindSession(fakePi, fakeCtx);
    s.bindSession({ _tag: "b" } as any, { _tag: "b" } as any); // re-point
    s.dropSession(); // server stays
    expect(s.url).toBe(url1);
    s.stop();
  });
  it("unrefs the server so it does not keep the process alive", () => {
    const s = new WebServer({ port: 0 });
    s.start();
    expect(s.unrefed).toBe(true);
    s.stop();
  });
});

describe("WebServer broadcast over a real WS", () => {
  it("delivers a broadcast frame to a connected client", async () => {
    const s = new WebServer({ port: 0 });
    s.start();
    try {
      const ws = new WebSocket(`${s.url.replace("http", "ws")}/ws`);
      const received = new Promise<any>((resolve) => {
        ws.onmessage = (ev) => resolve(JSON.parse(String(ev.data)));
      });
      await new Promise<void>((r) => { ws.onopen = () => r(); });
      s.broadcast({ type: "turn_start" });
      const frame = await received;
      expect(frame.type).toBe("turn_start");
      ws.close();
    } finally { s.stop(); }
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/broadcaster.test.ts tests/web-server.test.ts )`
Expected: FAIL — `Cannot find module "../src/web-server.js"`.

- [ ] **Step 5: Implement `src/web-server.ts`**

```typescript
/**
 * WebServer — the volatile transport adapter and the ONLY Bun.serve touch-point
 * (specs/04 §3, §2). Implements Broadcaster over a WS client-set (lifted from
 * gui-movie-director/api/ws.ts). Owns: HTTP fetch (/health + stub connect-test
 * page + /ws upgrade), websocket handlers, the shared originAllowed guard
 * (gui-movie-director/lib/origin.ts), an inline copy of serveWithFallback
 * (gui-movie-director/server.ts — NOT a lib export), .unref() (webui is embedded;
 * gui-movie-director does NOT unref), and the module-level singleton lifecycle
 * (lazy start, re-point pi/ctx per session_start, drop ref on session_shutdown —
 * server survives; persistent co-frontend, NOT closeAll).
 *
 * Deliberately does NOT import web-transport: inbound commands are handed to an
 * injected onCommand callback (set by extensions/webui.ts) so the adapter stays
 * volatile and protocol-free.
 */
import type { Server, ServerWebSocket } from "bun";
import type { Broadcaster } from "./broadcaster.js";
import type { ClientFrame, WebFrame } from "./protocol.js";
import { validateInbound } from "./protocol.js";

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
function originAllowed(origin: string | null, host: string | null): boolean {
  if (!origin) return true;
  if (!host) return false;
  const portMatch = host.match(/:(\d+)$/);
  const port = portMatch ? portMatch[1] : "";
  return LOOPBACK_HOSTS.some((h) => origin === `http://${h}:${port}`);
}

/** Minimal session-ref shape WebServer holds (re-pointed per session_start). */
export interface SessionRef {
  pi: { sendUserMessage(content: string | unknown[], opts?: { deliverAs?: "steer" | "followUp" }): unknown; abort?: () => void; [k: string]: unknown };
  ctx: { abort(): void; [k: string]: unknown };
}

const STUB_PAGE = `<!doctype html><meta charset=utf-8><title>webui connect-test</title>
<body><pre id=log></pre><script>
const log=document.getElementById('log');
function out(m){log.textContent+=m+'\\n';}
const ws=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/ws');
ws.onopen=()=>out('[open] '+new Date().toISOString());
ws.onmessage=e=>out('[frame] '+e.data);
ws.onclose=()=>out('[close]');
ws.onerror=()=>out('[error]');
</script></body>`;

export interface WebServerOptions { port?: number; hostname?: string; }

export class WebServer implements Broadcaster {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly clients = new Set<ServerWebSocket<unknown>>();
  private session: SessionRef | null = null;
  private onCommand: ((frame: ClientFrame, reply: (f: WebFrame) => void) => void) | null = null;
  private readonly port: number;
  private readonly hostname: string;
  unrefed = false;

  constructor(opts: WebServerOptions = {}) {
    this.port = opts.port ?? 0;
    this.hostname = opts.hostname ?? "127.0.0.1";
  }

  /** Idempotent lazy start. */
  start(): void {
    if (this.server) return;
    this.server = this.serveWithFallback({
      hostname: this.hostname,
      port: this.port,
      fetch: (req, srv) => this.fetch(req, srv),
      websocket: {
        open: (_ws) => this.clients.add(_ws as ServerWebSocket<unknown>),
        message: (_ws, msg) => this.onMessage(msg),
        close: (_ws) => this.clients.delete(_ws as ServerWebSocket<unknown>),
      },
    });
    this.server.unref();
    this.unrefed = true;
  }

  /** Re-point the live session (called on each session_start). */
  bindSession(pi: SessionRef["pi"], ctx: SessionRef["ctx"]): void {
    this.session = { pi, ctx };
  }

  /** Drop the session ref (session_shutdown); the server stays up. */
  dropSession(): void { this.session = null; }

  /** Inject the inbound-command handler (extensions/webui.ts sets this). */
  setCommandHandler(cb: ((frame: ClientFrame, reply: (f: WebFrame) => void) => void) | null): void {
    this.onCommand = cb;
  }

  get url(): string {
    if (!this.server) throw new Error("WebServer not started");
    return `http://${this.hostname}:${this.server.port}`;
  }

  broadcast(frame: WebFrame): void {
    const msg = JSON.stringify(frame);
    for (const ws of this.clients) { try { ws.send(msg); } catch { /* closed */ } }
  }

  private reply(ws: ServerWebSocket<unknown> | null, f: WebFrame): void {
    if (ws) { try { ws.send(JSON.stringify(f)); } catch { /* closed */ } }
  }

  private fetch(req: Request, srv: Server): Response {
    const url = new URL(req.url);
    const origin = req.headers.get("origin");
    if (origin && !originAllowed(origin, req.headers.get("host"))) {
      return new Response("forbidden", { status: 403 });
    }
    if (url.pathname === "/health") return new Response("ok", { headers: { "Content-Type": "text/plain" } });
    if (url.pathname === "/") return new Response(STUB_PAGE, { headers: { "Content-Type": "text/html" } });
    if (url.pathname === "/ws") {
      if (origin && !originAllowed(origin, req.headers.get("host"))) return new Response("forbidden", { status: 403 });
      if (srv.upgrade(req)) return new Response("WebSocket", { status: 101 });
      return new Response("upgrade failed", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  }

  private onMessage(msg: string | Buffer): void {
    let raw: unknown;
    try { raw = JSON.parse(typeof msg === "string" ? msg : msg.toString()); } catch { return; } // malformed -> ignore (spec §6)
    const frame = validateInbound(raw);
    if (!frame) return;
    if (this.session === null) { this.broadcast({ type: "mutex_force_release", driver: "tui" }, { noSession: true } as never); return; } // placeholder — real guard is in webui.ts (Task 3); see note
    if (this.onCommand) this.onCommand(frame, (f) => this.broadcast(f));
  }

  /** Copied inline from gui-movie-director/server.ts (NOT a lib export). */
  private serveWithFallback(cfg: Parameters<typeof Bun.serve>[0]): ReturnType<typeof Bun.serve> {
    const start = (cfg.port as number) ?? 0;
    for (let p = start; p <= start + 50; p++) {
      try { return Bun.serve({ ...cfg, port: p }); }
      catch (e) {
        const m = String((e as Error)?.message ?? e);
        if (!/address|port|EADDRINUSE/i.test(m) || p === start + 50) throw e;
      }
    }
    throw new Error("serveWithFallback: exhausted port range");
  }

  /** Test-only teardown. */
  stop(): void { try { this.server?.stop(true); } catch { /* ignore */ } this.server = null; this.clients.clear(); }
}
```

> **Note (resolve in TDD):** the no-session guard's placeholder broadcast above is WRONG on purpose — it's a RED marker. The real guard belongs in `extensions/webui.ts` (Task 3): reply `{ type: "no_session" }` to the client, **never** broadcast, **never** deref a null `pi`/`ctx`. Delete the placeholder and move the guard into the `onCommand` closure in Task 3. Keep `WebServer.onMessage` strictly: validate → if `session === null` invoke a `onNoSession` hook (or just let `onCommand` see a null-session marker). The cleanest seam: `WebServer` exposes `hasSession(): boolean`; the injected `onCommand` closure (Task 3) checks `webServer`'s session and replies `no_session`. Pin the exact seam in the Task 3 RED test.

- [ ] **Step 6: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/broadcaster.test.ts tests/web-server.test.ts )`
Expected: PASS — all tests green (origin guard, lifecycle, real-WS broadcast).

- [ ] **Step 7: Full suite + typecheck**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test && bun run build )`
Expected: every test PASS; `bunx tsc` exits 0.

- [ ] **Step 8: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/broadcaster.ts bun-apps/pi-agent-ext-webui/src/web-server.ts bun-apps/pi-agent-ext-webui/tests/broadcaster.test.ts bun-apps/pi-agent-ext-webui/tests/web-server.test.ts
git commit -m "feat(webui): Broadcaster port + WebServer adapter (Bun.serve, origin guard, unref, singleton) (ticket 04)"
```

---

### Task 3: Mutex glue + extension wiring (`extensions/webui.ts` + `notifier.ts`)

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/notifier.ts`
- Create: `bun-apps/pi-agent-ext-webui/extensions/webui.ts`
- Create: `bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts`
- Modify: `bun-apps/pi-agent/run-dir/manifest.json` (register the extension — dynamic `extensions[]`)

**Interfaces:**
- Consumes: `MutexController`, `MutexNotifier` (from `./src/mutex-controller.js`); `WebTransport`; `WebServer` (→ `Broadcaster`); `validateInbound`, `DispatchAction`, `WebFrame`, `EventLike` (from `./src/protocol.js`); pi SDK `ExtensionFactory`, `ExtensionAPI`, `ExtensionContext`, `InputEventResult` (type-only).
- Produces: `function makeMutexNotifier(broadcaster: Broadcaster): MutexNotifier` (notifier.ts); the default-exported `ExtensionFactory` in `extensions/webui.ts`.

**Wiring ownership (spec §3 "Wiring ownership"):** the factory constructs the `WebServer` (→ `Broadcaster`), constructs the `MutexController` wired to `makeMutexNotifier(broadcaster)`, and registers **every** `pi.on(...)`. `WebServer` implements `Broadcaster`; `WebTransport` is pure and is *called* from the handlers. The factory uses a **module-level singleton** `WebServer` (the module is cached → survives the per-session factory re-run).

- [ ] **Step 1: Write the failing tests `tests/webui-wiring.test.ts`**

```typescript
import { describe, expect, it } from "bun:test";
import { makeMutexNotifier } from "../src/notifier.js";
import { MemoryBroadcaster } from "../src/broadcaster.js";
import { MutexController } from "../src/mutex-controller.js";
import { WebTransport } from "../src/web-transport.js";
import { validateInbound } from "../src/protocol.js";

const realClock = {
  now: () => Date.now(),
  setInterval: (h: () => void, ms: number) => { const id = globalThis.setInterval(h, ms); return { clear: () => globalThis.clearInterval(id); }; },
};

describe("makeMutexNotifier routing", () => {
  it("notifyBlocked(blocked, by) -> mutex_blocked frame (arg order)", () => {
    const b = new MemoryBroadcaster();
    const n = makeMutexNotifier(b);
    n.notifyBlocked("web", "tui");
    expect(b.frames).toEqual([{ type: "mutex_blocked", blocked: "web", by: "tui" }]);
  });
  it("notifyForceRelease(driver) -> mutex_force_release frame", () => {
    const b = new MemoryBroadcaster();
    makeMutexNotifier(b).notifyForceRelease("tui");
    expect(b.frames).toEqual([{ type: "mutex_force_release", driver: "tui" }]);
  });
  it("controller force-release routes through the notifier -> broadcaster", () => {
    const b = new MemoryBroadcaster();
    const c = new MutexController({ clock: realClock, watchdog: { staleMs: 1, intervalMs: 1 }, notifier: makeMutexNotifier(b) });
    c.handleInput("interactive");
    // wait one watchdog tick
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(b.frames.some((f) => f.type === "mutex_force_release")).toBe(true);
      resolve();
    }, 30));
  });
});

describe("inbound dispatch (parseCommand -> handleInput -> descriptor)", () => {
  const t = new WebTransport();
  it("agentic idle -> gate continue -> agentic descriptor (source extension)", () => {
    const c = new MutexController({ clock: realClock, notifier: makeMutexNotifier(new MemoryBroadcaster()) });
    const action = c.handleInput("extension"); // simulates the input-event gate for a web command
    expect(action.action).toBe("continue");
    expect(t.parseCommand(validateInbound({ type: "prompt", text: "hi" })!).kind).toBe("agentic");
  });
  it("agentic while TUI driving -> handled + mutex_blocked broadcast (NOT per-command ack)", () => {
    const b = new MemoryBroadcaster();
    const c = new MutexController({ clock: realClock, notifier: makeMutexNotifier(b) });
    c.handleInput("interactive"); // TUI is driving
    const action = c.handleInput("extension"); // web command gated
    expect(action.action).toBe("handled");
    expect(b.frames).toEqual([{ type: "mutex_blocked", blocked: "web", by: "tui" }]);
  });
  it("appexec descriptor is bypass (NOT routed through handleInput)", () => {
    const d = t.parseCommand(validateInbound({ type: "appexec" })!);
    expect(d.kind).toBe("appexec");
    // The wiring MUST NOT call handleInput for appexec (spec §6). Asserted by
    // contract: the descriptor has no `source` field, so the wiring branches on
    // kind === "agentic" before gating.
  });
});
```

> The no-session-bound guard + the full end-to-end smoke (real `WebServer` + fake `pi`/`ctx`) are integration tests that exercise the factory. Because the factory depends on the pi SDK `ExtensionAPI`/`ExtensionContext` shapes, write them against a **minimal fake** `pi`/`ctx` (recording `sendUserMessage`/`abort` + an `on(event, handler)` map) so no real pi is needed. Pin the exact fake shape in this RED step. Two smoke cases (spec §6): (a) web agentic command while idle → `sendUserMessage` called + the gate is `continue`; (b) web agentic command while a TUI turn is driving → swallowed, no `sendUserMessage`, `mutex_blocked` broadcast.

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/webui-wiring.test.ts )`
Expected: FAIL — `Cannot find module "../src/notifier.js"` (and `../extensions/webui.js` is not yet importable as a module).

- [ ] **Step 3: Implement `src/notifier.ts`**

```typescript
/**
 * notifier.ts — webui's MutexNotifier impl (specs/04 §3 "MutexNotifier
 * implementation"). Turns MutexController callbacks into outbound WS frames
 * through the injected Broadcaster. Block feedback is BROADCAST, not a
 * per-command ack (spec §4 note — supersedes ticket-03 §5's speculative ack).
 */
import type { Broadcaster } from "./broadcaster.js";
import type { MutexNotifier } from "./mutex-controller.js";

export function makeMutexNotifier(broadcaster: Broadcaster): MutexNotifier {
  return {
    notifyBlocked(blocked, by) { broadcaster.broadcast({ type: "mutex_blocked", blocked, by }); },
    notifyForceRelease(driver) { broadcaster.broadcast({ type: "mutex_force_release", driver }); },
  };
}
```

- [ ] **Step 4: Implement `extensions/webui.ts` (the factory)**

```typescript
/**
 * extensions/webui.ts — the canonical registered entry (CLAUDE.md convention:
 * extensions/<X>.ts where <X> is the folder suffix; one entry per package).
 *
 * Owns construction + EVERY pi.on registration + inbound WS->dispatch (specs/04
 * §3 "Wiring ownership"). A module-level singleton WebServer survives the
 * per-session factory re-run; each session_start re-points pi/ctx; session_shutdown
 * drops the ref (server stays). Mutex glue: MutexController wired to
 * makeMutexNotifier(broadcaster) so blocks/force-releases become mutex_* frames.
 */
import type { ExtensionFactory, ExtensionAPI, ExtensionContext, InputEventResult } from "@earendil-works/pi-coding-agent";
import { MutexController } from "../src/mutex-controller.js";
import { makeMutexNotifier } from "../src/notifier.js";
import { WebTransport } from "../src/web-transport.js";
import { WebServer } from "../src/web-server.js";
import { validateInbound } from "../src/protocol.js";

// Module-level singleton: survives per-session factory re-runs (spec §1).
let webServer: WebServer | null = null;
const transport = new WebTransport();

const factory: ExtensionFactory = (pi: ExtensionAPI, ctx: ExtensionContext) => {
  // Lazy start on first load; re-point pi/ctx every time (every session_start).
  if (!webServer) {
    webServer = new WebServer({ port: 0 });
    webServer.start();
  }
  webServer.bindSession(pi as unknown as import("../src/web-server.js").SessionRef["pi"], ctx as unknown as import("../src/web-server.js").SessionRef["ctx"]);

  const broadcaster = webServer; // WebServer implements Broadcaster
  const controller = new MutexController({
    clock: { now: () => Date.now(), setInterval: (h, ms) => { const id = globalThis.setInterval(h, ms); return { clear: () => globalThis.clearInterval(id); }; } },
    notifier: makeMutexNotifier(broadcaster),
  });

  // Inbound WS command flow: validate -> transport.parseCommand -> dispatch.
  // agentic: gate through handleInput("extension"); on continue -> op->pi-call;
  //   on handled -> swallow (controller already broadcast mutex_blocked).
  // appexec: BYPASS the controller entirely (spec §6).
  // control: subscribe/unsubscribe (v1 no-op beyond WS bookkeeping).
  webServer.setCommandHandler((frame, _reply) => {
    if (webServer === null) return;
    const action = transport.parseCommand(frame);
    if (action.kind === "appexec") {
      // forward seam — v1 has no defined appexec ops/executor (spec §3)
      return;
    }
    if (action.kind === "control") {
      return; // v1: WS client-set membership is the only state; no extra work
    }
    // agentic — route THROUGH the mutex (spec §1, §6)
    const verdict = controller.handleInput("extension");
    if (verdict.action === "handled") return; // swallowed; mutex_blocked already broadcast
    // continue -> resolve op -> pi call (spec §3 table)
    switch (action.op) {
      case "prompt": pi.sendUserMessage(action.text ?? ""); break;
      case "steer": pi.sendUserMessage(action.text ?? "", { deliverAs: "steer" }); break;
      case "followUp": pi.sendUserMessage(action.text ?? "", { deliverAs: "followUp" }); break;
      case "abort": ctx.abort(); break;
    }
  });

  // --- pi.on glue (the wiring ticket 03 deferred) ---
  // Inbound mutex gate = the `input` extension event (locked by ticket 02).
  pi.on("input", (ev): InputEventResult => {
    return controller.handleInput(ev.source).action === "handled" ? { action: "handled" } : { action: "continue" };
  });
  // Mutex lifecycle
  pi.on("agent_settled", () => controller.handleSettled());
  pi.on("message_update", () => controller.handleActivity());
  pi.on("tool_execution_update", () => controller.handleActivity());
  pi.on("session_shutdown", () => { controller.handleShutdown(); webServer?.dropSession(); });
  // Outbound stream: every host event -> mapEvent -> broadcast (spec §3)
  const fwd = (ev: unknown) => broadcaster.broadcast(transport.mapEvent(ev as { type: string; [k: string]: unknown }));
  pi.on("message_start", fwd); pi.on("message_update", fwd); pi.on("message_end", fwd);
  pi.on("tool_execution_start", fwd); pi.on("tool_execution_end", fwd);
  pi.on("tool_result", fwd);
  pi.on("turn_start", fwd); pi.on("turn_end", fwd);
  pi.on("agent_settled", fwd);
  pi.on("session_before_compact", fwd); pi.on("session_compact", fwd);
};

export default factory;
```

> **No-session-bound guard (spec §6):** the `onCommand` closure runs only when `webServer` has a bound session (the factory bound it at load). But between `session_shutdown` (dropSession) and the next `session_start`, inbound WS messages still arrive. The closure must guard: if the session ref is null, reply a `no_session` frame to the sending client and return — **never** deref null `pi`/`ctx`. Expose `webServer.hasSession()` (add in Task 2's seam) and check it first. Pin the exact frame shape (`{ type: "no_session" }`) in the RED test.

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/webui-wiring.test.ts )`
Expected: PASS — notifier routing, dispatch matrix, end-to-end smoke all green.

- [ ] **Step 6: Full suite + typecheck**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test && bun run build )`
Expected: every test PASS; `bunx tsc` exits 0. (The `@earendil-works/pi-coding-agent` type-only import in `extensions/webui.ts` must resolve — it is a workspace-wide dependency via the pi host; if `tsc` from this package cannot resolve it, add it as a devDependency mirroring how sibling extensions resolve the SDK, OR use a relative structural type. Prefer the devDependency route to keep the type-only reference honest.)

- [ ] **Step 7: Register the extension (manifest.json)**

Edit `bun-apps/pi-agent/run-dir/manifest.json` `extensions[]`, add (dynamic/jiti — matches sibling prototype extensions like `movie-director`):
```json
{
  "name": "pi-agent-ext-webui",
  "entry": "pi-agent-ext-webui/extensions/webui.ts",
  "bundleMode": "thin",
  "testGate": "cd bun-apps/pi-agent-ext-webui && bun test",
  "version": "0.1.0"
}
```
> Do NOT also add it to `bun-apps/pi-agent/src/static-extensions.ts` — double-registration is forbidden (CLAUDE.md). The schema-cost canary (`pi-agent-cli/src/commands/schema-cost.ts` `discoverExtensionEntries()`) measures it automatically once registered here. (Decision: dynamic jiti for the v1 prototype; switch to `static-extensions.ts` only if/when it must survive `--compile`.)

- [ ] **Step 8: Connect-test page E2E (manual validation)**

Start a pi session with the extension loaded; open `http://127.0.0.1:<port>/` (port is logged / discoverable). Expected: the stub page opens the WS, prints `[open]`, and streams `[frame] {...}` for agent activity; typing a `prompt` in the devtools console (`ws.send(JSON.stringify({type:'prompt',text:'hi'}))`) injects a turn. This validates the protocol end-to-end (the real frontend is ticket 06).

- [ ] **Step 9: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/notifier.ts bun-apps/pi-agent-ext-webui/extensions/webui.ts bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts bun-apps/pi-agent/run-dir/manifest.json
git commit -m "feat(webui): mutex glue + extension factory + register in manifest (ticket 04)"
```

---

## TDD Discipline (whole-branch)

- **Per task:** RED (failing test, named) → run → see fail → GREEN (implement) → run → see pass → `bun run build` (typecheck) → commit. Review between tasks (diff vs the prior task's commit): does it match the brief? are seams clean? any I/O leaking into a "pure" module?
- **Final whole-branch review (before merge):**
  1. Spec-coverage walk against `specs/04-web-transport-protocol.md` (see Self-Review below).
  2. Placeholder scan — no `TODO`/`FIXME`/placeholder broadcast left in `WebServer.onMessage`.
  3. Purity audit — `protocol.ts` and `web-transport.ts` have zero `Bun`/`pi` runtime imports (only type-only). `grep -n "from \"bun\"\|from \"@earendil" src/protocol.ts src/web-transport.ts` must return nothing.
  4. `typebox` import specifier is `"typebox"` everywhere (not `@sinclair/typebox`).
  5. The mutex modules (`mutex.ts`, `mutex-controller.ts`) are byte-identical to the ticket-03 merge.
  6. `( cd bun-apps/pi-agent-ext-webui && bun test && bun run build )` green; `mlx_native.py` untouched.

## Risks / Unknowns

- **TypeBox availability:** `typebox@^1.3.7` is declared in `pi-agent-cli` and kept **external** in thin bundles (host-provided at runtime). webui declares it as a devDependency for its own build/test. Risk: if the isolated linker does not hoist it into `pi-agent-ext-webui/node_modules`, `bun install` from `bun-apps/` must surface it. Verify resolve in Task 0 Step 1. If it cannot resolve, fall back to hand-rolled type guards (the schemas are simple unions) — but prefer TypeBox to match the ecosystem (spec §4).
- **Exact `.details` field shapes per event** (spec §8 open question): pinned in TDD — `toWebFrame` forwards `.details` **verbatim** (no field drop), so the per-event shape is whatever pi emits; tests assert preservation, not a fixed schema. Ticket 05/06 consume these shapes.
- **`Bun.serve().unref()` on the agent process:** webui is embedded in the agent process, so the server MUST unref (unlike gui-movie-director, a foreground dev server). The Task 2 lifecycle test asserts `unrefed === true`. Open: confirm the agent process still exits cleanly with the unref'd server when no session is active (manual check in Task 3 Step 8).
- **Two web tabs share the single `web` slot** (spec §9 known v1 simplification): all web tabs are the `"web"` frontend; the mutex is tui-vs-web, not web-vs-web. Not a bug — document in the connect-test page.
- **Factory-runs-per-session vs module singleton:** the module-level `webServer` guard (`if (!webServer)`) prevents duplicate `Bun.serve` starts across factory re-runs. Verify no second port binds on a second `session_start` (Task 3 smoke).
- **`WebServer` ↔ `web-transport` seam:** `WebServer` must NOT import `web-transport` (keep the adapter volatile). The `onCommand` callback is the only inbound seam; the no-session guard must live in the closure (Task 3), not in `WebServer.onMessage`'s placeholder.
- **`session_shutdown` is NOT `closeAll()`:** the server survives; only the session ref is dropped. The Task 2 lifecycle test asserts the url is unchanged across bind/drop.
- **`ExtensionEvent` type-only reference:** `protocol.ts`/`web-transport.ts` must reference the SDK union **type-only** (structural `EventLike`) so no runtime pi import sneaks in. The purity audit catches this.

## Non-Goals (deferred — spec §9)

- **Approval dialogs** (`select` / `confirm` / `input`) — later ticket. v1 = drive / observe / abort only.
- **Token / bearer auth** (`randomUUID`) — ticket 07. v1 = origin-loopback only.
- **Real frontend / renderers** — tickets 05 / 06. v1 = `/health` + stub connect-test page.
- **Path-B** (CBOR `pi-server`) migration — the seam is shaped (`Broadcaster` port, `WebTransport` purity) but not implemented.
- **`queue_update` deltas** — need a pi patch; not in the `ExtensionEvent` union.
- **Per-tab web driver slots** — v1: all web tabs share one `web` driver.
- **Reconnect replay buffer** — v1: no missed-frame recovery (broadcast is fire-and-forget).
- **Concrete `appexec` ops/executor** — v1 defines the bypass seam only; no ops yet.

## Verification

- **Typecheck green:** `( cd bun-apps/pi-agent-ext-webui && bun run build )` → `bunx tsc` exits 0.
- **All tests green:** `( cd bun-apps/pi-agent-ext-webui && bun test )` — protocol, web-transport, broadcaster, web-server (incl. real-WS integration), webui-wiring, plus the unchanged ticket-03 mutex tests.
- **E2E (manual):** the connect-test page (`/`) opens the WS, prints frames; a `prompt` over the WS injects a turn — validates the protocol end-to-end (Task 3 Step 8).
- **Purity:** `grep` audit confirms `protocol.ts` + `web-transport.ts` have no runtime `Bun`/`pi` imports.
- **No regressions:** `mutex.ts` / `mutex-controller.ts` unchanged; `python/embed-bench/backends/mlx_native.py` untouched.

---

## Self-Review

**1. Spec coverage** (against `specs/04-web-transport-protocol.md`):
- §1 Goal + Path-A lock (module singleton, re-point on session_start, drop on shutdown) → Task 2 lifecycle + Task 3 factory.
- §2 Ground truth (Bun.serve, serveWithFallback inline, WS framing, originAllowed, mutex API import path) → Task 2 lifts + Task 3 imports `MutexController`.
- §3 Deep module + adapters (`WebTransport` pure / `Broadcaster` port / `WebServer` adapter / `MutexNotifier` impl / `pi.on` glue / wiring ownership) → Tasks 0–3.
- §4 Wire schema (outbound incl. `mutex_blocked`/`mutex_force_release`; inbound prompt/steer/followUp/abort/appexec/subscribe/unsubscribe; broadcast-not-ack; TypeBox) → Task 0 schema + Task 3 notifier.
- §5 v1 scope (approvals deferred; origin-only auth; minimal stub page; spec→plan→TDD) → Non-Goals + Task 2 stub page.
- §6 Failure modes (non-loopback 403/denied; malformed ignored; no-session `no_session`; web-while-TUI → handled+broadcast; appexec bypass; EADDRINUSE throw; shutdown ≠ closeAll; watchdog force-release; two tabs share slot) → Tasks 2 & 3 tests + Risks.
- §7 Test strategy (pure unit, broadcaster integration, notifier routing, origin guard, lifecycle) → every task's RED list.
- §8 Open questions (TypeBox ✓; replay buffer none; multi-tab share; `.details` pinned in TDD) → resolved above.
- §9 Out of scope → Non-Goals.
- Gap (intentional, out of this plan): real frontend (06), approval dialogs, token auth (07), Path-B.

**2. Placeholder scan:** one intentional RED placeholder in `WebServer.onMessage` (the no-session guard) — explicitly marked, deleted in Task 3 when the guard moves into the `onCommand` closure. Final review re-scans for any remaining `TODO`/placeholder.

**3. Type consistency:** `WebFrame` / `ClientFrame` / `DispatchAction` defined in Task 0 (`protocol.ts`) and consumed unchanged in Tasks 1 & 3. `Broadcaster` (Task 2) consumed by `makeMutexNotifier` (Task 3). `MutexController.handleInput` / `MutexNotifier` signatures match the ticket-03 merge exactly. `notifyBlocked(blocked, by)` arg order matches the ticket-03 controller tests and the notifier test. The `op → pi-call` table (Task 3 `onCommand` switch) matches spec §3.

---

## Execution Handoff

Plan complete and saved to `.planning/2026-08-10-pi-agent-ext-webui-from-scratch/plans/04-web-transport-protocol-plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. (REQUIRED SUB-SKILL: superpowers:subagent-driven-development.)
2. **Inline Execution** — execute the tasks in this session via executing-plans, batch with checkpoints. (REQUIRED SUB-SKILL: superpowers:executing-plans.)

Which approach?
