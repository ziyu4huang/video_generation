/**
 * P0 regression test for #347 — the stale-ctx crash guard in scheduleVaultBanner.
 *   bun test extensions/__tests__/banner-stale-ctx.test.mjs
 *
 * The pi runtime can deactivate the session ctx after a switch (/resume,
 * ctx.fork, ctx.switchSession): the `ctx.ui` getter then throws assertActive().
 * The banner's deferred ctx.ui calls live inside setTimeout callbacks that can
 * fire AFTER such a switch, so each must be guarded — otherwise the throw
 * becomes an uncaughtException that crashes pi.
 *
 * We drive scheduleVaultBanner directly (no pi runtime) with a controllable ctx
 * whose `ui` getter throws once marked stale, and a setTimeout shim that lets us
 * fire the deferred callbacks synchronously (instead of waiting 10s/8s).
 *
 * Mutation check: remove the try/catch in scheduleVaultBanner and the two
 * stale-ctx tests below MUST fail (proving they actually guard the crash, not
 * pass vacuously).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { scheduleVaultBanner } from "../obsidian.ts";

// ─── setTimeout shim ────────────────────────────────────────────────────────
// Capture timers instead of waiting 10s/8s. MUST restore globalThis.setTimeout
// after each test: bun:test shares one process across files, and a leaked mock
// would break every later test's own timers.
let origSetTimeout = null;
const pending = [];
function captureTimers() {
	origSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = (fn) => { pending.push(fn); return pending.length; };
}
function restoreTimers() {
	if (origSetTimeout) globalThis.setTimeout = origSetTimeout;
	origSetTimeout = null;
	pending.length = 0;
}
function fireNext() { const fn = pending.shift(); if (fn) fn(); }
function fireAll() { while (pending.length) fireNext(); }
afterEach(restoreTimers);

// ─── controllable ctx ───────────────────────────────────────────────────────
// `ui` getter throws once markStale() is called — mirrors the runtime's
// assertActive() failure on a post-switch SessionContext. Before stale,
// setWidget records its calls so we can assert what rendered.
function makeCtx() {
	let stale = false;
	const uiCalls = [];
	return {
		uiCalls,
		markStale() { stale = true; },
		get ui() {
			if (stale) throw new Error("SessionContext is no longer active");
			return {
				setWidget: (key, lines) => { uiCalls.push([key, lines]); },
			};
		},
	};
}

const LINE = "📓 obsidian vault active: test-vault";

describe("scheduleVaultBanner — stale-ctx crash guard (#347)", () => {
	it("happy path: shows the banner, then clears it", () => {
		captureTimers();
		const ctx = makeCtx();
		scheduleVaultBanner(ctx, LINE);
		fireAll(); // fires show (which schedules dismiss), then dismiss
		expect(ctx.uiCalls).toEqual([
			["obsidian-vault", [LINE]],
			["obsidian-vault", undefined],
		]);
	});

	it("show fires after ctx went stale → guard swallows, no throw, no dismiss scheduled", () => {
		captureTimers();
		const ctx = makeCtx();
		scheduleVaultBanner(ctx, LINE);
		ctx.markStale(); // session switch before the 10s show timer fires
		expect(() => fireAll()).not.toThrow();
		// show's setWidget threw → caught → early return → dismiss never scheduled
		expect(ctx.uiCalls).toEqual([]);
	});

	it("dismiss fires after ctx went stale (switch between show and dismiss) → guard swallows", () => {
		captureTimers();
		const ctx = makeCtx();
		scheduleVaultBanner(ctx, LINE);
		// fire show while ctx is still alive → records banner + schedules dismiss
		expect(() => fireNext()).not.toThrow();
		expect(ctx.uiCalls).toEqual([["obsidian-vault", [LINE]]]);
		// session switches before the 8s dismiss timer fires
		ctx.markStale();
		expect(() => fireNext()).not.toThrow();
		// dismiss's setWidget threw → caught → no second call recorded
		expect(ctx.uiCalls).toEqual([["obsidian-vault", [LINE]]]);
	});
});
