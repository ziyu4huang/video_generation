import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorIntermediate, resolvePackRunContext } from "../src/pack-run-context.js";
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

describe("mirrorIntermediate", () => {
  test("mirrorIntermediate writes <phase>/<idx>-<hash>.json for an object result", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mirror-"));
    mirrorIntermediate(tmp, "research", { index: 3, hash: "abc123", result: { finding: "x" } });
    const file = join(tmp, "research", "3-abc123.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ finding: "x" });
  });

  test("mirrorIntermediate writes .txt for a string result", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mirror-"));
    mirrorIntermediate(tmp, "draft", { index: 1, hash: "h", result: "hello world" });
    expect(readFileSync(join(tmp, "draft", "1-h.txt"), "utf-8")).toBe("hello world");
  });

  test("mirrorIntermediate uses _no-phase when phase is undefined", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mirror-"));
    mirrorIntermediate(tmp, undefined, { index: 0, hash: "z", result: 42 });
    expect(existsSync(join(tmp, "_no-phase", "0-z.json"))).toBe(true);
  });

  test("mirrorIntermediate is idempotent (same name overwrites)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mirror-"));
    mirrorIntermediate(tmp, "p", { index: 1, hash: "h", result: "v1" });
    mirrorIntermediate(tmp, "p", { index: 1, hash: "h", result: "v2" });
    expect(readFileSync(join(tmp, "p", "1-h.txt"), "utf-8")).toBe("v2");
  });

  test("mirrorIntermediate never throws on a bad path", () => {
    expect(() =>
      mirrorIntermediate("/proc/cannot/write/here", "p", { index: 0, hash: "h", result: "x" }),
    ).not.toThrow();
  });
});
