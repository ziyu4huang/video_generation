import { describe, expect, mock, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "../commands.js";
import { PlanningOverlay } from "../overlay.js";
import { createRuntimeState } from "../state.js";

function fakePi() {
  const handlers = new Map<string, (args: string, ctx: ExtensionCommandContext) => unknown>();
  return {
    pi: {
      registerCommand: (name: string, opts: { handler: (args: string, ctx: ExtensionCommandContext) => unknown }) => {
        handlers.set(name, opts.handler);
      },
      sendMessage: mock(() => {}),
      sendUserMessage: mock(() => {}),
    } as unknown as ExtensionAPI,
    handlers,
  };
}

function fakeCtx(cwd = "/tmp/does-not-matter", sessionId = "s1") {
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
    ui: { setStatus: mock(() => {}), notify: mock(() => {}) },
  } as unknown as ExtensionCommandContext;
}

function getPlanHandler(handlers: Map<string, (args: string, ctx: ExtensionCommandContext) => unknown>) {
  const handler = handlers.get("plan");
  if (!handler) throw new Error("plan command was not registered");
  return handler;
}

describe("/plan dispatcher", () => {
  test("routes 'status' to the plan-status handler", async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi, createRuntimeState(), new PlanningOverlay());
    const plan = getPlanHandler(handlers);
    const ctx = fakeCtx();
    await plan("status", ctx);
    expect(ctx.ui.notify).toHaveBeenCalled(); // "No active plan" in a tmp dir with no task_plan.md
  });

  test("routes 'goal <text>' to the plan-goal handler", async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi, createRuntimeState(), new PlanningOverlay());
    const plan = getPlanHandler(handlers);
    const ctx = fakeCtx();
    await plan("goal all tests pass", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Plan goal set"), "info");
  });

  test("unknown subcommand prints usage, does not throw", async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi, createRuntimeState(), new PlanningOverlay());
    const plan = getPlanHandler(handlers);
    const ctx = fakeCtx();
    await expect(plan("bogus", ctx)).resolves.toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage"), "warning");
  });
});
