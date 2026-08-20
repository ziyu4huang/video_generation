import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { CaptureThrottle } from "../../src/handlers/capture-throttle.js";

/** Throttle with a controllable fake clock; returns helpers to advance time. */
function makeThrottle(opts: {
  rateLimit?: number;
  rateWindowMs?: number;
  dedupCacheSize?: number;
  t0?: number;
} = {}) {
  let t = opts.t0 ?? 1_000_000;
  const throttle = new CaptureThrottle({
    rateLimit: opts.rateLimit ?? 3,
    rateWindowMs: opts.rateWindowMs ?? 10_000,
    dedupCacheSize: opts.dedupCacheSize ?? 64,
    now: () => t,
  });
  return { throttle, advance: (ms: number) => { t += ms; } };
}

describe("CaptureThrottle — rate limit", () => {
  it("allows under the cap", () => {
    const { throttle } = makeThrottle({ rateLimit: 3 });
    assert.equal(throttle.allow("a"), true);
    assert.equal(throttle.allow("b"), true); // not recorded yet → still under cap
  });

  it("denies a distinct key once the cap is reached", () => {
    const { throttle } = makeThrottle({ rateLimit: 2 });
    for (const k of ["a", "b"]) { assert.equal(throttle.allow(k), true); throttle.recordCapture(k); }
    assert.equal(throttle.allow("c"), false); // ③ rate-capped
  });

  it("allows again after the window expires (fake clock)", () => {
    const { throttle, advance } = makeThrottle({ rateLimit: 2, rateWindowMs: 10_000 });
    throttle.recordCapture("a"); throttle.recordCapture("b"); // fill window
    assert.equal(throttle.allow("c"), false); // capped
    advance(10_001); // past window
    assert.equal(throttle.allow("c"), true); // window reset
  });

  it("rateLimit:0 = unlimited (never rate-denies)", () => {
    const { throttle } = makeThrottle({ rateLimit: 0 });
    for (let i = 0; i < 50; i++) {
      throttle.recordCapture(`k${i}`);
      assert.equal(throttle.allow(`k${i + 100}`), true);
    }
  });
});

describe("CaptureThrottle — this-session dedup cache", () => {
  it("denies a key already recorded this session (① fast path)", () => {
    const { throttle } = makeThrottle({ dedupCacheSize: 64 });
    assert.equal(throttle.allow("enoent"), true);
    throttle.recordCapture("enoent");
    assert.equal(throttle.allow("enoent"), false); // ①
  });

  it("allow() does NOT record (two allows with no record both pass)", () => {
    const { throttle } = makeThrottle({ rateLimit: 1 });
    assert.equal(throttle.allow("x"), true);
    assert.equal(throttle.allow("x"), true); // not recorded → not cached → still true
  });

  it("evicts the oldest key when the LRU is full", () => {
    // rateLimit:0 isolates the dedup/LRU path from the rate window
    // (3 records would otherwise cap the default rateLimit:3 and mask eviction).
    const { throttle } = makeThrottle({ rateLimit: 0, dedupCacheSize: 2 });
    throttle.recordCapture("a");
    throttle.recordCapture("b");
    throttle.recordCapture("c"); // evicts "a" (oldest)
    assert.equal(throttle.allow("a"), true);  // "a" evicted → allowed
    assert.equal(throttle.allow("b"), false); // "b" still cached
  });

  it("dedupCacheSize:0 = no session-cache fast-path", () => {
    const { throttle } = makeThrottle({ dedupCacheSize: 0 });
    throttle.recordCapture("a");
    assert.equal(throttle.allow("a"), true); // cache disabled → not deduped here
  });
});

describe("CaptureThrottle — fail-open", () => {
  it("returns true (does not throw) when the injected clock throws", () => {
    const throttle = new CaptureThrottle({
      rateLimit: 1, rateWindowMs: 1000, dedupCacheSize: 1,
      now: () => { throw new Error("clock broke"); },
    });
    // Fresh key → reaches rate check → pruneWindow() → now() throws → fail-open.
    assert.equal(throttle.allow("k"), true);
  });
});
