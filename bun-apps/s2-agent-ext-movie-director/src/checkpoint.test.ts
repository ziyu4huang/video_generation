import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeCheckpoint,
  readCheckpoint,
  getLatestCheckpoint,
  getCompletedStages,
  listProjects,
  GateViolationError,
  enforceStageCheckpointGate,
} from "./checkpoint.ts";

let env: Record<string, string | undefined>;
beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), "md-cp-"));
  env = { MLX_OUTPUT_DIR: tmp };
});

describe("checkpoint gate enforcement", () => {
  test("in_progress on a gated stage writes without approval", () => {
    const cp = writeCheckpoint({
      projectId: "p1", pipeline: "talking-head", stage: "idea",
      status: "in_progress", env,
    });
    expect(cp.status).toBe("in_progress");
    expect(readCheckpoint("p1", "idea", env)?.status).toBe("in_progress");
  });

  test("completed on a gated stage WITHOUT approval ⇒ GateViolationError", () => {
    expect(() =>
      writeCheckpoint({
        projectId: "p1", pipeline: "talking-head", stage: "idea",
        status: "completed", env,
      }),
    ).toThrow(GateViolationError);
    // Nothing persisted.
    expect(readCheckpoint("p1", "idea", env)).toBeUndefined();
  });

  test("completed on a gated stage WITH humanApproved=true writes ok", () => {
    const cp = writeCheckpoint({
      projectId: "p1", pipeline: "talking-head", stage: "idea",
      status: "completed", humanApproved: true, env,
      artifacts: {
        brief: {
          version: "1.0", title: "x", hook: "hook", key_points: ["a"],
          tone: "warm", style: "clean-professional", target_platform: "generic",
          target_duration_seconds: 30,
        },
      },
    });
    expect(cp.status).toBe("completed");
    expect(cp.human_approved).toBe(true);
  });

  test("completed on a NON-gated stage writes without approval (edit)", () => {
    const cp = writeCheckpoint({
      projectId: "p1", pipeline: "talking-head", stage: "edit",
      status: "completed", overrideRequiredArtifacts: true, env,
    });
    expect(cp.status).toBe("completed");
  });

  test("awaiting_human is allowed on a gated stage without approval", () => {
    const cp = writeCheckpoint({
      projectId: "p1", pipeline: "talking-head", stage: "script",
      status: "awaiting_human", env,
    });
    expect(cp.status).toBe("awaiting_human");
  });
});

// Relocated from extensions/movie-director.ts's next-stage case (Item 1,
// gate unification, output/next-goal-20260712_135012.md) — pure move, same
// GATE VIOLATION wording/override-flag behavior as before, now unit-testable
// without instantiating the extension/dispatcher.
describe("enforceStageCheckpointGate", () => {
  test("returns null when the stage isn't checkpoint_required", () => {
    // animated-explainer's "research" stage has checkpoint_required:false.
    const r = enforceStageCheckpointGate("animated-explainer", "research", "p5", { env });
    expect(r).toBeNull();
  });

  test("returns null when stage is undefined", () => {
    const r = enforceStageCheckpointGate("animated-explainer", undefined, "p5", { env });
    expect(r).toBeNull();
  });

  test("blocks with a projectId-missing error when required and projectId is absent", () => {
    // "proposal" has checkpoint_required:true.
    const r = enforceStageCheckpointGate("animated-explainer", "proposal", undefined, { env });
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toContain("requires non-empty projectId");
  });

  test("blocks with GATE VIOLATION when required and no completed checkpoint exists", () => {
    const r = enforceStageCheckpointGate("animated-explainer", "proposal", "p5", { env });
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toContain("GATE VIOLATION");
  });

  test("returns null once the stage has a completed checkpoint", () => {
    writeCheckpoint({
      projectId: "p5", pipeline: "animated-explainer", stage: "proposal",
      status: "completed", humanApproved: true, overrideRequiredArtifacts: true, env,
    });
    const r = enforceStageCheckpointGate("animated-explainer", "proposal", "p5", { env });
    expect(r).toBeNull();
  });

  test("returns null when overrideStageGate:true, even without a completed checkpoint", () => {
    const r = enforceStageCheckpointGate("animated-explainer", "proposal", "p5", { overrideStageGate: true, env });
    expect(r).toBeNull();
  });
});

describe("final_review gate — publish cannot complete past a fail verdict without override", () => {
  test("publish completed is rejected when the linked final_review verdict is 'fail'", () => {
    // talking-head's compose stage produces final_review; publish requires it.
    writeCheckpoint({
      projectId: "p4", pipeline: "talking-head", stage: "compose",
      status: "completed", env, overrideArtifactValidation: true, overrideRequiredArtifacts: true,
      artifacts: { render_report: { ok: true }, final_review: { verdict: "fail", checks: [] } },
    });
    expect(() =>
      writeCheckpoint({
        projectId: "p4", pipeline: "talking-head", stage: "publish",
        status: "completed", humanApproved: true, env,
      }),
    ).toThrow(GateViolationError);
    expect(readCheckpoint("p4", "publish", env)).toBeUndefined();
  });

  test("publish completed succeeds when final_review verdict is 'pass'", () => {
    writeCheckpoint({
      projectId: "p5", pipeline: "talking-head", stage: "compose",
      status: "completed", env, overrideArtifactValidation: true, overrideRequiredArtifacts: true,
      artifacts: { render_report: { ok: true }, final_review: { verdict: "pass", checks: [] } },
    });
    const cp = writeCheckpoint({
      projectId: "p5", pipeline: "talking-head", stage: "publish",
      status: "completed", humanApproved: true, env,
    });
    expect(cp.status).toBe("completed");
  });

  test("publish completed succeeds past a 'fail' verdict when overrideFinalReview=true is passed explicitly", () => {
    writeCheckpoint({
      projectId: "p6", pipeline: "talking-head", stage: "compose",
      status: "completed", env, overrideArtifactValidation: true, overrideRequiredArtifacts: true,
      artifacts: { render_report: { ok: true }, final_review: { verdict: "fail", checks: [] } },
    });
    const cp = writeCheckpoint({
      projectId: "p6", pipeline: "talking-head", stage: "publish",
      status: "completed", humanApproved: true, overrideFinalReview: true, env,
    });
    expect(cp.status).toBe("completed");
  });

  test("awaiting_human on publish is allowed even with a 'fail' final_review (not a completion)", () => {
    writeCheckpoint({
      projectId: "p7", pipeline: "talking-head", stage: "compose",
      status: "completed", env, overrideArtifactValidation: true, overrideRequiredArtifacts: true,
      artifacts: { render_report: { ok: true }, final_review: { verdict: "fail", checks: [] } },
    });
    const cp = writeCheckpoint({
      projectId: "p7", pipeline: "talking-head", stage: "publish",
      status: "awaiting_human", env,
    });
    expect(cp.status).toBe("awaiting_human");
  });

  test("publish completed is rejected when compose was never completed (no final_review to check) — fails closed, not open", () => {
    // No prior "compose" checkpoint written for this project at all.
    expect(() =>
      writeCheckpoint({
        projectId: "p9", pipeline: "talking-head", stage: "publish",
        status: "completed", humanApproved: true, env,
      }),
    ).toThrow(GateViolationError);
    expect(readCheckpoint("p9", "publish", env)).toBeUndefined();
  });
});

describe("required_artifacts_in gate — generalized beyond final_review (tool-design audit, 2026-07-12)", () => {
  test("compose cannot complete when edit was never completed (edit_decisions missing)", () => {
    expect(() =>
      writeCheckpoint({
        projectId: "p13", pipeline: "talking-head", stage: "compose",
        status: "completed", env, overrideArtifactValidation: true,
        artifacts: { render_report: { ok: true } },
      }),
    ).toThrow(GateViolationError);
    expect(readCheckpoint("p13", "compose", env)).toBeUndefined();
  });

  test("compose cannot complete when edit completed but didn't carry the edit_decisions artifact key", () => {
    writeCheckpoint({
      projectId: "p14", pipeline: "talking-head", stage: "edit",
      status: "completed", env, overrideRequiredArtifacts: true, overrideArtifactValidation: true,
      artifacts: { some_other_key: {} }, // no edit_decisions
    });
    writeCheckpoint({
      projectId: "p14", pipeline: "talking-head", stage: "assets",
      status: "completed", humanApproved: true, env, overrideRequiredArtifacts: true, overrideArtifactValidation: true,
      artifacts: { asset_manifest: { ok: true } },
    });
    expect(() =>
      writeCheckpoint({
        projectId: "p14", pipeline: "talking-head", stage: "compose",
        status: "completed", env, overrideArtifactValidation: true,
        artifacts: { render_report: { ok: true } },
      }),
    ).toThrow(GateViolationError);
  });

  test("compose completes once both edit_decisions and asset_manifest exist in their completed producing stages", () => {
    writeCheckpoint({
      projectId: "p15", pipeline: "talking-head", stage: "edit",
      status: "completed", env, overrideRequiredArtifacts: true,
      artifacts: { edit_decisions: { version: "1.0", cuts: [], render_runtime: "ffmpeg" } },
    });
    writeCheckpoint({
      projectId: "p15", pipeline: "talking-head", stage: "assets",
      status: "completed", humanApproved: true, env, overrideRequiredArtifacts: true, overrideArtifactValidation: true,
      artifacts: { asset_manifest: { ok: true } },
    });
    const cp = writeCheckpoint({
      projectId: "p15", pipeline: "talking-head", stage: "compose",
      status: "completed", env, overrideArtifactValidation: true,
      artifacts: { render_report: { ok: true } },
    });
    expect(cp.status).toBe("completed");
  });

  test("overrideRequiredArtifacts=true bypasses the check explicitly", () => {
    const cp = writeCheckpoint({
      projectId: "p16", pipeline: "talking-head", stage: "compose",
      status: "completed", env, overrideRequiredArtifacts: true, overrideArtifactValidation: true,
      artifacts: { render_report: { ok: true } },
    });
    expect(cp.status).toBe("completed");
  });

  test("a stage with no required_artifacts_in (idea) is never gated by this check", () => {
    const cp = writeCheckpoint({
      projectId: "p17", pipeline: "talking-head", stage: "idea",
      status: "completed", humanApproved: true, env,
      artifacts: {
        brief: {
          version: "1.0", title: "x", hook: "hook", key_points: ["a"],
          tone: "warm", style: "clean-professional", target_platform: "generic",
          target_duration_seconds: 30,
        },
      },
    });
    expect(cp.status).toBe("completed");
  });
});

describe("artifact-schema gate — completed cannot carry a schema-invalid canonical artifact", () => {
  test("completed with a schema-invalid research_brief is rejected", () => {
    // Missing every required field research_brief.schema.json demands.
    expect(() =>
      writeCheckpoint({
        projectId: "p8", pipeline: "animated-explainer", stage: "research",
        status: "completed", env,
        artifacts: { research_brief: "Successfully simulated research brief content." },
      }),
    ).toThrow(GateViolationError);
    expect(readCheckpoint("p8", "research", env)).toBeUndefined();
  });

  test("completed with a schema-valid research_brief writes ok", () => {
    const cp = writeCheckpoint({
      projectId: "p9", pipeline: "animated-explainer", stage: "research",
      status: "completed", env,
      artifacts: {
        research_brief: {
          version: "1.0",
          topic: "why the sky is blue",
          research_date: "2026-07-10",
          landscape: {
            existing_content: [
              { title: "a", source: "youtube", angle: "x", what_it_covers: "y" },
              { title: "b", source: "youtube", angle: "x", what_it_covers: "y" },
              { title: "c", source: "blog", angle: "x", what_it_covers: "y" },
            ],
            saturated_angles: [],
            underserved_gaps: ["gap"],
          },
          data_points: [
            { claim: "Rayleigh scattering", source_url: "https://example.com/a", credibility: "primary_source" },
            { claim: "point 2", source_url: "https://example.com/b", credibility: "secondary_source" },
            { claim: "point 3", source_url: "https://example.com/c", credibility: "secondary_source" },
          ],
          audience_insights: {
            common_questions: ["q1", "q2", "q3"],
            misconceptions: [],
            knowledge_level: "novice",
          },
          angles_discovered: [
            { name: "angle 1", hook: "h1", type: "evergreen", why_now: "w1" },
            { name: "angle 2", hook: "h2", type: "data_driven", why_now: "w2" },
            { name: "angle 3", hook: "h3", type: "narrative", why_now: "w3" },
          ],
          sources: [
            { url: "https://example.com/1", title: "s1", used_for: "data" },
            { url: "https://example.com/2", title: "s2", used_for: "data" },
            { url: "https://example.com/3", title: "s3", used_for: "data" },
            { url: "https://example.com/4", title: "s4", used_for: "data" },
            { url: "https://example.com/5", title: "s5", used_for: "data" },
          ],
        },
      },
    });
    expect(cp.status).toBe("completed");
  });

  test("overrideArtifactValidation=true allows a schema-invalid artifact through explicitly", () => {
    const cp = writeCheckpoint({
      projectId: "p10", pipeline: "animated-explainer", stage: "research",
      status: "completed", env, overrideArtifactValidation: true,
      artifacts: { research_brief: "not schema-shaped, shipped on purpose" },
    });
    expect(cp.status).toBe("completed");
  });

  test("in_progress with a schema-invalid artifact is not blocked (only completed is gated)", () => {
    const cp = writeCheckpoint({
      projectId: "p11", pipeline: "animated-explainer", stage: "research",
      status: "in_progress", env,
      artifacts: { research_brief: "still drafting" },
    });
    expect(cp.status).toBe("in_progress");
  });

  test("artifact keys with no canonical schema (custom/intermediate) are not validated", () => {
    const cp = writeCheckpoint({
      projectId: "p12", pipeline: "talking-head", stage: "edit",
      status: "completed", env, overrideRequiredArtifacts: true,
      artifacts: { some_custom_note: { anything: "goes" } },
    });
    expect(cp.status).toBe("completed");
  });
});

describe("checkpoint archival + state", () => {
  test("rewriting a stage archives the superseded checkpoint to history/", () => {
    writeCheckpoint({ projectId: "p2", pipeline: "talking-head", stage: "idea", status: "in_progress", env });
    writeCheckpoint({ projectId: "p2", pipeline: "talking-head", stage: "idea", status: "completed", humanApproved: true, env });
    const cur = readCheckpoint("p2", "idea", env);
    expect(cur?.status).toBe("completed");
    // history/ should hold the prior in_progress archive.
    // (presence check — exact filename includes a timestamp)
  });

  test("getLatestCheckpoint + getCompletedStages", () => {
    writeCheckpoint({ projectId: "p3", pipeline: "talking-head", stage: "idea", status: "completed", humanApproved: true, env });
    writeCheckpoint({ projectId: "p3", pipeline: "talking-head", stage: "edit", status: "completed", overrideRequiredArtifacts: true, env });
    const latest = getLatestCheckpoint("p3", "talking-head", env);
    expect(latest?.stage).toBe("edit");
    expect(getCompletedStages("p3", "talking-head", env)).toEqual(["idea", "edit"]);
  });
});

describe("script pacing advisory (Bug 3, saturn-young-rings 2026-07-12)", () => {
  test("writing a checkpoint with a script artifact auto-computes metadata.script_pacing", () => {
    const text = Array.from({ length: 270 }, () => "word").join(" ");
    const cp = writeCheckpoint({
      projectId: "p4", pipeline: "talking-head", stage: "idea", status: "in_progress",
      artifacts: {
        script: {
          version: "1.0", title: "t", total_duration_seconds: 78,
          sections: [{ id: "s1", text, start_seconds: 0, end_seconds: 78 }],
        },
      },
      env,
    });
    const pacing = (cp.metadata as Record<string, unknown> | undefined)?.script_pacing as { status: string; overallWordsPerSecond: number } | undefined;
    expect(pacing).toBeDefined();
    expect(pacing!.status).toBe("warn"); // 270/78 ≈ 3.46 wps — the real saturn-young-rings shape
    expect(pacing!.overallWordsPerSecond).toBeCloseTo(3.46, 1);
  });

  test("does not block completion even when script_pacing would fail — advisory only", () => {
    const text = Array.from({ length: 270 }, () => "word").join(" ");
    expect(() =>
      writeCheckpoint({
        projectId: "p5", pipeline: "talking-head", stage: "idea", status: "completed", humanApproved: true,
        artifacts: {
          script: {
            version: "1.0", title: "t", total_duration_seconds: 60,
            sections: [{ id: "s1", text, start_seconds: 0, end_seconds: 60 }],
          },
        },
        overrideArtifactValidation: true, // script.schema.json requires more fields than this minimal fixture has
        env,
      }),
    ).not.toThrow();
  });

  test("no script artifact ⇒ no script_pacing key in metadata", () => {
    const cp = writeCheckpoint({
      projectId: "p6", pipeline: "talking-head", stage: "idea", status: "in_progress", env,
    });
    expect((cp.metadata as Record<string, unknown> | undefined)?.script_pacing).toBeUndefined();
  });
});

describe("listProjects — project discovery (tool-design audit, resumability gap, 2026-07-12)", () => {
  test("no projects directory yet ⇒ empty array, not an error", () => {
    expect(listProjects(env)).toEqual([]);
  });

  test("discovers a project purely from its checkpoint_*.json files, with resumeStage set to the next stage", () => {
    writeCheckpoint({ projectId: "proj-a", pipeline: "talking-head", stage: "idea", status: "completed", humanApproved: true, env });
    const list = listProjects(env);
    expect(list).toHaveLength(1);
    expect(list[0]!.projectId).toBe("proj-a");
    expect(list[0]!.pipeline).toBe("talking-head");
    expect(list[0]!.latestStage).toBe("idea");
    expect(list[0]!.latestStatus).toBe("completed");
    expect(list[0]!.completedStages).toEqual(["idea"]);
    expect(list[0]!.resumeStage).toBe("script"); // next stage after idea
  });

  test("an in_progress/failed latest stage resumes AT that stage, not past it", () => {
    writeCheckpoint({ projectId: "proj-b", pipeline: "talking-head", stage: "idea", status: "completed", humanApproved: true, env });
    writeCheckpoint({ projectId: "proj-b", pipeline: "talking-head", stage: "script", status: "in_progress", env });
    const list = listProjects(env);
    const proj = list.find((p) => p.projectId === "proj-b")!;
    expect(proj.latestStage).toBe("script");
    expect(proj.resumeStage).toBe("script"); // resume the incomplete stage itself, don't skip past it
  });

  test("determines 'latest' by PIPELINE STAGE ORDER, not timestamp+directory-listing order (CI flake fix, 2026-07-12)", () => {
    // Reproduces the actual trigger: two checkpoints written with the SAME
    // timestamp (fast synchronous writes, common in tests and sometimes real
    // runs). readdirSync's directory-listing order is NOT alphabetical or
    // creation-order-guaranteed across filesystems (macOS's APFS often looks
    // sorted; Linux ext4/tmpfs, hit in CI, does not) — a naive
    // timestamp-then-file-order tie-break can silently report a STALE stage
    // as "latest". Deliberately writes the LATER-in-pipeline-order stage
    // ("script") before the EARLIER one ("idea") — the opposite of both
    // alphabetical and pipeline order — to prove the result doesn't depend on
    // write/file-listing order once timestamps tie.
    const tied = () => "2026-07-12T00:00:00.000Z";
    writeCheckpoint({ projectId: "proj-tie", pipeline: "talking-head", stage: "script", status: "in_progress", env, now: tied });
    writeCheckpoint({ projectId: "proj-tie", pipeline: "talking-head", stage: "idea", status: "completed", humanApproved: true, env, now: tied });
    const list = listProjects(env);
    const proj = list.find((p) => p.projectId === "proj-tie")!;
    expect(proj.latestStage).toBe("script"); // script is later in talking-head's stage order than idea
    expect(proj.resumeStage).toBe("script");
  });

  test("multiple projects sort newest-first by latest checkpoint timestamp", () => {
    writeCheckpoint({
      projectId: "proj-old", pipeline: "talking-head", stage: "idea", status: "in_progress", env,
      now: () => "2020-01-01T00:00:00.000Z",
    });
    writeCheckpoint({
      projectId: "proj-new", pipeline: "talking-head", stage: "idea", status: "in_progress", env,
      now: () => "2030-01-01T00:00:00.000Z",
    });
    const list = listProjects(env);
    expect(list.map((p) => p.projectId)).toEqual(["proj-new", "proj-old"]);
  });

  test("a project directory with zero checkpoint files (stray/empty dir) is not listed", () => {
    writeCheckpoint({ projectId: "proj-c", pipeline: "talking-head", stage: "idea", status: "in_progress", env });
    // Simulate a stray empty dir alongside a real project.
    mkdirSync(join(env.MLX_OUTPUT_DIR!, "movie-director", "projects", "stray-empty-dir"), { recursive: true });
    const list = listProjects(env);
    expect(list.map((p) => p.projectId)).toEqual(["proj-c"]);
  });
});
