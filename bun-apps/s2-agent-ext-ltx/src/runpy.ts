/**
 * runpy.ts — the run.py VIDEO adapter (Option A), sibling of the Swift path.
 *
 * `run.py video t2i2v` is the canonical PYTHON generation runtime (CLAUDE.md
 * declares run.py "the only generation runtime"). This adapter spawns it
 * DIRECTLY so the extension's video path is whole WITHOUT building the
 * `swift:ltx` binary — the production `i2v` command itself still bridges run.py
 * via RunPyBridge.swift (see the README's native-i2v-vs-i2v note), and the pure
 * Swift `native-i2v` port is incomplete. A thin TS adapter reaches the SAME
 * run.py call site the Swift bridge does, with zero swift build cost.
 *
 *   spawns:  python/venv/bin/python python/mlx-movie-director/run.py video t2i2v ...
 *   parses:  [t2i2v]   manifest: <path>   (app/commands/video-t2i2v.py:1156)
 *   reads:   t2i2v_manifest.json  ({ pipeline, output_dir, stages:{t2i,vlm,i2v,quality} })
 *   globs:   newest *.mp4 from the manifest's output_dir
 *
 * LOCAL-ONLY (constraint 1): run.py is local MLX on Apple Silicon — never a
 * cloud GAI API. There is no provider/model field here that could name a cloud
 * backend; the only model ids come from the manifest's stage transformers
 * (ltx/dasiwa/dev/z-image — all local silicon).
 *
 * Mirrors runLtx()'s shape (details + summary + stderrTail) so the movie-director
 * bridge can adapt it the same way. Pure / pi-free: importable from the extension
 * OR a standalone e2e smoke (see scripts/e2e-smoke.ts).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoRoot } from "./binary.ts";
import { invokeLtx, type InvokeResult, type ProgressFn } from "./invoke.ts";
import {
  assertPathAllowed,
  ensureOutputDir,
  rejectFlagLike,
  resolveOutputDir,
  validateExtraArgs,
  type AllowedRoots,
} from "./paths.ts";

/** Typed options for `run.py video t2i2v` (camelCase → kebab CLI flags). */
export interface RunPyVideoOptions {
  /** The T2I prompt (Stage 1). Required unless --self-test selects a fixture. */
  prompt?: string;
  /** Stage-2 VLM action text (zh motion+voice expansion). Omit to skip VLM. */
  action?: string;
  /** I2V transformer variant: "dev" | "dasiwa" | ... (maps to --t2i-transformer's i2v sibling via run.py). */
  transformer?: string;
  /** T2I transformer variant (maps to --t2i-transformer). */
  t2iTransformer?: string;
  /** Number of I2V frames (default per fixture / run.py). */
  frames?: number;
  /** Frames per second. */
  fps?: number;
  /** Base seed (T2I + I2V). */
  seed?: number;
  /** T2I width / height. */
  t2iWidth?: number;
  t2iHeight?: number;
  /** Existing image to skip Stage-1 T2I (path validated under an allowed root). */
  fromImage?: string;
  /** TTS voice for the Stage-4b audio-lang fix (local macOS `say` voice). */
  ttsVoice?: string;
  /** Run the quality-check stage (needs LM Studio for VLM scoring). */
  qualityCheck?: boolean;
  /**
   * Pick a T2I2V_SELF_TESTS fixture (app/commands/video-t2i2v.py:31):
   * `true` runs all, a string runs one named fixture. Cheapest way to drive a
   * real end-to-end gen without hand-building every flag.
   */
  selfTest?: boolean | string;
}

export interface RunPyVideoInput {
  options?: RunPyVideoOptions;
  /** Output dir override (passed as --gen-output-dir; run.py writes t2i2v_* under it). */
  outputDir?: string;
  /** Escape-hatch raw tokens (validated; leading-dash must be allow-listed). */
  extraArgs?: string[];
  /** Abort the run. */
  signal?: AbortSignal;
  /** Progress stream (one line per update). */
  onProgress?: ProgressFn;
  /**
   * Test-only spawn injection: replaces the real `python/venv/bin/python run.py`
   * subprocess so unit tests can feed canned stdout + a fake manifest without a
   * venv. Mirrors the whisper/clip/esrgan/compose-motion adapters' pattern.
   */
  _spawnImpl?: (opts: {
    bin: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
  }) => Promise<InvokeResult>;
}

/** The structured result. Shape-compatible with LtxDetails so the bridge adapts it uniformly. */
export interface RunPyVideoDetails {
  ok: boolean;
  /** "video t2i2v". */
  command: string;
  exitCode: number;
  aborted: boolean;
  /** Newest *.mp4 produced (null if none / non-zero exit). */
  output: string | null;
  /** The parsed t2i2v_manifest.json (null if unreadable). */
  manifest: Record<string, unknown> | null;
  /** The run's output_dir (from manifest; the t2i2v_<stamp> dir). */
  outDir: string | null;
  /** Local model id (i2v transformer from the manifest), for the bridge's `model` field. */
  model: string | null;
  /** Raw run.py stdout (kept whole; summarized separately). */
  stdout: string;
  /** Convenience flag for the gate criterion: exit 0 && mp4 exists. */
  exitOk: boolean;
  mp4Exists: boolean;
}

export interface RunPyVideoOutput {
  details: RunPyVideoDetails;
  summary: string;
  stderrTail: string;
}

/** Flags the agent may pass via extraArgs (escape hatch). Kept narrow + obvious. */
const EXTRA_ARG_ALLOW_RUNPY = new Set<string>([
  "help", "version",
  "prompt", "action", "transformer", "t2i-transformer", "frames", "fps",
  "seed", "t2i-width", "t2i-height", "from-image", "tts-voice",
  "quality-check", "no-quality-check", "self-test", "gen-output-dir",
  "t2i-steps", "t2i-cfg-scale", "t2i-seed", "t2i-lora-path", "t2i-lora-scale",
  "t2i-face-detail", "t2i-clothing", "quality-threshold", "max-retries",
  "review-runs", "review-dir", "rescore", "dev-audio", "vlm-api-url",
]);

/** Resolve the MLX venv python + run.py from the repo root (env-overridable). */
export function resolveRunPyPaths(repoRoot: string): { python: string; runPy: string } {
  const python = process.env.MLX_VENV_PYTHON ?? join(repoRoot, "python", "venv", "bin", "python");
  const runPy = process.env.RUN_PY ?? join(repoRoot, "python", "mlx-movie-director", "run.py");
  return { python, runPy };
}

/**
 * Validate path + free-form string fields before they reach argv. Mirrors
 * index.ts's validateOptionPaths: `fromImage` must resolve under an allowed
 * root, every other string field is checked for a leading "-" (flag
 * injection). Without this, buildArgs pushes every field straight into argv
 * unchecked — the exact gap paths.ts's own header promises is closed
 * everywhere in this package.
 */
function validateOptions(opts: RunPyVideoOptions, roots: AllowedRoots): void {
  if (opts.fromImage != null) {
    assertPathAllowed(String(opts.fromImage), roots, { kind: "fromImage", mustExist: true });
  }
  for (const [key, v] of Object.entries(opts)) {
    if (key === "fromImage") continue;
    if (typeof v === "string") rejectFlagLike(v, key);
  }
}

/** camelCase option → kebab-case flag token list (only set fields contribute). */
function buildArgs(opts: RunPyVideoOptions, genOutputDir: string | null): string[] {
  const args: string[] = [];

  // --self-test first (it short-circuits everything else in run.py dispatch).
  if (opts.selfTest != null && opts.selfTest !== false) {
    args.push("--self-test");
    if (typeof opts.selfTest === "string" && opts.selfTest) args.push(opts.selfTest);
  }

  if (opts.prompt != null) args.push("--prompt", String(opts.prompt));
  if (opts.action != null) args.push("--action", String(opts.action));
  if (opts.transformer != null) args.push("--transformer", String(opts.transformer));
  if (opts.t2iTransformer != null) args.push("--t2i-transformer", String(opts.t2iTransformer));
  if (opts.frames != null) args.push("--frames", String(opts.frames));
  if (opts.fps != null) args.push("--fps", String(opts.fps));
  if (opts.seed != null) args.push("--seed", String(opts.seed));
  if (opts.t2iWidth != null) args.push("--t2i-width", String(opts.t2iWidth));
  if (opts.t2iHeight != null) args.push("--t2i-height", String(opts.t2iHeight));
  if (opts.fromImage != null) args.push("--from-image", String(opts.fromImage));
  if (opts.ttsVoice != null) args.push("--tts-voice", String(opts.ttsVoice));
  if (opts.qualityCheck === true) args.push("--quality-check");
  if (opts.qualityCheck === false) args.push("--no-quality-check");

  if (genOutputDir) args.push("--gen-output-dir", genOutputDir);
  return args;
}

/** Newest *.mp4 in `dir` by mtime (run.py writes exactly one per t2i2v run). */
function newestMp4(dir: string): string | null {
  if (!dir || !existsSync(dir)) return null;
  let best: { path: string; mtime: number } | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.toLowerCase().endsWith(".mp4")) continue;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (!best || st.mtimeMs > best.mtime) best = { path, mtime: st.mtimeMs };
  }
  return best?.path ?? null;
}

/** Parse `[t2i2v]   manifest: <path>` (last match wins — it prints once at the end). */
function manifestPathFromStdout(stdout: string): string | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(/^\[t2i2v\]\s+manifest:\s*(.+)$/);
    if (m) return m[1]!.trim();
  }
  return null;
}

function readManifest(path: string): Record<string, unknown> | null {
  try {
    const txt = readFileSync(path, "utf8");
    const j = JSON.parse(txt);
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function buildDetails(res: InvokeResult): RunPyVideoDetails {
  const exitOk = res.exitCode === 0 && !res.aborted;
  const manifestPath = manifestPathFromStdout(res.stdout);
  const manifest = manifestPath ? readManifest(manifestPath) : null;
  const outDir =
    (manifest && typeof manifest["output_dir"] === "string" && (manifest["output_dir"] as string)) ||
    null;
  const mp4 = outDir ? newestMp4(outDir) : null;
  const mp4Exists = mp4 != null && existsSync(mp4);
  const stages = (manifest && (manifest["stages"] as Record<string, unknown> | undefined)) || undefined;
  const i2v = (stages && (stages["i2v"] as Record<string, unknown> | undefined)) || undefined;
  const t2i = (stages && (stages["t2i"] as Record<string, unknown> | undefined)) || undefined;
  const model =
    (i2v && typeof i2v["transformer"] === "string" && (i2v["transformer"] as string)) ||
    (t2i && typeof t2i["transformer"] === "string" && (t2i["transformer"] as string)) ||
    null;

  // ok = the adapter's gate: run.py exited 0 AND a real mp4 landed on disk.
  // A 0-exit with no mp4 (e.g. a --review-runs dispatch) is NOT a generation success.
  const ok = exitOk && mp4Exists;
  return {
    ok,
    command: "video t2i2v",
    exitCode: res.exitCode,
    aborted: res.aborted,
    output: mp4,
    manifest,
    outDir,
    model,
    stdout: res.stdout,
    exitOk,
    mp4Exists,
  };
}

function summarize(d: RunPyVideoDetails): string {
  if (d.aborted) return "video t2i2v: aborted";
  if (!d.exitOk) return `video t2i2v: run.py exited ${d.exitCode} (no mp4)`;
  if (!d.mp4Exists) return "video t2i2v: run.py exited 0 but produced no mp4 (review/empty run?)";
  const xfmr = d.model ? ` [${d.model}]` : "";
  return `video t2i2v: ✓ ${d.output}${xfmr}`;
}

function stderrTailOf(res: InvokeResult): string {
  const lines = res.stderr.split("\n").filter((l) => l.trim());
  return lines.slice(-12).join("\n");
}

/**
 * Run `python/venv/bin/python run.py video t2i2v ...` end-to-end. Resolves with
 * structured details + summary. Throws PathSafetyError on invalid paths/args
 * (same contract as runLtx) or on repo-root / output-dir resolution failure.
 * Non-zero run.py exit is NOT an exception — it surfaces as details.ok=false.
 */
export async function runPyVideo(input: RunPyVideoInput): Promise<RunPyVideoOutput> {
  const repoRoot = resolveRepoRoot();
  const roots: AllowedRoots = {
    repoRoot,
    outputDir: resolveOutputDir(repoRoot, input.outputDir),
    // run.py resolves its own models root from cfg; the adapter doesn't inject one.
    modelsRoot: repoRoot,
  };
  // ensureOutputDir's mkdirSync can throw a raw fs error on a read-only/full volume.
  try {
    ensureOutputDir(repoRoot, roots.outputDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const res: InvokeResult = { exitCode: 1, output: message, stdout: "", stderr: message, aborted: false };
    return { details: buildDetails(res), summary: summarize(buildDetails(res)), stderrTail: message };
  }

  const { python, runPy } = resolveRunPyPaths(repoRoot);
  const options = input.options ?? {};
  validateOptions(options, roots);
  const extraArgs = validateExtraArgs(input.extraArgs ?? [], roots, [...EXTRA_ARG_ALLOW_RUNPY]);
  // invokeLtx does `spawn(python, args)` — so argv must be the run.py SCRIPT path
  // first, then the run.py subcommand chain (`video t2i2v …`), NOT `video` as the
  // first token (python would treat "video" as the script path: "can't open file '…/video'").
  const args = [runPy, "video", "t2i2v", ...buildArgs(options, roots.outputDir), ...extraArgs];

  try {
    input.onProgress?.({ kind: "progress", text: `$ ${python} ${args.join(" ")}` });
  } catch {
    /* progress callback failures must not crash the run */
  }

  const res = input._spawnImpl
    ? await input._spawnImpl({ bin: python, args, cwd: repoRoot, env: undefined })
    : await invokeLtx({ bin: python, args, cwd: repoRoot, signal: input.signal, onProgress: input.onProgress });

  const details = buildDetails(res);
  return { details, summary: summarize(details), stderrTail: stderrTailOf(res) };
}
