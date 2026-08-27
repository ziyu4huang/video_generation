/**
 * overlay.ts (cc-parity-task ticket 03): the composite-widget loop section is
 * now a FACE ONLY — it renders from the __piWakeupLoops cross-extension seam
 * (ultracode's WakeupRegistry), never from in-package state. These tests pin
 * the seam read + rendering; the retired scheduler/persistence semantics
 * moved to s2-agent-ext-ultracode's tests (wakeup-registry/wakeup-persistence).
 */

import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { LoopOverlay, readWakeupLoops } from "../overlay.js";

const T0 = Date.parse("2026-08-28T12:00:00Z");

function installSeam(loops: unknown): void {
	(globalThis as Record<string, unknown>).__piWakeupLoops = () => loops;
}
function removeSeam(): void {
	delete (globalThis as Record<string, unknown>).__piWakeupLoops;
}

beforeEach(() => removeSeam());
afterEach(() => removeSeam());

test("readWakeupLoops: [] when ultracode is not loaded (no seam) or publishes junk", () => {
	assert.deepEqual(readWakeupLoops(), []);
	installSeam("not-an-array");
	assert.deepEqual(readWakeupLoops(), []);
});

test("readWakeupLoops: the seam's pending list passes through", () => {
	const loops = [{ id: "loop-1", prompt: "check CI", mode: "fixed", delaySeconds: 300, dueAt: T0 + 60_000, fireCount: 2 }];
	installSeam(loops);
	assert.equal(readWakeupLoops().length, 1);
	assert.equal(readWakeupLoops()[0]!.id, "loop-1");
});

test("render: one line per pending loop with id, mode, cadence, fire count, countdown", () => {
	const originalNow = Date.now;
	Date.now = () => T0;
	try {
		installSeam([
			{ id: "loop-1", prompt: "check CI", mode: "fixed", delaySeconds: 300, dueAt: T0 + 120_000, fireCount: 2 },
			{ id: "loop-2", prompt: "watch deploy", mode: "dynamic", dueAt: T0 + 30_000, fireCount: 5 },
		]);
		const overlay = new LoopOverlay();
		const lines = overlay.render({} as never, 200);
		assert.equal(lines.length, 2);
		assert.match(lines[0]!, /\/loop loop-1 \[fixed\] every 5m · fired 2× · next in 120s · check CI/);
		assert.match(lines[1]!, /\/loop loop-2 \[dynamic\] dynamic · fired 5× · next in 30s · watch deploy/);
	} finally {
		Date.now = originalNow;
	}
});

test("render: [] when the registry is empty", () => {
	installSeam([]);
	const overlay = new LoopOverlay();
	assert.deepEqual(overlay.render({} as never, 200), []);
});

test("polling refreshes only while loops are pending, and dispose stops the timer", async () => {
	installSeam([]);
	let refreshes = 0;
	const overlay = new LoopOverlay();
	overlay.setRefresh(() => {
		refreshes += 1;
	});
	overlay.startPolling();
	await new Promise((r) => setTimeout(r, 80));
	assert.equal(refreshes, 0, "empty registry — no refresh churn");
	installSeam([{ id: "loop-1", prompt: "p", mode: "fixed", delaySeconds: 60, dueAt: T0, fireCount: 0 }]);
	overlay.startPolling(); // restart at the (test-scale) cadence is still 30s — flush manually
	overlay.update(undefined); // interface-compat update still refreshes
	assert.equal(refreshes, 1);
	overlay.dispose();
});
