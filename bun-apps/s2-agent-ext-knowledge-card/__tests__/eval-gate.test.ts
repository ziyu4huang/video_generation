/**
 * Ticket 09 (kcard-parity D26) — CI-safe eval-gate tripwire.
 *
 * Pins, at seconds scale (local_ci ≤5min budget):
 *   1. the D25 default-switch gate rule (pure — always runs);
 *   2. the three recall-audit arms' scoring code paths end-to-end against a
 *      temp corpus + deterministic hashing embedder — kcard (blend),
 *      kcard-hier (hierarchical, including the D23 body FTS lane and the
 *      stem/slug lane), kcard-flat-vector (pure KNN). Spawned as a
 *      subprocess with a THROWAWAY SurrealDB namespace; skipped when the
 *      local SurrealDB service is down (hermes _helpers pattern).
 *
 * The live 17/20 battery itself stays on-demand (D26) — LM Studio + the full
 * vault embeds do not fit CI. This file only pins that the gate machinery
 * runs and measures.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SurrealClient, SURREAL_DEFAULTS } from "@repo/s2-agent-core-interface";
import { evaluateDefaultSwitchGate } from "../src/hierarchical-retrieval.ts";

// ── 1. D25 gate rule (pure) ─────────────────────────────────────────────────

describe("evaluateDefaultSwitchGate (D25)", () => {
	const baseline = { hitK: 17, graded: 20, mrr: 0.688 };
	test("both metrics held → passes", () => {
		const v = evaluateDefaultSwitchGate(baseline, { hitK: 17, graded: 20, mrr: 0.7 });
		expect(v.passes).toBe(true);
		expect(v.reason).toContain("17/20");
	});
	test("hit@K tie but MRR under → fails (tie is not earned)", () => {
		expect(evaluateDefaultSwitchGate(baseline, { hitK: 17, graded: 20, mrr: 0.617 }).passes).toBe(false);
	});
	test("MRR over but hit@K under → fails", () => {
		expect(evaluateDefaultSwitchGate(baseline, { hitK: 16, graded: 20, mrr: 0.71 }).passes).toBe(false);
	});
	test("both improve → passes; both regress → fails", () => {
		expect(evaluateDefaultSwitchGate(baseline, { hitK: 18, graded: 20, mrr: 0.71 }).passes).toBe(true);
		expect(evaluateDefaultSwitchGate(baseline, { hitK: 15, graded: 20, mrr: 0.604 }).passes).toBe(false);
	});
});

// ── 2. three-arm fixture smoke (live Surreal, temp ns) ─────────────────────

async function isSurrealUp(endpoint: string = SURREAL_DEFAULTS.endpoint): Promise<boolean> {
	try {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), 1500);
		const res = await fetch(`${endpoint}/health`, { signal: ctrl.signal });
		clearTimeout(t);
		return res.ok || res.status === 200;
	} catch {
		return false;
	}
}

// Machine-coupled live section (local SurrealDB service): skipped under CI
// and when the service is down (test-portability P-classes; surreal-index-
// live.test.ts pattern).
const UP = process.env.CI ? false : await isSurrealUp();
const liveDescribe = (name: string, body: () => void) =>
	(UP ? describe : (describe.skip as typeof describe))(name, body);

function fixtureCard(id: string, title: string, body: string, extra: Record<string, string> = {}): string {
	return [
		"---",
		`id: "${id}"`,
		"created: 2026-08-23",
		"tags: [zettel, eval-gate-fixture]",
		'sources: ["eval-gate-fixture"]',
		`source_id: "${id}"`,
		"record_type: pattern",
		"status: active",
		...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
		"---",
		`# ${title}`,
		"",
		body,
		"",
	].join("\n");
}

liveDescribe("recall-audit three arms (fixture corpus, temp Surreal ns)", () => {
	let tmp: string;
	let vault: string;
	let batteryFile: string;
	let receiptFile: string;
	const ns = `kcard_evalgate_${process.pid}_${Date.now() % 100000}`;
	const FOLDER = "Zettelkasten/knowledge-graph";

	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), "kcard-eval-gate-"));
		const folder = join(tmp, "vault", FOLDER);
		mkdirSync(folder, { recursive: true });
		// Body lane target: the distinctive token lives ONLY in the body —
		// title/summary lanes cannot find it (D23 body FTS lane).
		writeFileSync(
			join(folder, "fixture-zephyr-telemetry-relay.md"),
			fixtureCard("zephyr-telemetry-relay", "relay card", "ordinary prose, then: zephyr telemetry beacon calibration notes live in the body", { summary: '"generic relay summary"' }),
		);
		// Stem-lane target: the stem names the topic; the body is off-topic.
		writeFileSync(
			join(folder, "fixture-orbital-docking-sequence.md"),
			fixtureCard("orbital-docking-sequence", "sequence card", "unrelated filler text about coffee grinding"),
		);
		writeFileSync(
			join(folder, "fixture-distractor-noise.md"),
			fixtureCard("distractor-noise", "noise card", "completely unrelated filler"),
		);
		const battery = {
			kcard: [
				{ q: "zephyr telemetry beacon calibration notes", vaultTargets: ["zephyr-telemetry-relay"] },
				{ q: "orbital docking sequence checklist", vaultTargets: ["orbital-docking-sequence"] },
			],
		};
		batteryFile = join(tmp, "battery.json");
		writeFileSync(batteryFile, JSON.stringify(battery));
		receiptFile = join(tmp, "receipt.json");
	});
	afterAll(async () => {
		rmSync(tmp, { recursive: true, force: true });
		if (UP) {
			try {
				// Throwaway namespace cleanup (best effort — a failed remove
				// never fails the test).
				const c = new SurrealClient({ endpoint: SURREAL_DEFAULTS.endpoint, namespace: ns, database: "context_db", username: SURREAL_DEFAULTS.username, password: SURREAL_DEFAULTS.password });
				await c.query(`REMOVE NAMESPACE ${ns};`);
			} catch {
				// already gone
			}
		}
	});

	test("all three arms run, report metrics, and the body/stem lanes retrieve their targets", () => {
		// import.meta.dir = <pkg>/__tests__ → ../../.. = bun-apps/scripts.
		const script = join(import.meta.dir, "..", "..", "scripts", "recall-audit.mjs");
		// Scratch the KCARD_* overrides: bun workers run test files
		// sequentially in one process, so a sibling file's module-top
		// `KCARD_USAGE_LOG=0` (tool-boundary suites) would otherwise leak into
		// this subprocess and silently disable exactly what this fixture pins.
		const env = { ...process.env };
		delete env.KCARD_USAGE_LOG;
		delete env.KCARD_INDEX_REBUILD;
		delete env.KCARD_HOTNESS_DEFAULT;
		const proc = spawnSync(
			"bun",
			[
				script,
				"--arm", "kcard,kcard-hier,kcard-flat-vector",
				"--vault", join(tmp, "vault"),
				"--battery", batteryFile,
				"--receipt", receiptFile,
				"--surreal-namespace", ns,
				"--test-embedder",
				// ticket 08: pin the D37 fold code path in CI (warmup plays the
				// battery through the throwaway-ns usage ledger first).
				"--hotness", "on",
				"--warmup", "1",
			],
			{ encoding: "utf8", timeout: 120_000, env },
		);
		expect(proc.status).toBe(0);
		const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
		for (const arm of ["kcard", "kcard-hier", "kcard-flat-vector"]) {
			// (the kcard arm's receipt predates the `available` field —
			// metrics presence is the availability signal there)
			expect(receipt[arm]?.metrics?.graded, `${arm} metrics`).toBe(2);
		}
		// Body lane end-to-end: the body-only token query must hit in hier.
		const bodyQuery = receipt["kcard-hier"].perQuery.find((p: { q: string }) => p.q.includes("zephyr"));
		expect(bodyQuery.rank).toBe(1);
		// ticket 08: the kcard arm measured with the fold armed + a fed ledger.
		expect(receipt.kcard.hotness).toEqual({ on: true, warmupRounds: 1, feedStems: expect.any(Number) });
		expect(receipt.kcard.hotness.feedStems).toBeGreaterThan(0);
	}, 180_000);
});
