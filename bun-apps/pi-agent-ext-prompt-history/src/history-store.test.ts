import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HISTORY_CAP,
	projectKey,
	historyFilePath,
	readHistory,
	recordPrompt,
} from "./history-store.ts";

let agentDir: string;
beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "ph-store-"));
});

describe("projectKey", () => {
	test("is <slug>-<12hex> and stable per cwd, distinct across cwds", () => {
		const k = projectKey("/tmp/foo");
		expect(k).toMatch(/^[a-z0-9._-]+-[0-9a-f]{12}$/);
		expect(projectKey("/tmp/foo")).toBe(k);
		expect(projectKey("/tmp/bar")).not.toBe(k);
	});
});

describe("historyFilePath", () => {
	test("lives under prompt-history/<key>/history.jsonl", () => {
		expect(historyFilePath("/tmp/foo", agentDir)).toBe(
			join(agentDir, "prompt-history", projectKey("/tmp/foo"), "history.jsonl"),
		);
	});
});

describe("recordPrompt + readHistory", () => {
	test("records newest-first and round-trips", () => {
		recordPrompt("/tmp/foo", "hello", agentDir);
		recordPrompt("/tmp/foo", "world", agentDir);
		expect(readHistory("/tmp/foo", agentDir)).toEqual(["world", "hello"]);
	});

	test("skips empty / whitespace-only", () => {
		recordPrompt("/tmp/foo", "   ", agentDir);
		expect(readHistory("/tmp/foo", agentDir)).toEqual([]);
	});

	test("skips consecutive duplicate of most-recent (non-consecutive allowed)", () => {
		recordPrompt("/tmp/foo", "a", agentDir);
		recordPrompt("/tmp/foo", "b", agentDir);
		recordPrompt("/tmp/foo", "a", agentDir); // non-consecutive dup → kept
		expect(readHistory("/tmp/foo", agentDir)).toEqual(["a", "b", "a"]);
		recordPrompt("/tmp/foo", "a", agentDir); // consecutive dup → skipped
		expect(readHistory("/tmp/foo", agentDir)).toEqual(["a", "b", "a"]);
	});

	test("excludes ! bash lines", () => {
		recordPrompt("/tmp/foo", "!ls -la", agentDir);
		recordPrompt("/tmp/foo", "  !git status", agentDir);
		expect(readHistory("/tmp/foo", agentDir)).toEqual([]);
	});

	test("caps at HISTORY_CAP, retaining the newest", () => {
		for (let i = 0; i < HISTORY_CAP + 10; i++) recordPrompt("/tmp/foo", `p${i}`, agentDir);
		const h = readHistory("/tmp/foo", agentDir);
		expect(h.length).toBe(HISTORY_CAP);
		expect(h[0]).toBe(`p${HISTORY_CAP + 9}`);
	});

	test("isolates per cwd", () => {
		recordPrompt("/tmp/foo", "x", agentDir);
		recordPrompt("/tmp/bar", "y", agentDir);
		expect(readHistory("/tmp/foo", agentDir)).toEqual(["x"]);
		expect(readHistory("/tmp/bar", agentDir)).toEqual(["y"]);
	});

	test("readHistory returns [] when file missing or corrupt", () => {
		expect(readHistory("/tmp/never", agentDir)).toEqual([]);
	});
});
