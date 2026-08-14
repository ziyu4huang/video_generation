/**
 * Stage B (decision 03 = b2): the workflow path registers its runs into the
 * shared SubagentInFlightRegistry so the unified subagent-context box AND
 * /subagents show workflow runs alongside subagent/subagents runs.
 *
 * These tests inject a REAL SubagentInFlightRegistry into WorkflowManager and
 * assert the per-workflow registration contract:
 *   (a) foreground runSync → start{foreground:true} + end on completion
 *   (b) background run     → start{foreground:false} BEFORE startInBackground
 *                            returns the runId + end on DETACHED completion
 *   (c) progress events    → taskPreview reflects phase + k-of-N agents
 *   (d) no leak            → end always called, incl. error / abort / pause
 *
 * The pure preview/id helpers (workflowPreview, workflowInFlightId) are also
 * unit-tested directly for exactness.
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentUsage } from "@repo/pi-agent-ext-core-runtime";
import { SubagentInFlightRegistry } from "@repo/pi-agent-ext-core-runtime";
import { createWorkflowSnapshot, type WorkflowSnapshot } from "../src/display.js";
import type { WorkflowMeta } from "../src/workflow.js";
import { WorkflowManager, workflowInFlightId, workflowPreview } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

/** Instant agent runner (returns `result`); usage reported so the path is real. */
function fakeAgent(result: unknown = "ok") {
  return {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
      return result;
    },
  };
}

/** Agent that hangs until its resolve() is called externally (timing control). */
function deferredAgent() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return {
    resolve: (v: unknown = "done") => resolve(v),
    runner: {
      async run(_prompt: string, _options?: { onUsage?: (u: AgentUsage) => void }) {
        return promise;
      },
    },
  };
}

/** Per-call deferred agent: each agent() call gets its own resolvable promise. */
function perCallDeferredAgent() {
  const resolves: Array<(v: unknown) => void> = [];
  let idx = 0;
  return {
    resolve(callIdx: number, v: unknown = "done") {
      resolves[callIdx]?.(v);
    },
    runner: {
      async run(_prompt: string, _options?: { onUsage?: (u: AgentUsage) => void }) {
        const i = idx++;
        return new Promise((r) => {
          resolves[i] = r;
        });
      },
    },
  };
}

const oneAgentScript = `export const meta = { name: 'tracked_demo', description: 'one agent' }
phase('Work')
const a = await agent('do it', { label: 'a' })
return { a }`;

const twoPhaseScript = `export const meta = { name: 'preview_wf', description: 'two phases', phases: [{ title: 'Scan' }, { title: 'Judge' }] }
phase('Scan')
const a = await agent('scan it', { label: 'scan' })
phase('Judge')
const b = await agent('judge it', { label: 'judge' })
return { a, b }`;

function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-inflight-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// ─── pure helper unit tests ────────────────────────────────────────────────────

test("workflowInFlightId prefixes the run id so it never collides with a subagent toolCallId", () => {
  assert.equal(workflowInFlightId("abc-123"), "wf:abc-123");
  // Subagent/subagents registry keys are toolCallIds (e.g. "call_…"); the "wf:"
  // prefix guarantees a disjoint key space even if a runId looked toolCallId-ish.
  assert.notEqual(workflowInFlightId("call_xyz"), "call_xyz");
});

test("workflowPreview renders name · phase · finished/total agents", () => {
  const meta: WorkflowMeta = { name: "preview_wf", description: "d", phases: [{ title: "Scan" }] };
  const snap: WorkflowSnapshot = { ...createWorkflowSnapshot(meta), currentPhase: "Scan" };
  assert.equal(workflowPreview(snap), "preview_wf · Scan", "no agents yet → no counts segment");

  snap.agents.push({ id: 1, label: "a", prompt: "p", status: "running", startedAt: 0 });
  snap.agents.push({ id: 2, label: "b", prompt: "p", status: "done", startedAt: 0 });
  snap.agents.push({ id: 3, label: "c", prompt: "p", status: "error", startedAt: 0 });
  assert.equal(workflowPreview(snap), "preview_wf · Scan · 2/3 agents", "done+error count as finished");

  snap.currentPhase = undefined;
  assert.equal(workflowPreview(snap), "preview_wf · 2/3 agents", "phase omitted when absent");
});

// ─── (a) foreground runSync registers foreground:true + ends on completion ─────

test(
  "(a) foreground runSync registers foreground:true while running and ends on completion",
  withTempCwd(async (cwd) => {
    const reg = new SubagentInFlightRegistry();
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner, inFlight: reg });
    manager.on("error", () => {});

    const runPromise = manager.runSync(oneAgentScript);
    await tick(); // let the agent start

    // Mid-flight: the run is registered as a WORKFLOW entry with foreground=true
    // (a foreground runSync blocks the turn → rendered inline by the workflow
    // tool's own component → EXCLUDED from the context box, per decision 02).
    const running = reg.views();
    assert.equal(running.length, 1, "exactly one in-flight entry while the run executes");
    const v = running[0];
    assert.equal(v.actor, "workflow");
    assert.equal(v.foreground, true, "foreground runSync → foreground:true (excluded from the box)");
    assert.equal(v.id.startsWith("wf:"), true, "id is the prefixed workflow runId");
    assert.equal(v.modelSeg, "default", "a workflow aggregates agents → no single model");
    assert.match(v.latestAction ?? "", /tracked_demo/);

    da.resolve("done");
    await runPromise;

    // Completion removes the entry — no leak.
    assert.equal(reg.views().length, 0, "entry ended after foreground completion");
  }),
);

// ─── (b) background run: start BEFORE runId returned + detached end ────────────

test(
  "(b) background run registers foreground:false BEFORE startInBackground returns the runId, ends on detached completion",
  withTempCwd(async (cwd) => {
    const reg = new SubagentInFlightRegistry();
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner, inFlight: reg });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);

    // The KEY assertion: the entry is ALREADY live the instant startInBackground
    // returns (executeRun's synchronous head registers before the first await,
    // i.e. before runId is handed back). A background run is foreground:false →
    // it is the context box's domain (decision 02).
    const v = reg.view(workflowInFlightId(runId));
    assert.ok(v, "registered BEFORE startInBackground returned the runId");
    assert.equal(v.actor, "workflow");
    assert.equal(v.foreground, false, "background run → foreground:false (box shows it)");
    assert.equal(v.id, workflowInFlightId(runId));

    // Detached completion: the tool already returned; the run finishes on its
    // own. The entry MUST be removed when the detached promise settles.
    da.resolve("done");
    await promise;
    assert.equal(reg.view(workflowInFlightId(runId)), undefined, "detached completion ends the entry");
  }),
);

// ─── (c) progress events update the registry preview (phase + k-of-N) ──────────

test(
  "(c) progress events flow into the registry preview (phase + finished/total agents)",
  withTempCwd(async (cwd) => {
    const reg = new SubagentInFlightRegistry();
    const da = perCallDeferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner, inFlight: reg });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(twoPhaseScript);
    await tick(); // agent 1 (Scan) has started

    const id = workflowInFlightId(runId);
    const afterScanStart = reg.view(id)?.latestAction ?? "";
    assert.match(afterScanStart, /Scan/, "preview reflects the Scan phase");
    assert.match(afterScanStart, /0\/1 agents|1 agents/, "preview shows agent counts");

    // Finish agent 1 → its end fires progress(); then phase switches to Judge and
    // agent 2 starts. Sample the preview once agent 2 is in flight: by then
    // progress() has recorded 1 finished of 2 under the Judge phase.
    da.resolve(0, "scan-done");
    await tick(30);

    const midJudge = reg.view(id)?.latestAction ?? "";
    assert.match(midJudge, /Judge/, "preview advanced to the Judge phase");
    assert.match(midJudge, /1\/2 agents/, "preview reflects 1 of 2 agents finished");

    da.resolve(1, "judge-done");
    await promise;
    assert.equal(reg.view(id), undefined, "entry ended after completion");
  }),
);

// ─── (d) no leak: end always called on error / abort ───────────────────────────

test(
  "(d1) a failed run (agent throws) ends the registry entry — no leak",
  withTempCwd(async (cwd) => {
    const reg = new SubagentInFlightRegistry();
    const manager = new WorkflowManager({
      cwd,
      inFlight: reg,
      agent: {
        async run() {
          throw new Error("agent exploded");
        },
      },
    });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await promise.catch(() => {}); // run rejects — the finally still fires endInFlight

    assert.equal(reg.view(workflowInFlightId(runId)), undefined, "entry ended on error");
  }),
);

test(
  "(d2) an aborted run (stop) ends the registry entry — no leak",
  withTempCwd(async (cwd) => {
    const reg = new SubagentInFlightRegistry();
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner, inFlight: reg });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await tick();
    assert.ok(reg.view(workflowInFlightId(runId)), "entry live before stop");

    manager.stop(runId);
    da.resolve("done");
    await promise.catch(() => {});

    assert.equal(reg.view(workflowInFlightId(runId)), undefined, "entry ended on abort");
  }),
);

test(
  "(d3) a paused run (usage limit) ends the registry entry; resume re-registers it",
  withTempCwd(async (cwd) => {
    const reg = new SubagentInFlightRegistry();
    const limitActive = true;
    const manager = new WorkflowManager({
      cwd,
      inFlight: reg,
      agent: {
        async run(prompt: string) {
          if (prompt.includes("second") && limitActive) {
            throw new (class extends Error {
              code = "PROVIDER_USAGE_LIMIT";
            })("usage limit");
          }
          return "ok";
        },
      },
    });
    // The fake throws a plain Error (not WorkflowError) → executeRun wraps it as
    // a recoverable WORKFLOW_ABORTED → status "failed" (not paused). That still
    // exercises the finally → endInFlight path, which is what this test asserts.
    manager.on("error", () => {});
    manager.on("paused", () => {});

    const twoAgent = `export const meta = { name: 'q', description: 'q', phases: [{title:'P'}] }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
return { a, b }`;
    const { runId, promise } = manager.startInBackground(twoAgent);
    await promise.catch(() => {});

    // Whatever terminal state (failed/paused), the live entry is gone — no leak.
    assert.equal(reg.view(workflowInFlightId(runId)), undefined, "entry ended at run termination");
  }),
);

// ─── no-op when no registry bound (tests/hosts without the box) ─────────────────

test(
  "a manager with no inFlight registry runs unchanged (registration is a no-op)",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() }); // no inFlight
    // Should complete without touching any registry — no throw, normal result.
    const result = await manager.runSync(oneAgentScript);
    assert.equal(result.agentCount, 1);
  }),
);

// ─── setInFlight late-binding mirrors the createWorkflowTool wiring ────────────

test(
  "setInFlight binds the registry after construction (the createWorkflowTool path)",
  withTempCwd(async (cwd) => {
    const reg = new SubagentInFlightRegistry();
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner }); // none at construction
    manager.setInFlight(reg); // late bind — mirrors createWorkflowTool → manager
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    assert.ok(reg.view(workflowInFlightId(runId)), "late-bound registry receives the registration");
    da.resolve("done");
    await promise;
    assert.equal(reg.view(workflowInFlightId(runId)), undefined);
  }),
);

// ─── updateTaskPreview is the only preview mutation path ──────────────────────

test("updateTaskPreview is the only preview mutation path", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "wf-1", agent: "workflow", taskPreview: "starting", startedAt: Date.now() });
  reg.updateTaskPreview("wf-1", "phase 2/3 · agent b");
  const v = reg.view("wf-1");
  assert.ok(v);
  assert.equal(v.latestAction, "phase 2/3 · agent b"); // no tool-call history → taskPreview wins
});
