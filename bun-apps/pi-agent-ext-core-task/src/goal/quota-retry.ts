// Quota-aware retry. When the goal-completion auditor (a separate model call)
// fails with a 429 / quota error, the goal_complete error branch used to tell
// the agent to "re-verify and call goal_complete again" — which re-ran the
// auditor against a quota window that only resets in ~1h, looping forever and
// burning tokens. This module detects the quota subclass, parses the upstream's
// Retry-After hint, and exposes a one-shot scheduled resume so the goal can
// pause + auto-resume instead of spinning.
//
// Pure module — zero @earendil-works/* imports (even type-only). The ctx shape
// quota-retry needs is the local QuotaRetryCtx interface; the goal.ts wiring
// passes the real ctx (structural satisfaction). The setTimeout + the module
// singleton are side-effect state local to this module (no @earendil runtime
// coupling) — same shape as length-continue.ts's tracker singleton.
//
// Verbatim port of GLA extensions/quota-retry.ts (faithful baseline); the only
// deviation is the ctx type (QuotaRetryCtx instead of import type ExtensionContext).

/** The ctx shape quota-retry needs (local — keeps the module free of @earendil imports). */
export interface QuotaRetryCtx {
	readonly ui: { notify(message: string, level?: string): void };
}

export const DEFAULT_QUOTA_RETRY_SEC = 3600;

export interface QuotaError {
	raw: string;
	/** Seconds until retry, from the upstream hint or the default. */
	retryAfterSec: number;
	/** True when retryAfterSec came from the upstream (Retry-After / "retry in Ns"), false when the default was used. */
	fromUpstream: boolean;
}

/** Match 429, "quota", "rate limit", "temporarily rate-limited upstream", credit exhaustion. */
export function isQuotaError(error: string | undefined): boolean {
	if (!error) return false;
	return /429|quota|rate.?limit|temporarily|credits?|key limit exceeded|insufficient.?balance|too many requests/i.test(error);
}

/** Parse the retry window out of an error string: `Retry-After: N`, `retry after/in N (s|m|h)` prose, else default. */
export function parseQuotaError(error: string, defaultRetryAfterSec = DEFAULT_QUOTA_RETRY_SEC): QuotaError {
	let m = error.match(/retry-after:\s*(\d+)/i);
	if (m) {
		const sec = Number(m[1]);
		if (Number.isFinite(sec) && sec >= 0) return { raw: error, retryAfterSec: sec, fromUpstream: true };
	}
	m = error.match(/retry (?:after|in)\s+(\d+)\s*(s|sec|seconds|m|min|minutes|h|hours?)/i);
	if (m) {
		const n = Number(m[1]);
		const unit = m[2]!.toLowerCase();
		const mult = unit.startsWith("h") ? 3600 : unit.startsWith("m") ? 60 : 1;
		if (Number.isFinite(n) && n >= 0) return { raw: error, retryAfterSec: n * mult, fromUpstream: true };
	}
	return { raw: error, retryAfterSec: defaultRetryAfterSec, fromUpstream: false };
}

/** Detect a SUBAGENT (Agent-tool) quota failure in a tool_result. Pure; wiring deferred. */
export function isSubagentQuotaResult(toolName: string, isError: boolean, payload: unknown): boolean {
	if (!isError) return false;
	if (toolName !== "Agent" && toolName !== "agent") return false;
	const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
	return isQuotaError(text);
}

let quotaRetryTimer: ReturnType<typeof setTimeout> | null = null;

/** Test hook — is a quota retry currently scheduled? */
export function isQuotaRetryPending(): boolean {
	return quotaRetryTimer !== null;
}

/** Cancel any pending quota retry (e.g. the user resumed manually, or a fresh session). */
export function cancelQuotaRetry(): void {
	if (quotaRetryTimer) {
		clearTimeout(quotaRetryTimer);
		quotaRetryTimer = null;
	}
}

/**
 * Schedule a one-shot auto-resume after the quota window. The fire callback
 * re-checks the goal is still paused for the quota reason before resuming
 * (the caller's resume is idempotent; a user /goal pause during the window is
 * not stomped because resumeGoal/session_start call cancelQuotaRetry).
 */
export function scheduleQuotaRetry(
	ctx: QuotaRetryCtx,
	retryAfterSec: number,
	reason: string,
	fire: () => void,
	label = "Auditor quota exhausted — auto-retry",
): void {
	cancelQuotaRetry();
	const ms = Math.max(1_000, retryAfterSec * 1_000);
	quotaRetryTimer = setTimeout(() => {
		quotaRetryTimer = null;
		try {
			fire();
		} catch {
			/* session may be gone; session_start will re-evaluate */
		}
	}, ms);
	quotaRetryTimer.unref?.();
	ctx.ui.notify(
		`${label} in ${Math.round(retryAfterSec / 60)}m (${reason.slice(0, 80)}). /goal resume retries now.`,
		"info",
	);
}
