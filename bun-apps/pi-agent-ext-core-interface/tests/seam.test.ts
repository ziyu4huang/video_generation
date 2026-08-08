import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { publishSeam, readSeam } from "../src/seam.js";

describe("seam accessors", () => {
  it("round-trips a published value", () => {
    publishSeam("__piGoalActive", 42); // __piGoalActive is `unknown` in SeamImplMap
    assert.equal(readSeam("__piGoalActive"), 42);
    delete (globalThis as Record<string, unknown>).__piGoalActive;
  });
  it("readSeam returns undefined when unpublished", () => {
    delete (globalThis as Record<string, unknown>).__piGoalActive;
    assert.equal(readSeam("__piGoalActive"), undefined);
  });
});
