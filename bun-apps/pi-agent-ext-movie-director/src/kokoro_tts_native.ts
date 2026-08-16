/**
 * kokoro_tts_native.ts — the Bun-native Kokoro TTS adapter, calling the
 * compiled `kokoro-tts` Swift binary (swift/musicgen-director's KokoroTTSCLI
 * target) — wiring mlx-audio-swift's already-implemented Kokoro model, NOT a
 * from-scratch port (see .planning/specs/2026-08-01-kokoro-tts-swift-
 * native-port-design.md). Same shape as music_native.ts's ensureBinary()/
 * spawn pattern.
 *
 * Reuses runpy_tts.ts's RunPyTtsDetails/RunPyTtsOutput shapes exactly (same
 * fields, command:"tts") so bridge.ts's existing adaptRunPyTts-style artifact
 * shape stays consistent across all three tts providers (runpy/edge-tts/
 * kokoro) — but KokoroTtsOptions is its OWN new type: Kokoro's voice
 * namespace (af_heart, am_michael, zf_xiaobei, zm_yunjian, etc.) and --speed
 * float are unrelated to edge-tts's RunPyTtsOptions (voice id +
 * rate-as-percentage-string), so
 * reusing that options type would misrepresent the contract.
 */
import { existsSync, statSync } from "node:fs";
import { ensureBinary, resolveRepoRoot } from "./kokoro_binary.ts";
import type { RunPyTtsDetails, RunPyTtsOutput } from "./runpy_tts.ts";

export interface KokoroTtsOptions {
  /** Narration text (required). */
  text: string;
  /** Kokoro voice id, e.g. af_heart, am_michael, zf_xiaobei, zm_yunjian (required — no default). */
  voice: string;
  /** Speech speed multiplier (Kokoro's native parameter — NOT edge-tts's rate-as-percentage-string). */
  speed?: number;
  /** mlx-audio-swift model repo id. Default (the CLI's own default): mlx-community/Kokoro-82M-bf16. */
  modelRepo?: string;
}

export interface KokoroTtsInput {
  options: KokoroTtsOptions;
  /** Output audio path (required — always passed as --output for a deterministic asset path). */
  output: string;
  signal?: AbortSignal;
  /** Test seam: inject a canned spawn result so unit tests don't need a built binary. */
  _spawnImpl?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** Build the argv tail for `kokoro-tts generate` from KokoroTtsOptions. */
export function buildKokoroTtsArgs(opts: KokoroTtsOptions, output: string): string[] {
  const args: string[] = ["generate", "--text", opts.text, "--voice", opts.voice, "--output", output];
  if (opts.speed != null) args.push("--speed", String(opts.speed));
  if (opts.modelRepo != null) args.push("--model-repo", opts.modelRepo);
  return args;
}

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

/** Run `kokoro-tts generate` and normalize into the RunPyTtsDetails/Output shape. */
export async function runKokoroTtsNative(input: KokoroTtsInput): Promise<RunPyTtsOutput> {
  // KokoroTtsOptions.voice is typed as a required string, but callers following
  // the generic {text, voice?, rate?, output?} tts contract (where voice really
  // is optional for say/edge-tts) can still omit it at runtime — without this
  // guard, `undefined` would be pushed into argv, Bun.spawn would stringify it
  // to the literal "undefined", and the failure would surface as a confusing
  // error deep inside Kokoro's voice lookup instead of a clean message here.
  if (!input.options.voice || input.options.voice.trim() === "") {
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
    const msg =
      "kokoro tts: voice is required (e.g. af_heart, am_michael, zf_xiaobei, zm_yunjian) — no default across English/Mandarin namespaces";
    return { details, summary: msg, stderrTail: "" };
  }

  const args = buildKokoroTtsArgs(input.options, input.output);
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
    return { details, summary: `kokoro tts spawn failed: ${msg}`, stderrTail: msg };
  }

  const exists = existsSync(input.output);
  const sizeBytes = exists ? statSync(input.output).size : 0;
  const ok = res.exitCode === 0 && exists && sizeBytes > 0;
  const details: RunPyTtsDetails = {
    ok,
    command: "tts",
    exitCode: res.exitCode,
    aborted: false,
    output: exists ? input.output : null,
    sizeBytes: exists ? sizeBytes : null,
    voice: input.options.voice,
    stdout: res.stdout,
  };
  const summary = ok
    ? `kokoro ✓ ${input.options.voice} (Swift native, local) → ${input.output}`
    : `kokoro tts FAILED (exit ${res.exitCode})`;
  const stderrTail = res.stderr
    .split("\n")
    .filter((l) => l.trim())
    .slice(-5)
    .join("\n");
  return { details, summary, stderrTail };
}
