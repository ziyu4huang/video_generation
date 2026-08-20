import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classList, parseSvg, type SvgNode } from "../lib/svg-model.ts";
import {
  CLASS_RULES,
  knownClasses,
  parseCssColor,
  resolveStyle,
  themeBackground,
  toHex,
  flatten,
  applyInlineAttrs,
  type Theme,
} from "../lib/svg-theme.ts";
import { runArchify, VENDORED_BIN } from "../lib/run.ts";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = join(PKG_ROOT, "vendored", "examples");
const THEMES: Theme[] = ["light", "dark"];

/**
 * Render every vendored example (all five diagram types) once, so the drift
 * guard sees the WHOLE class vocabulary rather than the architecture subset.
 * Measured 2026-08-21: 13 examples in 558 ms total — cheap enough to be an
 * unconditional gate, so this test has no skip escape hatch on purpose.
 */
let renderedDocs: { name: string; nodes: SvgNode[] }[] = [];
let workDir = "";

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "archify-theme-drift-"));
  const files = readdirSync(EXAMPLES).filter((f) =>
    /\.(architecture|workflow|sequence|dataflow|lifecycle)\.json$/.test(f)
  );
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    const type = /\.(\w+)\.json$/.exec(f)![1]!;
    const out = join(workDir, f.replace(".json", ".html"));
    const { stdout, status } = await runArchify(
      ["deliver", type, join(EXAMPLES, f), out, "--json"],
      PKG_ROOT,
      undefined,
      VENDORED_BIN
    );
    expect(status, `${f} render exit status (stdout: ${stdout.slice(0, 200)})`).toBe(0);
    const doc = await parseSvg(await Bun.file(out).text());
    renderedDocs.push({ name: f, nodes: doc.nodes });
  }
});

describe("theme drift — the class vocabulary must stay covered", () => {
  test("every class on a rendered element is known to the table", () => {
    const known = knownClasses();
    const unknown = new Map<string, string>(); // class -> first file that used it
    for (const { name, nodes } of renderedDocs) {
      for (const n of nodes) {
        for (const c of classList(n)) {
          if (!known.has(c) && !unknown.has(c)) unknown.set(c, `${name} <${n.tag}>`);
        }
      }
    }
    expect(
      [...unknown].map(([c, where]) => `${c} (first seen in ${where})`),
      "svg-theme.ts CLASS_RULES is missing classes emitted by the vendored renderers — " +
        "a vendored bump added styling this exporter would silently drop"
    ).toEqual([]);
  });

  test("every class defined in the template stylesheet is known", async () => {
    const template = await Bun.file(join(PKG_ROOT, "vendored", "assets", "template.html")).text();
    const known = knownClasses();
    const defined = new Set(
      [...template.matchAll(/\.((?:c|t|m|a|s)-[a-z0-9-]+|sigil-fill|semantic-sigil)\b/g)].map(
        (m) => m[1]!
      )
    );
    const missing = [...defined].filter((c) => !known.has(c)).sort();
    expect(missing).toEqual([]);
  });

  test("the guard can actually fail", () => {
    // A guard nobody has seen fail is a guard nobody knows works.
    const known = knownClasses();
    expect(known.has("c-invented-by-a-future-vendor-bump")).toBe(false);
  });

  test("covers all five diagram types", () => {
    const types = new Set(
      renderedDocs.map((d) => /\.(\w+)\.json$/.exec(d.name)![1]!)
    );
    expect([...types].sort()).toEqual([
      "architecture",
      "dataflow",
      "lifecycle",
      "sequence",
      "workflow",
    ]);
  });
});

describe("resolveStyle", () => {
  test("every paint-bearing class resolves in both themes", () => {
    for (const theme of THEMES) {
      for (const [cls, rule] of Object.entries(CLASS_RULES)) {
        const isStructural = Object.keys(rule).length === 0;
        const s = resolveStyle([cls], theme, { r: 1, g: 2, b: 3, a: 1 });
        if (isStructural) {
          expect(s, `${cls} should carry no paint`).toEqual({});
          continue;
        }
        const carriesPaint =
          s.fill !== undefined ||
          s.stroke !== undefined ||
          s.color !== undefined ||
          s.dash !== undefined;
        expect(carriesPaint, `${cls} resolved to nothing in ${theme}`).toBe(true);
      }
    }
  });

  test("light and dark differ where the palette differs", () => {
    const l = resolveStyle(["c-backend"], "light");
    const d = resolveStyle(["c-backend"], "dark");
    expect(l.stroke).not.toEqual(d.stroke);
  });

  test("`none` is null, absent is undefined", () => {
    const s = resolveStyle(["a-default"], "light");
    expect(s.fill).toBeNull(); // .a-default { fill: none }
    expect(s.strokeWidth).toBeUndefined(); // never specified by the class
  });

  test("sigil-fill takes currentColor from the inherited s-* color", () => {
    const inherited = resolveStyle(["s-database"], "light").color!;
    expect(inherited).toBeDefined();
    const s = resolveStyle(["sigil-fill"], "light", inherited);
    expect(s.fill).toEqual(inherited);
    expect(s.stroke).toBeNull();
  });

  test("unknown classes are ignored, not fatal", () => {
    expect(resolveStyle(["totally-unknown"], "light")).toEqual({});
  });
});

describe("applyInlineAttrs — inline presentation attributes win", () => {
  const base = resolveStyle(["c-backend"], "light");

  test("stroke-width and stroke-dasharray are picked up", () => {
    const s = applyInlineAttrs(base, (n) =>
      ({ "stroke-width": "1.1", "stroke-dasharray": "5, 3" })[n]
    );
    expect(s.strokeWidth).toBe(1.1);
    expect(s.dash).toEqual([5, 3]);
  });

  test("an inline fill overrides the class fill", () => {
    const s = applyInlineAttrs(base, (n) => (n === "fill" ? "#ff0000" : undefined));
    expect(s.fill).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  test("absent attributes leave the class style untouched", () => {
    expect(applyInlineAttrs(base, () => undefined)).toEqual(base);
  });

  test("the archify `style` attribute carries no paint", () => {
    // Measured across all 13 examples: every `style` value is `--step:N`, an
    // animation-ordering custom property. This test pins that so nobody adds a
    // CSS declaration parser for it.
    const stylish = renderedDocs
      .flatMap((d) => d.nodes)
      .map((n) => n.attrs["style"])
      .filter((v): v is string => v !== undefined);
    expect(stylish.length).toBeGreaterThan(0);
    for (const v of stylish) expect(v).toMatch(/^--step:\d+$/);
  });
});

describe("parseCssColor", () => {
  test("hex forms", () => {
    expect(parseCssColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor("#0891b2")).toEqual({ r: 8, g: 145, b: 178, a: 1 });
  });

  test("rgb / rgba", () => {
    expect(parseCssColor("rgba(34, 211, 238, 0.15)")).toEqual({ r: 34, g: 211, b: 238, a: 0.15 });
    expect(parseCssColor("rgb(1,2,3)")).toEqual({ r: 1, g: 2, b: 3, a: 1 });
  });

  test("none / transparent are null; absent is undefined", () => {
    expect(parseCssColor("none")).toBeNull();
    expect(parseCssColor("transparent")).toBeNull();
    expect(parseCssColor(undefined)).toBeUndefined();
  });

  test("currentColor resolves from the supplied color", () => {
    const c = { r: 9, g: 9, b: 9, a: 1 };
    expect(parseCssColor("currentColor", c)).toEqual(c);
  });

  test("an unparseable value is undefined, not a crash", () => {
    expect(parseCssColor("color-mix(in srgb, red 50%, blue)")).toBeUndefined();
  });
});

describe("color helpers", () => {
  test("toHex is uppercase, 6 digits, no hash", () => {
    expect(toHex({ r: 8, g: 145, b: 178, a: 1 })).toBe("0891B2");
    expect(toHex({ r: 0, g: 0, b: 0, a: 1 })).toBe("000000");
  });

  test("toHex clamps out-of-range channels", () => {
    expect(toHex({ r: -5, g: 300, b: 12.6, a: 1 })).toBe("00FF0D");
  });

  test("flatten composites alpha against the page background", () => {
    const white = { r: 255, g: 255, b: 255, a: 1 };
    expect(flatten({ r: 0, g: 0, b: 0, a: 0.5 }, white)).toEqual({
      r: 127.5,
      g: 127.5,
      b: 127.5,
      a: 1,
    });
  });

  test("themeBackground matches the palette", () => {
    expect(toHex(themeBackground("light"))).toBe("FFFFFF");
    expect(toHex(themeBackground("dark"))).toBe("020617");
  });
});

// Clean up the render scratch dir without leaving it to the OS.
process.on("exit", () => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});
