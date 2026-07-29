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
});
