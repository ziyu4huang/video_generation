import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { archifyRender } from "../lib/render.ts";

const fixtureIr = join(import.meta.dir, "fixtures/mini.architecture.json");
const referenceHtml = join(import.meta.dir, "fixtures/mini.architecture.html");

const validIr = {
  schema_version: 1, diagram_type: "architecture",
  meta: { title: "Mini" },
  components: [
    { id: "client", type: "frontend", label: "Client", pos: [40, 40], size: [120, 60] },
    { id: "server", type: "backend", label: "Server", pos: [260, 40], size: [120, 60] },
    { id: "db", type: "database", label: "DB", pos: [480, 40], size: [120, 60] },
  ],
  connections: [
    { id: "c1", from: "client", to: "server" },
    { id: "c2", from: "server", to: "db", label: "SQL" },
  ],
};

const normalize = (s: string) => s.replace(/\r\n?/g, "\n");

describe("archify_render (golden snapshot)", () => {
  it("renders the fixture IR to HTML matching the checked-in reference", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "archify-render-"));
    const res = await archifyRender({ irPath: fixtureIr }, { cwd: outDir });
    expect(res.isError).toBeFalsy();
    const out = (res.details as { path: string }).path;
    const fresh = normalize(await Bun.file(out).text());
    const ref = normalize(await Bun.file(referenceHtml).text());
    expect(fresh).toBe(ref);
  });

  it("honors meta.output authored inside an irPath file (not only inline ir)", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "archify-render-meta-"));
    const res = await archifyRender({ irPath: fixtureIr }, { cwd: outDir });
    expect(res.isError).toBeFalsy();
    // fixture authors meta.output = "mini.html"; render must respect it.
    expect((res.details as { path: string }).path).toBe(join(outDir, "mini.html"));
  });
});

describe("archify_render (deliver receipt)", () => {
  it("returns artifact sha256 + validation summary on success", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "archify-render-receipt-"));
    const res = await archifyRender({ ir: validIr }, { cwd: outDir });
    expect(res.isError).toBeFalsy();
    const details = res.details as {
      artifact?: { sha256?: string; bytes?: number };
      validation?: { checksPassed?: number; checkCount?: number };
    };
    expect(details.artifact?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof details.validation?.checksPassed).toBe("number");
    expect(typeof details.validation?.checkCount).toBe("number");
    expect(details.validation!.checksPassed!).toBeGreaterThanOrEqual(1);
    expect(details.validation!.checkCount!).toBeGreaterThanOrEqual(details.validation!.checksPassed!);
  });

  it("fails (isError) when the IR is schema-invalid", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "archify-render-invalid-"));
    const res = await archifyRender(
      { ir: { schema_version: 1, diagram_type: "architecture", meta: {} } },
      { cwd: outDir },
    );
    expect(res.isError).toBe(true);
  });
});
