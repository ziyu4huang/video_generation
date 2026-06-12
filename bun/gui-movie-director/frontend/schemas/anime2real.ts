import type { CommandSchema } from "./types";

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
