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
  /**
   * Value (or each array element) is a "name[=path[:strength]]" spec
   * (native-relay's --variant) — a bare name with NO embedded path (e.g.
   * "baseline") is valid and left untouched; when an "=" is present, the
   * portion after it is a "path[:strength]" spec whose path portion is
   * validated exactly like isPathSpecArray. Distinct from isPathSpecArray
   * because that flag assumes the ENTIRE value is "path[:strength]" with
   * no name= prefix — treating --variant that way would either skip the
   * embedded path's validation entirely or wrongly reject bare names as
   * missing files (see pi-agent-ext-ltx-self-improve's path-safety finding,
   * 2026-07-05).
   */
  isVariantSpecArray?: boolean;
  /**
   * A path field the CLI WRITES to rather than reads from — must NOT be
   * required to already exist. Implied automatically when the field key is
   * literally "output" (the common case); set explicitly for a differently
   * named write-target field (e.g. `segment`'s `json` report path, `i2v`'s
   * `jsonOut` summary path).
   */
  isOutputPath?: boolean;
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

// ─── The 16 ltx-video subcommands ────────────────────────────────────────────

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
      lastFrame: { flag: "--last-frame", type: "string", isPath: true, description: "First-Last-Frame (FFLF): pin this image as the clip's LAST frame (frame 0 is always the T2I-generated --prompt image). Must already be exactly width x height unless lastFrameAutoResize is set." },
      lastFrameStrength: { flag: "--last-frame-strength", type: "number", description: "Conditioning strength for lastFrame, 0.0-1.0. Default 1.0 = fully preserved/pinned; lower values partially blend it with generated content." },
      lastFrameAutoResize: { flag: "--last-frame-auto-resize", type: "boolean", description: "Auto-resize lastFrame to exactly width x height (aspect-fill + center-crop, bicubic) instead of requiring an exact match. Off by default." },
      lastFrameDerivesResolution: { flag: "--last-frame-derives-resolution", type: "boolean", description: "When lastFrame is given: derive the BASE generation width/height as half the last-frame image's own dimensions (snapped to nearest 32), overriding any explicit width/height. Implies lastFrameAutoResize. Pairs with upscale (on by default) to bring the final output back to the last-frame image's own resolution." },
      audioTrack: { flag: "--audio-track", type: "string", isPath: true, description: "Custom audio injection: preserve this WAV's content through generation instead of generating audio from scratch. Any sample rate/channel count." },
      inputImage: { flag: "--input-image", type: "string", isPath: true, description: "I2V from an arbitrary supplied image instead of a T2I-generated one: skips T2I entirely and VAE-encodes this image as the frame-0 conditioning latent. Must already be exactly width x height. Useful for chaining (e.g. feeding a prior clip's last decoded frame back in as the next segment's start)." },
      mp4: { flag: "--mp4", invertedFlag: "--no-mp4", type: "boolean", description: "Mux the final frame sequence (post-upscale if upscale is on) + audio.wav into a real H.264+AAC video.mp4 via AVAssetWriter. ON by default — set false to pass --no-mp4 and keep just the frame sequence." },
      secondStage: { flag: "--second-stage", type: "string", description: "When upscale/refine are on: chain a SECOND upscale+refine pass. 'x1.5' -> 2x*1.5x=3x total. 'x2' -> 2x*2x=4x total (reuses the x2 checkpoint again). Off by default." },
      gridImage: { flag: "--grid-image", type: "string", isPath: true, description: "Grid guide: a single image containing an NxN grid of storyboard panels, split in-memory and pinned as N independent keyframe guides (see gridFrameIndices/gridStrengths). Requires gridFrameIndices." },
      gridColumns: { flag: "--grid-columns", type: "int", description: "Grid guide column count. Default 2." },
      gridRows: { flag: "--grid-rows", type: "int", description: "Grid guide row count. Default 2." },
      gridFrameIndices: { flag: "--grid-frame-indices", type: "number[]", description: "Latent frame index for each grid panel, row-major (top-left, top-right, ..., bottom-right). Must have exactly gridColumns * gridRows entries." },
      gridStrengths: { flag: "--grid-strengths", type: "number[]", description: "Per-panel conditioning strength (0.0-1.0, default 1.0 for all panels if omitted). Must match gridFrameIndices count when given." },
    },
  },

  "native-upscale": {
    name: "native-upscale",
    writesOutput: true,
    when: "2x spatial upscale a PNG frame sequence, 100% native Swift/MLX (LTX-2.3's LatentUpsampler), with an optional refine pass. Used standalone or automatically by native-i2v.",
    fields: {
      input: { flag: "--input", type: "string", isPath: true, description: "Input frame directory (frame_%04d.png sequence, e.g. native-i2v's frames/ output)." },
      output: { flag: "--output", type: "string", isPath: true, description: "Output directory (frames/ subdirectory holds the upscaled PNG sequence). Default native_upscale_output." },
      mode: { flag: "--mode", type: "string", description: "'fast' = LatentUpsampler 2x, native, ~1-2s (default, recommended for preview). 'hd' = native IC-LoRA reference-conditioned restoration chained into the fast upscaler (real LoRA fusion + reference conditioning) — verified end-to-end against a real, non-gated restoration+upscale LoRA pair externalized under mlx-models/lora/ltx-2.3-restore/; requires refinePrompt + refineAudio." },
      refinePrompt: { flag: "--refine-prompt", type: "string", description: "fast mode: optional low-strength refine pass prompt (requires refineAudio). hd mode: REQUIRED — the IC-LoRA restoration generation prompt. Reuse the same prompt as the source native-i2v run." },
      refineAudio: { flag: "--refine-audio", type: "string", isPath: true, description: "WAV to preserve through the refine/restoration pass — the joint audio-video transformer needs a valid audio branch even though audio itself isn't refined. Typically the source native-i2v run's own audio.wav. Required with refinePrompt (fast mode) and always required for hd mode." },
      fps: { flag: "--fps", type: "number", description: "Output frame rate of the source clip (used for RoPE video positions in refinePrompt/hd mode). Default 24.0." },
      restorationLora: { flag: "--restoration-lora", type: "string", isPath: true, description: "hd mode only: override the restoration IC-LoRA path (default mlx-models/lora/ltx-2.3-restore/ltx2.3-video-restoration-general.safetensors)." },
      upscaleLora: { flag: "--upscale-lora", type: "string", isPath: true, description: "hd mode only: override the upscale IC-LoRA path (default mlx-models/lora/ltx-2.3-restore/ltx2.3-ic-video-upscale-general.safetensors)." },
      mp4: { flag: "--mp4", invertedFlag: "--no-mp4", type: "boolean", description: "Mux the final frame sequence + refineAudio (if given) into a real H.264+AAC video.mp4 via AVAssetWriter. ON by default — set false to pass --no-mp4." },
      preserveFirstLastFrame: { flag: "--preserve-first-last-frame", type: "boolean", description: "When refinePrompt is also given: re-pin the input's first and last frames during the refine pass so they don't drift from their original content — set this when input came from a native-i2v run that used lastFrame (FFLF)." },
      secondStage: { flag: "--second-stage", type: "string", description: "fast mode only: chain a SECOND upscale+refine pass after the first. 'x1.5' -> 2x*1.5x=3x total. 'x2' -> 2x*2x=4x total (reuses the x2 checkpoint again). Requires refinePrompt/refineAudio (every cascaded stage is refined)." },
    },
  },

  "native-t2a": {
    name: "native-t2a",
    writesOutput: true,
    when: "Generate audio ONLY from a text prompt, 100% native Swift/MLX (no run.py, no video at all). Use when you just need a voice/sound WAV, not a clip.",
    fields: {
      prompt: { flag: "--prompt", type: "string", description: "Text prompt." },
      seconds: { flag: "--seconds", type: "number", description: "Target audio duration in seconds (internally a virtual video frame count snapped to LTX's 8k+1 stride — no video is generated or decoded). Default 3.84." },
      frameRate: { flag: "--frame-rate", type: "number", description: "Virtual frame rate used only for the audio-token-count formula. Default 25.0." },
      seed: { flag: "--seed", type: "int", description: "Random seed. Default 42." },
      textMaxLength: { flag: "--text-max-length", type: "int", description: "Gemma text-encoder max token length. Default 128." },
      output: { flag: "--output", type: "string", isPath: true, description: "Output directory (audio.wav). Default native_t2a_output." },
      loras: { flag: "--lora", type: "string[]", isPathSpecArray: true, description: "LoRA safetensors to fuse into the distilled transformer, repeatable to stack: path[:strength] (strength defaults to 1.0)." },
    },
  },

  "native-relay": {
    name: "native-relay",
    writesOutput: true,
    when: "Multi-segment prompt-relay video, 100% native Swift/MLX (no run.py, no ffmpeg) — experimental, distilled-only. Chains N I2V generations, each segment's last decoded frame feeding the next segment's start, concatenated into one video. Use for a scene that needs multiple distinct prompts in sequence.",
    fields: {
      prompts: { flag: "--prompts", type: "string[]", description: "One prompt per segment (2+ args = multi-segment relay)." },
      firstImage: { flag: "--first-image", type: "string", isPath: true, description: "Reference image for segment 1 (I2V). Must already be exactly width x height. Omit for T2I-then-I2V on segment 1." },
      seconds: { flag: "--seconds", type: "number", description: "Duration per segment in seconds (frame count snapped to LTX's 8k+1 stride). Default 2.0." },
      fps: { flag: "--fps", type: "number", description: "Output frame rate. Default 24.0." },
      width: { flag: "--width", type: "int", description: "Output width (must be a multiple of 32). Default 640." },
      height: { flag: "--height", type: "int", description: "Output height (must be a multiple of 32). Default 960." },
      seed: { flag: "--seed", type: "int", description: "Base random seed (each segment uses seed + segment index). Default 42." },
      t2iTransformer: { flag: "--t2i-transformer", type: "string", isPathComponent: true, description: "T2I transformer variant under models/transformer/ (segment 1 only, when firstImage is omitted). Default moody-pro-mix." },
      textMaxLength: { flag: "--text-max-length", type: "int", description: "Gemma text-encoder max token length. Default 128." },
      loras: { flag: "--lora", type: "string[]", isPathSpecArray: true, description: "LoRA safetensors to fuse into the distilled transformer, repeatable to stack: path[:strength] (strength defaults to 1.0). Applied to every segment." },
      output: { flag: "--output", type: "string", isPath: true, description: "Output directory (seg01/, seg02/, ..., relay.mp4). Default native_relay_output." },
      relayAudio: { flag: "--relay-audio", type: "string", isPath: true, description: "Custom audio track that REPLACES the final concatenated video's audio entirely (WAV/MP3/M4A/AAC — no ffmpeg needed). Trimmed to the video's duration if longer. Ignored if relayTtsText is also set." },
      relayTtsText: { flag: "--relay-tts-text", type: "string", description: "Narration text to synthesize via macOS 'say' and use as relayAudio. Ignored if relayAudio is also set." },
      relayTtsVoice: { flag: "--relay-tts-voice", type: "string", description: "Voice name for relayTtsText. Default Meijia (zh-TW). List available voices with: say -v '?'." },
      relayTtsRate: { flag: "--relay-tts-rate", type: "int", description: "Speech rate in words/min for relayTtsText. Default 145." },
      variant: { flag: "--variant", type: "string[]", isVariantSpecArray: true, description: "Run once per named variant for A/B comparison: name[=lora_path[:strength]]. A bare name (no '=') runs with no LoRA (e.g. 'baseline'). Repeatable. Each variant's output goes to <output>/<name>/ and overrides loras for that run." },
      gridImage: { flag: "--grid-image", type: "string", isPath: true, description: "Grid guide: a single image containing an NxN grid of storyboard panels, split in-memory and pinned as N independent keyframe guides, applied to EVERY segment (see gridFrameIndices/gridStrengths). Requires gridFrameIndices." },
      gridColumns: { flag: "--grid-columns", type: "int", description: "Grid guide column count. Default 2." },
      gridRows: { flag: "--grid-rows", type: "int", description: "Grid guide row count. Default 2." },
      gridFrameIndices: { flag: "--grid-frame-indices", type: "number[]", description: "Latent frame index for each grid panel, row-major (top-left, top-right, ..., bottom-right). Must have exactly gridColumns * gridRows entries." },
      gridStrengths: { flag: "--grid-strengths", type: "number[]", description: "Per-panel conditioning strength (0.0-1.0, default 1.0 for all panels if omitted). Must match gridFrameIndices count when given." },
    },
  },

  "native-storyboard": {
    name: "native-storyboard",
    writesOutput: true,
    when: "Multi-segment/multi-panel storyboard video from a single JSON config file, 100% native Swift/MLX (no run.py, no ffmpeg). The config's transitionMode picks the underlying stage: 'camera-move' = one continuous shot (native-i2v under the hood, grid panels as keyframes); 'hard-cut' = discrete per-panel segments concatenated with a true cut (native-relay under the hood). Prefer this over hand-assembling native-i2v/native-relay's --grid-* flags for anything beyond a couple of panels.",
    fields: {
      config: { flag: "--config", type: "string", isPath: true, description: "Path to the storyboard JSON config file (transitionMode, segments with per-panel prompt/frameIndex/strength, shared grid image path/columns/rows). Asset paths inside the JSON (grid image, LoRA paths, audio overlay) resolve relative to the config file's own directory." },
      output: { flag: "--output", type: "string", isPath: true, description: "Output directory override. Defaults to the config file's own `output` field, or native_storyboard_output." },
    },
  },

  "native-ingredients": {
    name: "native-ingredients",
    writesOutput: true,
    when: "Generate a video from a single reference image, 100% native Swift/MLX (no run.py), via a user-supplied Ingredients IC-LoRA adapter (character/product/scene reference conditioning).",
    fields: {
      input: { flag: "--input", type: "string", isPath: true, description: "Reference image (e.g. a character/product/scene reference sheet)." },
      output: { flag: "--output", type: "string", isPath: true, description: "Output directory (frames/ subdirectory holds the generated PNG sequence, audio.wav holds generated audio). Default native_ingredients_output." },
      prompt: { flag: "--prompt", type: "string", description: "Generation prompt describing the target scene." },
      lora: { flag: "--lora", type: "string", isPath: true, description: "Path to the Ingredients IC-LoRA .safetensors checkpoint (e.g. Lightricks/LTX-2.3-22b-IC-LoRA-Ingredients's ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors). No bundled default." },
      loraStrength: { flag: "--lora-strength", type: "number", description: "Fusion strength for lora. Default 1.0." },
      width: { flag: "--width", type: "int", description: "Output width (snapped to a valid resolution). Default 640." },
      height: { flag: "--height", type: "int", description: "Output height (snapped to a valid resolution). Default 960." },
      seconds: { flag: "--seconds", type: "number", description: "Target duration in seconds (rounded to the nearest valid LTX frame count, 8k+1). Default 5.0." },
      fps: { flag: "--fps", type: "number", description: "Output frame rate (used for RoPE video positions and audio token count). Default 24.0." },
      seed: { flag: "--seed", type: "int", description: "Random seed for the denoise pass. Default 42." },
      mp4: { flag: "--mp4", invertedFlag: "--no-mp4", type: "boolean", description: "Mux the generated PNG frame sequence + generated audio into a real H.264+AAC output.mp4 via AVAssetWriter. ON by default." },
    },
  },

  "native-restyle": {
    name: "native-restyle",
    writesOutput: true,
    when: "V2V restyle a PNG frame sequence, 100% native Swift/MLX (no run.py), via a user-supplied IC-LoRA style adapter. Use to change the visual style of an existing native-i2v frames/ output.",
    fields: {
      input: { flag: "--input", type: "string", isPath: true, description: "Input frame directory (frame_%04d.png sequence, e.g. native-i2v's frames/ output) — the reference clip to restyle." },
      output: { flag: "--output", type: "string", isPath: true, description: "Output directory (frames/ subdirectory holds the restyled PNG sequence). Default native_restyle_output." },
      prompt: { flag: "--prompt", type: "string", description: "Generation prompt describing the target style." },
      audio: { flag: "--audio", type: "string", isPath: true, description: "WAV to preserve through the pass — the joint audio-video transformer needs a valid audio branch even though audio itself isn't restyled. Typically the source native-i2v run's own audio.wav." },
      lora: { flag: "--lora", type: "string", isPath: true, description: "Path to the V2V-style IC-LoRA .safetensors checkpoint. No bundled default — user-supplied style adapter." },
      loraStrength: { flag: "--lora-strength", type: "number", description: "Fusion strength for lora. Default 1.0." },
      fps: { flag: "--fps", type: "number", description: "Output frame rate of the source clip (used for RoPE video positions). Default 24.0." },
      seed: { flag: "--seed", type: "int", description: "Random seed for the denoise pass. Default 42." },
      mp4: { flag: "--mp4", invertedFlag: "--no-mp4", type: "boolean", description: "Mux the restyled PNG frame sequence + audio into a real H.264+AAC output.mp4 via AVAssetWriter. ON by default." },
    },
  },

  segment: {
    name: "segment",
    writesOutput: false,
    when: "Detect scene cuts in an existing video via HSV histogram correlation (no VLM scoring, no generation). Use before cutting/relaying a multi-scene clip into segments.",
    fields: {
      segmentInput: { flag: "--segment-input", type: "string", isPath: true, description: "Input video file to analyze." },
      threshold: { flag: "--threshold", type: "number", description: "Scene change sensitivity: lower = more sensitive (0.3-0.5). Default 0.4." },
      minFrames: { flag: "--min-frames", type: "int", description: "Minimum frames per scene; shorter scenes are merged. Default 8." },
      json: { flag: "--json", type: "string", isPath: true, isOutputPath: true, description: "Save the per-segment report as JSON to this path." },
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
      jsonOut: { flag: "--json-out", type: "string", isPath: true, isOutputPath: true, description: "Write a JSON timing/result summary to this path." },
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

/** Keys of "name[=path[:strength]]"-spec fields (native-relay's --variant). */
export function variantSpecFieldKeys(spec: CommandSpec): string[] {
  return Object.entries(spec.fields)
    .filter(([, f]) => f.isVariantSpecArray)
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
