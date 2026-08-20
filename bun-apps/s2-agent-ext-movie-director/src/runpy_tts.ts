/**
 * runpy_tts.ts — the run.py TTS adapter (natural-voice narration via edge-tts).
 *
 * Shells `run.py tts --text <t> --voice <v> --output <path>` (app/commands/tts.py,
 * a thin wrapper around Microsoft's edge-tts library — the same engine `run.py
 * video relay --relay-tts-engine edge-tts` already uses internally, now exposed as
 * its own top-level command so movie-director can synthesize narration without
 * pulling in the full relay pipeline).
 *
 * Unlike macOS `say` (movie-director's prior only TTS provider — free, offline,
 * but robotic AVSpeechSynthesizer output), edge-tts produces natural-sounding
 * neural voices at near-zero generation cost (~1s for a 10s narration on this
 * measured hardware) — but it needs NETWORK EGRESS (Microsoft's edge-tts
 * service), so it is NOT available under --offline; callers should fall back to
 * `say` in that mode (see registry.ts's `say_tts` provider notes).
 *
 * The caller always passes an explicit `--output` path (this adapter's whole
 * point is deterministic narration asset paths inside a project's assets/ dir),
 * so no manifest-sentinel parsing is needed — `ok` is simply "exit 0 AND the
 * requested file landed on disk with nonzero size", mirroring caption.ts's
 * "0-exit-but-nothing-written is NOT success" stance.
 *
 * LOCAL SPAWN, CLOUD SERVICE: the python process itself is local (python/venv on
 * Apple Silicon), but edge-tts's synthesis call goes out to Microsoft's service —
 * this is the one movie-director provider that is not fully local-silicon.
 */
import { existsSync, statSync } from "node:fs";
import { resolveRepoRoot, resolveRunPyPaths } from "@repo/s2-agent-ext-ltx";

export interface RunPyTtsOptions {
  /** Narration text (required). */
  text: string;
  /** edge-tts voice id. Default (run.py's own default): en-US-AriaNeural. */
  voice?: string;
  /** Speech rate as a signed percentage string, e.g. "-10%", "+15%". Default "+0%". */
  rate?: string;
}

export interface RunPyTtsInput {
  options: RunPyTtsOptions;
  /** Output audio path (required — always passed as --output for a deterministic asset path). */
  output: string;
  signal?: AbortSignal;
  /**
   * Test seam: inject a canned spawn result so unit tests can drive runPyTts
   * without the MLX venv / network egress. The real path resolves the venv
   * python + run.py and spawns `python run.py tts ...` from the repo root.
   */
  _spawnImpl?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface RunPyTtsDetails {
  ok: boolean;
  command: "tts";
  exitCode: number;
  aborted: boolean;
  /** The requested output path (echoed back; null only on a spawn-level failure before any path was known). */
  output: string | null;
  sizeBytes: number | null;
  voice: string | null;
  stdout: string;
}

export interface RunPyTtsOutput {
  details: RunPyTtsDetails;
  summary: string;
  stderrTail: string;
}

/** Build the run.py argv tail (everything after `python run.py`). */
export function buildTtsArgs(opts: RunPyTtsOptions, output: string): string[] {
  const args: string[] = ["tts", "--text", opts.text, "--output", output];
  if (opts.voice) args.push("--voice", opts.voice);
  if (opts.rate) args.push("--rate", opts.rate);
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

/** Run `run.py tts` and normalize the result into details + summary. */
export async function runPyTts(input: RunPyTtsInput): Promise<RunPyTtsOutput> {
  const args = buildTtsArgs(input.options, input.output);
  const spawnFn = input._spawnImpl ?? ((a: string[]) => defaultSpawn(a, input.signal));

  let res: { stdout: string; stderr: string; exitCode: number };
  try {
    res = await spawnFn(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const details: RunPyTtsDetails = {
      ok: false,
      command: "tts",
      exitCode: 1,
      aborted: false,
      output: null,
      sizeBytes: null,
      voice: null,
      stdout: "",
    };
    return { details, summary: `tts spawn failed: ${msg}`, stderrTail: msg };
  }

  const exists = existsSync(input.output);
  const sizeBytes = exists ? statSync(input.output).size : 0;
  // ok = run.py exited 0 AND the requested audio file actually landed with real
  // content — a 0-exit run that wrote nothing (or an empty file) is NOT success.
  const ok = res.exitCode === 0 && exists && sizeBytes > 0;
  const details: RunPyTtsDetails = {
    ok,
    command: "tts",
    exitCode: res.exitCode,
    aborted: false,
    output: exists ? input.output : null,
    sizeBytes: exists ? sizeBytes : null,
    voice: input.options.voice ?? null,
    stdout: res.stdout,
  };
  const summary = ok
    ? `tts ✓ edge-tts (${details.voice ?? "default voice"}) → ${input.output}`
    : `tts FAILED (exit ${res.exitCode})`;
  const stderrTail = res.stderr
    .split("\n")
    .filter((l) => l.trim())
    .slice(-5)
    .join("\n");
  return { details, summary, stderrTail };
}
