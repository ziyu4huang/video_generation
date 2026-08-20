/**
 * report-persist.test.ts — cross-restart persistence for report frames.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendReport,
  loadReports,
  reportPersistPath,
  REPORT_RESTORE_CAP,
  type ReportFrame,
} from "../src/report-persist.js";

function frame(i: number): ReportFrame {
  return {
    type: "report",
    id: "report-test-" + i,
    title: "T" + i,
    source: "test",
    ts: i,
    markdown: "# body " + i,
  } as ReportFrame;
}

describe("report-persist", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "webui-rp-"));
    process.env["WEBUI_REPORT_DIR"] = dir;
  });
  afterAll(() => {
    delete process.env["WEBUI_REPORT_DIR"];
    rmSync(dir, { recursive: true, force: true });
  });

  test("path is per-port inside the dir; env override honored", () => {
    expect(reportPersistPath(8890)).toBe(join(dir, "reports-8890.jsonl"));
  });

  test("append + load round-trip preserves arrival order and fields", () => {
    const p = reportPersistPath(8891);
    appendReport(p, frame(1));
    appendReport(p, frame(2));
    const loaded = loadReports(p);
    expect(loaded.map((f) => f.id)).toEqual(["report-test-1", "report-test-2"]);
    expect(loaded[0]!.markdown).toBe("# body 1");
    expect(loaded[1]!.title).toBe("T2");
  });

  test("corrupt and non-report lines are skipped silently", () => {
    const p = reportPersistPath(8892);
    appendReport(p, frame(1));
    writeFileSync(p, "{ not json\n" + JSON.stringify({ type: "card", id: "x" }) + "\n", { flag: "a" });
    appendReport(p, frame(2));
    const loaded = loadReports(p);
    expect(loaded.map((f) => f.id)).toEqual(["report-test-1", "report-test-2"]);
  });

  test("restore cap: only the newest REPORT_RESTORE_CAP frames load", () => {
    const p = reportPersistPath(8893);
    for (let i = 0; i < REPORT_RESTORE_CAP + 5; i++) appendReport(p, frame(i));
    const loaded = loadReports(p);
    expect(loaded.length).toBe(REPORT_RESTORE_CAP);
    expect(loaded[0]!.id).toBe("report-test-5");
    expect(loaded[loaded.length - 1]!.id).toBe("report-test-" + (REPORT_RESTORE_CAP + 4));
  });

  test("appendReport never throws on an impossible path (best-effort contract)", () => {
    expect(() => appendReport("/proc/definitely/not/writable/reports.jsonl", frame(1))).not.toThrow();
  });

  test("loadReports on a missing file -> []", () => {
    expect(loadReports(join(dir, "nope", "reports-9999.jsonl"))).toEqual([]);
  });
});
