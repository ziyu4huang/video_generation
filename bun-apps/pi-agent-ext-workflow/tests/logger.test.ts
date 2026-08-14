import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowLogger } from "../src/logger.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";
import { withFakeHome } from "./helpers/fake-home.js";

/**
 * logger — run-log persistence + the `runsDir` override that lets a headless
 * caller (the pi-agent CLI) redirect output to PWD/.pi or any folder.
 */
describe("workflow logger", () => {
  it("writes the run log into the overridden runsDir (absolute)", () => {
    const home = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-project-"));
    const customRuns = mkdtempSync(join(tmpdir(), "pi-dw-out-"));
    try {
      withFakeHome(home, () => {
        const logger = createWorkflowLogger({
          runId: "run-override-test",
          cwd,
          persist: true,
          runsDir: customRuns,
        });
        logger.log("hello");
        const logFile = logger.persist();
        assert.equal(logFile, join(customRuns, "run-override-test.log"));
        assert.ok(existsSync(logFile), "log file must exist in the overridden dir");
        // And NOT in the default cwd-hashed runs dir.
        const defaultDir = workflowProjectPaths(cwd).runsDir;
        assert.ok(!existsSync(join(defaultDir, "run-override-test.log")));
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
      rmSync(customRuns, { recursive: true, force: true });
    }
  });

  it("falls back to the cwd-hashed runs dir when runsDir is omitted", () => {
    const home = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-project-"));
    try {
      withFakeHome(home, () => {
        const logger = createWorkflowLogger({
          runId: "run-default-test",
          cwd,
          persist: true,
        });
        logger.log("x");
        const logFile = logger.persist();
        const defaultDir = workflowProjectPaths(cwd).runsDir;
        assert.equal(logFile, join(defaultDir, "run-default-test.log"));
        assert.ok(existsSync(logFile));
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("resolves a relative runsDir against cwd", () => {
    const home = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-project-"));
    try {
      withFakeHome(home, () => {
        const logger = createWorkflowLogger({
          runId: "run-rel-test",
          cwd,
          persist: true,
          runsDir: "custom/rel/runs",
        });
        logger.log("x");
        const logFile = logger.persist();
        assert.equal(logFile, join(cwd, "custom", "rel", "runs", "run-rel-test.log"));
        assert.ok(existsSync(logFile));
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
