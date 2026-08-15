/**
 * index.ts — pure, pi-free pipeline tying binary/commands/invoke/result together.
 *
 * `runLtx()` is the reusable core: resolve binary -> validate paths -> build
 * args -> spawn -> parse. No dependency on the pi SDK, so it is unit-testable
 * and importable from the extension OR a future CLI command. Mirrors
 * pi-agent-ext-flux2/src/index.ts's shape; the two real differences are (1)
 * ltx-video has no --models-root/--output-dir global flags to inject (see
 * paths.ts's assertModelsRootExists doc comment) and (2) result parsing is
 * stdout-regex-based (result.ts) rather than a .manifest.json sidecar.
 */
import { ensureBinary, resolveRepoRoot } from "./binary.ts";
import { buildArgs, COMMANDS, pathFieldKeys, pathSpecFieldKeys, variantSpecFieldKeys, type CommandSpec } from "./commands.ts";
import { invokeLtx, type InvokeResult, type ProgressFn } from "./invoke.ts";
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
import { buildDetails, stderrTail, summarize, type LtxDetails } from "./result.ts";
import { applyShotLanguage, type ShotLanguage } from "./shotLanguage.ts";

export * from "./commands.ts";
export * from "./paths.ts";
export * from "./shotLanguage.ts";
export { invokeLtx } from "./invoke.ts";
export type { LtxDetails, GateEntry } from "./result.ts";
export { PathSafetyError } from "./paths.ts";
export { resolveRepoRoot, defaultBinaryPath, ensureBinary } from "./binary.ts";
export {
  runPyVideo,
  resolveRunPyPaths,
  type RunPyVideoInput,
  type RunPyVideoOutput,
  type RunPyVideoDetails,
  type RunPyVideoOptions,
} from "./runpy.ts";

export type CommandName = keyof typeof COMMANDS;

export interface RunLtxInput {
  command: CommandName;
  /** Per-command typed options (camelCase keys matching commands.ts fields). */
  options?: Record<string, unknown>;
  /**
   * Structured camera/lighting vocabulary (concept borrowed from
   * ../OpenMontage's scene_plan.shot_language, see shotLanguage.ts), rendered
   * to a text clause and appended to `options.prompt` (or every element of
   * `options.prompts` for native-relay) before the command runs. No-op for
   * commands with no prompt-shaped field.
   */
  shotLanguage?: ShotLanguage;
  /** Output dir override (constrains path validation; individual commands' `output` field wins if set). */
  outputDir?: string;
  /** Models root override (constrains path validation only — no CLI flag to inject, see paths.ts). */
  modelsRoot?: string;
  /** Escape-hatch raw tokens (validated; leading-dash must be allow-listed). */
  extraArgs?: string[];
  /** Abort the run. */
  signal?: AbortSignal;
  /** Progress stream (one line per update). */
  onProgress?: ProgressFn;
}

export interface RunLtxOutput {
  details: LtxDetails;
  /** One-line human summary (becomes the tool's text content). */
  summary: string;
  /** stderr tail on failure (for the error text fallback). */
  stderrTail: string;
}

/**
 * Flags the agent may pass via extraArgs (escape hatch), validated prefix set.
 * Exported so `scripts/check-flags.ts` can cross-check every entry here still
 * names a real `ltx-video` flag — this set is otherwise invisible to that
 * drift guard, which only diffs `commands.ts`'s typed fields (found by
 * pi-agent-ext-ltx-self-improve's review lane, 2026-07-04).
 */
export const EXTRA_ARG_ALLOW = new Set<string>([
  "help", "version",
  "prompt", "action", "seconds", "fps", "width", "height", "seed", "steps",
  "t2i-transformer", "transformer", "text-max-length", "output", "upscale",
  "no-upscale", "refine", "no-refine", "lora", "last-frame", "audio-track",
  "input", "mode", "refine-prompt", "refine-audio", "stage1-steps",
  "stage2-steps", "cfg-scale", "stg-scale", "quality-check",
  "no-quality-check", "vlm-score", "no-vlm-score", "self-verify", "json-out",
  "scale", "keep-audio", "no-keep-audio", "json", "expect-voice",
  "no-expect-voice", "strict", "keyframes", "style", "threshold", "latent",
  "zeros", "zeros-frames", "zeros-size", "mp4", "no-mp4",
  "restoration-lora", "upscale-lora",
]);

/** Validate all path-typed fields (plain paths + path[:strength] specs) in options. */
function validateOptionPaths(spec: CommandSpec, options: Record<string, unknown>, roots: AllowedRoots): void {
  for (const key of pathFieldKeys(spec)) {
    if (!(key in options)) continue;
    const v = options[key];
    if (v == null) continue;
    const field = spec.fields[key];
    if (field == null) continue;
    if (field.isPathArray) {
      if (!Array.isArray(v)) throw new PathSafetyError(`field "${key}" must be an array of paths`);
      for (const item of v) assertPathAllowed(String(item), roots, { kind: key, mustExist: true });
    } else {
      const isOutput = key === "output" || field.isOutputPath === true;
      assertPathAllowed(String(v), roots, { kind: key, mustExist: !isOutput });
    }
  }

  // "path[:strength]" spec fields (native-i2v's --lora): validate only the
  // path portion (everything before the LAST ":" if present), leave the
  // strength suffix for the Swift binary's own ValidationError.
  for (const key of pathSpecFieldKeys(spec)) {
    if (!(key in options)) continue;
    const v = options[key];
    if (v == null) continue;
    if (!Array.isArray(v)) throw new PathSafetyError(`field "${key}" must be an array of "path[:strength]" specs`);
    for (const item of v) {
      const raw = String(item);
      const colonIdx = raw.lastIndexOf(":");
      const pathPart = colonIdx > 0 ? raw.slice(0, colonIdx) : raw;
      assertPathAllowed(pathPart, roots, { kind: key, mustExist: true });
    }
  }

  // "name[=path[:strength]]" spec fields (native-relay's --variant): a bare
  // name (no "=") has no embedded path and is left untouched (still subject
  // to the rejectFlagLike pass below); when "=" is present, the path portion
  // (everything between "=" and the LAST ":" if present) is validated the
  // same way as pathSpecFieldKeys above.
  for (const key of variantSpecFieldKeys(spec)) {
    if (!(key in options)) continue;
    const v = options[key];
    if (v == null) continue;
    if (!Array.isArray(v)) throw new PathSafetyError(`field "${key}" must be an array of "name[=path[:strength]]" specs`);
    for (const item of v) {
      const raw = String(item);
      rejectFlagLike(raw, key);
      const eqIdx = raw.indexOf("=");
      if (eqIdx < 0) continue; // bare name, no embedded path
      const afterEq = raw.slice(eqIdx + 1);
      const colonIdx = afterEq.lastIndexOf(":");
      const pathPart = colonIdx > 0 ? afterEq.slice(0, colonIdx) : afterEq;
      assertPathAllowed(pathPart, roots, { kind: key, mustExist: true });
    }
  }

  // Reject flag-like values in free-form string (or string[]) fields that
  // aren't paths (e.g. a prompt accidentally starting with '-').
  for (const [key, field] of Object.entries(spec.fields)) {
    if (field.isPath || field.isPathArray || field.isPathSpecArray || field.isVariantSpecArray || field.positional) continue;
    if (!(key in options)) continue;
    const v = options[key];
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

/** Build the full ltx-video argv: command args + extraArgs (no global flags — see paths.ts). */
function buildArgv(spec: CommandSpec, options: Record<string, unknown>, roots: AllowedRoots, extraArgs: string[]): string[] {
  const cmdArgs = buildArgs(spec, options);
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

/**
 * Commands whose --output is a single FILE (not a directory) need the right
 * extension — the Swift side's image/audio writers pick format from context,
 * not from the path suffix, but a suffix-less path still reads oddly and
 * some downstream tooling (e.g. `open`) relies on it. Directory-output
 * commands (native-i2v, native-upscale, video-decode) get no suffix.
 */
const DEFAULT_OUTPUT_EXT: Partial<Record<string, string>> = {
  t2i: ".png",
  upscale: ".mp4",
  "audio-decode": ".wav",
};

/**
 * If the command has an `output` field and the agent didn't set one, inject a
 * default path under the resolved output dir (mirroring flux2's
 * externalized-output-dir convention) instead of letting the Swift binary's
 * own relative default land inside the repo/cwd.
 */
function withDefaultOutput(
  spec: CommandSpec,
  options: Record<string, unknown>,
  roots: AllowedRoots,
  timestamp: number,
): Record<string, unknown> {
  if (!("output" in spec.fields) || options.output != null) return options;
  const stamp = new Date(timestamp).toISOString().replace(/[:.]/g, "-");
  const ext = DEFAULT_OUTPUT_EXT[spec.name] ?? "";
  return { ...options, output: `${roots.outputDir}/${spec.name.replace(/[^a-z0-9]+/gi, "_")}_${stamp}${ext}` };
}

/**
 * Merge a ShotLanguage clause into `options.prompt` (string commands) or
 * every element of `options.prompts` (native-relay's string[]). No-op if
 * `sl` is undefined or neither field is present/a string(-array).
 */
export function withShotLanguage(options: Record<string, unknown>, sl: ShotLanguage | undefined): Record<string, unknown> {
  if (!sl) return options;
  const next = { ...options };
  if (typeof next.prompt === "string") {
    next.prompt = applyShotLanguage(next.prompt, sl);
  }
  if (Array.isArray(next.prompts)) {
    next.prompts = next.prompts.map((p) => (typeof p === "string" ? applyShotLanguage(p, sl) : p));
  }
  return next;
}

/**
 * Run ONE ltx-video command invocation end-to-end (validate paths -> build
 * args -> spawn -> parse).
 */
/** Convert a thrown Error into the same structured failure shape a non-zero ltx-video exit produces. */
function toFailureResult(command: CommandName, err: unknown): { details: LtxDetails; res: InvokeResult } {
  const message = err instanceof Error ? err.message : String(err);
  const res: InvokeResult = { exitCode: 1, output: message, stdout: message, stderr: message, aborted: false };
  const details = buildDetails(command, res);
  return { details, res };
}

async function runOnce(
  command: CommandName,
  optionsIn: Record<string, unknown>,
  roots: AllowedRoots,
  extraArgs: string[],
  signal: AbortSignal | undefined,
  onProgress: ProgressFn | undefined,
): Promise<{ details: LtxDetails; res: InvokeResult }> {
  const spec = COMMANDS[command];
  if (!spec) {
    throw new Error(`Unknown ltx-video command "${command}". Known: ${Object.keys(COMMANDS).join(", ")}`);
  }

  const options = withDefaultOutput(spec, optionsIn, roots, Date.now());
  validateOptionPaths(spec, options, roots);

  assertModelsRootExists(roots.repoRoot, roots.modelsRoot);
  // ensureOutputDir()'s mkdirSync can throw a raw fs error (ENOTDIR if a
  // parent segment is already a regular file, EACCES/ENOSPC on a read-only
  // or full volume) — NOT part of the documented "throws PathSafetyError,
  // otherwise details.ok=false" contract, same class of gap as
  // ensureBinary()'s build failure below (found by
  // pi-agent-ext-ltx-self-improve's review lane, 2026-07-05).
  try {
    ensureOutputDir(roots.repoRoot, roots.outputDir);
  } catch (err) {
    return toFailureResult(command, err);
  }

  // ensureBinary() throws a plain Error on repo-root/`swift build`/missing-
  // binary failures (binary.ts) — NOT part of the documented "throws
  // PathSafetyError, otherwise details.ok=false" contract runLtx's own
  // JSDoc promises. Catch it here so a fresh-checkout build failure surfaces
  // the same structured way as a non-zero ltx-video exit, instead of an
  // unhandled rejection (found by pi-agent-ext-ltx-self-improve's review
  // lane, 2026-07-04).
  let bin: string;
  try {
    bin = await ensureBinary(onProgress);
  } catch (err) {
    return toFailureResult(command, err);
  }
  const args = buildArgv(spec, options, roots, extraArgs);

  // onProgress runs before invokeLtx is even called — a throw here must not
  // crash runOnce, same reasoning as every other onProgress call site guarded
  // in invoke.ts/binary.ts (found by pi-agent-ext-ltx-self-improve's review
  // lane, 2026-07-05: this call site was missed in that earlier pass).
  try {
    onProgress?.({ kind: "progress", text: `$ ltx-video ${[spec.name, ...args].join(" ")}` });
  } catch {
    /* progress callback failures must not crash the run */
  }

  const res = await invokeLtx({
    bin,
    args: [spec.name, ...args],
    cwd: roots.repoRoot,
    signal,
    onProgress,
  });

  const details = buildDetails(command, res, options);
  return { details, res };
}

/**
 * Run an ltx-video command end-to-end. Resolves with structured details +
 * summary. Throws PathSafetyError on invalid paths/args. Non-zero ltx-video
 * exit is NOT an exception — it surfaces as details.ok=false.
 */
export async function runLtx(input: RunLtxInput): Promise<RunLtxOutput> {
  if (!COMMANDS[input.command]) {
    throw new Error(`Unknown ltx-video command "${input.command}". Known: ${Object.keys(COMMANDS).join(", ")}`);
  }
  const options = withShotLanguage(input.options ?? {}, input.shotLanguage);
  const repoRoot = resolveRepoRoot();
  const roots = resolveRoots(repoRoot, input.outputDir, input.modelsRoot);
  const extraArgs = input.extraArgs ?? [];

  const { details, res } = await runOnce(input.command, options, roots, extraArgs, input.signal, input.onProgress);
  return { details, summary: summarize(details), stderrTail: stderrTail(res) };
}
