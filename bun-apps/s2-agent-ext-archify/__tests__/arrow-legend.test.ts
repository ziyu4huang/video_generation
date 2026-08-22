import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classList, parseSvg, type SvgNode } from "../lib/svg-model.ts";
import { runArchify, VENDORED_BIN } from "../lib/run.ts";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Ticket 04 (effort 2026-08-22-archify-deck-template-v2): the arrow
 * dual-meaning convention is mechanical — an IR mixing ≥2 connection variants
 * gets an auto legend (line sample + meaning per variant); a single-variant
 * IR stays legend-as-before; `meta.legend: false` suppresses the whole auto
 * legend.
 */
const BASE = {
  schema_version: 1,
  diagram_type: "architecture",
  meta: { title: "Legend fixture", output: "legend.architecture.html" },
  components: [
    { id: "a", type: "backend", label: "A", pos: [40, 40], size: [120, 60] },
    { id: "b", type: "backend", label: "B", pos: [240, 40], size: [120, 60] },
  ],
};

let workDir = "";

async function render(ir: object): Promise<SvgNode[]> {
  const irPath = join(workDir, `t-${Math.random().toString(36).slice(2)}.architecture.json`);
  writeFileSync(irPath, JSON.stringify(ir));
  const out = irPath.replace(/\.json$/, ".html");
  const { stdout, status } = await runArchify(
    ["deliver", "architecture", irPath, out, "--json"],
    PKG_ROOT,
    undefined,
    VENDORED_BIN
  );
  expect(status, stdout.slice(0, 200)).toBe(0);
  return (await parseSvg(await Bun.file(out).text())).nodes;
}

function legendKinds(nodes: SvgNode[]): string[] {
  return nodes
    .filter((n) => n.attrs["data-legend-kind"] !== undefined)
    .map((n) => n.attrs["data-legend-kind"]!);
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "archify-arrow-legend-"));
});

describe("auto arrow legend", () => {
  test("opt-in + mixed variants chart a sample + meaning per variant", async () => {
    const nodes = await render({
      ...BASE,
      meta: { ...BASE.meta, legend: "variants" },
      connections: [
        { id: "e1", from: "a", to: "b" },
        { id: "e2", from: "b", to: "a", variant: "dashed" },
      ],
    });
    const kinds = legendKinds(nodes);
    expect(kinds).toContain("variant-default");
    expect(kinds).toContain("variant-dashed");
    const sample = nodes.find((n) => n.attrs["data-legend-kind"] === "variant-dashed")!;
    // Flat document order: the line sample is the first path INSIDE that g.
    const gi = nodes.indexOf(sample);
    const line = nodes.slice(gi + 1).find((n) => n.tag === "path")!;
    expect(classList(line)).toContain("a-dashed");
    // The legend text carries the convention, not just the line style.
    const label = nodes.find(
      (n) => n.tag === "text" && n.text.includes("verifies")
    );
    expect(label).toBeDefined();
  });

  test("mixed variants WITHOUT opt-in chart nothing (D3 byte-lock)", async () => {
    const nodes = await render({
      ...BASE,
      connections: [
        { id: "e1", from: "a", to: "b" },
        { id: "e2", from: "b", to: "a", variant: "dashed" },
      ],
    });
    expect(legendKinds(nodes).filter((k) => k.startsWith("variant-"))).toEqual([]);
    // The type legend itself is untouched.
    expect(legendKinds(nodes)).toContain("backend");
  });

  test("meta.legend:false suppresses the whole auto legend", async () => {
    const nodes = await render({
      ...BASE,
      meta: { ...BASE.meta, legend: false },
      connections: [
        { id: "e1", from: "a", to: "b" },
        { id: "e2", from: "b", to: "a", variant: "dashed" },
      ],
    });
    expect(nodes.find((n) => n.attrs["data-legend-bridge"] !== undefined)?.text ?? "gone")
      .not.toContain("Legend");
    expect(legendKinds(nodes)).toEqual([]);
  });
});
