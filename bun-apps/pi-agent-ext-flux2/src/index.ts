/**
 * index.ts — pure, pi-free pipeline tying binary/commands/invoke/result together.
 *
 * `runFlux2()` is the reusable core: resolve binary → validate paths → build
 * args → spawn → parse. It has NO dependency on the pi SDK, so it is unit-
 * testable and importable from the extension OR a future CLI command.
 *
 * The extension (extensions/flux2.ts) is a thin wrapper that maps the typed
 * tool parameters onto this function and shapes the ToolResult.
 */
import { ensureBinary, resolveRepoRoot } from "./binary.ts";
import {
  buildArgs,
  COMMANDS,
  pathFieldKeys,
  type CommandSpec,
} from "./commands.ts";
import { invokeFlux2, type InvokeResult, type ProgressFn } from "./invoke.ts";
import {
  assertModelsRootExists,
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
  buildGateDetails,
  buildImageDetails,
  buildScenePipelineDetails,
  buildTextDetails,
  stderrTail,
  summarize,
  type Flux2Details,
} from "./result.ts";
import { runScenePipeline, type ScenePipelineOptions } from "./scenePipeline.ts";

export * from "./commands.ts";
export * from "./paths.ts";
export * from "./scenePipeline.ts";
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
  /**
   * Multi-seed pipeline — only meaningful when `command === "scene"`. Renders
   * every seed, gates + optionally VLM-verifies each, and picks a winner. See
   * scenePipeline.ts. When set, `options.seed`/`seeds` are ignored (each
   * candidate supplies its own seed).
   */
  scenePipeline?: ScenePipelineOptions;
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
  "input", "preset", "ref-count", "angle", "azimuth", "elevation",
  "source", "reference", "threshold", "feather", "mask-dilate", "preserve-aspect-ratio",
  "inpaint", "harmonize", "expand", "pixels", "model", "tile-size", "tile-overlap",
  "no-tile", "json", "strict", "image", "images", "character", "scenes", "ref", "reference",
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
    // pathFieldKeys() only returns keys present in spec.fields, so this is
    // defined; the guard also satisfies noUncheckedIndexedAccess.
    if (!field) continue;
    if (field.isPathArray) {
      if (!Array.isArray(v)) throw new PathSafetyError(`field "${key}" must be an array of paths`);
      for (const item of v) assertPathAllowed(String(item), roots, { kind: key, mustExist: true });
    } else {
      // output fields need not pre-exist; inputs do.
      const isOutput = key === "output";
      assertPathAllowed(String(v), roots, { kind: key, mustExist: !isOutput });
    }
  }
  // Reject flag-like values in free-form string (or string[], e.g. `lora`)
  // fields that aren't paths (e.g. a prompt, or a lora name, accidentally
  // starting with '-'). Array fields were previously skipped entirely here
  // because the check only ran for `typeof v === "string"` — an array slips
  // straight through to buildArgs() unvalidated.
  for (const [key, field] of Object.entries(spec.fields)) {
    if (field.isPath || field.isPathArray || field.positional) continue;
    if (!(key in options)) continue;
    const v = options[key];
    // isPathComponent fields (transformer/vae/encoder/tokenizerDir/lora/model)
    // are bare names the Swift binary joins onto a models-tree root itself
    // with no sanitization — reject path separators / ".." instead of the
    // weaker leading-dash-only rejectFlagLike check.
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
 * Run ONE flux2 command invocation end-to-end (validate paths → build args →
 * spawn → parse). This is the reusable primitive both the single-shot path
 * and the multi-seed scene pipeline call. Returns the raw invoke result
 * alongside `details` so the single-shot caller can still report a stderr tail.
 */
async function runOnce(
  command: CommandName,
  options: Record<string, unknown>,
  roots: AllowedRoots,
  extraArgs: string[],
  signal: AbortSignal | undefined,
  onProgress: ProgressFn | undefined,
): Promise<{ details: Flux2Details; res: InvokeResult }> {
  const spec = COMMANDS[command];
  if (!spec) {
    throw new Error(`Unknown flux2 command "${command}". Known: ${Object.keys(COMMANDS).join(", ")}`);
  }

  // Create the write target BEFORE validating paths: a not-yet-existing
  // outputDir under a symlinked ancestor (macOS /tmp -> /private/tmp, or any
  // `--output-dir <newpath>`) would otherwise resolve the ROOT via fallback
  // (realpathSync fails → returns the path unchanged) while each child path
  // resolves through the symlink — mismatching and wrongly rejecting a
  // legitimate --output/--ref under it. Validate against a dir that exists.
  if ("outputDir" in spec.fields) ensureOutputDir(roots.repoRoot, roots.outputDir);

  validateOptionPaths(spec, options, roots);

  // Boundary guard: models root is a read target → fail fast if absent (only
  // generation/story commands pass --models-root) so a missing tree surfaces
  // as an actionable error instead of an opaque MLX/Swift downstream crash.
  if (spec.acceptsGlobals) assertModelsRootExists(roots.repoRoot, roots.modelsRoot);

  const bin = await ensureBinary(onProgress);
  const args = buildArgv(spec, options, roots, extraArgs);
  const cmdTokens = [spec.name, ...(spec.cliSubcommand ? [spec.cliSubcommand] : [])];

  onProgress?.({ kind: "progress", text: `$ flux2 ${[...cmdTokens, ...args].join(" ")}` });

  const res = await invokeFlux2({
    bin,
    args: [...cmdTokens, ...args],
    cwd: roots.repoRoot,
    signal,
    onProgress,
  });

  let details: Flux2Details;
  if (command === "gate") details = buildGateDetails(res);
  else if (spec.writesImage) details = await buildImageDetails(command, res, bin, [...cmdTokens, ...args], roots.outputDir);
  else details = buildTextDetails(command, res);

  return { details, res };
}

/**
 * Run a flux2 command end-to-end. Resolves with structured details + summary.
 * Throws PathSafetyError on invalid paths/args. Non-zero flux2 exit is NOT an
 * exception — it surfaces as details.ok=false (the agent can react).
 *
 * If `scenePipeline` is set (only meaningful for `command: "scene"`), renders
 * every seed in `scenePipeline.seeds`, gates + optionally VLM-verifies each
 * via pi-file2md's shared subagent, and returns the winner as `details.output`
 * (so existing chaining, e.g. scene → upscale, keeps working unchanged) plus
 * the full candidate breakdown under `details.scenePipeline`.
 */
export async function runFlux2(input: RunFlux2Input): Promise<RunFlux2Output> {
  if (!COMMANDS[input.command]) {
    throw new Error(
      `Unknown flux2 command "${input.command}". Known: ${Object.keys(COMMANDS).join(", ")}`,
    );
  }
  const options = input.options ?? {};
  const repoRoot = resolveRepoRoot();
  const roots = resolveRoots(repoRoot, input.outputDir, input.modelsRoot);
  const extraArgs = input.extraArgs ?? [];

  if (input.scenePipeline) {
    const scenePipelineOpts = input.scenePipeline;
    const { seed: _seed, ...baseOptions } = options; // each candidate sets its own seed
    const pipeline = await runScenePipeline(
      baseOptions,
      scenePipelineOpts,
      {
        runSceneOnce: (opts) =>
          runOnce(input.command, opts, roots, extraArgs, input.signal, input.onProgress).then((r) => r.details),
        // Lazy: only imports pi-file2md's session machinery / resolves the LLM
        // target when a VLM verdict is actually requested. runScenePipeline
        // only ever calls this when verifyPrompt is set, so a pure gate-based
        // pipeline (no verifyPrompt) never pays for it — and never risks an
        // unrelated import/module-resolution failure aborting the whole
        // render before a single candidate is produced.
        askAboutImage: async (imagePath, question) => {
          const vlm = await import("./vlm.ts");
          const llm = vlm.resolveVlmLLM(scenePipelineOpts.vlmModel);
          return vlm.askAboutImage(imagePath, question, llm);
        },
      },
      (text) => input.onProgress?.({ kind: "progress", text }),
      input.signal,
    );
    const details = buildScenePipelineDetails(input.command, pipeline);
    return { details, summary: summarize(details), stderrTail: "" };
  }

  const { details, res } = await runOnce(input.command, options, roots, extraArgs, input.signal, input.onProgress);
  return { details, summary: summarize(details), stderrTail: stderrTail(res) };
}
