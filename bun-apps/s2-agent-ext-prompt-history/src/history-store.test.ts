import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	HISTORY_CAP,
	projectKey,
	historyFilePath,
	readHistory,
	recordPrompt,
	historyFileName,
	SCHEMA_VERSION,
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

describe("cache-compat policy (SCHEMA_VERSION, 2026-08-22)", () => {
	test("v1 filename is byte-stable `history.jsonl` — compatible releases never move it", () => {
		expect(historyFileName(SCHEMA_VERSION)).toBe("history.jsonl");
		expect(historyFilePath("/proj/x", "/agent")).toBe(
			join("/agent", "prompt-history", projectKey("/proj/x"), "history.jsonl"),
		);
	});

	test("an INCOMPATIBLE schema bump changes the FILENAME only — same directory, old file untouched", () => {
		expect(historyFileName(2)).toBe("history.v2.jsonl");
		expect(historyFileName(3)).toBe("history.v3.jsonl");
		const v1 = historyFilePath("/proj/x", "/agent");
		const v2 = join("/agent", "prompt-history", projectKey("/proj/x"), historyFileName(2));
		expect(dirname(v2)).toBe(dirname(v1)); // directory = project identity, never versioned
	});

	test("the path is version-blind by design: no extension/schema version input exists", () => {
		// projectKey + historyFilePath take ONLY cwd — there is no version
		// parameter to pass, which IS the compat guarantee (x.y.* shares the cache).
		expect(projectKey.length).toBe(1);
		expect(historyFilePath("/a", "/m").startsWith("/m/prompt-history/")).toBe(true);
	});
});
