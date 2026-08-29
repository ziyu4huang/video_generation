import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../../src/distill/gate.ts";
import { runConverge } from "../../src/distill/converge.ts";
import { readState } from "../../src/distill/state.ts";
import type { MemoryEntry, EnrichedNote } from "../../src/distill/types.ts";

describe("distill full pipeline integration", () => {
	let vault: string;
	beforeAll(() => {
		vault = mkdtempSync(join(tmpdir(), "distill-pipeline-"));
	});
	afterAll(() => rmSync(vault, { recursive: true, force: true }));

	test("status → gate → enrich → converge → verify", async () => {
		// Seed raw memory entries (simulating hermes-memory bloat)
		const now = Date.now();
		const day = 86400000;
		const entries: MemoryEntry[] = [

			{ id: "m1", target: "failure", content: "LoRA alpha must match rank or training diverges", created: new Date(now - day).toISOString() },
			{ id: "m2", target: "failure", content: "LoRA alpha must match rank or training diverges.", created: new Date(now - day).toISOString() },
			{ id: "m3", target: "failure", content: "Use mlx-8bit quantization for memory savings on large models", created: new Date(now - day).toISOString() },
			{ id: "m4", target: "failure", content: "", created: new Date(now - day).toISOString() },
			{ id: "m5", target: "failure", content: "Old forgotten note from months ago", created: new Date(now - 120 * day).toISOString() },
			{ id: "m6", target: "failure", content: "Always pin bun.lock before merging extension PRs", created: new Date(now - day).toISOString() },
		];

		// Stage 1: gate
		const gateResult = runGate(entries, vault);
		expect(gateResult.candidates).toBe(6);
		expect(gateResult.survivors.length).toBe(3); // m2 dup, m4 malformed, m5 stale
		expect(gateResult.killed.length).toBe(3);
		const survivorIds = gateResult.survivors.map((s) => s.entry.id).sort();
		expect(survivorIds).toEqual(["m1", "m3", "m6"]);

		// Stage 2: agent enriches (simulated — produce structured notes)
		const enrichedNotes: EnrichedNote[] = [
			{ id: "distill:lora-alpha-rank", type: "gotcha", title: "LoRA alpha must match rank", detail: "When LoRA alpha differs from rank, training diverges with NaN loss. Always set alpha = rank for stable training across all model sizes.", tags: ["lora", "training", "mlx"] },
			{ id: "distill:mlx-8bit-memory", type: "lever", title: "MLX 8-bit quant saves memory", detail: "Use mlx-8bit quantization for about 50 percent memory reduction with minimal quality loss on Apple Silicon. Default dtype for production.", tags: ["mlx", "quantization"] },
			{ id: "distill:lock-pin-merge", type: "convention", title: "Pin bun.lock before merging", detail: "Always run bun install and commit bun.lock before merging extension PRs. CI uses frozen-lockfile and fails on stale lockfiles.", tags: ["bun", "ci", "convention"] },
		];

		// Stage 3: converge
		const metrics = { candidates: 6, killed: 3, survivors: 3 };
		const convergeResult = await runConverge(enrichedNotes, vault, metrics);
		expect(convergeResult.created + convergeResult.updated + convergeResult.unchanged).toBe(3);
		expect(convergeResult.passRate).toBe(1); // 3 converged / 3 survivors

		// Verify vault cards exist
		const graphDir = join(vault, "Zettelkasten", "knowledge-graph");
		expect(existsSync(graphDir)).toBe(true);
		const cards = readdirSync(graphDir).filter((f) => f.endsWith(".md"));
		expect(cards.length).toBeGreaterThanOrEqual(3);

		// Verify threshold adjusted in state
		const state = readState(vault);
		expect(state.history.length).toBe(1);
		expect(state.history[0].passRate).toBe(1);
		expect(state.lastRun).toBeTruthy();

		// Verify the per-run memory diff (ticket 14): written beside the
		// state, full shape, runId joined to state.lastRun.
		const diffFile = join(vault, ".distill-diff.json");
		expect(existsSync(diffFile)).toBe(true);
		const diff = convergeResult.diff!;
		expect(diff.runId).toBe(state.lastRun ?? "");
		expect(diff.target).toBe("failure");
		expect(diff.created.length).toBe(3);
		expect(diff.merged).toEqual([]);
		expect(diff.superseded).toEqual([]);
		expect(diff.skipped).toEqual([]);

		// Verify idempotency — second converge upserts
		const convergeResult2 = await runConverge(enrichedNotes, vault, metrics);
		expect(convergeResult2.created).toBe(0);
		expect(convergeResult2.updated + convergeResult2.unchanged).toBe(3);
		// …and the diff reflects the no-op run (nothing created/merged).
		expect(convergeResult2.diff?.created).toEqual([]);
		expect(convergeResult2.diff?.merged).toEqual([]);
	});
});
