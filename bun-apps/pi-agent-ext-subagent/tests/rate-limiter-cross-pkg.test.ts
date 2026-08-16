import { describe, it } from "bun:test";
import assert from "node:assert/strict";
/**
 * CROSS-PACKAGE SHARING PROOF (wayfinder tickets 02+03 — make-or-break).
 *
 * The rate limiter MUST be a single shared budget across pi-agent-ext-subagent
 * (the `subagents`/`subagent` tools) and pi-agent-ext-workflow (the `agent()`
 * dispatch). This test exercises the TWO distinct import paths the two packages
 * use in production:
 *
 *   - pi-agent-ext-subagent imports the shared runtime directly:
 *         import { ... } from "@repo/pi-agent-core-runtime"
 *   - pi-agent-ext-workflow imports the package root:
 *         import { ... } from "@repo/pi-agent-ext-subagent"
 *
 * It acquires-and-HOLDS one slot via the src path, then proves the package-root
 * path BLOCKS on the SAME budget (and releases cleanly). If each import path
 * resolved to a disjoint limiter, the second acquire would NOT block. Passing
 * this test is the guarantee that combined subagents + workflow dispatch is
 * actually bounded by ONE shared cap per provider.
 *
 * (Robustness note: even if the workspace linker ever deduped these two import
 * paths to separate module records, the limiter state lives on globalThis, so
 * they still share. This test asserts the observable behavior - blocking -
 * which holds under either module-resolution outcome.)
 */
// CORE-RUNTIME path - the subagent package's own import (subagents-tool.ts
// now sources the limiter from core-runtime; this mirrors that path).
import {
  __resetRateLimitStateForTests,
  getGlobalRateLimiter as getViaSrc,
  setRateLimitCapResolver as setResolverViaSrc,
} from "@repo/pi-agent-core-runtime";
// PACKAGE-ROOT path - the core-runtime facade this barrel re-exports for peers
// that do not declare core-runtime (see tests/barrel-surface.test.ts). Both
// spellings must gate on ONE budget, or a facade consumer would silently get an
// unbounded second limiter. (pi-agent-ext-workflow itself imports the symbol
// from core-runtime directly; this path covers the facade consumers.)
import {
  getGlobalRateLimiter as getViaPkgRoot,
  setRateLimitCapResolver as setResolverViaPkg,
} from "@repo/pi-agent-ext-subagent";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("rate-limiter cross-package sharing", () => {
  it("src path and package-root path resolve ONE shared budget (acquire/hold blocks the other)", async () => {
    __resetRateLimitStateForTests();
    // Register a cap=1 resolver via the src path; the package-root path must see it.
    setResolverViaSrc(() => 1);
    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    // Acquire via the SRC import path and hold the slot open.
    let srcEntered = false;
    const srcRun = getViaSrc("zai").run(async () => {
      srcEntered = true;
      await held; // never resolves until releaseHeld()
      return "src-done";
    });
    await tick();
    assert.ok(srcEntered, "src-path acquire should have entered the gate");

    // Now acquire via the PACKAGE-ROOT import path. If the two share one budget
    // (cap 1), this MUST block until the src slot is released.
    let pkgEntered = false;
    const pkgRun = getViaPkgRoot("zai").run(async () => {
      pkgEntered = true;
      return "pkg-done";
    });
    // Give it a beat to (not) enter.
    await tick();
    await tick();
    assert.equal(pkgEntered, false, "package-root acquire MUST block while src holds the only slot");

    // Release the held src slot -> the package-root acquire should now enter.
    releaseHeld();
    const [srcRes, pkgRes] = await Promise.all([srcRun, pkgRun]);
    assert.equal(srcRes, "src-done");
    assert.equal(pkgRes, "pkg-done");
    assert.ok(pkgEntered, "package-root acquire entered after the src slot was released");

    __resetRateLimitStateForTests();
  });

  it("a resolver registered via the package-root path gates acquires via the src path", async () => {
    __resetRateLimitStateForTests();
    // Register cap=1 via the PACKAGE-ROOT path (as the workflow extension does),
    // then drive acquires through the SRC path (as the subagents tool does).
    setResolverViaPkg(() => 1);
    let peak = 0;
    let active = 0;
    const work = async () => {
      active++;
      peak = Math.max(peak, active);
      await tick();
      active--;
    };
    const lim = getViaSrc("cross-prov");
    await Promise.all(Array.from({ length: 5 }, () => lim.run(work)));
    assert.equal(peak, 1, "src-path acquires gated to 1 by a package-root resolver");
    __resetRateLimitStateForTests();
  });
});
