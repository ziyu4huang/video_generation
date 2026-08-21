import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDeck, type DeckManifest, type DeckResult } from "../lib/deck-build.ts";
import { parseSvg } from "../lib/svg-model.ts";
import { toShapeIR } from "../lib/shape-ir.ts";
import { count, readZipText } from "../lib/read-zip.ts";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = join(PKG_ROOT, "vendored", "examples");

/**
 * The acceptance test for "shape design".
 *
 * A deck of all five diagram types is built, then the `.pptx` is opened in pure
 * Bun and its slide XML inspected. The load-bearing assertion is
 * `<a:blip> === 0`: a blip is an image reference, so zero of them means nothing
 * on the slide was rasterized. That is the one property a regression back to
 * screenshots cannot fake, which is why it is asserted per slide rather than as
 * a summary.
 */
const CASES = [
  { type: "architecture", example: "web-app.architecture.json", title: "Architecture" },
  { type: "workflow", example: "incident-response.workflow.json", title: "Workflow" },
  { type: "sequence", example: "cache-miss-request.sequence.json", title: "Sequence" },
  { type: "dataflow", example: "event-stream.dataflow.json", title: "Dataflow" },
  { type: "lifecycle", example: "agent-run.lifecycle.json", title: "Lifecycle" },
] as const;

let workDir = "";
let result: DeckResult;
let entries: Record<string, string> = {};
/** ShapeIR node counts per slide, recomputed independently of the build. */
const irCounts: number[] = [];
const irTexts: string[][] = [];

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "archify-pptx-accept-"));
  const manifest: DeckManifest = {
    tag: "acceptance",
    // `scale` is a leftover of the raster era — assert it is tolerated, not fatal.
    defaults: { font: "Arial", scale: 2 },
    slides: CASES.map((c) => ({
      ir: join(EXAMPLES, c.example),
      title: c.title,
      subtitle: c.type,
    })),
  };
  const outputPath = join(workDir, "acceptance.pptx");
  result = await buildDeck({
    manifest,
    manifestDir: EXAMPLES,
    outputPath,
    cwd: PKG_ROOT,
    theme: "light",
  });
  entries = await readZipText(await Bun.file(outputPath).bytes());

  // Independent expectation: re-derive each slide's ShapeIR from a fresh render
  // rather than trusting the numbers the build reported about itself.
  for (const c of CASES) {
    const html = join(workDir, `${c.type}.html`);
    const proc = Bun.spawnSync({
      cmd: [
        process.execPath,
        join(PKG_ROOT, "vendored", "bin", "archify.mjs"),
        "deliver",
        c.type,
        join(EXAMPLES, c.example),
        html,
        "--json",
      ],
      cwd: PKG_ROOT,
    });
    expect(proc.exitCode, `${c.example} render`).toBe(0);
    const ir = toShapeIR(await parseSvg(await Bun.file(html).text()), "light");
    irCounts.push(ir.nodes.length);
    irTexts.push(ir.nodes.flatMap((n) => (n.kind === "text" ? [n.text] : [])));
  }
});

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("the deck builds without a browser", () => {
  test("produces one slide per diagram type", () => {
    expect(result.slides).toHaveLength(CASES.length);
    expect(result.slides.map((s) => s.diagramType)).toEqual(CASES.map((c) => c.type));
  });

  test("is a real OOXML package", () => {
    expect(entries["[Content_Types].xml"]).toBeDefined();
    for (let i = 1; i <= CASES.length; i++) {
      expect(entries[`ppt/slides/slide${i}.xml`], `slide${i}.xml missing`).toBeDefined();
    }
  });

  test("every slide placed shapes", () => {
    for (const s of result.slides) {
      expect(s.shapes, `${s.diagramType} shapes`).toBeGreaterThan(0);
      expect(s.texts, `${s.diagramType} texts`).toBeGreaterThan(0);
    }
  });
});

describe("shape design — the contract", () => {
  CASES.forEach((c, i) => {
    const slideXml = (): string => entries[`ppt/slides/slide${i + 1}.xml`]!;

    test(`${c.type}: slide XML contains ZERO images`, () => {
      // The load-bearing assertion. A blip is a picture reference; a
      // screenshot-based exporter cannot avoid emitting them.
      expect(count(slideXml(), /<a:blip[ />]/g), `${c.type} has rasterized content`).toBe(0);
    });

    test(`${c.type}: shape count covers the ShapeIR`, () => {
      const shapes = count(slideXml(), /<p:sp>/g);
      // >= because slide chrome (title, tag, accent rule, subtitle, page
      // number) adds its own shapes on top of the diagram's.
      expect(shapes, `${c.type} shapes vs ${irCounts[i]} IR nodes`).toBeGreaterThanOrEqual(
        irCounts[i]!
      );
    });

    test(`${c.type}: uses real geometry primitives`, () => {
      const xml = slideXml();
      expect(count(xml, /<a:prstGeom/g), `${c.type} preset shapes`).toBeGreaterThan(0);
      expect(count(xml, /<a:custGeom>/g), `${c.type} freeform shapes`).toBeGreaterThan(0);
    });

    test(`${c.type}: every diagram label survives as a text run`, () => {
      const xml = slideXml();
      const missing = irTexts[i]!.filter((t) => {
        const escaped = t
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        return !xml.includes(`>${escaped}<`);
      });
      expect(missing, `${c.type} lost labels`).toEqual([]);
    });
  });

  test("no media part is referenced by any slide", () => {
    const rels = Object.entries(entries).filter(([n]) => n.includes("ppt/slides/_rels/"));
    expect(rels.length).toBeGreaterThan(0);
    for (const [name, xml] of rels) {
      expect(xml, `${name} references an image`).not.toMatch(/\/image/);
    }
  });

  test("the whole deck is image-free", () => {
    const totalBlips = Object.entries(entries)
      .filter(([n]) => n.startsWith("ppt/slides/slide"))
      .reduce((a, [, xml]) => a + count(xml, /<a:blip[ />]/g), 0);
    expect(totalBlips).toBe(0);
  });
});

describe("the assertion can actually fail", () => {
  test("a blip in slide XML would be detected", () => {
    // A guard nobody has watched fail is a guard nobody knows works: prove the
    // matcher reacts to the thing it is supposed to catch.
    const withImage = `<p:sp><a:blip r:embed="rId2"/></p:sp>`;
    expect(count(withImage, /<a:blip[ />]/g)).toBe(1);
    expect(count(slideLike(), /<a:blip[ />]/g)).toBe(0);
  });
});

function slideLike(): string {
  return `<p:sp><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:sp>`;
}

describe("themes", () => {
  test("dark builds too, and differs from light", async () => {
    const manifest: DeckManifest = {
      slides: [{ ir: join(EXAMPLES, "web-app.architecture.json"), title: "Dark" }],
    };
    const outputPath = join(workDir, "dark.pptx");
    const dark = await buildDeck({
      manifest,
      manifestDir: EXAMPLES,
      outputPath,
      cwd: PKG_ROOT,
      theme: "dark",
    });
    expect(dark.theme).toBe("dark");
    const darkXml = (await readZipText(await Bun.file(outputPath).bytes()))[
      "ppt/slides/slide1.xml"
    ]!;
    expect(count(darkXml, /<a:blip[ />]/g)).toBe(0);
    expect(darkXml).not.toBe(entries["ppt/slides/slide1.xml"]);
  }, 60_000);
});
