import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expandVModelArchetype } from "../vendored/renderers/architecture/vmodel.mjs";
import { runArchify, VENDORED_BIN } from "../src/run.ts";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Ticket 02 (effort 2026-08-22-archify-deck-template-v2): `meta.archetype:
 * { kind: "v-model" }` declares the arms; the geometry pre-pass fills absent
 * pos/size. Explicit positions survive; bad payloads fail with actionable
 * problems; a full V renders clean through deliver.
 */
const LEFT = ["rfq", "s1", "s2", "h1", "h2"];
const RIGHT = ["h3", "h4", "s4", "s5"];

function vIr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    diagram_type: "architecture",
    meta: {
      title: "V fixture",
      output: "v.architecture.html",
      archetype: { kind: "v-model", leftArm: LEFT, rightArm: RIGHT },
      ...overrides,
    },
    components: [...LEFT, ...RIGHT].map((id) => ({ id, type: "backend", label: id.toUpperCase() })),
    connections: [
      ...LEFT.slice(0, -1).map((id, i) => ({ id: `l${i}`, from: id, to: LEFT[i + 1]! })),
      { id: "apex", from: "h2", to: "h3" },
      ...RIGHT.slice(0, -1).map((id, i) => ({ id: `r${i}`, from: id, to: RIGHT[i + 1]! })),
    ],
  };
}

describe("expandVModelArchetype (pure geometry)", () => {
  test("fills pos/size into a V: left arm top→apex, right arm apex→top", () => {
    const arch = vIr() as { meta: { archetype: unknown }; components: { id: string; pos?: number[]; size?: number[] }[] };
    expandVModelArchetype(arch, []);
    const at = (id: string): { x: number; y: number; size?: number[] } => {
      const c = arch.components.find((x) => x.id === id)!;
      const pos = c.pos as [number, number];
      return { x: pos[0], y: pos[1], size: c.size };
    };
    expect(at("rfq").y).toBeLessThan(at("h2").y); // left descends
    expect(at("rfq").x).toBeLessThan(at("h2").x);
    expect(at("h3").y).toBe(at("h2").y); // apex pair shares the bottom row
    expect(at("h3").x).toBeGreaterThan(at("h2").x + 150); // edge clearance, no overlap
    expect(at("s5").y).toBeLessThan(at("h3").y); // right ascends
    expect(at("s5").x).toBeGreaterThan(at("h3").x);
    expect(at("h2").y).toBe(Math.max(...[...LEFT, ...RIGHT].map((id) => at(id).y)));
    for (const c of arch.components) expect(c.size).toEqual([150, 64]);
  });

  test("explicit pos is never overridden", () => {
    const arch = vIr() as { components: { id: string; pos?: number[] }[] };
    const pinned = arch.components.find((c) => c.id === "s2")!;
    pinned.pos = [700, 200];
    expandVModelArchetype(arch, []);
    expect(pinned.pos).toEqual([700, 200]);
  });

  test("unknown arm id and double-arm membership are actionable problems", () => {
    const bad1 = vIr() as { meta: { archetype: { leftArm: string[] } } };
    bad1.meta.archetype.leftArm = ["rfq", "s1", "s2", "h1", "nope"];
    const p1: string[] = [];
    expandVModelArchetype(bad1, p1);
    expect(p1.join("\n")).toContain('"nope"');

    const bad2 = vIr() as { meta: { archetype: { rightArm: string[] } } };
    bad2.meta.archetype.rightArm = ["h2", "h3", "h4"];
    const p2: string[] = [];
    expandVModelArchetype(bad2, p2);
    expect(p2.join("\n")).toContain('"h2"');
  });

  test("no archetype payload is a no-op", () => {
    const arch = vIr() as { meta: { archetype?: unknown }; components: { pos?: number[] }[] };
    delete arch.meta.archetype;
    expandVModelArchetype(arch, []);
    expect(arch.components.every((c) => c.pos === undefined)).toBe(true);
  });
});

describe("v-model through the vendored pipeline", () => {
  let workDir = "";

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "archify-vmodel-"));
  });

  test("deliver renders a pos-free V clean (all layout gates pass)", async () => {
    const irPath = join(workDir, "v.architecture.json");
    writeFileSync(irPath, JSON.stringify(vIr()));
    const { stdout, status } = await runArchify(
      ["deliver", "architecture", irPath, join(workDir, "v.architecture.html"), "--json"],
      PKG_ROOT,
      undefined,
      VENDORED_BIN
    );
    expect(status, stdout.slice(0, 300)).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);
  });

  test("unknown arm id fails deliver with the id named", async () => {
    const ir = vIr() as { meta: { archetype: { leftArm: string[] } } };
    ir.meta.archetype.leftArm = ["rfq", "s1", "s2", "h1", "nope"];
    const irPath = join(workDir, "bad.architecture.json");
    writeFileSync(irPath, JSON.stringify(ir));
    const { stdout, status } = await runArchify(
      ["deliver", "architecture", irPath, join(workDir, "bad.html"), "--json"],
      PKG_ROOT,
      undefined,
      VENDORED_BIN
    );
    expect(status).toBe(1);
    expect(stdout).toContain("nope");
  });

  test("schema rejects an unknown archetype kind", async () => {
    const ir = vIr({ archetype: { kind: "pyramid", leftArm: LEFT, rightArm: RIGHT } });
    const irPath = join(workDir, "kind.architecture.json");
    writeFileSync(irPath, JSON.stringify(ir));
    const { stdout, status } = await runArchify(
      ["validate", "architecture", irPath, "--json"],
      PKG_ROOT,
      undefined,
      VENDORED_BIN
    );
    expect(status).toBe(1);
    expect(stdout).toContain("archetype");
  });
});
