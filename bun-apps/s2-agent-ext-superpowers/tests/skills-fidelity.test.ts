import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeFixturesDigest,
  FIXTURES_DIGEST_KEY,
  PORTED_SKILLS,
  readFixturesDigest,
} from "../scripts/skill-provenance.js";

/**
 * Skill fidelity guard (ADR-superpowers-0004).
 *
 * The upstream-ported superpowers SKILL.md must be byte-identical to their
 * committed baseline fixtures. A convention injection (#664/#676/#678 — repo
 * conventions written into upstream skill bodies) slipped through the
 * structure-only skills.test.ts; it now fails HERE, in CI, loudly.
 *
 * Mechanism: positive content pin (not a denylist). The repo's own dep-guard
 * (ADR-monorepo-0001) showed denylists/regex miss things — a pin catches ALL drift:
 * convention injection, accidental edit, and upstream drift.
 *
 * The pin alone was not enough. Re-baselining is legitimate and routine, and
 * UPSTREAM.ref — the record of WHAT the current fixtures are and which local
 * divergences a future re-port must preserve — was guarded only by "exists and
 * is non-empty". So a re-baseline could rewrite every fixture and leave the
 * record describing the old state, with the suite green. PR #1682 did exactly
 * that: 708 lines compressed out of five ported skills, zero lines added to
 * UPSTREAM.ref. The `fixtures-digest` assertion below closes it — the record
 * now cannot go stale without going red.
 *
 * Which skills are pinned is derived from scripts/skill-provenance.ts, not
 * restated here: an `upstream` skill is pinned by declaration, so a new port
 * cannot ship unguarded by being forgotten in a second list.
 *
 * Re-sync: run `bun scripts/rebaseline-upstream-skills.ts --note "<why>"`
 * (NEVER automatic) — it copies the skills into these fixtures AND rewrites
 * UPSTREAM.ref's digest + log so every re-port leaves a provenance record.
 *
 * NOT in scope: using-superpowers/references/*.md (the sanctioned #639 pi-port
 * glue) — only SKILL.md files are pinned.
 */
const skillsDir = join(import.meta.dir, "..", "skills");
const fixturesDir = join(import.meta.dir, "__fixtures__", "upstream-skills");
const refPath = join(fixturesDir, "UPSTREAM.ref");

describe("skill fidelity (ADR-superpowers-0004) — upstream-ported SKILL.md byte-equal baseline", () => {
  for (const name of PORTED_SKILLS) {
    it(`${name}/SKILL.md matches its baseline fixture`, () => {
      const skill = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
      const fixturePath = join(fixturesDir, `${name}.md`);
      if (!existsSync(fixturePath)) {
        // Missing fixture = guard not yet baselined for this skill.
        throw new Error(
          `Missing baseline fixture ${fixturePath}. ` +
            `Run \`bun scripts/rebaseline-upstream-skills.ts --note "<why>"\` to (re)baseline.`,
        );
      }
      const fixture = readFileSync(fixturePath, "utf8");
      expect(skill).toBe(fixture);
    });
  }

  it("UPSTREAM.ref provenance record exists and is non-empty", () => {
    expect(existsSync(refPath), "UPSTREAM.ref missing — re-baseline without provenance").toBe(true);
    const ref = readFileSync(refPath, "utf8").trim();
    expect(ref.length, "UPSTREAM.ref is empty — every re-port must declare its source").toBeGreaterThan(0);
  });

  it(`UPSTREAM.ref's ${FIXTURES_DIGEST_KEY} matches the fixtures it describes`, () => {
    const recorded = readFixturesDigest(readFileSync(refPath, "utf8"));
    expect(
      recorded,
      `UPSTREAM.ref carries no ${FIXTURES_DIGEST_KEY}: line — the provenance record is not tied to any fixture state`,
    ).not.toBeNull();
    expect(
      recorded,
      "UPSTREAM.ref describes a different fixture state than the one committed. The fixtures were " +
        'changed without re-recording provenance — run `bun scripts/rebaseline-upstream-skills.ts --note "<why>"`.',
    ).toBe(computeFixturesDigest(fixturesDir));
  });

  it("no orphan fixtures — every pinned fixture belongs to a currently-declared upstream skill", () => {
    const onDisk = readdirSync(fixturesDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -".md".length))
      .sort();
    // An orphan is invisible to the digest (it hashes the declared list only),
    // so a removed/reclassified skill would leave its old body pinned to nothing.
    expect(onDisk).toEqual([...PORTED_SKILLS].sort());
  });
});
