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

  it("publishes the 5-function surface (+ the es1 entityAugment leaf)", () => {
    publishKnowledgePipeline({ collectInputFiles, ingestRecords, retrieveRecords, healGraph, buildHierarchy });
    const kp = readSeam(KEY);
    assert.ok(kp, "seam must be published");
    assert.equal(typeof kp.collectInputFiles, "function");
    assert.equal(typeof kp.ingestRecords, "function");
    assert.equal(typeof kp.healGraph, "function");
    assert.equal(typeof kp.retrieveRecords, "function");
    assert.equal(typeof kp.buildHierarchy, "function");
    assert.equal(typeof kp.entityAugment?.augmentEmbedText, "function", "es1 leaf must be attached at publish");
  });

  it("entityAugment.augmentEmbedText — contract passthrough (es1)", () => {
    publishKnowledgePipeline({ collectInputFiles, ingestRecords, retrieveRecords, healGraph, buildHierarchy });
    const leaf = readSeam(KEY)!.entityAugment!;
    // Empty / absent / null summary → base unchanged (zero behavior change
    // when summaries are absent).
    assert.equal(leaf.augmentEmbedText("base text", undefined), "base text");
    assert.equal(leaf.augmentEmbedText("base text", ""), "base text");
    assert.equal(leaf.augmentEmbedText("base text", null), "base text");
    // Non-empty summary → summary prefix, sliced to 200, total capped at 1000.
    assert.equal(leaf.augmentEmbedText("body", "sum"), "sum body");
    const s300 = "s".repeat(300);
    const b900 = "b".repeat(900);
    assert.equal(leaf.augmentEmbedText(b900, s300), `${s300.slice(0, 200)} ${b900}`.slice(0, 1000));
  });

  it("impl-provided entityAugment wins over the default leaf", () => {
    const custom = { augmentEmbedText: (base: string) => `custom ${base}` };
    publishKnowledgePipeline({
      collectInputFiles, ingestRecords, retrieveRecords, healGraph, buildHierarchy,
      entityAugment: custom,
    });
    const kp = readSeam(KEY)!;
    assert.equal(kp.entityAugment?.augmentEmbedText("x", undefined), "custom x");
  });
});
