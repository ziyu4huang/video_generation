/**
 * runpy_music.ts — the run.py music adapter (local MLX MusicGen via mlx-audiocraft).
 *
 * Shells `run.py music --prompt <p> --output <path> [--duration <s>] [--model <m>]`
 * (app/commands/music.py, a wrapper around Meta's MusicGen running on Apple
 * Silicon via the mlx-audiocraft port — the first full AudioCraft port for
 * M-series Macs, no CUDA). This is movie-director's music SOURCE provider: it
 * produces the royalty-free audio file that `edit.audio.music.src` points at,
 * which compose-motion's `amix` pass then mixes under the narration
 * (src/compose_motion.ts:mixAudioOnto).
 *
 * Fully local-silicon + open-source + free: no network egress at generation time
 * (the model downloads once from HuggingFace, then runs on-device), no API key,
 * no cloud. MusicGen weights are CC-BY-4.0 — attribution to Meta/MusicGen is
 * recorded in publish_log by the caller (the license itself imposes no fee).
 *
 * This inverts the earlier royalty-free-STOCK-via-network decision (Pixabay) in
 * favor of local GENERATIVE music, matching the repo's native-MLX/offline posture
 * and the user's "MLX + open-source + free" constraint. See ticket 01's revision
 * note + ticket 04.
 *
 * The caller always passes an explicit `--output` path (deterministic asset path
 * inside a project's assets/ dir), so `ok` is simply "exit 0 AND the requested
 * file landed on disk with nonzero size" — mirroring runpy_tts's "0-exit-but-
 * nothing-written is NOT success" stance.
 */
import { existsSync, statSync } from "node:fs";
import { resolveRepoRoot, resolveRunPyPaths } from "@repo/s2-agent-ext-ltx";

export interface RunPyMusicOptions {
  /** Music description prompt — mood/genre/instruments (required). */
  prompt: string;
  /** Target duration in seconds (default: run.py's own default, ~30). */
  duration?: number;
  /**
   * MusicGen model id (default: run.py's own default, facebook/musicgen-small).
   * Override via MD_MUSICGEN_MODEL. Larger models (medium/large/melody) raise
   * quality + VRAM; small is the safe default on Apple Silicon.
   */
  model?: string;
}

export interface RunPyMusicInput {
  options: RunPyMusicOptions;
  /** Output audio path (required — always passed as --output for a deterministic asset path). */
  output: string;
  signal?: AbortSignal;
  /**
   * Test seam: inject a canned spawn result so unit tests can drive runPyMusic
   * without the MLX venv / model download. The real path resolves the venv
   * python + run.py and spawns `python run.py music ...` from the repo root.
   */
  _spawnImpl?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface RunPyMusicDetails {
  ok: boolean;
  command: "music";
  exitCode: number;
  aborted: boolean;
  /** The requested output path (echoed back; null only on a spawn-level failure before any path was known). */
  output: string | null;
  sizeBytes: number | null;
  model: string | null;
  duration: number | null;
  stdout: string;
}

export interface RunPyMusicOutput {
  details: RunPyMusicDetails;
  summary: string;
  stderrTail: string;
}

/** Build the run.py argv tail (everything after `python run.py`). */
export function buildMusicArgs(opts: RunPyMusicOptions, output: string): string[] {
  const args: string[] = ["music", "--prompt", opts.prompt, "--output", output];
  if (opts.duration != null) args.push("--duration", String(opts.duration));
  if (opts.model) args.push("--model", opts.model);
  return args;
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
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/** Run `run.py music` and normalize the result into details + summary. */
export async function runPyMusic(input: RunPyMusicInput): Promise<RunPyMusicOutput> {
  const args = buildMusicArgs(input.options, input.output);
  const spawnFn = input._spawnImpl ?? ((a: string[]) => defaultSpawn(a, input.signal));

  let res: { stdout: string; stderr: string; exitCode: number };
  try {
    res = await spawnFn(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const details: RunPyMusicDetails = {
      ok: false,
      command: "music",
      exitCode: 1,
      aborted: false,
      output: null,
      sizeBytes: null,
      model: null,
      duration: null,
      stdout: "",
    };
    return { details, summary: `music spawn failed: ${msg}`, stderrTail: msg };
  }

  const exists = existsSync(input.output);
  const sizeBytes = exists ? statSync(input.output).size : 0;
  // ok = run.py exited 0 AND the requested audio file actually landed with real
  // content — a 0-exit run that wrote nothing (or an empty file) is NOT success.
  const ok = res.exitCode === 0 && exists && sizeBytes > 0;
  const details: RunPyMusicDetails = {
    ok,
    command: "music",
    exitCode: res.exitCode,
    aborted: false,
    output: exists ? input.output : null,
    sizeBytes: exists ? sizeBytes : null,
    model: input.options.model ?? null,
    duration: input.options.duration ?? null,
    stdout: res.stdout,
  };
  const summary = ok
    ? `music ✓ MusicGen (${details.model ?? "default model"}) → ${input.output}`
    : `music FAILED (exit ${res.exitCode})`;
  const stderrTail = res.stderr
    .split("\n")
    .filter((l) => l.trim())
    .slice(-5)
    .join("\n");
  return { details, summary, stderrTail };
}
