import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { isAbsolute, join } from "node:path";
import { runArchify, withTempIr } from "./run.ts";
import { resolveOutputPath } from "./output-path.ts";
import { loadIrMeta } from "./load-ir.ts";
import { announceOpen, type OpenBus } from "./open-announce.ts";

export interface RenderCtx { cwd: string; bin?: string; events?: OpenBus }

interface DeliverReceipt {
  ok?: boolean;
  error?: string;
  diagnostics?: { code?: string; message?: string }[];
  output?: string;
  artifact?: { sha256?: string; bytes?: number };
  validation?: {
    checksPassed?: number;
    checkCount?: number;
    compositionProfile?: string;
    compositionStatus?: string;
    engineeringProfile?: string;
    errors?: number;
    warnings?: number;
  };
}

/**
 * Pure entry point: resolves output, runs vendored `deliver --json` (render →
 * artifact check → atomic commit → receipt) so the produced HTML is validated,
 * not just the IR. Returns the absolute HTML path plus the deliver receipt.
 */
export async function archifyRender(params: { ir?: unknown; irPath?: string; outputPath?: string; type?: string }, ctx: RenderCtx, signal?: AbortSignal) {
  if (signal?.aborted) {
    return { content: [{ type: "text" as const, text: "Aborted before render: the AbortSignal was already aborted." }], details: { aborted: true }, isError: true };
  }
  const loaded = loadIrMeta({ ir: params.ir, irPath: params.irPath, cwd: ctx.cwd });
  if (!loaded.ok) {
    return { content: [{ type: "text" as const, text: `Error: ${loaded.error}` }], details: { error: loaded.error }, isError: true };
  }
  const type = params.type ?? loaded.meta.type;
  if (!type) {
    return { content: [{ type: "text" as const, text: "Error: diagram type could not be determined; pass `type` or set ir.diagram_type." }], details: { error: "type unknown" }, isError: true };
  }
  const irPathGiven = params.irPath ? (isAbsolute(params.irPath) ? params.irPath : join(ctx.cwd, params.irPath)) : null;
  const outPath = resolveOutputPath({ cwd: ctx.cwd, outputPath: params.outputPath, metaOutput: loaded.meta.metaOutput, diagramType: type });

  // deliver: render → check → atomic commit → JSON receipt. Never --open
  // (headless; snapshot lacks open-artifact.mjs). No --quality/--repo-root
  // (parity with the prior surface; add when needed).
  const deliver = (irPath: string) => runArchify(["deliver", type, irPath, outPath, "--json"], ctx.cwd, signal, ctx.bin);
  const { stdout, stderr, status } = irPathGiven
    ? await deliver(irPathGiven)
    : await withTempIr(params.ir ?? {}, deliver);

  let receipt: DeliverReceipt;
  try {
    receipt = JSON.parse(stdout) as DeliverReceipt;
  } catch {
    // Empty stdout means archify never produced output — the bin is missing or
    // failed to load (pre-flight sets stderr to a "vendored bin not found"
    // message). Do NOT blame IR validity in that case; lead with stderr.
    const binMissing = stdout === "";
    const detail = binMissing
      ? stderr
      : `archify deliver produced non-JSON output (exit ${status}). ${stderr || stdout}`;
    return {
      content: [{ type: "text" as const, text: `Error: ${detail}` }],
      details: { error: binMissing ? "vendored bin missing" : "deliver non-json", status },
      isError: true,
    };
  }

  if (receipt.ok !== true || status !== 0) {
    const diag = receipt.diagnostics?.length
      ? receipt.diagnostics.map((d) => `[${d.code ?? "?"}] ${d.message ?? ""}`).join("\n")
      : receipt.error ?? "";
    return {
      content: [{ type: "text" as const, text: `Error: archify render failed: ${receipt.error ?? "see diagnostics"}.\nValidate the IR first with archify_validate.\n${diag}` }],
      details: { error: "deliver failed", status, report: receipt },
      isError: true,
    };
  }

  const sha = receipt.artifact?.sha256 ?? "";
  const v = receipt.validation;
  const checks = v ? `${v.checksPassed ?? "?"}/${v.checkCount ?? "?"} checks` : "";
  const comp = v ? `; composition ${v.compositionProfile ?? "n/a"}: ${v.compositionStatus ?? "?"}` : "";
  // Success-only webui:open announce: view = output basename sans .html,
  // title = authored ir.meta.title with the diagram type as fallback.
  announceOpen(ctx.events, "render", outPath, { meta: { title: loaded.meta.title }, diagram_type: type });
  return {
    content: [{ type: "text" as const, text: `Rendered ${type} diagram → ${outPath} (${checks}${comp}; sha256 ${sha.slice(0, 12)}).` }],
    details: { path: outPath, type, artifact: receipt.artifact, validation: receipt.validation },
  };
}

/** Factory form: wires the factory-captured pi.events bus into the tool ctx. */
export function makeRenderTool(events?: OpenBus) {
  return defineTool({
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
    async execute(_id, params, signal, _onUpdate, ctx) {
      return archifyRender(params, { cwd: ctx.cwd, events }, signal);
    },
  });
}
