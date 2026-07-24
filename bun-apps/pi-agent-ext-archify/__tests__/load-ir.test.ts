import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadIrMeta } from "../lib/load-ir.ts";

describe("loadIrMeta", () => {
  it("extracts type + metaOutput from an inline ir object", () => {
    const r = loadIrMeta({
      ir: { diagram_type: "workflow", meta: { output: "w.html" } },
      cwd: "/work",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meta.type).toBe("workflow");
    expect(r.meta.metaOutput).toBe("w.html");
  });

  it("reads type + metaOutput from an irPath file (cwd-relative)", () => {
    const dir = mkdtempSync(join(tmpdir(), "archify-loadir-"));
    writeFileSync(
      join(dir, "ir.json"),
      JSON.stringify({ diagram_type: "sequence", meta: { output: "seq.html" } }),
    );
    const r = loadIrMeta({ irPath: "ir.json", cwd: dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meta.type).toBe("sequence");
    expect(r.meta.metaOutput).toBe("seq.html");
  });

  it("honors an absolute irPath", () => {
    const dir = mkdtempSync(join(tmpdir(), "archify-loadir-abs-"));
    const abs = join(dir, "ir.json");
    writeFileSync(abs, JSON.stringify({ diagram_type: "dataflow" }));
    const r = loadIrMeta({ irPath: abs, cwd: "/elsewhere" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meta.type).toBe("dataflow");
    expect(r.meta.metaOutput).toBeUndefined();
  });

  it("reports an honest error when irPath is unreadable (not a silent 'type unknown')", () => {
    const r = loadIrMeta({ irPath: "does-not-exist.json", cwd: "/work" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("does-not-exist.json");
  });

  it("reports an honest error when irPath is malformed JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "archify-loadir-bad-"));
    writeFileSync(join(dir, "ir.json"), "{ not valid json");
    const r = loadIrMeta({ irPath: "ir.json", cwd: dir });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/json|parse/i);
  });

  it("returns undefined type when neither ir nor irPath carries diagram_type", () => {
    const r = loadIrMeta({ ir: { meta: {} }, cwd: "/work" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meta.type).toBeUndefined();
  });
});
