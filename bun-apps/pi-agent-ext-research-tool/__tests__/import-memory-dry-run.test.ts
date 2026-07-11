/**
 * importMemory dry-run: parses + counts but does NOT write the JSONL file.
 * Pins the contract added for --dry-run globalization (no silent write).
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importMemory } from "../lib/import-memory.ts";

describe("importMemory — dry-run", () => {
	let hermesDir: string;
	let outDir: string;
	let outputPath: string;

	beforeEach(() => {
		hermesDir = mkdtempSync(join(tmpdir(), "hermes-dry-"));
		outDir = mkdtempSync(join(tmpdir(), "out-dry-"));
		outputPath = join(outDir, "study_news.jsonl");
		// One §-delimited entry in MEMORY.md → parseable.
		writeFileSync(
			join(hermesDir, "MEMORY.md"),
			"§ <!-- created=2026-07-11 --> A durable global fact for testing import.",
		);
	});

	afterEach(() => {
		rmSync(hermesDir, { recursive: true, force: true });
		rmSync(outDir, { recursive: true, force: true });
	});

	test("dryRun=true → no file written, counts still accurate", () => {
		const res = importMemory(outputPath, hermesDir, true);
		// counts reflect what WOULD be imported
		expect(res.total).toBe(1);
		expect(res.added).toBe(1);
		expect(res.existing).toBe(0);
		// the output file must NOT exist (no write)
		expect(existsSync(outputPath)).toBe(false);
	});

	test("dryRun=false (default) → writes the JSONL file", () => {
		const res = importMemory(outputPath, hermesDir, false);
		expect(res.added).toBe(1);
		expect(existsSync(outputPath)).toBe(true);
		const written = readFileSync(outputPath, "utf-8").trim();
		expect(written.length).toBeGreaterThan(0);
		expect(JSON.parse(written).fact).toContain("durable global fact");
	});

	test("dryRun on a collection that already has the id → existing=1, no write", () => {
		// first, materialize the entry (not dry-run)
		importMemory(outputPath, hermesDir, false);
		const before = existsSync(outputPath);
		// second dry-run pass: the id already exists → would add 0
		const res = importMemory(outputPath, hermesDir, true);
		expect(res.added).toBe(0);
		expect(res.existing).toBe(1);
		expect(before).toBe(true);
	});
});
