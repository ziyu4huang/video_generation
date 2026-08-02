import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import extension from "../../extensions/core-task.js";

/**
 * Permissive fake pi via Proxy: `on(event, h)` is captured; ANY other property
 * access returns a no-op mock — absorbs the factory's many registerTool /
 * registerCommand / getConfig / ... calls (from goal(), registerLoop,
 * registerAskUser, …) without enumerating them.
 */
function fakePi(): { pi: unknown; handlers: Record<string, ((...a: unknown[]) => unknown)[]> } {
  const handlers: Record<string, ((...a: unknown[]) => unknown)[]> = {};
  const pi = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "on")
          return (event: string, h: (...a: unknown[]) => unknown) => {
            (handlers[event] ??= []).push(h);
          };
        return mock((..._args: unknown[]) => {});
      },
    },
  );
  return { pi, handlers };
}

test("session_start with hasUI registers the launcher trigger (onTerminalInput)", async () => {
  const { pi, handlers } = fakePi();
  extension(pi as never);
  assert.ok(handlers.session_start?.length, "session_start handler registered");
  const onTerminalInput = mock((_h: unknown) => () => {});
  const ctx = {
    hasUI: true,
    ui: { onTerminalInput, setUICtx: mock(() => {}), setWidget: mock(() => {}), notify: mock(() => {}) },
    cwd: "/tmp",
    sessionManager: { getSessionId: () => "s1" },
  };
  // The factory registers multiple session_start handlers (goal's + core-task's);
  // pi fires ALL handlers for an event at runtime, so mirror that here rather
  // than hard-coding an index. Only core-task's `if (ctx.hasUI)` block calls
  // registerStatusLauncherTrigger → onTerminalInput is called exactly once.
  for (const h of handlers.session_start ?? []) await h({} as never, ctx as never);
  assert.equal(onTerminalInput.mock.calls.length, 1, "trigger's onTerminalInput was called");
});

test("session_start without UI does NOT register the trigger", async () => {
  const { pi, handlers } = fakePi();
  extension(pi as never);
  const onTerminalInput = mock((_h: unknown) => () => {});
  for (const h of handlers.session_start ?? []) await h({} as never, { hasUI: false, cwd: "/tmp", ui: { onTerminalInput } } as never);
  assert.equal(onTerminalInput.mock.calls.length, 0);
});
