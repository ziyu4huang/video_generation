import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { readSeam } from "@repo/pi-agent-ext-core-interface";
import { collectInputFiles, ingestRecords } from "../src/ingest.js";
import { runConvergenceLoop } from "../src/loop.js";
import { retrieveRecords } from "../src/retrieve.js";
import { publishKnowledgePipeline } from "../src/knowledge-pipeline-seam.js";

const KEY = "__piKnowledgePipeline";

describe("zk publishes KnowledgePipeline seam", () => {
  beforeEach(() => { delete (globalThis as Record<string, unknown>)[KEY]; });
  afterEach(() => { delete (globalThis as Record<string, unknown>)[KEY]; });

  it("publishes the 4-function surface", () => {
    publishKnowledgePipeline({ collectInputFiles, ingestRecords, runConvergenceLoop, retrieveRecords });
    const kp = readSeam(KEY);
    assert.ok(kp, "seam must be published");
    assert.equal(typeof kp.collectInputFiles, "function");
    assert.equal(typeof kp.ingestRecords, "function");
    assert.equal(typeof kp.runConvergenceLoop, "function");
    assert.equal(typeof kp.retrieveRecords, "function");
  });
});
