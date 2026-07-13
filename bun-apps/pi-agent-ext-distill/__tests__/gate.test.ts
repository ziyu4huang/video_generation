import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../src/gate.ts";
import type { MemoryEntry } from "../src/types.ts";

describe("distill gate", () => {
	let vault: string;
	beforeAll(() => {
		vault = mkdtempSync(join(tmpdir(), "distill-gate-"));
		mkdirSync(join(vault, "Zettelkasten", "knowledge-graph"), { recursive: true });
	});
	afterAll(() => rmSync(vault, { recursive: true, force: true }));

	function entry(id: string, content: string, daysOld = 1): MemoryEntry {
		const ts = new Date(Date.now() - daysOld * 86400000).toISOString();
		return { id, target: "failure", content, created: ts, last: ts };
	}

	test("kills duplicates (near-identical content)", () => {
		const entries = [
			entry("a", "LoRA alpha must match rank or training diverges"),
			entry("b", "LoRA alpha must match rank or training diverges."),
			entry("c", "Use mlx-8bit quantization for memory savings"),
		];
		const result = runGate(entries, vault);
		expect(result.candidates).toBe(3);
		expect(result.killed.length).toBe(1);
		expect(result.killed[0].reason).toBe("duplicate");
		expect(result.survivors.length).toBe(2);
	});

	test("kills stale entries (no edits in 90+ days)", () => {
		const entries = [
			entry("fresh", "recent learning about something important", 5),
			entry("ancient", "old forgotten thing from months ago", 120),
		];
		const result = runGate(entries, vault);
		expect(result.killed.find((k) => k.entry.id === "ancient")?.reason).toBe("stale");
		expect(result.survivors.find((s) => s.entry.id === "fresh")).toBeTruthy();
	});

	test("kills malformed entries (empty content)", () => {
		const entries = [
			entry("good", "this is valid content"),
			entry("bad", ""),
		];
		const result = runGate(entries, vault);
		expect(result.killed.find((k) => k.entry.id === "bad")?.reason).toBe("malformed");
		expect(result.survivors.find((s) => s.entry.id === "good")).toBeTruthy();
	});

	test("kills duplicates against existing vault cards", () => {
		writeFileSync(
			join(vault, "Zettelkasten", "knowledge-graph", "existing.md"),
			`---\nid: existing\ntitle: "MLX 8-bit quant saves memory"\ntags: [mlx]\n---\nUse mlx-8bit quantization for memory savings.`,
		);
		const entries = [
			entry("dup", "Use mlx-8bit quantization for memory savings"),
			entry("new", "A brand new insight not found in the vault"),
		];
		const result = runGate(entries, vault);
		expect(result.killed.find((k) => k.entry.id === "dup")).toBeTruthy();
		expect(result.survivors.find((s) => s.entry.id === "new")).toBeTruthy();
	});
});
