import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { publishSeam, type KnowledgePipeline } from "@repo/pi-agent-core-interface";
import { getKnowledgePipeline } from "../src/knowledge-pipeline-seam.js";

const KEY = "__piKnowledgePipeline";

describe("hermes reads KnowledgePipeline defensively", () => {
  beforeEach(() => { delete (globalThis as Record<string, unknown>)[KEY]; });
  afterEach(() => { delete (globalThis as Record<string, unknown>)[KEY]; });

  it("returns undefined when zk is absent", () => {
    assert.equal(getKnowledgePipeline(), undefined);
  });

  it("returns the published impl object with its 4 methods", () => {
    const fake: KnowledgePipeline = {
      collectInputFiles: () => ({ files: [], skipped: [] }),
      ingestRecords: async () => ({
        source: "hermes",
        sourceLabel: "test",
        total: 0,
        created: 0,
        updated: 0,
        unchanged: 0,
        skipped: 0,
        linked: 0,
        wikiMerged: 0,
        mocUpdated: false,
        vaultPath: "",
        folder: "",
        cards: [],
        parseErrors: [],
      }),
      runConvergenceLoop: async () => ({
        sourcesIngested: 0,
        created: 0,
        updated: 0,
        unchanged: 0,
        deadLinksBefore: 0,
        deadLinksAfter: 0,
        mocMissingBefore: false,
        mocMissingAfter: false,
        rounds: 0,
        converged: false,
        truncated: false,
        health: null,
      }),
      retrieveRecords: async () => ({
        count: 0,
        cards: [],
        digest: "",
        folder: "",
        scanned: 0,
        excluded: 0,
      }),
      healGraph: async () => ({ mocRegenerated: false, deadLinksPruned: 0, linksDeduped: 0, cardsTouched: [] }),
    };
    publishSeam(KEY, fake);
    const kp = getKnowledgePipeline();
    assert.equal(kp, fake);
    assert.equal(typeof kp?.collectInputFiles, "function");
    assert.equal(typeof kp?.ingestRecords, "function");
    assert.equal(typeof kp?.healGraph, "function");
    assert.equal(typeof kp?.runConvergenceLoop, "function");
    assert.equal(typeof kp?.retrieveRecords, "function");
  });
});
