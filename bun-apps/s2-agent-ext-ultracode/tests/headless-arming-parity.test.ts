/**
 * Ticket 02 (B2) of `.planning/2026-08-23-headless-dispatch-hang/`: pin that a
 * HEADLESS print-mode prompt (`./s2-agent.sh -p "…"`) arms workflows mode and
 * parses budget directives exactly like an interactive submit.
 *
 * The load-bearing SDK contract (upstream 0.84.2, verified in dist):
 * print mode calls `session.prompt(initialMessage, { images })` with NO
 * `source` option (dist/modes/print-mode.js), and `AgentSession.prompt` emits
 * the extension input event with `options?.source ?? "interactive"`. The
 * `event.source === "interactive"` guard in workflow-editor.ts therefore does
 * NOT discriminate print mode — headless `-p` input events carry
 * "interactive".
 *
 * The 2026-08-23 live-smoke "measured negative" (run mt5msv81-dq40xz, cc-parity-2
 * spec §9) attributed the non-binding `+500k` to that guard; the actual cause
 * was `keywordTriggerEnabled: false` in this machine's global workflow settings
 * (`~/.pi/workflows/settings.json`) — keyword arming is off EVERYWHERE,
 * interactive runs included. This test pins the parity so an SDK upgrade that
 * changes the default source (and re-opens a real headless gap) fails here.
 *
 * Chain pinned, deterministically (faux provider, zero network):
 *   1. a real AgentSession driven by `prompt(text)` with no options — the exact
 *      print-mode call shape — delivers `source: "interactive"` to an inline
 *      extension's input handler;
 *   2. feeding that OBSERVED source into the real workflow-editor input handler
 *      transforms the message (forced-workflow turn) and sets the budget
 *      directive holder, which `consumeBudgetDirective()` (the WorkflowManager
 *      run-entry seam) returns — the value that lands on the persisted run
 *      record as `tokenBudgetSource: "directive"` via ticket-05's pinned
 *      applyBudgetDirective path (workflow-manager + run-persistence tests).
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionUIContext,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { consumeBudgetDirective, resetBudgetDirective } from "../src/budget-directive.js";

test("print-mode prompt shape (no source option) delivers source 'interactive' and arms + parses +500k", async () => {
  const home = mkdtempSync(join(tmpdir(), "headless-arming-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "headless-arming-cwd-"));
  const agentDir = join(home, "agent");
  const observedSources: Array<string | undefined> = [];

  const core = createFauxCore({
    provider: "headless-arming-parity",
    models: [{ id: "faux-model", name: "Faux", contextWindow: 128_000, maxTokens: 4096 }],
  });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
  modelRuntime.registerProvider("headless-arming-parity", {
    api: core.api as never,
    apiKey: "faux-not-used",
    streamSimple: core.streamSimple as never,
    models: core.models as never,
  });
  core.setResponses([(() => fauxAssistantMessage("B2-PARITY-OK", { stopReason: "stop" })) as never]);

  // Probe extension: records the source every input event actually carried.
  const probe = (pi: ExtensionAPI): void => {
    pi.on("input", (event: { source?: string; text?: string }) => {
      observedSources.push(event.source);
      return { action: "continue" } as const;
    });
  };

  try {
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [{ name: "headless-arming-probe", factory: probe, hidden: true }],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model: core.getModel() as never,
      modelRuntime,
      sessionManager: SessionManager.inMemory(),
      noTools: "all",
      resourceLoader,
    });

    // THE seam: the exact print-mode call shape — prompt(text) with no options
    // (upstream print-mode.js passes only { images } for the initial message).
    await session.prompt("ultracode +500k reply with exactly: B2-PARITY-OK");

    // 1. The SDK delivered the input event to the extension with source
    // "interactive" — the guard in workflow-editor.ts does not block print mode.
    assert.ok(observedSources.length >= 1, "the input event reached the extension handler");
    assert.equal(observedSources[0], "interactive", "print-mode prompt() without source defaults to 'interactive'");

    // 2. Feed the OBSERVED source into the REAL workflow-editor input handler.
    resetBudgetDirective();
    const captured: Array<{ event: string; handler: (event: unknown) => unknown }> = [];
    const pi = {
      on: (event: string, handler: (event: unknown) => unknown) => {
        captured.push({ event, handler });
      },
      getActiveTools: () => ["bash", "read"],
      setActiveTools: () => {},
    } as unknown as ExtensionAPI;
    const ui = { setEditorComponent: () => {} } as unknown as ExtensionUIContext;
    const editor = await import("../src/workflow-editor.js");
    editor.installWorkflowEditor(pi, ui, undefined, {
      settingsStore: { load: () => ({ keywordTriggerEnabled: true }), save: () => {} },
    });
    const inputHandler = captured.find((c) => c.event === "input")?.handler as
      | ((event: { source?: string; text?: string }) => { action: string; text?: string })
      | undefined;
    assert.notEqual(inputHandler, undefined, "workflow-editor input handler should be registered");

    const result = inputHandler({
      source: observedSources[0],
      text: "ultracode +500k reply with exactly: B2-PARITY-OK",
    });
    assert.equal(result.action, "transform", "the headless-observed source arms the forced-workflow turn");
    assert.ok(result.text?.length, "transform produced a forced-workflow prompt");
    // The WorkflowManager run-entry seam (read-and-clear) sees the directive.
    assert.equal(consumeBudgetDirective(), 500_000, "+500k parsed from the armed headless message");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    resetBudgetDirective();
  }
});
