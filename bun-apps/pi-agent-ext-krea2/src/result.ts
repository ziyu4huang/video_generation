/**
 * result.ts — turn a krea2 run into structured, agent-consumable `details`.
 *
 * krea2 is much simpler than flux2: no `.manifest.json` sidecar, no `gate`
 * subcommand. The single reliable output contract is the line
 *     [krea2] saved <abspath>
 * printed on success by T2ICommand.swift / I2ICommand.swift. We parse the LAST
 * such line for `details.output` (the chaining handle) and lift the requested
 * dims/seed from the input options (krea2 itself echoes `native WxH … seed=S`
 * but those are progress lines, not a structured contract).
 */
import { existsSync, statSync } from "node:fs";
import type { InvokeResult } from "./invoke.ts";

export interface OutputFile {
  path: string;
  seed: number | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
}

export interface Krea2Details {
  ok: boolean;
  command: string;
  exitCode: number;
  aborted: boolean;
  /** Primary output path (first-class, for chaining). null on failure / non-image commands. */
  output: string | null;
  outputs: OutputFile[];
  seed: number | null;
  width: number | null;
  height: number | null;
  /** Raw stdout for the run (text commands / error context). */
  stdout?: string;
}

/**
 * Parse the LAST `[krea2] saved <path>` line from stdout. Returns null if none.
 * The path is whatever krea2 printed (absolute — krea2 resolves via Paths.swift).
 */
export function parseSavedPath(stdout: string): string | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const m = line.match(/\[krea2\]\s+saved\s+(\S+)/);
    if (m && m[1]) return m[1];
  }
  return null;
}

/**
 * Build details for an image-producing command (t2i/i2i). `opts.seed/width/height`
 * are the agent-requested values (used to populate details even when krea2 prints
 * no structured sidecar); they are informational, not re-derived from the run.
 */
export function buildImageDetails(
  command: string,
  res: InvokeResult,
  opts: { seed?: number; width?: number; height?: number } = {},
): Krea2Details {
  const ok = res.exitCode === 0 && !res.aborted;
  const primary = ok ? parseSavedPath(res.stdout) : null;

  const seed = opts.seed ?? null;
  const width = opts.width ?? null;
  const height = opts.height ?? null;

  const outputs: OutputFile[] = primary
    ? [
        {
          path: primary,
          seed,
          width,
          height,
          sizeBytes: existsSync(primary) ? statSync(primary).size : null,
        },
      ]
    : [];

  return {
    ok,
    command,
    exitCode: res.exitCode,
    aborted: res.aborted,
    output: primary,
    outputs,
    seed,
    width,
    height,
    stdout: res.stdout,
  };
}

/** One-line human summary for the text content field. */
export function summarize(d: Krea2Details): string {
  if (d.aborted) return `${d.command} aborted (exit ${d.exitCode}).`;
  if (!d.ok) {
    const tail = (d.stdout ?? "").trim().split("\n").slice(-6).join("\n");
    return `${d.command} FAILED (exit ${d.exitCode}).\n${tail}`;
  }
  const dims = d.width && d.height ? `${d.width}×${d.height}` : "";
  const seedStr = d.seed != null ? ` seed ${d.seed}` : "";
  return `${d.command} ok → ${d.output ?? "(no output)"}  ${dims}${seedStr}`.replace(/  +/g, "  ").trim();
}

/** Summarize a non-ok run's stderr tail for the error-content fallback. */
export function stderrTail(res: InvokeResult, n = 12): string {
  const src = (res.stderr || res.output || "").trim();
  return src.split("\n").slice(-n).join("\n");
}
