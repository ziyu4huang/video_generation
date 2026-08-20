/**
 * Layer A resume robustness — the permanent regression net.
 *
 * Two characterization tests over WorkflowManager's resume mechanics (the
 * machinery the /movie commands now ride on after Phase 2). No new production
 * code here — Phase 2 wired it; these tests pin it so a regression is caught
 * before a real crash exposes it.
 *
 *   A. recoverStaleRuns reconciles a dead "running" run -> "paused" (the
 *      kernel-panic recovery path; journal preserved).
 *   B. resume replays a REAL captured journal prefix, runs only the suffix
 *      live, and deep-equals a clean run (resume is a pure replay).
 *
 * (A planned "partial-artifact" test C was dropped: Phase-1 step 6 found
 * dispatch.generate has no skip-if-exists cache — it always re-renders, so a
 * crashed run's partial media is overwritten on resume. No fix, no test.)
 */
import { describe, test, expect } from "bun:test";
import { WorkflowManager, createRunPersistence } from "@repo/s2-agent-ext-workflow";
import {
  buildProbeRegistry,
  stubAgent,
  PROBE_SCRIPT,
  tmpCwd,
  waitForTerminal,
  type ProbeCounters,
} from "./resume-test-helpers.ts";

describe("Layer A: resume robustness", () => {
  test("A. recoverStaleRuns reconciles a dead 'running' run to 'paused' (kernel-panic path)", () => {
    const cwd = tmpCwd();
    const persistence = createRunPersistence(cwd);
    const now = new Date().toISOString();
    persistence.save({
      runId: "run-dead",
      workflowName: "resume-probe",
      script: PROBE_SCRIPT,
      args: { steps: 4 },
      status: "running",
      phases: ["steps"],
      agents: [],
      logs: [],
      startedAt: now,
      updatedAt: now,
      journal: [{ index: 0, hash: "h0", result: { id: 0, ok: true } }],
    } as never);

    // A FRESH manager on this cwd = a new session after a crash.
    new WorkflowManager({ cwd, agent: stubAgent });

    const after = createRunPersistence(cwd).load("run-dead");
    expect(after?.status).toBe("paused"); // never "failed"
    expect((after?.journal ?? []).length).toBe(1); // journal preserved, not wiped
  });

  test("B. resume replays a real journal prefix, runs only the suffix live, deep-equals a clean run", async () => {
    const cwd = tmpCwd();

    // 1) clean run -> capture the REAL journal (real hashes) + result
    const cleanCounters: ProbeCounters = { liveCalls: 0, liveIds: [] };
    const m1 = new WorkflowManager({ cwd, agent: stubAgent });
    m1.on("error", () => {}); // swallow so a failure doesn't crash the process
    m1.setHostFns(buildProbeRegistry(cleanCounters) as never);
    const clean = (await m1.runSync(PROBE_SCRIPT, { steps: 4 })) as { result?: unknown };
    const cleanRun = createRunPersistence(cwd).list().at(-1)!;
    const fullJournal = cleanRun.journal ?? [];
    expect(cleanCounters.liveCalls).toBe(4); // sanity: clean run did all 4 live
    expect(fullJournal.length).toBe(4);

    // 2) seed a NEW "paused" run with only the first half of the real journal
    const seedId = "run-resume-b";
    const now = new Date().toISOString();
    createRunPersistence(cwd).save({
      runId: seedId,
      workflowName: "resume-probe",
      script: PROBE_SCRIPT,
      args: { steps: 4 },
      status: "paused",
      phases: ["steps"],
      agents: [],
      logs: [],
      startedAt: now,
      updatedAt: now,
      journal: fullJournal.slice(0, 2),
    } as never);

    // 3) fresh manager + resume -> steps 0,1 replayed from journal, 2,3 run live
    const resumeCounters: ProbeCounters = { liveCalls: 0, liveIds: [] };
    const m2 = new WorkflowManager({ cwd, agent: stubAgent });
    m2.on("error", () => {});
    m2.setHostFns(buildProbeRegistry(resumeCounters) as never);
    const ok = await m2.resume(seedId);
    const final = await waitForTerminal(() => createRunPersistence(cwd).load(seedId) as never);

    expect(ok).toBe(true);
    expect(final?.status).toBe("completed");
    expect(resumeCounters.liveCalls).toBe(2); // steps 2,3 live; 0,1 replayed (not re-invoked)
    expect(resumeCounters.liveIds).toEqual([2, 3]);
    expect(final?.result).toEqual(clean.result); // deep-equal — resume is a pure replay
  });
});
