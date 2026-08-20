import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Cross-skill reference guard.
 *
 * Skills point at each other by `<package-short-name>:<skill-name>` — the
 * "single source" idiom. ext-simplification-round-2 (#1682) leaned on it hard:
 * five wayfind skills each carry a pointer block deferring dispatch discipline
 * to `superpowers:dispatch-recovery` instead of restating the rules. That is
 * the right shape, and it has one failure mode — rename or remove the target
 * and every pointer silently becomes a dead end. An agent following one gets
 * nothing; no test notices, because 6 of the 11 references cross a package
 * boundary and each package's suite only ever sees its own skills/ directory.
 *
 * That is why this lives in bun-apps/tests/ rather than in either package:
 * it is the only place both sides of the reference are visible. Same reasoning
 * as tests/adr-citation.test.ts, which guards the same class of cross-document
 * pointer.
 *
 * Asymmetry worth knowing: the superpowers skill bodies are byte-pinned
 * (ADR-superpowers-0004), so their targets do not move by accident. The wayfind
 * pointer blocks are plain unpinned text. Drift is one-sided, and this guard
 * watches the side that can move.
 */

const bunApps = join(import.meta.dir, "..");

/** `s2-agent-ext-wayfind` → `wayfind`; the prefix skills actually write. */
function shortName(pkgDir: string): string {
  return pkgDir.replace(/^s2-agent-ext-/, "");
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Every `<short>:<skill>` this monorepo ships, and where each SKILL.md lives. */
function collectSkills(): { owned: Set<string>; shorts: string[]; files: { pkg: string; skill: string; path: string }[] } {
  const owned = new Set<string>();
  const shorts: string[] = [];
  const files: { pkg: string; skill: string; path: string }[] = [];
  for (const pkg of readdirSync(bunApps)) {
    const skillsDir = join(bunApps, pkg, "skills");
    if (!isDir(skillsDir)) continue;
    shorts.push(shortName(pkg));
    for (const skill of readdirSync(skillsDir)) {
      if (!isDir(join(skillsDir, skill))) continue;
      owned.add(`${shortName(pkg)}:${skill}`);
      files.push({ pkg, skill, path: join(skillsDir, skill, "SKILL.md") });
    }
  }
  return { owned, shorts, files };
}

const { owned, shorts, files } = collectSkills();

// Longest-first so `hermes-memory:` is not matched as a bare `hermes` prefix.
// `(?<!/)` excludes slash-command invocations: `/btw:new` is the btw
// extension's COMMAND, not a pointer to a `btw:new` skill — the collision
// became live when the btw skill moved to its owning package (short name
// `btw`) and its own command docs started matching the pointer pattern.
const referencePattern = new RegExp(
  `(?<!/)\\b(${[...shorts].sort((a, b) => b.length - a.length).join("|")}):([a-z0-9][a-z0-9-]*)\\b`,
  "g",
);

interface Reference {
  ref: string;
  from: string;
}

function collectReferences(): Reference[] {
  const refs: Reference[] = [];
  for (const { pkg, skill, path } of files) {
    let body: string;
    try {
      body = readFileSync(path, "utf8");
    } catch {
      continue; // a skill dir with no SKILL.md is skills.test.ts's business, not ours
    }
    for (const match of body.matchAll(referencePattern)) {
      refs.push({ ref: `${match[1]}:${match[2]}`, from: `${pkg}/${skill}` });
    }
  }
  return refs;
}

const references = collectReferences();

describe("cross-skill references resolve", () => {
  it("every <package>:<skill> reference names a skill that exists", () => {
    const dangling = [...new Set(references.filter((r) => !owned.has(r.ref)).map((r) => `${r.from} → ${r.ref}`))].sort();
    expect(dangling, "a skill points at a skill that does not exist — the pointer is a dead end for any agent following it").toEqual([]);
  });

  it("the scanner still finds references at all (a guard that matches nothing passes silently)", () => {
    // Not a style assertion: if the pattern or the discovery walk breaks, every
    // other assertion here goes vacuously green. This is the canary for that.
    expect(references.length).toBeGreaterThan(0);
  });

  it("cross-package references are covered — the case no single package's suite can see", () => {
    const crossPackage = references.filter((r) => shortName(r.from.split("/")[0]) !== r.ref.split(":")[0]);
    expect(crossPackage.length).toBeGreaterThan(0);
  });
});
