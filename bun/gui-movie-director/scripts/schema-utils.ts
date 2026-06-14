import { RUN_PY } from "../lib/paths";
import { resolvePythonBin } from "../lib/pythonBin";

// ── run.py schema types (mirror of app/commands/schema.py output) ────────────

export interface RunArg {
  flags: string[];
  dest: string;
  type?: string;
  default?: unknown;
  choices?: string[];
  action: string;
  nargs?: number | string;
  required: boolean;
  help?: string;
}

export interface RunCommand {
  args: RunArg[];
  positionals: RunArg[];
}

export interface RunSchema {
  commands: Record<string, RunCommand>;
}

// ── run.py introspection ─────────────────────────────────────────────────────

/**
 * Fetch the run.py CLI schema by running `run.py schema --compact` (argparse
 * introspection, parse-only, no model loading, no GPU — safe to run anytime).
 */
export function fetchRunSchema(): RunSchema {
  const pythonBin = resolvePythonBin();
  const proc = Bun.spawnSync(
    [pythonBin, RUN_PY, "schema", "--compact"],
    { stdout: "pipe", stderr: "pipe", timeout: 15_000 },
  );
  const stdout = new TextDecoder().decode(proc.stdout).trim();
  const stderr = new TextDecoder().decode(proc.stderr).trim();
  if (!stdout) {
    throw new Error(`run.py schema produced no output${stderr ? `: ${stderr}` : ""}`);
  }
  return JSON.parse(stdout) as RunSchema;
}

/**
 * Index a command's args by their CLI flag strings for O(1) lookup.
 */
export function indexByFlag(args: RunArg[]): Map<string, RunArg> {
  const m = new Map<string, RunArg>();
  for (const a of args) for (const f of a.flags) m.set(f, a);
  return m;
}
