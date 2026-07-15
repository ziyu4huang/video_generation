import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	readPipelineDoc,
	writePipelineDoc,
	shouldDistill,
	findExistingRun,
	type MemoryPipelineDoc,
} from "../commands/memory-to-vault.ts";

describe("memory-to-vault pipeline.json", () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mtv-pl-")); });
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const base = (extra?: Partial<MemoryPipelineDoc>): MemoryPipelineDoc => ({
		schemaVersion: 1, createdAt: "t1", updatedAt: "t1", status: "running",
		options: { concurrency: 4, retries: 2, folder: "Z/knowledge-graph", threshold: 0.9 },
		scope: { files: [{ path: "/a.md", source: "hermes:MEMORY.md" }], fileCount: 1, excluded: 0 },
		stages: { "fan-out": { status: "pending" }, hygiene: { status: "pending" } },
		...extra,
	});

	test("write then read round-trips the doc", () => {
		const path = join(dir, "pipeline.json");
		writePipelineDoc(path, base());
		const back = readPipelineDoc(path);
		expect(back?.status).toBe("running");
		expect(back?.scope.fileCount).toBe(1);
		expect(back?.options.concurrency).toBe(4);
	});

	test("readPipelineDoc returns null for missing/corrupt file", () => {
		expect(readPipelineDoc(join(dir, "nope.json"))).toBeNull();
	});

	test("shouldDistill skips files already done unless force", () => {
		const doc = base({
			scope: {
				files: [{ path: "/done.md", source: "x" }, { path: "/new.md", source: "y" }],
				fileCount: 2, excluded: 0,
			},
			stages: {
				"fan-out": {
					status: "running",
					perFile: [
						{ path: "/done.md", status: "done", notesCreated: 5 },
						{ path: "/new.md", status: "error", error: "429" },
					],
				},
				hygiene: { status: "pending" },
			},
		});
		expect(shouldDistill(doc, false).sort()).toEqual(["/new.md"]);
		expect(shouldDistill(doc, true).sort()).toEqual(["/done.md", "/new.md"]);
	});
});

describe("findExistingRun (resume run-dir reuse)", () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mtv-run-")); });
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("returns null when no run dir exists", () => {
		expect(findExistingRun(dir)).toBeNull();
	});

	test("returns the newest run dir that has a pipeline.json", () => {
		const old = join(dir, "memory-to-vault-20260101-000000-old");
		const newer = join(dir, "memory-to-vault-20260102-000000-newer");
		mkdirSync(old, { recursive: true });
		mkdirSync(newer, { recursive: true });
		// only the newer one has a pipeline.json
		writePipelineDoc(join(newer, "pipeline.json"), {
			schemaVersion: 1, createdAt: "t", updatedAt: "t", status: "partial",
			options: { concurrency: 4, retries: 2, folder: "Z", threshold: 0.9 },
			scope: { files: [], fileCount: 0, excluded: 0 },
			stages: { "fan-out": { status: "partial" }, hygiene: { status: "pending" } },
		});
		expect(findExistingRun(dir)).toBe(newer);
	});

	test("ignores run dirs without a pipeline.json (incomplete init)", () => {
		const a = join(dir, "memory-to-vault-20260101-000000-a");
		mkdirSync(a, { recursive: true }); // no pipeline.json
		expect(findExistingRun(dir)).toBeNull();
	});
});
