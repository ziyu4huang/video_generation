import { describe, test, expect } from "bun:test";
import { validateArtifact, listSchemas } from "./schema.ts";

describe("artifact schema validation", () => {
  test("schemas loaded include the canonical artifacts", () => {
    const list = listSchemas();
    expect(list).toContain("artifact/script");
    expect(list).toContain("artifact/edit_decisions");
    expect(list).toContain("pipeline/pipeline_manifest");
    expect(list).toContain("checkpoint/checkpoint");
  });

  test("a well-formed brief validates", () => {
    const r = validateArtifact("brief", {
      version: "1.0",
      title: "Hook Test",
      hook: "a hook",
      key_points: ["a"],
      tone: "neutral",
      style: "clean",
      target_platform: "youtube",
      target_duration_seconds: 30,
    });
    expect(r.ok).toBe(true);
  });

  test("a malformed brief (missing required) fails with errors", () => {
    const r = validateArtifact("brief", { version: "1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });
});
