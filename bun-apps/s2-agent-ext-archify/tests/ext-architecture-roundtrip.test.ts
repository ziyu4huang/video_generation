import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archifyRender } from "../src/render.ts";
import { inspectArtifact } from "../src/inspect-artifact.ts";

// E2E-gated: the manifest testGate runs `bun test --isolate` without this env var,
// so this suite SKIPs in default CI and only fires when a human runs E2E locally.
// The Task-1 ext-architecture-ir.test.ts guard (validate + closed-set edges) is the
// unconditional rot-protector; this suite is the deeper real-render check.
const E2E = process.env.PI_AGENT_E2E === "1";
const describeMaybe = E2E ? describe : describe.skip;

const PKG = join(import.meta.dir, "..");
const IR_PATH = join(PKG, "ir", "s2-agent-extensions.architecture.json");

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// Derive expected labels from the IR itself so this test cannot drift from the IR.
// If a label changes in the IR, the expected set tracks it automatically.
const _ir = JSON.parse(readFileSync(IR_PATH, "utf8")) as {
  components: { label: string }[];
  boundaries: { label: string }[];
};
const COMPONENT_LABELS = _ir.components.map((c) => c.label);
const LANE_LABELS = _ir.boundaries.map((b) => b.label);

describeMaybe("s2-agent extension architecture — render round-trip", () => {
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
