import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../src/gate.ts";
import { runConverge } from "../src/converge.ts";
import { retrieveRecords } from "../../pi-agent-ext-knowledge-card/src/retrieve.ts";
import type { MemoryEntry } from "../src/types.ts";

/**
 * E2E for mechanism B (C1 fix): a raw hermes-style `pi-memory:failure:*` card
 * (simulating hermes auto-converge on session_shutdown) is upgraded by distill —
 * the gate treats it as an upgrade candidate (NOT killed), converge writes the
 * curated typed card AND supersedes the raw one, and retrieveRecords returns
 * ONLY the curated card (the superseded raw is excluded).
 *
 * Hermes's convergeToVault is simulated by writing the raw card directly (it
 * dynamic-imports peers and is awkward in a unit test); this still proves the
 * B end-to-end flow.
 */
describe("e2e: hermes raw → distill upgrade → retrieve curated only", () => {
	let vault: string;
	beforeAll(() => {
		vault = mkdtempSync(join(tmpdir(), "e2e-supersede-"));
		mkdirSync(join(vault, "Zettelkasten", "knowledge-graph"), { recursive: true });
		// Simulate hermes having auto-converged a raw failure card on shutdown.
		writeFileSync(
			join(vault, "Zettelkasten", "knowledge-graph", "raw.md"),
			`---\nid: "pi-memory:failure:h1"\nstatus: active\nsuperseded_by: ""\ntags: [pi-memory, target:failure, lora]\ncreated: 2026-07-14T00:00:00Z\n---\nLoRA alpha must match rank or training diverges with NaN loss\n`,
		);
	});
	afterAll(() => rmSync(vault, { recursive: true, force: true }));

	test("gate upgrades the raw card; converge supersedes it; retrieve returns only curated", async () => {
		const entry: MemoryEntry = {
			id: "m1",
			target: "failure",
			content: "LoRA alpha must match rank or training diverges with NaN loss",
			created: new Date().toISOString(),
		};

		// Stage 1 — gate: the raw card is an UPGRADE candidate (NOT killed).
		const g = runGate([entry], vault);
		expect(g.survivors.length).toBe(1);
		expect(g.killed.length).toBe(0);
		expect(g.survivors[0].supersedesCardId).toBe("pi-memory:failure:h1");

		// Stage 2 — agent enriches (simulated), threading supersedesCardId.
		const notes = [{
			id: "distill:lora-alpha-rank", type: "gotcha", title: "LoRA alpha must match rank",
			detail: "When LoRA alpha differs from rank, training diverges with NaN loss. Set alpha = rank for stable training.",
			tags: ["lora", "training"], confidence: 0.9,
			supersedesCardId: "pi-memory:failure:h1",
		}];

		// Stage 3 — converge: write curated card + supersede the raw one.
		await runConverge(notes as any, vault, { candidates: 1, killed: 0, survivors: 1 });

		// Stage 4 — retrieve: only the curated card is active; the raw is excluded.
		const r = await retrieveRecords({ vaultPath: vault, tags: ["lora"], topK: 10 });
		const ids = r.cards.map((c) => c.id);
		expect(ids).toContain("distill:lora-alpha-rank");
		expect(ids).not.toContain("pi-memory:failure:h1");
	});
});
