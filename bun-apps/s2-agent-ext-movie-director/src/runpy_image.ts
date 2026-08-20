/**
 * runpy_image.ts — the run.py IMAGE adapter (the force multiplier).
 *
 * `run.py` already has local, tested image sub-actions (t2i, controlnet,
 * faceswap, profile, purify, restore, multicouple, twosubject, workflow,
 * storyboard, review, quality, inpaint, cutout, styletransfer, character,
 * kontext). Originally this adapter also carried i2i/swap/anime2real/angle/
 * expansion; those five moved onto the equivalent flux2/krea2 Swift director
 * (2026-07-13, see bridge.ts's normalizeLegacyImageRequest) once confirmed
 * flux2/krea2 already implement the same mechanism natively. What remains
 * here is the long tail with no Swift-native equivalent yet (see
 * [[mlx-image-gen-om-gap-analysis]] — "the highest-leverage move is NOT new
 * MLX code, it's wiring").
 *
 *   spawns:  python/venv/bin/python python/mlx-movie-director/run.py image <action> ...
 *   parses:  `Manifest:   <path>` sentinel (app/commands/_shared.py:233, printed by
 *            run_session on success; `Manifest (error): <path>` on error to stderr)
 *   reads:   <base>.manifest.json — { status, output_files:[{path,seed,size_bytes,
 *            width,height}], models:{transformer:{path,...}}, elapsed_seconds }
 *   globs:   newest image in --gen-output-dir as a fallback when a sub-action does
 *            not use run_session (so it prints no manifest sentinel)
 *
 * LOCAL-ONLY (constraint 1): run.py is local MLX on Apple Silicon — never a cloud
 * GAI API. The only model ids come from the manifest's transformer fingerprint
 * (zimage / flux2-klein / lens — all local silicon); none can name a cloud backend.
 *
 * Mirrors runPyCaption()'s shape (details + summary + stderrTail) so the
 * movie-director bridge adapts it into the same ToolResult. Pure / pi-free: the
 * `_spawnImpl` test seam lets unit tests drive it without the MLX venv.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveRepoRoot, resolveRunPyPaths } from "@repo/s2-agent-ext-ltx";

/** The run.py image sub-actions this adapter reaches (image.py:run dispatch). */
export type ImageAction =
  | "t2i"
  | "i2i"
  | "controlnet"
  | "faceswap"
  | "profile"
  | "purify"
  | "restore"
  | "multicouple"
  | "twosubject"
  | "workflow"
  | "storyboard"
  | "review"
  | "quality"
  | "inpaint"
  | "cutout"
  | "styletransfer"
  | "kontext";

/** Typed options for `run.py image <action>` (camelCase → kebab CLI flags). */
export interface RunPyImageOptions {
  /** run.py image sub-action. Default "t2i" (run.py's own default). */
  action?: ImageAction;
  /** Secondary positional — meaningful for `review` (angle|generation|vae|lora|...). */
  subAction?: string;
  /** The text prompt (most actions). */
  prompt?: string;
  /** --input-image (controlnet / i2i / purify / anime2real / restore). */
  inputImage?: string;
  /** --input (angle / profile / expansion / review). */
  input?: string;
  /** --face (faceswap source face). */
  face?: string;
  /** --reference-image (i2i pose/style ref) / --reference (swap). */
  referenceImage?: string;
  reference?: string;
  /** Base seed. */
  seed?: number;
  /** --seed-start (distinct seeds across --count). */
  seedStart?: number;
  /** Batch count. */
  count?: number;
  /** Output dimensions. */
  width?: number;
  height?: number;
  /** Sampling steps + CFG. */
  steps?: number;
  cfgScale?: number;
  /** Pipeline family: zimage | flux2-klein | lens. */
  pipeline?: string;
  /** LoRA path + scale. */
  loraPath?: string;
  loraScale?: number;
  /** i2i / anime2real denoise strength. */
  denoiseStrength?: number;
  /** ControlNet type + strength (controlnet / i2i). */
  controlnetType?: string;
  controlnetStrength?: number;
  /** purify mode (purify|enhance|redraw) + resolution (same|2x|2160|...). */
  purifyMode?: string;
  resolution?: string | number;
  /** purify --backend (seedvr2 default | transformer). Forwarded as-is; the native purify_hybrid fork intercepts "transformer" requests before they ever reach here — see bridge.ts's isNativePurifyRequest. */
  backend?: string;
  /** --mask (inpaint: mask image, white=regenerate / black=keep). */
  mask?: string;
  /** --crop (inpaint: Union 2.1 crop-for-detail on the mask bbox). */
  crop?: boolean;
  /** --guidance (kontext CFG; also extraArg-allowed). */
  guidance?: number;
  /** --scheduler (kontext mflux scheduler). */
  scheduler?: string;
  /** --quantize (kontext MLX bits, default 8). */
  quantize?: number;
  /** --scenes (kontext certify mode: N differentiated in-context renders). */
  scenes?: number;
  /** --prompt-subject (kontext scenes mode subject description). */
  promptSubject?: string;
  /**
   * Pick a named image self-test fixture (image.py's unified selftest dispatcher).
   * `true` runs the action's bare self-test; a string runs one named fixture.
   */
  selfTest?: boolean | string;
}

export interface RunPyImageInput {
  options?: RunPyImageOptions;
  /**
   * Output dir override (passed as --gen-output-dir; run.py writes output_XXXX.*
   * + .manifest.json under cfg.OUTPUT_DIR by default, overridable here). When
   * omitted the adapter does NOT pass --gen-output-dir (run.py uses its default).
   */
  outputDir?: string;
  /** Escape-hatch raw tokens (validated against EXTRA_ARG_ALLOW_RUNPY_IMAGE). */
  extraArgs?: string[];
  /** Abort the run. */
  signal?: AbortSignal;
  /**
   * Test seam: inject a canned spawn result so unit tests can drive runPyImage
   * without the MLX venv. The real path resolves the venv python + run.py and
   * spawns `python run.py image ...` from the repo root (mirrors caption.ts).
   */
  _spawnImpl?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** One produced image file (from the manifest's output_files[]). */
export interface RunPyImageOutputFile {
  path: string;
  seed?: number;
  sizeBytes?: number;
  width?: number;
  height?: number;
}

/** The structured result. Shape-compatible with CaptionDetails so the bridge adapts it uniformly. */
export interface RunPyImageDetails {
  ok: boolean;
  /** "image <action>". */
  command: string;
  exitCode: number;
  aborted: boolean;
  /** Produced image paths (manifest output_files[], or globbed fallback). Empty on failure. */
  outputs: RunPyImageOutputFile[];
  /** Path to the parsed <base>.manifest.json (null if no sentinel / unreadable). */
  manifestPath: string | null;
  /** The manifest's status field ("success" | "error"); null when no manifest. */
  manifestStatus: string | null;
  /** Local transformer model id (manifest models.transformer basename), for the bridge `model` field. */
  model: string | null;
  /** Manifest-reported wall time (seconds); null when no manifest. */
  elapsedSeconds: number | null;
  /** Raw run.py stdout (kept whole; summarized separately). */
  stdout: string;
  /** Convenience flags for the gate criterion. */
  exitOk: boolean;
  imageExists: boolean;
}

export interface RunPyImageOutput {
  details: RunPyImageDetails;
  summary: string;
  stderrTail: string;
}

/**
 * Flags the agent may pass via extraArgs (escape hatch). Kept to the high-frequency
 * image flags NOT modeled in RunPyImageOptions, so the option surface stays small
 * while the full run.py image CLI remains reachable. Leading-dash tokens outside
 * this set are rejected (mirrors the runpy.ts video allowlist discipline).
 */
const EXTRA_ARG_ALLOW_RUNPY_IMAGE = new Set<string>([
  "help", "version", "json-summary", "draft", "ab-test", "variant",
  "prompt-file", "negative-prompt", "upscale", "upscale-method", "no-upscale",
  "list-loras", "lora-pipeline", "extra-lora", "extra-lora-scale",
  "transformer", "vae", "encoder", "scheduler", "guidance",
  "views", "base-prompt", "ratio", "elevations", "azimuth", "elevation",
  "mode", "server", "sam-prompt", "sam-threshold", "feather", "blend",
  "expand", "pixels", "aspect", "longest", "overlap",
  "subject", "fill-holes", "trim",
  "style-preset", "playbook", "strength",
  "style-anchor", "cutout-subject",
  "quantize", "scenes", "prompt-subject", "kontext-lock",
  "softness-override", "film-grain", "sharpening", "lut", "face-detail",
  "anime2real-ref-count", "anime2real-lora-scale",
  "prompt-a", "prompt-b", "merge-prompt", "merge-denoise",
  "char-a", "char-b", "ref-a", "ref-b", "candidates", "rounds", "style",
  "vlm-api-url", "vlm-model", "test-prompt", "quality-inputs", "inputs", "labels",
  "gen-output-dir", "models-dir", "self-test",
]);

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".bmp"];

/** camelCase option → kebab-case flag token list (only set fields contribute). */
export function buildImageArgs(opts: RunPyImageOptions, genOutputDir: string | null): string[] {
  const args: string[] = ["image"];

  // Positional action (default t2i — run.py's own default), then optional sub_action.
  const action = opts.action ?? "t2i";
  args.push(action);
  if (opts.subAction) args.push(opts.subAction);

  // --self-test short-circuits dispatch in run.py; emit it first for clarity.
  if (opts.selfTest != null && opts.selfTest !== false) {
    args.push("--self-test");
    if (typeof opts.selfTest === "string" && opts.selfTest) args.push(opts.selfTest);
  }

  if (opts.prompt != null) args.push("--prompt", String(opts.prompt));
  if (opts.inputImage != null) args.push("--input-image", opts.inputImage);
  if (opts.input != null) args.push("--input", opts.input);
  if (opts.face != null) args.push("--face", opts.face);
  if (opts.referenceImage != null) args.push("--reference-image", opts.referenceImage);
  if (opts.reference != null) args.push("--reference", opts.reference);
  if (opts.seed != null) args.push("--seed", String(opts.seed));
  if (opts.seedStart != null) args.push("--seed-start", String(opts.seedStart));
  if (opts.count != null) args.push("--count", String(opts.count));
  if (opts.width != null) args.push("--width", String(opts.width));
  if (opts.height != null) args.push("--height", String(opts.height));
  if (opts.steps != null) args.push("--steps", String(opts.steps));
  if (opts.cfgScale != null) args.push("--cfg-scale", String(opts.cfgScale));
  if (opts.pipeline != null) args.push("--pipeline", opts.pipeline);
  if (opts.loraPath != null) args.push("--lora-path", opts.loraPath);
  if (opts.loraScale != null) args.push("--lora-scale", String(opts.loraScale));
  if (opts.denoiseStrength != null) args.push("--denoise-strength", String(opts.denoiseStrength));
  if (opts.controlnetType != null) args.push("--controlnet-type", opts.controlnetType);
  if (opts.controlnetStrength != null) args.push("--controlnet-strength", String(opts.controlnetStrength));
  if (opts.purifyMode != null) args.push("--purify-mode", opts.purifyMode);
  if (opts.resolution != null) args.push("--resolution", String(opts.resolution));
  if (opts.backend != null) args.push("--backend", opts.backend);
  if (opts.mask != null) args.push("--mask", opts.mask);
  if (opts.crop) args.push("--crop");
  // Kontext-specific (FLUX.1-Kontext-dev in-context re-render).
  if (opts.guidance != null) args.push("--guidance", String(opts.guidance));
  if (opts.scheduler != null) args.push("--scheduler", opts.scheduler);
  if (opts.quantize != null) args.push("--quantize", String(opts.quantize));
  if (opts.scenes != null) args.push("--scenes", String(opts.scenes));
  if (opts.promptSubject != null) args.push("--prompt-subject", opts.promptSubject);

  if (genOutputDir) args.push("--gen-output-dir", genOutputDir);
  return args;
}

/**
 * Parse the manifest path from run.py's sentinel. run_session prints
 * `Manifest:   <path>` to stdout on success and `Manifest (error): <path>` to
 * stderr on failure (app/commands/_shared.py:212,233). Some sub-actions also print
 * a bare `Manifest:   <path>` (faceswap writes its own, image-faceswap.py:482).
 * Last match wins (it prints once at the end). Returns null if no sentinel fired.
 */
export function manifestPathFromOutput(stdout: string, stderr: string): string | null {
  const combined = `${stdout}\n${stderr}`;
  const lines = combined.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(/^Manifest(?:\s+\(error\))?:\s+(.+)$/);
    if (m) return m[1]!.trim();
  }
  return null;
}

/**
 * Newest image in `dir` (recursively) by mtime. Fallback for sub-actions that do
 * not use run_session (so they print no manifest sentinel) — we still know
 * --gen-output-dir. Recursive because several run.py image sub-actions write to
 * a subfolder (profile → output/profile_<stamp>/, workflow → output/workflow_<stamp>/),
 * so a flat top-level glob would miss them. Bounded by a depth guard so an
 * arbitrarily deep output tree can't blow the stack.
 */
function newestImage(dir: string): string | null {
  if (!dir || !existsSync(dir)) return null;
  let best: { path: string; mtime: number } | null = null;
  const stack: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
  while (stack.length) {
    const { dir: cur, depth } = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const path = join(cur, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory() && depth < 8) {
        stack.push({ dir: path, depth: depth + 1 });
        continue;
      }
      if (!st.isFile()) continue;
      const lower = name.toLowerCase();
      if (!IMAGE_EXTS.some((ext) => lower.endsWith(ext))) continue;
      if (!best || st.mtimeMs > best.mtime) best = { path, mtime: st.mtimeMs };
    }
  }
  return best?.path ?? null;
}

/** Parse a .manifest.json into the fields the adapter needs; null if unreadable/absent. */
export function readImageManifest(path: string): {
  status: string;
  outputs: RunPyImageOutputFile[];
  model: string | null;
  elapsedSeconds: number | null;
} | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;

  const status = typeof data.status === "string" ? data.status : "unknown";
  const rawFiles = Array.isArray(data.output_files) ? (data.output_files as Array<Record<string, unknown>>) : [];
  const outputs: RunPyImageOutputFile[] = rawFiles
    .map((o) => ({
      path: typeof o.path === "string" ? (o.path as string) : "",
      seed: typeof o.seed === "number" ? (o.seed as number) : undefined,
      sizeBytes: typeof o.size_bytes === "number" ? (o.size_bytes as number) : undefined,
      width: typeof o.width === "number" ? (o.width as number) : undefined,
      height: typeof o.height === "number" ? (o.height as number) : undefined,
    }))
    .filter((o) => o.path.length > 0);

  // models.transformer.path is the local transformer's model.safetensors file
  // (collect_model_fingerprint: <tf_dir>/model.safetensors). The meaningful id is
  // the parent dir name (e.g. "moody-pro-mix", "flux2-klein"); fall back to the
  // file basename for any non-standard shape.
  const models = (data.models && typeof data.models === "object" ? (data.models as Record<string, unknown>) : {});
  const transformer = (models.transformer && typeof models.transformer === "object"
    ? (models.transformer as Record<string, unknown>)
    : {});
  const tfPath = typeof transformer.path === "string" ? (transformer.path as string) : null;
  let model: string | null = null;
  if (tfPath) {
    const fileBase = basename(tfPath);
    model = fileBase.toLowerCase() === "model.safetensors" ? basename(dirname(tfPath)) : fileBase;
  }

  const elapsedSeconds = typeof data.elapsed_seconds === "number" ? (data.elapsed_seconds as number) : null;
  return { status, outputs, model, elapsedSeconds };
}

/** Validate extraArgs: every leading-dash token must be in the allowlist. Throws on a violation. */
export function validateImageExtraArgs(args: string[]): string[] {
  for (const tok of args) {
    if (tok.startsWith("-") && !EXTRA_ARG_ALLOW_RUNPY_IMAGE.has(tok.replace(/^(-)+/, ""))) {
      throw new Error(`runpy_image: extraArg "${tok}" is not in the allowlist (EXTRA_ARG_ALLOW_RUNPY_IMAGE)`);
    }
  }
  return args;
}

function buildDetails(
  res: { stdout: string; stderr: string; exitCode: number },
  genOutputDir: string | null,
  command: string,
): RunPyImageDetails {
  const exitOk = res.exitCode === 0;
  const manifestPath = manifestPathFromOutput(res.stdout, res.stderr);
  const parsed = manifestPath ? readImageManifest(manifestPath) : null;

  // Prefer manifest output_files; fall back to globbing the newest image when the
  // sub-action wrote no manifest sentinel (and we know the output dir).
  let outputs = parsed?.outputs ?? [];
  if (outputs.length === 0 && exitOk && genOutputDir) {
    const glob = newestImage(genOutputDir);
    if (glob) outputs = [{ path: glob }];
  }
  const imageExists = outputs.some((o) => existsSync(o.path));

  // ok = run.py exited 0 AND (a manifest reported success OR a real image landed).
  // A 0-exit run with no image (e.g. a --list-loras / review-only dispatch) is NOT
  // a generation success — mirrors adaptRunPy's "0-exit review/empty run ≠ success".
  const ok = exitOk && ((parsed?.status === "success" && imageExists) || (!parsed && imageExists));

  return {
    ok,
    command,
    exitCode: res.exitCode,
    aborted: false,
    outputs,
    manifestPath,
    manifestStatus: parsed?.status ?? null,
    model: parsed?.model ?? null,
    elapsedSeconds: parsed?.elapsedSeconds ?? null,
    stdout: res.stdout,
    exitOk,
    imageExists,
  };
}

function summarize(d: RunPyImageDetails): string {
  if (d.aborted) return `${d.command}: aborted`;
  if (!d.exitOk) return `${d.command}: run.py exited ${d.exitCode}`;
  if (!d.imageExists) {
    return `${d.command}: run.py exited 0 but produced no image (review/list-only run?)`;
  }
  const n = d.outputs.length;
  const xfmr = d.model ? ` [${d.model}]` : "";
  const first = d.outputs[0]?.path ?? "(none)";
  return n === 1 ? `${d.command}: ✓ ${first}${xfmr}` : `${d.command}: ✓ ${n} images (${first}, …)${xfmr}`;
}

function stderrTailOf(res: { stderr: string }): string {
  return res.stderr
    .split("\n")
    .filter((l) => l.trim())
    .slice(-8)
    .join("\n");
}

/** Real spawn: resolve the MLX venv python + run.py, spawn from the repo root. */
async function defaultSpawn(
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const repoRoot = resolveRepoRoot();
  const { python, runPy } = resolveRunPyPaths(repoRoot);
  const proc = Bun.spawn({
    cmd: [python, runPy, ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  // Bun auto-drains pipes (Node would deadlock) — safe to await both then exit.
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/**
 * Run `python/venv/bin/python run.py image <action> ...` end-to-end. Resolves with
 * structured details + summary. Non-zero run.py exit is NOT an exception — it
 * surfaces as details.ok=false. Throws only on extraArgs validation failure.
 */
export async function runPyImage(input: RunPyImageInput): Promise<RunPyImageOutput> {
  const options = input.options ?? {};
  const extraArgs = validateImageExtraArgs(input.extraArgs ?? []);
  const args = [...buildImageArgs(options, input.outputDir ?? null), ...extraArgs];

  const spawnFn = input._spawnImpl ?? ((a: string[]) => defaultSpawn(a, input.signal));

  let res: { stdout: string; stderr: string; exitCode: number };
  try {
    res = await spawnFn(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const details: RunPyImageDetails = {
      ok: false,
      command: `image ${options.action ?? "t2i"}`,
      exitCode: 1,
      aborted: false,
      outputs: [],
      manifestPath: null,
      manifestStatus: null,
      model: null,
      elapsedSeconds: null,
      stdout: "",
      exitOk: false,
      imageExists: false,
    };
    return { details, summary: `image spawn failed: ${msg}`, stderrTail: msg };
  }

  const command = `image ${options.action ?? "t2i"}`;
  const details = buildDetails(res, input.outputDir ?? null, command);
  return { details, summary: summarize(details), stderrTail: stderrTailOf(res) };
}
