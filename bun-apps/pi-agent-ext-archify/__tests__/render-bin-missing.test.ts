import { describe, it, expect } from "bun:test";
import { archifyRender } from "../lib/render.ts";

// Uses DI (ctx.bin) — NOT mock.module — to force the "vendored bin not found"
// pre-flight. Bun's mock.module is process-global: a stubbed run.ts leaks into
// every sibling test file that imports the real module (vendored-bin-resolution,
// archify_validate, the golden render, archify_delta, …), breaking the whole
// suite in a single-process `bun test` run. Passing a nonexistent bin through
// RenderCtx triggers runArchify's REAL pre-flight guard with zero cross-file
// contamination. See pi-agent/src/cli/__tests__/workflow-command.test.ts and
// pi-agent-ext-subagent/.../models-preset-command.test.ts for the same
// "DI over mock.module" convention.
describe("archifyRender — missing vendored bin", () => {
  it("surfaces 'vendored bin not found' and does NOT say 'Validate the IR'", async () => {
    const out = await archifyRender(
      { ir: { diagram_type: "architecture" } },
      { cwd: "/tmp", bin: "/nonexistent/archify.mjs" },
    );
    const text = (out.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(out.isError).toBe(true);
    expect(text).toContain("vendored bin not found");
    expect(text).not.toContain("Validate the IR");
  });
});
