import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./pi-movie-director-cost.ts";

function captureTool(): any {
  let tool: any = null;
  const fakePi = {
    registerTool(t: any) {
      tool = t;
    },
  } as any;
  extension(fakePi);
  return tool;
}

describe("cost tool (typed prototype)", () => {
  test("registers with a non-empty description and a real union schema (not Type.Any)", () => {
    const tool = captureTool();
    expect(tool.name).toBe("cost");
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.parameters).toBeDefined();
    expect(tool.parameters.anyOf).toBeDefined();
    expect(tool.parameters.anyOf.length).toBe(4);
  });

  test("estimate → reserve → reconcile → snapshot lifecycle round-trips", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-cost-tool-"));
    const prev = process.env.MLX_OUTPUT_DIR;
    process.env.MLX_OUTPUT_DIR = dir;
    try {
      const tool = captureTool();
      const est = await tool.execute(
        "id",
        { action: "estimate", projectId: "p1", tool: "krea2_image", operation: "t2i", estimatedUsd: 0.05 },
        undefined,
        undefined,
        undefined,
      );
      expect(est.details.ok).toBe(true);
      const entryId = JSON.parse(est.content[0].text).entryId;
      expect(typeof entryId).toBe("string");

      const res = await tool.execute("id", { action: "reserve", projectId: "p1", entryId }, undefined, undefined, undefined);
      expect(res.details.ok).toBe(true);

      const rec = await tool.execute(
        "id",
        { action: "reconcile", projectId: "p1", entryId, actualUsd: 0.04, success: true },
        undefined,
        undefined,
        undefined,
      );
      expect(rec.details.ok).toBe(true);

      const snap = await tool.execute("id", { action: "snapshot", projectId: "p1" }, undefined, undefined, undefined);
      expect(snap.details.ok).toBe(true);
      const parsed = JSON.parse(snap.content[0].text);
      expect(parsed.total_spent_usd).toBe(0.04);
    } finally {
      if (prev === undefined) delete process.env.MLX_OUTPUT_DIR;
      else process.env.MLX_OUTPUT_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reserve on an unknown entryId surfaces the error (not swallowed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-cost-tool-err-"));
    const prev = process.env.MLX_OUTPUT_DIR;
    process.env.MLX_OUTPUT_DIR = dir;
    try {
      const tool = captureTool();
      const res = await tool.execute(
        "id",
        { action: "reserve", projectId: "p1", entryId: "nonexistent" },
        undefined,
        undefined,
        undefined,
      );
      expect(res.details.ok).toBe(false);
      expect(res.details.error).toContain("not found");
    } finally {
      if (prev === undefined) delete process.env.MLX_OUTPUT_DIR;
      else process.env.MLX_OUTPUT_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
