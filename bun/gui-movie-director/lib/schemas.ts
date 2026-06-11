// Command argument schemas derived from run.py image <action> CLI args.
// Each schema declares fields, their types, defaults, and whether they're required.

export type FieldType = "string" | "number" | "boolean" | "select" | "multiselect";

export interface FieldSchema {
  type: FieldType;
  cliFlag: string;       // e.g. "--prompt", "--lora-scale"
  required?: boolean;
  default?: any;
  choices?: string[];    // For select fields
  min?: number;
  max?: number;
}

export type CommandSchema = Record<string, FieldSchema>;

// Shared/common fields used by multiple commands
const PROMPT: FieldSchema = { type: "string", cliFlag: "--prompt", required: false };
const STEPS: FieldSchema = { type: "number", cliFlag: "--steps" };
const SEED: FieldSchema = { type: "number", cliFlag: "--seed", default: 42 };
const LORA_PATH: FieldSchema = { type: "string", cliFlag: "--lora-path" };
const LORA_SCALE: FieldSchema = { type: "number", cliFlag: "--lora-scale", default: 1.0, min: 0, max: 2 };
const VAE_PATH: FieldSchema = { type: "string", cliFlag: "--vae-path" };
const INPUT_IMAGE: FieldSchema = { type: "string", cliFlag: "--input" };
const DENOISE: FieldSchema = { type: "number", cliFlag: "--denoise-strength", default: 1.0, min: 0, max: 1 };
const PIPELINE: FieldSchema = { type: "select", cliFlag: "--pipeline", choices: ["zimage", "flux2-klein"], default: "zimage" };

export const COMMAND_SCHEMAS: Record<string, CommandSchema> = {
  t2i: {
    prompt: { ...PROMPT, required: true },
    pipeline: PIPELINE,
    width: { type: "number", cliFlag: "--width", default: 640 },
    height: { type: "number", cliFlag: "--height", default: 960 },
    steps: STEPS,
    seed: SEED,
    lora_path: LORA_PATH,
    lora_scale: LORA_SCALE,
    vae_path: VAE_PATH,
    variant: { type: "select", cliFlag: "--variant", choices: ["4b", "9b"] },
    draft: { type: "boolean", cliFlag: "--draft" },
    upscale: { type: "boolean", cliFlag: "--upscale" },
    upscale_method: { type: "select", cliFlag: "--upscale-method", choices: ["esrgan", "seedvr2"] },
    count: { type: "number", cliFlag: "--count", default: 1, min: 1 },
    seed_start: { type: "number", cliFlag: "--seed-start" },
  },

  i2i: {
    input_image: { ...INPUT_IMAGE, required: true },
    reference_image: { type: "string", cliFlag: "--reference-image" },
    prompt: PROMPT,
    denoise_strength: { ...DENOISE, default: 0.4 },
    controlnet_strength: { type: "number", cliFlag: "--controlnet-strength", default: 1.0, min: 0, max: 1 },
    pipeline: PIPELINE,
    steps: STEPS,
    seed: SEED,
    skip_preprocess: { type: "boolean", cliFlag: "--skip-preprocess" },
    blur_ref: { type: "boolean", cliFlag: "--blur-ref" },
    lora_path: LORA_PATH,
    lora_scale: LORA_SCALE,
    upscale: { type: "boolean", cliFlag: "--upscale" },
  },

  anime2real: {
    input_image: { ...INPUT_IMAGE, required: true },
    realism_style: { type: "select", cliFlag: "--realism-style", choices: ["civitai-chinese", "photorealistic", "3d-game", "semi-realistic"], default: "civitai-chinese" },
    anime2real_lora_scale: { type: "number", cliFlag: "--anime2real-lora-scale", min: 0, max: 2 },
    anime2real_ref_count: { type: "number", cliFlag: "--anime2real-ref-count", default: 1, min: 1, max: 4 },
    ref_strength: { type: "number", cliFlag: "--ref-strength", default: 1.0, min: 0, max: 1 },
    prompt: PROMPT,
    steps: STEPS,
    seed: SEED,
  },

  expansion: {
    input_image: { ...INPUT_IMAGE, required: true },
    expand: { type: "string", cliFlag: "--expand" },
    pixels: { type: "number", cliFlag: "--pixels", default: 1024 },
    aspect: { type: "string", cliFlag: "--aspect" },
    expansion_feather: { type: "number", cliFlag: "--expansion-feather", default: 96 },
    overlap: { type: "number", cliFlag: "--overlap", default: 128 },
    longest: { type: "number", cliFlag: "--longest", default: 1024 },
    expansion_ref_strength: { type: "number", cliFlag: "--expansion-ref-strength", default: 1.0, min: 0, max: 1 },
    prompt: PROMPT,
    steps: STEPS,
    seed: SEED,
    upscale: { type: "boolean", cliFlag: "--upscale" },
    upscale_method: { type: "select", cliFlag: "--upscale-method", choices: ["esrgan", "seedvr2"] },
  },

  faceswap: {
    input_image: { ...INPUT_IMAGE, required: true },
    face: { type: "string", cliFlag: "--face", required: true },
    mode: { type: "select", cliFlag: "--mode", choices: ["face", "head"], default: "head" },
    lora: { type: "string", cliFlag: "--lora" },
    seed: SEED,
  },

  swap: {
    input_image: { ...INPUT_IMAGE, required: true },
    reference: { type: "string", cliFlag: "--reference", required: true },
    sam_prompt: { type: "string", cliFlag: "--sam-prompt", required: true },
    ref_sam_prompt: { type: "string", cliFlag: "--ref-sam-prompt" },
    sam_threshold: { type: "number", cliFlag: "--sam-threshold", default: 0.3, min: 0, max: 1 },
    feather: { type: "number", cliFlag: "--feather", default: 10 },
    blend: { type: "boolean", cliFlag: "--blend" },
  },

  controlnet: {
    prompt: { ...PROMPT, required: true },
    input_image: INPUT_IMAGE,
    controlnet_type: { type: "select", cliFlag: "--controlnet-type", choices: ["canny", "pose", "depth", "hed", "scribble", "gray"], default: "canny" },
    controlnet_strength: { type: "number", cliFlag: "--controlnet-strength", default: 1.0, min: 0, max: 1 },
    blur_ref: { type: "boolean", cliFlag: "--blur-ref" },
    remove_outlines: { type: "boolean", cliFlag: "--remove-outlines" },
    steps: STEPS,
    seed: SEED,
    pipeline: PIPELINE,
  },

  angle: {
    input_image: { ...INPUT_IMAGE, required: true },
    azimuth: { type: "number", cliFlag: "--azimuth", default: 90 },
    elevation: { type: "number", cliFlag: "--elevation", default: 0 },
    prompt: PROMPT,
  },

  profile: {
    prompt: { ...PROMPT, required: true },
    views: { type: "string", cliFlag: "--views", default: "front,back,side" },
    ratio: { type: "string", cliFlag: "--ratio", default: "standing" },
    base_prompt: { type: "string", cliFlag: "--base-prompt" },
    ref_count: { type: "number", cliFlag: "--ref-count", default: 3, min: 1, max: 4 },
    steps: STEPS,
    seed: SEED,
    pipeline: PIPELINE,
    lora_path: LORA_PATH,
    lora_scale: LORA_SCALE,
  },

  quality: {
    quality_inputs: { type: "string", cliFlag: "--quality-inputs", required: true },
  },

  workflow: {
    prompt: { ...PROMPT, required: true },
    pipeline: PIPELINE,
    width: { type: "number", cliFlag: "--width", default: 640 },
    height: { type: "number", cliFlag: "--height", default: 960 },
    seed: SEED,
    face_detail: { type: "boolean", cliFlag: "--face-detail" },
    face_detail_denoise: { type: "number", cliFlag: "--face-detail-denoise" },
    face_detail_steps: { type: "number", cliFlag: "--face-detail-steps" },
    film_grain: { type: "number", cliFlag: "--film-grain" },
    sharpening: { type: "number", cliFlag: "--sharpening" },
    lut: { type: "string", cliFlag: "--lut" },
    lut_strength: { type: "number", cliFlag: "--lut-strength" },
    skin_contrast: { type: "number", cliFlag: "--skin-contrast" },
    upscale: { type: "boolean", cliFlag: "--upscale" },
  },

  // ─── Video ──────────────────────────────────────────────────────────

  "video-generate": {
    prompt: PROMPT,
    test_prompt: { type: "string", cliFlag: "--test-prompt" },
    width: { type: "number", cliFlag: "--width", default: 704 },
    height: { type: "number", cliFlag: "--height", default: 448 },
    frames: { type: "number", cliFlag: "--frames", default: 97 },
    fps: { type: "number", cliFlag: "--fps", default: 24 },
    input_image: { type: "string", cliFlag: "--input-image" },
    audio: { type: "string", cliFlag: "--audio" },
    begin_image: { type: "string", cliFlag: "--begin-image" },
    end_image: { type: "string", cliFlag: "--end-image" },
    begin_strength: { type: "number", cliFlag: "--begin-strength", default: 1.0, min: 0, max: 1 },
    end_strength: { type: "number", cliFlag: "--end-strength", default: 1.0, min: 0, max: 1 },
    seed: SEED,
    cfg_scale: { type: "number", cliFlag: "--cfg-scale", default: 5.0 },
    stg_scale: { type: "number", cliFlag: "--stg-scale", default: 1.0 },
    stage1_steps: { type: "number", cliFlag: "--stage1-steps" },
    stage2_steps: { type: "number", cliFlag: "--stage2-steps" },
    low_ram: { type: "boolean", cliFlag: "--low-ram" },
    hq: { type: "boolean", cliFlag: "--hq" },
    distilled: { type: "boolean", cliFlag: "--distilled" },
    teacache: { type: "boolean", cliFlag: "--teacache" },
    teacache_thresh: { type: "number", cliFlag: "--teacache-thresh" },
    temporal_upscale: { type: "boolean", cliFlag: "--temporal-upscale" },
    enhance_prompt: { type: "boolean", cliFlag: "--enhance-prompt" },
    lora_path: LORA_PATH,
    lora_scale: LORA_SCALE,
  },

  "video-restore": {
    restore_input_flag: { type: "string", cliFlag: "--restore-input", required: true },
    restore_output: { type: "string", cliFlag: "--restore-output" },
    restore_negative_prompt: { type: "string", cliFlag: "--restore-negative-prompt" },
    restore_scale: { type: "number", cliFlag: "--restore-scale", default: 1.0 },
    restore_cond_strength: { type: "number", cliFlag: "--restore-cond-strength", default: 1.0, min: 0, max: 1 },
    seed: SEED,
    frames: { type: "number", cliFlag: "--frames" },
    low_ram: { type: "boolean", cliFlag: "--low-ram" },
    restoration_lora: { type: "string", cliFlag: "--restoration-lora" },
    upscale_lora: { type: "string", cliFlag: "--upscale-lora" },
    restoration_scale: { type: "number", cliFlag: "--restoration-scale", default: 1.0 },
    upscale_scale: { type: "number", cliFlag: "--upscale-scale", default: 1.0 },
    no_upscale_lora: { type: "boolean", cliFlag: "--no-upscale-lora" },
    restore_no_audio: { type: "boolean", cliFlag: "--restore-no-audio" },
  },
};
