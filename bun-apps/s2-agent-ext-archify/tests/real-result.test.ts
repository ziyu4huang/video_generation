import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archifyRender } from "../src/render.ts";
import { runArchify } from "../src/run.ts";
import { inspectArtifact } from "../src/inspect-artifact.ts";

const E2E = process.env.PI_AGENT_E2E === "1";
const describeMaybe = E2E ? describe : describe.skip;

const VENDORED_EXAMPLES = join(import.meta.dir, "..", "vendored", "examples");

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
function withTempCwd(): string {
  const d = mkdtempSync(join(tmpdir(), "archify-real-"));
  tempDirs.push(d);
  return d;
}

const MATRIX = [
  { type: "architecture", file: "production-deployment.architecture.json" },
  { type: "sequence", file: "async-job-roundtrip.sequence.json" },
  { type: "workflow", file: "agent-tool-call.workflow.json" },
  { type: "dataflow", file: "event-stream.dataflow.json" },
  { type: "lifecycle", file: "agent-run.lifecycle.json" },
] as const;

describeMaybe("archify real-result — generated-HTML structural fidelity", () => {
  for (const { type, file } of MATRIX) {
    test(`${type}: round-trip integrity, self-containment, archify check`, async () => {
      const cwd = withTempCwd();
      const ir = JSON.parse(readFileSync(join(VENDORED_EXAMPLES, file), "utf8"));

      const res = await archifyRender({ ir, type }, { cwd });
      const htmlPath = (res.details as { path: string }).path;
      const html = readFileSync(htmlPath, "utf8");
      const f = inspectArtifact(html);

      // structural fidelity
      expect(f.hasDoctype).toBe(true);
      expect(f.hasSvg).toBe(true);
      expect(f.textLabels.length).toBeGreaterThan(0);
      expect(typeof f.title).toBe("string");
      expect(f.title!.length).toBeGreaterThan(0);
      expect(f.bytes).toBeGreaterThan(10_000);

      // functional self-containment: no REQUIRED external refs (offline-capable)
      expect(f.requiredExternalRefs).toEqual([]);

      // vendored artifact validator
      const check = await runArchify(["check", htmlPath], cwd);
      expect(check.status).toBe(0);
    }, 60_000);
  }

  test("architecture: every IR component label renders in a <text> element", async () => {
    const cwd = withTempCwd();
    const ir = JSON.parse(
      readFileSync(join(VENDORED_EXAMPLES, "production-deployment.architecture.json"), "utf8"),
    ) as { components?: { label?: string }[] };
    const components = (ir.components ?? [])
      .map((c) => c.label)
      .filter((label): label is string => typeof label === "string" && label.length > 0);

    const res = await archifyRender({ ir, type: "architecture" }, { cwd });
    const htmlPath = (res.details as { path: string }).path;
    const f = inspectArtifact(readFileSync(htmlPath, "utf8"));

    for (const label of components) {
      expect(f.textLabels).toContain(label);
    }
  }, 60_000);
});
