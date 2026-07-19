import { describe, expect, test } from "bun:test";
import { packId } from "../src/workflow-pack-id.js";

/**
 * `workflow-pack-id.ts` — stable pack identity (decision 08).
 * packId = <name-slug>-<sha256(absPath).slice(0,12)>, version-INDEPENDENT.
 */
describe("packId", () => {
  test("is <name>-<12-hex>, stable per absolute path", () => {
    const id = packId("audit", "/repo/.pi/workflows/audit");
    expect(id).toMatch(/^audit-[0-9a-f]{12}$/);
    // stable (deterministic)
    expect(packId("audit", "/repo/.pi/workflows/audit")).toBe(id);
  });

  test("differs across locations for the same name", () => {
    const a = packId("audit", "/repo/.pi/workflows/audit");
    const b = packId("audit", "/repo/bun-apps/pkgA/workflows/audit");
    expect(a).not.toBe(b);
  });

  test("slug-sanitizes name (lowercase, non-alnum → dash)", () => {
    expect(packId("My Pack", "/p")).toMatch(/^my-pack-[0-9a-f]{12}$/);
  });

  test("is version-independent (takes only name + absPath)", () => {
    // There is no version parameter; the signature is (name, absPath) only.
    const id = packId("x", "/p");
    expect(id.split("-")).toHaveLength(2);
  });
});
