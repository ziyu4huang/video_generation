import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { archifyExportPptx } from "../lib/export-pptx.ts";
import { count, readZipText } from "../lib/read-zip.ts";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = join(PKG_ROOT, "vendored", "examples");
const IR_A = join(EXAMPLES, "web-app.architecture.json");
const IR_B = join(EXAMPLES, "agent-run.lifecycle.json");

const work = mkdtempSync(join(tmpdir(), "archify-export-tool-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("archify_export_pptx — input contract", () => {
  test("requires exactly one of manifestPath / irPaths", async () => {
    const ctx = { cwd: PKG_ROOT };
    expect((await archifyExportPptx({}, ctx)).isError).toBe(true);
    expect(
      (await archifyExportPptx({ manifestPath: "m.json", irPaths: [IR_A] }, ctx)).isError
    ).toBe(true);
    expect((await archifyExportPptx({ irPaths: [] }, ctx)).isError).toBe(true);
  });

  test("rejects an unknown theme before doing any work", async () => {
    const r = await archifyExportPptx({ irPaths: [IR_A], theme: "neon" }, { cwd: PKG_ROOT });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("light|dark");
  });

  test("honours an already-aborted signal", async () => {
    const r = await archifyExportPptx(
      { irPaths: [IR_A] },
      { cwd: PKG_ROOT },
      AbortSignal.abort()
    );
    expect(r.isError).toBe(true);
    expect(r.details["aborted"]).toBe(true);
  });

  test("a missing manifest is a printable error, not a stack trace", async () => {
    const r = await archifyExportPptx(
      { manifestPath: join(work, "nope.json") },
      { cwd: PKG_ROOT }
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("manifest not found");
  });

  test("a missing IR is reported by slide number", async () => {
    const r = await archifyExportPptx(
      { irPaths: [join(work, "ghost.json")], outputPath: join(work, "x.pptx") },
      { cwd: PKG_ROOT }
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/slide 1/);
  });
});

describe("archify_export_pptx — output", () => {
  test("irPaths builds one slide per IR and reports an absolute path", async () => {
    const outputPath = join(work, "tool.pptx");
    const r = await archifyExportPptx(
      { irPaths: [IR_A, IR_B], outputPath },
      { cwd: PKG_ROOT }
    );
    expect(r.isError).toBeUndefined();
    expect(isAbsolute(r.details["path"] as string)).toBe(true);
    expect(r.details["path"]).toBe(outputPath);

    const slides = r.details["slides"] as { diagramType: string; shapes: number }[];
    expect(slides).toHaveLength(2);
    expect(slides.map((s) => s.diagramType)).toEqual(["architecture", "lifecycle"]);
    expect(r.content[0]!.text).toContain("native shapes");

    const entries = await readZipText(await Bun.file(outputPath).bytes());
    expect(count(entries["ppt/slides/slide1.xml"]!, /<a:blip[ />]/g)).toBe(0);
    expect(count(entries["ppt/slides/slide2.xml"]!, /<a:blip[ />]/g)).toBe(0);
  }, 60_000);

  test("defaults the output beside the cwd when irPaths carries none", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "archify-export-cwd-"));
    try {
      const r = await archifyExportPptx({ irPaths: [IR_B] }, { cwd });
      expect(r.isError).toBeUndefined();
      expect(r.details["path"]).toBe(join(cwd, "deck.pptx"));
      expect(await Bun.file(join(cwd, "deck.pptx")).exists()).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  test("a manifest drives titles, theme and output", async () => {
    const manifestPath = join(work, "deck.config.json");
    const outputPath = join(work, "from-manifest.pptx");
    await Bun.write(
      manifestPath,
      JSON.stringify({
        output: outputPath,
        theme: "dark",
        tag: "tool test",
        slides: [{ ir: IR_A, title: "Titled", subtitle: "sub" }],
      })
    );
    const r = await archifyExportPptx({ manifestPath }, { cwd: PKG_ROOT });
    expect(r.isError).toBeUndefined();
    expect(r.details["theme"]).toBe("dark");
    const slides = r.details["slides"] as { title: string }[];
    expect(slides[0]!.title).toBe("Titled");

    const entries = await readZipText(await Bun.file(outputPath).bytes());
    expect(entries["ppt/slides/slide1.xml"]).toContain("Titled");
  }, 60_000);

  test("an explicit theme overrides the manifest", async () => {
    const manifestPath = join(work, "deck-light.json");
    await Bun.write(
      manifestPath,
      JSON.stringify({
        output: join(work, "override.pptx"),
        theme: "dark",
        slides: [{ ir: IR_A, title: "T" }],
      })
    );
    const r = await archifyExportPptx({ manifestPath, theme: "light" }, { cwd: PKG_ROOT });
    expect(r.details["theme"]).toBe("light");
  }, 60_000);
});
