/**
 * ci-log-writer — MC-2's persistence seam: lazy dir, sanitized+deduped step
 * names, content round-trip. The recipe's capture logic is tested in
 * ci-recipe.test.ts; this file only pins the filesystem behavior.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCiLogWriter, sanitizeStepName } from "../src/ci-log-writer.ts";

describe("createCiLogWriter", () => {
  test("lazy: no directory until the first write", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ci-log-writer-"));
    const writer = await createCiLogWriter(repo, "pr-42");
    expect(existsSync(writer.dir)).toBe(false);
    await writer.write("typecheck:pkg-a", "--- stdout ---\nboom\n");
    expect(existsSync(writer.dir)).toBe(true);
  });

  test("writes sanitized, content-faithful files; dedupes collisions", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ci-log-writer-"));
    const writer = await createCiLogWriter(repo, "pr-42");
    const p1 = await writer.write("typecheck:pkg-a", "first failure");
    const p2 = await writer.write("typecheck:pkg-a", "second failure");
    const p3 = await writer.write("gate:Weird Name/With:Colons", "gate output");
    expect(readFileSync(p1, "utf8")).toBe("first failure");
    expect(readFileSync(p2, "utf8")).toBe("second failure");
    expect(p2).not.toBe(p1);
    assertExists(p3);
    const files = readdirSync(writer.dir).sort();
    expect(files.some((f) => f.startsWith("typecheck-pkg-a"))).toBe(true);
    expect(files.some((f) => f.startsWith("gate-weird-name-with-colons"))).toBe(true);
  });

  test("dir lands under output/ci-logs/ (gitignored)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ci-log-writer-"));
    const writer = await createCiLogWriter(repo, "pr-7");
    await writer.write("some-step", "x");
    const norm = writer.dir.replaceAll("\\", "/");
    expect(norm).toContain("/output/ci-logs/pr-7-");
    expect(existsSync(join(writer.dir, "some-step.log"))).toBe(true);
  });
});

function assertExists(p: string): void {
  if (!existsSync(p)) throw new Error(`expected ${p} to exist`);
}
