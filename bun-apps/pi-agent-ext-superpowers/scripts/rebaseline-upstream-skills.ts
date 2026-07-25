#!/usr/bin/env bun
/**
 * rebaseline-upstream-skills.ts — regenerate the skill-fidelity baseline.
 *
 * Guarded by tests/skills-fidelity.test.ts (ADR-0004). Run this ONLY when
 * re-syncing the superpowers SKILL.md from upstream. It is NEVER automatic.
 *
 * What it does:
 *   - Copies each skills/<name>/SKILL.md → tests/__fixtures__/upstream-skills/<name>.md
 *   - PRESERVES UPSTREAM.ref (never clobbers provenance) and reminds you to
 *     update its upstream-ref if this was an upstream re-sync.
 *
 * After running: review the fixture diff in your PR, update UPSTREAM.ref's
 * upstream-ref to the new commit/version, then commit. The pin test then passes
 * against the new baseline.
 *
 * Usage: bun scripts/rebaseline-upstream-skills.ts
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const skillsDir = join(root, "..", "skills");
const fixturesDir = join(root, "..", "tests", "__fixtures__", "upstream-skills");

// Keep in sync with tests/skills-fidelity.test.ts PORTED_SKILLS.
// Every dir under skills/ is currently an upstream port; if a pi-owned skill is
// ever added here, EXCLUDE it from this list (and the test) so it isn't pinned.
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
];

mkdirSync(fixturesDir, { recursive: true });

let copied = 0;
for (const name of PORTED_SKILLS) {
  const src = join(skillsDir, name, "SKILL.md");
  if (!existsSync(src)) {
    console.error(`✗ missing skill source: ${src}`);
    process.exit(1);
  }
  copyFileSync(src, join(fixturesDir, `${name}.md`));
  copied++;
}
console.log(`✓ re-baselined ${copied} skill fixture(s) → ${fixturesDir}`);

const refPath = join(fixturesDir, "UPSTREAM.ref");
if (!existsSync(refPath)) {
  console.error(
    `✗ UPSTREAM.ref missing. Create it at ${refPath} declaring the upstream source ` +
      "(see ADR-0004). The pin test requires it to be present and non-empty.",
  );
  process.exit(1);
}
console.log(
  `✓ preserved UPSTREAM.ref — if this was an upstream re-sync, EDIT it to record the new upstream-ref: ${refPath}`,
);
