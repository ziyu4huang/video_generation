import { describe, it, expect, beforeEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";

// Point the module at an isolated temp dir BEFORE importing it so tests never
// touch the real knowledge-base/code/.
const TMP = path.join(os.tmpdir(), "code-kb-test");
process.env.KB_CODE_ROOT = TMP;

import {
  appendCodeRecord,
  readAllCodeRecords,
  readCodeIndex,
  buildCodeReport,
} from "./code-knowledge";
import type { CodeKnowledgeRecord } from "./code-knowledge";

function makeRecord(over: Partial<CodeKnowledgeRecord> = {}): CodeKnowledgeRecord {
  return {
    runId: "2026-06-15T00-00-00",
    workflow: "gui-movie-director-self-improve",
    lanes: ["review", "schema"],
    effort: "low",
    fixApplied: false,
    openIssues: 5,
    findings: { verified: 3, newFindings: 3, bySeverity: { high: 1 }, byDimension: { security: 2 } },
    fixes: { mode: "review-only" },
    schema: { runtimeErrors: 1, runtimeFindings: 4, driftRemaining: 0 },
    filesTouched: [],
    timestamp: "2026-06-15T00-00-00",
    ...over,
  };
}

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});

describe("code-knowledge", () => {
  it("appendCodeRecord writes records.jsonl + index.json", () => {
    appendCodeRecord(makeRecord({ runId: "r1", openIssues: 7 }));
    expect(fs.existsSync(path.join(TMP, "records.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(TMP, "index.json"))).toBe(true);
  });

  it("index totalRuns increments, trend appends, lastRunId tracks", () => {
    appendCodeRecord(makeRecord({ runId: "r1", openIssues: 7 }));
    appendCodeRecord(makeRecord({ runId: "r2", openIssues: 3 }));
    const idx = readCodeIndex()!;
    expect(idx.totalRuns).toBe(2);
    expect(idx.lastRunId).toBe("r2");
    expect(idx.openIssuesTrend).toEqual([7, 3]);
  });

  it("openIssuesTrend caps at the last 50 runs", () => {
    for (let i = 0; i < 60; i++) {
      appendCodeRecord(makeRecord({ runId: `r${i}`, openIssues: i }));
    }
    const idx = readCodeIndex()!;
    expect(idx.totalRuns).toBe(60);
    expect(idx.openIssuesTrend.length).toBe(50);
    // Oldest 10 dropped; trend starts at run 10 (openIssues=10).
    expect(idx.openIssuesTrend[0]).toBe(10);
    expect(idx.openIssuesTrend[49]).toBe(59);
  });

  it("readAllCodeRecords returns every appended record in order", () => {
    appendCodeRecord(makeRecord({ runId: "r1" }));
    appendCodeRecord(makeRecord({ runId: "r2" }));
    const recs = readAllCodeRecords();
    expect(recs.length).toBe(2);
    expect(recs[0].runId).toBe("r1");
    expect(recs[1].runId).toBe("r2");
  });

  it("buildCodeReport aggregates mostBugProneFiles across runs", () => {
    appendCodeRecord(makeRecord({ runId: "r1", filesTouched: ["api/jobs.ts", "lib/sub.ts"] }));
    appendCodeRecord(makeRecord({ runId: "r2", filesTouched: ["api/jobs.ts", "api/x.ts"] }));
    const report = buildCodeReport();
    // api/jobs.ts touched twice → top of the list
    expect(report.mostBugProneFiles[0]).toEqual({ file: "api/jobs.ts", count: 2 });
    expect(report.mostBugProneFiles.find((f) => f.file === "lib/sub.ts")?.count).toBe(1);
  });

  it("buildCodeReport aggregates recurringDimensions from byDimension", () => {
    appendCodeRecord(makeRecord({ runId: "r1", findings: { verified: 2, newFindings: 2, bySeverity: {}, byDimension: { security: 3, correctness: 1 } } }));
    appendCodeRecord(makeRecord({ runId: "r2", findings: { verified: 1, newFindings: 1, bySeverity: {}, byDimension: { security: 2 } } }));
    const report = buildCodeReport();
    expect(report.recurringDimensions[0]).toEqual({ dimension: "security", count: 5 });
    expect(report.recurringDimensions.find((d) => d.dimension === "correctness")?.count).toBe(1);
  });

  it("buildCodeReport computes fixRate = applied / verified across history", () => {
    // run1: 4 verified, 2 applied. run2: review-only (0 applied), 6 verified.
    appendCodeRecord(makeRecord({ runId: "r1", findings: { verified: 4, newFindings: 4, bySeverity: {}, byDimension: {} }, fixes: { applied: 2, regressions: 0 } }));
    appendCodeRecord(makeRecord({ runId: "r2", findings: { verified: 6, newFindings: 6, bySeverity: {}, byDimension: {} }, fixes: { mode: "review-only" } }));
    const report = buildCodeReport();
    // applied=2, verified=10 → 20%
    expect(report.fixRate).toBe(20);
  });

  it("buildCodeReport on empty KB returns zeros + null latestRun", () => {
    const report = buildCodeReport();
    expect(report.totalRuns).toBe(0);
    expect(report.latestRun).toBeNull();
    expect(report.fixRate).toBe(0);
    expect(report.mostBugProneFiles).toEqual([]);
    expect(report.openIssuesTrend).toEqual([]);
  });

  it("latestRun is the most recently appended record", () => {
    appendCodeRecord(makeRecord({ runId: "r1", openIssues: 9 }));
    appendCodeRecord(makeRecord({ runId: "r2", openIssues: 4 }));
    const report = buildCodeReport();
    expect(report.latestRun?.runId).toBe("r2");
    expect(report.latestRun?.openIssues).toBe(4);
  });
});
