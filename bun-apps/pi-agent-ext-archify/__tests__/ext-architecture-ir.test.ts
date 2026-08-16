import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const PKG = join(import.meta.dir, "..");
const IR_PATH = join(PKG, "ir", "pi-agent-extensions.architecture.json");
const BIN = join(PKG, "vendored", "bin", "archify.mjs");

const ir = JSON.parse(readFileSync(IR_PATH, "utf8")) as {
  diagram_type: string;
  components: { id: string; label: string }[];
  boundaries: { label: string; wraps: string[] }[];
  connections: { from: string; to: string }[];
};

const STATIC = [
  "task", "hermes-memory", "superpowers", "wayfind", "web-access",
  "obsidian", "btw", "file2md", "subagent", "workflow", "knowledge-card", "power-tool",
];
const DYNAMIC = [
  "tool-gate", "flux2", "krea2", "ltx", "research-tool",
  "zai-mcp", "movie-director", "deploy", "archify",
];
const EXPECTED_EDGES = [
  ["flux2", "file2md"], ["flux2", "workflow"],
  ["hermes-memory", "subagent"],
  ["knowledge-card", "obsidian"], ["knowledge-card", "subagent"],
  ["movie-director", "flux2"], ["movie-director", "krea2"],
  ["movie-director", "ltx"], ["movie-director", "workflow"],
  ["research-tool", "obsidian"],
  ["wayfind", "task"],
  ["workflow", "subagent"],
];

describe("pi-agent extension architecture IR", () => {
  test("is an architecture diagram", () => {
    expect(ir.diagram_type).toBe("architecture");
  });

  test("has exactly 21 components with stable ids", () => {
    const ids = ir.components.map((c) => c.id).sort();
    expect(ids).toEqual([...STATIC, ...DYNAMIC].sort());
  });

  test("has two lane boundaries (static + dynamic) partitioning all 21", () => {
    const byLabel = new Map(ir.boundaries.map((b) => [b.label, b.wraps]));
    const staticLane = byLabel.get("Static — native import · in --exe binary") ?? [];
    const dynamicLane = byLabel.get("Dynamic — jiti -e · source/bundle only") ?? [];
    expect(staticLane.sort()).toEqual(STATIC.slice().sort());
    expect(dynamicLane.sort()).toEqual(DYNAMIC.slice().sort());
  });

  test("connection set exactly matches the grep-verified import edges", () => {
    const got = new Set(ir.connections.map((c) => `${c.from}->${c.to}`));
    expect(ir.connections).toHaveLength(EXPECTED_EDGES.length);
    for (const [from, to] of EXPECTED_EDGES) {
      expect(got.has(`${from}->${to}`)).toBe(true);
    }
  });

  test("archify validate accepts the IR", () => {
    const r = spawnSync(process.execPath, [BIN, "validate", "architecture", IR_PATH, "--json"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });
});
