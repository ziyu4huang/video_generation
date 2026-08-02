/**
 * Tests for the miss-rate aggregator (wayfinder ticket 02).
 *
 * Exercises the full pipeline against a hand-crafted JSONL fixture with a known
 * shape: 3 sessions (one gated-domain with a confirmed common miss, one
 * non-gated-domain, one gated-domain with an escape but no miss), verifying
 * session segmentation, gated-domain detection, escape-rate, and the
 * confirmed-miss correlation + common/review labelling.
 */
import { describe, expect, it } from "bun:test";
import { computeMissRate, parseLog, promptMatchesGateIntent, segmentSessions } from "./miss-rate.ts";

// ts helpers — spaced to force session boundaries (> 30 min gap).
const T0 = "2026-08-01T09:00:00.000Z";
const m = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
const SIXTY = 60 * 60 * 1000; // 60 min — comfortably over the 30-min session gap

/** The fixture: see header comment for the intended shape. */
const FIXTURE = [
	// ── Session A (gated-domain): flux2 auto-fires; ltx missed + escape-recovered ──
	{ kind: "turn", ts: m(0), gatesFired: ["flux2"], dormantGates: ["ltx"], promptLen: 10, activeCount: 5, totalCount: 50, savedTok: 8000 },
	{ kind: "miss_candidate", ts: m(60_000), dormantGates: ["ltx"], promptHead: "generate a video of the scene" },
	{ kind: "activate", ts: m(120_000), via: "intent", intent: "make a video", matchedGate: ["ltx"], activated: ["ltx", "ltx_help"] },
	// ── Session B (NOT gated-domain): no gate fired, no escape ──
	{ kind: "turn", ts: m(SIXTY), gatesFired: [], dormantGates: ["flux2"], promptLen: 8, activeCount: 5, totalCount: 50, savedTok: 8000 },
	{ kind: "miss_candidate", ts: m(SIXTY + 60_000), dormantGates: ["flux2"], promptHead: "fix the typo in main.ts" },
	// ── Session C (gated-domain): ltx fires; escape with NO preceding miss → no confirmed-miss ──
	{ kind: "turn", ts: m(2 * SIXTY), gatesFired: ["ltx"], dormantGates: ["flux2"], promptLen: 12, activeCount: 5, totalCount: 50, savedTok: 8000 },
	{ kind: "activate", ts: m(2 * SIXTY + 60_000), via: "name", intent: "flux2", matchedGate: ["flux2"], activated: ["flux2", "flux2_help"] },
]
	.map((e) => JSON.stringify(e))
	.join("\n");

describe("miss-rate: parseLog + segmentSessions", () => {
	it("parses all lines and skips malformed ones", () => {
		const events = parseLog(FIXTURE + "\n{not json}\n\n");
		expect(events.length).toBe(7);
		expect(events[0].kind).toBe("turn");
	});

	it("segments at >30min gaps into 3 sessions", () => {
		const sessions = segmentSessions(parseLog(FIXTURE));
		expect(sessions.length).toBe(3);
		// A: gated-domain (flux2 fired + activate); B: not; C: gated-domain (ltx fired + activate)
		expect(sessions.map((s) => s.gatedDomain)).toEqual([true, false, true]);
	});
});

describe("miss-rate: computeMissRate", () => {
	const report = computeMissRate(parseLog(FIXTURE));

	it("counts 2 gated-domain sessions, both with escapes", () => {
		expect(report.gatedDomainSessions).toBe(2);
		expect(report.escapeSessions).toBe(2);
		expect(report.totalEscapes).toBe(2);
		expect(report.escapeSessionPct).toBe(100);
	});

	it("finds exactly 1 confirmed-miss (ltx in session A) and labels it common", () => {
		expect(report.confirmedMisses.length).toBe(1);
		const cm = report.confirmedMisses[0];
		expect(cm.gate).toBe("ltx");
		// "generate a video" → ltx requires noun "video" ∧ verb "generate" → common
		expect(cm.label).toBe("common");
		expect(cm.promptHead).toBe("generate a video of the scene");
	});

	it("does NOT confirm a miss when no miss_candidate precedes the activate (session C)", () => {
		// C's flux2 activate has no preceding miss_candidate → not a confirmed-miss
		expect(report.perGate.find((g) => g.gate === "flux2")).toBeUndefined();
	});

	it("reports the GO bar state from the common lens", () => {
		// 1 common miss → NO-GO signal (the bar is zero common)
		expect(report.commonMisses).toBe(1);
		expect(report.reviewMisses).toBe(0);
	});
});

describe("miss-rate: promptMatchesGateIntent", () => {
	it("matches a bare keyword", () => {
		expect(promptMatchesGateIntent("use ltx to render", "ltx")).toBe(true); // keyword "ltx"
	});
	it("matches a requires noun∧verb with no bare keyword", () => {
		expect(promptMatchesGateIntent("generate a video", "ltx")).toBe(true); // noun video ∧ verb generate
	});
	it("rejects a noun without its verb", () => {
		expect(promptMatchesGateIntent("the video is buffering", "ltx")).toBe(false); // noun video, no gen-verb
	});
	it("rejects an unrelated prompt", () => {
		expect(promptMatchesGateIntent("fix the typo", "ltx")).toBe(false);
	});
});
