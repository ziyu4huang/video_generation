/**
 * D5 backward-compat test: readPipelineDoc migrates the legacy `pipeline.json`
 * stage key "vlm-describe" → "file2md" so runs written before the rename resume
 * cleanly. New runs write "file2md" directly.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPipelineDoc } from "../commands/pdf-to-vault.ts";

describe("readPipelineDoc — D5 stage-key migration (vlm-describe → file2md)", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	/** Write a minimal pipeline.json with the given `stages` object. */
	function writeDoc(stages: Record<string, unknown>): string {
		dir = mkdtempSync(join(tmpdir(), "p2v-migrate-"));
		const path = join(dir, "pipeline.json");
		const doc = {
			schemaVersion: 1,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			input: "/tmp/x.pdf",
			inputName: "x.pdf",
			slug: "x",
			status: "running",
			options: {
				vlmModel: "lm-studio/google/gemma-4-12b",
				retries: 3,
				retryWaitSec: 10,
				deletePng: false,
				forceDistill: false,
			},
			stages,
		};
		writeFileSync(path, JSON.stringify(doc), "utf8");
		return path;
	}

	test("migrates a legacy 'vlm-describe' stage key → 'file2md'", () => {
		const path = writeDoc({
			"vlm-describe": { status: "done", pagesDone: 3, pagesTotal: 3 },
			distill: { status: "pending" },
		});
		const doc = readPipelineDoc(path);
		expect(doc).not.toBeNull();
		expect(doc!.stages["file2md"].status).toBe("done");
		expect(doc!.stages["file2md"].pagesDone).toBe(3);
		// legacy key is removed from the (mutated) raw object
		expect((doc!.stages as Record<string, unknown>)["vlm-describe"]).toBeUndefined();
	});

	test("leaves a doc that already uses 'file2md' untouched", () => {
		const path = writeDoc({
			file2md: { status: "done", pagesDone: 1, pagesTotal: 1 },
			distill: { status: "done", notesCreated: 2 },
		});
		const doc = readPipelineDoc(path);
		expect(doc).not.toBeNull();
		expect(doc!.stages["file2md"].status).toBe("done");
		expect(doc!.stages.distill.notesCreated).toBe(2);
	});

	test("returns null for a missing path", () => {
		expect(readPipelineDoc(join(tmpdir(), "p2v-does-not-exist.json"))).toBeNull();
	});
});
