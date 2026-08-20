/**
 * Tests for formatPathologyReport — pure presentation over Finding[].
 */
import { test, expect, describe } from "bun:test";
import { formatPathologyReport } from "../format.ts";
import { analyzePathology } from "../detector.ts";
import type { ToolCallRecord } from "../types.ts";

describe("formatPathologyReport", () => {
  test("clean session (info-only) → header + healthy line, no severity sections", () => {
    const findings = analyzePathology({ calls: [], contextPercent: 30 });
    const text = formatPathologyReport(findings);
    expect(text).toContain("Inspect Pathology");
    expect(text).toContain("0 patholog");
    expect(text).toContain("No pathologies detected");
  });

  test("a high retry-loop finding is rendered under a High section", () => {
    const calls: ToolCallRecord[] = [
      { toolName: "bash", argsSig: '{"command":"npm test"}', isError: false, ts: 1 },
      { toolName: "bash", argsSig: '{"command":"npm test"}', isError: false, ts: 2 },
      { toolName: "bash", argsSig: '{"command":"npm test"}', isError: false, ts: 3 },
    ];
    const text = formatPathologyReport(analyzePathology({ calls, contextPercent: 10 }));
    expect(text).toContain("High");
    expect(text).toContain("retry");
  });

  test("recent-calls tail renders tool name + ok/ERR status", () => {
    const recent: ToolCallRecord[] = [
      { toolName: "bash", argsSig: '{"command":"ls"}', isError: false, ts: 1 },
      { toolName: "read", argsSig: '{"path":"a"}', isError: true, ts: 2 },
    ];
    const text = formatPathologyReport(analyzePathology({ calls: recent, contextPercent: 10 }), recent);
    expect(text).toContain("Recent tool calls");
    expect(text).toContain("bash");
    expect(text).toContain("read");
    expect(text).toContain("ERR");
  });
});
