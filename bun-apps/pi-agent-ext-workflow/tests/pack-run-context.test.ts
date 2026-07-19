import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePackRunContext } from "../src/pack-run-context.js";
import { packId } from "../src/workflow-pack-id.js";

/**
 * `pack-run-context.ts` — resolve a pack's runtime filesystem context.
 * Pure packaging over packStateRoot / ensureStateDirs / packId.
 */
describe("resolvePackRunContext", () => {
  test("in-place pack (.pi/workflows/<name>) → redirected=false, stateRoot=packDir", () => {
    const repo = mkdtempSync(join(tmpdir(), "rprc-"));
    const packDir = join(repo, ".pi", "workflows", "demo");
    const ctx = resolvePackRunContext({ name: "demo", packDir, repoRoot: repo });
    expect(ctx.redirected).toBe(false);
    expect(ctx.stateRoot).toBe(packDir);
    expect(ctx.runsDir).toBe(join(packDir, "runs"));
    expect(ctx.outputsDir).toBe(join(packDir, "outputs"));
    expect(ctx.intermediateDir).toBe(join(packDir, "intermediate"));
    expect(ctx.packId).toBe(packId("demo", packDir));
    rmSync(repo, { recursive: true, force: true });
  });

  test("checked-in pack (outside .pi/workflows) → redirected=true, stateRoot=<repo>/.pi/workflows/.state/<packId>", () => {
    const repo = mkdtempSync(join(tmpdir(), "rprc-"));
    const packDir = join(repo, "bun-apps", "some-pkg", "workflows", "demo");
    const ctx = resolvePackRunContext({ name: "demo", packDir, repoRoot: repo });
    expect(ctx.redirected).toBe(true);
    expect(ctx.stateRoot).toBe(join(repo, ".pi", "workflows", ".state", ctx.packId));
    rmSync(repo, { recursive: true, force: true });
  });

  test("manifest.io flows through to ctx.io", () => {
    const repo = mkdtempSync(join(tmpdir(), "rprc-"));
    const packDir = join(repo, ".pi", "workflows", "demo");
    const ctx = resolvePackRunContext({
      name: "demo",
      packDir,
      repoRoot: repo,
      manifest: { name: "demo", description: "d", io: { intermediate: { persist: true } } } as any,
    });
    expect(ctx.io?.intermediate?.persist).toBe(true);
    rmSync(repo, { recursive: true, force: true });
  });

  test("resolvePackRunContext creates runs/outputs/intermediate under stateRoot", () => {
    const repo = mkdtempSync(join(tmpdir(), "rprc-"));
    const packDir = join(repo, "bun-apps", "pkg", "workflows", "demo");
    const ctx = resolvePackRunContext({ name: "demo", packDir, repoRoot: repo });
    expect(existsSync(join(ctx.stateRoot, "runs"))).toBe(true);
    expect(existsSync(join(ctx.stateRoot, "outputs"))).toBe(true);
    expect(existsSync(join(ctx.stateRoot, "intermediate"))).toBe(true);
    rmSync(repo, { recursive: true, force: true });
  });
});
