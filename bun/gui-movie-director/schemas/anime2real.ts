import type { UnifiedCommand } from "./types";

export const anime2realCommand: UnifiedCommand = {
  action: "anime2real",
  submitLabel: "Convert to Real",
  runningLabel: "Converting...",
  isDisabled: (s) => !s.input_image,
  fields: [
    { key: "input_image", cliFlag: "--input", control: "image", label: "Anime Image", required: true, section: "Input" },
    { key: "realism_style", cliFlag: "--realism-style", control: "select", label: "Realism Style", choices: [
      { value: "civitai-chinese", label: "CivitAI Chinese (Recommended)" },
      { value: "photorealistic", label: "Photorealistic" },
      { value: "3d-game", label: "3D Game" },
      { value: "semi-realistic", label: "Semi-Realistic" },
    ], default: "civitai-chinese", section: "Style Transfer" },
    { key: "anime2real_lora_scale", cliFlag: "--anime2real-lora-scale", control: "range", label: "LoRA Scale", min: 0, max: 2, step: 0.05, default: 1.0, section: "Style Transfer" },
    { key: "ref_strength", cliFlag: "--ref-strength", control: "range", label: "Reference Strength", min: 0, max: 1, step: 0.05, default: 1.0, section: "Style Transfer" },
    { key: "anime2real_ref_count", cliFlag: "--anime2real-ref-count", control: "number", label: "Reference Count", min: 1, max: 4, default: 1, section: "Style Transfer" },
    { key: "steps", cliFlag: "--steps", control: "number", label: "Steps", min: 1, max: 50, default: 8, section: "Style Transfer" },
    { key: "seed", cliFlag: "--seed", control: "number", label: "Seed", default: 42, section: "Style Transfer" },
    { key: "prompt", cliFlag: "--prompt", control: "text", label: "Prompt" },
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
