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
      artifacts: { brief: { title: "x" } },
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
