import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

export interface ResolveOutputPathOpts {
  cwd: string;
  outputPath?: string;
  metaOutput?: string;
  diagramType: string;
}

/** Resolve the destination HTML path: outputPath param → IR meta.output → <type>.html (collision-safe). */
export function resolveOutputPath(opts: ResolveOutputPathOpts): string {
  const { cwd, diagramType } = opts;
  const named = opts.outputPath ?? opts.metaOutput;
  if (named) return isAbsolute(named) ? named : join(cwd, named);
  const exists = existsSync;
  const base = join(cwd, `${diagramType}.html`);
  if (!exists(base)) return base;
  const suffix = createHash("sha256").update(`${Date.now()}`).digest("hex").slice(0, 6);
  return join(cwd, `${diagramType}-${suffix}.html`);
}
