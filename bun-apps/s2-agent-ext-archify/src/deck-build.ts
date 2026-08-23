/**
 * deck-build.ts — deck manifest → a PPTX of NATIVE shapes + composed slide HTML.
 *
 * The shared core behind both `bun run deck` (scripts/deck.ts) and the
 * `archify_export_pptx` tool, so the CLI and the agent can never drift.
 *
 * This module is an ORCHESTRATOR and nothing else. It resolves the manifest,
 * asks `layouts.ts` where things go, hands the answer to the two emitters, and
 * writes the results. It owns no geometry, no palette and no chrome — those
 * moved to `layouts.ts` / `deck-theme.ts` when a slide stopped being "one
 * diagram per page".
 *
 * Pipeline, per slide:
 *
 *   Slide --resolveLayout--> layout fn --> PlacedBlock[]
 *                                             |
 *          diagram blocks --deliver--> .html --parseSvg--> SvgDoc --toShapeIR--┐
 *                                             |                                |
 *                                             +--> emit-pptx (native shapes) <-+
 *                                             +--> emit-html (composed page)
 *
 * `deliver` (not bare `render`) is deliberate: it validates the IR, renders,
 * checks the artifact and commits atomically, so a deck can never be built from
 * an artifact archify itself considers broken.
 *
 * **No browser is involved.** Slides carry real PowerPoint shapes and text runs,
 * never screenshots.
 */
import PptxGenJS from "pptxgenjs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { lintDeck } from "./deck-lint.ts";
import { PALETTES, type Palette, type Theme } from "./deck-theme.ts";
import { emitHtmlSlide, type DiagramEmbed } from "./emit-html.ts";
import { emitPptxSlide, type SlideLike } from "./emit-pptx.ts";
import { loadRegistry } from "./layout-registry.ts";
import { loadIrMeta } from "./load-ir.ts";
import { formatShapeIR, toShapeIR, type ShapeIR } from "./shape-ir.ts";
import {
  normalizeBullets,
  resolveLayout,
  SLIDE_LAYOUTS,
  type PlacedBlock,
  type Slide,
  type SlideLayout,
} from "./slide-model.ts";
import { parseSvg } from "./svg-model.ts";
import { applyViewFocus, readComponentIds, readGuidedViews } from "./view-focus.ts";
import { runArchify, VENDORED_BIN } from "./run.ts";
import { announceDeck, type OpenBus } from "./open-announce.ts";
import { generateThumbnails } from "./thumbnails.ts";
import { parseOutline } from "./outline.ts";

export type { Theme, Palette };
/** Re-exported for consumers that imported it from here before the split. */
export { PALETTES };

/**
 * One slide of a deck. `Slide` carries every layout's fields; a manifest written
 * before layouts existed uses only `ir` / `title` / `subtitle` and still works,
 * because a slide with `ir` and no `layout` IS a diagram slide (`resolveLayout`).
 */
export type DeckSlide = Slide;

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
  /**
   * Env for template search-path resolution (tests must not mutate
   * `process.env`; cf. `LoadRegistryOpts.env`).
   */
  env?: NodeJS.ProcessEnv;
  bin?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Debug hook: dump each slide's ShapeIR here (see `--emit-shape-ir`). */
  emitShapeIrDir?: string;
  /**
   * Where the rendered slide HTML lives.
   *
   * A path PERSISTS the slides there (and makes them announceable to a webui);
   * `null` keeps them in a temp dir that is deleted when the build returns —
   * the .pptx is then the only artifact.
   *
   * Persisting is the default for both entry points, and it is not merely a
   * side effect: those HTML files ARE the slides, full-fidelity and (for
   * diagrams) interactive. The .pptx is the flattened, portable view.
   */
  slidesDir?: string | null;
  /** Optional host event bus — a deck build announces `webui:deck` on it. */
  events?: OpenBus;
  /** Deck title for the announce (defaults to the output basename). */
  deckTitle?: string;
  /**
   * Render a thumbnail per slide for a webui's slide rail. Needs persisted
   * slides, costs a real page load each (~300 ms + the artifact's own weight),
   * and is best-effort — a failure just means that slide shows its title.
   */
  thumbnails?: boolean;
}

export interface BuiltSlide {
  title: string;
  subtitle?: string;
  /** The slide page: an archify artifact for `diagram`, else a composed page. */
  htmlPath: string;
  /** The code layout or the resolved template name (`*.layout.json`). */
  layout: string;
  /** Absolute IR path, when this slide has a diagram. */
  irPath?: string;
  /** The archify diagram type, or the layout name when there is no diagram. */
  diagramType: string;
  shapes: number;
  texts: number;
  /**
   * Smallest diagram-label pt on this slide, when it has one (see
   * `PlacementResult.minPt`). The export surfaces a readability advisory when
   * it drops below a configurable floor, so a diagram whose labels collapse is
   * reported at export time rather than after a screenshot.
   */
  minPt?: number;
}

export interface DeckResult {
  output: string;
  theme: Theme;
  bytes: number;
  slides: BuiltSlide[];
  /** Directory holding the rendered slide HTML, when it was persisted. */
  slidesDir?: string;
}

/** The slice of the registry manifest validation needs. */
export interface LayoutNames {
  has(name: string): boolean;
  names(): string[];
}

/** Parse + shape-check a manifest. Throws `DeckError` with a printable message. */
export function parseManifest(raw: string, source: string, registry?: LayoutNames): DeckManifest {
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
    throw new DeckError(`manifest missing non-empty \`slides\` (${source})`);
  }
  const available: readonly string[] = registry ? registry.names() : SLIDE_LAYOUTS;
  m.slides.forEach((s, i) => {
    const where = `slide ${i + 1}`;
    if (!s || typeof s !== "object") throw new DeckError(`${where}: not an object`);
    if (typeof s.title !== "string" || s.title === "") {
      throw new DeckError(`${where}: missing \`title\``);
    }
    if (s.layout !== undefined && !available.includes(s.layout)) {
      throw new DeckError(
        `${where}: unknown \`layout\` ${JSON.stringify(s.layout)} — ` +
          `expected one of ${available.join(", ")}`
      );
    }
    if (s.layout === undefined && typeof s.ir !== "string") {
      throw new DeckError(
        `${where}: needs either an \`ir\` (a diagram slide) or an explicit \`layout\` ` +
          `(one of ${available.join(", ")}).`
      );
    }
    if (s.ir !== undefined && (typeof s.ir !== "string" || s.ir === "")) {
      throw new DeckError(`${where}: \`ir\` must be a non-empty string`);
    }
    if (s.views !== undefined) {
      if (s.views !== "expand") {
        throw new DeckError(`${where}: \`views\` must be "expand" (the only mode)`);
      }
      if (typeof s.ir !== "string") {
        throw new DeckError(`${where}: \`views: "expand"\` needs an \`ir\` whose meta.views exist`);
      }
    }
    if (s.ratio !== undefined && typeof s.ratio !== "number") {
      throw new DeckError(`${where}: \`ratio\` must be a number`);
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

/**
 * Resolve every diagram block on a slide: render its IR and convert to ShapeIR.
 *
 * The artifact's filename encodes decision D4. On a `diagram` slide the artifact
 * IS `slide-N.html` — exactly what the pre-composition builder wrote and what a
 * webui already serves. On a composed slide it is `slide-N.diagram.html`, a
 * sibling the composed page iframes.
 */
async function resolveDiagrams(
  blocks: PlacedBlock[],
  index: number,
  layout: SlideLayout,
  work: string,
  theme: Theme,
  params: BuildDeckParams,
  viewFocus?: string[]
): Promise<{
  diagrams: Map<string, ShapeIR>;
  diagramSrc: Map<string, DiagramEmbed>;
  artifactPath?: string;
  diagramType?: string;
}> {
  const diagrams = new Map<string, ShapeIR>();
  const diagramSrc = new Map<string, DiagramEmbed>();
  let artifactPath: string | undefined;
  let diagramType: string | undefined;

  for (const block of blocks) {
    if (block.content.kind !== "diagram") continue;
    const irAbs = block.content.ir;
    if (!(await Bun.file(irAbs).exists())) {
      throw new DeckError(`slide ${index + 1}: IR not found: ${irAbs}`);
    }
    const file =
      layout === "diagram" ? `slide-${index + 1}.html` : `slide-${index + 1}.diagram.html`;
    const out = join(work, file);
    diagramType = await deliverSlide(irAbs, out, index, params);
    const doc = await parseSvg(await Bun.file(out).text());
    // A guided build slide dims everything outside its view's focus — in the
    // ShapeIR projection only; the on-disk artifact stays the interactive
    // full-strength page (D4).
    if (viewFocus) applyViewFocus(doc.nodes, viewFocus);
    const ir = toShapeIR(doc, theme);
    diagrams.set(irAbs, ir);
    diagramSrc.set(irAbs, {
      file,
      ...(ir.width > 0 && ir.height > 0 ? { aspect: ir.width / ir.height } : {}),
    });
    artifactPath = out;
    if (params.emitShapeIrDir) {
      await Bun.write(
        join(params.emitShapeIrDir, `slide-${index + 1}.shape-ir.txt`),
        formatShapeIR(ir)
      );
    }
  }
  return {
    diagrams,
    diagramSrc,
    ...(artifactPath ? { artifactPath } : {}),
    ...(diagramType ? { diagramType } : {}),
  };
}

/**
 * Expand `views: "expand"` slides: one overview slide (authored, untouched)
 * plus one build slide per `meta.views` entry. Expansion runs BEFORE lint so
 * the lint sees the final slide set (a view label that overflows the title
 * band should block, not slip through as an expansion artifact).
 */
export function expandViews(manifest: DeckManifest, manifestDir: string): DeckSlide[] {
  const out: DeckSlide[] = [];
  manifest.slides.forEach((s, i) => {
    if (s.views !== "expand") {
      out.push(s);
      return;
    }
    const irAbs = isAbsolute(s.ir!) ? s.ir! : resolve(manifestDir, s.ir!);
    const views = readGuidedViews(irAbs, manifestDir);
    if (views.length === 0) {
      throw new DeckError(
        `slide ${i + 1}: \`views: "expand"\` but the IR has no \`meta.views\` — author them first.`
      );
    }
    const componentIds = readComponentIds(irAbs, manifestDir);
    for (const v of views) {
      const unknown = v.focus.filter((id) => !componentIds.has(id));
      if (unknown.length > 0) {
        throw new DeckError(
          `slide ${i + 1}: guided view "${v.label}" focuses unknown node id(s) ${unknown.join(", ")} — fix meta.views.`
        );
      }
    }
    // Overview first (the full diagram), then one guided build per view.
    const overview: DeckSlide = { ...s };
    delete overview.views;
    out.push(overview);
    for (const v of views) {
      out.push({
        ...overview,
        title: v.label,
        ...(v.note !== undefined ? { takeaway: v.note } : {}),
        viewFocus: v.focus,
      });
    }
  });
  return out;
}

/** Build the deck. Every slide is laid out, emitted twice, and counted. */
export async function buildDeck(params: BuildDeckParams): Promise<DeckResult> {
  const { manifest } = params;
  const theme: Theme = params.theme ?? manifest.theme ?? "light";
  const palette = PALETTES[theme];
  const font = manifest.defaults?.font ?? "Arial";
  const tag = manifest.tag ?? "archify deck";
  const progress = params.onProgress ?? (() => {});

  // Template search path, scoped to this build — the SAME tier order that
  // `loadManifestFile` used to validate the manifest, so the names that passed
  // validation are the ones `render` dispatches on here (ticket 07).
  const registry = loadRegistry({ manifestDir: params.manifestDir, env: params.env });

  const slides = expandViews(manifest, params.manifestDir);

  // Style notes ride along in the tool result; an `error` note does not. It
  // says the deck will come out visibly broken — today only a title too wide
  // for its band, which the accent rule strikes through — and writing that file
  // anyway just moves the discovery to whoever opens it. See `deck-lint.ts`.
  const blocking = lintDeck({
    slides,
    suppressedTitle: new Set(registry.titleSuppressedLayouts()),
  }).filter((n) => n.severity === "error");
  if (blocking.length > 0) {
    throw new DeckError(
      `deck would render broken:\n` +
        blocking.map((n) => `  slide ${n.slide}: [${n.code}] ${n.message}`).join("\n")
    );
  }

  // A persisted slidesDir doubles as the webui-servable copy of the deck; a
  // temp dir means the .pptx is the only thing that survives the call.
  const persist = params.slidesDir !== null && params.slidesDir !== undefined;
  const work = persist ? params.slidesDir! : mkdtempSync(join(tmpdir(), "archify-deck-"));
  if (persist) mkdirSync(work, { recursive: true });
  try {
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: "WIDE", width: 13.333, height: 7.5 });
    pptx.layout = "WIDE";

    const total = slides.length;
    const built: BuiltSlide[] = [];

    for (let i = 0; i < total; i++) {
      if (params.signal?.aborted) throw new DeckError("aborted");
      const authored = slides[i]!;
      const layout = resolveLayout(authored);

      // Absolutize `ir` BEFORE layout so a diagram block's `ir` is the key both
      // the ShapeIR map and the iframe src agree on.
      const slide: Slide = {
        ...authored,
        ...(authored.ir
          ? { ir: isAbsolute(authored.ir) ? authored.ir : resolve(params.manifestDir, authored.ir) }
          : {}),
        ...(authored.bullets ? { bullets: normalizeBullets(authored.bullets) } : {}),
      };

      const blocks = registry.render(layout, slide, { index: i, total, tag });
      const { diagrams, diagramSrc, artifactPath, diagramType } = await resolveDiagrams(
        blocks,
        i,
        layout,
        work,
        theme,
        params,
        slide.viewFocus
      );

      const pptxSlide = pptx.addSlide() as unknown as SlideLike & {
        background?: unknown;
        addNotes?: (t: string) => unknown;
      };
      pptxSlide.background = { color: palette.slideBg };
      const placed = emitPptxSlide(pptxSlide, blocks, {
        palette,
        theme,
        font,
        diagrams,
        roleOf: registry.roleOf(layout),
      });
      if (slide.notes && typeof pptxSlide.addNotes === "function") pptxSlide.addNotes(slide.notes);

      // D4: a `diagram` slide's page IS the archify artifact, untouched.
      // Composed slides get their own page, with the artifact beside them.
      const htmlPath = join(work, `slide-${i + 1}.html`);
      if (layout !== "diagram") {
        await Bun.write(
          htmlPath,
          emitHtmlSlide(blocks, {
            palette,
            theme,
            font,
            title: slide.title,
            diagramSrc,
            roleOf: registry.roleOf(layout),
          })
        );
      } else if (!artifactPath) {
        throw new DeckError(
          `slide ${i + 1}: layout "diagram" needs an \`ir\` — add one, or pick another layout.`
        );
      }

      built.push({
        title: slide.title,
        ...(slide.subtitle !== undefined ? { subtitle: slide.subtitle } : {}),
        htmlPath,
        layout,
        ...(slide.ir ? { irPath: slide.ir } : {}),
        diagramType: diagramType ?? layout,
        shapes: placed.shapes,
        texts: placed.texts,
        ...(placed.minPt !== undefined ? { minPt: placed.minPt } : {}),
      });
      progress(
        `slide ${i + 1}/${total} (${diagramType ?? layout}) — ` +
          `${placed.shapes} shapes, ${placed.texts} text runs`
      );
    }

    const data = (await pptx.write({ outputType: "nodebuffer" })) as Uint8Array;
    await Bun.write(params.outputPath, data);

    // One manifest, two surfaces: the same ordered slide set that just became a
    // .pptx is announced to any webui as a browsable deck. Webui-optional — no
    // bus, or slides that were never persisted, makes this a silent no-op.
    if (persist) {
      // Best-effort thumbnails; `null` entries simply carry no `thumb`.
      const thumbs = params.thumbnails
        ? await generateThumbnails(built.map((b) => b.htmlPath))
        : built.map(() => null);
      announceDeck(
        params.events,
        params.outputPath,
        built.map((b, i) => ({
          path: b.htmlPath,
          title: b.title,
          ...(b.subtitle !== undefined ? { subtitle: b.subtitle } : {}),
          ...(thumbs[i] ? { thumb: thumbs[i]! } : {}),
        })),
        params.deckTitle
      );
    }

    return {
      output: params.outputPath,
      theme,
      bytes: data.length,
      slides: built,
      ...(persist ? { slidesDir: work } : {}),
    };
  } finally {
    if (!persist) rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Resolve a manifest path + its output path the way both entry points expect.
 */
export async function loadManifestFile(
  manifestPath: string,
  cwd: string,
  registry?: LayoutNames
): Promise<{ manifest: DeckManifest; manifestDir: string; manifestAbs: string }> {
  const manifestAbs = isAbsolute(manifestPath) ? manifestPath : resolve(cwd, manifestPath);
  const file = Bun.file(manifestAbs);
  if (!(await file.exists())) throw new DeckError(`manifest not found: ${manifestAbs}`);
  // No registry supplied ⇒ build one scoped to the manifest, so its
  // `<manifestDir>/templates` tier and any $ARCHIFY_TEMPLATES the caller set
  // are on the search path when `layout:` values are validated.
  const reg = registry ?? loadRegistry({ manifestDir: dirname(manifestAbs) });
  const manifest = parseManifest(await file.text(), manifestAbs, reg);
  return { manifest, manifestDir: dirname(manifestAbs), manifestAbs };
}

/**
 * The four input shapes a deck can arrive in, resolved through ONE function so
 * `archify_export_pptx` and `bun run deck` cannot drift (ticket 08, D8):
 *
 *   - `manifestPath` — a deck.config.json
 *   - `irPaths`      — one slide per IR, titles from `ir.meta.title`
 *   - `outline`      — Markdown outline text, resolved against the cwd
 *   - `outlinePath`  — an outline file, resolved against its own directory
 *
 * Exactly one shape must be present.
 */
export type DeckInputKind = "manifest" | "irPaths" | "outline";

export interface DeckInputParams {
  manifestPath?: string;
  irPaths?: string[];
  /** Outline Markdown text; `ir`/`output` paths resolve against the cwd. */
  outline?: string;
  /** Path to an outline file; `ir`/`output` paths resolve beside it. */
  outlinePath?: string;
}

const SHAPE_NAMES = ["manifestPath", "irPaths", "outline", "outlinePath"] as const;

export async function resolveDeckInput(
  params: DeckInputParams,
  cwd: string
): Promise<{ manifest: DeckManifest; manifestDir: string; inputKind: DeckInputKind }> {
  const present = [
    typeof params.manifestPath === "string" && params.manifestPath !== "",
    Array.isArray(params.irPaths) && params.irPaths.length > 0,
    typeof params.outline === "string" && params.outline !== "",
    typeof params.outlinePath === "string" && params.outlinePath !== "",
  ];
  const count = present.filter(Boolean).length;
  if (count !== 1) {
    const listed = SHAPE_NAMES.filter((_, i) => present[i]).join(", ");
    throw new DeckError(
      count === 0
        ? `Pass exactly one of ${SHAPE_NAMES.join(" / ")}.`
        : `Pass exactly one of ${SHAPE_NAMES.join(" / ")} — got ${listed}.`
    );
  }
  if (present[0]!) {
    const loaded = await loadManifestFile(params.manifestPath!, cwd);
    return { manifest: loaded.manifest, manifestDir: loaded.manifestDir, inputKind: "manifest" };
  }
  if (present[1]!) return { manifest: manifestFromIrPaths(params.irPaths!, cwd), manifestDir: cwd, inputKind: "irPaths" };
  if (present[2]!) return { manifest: parseOutline(params.outline!, cwd), manifestDir: cwd, inputKind: "outline" };
  const outlineAbs = isAbsolute(params.outlinePath!) ? params.outlinePath! : resolve(cwd, params.outlinePath!);
  const file = Bun.file(outlineAbs);
  if (!(await file.exists())) throw new DeckError(`outline not found: ${outlineAbs}`);
  return { manifest: parseOutline(await file.text(), dirname(outlineAbs)), manifestDir: dirname(outlineAbs), inputKind: "outline" };
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

/**
 * The default slide directory for an output path: `<output basename>.slides/`
 * beside the .pptx. Predictable, obviously related to the deck, and trivially
 * deletable.
 */
export function defaultSlidesDir(outputPath: string): string {
  return outputPath.replace(/\.pptx$/i, "") + ".slides";
}
