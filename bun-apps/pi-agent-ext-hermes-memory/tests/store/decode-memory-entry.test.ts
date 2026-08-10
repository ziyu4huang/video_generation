import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  decodeMemoryEntry,
  mdIdOf,
  isPinned,
  parseMarkdownMemoryEntry,
  serializeMetadataFrontmatter,
  serializeMetadataComment,
} from "../../src/store/memory-format.js";
import { parseEntry } from "../../src/store/merge-plan.js";

// decodeMemoryEntry is the unified shape-aware decoder (architecture-deepening
// C1 v2 part 1). These tests cover its field projection (frontmatter + comment
// shapes), the two baked-in fixes (leniency + typeof-id), and purity. mdIdOf /
// isPinned are covered as the 1-liners over the decoded value.

const SRC = { kind: "quote" as const, locator: "s12", capture: "use pnpm" };

describe("decodeMemoryEntry — frontmatter shape (all fields)", () => {
  it("projects id / created / lastReferenced / text and shape=frontmatter", () => {
    const raw = serializeMetadataFrontmatter({
      id: "id-1",
      text: "remember this",
      created: "2026-08-02",
      last: "2026-08-09",
    });
    const d = decodeMemoryEntry(raw);
    assert.strictEqual(d.shape, "frontmatter");
    assert.strictEqual(d.text, "remember this");
    assert.strictEqual(d.id, "id-1");
    assert.strictEqual(d.created, "2026-08-02");
    assert.strictEqual(d.lastReferenced, "2026-08-09");
    // Absent frontmatter-only fields stay undefined.
    assert.strictEqual(d.state, undefined);
    assert.strictEqual(d.severity, undefined);
    assert.strictEqual(d.pin, undefined);
    assert.strictEqual(d.provenance, undefined);
    assert.strictEqual(d.sources, undefined);
    assert.strictEqual(d.mwSuccess, undefined);
    assert.strictEqual(d.mwFail, undefined);
  });

  it("projects state + severity (failure lifecycle)", () => {
    const raw = serializeMetadataFrontmatter({
      id: "f-1",
      text: "[failure] boom",
      created: "2026-08-02",
      last: "2026-08-02",
      state: "resolved",
      severity: 2,
    });
    const d = decodeMemoryEntry(raw);
    assert.strictEqual(d.state, "resolved");
    assert.strictEqual(d.severity, 2);
  });

  it("projects pin:true (strict boolean)", () => {
    const raw = serializeMetadataFrontmatter({
      id: "pin-1",
      text: "always remember",
      created: "2026-08-02",
      last: "2026-08-02",
      pin: true,
    });
    const d = decodeMemoryEntry(raw);
    assert.strictEqual(d.pin, true);
  });

  it("projects provenance + sources", () => {
    const raw = serializeMetadataFrontmatter({
      id: "p-1",
      text: "use pnpm",
      created: "2026-08-02",
      last: "2026-08-02",
      provenance: "verified",
      sources: [SRC],
    });
    const d = decodeMemoryEntry(raw);
    assert.strictEqual(d.provenance, "verified");
    assert.deepStrictEqual(d.sources, [SRC]);
  });

  it("maps memworth.{success,fail} → mwSuccess / mwFail", () => {
    const raw = serializeMetadataFrontmatter({
      id: "mw-1",
      text: "worthful fact",
      created: "2026-08-02",
      last: "2026-08-02",
      mwSuccess: 5,
      mwFail: 1,
    });
    const d = decodeMemoryEntry(raw);
    assert.strictEqual(d.mwSuccess, 5);
    assert.strictEqual(d.mwFail, 1);
    // Confirm the on-disk rename actually happened (memworth, not mwSuccess).
    assert.ok(raw.includes("memworth:"), `expected memworth envelope:\n${raw}`);
    assert.ok(!raw.includes("mwSuccess"));
  });

  it("omits memworth when both counters are zero", () => {
    const raw = serializeMetadataFrontmatter({
      id: "mw-0",
      text: "fresh entry",
      created: "2026-08-02",
      last: "2026-08-02",
      mwSuccess: 0,
      mwFail: 0,
    });
    const d = decodeMemoryEntry(raw);
    assert.strictEqual(d.mwSuccess, undefined);
    assert.strictEqual(d.mwFail, undefined);
  });
});

describe("decodeMemoryEntry — comment shape", () => {
  it("projects text / created / lastReferenced and shape=comment; no fm-only fields", () => {
    const raw = serializeMetadataComment({ text: "use pnpm not npm", created: "2026-05-09", lastReferenced: "2026-05-10" });
    const d = decodeMemoryEntry(raw);
    assert.strictEqual(d.shape, "comment");
    assert.strictEqual(d.text, "use pnpm not npm");
    assert.strictEqual(d.created, "2026-05-09");
    assert.strictEqual(d.lastReferenced, "2026-05-10");
    // No frontmatter-only fields on comment-shape entries.
    assert.strictEqual(d.id, undefined);
    assert.strictEqual(d.state, undefined);
    assert.strictEqual(d.severity, undefined);
    assert.strictEqual(d.pin, undefined);
  });

  it("threads provenance + sources + memworth from the meta comment", () => {
    const raw = serializeMetadataComment({
      text: "use pnpm",
      created: "2026-05-09",
      lastReferenced: "2026-05-10",
      provenance: "unverified",
      sources: [SRC],
      mwSuccess: 3,
      mwFail: 2,
    });
    const d = decodeMemoryEntry(raw);
    assert.strictEqual(d.provenance, "unverified");
    assert.deepStrictEqual(d.sources, [SRC]);
    assert.strictEqual(d.mwSuccess, 3);
    assert.strictEqual(d.mwFail, 2);
  });

  it("falls back to today for a bare entry with no comment trailer", () => {
    const d = decodeMemoryEntry("bare entry text");
    assert.strictEqual(d.shape, "comment");
    assert.strictEqual(d.text, "bare entry text");
    assert.match(d.created, /^\d{4}-\d{2}-\d{2}$/);
    assert.strictEqual(d.created, d.lastReferenced);
  });
});

describe("decodeMemoryEntry — LENIENT malformed handling (baked-in fix (a))", () => {
  it("never throws on a frontmatter entry missing its closing fence", () => {
    const malformed = "---\nid: x\ncreated: 2026-08-02\nlast: 2026-08-02\nbody with no close";
    // detectEntryShape sees the opening fence → frontmatter, but splitFencedYaml
    // finds no closing fence → null. decodeMemoryEntry must NOT throw.
    let d: ReturnType<typeof decodeMemoryEntry> | undefined;
    assert.doesNotThrow(() => {
      d = decodeMemoryEntry(malformed);
    });
    assert.ok(d);
    // Falls back to comment-shape minimal entry.
    assert.strictEqual(d!.shape, "comment");
    assert.strictEqual(d!.text, malformed.trim());
    assert.match(d!.created, /^\d{4}-\d{2}-\d{2}$/);
    assert.strictEqual(d!.id, undefined);
    assert.strictEqual(d!.pin, undefined);
    assert.strictEqual(d!.state, undefined);
  });

  it("never throws on malformed YAML between fences", () => {
    const malformed = "---\n: : bad\n  : [unclosed\n---\nbody";
    assert.doesNotThrow(() => {
      decodeMemoryEntry(malformed);
    });
  });

  it("never throws on an opening fence with nothing else", () => {
    assert.doesNotThrow(() => {
      decodeMemoryEntry("---");
      decodeMemoryEntry("---\n");
    });
  });
});

describe("decodeMemoryEntry — proper id read (baked-in fix (b))", () => {
  it("id-less frontmatter → id === undefined (NOT the literal \"undefined\")", () => {
    // Hand-craft a frontmatter envelope with no `id` key (serializeMetadataFront-
    // matter requires id, so build the raw string directly).
    const raw = "---\ncreated: 2026-08-02\nlast: 2026-08-02\n---\nbody text";
    const d = decodeMemoryEntry(raw);
    assert.strictEqual(d.shape, "frontmatter");
    assert.strictEqual(d.text, "body text");
    assert.strictEqual(d.id, undefined);
    assert.notStrictEqual(d.id, "undefined" as unknown as undefined);
  });

  it("non-string id (e.g. number) → undefined, not String(value)", () => {
    // A numeric id must NOT be coerced via String() — typeof gate drops it.
    const raw = "---\nid: 42\ncreated: 2026-08-02\nlast: 2026-08-02\n---\nbody";
    const d = decodeMemoryEntry(raw);
    assert.strictEqual(d.id, undefined);
    assert.notStrictEqual(d.id, "42");
  });

  it("string id survives the typeof gate", () => {
    const raw = "---\nid: \"abc-123\"\ncreated: 2026-08-02\nlast: 2026-08-02\n---\nbody";
    const d = decodeMemoryEntry(raw);
    assert.strictEqual(d.id, "abc-123");
  });
});

describe("decodeMemoryEntry — purity", () => {
  it("is deterministic: same input → structurally equal output, no mutation", () => {
    const raw = serializeMetadataFrontmatter({
      id: "pure-1",
      text: "deterministic body",
      created: "2026-08-02",
      last: "2026-08-02",
      provenance: "verified",
      pin: true,
    });
    const a = decodeMemoryEntry(raw);
    const b = decodeMemoryEntry(raw);
    assert.deepStrictEqual(a, b);
    // Input string is untouched (no in-place mutation).
    assert.strictEqual(raw, serializeMetadataFrontmatter({
      id: "pure-1",
      text: "deterministic body",
      created: "2026-08-02",
      last: "2026-08-02",
      provenance: "verified",
      pin: true,
    }));
  });

  it("has no fs / side effects — derives everything from the input string", () => {
    // A pure decode of two unrelated inputs is independent.
    const d1 = decodeMemoryEntry(serializeMetadataComment({ text: "a", created: "2026-01-01", lastReferenced: "2026-01-02" }));
    const d2 = decodeMemoryEntry(serializeMetadataFrontmatter({ id: "b", text: "b", created: "2026-03-03", last: "2026-03-04" }));
    assert.strictEqual(d1.text, "a");
    assert.strictEqual(d2.id, "b");
    assert.strictEqual(d1.shape, "comment");
    assert.strictEqual(d2.shape, "frontmatter");
  });
});

describe("mdIdOf — 1-liner over decodeMemoryEntry", () => {
  it("returns the frontmatter id when present", () => {
    const raw = serializeMetadataFrontmatter({ id: "id-x", text: "t", created: "2026-08-02", last: "2026-08-02" });
    assert.strictEqual(mdIdOf(raw), "id-x");
  });

  it("returns null for comment-shape entries (no id)", () => {
    const raw = serializeMetadataComment({ text: "legacy", created: "2026-05-09", lastReferenced: "2026-05-10" });
    assert.strictEqual(mdIdOf(raw), null);
  });

  it("returns null for malformed frontmatter (lenient fallback)", () => {
    const malformed = "---\nid: x\nbody with no close";
    assert.strictEqual(mdIdOf(malformed), null);
  });

  it("returns null for an id-less frontmatter (NOT the literal \"undefined\")", () => {
    const raw = "---\ncreated: 2026-08-02\nlast: 2026-08-02\n---\nbody";
    assert.strictEqual(mdIdOf(raw), null);
    assert.notStrictEqual(mdIdOf(raw), "undefined");
  });
});

describe("isPinned — 1-liner over decodeMemoryEntry", () => {
  it("returns true only for a pinned frontmatter entry", () => {
    const raw = serializeMetadataFrontmatter({ id: "pin-1", text: "locked", created: "2026-08-02", last: "2026-08-02", pin: true });
    assert.strictEqual(isPinned(raw), true);
  });

  it("returns false for an unpinned frontmatter entry", () => {
    const raw = serializeMetadataFrontmatter({ id: "no-pin", text: "free", created: "2026-08-02", last: "2026-08-02" });
    assert.strictEqual(isPinned(raw), false);
  });

  it("returns false for comment-shape entries (never pinned)", () => {
    const raw = serializeMetadataComment({ text: "legacy", created: "2026-05-09", lastReferenced: "2026-05-10" });
    assert.strictEqual(isPinned(raw), false);
  });

  it("returns false for malformed frontmatter (lenient fallback)", () => {
    const malformed = "---\npin: true\nbody with no close";
    assert.strictEqual(isPinned(malformed), false);
  });
});

// ─── Part 2 observability: the baked-in fixes now flow through the WIRED ───
// public decode call sites (parseMarkdownMemoryEntry, parseEntry) — they
// delegate to decodeMemoryEntry, so a malformed frontmatter no longer throws
// (baked-in fix (a)) and an id-less frontmatter surfaces no mdId (baked-in fix
// (b), NOT the literal "undefined"). Before Part 2 each site re-parsed the
// frontmatter itself and threw on a missing closing fence.
describe("Part 2 wiring — leniency + id read flow through the wired sites", () => {
  const malformedFm = "---\nid: gone\ncreated: 2026-08-02\nlast: 2026-08-02\nbody with no closing fence";
  const idlessFm = "---\ncreated: 2026-08-02\nlast: 2026-08-02\n---\nreal body";

  it("parseMarkdownMemoryEntry does NOT throw on malformed frontmatter (lenient)", () => {
    let e: ReturnType<typeof parseMarkdownMemoryEntry> | undefined;
    assert.doesNotThrow(() => {
      e = parseMarkdownMemoryEntry(malformedFm, "memory", null);
    });
    assert.ok(e);
    assert.strictEqual(e!.target, "memory");
    assert.strictEqual(e!.mdId, undefined); // lenient fallback carries no id
  });

  it("parseMarkdownMemoryEntry surfaces NO mdId for an id-less frontmatter (typeof-id read)", () => {
    const e = parseMarkdownMemoryEntry(idlessFm, "memory", null);
    assert.strictEqual(e.content, "real body");
    assert.strictEqual(e.mdId, undefined); // NOT the literal "undefined"
    assert.notStrictEqual(e.mdId, "undefined" as unknown as undefined);
  });

  it("parseEntry does NOT throw on malformed frontmatter (lenient)", () => {
    let e: ReturnType<typeof parseEntry> | undefined;
    assert.doesNotThrow(() => {
      e = parseEntry(malformedFm);
    });
    assert.ok(e);
    assert.match(e!.content, /no closing fence/);
    assert.strictEqual(e!.mdId, undefined); // lenient fallback carries no id
  });

  it("parseEntry surfaces NO mdId for an id-less frontmatter (typeof-id read)", () => {
    const e = parseEntry(idlessFm);
    assert.strictEqual(e.content, "real body");
    assert.strictEqual(e.mdId, undefined); // NOT the literal "undefined"
    assert.notStrictEqual(e.mdId, "undefined" as unknown as undefined);
  });
});
