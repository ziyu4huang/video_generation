/**
 * runpy_lipsync.ts — the `python -m app.lipsync_metrics` adapter (mouth-motion
 * vs. audio-loudness correlation for a talking-head video).
 *
 * `lipsync_metrics.py` is a MODULE, not a run.py subcommand (its own
 * `__main__` block: `python -m app.lipsync_metrics <mp4_path>`, printing
 * `json.dumps(result, indent=2)` to stdout) — so this spawns the venv python
 * directly with `-m`, from `python/mlx-movie-director` as cwd (required for
 * the `app.` import to resolve), rather than going through run.py like
 * runpy_tts.ts / runpy_image.ts do.
 *
 * Unlike runpy_tts's best-effort posture (which protects an already-succeeded
 * generation), evaluation IS the point here — callers get a real {ok, error}
 * on any failure, nothing is swallowed at this layer.
 */
import { join } from "node:path";
import { resolveRepoRoot, resolveRunPyPaths } from "@repo/pi-agent-ext-ltx";

export interface LipsyncMetrics {
  verdict: string;
  pearson_r: number | null;
  mouth_ratio_std: number | null;
  caveat?: string;
}

export interface RunPyLipsyncInput {
  videoPath: string;
  signal?: AbortSignal;
  /**
   * Test seam: inject a canned spawn result so unit tests can drive
   * runPyLipsync without the MLX venv. The real path resolves the venv
   * python and spawns `python -m app.lipsync_metrics <videoPath>` from
   * python/mlx-movie-director.
   */
  _spawnImpl?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface RunPyLipsyncOutput {
  ok: boolean;
  metrics: LipsyncMetrics | null;
  error: string | null;
  stderrTail: string;
}

async function defaultSpawn(
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const repoRoot = resolveRepoRoot();
  const { python } = resolveRunPyPaths(repoRoot);
  const cwd = join(repoRoot, "python", "mlx-movie-director");
  const proc = Bun.spawn({
    cmd: [python, ...args],
    cwd,
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

/** Run `python -m app.lipsync_metrics <videoPath>` and parse its JSON stdout. */
export async function runPyLipsync(input: RunPyLipsyncInput): Promise<RunPyLipsyncOutput> {
  const args = ["-m", "app.lipsync_metrics", input.videoPath];
  const spawnFn = input._spawnImpl ?? ((a: string[]) => defaultSpawn(a, input.signal));

  let res: { stdout: string; stderr: string; exitCode: number };
  try {
    res = await spawnFn(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, metrics: null, error: `lipsync_metrics spawn failed: ${msg}`, stderrTail: "" };
  }

  const stderrTail = res.stderr.slice(-2000);
  if (res.exitCode !== 0) {
    return { ok: false, metrics: null, error: `lipsync_metrics exited ${res.exitCode}`, stderrTail };
  }

  try {
    const metrics = JSON.parse(res.stdout) as LipsyncMetrics;
    return { ok: true, metrics, error: null, stderrTail };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, metrics: null, error: `lipsync_metrics produced non-JSON stdout: ${msg}`, stderrTail };
  }
}
