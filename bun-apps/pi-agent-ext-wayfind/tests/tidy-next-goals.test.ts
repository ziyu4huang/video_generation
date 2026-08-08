import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tidyNextGoals } from "../src/tidy-next-goals.js";

/** Fresh temp effort dir (owns an `output/` we can fill). Auto-removed on teardown. */
function tmpEffort(): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-tidy-"));
  mkdirSync(join(dir, "output"), { recursive: true });
  return dir;
}

/** Read sorted basenames of `output/` (for assertion convenience). */
const basenames = (effort: string): string[] => readdirSync(join(effort, "output")).sort();

describe("tidyNextGoals — Phase 1: filename normalization", () => {
  it("converts a dash separator to an underscore", () => {
    const dir = tmpEffort();
    try {
      writeFileSync(join(dir, "output", "next-goal-20260706-0531.md"), "x");
      const r = tidyNextGoals(dir);
      expect(r.normalized).toBe(1);
      expect(r.removed).toBe(0);
      expect(basenames(dir)).toEqual(["next-goal-20260706_053100.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pads missing seconds with trailing '0's (4-digit and 5-digit times)", () => {
    const dir = tmpEffort();
    try {
      writeFileSync(join(dir, "output", "next-goal-20260705_1100.md"), "a"); // -> _110000
      writeFileSync(join(dir, "output", "next-goal-20260705_22334.md"), "b"); // -> _223340
      const r = tidyNextGoals(dir);
      expect(r.normalized).toBe(2);
      expect(basenames(dir)).toEqual(["next-goal-20260705_110000.md", "next-goal-20260705_223340.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent on already-canonical names (second run is a no-op)", () => {
    const dir = tmpEffort();
    try {
      writeFileSync(join(dir, "output", "next-goal-20260705_110000.md"), "a");
      const first = tidyNextGoals(dir);
      expect(first).toEqual({ normalized: 0, removed: 0 });
      const second = tidyNextGoals(dir);
      expect(second).toEqual({ normalized: 0, removed: 0 });
      expect(basenames(dir)).toEqual(["next-goal-20260705_110000.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves unparsable next-goal names untouched (skipped, not renamed)", () => {
    const dir = tmpEffort();
    try {
      writeFileSync(join(dir, "output", "next-goal-foobar.md"), "x");
      writeFileSync(join(dir, "output", "next-goal-notes.md"), "y");
      const r = tidyNextGoals(dir, 10);
      expect(r.normalized).toBe(0);
      expect(basenames(dir)).toEqual(["next-goal-foobar.md", "next-goal-notes.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not clobber when a normalized name collides with an existing file", () => {
    const dir = tmpEffort();
    try {
      // canonical target already present; the un-padded one should NOT overwrite it.
      writeFileSync(join(dir, "output", "next-goal-20260705_110000.md"), "canonical");
      writeFileSync(join(dir, "output", "next-goal-20260705_1100.md"), "short");
      const r = tidyNextGoals(dir);
      expect(r.normalized).toBe(0); // collision → skipped, not renamed
      expect(readFileSync(join(dir, "output", "next-goal-20260705_110000.md"), "utf-8")).toBe("canonical");
      expect(existsSync(join(dir, "output", "next-goal-20260705_1100.md"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tidyNextGoals — Phase 2: retention (keep N newest)", () => {
  it("trims to keepN newest by lexicographic (timestamp) order and keeps the right ones", () => {
    const dir = tmpEffort();
    try {
      const files = [
        "next-goal-20260101_000000.md",
        "next-goal-20260303_000000.md",
        "next-goal-20260202_000000.md",
        "next-goal-20260404_000000.md",
        "next-goal-20260505_000000.md",
      ];
      for (const f of files) writeFileSync(join(dir, "output", f), f);
      const r = tidyNextGoals(dir, 2); // keep 2 newest
      expect(r.removed).toBe(3);
      expect(r.normalized).toBe(0);
      // newest two by timestamp: 20260505, 20260404
      expect(basenames(dir)).toEqual(["next-goal-20260404_000000.md", "next-goal-20260505_000000.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps everything when total <= keepN (default 10)", () => {
    const dir = tmpEffort();
    try {
      writeFileSync(join(dir, "output", "next-goal-20260101_000000.md"), "a");
      writeFileSync(join(dir, "output", "next-goal-20260202_000000.md"), "b");
      const r = tidyNextGoals(dir); // keepN default 10
      expect(r).toEqual({ normalized: 0, removed: 0 });
      expect(basenames(dir).length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keepN=0 unlinks every next-goal file", () => {
    const dir = tmpEffort();
    try {
      writeFileSync(join(dir, "output", "next-goal-20260101_000000.md"), "a");
      writeFileSync(join(dir, "output", "next-goal-20260202_000000.md"), "b");
      const r = tidyNextGoals(dir, 0);
      expect(r.removed).toBe(2);
      expect(basenames(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tidyNextGoals — edge cases", () => {
  it("no-op when <effortDir>/output does not exist (and does not create it)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-tidy-missing-"));
    try {
      expect(existsSync(join(dir, "output"))).toBe(false);
      expect(tidyNextGoals(dir)).toEqual({ normalized: 0, removed: 0 });
      expect(existsSync(join(dir, "output"))).toBe(false); // NOT created
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no-op on an empty output dir", () => {
    const dir = tmpEffort();
    try {
      expect(tidyNextGoals(dir)).toEqual({ normalized: 0, removed: 0 });
      expect(basenames(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves non-next-goal files in output/", () => {
    const dir = tmpEffort();
    try {
      writeFileSync(join(dir, "output", "next-goal-20260101_000000.md"), "goal");
      writeFileSync(join(dir, "output", "README.md"), "keep me");
      writeFileSync(join(dir, "output", "notes.txt"), "also keep");
      writeFileSync(join(dir, "output", "other-20260101_000000.md"), "wrong prefix");
      const r = tidyNextGoals(dir, 0); // delete all next-goal files
      expect(r.removed).toBe(1);
      expect(basenames(dir)).toEqual(["README.md", "notes.txt", "other-20260101_000000.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("combines normalize + trim in one run", () => {
    const dir = tmpEffort();
    try {
      // mix of un-normalized + canonical; keep the 2 newest after normalization
      writeFileSync(join(dir, "output", "next-goal-20260101-0000.md"), "old-short"); // -> 20260101_000000
      writeFileSync(join(dir, "output", "next-goal-20260202_120000.md"), "feb");
      writeFileSync(join(dir, "output", "next-goal-20260303_235959.md"), "mar");
      writeFileSync(join(dir, "output", "next-goal-20260404_0600.md"), "apr-short"); // -> 20260404_060000
      const r = tidyNextGoals(dir, 2);
      expect(r.normalized).toBe(2); // the two short ones padded
      expect(r.removed).toBe(2); // 4 total, keep 2
      // newest two: 20260404_060000 (was short), 20260303_235959
      expect(basenames(dir)).toEqual(["next-goal-20260303_235959.md", "next-goal-20260404_060000.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
