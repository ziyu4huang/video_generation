/**
 * index.ts — pure, pi-free pipeline tying binary/commands/invoke/result together.
 *
 * `runFlux2()` is the reusable core: resolve binary → validate paths → build
 * args → spawn → parse. It has NO dependency on the pi SDK, so it is unit-
 * testable and importable from the extension OR a future CLI command.
 *
 * The extension (extensions/pi-flux2.ts) is a thin wrapper that maps the typed
 * tool parameters onto this function and shapes the ToolResult.
 */
import { ensureBinary, resolveRepoRoot } from "./binary.ts";
import {
  buildArgs,
  COMMANDS,
  pathFieldKeys,
  type CommandSpec,
} from "./commands.ts";
import { invokeFlux2, type ProgressFn } from "./invoke.ts";
import {
  assertPathAllowed,
  PathSafetyError,
  rejectFlagLike,
  resolveModelsRoot,
  resolveOutputDir,
  validateExtraArgs,
  type AllowedRoots,
} from "./paths.ts";
import {
  buildGateDetails,
  buildImageDetails,
  buildTextDetails,
  stderrTail,
  summarize,
  type Flux2Details,
} from "./result.ts";

export * from "./commands.ts";
export * from "./paths.ts";
export { invokeFlux2 } from "./invoke.ts";
export type { Flux2Details, OutputFile, PerfInfo, GateEntry } from "./result.ts";
export { PathSafetyError } from "./paths.ts";

export type CommandName = keyof typeof COMMANDS;

export interface RunFlux2Input {
  command: CommandName;
  /** Per-command typed options (camelCase keys matching commands.ts fields). */
  options?: Record<string, unknown>;
  /** Output dir override (→ --output-dir global; also constrains path validation). */
  outputDir?: string;
  /** Models root override (→ --models-root global). */
  modelsRoot?: string;
  /** Escape-hatch raw tokens (validated; leading-dash must be allow-listed). */
  extraArgs?: string[];
  /** Abort the run. */
  signal?: AbortSignal;
  /** Progress stream (one line per update). */
  onProgress?: ProgressFn;
}

export interface RunFlux2Output {
  details: Flux2Details;
  /** One-line human summary (becomes the tool's text content). */
  summary: string;
  /** stderr tail on failure (for the error text fallback). */
  stderrTail: string;
}

/** Flags the agent may pass via extraArgs (escape hatch), validated prefix set. */
const EXTRA_ARG_ALLOW = new Set<string>([
  "help", "version",
  "prompt", "negative-prompt", "ref", "ref-count-per-image", "ref-strength",
  "ref-gate-steps", "regional", "region-attention", "ref-mask", "ref-region-mask",
  "ref-region-strength", "ref-region-feather", "regional-feather", "regional-strength",
  "hand-repair", "hand-repair-strength", "bg", "bg-strength", "lora", "lora-scale",
  "transformer", "seed", "width", "height", "steps", "cfg-scale", "output", "output-dir",
  "name", "vae", "encoder", "tokenizer-dir", "no-artifacts", "strict-gate", "models-root",
  "input", "preset", "style-prompt", "ref-count", "angle", "azimuth", "elevation",
  "source", "reference", "threshold", "feather", "mask-dilate", "preserve-aspect-ratio",
  "inpaint", "harmonize", "expand", "pixels", "model", "tile-size", "tile-overlap",
  "no-tile", "json", "strict", "image", "character", "scenes", "ref", "reference", "reference-image",
  "tokenizer", "tokenizer-dir",
]);

/** Validate all path-typed fields in options against the allowed roots. */
function validateOptionPaths(
  spec: CommandSpec,
  options: Record<string, unknown>,
  roots: AllowedRoots,
): void {
  for (const key of pathFieldKeys(spec)) {
    if (!(key in options)) continue;
    const v = options[key];
    if (v == null) continue;
    const field = spec.fields[key];
    if (field.isPathArray) {
      if (!Array.isArray(v)) throw new PathSafetyError(`field "${key}" must be an array of paths`);
      for (const item of v) assertPathAllowed(String(item), roots, { kind: key, mustExist: true });
    } else {
      // output fields need not pre-exist; inputs do.
      const isOutput = key === "output";
      assertPathAllowed(String(v), roots, { kind: key, mustExist: !isOutput });
    }
  }
  // Reject flag-like values in free-form string fields that aren't paths
  // (e.g. a prompt accidentally starting with '-').
  for (const [key, field] of Object.entries(spec.fields)) {
    if (field.isPath || field.isPathArray || field.positional) continue;
    if (!(key in options)) continue;
    const v = options[key];
    if (typeof v === "string") rejectFlagLike(v, key);
  }
}

/** Build the full flux2 argv: globals (only where accepted) + command args + extraArgs. */
function buildArgv(
  spec: CommandSpec,
  options: Record<string, unknown>,
  roots: AllowedRoots,
  extraArgs: string[],
): string[] {
  const argv: string[] = [];

  // --models-root only on commands that declare GlobalOptions (generation + story).
  if (spec.acceptsGlobals) argv.push("--models-root", roots.modelsRoot);
  // --output-dir only on commands that model it (generation commands; lands the
  // manifest sidecar in the validated output dir we parse from).
  if ("outputDir" in spec.fields) argv.push("--output-dir", roots.outputDir);

  const cmdArgs = buildArgs(spec, options);
  const cleanedExtra = validateExtraArgs(extraArgs, roots, [...EXTRA_ARG_ALLOW]);
  // Drop our managed globals from any user extraArgs to avoid duplicates/conflicts.
  const filteredExtra = cleanedExtra.filter((t, i) => {
    if (t === "--models-root" || t === "--output-dir") return false;
    if (i > 0 && (cleanedExtra[i - 1] === "--models-root" || cleanedExtra[i - 1] === "--output-dir")) {
      return false;
    }
    return true;
  });

  return [...argv, ...cmdArgs, ...filteredExtra];
}

/** Resolve the allowed-roots bundle for a run. */
function resolveRoots(repoRoot: string, outputDir?: string, modelsRoot?: string): AllowedRoots {
  return {
    repoRoot,
    outputDir: resolveOutputDir(repoRoot, outputDir),
    modelsRoot: resolveModelsRoot(repoRoot, modelsRoot),
  };
}

/**
 * Run a flux2 command end-to-end. Resolves with structured details + summary.
 * Throws PathSafetyError on invalid paths/args. Non-zero flux2 exit is NOT an
 * exception — it surfaces as details.ok=false (the agent can react).
 */
export async function runFlux2(input: RunFlux2Input): Promise<RunFlux2Output> {
  const spec = COMMANDS[input.command];
  if (!spec) {
    throw new Error(
      `Unknown flux2 command "${input.command}". Known: ${Object.keys(COMMANDS).join(", ")}`,
    );
  }
  const options = input.options ?? {};
  const repoRoot = resolveRepoRoot();
  const roots = resolveRoots(repoRoot, input.outputDir, input.modelsRoot);

  validateOptionPaths(spec, options, roots);

  const bin = await ensureBinary(input.onProgress);
  const args = buildArgv(spec, options, roots, input.extraArgs ?? []);
  const cmdTokens = [spec.name, ...(spec.cliSubcommand ? [spec.cliSubcommand] : [])];

  input.onProgress?.({ kind: "progress", text: `$ flux2 ${[...cmdTokens, ...args].join(" ")}` });

  const res = await invokeFlux2({
    bin,
    args: [...cmdTokens, ...args],
    cwd: repoRoot,
    signal: input.signal,
    onProgress: input.onProgress,
  });

  let details: Flux2Details;
  if (input.command === "gate") {
    details = buildGateDetails(res);
  } else if (spec.writesImage) {
    details = await buildImageDetails(input.command, res, bin, [...cmdTokens, ...args], roots.outputDir);
  } else {
    details = buildTextDetails(input.command, res);
  }

  return { details, summary: summarize(details), stderrTail: stderrTail(res) };
}
