import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, writeState } from "../../src/distill/state.ts";
import type { DistillState } from "../../src/distill/types.ts";

describe("distill state", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "distill-state-"));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("readState returns default when no state file", () => {
		const state = readState(dir);
		expect(state.threshold).toBe(50);
		expect(state.history).toEqual([]);
		expect(state.lastRun).toBeNull();
	});

	test("writeState → readState round-trip", () => {
		const state: DistillState = {
			threshold: 45,
			history: [
				{
					ts: "2026-07-13T14:00:00Z",
					target: "failure",
					candidates: 73,
					killed: 45,
					survivors: 28,
					converged: 26,
					killRate: 0.62,
					passRate: 0.93,
				},
			],
			lastRun: "2026-07-13T14:00:00Z",
		};
		writeState(dir, state);
		const read = readState(dir);
		expect(read.threshold).toBe(45);
		expect(read.history.length).toBe(1);
		expect(read.history[0].passRate).toBe(0.93);
		expect(read.lastRun).toBe("2026-07-13T14:00:00Z");
	});

	test("history capped at 50 entries", () => {
		const state: DistillState = { threshold: 50, history: [], lastRun: null };
		for (let i = 0; i < 60; i++) {
			state.history.push({
				ts: `2026-07-${i}`,
				target: "failure",
				candidates: 10,
				killed: 5,
				survivors: 5,
				converged: 4,
				killRate: 0.5,
				passRate: 0.8,
			});
		}
		writeState(dir, state);
		const read = readState(dir);
		expect(read.history.length).toBe(50);
	});

	test("readState resets to default on corrupt state file (no throw)", () => {
		// Ticket 05: a corrupt .distill-state.json must not crash converge —
		// cards are already written by the time readState runs, so a throw
		// leaves a partial converge + no result returned. Reset to the empty
		// default (same as a missing file) so converge completes and the
		// subsequent writeState overwrites the corrupt file (self-healing).
		const corruptDir = mkdtempSync(join(tmpdir(), "distill-state-corrupt-"));
		try {
			writeFileSync(join(corruptDir, ".distill-state.json"), "{ this is not valid json }}}");
			const state = readState(corruptDir);
			expect(state.threshold).toBe(50);
			expect(state.history).toEqual([]);
			expect(state.lastRun).toBeNull();
		} finally {
			rmSync(corruptDir, { recursive: true, force: true });
		}
	});
});
