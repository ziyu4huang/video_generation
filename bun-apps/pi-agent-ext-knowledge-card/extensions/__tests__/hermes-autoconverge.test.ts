/**
 * ADR-0001: hermes-memory convergence now lives in the HUB (knowledge-card),
 * NOT in hermes. Tests convergeHermesMemory() directly with explicit paths
 * (no resolveVault/env coupling — mirrors retrieve.bench.test.ts). Verifies
 * the behavior moved without losing the auto-converge, and that hermes needs
 * no upward dependency edge.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convergeHermesMemory } from "../knowledge-card.ts";

describe("ADR-0001 hub convergeHermesMemory", () => {
	let vault: string;
	let hermesDir: string;

	beforeEach(() => {
		vault = mkdtempSync(join(tmpdir(), "kc-vault-"));
		hermesDir = mkdtempSync(join(tmpdir(), "kc-hermes-"));
		// Two §-separated hermes entries (the adaptHermesMarkdown shape).
		writeFileSync(
			join(hermesDir, "MEMORY.md"),
			'[insight] **cfg-scale 7 sharpens flux2 detail**\nverified 2026-07-18\n§\n[tool-quirk] obsidian append_section needs bare heading text\n<!-- created=2026-07-12, last=2026-07-12 -->\n',
			"utf8",
		);
	});

	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
		rmSync(hermesDir, { recursive: true, force: true });
	});

	it("converges hermes §-entries into the vault knowledge-graph folder", async () => {
		const summary = await convergeHermesMemory(vault, hermesDir);
		assert.ok(summary, "returned a summary");
		assert.ok(
			(summary.created + summary.updated) >= 2,
			`≥2 cards converged (got created=${summary.created} updated=${summary.updated})`,
		);
		assert.ok(existsSync(join(vault, "Zettelkasten", "knowledge-graph")), "folder created");
		const cards = readdirSync(join(vault, "Zettelkasten", "knowledge-graph")).filter((f) => f.endsWith(".md"));
		const all = cards.map((c) => c.toLowerCase()).join(" ");
		assert.match(all, /cfg-scale|sharpens|flux2/);
		assert.match(all, /append_section|bare.heading|tool.quirk/);
	});

	it("returns null when the hermes dir is absent (hermes not installed)", async () => {
		rmSync(hermesDir, { recursive: true, force: true });
		const summary = await convergeHermesMemory(vault, hermesDir);
		assert.equal(summary, null);
	});

	it("is idempotent — re-converge upserts in place, no duplicate cards", async () => {
		await convergeHermesMemory(vault, hermesDir);
		const summary2 = await convergeHermesMemory(vault, hermesDir);
		assert.ok(summary2, "second run returns a summary");
		assert.equal(summary2.created, 0, "no NEW cards on re-converge (canonical-id idempotency)");
	});
});
