import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  __resetRateLimitStateForTests,
  getGlobalRateLimiter,
  getRateLimitCapResolver,
  providerFromModelSpec,
  setRateLimitCapResolver,
} from "@repo/pi-agent-core-runtime";

/** Tick so queued microtasks/promises can settle. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("rate-limiter: providerFromModelSpec", () => {
  it("extracts the segment before the first '/'", () => {
    assert.equal(providerFromModelSpec("zai/glm-4.6"), "zai");
    assert.equal(providerFromModelSpec("anthropic/claude-opus"), "anthropic");
  });
  it("returns the whole string when there is no '/'", () => {
    assert.equal(providerFromModelSpec("zai"), "zai");
  });
  it("returns undefined for empty/unset specs", () => {
    assert.equal(providerFromModelSpec(undefined), undefined);
    assert.equal(providerFromModelSpec(""), undefined);
    assert.equal(providerFromModelSpec("/glm-4.6"), undefined);
  });
});

describe("rate-limiter: cap respected + pass-through", () => {
  // Resolver is process-global → set/teardown per test so cases are isolated.
  const restoreResolver = () => {
    __resetRateLimitStateForTests();
  };
  it("gates to the configured maxConcurrent", async () => {
    __resetRateLimitStateForTests();
    setRateLimitCapResolver(() => 2);
    let active = 0;
    let peak = 0;
    const mk = () => async () => {
      active++;
      peak = Math.max(peak, active);
      await tick();
      active--;
      return active;
    };
    const limiter = getGlobalRateLimiter("zai");
    const results = await Promise.all(Array.from({ length: 6 }, () => limiter.run(mk())));
    assert.equal(results.length, 6);
    assert.ok(peak <= 2, `peak concurrency ${peak} exceeded cap 2`);
    assert.ok(peak === 2, `expected saturation at cap 2, got peak ${peak}`);
    restoreResolver();
  });

  it("is a pass-through (no gating) when no cap is configured", async () => {
    __resetRateLimitStateForTests();
    // No resolver registered → every run proceeds immediately, all in flight.
    let active = 0;
    let peak = 0;
    const mk = () => async () => {
      active++;
      peak = Math.max(peak, active);
      await tick();
      active--;
    };
    const limiter = getGlobalRateLimiter("zai");
    await Promise.all(Array.from({ length: 8 }, () => limiter.run(mk())));
    // Unbounded → all 8 ran concurrently.
    assert.equal(peak, 8, "pass-through should let all calls run at once");
    restoreResolver();
  });

  it("is a pass-through when the resolver returns undefined for the provider", async () => {
    __resetRateLimitStateForTests();
    // Cap configured for "zai" but not "other" → "other" is pass-through.
    setRateLimitCapResolver((p) => (p === "zai" ? 1 : undefined));
    let active = 0;
    let peak = 0;
    const mk = () => async () => {
      active++;
      peak = Math.max(peak, active);
      await tick();
      active--;
    };
    const limiter = getGlobalRateLimiter("other");
    await Promise.all(Array.from({ length: 5 }, () => limiter.run(mk())));
    assert.equal(peak, 5, "uncapped provider should pass through");
    restoreResolver();
  });
});

describe("rate-limiter: per-provider isolation", () => {
  it("two providers get independent budgets", async () => {
    __resetRateLimitStateForTests();
    setRateLimitCapResolver((p) => (p === "zai" ? 1 : p === "anthropic" ? 3 : undefined));
    let zaiPeak = 0;
    let zaiActive = 0;
    let anthropicPeak = 0;
    let anthropicActive = 0;

    const zai = getGlobalRateLimiter("zai");
    const anthropic = getGlobalRateLimiter("anthropic");

    const zaiTasks = Array.from({ length: 4 }, () =>
      zai.run(async () => {
        zaiActive++;
        zaiPeak = Math.max(zaiPeak, zaiActive);
        await tick();
        zaiActive--;
      }),
    );
    const anthropicTasks = Array.from({ length: 6 }, () =>
      anthropic.run(async () => {
        anthropicActive++;
        anthropicPeak = Math.max(anthropicPeak, anthropicActive);
        await tick();
        anthropicActive--;
      }),
    );
    await Promise.all([...zaiTasks, ...anthropicTasks]);
    assert.equal(zaiPeak, 1, "zai capped at 1");
    assert.equal(anthropicPeak, 3, "anthropic capped at 3");
    __resetRateLimitStateForTests();
  });
});

describe("rate-limiter: singleton stability", () => {
  it("returns the same instance per provider across calls", () => {
    __resetRateLimitStateForTests();
    const a = getGlobalRateLimiter("zai");
    const b = getGlobalRateLimiter("zai");
    assert.equal(a, b, "same provider → same limiter instance");
    const c = getGlobalRateLimiter("anthropic");
    assert.notEqual(a, c, "different provider → different instance");
    __resetRateLimitStateForTests();
  });

  it("resolver set/get is symmetric and clearable", () => {
    __resetRateLimitStateForTests();
    assert.equal(getRateLimitCapResolver(), undefined);
    const r = (p: string) => (p === "zai" ? 4 : undefined);
    setRateLimitCapResolver(r);
    assert.equal(getRateLimitCapResolver(), r);
    setRateLimitCapResolver(undefined);
    assert.equal(getRateLimitCapResolver(), undefined);
    __resetRateLimitStateForTests();
  });
});
