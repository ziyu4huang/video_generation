import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { isAbsolute, join } from "node:path";
import { runArchify, withTempIr } from "./run.ts";
import { resolveOutputPath } from "./output-path.ts";

export interface RenderCtx { cwd: string }

/** Pure entry point: resolves output, runs vendored `render`, returns the absolute HTML path. */
export async function archifyRender(params: { ir?: unknown; irPath?: string; outputPath?: string }, ctx: RenderCtx) {
  const irPathGiven = params.irPath ? (isAbsolute(params.irPath) ? params.irPath : join(ctx.cwd, params.irPath)) : null;
  const irMetaOutput = (params.ir as { meta?: { output?: string } } | undefined)?.meta?.output;
  const type = (params.ir as { diagram_type?: string } | undefined)?.diagram_type ?? "architecture";
  const outPath = resolveOutputPath({ cwd: ctx.cwd, outputPath: params.outputPath, metaOutput: irMetaOutput, diagramType: type });

  const status = irPathGiven
    ? runArchify(["render", type, irPathGiven, outPath], ctx.cwd).status
    : withTempIr(params.ir ?? {}, (irPath) => runArchify(["render", type, irPath, outPath], ctx.cwd).status);

  if (status !== 0) {
    return { content: [{ type: "text" as const, text: `Error: archify render failed (exit ${status}). Validate the IR first with archify_validate.` }], details: { error: "render failed", status }, isError: true };
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
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    return archifyRender(params, { cwd: ctx.cwd });
  },
});
