import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { isAbsolute, join } from "node:path";
import { runArchify } from "./run.ts";
import { resolveOutputPath } from "./output-path.ts";

export interface DeltaCtx { cwd: string }

/** archify `compare` is architecture-only (bin/archify.mjs rejects type !== 'architecture'). */
export async function archifyDelta(params: { basePath: string; headPath: string; outputPath?: string; type?: string }, ctx: DeltaCtx) {
  const type = params.type ?? "architecture";
  if (type !== "architecture") {
    return { content: [{ type: "text" as const, text: "Error: archify_delta is architecture-only (archify compare requires type 'architecture')." }], details: { error: "non-architecture delta unsupported", type }, isError: true };
  }
  const base = isAbsolute(params.basePath) ? params.basePath : join(ctx.cwd, params.basePath);
  const head = isAbsolute(params.headPath) ? params.headPath : join(ctx.cwd, params.headPath);
  const outPath = resolveOutputPath({ cwd: ctx.cwd, outputPath: params.outputPath, diagramType: "architecture-delta" });
  const { status } = runArchify(["compare", "architecture", base, head, outPath], ctx.cwd);
  if (status !== 0) {
    return { content: [{ type: "text" as const, text: `Error: archify compare failed (exit ${status}). Ensure both IRs are valid architecture diagrams.` }], details: { error: "compare failed", status }, isError: true };
  }
  return { content: [{ type: "text" as const, text: `Rendered architecture delta → ${outPath}` }], details: { path: outPath, type: "architecture-delta" } };
}

export const deltaTool = defineTool({
  name: "archify_delta",
  label: "Archify Delta",
  description:
    "Compare two architecture IR snapshots and render a before/delta/after HTML (merge-review). " +
    "Architecture-only. Pass `basePath` + `headPath` (absolute or cwd-relative). Optional `outputPath`. Returns the absolute output path.",
  parameters: Type.Object({
    basePath: Type.String({ description: "Base (before) architecture IR .json path." }),
    headPath: Type.String({ description: "Head (after) architecture IR .json path." }),
    outputPath: Type.Optional(Type.String({ description: "Output HTML path. Default: <cwd>/architecture-delta.html." })),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    return archifyDelta(params, { cwd: ctx.cwd });
  },
});
