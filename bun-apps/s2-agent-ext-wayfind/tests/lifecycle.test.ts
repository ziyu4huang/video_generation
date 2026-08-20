import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { completeEffort, setEffortStatus } from "../src/lifecycle.js";
import { doneDir } from "../src/model.js";

let cwd = "";
afterEach(() => {
  if (cwd) {
    rmSync(cwd, { recursive: true, force: true });
    cwd = "";
  }
});

function seedEffort(root: string, effort: string, status = "active"): void {
  const dir = join(root, ".planning", effort);
  mkdirSync(dir, { recursive: true });
  const fm = [
    "---",
    `effort: ${effort}`,
    "created: 2026-08-08",
    "last: 2026-08-08",
    `status: ${status}`,
    "---",
    "",
    "# Wayfinder map",
    "",
    "## Destination",
    "",
    "ship it",
  ].join("\n");
  writeFileSync(join(dir, "map.md"), fm, "utf-8");
}

describe("doneDir", () => {
  it("returns the <cwd>/.planning/done archive root", () => {
    cwd = mkdtempSync(join(tmpdir(), "wf-life-"));
    expect(doneDir(cwd)).toBe(join(cwd, ".planning", "done"));
  });
});

describe("setEffortStatus", () => {
  it("writes the new status into the map front-matter in place and returns ok", () => {
    cwd = mkdtempSync(join(tmpdir(), "wf-life-"));
    const effort = "2026-08-08-demo";
    seedEffort(cwd, effort, "active");
    const res = setEffortStatus(cwd, effort, "paused");
    expect(res).toEqual({ ok: true });
    const after = readFileSync(join(cwd, ".planning", effort, "map.md"), "utf-8");
    expect(after).toContain("status: paused");
    expect(after).not.toContain("status: active");
    expect(after).toContain("created: 2026-08-08"); // preserved
  });

  it("refuses {ok:false} when no map.md exists", () => {
    cwd = mkdtempSync(join(tmpdir(), "wf-life-"));
    const res = setEffortStatus(cwd, "no-such-effort", "paused");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("no map");
  });
});

describe("completeEffort", () => {
  it("stamps status:complete and moves the effort dir under .planning/done/", () => {
    cwd = mkdtempSync(join(tmpdir(), "wf-life-"));
    const effort = "2026-08-08-demo";
    seedEffort(cwd, effort, "active");
    const res = completeEffort(cwd, effort);
    expect(res).toEqual({ ok: true, effort, movedTo: `.planning/done/${effort}` });
    expect(existsSync(join(cwd, ".planning", effort))).toBe(false); // original gone
    const moved = join(cwd, ".planning", "done", effort);
    expect(existsSync(join(moved, "map.md"))).toBe(true);
    expect(readFileSync(join(moved, "map.md"), "utf-8")).toContain("status: complete");
  });

  it("refuses {ok:false} when there is no map.md", () => {
    cwd = mkdtempSync(join(tmpdir(), "wf-life-"));
    const res = completeEffort(cwd, "no-such-effort");
    expect(res.ok).toBe(false);
  });

  it("refuses {ok:false} when the destination already exists (no clobber)", () => {
    cwd = mkdtempSync(join(tmpdir(), "wf-life-"));
    const effort = "2026-08-08-demo";
    seedEffort(cwd, effort);
    mkdirSync(join(cwd, ".planning", "done", effort), { recursive: true });
    const res = completeEffort(cwd, effort);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("already exists");
  });
});

describe("model.ts purity (fs-free invariant)", () => {
  it("does not import node:fs", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "src", "model.ts"), "utf-8");
    expect(src).not.toContain('from "node:fs"');
    expect(src).not.toContain("require(");
  });
});

describe("markdown.ts purity (fs-free invariant)", () => {
  it("does not import node:fs", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "src", "markdown.ts"), "utf-8");
    expect(src).not.toContain('from "node:fs"');
    expect(src).not.toContain("require(");
  });
});
