import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { isAbsolute, join } from "node:path";
import { readFileSync } from "node:fs";
import { runArchify, withTempIr } from "./run.ts";
import { resolveOutputPath } from "./output-path.ts";

export interface RenderCtx { cwd: string }

function readDiagramType(irPath: string): string | undefined {
  try { return (JSON.parse(readFileSync(irPath, "utf8")) as { diagram_type?: string }).diagram_type; }
  catch { return undefined; }
}

/** Pure entry point: resolves output, runs vendored `render`, returns the absolute HTML path. */
export async function archifyRender(params: { ir?: unknown; irPath?: string; outputPath?: string; type?: string }, ctx: RenderCtx) {
  const irPathGiven = params.irPath ? (isAbsolute(params.irPath) ? params.irPath : join(ctx.cwd, params.irPath)) : null;
  const irMetaOutput = (params.ir as { meta?: { output?: string } } | undefined)?.meta?.output;
  const type = params.type
    ?? (params.ir as { diagram_type?: string } | undefined)?.diagram_type
    ?? (irPathGiven ? readDiagramType(irPathGiven) : undefined);
  if (!type) {
    return { content: [{ type: "text" as const, text: "Error: diagram type could not be determined; pass `type` or set ir.diagram_type." }], details: { error: "type unknown" }, isError: true };
  }
  const outPath = resolveOutputPath({ cwd: ctx.cwd, outputPath: params.outputPath, metaOutput: irMetaOutput, diagramType: type });

  const result = irPathGiven
    ? runArchify(["render", type, irPathGiven, outPath], ctx.cwd)
    : withTempIr(params.ir ?? {}, (irPath) => runArchify(["render", type, irPath, outPath], ctx.cwd));

  if (result.status !== 0) {
    return { content: [{ type: "text" as const, text: `Error: archify render failed (exit ${result.status}). Validate the IR first with archify_validate.\n${result.stderr || result.stdout}` }], details: { error: "render failed", status: result.status }, isError: true };
  }
  return {
    content: [{ type: "text" as const, text: `Rendered ${type} diagram → ${outPath}` }],
    details: { path: outPath, type },
  };
}

export const renderTool = defineTool({
  name: "archify_render",
  label: "Archify Render",
  description:
    "Render a typed-JSON-IR diagram to a self-contained HTML file (inline SVG, theme toggle, export menu). " +
    "Pass `ir` (JSON object) or `irPath`. Optional `outputPath` (absolute or cwd-relative); default honors ir.meta.output else <cwd>/<type>.html. " +
    "Validate first with archify_validate. Returns the absolute output path.",
  parameters: Type.Object({
    ir: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Diagram IR as a JSON object." })),
    irPath: Type.Optional(Type.String({ description: "Path to an IR .json file (absolute or cwd-relative)." })),
    outputPath: Type.Optional(Type.String({ description: "Output HTML path (absolute or cwd-relative). Default: ir.meta.output else <cwd>/<type>.html." })),
    type: Type.Optional(Type.String({ description: "Diagram type: architecture|workflow|sequence|dataflow|lifecycle. Inferred from ir.diagram_type (or the irPath file) if omitted." })),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    return archifyRender(params, { cwd: ctx.cwd });
  },
});
