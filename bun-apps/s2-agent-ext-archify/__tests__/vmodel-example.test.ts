import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDeck, loadManifestFile, type DeckResult } from "../lib/deck-build.ts";
import { readZipText } from "../lib/read-zip.ts";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = join(PKG_ROOT, "examples", "vmodel", "deck.config.json");

/**
 * Ticket 05 (effort 2026-08-22-archify-deck-template-v2): the ASPICE v2 deck
 * recast through the new template — archetype geometry (zero hand-computed
 * pos), role palette, arrow legend, and guided views as pptx build slides —
 * is a checked-in example, so the whole feature stack has a permanent
 * end-to-end gate.
 */
describe("examples/vmodel — the v2 recast", () => {
  let result: DeckResult;
  let parts: Record<string, string>;
  let workDir: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "archify-vmodel-example-"));
    const { manifest, manifestDir } = await loadManifestFile(EXAMPLE, PKG_ROOT);
    const outputPath = join(workDir, "vmodel-deck.pptx");
    result = await buildDeck({
      manifest,
      manifestDir,
      outputPath,
      cwd: PKG_ROOT,
      slidesDir: join(workDir, "slides"),
    });
    parts = await readZipText(await Bun.file(outputPath).bytes());
  });

  test("views expansion: title + overview + 3 guided builds + statement", () => {
    expect(result.slides.map((s) => s.title)).toEqual([
      "A chip is a system — model IC design with ASPICE 4.0",
      "The V: break down the spec, verify against it",
      "Spec — left arm",
      "Verify — right arm",
      "Pairings",
      "The hierarchy is the process, not the document",
    ]);
  });

  test("overview full strength; every guided build dims something", async () => {
    const alphaCount = (n: number) =>
      (parts[`ppt/slides/slide${n}.xml`]?.match(/<a:alpha val=/g) ?? []).length;
    expect(alphaCount(2)).toBe(0);
    expect(alphaCount(3)).toBeGreaterThan(0);
    expect(alphaCount(4)).toBeGreaterThan(0);
    expect(alphaCount(5)).toBeGreaterThan(0);
  });

  test("the V IR carries no hand-computed geometry", async () => {
    const ir = await Bun.file(join(PKG_ROOT, "examples", "vmodel", "chip-vshape.architecture.json")).json();
    expect(ir.meta.archetype.kind).toBe("v-model");
    expect(ir.components.length).toBe(10);
    for (const c of ir.components) {
      expect(c.pos, `${c.id} must rely on the archetype, not pos`).toBeUndefined();
      expect(c.size).toBeUndefined();
    }
    // Arms + roles: left derives (spec), right verifies.
    const roleOf = (id: string): string | undefined =>
      (ir.components as { id: string; role?: string }[]).find((c) => c.id === id)?.role;
    for (const id of ir.meta.archetype.leftArm as string[]) {
      expect(roleOf(id)).toBe("spec");
    }
    for (const id of ir.meta.archetype.rightArm as string[]) {
      expect(roleOf(id)).toBe("verify");
    }
    expect(ir.meta.legend).toBe("variants");
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });
});
