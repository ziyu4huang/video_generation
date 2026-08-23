import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDeck, parseManifest } from "../src/deck-build.ts";
import { loadRegistry } from "../src/layout-registry.ts";
import { lintDeck } from "../src/deck-lint.ts";
import { lintPptx } from "../src/ooxml-lint.ts";
import { count, readZipText } from "../src/read-zip.ts";
import { runArchify } from "../src/run.ts";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIBRARY = join(PKG_ROOT, "examples", "ir-library");
const DECK_DIR = join(LIBRARY, "decks");

interface CatalogEntry {
  path: string;
  diagram_type: string;
  title: string;
  description: string;
  archetype: string;
  pairing: string[];
  tier: string;
}

const catalog = (await Bun.file(join(LIBRARY, "library.catalog.json")).json()) as {
  entries: CatalogEntry[];
};

const EXPECTED = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"] as const;
const VALID_TIER = ["generic", "flagship-domain"];
const SHIPPED_TEMPLATES = ["agenda", "compare", "end", "kpi-row", "quote", "table", "timeline"];

const work = mkdtempSync(join(tmpdir(), "archify-ir-library-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("t10 — the IR library stays validated, cataloged and buildable", () => {
  test("catalog is well-formed", async () => {
    expect(catalog.entries.length).toBeGreaterThanOrEqual(15);
    const seen = new Set<string>();
    for (const e of catalog.entries) {
      expect(e.tier, `tier of ${e.path}`).toBeOneOf(VALID_TIER);
      expect((EXPECTED as readonly string[]).includes(e.diagram_type), `unknown diagram_type for ${e.path}`).toBe(true);
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.description.length).toBeGreaterThan(0);
      expect(Array.isArray(e.pairing)).toBe(true);
      expect(seen.has(e.path), `duplicate path ${e.path}`).toBe(false);
      seen.add(e.path);
      expect(
        await Bun.file(resolve(LIBRARY, e.path)).exists(),
        `cataloged IR missing: ${e.path}`,
      ).toBe(true);
    }
    // Every diagram type is covered by at least one cataloged IR.
    for (const t of EXPECTED) {
      expect(
        catalog.entries.some((e) => e.diagram_type === t),
        `no cataloged ${t} IR`,
      ).toBe(true);
    }
    // Both tiers are exercised.
    expect(catalog.entries.some((e) => e.tier === "flagship-domain")).toBe(true);
  });

  test("catalog diagram_type matches each IR file's own declaration", async () => {
    for (const e of catalog.entries) {
      const ir = JSON.parse(
        (await Bun.file(resolve(LIBRARY, e.path)).text()) as string,
      ) as { diagram_type: string };
      expect(ir.diagram_type, `diagram_type of ${e.path}`).toBe(e.diagram_type);
    }
  });

  for (const e of catalog.entries) {
    test(`${e.path}: validates and delivers clean`, async () => {
      const irPath = resolve(LIBRARY, e.path);
      const htmlPath = join(work, `${e.diagram_type}-${e.archetype}.html`);
      const { stdout, status } = await runArchify(["validate", e.diagram_type, irPath, "--json"], PKG_ROOT);
      expect(status, stdout).toBe(0);
      expect(JSON.parse(stdout).ok).toBe(true);
      const delivered = await runArchify(
        ["deliver", e.diagram_type, irPath, htmlPath, "--json"],
        PKG_ROOT,
      );
      expect(delivered.status).toBe(0);
      expect(JSON.parse(delivered.stdout).ok, delivered.stderr).toBe(true);
      expect(await Bun.file(htmlPath).exists()).toBe(true);
    });
  }

  test("flagship deck builds, lints clean and stays zero-blip", async () => {
    const registry = loadRegistry({ manifestDir: DECK_DIR });
    const manifest = parseManifest(
      await Bun.file(join(DECK_DIR, "library.config.json")).text(),
      join(DECK_DIR, "library.config.json"),
      registry,
    );
    expect(lintDeck(manifest)).toEqual([]);

    const outputPath = join(work, "library.pptx");
    const result = await buildDeck({
      manifest,
      manifestDir: DECK_DIR,
      outputPath,
      cwd: PKG_ROOT,
      slidesDir: null,
    });
    expect(result.slides.length).toBeGreaterThan(18);

    const entries = await readZipText(await Bun.file(outputPath).bytes());
    const partNames = Object.keys(entries).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p));
    expect(partNames.length).toBe(result.slides.length);
    const blips = partNames.reduce((n, p) => n + count(entries[p] as string, /<a:blip>/g), 0);
    expect(blips).toBe(0);

    for (const p of partNames) {
      expect(count(entries[p] as string, /<a:blip>/g), `${p} has a blip`).toBe(0);
    }

    const diags = await lintPptx(entries);
    expect(diags).toEqual([]);
  });

  test("flagship deck exercises every shipped rich template", async () => {
    const registry = loadRegistry({ manifestDir: DECK_DIR });
    const manifest = parseManifest(
      await Bun.file(join(DECK_DIR, "library.config.json")).text(),
      join(DECK_DIR, "library.config.json"),
      registry,
    );
    const used = new Set(manifest.slides.map((s) => s.layout as string));
    for (const t of SHIPPED_TEMPLATES) {
      expect(used.has(t), `template ${t} not used by the flagship deck`).toBe(true);
    }
  });
});
