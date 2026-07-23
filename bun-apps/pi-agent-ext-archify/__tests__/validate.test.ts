import { describe, it, expect } from "bun:test";
import { archifyValidate } from "../lib/validate.ts";

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
});
