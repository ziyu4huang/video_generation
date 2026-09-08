/**
 * skills-integrity.test.ts — self-arc-15 t01: the FULL 16-skill inventory guard.
 *
 * skills.test.ts guards loading rules over whatever it DISCOVERS, and its
 * expected-list covers only 6 of the 16 skill dirs (one-directional toContain)
 * — a silently removed or renamed skill outside that 6 shipped green. This test
 * pins the golden 16-name set EXACTLY (both directions) plus name==dir, so the
 * family's primary surface — the skills themselves — cannot drift silently.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const skillsDir = join(import.meta.dir, "..", "skills");

/** The golden inventory — 16 wayfind skills, measured 2026-09-09. */
const GOLDEN = [
  "ask-matt",
  "codebase-design",
  "domain-modeling",
  "grill-me",
  "grill-me-with-docs",
  "grilling",
  "handoff",
  "improve-codebase-architecture",
  "resolving-merge-conflicts",
  "teach",
  "to-questionnaire",
  "to-spec",
  "to-tickets",
  "triage",
  "wait-what",
  "wizard",
] as const;

function skillDirs(): string[] {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function frontmatterField(content: string, key: string): string | undefined {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return undefined;
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0 && line.slice(0, idx).trim() === key) {
      return line
        .slice(idx + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}

describe("skills-integrity (self-arc-15 t01)", () => {
  test("golden 16-name set matches skills/ exactly (both directions)", () => {
    expect(skillDirs()).toEqual([...GOLDEN]);
  });

  for (const name of GOLDEN) {
    test(`${name}: SKILL.md exists, frontmatter name == dir, description non-empty`, () => {
      const p = join(skillsDir, name, "SKILL.md");
      expect(statSync(p).isFile()).toBe(true);
      const content = readFileSync(p, "utf8");
      expect(frontmatterField(content, "name")).toBe(name);
      const desc = frontmatterField(content, "description");
      expect(desc).toBeDefined();
      expect((desc ?? "").length).toBeGreaterThanOrEqual(20);
    });
  }
});
