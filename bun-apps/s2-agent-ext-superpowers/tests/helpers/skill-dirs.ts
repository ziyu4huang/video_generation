/**
 * Shared skills/ directory walker (ticket 02 test-deduce): one listing helper
 * for the tests that enumerate skill dirs (skills.test.ts, skill-exclude.test.ts).
 * Delegates to src's listSkillDirNames (same readdir/statSync-isDirectory/sort
 * walk) so src and tests can't drift.
 */
import { join } from "node:path";
import { listSkillDirNames } from "../../src/superpowers.js";

/** All immediate skill subdirs of a skills/ dir, sorted (the dir-names the
 *  exclude list keys on). */
export function allSkillDirNames(skillsDir: string): string[] {
  return listSkillDirNames(skillsDir);
}

/** Every skill dir that actually carries a SKILL.md (name + its path). */
export function listSkillDirs(skillsDir: string): { name: string; path: string }[] {
  return allSkillDirNames(skillsDir).map((name) => ({ name, path: join(skillsDir, name, "SKILL.md") }));
}
