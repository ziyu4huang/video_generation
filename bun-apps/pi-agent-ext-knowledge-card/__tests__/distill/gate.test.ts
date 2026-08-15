import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../../src/distill/gate.ts";
import type { MemoryEntry } from "../../src/distill/types.ts";

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

	test("raw pi-memory card match → upgrade candidate (NOT killed)", () => {
		// Seed a raw hermes-style card (active, id pi-memory:...) — quoted id because
		// colon-containing scalars are quoted by ingest.ts yamlScalar.
		writeFileSync(
			join(vault, "Zettelkasten", "knowledge-graph", "raw-up.md"),
			`---\nid: "pi-memory:failure:hash1"\nstatus: active\nsuperseded_by: ""\ntags: [zettel]\n---\nLoRA alpha must match rank or training diverges\n`,
		);
		const entries = [
			entry("x", "LoRA alpha must match rank or training diverges"), // matches raw → upgrade
			entry("y", "A brand new insight about gpu memory allocation"), // no match → survive
		];
		const result = runGate(entries, vault);
		expect(result.killed.length).toBe(0);
		expect(result.survivors.length).toBe(2);
		const up = result.survivors.find((s) => s.entry.id === "x");
		expect(up?.supersedesCardId).toBe("pi-memory:failure:hash1");
		expect(up?.reason).toMatch(/upgrade/i);
	});

	test("raw hermes: card match → upgrade candidate (F3 — the live hub adapter id)", () => {
		// The CURRENT hub auto-converge (convergeHermesMemory → adaptHermesMarkdown)
		// mints `hermes:<slug>` ids, not `pi-memory:*`. The gate must treat those
		// as upgrade candidates too, or every auto-converged card is killed as a
		// "duplicate" and the curated upgrade path never fires (C1 doc↔code drift).
		writeFileSync(
			join(vault, "Zettelkasten", "knowledge-graph", "hermes-up.md"),
			`---\nid: "hermes:lora-alpha-rank"\nstatus: active\nsuperseded_by: ""\ntags: [zettel, hermes]\n---\nLoRA alpha must match rank or training diverges\n`,
		);
		const entries = [
			entry("h", "LoRA alpha must match rank or training diverges"), // matches hermes raw → upgrade
			entry("k", "A brand new insight about kv cache memory"), // no match → survive
		];
		const result = runGate(entries, vault);
		expect(result.killed.length).toBe(0);
		expect(result.survivors.length).toBe(2);
		const up = result.survivors.find((s) => s.entry.id === "h");
		expect(up?.supersedesCardId).toBe("hermes:lora-alpha-rank");
		expect(up?.reason).toMatch(/upgrade/i);
	});

	test("curated (distill:) card match → killed as true duplicate", () => {
		writeFileSync(
			join(vault, "Zettelkasten", "knowledge-graph", "curated-dup.md"),
			`---\nid: "distill:already-done"\nstatus: active\nsuperseded_by: ""\ntags: [zettel]\n---\nFlux2 needs explicit guidance scale override\n`,
		);
		const entries = [entry("z", "Flux2 needs explicit guidance scale override")];
		const result = runGate(entries, vault);
		expect(result.killed.length).toBe(1);
		expect(result.killed[0].reason).toBe("duplicate");
	});

	test("already-superseded raw card → killed (not re-upgraded)", () => {
		writeFileSync(
			join(vault, "Zettelkasten", "knowledge-graph", "sup.md"),
			`---\nid: "pi-memory:failure:hash2"\nstatus: superseded\nsuperseded_by: "distill:old"\ntags: [zettel]\n---\nPin bun lockfile before merging extension PRs\n`,
		);
		const entries = [entry("w", "Pin bun lockfile before merging extension PRs")];
		const result = runGate(entries, vault);
		expect(result.killed.length).toBe(1);
		expect(result.killed[0].reason).toBe("duplicate");
	});
});
