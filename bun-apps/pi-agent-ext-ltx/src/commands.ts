/**
 * commands.ts — authoritative map of every `ltx-video` subcommand to its
 * typed parameters + CLI-flag translation.
 *
 * This file is the SINGLE source of truth for the tool's command surface. It is
 * curated against `swift/ltx-video-director/Sources/LTXVideoDirectorCLI/<Cmd>Command.swift`
 * and verified by `scripts/check-flags.ts` (run `ltx-video <cmd> --help` and assert
 * every declared flag is modeled here or allow-listed). Mirrors
 * pi-agent-ext-flux2/src/commands.ts's design exactly — see that file's header
 * for the naming convention.
 *
 * Naming: Swift `@Option var t2iTransformer` -> CLI `--t2i-transformer` (camelCase->kebab).
 * Defaults are intentionally NOT duplicated — `toArgs` only emits a flag when
 * the agent sets a value, so the Swift default always wins. This avoids drift.
 */
import { Type, type TSchema } from "typebox";

export type FieldType = "string" | "number" | "int" | "boolean" | "string[]" | "number[]";

export interface FieldSpec {
  /** CLI flag including dashes, e.g. "--prompt", "--cfg-scale". Use "" for positional. */
  flag: string;
  type: FieldType;
  description: string;
  /** Value is a filesystem path -> path-validated against allowed roots. */
  isPath?: boolean;
  /** Array field where every element is a path. */
  isPathArray?: boolean;
  /**
   * Value is a bare NAME the Swift binary joins onto a models-tree root
   * itself (e.g. `--t2i-transformer moody-pro-mix` -> `RepoPaths.mlxModelsRoot
   * /transformer/<name>`), NOT a path the tool resolves. No ".."-sanitization
   * on the Swift side, so validated as a bare path component.
   */
  isPathComponent?: boolean;
  /**
   * Value (or each array element) is a "path[:strength]" spec — a real
   * filesystem path with an optional ":<float>" suffix (native-i2v's --lora).
   * The path portion is validated as a real path; the suffix is left for the
   * Swift binary's own ValidationError to reject if malformed.
   */
  isPathSpecArray?: boolean;
  /** Positional argument (no flag prefix), appended in declared order. */
  positional?: boolean;
  /**
   * For boolean fields backed by an ArgumentParser `.prefixedNo` inversion
   * (single Swift property, default true, toggled by EITHER --x or --no-x —
   * e.g. native-i2v's --upscale/--no-upscale). `v === false` emits this flag
   * instead of omitting the field; `v === true` emits `flag` as normal.
   * Omit for plain boolean flags (default false, presence sets true).
   */
  invertedFlag?: string;
}

export interface CommandSpec {
  /** CLI subcommand name, e.g. "native-i2v". */
  name: string;
  /** True if the command produces a video/image/audio output parseable from stdout. */
  writesOutput: boolean;
  /** One-line "when to use" for the dispatcher description. */
  when: string;
  fields: Record<string, FieldSpec>;
}

// ─── Field schemas -> typebox ─────────────────────────────────────────────────

function fieldSchema(f: FieldSpec): TSchema {
  const wrap = (t: TSchema): TSchema => Type.Optional(t);
  switch (f.type) {
    case "string":
      return wrap(Type.String({ description: f.description }));
    case "number":
      return wrap(Type.Number({ description: f.description }));
    case "int":
      return wrap(Type.Integer({ description: f.description }));
    case "boolean":
      return wrap(Type.Boolean({ description: f.description }));
    case "string[]":
      return wrap(Type.Array(Type.String(), { description: f.description }));
    case "number[]":
      return wrap(Type.Array(Type.Number(), { description: f.description }));
  }
}

/** Build a typebox Type.Object for a command's parameters. */
export function buildParams(spec: CommandSpec) {
  const props: Record<string, TSchema> = {};
  for (const [key, f] of Object.entries(spec.fields)) props[key] = fieldSchema(f);
  return Type.Object(props);
}

// ─── The 10 ltx-video subcommands ────────────────────────────────────────────

export const COMMANDS: Record<string, CommandSpec> = {
  t2i: {
    name: "t2i",
    writesOutput: true,
    when: "Text -> single image, 100% native Swift/MLX (ZImageDirector in-process). The t2i2v pipeline's first stage.",
    fields: {
      prompt: { flag: "--prompt", type: "string", description: "Text prompt." },
      transformer: { flag: "--transformer", type: "string", isPathComponent: true, description: "Transformer variant under models/transformer/. Default moody-pro-mix." },
      width: { flag: "--width", type: "int", description: "Output width. Default 640." },
      height: { flag: "--height", type: "int", description: "Output height. Default 960." },
      steps: { flag: "--steps", type: "int", description: "Denoising steps. Omit for the transformer's recommended value." },
      seed: { flag: "--seed", type: "int", description: "Random seed. Default 99." },
      output: { flag: "--output", type: "string", isPath: true, description: "Output PNG path. Default t2i_native_output.png." },
    },
  },

  "native-i2v": {
    name: "native-i2v",
    writesOutput: true,
    when: "THE FLAGSHIP command. Image-to-video generation, 100% native Swift/MLX (no run.py) — T2I -> LTX-2.3 I2V, distilled transformer, with optional First-Last-Frame conditioning, custom audio injection, LoRA fusion, and an auto post-upscale refine pass. PNG frame sequence + WAV output (no mp4 muxer yet).",
    fields: {
      prompt: { flag: "--prompt", type: "string", description: "Text prompt (used verbatim for both T2I and video stages — no VLM expansion yet)." },
      seconds: { flag: "--seconds", type: "number", description: "Target clip duration in seconds (frame count snapped to LTX's 8k+1 stride). Default 0.5." },
      fps: { flag: "--fps", type: "number", description: "Output frame rate. Default 24.0." },
      width: { flag: "--width", type: "int", description: "Output width, multiple of 32. Default 640 (production-recommended)." },
      height: { flag: "--height", type: "int", description: "Output height, multiple of 32. Default 960 (production-recommended)." },
      seed: { flag: "--seed", type: "int", description: "Random seed. Default 42." },
      t2iTransformer: { flag: "--t2i-transformer", type: "string", isPathComponent: true, description: "T2I transformer variant under models/transformer/. Default moody-pro-mix." },
      textMaxLength: { flag: "--text-max-length", type: "int", description: "Gemma text-encoder max token length. Default 128." },
      output: { flag: "--output", type: "string", isPath: true, description: "Output directory (source.png, frames/, audio.wav, upscaled/). Default native_i2v_output." },
      upscale: { flag: "--upscale", invertedFlag: "--no-upscale", type: "boolean", description: "Auto-run the native 2x spatial upscaler after decode. ON by default — set false to pass --no-upscale and skip it." },
      refine: { flag: "--refine", invertedFlag: "--no-refine", type: "boolean", description: "When upscale is on, also run the low-strength transformer refine pass (fixes over-sharpened/halo artifact). ON by default — set false to pass --no-refine and skip it." },
      loras: { flag: "--lora", type: "string[]", isPathSpecArray: true, description: "LoRA safetensors to fuse, repeatable to stack: path[:strength] (strength defaults to 1.0), e.g. ['a.safetensors:0.8', 'b.safetensors']." },
      lastFrame: { flag: "--last-frame", type: "string", isPath: true, description: "First-Last-Frame (FFLF): pin this image as the clip's LAST frame (frame 0 is always the T2I-generated --prompt image). Must already be exactly width x height." },
      audioTrack: { flag: "--audio-track", type: "string", isPath: true, description: "Custom audio injection: preserve this WAV's content through generation instead of generating audio from scratch. Any sample rate/channel count." },
      mp4: { flag: "--mp4", invertedFlag: "--no-mp4", type: "boolean", description: "Mux the final frame sequence (post-upscale if upscale is on) + audio.wav into a real H.264+AAC video.mp4 via AVAssetWriter. ON by default — set false to pass --no-mp4 and keep just the frame sequence." },
    },
  },

  "native-upscale": {
    name: "native-upscale",
    writesOutput: true,
    when: "2x spatial upscale a PNG frame sequence, 100% native Swift/MLX (LTX-2.3's LatentUpsampler), with an optional refine pass. Used standalone or automatically by native-i2v.",
    fields: {
      input: { flag: "--input", type: "string", isPath: true, description: "Input frame directory (frame_%04d.png sequence, e.g. native-i2v's frames/ output)." },
      output: { flag: "--output", type: "string", isPath: true, description: "Output directory (frames/ subdirectory holds the upscaled PNG sequence). Default native_upscale_output." },
      mode: { flag: "--mode", type: "string", description: "'fast' = LatentUpsampler 2x, native, ~1-2s (default, recommended for preview). 'hd' = native IC-LoRA reference-conditioned restoration chained into the fast upscaler (real LoRA fusion + reference conditioning, UNVERIFIED against a real checkpoint — see NativeUpscaleStage.generateHD's doc comment) — requires refinePrompt + refineAudio and the restoration LoRA files under mlx-models/lora/ltx-2.3-restore/." },
      refinePrompt: { flag: "--refine-prompt", type: "string", description: "fast mode: optional low-strength refine pass prompt (requires refineAudio). hd mode: REQUIRED — the IC-LoRA restoration generation prompt. Reuse the same prompt as the source native-i2v run." },
      refineAudio: { flag: "--refine-audio", type: "string", isPath: true, description: "WAV to preserve through the refine/restoration pass — the joint audio-video transformer needs a valid audio branch even though audio itself isn't refined. Typically the source native-i2v run's own audio.wav. Required with refinePrompt (fast mode) and always required for hd mode." },
      fps: { flag: "--fps", type: "number", description: "Output frame rate of the source clip (used for RoPE video positions in refinePrompt/hd mode). Default 24.0." },
      restorationLora: { flag: "--restoration-lora", type: "string", isPath: true, description: "hd mode only: override the restoration IC-LoRA path (default mlx-models/lora/ltx-2.3-restore/ltx2.3-video-restoration-general.safetensors)." },
      upscaleLora: { flag: "--upscale-lora", type: "string", isPath: true, description: "hd mode only: override the upscale IC-LoRA path (default mlx-models/lora/ltx-2.3-restore/ltx2.3-ic-video-upscale-general.safetensors)." },
      mp4: { flag: "--mp4", invertedFlag: "--no-mp4", type: "boolean", description: "Mux the final frame sequence + refineAudio (if given) into a real H.264+AAC video.mp4 via AVAssetWriter. ON by default — set false to pass --no-mp4." },
    },
  },

  i2v: {
    name: "i2v",
    writesOutput: true,
    when: "Production I2V pipeline (ZImage T2I -> VLM prompt -> LTX-2.3 I2V). Still bridges through run.py internally for the VLM/quality-check/vlm-score stages — NOT the pure-native path (use native-i2v for that). Higher default quality/duration than native-i2v.",
    fields: {
      prompt: { flag: "--prompt", type: "string", description: "T2I prompt for the source image." },
      action: { flag: "--action", type: "string", description: "zh-TW action/speech intent for the VLM motion+voice prompt stage. Omit to skip VLM expansion." },
      seconds: { flag: "--seconds", type: "number", description: "Target clip duration in seconds (frame count snapped to LTX's 8k+1 stride). Default 10.0." },
      fps: { flag: "--fps", type: "number", description: "Output frame rate. Default 24.0." },
      transformer: { flag: "--transformer", type: "string", isPathComponent: true, description: "LTX-2.3 transformer variant. Default = the pipeline's default-for-i2v variant." },
      seed: { flag: "--seed", type: "int", description: "Seed (omit for run.py's default)." },
      stage1Steps: { flag: "--stage1-steps", type: "int", description: "Stage-1 denoising steps override (run.py default: 8; 16 recommended for intelligible speech with dasiwa)." },
      stage2Steps: { flag: "--stage2-steps", type: "int", description: "Stage-2 refinement steps override (run.py default: 3)." },
      cfgScale: { flag: "--cfg-scale", type: "number", description: "Text guidance scale override." },
      stgScale: { flag: "--stg-scale", type: "number", description: "Spatial-temporal guidance scale override (0.0 kills motion — why --transformer distilled often looks static)." },
      qualityCheck: { flag: "--quality-check", invertedFlag: "--no-quality-check", type: "boolean", description: "Run run.py's built-in quality-check gate (auto-retry on failure). ON by default — set false to pass --no-quality-check." },
      vlmScore: { flag: "--vlm-score", invertedFlag: "--no-vlm-score", type: "boolean", description: "Also run run.py's VLM keyframe scoring. ON by default — set false to pass --no-vlm-score." },
      selfVerify: { flag: "--self-verify", type: "boolean", description: "Run the native VideoGate + VLM verify on the result after generation." },
      jsonOut: { flag: "--json-out", type: "string", isPath: true, description: "Write a JSON timing/result summary to this path." },
    },
  },

  upscale: {
    name: "upscale",
    writesOutput: true,
    when: "Spatially upscale a video using LTX-2.3's native IC-LoRA restore+upscale stack. Bridges through run.py video-restore internally — higher quality than native-upscale but not pure-native.",
    fields: {
      input: { flag: "", positional: true, type: "string", isPath: true, description: "Input video to upscale." },
      output: { flag: "--output", type: "string", isPath: true, description: "Output video path. Default <input>_restored.mp4." },
      scale: { flag: "--scale", type: "number", description: "Output resolution scale relative to input (1.0 = same, 2.0 = 2x). Default 2.0." },
      keepAudio: { flag: "--keep-audio", invertedFlag: "--no-keep-audio", type: "boolean", description: "Mux the original audio back into the upscaled video. ON by default — set false to drop it." },
      selfVerify: { flag: "--self-verify", type: "boolean", description: "Run the native gate on the result after upscaling." },
    },
  },

  gate: {
    name: "gate",
    writesOutput: false,
    when: "Score existing video/image file(s) with the native VLM-free quality gateway (noise/blank/motion/audio-level checks). NO generation. Use json:true for parseable output. Pass asrPrompt to additionally verify the audio actually SAYS the right thing (bridges to mlx_whisper — slower, real transcription) instead of just checking loudness.",
    fields: {
      videos: { flag: "", positional: true, type: "string[]", isPathArray: true, description: "Video (or image) file(s) to gate." },
      json: { flag: "--json", type: "boolean", description: "Emit machine-readable JSON (one array). Recommended for the agent." },
      expectVoice: { flag: "--expect-voice", invertedFlag: "--no-expect-voice", type: "boolean", description: "Expect an audio/voice track (FAIL if missing). ON by default — set false to allow silent clips." },
      strict: { flag: "--strict", type: "boolean", description: "Treat WARN as failure too (exit 1)." },
      asrPrompt: { flag: "--asr-prompt", type: "string", description: "Also run the ASR voice-content gate: transcribes the audio (mlx_whisper bridge) and checks language + content overlap against 「...」 speech markers in this prompt. Omit to skip (default — the loudness-only gate above still runs)." },
      expectedScript: { flag: "--expected-script", type: "string", description: "With asrPrompt, additionally require the transcript to classify natively (no ML) as 'traditional' or 'simplified' Chinese — catches zh-CN output when zh-TW was expected, which Whisper's own language detection cannot tell apart." },
    },
  },

  verify: {
    name: "verify",
    writesOutput: false,
    when: "Extract keyframes and verify video quality/prompt-adherence with a local VLM (LM Studio). Semantic layer above the VLM-free `gate` command.",
    fields: {
      video: { flag: "", positional: true, type: "string", isPath: true, description: "Video file to verify." },
      prompt: { flag: "--prompt", type: "string", description: "Original generation prompt (used for prompt-adherence checking)." },
      keyframes: { flag: "--keyframes", type: "int", description: "Number of evenly spaced keyframes to sample. Default 4." },
      style: { flag: "--style", type: "string", description: "VLM caption style. 'score' (default) is most reliable with local models; 'review' also checks prompt-element adherence." },
      threshold: { flag: "--threshold", type: "int", description: "Minimum acceptable mean overall score (1-10) to pass. Default 6." },
      json: { flag: "--json", type: "boolean", description: "Emit machine-readable JSON." },
    },
  },

  models: {
    name: "models",
    writesOutput: false,
    when: "List installed LTX-2.3 transformer variants. NO generation. Read-only.",
    fields: {},
  },

  "audio-decode": {
    name: "audio-decode",
    writesOutput: true,
    when: "Decode an LTX-2.3 audio latent to a 48kHz stereo WAV file, 100% native Swift/MLX. Diagnostic/low-level — needs a pre-existing latent safetensors (or --zeros for a smoke test).",
    fields: {
      latent: { flag: "--latent", type: "string", isPath: true, description: "Path to a .safetensors file containing an 'audio_latent' array of shape (1, 8, T, 16)." },
      zeros: { flag: "--zeros", type: "boolean", description: "Skip loading a latent file and decode a silent (all-zero) latent instead — smoke test." },
      zerosFrames: { flag: "--zeros-frames", type: "int", description: "Frame count for the --zeros smoke-test latent. Default 8." },
      output: { flag: "--output", type: "string", isPath: true, description: "Output WAV path. Default audio_decode_output.wav." },
    },
  },

  "video-decode": {
    name: "video-decode",
    writesOutput: true,
    when: "Decode an LTX-2.3 video latent to a PNG frame sequence, 100% native Swift/MLX. Diagnostic/low-level — needs a pre-existing latent safetensors (or --zeros for a smoke test).",
    fields: {
      latent: { flag: "--latent", type: "string", isPath: true, description: "Path to a .safetensors file containing a 'video_latent' array of shape (1, 128, F, H, W)." },
      zeros: { flag: "--zeros", type: "boolean", description: "Skip loading a latent file and decode a synthetic (all-zero) latent instead — smoke test." },
      zerosFrames: { flag: "--zeros-frames", type: "int", description: "Latent frame count for the --zeros smoke-test latent. Default 2." },
      zerosSize: { flag: "--zeros-size", type: "int", description: "Latent spatial size (H=W) for the --zeros smoke-test latent. Default 2." },
      output: { flag: "--output", type: "string", isPath: true, description: "Output directory for the PNG frame sequence. Default video_decode_frames." },
    },
  },
};

// ─── Args builder ────────────────────────────────────────────────────────────

function fmtScalar(v: number | string): string {
  return String(v);
}

/**
 * Translate a typed options object into a ltx-video CLI token list, in the
 * order fields are declared. Only emits flags for keys that are present
 * (!== undefined). Path validation is the caller's responsibility (see
 * pathFieldKeys / pathSpecFieldKeys).
 */
export function buildArgs(spec: CommandSpec, options: Record<string, unknown>): string[] {
  const args: string[] = [];
  const positionalBuf: string[] = [];
  for (const [key, f] of Object.entries(spec.fields)) {
    if (!(key in options)) continue;
    const v = options[key];
    if (v === undefined || v === null) continue;

    if (f.type === "boolean") {
      if (f.positional) throw new Error(`boolean positional field "${key}" is invalid`);
      if (v === true) args.push(f.flag);
      else if (v === false && f.invertedFlag) args.push(f.invertedFlag);
      continue;
    }

    if (f.positional) {
      if (Array.isArray(v)) {
        for (const item of v) positionalBuf.push(String(item));
      } else {
        positionalBuf.push(String(v));
      }
      continue;
    }

    if (f.type === "string[]" || f.type === "number[]") {
      if (!Array.isArray(v)) {
        throw new Error(`field "${key}" expects an array, got ${typeof v}`);
      }
      // ltx-video's repeatable options (--lora, gate's positional videos) take
      // one flag occurrence per value (ArgumentParser's `parsing: .upToNextOption`
      // / @Argument [String]), not a joined comma-list.
      for (const item of v) args.push(f.flag, fmtScalar(item as number | string));
      continue;
    }

    args.push(f.flag, fmtScalar(v as number | string));
  }
  return [...args, ...positionalBuf];
}

/** Keys of plain path-typed fields (for pre-flight path validation). */
export function pathFieldKeys(spec: CommandSpec): string[] {
  return Object.entries(spec.fields)
    .filter(([, f]) => f.isPath || f.isPathArray)
    .map(([k]) => k);
}

/** Keys of "path[:strength]"-spec fields (native-i2v's --lora). */
export function pathSpecFieldKeys(spec: CommandSpec): string[] {
  return Object.entries(spec.fields)
    .filter(([, f]) => f.isPathSpecArray)
    .map(([k]) => k);
}

/** All flag names this command models (for the check-flags drift guard). */
export function modeledFlags(spec: CommandSpec): string[] {
  const flags = Object.values(spec.fields)
    .filter((f) => !f.positional && f.flag)
    .map((f) => f.flag);
  const inverted = Object.values(spec.fields)
    .map((f) => f.invertedFlag)
    .filter((f): f is string => !!f);
  return [...flags, ...inverted];
}

/** Command display list for the tool description. */
export const COMMAND_LIST = Object.values(COMMANDS);
