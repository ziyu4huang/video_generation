import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { isAbsolute, join, extname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { runArchify } from "./run.ts";
import { resolveOutputPath } from "./output-path.ts";
import { announceOpen, type OpenBus } from "./open-announce.ts";

export interface DeltaCtx { cwd: string; bin?: string; events?: OpenBus }

/** archify `compare` always writes a sidecar `<output>.receipt.json` beside the HTML. */
function receiptPathFor(htmlPath: string): string {
  const ext = extname(htmlPath);
  return ext ? `${htmlPath.slice(0, -ext.length)}.receipt.json` : `${htmlPath}.receipt.json`;
}

/** archify `compare` is architecture-only (bin/archify.mjs rejects type !== 'architecture'). */
export async function archifyDelta(params: { basePath: string; headPath: string; outputPath?: string; type?: string }, ctx: DeltaCtx, signal?: AbortSignal) {
  if (signal?.aborted) {
    return { content: [{ type: "text" as const, text: "Aborted before delta: the AbortSignal was already aborted." }], details: { aborted: true }, isError: true };
  }
  const type = params.type ?? "architecture";
  if (type !== "architecture") {
    return { content: [{ type: "text" as const, text: "Error: archify_delta is architecture-only (archify compare requires type 'architecture')." }], details: { error: "non-architecture delta unsupported", type }, isError: true };
  }
  const base = isAbsolute(params.basePath) ? params.basePath : join(ctx.cwd, params.basePath);
  const head = isAbsolute(params.headPath) ? params.headPath : join(ctx.cwd, params.headPath);
  const outPath = resolveOutputPath({ cwd: ctx.cwd, outputPath: params.outputPath, diagramType: "architecture-delta" });
  const { status, stderr, stdout } = await runArchify(["compare", "architecture", base, head, outPath], ctx.cwd, signal, ctx.bin);
  if (status !== 0) {
    const binMissing = stdout === "";
    const detail = binMissing
      ? stderr
      : `archify compare failed (exit ${status}). ${stderr || stdout}`;
    return {
      content: [{ type: "text" as const, text: `Error: ${detail}` }],
      details: { error: binMissing ? "vendored bin missing" : "compare failed", status },
      isError: true,
    };
  }
  // compare writes a provenance receipt beside the HTML; surface it explicitly.
  const receiptPath = receiptPathFor(outPath);
  let summary = "";
  if (existsSync(receiptPath)) {
    try {
      const r = JSON.parse(readFileSync(receiptPath, "utf8")) as { completeness?: string; proofLevel?: string; validation?: { checksPassed?: number; checkCount?: number } };
      const v = r.validation;
      summary = `\nReceipt → ${receiptPath} (${v ? `${v.checksPassed}/${v.checkCount} checks; ` : ""}completeness ${r.completeness ?? "?"}; ${r.proofLevel ?? "?"}).`;
    } catch {
      summary = `\nReceipt → ${receiptPath}.`;
    }
  }
  // Success-only webui:open announce: compare-<basename sans .html> view,
  // title = the delta diagramType const (compare has no ir.meta).
  announceOpen(ctx.events, "delta", outPath, { diagram_type: "architecture-delta" });
  return { content: [{ type: "text" as const, text: `Rendered architecture delta → ${outPath}${summary}` }], details: { path: outPath, receipt: receiptPath, type: "architecture-delta" } };
}

/** Factory form: wires the factory-captured pi.events bus into the tool ctx. */
export function makeDeltaTool(events?: OpenBus) {
  return defineTool({
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
    async execute(_id, params, signal, _onUpdate, ctx) {
      return archifyDelta(params, { cwd: ctx.cwd, events }, signal);
    },
  });
}
