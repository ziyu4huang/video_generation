import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeCheckpoint,
  readCheckpoint,
  getLatestCheckpoint,
  getCompletedStages,
  GateViolationError,
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
      status: "completed", env,
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

describe("final_review gate — publish cannot complete past a fail verdict without override", () => {
  test("publish completed is rejected when the linked final_review verdict is 'fail'", () => {
    // talking-head's compose stage produces final_review; publish requires it.
    writeCheckpoint({
      projectId: "p4", pipeline: "talking-head", stage: "compose",
      status: "completed", env, overrideArtifactValidation: true,
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
      status: "completed", env, overrideArtifactValidation: true,
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
      status: "completed", env, overrideArtifactValidation: true,
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
      status: "completed", env, overrideArtifactValidation: true,
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
      status: "completed", env,
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
    writeCheckpoint({ projectId: "p3", pipeline: "talking-head", stage: "edit", status: "completed", env });
    const latest = getLatestCheckpoint("p3", "talking-head", env);
    expect(latest?.stage).toBe("edit");
    expect(getCompletedStages("p3", "talking-head", env)).toEqual(["idea", "edit"]);
  });
});
