import { describe, test, expect } from "bun:test";
import { parsePiArgs } from "../args.ts";

describe("memory-to-vault flags", () => {
	test("parses --concurrency as a positive integer", () => {
		const p = parsePiArgs(["--concurrency", "4"]);
		expect(p.concurrency).toBe(4);
	});
	test("rejects --concurrency 0 (min 1)", () => {
		expect(() => parsePiArgs(["--concurrency", "0"])).toThrow(/concurrency/);
	});
	test("parses the value flags", () => {
		const p = parsePiArgs([
			"--only", "video_generation__*",
			"--files", "/a.md,/b.md",
			"--projects-dir", "/p",
			"--memory-dir", "/m",
		]);
		expect(p.only).toBe("video_generation__*");
		expect(p.filesCsv).toBe("/a.md,/b.md");
		expect(p.projectsDir).toBe("/p");
		expect(p.memoryDir).toBe("/m");
	});
	test("parses --verify as a boolean", () => {
		const p = parsePiArgs(["--verify"]);
		expect(p.verify).toBe(true);
	});
	test("reused flags still work (no regression)", () => {
		const p = parsePiArgs(["--retries", "3", "--retry-wait", "15", "--threshold", "0.85", "--max-notes", "40"]);
		expect(p.retries).toBe(3);
		expect(p.retryWaitSec).toBe(15);
		expect(p.threshold).toBe(0.85);
		expect(p.maxNotes).toBe(40);
	});
});
