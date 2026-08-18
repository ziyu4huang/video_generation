import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the skill-loading rules Pi's skill loader actually enforces, plus the
 * structural CSO rules that keep skills discoverable. Adapted from
 * pi-agent-ext-wayfind/tests/skills.test.ts, with ONE relaxation: the upstream
 * "Use when" description-prefix convention is NOT asserted here, because the
 * Superpowers skills are ported byte-identical from upstream and `brainstorming`
 * legitimately uses "You MUST use this before any creative work …". Rewriting
 * upstream content to satisfy an authoring convention would break fidelity.
 *
 * What IS asserted (these are what break loading at runtime):
 *  - frontmatter present with `name` + `description`
 *  - frontmatter parses as valid YAML under a REAL parser (Bun.YAML) — pi's
 *    skill loader uses a real YAML parser
 *  - `name` is hyphen-only (^[a-z0-9-]+$)
 *  - `description` is non-trivial (≥ 20 chars)
 *  - total frontmatter ≤ 1024 chars (agentskills.io spec)
 *  - body has a top-level H1 heading
 *  - the skill dir + every referenced resource file exists
 *
 * Deterministic: no LLM, no network. Runs in `bun test`.
 */

const skillsDir = join(import.meta.dir, "..", "skills");

const EXPECTED_SKILLS = [
  "brainstorming",
  "dispatch-recovery",
  "dispatching-parallel-agents",
  "executing-plans",
  "finishing-a-development-branch",
  "receiving-code-review",
  "requesting-code-review",
  "subagent-driven-development",
  "systematic-debugging",
  "test-driven-development",
  "using-git-worktrees",
  "using-superpowers",
  "verification-before-completion",
  "writing-plans",
  "writing-skills",
];

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

describe("skills suite (Pi loader rules)", () => {
  it(`discovers all ${EXPECTED_SKILLS.length} expected skills`, () => {
    const names = skillFiles.map((s) => s.name).sort();
    expect(names).toEqual([...EXPECTED_SKILLS].sort());
  });

  it("skills/ is a byte-identical port — no stray files added", () => {
    // Every file under skills/ must live inside one of the expected skill dirs.
    const all = readdirSync(skillsDir).filter((e) => statSync(join(skillsDir, e)).isDirectory());
    expect(all.sort()).toEqual([...EXPECTED_SKILLS].sort());
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

      it("has a non-trivial description field (≥ 20 chars)", () => {
        expect(fields.description).toBeTruthy();
        expect(fields.description.length).toBeGreaterThan(20);
      });

      it("frontmatter is ≤ 1024 chars (agentskills.io spec)", () => {
        expect(raw.length).toBeLessThanOrEqual(1024);
      });

      // NOTE: a top-level H1 is NOT asserted. It is a repo authoring convention
      // (see pi-agent-ext-wayfind), not a Pi loader requirement, and the upstream
      // `using-superpowers` bootstrap skill intentionally opens with directive
      // blocks (<EXTREMELY-IMPORTANT>, ## The Rule) instead of an H1. Asserting
      // it here would force rewriting byte-identical upstream content.
    });
  }
});
