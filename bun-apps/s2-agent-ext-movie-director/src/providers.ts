/**
 * providers.ts — non-native adapters (ffmpeg / pure-Bun / cloud HTTP) for the
 * movie-director bridge. Each emits the SAME ToolResult the native swift
 * directors do (see bridge.ts), so the orchestration layer treats a subtitled
 * SRT, a stitched MP4, and a generated PNG identically.
 *
 * iteration 3 "free wins" tier. The native directors (krea2/flux2/ltx) cover
 * generation; these cover everything else movie-director needs: ffmpeg for
 * audio-mix / color-grade / stitch / trim, pure-Bun for SRT/VTT subtitle_gen,
 * and a fetch-based scaffold for cloud TTS/music (auto-configures when an API
 * key is present).
 *
 * Availability is PROBED at runtime (probeConfigured), not hardcoded: ffmpeg
 * entries are callable only if `ffmpeg` is on PATH; cloud entries only if their
 * key is in env. The static registry `configured` is the declarative baseline;
 * the probe is the runtime truth (it can upgrade a cloud provider to callable
 * when a key appears, or downgrade an ffmpeg provider when the binary is gone).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { REGISTRY as REGISTRY_ALL, type Capability, type ProviderEntry } from "./registry.ts";
import { EXT_ROOT } from "./paths.ts";
import { renderRemotion, type RemotionEditDecisions } from "./remotion.ts";
import { composeMotion, type SpawnImpl } from "./compose_motion.ts";
import { renderHyperframes } from "./hyperframes_native.ts";
import { enforcePreCompose } from "./precompose-gate.ts";
import type { RenderReport, CaptionsOptions } from "./compose.ts";
import type { Adapter, Artifact, GenerateRequest, ToolResult } from "./bridge.ts";
import { tariffFor } from "./bridge.ts";
import { resolveRepoRoot, defaultBinaryPath, resolveRunPyPaths } from "@repo/s2-agent-ext-ltx";

// ─── Availability probe ──────────────────────────────────────────────────────

/** True if `ffmpeg` resolves on PATH (sync, cheap — caches per-process). */
function ffmpegOnPath(): boolean {
  try {
    const r = spawn("ffmpeg", ["-version"], { stdio: ["ignore", "pipe", "ignore"] });
    return r.pid != null;
  } catch {
    return false;
  }
}

let ffmpegCached: boolean | undefined;
function ffmpegAvailable(): boolean {
  if (ffmpegCached == null) ffmpegCached = ffmpegOnPath();
  return ffmpegCached;
}

/** Force a ffmpeg-availability result (tests inject a deterministic value). */
export function _setFfmpegAvailableForTest(v: boolean | undefined): void {
  ffmpegCached = v;
}

// ─── Remotion binary probe (compose:remotion) ────────────────────────────────

/**
 * The bundled local install's `remotion` binary, mirroring remotion.ts. Present
 * iff `bun install` was run in the shipped <EXT_ROOT>/remotion/ project (whose
 * node_modules are gitignored). This is the install path that makes compose_remotion
 * callable without REMOTION_BIN/PATH — probed last, after the explicit env + PATH.
 */
const BUNDLED_REMOTION_BIN = join(EXT_ROOT, "remotion", "node_modules", ".bin", "remotion");

/**
 * True if a usable `remotion` binary resolves (NOT the bunx fallback). Mirrors
 * `resolveRemotionBin()` in remotion.ts but SYNCHRONOUS (probeConfigured must be
 * sync) and cached per process. Resolution order: REMOTION_BIN env (must exist
 * on disk) → `remotion --version` on PATH (exit 0) → the bundled local install
 * (<EXT_ROOT>/remotion/node_modules/.bin/remotion, present after `bun install`
 * there). The bunx fallback is treated as "not really installed" (matches
 * remotion.ts) — it is NOT probed here, so compose_remotion reports uncallable
 * on a fresh clone until the bundled install lands.
 */
function remotionOnPath(): boolean {
  try {
    const r = spawnSync("remotion", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    return r.status === 0;
  } catch {
    return false;
  }
}

let remotionCached: boolean | undefined;
function remotionBinaryAvailable(env: Record<string, string | undefined>): boolean {
  if (remotionCached != null) return remotionCached;
  if (env.REMOTION_BIN && existsSync(env.REMOTION_BIN)) remotionCached = true;
  else if (remotionOnPath()) remotionCached = true;
  else remotionCached = existsSync(BUNDLED_REMOTION_BIN);
  return remotionCached;
}

/** Force the remotion-binary probe result (tests inject a deterministic value). */
export function _setRemotionProbeForTest(v: boolean | undefined): void {
  remotionCached = v;
}

// ─── ffmpeg motion-filter probe (compose:motion) ─────────────────────────────

/**
 * True if this ffmpeg build has BOTH the `zoompan` (ken-burns/zoom/pan) and
 * `xfade` (crossfade) filters the motion compositor needs. Standard builds
 * (including Homebrew ffmpeg on macOS) ship both; cached per process. Mirrors
 * the libass probe in compose.ts.
 */
let motionFiltersCached: boolean | undefined;
function motionFiltersAvailable(): boolean {
  if (motionFiltersCached != null) return motionFiltersCached;
  try {
    const r = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" });
    const list = r.stdout ?? "";
    const has = (name: string) => new RegExp(`(?:^|\\s).{0,3}${name}\\s`).test(list);
    motionFiltersCached = has("zoompan") && has("xfade");
  } catch {
    motionFiltersCached = false;
  }
  return motionFiltersCached;
}

/** Force the motion-filter probe result (tests inject a deterministic value). */
export function _setMotionFiltersForTest(v: boolean | undefined): void {
  motionFiltersCached = v;
}

// ─── hyperframes CLI probe (compose:hyperframes) ─────────────────────────────

/**
 * True if a usable `hyperframes` CLI resolves. Mirrors `remotionBinaryAvailable`
 * but treats the `bunx hyperframes` fallback as genuinely available (unlike
 * remotion's bundled-local-install expectation, `bunx <pkg>` IS hyperframes'
 * vendor-documented invocation — its own README leads with `npx hyperframes
 * <command>`), so this probe only needs HYPERFRAMES_BIN (if set) to exist, or
 * bunx itself to resolve on PATH.
 */
function hyperframesOnPath(): boolean {
  try {
    const r = spawnSync("hyperframes", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    return r.status === 0;
  } catch {
    return false;
  }
}
function bunxOnPath(): boolean {
  try {
    const r = spawnSync("bunx", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    return r.status === 0;
  } catch {
    return false;
  }
}

let hyperframesCliCached: boolean | undefined;
function hyperframesCliAvailable(env: Record<string, string | undefined>): boolean {
  if (hyperframesCliCached != null) return hyperframesCliCached;
  if (env.HYPERFRAMES_BIN) hyperframesCliCached = existsSync(env.HYPERFRAMES_BIN);
  else hyperframesCliCached = hyperframesOnPath() || bunxOnPath();
  return hyperframesCliCached;
}

/** Force the hyperframes-CLI probe result (tests inject a deterministic value). */
export function _setHyperframesCliForTest(v: boolean | undefined): void {
  hyperframesCliCached = v;
}

const CLOUD_KEY_FOR: Record<string, string> = {
  elevenlabs: "ELEVENLABS_API_KEY",
  openai: "OPENAI_API_KEY",
};

/** True if the built swift/ltx-video-director binary is on disk (never throws). */
function ltxBinaryPresent(): boolean {
  try {
    const repoRoot = resolveRepoRoot();
    return existsSync(defaultBinaryPath(repoRoot));
  } catch {
    // resolveRepoRoot throws if it can't walk to swift/ltx-video-director — treat
    // as "binary absent" so mlx:runpy wins rather than crashing the selector.
    return false;
  }
}

/** True if the MLX venv python AND run.py resolve (never throws). */
let runPyRuntimeCached: boolean | undefined;
function runPyRuntimePresent(): boolean {
  if (runPyRuntimeCached != null) return runPyRuntimeCached;
  try {
    const repoRoot = resolveRepoRoot();
    const { python, runPy } = resolveRunPyPaths(repoRoot);
    runPyRuntimeCached = existsSync(python) && existsSync(runPy);
    return runPyRuntimeCached;
  } catch {
    runPyRuntimeCached = false;
    return false;
  }
}

/** Force the run.py-runtime probe result (tests inject a deterministic value). */
export function _setRunPyRuntimeForTest(v: boolean | undefined): void {
  runPyRuntimeCached = v;
}

// ─── LM Studio reachability probe (caption VLM) ──────────────────────────────

/**
 * True if the local LM Studio server answers on its OpenAI-compatible port (used by
 * the mlx:caption probe — caption_native.ts calls LM Studio's VLM directly, no run.py).
 * Sync + cached per process, mirroring the ffmpeg/probe pattern: a short `curl` to
 * /v1/models (2s timeout). The specific VLM is auto-loaded at call time, so the probe
 * only asserts the server is up.
 */
let lmStudioReachableCached: boolean | undefined;
function lmStudioReachable(): boolean {
  if (lmStudioReachableCached != null) return lmStudioReachableCached;
  try {
    const r = spawnSync("curl", [
      "-s", "-o", "/dev/null", "--max-time", "2",
      "http://localhost:1234/v1/models",
    ]);
    lmStudioReachableCached = r.status === 0;
  } catch {
    lmStudioReachableCached = false;
  }
  return lmStudioReachableCached;
}

/** Force the LM-Studio-reachability probe result (tests inject a deterministic value). */
export function _setLmStudioReachableForTest(v: boolean | undefined): void {
  lmStudioReachableCached = v;
}

// ─── swift image-director binary probes (krea2 / flux2) ───────────────────────

/**
 * True if the built krea2-image-director binary is on disk (never throws).
 * Mirrors ltxBinaryPresent. Unlike ltx (whose binary is often absent on a fresh
 * checkout), krea2/flux2 auto-build on first `runKrea2`/`runFlux2` via each
 * ext's ensureBinary() — so an absent binary is NOT a hard block (generation
 * builds it). But the PROBE reports the honest current state so the preflight
 * rollup + the default selector reflect what is callable right now (an unbuilt
 * krea2 yields the default image_generation pick to runpy-image, the faster
 * no-build path). An explicit `provider:"krea2"` hint still reaches krea2
 * (selector.ts honors statically-configured providers regardless of probe) so
 * the auto-build flow is preserved.
 */
let krea2BinaryCached: boolean | undefined;
function krea2BinaryPresent(): boolean {
  if (krea2BinaryCached != null) return krea2BinaryCached;
  try {
    krea2BinaryCached = existsSync(join(resolveRepoRoot(), "swift", "krea2-image-director", ".build", "release", "krea2"));
  } catch {
    krea2BinaryCached = false;
  }
  return krea2BinaryCached;
}
/** Force the krea2-binary probe result (tests inject a deterministic value). */
export function _setKrea2BinaryForTest(v: boolean | undefined): void {
  krea2BinaryCached = v;
}

/** True if the built flux2-image-director binary is on disk (never throws). */
let flux2BinaryCached: boolean | undefined;
function flux2BinaryPresent(): boolean {
  if (flux2BinaryCached != null) return flux2BinaryCached;
  try {
    flux2BinaryCached = existsSync(join(resolveRepoRoot(), "swift", "flux2-image-director", ".build", "release", "flux2"));
  } catch {
    flux2BinaryCached = false;
  }
  return flux2BinaryCached;
}
/** Force the flux2-binary probe result (tests inject a deterministic value). */
export function _setFlux2BinaryForTest(v: boolean | undefined): void {
  flux2BinaryCached = v;
}

/** True if the built musicgen-director binary is on disk (never throws). */
let musicgenBinaryCached: boolean | undefined;
function musicgenBinaryPresent(): boolean {
  if (musicgenBinaryCached != null) return musicgenBinaryCached;
  try {
    musicgenBinaryCached = existsSync(join(resolveRepoRoot(), "swift", "musicgen-director", ".build", "release", "musicgen"));
  } catch {
    musicgenBinaryCached = false;
  }
  return musicgenBinaryCached;
}
/** Force the musicgen-binary probe result (tests inject a deterministic value). */
export function _setMusicgenBinaryForTest(v: boolean | undefined): void {
  musicgenBinaryCached = v;
}

/** True if the built kokoro-tts binary is on disk (never throws). */
let kokoroBinaryCached: boolean | undefined;
function kokoroBinaryPresent(): boolean {
  if (kokoroBinaryCached != null) return kokoroBinaryCached;
  try {
    kokoroBinaryCached = existsSync(join(resolveRepoRoot(), "swift", "musicgen-director", ".build", "release", "kokoro-tts"));
  } catch {
    kokoroBinaryCached = false;
  }
  return kokoroBinaryCached;
}

/** Force the kokoro-binary probe result (tests inject a deterministic value). */
export function _setKokoroBinaryForTest(v: boolean | undefined): void {
  kokoroBinaryCached = v;
}
/**
 * Runtime availability for a provider. Authoritative: a provider is callable iff
 * this returns true. The static `configured` is the declarative baseline (which
 * already marks GAPs / unimplemented providers false); the probe refines it for
 * every strategy with an environment/disk signal: ffmpeg (binary on PATH), fetch
 * (cloud API key), the swift directors (built binary on disk), run.py (venv+
 * run.py present), whisper/clip (built swift binary on disk), LM Studio
 * (caption server reachable), and the compose runtimes (remotion binary /
 * motion filters). Thus a cloud provider upgrades to callable when its key
 * appears; an ffmpeg/swift provider downgrades when its binary is gone;
 * run.py providers downgrade when the venv is absent. bun:builtin (subtitle_gen)
 * honors its flag.
 */
export function probeConfigured(entry: ProviderEntry, env: Record<string, string | undefined> = process.env): boolean {
  switch (entry.invoke) {
    case "ffmpeg":
      return ffmpegAvailable();
    case "fetch": {
      const key = CLOUD_KEY_FOR[entry.provider];
      return key ? Boolean(env[key]) : false;
    }
    case "macos:vision":
    case "macos:screencapturekit":
    case "macos:say":
      return entry.configured && process.platform === "darwin";
    case "bun:whisper":
      // callable iff the built ltx-video binary is on disk (the transcribe
      // subcommand lives in swift/ltx-video-director). Cheap: stat only.
      return entry.configured && whisperRuntimePresent(env);
    case "bun:clip":
      // callable iff the built swift/clip-director binary is on disk.
      return entry.configured && clipBinaryPresent();
    case "compose:remotion":
      // callable iff the registry flag is set AND a real remotion binary resolves
      // (REMOTION_BIN on disk OR `remotion` on PATH — NOT the bunx fallback).
      return entry.configured && remotionBinaryAvailable(env);
    case "compose:motion":
      // callable iff ffmpeg is on PATH AND its build has zoompan+xfade (the motion
      // compositor's only deps — no browser, no swift). Reuses the ffmpeg cache.
      return entry.configured && ffmpegAvailable() && motionFiltersAvailable();
    case "compose:hyperframes":
      // callable iff HYPERFRAMES_BIN resolves, OR `hyperframes`/`bunx` resolves on
      // PATH — bunx is the vendor's own supported invocation (not a "not really
      // installed" fallback the way it is for remotion).
      return entry.configured && hyperframesCliAvailable(env);
    case "swift:ltx":
      // callable iff the built ltx-video binary exists on disk. Unlike krea2/flux2
      // (which the GUI auto-builds), ltx-video's binary is NOT always present on a
      // fresh checkout — when it is absent, the run.py adapter (mlx:runpy) wins
      // video_generation instead. This is the honest "selector ranks by presence"
      // tiebreak between two native_swift rank-0 providers.
      return entry.configured && ltxBinaryPresent();
    case "swift:krea2":
      // callable iff the built krea2-image-director binary is on disk. Absent on a
      // fresh checkout (until the first runKrea2 auto-builds it); the default
      // selector then yields image_generation to runpy-image (no build, faster).
      // An explicit provider:"krea2" hint still reaches it (selector honors
      // statically-configured providers) so the auto-build path is preserved.
      // z-image (same invoke) probes the SAME krea2 binary.
      return entry.configured && krea2BinaryPresent();
    case "swift:flux2":
      // callable iff the built flux2-image-director binary is on disk (mirrors krea2).
      return entry.configured && flux2BinaryPresent();
    case "bun:musicgen-native":
      // callable iff the built musicgen-director binary is on disk (mirrors
      // krea2/flux2 — auto-built by ensureBinary() on first real call, but
      // absent on a fresh checkout until then; the default selector should
      // honestly fall back to mlx:runpy-music rather than eat a multi-minute
      // build inside what looks like a routine generation call).
      return entry.configured && musicgenBinaryPresent();
    case "bun:kokoro-tts":
      // callable iff the built kokoro-tts binary is on disk (mirrors
      // musicgen — auto-built by ensureBinary() on first real call, but
      // absent on a fresh checkout until then). Note: since kokoro_tts's
      // optIn was removed (2026-08-21, A/B-promoted to the tts default),
      // this probe result DOES affect selectProvider's bare "tts" fallback
      // (see the registry entry + selector.test.ts's soft-hint test) — an
      // absent binary honestly downgrades the default to say/edge-tts until
      // the first real call builds it.
      return entry.configured && kokoroBinaryPresent();
    case "mlx:runpy":
      // callable iff the MLX venv python AND run.py resolve (env-overridable via
      // MLX_VENV_PYTHON / RUN_PY). The canonical local PYTHON runtime — present
      // on any machine that has recreated python/venv per CLAUDE.md.
      return entry.configured && runPyRuntimePresent();
    case "mlx:runpy-image":
      // callable iff run.py + the MLX venv resolve — same presence signal as
      // mlx:runpy (image is a run.py subcommand family). Whether a specific
      // sub-action's models are present is a RUNTIME concern (run.py resolves
      // them from mlx-models); the static probe stays honest about the runtime.
      return entry.configured && runPyRuntimePresent();
    case "mlx:runpy-story":
      // callable iff run.py + the MLX venv resolve (story is a run.py top-level
      // command). The gemma brain load is a RUNTIME concern (run.py auto-resolves
      // it); the static probe stays honest about the runtime, not the brain.
      return entry.configured && runPyRuntimePresent();
    case "mlx:runpy-tts":
      // callable iff run.py + the MLX venv resolve — same presence signal as
      // mlx:runpy (tts is a run.py top-level command). Whether edge-tts's
      // network call actually succeeds is a RUNTIME concern (no network probe
      // here, mirrors the caption/story adapters not probing LM Studio either).
      return entry.configured && runPyRuntimePresent();
    case "mlx:runpy-music":
      // callable iff run.py + the MLX venv resolve — same presence signal as
      // mlx:runpy-tts (music is a run.py top-level command). Whether
      // mlx-audiocraft is actually installed is a RUNTIME concern (music.py
      // gives a clear ERROR if missing); the static probe stays honest about
      // the run.py/venv runtime, not the optional MusicGen dependency.
      return entry.configured && runPyRuntimePresent();
    case "mlx:caption":
      // caption runs entirely through caption_native.ts → LM Studio's VLM (zero
      // run.py since the 2026-07-19 port). Callable iff the local LM Studio
      // server is reachable (the model is auto-loaded at call time). Whether a
      // specific VLM is loaded is a RUNTIME concern; the probe stays honest about
      // the server being up.
      return entry.configured && lmStudioReachable();
    default:
      // bun:builtin (subtitle_gen): pure-Bun, in-repo, availability == the
      // registry's configured flag. (All native_swift directors now have explicit
      // binary/venv probes above — ltx/krea2/flux2/musicgen check the built swift binary.)
      return entry.configured;
  }
}

/** All providers for a capability whose runtime probe passes (the callable set). */
export function callableForCapability(
  entries: ProviderEntry[],
  env: Record<string, string | undefined> = process.env,
): ProviderEntry[] {
  return entries.filter((e) => probeConfigured(e, env));
}

/**
 * The preflight rollup using RUNTIME-probed availability (ffmpeg on PATH, cloud
 * keys in env), mirroring registry.providerMenuSummary() but reflecting what is
 * actually callable right now. A cloud provider auto-appears when its key lands;
 * an ffmpeg provider disappears when the binary is gone.
 */
export function probedMenuSummary(env: Record<string, string | undefined> = process.env): {
  composition_runtimes: Record<string, boolean>;
  capabilities: Array<{ capability: string; total: number; configured: number; available_providers: string[]; unavailable_providers: string[] }>;
  gaps: ProviderEntry[];
} {
  const caps = new Map<string, { capability: string; total: number; configured: number; available_providers: string[]; unavailable_providers: string[] }>();
  const gaps: ProviderEntry[] = [];
  for (const p of REGISTRY_ALL) {
    if (p.notes?.startsWith("GAP")) gaps.push(p);
    const key = String(p.capability);
    const r = caps.get(key) ?? { capability: key, total: 0, configured: 0, available_providers: [], unavailable_providers: [] };
    r.total += 1;
    if (probeConfigured(p, env)) {
      r.configured += 1;
      r.available_providers.push(p.provider);
    } else {
      r.unavailable_providers.push(p.provider);
    }
    caps.set(key, r);
  }
  const composition: Record<string, boolean> = {};
  for (const p of REGISTRY_ALL.filter((e) => e.capability === "composition")) {
    composition[p.provider] = probeConfigured(p, env);
  }
  return {
    composition_runtimes: composition,
    capabilities: [...caps.values()].sort((a, b) => a.capability.localeCompare(b.capability)),
    gaps,
  };
}

// ─── ffmpeg adapter ──────────────────────────────────────────────────────────

export interface FfmpegOptions {
  /** ffmpeg sub-command the bridge knows how to build: concat | trim | mix | grade. */
  operation?: "concat" | "trim" | "mix" | "grade";
  /** Input paths (1 for trim/grade, 2+ for concat, 2 for mix). */
  inputs?: string[];
  /** Output path. Defaults under outputDir. */
  output?: string;
  /** trim: start/duration seconds. */
  start?: number;
  duration?: number;
  /** mix: second audio path + level. */
  extraArgs?: string[];
}

function buildFfmpegArgv(opts: FfmpegOptions, fallbackOutput: string): string[] {
  const op = opts.operation ?? "concat";
  const output = opts.output ?? fallbackOutput;
  switch (op) {
    case "concat": {
      // concat demuxer needs a list file; we pass inputs via -i pairs + filter.
      const inputs = opts.inputs ?? [];
      const filter = inputs.map((_, i) => `[${i}:v:0][${i}:a:0]`).join("") + `concat=n=${inputs.length}:v=1:a=1[v][a]`;
      const argv: string[] = [];
      for (const inp of inputs) argv.push("-i", inp);
      argv.push("-filter_complex", filter, "-map", "[v]", "-map", "[a]", "-y", output);
      return argv;
    }
    case "trim": {
      const input = opts.inputs?.[0] ?? "";
      const argv = ["-ss", String(opts.start ?? 0), "-i", input];
      if (opts.duration != null) argv.push("-t", String(opts.duration));
      argv.push("-c", "copy", "-y", output);
      return argv;
    }
    case "mix": {
      // Overlay audio1 onto video0's audio (two inputs).
      const [v, a] = opts.inputs ?? [];
      return ["-i", v ?? "", "-i", a ?? "", "-filter_complex",
        "[0:a][1:a]amix=inputs=2:duration=first[a]", "-map", "0:v", "-map", "[a]",
        "-y", output];
    }
    case "grade": {
      const input = opts.inputs?.[0] ?? "";
      // eq filter with optional brightness/contrast/saturation from extraArgs.
      const eq = opts.extraArgs && opts.extraArgs.length ? opts.extraArgs.join("") : "eq=eq=brightness=0.0";
      return ["-i", input, "-vf", eq, "-y", output];
    }
    default:
      return [];
  }
}

/** ffmpeg adapter: spawns ffmpeg, returns a ToolResult with the output artifact. */
export const ffmpegAdapter: Adapter = async (req: GenerateRequest): Promise<ToolResult> => {
  if (!ffmpegAvailable()) {
    return fail(req, "ffmpeg", "ffmpeg not found on PATH");
  }
  const opts = (req.options ?? {}) as FfmpegOptions;
  const outputDir = req.outputDir ?? process.cwd();
  const fallback = join(outputDir, `ffmpeg_${opts.operation ?? "out"}.mp4`);
  const argv = buildFfmpegArgv(opts, fallback);
  const output = opts.output ?? fallback;
  const started = Date.now();
  try {
    const code = await runSpawn("ffmpeg", argv);
    const ok = code === 0;
    return {
      success: ok,
      provider: "ffmpeg",
      command: opts.operation ?? "ffmpeg",
      artifacts: ok && existsSync(output) ? [{ path: resolve(output), kind: artifactKindFor(req.capability), bytes: byteSize(output) }] : [],
      error: ok ? null : `ffmpeg exited ${code}`,
      cost_usd: ok ? 0 : 0,
      duration_seconds: (Date.now() - started) / 1000,
      seed: null,
      model: "ffmpeg",
    };
  } catch (err) {
    return fail(req, "ffmpeg", err instanceof Error ? err.message : String(err), (Date.now() - started) / 1000);
  }
};

// ─── subtitle_gen adapter (pure Bun) ─────────────────────────────────────────

export interface SubtitleOptions {
  /** Format: srt (default) or vtt. */
  format?: "srt" | "vtt";
  /** Word/cue timestamps: {text, start (s), end (s), speaker?}. */
  cues?: Array<{ text: string; start: number; end: number; speaker?: string }>;
  /**
   * Path to a whisper `words.json` (the word-timestamps artifact from the
   * `analysis:transcribe` generate command). When `cues` is absent, the adapter
   * reads this file + runs `cuesFromWhisper` to derive cues — so an agent-driven
   * run needs no timestamp math, just transcribe → subtitle(compose). Optional.
   */
  wordsPath?: string;
  /** Cue grouping when deriving from wordsPath: "words" (default) or "segments". */
  cueMode?: "words" | "segments";
  /** Words per cue when cueMode="words" (default 6). */
  wordsPerCue?: number;
  /** Output path. Defaults under outputDir. */
  output?: string;
}

function fmtTime(totalSeconds: number, sep: string): string {
  const s = Math.max(0, totalSeconds);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const sec = Math.floor(s) % 60;
  const min = Math.floor(s / 60) % 60;
  const hr = Math.floor(s / 3600);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(hr)}:${pad(min)}:${pad(sec)}${sep}${pad(ms, 3)}`;
}

/** Build SRT/VTT text from cue timestamps. Pure function — unit-testable. */
export function buildSubtitle(opts: SubtitleOptions): string {
  const format = opts.format ?? "srt";
  const cues = opts.cues ?? [];
  if (format === "vtt") {
    const body = cues.map((c) => {
      const speaker = c.speaker ? `<v ${c.speaker}>` : "";
      return `${fmtTime(c.start, ".")} --> ${fmtTime(c.end, ".")}\n${speaker}${c.text}`;
    });
    return ["WEBVTT", "", ...body].join("\n");
  }
  const body = cues.map((c, i) => `${i + 1}\n${fmtTime(c.start, ",")} --> ${fmtTime(c.end, ",")}\n${c.text}`);
  return body.join("\n") + (body.length ? "\n" : "");
}

/** subtitle_gen adapter: pure Bun, writes SRT/VTT, no external deps. */
export const subtitleAdapter: Adapter = async (req: GenerateRequest): Promise<ToolResult> => {
  const opts = (req.options ?? {}) as SubtitleOptions;
  const format = opts.format ?? "srt";
  const outputDir = req.outputDir ?? process.cwd();
  const output = opts.output ?? join(outputDir, `subtitles.${format}`);
  const started = Date.now();
  try {
    // Derive cues from a whisper words.json when the caller did not supply them
    // directly — the agent-driven captions path (transcribe → subtitle) hands
    // the words artifact path and lets subtitle_gen do the timestamp math.
    let cues = opts.cues;
    if (!cues && opts.wordsPath) {
      if (!existsSync(opts.wordsPath)) {
        return fail(req, "openmontage", `wordsPath not found: ${opts.wordsPath}`, (Date.now() - started) / 1000);
      }
      const words = JSON.parse(readFileSync(opts.wordsPath, "utf8")) as WhisperResult;
      cues = cuesFromWhisper(words, opts.cueMode ?? "words", opts.wordsPerCue ?? 6);
    }
    const text = buildSubtitle({ ...opts, cues });
    writeFileSync(output, text, "utf8");
    return {
      success: true,
      provider: "openmontage",
      command: format,
      artifacts: [{ path: resolve(output), kind: "data", bytes: Buffer.byteLength(text, "utf8") }],
      error: null,
      cost_usd: 0,
      duration_seconds: (Date.now() - started) / 1000,
      seed: null,
      model: "bun:builtin",
    };
  } catch (err) {
    return fail(req, "openmontage", err instanceof Error ? err.message : String(err), (Date.now() - started) / 1000);
  }
};

// ─── whisper adapter (native Swift/MLX via the ltx-video binary) ─────────────

/**
 * The transcribe backend is `ltx-video transcribe` — a PURE SWIFT/MLX Whisper
 * port (swift/ltx-video-director's WhisperModel + the segment-level seek loop
 * in WhisperTranscribe.swift), emitting the WhisperResult JSON below. This
 * replaces the former python `whisper_transcribe.py` → mlx_whisper spawn — no
 * python/whisper-venv is involved at runtime. Per-word DTW alignment is a
 * separate follow-up (P2b); until then each segment's `words` array is empty
 * (segment-level timestamps are always present).
 *
 * The binary is the SAME ltx-video binary the other swift:ltx commands use
 * (defaultBinaryPath, the one ltxBinaryPresent probes). `--checkpoint` /
 * `WHISPER_NATIVE_CHECKPOINT` / the cached whisper-large-v3-mlx snapshot are
 * resolved inside the binary, not here.
 */

/** Resolve the ltx-video binary path (throws if the repo root can't be walked). */
function whisperBinaryPath(): string {
  return defaultBinaryPath(resolveRepoRoot());
}

/**
 * True if the built ltx-video binary is on disk (never throws). The `env` arg
 * is kept for signature parity with the other probes even though the binary
 * path is env-independent.
 */
let whisperRuntimeOverride: boolean | undefined;
function whisperRuntimePresent(env: Record<string, string | undefined>): boolean {
  if (whisperRuntimeOverride != null) return whisperRuntimeOverride;
  try {
    return existsSync(whisperBinaryPath());
  } catch {
    // resolveRepoRoot throws if it can't walk to swift/ltx-video-director —
    // treat as "binary absent" so the selector falls through rather than crash.
    return false;
  }
}

/** Force the whisper-backend probe result (tests inject a deterministic value). */
export function _setWhisperRuntimeForTest(v: boolean | undefined): void {
  whisperRuntimeOverride = v;
}

export interface WhisperOptions {
  /** Path to the audio file to transcribe (required). */
  audio: string;
  /**
   * Optional weights.safetensors checkpoint path forwarded as `--checkpoint`.
   * Omit to let the binary resolve the cached whisper-large-v3-mlx snapshot.
   * (The old python `--model <hf-repo>` form is no longer meaningful for swift.)
   */
  model?: string;
  /** Language hint (e.g. "en"). Default: auto-detect. */
  language?: string;
  /**
   * Kept for API compatibility but ignored: the swift transcribe currently
   * emits segment-level timestamps only (no per-word DTW), so there are no
   * word timestamps to skip.
   */
  noWords?: boolean;
  /** Output dir for transcript.txt + words.json. Defaults to req.outputDir. */
  output?: string;
  /** Test-only spawn injection (the mock writes the JSON out file + returns 0). */
  _spawnImpl?: (cmd: string, argv: string[]) => Promise<number>;
}

/** Normalized shape emitted by `ltx-video transcribe` (the adapter's parse target). */
export interface WhisperResult {
  ok: boolean;
  error?: string;
  audio?: string;
  model?: string;
  language?: string | null;
  duration_s?: number;
  text?: string;
  segments?: Array<{
    start: number | null;
    end: number | null;
    text: string;
    words?: Array<{ word: string; start: number | null; end: number | null; prob?: number | null }>;
  }>;
}

/** Spawn `ltx-video transcribe` and parse its WhisperResult JSON. */
async function runWhisper(opts: WhisperOptions): Promise<WhisperResult> {
  const spawnImpl = opts._spawnImpl ?? runSpawn;
  const outDir = opts.output ?? process.cwd();
  const jsonOut = join(outDir, `whisper_${process.pid}_${Date.now() % 100000}.json`);
  const argv = ["transcribe", "--audio", opts.audio, "--output", jsonOut];
  if (opts.model) argv.push("--checkpoint", opts.model);
  if (opts.language) argv.push("--language", opts.language);
  const code = await spawnImpl(whisperBinaryPath(), argv);
  let payload: WhisperResult;
  try {
    payload = JSON.parse(readFileSync(jsonOut, "utf8")) as WhisperResult;
  } catch {
    payload = { ok: false, error: `whisper exited ${code} (no JSON output)` };
  }
  return payload;
}

/** whisper adapter: spawns ltx-video transcribe, returns a ToolResult with transcript + words artifacts. */
export const whisperAdapter: Adapter = async (req: GenerateRequest): Promise<ToolResult> => {
  if (!whisperRuntimePresent(process.env as Record<string, string | undefined>)) {
    return fail(req, "whisper", "whisper backend not found (build swift/ltx-video-director: swift build -c release)");
  }
  const opts = (req.options ?? {}) as unknown as WhisperOptions;
  if (!opts.audio || !existsSync(opts.audio)) {
    return fail(req, "whisper", `audio missing or not found: ${opts.audio ?? "(none)"}`);
  }
  // Workspace-relative default: when the caller omits outputDir (the common
  // agent-driven case), write transcript.txt/words.json to a per-call temp dir
  // instead of process.cwd() — so a run never litters the repo root. Callers
  // that want a specific location still pass outputDir/output explicitly.
  const outputDir = req.outputDir ?? mkdtempSync(join(tmpdir(), "md-transcribe-"));
  const started = Date.now();
  try {
    const res = await runWhisper({ ...opts, output: outputDir });
    if (!res.ok || !res.text) {
      return fail(req, "whisper", res.error ?? "whisper returned no text", (Date.now() - started) / 1000);
    }
    // Persist the transcript + word timestamps as workspace artifacts.
    const transcriptPath = join(outputDir, "transcript.txt");
    const wordsPath = join(outputDir, "words.json");
    writeFileSync(transcriptPath, res.text + "\n", "utf8");
    writeFileSync(wordsPath, JSON.stringify(res, null, 2), "utf8");
    const artifacts: Artifact[] = [
      { path: resolve(transcriptPath), kind: "data", bytes: Buffer.byteLength(res.text, "utf8"), role: "transcript" },
      { path: resolve(wordsPath), kind: "data", bytes: Buffer.byteLength(JSON.stringify(res), "utf8"), role: "word-timestamps" },
    ];
    return {
      success: true,
      provider: "whisper",
      command: req.command || "transcribe",
      artifacts,
      error: null,
      cost_usd: 0, // local MLX — honest $0 marginal
      duration_seconds: res.duration_s ?? (Date.now() - started) / 1000,
      seed: null,
      model: res.model ?? "whisper",
    };
  } catch (err) {
    return fail(req, "whisper", err instanceof Error ? err.message : String(err), (Date.now() - started) / 1000);
  }
};

/**
 * Convert whisper segments → subtitle cues (one cue per segment). Pure function —
 * unit-testable. `subtitle_gen` (buildSubtitle) consumes these directly. Word
 * boundaries are kept inside each segment so callers can re-group if desired.
 */
export function cuesFromWhisper(
  result: WhisperResult,
  mode: "segments" | "words" = "segments",
  wordsPerCue = 6,
): Array<{ text: string; start: number; end: number }> {
  const segs = result.segments ?? [];
  if (mode === "segments") {
    return segs
      .filter((s) => s.text && s.text.length > 0)
      .map((s) => ({ text: s.text, start: Number(s.start ?? 0), end: Number(s.end ?? s.start ?? 0) }));
  }
  // words mode: group every `wordsPerCue` words into one cue.
  const all = segs.flatMap((s) => s.words ?? []);
  const cues: Array<{ text: string; start: number; end: number }> = [];
  for (let i = 0; i < all.length; i += wordsPerCue) {
    const group = all.slice(i, i + wordsPerCue);
    if (group.length === 0) continue;
    const text = group.map((w) => w.word).join(" ").trim();
    if (!text) continue;
    cues.push({ text, start: Number(group[0]!.start ?? 0), end: Number(group[group.length - 1]!.end ?? group[0]!.start ?? 0) });
  }
  return cues;
}

// ─── CLIP adapter (native Swift/MLX via the clip-director binary) ────────────

/**
 * `analysis:video_understand` now runs the pure-Swift/MLX `clip` binary
 * (swift/clip-director) — CLIP ViT-B/32 text+vision towers + projections,
 * scoring frames against a prompt via cosine similarity. Replaces the former
 * python `clip_understand.py` (transformers + torch MPS); no python/vision-venv
 * is involved at runtime. Checkpoint resolved inside the binary (--checkpoint
 * > MD_CLIP_CHECKPOINT env > cached openai/clip-vit-base-patch32).
 */
function clipBinaryPath(): string {
  return join(resolveRepoRoot(), "swift", "clip-director", ".build", "release", "clip");
}

let clipBinaryOverride: boolean | undefined;
function clipBinaryPresent(): boolean {
  if (clipBinaryOverride != null) return clipBinaryOverride;
  try { return existsSync(clipBinaryPath()); } catch { return false; }
}

/**
 * Force the CLIP-backend probe result. Kept under the historical
 * `_setVisionRuntimeForTest` name (the probe was a python-vision import check
 * before the swift port) so existing test pins are unchanged.
 */
export function _setVisionRuntimeForTest(script: "clip", v: boolean | undefined): void {
  clipBinaryOverride = v;
}

export interface ClipOptions {
  /**
   * Pre-sampled frame image paths. If absent, the adapter samples `numFrames`
   * evenly-spaced frames from `video` via ffmpeg. Bun-side sampling keeps the
   * clip binary stateless about ffmpeg timing and lets the agent re-use the
   * frames artifact.
   */
  frames?: string[];
  /** Video path — sampled into `numFrames` frames when `frames` is absent. */
  video?: string;
  /** Frames to sample from `video` (default 4). */
  numFrames?: number;
  /** The text prompt to score frames against (required). */
  prompt: string;
  /** Extra candidate labels for multi-way ranking (prompt is always label[0]). */
  labels?: string[];
  /** HuggingFace CLIP repo (default openai/clip-vit-base-patch32). */
  model?: string;
  /** Test-only spawn injection. */
  _spawnImpl?: (cmd: string, argv: string[]) => Promise<number>;
}

/** Normalized shape emitted by the `clip` swift binary (parse target). */
export interface ClipResult {
  ok: boolean;
  error?: string;
  video?: string | null;
  prompt?: string;
  labels?: string[];
  score?: number;
  prob_mean?: number;
  frames?: Array<{ path: string; index: number; score: number; prob: number }>;
  model?: string;
  duration_s?: number;
}

/** Sample `numFrames` evenly-spaced frames from `video` via ffmpeg into outDir. */
async function sampleFrames(video: string, numFrames: number, outDir: string): Promise<string[]> {
  const dur = await ffprobeDuration(video);
  const frames: string[] = [];
  for (let i = 0; i < numFrames; i++) {
    const ts = dur > 0 ? (dur * (i + 0.5)) / numFrames : i;
    const outPath = join(outDir, `frame_${String(i).padStart(3, "0")}.png`);
    const code = await runSpawn("ffmpeg", [
      "-y", "-loglevel", "error", "-ss", ts.toFixed(3), "-i", video,
      "-frames:v", "1", outPath,
    ]);
    if (code === 0 && existsSync(outPath)) frames.push(outPath);
  }
  return frames;
}

function ffprobeDuration(video: string): Promise<number> {
  return new Promise((res) => {
    const p = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", video], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    p.stdout?.on("data", (d) => (out += d));
    p.on("error", () => res(0));
    p.on("exit", () => {
      const n = Number(out.trim());
      res(Number.isFinite(n) && n > 0 ? n : 0);
    });
  });
}

/** clip adapter: samples frames (if needed), spawns the swift `clip` binary, returns a scored ToolResult. */
export const clipAdapter: Adapter = async (req: GenerateRequest): Promise<ToolResult> => {
  if (!clipBinaryPresent()) {
    return fail(req, "clip", "clip backend not found (build swift/clip-director: swift build -c release)");
  }
  const opts = (req.options ?? {}) as unknown as ClipOptions;
  if (!opts.prompt) {
    return fail(req, "clip", "prompt is required for video_understand");
  }
  const outDir = req.outputDir ?? mkdtempSync(join(tmpdir(), "md-clip-"));
  const started = Date.now();
  try {
    // Resolve frames: caller-supplied, or sampled here via ffmpeg.
    let frames = opts.frames;
    const framesDir = join(outDir, "clip_frames");
    if ((!frames || frames.length === 0) && opts.video) {
      if (!existsSync(opts.video)) {
        return fail(req, "clip", `video not found: ${opts.video}`);
      }
      mkdirSyncSafe(framesDir);
      frames = await sampleFrames(opts.video, opts.numFrames ?? 4, framesDir);
      if (frames.length === 0) {
        return fail(req, "clip", "ffmpeg frame sampling produced no frames");
      }
    }
    if (!frames || frames.length === 0) {
      return fail(req, "clip", "no frames: pass options.frames or options.video");
    }

    const spawnImpl = opts._spawnImpl ?? runSpawn;
    const jsonOut = join(outDir, `clip_${process.pid}_${Date.now() % 100000}.json`);
    // The swift `clip` binary takes --frames <p...> --prompt <p> [--labels <p...>...]
    // (--labels repeats per label — ArgumentParser array-by-occurrence).
    const argv = ["--frames", ...frames, "--prompt", opts.prompt, "--output", jsonOut];
    if (opts.labels && opts.labels.length) for (const l of opts.labels) argv.push("--labels", l);
    if (opts.model) argv.push("--checkpoint", opts.model);
    const code = await spawnImpl(clipBinaryPath(), argv);
    let payload: ClipResult;
    try {
      payload = JSON.parse(readFileSync(jsonOut, "utf8")) as ClipResult;
    } catch {
      payload = { ok: false, error: `clip exited ${code} (no JSON output)` };
    }
    if (!payload.ok || payload.score == null) {
      return fail(req, "clip", payload.error ?? "clip returned no score", (Date.now() - started) / 1000);
    }
    // Persist the scored result next to the frames so the agent can cite it.
    const resultPath = join(outDir, "clip_scores.json");
    writeFileSync(resultPath, JSON.stringify(payload, null, 2), "utf8");
    return {
      success: true,
      provider: "clip",
      command: req.command || "video_understand",
      artifacts: [
        { path: resolve(resultPath), kind: "data", bytes: byteSize(resultPath), role: "scores" },
        ...(payload.video
          ? []
          : (frames ?? []).map((f, i) => ({ path: resolve(f), kind: "frames" as const, bytes: byteSize(f), role: `frame-${i}` }))),
      ],
      error: null,
      cost_usd: 0, // local MLX — honest $0 marginal
      duration_seconds: payload.duration_s ?? (Date.now() - started) / 1000,
      seed: null,
      model: payload.model ?? "clip-vit-base-patch32",
    };
  } catch (err) {
    return fail(req, "clip", err instanceof Error ? err.message : String(err), (Date.now() - started) / 1000);
  }
};

function mkdirSyncSafe(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore — best-effort frame scratch dir */
  }
}

// ─── cloud HTTP adapter (TTS/music via fetch) ────────────────────────────────

export interface CloudTtsOptions {
  provider?: "openai" | "elevenlabs";
  text?: string;
  /** Output path for the audio file. */
  output?: string;
  voice?: string;
  /** Inject a fetch impl (tests mock it). Defaults to global fetch. */
  _fetch?: typeof fetch;
}

async function openaiTts(opts: CloudTtsOptions, env: Record<string, string | undefined>): Promise<Uint8Array> {
  const key = env.OPENAI_API_KEY;
  const f = opts._fetch ?? fetch;
  const res = await f("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "tts-1", voice: opts.voice ?? "alloy", input: opts.text ?? "" }),
  });
  if (!res.ok) throw new Error(`openai tts HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** cloud HTTP adapter: synthesizes audio via a cloud TTS API. */
// NOT typed `: Adapter` (unlike the other adapters below) — it takes an extra
// optional `env` param (test/DI injection point) that the shared 1-arg
// Adapter signature would erase, breaking the `cloudHttpAdapter(req, env)`
// call below and every test that passes env explicitly. The registry entry
// at the `fetch:` key is still Adapter-shaped via its wrapping arrow.
export const cloudHttpAdapter = async (req: GenerateRequest, env: Record<string, string | undefined> = process.env): Promise<ToolResult> => {
  const opts = (req.options ?? {}) as CloudTtsOptions;
  const provider = opts.provider ?? "openai";
  const started = Date.now();
  const outputDir = req.outputDir ?? process.cwd();
  const output = opts.output ?? join(outputDir, `tts_${provider}.mp3`);
  try {
    let audio: Uint8Array;
    if (provider === "openai") {
      if (!env.OPENAI_API_KEY) return fail(req, provider, "OPENAI_API_KEY not set");
      audio = await openaiTts(opts, env);
    } else if (provider === "elevenlabs") {
      if (!env.ELEVENLABS_API_KEY) return fail(req, provider, "ELEVENLABS_API_KEY not set");
      // Minimal elevenlabs scaffold; full wiring deferred (key-gated smoke only).
      const f = opts._fetch ?? fetch;
      const res = await f(`https://api.elevenlabs.io/v1/text-to-speech/${opts.voice ?? "21m00Tcm4TlvDq8ikWAM"}`, {
        method: "POST",
        headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ text: opts.text ?? "" }),
      });
      if (!res.ok) throw new Error(`elevenlabs HTTP ${res.status}`);
      audio = new Uint8Array(await res.arrayBuffer());
    } else {
      return fail(req, provider, `unknown cloud provider "${provider}"`);
    }
    writeFileSync(output, audio);
    const t = tariffFor(env);
    return {
      success: true,
      provider,
      command: "tts",
      artifacts: [{ path: resolve(output), kind: "audio", bytes: audio.byteLength }],
      error: null,
      // Cloud TTS is real spend — nominal $0.015/1k chars (tts-1). Honest default.
      cost_usd: Math.round(t.image_usd + 0.015 * (opts.text?.length ?? 0) / 1000 * 10000) / 10000,
      duration_seconds: (Date.now() - started) / 1000,
      seed: null,
      model: provider,
    };
  } catch (err) {
    return fail(req, provider, err instanceof Error ? err.message : String(err), (Date.now() - started) / 1000);
  }
};

// ─── macOS `say` adapter (local, zero-cost, zero-key TTS fallback) ──────────

/** macOS `say`'s natural default rate band (words per minute) — outside this, the
 * adapter tags the result so a caller/cost-log/pacing gate can see the override
 * instead of it being invisible (the raw-`bash`+`say -r` escape hatch this
 * closes never surfaced a rate override anywhere; see script-pacing-gate.ts). */
const SAY_NATURAL_RATE_MIN = 140;
const SAY_NATURAL_RATE_MAX = 220;

export interface MacosSayOptions {
  text?: string;
  /** `say -v` voice name (e.g. "Samantha"). Defaults to the system voice. */
  voice?: string;
  /**
   * `say -r` words-per-minute rate. Omit for the system default (~175-200
   * wpm). Exists so an agent that needs to control speaking rate can do so
   * through this TRACKED path — before this option existed, the only way to
   * set `-r` was a raw `bash`+`say` call that bypassed cost tracking,
   * provider selection, and any pacing gate entirely (confirmed root cause
   * of the saturn-young-rings narration-compression bug, 2026-07-12: the
   * agent shelled out to `say -r 350` — ~2x natural rate — because there was
   * nowhere else to put it). Using THIS option instead makes the rate a
   * normal, visible, cost-tracked generate() call.
   */
  rate?: number;
  /** Output path (.wav). Defaults under outputDir. */
  output?: string;
}

/** macos:say adapter: spawns the built-in `say` binary, writes a WAV directly (no ffmpeg step). */
export const macosSayAdapter: Adapter = async (req: GenerateRequest): Promise<ToolResult> => {
  const opts = (req.options ?? {}) as MacosSayOptions;
  const started = Date.now();
  const outputDir = req.outputDir ?? process.cwd();
  const output = opts.output ?? join(outputDir, "tts_say.wav");
  const text = opts.text ?? "";
  if (!text) return fail(req, "say", "no text provided");
  try {
    mkdirSync(dirname(output), { recursive: true });
    const argv = ["-o", output, "--data-format=LEI16@24000", "--file-format=WAVE"];
    if (opts.voice) argv.push("-v", opts.voice);
    if (opts.rate !== undefined) argv.push("-r", String(opts.rate));
    argv.push(text);
    const code = await runSpawn("say", argv);
    const ok = code === 0 && existsSync(output);
    const rateNote =
      opts.rate !== undefined && (opts.rate < SAY_NATURAL_RATE_MIN || opts.rate > SAY_NATURAL_RATE_MAX)
        ? ` [rate=${opts.rate}wpm is outside the natural ${SAY_NATURAL_RATE_MIN}-${SAY_NATURAL_RATE_MAX}wpm band — ` +
          `if this is compensating for a script that's too dense for its planned duration, extend the video ` +
          `(chain more I2V clips) instead of the narration rate]`
        : "";
    return {
      success: ok,
      provider: "say",
      command: "tts",
      artifacts: ok ? [{ path: resolve(output), kind: "audio", bytes: byteSize(output) }] : [],
      error: ok ? null : `say exited ${code}`,
      cost_usd: 0, // local macOS synthesis — honest $0 marginal
      duration_seconds: (Date.now() - started) / 1000,
      seed: null,
      model: (opts.voice ?? "say-system-voice") + (opts.rate !== undefined ? ` rate=${opts.rate}wpm` : "") + rateNote,
    };
  } catch (err) {
    return fail(req, "say", err instanceof Error ? err.message : String(err), (Date.now() - started) / 1000);
  }
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function runSpawn(cmd: string, argv: string[]): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    p.on("error", rejectP);
    p.on("exit", (code) => resolveP(code ?? -1));
  });
}

function byteSize(p: string): number | undefined {
  try {
    return statSync(p).size;
  } catch {
    return undefined;
  }
}

function artifactKindFor(capability: Capability): Artifact["kind"] {
  if (capability === "video_generation" || capability === "video_post" || capability === "composition") return "video";
  if (capability === "audio_processing") return "audio";
  return "unknown";
}

function fail(req: GenerateRequest, provider: string, error: string, durationSeconds: number | null = null): ToolResult {
  return {
    success: false,
    provider,
    command: req.command,
    artifacts: [],
    error,
    cost_usd: 0,
    duration_seconds: durationSeconds,
    seed: null,
    model: provider,
  };
}

// ─── compose:remotion adapter (delegates to renderRemotion) ──────────────────

/**
 * Adapter wrapper so `selectAndGenerate("composition", {...})` routes to the
 * Remotion runtime (the compose-remotion action in the extension calls
 * renderRemotion directly; this wrapper exposes the same path through the
 * selector/bridge). Maps the RenderReport → ToolResult.
 */
export const composeRemotionAdapter: Adapter = async (req: GenerateRequest): Promise<ToolResult> => {
  const opts = (req.options ?? {}) as { editDecisions?: RemotionEditDecisions; workDir?: string; output?: string; width?: number; height?: number; fps?: number };
  const edit = opts.editDecisions;
  if (!edit || !Array.isArray(edit.cuts)) {
    return fail(req, "remotion", "compose:remotion requires options.editDecisions.{version,cuts:[...]}");
  }
  // GATE (code review, 2026-07-12): this adapter reaches the identical
  // renderRemotion() call the gated `compose-remotion` dispatch command does,
  // but selectAndGenerate({capability:"composition"}) routed through here
  // without ever calling enforcePreCompose — a second, ungated entry point to
  // the same render call, reopening Bug 2 (saturn-young-rings pre-compose
  // gate). req.options doubles as the gate's opts bag (narrativeDurationSeconds/
  // overridePreCompose etc. all read from the same options object dispatch.ts
  // passes to enforcePreCompose).
  const preComposeCheck = await enforcePreCompose(edit, (req.options ?? {}) as Record<string, unknown>);
  if (preComposeCheck) return fail(req, "remotion", preComposeCheck.error);
  const outputDir = req.outputDir ?? process.cwd();
  const workDir = opts.workDir ?? outputDir;
  const started = Date.now();
  try {
    const report: RenderReport = await renderRemotion(edit, {
      workDir,
      output: opts.output,
      width: opts.width,
      height: opts.height,
      fps: opts.fps,
    });
    const ok = report.outputs.length > 0;
    return {
      success: ok,
      provider: "remotion",
      command: req.command || "compose-remotion",
      artifacts: report.outputs.map((o) => ({
        path: resolve(o.path),
        kind: "video" as const,
        bytes: o.file_size_bytes,
        role: "composed",
      })),
      error: ok ? null : (report.warnings[0] ?? "remotion produced no output"),
      cost_usd: 0, // local Node subprocess — honest $0 marginal
      duration_seconds: report.render_time_seconds ?? (Date.now() - started) / 1000,
      seed: null,
      model: "remotion",
    };
  } catch (err) {
    return fail(req, "remotion", err instanceof Error ? err.message : String(err), (Date.now() - started) / 1000);
  }
};

// ─── compose:motion adapter (delegates to composeMotion) ─────────────────────

/**
 * Adapter wrapper so `selectAndGenerate("composition", {...})` and the
 * `compose-motion` action route to the ffmpeg motion compositor. Maps the
 * RenderReport → ToolResult. Same edit shape as compose-remotion
 * (RemotionEditDecisions) so an agent can drive either runtime from one edit.
 */
export const composeMotionAdapter: Adapter = async (req: GenerateRequest): Promise<ToolResult> => {
  const opts = (req.options ?? {}) as {
    editDecisions?: RemotionEditDecisions;
    workDir?: string;
    output?: string;
    width?: number;
    height?: number;
    fps?: number;
    transitionSeconds?: number;
    captions?: CaptionsOptions;
    /** Test-only spawn injection (mirrors the whisper/clip/esrgan adapters). */
    _spawnImpl?: SpawnImpl;
  };
  const edit = opts.editDecisions;
  if (!edit || !Array.isArray(edit.cuts)) {
    return fail(req, "motion", "compose:motion requires options.editDecisions.{version,cuts:[...]}");
  }
  // GATE (code review, 2026-07-12): same rationale as composeRemotionAdapter
  // above — this is the ungated second entry point to composeMotion() that
  // the `compose-motion` dispatch command already gates.
  const preComposeCheck = await enforcePreCompose(edit, (req.options ?? {}) as Record<string, unknown>);
  if (preComposeCheck) return fail(req, "motion", preComposeCheck.error);
  const outputDir = req.outputDir ?? process.cwd();
  const workDir = opts.workDir ?? outputDir;
  const started = Date.now();
  try {
    const report: RenderReport = await composeMotion(
      edit,
      {
        workDir,
        output: opts.output,
        width: opts.width,
        height: opts.height,
        fps: opts.fps,
        transitionSeconds: opts.transitionSeconds,
        // Honor the captions option (libass → drawtext → sidecar ladder). Without
        // this the adapter silently dropped captions, so the local ffmpeg path could
        // never burn subtitles even though composeMotion() fully supports it.
        captions: opts.captions,
      },
      opts._spawnImpl ? { spawnImpl: opts._spawnImpl } : {},
    );
    const ok = report.outputs.length > 0;
    return {
      success: ok,
      provider: "motion",
      command: req.command || "compose-motion",
      artifacts: report.outputs.map((o) => ({
        path: resolve(o.path),
        kind: "video" as const,
        bytes: o.file_size_bytes,
        role: "composed",
      })),
      error: ok ? null : (report.warnings[0] ?? "motion produced no output"),
      cost_usd: 0, // local ffmpeg — honest $0 marginal
      duration_seconds: report.render_time_seconds ?? (Date.now() - started) / 1000,
      seed: null,
      model: "ffmpeg-zoompan-xfade",
    };
  } catch (err) {
    return fail(req, "motion", err instanceof Error ? err.message : String(err), (Date.now() - started) / 1000);
  }
};

// ─── compose:hyperframes adapter (delegates to renderHyperframes) ────────────

/**
 * Adapter wrapper so `selectAndGenerate("composition", {...})` routes to the
 * HyperFrames runtime. Same edit shape as compose-remotion/compose-motion
 * (RemotionEditDecisions) so an agent can drive any of the three runtimes from
 * one edit. Maps the RenderReport → ToolResult.
 */
export const composeHyperframesAdapter: Adapter = async (req: GenerateRequest): Promise<ToolResult> => {
  const opts = (req.options ?? {}) as { editDecisions?: RemotionEditDecisions; workDir?: string; output?: string; width?: number; height?: number };
  const edit = opts.editDecisions;
  if (!edit || !Array.isArray(edit.cuts)) {
    return fail(req, "hyperframes", "compose:hyperframes requires options.editDecisions.{version,cuts:[...]}");
  }
  // GATE: same rationale as composeRemotionAdapter/composeMotionAdapter above —
  // this is an ungated second entry point to renderHyperframes() alongside
  // whatever gated `compose-hyperframes` dispatch command wraps it.
  const preComposeCheck = await enforcePreCompose(edit, (req.options ?? {}) as Record<string, unknown>);
  if (preComposeCheck) return fail(req, "hyperframes", preComposeCheck.error);
  const outputDir = req.outputDir ?? process.cwd();
  const workDir = opts.workDir ?? outputDir;
  const started = Date.now();
  try {
    const report: RenderReport = await renderHyperframes(edit, {
      workDir,
      output: opts.output,
      width: opts.width,
      height: opts.height,
    });
    const ok = report.outputs.length > 0;
    return {
      success: ok,
      provider: "hyperframes",
      command: req.command || "compose-hyperframes",
      artifacts: report.outputs.map((o) => ({
        path: resolve(o.path),
        kind: "video" as const,
        bytes: o.file_size_bytes,
        role: "composed",
      })),
      error: ok ? null : (report.warnings[0] ?? "hyperframes produced no output"),
      cost_usd: 0, // local CLI subprocess — honest $0 marginal
      duration_seconds: report.render_time_seconds ?? (Date.now() - started) / 1000,
      seed: null,
      model: "hyperframes",
    };
  } catch (err) {
    return fail(req, "hyperframes", err instanceof Error ? err.message : String(err), (Date.now() - started) / 1000);
  }
};

/** The non-native adapter map (merged into realAdapters by bridge.ts). */
export function nonNativeAdapters(_env?: Record<string, string | undefined>): Partial<Record<ProviderEntry["invoke"], Adapter>> {
  return {
    ffmpeg: ffmpegAdapter,
    "bun:builtin": subtitleAdapter, // subtitle_gen is the shipped bun:builtin provider
    "bun:whisper": whisperAdapter, // transcriber (Item I) spawns mlx-whisper via python
    "bun:clip": clipAdapter, // video_understand (Item I sibling) — CLIP via torch MPS
    "compose:remotion": composeRemotionAdapter, // composition runtime (iteration G #280) — Remotion Node subprocess
    "compose:motion": composeMotionAdapter, // composition runtime (Item J) — ffmpeg zoompan+xfade motion compositor
    "compose:hyperframes": composeHyperframesAdapter, // composition runtime — generated HTML rendered via the hyperframes CLI
    "macos:say": macosSayAdapter, // tts fallback — macOS `say`, zero-cost/zero-key local narration
    fetch: (req: GenerateRequest) => cloudHttpAdapter(req, _env),
  };
}
