/**
 * ext-api-bridge tripwire — the REAL-seam regression guard for the pi 0.84.2
 * extension-tools bridge (cc-parity-2 ticket 01, PR #1865; fog item "a
 * regression tripwire is still missing").
 *
 * Why every earlier test missed the 2026-08-23 bridge death:
 * ext-api-get-all-tool-definitions.test.ts re-implements the patch logic on a
 * MOCK runner (applyPatchToMock — it never calls the real patch);
 * tool-gate's bridge-availability.test.ts fakes the `pi` object and hand-sets
 * the global. Neither touches the installed pi-coding-agent dist. Only a live
 * smoke caught that createExtensionAPI's fixed-shape delegation object hides
 * runtime-patched methods from the `pi` extensions hold.
 *
 * This test runs the whole chain against the REAL installed SDK:
 *   real patch (import-time, on the real ExtensionRunner.prototype)
 *   → real ExtensionRunner.bindCore (publishes the globalThis reader)
 *   → real loadExtensionFromFactory (builds the `pi` via the REAL
 *     createExtensionAPI — the exact shape that broke)
 *   → real pi.registerTool
 *   → readAllToolDefinitions(real pi) must surface the tool WITH execute.
 *
 * A pi upgrade that renames bindCore, re-shapes createExtensionAPI, or breaks
 * the global fallback fails here loudly instead of silently stripping spawned
 * children of every parent extension tool.
 */
import { describe, test, expect, afterAll } from "bun:test";
import {
  ExtensionRunner,
  createExtensionRuntime,
  type Extension,
  type ExtensionRuntime,
} from "@earendil-works/pi-coding-agent";
// Not re-exported from the package root (exports map: only ".", "./rpc-entry",
// "./client"), so reach the module directly. Relative node_modules paths bypass
// the exports map — intentional for a tripwire: if the dist layout moves on
// upgrade, this import failing IS the alarm.
import { loadExtensionFromFactory } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.js";
// Importing the patch module applies it to the real prototype (default on).
import "./ext-api-get-all-tool-definitions.ts";
import {
  ALL_TOOL_DEFINITIONS_GLOBAL,
  readAllToolDefinitions,
} from "@repo/s2-agent-core-interface";

const g = globalThis as unknown as Record<string, unknown>;

/** No-op stand-ins for every action bindCore copies onto the runtime. */
const noopActions = {
  sendMessage: () => {},
  sendUserMessage: () => {},
  appendEntry: () => {},
  setSessionName: () => {},
  getSessionName: () => "",
  setLabel: () => {},
  getActiveTools: () => [] as string[],
  getAllTools: () => [] as unknown[],
  setActiveTools: () => {},
  refreshTools: () => {},
  getCommands: () => [] as unknown[],
  setModel: () => {},
  getThinkingLevel: () => undefined,
  setThinkingLevel: () => {},
};
const noopContextActions = {
  getModel: () => undefined,
  getScopedModels: () => [] as unknown[],
  isIdle: () => true,
  isProjectTrusted: () => true,
  getSignal: () => undefined,
  abort: () => {},
  hasPendingMessages: () => false,
  shutdown: () => {},
  getContextUsage: () => undefined,
  compact: () => {},
  getSystemPrompt: () => "",
  getSystemPromptOptions: () => ({}),
};
const fakeEventBus = { emit: () => {}, on: () => () => {} };

describe("extension-tools bridge tripwire (real SDK seam)", () => {
  afterAll(() => {
    // Don't leak the published reader into other tests in this process.
    delete g[ALL_TOOL_DEFINITIONS_GLOBAL];
  });

  test("readAllToolDefinitions(real pi) returns the registered tool with execute", async () => {
    const runtime: ExtensionRuntime = createExtensionRuntime();

    // A real extension whose factory captures the REAL `pi` object (built by
    // the real createExtensionAPI) and registers a probe tool through it.
    let capturedPi: unknown;
    const extension: Extension = await loadExtensionFromFactory(
      async (pi) => {
        capturedPi = pi;
        pi.registerTool({
          name: "tripwire_probe",
          label: "bridge tripwire probe",
          description: "bridge tripwire probe",
          parameters: { type: "object", properties: {} },
          execute: async () => ({ status: "ok", content: [{ type: "text", text: "probe-ok" }], details: {} }),
        });
      },
      process.cwd(),
      fakeEventBus as never,
      runtime,
    );

    const runner = new ExtensionRunner(
      [extension],
      runtime,
      process.cwd(),
      undefined as never,
      undefined as never,
    );
    // Real bindCore — the patched one must publish the globalThis reader.
    runner.bindCore(noopActions as never, noopContextActions as never);

    expect(capturedPi).toBeDefined();

    // THE regression contract: whatever shape createExtensionAPI has, the
    // two-source read must surface the parent's full tool definitions.
    const defs = readAllToolDefinitions(capturedPi);
    expect(defs).toBeDefined();
    const probe = defs?.find((d) => d.name === "tripwire_probe");
    expect(probe).toBeDefined();
    expect(typeof probe?.execute).toBe("function");

    // Honesty on WHICH source served the read: on pi 0.84.2's fixed-shape api
    // the method is absent and the global serves. If a future pi restores
    // runtime spreading (api path back), the method must actually work — an
    // api method that returns [] would be a new silent-break shape.
    const viaApi = (capturedPi as { getAllToolDefinitions?: () => unknown[] })
      .getAllToolDefinitions;
    if (typeof viaApi === "function") {
      expect(viaApi.call(capturedPi).map((d) => (d as { name: string }).name)).toContain(
        "tripwire_probe",
      );
    }
  });

  test("the global reader is published at bindCore time (not merely the runtime method)", async () => {
    const runtime = createExtensionRuntime();
    const runner = new ExtensionRunner(
      [],
      runtime,
      process.cwd(),
      undefined as never,
      undefined as never,
    );
    delete g[ALL_TOOL_DEFINITIONS_GLOBAL];
    expect(typeof g[ALL_TOOL_DEFINITIONS_GLOBAL]).toBe("undefined");
    runner.bindCore(noopActions as never, noopContextActions as never);
    expect(typeof g[ALL_TOOL_DEFINITIONS_GLOBAL]).toBe("function");
    // And the published reader reflects runner state live.
    expect((g[ALL_TOOL_DEFINITIONS_GLOBAL] as () => unknown[])()).toEqual([]);
  });
});
