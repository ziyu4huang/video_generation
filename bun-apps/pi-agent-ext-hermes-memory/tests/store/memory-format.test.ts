import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMetadataComment, serializeMetadataComment, parseMarkdownMemoryEntry } from "../../src/store/memory-format.js";

describe("parseMetadataComment — optional meta segment", () => {
  it("parses created/last only (legacy)", () => {
    const r = parseMetadataComment("use pnpm not npm <!-- created=2026-05-09, last=2026-05-10 -->");
    assert.strictEqual(r.text, "use pnpm not npm");
    assert.strictEqual(r.created, "2026-05-09");
    assert.strictEqual(r.lastReferenced, "2026-05-10");
    assert.strictEqual(r.provenance, undefined);
    assert.strictEqual(r.sources, undefined);
  });

  it("parses a trailing meta comment with provenance + sources", () => {
    const raw = 'use pnpm <!-- created=2026-05-09, last=2026-05-10 --> <!-- meta:{"provenance":"verified","sources":[{"kind":"quote","locator":"s12","capture":"use pnpm"}]} -->';
    const r = parseMetadataComment(raw);
    assert.strictEqual(r.text, "use pnpm");
    assert.strictEqual(r.provenance, "verified");
    assert.deepStrictEqual(r.sources, [{ kind: "quote", locator: "s12", capture: "use pnpm" }]);
  });

  it("falls back to today for entries with no comment at all", () => {
    const r = parseMetadataComment("bare entry text");
    assert.strictEqual(r.text, "bare entry text");
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.created));
  });

  it("ignores a malformed meta comment (keeps created/last)", () => {
    const raw = 'x <!-- created=2026-05-09, last=2026-05-10 --> <!-- meta:{not json} -->';
    const r = parseMetadataComment(raw);
    assert.strictEqual(r.text, "x");
    assert.strictEqual(r.provenance, undefined);
  });
});

describe("parseMarkdownMemoryEntry — threads meta", () => {
  it("carries provenance through the memory-target parse", () => {
    const raw = 'use pnpm <!-- created=2026-05-09, last=2026-05-10 --> <!-- meta:{"provenance":"unverified"} -->';
    const e = parseMarkdownMemoryEntry(raw, "memory", null);
    assert.strictEqual(e.content, "use pnpm");
    assert.strictEqual(e.provenance, "unverified");
  });
});

describe("serializeMetadataComment", () => {
  it("omits the meta comment when no provenance/sources", () => {
    const out = serializeMetadataComment({ text: "hi", created: "2026-05-09", lastReferenced: "2026-05-10" });
    assert.strictEqual(out, "hi <!-- created=2026-05-09, last=2026-05-10 -->");
  });

  it("emits the meta comment with provenance + sources", () => {
    const out = serializeMetadataComment({
      text: "hi",
      created: "2026-05-09",
      lastReferenced: "2026-05-10",
      provenance: "verified",
      sources: [{ kind: "quote", locator: "s1", capture: "hi" }],
    });
    assert.ok(out.includes("<!-- created=2026-05-09, last=2026-05-10 -->"));
    assert.ok(out.includes('<!-- meta:{"provenance":"verified","sources":'));
  });

  it("round-trips through parseMetadataComment", () => {
    const original = {
      text: "use bun not npm",
      created: "2026-05-09",
      lastReferenced: "2026-05-10",
      provenance: "unverified" as const,
      sources: [{ kind: "quote", locator: "s3", capture: "use bun" }],
    };
    const encoded = serializeMetadataComment(original);
    const decoded = parseMetadataComment(encoded);
    assert.deepStrictEqual(decoded, original);
  });
});

describe("serializeMetadataComment — worth counters", () => {
  it("omits counters when zero (no meta bloat for new entries)", () => {
    const out = serializeMetadataComment({ text: "x", created: "2026-05-09", lastReferenced: "2026-05-10", mwSuccess: 0, mwFail: 0 });
    assert.strictEqual(out, "x <!-- created=2026-05-09, last=2026-05-10 -->");
  });
  it("emits non-zero counters in the meta comment", () => {
    const out = serializeMetadataComment({ text: "x", created: "2026-05-09", lastReferenced: "2026-05-10", mwSuccess: 5, mwFail: 1 });
    assert.ok(out.includes('"mwSuccess":5'));
    assert.ok(out.includes('"mwFail":1'));
  });
  it("round-trips non-zero counters through parseMetadataComment", () => {
    const encoded = serializeMetadataComment({ text: "fact", created: "2026-05-09", lastReferenced: "2026-05-10", mwSuccess: 7, mwFail: 2 });
    const decoded = parseMetadataComment(encoded);
    assert.strictEqual(decoded.mwSuccess, 7);
    assert.strictEqual(decoded.mwFail, 2);
    assert.strictEqual(decoded.text, "fact");
  });
});
