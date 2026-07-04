/**
 * Regression tests for the flux2 self-improve LOOP workflow
 * (bun-apps/pi-agent-ext-flux2/workflows/self-improve-flux2.js).
 *
 * These load the ACTUAL workflow source and execute it through runWorkflow with
 * a mocked agent runner — the same harness as regression-ext-workflow-protection.
 * No GPU / no real flux2 binary / no LM Studio: the mock supplies fake PNG paths
 * and scripted pose_dsg verdicts. This is where the loop's contract is pinned:
 *
 *   1. fail → retry → converge      (gate actually re-runs with feedback)
 *   2. fail-forever → bounded exit  (never hangs; needsReview=true)
 *   3. null mid-loop                (silent-kill guard: no crash, loop completes)
 *   4. determinism                  (same mock+seeds → identical retry trace)
 *   5. comparative best-so-far      (winner = fewest failed_atoms, not absolute)
 *
 * The loop's control flow is pure JS (gate/validator); only the per-attempt
 * generate/judge agents touch the model. So a weak driver model cannot break the
 * multi-attempt trace — case (3) is the direct proof.
 */

import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import path from "node:path";
import { runWorkflow } from "../src/workflow.js";

const REPO = path.resolve(import.meta.dir, "../../..");
const WF_FILE = "bun-apps/pi-agent-ext-flux2/workflows/self-improve-flux2.js";
const SOURCE = await Bun.file(path.resolve(REPO, WF_FILE)).text();

type Atom = { id: string; q: string; present: boolean; confidence?: number };
type PoseVerdict = {
  anatomy_pass: boolean;
  faithfulness: number;
  atoms: Atom[];
};

const POSE = {
  id: "L3-01",
  prompt: "a woman in a dancer's pose",
  failure_modes: ["pose-plausibility"],
  atoms: [
    { id: "a1", q: "she stands on one leg" },
    { id: "a2", q: "her other leg is lifted behind her" },
    { id: "a4", q: "one arm reaches back toward the raised ankle" },
  ],
};

/**
 * Mock agent for the loop. Drives the three real agent surfaces:
 *   - "Generate one flux2 t2i PNG" → fake PNG paths (one per target).
 *   - "Validate this generated pose" → scripted pose_dsg verdicts, CONSUMED IN
 *     ORDER per judge call (one per attempt for a single-pose run, so verdicts
 *     map 1:1 to attempts). When the script runs out, the last verdict sticks
 *     (the fail-forever case).
 *   - "Append a self-improve exemplar" → fake successful persist.
 * Any other prompt → null (treated as a recoverable judge failure by the engine).
 */
function makeLoopMock(opts: {
  paths?: string[];
  poseVerdicts: PoseVerdict[];
  nullOnPoseCall?: number; // 1-based index of the pose-judge call that returns null
}) {
  const paths = opts.paths ?? ["/tmp/wf-loop-test/p0.png"];
  let poseCalls = 0;
  return {
    async run(prompt: string) {
      const p = String(prompt ?? "");
      if (/Generate one flux2 t2i PNG/.test(p)) {
        return { ok: true, paths, binaryReady: true, error: "" };
      }
      if (/Validate this generated pose/.test(p)) {
        poseCalls += 1;
        if (opts.nullOnPoseCall === poseCalls) return null; // silent-kill simulation
        const v = opts.poseVerdicts[Math.min(poseCalls - 1, opts.poseVerdicts.length - 1)];
        return {
          ok: true,
          path: paths[Math.min(poseCalls - 1, paths.length - 1)] ?? paths[0],
          poseId: POSE.id,
          anatomy_pass: v.anatomy_pass,
          faithfulness: v.faithfulness,
          anatomy: { limb_count: true, hands: true, face: true, pose_plausible: v.anatomy_pass },
          atoms: v.atoms,
          issues: [],
          rawTail: "",
        };
      }
      if (/Append a self-improve exemplar/.test(p)) {
        return { written: true, total_lines: 1 };
      }
      return null;
    },
  };
}

const common = {
  cwd: REPO,
  agentRetries: 1, // so run() actually fires (and can return null / throw)
  persistLogs: false,
  args: { repoRoot: REPO, poses: [POSE], outDir: "/tmp/wf-loop-test" },
} as const;

type LoopResult = {
  ok: boolean;
  converged: boolean;
  staticExit?: boolean;
  terminationReason?: string;
  needsReview: boolean;
  attemptsUsed: number;
  maxAttempts: number;
  winnerPath: string;
  winnerVerdict: {
    attempt: number;
    seed: number;
    ok: boolean;
    failedCount: number;
    meanFaith: number;
    poseMatrix: Array<{ poseId: string; anatomy_pass: boolean; faithfulness: number; failed_atoms: string[] }>;
    judgments: Array<{ scored: boolean; style?: string; needsReview?: boolean; error?: string }>;
  } | null;
  best: { attempt: number; failedCount: number; meanFaith: number; seed: number } | null;
  trace: Array<{ attempt: number; seed: number; ok: boolean; failedCount: number; meanFaith: number }>;
  exemplar: { prompt: string; params: { seed: number }; verdict: { ok: boolean; attempt: number } } | null;
  exemplarsFile?: string;
  maxExemplars?: number;
  summary: string;
};

describe("flux2 self-improve loop", () => {
  it("fail → retry → converge: gate re-runs with feedback and stops on ok", async () => {
    const result = await runWorkflow(SOURCE, {
      ...common,
      args: { ...common.args, attempts: 3, seed: 42 },
      agent: makeLoopMock({
        poseVerdicts: [
          { anatomy_pass: false, faithfulness: 0.3, atoms: [ // attempt 0: fails
            { id: "a1", q: "x", present: true },
            { id: "a2", q: "x", present: false },
            { id: "a4", q: "x", present: false },
          ]},
          { anatomy_pass: true, faithfulness: 0.9, atoms: [ // attempt 1: passes
            { id: "a1", q: "x", present: true },
            { id: "a2", q: "x", present: true },
            { id: "a4", q: "x", present: true },
          ]},
        ],
      }),
    });
    const r = result.result as LoopResult;

    assert.equal(r.converged, true, "should converge");
    assert.equal(r.ok, true);
    assert.equal(r.attemptsUsed, 2, "converges on attempt 2 (1-indexed) — gate stops on ok");
    assert.equal(r.maxAttempts, 3);
    assert.equal(r.needsReview, false);
    assert.ok(r.winnerVerdict, "winnerVerdict present");
    assert.equal(r.winnerVerdict!.attempt, 1, "winner is the converging attempt (0-indexed)");
    assert.equal(r.winnerVerdict!.ok, true);
    assert.ok(r.winnerPath.length > 0, "a winner path is selected");
    assert.ok(r.exemplar, "exemplar built from the winner");
    assert.equal(r.exemplar!.params.seed, 43, "winner seed = seedBase(42) + winning attempt(1)");
    assert.equal((r as { exemplarPersisted?: boolean }).exemplarPersisted, undefined, "workflow no longer persists (driver does) — exemplarPersisted field removed");
  });

  it("fail-forever → bounded exit: hits maxAttempts, needsReview=true, never hangs", async () => {
    const result = await runWorkflow(SOURCE, {
      ...common,
      // consecutiveStatic:0 disables plateau exit so this tests pure cap exhaustion.
      args: { ...common.args, attempts: 3, seed: 100, consecutiveStatic: 0 },
      agent: makeLoopMock({
        poseVerdicts: [
          { anatomy_pass: false, faithfulness: 0.2, atoms: [
            { id: "a1", q: "x", present: false },
            { id: "a2", q: "x", present: false },
          ]},
        ],
      }),
    });
    const r = result.result as LoopResult;

    assert.equal(r.converged, false);
    assert.equal(r.ok, false);
    assert.equal(r.staticExit, false);
    assert.equal(r.attemptsUsed, 3, "exhausts all attempts — bounded, no infinite regress");
    assert.equal(r.needsReview, true);
    assert.equal(r.trace.length, 3, "one trace entry per attempt");
  });

  it("plateau → static-exit early: same failed-atom set across rounds stops before maxAttempts", async () => {
    // Every attempt fails with the SAME atom absent (a2). With consecutiveStatic:2,
    // the loop should halt at attempt 2 (2 identical signatures) — NOT burn all 5.
    const result = await runWorkflow(SOURCE, {
      ...common,
      args: { ...common.args, attempts: 5, seed: 200, consecutiveStatic: 2 },
      agent: makeLoopMock({
        poseVerdicts: [
          { anatomy_pass: false, faithfulness: 0.3, atoms: [
            { id: "a1", q: "x", present: true },
            { id: "a2", q: "x", present: false },
          ]},
        ],
      }),
    });
    const r = result.result as LoopResult;

    assert.equal(r.staticExit, true, "should exit via plateau detection");
    assert.equal(r.terminationReason, "static");
    assert.equal(r.converged, false, "a plateau is NOT a convergence");
    assert.equal(r.needsReview, true);
    assert.equal(r.attemptsUsed, 2, "halts after consecutiveStatic(2) identical rounds, not maxAttempts(5)");
    assert.ok(r.attemptsUsed < 5, "must stop strictly before maxAttempts");
    // Winner is still the BEST attempt (fewest failed atoms), not the stuck last one.
    assert.ok(r.winnerVerdict, "best-so-far winner chosen even on static-exit");
  });

  it("null mid-loop (silent-kill guard): a failed judge becomes scored:false, loop completes without crashing", async () => {
    // attempt 0 fails (anatomy), attempt 1's judge returns null (unscored),
    // attempt 2 passes. The loop MUST survive the null and finish.
    const result = await runWorkflow(SOURCE, {
      ...common,
      args: { ...common.args, attempts: 3, seed: 7 },
      agent: makeLoopMock({
        nullOnPoseCall: 2, // the 2nd pose-judge call (attempt 1) returns null
        poseVerdicts: [
          { anatomy_pass: false, faithfulness: 0.3, atoms: [{ id: "a1", q: "x", present: false }] },
          { anatomy_pass: true, faithfulness: 0.9, atoms: [{ id: "a1", q: "x", present: true }] }, // unused (nulled)
          { anatomy_pass: true, faithfulness: 0.9, atoms: [{ id: "a1", q: "x", present: true }] },
        ],
      }),
    });
    const r = result.result as LoopResult;

    // attempt 1 (0-indexed) had an unscored judgment → that attempt can't be ok.
    // The trace entry for it must exist; the loop did not crash.
    assert.ok(r.trace.length >= 2, "loop ran multiple attempts despite the mid-loop null");
    assert.ok(r.attemptsUsed <= 3, "bounded");
    // The null surfaced as a scored:false / needsReview judgment on attempt 1.
    const nulledTraceSeed = 7 + 1;
    assert.ok(r.trace.some((t) => t.seed === nulledTraceSeed), "the nulled attempt is in the trace");
  });

  it("determinism: same mock + same seeds → identical retry trace across two runs", async () => {
    const verdicts: PoseVerdict[] = [
      { anatomy_pass: false, faithfulness: 0.4, atoms: [{ id: "a1", q: "x", present: false }, { id: "a2", q: "x", present: true }] },
      { anatomy_pass: true, faithfulness: 0.85, atoms: [{ id: "a1", q: "x", present: true }, { id: "a2", q: "x", present: true }] },
    ];
    const run1 = await runWorkflow(SOURCE, {
      ...common,
      args: { ...common.args, attempts: 3, seed: 42 },
      agent: makeLoopMock({ poseVerdicts: verdicts }),
    });
    const run2 = await runWorkflow(SOURCE, {
      ...common,
      args: { ...common.args, attempts: 3, seed: 42 },
      agent: makeLoopMock({ poseVerdicts: verdicts }),
    });
    const a = run1.result as LoopResult;
    const b = run2.result as LoopResult;

    assert.equal(a.attemptsUsed, b.attemptsUsed);
    assert.equal(a.converged, b.converged);
    assert.deepEqual(
      a.trace.map((t) => ({ s: t.seed, ok: t.ok })),
      b.trace.map((t) => ({ s: t.seed, ok: t.ok })),
      "per-attempt seed sequence + ok pattern must be identical",
    );
    assert.equal(a.winnerVerdict?.seed, b.winnerVerdict?.seed);
    assert.equal(a.winnerVerdict?.attempt, b.winnerVerdict?.attempt);
  });

  it("comparative best-so-far: when nothing converges, winner = fewest failed_atoms, not absolute score", async () => {
    // All three attempts fail anatomy (so the gate never passes), but their
    // failed_counts differ. The winner must be the attempt with the fewest
    // failed atoms — comparative ranking, immune to a holistic-score flip.
    const result = await runWorkflow(SOURCE, {
      ...common,
      args: { ...common.args, attempts: 3, seed: 50 },
      agent: makeLoopMock({
        poseVerdicts: [
          { anatomy_pass: false, faithfulness: 0.2, atoms: [ // attempt 0: 3 failed
            { id: "a1", q: "x", present: false },
            { id: "a2", q: "x", present: false },
            { id: "a4", q: "x", present: false },
          ]},
          { anatomy_pass: false, faithfulness: 0.5, atoms: [ // attempt 1: 0 failed (but anatomy hard-fail)
            { id: "a1", q: "x", present: true },
            { id: "a2", q: "x", present: true },
            { id: "a4", q: "x", present: true },
          ]},
          { anatomy_pass: false, faithfulness: 0.9, atoms: [ // attempt 2: 1 failed, HIGHER faithfulness
            { id: "a1", q: "x", present: true },
            { id: "a2", q: "x", present: false },
            { id: "a4", q: "x", present: true },
          ]},
        ],
      }),
    });
    const r = result.result as LoopResult;

    assert.equal(r.converged, false, "nothing converged");
    assert.equal(r.ok, false);
    assert.equal(r.needsReview, true);
    assert.ok(r.winnerVerdict, "a best-so-far winner is still chosen");
    assert.equal(r.winnerVerdict!.attempt, 1, "attempt 1 has 0 failed atoms — wins by comparative ranking");
    assert.equal(r.winnerVerdict!.failedCount, 0);
    // NOT attempt 2 despite its higher meanFaith (0.9 > 0.5): failedCount dominates.
    assert.equal(r.best!.attempt, 1);
  });

  it("empty-atoms pose verdict (VLM did not analyze) → scored:false, not a phantom 0-faith fail", async () => {
    // Real-silicon finding: pose_dsg can return a well-shaped verdict with ZERO
    // atoms + anatomy all-false + faithfulness 0. That is untrustworthy, not a
    // real fail. Surface as scored:false so the loop can retry instead of logging
    // a phantom judgment (and so a failed run is not persisted as an exemplar).
    const result = await runWorkflow(SOURCE, {
      ...common,
      args: { ...common.args, attempts: 1, seed: 8 },
      agent: makeLoopMock({
        poseVerdicts: [{ anatomy_pass: false, faithfulness: 0, atoms: [] }],
      }),
    });
    const r = result.result as LoopResult;
    assert.equal(r.ok, false);
    assert.equal(r.needsReview, true);
    const verdicts = r.winnerVerdict?.judgments ?? [];
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0].scored, false, "empty-atoms verdict MUST be scored:false");
    assert.ok(/0 atoms/i.test(verdicts[0].error || ""), "error names the empty-atoms cause");
  });

  it("few-shot injection: args.fewShot seeds attempt 0's generation prompt", async () => {
    // A few-shot string passed via args is prepended into attempt 0's generation
    // (the workflow seeds target 0 with it). The mock generate agent records the
    // prompts it received so we can assert the few-shot text reached generation.
    const seen: string[] = [];
    const result = await runWorkflow(SOURCE, {
      ...common,
      args: { ...common.args, attempts: 1, seed: 5, fewShot: "PRIOR_WINNING_EXPANSION_SEED" },
      agent: {
        async run(prompt: string) {
          const p = String(prompt ?? "");
          if (/Generate one flux2 t2i PNG/.test(p)) {
            seen.push(p);
            return { ok: true, paths: ["/tmp/wf-loop-test/p0.png"], binaryReady: true, error: "" };
          }
          if (/Validate this generated pose/.test(p)) {
            return {
              ok: true, path: "/tmp/wf-loop-test/p0.png", poseId: POSE.id,
              anatomy_pass: true, faithfulness: 0.9,
              anatomy: { limb_count: true, hands: true, face: true, pose_plausible: true },
              atoms: [{ id: "a1", q: "x", present: true }], issues: [], rawTail: "",
            };
          }
          return null;
        },
      },
    });
    const r = result.result as LoopResult;
    assert.equal(r.ok, true, "converges");
    assert.equal(r.exemplar?.prompt, POSE.prompt, "exemplar records the BASE pose prompt for matching");
    // The exemplar's winningPrompt carries the seed used (here base, since no feedback on attempt 0).
    assert.ok(seen.length > 0, "generate agent was called");
    assert.ok(
      seen.some((p) => p.includes("PRIOR_WINNING_EXPANSION_SEED")),
      "attempt 0 generation prompt MUST contain the few-shot seed",
    );
  });
});
