/**
 * Manifest guard: every file listed under `pi.extensions` in package.json must
 * exist on disk. (A previous regression pointed the entry at a nonexistent
 * `./extensions/index.ts` — the canonical entry is `./extensions/wayfind.ts`,
 * wired via pi-agent/src/static-extensions.ts.)
 */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const pkg = await Bun.file(join(import.meta.dir, "..", "package.json")).json();

test("pi.extensions manifest entries point at files that exist on disk", () => {
  expect(pkg.pi?.extensions?.length).toBeGreaterThan(0);
  for (const rel of pkg.pi.extensions as string[]) {
    expect(existsSync(join(import.meta.dir, "..", rel))).toBe(true);
  }
});

test("the canonical wayfind extension entry is registered (extensions/wayfind.ts)", () => {
  expect(pkg.pi.extensions).toContain("./extensions/wayfind.ts");
});
