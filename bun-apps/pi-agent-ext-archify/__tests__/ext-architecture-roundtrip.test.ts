import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archifyRender } from "../lib/render.ts";
import { inspectArtifact } from "../lib/inspect-artifact.ts";

const E2E = process.env.PI_AGENT_E2E === "1";
const describeMaybe = E2E ? describe : describe.skip;

const PKG = join(import.meta.dir, "..");
const IR_PATH = join(PKG, "ir", "pi-agent-extensions.architecture.json");

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const COMPONENT_LABELS = [
  "Core Task", "Hermes Memory", "Superpowers", "Wayfind", "Web Access", "Obsidian",
  "BTW", "File2MD", "Subagent", "Workflow", "Knowledge Card", "Power Tool",
  "Tool Gate", "Flux2", "Krea2", "LTX", "Research Tool", "ZAI MCP",
  "Movie Director", "Deploy", "Archify",
];
const LANE_LABELS = [
  "Static — native import · in --exe binary",
  "Dynamic — jiti -e · source/bundle only",
];

describeMaybe("pi-agent extension architecture — render round-trip", () => {
  test("every component label and both lane labels render as <text>", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "archify-extarch-"));
    tempDirs.push(cwd);
    const ir = JSON.parse(readFileSync(IR_PATH, "utf8"));

    const res = await archifyRender({ ir, type: "architecture" }, { cwd });
    const htmlPath = (res.details as { path: string }).path;
    const f = inspectArtifact(readFileSync(htmlPath, "utf8"));

    expect(f.hasDoctype).toBe(true);
    expect(f.hasSvg).toBe(true);
    for (const label of COMPONENT_LABELS) {
      expect(f.textLabels).toContain(label);
    }
    for (const lane of LANE_LABELS) {
      expect(f.textLabels).toContain(lane);
    }
  }, 60_000);
});
