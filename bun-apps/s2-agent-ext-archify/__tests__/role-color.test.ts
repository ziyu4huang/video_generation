import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classList, parseSvg, type SvgNode } from "../lib/svg-model.ts";
import { resolveStyle, THEME_VARS } from "../lib/svg-theme.ts";
import { runArchify, VENDORED_BIN } from "../lib/run.ts";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Ticket 01 (effort 2026-08-22-archify-deck-template-v2): the `role` field
 * (enum spec/verify) repaints components and connections with the role
 * palette in BOTH render paths — the vendored HTML renderer (class
 * vocabulary) and the lib pptx theme table (CLASS_RULES). Role is a pure
 * overlay: absent role ⇒ the type/variant palette, bit-for-bit.
 */
const ROLE_IR = {
  schema_version: 1,
  diagram_type: "architecture",
  meta: { title: "role fixture", output: "role-fixture.architecture.html" },
  components: [
    { id: "src", type: "external", role: "spec", label: "RFQ", pos: [40, 40], size: [120, 60] },
    { id: "mid", type: "backend", label: "Plain", pos: [240, 40], size: [120, 60] },
    { id: "chk", type: "frontend", role: "verify", label: "Verify", pos: [440, 40], size: [120, 60] },
  ],
  connections: [
    { id: "c1", from: "src", to: "mid" },
    { id: "c2", from: "mid", to: "chk", variant: "dashed", role: "verify" },
  ],
};

let workDir = "";
let svgNodes: SvgNode[] = [];

function classesOf(node: SvgNode | undefined): string[] {
  return node ? classList(node) : [];
}

function findByDataId(nodes: SvgNode[], name: string, value: string): SvgNode | undefined {
  return nodes.find((n) => n.attrs[name.toLowerCase()] === value);
}

/** Any node in the flat document order carrying a class token. */
function nodeWithClass(nodes: SvgNode[], cls: string): SvgNode | undefined {
  return nodes.find((n) => classList(n).includes(cls));
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "archify-role-"));
  const irPath = join(workDir, "role-fixture.architecture.json");
  writeFileSync(irPath, JSON.stringify(ROLE_IR));
  const out = join(workDir, "role-fixture.architecture.html");
  const { stdout, status } = await runArchify(
    ["deliver", "architecture", irPath, out, "--json"],
    PKG_ROOT,
    undefined,
    VENDORED_BIN
  );
  expect(status, `deliver exit (stdout: ${stdout.slice(0, 200)})`).toBe(0);
  svgNodes = (await parseSvg(await Bun.file(out).text())).nodes;
});

describe("role → class vocabulary (vendored renderer)", () => {
  test("role component carries the role fill class, not its type class", () => {
    // Component fills paint at the authored pos with the authored size;
    // legend swatches are 14x9 — geometry disambiguates the two.
    const compRect = (x: string, y: string): SvgNode | undefined => {
      // c-mask underlay + fill rect share a position; the fill is the LAST.
      const hits = svgNodes.filter((n) => n.tag === "rect" && n.attrs.x === x && n.attrs.y === y && n.attrs.width === "120");
      return hits[hits.length - 1];
    };
    const src = classesOf(compRect("40", "40"));
    expect(src).toContain("c-role-spec");
    expect(src).not.toContain("c-external");
    const chk = classesOf(compRect("440", "40"));
    expect(chk).toContain("c-role-verify");
    expect(chk).not.toContain("c-frontend");
  });

  test("verify role + dashed variant compose on one path", () => {
    const path = findByDataId(svgNodes, "data-edge-from", "mid");
    expect(path).toBeDefined();
    const cls = classesOf(path);
    expect(cls).toContain("a-dashed");
    expect(cls).toContain("a-role-verify");
    expect(path!.attrs["marker-end"]).toBe("url(#arrowhead-role-verify)");
  });

  test("absent role keeps the type palette", () => {
    const node = findByDataId(svgNodes, "data-node-id", "mid");
    expect(node).toBeDefined();
    expect(nodeWithClass(svgNodes, "c-backend")).toBeDefined();
  });

  test("legend gains role swatches when roles are in use", () => {
    expect(findByDataId(svgNodes, "data-legend-kind", "role-spec")).toBeDefined();
    expect(findByDataId(svgNodes, "data-legend-kind", "role-verify")).toBeDefined();
  });
});

describe("role → color (lib theme table, the pptx path)", () => {
  test("role class resolves to the role stroke in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const spec = resolveStyle(["c-role-spec"], theme);
      const verify = resolveStyle(["c-role-verify"], theme);
      expect(spec.stroke).toBeDefined();
      expect(verify.stroke).toBeDefined();
      expect(spec.stroke).not.toEqual(verify.stroke);
      const vars = THEME_VARS[theme];
      expect(vars["role-spec-stroke"]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(vars["role-verify-stroke"]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  test("role overlay after variant keeps the dash, wins the stroke", () => {
    const s = resolveStyle(["a-dashed", "a-role-verify"], "light");
    expect(s.dash).toEqual([4, 4]);
    const variantOnly = resolveStyle(["a-dashed"], "light");
    expect(s.stroke).not.toEqual(variantOnly.stroke);
    const roleOnly = resolveStyle(["a-role-verify"], "light");
    expect(s.stroke).toEqual(roleOnly.stroke);
  });

  test("marker + text role classes resolve", () => {
    const m = resolveStyle(["m-role-verify"], "dark");
    expect(m.fill).toBeDefined();
    const t = resolveStyle(["t-role-spec"], "dark");
    expect(t.fill).toBeDefined();
  });
});
