import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadModelTierConfig, normalizeWatchdogParam, resolveModelRole, runWatchdog } from "../src/index.js";

describe("watchdog public API + review capability", () => {
  it("re-exports runWatchdog + normalizeWatchdogParam", () => {
    assert.equal(typeof runWatchdog, "function");
    assert.equal(typeof normalizeWatchdogParam, "function");
  });
  it("model-tiers.json has a review capability (or falls back to big)", () => {
    const cfg = loadModelTierConfig();
    const review = resolveModelRole({ capability: "review" }, cfg) ?? resolveModelRole({ tier: "big" }, cfg);
    assert.ok(review, "expected capabilities.review OR tiers.big in ~/.pi/workflows/model-tiers.json");
  });
});
