/**
 * export-pptx.ts — the `archify_export_pptx` tool.
 *
 * Agent-facing face of lib/deck-build.ts. Four input shapes, resolved through
 * the ONE `resolveDeckInput()` so they cannot drift:
 *
 *   - `manifestPath` — a deck.config.json (the portable, reviewable form)
 *   - `irPaths`      — one slide per IR, titles taken from `ir.meta.title`
 *                      (the "just turn these into a deck" form)
 *   - `outline`      — Markdown outline text (the prose-first authoring door;
 *                      six code layouts as markers, templates via fenced JSON)
 *   - `outlinePath`  — same dialect, read from a file
 *
 * Slides carry NATIVE PowerPoint shapes, not screenshots — no browser is
 * launched and nothing is rasterized.
 *
 * The rendered interactive slide HTML is kept beside the .pptx (see
 * `defaultSlidesDir`) and announced as `webui:deck`, so ONE manifest feeds both
 * the exported deck and a webui Diagram pane. `slidesDir: null` opts out of
 * both. Webui-optional as always: no bus, no effect.
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { isAbsolute, resolve, dirname } from "node:path";
import {
  buildDeck,
  DeckError,
  defaultSlidesDir,
  resolveDeckInput,
  resolveDeckOutput,
  type DeckManifest,
  type Theme,
} from "./deck-build.ts";
import { lintDeck, storyline } from "./deck-lint.ts";
import { loadRegistry } from "./layout-registry.ts";
import type { OpenBus } from "./open-announce.ts";

export interface ExportPptxParams {
  manifestPath?: string;
  irPaths?: string[];
  /** Outline Markdown text (see lib/outline.ts for the marker dialect). */
  outline?: string;
  /** Path to an outline file; paths inside resolve beside it. */
  outlinePath?: string;
  outputPath?: string;
  theme?: string;
  /** Where the rendered slide HTML goes; `null` keeps only the .pptx. */
  slidesDir?: string | null;
  /** Render a thumbnail per slide for a webui slide rail (costs a page load each). */
  thumbnails?: boolean;
}

export interface ExportPptxCtx {
  cwd: string;
  bin?: string;
  events?: OpenBus;
}

interface ToolResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
  isError?: boolean;
}

function err(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text }], details: { error: text, ...details }, isError: true };
}

/**
 * Below this pt, a diagram label on a 16:9 slide is hard to read in a meeting.
 * Exported so the advisory is configurable/testable without a renderer.
 */
export const READABILITY_FLOOR_PT = 8;

export interface ReadabilityNote {
  /** 1-based slide index. */
  slide: number;
  /** Smallest diagram-label pt actually placed on that slide. */
  minPt: number;
  /** The floor it dropped below. */
  floor: number;
}

/**
 * Which slides put a diagram label below the readability floor?
 *
 * `sizePt = fontSize * scale * 72`, and `scale` shrinks with the viewBox. A
 * wide IR in a fixed slide box silently collapses its labels (the v3/v4 4pt
 * defect); this surfaces it at export time instead of after a screenshot.
 * Pure and renderless: only reads what the build already measured.
 */
export function readabilityNotes(
  slides: { minPt?: number }[],
  floor: number = READABILITY_FLOOR_PT
): ReadabilityNote[] {
  const notes: ReadabilityNote[] = [];
  slides.forEach((s, i) => {
    if (s.minPt !== undefined && s.minPt < floor) {
      notes.push({ slide: i + 1, minPt: s.minPt, floor });
    }
  });
  return notes;
}

/** Pure entry point (tested directly; the tool wrapper only adapts the SDK shape). */
export async function archifyExportPptx(
  params: ExportPptxParams,
  ctx: ExportPptxCtx,
  signal?: AbortSignal
): Promise<ToolResult> {
  if (signal?.aborted) {
    return err("Aborted before export: the AbortSignal was already aborted.", { aborted: true });
  }
  if (params.theme !== undefined && params.theme !== "light" && params.theme !== "dark") {
    return err(`theme must be light|dark, got ${JSON.stringify(params.theme)}`);
  }
  const theme = params.theme as Theme | undefined;

  try {
    const input = await resolveDeckInput(params, ctx.cwd);
    const manifest: DeckManifest = input.manifest;
    const manifestDir: string = input.manifestDir;
    const hasManifest = input.inputKind === "manifest";

    // `irPaths`/`outline` have no manifest to carry an output; default beside
    // the resolved base dir so the one-folder advisory stays quiet by default.
    const outputPath = params.outputPath
      ? isAbsolute(params.outputPath)
        ? params.outputPath
        : resolve(ctx.cwd, params.outputPath)
      : hasManifest
        ? resolveDeckOutput(manifest, manifestDir, ctx.cwd)
        : resolve(manifestDir, "deck.pptx");

    // Output-layout contract (map D9): one deliverable = one folder. The tools
    // already default beside the manifest; this catches an authored outputPath
    // that would scatter the .pptx/.slides away from it. Advisory only.
    const spread =
      hasManifest && dirname(resolve(outputPath)) !== resolve(manifestDir)
        ? { outputPath, manifestDir }
        : undefined;

    const result = await buildDeck({
      manifest,
      manifestDir,
      outputPath,
      cwd: ctx.cwd,
      ...(theme ? { theme } : {}),
      ...(ctx.bin ? { bin: ctx.bin } : {}),
      ...(signal ? { signal } : {}),
      ...(ctx.events ? { events: ctx.events } : {}),
      // Keep the rendered slides by default so the same manifest also feeds a
      // webui Diagram pane (announced as `webui:deck`; a no-op without webui).
      slidesDir:
        params.slidesDir === null
          ? null
          : params.slidesDir
            ? (isAbsolute(params.slidesDir) ? params.slidesDir : resolve(ctx.cwd, params.slidesDir))
            : defaultSlidesDir(outputPath),
      ...(params.thumbnails ? { thumbnails: true } : {}),
    });

    const shapes = result.slides.reduce((a, s) => a + s.shapes + s.texts, 0);
    // Advisory only — content notes never fail an export. They ride along in
    // `details` so the agent sees them without a second tool call, alongside the
    // storyline: the titles read in order ARE the deck's argument.
    const notes = lintDeck({
      slides: manifest.slides,
      suppressedTitle: new Set(loadRegistry({ manifestDir }).titleSuppressedLayouts()),
    });
    // Readability advisory (this session's learning): a diagram whose smallest
    // label scales below the floor is silently unreadable. Surfaced at export
    // so the agent tightens the viewBox before the deck ships, not after a
    // screenshot. Advisory only — it never fails the export.
    const small = readabilityNotes(result.slides);
    const readability =
      small.length > 0
        ? ` NOTE: ${small.length} diagram slide(s) put a label below ${READABILITY_FLOOR_PT}pt ` +
          `(${small
            .map((n) => `slide ${n.slide} @ ${n.minPt.toFixed(1)}pt`)
            .join(", ")}) — tighten the viewBox or enlarge the diagram box before shipping.`
        : "";
    return {
      content: [
        {
          type: "text",
          text:
            `Exported ${result.slides.length} slides → ${result.output} ` +
            `(${(result.bytes / 1024).toFixed(0)} KB, ${shapes} native shapes, theme=${result.theme}). ` +
            `Shapes are editable in PowerPoint; nothing was rasterized.` +
            (result.slidesDir ? ` Interactive slides: ${result.slidesDir}` : "") +
            readability +
            (spread
              ? ` NOTE: the .pptx landed outside the manifest folder (${manifestDir}) — keep one deliverable in one folder: put the .pptx (and its .slides/) beside deck.config.json.`
              : ""),
        },
      ],
      details: {
        path: result.output,
        ...(result.slidesDir ? { slidesDir: result.slidesDir } : {}),
        ...(spread ? { spread } : {}),
        theme: result.theme,
        bytes: result.bytes,
        slides: result.slides.map((s) => ({
          title: s.title,
          layout: s.layout,
          diagramType: s.diagramType,
          shapes: s.shapes,
          texts: s.texts,
          ...(s.minPt !== undefined ? { minPt: s.minPt } : {}),
        })),
        storyline: storyline(manifest),
        ...(notes.length > 0 ? { lint: notes } : {}),
        ...(small.length > 0 ? { readability: small } : {}),
      },
    };
  } catch (e) {
    if (e instanceof DeckError) return err(`Error: ${e.message}`);
    return err(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Factory form, mirroring makeRenderTool/makeDeltaTool. */
export function makeExportPptxTool(events?: OpenBus) {
  return defineTool({
    name: "archify_export_pptx",
    label: "Archify Export PPTX",
    description:
      "Export archify diagrams to a 16:9 .pptx as NATIVE, EDITABLE PowerPoint shapes (no screenshots). " +
      "Pass exactly one input shape: `manifestPath` (a deck.config.json), `irPaths` (one slide per IR), " +
      "`outline` (Markdown outline text) or `outlinePath` (an outline file). The outline dialect covers the " +
      "six code layouts with markers (# cover, ## NN section, ### action title, ^ takeaway, ~ source, - bullets, " +
      "!ir diagram); every layout template goes through a fenced :::name JSON payload. Call archify_deck_lint " +
      "with no arguments first to list available layouts and deck skeletons. " +
      "A manifest slide may set `layout` with `bullets`/`takeaway`/`source`/`statement`; a slide with `ir` and no " +
      "`layout` is a diagram slide. Optional `outputPath`, `theme` (light|dark) and `slidesDir`. " +
      "One deliverable = one folder: keep manifest/outline, IRs, .pptx and .slides/ together; an output outside " +
      "the manifest folder earns an advisory. " +
      "Also keeps the interactive slide HTML in <output>.slides/ and announces it to a webui Diagram pane. " +
      "Returns the absolute .pptx path.",
    parameters: Type.Object({
      manifestPath: Type.Optional(
        Type.String({
          description:
            "Path to a deck manifest JSON (absolute or cwd-relative): {output?, theme?, tag?, defaults?{font}, slides:[{title, layout?, ir?, bullets?, takeaway?, source?, statement?, subtitle?}]}.",
        })
      ),
      irPaths: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "IR .json paths, one slide each, in order. Titles come from ir.meta.title.",
        })
      ),
      outline: Type.Optional(
        Type.String({
          description:
            "Deck as Markdown outline TEXT: YAML frontmatter (output/theme/tag/defaults.font) + body markers " +
            "(# cover + > subtitle; ## NN section; ### action title; ^ takeaway; ~ source; '- ' / two-space '- ' bullets; " +
            "!ir <path>; fenced ```:::<template> JSON payload for layout templates). Mutually exclusive with the other shapes.",
        })
      ),
      outlinePath: Type.Optional(
        Type.String({
          description:
            "Path to an outline file (same dialect as `outline`). Paths inside resolve against the file's own directory.",
        })
      ),
      outputPath: Type.Optional(
        Type.String({
          description:
            "Output .pptx path (absolute or cwd-relative). Defaults to the manifest's `output`, else <cwd>/deck.pptx.",
        })
      ),
      theme: Type.Optional(
        Type.String({ description: "light | dark. Overrides the manifest's theme." })
      ),
      thumbnails: Type.Optional(
        Type.Boolean({
          description:
            "Render a thumbnail per slide for a webui slide rail. Costs a page load per slide; off by default.",
        })
      ),
      slidesDir: Type.Optional(
        Type.String({
          description:
            "Where to keep the rendered interactive slide HTML. Default: <output>.slides/ beside the .pptx (also what a webui Diagram pane serves).",
        })
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return archifyExportPptx(params as ExportPptxParams, { cwd: ctx.cwd, events }, signal);
    },
  });
}
