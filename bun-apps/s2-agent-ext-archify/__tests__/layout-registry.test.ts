import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "../lib/layout-registry.ts";
import { PALETTES, TYPE_SCALE, type TypeSpec } from "../lib/deck-theme.ts";

/** A minimal valid template body. */
function tpl(name: string, marker = "v1"): string {
  return JSON.stringify({
    name,
    description: `${name} template ${marker}`,
    chrome: false,
    slots:
      name === "kpi-row"
        ? { kpis: { kind: "array", of: ["value", "label"], min: 2, max: 4, required: true } }
        : {},
    body: [
      {
        region: "content",
        box: { inset: [0.2 + (marker === "v2" ? 0 : 0), 0.3, 0.2, 0.5] },
        content: { kind: "text", role: "kpiValue", from: "{slide.title}" },
        align: "center",
      },
    ],
  });
}

function writeTemplate(dir: string, name: string, marker = "v1"): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.layout.json`);
  writeFileSync(path, tpl(name, marker));
  return path;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "archify-registry-"));
}

const CTX = { index: 0, total: 1, tag: "t" };

describe("precedence — code layouts win outright (D3)", () => {
  test("a template named after a code layout is a LOAD ERROR in any tier, not an override", () => {
    // On the $ARCHIFY_TEMPLATES tier…
    const envDir = tempDir();
    writeTemplate(envDir, "diagram");
    expect(() =>
      loadRegistry({ env: { ARCHIFY_TEMPLATES: envDir }, shippedDir: tempDir() })
    ).toThrow(/code layout/);
    // …and on the <manifestDir>/templates tier.
    const manifestDir = tempDir();
    writeTemplate(join(manifestDir, "templates"), "bullets");
    expect(() => loadRegistry({ env: {}, manifestDir, shippedDir: tempDir() })).toThrow(
      /code layout/
    );
  });

  test("the six code layouts are always present and still render through layouts.ts", () => {
    const reg = loadRegistry({ env: {}, shippedDir: tempDir() });
    for (const n of ["title", "section", "bullets", "split", "diagram", "statement"]) {
      expect(reg.has(n)).toBe(true);
    }
    const blocks = reg.render("bullets", { title: "T", bullets: ["a"] }, CTX);
    expect(blocks.some((b) => b.content.kind === "bullets")).toBe(true);
  });
});

describe("precedence — user tiers beat the shipped tier", () => {
  test("an $ARCHIFY_TEMPLATES template beats a same-name shipped one", () => {
    const user = tempDir();
    const shipped = tempDir();
    writeTemplate(user, "kpi-row", "v1");
    writeTemplate(shipped, "kpi-row", "v2");
    const reg = loadRegistry({
      env: { ARCHIFY_TEMPLATES: user },
      manifestDir: tempDir(),
      shippedDir: shipped,
    });
    expect(reg.catalog().find((c) => c.name === "kpi-row")?.description).toContain("v1");
    expect(reg.roleOf("kpi-row")).toBeTypeOf("function");
  });

  test("<manifestDir>/templates is searched after $ARCHIFY_TEMPLATES but before shipped", () => {
    const envDir = tempDir();
    const manifestDir = tempDir();
    const shipped = tempDir();
    writeTemplate(envDir, "alpha", "env");
    writeTemplate(join(manifestDir, "templates"), "beta", "manifest");
    writeTemplate(shipped, "alpha", "shipped");
    writeTemplate(shipped, "beta", "shipped");
    const reg = loadRegistry({ env: { ARCHIFY_TEMPLATES: envDir }, manifestDir, shippedDir: shipped });
    const srcOf = (n: string) => reg.catalog().find((c) => c.name === n)?.source ?? "";
    expect(srcOf("alpha").startsWith(envDir)).toBe(true);
    expect(srcOf("beta").startsWith(join(manifestDir, "templates"))).toBe(true);
  });

  test("duplicate names within ONE tier are an error — silent shadowing hides edits", () => {
    const a = tempDir();
    const b = tempDir();
    writeTemplate(a, "dup");
    writeTemplate(b, "dup");
    // Same tier ($ARCHIFY_TEMPLATES holds both dirs).
    expect(() =>
      loadRegistry({ env: { ARCHIFY_TEMPLATES: `${a}:${b}` }, shippedDir: tempDir() })
    ).toThrow(/duplicate template name/);
    // Across tiers it is precedence, not an error.
    const reg = loadRegistry({ env: { ARCHIFY_TEMPLATES: a }, shippedDir: b });
    expect(reg.has("dup")).toBe(true);
  });
});

describe("roleOf merge (§4.5)", () => {
  test("a template role overrides a builtin for that slide only; builtins pass through", () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "roles.layout.json");
    writeFileSync(
      path,
      JSON.stringify({
        name: "roles",
        description: "role override probe",
        chrome: false,
        roles: {
          title: { sizePt: 40 },
          kpiValue: { sizePt: 40, bold: true, color: "title" },
          quiet: { sizePt: 8, color: "muted" },
        },
        body: [
          { region: "content", box: "fill", content: { kind: "text", role: "quiet", from: "{slide.title}" } },
        ],
      })
    );
    const reg = loadRegistry({ env: {}, shippedDir: dir });
    const roleOf = reg.roleOf("roles");
    const mergedTitle: TypeSpec = roleOf("title");
    expect(mergedTitle.sizePt).toBe(40); // overridden
    expect(mergedTitle.bold).toBe(true); // builtin carried through the merge
    expect(mergedTitle.color).toBe(TYPE_SCALE.title.color);
    expect(roleOf("kpiValue").sizePt).toBe(40);
    expect(roleOf("bullet").sizePt).toBe(TYPE_SCALE.bullet.sizePt); // untouched builtin

    // The next slide using a code layout is unaffected.
    expect(reg.roleOf("statement")("statement").sizePt).toBe(TYPE_SCALE.statement.sizePt);
  });

  test("autofit: a template role opts long text into shrink; builtin defaults hold otherwise", async () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "autofit.layout.json");
    writeFileSync(
      path,
      JSON.stringify({
        name: "autofit",
        description: "autofit probe",
        chrome: false,
        roles: { runningText: { sizePt: 16, color: "body", autofit: true } },
        body: [
          { region: "content", box: "fill", content: { kind: "text", role: "runningText", from: "{slide.title}" } },
        ],
      })
    );
    const reg = loadRegistry({ env: {}, shippedDir: dir });
    expect(reg.roleOf("autofit")("runningText").autofit).toBe(true);

    const { emitPptxSlide } = await import("../lib/emit-pptx.ts");
    const { spySlide, textCalls } = await import("./helpers/spy-slide.ts");
    const blocks = reg.render("autofit", { title: "long text" }, CTX);
    const slide = spySlide();
    emitPptxSlide(slide, blocks, {
      palette: PALETTES.light,
      theme: "light",
      font: "Arial",
      diagrams: new Map(),
      roleOf: reg.roleOf("autofit"),
    });
    expect(textCalls(slide)[0]!.opts["fit"]).toBe("shrink");

    // Without the role override, chrome roles keep their no-autofit behaviour.
    const codeBlocks = reg.render("bullets", { title: "T", bullets: ["a"] }, CTX);
    const slide2 = spySlide();
    emitPptxSlide(slide2, codeBlocks, {
      palette: PALETTES.light,
      theme: "light",
      font: "Arial",
      diagrams: new Map(),
      roleOf: reg.roleOf("bullets"),
    });
    const tagCall = textCalls(slide2).find((c) => c.text === "t")!;
    expect(tagCall.opts["fit"]).toBeUndefined();
  });
});

describe("parseManifest wire-in", () => {
  test("the unknown-layout message lists what IS available — the fallback discovery path", async () => {
    const user = tempDir();
    writeTemplate(user, "kpi-row");
    const reg = loadRegistry({ env: { ARCHIFY_TEMPLATES: user }, shippedDir: tempDir() });
    const { parseManifest, DeckError } = await import("../lib/deck-build.ts");
    const raw = JSON.stringify({ slides: [{ title: "T", layout: "kpi_row" }] });
    expect(() => parseManifest(raw, "test", reg)).toThrow(DeckError);
    let message = "";
    try {
      parseManifest(raw, "test", reg);
    } catch (e) {
      message = (e as Error).message;
    }
    for (const name of reg.names()) expect(message).toContain(name);

    // A template layout passes validation; without the registry the static
    // six-element check still guards.
    const ok = JSON.stringify({ slides: [{ title: "T", layout: "kpi-row" }] });
    expect(() => parseManifest(ok, "test", reg)).not.toThrow();
    expect(() => parseManifest(ok, "test")).toThrow(/unknown `layout`/);
  });
});

describe("catalog()", () => {
  test("returns {name, description, slots, source} with absolute sources, templates included", () => {
    const user = tempDir();
    const path = writeTemplate(user, "kpi-row");
    const reg = loadRegistry({ env: { ARCHIFY_TEMPLATES: user }, shippedDir: tempDir() });
    const catalog = reg.catalog();
    const entry = catalog.find((c) => c.name === "kpi-row")!;
    expect(entry.description).toContain("kpi-row");
    expect(entry.slots.kpis!.required).toBe(true);
    expect(entry.slots.kpis!.max).toBe(4);
    expect(entry.source).toMatch(/^\//);
    expect(entry.source).toBe(path);
    // Code layouts appear too, with an absolute source and no slots.
    const diagram = catalog.find((c) => c.name === "diagram")!;
    expect(diagram.source).toMatch(/^\//);
    expect(diagram.slots).toEqual({});
  });

  test("names() lists code layouts first, then templates — the unknown-layout message's vocabulary", () => {
    const user = tempDir();
    writeTemplate(user, "kpi-row");
    const reg = loadRegistry({ env: { ARCHIFY_TEMPLATES: user }, shippedDir: tempDir() });
    expect(reg.names()).toEqual([
      "title",
      "section",
      "bullets",
      "split",
      "diagram",
      "statement",
      "kpi-row",
    ]);
  });
});
