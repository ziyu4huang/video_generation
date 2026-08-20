import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { healKnowledgeGraph } from "./knowledge-heal.js";

describe("healKnowledgeGraph (defensive seam read)", () => {
  it("returns undefined when the zk seam is absent (graceful, no throw)", async () => {
    // Ensure the seam is unset for this test (delete globalThis.__piKnowledgePipeline).
    delete (globalThis as Record<string, unknown>).__piKnowledgePipeline;
    const r = await healKnowledgeGraph({ vaultPath: "/nonexistent" });
    assert.equal(r, undefined);
  });
});
