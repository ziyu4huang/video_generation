import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDeck,
  DeckError,
  loadManifestFile,
  parseManifest,
  type DeckResult,
} from "../lib/deck-build.ts";
import { lintDeck } from "../lib/deck-lint.ts";
import { lintPptx, formatDiagnostics } from "../lib/ooxml-lint.ts";
import { count, readZipText } from "../lib/read-zip.ts";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEGACY_MANIFEST = join(PKG_ROOT, "examples", "deck", "deck.config.json");
const COMPOSED_MANIFEST = join(PKG_ROOT, "examples", "deck-composed", "deck.config.json");

let workDir = "";

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "archify-composition-"));
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

async function build(manifestPath: string, name: string): Promise<{
  result: DeckResult;
  parts: Record<string, string>;
  slidesDir: string;
}> {
  const { manifest, manifestDir } = await loadManifestFile(manifestPath, PKG_ROOT);
  const outputPath = join(workDir, `${name}.pptx`);
  const slidesDir = join(workDir, `${name}.slides`);
  const result = await buildDeck({
    manifest,
    manifestDir,
    outputPath,
    cwd: PKG_ROOT,
    slidesDir,
  });
  return { result, parts: await readZipText(await Bun.file(outputPath).bytes()), slidesDir };
}

/**
 * The compatibility lock (effort decision D3).
 *
 * `examples/deck/deck.config.json` predates layouts entirely: its slides carry
 * only `ir` / `title` / `subtitle`. It must build with NO edit, and to the same
 * geometry. The chrome EMU values below are the literal numbers the
 * pre-composition builder emitted — during this effort the rebuilt slide XML was
 * additionally compared byte for byte against a pre-refactor capture and all
 * five slides were identical (see receipts/).
 */
describe("D3 — a pre-composition manifest builds unchanged", () => {
  let built: Awaited<ReturnType<typeof build>>;
  beforeAll(async () => {
    built = await build(LEGACY_MANIFEST, "legacy");
  });

  test("every slide resolves to the diagram layout without saying so", () => {
    expect(built.result.slides.map((s) => s.layout)).toEqual([
      "diagram",
      "diagram",
      "diagram",
      "diagram",
      "diagram",
    ]);
    expect(built.result.slides.map((s) => s.diagramType)).toEqual([
      "dataflow",
      "architecture",
      "architecture",
      "dataflow",
      "architecture",
    ]);
  });

  test("shape and text-run counts are unchanged", () => {
    // Chrome contributes a fixed 2 shapes + 4 text runs per slide; the rest is
    // the diagram. A change here means the diagram or the chrome moved.
    expect(built.result.slides.map((s) => [s.shapes, s.texts])).toEqual([
      [25, 25],
      [45, 30],
      [61, 24],
      [64, 53],
      [36, 25],
    ]);
  });

  test("the chrome sits at the pre-composition EMU coordinates", () => {
    const xml = built.parts["ppt/slides/slide1.xml"]!;
    // tag chip @ 9.7in x 0.28in, 3.13in x 0.4in
    expect(xml).toContain('<a:off x="8869680" y="256032"/><a:ext cx="2862072" cy="365760"/>');
    // title @ 0.5in x 0.22in, 9in x 0.75in
    expect(xml).toContain('<a:off x="457200" y="201168"/><a:ext cx="8229600" cy="685800"/>');
    // accent rule @ 0.5in x 1.02in, 12.333in x 0.035in
    expect(xml).toContain('<a:off x="457200" y="932688"/><a:ext cx="11277295" cy="32004"/>');
    // footer @ 0.5in x 7.0in, 11.4in x 0.4in
    expect(xml).toContain('<a:off x="457200" y="6400800"/><a:ext cx="10424160" cy="365760"/>');
    // page number @ 11.9in x 7.0in, 0.94in x 0.4in
    expect(xml).toContain('<a:off x="10881360" y="6400800"/><a:ext cx="859536" cy="365760"/>');
  });

  test("composition added no `algn=\"l\"` paragraphs", () => {
    // "left" is the OOXML default, so emitting it changes nothing visually —
    // but it rewrites every chrome paragraph on every slide, and that is how
    // this lock was first found to be broken. The counts below are the
    // pre-refactor values; they come from DIAGRAM labels, where
    // `pptx-shapes.ts` sets `align` explicitly per text anchor. Chrome
    // contributes none, and must keep contributing none.
    expect([1, 2, 3, 4, 5].map((i) => count(built.parts[`ppt/slides/slide${i}.xml`]!, /algn="l"/g)))
      .toEqual([5, 7, 7, 5, 7]);
  });

  test("nothing is rasterized", () => {
    for (let i = 1; i <= 5; i++) {
      expect(count(built.parts[`ppt/slides/slide${i}.xml`]!, /<a:blip\b/g), `slide${i}`).toBe(0);
    }
  });

  test("a diagram slide's page IS the archify artifact, not a composed page", () => {
    // D4: the webui Diagram pane serves these files and depends on them being
    // full-fidelity and interactive.
    const html = Bun.file(join(built.slidesDir, "slide-1.html"));
    expect(existsSync(join(built.slidesDir, "slide-1.diagram.html"))).toBe(false);
    return html.text().then((t) => {
      expect(t).toContain("<svg");
      expect(t).not.toContain("--pt:calc(100cqw / 960)");
    });
  });

  test("the package passes every OOXML structural rule", async () => {
    const diags = await lintPptx(built.parts);
    expect(formatDiagnostics(diags)).toBe("");
  });
});

describe("a composed deck", () => {
  let built: Awaited<ReturnType<typeof build>>;
  beforeAll(async () => {
    built = await build(COMPOSED_MANIFEST, "composed");
  });

  test("uses all six layouts", () => {
    expect(built.result.slides.map((s) => s.layout)).toEqual([
      "title",
      "section",
      "split",
      "diagram",
      "bullets",
      "statement",
    ]);
  });

  test("a composed slide gets our page; its diagram gets a sibling artifact", async () => {
    const composed = await Bun.file(join(built.slidesDir, "slide-3.html")).text();
    expect(composed).toContain("--pt:calc(100cqw / 960)");
    // The artifact's OWN embed contract, so it drops its toolbar and matches
    // the deck theme instead of showing its whole page UI in a 60 % column.
    expect(composed).toContain("slide-3.diagram.html?embed=1&amp;theme=light");
    expect(existsSync(join(built.slidesDir, "slide-3.diagram.html"))).toBe(true);
  });

  test("a text-only slide has no artifact beside it", () => {
    expect(existsSync(join(built.slidesDir, "slide-5.diagram.html"))).toBe(false);
  });

  test("carries real shapes on the text-only slides too", () => {
    const bullets = built.result.slides[4]!;
    expect(bullets.shapes).toBeGreaterThan(0);
    expect(bullets.texts).toBeGreaterThan(0);
  });

  test("nothing is rasterized on any slide", () => {
    for (let i = 1; i <= 6; i++) {
      expect(count(built.parts[`ppt/slides/slide${i}.xml`]!, /<a:blip\b/g), `slide${i}`).toBe(0);
    }
  });

  test("every text block wraps — the point of composing at all", () => {
    // `wrap="none"` belongs to diagram labels placed by `pptx-shapes.ts`. A
    // composed slide's prose must never be emitted that way.
    const composedOnly = ["1", "2", "5", "6"]; // title / section / bullets / statement
    for (const n of composedOnly) {
      expect(count(built.parts[`ppt/slides/slide${n}.xml`]!, /wrap="none"/g), `slide${n}`).toBe(0);
    }
  });

  test("passes every OOXML structural rule", async () => {
    expect(formatDiagnostics(await lintPptx(built.parts))).toBe("");
  });

  test("passes the content lint", async () => {
    const { manifest } = await loadManifestFile(COMPOSED_MANIFEST, PKG_ROOT);
    expect(lintDeck(manifest)).toEqual([]);
  });
});

describe("a deck that would render broken is refused", () => {
  const overflowing = {
    output: "o.pptx",
    slides: [{ layout: "bullets" as const, title: "一".repeat(30), bullets: ["a"] }],
  };

  test("buildDeck throws rather than writing a clipped title", async () => {
    // The action-title band has no autofit and the accent rule sits below it at
    // a fixed y, so a second line is struck through. Writing the file anyway
    // just moves the discovery to whoever opens it.
    await expect(
      buildDeck({
        manifest: overflowing,
        manifestDir: PKG_ROOT,
        outputPath: join(workDir, "refused.pptx"),
        cwd: PKG_ROOT,
        slidesDir: null,
      })
    ).rejects.toThrow(/would render broken[\s\S]*title-overflows/);
  });

  test("no file is left behind", async () => {
    expect(existsSync(join(workDir, "refused.pptx"))).toBe(false);
  });

  test("a warn-severity note does NOT block", async () => {
    // Only `error` blocks. A title-is-a-label note is a style opinion and a
    // style opinion that refuses to build teaches people to disable the linter.
    const result = await buildDeck({
      manifest: { output: "o.pptx", slides: [{ layout: "bullets" as const, title: "延遲", bullets: ["a"] }] },
      manifestDir: PKG_ROOT,
      outputPath: join(workDir, "warned.pptx"),
      cwd: PKG_ROOT,
      slidesDir: null,
    });
    expect(result.slides).toHaveLength(1);
  });
});

describe("manifest validation", () => {
  const parse = (slides: unknown) => () =>
    parseManifest(JSON.stringify({ output: "o.pptx", slides }), "test");

  test("a slide with neither `ir` nor `layout` names both remedies", () => {
    expect(parse([{ title: "T" }])).toThrow(DeckError);
    expect(parse([{ title: "T" }])).toThrow(/either an `ir`.*or an explicit `layout`/s);
  });

  test("an unknown layout lists the six that exist", () => {
    expect(parse([{ title: "T", layout: "kpi" }])).toThrow(/unknown `layout`.*bullets/s);
  });

  test("a legacy slide still validates", () => {
    expect(parse([{ ir: "a.json", title: "T", subtitle: "S" }])).not.toThrow();
  });

  test("a composed slide validates without an `ir`", () => {
    expect(parse([{ layout: "bullets", title: "T", bullets: ["a"] }])).not.toThrow();
  });

  test("a non-numeric `ratio` is rejected", () => {
    expect(parse([{ layout: "split", title: "T", ratio: "wide" }])).toThrow(/`ratio` must be/);
  });
});
