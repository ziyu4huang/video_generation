import { test } from "bun:test";
import assert from "node:assert/strict";
import { isSddReportActionable, parseSddReport, SDD_REPORT_STATUSES } from "@repo/pi-agent-ext-core-runtime";

const FULL_DONE = `
- **Status:** DONE
- Commits: abc1234 feat: hook, def5678 fix: flag
- 14/14 passing, output pristine
- The report file path: .planning/effort/tickets/task-1-report.md
`.trim();

test("parseSddReport returns undefined when there is no **Status:** marker (non-SDD output)", () => {
  assert.equal(parseSddReport("just some regular subagent prose"), undefined);
  assert.equal(parseSddReport(""), undefined);
  assert.equal(parseSddReport(undefined), undefined);
});

test("parseSddReport extracts status reliably (the canonical SDD block)", () => {
  const r = parseSddReport(FULL_DONE);
  assert.equal(r?.status, "DONE");
});

test("parseSddReport distinguishes DONE vs DONE_WITH_CONCERNS (prefix trap)", () => {
  assert.equal(parseSddReport("- **Status:** DONE")?.status, "DONE");
  assert.equal(parseSddReport("- **Status:** DONE_WITH_CONCERNS")?.status, "DONE_WITH_CONCERNS");
  assert.equal(parseSddReport("- **Status:** BLOCKED")?.status, "BLOCKED");
  assert.equal(parseSddReport("- **Status:** NEEDS_CONTEXT")?.status, "NEEDS_CONTEXT");
});

test("parseSddReport is case-insensitive on the enum but normalizes to canonical case", () => {
  assert.equal(parseSddReport("- **Status:** done")?.status, "DONE");
  assert.equal(parseSddReport("- **Status:** Blocked")?.status, "BLOCKED");
});

test("parseSddReport best-effort extracts commits (short SHAs), test summary, report file", () => {
  const r = parseSddReport(FULL_DONE);
  assert.deepEqual(r?.commits, ["abc1234", "def5678"]);
  assert.match(r?.testSummary ?? "", /14\/14 passing/);
  assert.equal(r?.reportFile, ".planning/effort/tickets/task-1-report.md");
});

test("parseSddReport omits best-effort fields that are not cleanly present", () => {
  const r = parseSddReport("- **Status:** DONE");
  assert.equal(r?.status, "DONE");
  assert.equal(r?.commits, undefined);
  assert.equal(r?.testSummary, undefined);
  assert.equal(r?.reportFile, undefined);
});

test("SDD_REPORT_STATUSES lists all four canonical statuses", () => {
  assert.deepEqual([...SDD_REPORT_STATUSES].sort(), ["BLOCKED", "DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT"]);
});

test("isSddReportActionable flags the statuses the controller must act on", () => {
  assert.equal(isSddReportActionable("BLOCKED"), true);
  assert.equal(isSddReportActionable("NEEDS_CONTEXT"), true);
  assert.equal(isSddReportActionable("DONE_WITH_CONCERNS"), true);
  assert.equal(isSddReportActionable("DONE"), false);
});
