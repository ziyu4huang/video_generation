import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Phase-2 weight gate for the always-on skill DESCRIPTIONS this effort targets.
 *
 * The `description:` frontmatter line is the only part of a skill that is
 * always-on (loaded into every request's system prompt so the model knows when
 * to `read` the full body). A thinned description that drops its trigger noun
 * would stop the skill from FIRING on the right cue — so this test pins two
 * invariants together for each target skill:
 *
 *   1. ≤ 150 chars   — the slim target (was 268–298 chars; ~217–224 tok each).
 *   2. trigger noun  — the cue the on-demand loader matches on is still present.
 *
 * Deterministic: pure file read + string check. Runs in `bun test`.
 *
 * NOTE on `grill-memory`'s path: the task brief lists
 * `bun-apps/s2-agent-ext-wayfind/skills/grill-memory/SKILL.md`, but that file
 * does NOT exist — `grill-memory` is packaged in the **hermes-memory**
 * extension (`bun-apps/s2-agent-ext-hermes-memory/skills/grill-memory/`), not
 * wayfind. The spec (section 6) names all three — domain-modeling, grilling,
 * grill-memory — as the Phase-2 always-on description targets, so grill-memory
 * IS in logical scope; only its on-disk location differs from the brief. This
 * test resolves the real path. See task-4-report.md → "Path discrepancy".
 */

const WAYFIND_SKILLS = join(import.meta.dir, "..", "skills");
// grill-memory physically lives in the hermes-memory package (one sibling over).
const HERMES_SKILLS = join(import.meta.dir, "..", "..", "s2-agent-ext-hermes-memory", "skills");

interface Target {
  name: string;
  /** Absolute path to the skill's SKILL.md. */
  path: string;
  /** Trigger noun that MUST survive the slim (lowercased substring match). */
  triggerNoun: string;
  /** Human-readable trigger-noun label for the assertion message. */
  triggerLabel: string;
}

const TARGETS: Target[] = [
  {
    name: "domain-modeling",
    path: join(WAYFIND_SKILLS, "domain-modeling", "SKILL.md"),
    triggerNoun: "ubiquitous language", // "glossary" also present; either is the cue
    triggerLabel: '"ubiquitous language" (or "glossary")',
  },
  {
    name: "grilling",
    path: join(WAYFIND_SKILLS, "grilling", "SKILL.md"),
    triggerNoun: "grill",
    triggerLabel: '"grill"',
  },
  {
    name: "grill-memory",
    path: join(HERMES_SKILLS, "grill-memory", "SKILL.md"),
    triggerNoun: "grill_decision", // "memory" also present; either is the cue
    triggerLabel: '"grill_decision" (or "memory")',
  },
];

const MAX_DESCRIPTION_CHARS = 150;

/** Extract the `description:` value from frontmatter (mirrors skills.test.ts' parser). */
function readDescription(skillPath: string): string {
  const content = readFileSync(skillPath, "utf8");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error(`no frontmatter in ${skillPath}`);
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0 && line.slice(0, idx).trim() === "description") {
      return line
        .slice(idx + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }
  throw new Error(`no description field in ${skillPath}`);
}

describe("Phase-2 skill description weight gate", () => {
  for (const t of TARGETS) {
    describe(`skill: ${t.name}`, () => {
      const description = readDescription(t.path);

      it(`description is ≤ ${MAX_DESCRIPTION_CHARS} chars (was 268–298)`, () => {
        expect(description.length, `desc is ${description.length} chars`).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
      });

      it(`description still contains its trigger noun ${t.triggerLabel}`, () => {
        // domain-modeling + grill-memory each have two acceptable trigger nouns;
        // pass if EITHER is present (mirrors the brief's "or" phrasing).
        const lower = description.toLowerCase();
        const alternatives = t.triggerLabel.match(/"[^"]+"/g)?.map((s) => s.replace(/"/g, "").toLowerCase()) ?? [
          t.triggerNoun.toLowerCase(),
        ];
        expect(
          alternatives.some((a) => lower.includes(a)),
          `none of ${alternatives} found in description`,
        ).toBe(true);
      });
    });
  }
});
