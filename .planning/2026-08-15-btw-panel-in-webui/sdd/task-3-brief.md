### Task 3: recording fake-pi helper + engine webui bridge (emit thread events)

**Files:**
- Create: `bun-apps/pi-agent-ext-btw/__tests__/helpers/fake-pi.ts`
- Modify: `bun-apps/pi-agent-ext-btw/src/btw/session.ts` (additive fields + methods; hook into `createBtwSubSession` and `disposeBtwSession`)
- Test: `bun-apps/pi-agent-ext-btw/__tests__/webui-bridge.test.ts`

**Interfaces:**
- Consumes: Task 1 (`BTW_EVENT_CHANNEL`, `BtwEvent`, `BtwThreadState`, `BtwModelRef`), Task 2 (`snapshotsFromDetails`, `snapshotsFromMessages`, `statusFromEvent`, `BtwStatusUpdate`); existing engine surface (`BtwEngine(pi)`, public `pendingThread`, `pendingMode`, `btwModelOverride`, `btwThinkingOverride`, `activeBtwSession: BtwSessionRuntime | null`, `BtwSessionRuntime = { session; mode; subscriptions: Set<()=>void>; sideThreadStartIndex }`).
- Produces: `makeFakeBusPi(): FakePi` (test helper: `{ pi: ExtensionAPI; emitted; appendEntries; trigger(event, ...args) }`); engine methods `setLatestCtx(ctx: ExtensionCommandContext): void`, `subscribeWebuiBridge(sr: BtwSessionRuntime): void`, `emitThreadEvent(): void`, `emitNotice(text: string): void`, `buildThreadState(): BtwThreadState`, `handleWebuiCommand(command: BtwCommand): Promise<void>` (handleWebuiCommand lands in Task 4 but its emit helpers come from here).

- [ ] **Step 1: Write the failing test**

```ts
// bun-apps/pi-agent-ext-btw/__tests__/webui-bridge.test.ts
import { describe, expect, it } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { makeFakeBusPi } from "./helpers/fake-pi";
import { BtwEngine } from "../src/btw/session";

function makeFakeSession(messages: unknown[] = []) {
  let listener: ((event: unknown) => void) | null = null;
  return {
    agent: { state: { messages } },
    subscribe(cb: (event: unknown) => void) {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    push(event: unknown) {
      listener?.(event);
    },
    abort() {},
    async dispose() {},
  };
}

const MESSAGES = [
  { role: "user", parts: [{ type: "text", text: "q" }] },
  { role: "assistant", parts: [{ type: "text", text: "partial" }] },
];

describe("BtwEngine webui bridge", () => {
  it("emits thread events with pre-reduced snapshots on every sub-session event", () => {
    const { pi, emitted } = makeFakeBusPi();
    const engine = new BtwEngine(pi);
    const fake = makeFakeSession(MESSAGES);
    engine.activeBtwSession = {
      session: fake as unknown as AgentSession,
      mode: "contextual",
      subscriptions: new Set(),
      sideThreadStartIndex: 0,
    };
    engine.subscribeWebuiBridge(engine.activeBtwSession);

    fake.push({ type: "message_update" });
    let last = emitted.filter((e) => e.channel === "btw:event").at(-1)?.data;
    expect(last).toEqual({
      type: "thread",
      state: {
        messages: [
          { id: "btw-m-0", role: "user", text: "q", status: "done" },
          { id: "btw-m-1", role: "assistant", text: "partial", status: "streaming" },
        ],
        mode: "contextual",
        model: null,
        thinking: null,
      },
    });

    fake.push({ type: "tool_execution_start", toolName: "bash" });
    last = emitted.filter((e) => e.channel === "btw:event").at(-1)?.data;
    expect(last).toMatchObject({
      type: "thread",
      state: {
        messages: [
          { id: "btw-m-0", status: "done" },
          { id: "btw-m-1", status: "running-tool", statusText: "running-tool: bash" },
        ],
      },
    });

    fake.push({ type: "turn_end" });
    last = emitted.filter((e) => e.channel === "btw:event").at(-1)?.data;
    expect(last).toMatchObject({
      type: "thread",
      state: { messages: [{ id: "btw-m-1", status: "done" }] },
    });
  });

  it("falls back to pendingThread snapshots after the session is disposed", async () => {
    const { pi, emitted } = makeFakeBusPi();
    const engine = new BtwEngine(pi);
    const fake = makeFakeSession([]);
    engine.activeBtwSession = {
      session: fake as unknown as AgentSession,
      mode: "contextual",
      subscriptions: new Set(),
      sideThreadStartIndex: 0,
    };
    engine.pendingThread.push({
      question: "persisted q",
      thinking: "",
      answer: "persisted a",
      provider: "anthropic",
      model: "claude-sonnet-4",
      api: "anthropic",
      thinkingLevel: "off",
      timestamp: 1,
    });
    await engine.disposeBtwSession();
    engine.emitThreadEvent();
    expect(emitted.filter((e) => e.channel === "btw:event").at(-1)?.data).toEqual({
      type: "thread",
      state: {
        messages: [
          { id: "btw-d-0", role: "user", text: "persisted q", status: "done" },
          { id: "btw-d-1", role: "assistant", text: "persisted a", status: "done" },
        ],
        mode: "contextual",
        model: null,
        thinking: null,
      },
    });
  });

  it("emitNotice posts a notice event on the event channel", () => {
    const { pi, emitted } = makeFakeBusPi();
    const engine = new BtwEngine(pi);
    engine.emitNotice("Injected into the main session");
    expect(emitted.filter((e) => e.channel === "btw:event").at(-1)?.data).toEqual({
      type: "notice",
      text: "Injected into the main session",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-btw && bun test __tests__/webui-bridge.test.ts )`
Expected: FAIL — `makeFakeBusPi` unresolved; `subscribeWebuiBridge` / `emitThreadEvent` / `emitNotice` not defined on `BtwEngine`.

- [ ] **Step 3: Write the fake-pi helper**

```ts
// bun-apps/pi-agent-ext-btw/__tests__/helpers/fake-pi.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface FakePi {
  pi: ExtensionAPI;
  emitted: { channel: string; data: unknown }[];
  appendEntries: { type: string; payload: unknown }[];
  trigger(event: string, ...args: unknown[]): void;
}

type AnyHandler = (...args: unknown[]) => unknown;

/**
 * Recording fake ExtensionAPI for webui-seam tests: an in-memory EventBus
 * (emit fans out to on-handlers and records every emission) plus a recording
 * appendEntry and on-handler registry. Extend the stub object with any extra
 * no-op methods the code under test touches — mirror the mock style of
 * __tests__/registration.test.ts (makeRecorderPi) / extension-contract.test.ts.
 */
export function makeFakeBusPi(): FakePi {
  const emitted: FakePi["emitted"] = [];
  const appendEntries: FakePi["appendEntries"] = [];
  const handlers = new Map<string, Set<AnyHandler>>();

  const pi = {
    events: {
      emit(channel: string, data: unknown): void {
        emitted.push({ channel, data });
        handlers.get(channel)?.forEach((handler) => handler(data));
      },
      on(channel: string, handler: AnyHandler): () => void {
        const set = handlers.get(channel) ?? new Set();
        set.add(handler);
        handlers.set(channel, set);
        return () => set.delete(handler);
      },
    },
    appendEntry(type: string, payload: unknown): void {
      appendEntries.push({ type, payload });
    },
    on(event: string, handler: AnyHandler): () => void {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    registerCommand(): void {},
    registerShortcut(): void {},
    registerMessageRenderer(): void {},
    sendUserMessage(): void {},
    ui: {},
  };

  return {
    pi: pi as unknown as ExtensionAPI,
    emitted,
    appendEntries,
    trigger(event: string, ...args: unknown[]) {
      handlers.get(event)?.forEach((handler) => handler(...args));
    },
  };
}
```

- [ ] **Step 4: Implement the engine bridge (additive only)**

Add imports at the top of `bun-apps/pi-agent-ext-btw/src/btw/session.ts`:

```ts
import {
  BTW_EVENT_CHANNEL,
  type BtwCommand,
  type BtwEvent,
  type BtwThreadState,
} from "./webui-events";
import {
  snapshotsFromDetails,
  snapshotsFromMessages,
  statusFromEvent,
  type BtwStatusUpdate,
} from "./snapshot";
```

Add these fields next to the existing private state of `BtwEngine`:

```ts
/** Latest ExtensionCommandContext seen at session_start/session_tree; the webui command channel carries no ctx. */
private latestCtx: ExtensionCommandContext | null = null;
/** Status override for the last live message, derived from sub-session events. */
private webuiStatus: BtwStatusUpdate | null = null;
/** The BtwSessionRuntime currently bridged to the webui event channel. */
private webuiBridgedFor: BtwSessionRuntime | null = null;
```

Add these methods to `BtwEngine` (do NOT touch `subscribeOverlayToActiveBtwSession`, `handleBtwSessionEvent`, or anything else on the TUI path):

```ts
/** Record the ctx the webui command handler should use (set from session_start/session_tree). */
setLatestCtx(ctx: ExtensionCommandContext): void {
  this.latestCtx = ctx;
}

/**
 * Webui bridge: an ADDITIONAL session subscription (separate from the overlay's)
 * that pre-reduces each sub-session event into a thread snapshot and emits it on
 * BTW_EVENT_CHANNEL. Never touches applyTranscriptEvent / setOverlayStatus / syncUi.
 */
subscribeWebuiBridge(sr: BtwSessionRuntime): void {
  if (this.webuiBridgedFor === sr) return;
  this.webuiBridgedFor = sr;
  this.webuiStatus = null;
  const dispose = sr.session.subscribe((event: AgentSessionEvent) => {
    const update = statusFromEvent(event);
    if (update) this.webuiStatus = update;
    this.emitThreadEvent();
  });
  sr.subscriptions.add(() => {
    if (this.webuiBridgedFor === sr) this.webuiBridgedFor = null;
    dispose();
  });
}

/** Current thread state, pre-reduced for the webui panel (D5). */
buildThreadState(): BtwThreadState {
  const messages = this.activeBtwSession
    ? snapshotsFromMessages(
        this.activeBtwSession.session.agent.state.messages.slice(
          this.activeBtwSession.sideThreadStartIndex,
        ),
        this.webuiStatus,
      )
    : snapshotsFromDetails(this.pendingThread);
  return {
    messages,
    mode: this.pendingMode,
    model: this.btwModelOverride
      ? {
          provider: this.btwModelOverride.provider,
          id: this.btwModelOverride.id,
          api: this.btwModelOverride.api,
        }
      : null,
    thinking: this.btwThinkingOverride,
  };
}

/** Emit the current thread snapshot on the webui event channel. */
emitThreadEvent(): void {
  const event: BtwEvent = { type: "thread", state: this.buildThreadState() };
  this.pi.events?.emit(BTW_EVENT_CHANNEL, event);
}

/** Emit a one-line notice (inject confirmation, summarize output, errors). */
emitNotice(text: string): void {
  const event: BtwEvent = { type: "notice", text };
  this.pi.events?.emit(BTW_EVENT_CHANNEL, event);
}
```

Two small edits inside existing methods (additive lines only):

- In `createBtwSubSession(ctx)`, as the last statement before returning the runtime: `this.subscribeWebuiBridge(sr);` (adjust to the local variable name the method actually uses for the `BtwSessionRuntime` it builds).
- In `disposeBtwSession()`, add `this.webuiStatus = null;` next to wherever the active session is cleared, and after the clearing add `this.emitThreadEvent();` so the panel falls back to the persisted thread.

Note (soft spot): the `btwModelOverride` mapping reads `provider`/`id`/`api` off `SessionModel` — mirror the field access used when the override entry payload is built in `setBtwModelOverride` and adjust the three keys there if the SDK `Model` names differ.

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-btw && bun test __tests__/webui-bridge.test.ts )`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the full btw gate (TUI regression check)**

Run: `( cd bun-apps/pi-agent-ext-btw && bun run test )`
Expected: PASS — all pre-existing tests (registration, extension-contract, markdown-render) stay green.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-btw/__tests__/helpers/fake-pi.ts bun-apps/pi-agent-ext-btw/__tests__/webui-bridge.test.ts bun-apps/pi-agent-ext-btw/src/btw/session.ts
git commit -m "feat(btw): emit pre-reduced thread snapshots on the webui event channel"
```

