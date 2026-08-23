import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOutline } from "../src/outline.ts";
import { DeckError } from "../src/deck-build.ts";
import { resolveLayout } from "../src/slide-model.ts";
import { archifyExportPptx } from "../src/export-pptx.ts";
import { readZipText } from "../src/read-zip.ts";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(PKG_ROOT, "scripts", "deck.ts");
const FIXTURE_IR = join(PKG_ROOT, "tests", "fixtures", "mini.architecture.json");

const work = mkdtempSync(join(tmpdir(), "archify-outline-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("parseOutline — marker dialect (ticket 08 acceptance 1)", () => {
  test("every marker round-trips to the expected slide", () => {
    const md = [
      "---",
      "output: out.pptx",
      "theme: dark",
      "tag: demo",
      "defaults:",
      "  font: PingFang TC",
      "---",
      "# A Title",
      "> A Subtitle",
      "## 2 Second Section",
      "### Content Action",
      "^ the takeaway",
      "~ the source",
      "- plain bullet",
      "  - nested bullet",
      "!ir " + FIXTURE_IR,
      "### A Quote",
      ":::quote",
      '{ "quote": "Hold the line", "attribution": "M. H.", "role": "lead" }',
      ":::",
    ].join("\n");

    const m = parseOutline(md, work);

    expect(m.output).toBe("out.pptx");
    expect(m.theme).toBe("dark");
    expect(m.tag).toBe("demo");
    expect(m.defaults).toEqual({ font: "PingFang TC" });

    const [s1, s2, s3] = m.slides;
    expect(s1).toEqual({ layout: "title", title: "A Title", subtitle: "A Subtitle" });
    expect(s2).toEqual({ layout: "section", title: "Second Section", sectionNumber: "2" });
    // `!ir` + bullets ⇒ split, and the inference is marker-order independent:
    // the bullets come BEFORE the `!ir` line here, the split decision is made
    // at slide close.
    expect(s3).toEqual({
      title: "Content Action",
      takeaway: "the takeaway",
      source: "the source",
      bullets: ["plain bullet", { text: "nested bullet", level: 1 }],
      ir: FIXTURE_IR,
      layout: "split",
    });
    // The only route to a template: fenced `:::name` payload, merged as slots.
    // Slot keys live on the template's schema, not on `Slide`, so reach them
    // through a record cast.
    const s4 = m.slides[3] as unknown as Record<string, unknown>;
    expect(s4.title).toBe("A Quote");
    expect(s4.layout).toBe("quote");
    expect(s4.quote).toBe("Hold the line");
    expect(s4.attribution).toBe("M. H.");
    expect(s4.role).toBe("lead");
  });
});

test("section numbers are not capped at two digits", () => {
  const m = parseOutline("## 100 Big\n", work);
  expect(m.slides[0]).toEqual({ layout: "section", title: "Big", sectionNumber: "100" });
});

describe("parseOutline — `!ir` split vs diagram (ticket 08 acceptance 2)", () => {
  test("ir alone resolves to diagram; ir + bullets resolves to split", () => {
    const irOnly = parseOutline(`### Diagram only\n!ir ${FIXTURE_IR}\n`, work);
    const irSlide = irOnly.slides[0]!;
    expect(irSlide.layout).toBeUndefined(); // authoring keeps the slide as it arrived
    expect(resolveLayout(irSlide)).toBe("diagram"); // and the builder infers it

    const withPoints = parseOutline(`### Split\n!ir ${FIXTURE_IR}\n- a point\n`, work);
    expect(withPoints.slides[0]!.layout).toBe("split");
    expect(resolveLayout(withPoints.slides[0]!)).toBe("split");
  });
});

describe("parseOutline — error shapes (ticket 08 acceptance 3 + 4)", () => {
  test("an unknown fenced layout fails with the registry's available list, not a JSON error", () => {
    const md = ["### X", ":::nope-69", '{ "slot": "x" }', ":::"].join("\n");
    let msg = "";
    try {
      parseOutline(md, work);
    } catch (e) {
      msg = e instanceof DeckError ? e.message : String(e);
    }
    expect(msg).toContain('unknown `layout` "nope-69"');
    expect(msg).toContain("expected one of");
    // The registry is the message's source: a shipped template name appears in
    // the available list (the code-layout fallback list would not contain it).
    expect(msg).toContain("quote");
    expect(msg).not.toContain("not valid JSON");
  });

  test("malformed frontmatter names the line number", () => {
    let msg = "";
    try {
      parseOutline(["---", "output: x.pptx", "boom", "---", "# T"].join("\n"), work);
    } catch (e) {
      msg = e instanceof DeckError ? e.message : String(e);
    }
    expect(msg).toContain("outline line 3");
    expect(msg).toContain("malformed frontmatter");
  });

  test("an unknown frontmatter key names the line number", () => {
    let msg = "";
    try {
      parseOutline(["---", "bogus: 1", "---", "# T"].join("\n"), work);
    } catch (e) {
      msg = e instanceof DeckError ? e.message : String(e);
    }
    expect(msg).toContain("outline line 2");
    expect(msg).toContain("unknown frontmatter key");
  });

  test("an unclosed fenced payload names the opening line number", () => {
    let msg = "";
    try {
      parseOutline(["# T", "### X", ":::quote", '{ "quote": "never closed" }'].join("\n"), work);
    } catch (e) {
      msg = e instanceof DeckError ? e.message : String(e);
    }
    expect(msg).toContain("outline line 3");
    expect(msg).toContain("never closed");
  });
});

describe("outline → .pptx — same outline through tool and CLI (ticket 08 acceptance 5)", () => {
  test("the tool and `bun run deck --outline` produce byte-equal decks", async () => {
    const outlinePath = join(work, "outline.md");
    const md = [
      "# Overview",
      "> Full deck",
      "## 1 Intro",
      "### Split",
      "!ir " + FIXTURE_IR,
      "- left point",
      "  - nested point",
      "### Quote",
      ":::quote",
      '{ "quote": "Hold the line", "attribution": "M. H.", "role": "lead" }',
      ":::",
    ].join("\n");
    writeFileSync(outlinePath, md);

    // Tool path: archify_export_pptx with outlinePath.
    const toolOut = join(work, "tool.pptx");
    const r = await archifyExportPptx({ outlinePath, outputPath: toolOut }, { cwd: PKG_ROOT });
    expect(r.isError).not.toBe(true);
    expect(existsSync(toolOut)).toBe(true);

    // CLI path: bun run deck --outline.
    const cliOut = join(work, "cli.pptx");
    const proc = Bun.spawnSync({
      cmd: [process.execPath, SCRIPT, "--outline", outlinePath, "--output", cliOut],
      cwd: PKG_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);

    // Byte parity must not be wall-clock-dependent: pptxgenjs stamps
    // docProps/core.xml with second-precision `new Date()` values, so two
    // builds of the SAME deck differ byte-wise when they cross a second
    // boundary. Compare every ZIP entry except that stamped metadata —
    // byte-exact everywhere else is the drift evidence the acceptance wants.
    const partsA = await readZipText(await Bun.file(toolOut).bytes());
    const partsB = await readZipText(await Bun.file(cliOut).bytes());
    delete partsA["docProps/core.xml"];
    delete partsB["docProps/core.xml"];
    expect(Object.keys(partsA).length).toBeGreaterThan(5); // not a vacuous compare
    expect(partsA).toEqual(partsB);
  });
});
