import { test, expect, describe } from "bun:test";
import {
	DEFAULT_QUOTA_RETRY_SEC,
	isQuotaError,
	parseQuotaError,
	isSubagentQuotaResult,
	isQuotaRetryPending,
	cancelQuotaRetry,
	scheduleQuotaRetry,
} from "../quota-retry.js";

describe("isQuotaError", () => {
	test("matches 429 / quota / rate-limit / credit shapes", () => {
		expect(isQuotaError("429 Too Many Requests")).toBe(true);
		expect(isQuotaError("rate limit exceeded")).toBe(true);
		expect(isQuotaError("insufficient balance")).toBe(true);
		expect(isQuotaError("too many requests")).toBe(true);
		expect(isQuotaError("quota exhausted")).toBe(true);
	});
	test("rejects undefined / empty / non-quota errors", () => {
		expect(isQuotaError(undefined)).toBe(false);
		expect(isQuotaError("")).toBe(false);
		expect(isQuotaError("network error")).toBe(false);
		expect(isQuotaError("connection reset")).toBe(false);
	});
});

describe("parseQuotaError", () => {
	test("Retry-After header → seconds, fromUpstream", () => {
		expect(parseQuotaError("429 — Retry-After: 5")).toEqual({ raw: "429 — Retry-After: 5", retryAfterSec: 5, fromUpstream: true });
	});
	test("'retry in 2m' prose → 120s", () => {
		expect(parseQuotaError("rate limited, retry in 2m").retryAfterSec).toBe(120);
		expect(parseQuotaError("rate limited, retry in 2m").fromUpstream).toBe(true);
	});
	test("'retry after 30 seconds' → 30s", () => {
		expect(parseQuotaError("retry after 30 seconds").retryAfterSec).toBe(30);
	});
	test("no hint → default 3600, !fromUpstream", () => {
		const q = parseQuotaError("429 with no retry hint");
		expect(q.retryAfterSec).toBe(DEFAULT_QUOTA_RETRY_SEC);
		expect(q.fromUpstream).toBe(false);
	});
});

describe("isSubagentQuotaResult", () => {
	test("Agent tool + isError + quota payload → true", () => {
		expect(isSubagentQuotaResult("Agent", true, "429 rate limited")).toBe(true);
	});
	test("non-Agent tool → false; !isError → false; non-quota payload → false", () => {
		expect(isSubagentQuotaResult("read", true, "429")).toBe(false);
		expect(isSubagentQuotaResult("Agent", false, "429")).toBe(false);
		expect(isSubagentQuotaResult("Agent", true, "network error")).toBe(false);
	});
});

describe("quota retry timer", () => {
	test("schedule → pending true + notify; cancel → pending false; reschedule cancels prior", () => {
		cancelQuotaRetry();
		expect(isQuotaRetryPending()).toBe(false);
		const notes: string[] = [];
		scheduleQuotaRetry({ ui: { notify: (m: string) => void notes.push(m) } }, 60, "429 rate limited", () => {});
		expect(isQuotaRetryPending()).toBe(true);
		expect(notes.some((n) => /auto-retry|quota/i.test(n))).toBe(true);
		// reschedule cancels the prior — still exactly one pending
		scheduleQuotaRetry({ ui: { notify: () => {} } }, 120, "429 again", () => {});
		expect(isQuotaRetryPending()).toBe(true);
		cancelQuotaRetry();
		expect(isQuotaRetryPending()).toBe(false);
	});

	test("fire callback runs after the window, then pending clears", async () => {
		cancelQuotaRetry();
		let fired = false;
		// retryAfterSec=1 → Math.max(1_000, 1*1000) = 1000ms minimum
		scheduleQuotaRetry({ ui: { notify: () => {} } }, 1, "test", () => { fired = true; });
		expect(isQuotaRetryPending()).toBe(true);
		await new Promise((r) => setTimeout(r, 1150));
		expect(fired).toBe(true);
		expect(isQuotaRetryPending()).toBe(false);
	});
});
