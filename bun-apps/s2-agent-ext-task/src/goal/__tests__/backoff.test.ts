import { test, expect } from "bun:test";
import { shouldPauseAfterBackoff, shouldHeartbeatRefire, accountTurnForNudges, shouldWedgeAlert, BACKOFF_HARD_CAP_MS, HEARTBEAT_STALL_MS } from "../backoff.js";

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
	const base = { supervising: true, sessionBusy: true, silentMs: 31 * 60_000, thresholdMs: 30 * 60_000, awaitingUser: false };
	expect(shouldWedgeAlert({ ...base, msSinceLastAlert: 31 * 60_000 })).toBe(true);
	expect(shouldWedgeAlert({ ...base, msSinceLastAlert: 1000 })).toBe(false);
});
test("shouldWedgeAlert exempts HITL waits even when fully armed", () => {
	// #1616 family: ask_user_question pending = blocked on a human, not wedged.
	expect(
		shouldWedgeAlert({
			supervising: true,
			sessionBusy: true,
			silentMs: 31 * 60_000,
			msSinceLastAlert: 31 * 60_000,
			thresholdMs: 30 * 60_000,
			awaitingUser: true,
		}),
	).toBe(false);
});
