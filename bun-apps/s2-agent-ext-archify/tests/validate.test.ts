import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { archifyValidate } from "../src/validate.ts";

const fixtureIr = join(import.meta.dir, "fixtures/mini.architecture.json");

const validIr = {
  schema_version: 1, diagram_type: "architecture",
  meta: { title: "Mini" },
  components: [{ id: "a", type: "backend", label: "A", pos: [0, 0], size: [10, 10] }],
  connections: [],
};
const invalidIr = { schema_version: 1, diagram_type: "architecture", meta: {}, components: [] };

describe("archify_validate", () => {
  it("accepts a valid IR", async () => {
    const res = await archifyValidate({ ir: validIr }, { cwd: import.meta.dir });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain("valid");
  });
  it("reports diagnostics for an invalid IR (missing meta.title)", async () => {
    const res = await archifyValidate({ ir: invalidIr }, { cwd: import.meta.dir });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("title");
  });

  it("infers diagram type from an irPath file when `type` is omitted", async () => {
    const res = await archifyValidate({ irPath: fixtureIr }, { cwd: import.meta.dir });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain("valid");
    expect((res.details as { type?: string }).type).toBe("architecture");
  });

  it("surfaces composition summary (warnings) on a valid IR", async () => {
    const res = await archifyValidate({ ir: validIr }, { cwd: import.meta.dir });
    expect(res.isError).toBeFalsy();
    const text = res.content[0]!.text.toLowerCase();
    expect(text).toContain("composition");
    const details = res.details as { report?: { composition?: { summary?: { warnings?: number } } } };
    const summary = details.report?.composition?.summary;
    expect(typeof summary?.warnings).toBe("number");
  });
});
