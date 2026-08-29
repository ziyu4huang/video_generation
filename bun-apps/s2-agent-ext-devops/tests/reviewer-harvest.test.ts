/**
 * reviewer-harvest tests — pinned to FIXTURE transcripts copied from real
 * shapes (tests/fixtures/reviewer-harvest/): the t01 injection probe
 * (thinking blocks + tool trail + SendMessage record + end_turn verdict),
 * a mid-flight truncation (still-running), and a synthetic `<synthetic>`
 * API-error line (errored, the real 429 death shape measured 2026-08-27).
 *
 * Everything runs against a temp harness tree + temp repo root via the
 * injectable HarvestIo — no test touches the live ~/.claude-glm root.
 */
import { describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	utimesSync,
	copyFileSync,
	readdirSync as readdirSyncRaw,
	statSync as statSyncRaw,
	existsSync as existsSyncRaw,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseTranscript,
	findTranscripts,
	harvest,
	writeReceipt,
	receiptFileName,
	type HarvestIo,
} from "../src/reviewer-harvest.js";
import { runReviewerHarvestCli, REVIEWER_HARVEST_USAGE } from "../scripts/reviewer-harvest.js";

const FIXTURES = join(import.meta.dir, "fixtures", "reviewer-harvest");

/** Real-fs io with an injected clock + no-op sleep (tests never actually wait). */
function testIo(over?: Partial<HarvestIo>): HarvestIo {
	return {
		readdirSync: (p) => readdirSyncRaw(p),
		readFileSync: (p, enc) => readFileSync(p, enc),
		statSync: (p) => statSyncRaw(p),
		writeFileSync,
		existsSync: (p) => existsSyncRaw(p),
		mkdirSync,
		sleep: async () => {},
		now: () => new Date("2026-08-29T09:00:00Z"),
		...over,
	};
}

function fixtureLines(name: string): string[] {
	return readFileSync(join(FIXTURES, name), "utf8").split("\n");
}

/** Build a temp harness tree with the given transcript files laid out per name → mtime. */
function tempHarness(files: Array<{ file: string; from: string; mtimeMs: number }>): {
	root: string;
} {
	const root = mkdtempSync(join(tmpdir(), "rh-harness-"));
	const subagents = join(root, "projects", "proj-x", "11111111-1111-1111-1111-111111111111", "subagents");
	mkdirSync(subagents, { recursive: true });
	for (const f of files) {
		const dest = join(subagents, f.file);
		copyFileSync(join(FIXTURES, f.from), dest);
		const d = new Date(f.mtimeMs);
		utimesSync(dest, d, d);
	}
	return { root };
}

describe("parseTranscript — fixture-pinned terminal states", () => {
	test("completed: t01 probe — verdict is the LAST end_turn assistant text", () => {
		const parsed = parseTranscript(fixtureLines("completed-probe.jsonl"));
		expect(parsed.status).toBe("completed");
		expect(parsed.verdict).toContain("INJECTION-PROBE-MARKER");
		expect(parsed.verdict).toContain("Movie Director");
		expect(parsed.lineCount).toBe(8);
		expect(parsed.sendMessages).toHaveLength(1);
		expect(parsed.sendMessages[0].to).toBe("main");
		expect(parsed.sendMessages[0].message).toContain("INJECTION-PROBE-MARKER");
	});

	test("completed: timestamps come from the real entries, not assumed", () => {
		const parsed = parseTranscript(fixtureLines("completed-probe.jsonl"));
		expect(parsed.firstTimestamp).toMatch(/^2026-08-29T/);
		expect(parsed.lastTimestamp).toMatch(/^2026-08-29T/);
	});

	test("still-running: truncated probe (ends on a tool_result) has no verdict", () => {
		const parsed = parseTranscript(fixtureLines("still-running.jsonl"));
		expect(parsed.status).toBe("still-running");
		expect(parsed.verdict).toBeUndefined();
		expect(parsed.lineCount).toBe(5);
	});

	test("errored: synthetic 429 line wins over the earlier turns", () => {
		const parsed = parseTranscript(fixtureLines("errored-429.jsonl"));
		expect(parsed.status).toBe("errored");
		expect(parsed.error).toContain("429");
		expect(parsed.verdict).toBeUndefined();
	});

	test("errored-then-recovered: an end_turn AFTER the error is the verdict", () => {
		const lines = fixtureLines("errored-429.jsonl");
		lines.push(
			JSON.stringify({
				type: "assistant",
				timestamp: "2026-08-27T14:00:00.000Z",
				message: {
					role: "assistant",
					stop_reason: "end_turn",
					content: [{ type: "text", text: "RECOVERED — verdict after the rate limit" }],
				},
			}),
		);
		const parsed = parseTranscript(lines);
		expect(parsed.status).toBe("completed");
		expect(parsed.verdict).toBe("RECOVERED — verdict after the rate limit");
	});

	test("torn trailing line (writer mid-append) stays still-running, not a crash", () => {
		const lines = fixtureLines("still-running.jsonl");
		lines.push('{"type":"assistant","timestamp":"2026-08-27T14:00:00.000Z","mess');
		const parsed = parseTranscript(lines);
		expect(parsed.status).toBe("still-running");
		expect(parsed.lineCount).toBe(6);
	});
});

describe("findTranscripts — name match + newest selection", () => {
	test("exact name prefix: `probe` does not match `probe2`", () => {
		const { root } = tempHarness([
			{ file: "agent-aprobe2-aaaaaaaaaaaaaaaa.jsonl", from: "still-running.jsonl", mtimeMs: 300_000 },
			{ file: "agent-aprobe-bbbbbbbbbbbbbbbb.jsonl", from: "still-running.jsonl", mtimeMs: 200_000 },
		]);
		const found = findTranscripts({ harnessRoot: root, name: "probe", io: testIo() });
		expect(found).toHaveLength(1);
		expect(found[0].path).toContain("agent-aprobe-");
	});

	test("newest by mtime wins across sessions and projects", () => {
		const root = mkdtempSync(join(tmpdir(), "rh-harness-"));
		const older = join(root, "projects", "proj-a", "aaaa-aaaa", "subagents");
		const newer = join(root, "projects", "proj-b", "bbbb-bbbb", "subagents");
		mkdirSync(older, { recursive: true });
		mkdirSync(newer, { recursive: true });
		copyFileSync(join(FIXTURES, "still-running.jsonl"), join(older, "agent-arev-older1.jsonl"));
		copyFileSync(join(FIXTURES, "completed-probe.jsonl"), join(newer, "agent-arev-newer1.jsonl"));
		utimesSync(join(older, "agent-arev-older1.jsonl"), new Date(100_000), new Date(100_000));
		utimesSync(join(newer, "agent-arev-newer1.jsonl"), new Date(999_000), new Date(999_000));
		const found = findTranscripts({ harnessRoot: root, name: "rev", io: testIo() });
		expect(found[0].path).toContain("agent-arev-newer1.jsonl");
	});

	test("no projects dir → empty (caller reports absent)", () => {
		const root = mkdtempSync(join(tmpdir(), "rh-harness-"));
		expect(findTranscripts({ harnessRoot: root, name: "x", io: testIo() })).toEqual([]);
	});
});

describe("harvest — end-to-end over the temp tree", () => {
	test("completed: verdict + receipt written under repo output/", async () => {
		const { root } = tempHarness([
			{ file: "agent-ainjection-probe-c27137ca99032335.jsonl", from: "completed-probe.jsonl", mtimeMs: 500_000 },
		]);
		const repoRoot = mkdtempSync(join(tmpdir(), "rh-repo-"));
		const result = await harvest({ name: "injection-probe", harnessRoot: root, repoRoot, io: testIo() });
		expect(result.status).toBe("completed");
		expect(result.verdict).toContain("INJECTION-PROBE-MARKER");
		expect(result.attempts).toBe(1);
		expect(result.receipt?.path).toContain(join("output", "reviewer-harvest"));
		const receipt = JSON.parse(readFileSync(result.receipt!.path, "utf8"));
		expect(receipt.status).toBe("completed");
		expect(receipt.transcriptPath).toBe(result.transcriptPath);
		expect(receipt.verdict).toBe(result.verdict);
		expect(receipt.dispatchedAt).toBe(result.dispatchedAt);
		expect(receipt.harvestedAt).toBe("2026-08-29T09:00:00.000Z");
	});

	test("receipt idempotence: re-harvest same terminal state = byte-identical, no rewrite", async () => {
		const { root } = tempHarness([
			{ file: "agent-ainjection-probe-c27137ca99032335.jsonl", from: "completed-probe.jsonl", mtimeMs: 500_000 },
		]);
		const repoRoot = mkdtempSync(join(tmpdir(), "rh-repo-"));
		const first = await harvest({ name: "injection-probe", harnessRoot: root, repoRoot, io: testIo() });
		const before = readFileSync(first.receipt!.path, "utf8");
		const second = await harvest({
			name: "injection-probe",
			harnessRoot: root,
			repoRoot,
			io: testIo({ now: () => new Date("2026-08-29T10:00:00Z") }),
		});
		expect(second.receipt?.unchanged).toBe(true);
		expect(second.receipt?.overwritten).toBe(false);
		expect(readFileSync(second.receipt!.path, "utf8")).toBe(before); // first harvestedAt survives
	});

	test("still-running within timeout: polls, then reports still-running (no receipt)", async () => {
		const { root } = tempHarness([
			{ file: "agent-arev-r1-0123456789abcdef.jsonl", from: "still-running.jsonl", mtimeMs: 500_000 },
		]);
		const repoRoot = mkdtempSync(join(tmpdir(), "rh-repo-"));
		const sleeps: number[] = [];
		let t = Date.parse("2026-08-29T09:00:00Z");
		const result = await harvest({
			name: "rev-r1",
			harnessRoot: root,
			repoRoot,
			timeoutMs: 10_000,
			pollMs: 4_000,
			io: testIo({
				sleep: async (ms) => {
					sleeps.push(ms);
					t += ms;
				},
				now: () => new Date(t),
			}),
		});
		expect(result.status).toBe("still-running");
		expect(result.receipt).toBeUndefined();
		expect(result.attempts).toBe(4); // t=0, 4s, 8s, 10s (last sleep clamped by the deadline)
		expect(sleeps).toEqual([4000, 4000, 2000]);
	});

	test("absent: no match at all", async () => {
		const root = mkdtempSync(join(tmpdir(), "rh-harness-"));
		const result = await harvest({
			name: "nobody",
			harnessRoot: root,
			repoRoot: mkdtempSync(join(tmpdir(), "rh-repo-")),
			io: testIo(),
		});
		expect(result.status).toBe("absent");
		expect(result.transcriptPath).toBeUndefined();
		expect(result.attempts).toBe(1);
	});

	test("errored: reports the API error, still writes a receipt (it IS a terminal verdict)", async () => {
		const { root } = tempHarness([
			{ file: "agent-arev-e1-0123456789abcdef.jsonl", from: "errored-429.jsonl", mtimeMs: 500_000 },
		]);
		const result = await harvest({
			name: "rev-e1",
			harnessRoot: root,
			repoRoot: mkdtempSync(join(tmpdir(), "rh-repo-")),
			io: testIo(),
		});
		expect(result.status).toBe("errored");
		expect(result.error).toContain("429");
		const receipt = JSON.parse(readFileSync(result.receipt!.path, "utf8"));
		expect(receipt.status).toBe("errored");
	});
});

describe("writeReceipt + receiptFileName", () => {
	test("filename is deterministic in (name, transcriptPath)", () => {
		expect(receiptFileName("rev", "/a/b.jsonl")).toBe(receiptFileName("rev", "/a/b.jsonl"));
		expect(receiptFileName("rev", "/a/b.jsonl")).not.toBe(receiptFileName("rev", "/a/c.jsonl"));
		expect(receiptFileName("rev", "/a/b.jsonl")).toMatch(/^rev-[0-9a-f]{8}\.json$/);
	});
});

describe("runReviewerHarvestCli — throw-free JSON contract", () => {
	test("--help: usage on stderr, exit 0, stdout empty", async () => {
		const res = await runReviewerHarvestCli(["--help"]);
		expect(res.exitCode).toBe(0);
		expect(res.stdout).toBe("");
		expect(res.stderr).toBe(REVIEWER_HARVEST_USAGE);
	});

	test("missing --name: exit 2", async () => {
		const res = await runReviewerHarvestCli([]);
		expect(res.exitCode).toBe(2);
		expect(res.stderr).toContain("--name is required");
	});

	test("unknown flag: exit 2", async () => {
		const res = await runReviewerHarvestCli(["--name", "x", "--bogus"]);
		expect(res.exitCode).toBe(2);
		expect(res.stderr).toContain("unknown flag");
	});

	test("completed run: exit 0, stdout is the parsed HarvestResult", async () => {
		const { root } = tempHarness([
			{ file: "agent-ainjection-probe-c27137ca99032335.jsonl", from: "completed-probe.jsonl", mtimeMs: 500_000 },
		]);
		const repoRoot = mkdtempSync(join(tmpdir(), "rh-repo-"));
		const res = await runReviewerHarvestCli(
			["--name", "injection-probe", "--harness-root", root, "--repo-root", repoRoot],
			{ io: testIo() },
		);
		expect(res.exitCode).toBe(0);
		const parsed = JSON.parse(res.stdout);
		expect(parsed.status).toBe("completed");
		expect(parsed.verdict).toContain("INJECTION-PROBE-MARKER");
	});

	test("still-running run: exit 1, JSON still parses", async () => {
		const { root } = tempHarness([
			{ file: "agent-arev-r2-0123456789abcdef.jsonl", from: "still-running.jsonl", mtimeMs: 500_000 },
		]);
		const res = await runReviewerHarvestCli(
			["--name", "rev-r2", "--harness-root", root, "--repo-root", mkdtempSync(join(tmpdir(), "rh-repo-"))],
			{ io: testIo() },
		);
		expect(res.exitCode).toBe(1);
		expect(JSON.parse(res.stdout).status).toBe("still-running");
	});
});
