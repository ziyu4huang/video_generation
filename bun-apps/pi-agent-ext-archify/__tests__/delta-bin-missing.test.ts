import { describe, it, expect, mock } from "bun:test";

mock.module("../lib/run.ts", () => ({
  VENDORED_BIN: "/nonexistent/archify.mjs",
  resolveVendoredBin: () => "/nonexistent/archify.mjs",
  runArchify: async () => ({
    stdout: "",
    stderr:
      "archify vendored bin not found at /nonexistent/archify.mjs; deploy may have omitted vendored/ (set PI_ARCHIFY_BIN to override).",
    status: 1,
  }),
}));

const { archifyDelta } = await import("../lib/delta.ts");

describe("archifyDelta — missing vendored bin", () => {
  it("surfaces 'vendored bin not found' and does NOT say 'Ensure both IRs'", async () => {
    const out = await archifyDelta(
      { basePath: "/tmp/base.json", headPath: "/tmp/head.json" },
      { cwd: "/tmp" },
    );
    const text = (out.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(out.isError).toBe(true);
    expect(text).toContain("vendored bin not found");
    expect(text).not.toContain("Ensure both IRs");
  });
});
