// tests/watchdog.test.ts

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runWatchdog } from "../src/watchdog/watchdog.js";

describe("runWatchdog orchestrator", () => {
  it("edit-gates when after == before (no change)", async () => {
    const r = await runWatchdog({
      cwd: process.cwd(),
      before: { root: "/r", key: "K", changedPaths: [] },
      opts: { l1: true, l2: false },
      taskLabel: "t",
      computeAfter: () => ({ root: "/r", key: "K", changedPaths: [] }),
    });
    assert.equal(r.editGated, true);
    assert.equal(r.ran, false);
  });

  it("runs L1 (mocked) + returns findings; L2 off by default", async () => {
    const r = await runWatchdog({
      cwd: process.cwd(),
      before: { root: "/r", key: "K1", changedPaths: [] },
      opts: { l1: true, l2: false },
      taskLabel: "t",
      computeAfter: () => ({ root: "/r", key: "K2", changedPaths: ["a.ts"] }),
      lsp: async () => ({
        ran: true,
        findings: [{ severity: "blocker", source: "lsp", path: "a.ts", line: 1, message: "boom" }],
      }),
    });
    assert.equal(r.editGated, false);
    assert.equal(r.l1.ran, true);
    assert.equal(r.l1.findings.length, 1);
    assert.equal(r.l2.ran, false);
    assert.match(r.summary, /1 .*finding|blocker/i);
  });

  it("surfaces degradation (not 'clean') when a layer didn't run with a note", async () => {
    const r = await runWatchdog({
      cwd: process.cwd(),
      before: { root: "/r", key: "K1", changedPaths: [] },
      opts: { l1: true, l2: false },
      taskLabel: "t",
      computeAfter: () => ({ root: "/r", key: "K2", changedPaths: ["a.ts"] }),
      lsp: async () => ({ ran: false, findings: [], note: "unavailable" }),
    });
    assert.equal(r.l1.ran, false);
    assert.equal(r.l1.findings.length, 0);
    assert.match(r.summary, /degraded/);
    assert.doesNotMatch(r.summary, /clean/);
  });

  it("L2 reviews ALL changed paths on a mixed change, not just TS/JS (ticket 05)", async () => {
    // tsJs would be ["src/a.ts"] only; ticket 05 makes L2 see every changed path.
    let captured: string[] | null = null;
    const r = await runWatchdog({
      cwd: "/r",
      before: { root: "/r", key: "K1", changedPaths: [] },
      opts: { l1: false, l2: true },
      taskLabel: "t",
      computeAfter: () => ({ root: "/r", key: "K2", changedPaths: ["src/a.ts", "pipeline/b.py"] }),
      diffForReview: (_cwd, paths) => {
        captured = paths;
        return { text: "", truncated: false, droppedNoiseFiles: [], truncatedFiles: [] };
      },
      modelReview: async () => ({ ran: true, findings: [] }),
    });
    assert.deepEqual(captured, ["src/a.ts", "pipeline/b.py"]); // both, not just TS/JS
    assert.equal(r.l2.ran, true);
  });

  it("summary surfaces L2 truncation + l2.truncated flag (ticket 04)", async () => {
    const r = await runWatchdog({
      cwd: "/r",
      before: { root: "/r", key: "K1", changedPaths: [] },
      opts: { l1: false, l2: true },
      taskLabel: "t",
      computeAfter: () => ({ root: "/r", key: "K2", changedPaths: ["a.ts"] }),
      diffForReview: () => ({ text: "...", truncated: true, droppedNoiseFiles: ["x.lock"], truncatedFiles: [] }),
      modelReview: async () => ({ ran: true, findings: [] }),
    });
    assert.equal(r.l2.truncated, true);
    assert.match(r.summary, /truncat/i);
  });
});
