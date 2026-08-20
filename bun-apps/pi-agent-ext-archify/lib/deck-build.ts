/**
 * deck-build.ts — deck manifest → a PPTX of NATIVE shapes.
 *
 * The shared core behind both `bun run deck` (scripts/deck.ts) and the
 * `archify_export_pptx` tool, so the CLI and the agent can never drift.
 *
 * Pipeline, per slide:
 *
 *   IR .json --deliver--> .html --parseSvg--> SvgDoc --toShapeIR--> ShapeIR
 *            --addShapeIrToSlide--> native PowerPoint shapes
 *
 * `deliver` (not bare `render`) is deliberate: it validates the IR, renders,
 * checks the artifact and commits atomically, so a deck can never be built from
 * an artifact archify itself considers broken.
 *
 * **No browser is involved.** The previous implementation launched Playwright
 * chromium and screenshotted each `<svg>` into a slide image; slides were flat
 * pictures and the package carried a browser dependency for it. Both are gone.
 */
import PptxGenJS from "pptxgenjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { loadIrMeta } from "./load-ir.ts";
import { addShapeIrToSlide, type SlideLike } from "./pptx-shapes.ts";
import { formatShapeIR, toShapeIR, type ShapeIR, type Theme } from "./shape-ir.ts";
import { parseSvg } from "./svg-model.ts";
import { runArchify, VENDORED_BIN } from "./run.ts";

export type { Theme };

export interface DeckSlide {
  /** Path to the IR .json, absolute or relative to the manifest dir. */
  ir: string;
  title: string;
  subtitle?: string;
}

export interface DeckManifest {
  output?: string;
  theme?: Theme;
  tag?: string;
  defaults?: {
    font?: string;
    /**
     * Raster scale factor. Meaningless now that slides carry vector shapes —
     * ACCEPTED AND IGNORED so existing manifests keep working rather than
     * erroring on a field that used to matter.
     */
    scale?: number;
  };
  slides: DeckSlide[];
}

/** A user-facing failure with a message meant to be printed as-is. */
export class DeckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeckError";
  }
}

interface Palette {
  slideBg: string;
  title: string;
  accent: string;
  subtitle: string;
  tagBg: string;
  tagBorder: string;
}

export const PALETTES: Record<Theme, Palette> = {
  light: {
    slideBg: "FFFFFF",
    title: "0F2740",
    accent: "2563EB",
    subtitle: "6B7280",
    tagBg: "EFF4FA",
    tagBorder: "CBD5E1",
  },
  dark: {
    slideBg: "0B1220",
    title: "E2E8F0",
    accent: "60A5FA",
    subtitle: "94A3B8",
    tagBg: "1E293B",
    tagBorder: "334155",
  },
};

/** Slide chrome geometry, in inches on a 13.333 x 7.5 stage. */
const STAGE = { w: 13.333, h: 7.5 };
const CONTENT = { x: 0.5, y: 1.18, w: 12.333, h: 5.7 };

export interface BuildDeckParams {
  manifest: DeckManifest;
  /** Directory that `slide.ir` and `manifest.output` resolve against. */
  manifestDir: string;
  /** Absolute output path for the .pptx. */
  outputPath: string;
  /** Overrides `manifest.theme`. */
  theme?: Theme;
  /** Working dir for the vendored CLI. */
  cwd: string;
  bin?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Debug hook: dump each slide's ShapeIR here (see `--emit-shape-ir`). */
  emitShapeIrDir?: string;
}

export interface BuiltSlide {
  title: string;
  subtitle?: string;
  /** The rendered HTML for this slide (inside the build's temp dir). */
  htmlPath: string;
  irPath: string;
  diagramType: string;
  shapes: number;
  texts: number;
}

export interface DeckResult {
  output: string;
  theme: Theme;
  bytes: number;
  slides: BuiltSlide[];
}

/** Parse + shape-check a manifest. Throws `DeckError` with a printable message. */
export function parseManifest(raw: string, source: string): DeckManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new DeckError(
      `manifest is not valid JSON (${source}): ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new DeckError(`manifest must be a JSON object (${source})`);
  }
  const m = parsed as DeckManifest;
  if (!Array.isArray(m.slides) || m.slides.length === 0) {
    throw new DeckError("manifest missing non-empty `slides`");
  }
  m.slides.forEach((s, i) => {
    if (!s || typeof s.ir !== "string" || s.ir === "") {
      throw new DeckError(`slide ${i + 1}: missing \`ir\``);
    }
    if (typeof s.title !== "string" || s.title === "") {
      throw new DeckError(`slide ${i + 1}: missing \`title\``);
    }
  });
  if (m.theme !== undefined && m.theme !== "light" && m.theme !== "dark") {
    throw new DeckError(`manifest \`theme\` must be light|dark, got ${JSON.stringify(m.theme)}`);
  }
  return m;
}

/** Build an implicit one-slide-per-IR manifest (the `irPaths` tool form). */
export function manifestFromIrPaths(irPaths: string[], cwd: string): DeckManifest {
  if (irPaths.length === 0) throw new DeckError("irPaths is empty");
  return {
    slides: irPaths.map((p) => {
      const abs = isAbsolute(p) ? p : resolve(cwd, p);
      const loaded = loadIrMeta({ irPath: abs, cwd });
      const title = loaded.ok
        ? (loaded.meta.title ?? basename(abs).replace(/\.json$/i, ""))
        : basename(abs).replace(/\.json$/i, "");
      return { ir: abs, title };
    }),
  };
}

/** Render one IR to HTML through the vendored `deliver` path. */
async function deliverSlide(
  irAbs: string,
  htmlPath: string,
  index: number,
  params: BuildDeckParams
): Promise<string> {
  const loaded = loadIrMeta({ irPath: irAbs, cwd: params.manifestDir });
  if (!loaded.ok) throw new DeckError(`slide ${index + 1}: ${loaded.error}`);
  const type = loaded.meta.type;
  if (!type) throw new DeckError(`slide ${index + 1}: IR has no \`diagram_type\``);

  const { stdout, stderr, status } = await runArchify(
    ["deliver", type, irAbs, htmlPath, "--json"],
    params.cwd,
    params.signal,
    params.bin ?? VENDORED_BIN
  );
  let receipt: { ok?: boolean; error?: string; diagnostics?: { code?: string; message?: string }[] };
  try {
    receipt = JSON.parse(stdout);
  } catch {
    throw new DeckError(
      `slide ${index + 1}: archify deliver produced non-JSON output (exit ${status}). ${
        stderr || stdout
      }`
    );
  }
  if (receipt.ok !== true || status !== 0) {
    const diag = receipt.diagnostics?.length
      ? receipt.diagnostics.map((d) => `[${d.code ?? "?"}] ${d.message ?? ""}`).join("\n")
      : (receipt.error ?? "");
    throw new DeckError(
      `slide ${index + 1}: archify render failed: ${receipt.error ?? "see diagnostics"}.\n` +
        `Validate the IR first with archify_validate.\n${diag}`
    );
  }
  return type;
}

/** Draw the fixed slide chrome (tag, title, accent rule, subtitle, page number). */
function addChrome(
  slide: SlideLike & { background?: unknown },
  opts: {
    palette: Palette;
    font: string;
    tag: string;
    title: string;
    subtitle?: string;
    index: number;
    total: number;
  }
): void {
  const { palette: p, font } = opts;
  slide.addShape("roundRect", {
    x: 9.7, y: 0.28, w: 3.13, h: 0.4,
    fill: { color: p.tagBg },
    line: { color: p.tagBorder, width: 0.5 },
  });
  slide.addText(opts.tag, {
    x: 9.7, y: 0.28, w: 3.13, h: 0.4,
    fontFace: font, fontSize: 10, color: p.title, align: "center", valign: "middle",
  });
  slide.addText(opts.title, {
    x: 0.5, y: 0.22, w: 9.0, h: 0.75,
    fontFace: font, fontSize: 26, bold: true, color: p.title, valign: "middle",
  });
  slide.addShape("rect", {
    x: 0.5, y: 1.02, w: CONTENT.w, h: 0.035,
    fill: { color: p.accent },
    line: { type: "none" },
  });
  slide.addText(opts.subtitle ?? "", {
    x: 0.5, y: 7.0, w: 11.4, h: 0.4,
    fontFace: font, fontSize: 11, color: p.subtitle, valign: "middle",
  });
  slide.addText(`${opts.index + 1} / ${opts.total}`, {
    x: 11.9, y: 7.0, w: 0.94, h: 0.4,
    fontFace: font, fontSize: 11, color: p.subtitle, align: "right", valign: "middle",
  });
}

/** Build the deck. Every slide is validated, rendered, and drawn as shapes. */
export async function buildDeck(params: BuildDeckParams): Promise<DeckResult> {
  const { manifest } = params;
  const theme: Theme = params.theme ?? manifest.theme ?? "light";
  const palette = PALETTES[theme];
  const font = manifest.defaults?.font ?? "Arial";
  const tag = manifest.tag ?? "archify deck";
  const progress = params.onProgress ?? (() => {});

  const work = mkdtempSync(join(tmpdir(), "archify-deck-"));
  try {
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: "WIDE", width: STAGE.w, height: STAGE.h });
    pptx.layout = "WIDE";

    const built: BuiltSlide[] = [];
    for (let i = 0; i < manifest.slides.length; i++) {
      if (params.signal?.aborted) throw new DeckError("aborted");
      const s = manifest.slides[i]!;
      const irAbs = isAbsolute(s.ir) ? s.ir : resolve(params.manifestDir, s.ir);
      if (!(await Bun.file(irAbs).exists())) {
        throw new DeckError(`slide ${i + 1}: IR not found: ${irAbs}`);
      }

      const htmlPath = join(work, `slide-${i + 1}.html`);
      const diagramType = await deliverSlide(irAbs, htmlPath, i, params);

      const doc = await parseSvg(await Bun.file(htmlPath).text());
      const ir: ShapeIR = toShapeIR(doc, theme);
      if (params.emitShapeIrDir) {
        await Bun.write(join(params.emitShapeIrDir, `slide-${i + 1}.shape-ir.txt`), formatShapeIR(ir));
      }

      const slide = pptx.addSlide() as unknown as SlideLike & { background?: unknown };
      (slide as { background?: unknown }).background = { color: palette.slideBg };
      addChrome(slide, {
        palette, font, tag,
        title: s.title,
        ...(s.subtitle !== undefined ? { subtitle: s.subtitle } : {}),
        index: i,
        total: manifest.slides.length,
      });
      const placed = addShapeIrToSlide(slide, ir, CONTENT, { fontFace: font });

      built.push({
        title: s.title,
        ...(s.subtitle !== undefined ? { subtitle: s.subtitle } : {}),
        htmlPath,
        irPath: irAbs,
        diagramType,
        shapes: placed.shapes,
        texts: placed.texts,
      });
      progress(
        `slide ${i + 1}/${manifest.slides.length} (${diagramType}) — ` +
          `${placed.shapes} shapes, ${placed.texts} text runs`
      );
    }

    const data = (await pptx.write({ outputType: "nodebuffer" })) as Uint8Array;
    await Bun.write(params.outputPath, data);
    return { output: params.outputPath, theme, bytes: data.length, slides: built };
  } finally {
    // The rendered HTML lives in `work`; ticket 09 copies what it needs out
    // BEFORE this returns, so cleaning up here is safe.
    rmSync(work, { recursive: true, force: true });
  }
}

/** Resolve a manifest path + its output path the way both entry points expect. */
export async function loadManifestFile(
  manifestPath: string,
  cwd: string
): Promise<{ manifest: DeckManifest; manifestDir: string; manifestAbs: string }> {
  const manifestAbs = isAbsolute(manifestPath) ? manifestPath : resolve(cwd, manifestPath);
  const file = Bun.file(manifestAbs);
  if (!(await file.exists())) throw new DeckError(`manifest not found: ${manifestAbs}`);
  const manifest = parseManifest(await file.text(), manifestAbs);
  return { manifest, manifestDir: dirname(manifestAbs), manifestAbs };
}

/**
 * Where the .pptx goes: an explicit `outputFlag` resolves against the CWD (it
 * came from a person's shell), while `manifest.output` resolves against the
 * manifest dir (so a manifest stays portable).
 */
export function resolveDeckOutput(
  manifest: DeckManifest,
  manifestDir: string,
  cwd: string,
  outputFlag?: string
): string {
  if (outputFlag) return isAbsolute(outputFlag) ? outputFlag : resolve(cwd, outputFlag);
  if (!manifest.output) {
    throw new DeckError("manifest missing `output` (and no --output given)");
  }
  return isAbsolute(manifest.output) ? manifest.output : resolve(manifestDir, manifest.output);
}
