import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { SEAM_KEYS, SEAM_KEY_ENTRIES, type SeamKey } from "../src/seam-keys.js";

describe("SEAM_KEYS", () => {
  it("registers __piKnowledgePipeline as crossPackage", () => {
    assert.equal(SEAM_KEYS.__piKnowledgePipeline.crossPackage, true);
  });
  it("exposes 10 entries in SEAM_KEY_ENTRIES", () => {
    assert.equal(SEAM_KEY_ENTRIES.length, 10);
    assert.ok(SEAM_KEY_ENTRIES.some((e) => e.key === "__piKnowledgePipeline" && e.crossPackage === true));
    // #1242's staleness reverse seam (hermes publishes, wayfind reads) shipped
    // unregistered, which left bun-apps/tests/seam-contract.test.ts RED on main.
    assert.ok(SEAM_KEY_ENTRIES.some((e) => e.key === "__piHermesStaleCheck" && e.crossPackage === true));
  });
  it("SeamKey includes the new key", () => {
    const k: SeamKey = "__piKnowledgePipeline";
    assert.equal(k, "__piKnowledgePipeline");
  });
});
