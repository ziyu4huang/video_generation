import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseMetadataComment,
  serializeMetadataComment,
  parseMarkdownMemoryEntry,
  serializeMetadataFrontmatter,
  parseMetadataFrontmatter,
  normalizeFailureState,
  defaultStateForCategory,
  normalizePin,
} from "../../src/store/memory-format.js";

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

describe("serialize/parse frontmatter — failure state + severity (Task 1)", () => {
  it("serialize/parse round-trips state + severity in frontmatter", () => {
    const raw = serializeMetadataFrontmatter({
      id: "uuid-1",
      text: "[failure] boom",
      created: "2026-08-02",
      last: "2026-08-02",
      state: "resolved",
      severity: 2,
    });
    assert.ok(raw.includes("state: resolved"));
    assert.ok(raw.includes("severity: 2"));
    const fm = parseMetadataFrontmatter(raw);
    assert.strictEqual(fm.state, "resolved");
    assert.strictEqual(fm.severity, 2);
  });

  it("state omitted when not supplied (memory/user entries)", () => {
    const raw = serializeMetadataFrontmatter({ id: "u", text: "note", created: "2026-08-02", last: "2026-08-02" });
    assert.ok(!raw.includes("state:"));
    assert.strictEqual(parseMetadataFrontmatter(raw).state, undefined);
  });

  it("normalizeFailureState coerces invalid → active", () => {
    assert.strictEqual(normalizeFailureState("resolved"), "resolved");
    assert.strictEqual(normalizeFailureState("bogus"), "active");
    assert.strictEqual(normalizeFailureState(undefined), "active");
    assert.strictEqual(normalizeFailureState(null), "active");
  });

  it("defaultStateForCategory maps tool-quirk/convention → acquired, else active", () => {
    assert.strictEqual(defaultStateForCategory("tool-quirk"), "acquired");
    assert.strictEqual(defaultStateForCategory("convention"), "acquired");
    assert.strictEqual(defaultStateForCategory("failure"), "active");
    assert.strictEqual(defaultStateForCategory("correction"), "active");
    assert.strictEqual(defaultStateForCategory(null), "active");
  });
});

describe("serialize/parse frontmatter — pin field (ticket 02)", () => {
  it("serialize/parse round-trips pin:true in frontmatter", () => {
    const raw = serializeMetadataFrontmatter({
      id: "pin-1",
      text: "always remember this",
      created: "2026-08-02",
      last: "2026-08-02",
      pin: true,
    });
    assert.ok(raw.includes("pin: true"), `expected pin:true in:\n${raw}`);
    const fm = parseMetadataFrontmatter(raw);
    assert.strictEqual(fm.pin, true);
  });

  it("pin omitted when not supplied (absent → not emitted, parses undefined)", () => {
    const raw = serializeMetadataFrontmatter({
      id: "no-pin",
      text: "a regular entry",
      created: "2026-08-02",
      last: "2026-08-02",
    });
    assert.ok(!raw.includes("pin:"), `pin must not be emitted when absent:\n${raw}`);
    assert.strictEqual(parseMetadataFrontmatter(raw).pin, undefined);
  });

  it("normalizePin coerces strictly: only true survives", () => {
    assert.strictEqual(normalizePin(true), true);
    assert.strictEqual(normalizePin(false), false);
    assert.strictEqual(normalizePin(undefined), false);
    assert.strictEqual(normalizePin(null), false);
    assert.strictEqual(normalizePin("true"), false);
    assert.strictEqual(normalizePin(1), false);
    assert.strictEqual(normalizePin("yes"), false);
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
