import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureStateDirs, packStateRoot } from "../src/pack-state.js";

/**
 * `pack-state.ts` — resolve a pack's runtime-state root (decisions 03/07).
 * .pi/workflows pack → in-place; checked-in pack → redirect to .pi/workflows/.state/<packId>.
 */
describe("packStateRoot", () => {
  test("a .pi/workflows pack uses in-place state (redirected=false)", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-"));
    const packDir = join(root, ".pi", "workflows", "demo");
    const r = packStateRoot({ packDir, name: "demo", repoRoot: root });
    expect(r.redirected).toBe(false);
    expect(r.root).toBe(packDir);
    rmSync(root, { recursive: true, force: true });
  });

  test("a checked-in pack (bun-apps/<pkg>/workflows) redirects to .pi/workflows/.state/<packId>", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-"));
    const packDir = join(root, "bun-apps", "pkgA", "workflows", "demo");
    const r = packStateRoot({ packDir, name: "demo", repoRoot: root });
    expect(r.redirected).toBe(true);
    expect(r.root.startsWith(join(root, ".pi", "workflows", ".state"))).toBe(true);
    expect(r.root).toMatch(/demo-[0-9a-f]{12}$/);
    rmSync(root, { recursive: true, force: true });
  });

  test("two same-named checked-in packs in different packages redirect to DIFFERENT roots", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-"));
    const a = packStateRoot({
      packDir: join(root, "bun-apps", "pkgA", "workflows", "demo"),
      name: "demo",
      repoRoot: root,
    });
    const b = packStateRoot({
      packDir: join(root, "bun-apps", "pkgB", "workflows", "demo"),
      name: "demo",
      repoRoot: root,
    });
    expect(a.redirected).toBe(true);
    expect(b.redirected).toBe(true);
    expect(a.root).not.toBe(b.root);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("ensureStateDirs", () => {
  test("idempotently creates runs/outputs/intermediate", () => {
    const root = mkdtempSync(join(tmpdir(), "ps-"));
    const state = join(root, "state");
    ensureStateDirs(state);
    ensureStateDirs(state); // idempotent — second call must not throw
    expect(existsSync(join(state, "runs"))).toBe(true);
    expect(existsSync(join(state, "outputs"))).toBe(true);
    expect(existsSync(join(state, "intermediate"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
