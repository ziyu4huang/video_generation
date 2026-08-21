/**
 * bridge.ts — the native director bridge + the shared ToolResult contract.
 *
 * Iteration 2's keystone. The registry's `invoke` field names a strategy
 * ("swift:krea2" / "swift:flux2" / "swift:ltx" / ...); this module makes those
 * strategies genuinely callable by delegating to each sibling director's
 * pi-SDK-free `runX()` core (which already resolves the binary, validates
 * paths, spawns, and parses the per-package Details). The three directors have
 * DIFFERENT Details shapes (flux2: rich .manifest.json; krea2: stdout sentinel;
 * ltx: per-command regex) — rather than re-parse stdout here, we reuse their
 * tested parsers and adapt each Details into ONE uniform ToolResult.
 *
 * ToolResult is the contract every director (and, later, every cloud/ffmpeg
 * provider) emits, so the orchestration layer never branches on provider
 * internals: it sees {success, artifacts[], cost_usd, duration_seconds, seed,
 * model} regardless of who generated.
 *
 * Cost: local MLX on Apple Silicon has ~$0 marginal cost (it is your own
 * silicon). cost_usd defaults to 0 (honest) and is overridable via env so
 * budget governance stays exercisable; cloud providers (iteration 3) plug real
 * tariffs into the same field. The estimate→reserve→reconcile lifecycle itself
 * runs in the extension around every generate() call.
 */
import { runKrea2, type Krea2Details, type CommandName as Krea2Command } from "@repo/s2-agent-ext-krea2";
import { runFlux2, type Flux2Details, type CommandName as Flux2Command } from "@repo/s2-agent-ext-flux2";
import {
  runLtx,
  runPyVideo,
  resolveRepoRoot,
  type LtxDetails,
  type CommandName as LtxCommand,
  type RunPyVideoDetails,
  type RunPyVideoOptions,
} from "@repo/s2-agent-ext-ltx";
import { REGISTRY, type Capability, type ProviderEntry } from "./registry.ts";
import { selectProvider, type SelectorOptions } from "./selector.ts";
import { nonNativeAdapters } from "./providers.ts";
import { type CaptionDetails, type CaptionOptions } from "./caption.ts";
import {
  runPyImage,
  type RunPyImageDetails,
  type RunPyImageOptions,
} from "./runpy_image.ts";
import type { PurifyMode } from "./purify_native.ts";
import {
  runPyStory,
  type RunPyStoryDetails,
  type RunPyStoryOptions,
} from "./runpy_story.ts";
import { runPyTts, type RunPyTtsDetails, type RunPyTtsOptions } from "./runpy_tts.ts";
import type { KokoroTtsOptions } from "./kokoro_tts_native.ts";
import { runPyMusic, type RunPyMusicDetails, type RunPyMusicOptions } from "./runpy_music.ts";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

// ─── ToolResult contract ─────────────────────────────────────────────────────

export type ArtifactKind =
  | "image"
  | "video"
  | "audio"
  | "frames"
  | "directory"
  | "data"
  | "text"
  | "unknown";

export interface Artifact {
  /** Absolute filesystem path to the produced artifact (the chaining handle). */
  path: string;
  kind: ArtifactKind;
  seed?: number | null;
  width?: number | null;
  height?: number | null;
  bytes?: number | null;
  /** For named secondary outputs (e.g. ltx native-i2v audio.wav). */
  role?: string;
}

export interface ToolResult {
  success: boolean;
  /** Which provider actually ran ("krea2" / "flux2" / "ltx" / ...). */
  provider: string;
  /** Director subcommand that ran ("t2i", "native-i2v", ...). */
  command: string;
  artifacts: Artifact[];
  /** Human-readable error when success=false; null on success. */
  error: string | null;
  /** USD spend for this run. 0 for local native (honest); real tariffs for cloud. */
  cost_usd: number;
  /** Wall time in seconds (provider-reported when available, else measured). */
  duration_seconds: number | null;
  /** Generation seed, when known. */
  seed: number | null;
  /** Model identifier, when known (provider name as the fallback). */
  model: string | null;
}

// ─── Tariff ──────────────────────────────────────────────────────────────────

export interface Tariff {
  image_usd: number;
  video_per_sec_usd: number;
}

/** Env-overridable nominal tariff (default 0 = honest for local silicon). */
export function tariffFor(env: Record<string, string | undefined> = process.env): Tariff {
  const num = (v: string | undefined, dflt: number) => {
    const n = Number(v);
    return v != null && Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  return {
    image_usd: num(env.MD_TARIFF_IMAGE_USD, 0),
    video_per_sec_usd: num(env.MD_TARIFF_VIDEO_PER_SEC_USD, 0),
  };
}

function costFor(capability: Capability, durationSeconds: number | null, env?: Record<string, string | undefined>): number {
  const t = tariffFor(env);
  if (capability === "video_generation" && durationSeconds != null) {
    return Math.round(t.video_per_sec_usd * durationSeconds * 10000) / 10000;
  }
  if (capability === "image_generation") return t.image_usd;
  return 0;
}

// ─── Generate request ────────────────────────────────────────────────────────

export interface GenerateRequest {
  capability: Capability;
  /** Director subcommand to run (e.g. "t2i", "native-i2v"). */
  command: string;
  /** Per-command options, passed through to the director (camelCase keys). */
  options?: Record<string, unknown>;
  /** Output dir override (resolved+validated by the director). */
  outputDir?: string;
  /** Models root override. */
  modelsRoot?: string;
  /** Escape-hatch raw tokens (validated by the director). */
  extraArgs?: string[];
}

// ─── Required-options preflight ─────────────────────────────────────────────

/**
 * Per-capability (or "capability:command") required option keys. Checked
 * BEFORE the adapter runs so a call missing a required option fails
 * synchronously instead of spawning a real subprocess (10-45s each on MLX)
 * and failing only after the fact. Keyed by "capability:command" for known
 * named commands, and by bare capability as the default-command fallback
 * (empty/unspecified `command`, which routes to that capability's default
 * generator — e.g. image_generation's t2i). Named commands NOT listed here
 * (faceswap, controlnet, ...) are intentionally left unchecked — their
 * required fields differ per command and a wrong guess would false-block
 * valid calls.
 */
const REQUIRED_OPTIONS: Record<string, string[]> = {
  image_generation: ["prompt"],
  "image_generation:t2i": ["prompt"],
  video_generation: ["prompt"],
  "video_generation:generate": ["prompt"],
  "video_generation:t2i2v": ["prompt"],
  tts: ["text"],
  music_generation: ["prompt"],
};

function requiredOptionsFor(capability: Capability, command: string): string[] {
  if (command) return REQUIRED_OPTIONS[`${capability}:${command}`] ?? [];
  return REQUIRED_OPTIONS[capability] ?? [];
}

/** Required option keys missing from `req.options` for this {capability, command}. */
export function missingRequiredOptions(req: GenerateRequest): string[] {
  const required = requiredOptionsFor(req.capability, req.command);
  if (required.length === 0) return [];
  const options = req.options ?? {};
  return required.filter((k) => options[k] == null || options[k] === "");
}

export type InvokeKey = ProviderEntry["invoke"];

/** An adapter runs ONE director and returns its uniform ToolResult. */
export type Adapter = (req: GenerateRequest) => Promise<ToolResult>;

export interface GenerateDeps {
  env?: Record<string, string | undefined>;
  /** Override adapters (tests inject canned results; default = real directors). */
  adapters?: Partial<Record<InvokeKey, Adapter>>;
  /** Inject clock for deterministic duration tests. */
  now?: () => number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function modelFromOptions(provider: string, options?: Record<string, unknown>): string {
  const candidates = ["transformer", "t2iTransformer", "vae", "encoder"];
  for (const k of candidates) {
    const v = options?.[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return provider;
}

function imageKind(_provider: string): ArtifactKind {
  return "image";
}

// ─── Per-package adaptors (Details → ToolResult). Exported for unit testing. ─

export function adaptKrea2(
  req: GenerateRequest,
  details: Krea2Details,
  summary: string,
  stderrTailStr: string,
  env?: Record<string, string | undefined>,
): ToolResult {
  return {
    success: details.ok,
    provider: "krea2",
    command: details.command,
    artifacts: details.outputs.map((o) => ({
      path: o.path,
      kind: imageKind("krea2"),
      seed: o.seed,
      width: o.width,
      height: o.height,
      bytes: o.sizeBytes,
    })),
    error: details.ok ? null : `${summary}\n${stderrTailStr}`.trim(),
    cost_usd: details.ok ? costFor(req.capability, null, env) : 0,
    // krea2 emits no wall time; the generate() wrapper measures it.
    duration_seconds: null,
    seed: details.seed,
    model: modelFromOptions("krea2", req.options),
  };
}

export function adaptFlux2(
  req: GenerateRequest,
  details: Flux2Details,
  summary: string,
  stderrTailStr: string,
  env?: Record<string, string | undefined>,
): ToolResult {
  return {
    success: details.ok,
    provider: "flux2",
    command: details.command,
    artifacts: details.outputs.map((o) => ({
      path: o.path,
      kind: imageKind("flux2"),
      seed: o.seed,
      width: o.width,
      height: o.height,
      bytes: o.sizeBytes,
    })),
    error: details.ok ? null : `${summary}\n${stderrTailStr}`.trim(),
    cost_usd: details.ok ? costFor(req.capability, details.perf.totalSeconds ?? null, env) : 0,
    duration_seconds: details.perf.totalSeconds,
    seed: details.seed,
    model: modelFromOptions("flux2", req.options),
  };
}

export function adaptLtx(
  req: GenerateRequest,
  details: LtxDetails,
  summary: string,
  stderrTailStr: string,
  env?: Record<string, string | undefined>,
): ToolResult {
  const artifacts: Artifact[] = [];
  if (details.output) {
    artifacts.push({
      path: details.output,
      kind: details.command.startsWith("native-t2a") ? "audio" : req.capability === "video_generation" ? "video" : "unknown",
      width: details.width,
      height: details.height,
      role: "primary",
    });
  }
  for (const [role, path] of Object.entries(details.extraOutputs)) {
    const kind: ArtifactKind = role.includes("audio")
      ? "audio"
      : role.includes("frame") || role.includes("Frame")
        ? "frames"
        : role.includes("mp4") || role.includes("video") || role.startsWith("segment")
          ? "video"
          : role.includes("dir")
            ? "directory"
            : "unknown";
    artifacts.push({ path, kind, role });
  }
  return {
    success: details.ok,
    provider: "ltx",
    command: details.command,
    artifacts,
    error: details.ok ? null : `${summary}\n${stderrTailStr}`.trim(),
    cost_usd: details.ok ? costFor(req.capability, details.wallSeconds ?? null, env) : 0,
    duration_seconds: details.wallSeconds,
    seed: (req.options?.seed as number | undefined) ?? null,
    model: modelFromOptions("ltx", req.options),
  };
}

// ─── Real adapters (call the directors). The default for generate(). ─────────

/**
 * normalizeLegacyImageRequest — angle/swap/anime2real/expansion/i2i/restore/
 * inpaint/faceswap used to route to runpy_image (RunPyImageOptions field
 * names: inputImage/referenceImage/denoiseStrength/loraPath/...). 2026-07-13:
 * they moved onto the equivalent flux2/krea2 Swift command, whose field names
 * mostly already match but diverge on a few keys, and two (anime2real/
 * expansion/restore) use a different command name on the Swift side
 * (style+preset / expand / i2i).
 * This normalizes an incoming request so BOTH the legacy RunPyImageOptions
 * shape and the native flux2/krea2 field names work unchanged — existing
 * callers don't need to update. No-op for every other command (t2i, scene,
 * edit, ...).
 */
export function normalizeLegacyImageRequest(req: GenerateRequest): GenerateRequest {
  if (req.capability === "enhancement" && req.command === "upscale") {
    // flux2 upscale (Swift/MLX, RealPLKSR 4x-nomos-webphoto-realplksr) is the sole
    // upscale provider since the Python esrgan adapter was removed (2026-07-19).
    // flux2's upscale command uses "input"/"output"; this maps any legacy caller
    // still passing "image" (the old esrgan field name) onto "input".
    const o = req.options ?? {};
    return { ...req, options: { ...o, input: o.input ?? o.image } };
  }
  if (req.capability !== "image_generation") return req;
  const o = req.options ?? {};
  switch (req.command) {
    case "angle":
      return { ...req, options: { ...o, input: o.input ?? o.inputImage } };
    case "swap":
      return { ...req, options: { ...o, source: o.source ?? o.inputImage ?? o.input } };
    case "i2i":
      return { ...req, options: { ...o, input: o.input ?? o.inputImage, strength: o.strength ?? o.denoiseStrength } };
    case "restore":
      // image-restore.py == image-i2i.py with reference_image forced None (no
      // ControlNet) and no other overrides; krea2's native i2i has no
      // ControlNet concept at all (pure SDEdit), so restore==i2i exactly.
      return { ...req, command: "i2i", options: { ...o, input: o.input ?? o.inputImage, strength: o.strength ?? o.denoiseStrength } };
    case "anime2real":
      return { ...req, command: "style", options: { ...o, preset: o.preset ?? "anime2real", input: o.input ?? o.inputImage } };
    case "expansion":
      return { ...req, command: "expand", options: { ...o, input: o.input ?? o.inputImage } };
    case "inpaint":
      // Legacy RunPyImageOptions used inputImage/referenceImage; flux2's native
      // inpaint command uses input/reference (mask/prompt names already match).
      // Legacy --crop (Union 2.1 crop-for-detail) has no native equivalent yet
      // (see registry.ts flux2_image notes) — silently dropped, not translated.
      return {
        ...req,
        options: {
          ...o,
          input: o.input ?? o.inputImage,
          reference: o.reference ?? o.referenceImage,
        },
      };
    case "faceswap":
      // Legacy RunPyImageOptions used `input` for the target body image
      // (image-faceswap.py's --input) and `loraPath`/`loraScale` for the BFS
      // LoRA override; flux2's native faceswap command uses body/face/lora/
      // loraScale (`lora` takes a bare NAME under models/lora/, matching
      // resolve_lora_path's short-name resolution, not loraPath's full path).
      // `mode`/`prompt` field names already match.
      return {
        ...req,
        options: {
          ...o,
          body: o.body ?? o.input ?? o.inputImage,
          lora: o.lora ?? o.loraPath,
        },
      };
    default:
      return req;
  }
}

async function realKrea2(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const normalized = normalizeLegacyImageRequest(req);
  const out = await runKrea2({
    command: normalized.command as Krea2Command,
    options: normalized.options,
    outputDir: normalized.outputDir,
    modelsRoot: normalized.modelsRoot,
    extraArgs: normalized.extraArgs,
  });
  return adaptKrea2(normalized, out.details, out.summary, out.stderrTail, env);
}

async function realFlux2(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const normalized = normalizeLegacyImageRequest(req);
  const out = await runFlux2({
    command: normalized.command as Flux2Command,
    options: normalized.options,
    outputDir: normalized.outputDir,
    modelsRoot: normalized.modelsRoot,
    extraArgs: normalized.extraArgs,
  });
  return adaptFlux2(normalized, out.details, out.summary, out.stderrTail, env);
}

async function realLtx(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const out = await runLtx({
    command: req.command as LtxCommand,
    options: req.options,
    outputDir: req.outputDir,
    modelsRoot: req.modelsRoot,
    extraArgs: req.extraArgs,
  });
  return adaptLtx(req, out.details, out.summary, out.stderrTail, env);
}

/**
 * adaptRunPy — normalize a run.py video t2i2v result into the same ToolResult
 * shape the swift directors emit. The single artifact is the produced .mp4
 * (kind:"video"); ok = run.py exited 0 AND the mp4 landed on disk (a 0-exit
 * review/empty run is NOT a generation success). The model id comes from the
 * manifest's i2v stage transformer (local silicon — never cloud).
 */
export function adaptRunPy(
  req: GenerateRequest,
  details: RunPyVideoDetails,
  summary: string,
  stderrTailStr: string,
  env?: Record<string, string | undefined>,
): ToolResult {
  const artifacts: Artifact[] = [];
  if (details.output) {
    artifacts.push({ path: details.output, kind: "video", role: "primary" });
  }
  return {
    success: details.ok,
    provider: "ltx-runpy",
    command: details.command,
    artifacts,
    error: details.ok ? null : `${summary}\n${stderrTailStr}`.trim(),
    cost_usd: details.ok ? costFor(req.capability, null, env) : 0,
    duration_seconds: null,
    seed: (req.options?.seed as number | undefined) ?? null,
    // Prefer the manifest's i2v transformer (local) when present; fall back to a
    // local label so the result never reads as a cloud model id.
    model: details.model ?? "run.py:t2i2v",
  };
}

async function realRunPy(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const out = await runPyVideo({
    options: (req.options ?? {}) as RunPyVideoOptions,
    outputDir: req.outputDir,
    extraArgs: req.extraArgs,
  });
  return adaptRunPy(req, out.details, out.summary, out.stderrTail, env);
}

/**
 * adaptCaption — normalize a run.py caption result into a ToolResult. The single
 * artifact is the produced <image>.caption.json (kind:"text" — an analysis text
 * output, the chaining handle for OM's review/retrieval tiers); ok = run.py
 * exited 0 AND the caption JSON landed + parsed. The model id is the resolved
 * local VLM recorded in the JSON (the gemma brain — never a cloud id).
 */
export function adaptCaption(
  req: GenerateRequest,
  details: CaptionDetails,
  summary: string,
  stderrTailStr: string,
  env?: Record<string, string | undefined>,
): ToolResult {
  const artifacts: Artifact[] = [];
  if (details.captionPath) {
    artifacts.push({ path: details.captionPath, kind: "text", role: "caption" });
  }
  return {
    success: details.ok,
    provider: "caption-vlm",
    command: details.command,
    artifacts,
    error: details.ok ? null : `${summary}\n${stderrTailStr}`.trim(),
    // Analysis is local silicon: nominal $0 (honest), env-overridable like image.
    cost_usd: details.ok ? costFor(req.capability, null, env) : 0,
    duration_seconds: null,
    seed: null,
    // Prefer the JSON's recorded model (the resolved gemma brain); fall back to a
    // local label so the result never reads as a cloud model id.
    model: details.model ?? "run.py:caption",
  };
}

/**
 * realCaption — caption dispatch. All 14 styles (default/t2i/photography/profile/
 * style/score/review/video_score/video_analysis/compare/playwright/lora_quality/
 * ltx_i2v/pose_dsg) run natively via caption_native.ts → LM Studio VLM (zero
 * run.py): `--samples` median, pose_dsg recomputed aggregates, and video keyframe
 * captioning are all ported. The Python `run.py caption` path is no longer on the
 * runtime dispatch (2026-07-19 zero-python migration).
 */
async function realCaption(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const options = (req.options ?? {}) as unknown as CaptionOptions;
  const { runCaptionNative } = await import("./caption_native.ts");
  const out = await runCaptionNative({ options });
  return adaptCaption(req, out.details, out.summary, out.stderrTail, env);
}

/**
 * adaptRunPyImage — normalize a run.py image result into the same ToolResult
 * shape the swift directors emit. Each produced image (manifest output_files[],
 * or the globbed newest-image fallback) becomes one kind:"image" artifact carrying
 * its seed/width/height/bytes when the manifest recorded them. ok = run.py exited
 * 0 AND a real image landed on disk (a 0-exit review/list-only run is NOT a
 * generation success — mirrors adaptRunPy). The model id is the manifest's local
 * transformer basename (zimage / flux2-klein / lens — never a cloud id).
 */
export function adaptRunPyImage(
  req: GenerateRequest,
  details: RunPyImageDetails,
  summary: string,
  stderrTailStr: string,
  env?: Record<string, string | undefined>,
): ToolResult {
  const artifacts: Artifact[] = details.outputs.map((o) => ({
    path: o.path,
    kind: "image",
    seed: o.seed ?? null,
    width: o.width ?? null,
    height: o.height ?? null,
    bytes: o.sizeBytes ?? null,
    role: "primary",
  }));
  return {
    success: details.ok,
    provider: "runpy-image",
    command: details.command,
    artifacts,
    error: details.ok ? null : `${summary}\n${stderrTailStr}`.trim(),
    cost_usd: details.ok ? costFor(req.capability, null, env) : 0,
    duration_seconds: details.elapsedSeconds,
    seed: (req.options?.seed as number | undefined) ?? details.outputs[0]?.seed ?? null,
    // Prefer the manifest's local transformer basename; fall back to a local label
    // so the result never reads as a cloud model id.
    model: details.model ?? `run.py:${details.command}`,
  };
}

async function realRunPyImage(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const out = await runPyImage({
    options: (req.options ?? {}) as RunPyImageOptions,
    outputDir: req.outputDir,
    extraArgs: req.extraArgs,
  });
  return adaptRunPyImage(req, out.details, out.summary, out.stderrTail, env);
}

/**
 * isNativeControlNetRequest — decide whether a `controlnet` request can reach
 * swift/krea2-image-director's native Krea2ControlNet.swift (Control LoRA +
 * Krea 2 Turbo) instead of run.py's image-controlnet.py (canny/scribble/raw
 * preprocessing, Z-Image/Flux2-Klein).
 *
 * The native command does ZERO preprocessing of its own — it consumes
 * whatever `controlImage` it's handed as an already-computed conditioning
 * map (depth/pose/edge). So the native path is only safe when:
 *   1. the caller supplies the native `controlImage` field at all (legacy
 *      callers using run.py's `inputImage`/`controlnetType` shape never set
 *      this — default stays run.py, zero behavior change for them), AND
 *   2. no Python-only preprocessing knob is requested: `controlnetType`
 *      other than "raw"/"depth" (canny/scribble/pose/hed all need the
 *      built-in cv2/model preprocessing run.py has and Swift doesn't),
 *      `blurRef`, `removeOutlines`, or `controlnetAbTest`.
 *
 * Conservative by design — a false negative just costs a Python subprocess
 * (current behavior, no regression); a false positive would hand the Swift
 * binary a raw non-conditioning image and either crash or silently produce a
 * garbage generation, which is why every ambiguous case here routes to
 * run.py instead of guessing.
 */
export function isNativeControlNetRequest(options: Record<string, unknown>): boolean {
  if (options.controlImage == null) return false;
  if (options.blurRef != null || options.removeOutlines || options.controlnetAbTest) return false;
  const ctype = options.controlnetType;
  if (ctype != null && ctype !== "raw" && ctype !== "depth") return false;
  return true;
}

/**
 * realControlNet — style-forked (caption.ts pattern) controlnet dispatch.
 * Unlike caption's fork (same underlying VLM call, just re-implemented in
 * Bun), the native and run.py controlnet paths are genuinely DIFFERENT
 * mechanisms (Krea 2 Turbo + Control LoRA vs Z-Image/Flux2-Klein + cv2
 * preprocessing) — see isNativeControlNetRequest for the exact split and
 * registry.ts's controlnet_hybrid entry for the rationale. Native path
 * reuses realKrea2 (so normalizeLegacyImageRequest / adaptKrea2 stay the
 * single source of truth for krea2 dispatch); Python path is the pre-existing
 * realRunPyImage, unchanged.
 */
async function realControlNet(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const options = (req.options ?? {}) as Record<string, unknown>;
  if (isNativeControlNetRequest(options)) {
    return realKrea2({ ...req, command: "controlnet" }, env);
  }
  return realRunPyImage(req, env);
}

/**
 * isNativeWorkflowRequest — decide whether a `workflow` request can reach
 * workflow_native.ts (base gen + optional ESRGAN upscale, both already
 * Swift-native) instead of run.py's image-workflow.py (full 4-stage
 * pipeline incl. mediapipe face-detailer, numpy/PIL/cv2 post-process, and
 * SeedVR2). See workflow_native.ts's module doc for the full per-stage
 * portability investigation this gate is based on.
 *
 * Native path is only safe when NONE of the remaining non-portable stages
 * are requested: LUT color-grading (`lut`/`lutPath`/`lut_path` — no `.cube`
 * asset or caller exists anywhere in this repo, deferred, see
 * `.planning/specs/2026-08-03-postprocess-swift-native-port-design.md`), or
 * `upscale_method: "seedvr2"` (confirmed PyTorch/torch-MPS-only, no
 * MLX/Swift port anywhere). face-detail is native (FaceDetector.swift's
 * VNDetectFaceRectanglesRequest, 2026-08-02), and film-grain/sharpening/
 * skin-contrast/noise-clean are native too (PostProcessFilters.swift, pure
 * MLXArray reimplementation, 2026-08-03) — see workflow_native.ts's module
 * doc.
 *
 * Checks BOTH `options` (typed/camelCase or snake_case field names — callers
 * use either) and `extraArgs` (raw CLI tokens; runpy_image.ts's
 * RunPyImageOptions has no typed fields for these knobs, so callers commonly
 * pass them as raw `--film-grain 0.02`-style tokens instead). Conservative by
 * design, same as isNativeControlNetRequest — a false negative just costs a
 * Python subprocess (current behavior, no regression); a false positive
 * would silently drop a requested stage, which this function exists to
 * prevent.
 */
export function isNativeWorkflowRequest(options: Record<string, unknown>, extraArgs?: string[]): boolean {
  const truthy = (v: unknown): boolean => {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v > 0;
    if (typeof v === "string") return v.length > 0;
    return v != null;
  };
  const NONPORTABLE_OPTION_KEYS = [
    "lut", "lutPath", "lut_path",
  ];
  for (const k of NONPORTABLE_OPTION_KEYS) {
    if (truthy(options[k])) return false;
  }
  const upscaleMethod = options.upscaleMethod ?? options.upscale_method;
  if (upscaleMethod === "seedvr2") return false;

  const NONPORTABLE_FLAGS = new Set([
    "--lut", "--lut-strength",
  ]);
  for (const a of extraArgs ?? []) {
    if (NONPORTABLE_FLAGS.has(a)) return false;
  }
  if ((extraArgs ?? []).includes("seedvr2")) return false;

  return true;
}

/**
 * isNativePurifyRequest — decide whether a `purify` request can reach
 * flux2's native `styletransfer` command (via purify_native.ts) instead of
 * run.py's image-purify.py.
 *
 * `--backend transformer` is pure parameter computation around a
 * flux2-klein SDEdit img2img call — already Swift-native as `styletransfer`.
 * `--backend seedvr2` (the default) is confirmed PyTorch/torch-MPS-only, and
 * `--remove` (subtitle/watermark/screen-ui removal) is a separate, larger
 * new-algorithm effort with no existing Swift primitive for its mask-union/
 * dilate/median-fill/feathered-composite steps — see
 * .planning/specs/2026-08-05-purify-transformer-backend-swift-native-port-design.md.
 * Both stay on run.py, unchanged.
 *
 * The `.png` extension check exists because `purify_native.ts`'s dimension
 * probe (`probePngDimensions`) only parses the PNG IHDR chunk — deciding
 * this up front (not attempting native work and falling back on failure)
 * matches every other native/Python fork in this file
 * (isNativeControlNetRequest/isNativeWorkflowRequest never retry-on-failure).
 * purify's Python flag is `--input-image` (`RunPyImageOptions.inputImage`) —
 * NOT the same `input` field angle/profile/expansion/review use.
 */
export function isNativePurifyRequest(options: Record<string, unknown>): boolean {
  if (options.backend !== "transformer") return false;
  const remove = options.remove;
  if (remove != null && remove !== "none") return false;
  const inputImage = options.inputImage;
  if (typeof inputImage !== "string" || !/\.png$/i.test(inputImage)) return false;
  return true;
}

/**
 * realPurify — style-forked (controlnet_hybrid/workflow_hybrid pattern)
 * purify dispatch. Native path: purify_native.ts's runPurifyTransformerNative
 * (flux2 styletransfer). Fallback path: the pre-existing realRunPyImage,
 * unchanged. See isNativePurifyRequest for the exact split.
 */
async function realPurify(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const options = (req.options ?? {}) as Record<string, unknown>;
  if (!isNativePurifyRequest(options)) {
    return realRunPyImage(req, env);
  }
  const { runPurifyTransformerNative } = await import("./purify_native.ts");
  const inputImage = String(options.inputImage);
  const out = await runPurifyTransformerNative({
    inputImage,
    mode: options.purifyMode as PurifyMode | undefined,
    resolution: options.resolution as string | number | undefined,
    seed: options.seed as number | undefined,
    prompt: options.prompt as string | undefined,
    transformer: options.transformer as string | undefined,
  });
  // adaptFlux2 sets `command` from Flux2Details.command, which reports the
  // real underlying flux2 subcommand ("styletransfer"). Normalize it back to
  // "purify" — the caller-facing command name — matching realControlNet's
  // command-forcing and realWorkflow's hardcoded "image workflow" (both
  // present the outer command name, not an internal implementation detail).
  return { ...adaptFlux2(req, out.details, out.summary, out.stderrTail, env), command: "purify" };
}

/**
 * realWorkflow — style-forked (caption.ts/controlnet_hybrid pattern)
 * workflow dispatch. Native path: workflow_native.ts's base-gen (+optional
 * ESRGAN upscale) orchestration. Fallback path: the pre-existing
 * realRunPyImage, unchanged. See isNativeWorkflowRequest for the exact split.
 */
async function realWorkflow(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const options = (req.options ?? {}) as Record<string, unknown>;
  if (!isNativeWorkflowRequest(options, req.extraArgs)) {
    return realRunPyImage(req, env);
  }

  const started = Date.now();
  try {
    const { runWorkflowNative } = await import("./workflow_native.ts");
    const postProcess = {
      filmGrain: (options.filmGrain as number | undefined) ?? (options.film_grain as number | undefined),
      sharpening: options.sharpening as number | undefined,
      skinContrast: Boolean(options.skinContrast ?? options.skin_contrast),
      noiseClean: Boolean(options.noiseClean ?? options.noise_clean),
    };
    const hasPostProcess = Boolean(
      postProcess.filmGrain || postProcess.sharpening || postProcess.skinContrast || postProcess.noiseClean);
    const result = await runWorkflowNative({
      prompt: options.prompt as string | undefined,
      input: (options.input as string | undefined) ?? (options.inputImage as string | undefined),
      width: options.width as number | undefined,
      height: options.height as number | undefined,
      steps: options.steps as number | undefined,
      seed: options.seed as number | undefined,
      loraPath: (options.loraPath as string | undefined) ?? (options.lora_path as string | undefined),
      loraScale: (options.loraScale as number | undefined) ?? (options.lora_scale as number | undefined),
      denoiseStrength: (options.denoiseStrength as number | undefined) ?? (options.denoise_strength as number | undefined),
      faceDetail: Boolean(options.faceDetail ?? options.face_detail),
      postProcess: hasPostProcess ? postProcess : undefined,
      upscale: Boolean(options.upscale),
      upscaleModel: (options.upscaleModel as string | undefined) ?? (options.upscale_model as string | undefined),
      outputDir: req.outputDir,
    });
    return {
      success: true,
      provider: "workflow-native",
      command: "image workflow",
      artifacts: [{ path: result.finalImage, kind: "image", seed: result.seed, width: result.width, height: result.height, role: "primary" }],
      error: null,
      cost_usd: costFor(req.capability, null, env),
      duration_seconds: (Date.now() - started) / 1000,
      seed: result.seed,
      model: "zimage:t2i/i2i"
        + (result.stages.includes("face_detail") ? "+flux2:face-detail" : "")
        + (result.stages.includes("postprocess") ? "+flux2:postprocess" : "")
        + (result.stages.includes("upscale") ? "+flux2:upscale" : ""),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      provider: "workflow-native",
      command: "image workflow",
      artifacts: [],
      error: msg,
      cost_usd: 0,
      duration_seconds: (Date.now() - started) / 1000,
      seed: null,
      model: "zimage:t2i/i2i",
    };
  }
}

/**
 * adaptRunPyStory — normalize a run.py story result. angles/propose produce a
 * structured text artifact (the angles.json / proposal.yaml the agent reads for
 * the approval gate, kind:"text"); shots produces storyboard image frames
 * (kind:"image", delegated to `image storyboard`). ok = run.py exited 0 AND the
 * sub-action's expected artifact parsed (angles/concepts) or ≥1 frame landed
 * (shots). LOCAL MLX + local gemma brain — never a cloud id.
 */
export function adaptRunPyStory(
  req: GenerateRequest,
  details: RunPyStoryDetails,
  summary: string,
  stderrTailStr: string,
  env?: Record<string, string | undefined>,
): ToolResult {
  const artifacts: Artifact[] = [];
  // angles/propose: the structured artifact is the deliverable.
  if (details.artifactPath) {
    artifacts.push({ path: details.artifactPath, kind: "text", role: "primary" });
  }
  // shots: the delegated storyboard frames.
  for (const p of details.outputs) {
    artifacts.push({ path: p, kind: "image", role: "primary" });
  }
  return {
    success: details.ok,
    provider: "runpy-story",
    command: details.command,
    artifacts,
    error: details.ok ? null : `${summary}\n${stderrTailStr}`.trim(),
    cost_usd: details.ok ? costFor(req.capability, null, env) : 0,
    duration_seconds: null,
    seed: null,
    model: "run.py:story",
  };
}

async function realRunPyStory(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const out = await runPyStory({
    options: (req.options ?? {}) as RunPyStoryOptions,
    outputDir: req.outputDir,
    extraArgs: req.extraArgs,
  });
  return adaptRunPyStory(req, out.details, out.summary, out.stderrTail, env);
}

/**
 * realStoryNative — angles/propose via a direct LM Studio call (story_native.ts),
 * NOT a run.py subprocess (2026-07-13 migration — see story_native.ts's header).
 * Writes the same <base>_angles.json / <base>_proposal.yaml artifact shape
 * run.py's story.py wrote, so downstream consumers (`story shots` → `image
 * storyboard --proposal <path>`) keep working unchanged. LOCAL ONLY: LM Studio
 * always resolves to localhost.
 */
async function realStoryNative(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const opts = (req.options ?? {}) as { topic?: string; count?: number; vlmApiUrl?: string; vlmModel?: string };
  const topic = (opts.topic ?? "").trim();
  if (!topic) {
    return {
      success: false,
      provider: "story-native",
      command: `story ${req.command}`,
      artifacts: [],
      error: `story ${req.command}: --topic is required`,
      cost_usd: 0,
      duration_seconds: null,
      seed: null,
      model: "lmstudio:story",
    };
  }
  const outDir = req.outputDir ?? join(resolveRepoRoot(), "..", "video_generation__output");
  const base = `story_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const started = Date.now();
  try {
    if (req.command === "propose") {
      const { runStoryProposeNative, proposalToYaml } = await import("./story_native.ts");
      const { concepts } = await runStoryProposeNative(topic, opts.count ?? 2, { apiUrl: opts.vlmApiUrl, model: opts.vlmModel });
      const path = join(outDir, `${base}_proposal.yaml`);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path, proposalToYaml(concepts));
      return {
        success: concepts.length > 0,
        provider: "story-native",
        command: "story propose",
        artifacts: [{ path, kind: "text", role: "primary" }],
        error: concepts.length > 0 ? null : "story propose: LM Studio returned no concepts",
        cost_usd: costFor(req.capability, null, env),
        duration_seconds: (Date.now() - started) / 1000,
        seed: null,
        model: "lmstudio:story-propose",
      };
    }
    // "angles" (default).
    const { runStoryAnglesNative } = await import("./story_native.ts");
    const { angles } = await runStoryAnglesNative(topic, opts.count ?? 3, { apiUrl: opts.vlmApiUrl, model: opts.vlmModel });
    const path = join(outDir, `${base}_angles.json`);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path, JSON.stringify(angles, null, 2));
    return {
      success: angles.length > 0,
      provider: "story-native",
      command: "story angles",
      artifacts: [{ path, kind: "text", role: "primary" }],
      error: angles.length > 0 ? null : "story angles: LM Studio returned no angles",
      cost_usd: costFor(req.capability, null, env),
      duration_seconds: (Date.now() - started) / 1000,
      seed: null,
      model: "lmstudio:story-angles",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      provider: "story-native",
      command: `story ${req.command}`,
      artifacts: [],
      error: msg,
      cost_usd: 0,
      duration_seconds: (Date.now() - started) / 1000,
      seed: null,
      model: "lmstudio:story",
    };
  }
}

/**
 * adaptRunPyTts — normalize a run.py tts (edge-tts) result. The single artifact
 * is the produced narration audio (kind:"audio"); ok = run.py exited 0 AND the
 * requested file landed with real content (mirrors runPyTts's own "0-exit but
 * nothing written is NOT success" stance). Cost is real but small (edge-tts is
 * free); duration_seconds is the audio's own length, not measurable here without
 * probing the file, so it stays null (the caller can ffprobe the artifact path
 * if it needs the real duration — same as every other audio-producing adapter).
 */
export function adaptRunPyTts(
  req: GenerateRequest,
  details: RunPyTtsDetails,
  summary: string,
  stderrTailStr: string,
  env?: Record<string, string | undefined>,
): ToolResult {
  const artifacts: Artifact[] = [];
  if (details.output) {
    artifacts.push({ path: details.output, kind: "audio", role: "primary", bytes: details.sizeBytes ?? undefined });
  }
  return {
    success: details.ok,
    provider: "edge-tts",
    command: details.command,
    artifacts,
    error: details.ok ? null : `${summary}\n${stderrTailStr}`.trim(),
    // edge-tts is a free Microsoft service — honest $0 marginal cost, same
    // stance as the local-silicon providers even though this one needs network.
    cost_usd: details.ok ? costFor(req.capability, null, env) : 0,
    duration_seconds: null,
    seed: null,
    model: details.voice ?? "edge-tts",
  };
}

async function realRunPyTts(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const opts = (req.options ?? {}) as unknown as RunPyTtsOptions & { output?: string };
  const outputDir = req.outputDir ?? process.cwd();
  const output = opts.output ?? join(outputDir, "tts_edge.mp3");
  const out = await runPyTts({ options: opts, output });
  return adaptRunPyTts(req, out.details, out.summary, out.stderrTail, env);
}

/**
 * adaptRunPyMusic — normalize a run.py music (local MLX MusicGen) result. The
 * single artifact is the produced score track (kind:"audio"); ok = run.py
 * exited 0 AND the requested file landed with real content (mirrors
 * adaptRunPyTts's "0-exit but nothing written is NOT success" stance).
 * MusicGen is fully local/on-device — same honest $0 marginal-cost stance the
 * other local-silicon providers use.
 */
export function adaptRunPyMusic(
  req: GenerateRequest,
  details: RunPyMusicDetails,
  summary: string,
  stderrTailStr: string,
  env?: Record<string, string | undefined>,
): ToolResult {
  const artifacts: Artifact[] = [];
  if (details.output) {
    artifacts.push({ path: details.output, kind: "audio", role: "primary", bytes: details.sizeBytes ?? undefined });
  }
  return {
    success: details.ok,
    provider: "musicgen",
    command: details.command,
    artifacts,
    error: details.ok ? null : `${summary}\n${stderrTailStr}`.trim(),
    cost_usd: details.ok ? costFor(req.capability, null, env) : 0,
    duration_seconds: details.duration ?? null,
    seed: null,
    model: details.model ?? "musicgen",
  };
}

async function realRunPyMusic(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const opts = (req.options ?? {}) as unknown as RunPyMusicOptions & { output?: string };
  const outputDir = req.outputDir ?? process.cwd();
  const output = opts.output ?? join(outputDir, "music.wav");
  const out = await runPyMusic({ options: opts, output });
  return adaptRunPyMusic(req, out.details, out.summary, out.stderrTail, env);
}

/**
 * realTtsNative — edge-tts via tts_native.ts's `msedge-tts`-backed Bun client,
 * NOT a run.py subprocess (2026-07-13 migration). Same ToolResult contract
 * shape as adaptRunPyTts (single kind:"audio" artifact); reuses that adapter
 * function directly since the Details shapes are structurally compatible.
 */
async function realTtsNative(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const opts = (req.options ?? {}) as unknown as RunPyTtsOptions & { output?: string };
  const outputDir = req.outputDir ?? process.cwd();
  const output = opts.output ?? join(outputDir, "tts_edge.mp3");
  const { runTtsNative } = await import("./tts_native.ts");
  const out = await runTtsNative(opts, output);
  return adaptRunPyTts(req, { ...out.details, exitCode: out.details.ok ? 0 : 1, aborted: false, stdout: "" }, out.summary, out.stderrTail, env);
}

/**
 * realMusicNative — musicgen-director's compiled Swift binary (music_native.ts,
 * via ensureBinary()), NOT a run.py subprocess (this port — see
 * music_native.ts's header). Reuses adaptRunPyMusic as-is since
 * RunPyMusicOptions/Details are structurally identical between the old
 * runpy_music.ts and the new music_native.ts.
 */
async function realMusicNative(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const opts = (req.options ?? {}) as unknown as RunPyMusicOptions & { output?: string };
  const outputDir = req.outputDir ?? process.cwd();
  const output = opts.output ?? join(outputDir, "music.wav");
  const { runMusicNative } = await import("./music_native.ts");
  const out = await runMusicNative({ options: opts, output });
  return adaptRunPyMusic(req, out.details, out.summary, out.stderrTail, env);
}

/**
 * adaptKokoroTts — normalize a kokoro-tts (local Swift/MLX Kokoro-82M) result.
 * A SEPARATE function from adaptRunPyTts (NOT reused) — adaptRunPyTts
 * hardcodes provider:"edge-tts", which would be wrong here. Same artifact/
 * cost/duration conventions as adaptRunPyMusic (fully local, honest $0
 * marginal cost).
 */
export function adaptKokoroTts(
  req: GenerateRequest,
  details: RunPyTtsDetails,
  summary: string,
  stderrTailStr: string,
  env?: Record<string, string | undefined>,
): ToolResult {
  const artifacts: Artifact[] = [];
  if (details.output) {
    artifacts.push({ path: details.output, kind: "audio", role: "primary", bytes: details.sizeBytes ?? undefined });
  }
  return {
    success: details.ok,
    provider: "kokoro",
    command: details.command,
    artifacts,
    error: details.ok ? null : `${summary}\n${stderrTailStr}`.trim(),
    cost_usd: details.ok ? costFor(req.capability, null, env) : 0,
    duration_seconds: null,
    seed: null,
    model: details.voice ?? "kokoro-82m",
  };
}

/**
 * realKokoroTtsNative — kokoro-tts's compiled Swift binary
 * (kokoro_tts_native.ts, via ensureBinary()), local Kokoro-82M TTS. `voice`
 * is REQUIRED (no default, unlike edge-tts) — the caller (or the agent tool
 * wrapper) must always pass one; there is no single sensible default across
 * English/Mandarin voice namespaces.
 */
async function realKokoroTtsNative(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const opts = (req.options ?? {}) as unknown as KokoroTtsOptions & { output?: string };
  const outputDir = req.outputDir ?? process.cwd();
  const output = opts.output ?? join(outputDir, "tts_kokoro.wav");
  const { runKokoroTtsNative } = await import("./kokoro_tts_native.ts");
  const out = await runKokoroTtsNative({ options: opts, output });
  return adaptKokoroTts(req, out.details, out.summary, out.stderrTail, env);
}

/**
 * realTwosubjectNative — the VLM-driven single-prompt two-subject loop via
 * twosubject_native.ts, NOT a run.py subprocess (2026-07-13 migration — see
 * that module's header). The single artifact is the winning composite image
 * (kind:"image"); ok = the loop produced a scored winner (runTwosubjectNative
 * throws otherwise, caught below into success:false, mirroring the Python's
 * sys.exit(1) on "no candidate produced a parseable score").
 */
async function realTwosubjectNative(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const opts = (req.options ?? {}) as Record<string, unknown>;
  const started = Date.now();
  try {
    const { runTwosubjectNative } = await import("./twosubject_native.ts");
    const result = await runTwosubjectNative({
      charA: opts.charA as string | undefined,
      charB: opts.charB as string | undefined,
      refA: opts.refA as string | undefined,
      refB: opts.refB as string | undefined,
      candidates: opts.candidates as number | undefined,
      rounds: opts.rounds as number | undefined,
      minOverall: opts.minOverall as number | undefined,
      style: opts.style as string | undefined,
      width: opts.width as number | undefined,
      height: opts.height as number | undefined,
      steps: opts.steps as number | undefined,
      detail: opts.detail as boolean | undefined,
      seed: opts.seed as number | undefined,
      seedStart: opts.seedStart as number | undefined,
      vlmApiUrl: opts.vlmApiUrl as string | undefined,
      vlmModel: opts.vlmModel as string | undefined,
      outputDir: req.outputDir,
    });
    return {
      success: true,
      provider: "twosubject-native",
      command: "image twosubject",
      artifacts: [{ path: result.winnerPath, kind: "image", role: "primary" }],
      error: null,
      cost_usd: costFor(req.capability, null, env),
      duration_seconds: (Date.now() - started) / 1000,
      seed: result.winnerSeed,
      model: "krea2:z-image",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      provider: "twosubject-native",
      command: "image twosubject",
      artifacts: [],
      error: msg,
      cost_usd: 0,
      duration_seconds: (Date.now() - started) / 1000,
      seed: null,
      model: "krea2:z-image",
    };
  }
}

/**
 * realProfileNative — the multi-view (front/back/side) character-profile loop
 * via profile_native.ts, NOT a run.py subprocess (2026-07-13 migration — see
 * that module's header). Each requested view's `angle` call becomes one
 * kind:"image" artifact (role:"primary", mirroring adaptRunPyImage's
 * multi-output shape); ok = at least one view was generated (runProfileNative
 * throws otherwise — no partial-success mode, mirroring the Python's
 * sys.exit(1) on an unhandled generation-loop exception).
 */
async function realProfileNative(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const opts = (req.options ?? {}) as Record<string, unknown>;
  const started = Date.now();
  try {
    const { runProfileNative } = await import("./profile_native.ts");
    const result = await runProfileNative({
      input: (opts.input as string | undefined) ?? (opts.inputImage as string | undefined) ?? "",
      views: opts.views as ("front" | "back" | "side")[] | undefined,
      ratio: opts.ratio as "portrait" | "standing" | "full-body" | "tall" | "9:16" | undefined,
      width: opts.width as number | undefined,
      height: opts.height as number | undefined,
      steps: opts.steps as number | undefined,
      seed: opts.seed as number | undefined,
      refCount: opts.refCount as number | undefined,
      outputDir: req.outputDir,
    });
    return {
      success: result.views.length > 0,
      provider: "profile-native",
      command: "image profile",
      artifacts: result.views.map((v) => ({
        path: v.path,
        kind: "image",
        seed: v.seed,
        width: v.width,
        height: v.height,
        role: "primary",
      })),
      error: null,
      cost_usd: costFor(req.capability, null, env),
      duration_seconds: (Date.now() - started) / 1000,
      seed: result.seed,
      model: "flux2-klein:angle",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      provider: "profile-native",
      command: "image profile",
      artifacts: [],
      error: msg,
      cost_usd: 0,
      duration_seconds: (Date.now() - started) / 1000,
      seed: null,
      model: "flux2-klein:angle",
    };
  }
}

/**
 * realCharacterNative — the character-sheet build via character_native.ts,
 * NOT a run.py subprocess (2026-07-13 migration, session 6 — see that
 * module's header). Orchestrates Phase 1 (profile, delegated straight to
 * runProfileNative) + Phase 2 (per-view flux2 `cutout` alpha-composited
 * PNG, moved off `segment` mask-only 2026-08-01) + Phase 3
 * (IdentitySpec.json, written to `<outputDir>/IdentitySpec.json` when an
 * output dir is resolvable). Each generated view's image becomes one
 * kind:"image" artifact (role:"primary"); the written IdentitySpec.json (if
 * any) rides as a second kind:"text" artifact (role:"metadata"), mirroring
 * how the Python's `Manifest:` sentinel points at the same file. ok = at
 * least one view was generated (runCharacterNative/runProfileNative throw
 * otherwise — no partial-success mode, mirroring the Python's sys.exit(1)).
 */
async function realCharacterNative(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const opts = (req.options ?? {}) as Record<string, unknown>;
  const started = Date.now();
  try {
    const { runCharacterNative, writeIdentitySpec } = await import("./character_native.ts");
    const result = await runCharacterNative({
      input: (opts.input as string | undefined) ?? (opts.inputImage as string | undefined) ?? "",
      views: opts.views as ("front" | "back" | "side")[] | undefined,
      ratio: opts.ratio as "portrait" | "standing" | "full-body" | "tall" | "9:16" | undefined,
      width: opts.width as number | undefined,
      height: opts.height as number | undefined,
      steps: opts.steps as number | undefined,
      seed: opts.seed as number | undefined,
      refCount: opts.refCount as number | undefined,
      refStrength: opts.refStrength as number | undefined,
      styleAnchor: opts.styleAnchor as string | undefined,
      loraPath: opts.loraPath as string | undefined,
      loraScale: opts.loraScale as number | undefined,
      cfgScale: opts.cfgScale as number | undefined,
      pipeline: opts.pipeline as string | undefined,
      cutoutSubject: opts.cutoutSubject as string | undefined,
      samThreshold: opts.samThreshold as number | undefined,
      outputDir: req.outputDir,
    });

    const artifacts: ToolResult["artifacts"] = result.identitySpec.views
      .filter((v) => v.image)
      .map((v) => ({ path: v.image as string, kind: "image" as const, role: "primary" as const }));

    let specPath: string | null = null;
    if (result.outDir) {
      specPath = await writeIdentitySpec(result.outDir, result.identitySpec);
      artifacts.push({ path: specPath, kind: "text" as const, role: "metadata" as const });
    }

    return {
      success: artifacts.some((a) => a.kind === "image"),
      provider: "character-native",
      command: "image character",
      artifacts,
      error: null,
      cost_usd: costFor(req.capability, null, env),
      duration_seconds: (Date.now() - started) / 1000,
      seed: result.identitySpec.lock.seed,
      model: "flux2-klein:angle+cutout",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      provider: "character-native",
      command: "image character",
      artifacts: [],
      error: msg,
      cost_usd: 0,
      duration_seconds: (Date.now() - started) / 1000,
      seed: null,
      model: "flux2-klein:angle+cutout",
    };
  }
}

/**
 * realStoryboardNative — the storyboard core generation line via
 * storyboard_native.ts, NOT a run.py subprocess (2026-08-01 — see that
 * module's header). Each generated frame's image becomes one kind:"image"
 * artifact (role:"primary"); frames whose generation failed are skipped from
 * artifacts (their `image` is null, but still recorded in the returned
 * result for the caller). The written storyboard.json rides as a second
 * kind:"text" artifact (role:"metadata"). ok = at least one frame was
 * generated (runStoryboardNative itself never throws on a per-shot failure
 * — see module doc; it only throws on a scene-loading error, e.g. an
 * unreadable --scenes file).
 */
async function realStoryboardNative(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const opts = (req.options ?? {}) as Record<string, unknown>;
  const started = Date.now();
  try {
    const { runStoryboardNative, writeStoryboardJson } = await import("./storyboard_native.ts");
    const result = await runStoryboardNative({
      scenes: opts.scenes as string | undefined,
      story: opts.story as string | undefined,
      numPanels: opts.numPanels as number | undefined,
      styleHint: opts.styleHint as string | undefined,
      character: (opts.character as string | undefined) ?? (opts.input as string | undefined),
      kontextLock: opts.kontextLock as boolean | undefined,
      seed: opts.seed as number | undefined,
      width: opts.width as number | undefined,
      height: opts.height as number | undefined,
      steps: opts.steps as number | undefined,
      outputDir: req.outputDir,
    });

    const artifacts: ToolResult["artifacts"] = result.frames
      .filter((f) => f.image)
      .map((f) => ({ path: f.image as string, kind: "image" as const, role: "primary" as const }));

    const jsonPath = await writeStoryboardJson(result.outDir, result);
    artifacts.push({ path: jsonPath, kind: "text" as const, role: "metadata" as const });
    if (result.contactSheet) {
      artifacts.push({ path: result.contactSheet, kind: "image" as const, role: "reference" as const });
    }

    return {
      success: artifacts.some((a) => a.kind === "image" && a.role === "primary"),
      provider: "storyboard-native",
      command: "image storyboard",
      artifacts,
      error: null,
      cost_usd: costFor(req.capability, null, env),
      duration_seconds: (Date.now() - started) / 1000,
      seed: (opts.seed as number | undefined) ?? null,
      model: "krea2:t2i+flux2:edit+flux2:kontext",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      provider: "storyboard-native",
      command: "image storyboard",
      artifacts: [],
      error: msg,
      cost_usd: 0,
      duration_seconds: (Date.now() - started) / 1000,
      seed: null,
      model: "krea2:t2i+flux2:edit+flux2:kontext",
    };
  }
}

/** The live adapter map. Tests override entries via GenerateDeps.adapters. */
export function realAdapters(env?: Record<string, string | undefined>): Partial<Record<InvokeKey, Adapter>> {
  return {
    "swift:krea2": (req) => realKrea2(req, env),
    "swift:flux2": (req) => realFlux2(req, env),
    "swift:ltx": (req) => realLtx(req, env),
    "mlx:runpy": (req) => realRunPy(req, env),
    "mlx:runpy-image": (req) => realRunPyImage(req, env),
    "mlx:runpy-story": (req) => realRunPyStory(req, env),
    "bun:lmstudio-story": (req) => realStoryNative(req, env),
    "mlx:runpy-tts": (req) => realRunPyTts(req, env),
    "bun:tts-native": (req) => realTtsNative(req, env),
    "mlx:runpy-music": (req) => realRunPyMusic(req, env),
    "bun:musicgen-native": (req) => realMusicNative(req, env),
    "bun:kokoro-tts": (req) => realKokoroTtsNative(req, env),
    "bun:twosubject-native": (req) => realTwosubjectNative(req, env),
    "bun:profile-native": (req) => realProfileNative(req, env),
    "bun:character-native": (req) => realCharacterNative(req, env),
    "bun:storyboard-native": (req) => realStoryboardNative(req, env),
    "mlx:caption": (req) => realCaption(req, env),
    "mlx:controlnet-hybrid": (req) => realControlNet(req, env),
    "mlx:workflow-hybrid": (req) => realWorkflow(req, env),
    "mlx:purify-hybrid": (req) => realPurify(req, env),
    // Non-native adapters (ffmpeg / pure-Bun subtitle / cloud HTTP) — iteration 3.
    ...nonNativeAdapters(env),
  };
}

// ─── generate(): select → adapt → measure ────────────────────────────────────

export interface GenerateOutcome {
  /** The provider entry that ran (selected by the selector). */
  entry: ProviderEntry;
  result: ToolResult;
}

/**
 * Run a generation end-to-end: the selector picks the provider (or the caller
 * pre-selects), the bridge runs the director via its adapter, and the result is
 * normalized to ToolResult. Cost reconciliation against the budget tracker is
 * the caller's responsibility (the extension wires estimate→reserve→reconcile
 * around this call) — generate() itself is pure of fs/cost IO.
 */
export async function generate(
  entry: ProviderEntry,
  req: GenerateRequest,
  deps: GenerateDeps = {},
): Promise<ToolResult> {
  const env = deps.env;
  const adapters = deps.adapters ?? realAdapters(env);
  const adapter = adapters[entry.invoke];
  const now = deps.now ?? Date.now;
  const start = now();

  const missing = missingRequiredOptions(req);
  if (missing.length > 0) {
    return {
      success: false,
      provider: entry.provider,
      command: req.command,
      artifacts: [],
      error: `${req.capability} requires options.${missing.join(", options.")}`,
      cost_usd: 0,
      duration_seconds: (now() - start) / 1000,
      seed: null,
      model: entry.provider,
    };
  }

  if (!adapter) {
    return {
      success: false,
      provider: entry.provider,
      command: req.command,
      artifacts: [],
      error: `no bridge implemented for invoke "${entry.invoke}" (provider "${entry.name}")`,
      cost_usd: 0,
      duration_seconds: (now() - start) / 1000,
      seed: null,
      model: entry.provider,
    };
  }

  let result: ToolResult;
  try {
    result = await adapter(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = {
      success: false,
      provider: entry.provider,
      command: req.command,
      artifacts: [],
      error: msg,
      cost_usd: 0,
      duration_seconds: (now() - start) / 1000,
      seed: null,
      model: entry.provider,
    };
  }

  // Fill duration from wall time when the director didn't report it (krea2).
  if (result.duration_seconds == null) {
    result = { ...result, duration_seconds: (now() - start) / 1000 };
  }
  return result;
}

/**
 * Convenience: select the provider for a capability then generate. Returns the
 * selected entry alongside the result so the caller can record which provider ran.
 */
export async function selectAndGenerate(
  capability: Capability,
  req: Omit<GenerateRequest, "capability">,
  selectorOpts: SelectorOptions = {},
  deps: GenerateDeps = {},
): Promise<GenerateOutcome> {
  // Default the selector's command to the request's command so a caller that
  // addresses {capability, command} routes correctly without re-passing command
  // in selectorOpts (command-routing tiebreak lives in the selector).
  const entry = selectProvider(capability, { ...selectorOpts, command: selectorOpts.command ?? req.command });

  // Quality-first local narration chain (2026-08-21 A/B: kokoro — local
  // Swift MLX — at latency parity with edge-tts, fully offline, higher
  // quality than `say`; promoted over the 2026-07-11 edge-tts-first chain).
  // The static ranking now lands kokoro for bare tts calls; a REAL runtime
  // failure (binary missing/unbuildable, text edge case) falls through
  // edge-tts (network) and then the offline-safe `say` pick — so the chain
  // never regresses the offline/no-network case, it only upgrades it.
  if (capability === "tts" && !selectorOpts.provider) {
    const chain: string[] = [];
    if (entry.provider !== "kokoro" && entry.provider !== "edge-tts" && entry.provider !== "say") {
      chain.push(entry.provider);
    }
    chain.push("kokoro", "edge-tts", "say");
    let firstFailure: { entry: ProviderEntry; result: ToolResult } | null = null;
    for (const provider of chain) {
      const e = REGISTRY.find((p) => p.capability === "tts" && p.provider === provider && p.configured);
      if (!e) continue;
      const r = await generate(e, { ...req, capability }, deps);
      if (r.success) return { entry: e, result: r };
      firstFailure ??= { entry: e, result: r };
    }
    if (firstFailure) return firstFailure;
  }

  const result = await generate(entry, { ...req, capability }, deps);
  return { entry, result };
}
