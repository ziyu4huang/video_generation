#!/usr/bin/env bun
/**
 * rebaseline-upstream-skills.ts — regenerate the skill-fidelity baseline.
 *
 * Guarded by tests/skills-fidelity.test.ts (ADR-superpowers-0004). Run this ONLY
 * when the ported SKILL.md legitimately changed — an upstream re-sync, or a
 * sanctioned local edit. It is NEVER automatic.
 *
 * What it does:
 *   - Copies each skills/<name>/SKILL.md → tests/__fixtures__/upstream-skills/<name>.md
 *     for every skill declared `upstream` in scripts/skill-provenance.ts, and
 *     removes fixtures that no longer answer to a declared upstream skill.
 *   - Rewrites UPSTREAM.ref's `fixtures-digest:` to match what it just wrote,
 *     and appends the mandatory `--note` to the re-baseline log.
 *
 * Why --note is mandatory: the record is the whole point. UPSTREAM.ref tells the
 * next re-porter which divergences to preserve, and it used to be possible —
 * and it happened, in PR #1682 — to rewrite every fixture while leaving the
 * record describing a state that no longer existed. The note is one line and it
 * is the only thing that carries WHY the bytes moved.
 *
 * Usage: bun scripts/rebaseline-upstream-skills.ts --note "<why the fixtures moved>"
 *        [--divergence <skill>:<marker>]...   record a machine-readable local
 *        divergence row: `divergence: <skill> | <marker>` — the marker is a
 *        substring that MUST remain in that skill's SKILL.md (asserted by
 *        tests/skills-fidelity.test.ts), so an upstream re-sync that drops a
 *        sanctioned local section goes red even after a legitimate re-baseline.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeFixturesDigest, FIXTURES_DIGEST_KEY, PORTED_SKILLS } from "./skill-provenance.js";

const LOG_HEADER = "# Re-baseline log (appended by scripts/rebaseline-upstream-skills.ts):";
const DIVERGENCE_PREFIX = "divergence: ";

function parseNote(argv: string[]): string | null {
  const i = argv.indexOf("--note");
  if (i === -1) return null;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--") || value.trim() === "") return null;
  return value.trim();
}

/** Repeatable `--divergence <skill>:<marker>` → `["<skill> | <marker>", …]` rows. */
function parseDivergences(argv: string[]): string[] {
  const rows: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--divergence") continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) continue;
    const sep = value.indexOf(":");
    if (sep <= 0) {
      console.error(`✗ --divergence expects <skill>:<marker> (got "${value}")`);
      process.exit(2);
    }
    const skill = value.slice(0, sep).trim();
    const marker = value.slice(sep + 1).trim();
    if (!PORTED_SKILLS.includes(skill)) {
      console.error(`✗ --divergence skill "${skill}" is not a declared upstream skill`);
      process.exit(2);
    }
    rows.push(`${skill} | ${marker}`);
  }
  return rows;
}

const note = parseNote(process.argv.slice(2));
if (note === null) {
  console.error(
    'usage: bun scripts/rebaseline-upstream-skills.ts --note "<why the fixtures moved>"\n' +
      "\n" +
      "The note is recorded in UPSTREAM.ref's re-baseline log. It is required:\n" +
      "a fixture rewrite with no record is the exact failure this script exists\n" +
      "to prevent (see PR #1682).",
  );
  process.exit(2);
}

const root = import.meta.dir;
const skillsDir = join(root, "..", "skills");
const fixturesDir = join(root, "..", "tests", "__fixtures__", "upstream-skills");
const refPath = join(fixturesDir, "UPSTREAM.ref");

mkdirSync(fixturesDir, { recursive: true });

for (const name of PORTED_SKILLS) {
  const src = join(skillsDir, name, "SKILL.md");
  if (!existsSync(src)) {
    console.error(`✗ missing skill source: ${src}`);
    process.exit(1);
  }
  copyFileSync(src, join(fixturesDir, `${name}.md`));
}
console.log(`✓ re-baselined ${PORTED_SKILLS.length} skill fixture(s) → ${fixturesDir}`);

// A fixture with no declared upstream skill behind it pins a body nothing ships.
const orphans = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".md"))
  .filter((f) => !PORTED_SKILLS.includes(f.slice(0, -".md".length)));
for (const orphan of orphans) {
  rmSync(join(fixturesDir, orphan));
  console.log(`✓ removed orphan fixture ${orphan} (no longer a declared upstream skill)`);
}

if (!existsSync(refPath)) {
  console.error(
    `✗ UPSTREAM.ref missing. Create it at ${refPath} declaring the upstream source ` +
      "(see ADR-superpowers-0004). The pin test requires it to be present and non-empty.",
  );
  process.exit(1);
}

// --divergence rows: dedup against what UPSTREAM.ref already carries, then
// insert beside any existing divergence block (before the re-baseline log).
const divergenceRows = parseDivergences(process.argv.slice(2));
const digest = computeFixturesDigest(fixturesDir);
const today = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD, local — matches commit dates
const digestLine = `${FIXTURES_DIGEST_KEY}: ${digest}`;
const digestPattern = new RegExp(`^${FIXTURES_DIGEST_KEY}:[ \\t]*\\S*[ \\t]*$`, "m");

let ref = readFileSync(refPath, "utf8");
ref = digestPattern.test(ref)
  ? ref.replace(digestPattern, digestLine)
  : `${ref.replace(/\n*$/, "\n")}\n${digestLine}\n`;
if (!ref.includes(LOG_HEADER)) ref = `${ref.replace(/\n*$/, "\n")}\n${LOG_HEADER}\n`;

// Insert new divergence rows beside any existing block (just before the log),
// deduped — a repeated --divergence is idempotent.
const existingRows = new Set(
  ref
    .split("\n")
    .filter((line) => line.startsWith(DIVERGENCE_PREFIX))
    .map((line) => line.slice(DIVERGENCE_PREFIX.length).trim()),
);
const freshRows = divergenceRows.filter((row) => !existingRows.has(row));
if (freshRows.length > 0) {
  const block = freshRows.map((row) => `${DIVERGENCE_PREFIX}${row}\n`).join("");
  const logIdx = ref.indexOf(LOG_HEADER);
  ref =
    logIdx >= 0 ? `${ref.slice(0, logIdx)}${block}\n${ref.slice(logIdx)}` : `${ref.replace(/\n*$/, "\n")}\n${block}`;
  console.log(`✓ recorded ${freshRows.length} divergence row(s) (marker asserted by skills-fidelity.test.ts)`);
}

ref = `${ref.replace(/\n*$/, "\n")}#   ${today} — ${note} (${digest.slice(0, 19)}…)\n`;
writeFileSync(refPath, ref);

console.log(`✓ UPSTREAM.ref updated: ${digestLine}`);
console.log(`✓ logged: ${today} — ${note}`);
console.log(
  "→ review the fixture diff in your PR. If this was an UPSTREAM re-sync, also edit\n" +
    "  UPSTREAM.ref's upstream-ref: to the new commit/version, and add a LOCAL-DIVERGENCES\n" +
    "  row for any repo-local section a future naive re-port would blow away.",
);
