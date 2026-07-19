import { describe, expect, test } from "bun:test";
import { _missingDeps } from "../../src/obsidian-lib.ts";

/**
 * Startup dep-check behavior. In a `bun build --compile` binary the extension's
 * import.meta.dir is a $bunfs virtual path; walking the REAL filesystem up from
 * it can never find node_modules, so the probe must short-circuit (deps are
 * inlined into the binary at build time — there is nothing to check).
 */
describe("_missingDeps", () => {
  test("returns [] when probing from a $bunfs virtual path (compiled binary)", () => {
    expect(_missingDeps(["@earendil-works/pi-coding-agent"], "/$bunfs/root")).toEqual([]);
    expect(_missingDeps(["@earendil-works/pi-coding-agent"], "/~BUN/root")).toEqual([]);
  });

  test("returns [] when probing from undefined", () => {
    expect(_missingDeps(["@earendil-works/pi-coding-agent"], undefined)).toEqual([]);
  });

  test("finds installed deps from the real package dir", () => {
    const pkgDir = new URL("../..", import.meta.url).pathname;
    expect(_missingDeps(["@earendil-works/pi-coding-agent"], pkgDir)).toEqual([]);
  });
});
