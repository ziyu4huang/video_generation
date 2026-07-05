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
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { REGISTRY as REGISTRY_ALL, type Capability, type ProviderEntry } from "./registry.ts";
import { EXT_ROOT } from "./paths.ts";
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
    case "bun:whisper":
      // callable iff we can resolve BOTH a python binary and the entry script.
      // (cheap: stat only — we do NOT import mlx_whisper on every probe.)
      return entry.configured && whisperRuntimePresent(env);
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

// ─── whisper adapter (native mlx-whisper via python subprocess) ──────────────

/**
 * The python entry script + the whisper venv. The script lives inside the ext
 * (<EXT_ROOT>/python/whisper_transcribe.py); the venv is repo infra
 * (<repo>/python/whisper-venv) created by `uv venv` + `uv pip install mlx-whisper`.
 * Resolution order for the python binary:
 *   1. MD_WHISPER_PYTHON env (explicit override — mirrors REMOTION_BIN).
 *   2. <repo>/python/whisper-venv/bin/python — walk up from EXT_ROOT.
 *   3. "python3" on PATH (last resort; needs mlx_whisper importable there).
 */
const WHISPER_SCRIPT = join(EXT_ROOT, "python", "whisper_transcribe.py");

export function whisperScriptPath(): string {
  return WHISPER_SCRIPT;
}

/** Resolve the python binary that runs mlx_whisper (cached per process). */
export function resolveWhisperPython(env: Record<string, string | undefined> = process.env): string {
  if (env.MD_WHISPER_PYTHON && existsSync(env.MD_WHISPER_PYTHON)) return env.MD_WHISPER_PYTHON;
  // Walk up from EXT_ROOT looking for python/whisper-venv/bin/python.
  let dir = EXT_ROOT;
  for (let i = 0; i < 8; i++) {
    const cand = join(dir, "python", "whisper-venv", "bin", "python");
    if (existsSync(cand)) return cand;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "python3";
}

let whisperRuntimeCached: boolean | undefined;
function whisperRuntimePresent(env: Record<string, string | undefined>): boolean {
  if (whisperRuntimeCached != null) return whisperRuntimeCached;
  const py = env.MD_WHISPER_PYTHON ? env.MD_WHISPER_PYTHON : resolveWhisperPython(env);
  // "python3" resolves via PATH (existsSync("python3") is false but it is callable);
  // an absolute resolved path must actually exist on disk.
  const pyPresent = py === "python3" ? true : existsSync(py);
  whisperRuntimeCached = pyPresent && existsSync(WHISPER_SCRIPT);
  return whisperRuntimeCached;
}

/** Force the whisper-runtime probe result (tests inject a deterministic value). */
export function _setWhisperRuntimeForTest(v: boolean | undefined): void {
  whisperRuntimeCached = v;
}

export interface WhisperOptions {
  /** Path to the audio file to transcribe (required). */
  audio: string;
  /** HuggingFace mlx-whisper repo. Default: mlx-community/whisper-small-mlx. */
  model?: string;
  /** Language hint (e.g. "en"). Default: auto-detect. */
  language?: string;
  /** Skip word-level timestamps (segment-level only). */
  noWords?: boolean;
  /** Output dir for transcript.txt + words.json. Defaults to req.outputDir. */
  output?: string;
  /** Test-only spawn injection (the mock writes the JSON out file + returns 0). */
  _spawnImpl?: (cmd: string, argv: string[]) => Promise<number>;
}

/** Normalized shape emitted by whisper_transcribe.py (the adapter's parse target). */
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

/** Run the whisper python entry and parse its normalized JSON result. */
async function runWhisper(opts: WhisperOptions, env: Record<string, string | undefined>): Promise<WhisperResult> {
  const spawnImpl = opts._spawnImpl ?? runSpawn;
  const py = resolveWhisperPython(env);
  const outDir = opts.output ?? process.cwd();
  const jsonOut = join(outDir, `whisper_${process.pid}_${Date.now() % 100000}.json`);
  const argv = [WHISPER_SCRIPT, "--audio", opts.audio, "--output", jsonOut];
  if (opts.model) argv.push("--model", opts.model);
  if (opts.language) argv.push("--language", opts.language);
  if (opts.noWords) argv.push("--no-words");
  const code = await spawnImpl(py, argv);
  let payload: WhisperResult;
  try {
    payload = JSON.parse(readFileSync(jsonOut, "utf8")) as WhisperResult;
  } catch {
    payload = { ok: false, error: `whisper exited ${code} (no JSON output)` };
  }
  return payload;
}

/** whisper adapter: spawns mlx-whisper, returns a ToolResult with transcript + words artifacts. */
export const whisperAdapter: Adapter = async (req: GenerateRequest): Promise<ToolResult> => {
  if (!whisperRuntimePresent(process.env as Record<string, string | undefined>)) {
    return fail(req, "whisper", "whisper runtime not found (set MD_WHISPER_PYTHON or create python/whisper-venv)");
  }
  const opts = (req.options ?? {}) as WhisperOptions;
  if (!opts.audio || !existsSync(opts.audio)) {
    return fail(req, "whisper", `audio missing or not found: ${opts.audio ?? "(none)"}`);
  }
  const outputDir = req.outputDir ?? process.cwd();
  const started = Date.now();
  try {
    const res = await runWhisper({ ...opts, output: outputDir }, process.env as Record<string, string | undefined>);
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
    "bun:whisper": whisperAdapter, // transcriber (Item I) spawns mlx-whisper via python
    fetch: (req: GenerateRequest) => cloudHttpAdapter(req, _env),
  };
}
