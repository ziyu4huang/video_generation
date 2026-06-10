import type { CommandSchema } from "./types";

// Shared option sets
export const PIPELINE_OPTIONS = [
  { value: "zimage", label: "ZImage Turbo" },
  { value: "flux2-klein", label: "Flux2 Klein 9B" },
];

// ─── Generate ────────────────────────────────────────────────────

export const T2I_SCHEMA: CommandSchema = {
  action: "t2i",
  submitLabel: "Generate",
  runningLabel: "Generating...",
  isDisabled: (s) => !s.prompt?.trim(),
  sections: [
    {
      title: "Prompt",
      fields: [
        { type: "prompt", key: "prompt", required: true, placeholder: "Describe the image you want to generate..." },
      ],
    },
    {
      title: "Generation",
      fields: [
        { type: "select", key: "pipeline", label: "Pipeline", options: PIPELINE_OPTIONS, default: "zimage" },
        { type: "number", key: "steps", label: "Steps", min: 1, max: 50 },
        { type: "number", key: "seed", label: "Seed", default: 42 },
        { type: "number", key: "width", label: "Width", min: 256, max: 2048, step: 64, default: 640 },
        { type: "number", key: "height", label: "Height", min: 256, max: 2048, step: 64, default: 960 },
        { type: "number", key: "count", label: "Count", min: 1, max: 10, default: 1 },
      ],
    },
    {
      title: "LoRA & Style",
      fields: [
        { type: "range", key: "lora_scale", label: "LoRA Scale", min: 0, max: 2, step: 0.05, default: 1.0 },
      ],
    },
    {
      title: "Options",
      fields: [
        { type: "toggle", key: "draft", label: "Draft mode (fewer steps, smaller resolution)" },
        { type: "toggle", key: "upscale", label: "ESRGAN 4× Upscale" },
      ],
    },
  ],
  buildParams: (s) => ({
    prompt: s.prompt?.trim(),
    pipeline: s.pipeline,
    width: s.width,
    height: s.height,
    steps: s.steps ?? undefined,
    seed: s.seed,
    lora_scale: s.lora_scale !== 1.0 ? s.lora_scale : undefined,
    draft: s.draft || undefined,
    upscale: s.upscale || undefined,
    count: s.count > 1 ? s.count : undefined,
  }),
};

export const WORKFLOW_SCHEMA: CommandSchema = {
  action: "workflow",
  submitLabel: "Run Workflow",
  runningLabel: "Running workflow...",
  isDisabled: (s) => !s.prompt?.trim(),
  sections: [
    {
      title: "Prompt",
      fields: [
        { type: "prompt", key: "prompt", required: true, placeholder: "Describe the image..." },
      ],
    },
    {
      title: "Generation",
      fields: [
        { type: "select", key: "pipeline", label: "Pipeline", options: PIPELINE_OPTIONS, default: "zimage" },
        { type: "number", key: "seed", label: "Seed", default: 42 },
        { type: "number", key: "width", label: "Width", min: 256, max: 2048, step: 64, default: 640 },
        { type: "number", key: "height", label: "Height", min: 256, max: 2048, step: 64, default: 960 },
      ],
    },
    {
      title: "Post-Processing",
      fields: [
        { type: "toggle", key: "face_detail", label: "Face Detailer", default: true },
        { type: "range", key: "film_grain", label: "Film Grain", min: 0, max: 1, step: 0.05, default: 0.3 },
        { type: "range", key: "sharpening", label: "Sharpening", min: 0, max: 1, step: 0.05, default: 0.5 },
        { type: "toggle", key: "upscale", label: "ESRGAN 4× Upscale", default: true },
      ],
    },
  ],
  buildParams: (s) => ({
    prompt: s.prompt?.trim(),
    pipeline: s.pipeline,
    width: s.width,
    height: s.height,
    seed: s.seed,
    face_detail: s.face_detail || undefined,
    film_grain: s.film_grain > 0 ? s.film_grain : undefined,
    sharpening: s.sharpening > 0 ? s.sharpening : undefined,
    upscale: s.upscale || undefined,
  }),
};

// ─── Transform ───────────────────────────────────────────────────

export const I2I_SCHEMA: CommandSchema = {
  action: "i2i",
  submitLabel: "Generate",
  runningLabel: "Generating...",
  isDisabled: (s) => !s.input_image,
  sections: [
    {
      title: "Input Images",
      fields: [
        { type: "image", key: "input_image", label: "Source Image", required: true },
        { type: "image", key: "reference_image", label: "Reference Image (ControlNet)" },
      ],
    },
    {
      title: "Generation",
      fields: [
        { type: "text", key: "prompt", label: "Prompt", placeholder: "Describe changes (optional for I2I)...", multiline: true },
        { type: "range", key: "denoise_strength", label: "Denoise Strength", min: 0, max: 1, step: 0.05, default: 0.4 },
        { type: "select", key: "pipeline", label: "Pipeline", options: PIPELINE_OPTIONS, default: "zimage" },
        { type: "range", key: "controlnet_strength", label: "ControlNet Strength", min: 0, max: 1, step: 0.05, default: 1.0, visible: (s) => !!s.reference_image },
        { type: "number", key: "steps", label: "Steps", min: 1, max: 50 },
        { type: "number", key: "seed", label: "Seed", default: 42 },
      ],
    },
  ],
  buildParams: (s) => ({
    input_image: s.input_image,
    reference_image: s.reference_image || undefined,
    prompt: s.prompt?.trim() || undefined,
    denoise_strength: s.denoise_strength,
    pipeline: s.pipeline,
    controlnet_strength: s.reference_image ? s.controlnet_strength : undefined,
    steps: s.steps ?? undefined,
    seed: s.seed,
  }),
};

export const ANIME2REAL_SCHEMA: CommandSchema = {
  action: "anime2real",
  submitLabel: "Convert to Real",
  runningLabel: "Converting...",
  isDisabled: (s) => !s.input_image,
  sections: [
    {
      title: "Input",
      fields: [
        { type: "image", key: "input_image", label: "Anime Image", required: true },
      ],
    },
    {
      title: "Style Transfer",
      fields: [
        { type: "select", key: "realism_style", label: "Realism Style", options: [
          { value: "civitai-chinese", label: "CivitAI Chinese (Recommended)" },
          { value: "photorealistic", label: "Photorealistic" },
          { value: "3d-game", label: "3D Game" },
          { value: "semi-realistic", label: "Semi-Realistic" },
        ], default: "civitai-chinese" },
        { type: "range", key: "anime2real_lora_scale", label: "LoRA Scale", min: 0, max: 2, step: 0.05, default: 1.0 },
        { type: "range", key: "ref_strength", label: "Reference Strength", min: 0, max: 1, step: 0.05, default: 1.0 },
        { type: "number", key: "anime2real_ref_count", label: "Reference Count", min: 1, max: 4, default: 1 },
        { type: "number", key: "steps", label: "Steps", min: 1, max: 50, default: 8 },
        { type: "number", key: "seed", label: "Seed", default: 42 },
      ],
    },
  ],
  buildParams: (s) => ({
    input_image: s.input_image,
    realism_style: s.realism_style,
    anime2real_lora_scale: s.anime2real_lora_scale !== 1.0 ? s.anime2real_lora_scale : undefined,
    ref_strength: s.ref_strength !== 1.0 ? s.ref_strength : undefined,
    anime2real_ref_count: s.anime2real_ref_count !== 1 ? s.anime2real_ref_count : undefined,
    steps: s.steps,
    seed: s.seed,
  }),
};

export const EXPANSION_SCHEMA: CommandSchema = {
  action: "expansion",
  submitLabel: "Expand",
  runningLabel: "Expanding...",
  isDisabled: (s) => !s.input_image,
  sections: [
    {
      title: "Input",
      fields: [
        { type: "image", key: "input_image", label: "Source Image", required: true },
      ],
    },
    {
      title: "Expansion Mode",
      fields: [
        { type: "select", key: "mode", label: "Mode", options: [
          { value: "direction", label: "Direction" },
          { value: "aspect", label: "Aspect Ratio" },
        ], default: "direction" },
        { type: "toggle", key: "expand_left", label: "Left", visible: (s) => s.mode === "direction" },
        { type: "toggle", key: "expand_right", label: "Right", default: true, visible: (s) => s.mode === "direction" },
        { type: "toggle", key: "expand_up", label: "Up", visible: (s) => s.mode === "direction" },
        { type: "toggle", key: "expand_down", label: "Down", default: true, visible: (s) => s.mode === "direction" },
        { type: "number", key: "pixels", label: "Pixels per Direction", min: 256, max: 2048, step: 64, default: 1024, visible: (s) => s.mode === "direction" },
        { type: "text", key: "aspect", label: "Target Aspect Ratio (W:H)", placeholder: "16:9", visible: (s) => s.mode === "aspect" },
      ],
    },
    {
      title: "Settings",
      fields: [
        { type: "number", key: "feather", label: "Feather", min: 0, max: 512, default: 96 },
        { type: "number", key: "overlap", label: "Overlap", min: 0, max: 512, default: 128 },
        { type: "number", key: "longest", label: "Longest Side", min: 256, max: 4096, default: 1024 },
        { type: "range", key: "expansion_ref_strength", label: "Reference Strength", min: 0, max: 1, step: 0.05, default: 1.0 },
        { type: "text", key: "prompt", label: "Prompt (optional)", placeholder: "Guide the expanded content...", multiline: true },
        { type: "number", key: "seed", label: "Seed", default: 42 },
      ],
    },
  ],
  buildParams: (s) => {
    const expandDirs = [s.expand_left && "left", s.expand_right && "right", s.expand_up && "up", s.expand_down && "down"].filter(Boolean).join(",");
    return {
      input_image: s.input_image,
      expand: s.mode === "direction" ? expandDirs : undefined,
      aspect: s.mode === "aspect" ? s.aspect : undefined,
      pixels: s.mode === "direction" ? s.pixels : undefined,
      expansion_feather: s.feather !== 96 ? s.feather : undefined,
      overlap: s.overlap !== 128 ? s.overlap : undefined,
      longest: s.longest,
      expansion_ref_strength: s.expansion_ref_strength !== 1.0 ? s.expansion_ref_strength : undefined,
      prompt: s.prompt?.trim() || undefined,
      seed: s.seed,
    };
  },
};

// ─── Edit ────────────────────────────────────────────────────────

export const FACESWAP_SCHEMA: CommandSchema = {
  action: "faceswap",
  submitLabel: "Swap Face",
  runningLabel: "Swapping...",
  isDisabled: (s) => !s.body || !s.face,
  sections: [
    {
      title: "Images",
      fields: [
        { type: "image", key: "body", label: "Body Image", required: true },
        { type: "image", key: "face", label: "Face Image", required: true },
      ],
    },
    {
      title: "Settings",
      fields: [
        { type: "select", key: "mode", label: "Mode", options: [
          { value: "head", label: "Head Swap" },
          { value: "face", label: "Face Swap" },
        ], default: "head" },
        { type: "number", key: "seed", label: "Seed", default: 42 },
      ],
    },
  ],
  buildParams: (s) => ({
    input_image: s.body,
    face: s.face,
    mode: s.mode,
    seed: s.seed,
  }),
};

export const SWAP_SCHEMA: CommandSchema = {
  action: "swap",
  submitLabel: "Swap Region",
  runningLabel: "Swapping...",
  isDisabled: (s) => !s.input_image || !s.reference || !s.sam_prompt?.trim(),
  sections: [
    {
      title: "Images",
      fields: [
        { type: "image", key: "input_image", label: "Source Image", required: true },
        { type: "image", key: "reference", label: "Reference Image", required: true },
      ],
    },
    {
      title: "SAM Segmentation",
      fields: [
        { type: "text", key: "sam_prompt", label: "SAM Prompt (what to swap in source) *", placeholder: "e.g. shirt, car, background" },
        { type: "text", key: "ref_sam_prompt", label: "Reference SAM Prompt (what to extract from reference)", placeholder: "Defaults to same as SAM Prompt" },
      ],
    },
    {
      title: "Settings",
      fields: [
        { type: "range", key: "sam_threshold", label: "SAM Threshold", min: 0, max: 1, step: 0.05, default: 0.3 },
        { type: "number", key: "feather", label: "Feather", min: 0, max: 100, default: 10 },
        { type: "toggle", key: "blend", label: "Blend (smooth composite)" },
      ],
    },
  ],
  buildParams: (s) => ({
    input_image: s.input_image,
    reference: s.reference,
    sam_prompt: s.sam_prompt?.trim(),
    ref_sam_prompt: s.ref_sam_prompt?.trim() || undefined,
    sam_threshold: s.sam_threshold !== 0.3 ? s.sam_threshold : undefined,
    feather: s.feather !== 10 ? s.feather : undefined,
    blend: s.blend || undefined,
  }),
};

export const CONTROLNET_SCHEMA: CommandSchema = {
  action: "controlnet",
  submitLabel: "Generate",
  runningLabel: "Generating...",
  isDisabled: (s) => !s.prompt?.trim(),
  sections: [
    {
      title: "Input",
      fields: [
        { type: "image", key: "input_image", label: "Reference Image (optional)" },
      ],
    },
    {
      title: "ControlNet",
      fields: [
        { type: "prompt", key: "prompt", required: true, placeholder: "Describe the image..." },
        { type: "select", key: "controlnet_type", label: "Type", options: [
          { value: "canny", label: "Canny Edges" },
          { value: "pose", label: "OpenPose" },
          { value: "depth", label: "Depth" },
          { value: "hed", label: "HED" },
          { value: "scribble", label: "Scribble" },
          { value: "gray", label: "Gray" },
        ], default: "canny" },
        { type: "range", key: "controlnet_strength", label: "Strength", min: 0, max: 1, step: 0.05, default: 1.0 },
        { type: "toggle", key: "blur_ref", label: "Blur Reference" },
        { type: "toggle", key: "remove_outlines", label: "Remove Outlines" },
        { type: "number", key: "steps", label: "Steps", min: 1, max: 50 },
        { type: "number", key: "seed", label: "Seed", default: 42 },
      ],
    },
  ],
  buildParams: (s) => ({
    prompt: s.prompt?.trim(),
    input_image: s.input_image || undefined,
    controlnet_type: s.controlnet_type,
    controlnet_strength: s.controlnet_strength !== 1.0 ? s.controlnet_strength : undefined,
    blur_ref: s.blur_ref || undefined,
    remove_outlines: s.remove_outlines || undefined,
    steps: s.steps ?? undefined,
    seed: s.seed,
  }),
};

export const ANGLE_SCHEMA: CommandSchema = {
  action: "angle",
  submitLabel: "Reframe",
  runningLabel: "Reframing...",
  isDisabled: (s) => !s.input_image,
  sections: [
    {
      title: "Input",
      fields: [
        { type: "image", key: "input_image", label: "Source Image", required: true },
      ],
    },
    {
      title: "Camera Angle",
      fields: [
        { type: "number", key: "azimuth", label: "Azimuth (horizontal rotation)", min: -180, max: 180, default: 90 },
        { type: "number", key: "elevation", label: "Elevation (vertical angle)", min: -90, max: 90, default: 0 },
        { type: "text", key: "prompt", label: "Prompt (optional)", placeholder: "Describe any changes to the scene...", multiline: true },
      ],
    },
  ],
  buildParams: (s) => ({
    input_image: s.input_image,
    azimuth: s.azimuth,
    elevation: s.elevation,
    prompt: s.prompt?.trim() || undefined,
  }),
};

// ─── Analyze ─────────────────────────────────────────────────────

export const PROFILE_SCHEMA: CommandSchema = {
  action: "profile",
  submitLabel: "Generate Profile",
  runningLabel: "Generating...",
  isDisabled: (s) => !s.prompt?.trim(),
  sections: [
    {
      title: "Character",
      fields: [
        { type: "prompt", key: "prompt", required: true, placeholder: "Describe the character in detail..." },
        { type: "text", key: "base_prompt", label: "Base Prompt Override", placeholder: "Override the default photographic base prompt..." },
      ],
    },
    {
      title: "Settings",
      fields: [
        { type: "select", key: "views", label: "Views", options: [
          { value: "front,back,side", label: "All Views" },
          { value: "front", label: "Front Only" },
          { value: "front,back", label: "Front + Back" },
        ], default: "front,back,side" },
        { type: "select", key: "ratio", label: "Pose", options: [
          { value: "standing", label: "Standing" },
          { value: "sitting", label: "Sitting" },
        ], default: "standing" },
        { type: "number", key: "ref_count", label: "Reference Count", min: 1, max: 4, default: 3 },
        { type: "number", key: "seed", label: "Seed", default: 42 },
      ],
    },
  ],
  buildParams: (s) => ({
    prompt: s.prompt?.trim(),
    views: s.views,
    ratio: s.ratio,
    base_prompt: s.base_prompt?.trim() || undefined,
    ref_count: s.ref_count !== 3 ? s.ref_count : undefined,
    seed: s.seed,
  }),
};

export const QUALITY_SCHEMA: CommandSchema = {
  action: "quality",
  submitLabel: "Analyze Quality",
  runningLabel: "Analyzing...",
  isDisabled: (s) => !s.quality_inputs?.length,
  sections: [
    {
      title: "Images to Analyze",
      fields: [
        { type: "images", key: "quality_inputs", label: "Add images for quality analysis" },
      ],
    },
  ],
  buildParams: (s) => ({
    quality_inputs: s.quality_inputs,
  }),
};
