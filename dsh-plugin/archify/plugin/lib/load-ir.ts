import { isAbsolute, join } from "node:path";
import { readFileSync } from "node:fs";

export interface IrMeta {
  /** Diagram type (`diagram_type`). Undefined when not present anywhere. */
  type?: string;
  /** Authored output filename (`meta.output`), honored by render. */
  metaOutput?: string;
}

export type LoadIrResult = { ok: true; meta: IrMeta } | { ok: false; error: string };

function metaOf(ir: unknown): IrMeta {
  const obj = (ir ?? {}) as { diagram_type?: string; meta?: { output?: string } };
  const metaOutput =
    typeof obj.meta?.output === "string" && obj.meta.output ? obj.meta.output : undefined;
  return { type: obj.diagram_type, metaOutput };
}

/**
 * Extract diagram metadata (type + authored output) from an inline IR object or
 * an IR file. File errors are reported honestly (path + reason) rather than
 * collapsing into a misleading "type unknown". Does NOT create temp files —
 * callers that need a CLI-readable path for inline IR still use `withTempIr`.
 */
export function loadIrMeta(params: { ir?: unknown; irPath?: string; cwd: string }): LoadIrResult {
  if (params.irPath) {
    const abs = isAbsolute(params.irPath) ? params.irPath : join(params.cwd, params.irPath);
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Could not read IR file "${params.irPath}": ${reason}` };
    }
    let ir: unknown;
    try {
      ir = JSON.parse(text);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `IR file "${params.irPath}" is not valid JSON: ${reason}` };
    }
    return { ok: true, meta: metaOf(ir) };
  }
  return { ok: true, meta: metaOf(params.ir) };
}
