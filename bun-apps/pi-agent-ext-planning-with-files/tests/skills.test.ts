import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the skill-authoring CSO rules from the `writing-skills` meta-skill:
 *  - frontmatter present with `name` + `description`
 *  - `name` is hyphen-only (^[a-z0-9-]+$), verb-first where possible
 *  - `description` starts with "Use when" (trigger-only; never a workflow summary —
 *    a workflow summary causes models to follow the description and skip the body)
 *  - total frontmatter ≤ 1024 chars (agentskills.io spec)
 *
 * Deterministic: no LLM, no network. Runs in `bun test`.
 */

const skillsDir = join(import.meta.dir, "..", "skills");

function listSkillFiles(): { name: string; path: string }[] {
  return readdirSync(skillsDir)
    .filter((entry) => statSync(join(skillsDir, entry)).isDirectory())
    .map((name) => ({ name, path: join(skillsDir, name, "SKILL.md") }))
    .filter((entry) => {
      try {
        statSync(entry.path);
        return true;
      } catch {
        return false;
      }
    });
}

function parseFrontmatter(content: string): { raw: string; fields: Record<string, string> } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { raw: "", fields: {} };
  const raw = match[1];
  const fields: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const value = line
        .slice(idx + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (key) fields[key] = value;
    }
  }
  return { raw, fields };
}

const skillFiles = listSkillFiles();

describe("skills suite (writing-skills CSO rules)", () => {
  it("discovers at least the 6 expected skills", () => {
    const names = skillFiles.map((s) => s.name).sort();
    expect(names).toContain("planning-with-files");
    // the 5 methodology skills ported from superpowers
    for (const expected of [
      "brainstorming",
      "writing-plans",
      "executing-plans",
      "verification-before-completion",
      "systematic-debugging",
    ]) {
      expect(names).toContain(expected);
    }
  });

  for (const { name, path } of skillFiles) {
    describe(`skill: ${name}`, () => {
      const content = readFileSync(path, "utf8");
      const { raw, fields } = parseFrontmatter(content);

      it("has frontmatter delimited by ---", () => {
        expect(raw.length).toBeGreaterThan(0);
      });

      it("has a name field", () => {
        expect(fields.name).toBeTruthy();
      });

      it("name is lowercase hyphen-only (no spaces, brackets, or special chars)", () => {
        expect(fields.name).toMatch(/^[a-z0-9-]+$/);
      });

      it("has a description field", () => {
        expect(fields.description).toBeTruthy();
        expect(fields.description.length).toBeGreaterThan(20);
      });

      it('description starts with "Use when" (trigger-only, no workflow summary)', () => {
        expect(fields.description.startsWith("Use when")).toBe(true);
      });

      it("frontmatter is ≤ 1024 chars (agentskills.io spec)", () => {
        expect(raw.length).toBeLessThanOrEqual(1024);
      });

      it("has a top-level H1 heading in the body", () => {
        expect(/^#\s/m.test(content.replace(/^---[\s\S]*?---/, ""))).toBe(true);
      });
    });
  }
});
