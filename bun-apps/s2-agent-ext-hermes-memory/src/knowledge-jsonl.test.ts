import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { parseKnowledgeJsonl } from "./knowledge-jsonl.js";
import type { KnowledgeRecord } from "@repo/s2-agent-core-interface";

describe("parseKnowledgeJsonl (hermes-side adapter, Option A)", () => {
  it("parses a valid record, skips blank/comment, records a missing-id error", () => {
    const content = [
      '{"id":"a1","type":"lever","title":"A","detail":"d","tags":["x","y"],"dimension":"perf","confidence":0.8,"status":"active","superseded_by":null}',
      "",
      "# a comment line — skipped, not an error",
      '{"type":"lever","title":"NoId"}',
    ].join("\n");
    const { records, parseErrors } = parseKnowledgeJsonl(content);
    assert.equal(records.length, 1);
    const r: KnowledgeRecord = records[0]!;
    assert.equal(r.id, "a1");
    assert.equal(r.title, "A");
    assert.equal(r.type, "lever");
    assert.equal(r.detail, "d");
    assert.deepEqual(r.tags, ["x", "y"]);
    assert.equal(r.dimension, "perf");
    assert.equal(r.confidence, 0.8);
    assert.equal(r.status, "active");
    assert.equal(r.superseded_by, null);
    // blank (line 2) + comment (line 3) skipped; missing-id at line 4 → 1 error.
    assert.equal(parseErrors.length, 1);
    assert.equal(parseErrors[0]!.line, 4);
    assert.match(parseErrors[0]!.reason, /id/i);
  });

  it("coerces missing optional fields to defaults", () => {
    const { records, parseErrors } = parseKnowledgeJsonl('{"id":"b1","title":"B"}');
    assert.equal(parseErrors.length, 0);
    const r = records[0]!;
    assert.equal(r.type, "pattern"); // default
    assert.equal(r.detail, "");
    assert.deepEqual(r.tags, []);
    assert.equal(r.dimension, null);
    assert.equal(r.confidence, 0);
    assert.equal(r.status, "active");
    assert.equal(r.superseded_by, null);
    // Provenance (F1): absent → undefined (never a partial/empty object).
    assert.equal(r.evidence, undefined);
    assert.equal(r.schema_version, undefined);
    assert.equal(r.extracted_at, undefined);
  });

  it("passes the evidence block / schema_version / extracted_at through (F1)", () => {
    const { records, parseErrors } = parseKnowledgeJsonl(
      '{"id":"e1","title":"E","evidence":{"occurrences":3,"first_seen":"2026-06-20","last_seen":"2026-07-01","run_ids":["r1"]},"schema_version":2,"extracted_at":"2026-07-02T10:00:00Z"}',
    );
    assert.equal(parseErrors.length, 0);
    const r = records[0]!;
    assert.deepEqual(r.evidence, {
      occurrences: 3,
      first_seen: "2026-06-20",
      last_seen: "2026-07-01",
      run_ids: ["r1"],
    });
    assert.equal(r.schema_version, 2);
    assert.equal(r.extracted_at, "2026-07-02T10:00:00Z");
  });

  it("drops a malformed (non-object) evidence field instead of crashing", () => {
    const { records, parseErrors } = parseKnowledgeJsonl(
      '{"id":"e2","title":"E2","evidence":"not-an-object"}',
    );
    assert.equal(parseErrors.length, 0);
    assert.equal(records[0]!.evidence, undefined);
  });

  it("drops an array-shaped evidence field (arrays are not evidence blocks)", () => {
    const { records, parseErrors } = parseKnowledgeJsonl(
      '{"id":"e3","title":"E3","evidence":[{"first_seen":"2026-01-01"}]}',
    );
    assert.equal(parseErrors.length, 0);
    assert.equal(records[0]!.evidence, undefined);
  });

  it("records a JSON parse error (malformed line)", () => {
    const { records, parseErrors } = parseKnowledgeJsonl("{not valid json");
    assert.equal(records.length, 0);
    assert.equal(parseErrors.length, 1);
    assert.match(parseErrors[0]!.reason, /JSON/i);
  });

  it("records a missing-title error (with id in reason)", () => {
    const { records, parseErrors } = parseKnowledgeJsonl('{"id":"c1"}');
    assert.equal(records.length, 0);
    assert.equal(parseErrors.length, 1);
    assert.match(parseErrors[0]!.reason, /title/i);
    assert.match(parseErrors[0]!.reason, /c1/);
  });
});
