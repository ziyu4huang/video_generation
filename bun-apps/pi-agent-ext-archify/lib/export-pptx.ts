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
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { isAbsolute, resolve } from "node:path";
import {
  buildDeck,
  DeckError,
  loadManifestFile,
  manifestFromIrPaths,
  resolveDeckOutput,
  type DeckManifest,
  type Theme,
} from "./deck-build.ts";
import type { OpenBus } from "./open-announce.ts";

export interface ExportPptxParams {
  manifestPath?: string;
  irPaths?: string[];
  outputPath?: string;
  theme?: string;
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

    const result = await buildDeck({
      manifest,
      manifestDir,
      outputPath,
      cwd: ctx.cwd,
      ...(theme ? { theme } : {}),
      ...(ctx.bin ? { bin: ctx.bin } : {}),
      ...(signal ? { signal } : {}),
    });

    const shapes = result.slides.reduce((a, s) => a + s.shapes + s.texts, 0);
    return {
      content: [
        {
          type: "text",
          text:
            `Exported ${result.slides.length} slides → ${result.output} ` +
            `(${(result.bytes / 1024).toFixed(0)} KB, ${shapes} native shapes, theme=${result.theme}). ` +
            `Shapes are editable in PowerPoint; nothing was rasterized.`,
        },
      ],
      details: {
        path: result.output,
        theme: result.theme,
        bytes: result.bytes,
        slides: result.slides.map((s) => ({
          title: s.title,
          diagramType: s.diagramType,
          shapes: s.shapes,
          texts: s.texts,
        })),
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
      "Optional `outputPath` and `theme` (light|dark). Returns the absolute .pptx path.",
    parameters: Type.Object({
      manifestPath: Type.Optional(
        Type.String({
          description:
            "Path to a deck manifest JSON (absolute or cwd-relative): {output?, theme?, tag?, defaults?{font}, slides:[{ir,title,subtitle?}]}.",
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
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return archifyExportPptx(params as ExportPptxParams, { cwd: ctx.cwd, events }, signal);
    },
  });
}
