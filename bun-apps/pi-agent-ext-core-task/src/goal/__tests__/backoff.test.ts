import { test, expect } from "bun:test";
import { backoffMs, shouldPauseAfterBackoff, shouldHeartbeatRefire, accountTurnForNudges, shouldWedgeAlert, BACKOFF_HARD_CAP_MS, HEARTBEAT_STALL_MS } from "../backoff.js";

test("backoffMs follows the stuck schedule then caps", () => {
	expect(backoffMs(0)).toBe(0);
	expect(backoffMs(1)).toBe(30_000);
	expect(backoffMs(4)).toBe(240_000);
	expect(backoffMs(99)).toBe(BACKOFF_HARD_CAP_MS);
});
test("shouldPauseAfterBackoff trips at the cap or 3 idle iters", () => {
	expect(shouldPauseAfterBackoff(BACKOFF_HARD_CAP_MS, 0)).toBe(true);
	expect(shouldPauseAfterBackoff(0, 3)).toBe(true);
	expect(shouldPauseAfterBackoff(1000, 1)).toBe(false);
});
test("shouldHeartbeatRefire needs supervising+idle+stalled", () => {
	const base = { supervising: true, sessionIdle: true, timerPending: false, msSinceActivity: HEARTBEAT_STALL_MS };
	expect(shouldHeartbeatRefire(base)).toBe(true);
	expect(shouldHeartbeatRefire({ ...base, sessionIdle: false })).toBe(false);
	expect(shouldHeartbeatRefire({ ...base, timerPending: true })).toBe(false);
	expect(shouldHeartbeatRefire({ ...base, msSinceActivity: 1000 })).toBe(false);
});
test("accountTurnForNudges resets on tools, else increments", () => {
	expect(accountTurnForNudges(2, 1)).toBe(0);
	expect(accountTurnForNudges(0, 1)).toBe(2);
});
test("shouldWedgeAlert throttles to once per threshold", () => {
	const base = { supervising: true, sessionBusy: true, silentMs: 31 * 60_000, thresholdMs: 30 * 60_000 };
	expect(shouldWedgeAlert({ ...base, msSinceLastAlert: 31 * 60_000 })).toBe(true);
	expect(shouldWedgeAlert({ ...base, msSinceLastAlert: 1000 })).toBe(false);
});
