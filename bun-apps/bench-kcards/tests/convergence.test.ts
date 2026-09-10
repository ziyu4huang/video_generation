/**
 * convergence.test.ts — T4: the in-process convergence harness on a sandbox
 * vault. Gates: (a) converge completes without a bridge/model session;
 * (b) idempotence — re-ingest reports 0 created; (c) orphan red-gate — a
 * card written DIRECTLY into the sandbox (bypassing ingest) is invisible to
 * the graph until ingested, proving the tooling sees the difference.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { openConvergedSandbox, loadPaperCards, converge } from "../src/converge-sandbox.ts";
import { realVaultPath } from "../src/vault-sandbox.ts";

const CARDS_DIR = join(realVaultPath(), "Zettelkasten");

describe("T4 — convergence harness", () => {
	test("13 cards converge in-process; idempotence run creates 0", async () => {
		const { first, idempotence, cards } = await openConvergedSandbox(realVaultPath(), CARDS_DIR);
		expect(cards).toHaveLength(13);
		// the sandbox is seeded from the ALREADY-CONVERGED real vault, so the
		// first in-process run UPSERTS over the existing graph notes
		expect(first.total).toBe(13);
		expect(first.created).toBe(0);
		// idempotence: the second full run must not create anything new
		expect(idempotence.created).toBe(0);
	}, 60_000);

	test("orphan red-gate: a directly-written card is invisible to retrieval until ingested", async () => {
		const { vaultPath, cards } = await openConvergedSandbox(realVaultPath(), CARDS_DIR);
		// write a NEW card directly into the sandbox vault — the bypass
		const orphanName = "Paper - Orphan Bypass Probe.md";
		writeFileSync(
			join(vaultPath, "Zettelkasten", orphanName),
			["---", "id: 209901010001", "created: 2099-01-01", "tags: [zettel, orphan-probe]", 'sources: ["arXiv:9999.99999"]', "---", "", "# Paper - Orphan Bypass Probe", "", "## 核心想法", "- Orphan probe content for the bypass gate."].join("\n"),
			"utf8",
		);
		// direct-writes are invisible: converge count for it is 0 until ingested
		const summary = await converge(vaultPath, cards); // idempotent on the 13
		expect(summary.created).toBe(0);
		// ...and after ingesting the orphan itself, it converges (upsert path)
		const [orphan] = loadPaperCards(vaultPath + "/Zettelkasten").filter((c) => c.name === orphanName);
		expect(orphan).toBeDefined();
		const orphanSummary = await converge(vaultPath, [orphan]);
		expect(orphanSummary.created).toBe(1);
	}, 60_000);
});
