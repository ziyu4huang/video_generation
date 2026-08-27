import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { SEAM_KEYS, SEAM_KEY_ENTRIES, type SeamKey } from "../src/seam-keys.js";

describe("SEAM_KEYS", () => {
  it("registers __piKnowledgePipeline as crossPackage", () => {
    assert.equal(SEAM_KEYS.__piKnowledgePipeline.crossPackage, true);
  });
  it("exposes 11 entries in SEAM_KEY_ENTRIES", () => {
    assert.equal(SEAM_KEY_ENTRIES.length, 11);
    assert.ok(SEAM_KEY_ENTRIES.some((e) => e.key === "__piKnowledgePipeline" && e.crossPackage === true));
    // #1242's staleness reverse seam (hermes publishes, wayfind reads) shipped
    // unregistered, which left bun-apps/tests/seam-contract.test.ts RED on main.
    assert.ok(SEAM_KEY_ENTRIES.some((e) => e.key === "__piHermesStaleCheck" && e.crossPackage === true));
    // ticket 06: tool-gate live-state seam (tool-gate publishes, power-tool reads).
    assert.ok(SEAM_KEY_ENTRIES.some((e) => e.key === "__piToolGateStatus" && e.crossPackage === true));
    // kcard-parity D8: host-published embedding config (publisher = s2-agent host,
    // outside the seam-contract scanner set → crossPackage:false per __piRateLimitState
    // precedent; reader = embedding-leaf resolveSemanticEmbedConfig).
    assert.ok(SEAM_KEY_ENTRIES.some((e) => e.key === "__piEmbeddingConfig" && e.crossPackage === false));
    // 2026-08-24: host-published baked provider catalog (publisher = s2-agent
    // host, same scanner-set exemption as __piEmbeddingConfig; reader =
    // core-runtime registerBakedProvidersFromSeam via globalThis).
    assert.ok(SEAM_KEY_ENTRIES.some((e) => e.key === "__piBakedProviders" && e.crossPackage === false));
    // cc-parity-task t03 (2026-08-28): pending-loop snapshot reader (ultracode
    // publishes, ext-task's composite-widget overlay reads display-only).
    assert.ok(SEAM_KEY_ENTRIES.some((e) => e.key === "__piWakeupLoops" && e.crossPackage === true));
  });
  it("SeamKey includes the new key", () => {
    const k: SeamKey = "__piKnowledgePipeline";
    assert.equal(k, "__piKnowledgePipeline");
  });
});
