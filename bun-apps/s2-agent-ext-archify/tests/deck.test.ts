import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../scripts/deck.ts";
import { parseManifest, manifestFromIrPaths, resolveDeckOutput, DeckError } from "../src/deck-build.ts";
import { readZipText, count } from "../src/read-zip.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PKG_ROOT = join(HERE, "..");
const SCRIPT = join(PKG_ROOT, "scripts", "deck.ts");
const FIXTURE_IR = join(HERE, "fixtures", "mini.architecture.json");
const EXAMPLE_IR = join(PKG_ROOT, "vendored", "examples", "agent-run.lifecycle.json");

describe("deck.parseArgs", () => {
  it("defaults the manifest to deck.config.json", () => {
    expect(parseArgs([]).manifest).toBe("deck.config.json");
  });

  it("accepts a positional manifest", () => {
    expect(parseArgs(["x.json"]).manifest).toBe("x.json");
  });

  it("parses --theme and --output", () => {
    const a = parseArgs(["m.json", "--theme", "dark", "--output", "o.pptx"]);
    expect(a.theme).toBe("dark");
    expect(a.output).toBe("o.pptx");
  });

  it("parses --emit-shape-ir", () => {
    expect(parseArgs(["m.json", "--emit-shape-ir", "/tmp/ir"]).emitShapeIr).toBe("/tmp/ir");
  });

  it("rejects an invalid --theme", () => {
    expect(() => parseArgs(["m.json", "--theme", "nope"])).toThrow(/light\|dark/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["m.json", "--bogus"])).toThrow(/Unknown flag/);
  });
});

describe("manifest handling", () => {
  it("accepts a well-formed manifest", () => {
    const m = parseManifest(
      JSON.stringify({ output: "o.pptx", slides: [{ ir: "a.json", title: "A" }] }),
      "test"
    );
    expect(m.slides).toHaveLength(1);
  });

  it("tolerates the obsolete defaults.scale", () => {
    // `scale` configured the old raster path. Existing manifests must keep
    // working rather than erroring on a field that no longer means anything.
    const m = parseManifest(
      JSON.stringify({ output: "o.pptx", defaults: { scale: 3 }, slides: [{ ir: "a.json", title: "A" }] }),
      "test"
    );
    expect(m.defaults?.scale).toBe(3);
  });

  it("rejects invalid JSON, empty slides, and missing fields with printable errors", () => {
    expect(() => parseManifest("{", "test")).toThrow(DeckError);
    expect(() => parseManifest(JSON.stringify({ slides: [] }), "test")).toThrow(/non-empty/);
    expect(() => parseManifest(JSON.stringify({ slides: [{ title: "A" }] }), "test")).toThrow(/`ir`/);
    expect(() => parseManifest(JSON.stringify({ slides: [{ ir: "a.json" }] }), "test")).toThrow(/`title`/);
    expect(() => parseManifest(JSON.stringify({ theme: "neon", slides: [{ ir: "a", title: "A" }] }), "test")).toThrow(/light\|dark/);
  });

  it("builds an implicit manifest from IR paths, titling from ir.meta.title", () => {
    const m = manifestFromIrPaths([FIXTURE_IR, EXAMPLE_IR], PKG_ROOT);
    expect(m.slides).toHaveLength(2);
    expect(m.slides[0]!.title.length).toBeGreaterThan(0);
    expect(m.slides.map((s) => s.ir)).toEqual([FIXTURE_IR, EXAMPLE_IR]);
  });

  it("resolves --output against cwd but manifest.output against the manifest dir", () => {
    const m = { output: "out/deck.pptx", slides: [{ ir: "a.json", title: "A" }] };
    expect(resolveDeckOutput(m, "/manifest/dir", "/some/cwd")).toBe("/manifest/dir/out/deck.pptx");
    expect(resolveDeckOutput(m, "/manifest/dir", "/some/cwd", "x.pptx")).toBe("/some/cwd/x.pptx");
  });

  it("requires an output when neither the manifest nor the flag supplies one", () => {
    expect(() => resolveDeckOutput({ slides: [{ ir: "a", title: "A" }] }, "/d", "/c")).toThrow(
      /missing `output`/
    );
  });
});

/**
 * Integration: manifest → .pptx through the real CLI.
 *
 * This used to be gated behind `ARCHIFY_DECK_TEST_BROWSER` because the pipeline
 * launched Playwright chromium. There is no browser any more, so the gate is
 * gone and the test always runs.
 */
describe("deck integration — manifest → .pptx", () => {
  it("produces a 2-slide OOXML package of shapes, with NO images", async () => {
    const dir = mkdtempSync(join(tmpdir(), "archify-deck-test-"));
    try {
      const out = join(dir, "out.pptx");
      const manifest = {
        output: out,
        theme: "light",
        tag: "deck test",
        defaults: { font: "Arial", scale: 2 },
        slides: [
          { ir: FIXTURE_IR, title: "Slide one", subtitle: "architecture" },
          { ir: EXAMPLE_IR, title: "Slide two", subtitle: "lifecycle" },
        ],
      };
      await Bun.write(join(dir, "manifest.json"), JSON.stringify(manifest));

      const proc = Bun.spawnSync({
        cmd: [process.execPath, SCRIPT, join(dir, "manifest.json")],
        cwd: PKG_ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (proc.exitCode !== 0) {
        throw new Error(
          `deck exited ${proc.exitCode}\nstdout: ${proc.stdout?.toString() ?? ""}\nstderr: ${
            proc.stderr?.toString() ?? ""
          }`
        );
      }
      expect(proc.stdout.toString()).toContain("native shapes");

      const bytes = await Bun.file(out).bytes();
      // ZIP local-file-header magic: PK\x03\x04
      expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);

      const entries = await readZipText(bytes);
      expect(entries["ppt/slides/slide1.xml"]).toBeDefined();
      expect(entries["ppt/slides/slide2.xml"]).toBeDefined();
      expect(entries["ppt/slides/slide3.xml"]).toBeUndefined();

      // The inversion: the old assertion demanded >= 2 media images, because
      // every slide WAS a screenshot. Slides are now vector shapes, so the
      // correct expectation is the exact opposite.
      for (const n of ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"]) {
        expect(count(entries[n]!, /<a:blip[ />]/g), `${n} rasterized`).toBe(0);
        expect(count(entries[n]!, /<p:sp>/g), `${n} shapes`).toBeGreaterThan(5);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
