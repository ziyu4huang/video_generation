/**
 * S5 fog closure (cc-parity-2 ticket 06, map fog: "Whether
 * `sendUserMessage(followUp)` fired from the wakeup tick interleaves safely
 * with an in-flight streaming turn"): drives a REAL `createAgentSession` over
 * the pi SDK's faux transport (zero network, zero API spend), holds the first
 * turn OPEN mid-stream, and calls `sendUserMessage(..., {deliverAs:
 * "followUp"})` while it streams — pinning the exact contract the wakeup
 * loop's fire seam relies on:
 *
 *   1. the call does NOT throw while the agent is streaming,
 *   2. the message queues (session-level followUp queue, visible pre-drain),
 *   3. when the streaming turn ends, the queue drains and fires ONE new turn
 *      (the faux core consumed a second response).
 *
 * No live LLM. The faux response for turn one awaits a gate we control, so
 * "in-flight streaming turn" is real, not simulated.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

async function until(cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("sendUserMessage(followUp) during a streaming turn queues, then drains as the next turn", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "wakeup-interleave-agentdir-"));
  const cwd = mkdtempSync(join(tmpdir(), "wakeup-interleave-cwd-"));
  // Turn one stays open until we release the gate; turn two is instant.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const core = createFauxCore({
    provider: "wakeup-interleave",
    models: [{ id: "faux-model", name: "Faux", contextWindow: 128_000, maxTokens: 4096 }],
  });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
  modelRuntime.registerProvider("wakeup-interleave", {
    api: core.api as never,
    apiKey: "faux-not-used",
    streamSimple: core.streamSimple as never,
    models: core.models as never,
  });
  core.setResponses([
    (async () => {
      await gate;
      return fauxAssistantMessage("turn one done", { stopReason: "stop" });
    }) as never,
    (() => fauxAssistantMessage("turn two done", { stopReason: "stop" })) as never,
    (() => fauxAssistantMessage("unexpected third turn", { stopReason: "stop" })) as never,
  ]);

  try {
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model: core.getModel() as never,
      modelRuntime,
      sessionManager: SessionManager.inMemory(),
      noTools: "all",
    });
    const first = session.prompt("start turn one");
    await until(() => session.isStreaming, "turn one is streaming");

    // THE seam: fire a wakeup-style followUp while the turn streams.
    await session.sendUserMessage("[wakeup loop loop-1] continue the task", { deliverAs: "followUp" });
    // 1+2: it queued instead of throwing; exactly one followUp pending.
    assert.equal(session.pendingMessageCount, 1, "the followUp queued while streaming");
    assert.deepEqual(session.getFollowUpMessages(), ["[wakeup loop loop-1] continue the task"]);
    assert.ok(session.isStreaming, "the streaming turn was not disturbed");

    release();
    await first;
    // 3: the queue drained → ONE more turn ran (second faux response consumed).
    await until(() => core.state.callCount >= 2, "the followUp fired a second turn");
    await session.waitForIdle();
    assert.equal(session.pendingMessageCount, 0, "queue drained after the turn");
    assert.equal(core.state.callCount, 2, "exactly two turns — the followUp fired once, no runaway");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("sendUserMessage(followUp) against an IDLE session triggers a turn directly", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "wakeup-idle-agentdir-"));
  const cwd = mkdtempSync(join(tmpdir(), "wakeup-idle-cwd-"));
  const core = createFauxCore({
    provider: "wakeup-idle",
    models: [{ id: "faux-model", name: "Faux", contextWindow: 128_000, maxTokens: 4096 }],
  });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
  modelRuntime.registerProvider("wakeup-idle", {
    api: core.api as never,
    apiKey: "faux-not-used",
    streamSimple: core.streamSimple as never,
    models: core.models as never,
  });
  core.setResponses([(() => fauxAssistantMessage("idle fire", { stopReason: "stop" })) as never]);

  try {
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model: core.getModel() as never,
      modelRuntime,
      sessionManager: SessionManager.inMemory(),
      noTools: "all",
    });
    await session.sendUserMessage("[wakeup loop loop-1] continue the task", { deliverAs: "followUp" });
    await session.waitForIdle();
    assert.equal(core.state.callCount, 1, "an idle session fired the wakeup turn immediately");
    assert.equal(session.pendingMessageCount, 0, "nothing queued — the turn ran at once");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
