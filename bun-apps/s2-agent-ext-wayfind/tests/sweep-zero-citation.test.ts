import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMap } from "../src/map.js";
import { today } from "../src/model.js";
import { archiveZeroCitationEfforts, classifyZeroCitationEfforts } from "../src/sweep-zero-citation.js";

const tempRoots: string[] = [];

function makeRoot(): string {
  const cwd = mkdtempSync(join(tmpdir(), "wf-sweep-"));
  tempRoots.push(cwd);
  return cwd;
}

afterEach(() => {
  while (tempRoots.length) {
    const r = tempRoots.pop();
    if (r) rmSync(r, { recursive: true, force: true });
  }
});

/** Scaffold an effort via writeMap, optionally relocating it into done/. */
function seedMap(
  root: string,
  effort: string,
  opts: { decisions?: string[]; status?: "active" | "complete" | "paused"; inDone?: boolean; legacy?: boolean },
): void {
  if (opts.legacy) {
    const dir = join(root, ".planning", opts.inDone ? join("done", effort) : effort);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "map.md"), "# Legacy map\n\nNo frontmatter, no decisions.\n", "utf-8");
    return;
  }
  const decisions = (opts.decisions ?? []).map((t, i) => ({
    title: t,
    link: `tickets/0${i + 1}-${t.toLowerCase().replace(/\s+/g, "-")}.md`,
    gist: `choose ${t}`,
  }));
  writeMap(root, {
    effort,
    destination: `dest ${effort}`,
    notes: "",
    decisions,
    fog: [],
    outOfScope: [],
    tickets: [],
    meta: { effort, created: today(), status: opts.status ?? "active" },
  });
  if (opts.inDone) {
    const from = join(root, ".planning", effort);
    const toDir = join(root, ".planning", "done");
    mkdirSync(toDir, { recursive: true });
    renameSync(from, join(toDir, effort));
  }
}

describe("classifyZeroCitationEfforts", () => {
  it("enumerates root + done efforts and classifies by decision count + status", () => {
    const root = makeRoot();
    seedMap(root, "cited-active", { decisions: ["storage"], status: "active" }); // cited → kept
    seedMap(root, "zero-active", { decisions: [], status: "active" }); // zero + active → guarded
    seedMap(root, "zero-done", { decisions: [], status: "complete", inDone: true }); // zero + complete → candidate
    seedMap(root, "cited-done", { decisions: ["api"], status: "complete", inDone: true }); // cited → kept

    const r = classifyZeroCitationEfforts(root);
    expect(r.scanned).toBe(4);
    expect(r.cited).toBe(2);
    expect(r.zeroCitationComplete.map((e) => e.effort)).toEqual(["zero-done"]);
    expect(r.zeroCitationComplete[0]).toMatchObject({ location: "done", complete: true, decisionCount: 0 });
    expect(r.zeroCitationGuarded.map((e) => e.effort)).toEqual(["zero-active"]);
    expect(r.zeroCitationGuarded[0]).toMatchObject({ location: "root", complete: false });
    expect(r.errors).toEqual([]);
  });

  it("treats a legacy prose-only map in done/ as zero-citation complete (no frontmatter, no decisions)", () => {
    const root = makeRoot();
    seedMap(root, "legacy-done", { legacy: true, inDone: true });
    const r = classifyZeroCitationEfforts(root);
    expect(r.zeroCitationComplete.map((e) => e.effort)).toEqual(["legacy-done"]);
    expect(r.zeroCitationComplete[0].status).toBeNull();
    expect(r.zeroCitationComplete[0].complete).toBe(true);
  });

  it("a legacy active effort (root) is guarded, not swept", () => {
    const root = makeRoot();
    seedMap(root, "legacy-active", { legacy: true });
    const r = classifyZeroCitationEfforts(root);
    expect(r.zeroCitationGuarded.map((e) => e.effort)).toEqual(["legacy-active"]);
    expect(r.zeroCitationComplete).toEqual([]);
  });

  it("is throw-free on a missing .planning/ dir", () => {
    expect(classifyZeroCitationEfforts(makeRoot())).toMatchObject({
      scanned: 0,
      zeroCitationComplete: [],
      zeroCitationGuarded: [],
      cited: 0,
      errors: [],
    });
  });
});

describe("archiveZeroCitationEfforts", () => {
  it("moves only zero-citation complete efforts into .planning/archive/, guarding the rest", () => {
    const root = makeRoot();
    seedMap(root, "zero-done", { decisions: [], status: "complete", inDone: true });
    seedMap(root, "zero-active", { decisions: [], status: "active" });
    seedMap(root, "cited-done", { decisions: ["api"], status: "complete", inDone: true });

    const r = archiveZeroCitationEfforts(root);
    expect(r.moved).toEqual([join(".planning", "archive", "zero-done")]);
    expect(r.skipped).toEqual([]);
    // moved out of done/ into archive/
    expect(existsSync(join(root, ".planning", "archive", "zero-done", "map.md"))).toBe(true);
    expect(existsSync(join(root, ".planning", "done", "zero-done"))).toBe(false);
    // guarded active + cited are untouched
    expect(existsSync(join(root, ".planning", "zero-active", "map.md"))).toBe(true);
    expect(existsSync(join(root, ".planning", "done", "cited-done", "map.md"))).toBe(true);
  });

  it("skips a candidate whose archive target already exists (no clobber)", () => {
    const root = makeRoot();
    seedMap(root, "zero-done", { decisions: [], status: "complete", inDone: true });
    mkdirSync(join(root, ".planning", "archive", "zero-done"), { recursive: true });
    writeFileSync(join(root, ".planning", "archive", "zero-done", "map.md"), "# existing\n", "utf-8");

    const r = archiveZeroCitationEfforts(root);
    expect(r.moved).toEqual([]);
    expect(r.skipped.length).toBe(1);
    // original still in place (never clobbered)
    expect(existsSync(join(root, ".planning", "done", "zero-done", "map.md"))).toBe(true);
    expect(readFileSync(join(root, ".planning", "archive", "zero-done", "map.md"), "utf-8")).toBe("# existing\n");
  });
});
