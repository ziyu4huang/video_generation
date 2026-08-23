import { describe, it, expect } from "bun:test";
import { archifyDelta } from "../src/delta.ts";

// Uses DI (ctx.bin) — NOT mock.module — to force the "vendored bin not found"
// pre-flight. See render-bin-missing.test.ts: Bun's mock.module is
// process-global, so a run.ts stub leaks into sibling test files and breaks the
// whole single-process `bun test` run. A nonexistent bin via DeltaCtx triggers
// runArchify's REAL pre-flight guard, leak-free.
describe("archifyDelta — missing vendored bin", () => {
  it("surfaces 'vendored bin not found' and does NOT say 'Ensure both IRs'", async () => {
    const out = await archifyDelta(
      { basePath: "/tmp/base.json", headPath: "/tmp/head.json" },
      { cwd: "/tmp", bin: "/nonexistent/archify.mjs" },
    );
    const text = (out.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(out.isError).toBe(true);
    expect(text).toContain("vendored bin not found");
    expect(text).not.toContain("Ensure both IRs");
  });
});
