/**
 * music_native.ts — the Bun-native musicgen adapter, calling the compiled
 * `musicgen` Swift binary (swift/musicgen-director) instead of shelling
 * `run.py music` (a Python wrapper around mlx-audiocraft's MusicGen). Same
 * migration shape as tts_native.ts's 2026-07-13 edge-tts move, except the
 * "native" side here is a real compiled MLX binary (ensureBinary(), same
 * pattern as s2-agent-ext-flux2/s2-agent-ext-ltx), not a pure-JS library —
 * this is the from-scratch Swift/MLX MusicGen-small port (T5 text encoder +
 * 24-layer LM decoder + EnCodec-32kHz decode), numerically verified against
 * the Python reference layer-by-layer (all cos>=0.99).
 *
 * Reuses runpy_music.ts's RunPyMusicOptions/RunPyMusicDetails/RunPyMusicOutput
 * shapes exactly (same fields) so bridge.ts's existing adaptRunPyMusic
 * ToolResult adapter works unchanged for this provider too — see
 * bridge.ts's realMusicNative.
 */
import { existsSync, statSync } from "node:fs";
import { ensureBinary, resolveRepoRoot } from "./musicgen_binary.ts";
import type { RunPyMusicOptions, RunPyMusicDetails, RunPyMusicOutput } from "./runpy_music.ts";

export interface MusicNativeInput {
  options: RunPyMusicOptions;
  /** Output audio path (required — always passed as --output for a deterministic asset path). */
  output: string;
  signal?: AbortSignal;
  /** Test seam: inject a canned spawn result so unit tests don't need a built binary. */
  _spawnImpl?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/**
 * Build the argv tail for `musicgen generate` from RunPyMusicOptions. Mirrors
 * runpy_music.ts's buildMusicArgs, minus --model: the Swift CLI only ships
 * MusicGen-small (see swift/musicgen-director's design spec's Scope section)
 * so opts.model (a HF model id like facebook/musicgen-medium) has no v1
 * equivalent and is intentionally not passed through.
 */
export function buildMusicNativeArgs(opts: RunPyMusicOptions, output: string): string[] {
  const args: string[] = ["generate", "--prompt", opts.prompt, "--output", output];
  if (opts.duration != null) args.push("--duration", String(opts.duration));
  return args;
}

/**
 * Real spawn: resolve/build the musicgen Swift binary, spawn `musicgen
 * generate ...` with cwd=repoRoot. The binary's --model-dir default is a
 * path RELATIVE to its cwd (mlx-models/musicgen/musicgen-small) — without
 * pinning cwd to the repo root, that default resolves against wherever this
 * Bun process happens to be running from and fails to find the checkpoint
 * (mirrors runpy_music.ts's defaultSpawn / s2-agent-ext-ltx's invoke.ts, both
 * of which also spawn with cwd: repoRoot for the same reason).
 */
async function defaultSpawn(
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const bin = await ensureBinary();
  const proc = Bun.spawn({
    cmd: [bin, ...args],
    cwd: resolveRepoRoot(),
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

/** Run `musicgen generate` and normalize into the SAME details/summary shape runpy_music.ts produces. */
export async function runMusicNative(input: MusicNativeInput): Promise<RunPyMusicOutput> {
  const args = buildMusicNativeArgs(input.options, input.output);
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
  // ok = the binary exited 0 AND the requested audio file actually landed with
  // real content — mirrors runPyMusic's "0-exit but nothing written is NOT
  // success" stance.
  const ok = res.exitCode === 0 && exists && sizeBytes > 0;
  const details: RunPyMusicDetails = {
    ok,
    command: "music",
    exitCode: res.exitCode,
    aborted: false,
    output: exists ? input.output : null,
    sizeBytes: exists ? sizeBytes : null,
    model: "musicgen-small",
    duration: input.options.duration ?? null,
    stdout: res.stdout,
  };
  const summary = ok
    ? `music ✓ MusicGen-small (Swift native) → ${input.output}`
    : `music FAILED (exit ${res.exitCode})`;
  const stderrTail = res.stderr
    .split("\n")
    .filter((l) => l.trim())
    .slice(-5)
    .join("\n");
  return { details, summary, stderrTail };
}
