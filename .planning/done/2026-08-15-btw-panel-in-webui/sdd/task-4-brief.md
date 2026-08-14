### Task 4: command-channel subscription + ctx capture in registerBtwFeature

**Files:**
- Modify: `bun-apps/pi-agent-ext-btw/src/btw/session.ts` (add `handleWebuiCommand`)
- Modify: `bun-apps/pi-agent-ext-btw/src/btw/index.ts` (capture ctx, emit initial thread event, subscribe to the command channel)
- Test: `bun-apps/pi-agent-ext-btw/__tests__/webui-command.test.ts`

**Interfaces:**
- Consumes: Task 1 (`BTW_COMMAND_CHANNEL`, `isBtwCommand`, `BtwCommand`); Task 3 (`setLatestCtx`, `emitThreadEvent`, `emitNotice`, `latestCtx`); existing engine surface (`dispatchBtwCommand(name, args, ctx)`, `runBtw(ctx, question, saveRequested=false)`, `getBtwHandoffThread(ctx)`, `summarizeThread(ctx, thread)`, `setBtwModelOverride(ctx, model)`, `setBtwThinkingOverride(ctx, level)`, `disposeBtwSession()`, `pendingMode`).
- Produces: `BtwEngine.handleWebuiCommand(command: BtwCommand): Promise<void>`; `registerBtwFeature` now (a) calls `engine.setLatestCtx(ctx)` + `engine.emitThreadEvent()` in its `session_start`/`session_tree` handlers, and (b) subscribes `pi.events.on(BTW_COMMAND_CHANNEL, ...)` dispatching into `handleWebuiCommand`. No new tools, no new commands registered (D2).

- [ ] **Step 1: Write the failing test**

```ts
// bun-apps/pi-agent-ext-btw/__tests__/webui-command.test.ts
import { describe, expect, it } from "bun:test";
import { makeFakeBusPi } from "./helpers/fake-pi";
import { registerBtwFeature } from "../src/btw";
import { BTW_COMMAND_CHANNEL } from "../src/btw/webui-events";

const fakeCtx = {
  isIdle: () => true,
  sessionManager: { getBranch: () => [] },
  modelRegistry: { find: () => undefined, getAvailable: () => [] },
} as unknown as Parameters<Parameters<typeof registerBtwFeature>[0]["on"]>[1];

const threadEvents = (emitted: { channel: string; data: unknown }[]) =>
  emitted.filter((e) => e.channel === "btw:event" && (e.data as { type?: string }).type === "thread");

describe("webui command channel", () => {
  it("ignores commands before any session_start (no ctx yet)", () => {
    const fake = makeFakeBusPi();
    registerBtwFeature(fake.pi);
    fake.pi.events?.emit(BTW_COMMAND_CHANNEL, { kind: "clear" });
    const last = fake.emitted.filter((e) => e.channel === "btw:event").at(-1)?.data as
      | { type?: string; text?: string }
      | undefined;
    expect(last?.type).toBe("notice");
    expect(String(last?.text)).toContain("no active session");
  });

  it("dispatches clear through the engine (persisted reset entry) and emits a thread event", () => {
    const fake = makeFakeBusPi();
    registerBtwFeature(fake.pi);
    fake.trigger("session_start", {}, fakeCtx);
    fake.pi.events?.emit(BTW_COMMAND_CHANNEL, { kind: "clear" });
    expect(fake.appendEntries.map((e) => e.type)).toContain("btw-thread-reset");
    expect(threadEvents(fake.emitted).length).toBeGreaterThan(0);
  });

  it("mode command switches pendingMode, disposes the session, and reports it", () => {
    const fake = makeFakeBusPi();
    registerBtwFeature(fake.pi);
    fake.trigger("session_start", {}, fakeCtx);
    fake.pi.events?.emit(BTW_COMMAND_CHANNEL, { kind: "mode", mode: "tangent" });
    const last = threadEvents(fake.emitted).at(-1)?.data as { state?: { mode?: string } };
    expect(last?.state?.mode).toBe("tangent");
  });

  it("ignores malformed payloads instead of throwing", () => {
    const fake = makeFakeBusPi();
    registerBtwFeature(fake.pi);
    fake.trigger("session_start", {}, fakeCtx);
    expect(() => fake.pi.events?.emit(BTW_COMMAND_CHANNEL, { kind: "bogus" })).not.toThrow();
    expect(() => fake.pi.events?.emit(BTW_COMMAND_CHANNEL, null)).not.toThrow();
  });

  it("emits an initial thread event at session_start (seeds the webui store)", () => {
    const fake = makeFakeBusPi();
    registerBtwFeature(fake.pi);
    fake.trigger("session_start", {}, fakeCtx);
    expect(threadEvents(fake.emitted).length).toBeGreaterThanOrEqual(1);
  });
});
```

Note: `fakeCtx`'s cast keeps the test model-free; add further no-op members only if `restoreThread`/`dispatchBtwCommand` actually dereference them (mirror `__tests__/extension-contract.test.ts`'s mock ctx if one exists).

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-btw && bun test __tests__/webui-command.test.ts )`
Expected: FAIL — no subscription on `webui:btw-command`, no initial thread event at `session_start`.

- [ ] **Step 3: Implement handleWebuiCommand on BtwEngine**

Add to `BtwEngine` in `bun-apps/pi-agent-ext-btw/src/btw/session.ts`:

```ts
/**
 * Handle a webui panel command. ask/new/clear/inject/summarize reuse the exact
 * TUI code paths (runBtw / dispatchBtwCommand); model/thinking/mode use the
 * engine setters directly. Always ends with a thread event (or a notice on error).
 */
async handleWebuiCommand(command: BtwCommand): Promise<void> {
  const ctx = this.latestCtx;
  if (!ctx) {
    this.emitNotice("btw: no active session context yet");
    return;
  }
  try {
    switch (command.kind) {
      case "ask":
        await this.runBtw(ctx, command.text, false);
        break;
      case "new":
        await this.dispatchBtwCommand("btw:new", "", ctx);
        break;
      case "clear":
        await this.dispatchBtwCommand("btw:clear", "", ctx);
        break;
      case "inject":
        await this.dispatchBtwCommand("btw:inject", "", ctx);
        this.emitNotice("Injected into the main session");
        break;
      case "summarize": {
        const { thread } = await this.getBtwHandoffThread(ctx);
        const summary = await this.summarizeThread(ctx, thread);
        this.emitNotice(summary);
        break;
      }
      case "model": {
        const model = command.model
          ? (ctx.modelRegistry.find(command.model.provider, command.model.id) ?? null)
          : null;
        await this.setBtwModelOverride(ctx, model);
        break;
      }
      case "thinking":
        await this.setBtwThinkingOverride(ctx, command.level);
        break;
      case "mode":
        // Mirror the engine's dispose-on-mode-change semantics: next ensureBtwSession
        // rebuilds in the new mode; dispose now so the panel reflects the reset.
        this.pendingMode = command.mode;
        await this.disposeBtwSession();
        break;
    }
  } catch (error) {
    this.emitNotice(`btw: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  this.emitThreadEvent();
}
```

- [ ] **Step 4: Wire the subscription + ctx capture in registerBtwFeature**

In `bun-apps/pi-agent-ext-btw/src/btw/index.ts`, inside `registerBtwFeature(pi)`:

1. Add the import: `import { BTW_COMMAND_CHANNEL, isBtwCommand } from "./webui-events";`
2. In the existing `session_start` and `session_tree` handlers (keep all surrounding code as-is; these are the added lines):

```ts
pi.on("session_start", async (_event, ctx) => {
  engine.setLatestCtx(ctx);
  // ... existing restoreThread call stays ...
  await engine.restoreThread(ctx);
  engine.emitThreadEvent();
});
// session_tree handler gets the identical three additions.
```

3. Register the command-channel subscription next to the existing `pi.on("context")` filter:

```ts
// webui panel commands (user-only surface; D2 — no new tools registered)
pi.events?.on(BTW_COMMAND_CHANNEL, (data: unknown) => {
  if (!isBtwCommand(data)) return;
  void engine.handleWebuiCommand(data);
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-btw && bun test __tests__/webui-command.test.ts )`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the full btw gate (TUI regression check)**

Run: `( cd bun-apps/pi-agent-ext-btw && bun run test )`
Expected: PASS — registration.test.ts (4), extension-contract.test.ts (3), markdown-render.test.ts (4) all green.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-btw/src/btw/session.ts bun-apps/pi-agent-ext-btw/src/btw/index.ts bun-apps/pi-agent-ext-btw/__tests__/webui-command.test.ts
git commit -m "feat(btw): subscribe to webui command channel with ctx capture"
```


## Phase 2 — webui transports

