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
import { spawn } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REGISTRY as REGISTRY_ALL, type Capability, type ProviderEntry } from "./registry.ts";
import type { Adapter, Artifact, GenerateRequest, ToolResult } from "./bridge.ts";
import { tariffFor } from "./bridge.ts";

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

const CLOUD_KEY_FOR: Record<string, string> = {
  elevenlabs: "ELEVENLABS_API_KEY",
  openai: "OPENAI_API_KEY",
};

/**
 * Runtime availability for a provider. Authoritative: a provider is callable iff
 * this returns true. The static `configured` is the declarative baseline (which
 * already marks GAPs / unimplemented providers false); the probe refines it ONLY
 * for the two strategies with an environment signal — ffmpeg (binary on PATH) and
 * fetch (cloud API key). Thus: a cloud provider upgrades to callable when its key
 * appears; an ffmpeg provider downgrades when the binary is gone; everything else
 * honors its registry `configured` flag.
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
      return entry.configured && process.platform === "darwin";
    default:
      // native_swift directors (krea2/flux2/ltx) + bun:builtin (subtitle_gen):
      // on-platform / in-repo, availability == the registry's configured flag.
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
    const text = buildSubtitle(opts);
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
export const cloudHttpAdapter: Adapter = async (req: GenerateRequest, env: Record<string, string | undefined> = process.env): Promise<ToolResult> => {
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

/** The non-native adapter map (merged into realAdapters by bridge.ts). */
export function nonNativeAdapters(_env?: Record<string, string | undefined>): Partial<Record<ProviderEntry["invoke"], Adapter>> {
  return {
    ffmpeg: ffmpegAdapter,
    "bun:builtin": subtitleAdapter, // subtitle_gen is the shipped bun:builtin provider
    fetch: (req: GenerateRequest) => cloudHttpAdapter(req, _env),
  };
}
