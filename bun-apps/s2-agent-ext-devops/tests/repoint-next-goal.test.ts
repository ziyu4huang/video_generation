/**
 * repoint-next-goal tests — the write-path queue-pointer tool (self-arc-19 t02).
 *
 * Fixtures build minimal-but-FULLY-VALID strict-v2 goal files (the repoint
 * must pass validateNextGoalFile as-is), plus the live-incident shape: an
 * OLDER-named file that is a byte-copy of the NEWEST (its frontmatter `file:`
 * names the twin, exactly like the 2026-09-10 stale duplicate). Newest
 * filename wins; the byte-copy is deleted.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execRepoint, planRepoint } from "../src/repoint-next-goal.js";

const tempRoots: string[] = [];
function makeOutput(): string {
  const dir = mkdtempSync(join(tmpdir(), "repoint-ng-"));
  tempRoots.push(dir);
  return dir;
}
afterEach(() => {
  while (tempRoots.length) {
    const r = tempRoots.pop();
    if (r) rmSync(r, { recursive: true, force: true });
  }
});

/** A fully valid strict-v2 goal file (self-referential file:, created = filename ts). */
function goalSource(outputDir: string, ts: string, opts: { supersedes?: string } = {}): string {
  const self = join(outputDir, fname(ts));
  const supersedes = opts.supersedes === undefined ? "none" : opts.supersedes;
  const step =
    "Execute the queue head end-to-end through the devops chain: branch from origin/main, implement the tickets, run the canonical gates, merge, verify full scope, sync.";
  return [
    "---",
    `file: ${self}`,
    `created: ${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}`,
    `supersedes: ${supersedes}`,
    "---",
    "",
    "# Next goal — fixture",
    "",
    "## Verified this session",
    "",
    "Fixture verified: unit tests (bun test green).",
    "",
    "## Honest gaps",
    "",
    "Fixture gap: nothing real.",
    "",
    "## Immediate steps",
    "",
    `1. ${step}`,
    "",
    "## Done when",
    "",
    "- [ ] fixture box unchecked",
    "",
    "## Ranked next goals",
    "",
    "1. **first** — why + first step.",
    "2. **second** — why + first step.",
    "3. **third** — why + first step.",
    "",
  ].join("\n");
}

function writeGoal(outputDir: string, ts: string, opts: { supersedes?: string } = {}): string {
  const p = join(outputDir, fname(ts));
  writeFileSync(p, goalSource(outputDir, ts, opts), "utf8");
  return p;
}

const OLD = "20260101010101";
const NEW = "20260202020202";

const fname = (ts: string): string => `next-goal-${ts.slice(0, 8)}-${ts.slice(8)}.md`;

/** Seed the live-incident shape: OLDER file is a byte-copy of NEWEST. */
function seedDupPair(outputDir: string): { older: string; newer: string } {
  const newer = writeGoal(outputDir, NEW);
  const older = join(outputDir, fname(OLD));
  writeFileSync(older, readFileSync(newer, "utf8"), "utf8"); // byte-copy, stale name
  return { older, newer };
}

function seedLatest(outputDir: string, target: string): void {
  symlinkSync(target, join(outputDir, "LATEST-next-goal.md"));
}

describe("byte-duplicate dedupe (newest filename wins)", () => {
  it("deletes the older twin and repoints at the newest", () => {
    const out = makeOutput();
    const { older, newer } = seedDupPair(out);
    seedLatest(out, "whatever.md");
    const plan = planRepoint(out, newer);
    expect(plan.deletions.map((d) => d.file)).toEqual([older]);
    expect(plan.retargeted).toBe(false);
    const res = execRepoint(plan, { check: false });
    expect(res.ok).toBe(true);
    expect(res.deleted.map((d) => d.file)).toEqual([older]);
    expect(existsSync(older)).toBe(false);
    expect(existsSync(newer)).toBe(true);
    expect(res.repointed).toBe(true);
    expect(readlinkSync(join(out, "LATEST-next-goal.md"))).toBe(fname(NEW));
    expect(res.doctor?.ok).toBe(true);
  });

  it("re-targets when the REQUESTED target is itself the stale duplicate", () => {
    const out = makeOutput();
    const { older, newer } = seedDupPair(out);
    const plan = planRepoint(out, older);
    expect(plan.retargeted).not.toBe(false);
    if (plan.retargeted !== false) expect(plan.retargeted.to).toBe(newer);
    expect(plan.resolvedTarget).toBe(newer);
    const res = execRepoint(plan, { check: false });
    expect(res.ok).toBe(true);
    expect(existsSync(older)).toBe(false);
    expect(readlinkSync(join(out, "LATEST-next-goal.md"))).toBe(fname(NEW));
  });
});

describe("failure ordering: a failed repoint destroys nothing", () => {
  it("fails on supersedes-order (predecessor NEWER than target) without deleting or repointing", () => {
    const out = makeOutput();
    const newer = writeGoal(out, NEW);
    const older = writeGoal(out, OLD, { supersedes: newer }); // chain runs backwards
    const plan = planRepoint(out, older);
    expect(plan.supersedesOrder.ok).toBe(false);
    const res = execRepoint(plan, { check: false });
    expect(res.ok).toBe(false);
    expect(res.deleted).toEqual([]);
    expect(res.repointed).toBe(false);
    expect(existsSync(newer)).toBe(true);
    expect(existsSync(older)).toBe(true);
    expect(res.problems.some((p) => p.includes("supersedes-order"))).toBe(true);
  });

  it("fails on strict-validation failure (missing sections) without deleting anything", () => {
    const out = makeOutput();
    const { older, newer } = seedDupPair(out);
    const bad = join(out, fname("20260303030303"));
    writeFileSync(bad, "---\nfile: x\ncreated: nope\nsupersedes: none\n---\n\nno sections\n", "utf8");
    const plan = planRepoint(out, bad);
    expect(plan.validation?.ok).toBe(false);
    const res = execRepoint(plan, { check: false });
    expect(res.ok).toBe(false);
    expect(res.deleted).toEqual([]);
    expect(existsSync(older)).toBe(true); // untouched
    expect(existsSync(newer)).toBe(true);
  });
});

describe("--check mutates nothing", () => {
  it("reports the plan (deletions + re-target) but writes nothing", () => {
    const out = makeOutput();
    const { older, newer } = seedDupPair(out);
    seedLatest(out, "nonexistent.md");
    const before = readFileSync(older, "utf8");
    const plan = planRepoint(out, older);
    const res = execRepoint(plan, { check: true });
    expect(res.ok).toBe(true);
    expect(res.checkOnly).toBe(true);
    expect(res.deletions.length).toBe(1);
    expect(res.deleted).toEqual([]); // planned, not executed
    expect(res.repointed).toBe(false);
    expect(res.latestForm).toBe("untouched");
    expect(existsSync(older)).toBe(true);
    expect(readFileSync(older, "utf8")).toBe(before);
    expect(readlinkSync(join(out, "LATEST-next-goal.md"))).toBe("nonexistent.md"); // pointer untouched
    void newer;
  });
});

describe("clean queue + LATEST form", () => {
  it("clean queue: no deletions, repoint happens, doctor ok", () => {
    const out = makeOutput();
    const only = writeGoal(out, NEW);
    const plan = planRepoint(out, only);
    const res = execRepoint(plan, { check: false });
    expect(res.ok).toBe(true);
    expect(res.deletions).toEqual([]);
    expect(res.doctor?.ok).toBe(true);
  });

  it("a regular-file LATEST is switched to a symlink and the switch is reported", () => {
    const out = makeOutput();
    mkdirSync(out, { recursive: true });
    const only = writeGoal(out, NEW);
    writeFileSync(join(out, "LATEST-next-goal.md"), "stale content copy", "utf8");
    const res = execRepoint(planRepoint(out, only), { check: false });
    expect(res.ok).toBe(true);
    expect(lstatSync(join(out, "LATEST-next-goal.md")).isSymbolicLink()).toBe(true);
    expect(res.problems.some((p) => p.includes("was a regular content file"))).toBe(true);
  });
});
