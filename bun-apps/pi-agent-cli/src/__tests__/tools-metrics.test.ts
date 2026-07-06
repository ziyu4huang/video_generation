/**
 * Unit tests for `tools-metrics` — the pure parsing + aggregation core.
 *
 * The filesystem `run()` path is trivial wiring; the interesting math lives in
 * `parseSessionLines` + `computeMetrics` + `percentile`, exercised here against
 * tiny synthetic transcripts.
 */
import { test, expect, describe } from "bun:test";
import {
	parseSessionLines,
	computeMetrics,
	percentile,
	formatReport,
	formatJson,
} from "../commands/tools-metrics.ts";

// Build a transcript line from a partial event object.
function line(ev: Record<string, unknown>): string {
	return JSON.stringify(ev);
}

/** A minimal assistant toolCall event. */
function callEvent(toolCallId: string, name: string, iso: string): string {
	return line({
		type: "message",
		id: "m-" + toolCallId,
		timestamp: iso,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name }],
		},
	});
}

/** A minimal toolResult event. */
function resultEvent(
	toolCallId: string,
	name: string,
	iso: string,
	isError = false,
): string {
	return line({
		type: "message",
		id: "r-" + toolCallId,
		timestamp: iso,
		message: { role: "toolResult", toolCallId, toolName: name, isError },
	});
}

function sessionLine(cwd: string, iso: string): string {
	return line({ type: "session", version: 3, id: "s1", timestamp: iso, cwd });
}

/** Shared ISO timestamp helper: baseIso(n) → T00:00:0n.000Z. */
function baseIso(sec: number): string {
	return `2026-07-01T00:00:0${sec}.000Z`;
}

describe("parseSessionLines", () => {
	test("extracts toolCall blocks and toolResult messages with timestamps", () => {
		const scan = parseSessionLines([
			sessionLine("/proj/x", "2026-07-01T00:00:00.000Z"),
			callEvent("c1", "bash", "2026-07-01T00:00:01.000Z"),
			resultEvent("c1", "bash", "2026-07-01T00:00:02.000Z"),
		]);
		expect(scan.cwd).toBe("/proj/x");
		expect(scan.calls).toHaveLength(1);
		expect(scan.calls[0]).toEqual({ callId: "c1", name: "bash", t0: Date.parse("2026-07-01T00:00:01.000Z") });
		expect(scan.results).toHaveLength(1);
		expect(scan.results[0]!.isError).toBe(false);
	});

	test("skips blank and malformed lines", () => {
		const scan = parseSessionLines(["", "not json", "{", callEvent("c1", "read", "2026-07-01T00:00:00.000Z")]);
		expect(scan.calls).toHaveLength(1);
	});

	test("toolResult without callId still counted (synthetic orphan id)", () => {
		const scan = parseSessionLines([
			line({
				type: "message",
				timestamp: "2026-07-01T00:00:00.000Z",
				message: { role: "toolResult", toolName: "read", isError: false },
			}),
		]);
		expect(scan.results).toHaveLength(1);
		expect(scan.results[0]!.callId.startsWith("__orphan__")).toBe(true);
	});

	test("ignores bashExecution messages (avoid double counting)", () => {
		const scan = parseSessionLines([
			line({
				type: "message",
				timestamp: "2026-07-01T00:00:00.000Z",
				message: { role: "bashExecution", command: "ls", exitCode: 0 },
			}),
		]);
		expect(scan.calls).toHaveLength(0);
		expect(scan.results).toHaveLength(0);
	});
});

describe("computeMetrics", () => {
	test("counts calls/results/errors per tool and pairs latency", () => {
		const scan = parseSessionLines([
			sessionLine("/p", baseIso(0)),
			callEvent("c1", "bash", baseIso(1)),
			resultEvent("c1", "bash", baseIso(3)), // 2s
			callEvent("c2", "edit", baseIso(1)),
			resultEvent("c2", "edit", baseIso(2), true), // 1s, error
			callEvent("c3", "bash", baseIso(4)), // unmatched (no result)
		]);
		const r = computeMetrics([scan]);
		const bash = r.tools.find((t) => t.name === "bash")!;
		const edit = r.tools.find((t) => t.name === "edit")!;
		expect(bash.calls).toBe(2);
		expect(bash.results).toBe(1);
		expect(bash.errors).toBe(0);
		expect(bash.latencies).toEqual([2000]);
		expect(edit.calls).toBe(1);
		expect(edit.results).toBe(1);
		expect(edit.errors).toBe(1);
		expect(edit.latencies).toEqual([1000]);
		expect(r.totalCalls).toBe(3);
		expect(r.totalResults).toBe(2);
		expect(r.totalErrors).toBe(1);
		expect(r.sessions).toBe(1);
	});

	test("sorts tools by calls desc then name asc", () => {
		const scan = parseSessionLines([
			sessionLine("/p", baseIso(0)),
			callEvent("a", "rare", baseIso(1)),
			callEvent("b", "bash", baseIso(1)),
			callEvent("c", "bash", baseIso(1)),
		]);
		const r = computeMetrics([scan]);
		expect(r.tools.map((t) => t.name)).toEqual(["bash", "rare"]);
	});

	test("since/until window filters by session start", () => {
		const early = parseSessionLines([sessionLine("/p", "2026-06-01T00:00:00.000Z")]);
		const late = parseSessionLines([sessionLine("/p", "2026-07-15T00:00:00.000Z")]);
		const r = computeMetrics([early, late], {
			sinceMs: Date.parse("2026-07-01T00:00:00.000Z"),
		});
		expect(r.sessions).toBe(1); // only the late one
	});

	test("cwd substring filter is case-insensitive", () => {
		const a = parseSessionLines([sessionLine("/Users/me/Video_Gen", baseIso(0))]);
		const b = parseSessionLines([sessionLine("/other", baseIso(0))]);
		const r = computeMetrics([a, b], { cwdSubstr: "video_gen" });
		expect(r.sessions).toBe(1);
	});
});

describe("percentile", () => {
	test("nearest-rank on a known sample", () => {
		// 1..100, p50 → ceil(0.5*100)=50th element = 50
		const s = Array.from({ length: 100 }, (_, i) => i + 1);
		expect(percentile(s, 50)).toBe(50);
		expect(percentile(s, 95)).toBe(95);
		expect(percentile(s, 100)).toBe(100);
	});
	test("empty sample → 0", () => {
		expect(percentile([], 50)).toBe(0);
	});
});

describe("formatReport / formatJson", () => {
	test("text report has a header summary and a table row per tool", () => {
		const scan = parseSessionLines([
			sessionLine("/p", baseIso(0)),
			callEvent("c1", "bash", baseIso(1)),
			resultEvent("c1", "bash", baseIso(3)),
		]);
		const r = computeMetrics([scan]);
		const lines = formatReport(r);
		const joined = lines.join("\n");
		expect(joined).toContain("calls");
		expect(joined).toContain("bash");
		expect(joined).toContain("tools-metrics");
	});

	test("--details adds p95/max/mean columns", () => {
		const scan = parseSessionLines([
			sessionLine("/p", baseIso(0)),
			callEvent("c1", "bash", baseIso(1)),
			resultEvent("c1", "bash", baseIso(3)),
		]);
		const r = computeMetrics([scan]);
		const lean = formatReport(r).join("\n");
		const detail = formatReport(r, { details: true }).join("\n");
		expect(lean).not.toContain("p95");
		expect(detail).toContain("p95");
		expect(detail).toContain("max");
		expect(detail).toContain("mean");
	});

	test("--tool filter hides non-matching rows", () => {
		const scan = parseSessionLines([
			sessionLine("/p", baseIso(0)),
			callEvent("c1", "bash", baseIso(1)),
			callEvent("c2", "edit", baseIso(1)),
		]);
		const r = computeMetrics([scan]);
		const lines = formatReport(r, { toolFilter: ["ed"] }).join("\n");
		expect(lines).toContain("edit");
		expect(lines).not.toContain("bash");
	});

	test("--top truncates rows and notes hidden remainder", () => {
		const scan = parseSessionLines([
			sessionLine("/p", baseIso(0)),
			callEvent("c1", "bash", baseIso(1)),
			callEvent("c2", "edit", baseIso(1)),
			callEvent("c3", "read", baseIso(1)),
		]);
		const r = computeMetrics([scan]);
		const lines = formatReport(r, { top: 1 }).join("\n");
		expect(lines).toContain("more tools hidden");
	});

	test("json report parses and carries latencyMs", () => {
		const scan = parseSessionLines([
			sessionLine("/p", baseIso(0)),
			callEvent("c1", "bash", baseIso(1)),
			resultEvent("c1", "bash", baseIso(3)),
		]);
		const r = computeMetrics([scan]);
		const obj = JSON.parse(formatJson(r));
		expect(obj.totals.calls).toBe(1);
		expect(obj.tools[0].name).toBe("bash");
		expect(obj.tools[0].latencyMs.p50).toBe(2000);
	});
});
