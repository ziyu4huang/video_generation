import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the skill-authoring CSO rules (the same rules pi's skill loader enforces):
 *  - frontmatter present with `name` + `description`
 *  - frontmatter parses as valid YAML under a REAL parser (Bun.YAML) — pi's skill
 *    loader uses a real YAML parser; the naive split-on-first-colon parser below
 *    cannot detect a `: ` inside an unquoted scalar, so this guard is what catches
 *    the "Nested mappings are not allowed" class that breaks loading at runtime
 *  - `name` is hyphen-only (^[a-z0-9-]+$), verb-first where possible
 *  - `description` starts with "Use when" (trigger-only; never a workflow summary)
 *  - total frontmatter ≤ 1024 chars (agentskills.io spec)
 *  - body has a top-level H1 heading
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
  it("discovers all 6 expected skills", () => {
    const names = skillFiles.map((s) => s.name).sort();
    for (const expected of ["domain-modeling", "grill-me", "grill-me-with-docs", "grilling", "to-spec", "to-tickets"]) {
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

      it("frontmatter is valid YAML to a real parser (Bun.YAML — matches pi's loader)", () => {
        expect(() => Bun.YAML.parse(`---\n${raw}\n---`)).not.toThrow();
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
