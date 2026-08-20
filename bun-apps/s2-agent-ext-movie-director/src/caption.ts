/**
 * caption.ts — the run.py caption adapter (the local VLM analysis tier).
 *
 * Shells `run.py caption <image> --style <s...> --lang <l>` — which resolves the
 * default gemma brain (Qwen3-VL only as the no-gemma fallback; see
 * app/commands/caption.py `_resolve_model`) — and reads the produced
 * `<image>.caption.json`. This is the explicit, callable replacement for
 * OpenMontage's "orchestrator-LLM-is-the-vision-model" assumption: the
 * s2-agent subagent calls the local VLM via this tool instead of assuming the
 * orchestrator is multimodal. Mirrors runPyVideo()'s shape (details + summary +
 * stderrTail) so the movie-director bridge adapts it into the same ToolResult.
 *
 * LOCAL ONLY: run.py + python/venv on Apple Silicon. Never a cloud VLM call —
 * the only HTTP it induces is to the local LM Studio (localhost:1234).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolveRepoRoot, resolveRunPyPaths } from "@repo/s2-agent-ext-ltx";

/** Options passed through to the caption path (camelCase). The input `image` may
 * be an image OR a video file (video is detected by extension → keyframe path). */
export interface CaptionOptions {
  /** Input image OR video path (required). Video ext (.mp4/.mov/...) → keyframe captioning. */
  image: string;
  /** Caption style(s): default / t2i / photography / profile / style / score / review /
   *  video_score / video_analysis / compare / playwright / lora_quality / ltx_i2v / pose_dsg.
   *  Default = t2i. */
  style?: string | string[];
  /** Output language: zh_TW | zh_CN | en | ja. Default = zh_TW. */
  lang?: string;
  /** Explicit VLM id override; if omitted, auto-resolves (loaded gemma brain). */
  model?: string;
  /** Skip the LM Studio auto-load probe (assume the model is already loaded). */
  noAutoLoad?: boolean;
  /** Original T2I prompt (required by 'review' and 'pose_dsg' styles). */
  prompt?: string;
  /** Run N independent VLM samples and write the per-dimension MEDIAN (score-family
   *  denoising; ignored for pose_dsg and video). Default 1. */
  samples?: number;
  /** 'ltx_i2v' action intent text (required by 'ltx_i2v'). */
  action?: string;
  /** LoRA name (used by 'lora_quality'). */
  loraName?: string;
  /** LoRA description (used by 'lora_quality'). */
  loraDescription?: string;
  /** LoRA scale applied (used by 'lora_quality'). */
  loraScale?: number | string;
  /** pose_dsg atoms: path to or inline JSON of {atoms:[{id,q}]} (optional; VLM self-decomposes if absent). */
  atoms?: string;
  /** Number of keyframes to extract for video captioning (default 8). */
  frames?: number;
}

export interface CaptionDetails {
  ok: boolean;
  command: "caption";
  exitCode: number;
  aborted: boolean;
  /** Path to the produced <image>.caption.json (null if run.py wrote nothing). */
  captionPath: string | null;
  /** Resolved VLM model recorded in the caption JSON (the local gemma brain). */
  model: string | null;
  /** Style keys present in the caption JSON (["score"], ["t2i","score"], ...). */
  styles: string[];
  /** Caption text (string for single-style; JSON-stringified styles map for multi). */
  text: string | null;
  /** Raw run.py stdout (kept whole; summarized separately). */
  stdout: string;
}

export interface CaptionOutput {
  details: CaptionDetails;
  summary: string;
  stderrTail: string;
}

export interface CaptionInput {
  options: CaptionOptions;
  signal?: AbortSignal;
  /**
   * Test seam: inject a canned spawn result so unit tests can drive runPyCaption
   * without the MLX venv / LM Studio. The real path resolves the venv python +
   * run.py and spawns `python run.py caption ...` from the repo root.
   */
  _spawnImpl?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** Build the run.py argv tail (everything after `python run.py`). */
export function buildCaptionArgs(opts: CaptionOptions): string[] {
  const args: string[] = ["caption", opts.image];
  const styles = Array.isArray(opts.style)
    ? opts.style
    : opts.style
      ? [opts.style]
      : [];
  if (styles.length) args.push("--style", ...styles);
  if (opts.lang) args.push("--lang", opts.lang);
  if (opts.model) args.push("--model", opts.model);
  if (opts.noAutoLoad) args.push("--no-auto-load");
  if (opts.prompt) args.push("--prompt", opts.prompt);
  return args;
}

/**
 * run.py writes <stem>.caption.json beside the input, where <stem> is the image
 * path with its extension stripped (mirrors caption.py's
 * `os.path.splitext(image_file)[0] + ".caption.json"`). e.g. "/x/y.png" →
 * "/x/y.caption.json" (NOT "/x/y.png.caption.json").
 */
export function captionPathFor(image: string): string {
  const dot = image.lastIndexOf(".");
  const slash = Math.max(image.lastIndexOf("/"), image.lastIndexOf("\\"));
  // Only strip a dot that's part of the filename (after the last separator).
  const stem = dot > slash ? image.slice(0, dot) : image;
  return `${stem}.caption.json`;
}

/** Parse a .caption.json into {model, styles, text}; null if unreadable/absent. */
export function readCaption(
  path: string,
): { model: string | null; styles: string[]; text: string | null } | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const stylesMap =
    data.styles && typeof data.styles === "object" ? Object.keys(data.styles as object) : [];
  const model = typeof data.model === "string" ? data.model : null;

  let text: string | null = null;
  if (stylesMap.length > 1) {
    text = JSON.stringify(data.styles);
  } else if (stylesMap.length === 1) {
    const entry = (data.styles as Record<string, unknown>)[stylesMap[0]!];
    text = typeof entry === "string" ? entry : JSON.stringify(entry);
  } else if (data.caption !== undefined) {
    text = typeof data.caption === "string" ? (data.caption as string) : JSON.stringify(data.caption);
  }
  // Single-style files carry the top-level `style` key; multi-style carry `styles`.
  const styleKey = typeof data.style === "string" ? [data.style as string] : [];
  return { model, styles: stylesMap.length ? stylesMap : styleKey, text };
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

/** Run `run.py caption` and normalize the result into details + summary. */
export async function runPyCaption(input: CaptionInput): Promise<CaptionOutput> {
  const args = buildCaptionArgs(input.options);
  const spawnFn = input._spawnImpl ?? ((a: string[]) => defaultSpawn(a, input.signal));

  let res: { stdout: string; stderr: string; exitCode: number };
  try {
    res = await spawnFn(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const details: CaptionDetails = {
      ok: false,
      command: "caption",
      exitCode: 1,
      aborted: false,
      captionPath: null,
      model: null,
      styles: [],
      text: null,
      stdout: "",
    };
    return { details, summary: `caption spawn failed: ${msg}`, stderrTail: msg };
  }

  const captionPath = captionPathFor(input.options.image);
  const exists = existsSync(captionPath);
  const parsed = exists ? readCaption(captionPath) : null;
  // ok = run.py exited 0 AND the caption JSON actually landed + parsed. A 0-exit
  // run that wrote no JSON is NOT a captioning success (mirrors adaptRunPy's
  // "0-exit review/empty run is NOT success" stance).
  const ok = res.exitCode === 0 && parsed != null;
  const details: CaptionDetails = {
    ok,
    command: "caption",
    exitCode: res.exitCode,
    aborted: false,
    captionPath: exists ? captionPath : null,
    model: parsed?.model ?? null,
    styles: parsed?.styles ?? [],
    text: parsed?.text ?? null,
    stdout: res.stdout,
  };
  const summary = ok
    ? `caption ✓ ${details.styles.join(",") || "t2i"} → ${captionPath} [${details.model}]`
    : `caption FAILED (exit ${res.exitCode})`;
  const stderrTail = res.stderr
    .split("\n")
    .filter((l) => l.trim())
    .slice(-5)
    .join("\n");
  return { details, summary, stderrTail };
}
