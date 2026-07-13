import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConverge } from "../src/converge.ts";
import type { EnrichedNote, ConvergeMetrics } from "../src/types.ts";

describe("distill converge", () => {
	let vault: string;
	beforeAll(() => {
		vault = mkdtempSync(join(tmpdir(), "distill-converge-"));
	});
	afterAll(() => rmSync(vault, { recursive: true, force: true }));

	const metrics: ConvergeMetrics = { candidates: 10, killed: 6, survivors: 4 };

	const notes: EnrichedNote[] = [
		{ id: "distill:lora-alpha-rank", type: "gotcha", title: "LoRA alpha must match rank", detail: "When alpha and rank differ, LoRA training diverges. Always set alpha = rank for stable training.", tags: ["lora", "training"], confidence: 0.9 },
		{ id: "distill:mlx-8bit-memory", type: "lever", title: "MLX 8-bit quant saves memory", detail: "Use mlx-8bit quantization for 50 percent memory reduction with minimal quality loss on Apple Silicon.", tags: ["mlx", "quantization"] },
	];

	test("creates vault cards + converges into graph", async () => {
		const result = await runConverge(notes, vault, metrics);
		expect(result.created + result.updated + result.unchanged).toBe(2);
		expect(result.passRate).toBeGreaterThan(0);
		const graphDir = join(vault, "Zettelkasten", "knowledge-graph");
		expect(existsSync(graphDir)).toBe(true);
		const cards = readdirSync(graphDir).filter((f) => f.endsWith(".md"));
		expect(cards.length).toBeGreaterThanOrEqual(2);
	});

	test("updates state with new threshold", async () => {
		const result = await runConverge(notes, vault, metrics);
		expect(result.newThreshold).toBeGreaterThanOrEqual(20);
		expect(result.thresholdReason).toBeTruthy();
	});

	test("idempotent — second run upserts in place", async () => {
		await runConverge(notes, vault, metrics);
		const result2 = await runConverge(notes, vault, metrics);
		expect(result2.created).toBe(0);
		expect(result2.updated + result2.unchanged).toBe(2);
	});
});
