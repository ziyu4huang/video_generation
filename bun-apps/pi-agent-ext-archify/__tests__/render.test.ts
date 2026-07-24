import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { archifyRender } from "../lib/render.ts";

const fixtureIr = join(import.meta.dir, "fixtures/mini.architecture.json");
const referenceHtml = join(import.meta.dir, "fixtures/mini.architecture.html");

const normalize = (s: string) => s.replace(/\r\n?/g, "\n");

describe("archify_render (golden snapshot)", () => {
  it("renders the fixture IR to HTML matching the checked-in reference", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "archify-render-"));
    const res = await archifyRender({ irPath: fixtureIr }, { cwd: outDir });
    expect(res.isError).toBeFalsy();
    const out = res.details!.path as string;
    const fresh = normalize(await Bun.file(out).text());
    const ref = normalize(await Bun.file(referenceHtml).text());
    expect(fresh).toBe(ref);
  });
});
