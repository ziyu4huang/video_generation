import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { runArchify, withTempIr } from "./run.ts";
import { loadIrMeta } from "./load-ir.ts";

export const validateParams = Type.Object({
  ir: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), { description: "The diagram IR as a JSON object. Omit if passing irPath." })),
  irPath: Type.Optional(
    Type.String({ description: "Path to an IR .json file (absolute or cwd-relative). Used if `ir` is omitted." })),
  type: Type.Optional(
    Type.String({ description: "Diagram type: architecture|workflow|sequence|dataflow|lifecycle. Inferred from ir.diagram_type if omitted." })),
});

export interface ValidateCtx { cwd: string }

/** Pure entry point reused by tests (no defineTool wrapper). */
export async function archifyValidate(params: { ir?: unknown; irPath?: string; type?: string }, ctx: ValidateCtx, signal?: AbortSignal) {
  if (signal?.aborted) return err("aborted before validate: the AbortSignal was already aborted.");
  const loaded = loadIrMeta({ ir: params.ir, irPath: params.irPath, cwd: ctx.cwd });
  if (!loaded.ok) return err(loaded.error);
  const type = params.type ?? loaded.meta.type;
  if (!type) return err("diagram type could not be determined; pass `type` or set ir.diagram_type.");
  const run = (irPath: string) => runArchify(["validate", type, irPath, "--json"], ctx.cwd, signal);
  const { stdout, stderr, status } = params.irPath
    ? await run(params.irPath)
    : await withTempIr(params.ir ?? {}, run);
  if (status !== 0) {
    const binMissing = stdout === "";
    return err(binMissing ? stderr : `archify validate failed (exit ${status}).\n${stderr || stdout}`);
  }
  let report: { ok?: boolean; error?: string; diagnostics?: unknown[]; composition?: { profile?: string; summary?: { errors?: number; warnings?: number } } };
  try {
    report = JSON.parse(stdout) as { ok?: boolean; error?: string; diagnostics?: unknown[]; composition?: { profile?: string; summary?: { errors?: number; warnings?: number } } };
  } catch {
    return err(`archify validate produced non-JSON output (exit 0).\n${stdout}`);
  }
  // archify validate --json emits { ok, error?, diagnostics?: [...] } — NOT `errors`.
  const ok = report.ok === true;
  const composition = report.composition;
  const warnings = composition?.summary?.warnings ?? 0;
  const errors = composition?.summary?.errors ?? 0;
  const compositionLine = composition
    ? ` composition ${composition.profile ?? "n/a"}: ${errors} error(s), ${warnings} warning(s).`
    : "";
  return {
    content: [{ type: "text" as const, text: ok ? `IR is valid (${type}).${compositionLine}` : `IR has ${report.diagnostics?.length ?? 1} issue(s):\n${report.error ?? stdout}` }],
    details: { type, valid: ok, report },
    ...(ok ? {} : { isError: true }),
  };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], details: { error: message }, isError: true };
}

export const validateTool = defineTool({
  name: "archify_validate",
  label: "Archify Validate",
  description:
    "Validate a typed-JSON-IR diagram against its schema BEFORE rendering. Pass `ir` (the JSON object) or `irPath`. " +
    "Returns validation diagnostics. Always validate before archify_render; never deliver unvalidated IR.",
  parameters: validateParams,
  async execute(_id, params, signal, _onUpdate, ctx) {
    return archifyValidate(params, { cwd: ctx.cwd }, signal);
  },
});
