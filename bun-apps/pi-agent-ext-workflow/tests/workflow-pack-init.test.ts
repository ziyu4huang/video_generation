import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldPack } from "../src/workflow-pack-init.js";

/**
 * `workflow-pack-init.ts` — scaffolder (decision 07).
 */
describe("scaffoldPack", () => {
  test("copies static files + agents/ and creates empty ephemeral dirs with .gitkeep", () => {
    const root = mkdtempSync(join(tmpdir(), "init-"));
    // The shipped template is the fixture source.
    const templateRoot = join(process.cwd(), "workflow-pack", "template");
    const { dir } = scaffoldPack({ name: "demo", targetDir: join(root, "demo"), templateRoot });

    // static files copied
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
    expect(existsSync(join(dir, "entry.js"))).toBe(true);
    expect(existsSync(join(dir, "agents", "worker.md"))).toBe(true);
    expect(existsSync(join(dir, "README.md"))).toBe(true);
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);

    // ephemeral dirs created empty + .gitkeep
    for (const d of ["inputs", "outputs", "intermediate", "runs"]) {
      expect(existsSync(join(dir, d))).toBe(true);
      expect(existsSync(join(dir, d, ".gitkeep"))).toBe(true);
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("is idempotent-ish: re-scaffolding over an existing dir does not throw", () => {
    const root = mkdtempSync(join(tmpdir(), "init-"));
    const templateRoot = join(process.cwd(), "workflow-pack", "template");
    const target = join(root, "demo");
    scaffoldPack({ name: "demo", targetDir: target, templateRoot });
    expect(() => scaffoldPack({ name: "demo", targetDir: target, templateRoot })).not.toThrow();
    rmSync(root, { recursive: true, force: true });
  });
});
