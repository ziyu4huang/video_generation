import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { readSeam } from "@repo/pi-agent-core-interface";
import { ingestRecords } from "../src/ingest.js";
import { collectInputFiles } from "../src/adapters.js";
import { retrieveRecords, healGraph } from "../src/retrieve.js";
import { buildHierarchy } from "../src/hierarchy-build.js";
import { publishKnowledgePipeline } from "../src/knowledge-pipeline-seam.js";

const KEY = "__piKnowledgePipeline";

describe("zk publishes KnowledgePipeline seam", () => {
  beforeEach(() => { delete (globalThis as Record<string, unknown>)[KEY]; });
  afterEach(() => { delete (globalThis as Record<string, unknown>)[KEY]; });

  it("publishes the 5-function surface", () => {
    publishKnowledgePipeline({ collectInputFiles, ingestRecords, retrieveRecords, healGraph, buildHierarchy });
    const kp = readSeam(KEY);
    assert.ok(kp, "seam must be published");
    assert.equal(typeof kp.collectInputFiles, "function");
    assert.equal(typeof kp.ingestRecords, "function");
    assert.equal(typeof kp.healGraph, "function");
    assert.equal(typeof kp.retrieveRecords, "function");
    assert.equal(typeof kp.buildHierarchy, "function");
  });
});
