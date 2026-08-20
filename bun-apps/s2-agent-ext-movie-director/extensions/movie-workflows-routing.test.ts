/**
 * Routing test: each /movie command handler routes through the injected
 * WorkflowManager.runSync (the crash-resumable path) instead of bare runWorkflow.
 *
 * Post-swap the handler only calls `factory(cwd, opts).runSync(...)` — so simply
 * injecting `managerFactory` is enough; NO module mock is needed. (An earlier
 * draft used `mock.module`, but Bun's mock.module is process-global and its
 * parseWorkflowScript stub leaked into movie-workflows.test.ts, breaking the
 * structural suite when run together.)
 */
import { describe, test, expect } from "bun:test";
import { registerMovieWorkflows } from "./movie-workflows.ts";

describe("movie-workflows routing (resume wiring)", () => {
  test("/produce-video handler routes through managerFactory.runSync", async () => {
    let runSyncCalls = 0;
    const fakeMgr = {
      on() { return fakeMgr; },
      setHostFns() {},
      setExtensionTools() {},
      async runSync() { runSyncCalls++; return { result: "ok" }; },
    };
    const commands: Record<string, { handler: (a: string, c: unknown) => Promise<void> }> = {};
    const pi = {
      registerCommand(name: string, def: { handler: (a: string, c: unknown) => Promise<void> }) {
        commands[name] = def;
      },
      getCommands: () => [],
      sendMessage: async () => {},
    };
    const ctx = { ui: { notify() {}, setStatus() {} } };

    registerMovieWorkflows(pi as never, process.cwd(), { managerFactory: () => fakeMgr as never });
    expect(commands["produce-video"]).toBeDefined();
    await commands["produce-video"]!.handler("concept=tides", ctx as never);

    expect(runSyncCalls).toBe(1);
  });
});
