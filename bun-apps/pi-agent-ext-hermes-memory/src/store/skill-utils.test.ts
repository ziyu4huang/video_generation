import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter, formatFrontmatter } from "./skill-utils.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("parseFrontmatter (delegates to splitFencedYaml — behavior change guard)", () => {
  it("parses a synthetic card: unquoted + double-quoted scalar + number + inline array + block array + nested map", () => {
    const raw = [
      "---",
      "name: grill-memory",
      'description: "Use when grilling — inform each recommendation"',
      "version: 3",
      "tags: [preference, insight, reject]",
      "triggers:",
      "  - memory_search",
      "  - grill_decision",
      "memworth:",
      "  success: 4",
      "  fail: 1",
      "created: 2026-06-28",
      "---",
      "# grill-memory",
      "",
      "Companion to `grilling`. Two protocols per decision.",
    ].join("\n");

    const parsed = parseFrontmatter(raw);
    // Shape preserved: flat string-keyed map.
    assert.equal(parsed.meta.name, "grill-memory");
    assert.equal(parsed.meta.description, "Use when grilling — inform each recommendation");
    assert.equal(parsed.meta.version, "3"); // number coerced to string
    assert.equal(parsed.meta.created, "2026-06-28");
    // Inline array survives (old regex parser left these as the raw "[a, b, c]"
    // substring on the same line; multi-line block arrays were dropped entirely).
    assert.ok(parsed.meta.tags!.includes("preference"));
    assert.ok(parsed.meta.tags!.includes("insight"));
    // Block array survives — the regex parser SILENTLY DROPPED these two lines.
    assert.ok(parsed.meta.triggers!.includes("memory_search"));
    assert.ok(parsed.meta.triggers!.includes("grill_decision"));
    // Nested map survives as a JSON round-trip string (fields not lost).
    assert.ok(parsed.meta.memworth!.includes("success"));
    assert.ok(parsed.meta.memworth!.includes("4"));
    // Body is everything after the closing fence, trimmed.
    assert.equal(parsed.body, "# grill-memory\n\nCompanion to `grilling`. Two protocols per decision.");
  });

  it("parses REAL package skill: skills/grill-memory/SKILL.md (unquoted scalars)", () => {
    const raw = readFileSync(join(here, "../../skills/grill-memory/SKILL.md"), "utf8");
    const parsed = parseFrontmatter(raw);
    assert.equal(parsed.meta.name, "grill-memory");
    assert.match(parsed.meta.description!, /grill-me session/);
    assert.ok(parsed.body.startsWith("# grill-memory"));
  });

  it("parses REAL package skill: skills/pi-memory-bulk-dedup/SKILL.md (mixed quoted/unquoted + numeric version)", () => {
    const raw = readFileSync(join(here, "../../skills/pi-memory-bulk-dedup/SKILL.md"), "utf8");
    const parsed = parseFrontmatter(raw);
    assert.equal(parsed.meta.name, "pi-memory-bulk-dedup");
    assert.match(parsed.meta.description!, /Bulk-dedup/);
    assert.equal(parsed.meta.version, "3"); // unquoted scalar `3` → number → "3"
    assert.equal(parsed.meta.created, "2026-06-28");
    assert.equal(parsed.meta.updated, "2026-08-07");
    assert.match(parsed.body, /Architecture/);
  });

  it("returns {meta:{}, body: raw.trim()} when there is no fence (no throw)", () => {
    const raw = "# just a heading\n\nno frontmatter here";
    const parsed = parseFrontmatter(raw);
    assert.deepEqual(parsed.meta, {});
    assert.equal(parsed.body, raw.trim());
  });

  it("formatFrontmatter round-trips a SkillDocument through parseFrontmatter", () => {
    const doc = {
      name: "round-trip-skill",
      displayName: "Round Trip",
      description: "survives the codec",
      version: 2,
      created: "2026-01-01",
      updated: "2026-02-02",
      body: "# body\n\nsome text",
    };
    const serialized = formatFrontmatter(doc);
    const parsed = parseFrontmatter(serialized);
    assert.equal(parsed.meta.name, "round-trip-skill");
    assert.equal(parsed.meta.description, "survives the codec");
    assert.equal(parsed.meta.version, "2");
    assert.equal(parsed.meta.created, "2026-01-01");
    assert.equal(parsed.meta.updated, "2026-02-02");
    assert.equal(parsed.meta.display_name, "Round Trip");
    assert.equal(parsed.body, "# body\n\nsome text");
  });
});
