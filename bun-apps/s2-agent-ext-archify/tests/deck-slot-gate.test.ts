/**
 * deck-slot-gate — missing template slots are BUILD ERRORS, not silent pages.
 *
 * Before this gate a `kpi-row` slide without `kpis` built successfully and
 * rendered an empty page (`resolveString` fills "", an empty repeat draws
 * nothing) — the defect class the 2026-09-07 archify-eval track-2 audit
 * ranked #2. The check itself (`slotProblems`) already existed in the
 * advisory `archify_deck_lint` tool; the fix is running it in `buildDeck`
 * where a refusal actually blocks the artifact.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildDeck, DeckError, type DeckManifest } from "../src/deck-build.ts";

const PKG_ROOT = join(import.meta.dir, "..");
const EXAMPLES = join(PKG_ROOT, "examples", "deck-composed");

describe("buildDeck slot gate — missing slots refuse to build", () => {
  test("kpi-row without `kpis` throws, naming the slot and the layout", async () => {
    const work = mkdtemp();
    try {
      const manifest = {
        output: "broken.pptx",
        theme: "light" as const,
        slides: [{ layout: "kpi-row", title: "Targets", source: "Source: none" }],
      } as unknown as DeckManifest;
      const error = await buildDeck({
        manifest,
        manifestDir: EXAMPLES,
        outputPath: join(work, "broken.pptx"),
        cwd: PKG_ROOT,
        slidesDir: null,
      }).catch((e: unknown) => e as DeckError);
      expect(error).toBeInstanceOf(DeckError);
      expect((error as DeckError).message).toContain("missing slot `kpis`");
      expect((error as DeckError).message).toContain('layout "kpi-row"');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  test("kpi-row with an empty `kpis` array refuses the same way", async () => {
    const work = mkdtemp();
    try {
      const manifest = {
        output: "broken.pptx",
        theme: "light" as const,
        slides: [{ layout: "kpi-row", title: "Targets", kpis: [] }],
      } as unknown as DeckManifest;
      const error = await buildDeck({
        manifest,
        manifestDir: EXAMPLES,
        outputPath: join(work, "broken.pptx"),
        cwd: PKG_ROOT,
        slidesDir: null,
      }).catch((e: unknown) => e as DeckError);
      expect(error).toBeInstanceOf(DeckError);
      expect((error as DeckError).message).toContain("missing slot `kpis`");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  test("kpi-row over the slot max refuses (max 4)", async () => {
    const work = mkdtemp();
    try {
      const manifest = {
        output: "broken.pptx",
        theme: "light" as const,
        slides: [
          {
            layout: "kpi-row",
            title: "Targets",
            kpis: [
              { value: "1", label: "a" },
              { value: "2", label: "b" },
              { value: "3", label: "c" },
              { value: "4", label: "d" },
              { value: "5", label: "e" },
            ],
          },
        ],
      } as unknown as DeckManifest;
      const error = await buildDeck({
        manifest,
        manifestDir: EXAMPLES,
        outputPath: join(work, "broken.pptx"),
        cwd: PKG_ROOT,
        slidesDir: null,
      }).catch((e: unknown) => e as DeckError);
      expect(error).toBeInstanceOf(DeckError);
      expect((error as DeckError).message).toContain("the layout draws at most 4");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);

  test("a well-formed kpi-row still builds (the gate only fires on real holes)", async () => {
    const work = mkdtemp();
    try {
      // Template layouts are registry names, not `SlideLayout` union members —
      // the assertion carries the template-slot fields the manifest type
      // deliberately leaves open (slot schemas are the registry's job).
      const manifest = {
        output: "good.pptx",
        theme: "light" as const,
        slides: [
          {
            layout: "kpi-row",
            title: "Targets",
            source: "Source: plan rev B",
            kpis: [
              { value: "62 k", label: "DMIPS", note: "8 cores" },
              { value: "ASIL-D", label: "Island" },
              { value: "125 °C", label: "Grade 1" },
            ],
          },
        ],
      } as unknown as DeckManifest;
      const result = await buildDeck({
        manifest,
        manifestDir: EXAMPLES,
        outputPath: join(work, "good.pptx"),
        cwd: PKG_ROOT,
        slidesDir: null,
      });
      expect(result.slides).toHaveLength(1);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

function mkdtemp(): string {
  return mkdtempSync(join(tmpdir(), "deck-slot-gate-"));
}
