import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDeck, DeckError, parseManifest, expandViews } from "../lib/deck-build.ts";
import { applyViewFocus, readGuidedViews } from "../lib/view-focus.ts";
import { parseSvg } from "../lib/svg-model.ts";
import { runArchify, VENDORED_BIN } from "../lib/run.ts";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Ticket 03 (effort 2026-08-22-archify-deck-template-v2): a diagram slide with
 * `"views": "expand"` becomes 1 overview + 1 build slide per `meta.views`
 * entry; build slides dim non-focus content in the pptx projection while the
 * HTML artifact stays interactive and untouched.
 */
const IR = {
  schema_version: 1,
  diagram_type: "architecture",
  meta: {
    title: "Views fixture",
    output: "views.architecture.html",
    views: [
      { id: "left", label: "Left arm carries the spec", focus: ["a", "b"], note: "Derivation flows top to bottom." },
      { id: "right", label: "Right arm checks the build", focus: ["c"], note: "Verification points back at the spec." },
    ],
  },
  components: [
    { id: "a", type: "backend", label: "A", pos: [40, 40], size: [120, 60] },
    { id: "b", type: "backend", label: "B", pos: [240, 40], size: [120, 60] },
    { id: "c", type: "frontend", label: "C", pos: [440, 40], size: [120, 60] },
  ],
  connections: [
    { id: "e1", from: "a", to: "b" },
    { id: "e2", from: "b", to: "c", variant: "dashed" },
  ],
};

let workDir = "";
let irPath = "";

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "archify-views-"));
  irPath = join(workDir, "views.architecture.json");
  writeFileSync(irPath, JSON.stringify(IR));
});

function manifestOf(views: string | undefined) {
  return parseManifest(
    JSON.stringify({
      output: join(workDir, "deck.pptx"),
      slides: [{ title: "The V, guided", ir: irPath, ...(views ? { views } : {}) }],
    }),
    "test"
  );
}

describe("expandViews", () => {
  test("one overview + one slide per guided view, in view order", () => {
    const slides = expandViews(manifestOf("expand"), workDir);
    expect(slides).toHaveLength(3);
    expect(slides[0]!.title).toBe("The V, guided");
    expect(slides[0]!.views).toBeUndefined();
    expect(slides[0]!.viewFocus).toBeUndefined();
    expect(slides[1]!.title).toBe("Left arm carries the spec");
    expect(slides[1]!.takeaway).toBe("Derivation flows top to bottom.");
    expect(slides[1]!.viewFocus).toEqual(["a", "b"]);
    expect(slides[2]!.title).toBe("Right arm checks the build");
    expect(slides[2]!.viewFocus).toEqual(["c"]);
  });

  test("no views field passes slides through untouched", () => {
    const slides = expandViews(manifestOf(undefined), workDir);
    expect(slides).toHaveLength(1);
  });

  test("missing meta.views is an actionable error", () => {
    const noViews = join(workDir, "noviews.architecture.json");
    writeFileSync(
      noViews,
      JSON.stringify({ ...IR, meta: { title: "No views" } })
    );
    const m = parseManifest(
      JSON.stringify({ slides: [{ title: "t", ir: noViews, views: "expand" }] }),
      "test"
    );
    expect(() => expandViews(m, workDir)).toThrow(DeckError);
    expect(() => expandViews(m, workDir)).toThrow(/meta\.views/);
  });

  test("a focus on an unknown node id is an actionable error", () => {
    const badViews = join(workDir, "badfocus.architecture.json");
    writeFileSync(
      badViews,
      JSON.stringify({ ...IR, meta: { ...IR.meta, views: [{ id: "v", label: "Broken", focus: ["zzz"] }] } })
    );
    const m = parseManifest(
      JSON.stringify({ slides: [{ title: "t", ir: badViews, views: "expand" }] }),
      "test"
    );
    expect(() => expandViews(m, workDir)).toThrow(/zzz/);
  });

  test("readGuidedViews reads meta.views from disk", () => {
    expect(readGuidedViews(irPath, workDir).map((v) => v.id)).toEqual(["left", "right"]);
  });
});

describe("applyViewFocus", () => {
  let svgNodes: Awaited<ReturnType<typeof parseSvg>>["nodes"] = [];

  beforeAll(async () => {
    const out = join(workDir, "views.architecture.html");
    const { status } = await runArchify(
      ["deliver", "architecture", irPath, out, "--json"],
      PKG_ROOT,
      undefined,
      VENDORED_BIN
    );
    expect(status).toBe(0);
    svgNodes = (await parseSvg(await Bun.file(out).text())).nodes;
  });

  test("dims non-focus nodes and cross-boundary edges, keeps chrome", () => {
    const dimmed = applyViewFocus(svgNodes, ["a", "b"]);
    expect(dimmed).toBeGreaterThan(0);
    const byId = (id: string) => svgNodes.find((n) => n.attrs["data-node-id"] === id);
    expect(byId("a")!.attrs.opacity).toBeUndefined();
    expect(byId("b")!.attrs.opacity).toBeUndefined();
    expect(byId("c")!.attrs.opacity).toBe("0.22");
    // e1 (a→b) both in focus; e2 (b→c) crosses the boundary → dimmed.
    const edges = svgNodes.filter((n) => n.attrs["data-edge-from"] !== undefined && n.tag === "path");
    const e1 = edges.find((n) => n.attrs["data-edge-from"] === "a")!;
    const e2 = edges.find((n) => n.attrs["data-edge-from"] === "b")!;
    expect(e1.attrs.opacity).toBeUndefined();
    expect(e2.attrs.opacity).toBe("0.22");
    // Legend chrome never dims (the bridge attr is valueless; a kind row stands in).
    const legendRow = svgNodes.find((n) => n.attrs["data-legend-kind"] !== undefined);
    expect(legendRow!.attrs.opacity).toBeUndefined();
  });
});

describe("views expansion through buildDeck", () => {
  test("deck has one overview + two guided builds; artifact files stay undimmed", async () => {
    const manifest = manifestOf("expand");
    const outputPath = join(workDir, "expanded.pptx");
    const slidesDir = join(workDir, "expanded.slides");
    const result = await buildDeck({
      manifest,
      manifestDir: workDir,
      outputPath,
      cwd: PKG_ROOT,
      slidesDir,
    });
    expect(result.slides).toHaveLength(3);
    expect(result.slides.map((s) => s.title)).toEqual([
      "The V, guided",
      "Left arm carries the spec",
      "Right arm checks the build",
    ]);
    // The on-disk artifacts are the untouched interactive pages.
    for (const s of result.slides) {
      const html = await Bun.file(s.htmlPath).text();
      expect(html).not.toContain('opacity="0.22"');
    }
    expect(result.bytes).toBeGreaterThan(1000);
  }, 20000);
});
