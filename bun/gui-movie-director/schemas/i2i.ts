import type { UnifiedCommand } from "./types";
import { PIPELINE_OPTIONS } from "./shared";

export const i2iCommand: UnifiedCommand = {
  action: "i2i",
  submitLabel: "Generate",
  runningLabel: "Generating...",
  isDisabled: (s) => !s.input_image,
  fields: [
    { key: "input_image", cliFlag: "--input", control: "image", label: "Source Image", required: true, section: "Input Images" },
    { key: "reference_image", cliFlag: "--reference-image", control: "image", label: "Reference Image (ControlNet)", section: "Input Images" },
    { key: "prompt", cliFlag: "--prompt", control: "text", label: "Prompt", placeholder: "Describe changes (optional for I2I)...", multiline: true, section: "Generation" },
    { key: "denoise_strength", cliFlag: "--denoise-strength", control: "range", label: "Denoise Strength", min: 0, max: 1, step: 0.05, default: 0.4, section: "Generation" },
    { key: "pipeline", cliFlag: "--pipeline", control: "select", label: "Pipeline", choices: PIPELINE_OPTIONS, default: "zimage", section: "Generation" },
    { key: "controlnet_strength", cliFlag: "--controlnet-strength", control: "range", label: "ControlNet Strength", min: 0, max: 1, step: 0.05, default: 1.0, visible: (s) => !!s.reference_image, section: "Generation" },
    { key: "steps", cliFlag: "--steps", control: "number", label: "Steps", min: 1, max: 50, section: "Generation" },
    { key: "seed", cliFlag: "--seed", control: "number", label: "Seed", default: 42, section: "Generation" },
    // Backend-only
    { key: "skip_preprocess", cliFlag: "--skip-preprocess", control: "toggle", label: "Skip Preprocess" },
    { key: "blur_ref", cliFlag: "--blur-ref", control: "toggle", label: "Blur Reference" },
    { key: "lora_path", cliFlag: "--lora-path", control: "text", label: "LoRA Path" },
    { key: "lora_scale", cliFlag: "--lora-scale", control: "range", label: "LoRA Scale", min: 0, max: 2, step: 0.05, default: 1.0 },
    { key: "upscale", cliFlag: "--upscale", control: "toggle", label: "Upscale" },
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
