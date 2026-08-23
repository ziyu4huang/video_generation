/**
 * skill-provenance.ts — the ONE list of which skills this package ships and
 * where each one came from.
 *
 * Why this file exists: the same set of skill names used to be written out
 * three times — `EXPECTED_SKILLS` in tests/skills.test.ts (the directory set),
 * `PORTED_SKILLS` in tests/skills-fidelity.test.ts (the byte-pinned set), and
 * `PORTED_SKILLS` again in scripts/rebaseline-upstream-skills.ts (the set the
 * re-baseline copies). Three hand-maintained lists that must agree, with only
 * a "keep in sync" comment holding them together. The dangerous drift is silent
 * in the direction that matters: a new upstream port added to the directory
 * list but forgotten in the pinned list ships UNGUARDED, and every test stays
 * green — nothing asserts the lists agree, because there is nothing to assert
 * them against.
 *
 * Now provenance is the declaration and the lists are derived from it, so
 * adding a skill is one edit that cannot omit the pin: you must say where the
 * skill came from, and `upstream` is what pins it.
 *
 * This lives under scripts/ rather than src/ on purpose — its only consumers
 * are the two guard tests and the re-baseline script. `src/` stays the runtime
 * / library face of the package (see package.json `main`).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `upstream` — ported from obra/superpowers. Byte-pinned against a committed
 *   fixture (ADR-superpowers-0004); local edits are a deliberate, logged act.
 * `repo-owned` — authored here (promoted from .planning/knowledge). Deliberately
 *   NOT pinned: there is no upstream to drift from.
 */
export type SkillProvenance = "upstream" | "repo-owned";

export interface SkillRecord {
  readonly name: string;
  readonly provenance: SkillProvenance;
}

/** Every directory under skills/, with its provenance. Keep alphabetical. */
export const SKILLS: readonly SkillRecord[] = [
  { name: "brainstorming", provenance: "upstream" },
  { name: "deterministic-edit-dispatch", provenance: "repo-owned" },
  { name: "dispatch-recovery", provenance: "repo-owned" },
  { name: "dispatching-parallel-agents", provenance: "upstream" },
  { name: "executing-plans", provenance: "upstream" },
  { name: "finishing-a-development-branch", provenance: "upstream" },
  { name: "receiving-code-review", provenance: "upstream" },
  { name: "requesting-code-review", provenance: "upstream" },
  { name: "subagent-driven-development", provenance: "upstream" },
  { name: "systematic-debugging", provenance: "upstream" },
  { name: "test-driven-development", provenance: "upstream" },
  { name: "using-git-worktrees", provenance: "upstream" },
  { name: "using-superpowers", provenance: "upstream" },
  { name: "writing-plans", provenance: "upstream" },
  { name: "writing-skills", provenance: "upstream" },
];

/** Every skill directory that must exist under skills/. */
export const EXPECTED_SKILLS: readonly string[] = SKILLS.map((s) => s.name);

/** The subset whose SKILL.md is byte-pinned to a fixture. */
export const PORTED_SKILLS: readonly string[] = SKILLS.filter((s) => s.provenance === "upstream").map((s) => s.name);

/** The key UPSTREAM.ref uses to carry the digest of the fixtures it describes. */
export const FIXTURES_DIGEST_KEY = "fixtures-digest";

/**
 * Digest of the pinned fixture set.
 *
 * This is what ties the provenance record to the bytes it claims to describe.
 * UPSTREAM.ref used to be guarded only by "exists and is non-empty", so a
 * re-baseline could rewrite every fixture and leave the record untouched — and
 * did: PR #1682 compressed five ported skills by 708 lines without adding a
 * single line to UPSTREAM.ref, and the suite stayed green. The next re-porter
 * would have read a record describing a state that no longer existed.
 *
 * Name and content both feed the hash, so a renamed fixture changes it too.
 */
export function computeFixturesDigest(fixturesDir: string): string {
  const hash = createHash("sha256");
  for (const name of [...PORTED_SKILLS].sort()) {
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(join(fixturesDir, `${name}.md`)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Reads the `fixtures-digest:` line out of UPSTREAM.ref, or null if absent. */
export function readFixturesDigest(refText: string): string | null {
  const match = refText.match(new RegExp(`^${FIXTURES_DIGEST_KEY}:[ \\t]*(\\S+)[ \\t]*$`, "m"));
  return match ? match[1] : null;
}
