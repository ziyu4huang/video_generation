/**
 * skills-inventory.test.ts — self-arc-16 t01: name==dir + full-set agreement.
 *
 * skills.test.ts asserts loading rules + the EXPECTED_SKILLS count over the
 * discovered set, and skills-fidelity byte-pins the UPSTREAM-ported skills —
 * but nothing asserts `frontmatter name == dir name` (a renamed dir or a
 * copy-pasted frontmatter name still loads under the FILE's name in some
 * hosts and the DIR's name in others), and nothing ties the three derived
 * lists (dirs, EXPECTED_SKILLS, golden) to the REPO-OWNED skills. This test
 * closes both: exact 16-set agreement + name==dir for every skill (repo-owned
 * especially — they have no upstream byte-pin to catch a rename).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPECTED_SKILLS, PORTED_SKILLS } from "../scripts/lib/skill-provenance.js";
import { listSkillDirs } from "./helpers/skill-dirs.js";

const skillsDir = join(import.meta.dir, "..", "skills");

/** The golden inventory — 16 superpowers skills, measured 2026-09-09. */
const GOLDEN = [
  "brainstorming",
  "deterministic-edit-dispatch",
  "dispatch-recovery",
  "dispatching-parallel-agents",
  "executing-plans",
  "finishing-a-development-branch",
  "probe-extension-introspection",
  "receiving-code-review",
  "requesting-code-review",
  "subagent-driven-development",
  "systematic-debugging",
  "test-driven-development",
  "using-git-worktrees",
  "using-superpowers",
  "writing-plans",
  "writing-skills",
] as const;

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

const repoOwned = [...GOLDEN].filter((s) => !PORTED_SKILLS.includes(s));

describe("skills-inventory (self-arc-16 t01)", () => {
  test("golden 16-name set == skills/ dirs == EXPECTED_SKILLS (three-way)", () => {
    const dirs = listSkillDirs(skillsDir)
      .map((s) => s.name)
      .sort();
    expect(dirs).toEqual([...GOLDEN]);
    expect([...EXPECTED_SKILLS].sort()).toEqual([...GOLDEN]);
  });

  test(`repo-owned skills carry name==dir (${repoOwned.join(", ")})`, () => {
    expect(repoOwned.length).toBeGreaterThan(0);
    for (const name of repoOwned) {
      const content = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
      expect(frontmatterField(content, "name")).toBe(name);
    }
  });

  test("every skill: frontmatter name == dir (ported included — a mismatch is drift)", () => {
    for (const { name, path } of listSkillDirs(skillsDir)) {
      const content = readFileSync(path, "utf8");
      expect(frontmatterField(content, "name")).toBe(name);
    }
  });
});
