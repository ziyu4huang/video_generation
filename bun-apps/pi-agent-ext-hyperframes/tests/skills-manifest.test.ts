import { describe, expect, it } from "bun:test";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the vendored HyperFrames skill family.
 *
 * Adapted from pi-agent-ext-superpowers/tests/skills.test.ts. The content is a
 * byte-identical vendored port from heygen-com/hyperframes — upstream authoring
 * conventions are NOT asserted, only:
 *  - the exact 8-skill roster (a partial/over-complete vendor fails loudly)
 *  - what Pi's skill loader actually enforces (frontmatter `name` +
 *    `description`, valid YAML, name is hyphen-only)
 *  - vendoring integrity: no symlinks left behind, and the heavy binary assets
 *    (mp3 SFX, woff2 fonts) actually made it into the repo copy
 *
 * Deterministic: no LLM, no network. Runs in `bun test`.
 */

const EXPECTED_SKILLS = [
  "hyperframes",
  "hyperframes-animation",
  "hyperframes-cli",
  "hyperframes-core",
  "hyperframes-creative",
  "hyperframes-keyframes",
  "hyperframes-registry",
  "media-use",
] as const;

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
  // Real YAML parse (matches pi's loader): several vendored skills use block
  // scalars (`description: >`), which a line-by-line scan cannot read.
  const parsed = Bun.YAML.parse(raw) as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") fields[key] = value.trim();
  }
  return { raw, fields };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = lstatSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const skillFiles = listSkillFiles();

describe("vendored skill roster", () => {
  it(`discovers exactly the ${EXPECTED_SKILLS.length} expected skills`, () => {
    const names = skillFiles.map((s) => s.name).sort();
    expect(
      names,
      "skills/ content disagrees with EXPECTED_SKILLS. A re-vendor that adds or drops a skill " +
        "directory must update this roster (and the README table).",
    ).toEqual([...EXPECTED_SKILLS].sort());
  });
});

describe("vendoring integrity", () => {
  it("contains no symlinks (the sh deploy copies dereferenced, but source mode reads in place)", () => {
    const symlinks = walk(skillsDir).filter((p) => lstatSync(p).isSymbolicLink());
    expect(symlinks).toEqual([]);
  });

  it("media-use ships its mp3 SFX assets (guards against a text-only partial copy)", () => {
    // Vendored 2026-08-08 with 19 mp3; lower bound tolerates upstream churn
    // while still failing a text-only copy.
    const sfx = walk(join(skillsDir, "media-use")).filter((p) => p.endsWith(".mp3"));
    expect(sfx.length).toBeGreaterThanOrEqual(15);
  });

  it("hyperframes-creative ships its woff2 fonts (OFL-licensed frame presets)", () => {
    // Vendored 2026-08-08 with 6 woff2; same partial-copy rationale.
    const fonts = walk(join(skillsDir, "hyperframes-creative")).filter((p) => p.endsWith(".woff2"));
    expect(fonts.length).toBeGreaterThanOrEqual(5);
  });
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

    it("has a name field matching the directory name", () => {
      expect(fields.name).toBe(name);
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

    it("is model-invocable (no disable-model-invocation frontmatter)", () => {
      // The whole point of vendoring is that pi surfaces these in the system
      // prompt's <available_skills> block; a disabled skill would silently vanish.
      expect(fields["disable-model-invocation"]).toBeUndefined();
    });
  });
}
