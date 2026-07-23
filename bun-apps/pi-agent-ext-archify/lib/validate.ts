import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { runArchify, withTempIr } from "./run.ts";

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
export async function archifyValidate(params: { ir?: unknown; irPath?: string; type?: string }, ctx: ValidateCtx) {
  const type = params.type ?? (params.ir as { diagram_type?: string } | undefined)?.diagram_type;
  if (!type) return err("diagram type could not be determined; pass `type` or set ir.diagram_type.");
  const run = (irPath: string) => runArchify(["validate", type, irPath, "--json"], ctx.cwd);
  const { stdout, status } = params.irPath
    ? run(params.irPath)
    : withTempIr(params.ir ?? {}, run);
  if (status !== 0) return err(`archify validate failed (exit ${status}).\n${stdout}`);
  // archify validate --json emits { ok, error?, diagnostics?: [...] } — NOT `errors`.
  const report = JSON.parse(stdout) as { ok?: boolean; error?: string; diagnostics?: unknown[] };
  const ok = report.ok === true;
  return {
    content: [{ type: "text" as const, text: ok ? `IR is valid (${type}).` : `IR has ${report.diagnostics?.length ?? 1} issue(s):\n${report.error ?? stdout}` }],
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
  async execute(_id, params, _signal, _onUpdate, ctx) {
    return archifyValidate(params, { cwd: ctx.cwd });
  },
});
