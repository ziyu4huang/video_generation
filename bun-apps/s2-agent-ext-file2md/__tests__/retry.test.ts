/**
 * Retry predicate + loop.
 *
 *   bun test __tests__/retry.test.ts
 */
import { describe, expect, test } from "bun:test";
import { isRetryableError, retryableError, withRetry } from "../src/vlm/retry.ts";

describe("isRetryableError", () => {
  test("429 status is retryable", () => {
    expect(isRetryableError({ status: 429 })).toBe(true);
    expect(isRetryableError({ statusCode: 429 })).toBe(true);
  });

  test("5xx is retryable, other statuses are not", () => {
    for (const s of [500, 502, 503, 599]) {
      expect(isRetryableError({ status: s })).toBe(true);
    }
    for (const s of [400, 401, 403, 404, 422]) {
      expect(isRetryableError({ status: s })).toBe(false);
    }
  });

  test("message-based detection (providers that surface 429 as text)", () => {
    const retryable = [
      "Rate limit exceeded",
      "429 Too Many Requests",
      "service unavailable",
      "Request timed out",
      "operation timed out",
      "ECONNRESET",
      "ETIMEDOUT",
      "socket hang up",
      "fetch failed",
      "overloaded",
    ];
    for (const msg of retryable) expect(isRetryableError(new Error(msg))).toBe(true);
  });

  test("non-retryable messages", () => {
    expect(isRetryableError(new Error("invalid api key"))).toBe(false);
    expect(isRetryableError(new Error("bad request"))).toBe(false);
  });

  test("accepts a plain string or message-less object", () => {
    expect(isRetryableError("rate limit hit")).toBe(true);
    expect(isRetryableError({})).toBe(false);
  });

  test("honors an explicit retryable flag (e.g. from retryableError)", () => {
    expect(isRetryableError(retryableError("gate: body too short"))).toBe(true);
    expect(isRetryableError({ retryable: true })).toBe(true);
    // a plain error without the flag falls through to message detection
    expect(isRetryableError(new Error("gate: body too short"))).toBe(false);
  });
});

describe("withRetry", () => {
  test("returns the result on first success (no retry)", async () => {
    let calls = 0;
    const r = await withRetry(
      async () => {
        calls++;
        return 42;
      },
      { retryWaitMs: 0 },
    );
    expect(r).toBe(42);
    expect(calls).toBe(1);
  });

  test("retries a flaky fn that then succeeds", async () => {
    let calls = 0;
    const r = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("rate limit");
        return "ok";
      },
      { maxRetries: 5, retryWaitMs: 0 },
    );
    expect(r).toBe("ok");
    expect(calls).toBe(3);
  });

  test("throws immediately on a non-retryable error (no retry)", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("invalid api key");
        },
        { maxRetries: 5, retryWaitMs: 0 },
      ),
    ).rejects.toThrow("invalid api key");
    expect(calls).toBe(1);
  });

  test("exhausts retries then throws the last error", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("service unavailable");
        },
        { maxRetries: 2, retryWaitMs: 0 },
      ),
    ).rejects.toThrow("service unavailable");
    // 1 initial + 2 retries
    expect(calls).toBe(3);
  });

  test("retries an error flagged retryable even if its message looks non-retryable", async () => {
    let calls = 0;
    const r = await withRetry(
      async () => {
        calls++;
        if (calls < 2) throw retryableError("gate: body too short");
        return "recovered";
      },
      { maxRetries: 3, retryWaitMs: 0 },
    );
    expect(r).toBe("recovered");
    expect(calls).toBe(2);
  });

  test("onRetry fires with the right attempt numbers", async () => {
    const attempts: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("429");
        return "ok";
      },
      { maxRetries: 5, retryWaitMs: 0, onRetry: (info) => attempts.push(info.attempt) },
    ).catch(() => {});
    expect(attempts).toEqual([1, 2]);
  });
});
