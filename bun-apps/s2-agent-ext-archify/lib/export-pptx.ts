/**
 * export-pptx.ts — the `archify_export_pptx` tool.
 *
 * Agent-facing face of lib/deck-build.ts. Two input shapes:
 *
 *   - `manifestPath` — a deck.config.json (the portable, reviewable form)
 *   - `irPaths`      — one slide per IR, titles taken from `ir.meta.title`
 *                      (the "just turn these into a deck" form)
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
  loadManifestFile,
  manifestFromIrPaths,
  resolveDeckOutput,
  type DeckManifest,
  type Theme,
} from "./deck-build.ts";
import { lintDeck, storyline } from "./deck-lint.ts";
import type { OpenBus } from "./open-announce.ts";

export interface ExportPptxParams {
  manifestPath?: string;
  irPaths?: string[];
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

  const hasManifest = typeof params.manifestPath === "string" && params.manifestPath !== "";
  const hasIrs = Array.isArray(params.irPaths) && params.irPaths.length > 0;
  if (hasManifest === hasIrs) {
    return err("Pass exactly one of `manifestPath` or a non-empty `irPaths`.");
  }

  try {
    let manifest: DeckManifest;
    let manifestDir: string;
    if (hasManifest) {
      const loaded = await loadManifestFile(params.manifestPath!, ctx.cwd);
      manifest = loaded.manifest;
      manifestDir = loaded.manifestDir;
    } else {
      manifest = manifestFromIrPaths(params.irPaths!, ctx.cwd);
      manifestDir = ctx.cwd;
    }

    // `irPaths` has no manifest to carry an output, so default beside the cwd.
    const outputPath = params.outputPath
      ? isAbsolute(params.outputPath)
        ? params.outputPath
        : resolve(ctx.cwd, params.outputPath)
      : hasManifest
        ? resolveDeckOutput(manifest, manifestDir, ctx.cwd)
        : resolve(ctx.cwd, "deck.pptx");

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
    const notes = lintDeck(manifest);
    return {
      content: [
        {
          type: "text",
          text:
            `Exported ${result.slides.length} slides → ${result.output} ` +
            `(${(result.bytes / 1024).toFixed(0)} KB, ${shapes} native shapes, theme=${result.theme}). ` +
            `Shapes are editable in PowerPoint; nothing was rasterized.` +
            (result.slidesDir ? ` Interactive slides: ${result.slidesDir}` : "") +
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
        })),
        storyline: storyline(manifest),
        ...(notes.length > 0 ? { lint: notes } : {}),
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
      "Pass either `manifestPath` (a deck.config.json) or `irPaths` (one slide per IR). " +
      "A manifest slide may set `layout` (title|section|bullets|split|diagram|statement) with " +
      "`bullets`/`takeaway`/`source`/`statement`; a slide with `ir` and no `layout` is a diagram slide. " +
      "Optional `outputPath`, `theme` (light|dark) and `slidesDir`. " +
      "One deliverable = one folder: keep manifest, IRs, .pptx and .slides/ together; an output outside the manifest folder earns an advisory. " +
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
            "IR .json paths, one slide each, in order. Titles come from ir.meta.title. Mutually exclusive with manifestPath.",
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
