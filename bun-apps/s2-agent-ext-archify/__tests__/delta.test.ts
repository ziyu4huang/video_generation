import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { archifyDelta } from "../lib/delta.ts";

const base = join(import.meta.dir, "fixtures/mini.architecture.json");
const head = join(import.meta.dir, "fixtures/mini.architecture.v2.json");

describe("archify_delta", () => {
  it("produces a before/delta/after HTML for two architecture IRs", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "archify-delta-"));
    const res = await archifyDelta({ basePath: base, headPath: head }, { cwd: outDir });
    expect(res.isError).toBeFalsy();
    const out = res.details!.path as string;
    const html = await Bun.file(out).text();
    expect(html.length).toBeGreaterThan(10_000);
    expect(out).toMatch(/\.html$/);
    // compare always writes a sidecar receipt beside the HTML; the tool must
    // report it (A4) rather than leaving an unexplained second file.
    const receipt = res.details!.receipt as string | undefined;
    expect(receipt).toBeTruthy();
    expect(receipt).toMatch(/\.receipt\.json$/);
    expect(await Bun.file(receipt!).exists()).toBe(true);
  }, 30_000); // full vendored deliver pipeline (validate → render → check); ~6s warm, well over bun's 5s default
  it("rejects non-architecture types (archify compare is architecture-only)", async () => {
    const res = await archifyDelta({ basePath: base, headPath: head, type: "workflow" }, { cwd: "/tmp" });
    expect(res.isError).toBe(true);
  });
});
