import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { runArchify } from "../src/run.ts";

const fixture = join(import.meta.dir, "fixtures/mini.architecture.json");

describe("runArchify", () => {
  it("validate returns structured JSON on a valid IR (--json)", async () => {
    const r = await runArchify(["validate", "architecture", fixture, "--json"], import.meta.dir);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.command).toBe("validate");
  });

  it("is async — returns a Promise so it never blocks the event loop", () => {
    const p = runArchify(["validate", "architecture", fixture, "--json"], import.meta.dir);
    expect(p).toBeInstanceOf(Promise);
    return p; // let it settle; a synchronous call returns a plain object, not a Promise
  });

  it("honors an already-aborted signal (does not report a successful run)", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runArchify(["validate", "architecture", fixture, "--json"], import.meta.dir, ac.signal);
    expect(r.status).not.toBe(0);
  });
});
