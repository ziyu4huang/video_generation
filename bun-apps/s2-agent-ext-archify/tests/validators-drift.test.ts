import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GEN = join(PKG_ROOT, "vendored/scripts/generate-validators.mjs");

describe("check:validators (vendored snapshot not drifted)", () => {
  it("generate-validators --check reports no drift", () => {
    const r = spawnSync(process.execPath, [GEN, "--check"], { cwd: PKG_ROOT, encoding: "utf-8" });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("drift");
  });
});
