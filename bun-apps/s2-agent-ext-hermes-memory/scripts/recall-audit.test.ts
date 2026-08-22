/**
 * recall-audit.mjs fixture test — CI-safe, zero network (ticket 04 acceptance).
 *
 * Spawns the committed harness (`bun-apps/scripts/recall-audit.mjs`) against a
 * TEMP corpus: hand-written kcard-format fixture cards + a 5-query battery,
 * kcard arm only, `--test-embedder` (deterministic hashing embedder — the
 * semantic blend runs without LM Studio). Asserts the receipt lands on disk,
 * corpus coverage is reported, and the graded metrics actually retrieve the
 * distinctive-tag fixture cards.
 *
 * Lives in hermes (the ticket owner) although the script itself is neutral
 * (bun-apps/scripts/) — spawning a subprocess creates no import edge, so the
 * dep-guard tier rule (TIER-0 hermes must not import TIER-1 knowledge-card)
 * stays intact.
 */
import { describe, it } from "bun:test";
import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUN_APPS = resolve(PKG_ROOT, "..");
const SCRIPT = join(BUN_APPS, "scripts", "recall-audit.mjs");

/** One kcard-format fixture card (frontmatter shape mirrors the live
 *  convergence folder: source_id/status/record_type/tags + H1 + body). */
function fixtureCard(id: string, tags: string[], title: string, body: string): string {
	return [
		"---",
		`id: "${id}"`,
		"created: 2026-08-22",
		`tags: [zettel, ${tags.join(", ")}]`,
		`sources: ["recall-audit-fixture"]`,
		`source: "recall-audit-fixture"`,
		`source_id: "${id}"`,
		"record_type: pattern",
		"status: active",
		"superseded_by: ",
		"confidence: 1",
		"dimension: project",
		"---",
		`# ${title}`,
		"",
		body,
		"",
	].join("\n");
}

describe("recall-audit harness (fixture corpus, offline)", () => {
	it("runs kcard-only against a temp corpus and produces a scored receipt", async () => {
		const tmp = mkdtempSync(join(PKG_ROOT, ".tmp-recall-audit-"));
		const vault = join(tmp, "vault");
		const folder = join(vault, "Zettelkasten", "knowledge-graph");
		mkdirSync(folder, { recursive: true });

		// Two distinctive-topic cards + one off-topic distractor.
		writeFileSync(
			join(folder, "fixture-aurora-constellation-deploy.md"),
			fixtureCard(
				"fixture:aurora-constellation-deploy",
				["aurora", "constellation", "deploy"],
				"Aurora constellation deploy",
				"Deploying the aurora constellation requires sequencing the relay handoff before the downlink window closes.",
			),
		);
		writeFileSync(
			join(folder, "fixture-harbor-lantern-mooring.md"),
			fixtureCard(
				"fixture:harbor-lantern-mooring",
				["harbor", "lantern", "mooring"],
				"Harbor lantern mooring",
				"Mooring at the harbor lantern berth needs a doubled spring line whenever the tidal range exceeds two meters.",
			),
		);
		writeFileSync(
			join(folder, "fixture-unrelated-thought.md"),
			fixtureCard(
				"fixture:unrelated-thought",
				["misc"],
				"Unrelated thought",
				"A generic note about nothing in particular, carrying no distinctive vocabulary.",
			),
		);

		const battery = {
			journal: [],
			kcard: [
				{ q: "sequencing the relay handoff before the downlink window closes", vaultTargets: ["fixture-aurora-constellation-deploy"] },
				{ q: "which berth needs a doubled spring line at high tidal range", vaultTargets: ["fixture-harbor-lantern-mooring"] },
				{ q: "aurora deploy sequence", vaultTargets: ["fixture-aurora-constellation-deploy"] },
				{ q: "harbor mooring line advice", vaultTargets: ["fixture-harbor-lantern-mooring"] },
				// Target card intentionally absent → coverage counter, not a scored miss.
				{ q: "completely absent topic glacier survey", vaultTargets: ["fixture-glacier-survey"] },
				{ q: "recipe for sourdough starter hydration ratios", negative: true },
			],
		};
		const batteryPath = join(tmp, "battery.json");
		writeFileSync(batteryPath, JSON.stringify(battery));

		const receiptPath = join(tmp, "receipt.json");
		// PORTABILITY-GUARDED: spawn via process.execPath (the running bun) —
		// never a PATH-dependent bare binary.
		const proc = Bun.spawnSync([
			process.execPath,
			SCRIPT,
			"--arm",
			"kcard",
			"--vault",
			vault,
			"--battery",
			batteryPath,
			"--test-embedder",
			"--receipt",
			receiptPath,
		], { cwd: BUN_APPS, stdout: "pipe", stderr: "pipe" });
		expect(proc.exitCode).toBe(0);

		const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
		expect(receipt.meta.embedder).toBe("test-hashing");
		expect(receipt.meta.k).toBe(5);
		expect(receipt.journal).toBeNull(); // journal arm not requested

		const kcard = receipt.kcard;
		expect(kcard.vaultCards).toBe(3);
		// Coverage: 4 graded queries, 1 absent target.
		expect(kcard.coverage.present).toBe(4);
		expect(kcard.coverage.absent).toBe(1);
		expect(kcard.coverage.absentQueries).toEqual(["completely absent topic glacier survey"]);

		// The distinctive-tag fixture cards must be retrievable (the harness's
		// whole point): target-present hit@5 = 4/4 here.
		expect(kcard.metricsTargetPresent.graded).toBe(4);
		expect(kcard.metricsTargetPresent.hitK).toBe(4);
		expect(kcard.metricsTargetPresent.misses).toBe(0);

		// Raw metrics include the absent-target query as a miss (5 graded, 4 hits).
		expect(kcard.metrics.graded).toBe(5);
		expect(kcard.metrics.hitK).toBe(4);

		rmSync(tmp, { recursive: true, force: true });
	}, 60000);
});
