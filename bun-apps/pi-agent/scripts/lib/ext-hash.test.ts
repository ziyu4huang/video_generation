import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashExtInputs, collectWorkspaceDepDirs } from "./ext-hash.ts";

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "ext-hash-test-"));
  const workspaceRoot = join(root, "bun-apps");
  const extDir = join(workspaceRoot, "my-ext");
  const sharedDir = join(workspaceRoot, "shared-util");
  mkdirSync(extDir, { recursive: true });
  mkdirSync(sharedDir, { recursive: true });

  writeFileSync(
    join(extDir, "package.json"),
    JSON.stringify({ name: "@repo/my-ext", dependencies: { "@repo/shared-util": "*" } }),
  );
  writeFileSync(join(extDir, "index.ts"), "export const x = 1;\n");

  writeFileSync(join(sharedDir, "package.json"), JSON.stringify({ name: "@repo/shared-util" }));
  writeFileSync(join(sharedDir, "util.ts"), "export const util = 1;\n");

  return { root, workspaceRoot, extDir, sharedDir };
}

const baseOpts = {
  thin: true,
  minifyCfg: "whitespace,identifiers,syntax",
  thinExternals: ["typebox"],
  bunVersion: "1.3.0",
};

describe("collectWorkspaceDepDirs", () => {
  test("finds a direct @repo/* dependency", () => {
    const { workspaceRoot, extDir, sharedDir, root } = makeFixture();
    try {
      const dirs = collectWorkspaceDepDirs(extDir, workspaceRoot);
      expect(dirs).toContain(sharedDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("hashExtInputs", () => {
  test("changes when a transitive @repo/* dependency's source changes", () => {
    const { workspaceRoot, extDir, sharedDir, root } = makeFixture();
    try {
      const entry = join(extDir, "index.ts");
      const before = hashExtInputs({ entry, pkgDir: extDir, workspaceRoot, ...baseOpts });

      writeFileSync(join(sharedDir, "util.ts"), "export const util = 2; // changed\n");

      const after = hashExtInputs({ entry, pkgDir: extDir, workspaceRoot, ...baseOpts });
      expect(after).not.toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is stable when nothing changes", () => {
    const { workspaceRoot, extDir, root } = makeFixture();
    try {
      const entry = join(extDir, "index.ts");
      const a = hashExtInputs({ entry, pkgDir: extDir, workspaceRoot, ...baseOpts });
      const b = hashExtInputs({ entry, pkgDir: extDir, workspaceRoot, ...baseOpts });
      expect(a).toBe(b);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
