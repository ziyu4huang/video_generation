/**
 * Tests for the convergence health + state observability module (Track 1, Phase 1.2).
 * Pure unit tests — no dynamic imports, no vault, no LLM. Just the JSON
 * bookkeeping + reconciliation + report formatting.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	entryHash,
	loadConvergeState,
	saveConvergeState,
	loadHealth,
	saveHealth,
	aggregateOverall,
	computeReconciliation,
	formatHealthReport,
	MAX_HISTORY,
	STATE_FILENAME,
	HEALTH_FILENAME,
	type ConvergeHealthRecord,
} from "../../src/store/converge-health.js";

describe("converge-health — state + health bookkeeping", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "converge-health-test-"));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("entryHash is deterministic and content-sensitive", () => {
		assert.equal(entryHash("same entry"), entryHash("same entry"));
		assert.notEqual(entryHash("entry A"), entryHash("entry B"));
		// Stable shape: base36, no randomness.
		assert.match(entryHash("x"), /^[0-9a-z]+$/);
	});

	it("loadConvergeState returns {} for missing/corrupt files", () => {
		assert.deepEqual(loadConvergeState(dir), {});
		fs.writeFileSync(path.join(dir, STATE_FILENAME), "{not json");
		assert.deepEqual(loadConvergeState(dir), {});
	});

	it("saveConvergeState / loadConvergeState round-trip", () => {
		saveConvergeState(dir, { memory: ["a", "b"], failure: ["c"] });
		assert.deepEqual(loadConvergeState(dir), { memory: ["a", "b"], failure: ["c"] });
	});

	it("loadHealth returns empty for missing/corrupt files", () => {
		assert.deepEqual(loadHealth(dir), { latest: null, history: [] });
		fs.writeFileSync(path.join(dir, HEALTH_FILENAME), "{broken");
		assert.deepEqual(loadHealth(dir), { latest: null, history: [] });
	});

	it("saveHealth sets latest + prepends history, capped at MAX_HISTORY", () => {
		const mk = (i: number): ConvergeHealthRecord => ({
			lastRunAt: new Date(2026, 0, i + 1).toISOString(),
			triggeredBy: "passive",
			overall: "ok",
			timedOut: false,
			targets: [],
		});
		for (let i = 0; i < MAX_HISTORY + 3; i++) saveHealth(dir, mk(i));
		const state = loadHealth(dir);
		assert.equal(state.history.length, MAX_HISTORY, "history capped");
		// latest == most recent saved (mk(MAX_HISTORY+2) has the latest date).
		assert.equal(state.latest?.lastRunAt, mk(MAX_HISTORY + 2).lastRunAt);
		assert.equal(state.history[0].lastRunAt, state.latest?.lastRunAt, "newest-first");
	});
});

describe("converge-health — aggregateOverall", () => {
	it("failed beats unavailable beats ok", () => {
		assert.equal(aggregateOverall(["ok", "ok"]), "ok");
		assert.equal(aggregateOverall(["ok", "unavailable"]), "unavailable");
		assert.equal(aggregateOverall(["ok", "unavailable", "failed"]), "failed");
		assert.equal(aggregateOverall(["failed", "unavailable"]), "failed");
		assert.equal(aggregateOverall([]), "ok");
	});
});

describe("converge-health — computeReconciliation", () => {
	it("counts converged vs unconverged using entryHash", () => {
		const e1 = "first durable fact";
		const e2 = "second durable fact";
		const e3 = "never converged fact";
		const state = {
			memory: [entryHash(e1), entryHash(e2)], // e1, e2 converged; e3 not
		};
		const recon = computeReconciliation({ memory: [e1, e2, e3] }, state);
		assert.equal(recon.length, 1);
		assert.equal(recon[0].target, "memory");
		assert.equal(recon[0].total, 3);
		assert.equal(recon[0].converged, 2);
		assert.equal(recon[0].unconverged, 1);
	});

	it("an edited entry (new hash) counts as unconverged", () => {
		const original = "original text";
		const edited = "original text BUT edited";
		const state = { memory: [entryHash(original)] };
		const recon = computeReconciliation({ memory: [edited] }, state);
		assert.equal(recon[0].converged, 0);
		assert.equal(recon[0].unconverged, 1);
	});

	it("empty store → zero unconverged", () => {
		const recon = computeReconciliation({ memory: [] }, {});
		assert.equal(recon[0].unconverged, 0);
	});
});

describe("converge-health — formatHealthReport", () => {
	it("reports 'no run recorded' when empty", () => {
		const report = formatHealthReport({ latest: null, history: [] }, []);
		assert.match(report, /No convergence run recorded/);
	});

	it("surfaces an unavailable run + the live unconverged gap", () => {
		const latest: ConvergeHealthRecord = {
			lastRunAt: new Date().toISOString(),
			triggeredBy: "passive",
			overall: "unavailable",
			timedOut: false,
			targets: [
				{ target: "memory", seen: 5, newEntries: 2, converged: 0, skipped: 3, status: "unavailable", reason: "pi-knowledge-card not installed" },
			],
			reason: "pi-knowledge-card not installed",
		};
		const recon = [{ target: "memory", total: 5, converged: 3, unconverged: 2 }];
		const report = formatHealthReport({ latest, history: [latest] }, recon);
		assert.match(report, /UNAVAILABLE/);
		assert.match(report, /pi-knowledge-card not installed/);
		assert.match(report, /2 entri/);
		assert.match(report, /memory: 2\/5 unconverged/);
	});

	it("reports all-converged when reconciliation is clean", () => {
		const latest: ConvergeHealthRecord = {
			lastRunAt: new Date().toISOString(),
			triggeredBy: "passive",
			overall: "ok",
			timedOut: false,
			targets: [{ target: "memory", seen: 3, newEntries: 0, converged: 0, skipped: 3, status: "ok" }],
		};
		const report = formatHealthReport({ latest, history: [latest] }, [{ target: "memory", total: 3, converged: 3, unconverged: 0 }]);
		assert.match(report, /All working-memory entries are converged/);
	});
});
