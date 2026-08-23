import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveModelRole } from "@repo/s2-agent-core-runtime";
import { normalizeWatchdogParam, runWatchdog } from "../src/index.js";

describe("watchdog public API + review capability", () => {
  it("re-exports runWatchdog + normalizeWatchdogParam", () => {
    assert.equal(typeof runWatchdog, "function");
    assert.equal(typeof normalizeWatchdogParam, "function");
  });

  // Hermetic: a PURE unit test of resolveModelRole against an inline config —
  // no read of ~/.pi/workflows/model-tiers.json (absent in CI).
  it("resolveModelRole resolves review (capability) with fallback to big (tier)", () => {
    const cfg = { tiers: { big: "zai/glm-5.2" }, capabilities: { review: "zai/glm-5.2:high" } };
    assert.equal(resolveModelRole({ capability: "review" }, cfg), "zai/glm-5.2:high");
    const cfgNoReview = { tiers: { big: "zai/glm-5.2" }, capabilities: {} };
    assert.equal(resolveModelRole({ capability: "review" }, cfgNoReview), undefined);
    assert.equal(resolveModelRole({ tier: "big" }, cfgNoReview), "zai/glm-5.2");
  });
});
