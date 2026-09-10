/**
 * arc-run-record tests (self-arc-22 t01) — the bridge that makes arc-review
 * dispatches harvestable by name.
 *
 * The helper persists a STANDARD SubagentRunRecord (core-runtime's own API)
 * with `agentName` set. These tests pin, against a tmp home:
 *   1. the record file lands where reviewer-harvest's pi-runs FALLBACK scans;
 *   2. the keys that fallback matches (`agentName`, `status`, `output`)
 *      carry what the harvest contract expects — "done" yields the output as
 *      verdict, "failed" is terminal-without-verdict (PI_TERMINAL_FAILURES);
 *   3. both success AND failure outcomes save (a failed review must still be
 *      harvestable as errored, not invisible).
 *
 * The devops side (findPiRuns/parsePiRun) is pinned by reviewer-harvest's own
 * tests; the FULL cross-package round-trip is proven live in t04 (real
 * dispatch → real `reviewer-harvest --name` CLI → receipt, arc evidence).
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subagentRunsDir } from "@repo/s2-agent-core-runtime";
import { writeArcReviewRunRecord } from "../scripts/lib/arc-run-record.js";

const OKLINE = "review body… VERDICT: APPROVE";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "arc-run-record-"));
}

function outcome(overrides: Record<string, unknown> = {}) {
  return {
    name: "arc-reviewer",
    task: "review prompt text",
    model: "zai/glm-5.3",
    cwd: "/some/worktree",
    startedAt: new Date("2026-09-10T02:00:00Z"),
    elapsedMs: 183000,
    usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500, cost: 0.01 },
    turns: { turnsUsed: 12, maxTurns: 40 },
    output: OKLINE,
    ...overrides,
  };
}

describe("writeArcReviewRunRecord", () => {
  it("lands a harvestable record in <home>/.pi/subagents/runs on success", () => {
    const home = tmpHome();
    try {
      const runId = writeArcReviewRunRecord(outcome(), home);
      const runsDir = subagentRunsDir(home);
      const file = join(runsDir, `${runId}.json`);
      expect(existsSync(file)).toBe(true);
      const record = JSON.parse(readFileSync(file, "utf8"));
      expect(record.agentName).toBe("arc-reviewer"); // the harvest match key
      expect(record.status).toBe("done"); // verdict-bearing (NOT in PI_TERMINAL_FAILURES)
      expect(record.output).toBe(OKLINE); // the verdict text
      expect(record.model).toBe("zai/glm-5.3");
      expect(record.task).toBe("review prompt text");
      expect(record.usage.total).toBe(1500);
      expect(record.turns.turnsUsed).toBe(12);
      expect(record.error).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("saves FAILED dispatches too — terminal-without-verdict, never invisible", () => {
    const home = tmpHome();
    try {
      const runId = writeArcReviewRunRecord(outcome({ failure: { kind: "model" }, output: "" }), home);
      const file = join(subagentRunsDir(home), `${runId}.json`);
      const record = JSON.parse(readFileSync(file, "utf8"));
      expect(record.status).toBe("failed"); // in PI_TERMINAL_FAILURES → errored, not still-running
      expect(record.error).toContain("model");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("each dispatch gets a unique id (two saves → two files)", () => {
    const home = tmpHome();
    try {
      const id1 = writeArcReviewRunRecord(outcome(), home);
      const id2 = writeArcReviewRunRecord(outcome(), home);
      expect(id1).not.toBe(id2);
      expect(readdirSync(subagentRunsDir(home)).length).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("D3 empty-output guard (reviewer should-fix, self-arc-22)", () => {
	it("a blank-output 'success' saves as failed with the guard error — never still-running", () => {
		const home = tmpHome();
		try {
			const runId = writeArcReviewRunRecord(outcome({ output: "   " }), home);
			const record = JSON.parse(readFileSync(join(subagentRunsDir(home), `${runId}.json`), "utf8"));
			expect(record.status).toBe("failed"); // in PI_TERMINAL_FAILURES → harvests as errored
			expect(record.error).toContain("empty reviewer output");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
