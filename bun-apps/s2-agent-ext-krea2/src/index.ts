/**
 * index.ts — pure, pi-free pipeline tying binary/commands/invoke/result together.
 *
 * `runKrea2()` is the reusable core: resolve binary → validate paths → build
 * args → spawn → parse. It has NO dependency on the pi SDK, so it is unit-
 * testable and importable from the extension OR a future CLI command.
 *
 * The extension (extensions/krea2.ts) is a thin wrapper that maps the typed
 * tool parameters onto this function and shapes the ToolResult.
 */
import { ensureBinary, resolveRepoRoot } from "./binary.ts";
import {
  buildArgs,
  COMMANDS,
  pathFieldKeys,
  type CommandSpec,
} from "./commands.ts";
import { invokeKrea2, type InvokeResult, type ProgressFn } from "./invoke.ts";
import {
  assertPathAllowed,
  assertSafePathComponent,
  ensureOutputDir,
  PathSafetyError,
  rejectFlagLike,
  resolveModelsRoot,
  resolveOutputDir,
  validateExtraArgs,
  type AllowedRoots,
} from "./paths.ts";
import {
  buildImageDetails,
  summarize,
  stderrTail,
  type Krea2Details,
} from "./result.ts";

export * from "./commands.ts";
export * from "./paths.ts";
export { invokeKrea2 } from "./invoke.ts";
export type { Krea2Details, OutputFile } from "./result.ts";
export { parseSavedPath } from "./result.ts";
export { PathSafetyError } from "./paths.ts";

export type CommandName = keyof typeof COMMANDS;

export interface RunKrea2Input {
  command: CommandName;
  /** Per-command typed options (camelCase keys matching commands.ts fields). */
  options?: Record<string, unknown>;
  /** Output dir override (NOT a krea2 flag — used for path validation + dir ensure only). */
  outputDir?: string;
  /** Models root override (NOT a krea2 flag — used for path validation only). */
  modelsRoot?: string;
  /** Escape-hatch raw tokens (validated; leading-dash must be allow-listed). */
  extraArgs?: string[];
  /** Abort the run. */
  signal?: AbortSignal;
  /** Progress stream (one line per update). */
  onProgress?: ProgressFn;
}

export interface RunKrea2Output {
  details: Krea2Details;
  /** One-line human summary (becomes the tool's text content). */
  summary: string;
  /** stderr tail on failure (for the error text fallback). */
  stderrTail: string;
}

/**
 * Flags the agent may pass via extraArgs (escape hatch), validated prefix set.
 * Sourced from `krea2 t2i/i2i --help` so the agent can forward any real flag.
 */
const EXTRA_ARG_ALLOW = new Set<string>([
  "help", "version",
  "prompt", "width", "height", "steps", "seed", "mu", "out", "bridge",
  "input", "strength",
  // short aliases krea2 accepts (-w/-h)
  "w", "h",
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
    if (!field) continue;
    if (field.isPathArray) {
      if (!Array.isArray(v)) throw new PathSafetyError(`field "${key}" must be an array of paths`);
      for (const item of v) assertPathAllowed(String(item), roots, { kind: key, mustExist: true });
    } else {
      // output (`out`) need not pre-exist; input does.
      const isOutput = key === "out";
      assertPathAllowed(String(v), roots, { kind: key, mustExist: !isOutput });
    }
  }
  // Reject flag-like values in free-form string fields that aren't paths
  // (e.g. prompt accidentally starting with '-').
  for (const [key, field] of Object.entries(spec.fields)) {
    if (field.isPath || field.isPathArray || field.positional) continue;
    if (!(key in options)) continue;
    const v = options[key];
    // isPathComponent fields are bare names the Swift binary joins onto a
    // models-tree root itself with no sanitization — reject path separators
    // / ".." instead of the weaker leading-dash-only rejectFlagLike check.
    if (field.isPathComponent) {
      if (typeof v === "string") assertSafePathComponent(v, key);
      else if (Array.isArray(v)) for (const item of v) if (typeof item === "string") assertSafePathComponent(item, key);
      continue;
    }
    if (typeof v === "string") {
      rejectFlagLike(v, key);
    } else if (Array.isArray(v)) {
      for (const item of v) if (typeof item === "string") rejectFlagLike(item, key);
    }
  }
}

/** Build the full krea2 argv: command args + validated extraArgs. */
function buildArgv(
  spec: CommandSpec,
  options: Record<string, unknown>,
  roots: AllowedRoots,
  extraArgs: string[],
): string[] {
  const cmdArgs = buildArgs(spec, options);
  // krea2 takes no global flags (--models-root/--output-dir are NOT krea2 flags);
  // extraArgs are validated against the krea2 surface only.
  void roots;
  const cleanedExtra = validateExtraArgs(extraArgs, roots, [...EXTRA_ARG_ALLOW]);
  return [...cmdArgs, ...cleanedExtra];
}

/** Resolve the allowed-roots bundle for a run. */
function resolveRoots(repoRoot: string, outputDir?: string, modelsRoot?: string): AllowedRoots {
  return {
    repoRoot,
    outputDir: resolveOutputDir(repoRoot, outputDir),
    modelsRoot: resolveModelsRoot(repoRoot, modelsRoot),
  };
}

/** Pull informational seed/width/height from the agent's options (may be unset). */
function optNum(options: Record<string, unknown>, key: string): number | undefined {
  const v = options[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Run a krea2 command end-to-end (validate paths → build args → spawn → parse).
 * Resolves with structured details + summary. Throws PathSafetyError on invalid
 * paths/args. Non-zero krea2 exit is NOT an exception — it surfaces as
 * details.ok=false (the agent can react).
 */
export async function runKrea2(input: RunKrea2Input): Promise<RunKrea2Output> {
  const spec = COMMANDS[input.command];
  if (!spec) {
    throw new Error(
      `Unknown krea2 command "${input.command}". Known: ${Object.keys(COMMANDS).join(", ")}`,
    );
  }
  const options = input.options ?? {};
  const repoRoot = resolveRepoRoot();
  const roots = resolveRoots(repoRoot, input.outputDir, input.modelsRoot);
  const extraArgs = input.extraArgs ?? [];

  // Create the write target BEFORE validating paths: a not-yet-existing
  // outputDir under a symlinked ancestor (macOS /tmp -> /private/tmp) would
  // otherwise resolve the root via fallback while the child path resolves
  // through the symlink, mismatching and wrongly rejecting a legitimate --out.
  ensureOutputDir(repoRoot, input.outputDir);

  validateOptionPaths(spec, options, roots);

  const bin = await ensureBinary(input.onProgress);
  const args = buildArgv(spec, options, roots, extraArgs);
  const cmdTokens = [spec.name];

  input.onProgress?.({ kind: "progress", text: `$ krea2 ${[...cmdTokens, ...args].join(" ")}` });

  const res: InvokeResult = await invokeKrea2({
    bin,
    args: [...cmdTokens, ...args],
    cwd: roots.repoRoot,
    signal: input.signal,
    onProgress: input.onProgress,
  });

  const details = buildImageDetails(input.command, res, {
    seed: optNum(options, "seed"),
    width: optNum(options, "width"),
    height: optNum(options, "height"),
  });
  return { details, summary: summarize(details), stderrTail: stderrTail(res) };
}
