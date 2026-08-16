/**
 * startup-banner.test.ts — unit tests for scheduleReadyBanner, the above-editor
 * startup banner that replaced the scary "Warning: zai-mcp ready" notify hack.
 *   bun test extensions/__tests__/startup-banner.test.ts
 *
 * The banner is driven by two nested setTimeout callbacks (show @5s, dismiss
 * @5s+8s). The pi runtime can deactivate the session ctx after a switch
 * (/resume, ctx.fork, ctx.switchSession): the `ctx.ui` getter then throws
 * assertActive(). Because the banner's deferred calls can fire AFTER such a
 * switch, each must be guarded — otherwise the throw becomes an
 * uncaughtException that crashes pi (the #347-class bug obsidian's
 * banner-stale-ctx.test.mjs guards).
 *
 * We drive scheduleReadyBanner directly (no pi runtime) with a controllable
 * ctx whose `ui` getter throws once marked stale, and a setTimeout shim that
 * fires the deferred callbacks synchronously (instead of waiting 5s/8s).
 *
 * Mutation check: remove either try/catch in scheduleReadyBanner and the two
 * stale-ctx tests below MUST fail (proving they guard the crash, not pass
 * vacuously).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { scheduleReadyBanner } from "../zai-mcp.ts";

// ─── setTimeout shim ────────────────────────────────────────────────────────
// Capture timers instead of waiting 5s/8s. MUST restore globalThis.setTimeout
// after each test: bun:test shares one process across files, and a leaked mock
// would break every later test's own timers.
let origSetTimeout: typeof setTimeout | null = null;
const pending: Array<() => void> = [];
function captureTimers(): void {
	origSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void) => {
		pending.push(fn);
		return pending.length;
	}) as unknown as typeof setTimeout;
}
function restoreTimers(): void {
	if (origSetTimeout) globalThis.setTimeout = origSetTimeout;
	origSetTimeout = null;
	pending.length = 0;
}
function fireNext(): void {
	const fn = pending.shift();
	if (fn) fn();
}
function fireAll(): void {
	while (pending.length) fireNext();
}
afterEach(restoreTimers);

// ─── controllable ctx ───────────────────────────────────────────────────────
// `ui` getter throws once markStale() is called — mirrors the runtime's
// assertActive() failure on a post-switch SessionContext. Before stale,
// setWidget records its calls so we can assert what rendered.
function makeCtx() {
	let stale = false;
	const uiCalls: Array<[string, string[] | undefined]> = [];
	return {
		uiCalls,
		markStale(): void {
			stale = true;
		},
		get ui(): { setWidget(key: string, lines: string[] | undefined): void } {
			if (stale) throw new Error("SessionContext is no longer active");
			return {
				setWidget: (key, lines) => {
					uiCalls.push([key, lines]);
				},
			};
		},
	};
}

const SUCCESS_LINES = [
	"🛰 zai-mcp ready — 2 tool(s) · 2 server(s)",
	"zai_web_search_web_search_prime · zai_web_reader_webReader",
];
const NO_TOOLS_LINES = ["⚠ zai-mcp: no MCP tools registered (check ZAI_API_KEY / network)"];

describe("scheduleReadyBanner — startup banner (replaces 'Warning:' notify hack)", () => {
	it("success path (tools > 0): shows the 2-line banner, then clears it", () => {
		captureTimers();
		const ctx = makeCtx();
		scheduleReadyBanner(ctx, SUCCESS_LINES);
		fireAll(); // fires show (which schedules dismiss), then dismiss
		expect(ctx.uiCalls).toEqual([
			["zai-mcp", SUCCESS_LINES],
			["zai-mcp", undefined],
		]);
	});

	it("no-tools path: shows the single warning line, then clears it", () => {
		captureTimers();
		const ctx = makeCtx();
		scheduleReadyBanner(ctx, NO_TOOLS_LINES);
		fireAll();
		expect(ctx.uiCalls).toEqual([
			["zai-mcp", NO_TOOLS_LINES],
			["zai-mcp", undefined],
		]);
	});

	it("show fires after ctx went stale → guard swallows, no throw, no dismiss scheduled", () => {
		captureTimers();
		const ctx = makeCtx();
		scheduleReadyBanner(ctx, SUCCESS_LINES);
		ctx.markStale(); // session switch before the 5s show timer fires
		expect(() => fireAll()).not.toThrow();
		// show's setWidget threw → caught → early return → dismiss never scheduled
		expect(ctx.uiCalls).toEqual([]);
	});

	it("dismiss fires after ctx went stale (switch between show and dismiss) → guard swallows", () => {
		captureTimers();
		const ctx = makeCtx();
		scheduleReadyBanner(ctx, SUCCESS_LINES);
		// fire show while ctx is still alive → records banner + schedules dismiss
		expect(() => fireNext()).not.toThrow();
		expect(ctx.uiCalls).toEqual([["zai-mcp", SUCCESS_LINES]]);
		// session switches before the 8s dismiss timer fires
		ctx.markStale();
		expect(() => fireNext()).not.toThrow();
		// dismiss's setWidget threw → caught → no second call recorded
		expect(ctx.uiCalls).toEqual([["zai-mcp", SUCCESS_LINES]]);
	});

	it("debug opts {immediate,log}: mirrors rendered lines to stderr once + still shows/clears", () => {
		captureTimers();
		const ctx = makeCtx();
		const errCalls: string[] = [];
		const origErr = console.error;
		console.error = (s: string) => { errCalls.push(s); };
		try {
			scheduleReadyBanner(ctx, SUCCESS_LINES, { immediate: true, log: true });
		} finally {
			console.error = origErr;
		}
		// log fired synchronously, exactly once, joining both lines
		expect(errCalls).toEqual([`[zai-mcp banner]\n${SUCCESS_LINES.join("\n")}`]);
		// immediate just sets the show delay to 0 (still captured by the shim);
		// the banner still renders then auto-dismisses like the prod path.
		fireAll();
		expect(ctx.uiCalls).toEqual([
			["zai-mcp", SUCCESS_LINES],
			["zai-mcp", undefined],
		]);
	});
});
