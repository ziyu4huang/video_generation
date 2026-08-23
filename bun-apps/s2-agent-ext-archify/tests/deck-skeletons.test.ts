import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDeck, type DeckManifest } from "../src/deck-build.ts";
import { lintDeck } from "../src/deck-lint.ts";
import { lintPptx } from "../src/ooxml-lint.ts";
import { parseOutline } from "../src/outline.ts";
import { readZipText } from "../src/read-zip.ts";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DECKS = join(PKG_ROOT, "templates", "decks");

const work = mkdtempSync(join(tmpdir(), "archify-skeletons-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const SKELETONS = ["technical-review", "project-kickoff", "incident-review", "product-proposal"];
const SHIPPED_TEMPLATES = ["agenda", "compare", "end", "kpi-row", "quote", "table", "timeline"];

describe("t09 — deck skeletons stay buildable and lint-clean", () => {
  for (const name of SKELETONS) {
    test(`${name}: builds, content-lint clean, ooxml clean`, async () => {
      const manifest: DeckManifest = parseOutline(
        await Bun.file(join(DECKS, `${name}.outline.md`)).text(),
        DECKS
      );
      expect(lintDeck(manifest)).toEqual([]);

      const outputPath = join(work, `${name}.pptx`);
      const result = await buildDeck({
        manifest,
        manifestDir: DECKS,
        outputPath,
        cwd: PKG_ROOT,
        slidesDir: null,
      });
      const diags = await lintPptx(await readZipText(await Bun.file(outputPath).bytes()));
      expect(diags).toEqual([]);
      expect(result.slides.length).toBeGreaterThan(3);
    });
  }

  test("between the four, every shipped template is used at least once", async () => {
    const used = new Set<string>();
    for (const name of SKELETONS) {
      const md = await Bun.file(join(DECKS, `${name}.outline.md`)).text();
      for (const m of md.matchAll(/^:::([\w-]+)/gm)) used.add(m[1]!);
    }
    for (const t of SHIPPED_TEMPLATES) {
      expect(used.has(t), `template ${t} not used by any skeleton`).toBe(true);
    }
  });
});
