import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { runArchify } from "../lib/run.ts";

const fixture = join(import.meta.dir, "fixtures/mini.architecture.json");

describe("runArchify", () => {
  it("validate returns structured JSON on a valid IR (--json)", () => {
    const r = runArchify(["validate", "architecture", fixture, "--json"], import.meta.dir);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.command).toBe("validate");
  });
});
