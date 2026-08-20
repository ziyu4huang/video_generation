export const BACKOFF_HARD_CAP_MS = 5 * 60 * 1000;
export const BACKOFF_ERROR_BASE_MS = 5_000;
export const BACKOFF_ERROR_MAX_MS = 60_000;

/** Backoff (ms) before the next iteration, from consecutive stuck iterations. Caps at 5 min. */
export function backoffMs(stuckCount: number, mode: "stuck" | "error" | "context" = "stuck"): number {
	if (mode === "error") return Math.min(BACKOFF_ERROR_BASE_MS * 2 ** Math.max(0, stuckCount - 1), BACKOFF_ERROR_MAX_MS);
	if (mode === "context") return Math.min(30_000 * Math.max(1, stuckCount), BACKOFF_HARD_CAP_MS);
	const schedule = [0, 30_000, 60_000, 120_000, 240_000, BACKOFF_HARD_CAP_MS];
	return schedule[Math.max(0, Math.min(schedule.length - 1, stuckCount))] ?? BACKOFF_HARD_CAP_MS;
}

export function shouldPauseAfterBackoff(stuckElapsedMs: number, idleIterCount: number): boolean {
	if (stuckElapsedMs >= BACKOFF_HARD_CAP_MS) return true;
	if (idleIterCount >= 3) return true;
	return false;
}

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_STALL_MS = 120_000; // tuned (D2): generous for a present user
export const HEARTBEAT_MAX_NUDGES = 3;
export const WEDGE_ALERT_DEFAULT_MINUTES = 30;

export interface HeartbeatInput {
	supervising: boolean; sessionIdle: boolean; timerPending: boolean;
	msSinceActivity: number; stallMs?: number;
}
export function shouldHeartbeatRefire(i: HeartbeatInput): boolean {
	if (!i.supervising || !i.sessionIdle || i.timerPending) return false;
	return i.msSinceActivity >= (i.stallMs ?? HEARTBEAT_STALL_MS);
}
export function accountTurnForNudges(toolCalls: number, currentNudges: number): number {
	return toolCalls > 0 ? 0 : currentNudges + 1;
}

export interface WedgeInput {
	supervising: boolean; sessionBusy: boolean; silentMs: number;
	msSinceLastAlert: number; thresholdMs: number;
	awaitingUser: boolean;
}
export function shouldWedgeAlert(i: WedgeInput): boolean {
	// HITL wedge exemption (#1616 family): a busy session whose silence is an
	// ask_user_question awaiting a human answer is blocked-on-human, not
	// wedged — never alert while an ask is in flight.
	if (i.awaitingUser) return false;
	if (!i.supervising || !i.sessionBusy || i.thresholdMs <= 0 || i.silentMs < i.thresholdMs) return false;
	return i.msSinceLastAlert >= i.thresholdMs;
}
