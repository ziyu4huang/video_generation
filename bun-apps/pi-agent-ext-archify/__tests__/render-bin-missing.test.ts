import { describe, it, expect, mock } from "bun:test";

// Stub run.ts so runArchify returns the exact pre-flight "bin missing" shape
// (stdout empty, stderr carrying the vendored-bin-not-found message). This
// tests render.ts's catch-block formatting in isolation; the real pre-flight
// is covered by vendored-bin-resolution.test.ts.
mock.module("../lib/run.ts", () => ({
  VENDORED_BIN: "/nonexistent/archify.mjs",
  resolveVendoredBin: () => "/nonexistent/archify.mjs",
  withTempIr: async (_ir: unknown, fn: (irPath: string) => unknown) => fn("/tmp/ir.json"),
  runArchify: async () => ({
    stdout: "",
    stderr:
      "archify vendored bin not found at /nonexistent/archify.mjs; deploy may have omitted vendored/ (set PI_ARCHIFY_BIN to override).",
    status: 1,
  }),
}));

const { archifyRender } = await import("../lib/render.ts");

describe("archifyRender — missing vendored bin", () => {
  it("surfaces 'vendored bin not found' and does NOT say 'Validate the IR'", async () => {
    const out = await archifyRender(
      { ir: { diagram_type: "architecture" } },
      { cwd: "/tmp" },
    );
    const text = (out.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(out.isError).toBe(true);
    expect(text).toContain("vendored bin not found");
    expect(text).not.toContain("Validate the IR");
  });
});
