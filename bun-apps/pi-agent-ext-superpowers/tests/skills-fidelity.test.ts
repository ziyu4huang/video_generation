import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Skill fidelity guard (ADR-0004).
 *
 * The 14 upstream-ported superpowers SKILL.md must be byte-identical to their
 * committed baseline fixtures. A convention injection (#664/#676/#678 — repo
 * conventions written into upstream skill bodies) slipped through the
 * structure-only skills.test.ts; it now fails HERE, in CI, loudly.
 *
 * Mechanism: positive content pin (not a denylist). The repo's own dep-guard
 * (ADR-monorepo-0001) showed denylists/regex miss things — a pin catches ALL drift:
 * convention injection, accidental edit, and upstream drift.
 *
 * Re-sync: run scripts/rebaseline-upstream-skills.ts (NEVER automatic) — it
 * copies the skills into these fixtures AND writes UPSTREAM.ref so every re-port
 * leaves a traceable provenance record.
 *
 * NOT in scope: using-superpowers/references/*.md (the sanctioned #639 pi-port
 * glue) — only SKILL.md files are pinned.
 */
const skillsDir = join(import.meta.dir, "..", "skills");
const fixturesDir = join(import.meta.dir, "__fixtures__", "upstream-skills");

/** Every upstream-ported superpowers skill (the risk set, not the 6 incident skills). */
const PORTED_SKILLS = [
  "brainstorming",
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
] as const;

describe("skill fidelity (ADR-0004) — upstream-ported SKILL.md byte-equal baseline", () => {
  for (const name of PORTED_SKILLS) {
    it(`${name}/SKILL.md matches its baseline fixture`, () => {
      const skill = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
      const fixturePath = join(fixturesDir, `${name}.md`);
      if (!existsSync(fixturePath)) {
        // Missing fixture = guard not yet baselined for this skill.
        throw new Error(
          `Missing baseline fixture ${fixturePath}. ` +
            `Run \`bun scripts/rebaseline-upstream-skills.ts\` to (re)baseline.`,
        );
      }
      const fixture = readFileSync(fixturePath, "utf8");
      expect(skill).toBe(fixture);
    });
  }

  it("UPSTREAM.ref provenance record exists and is non-empty", () => {
    const refPath = join(fixturesDir, "UPSTREAM.ref");
    expect(existsSync(refPath), "UPSTREAM.ref missing — re-baseline without provenance").toBe(true);
    const ref = readFileSync(refPath, "utf8").trim();
    expect(ref.length, "UPSTREAM.ref is empty — every re-port must declare its source").toBeGreaterThan(0);
  });
});
