import type { UnifiedCommand } from "./types";
import { PIPELINE_OPTIONS } from "./shared";

export const t2iCommand: UnifiedCommand = {
  action: "t2i",
  submitLabel: "Generate",
  runningLabel: "Generating...",
  isDisabled: (s) => !s.prompt?.trim(),
  fields: [
    { key: "prompt", cliFlag: "--prompt", control: "prompt", required: true, placeholder: "Describe the image you want to generate...", section: "Prompt" },
    { key: "pipeline", cliFlag: "--pipeline", control: "select", label: "Pipeline", choices: PIPELINE_OPTIONS, default: "zimage", section: "Generation" },
    { key: "steps", cliFlag: "--steps", control: "number", label: "Steps", min: 1, max: 50, section: "Generation" },
    { key: "seed", cliFlag: "--seed", control: "number", label: "Seed", default: 42, section: "Generation" },
    { key: "width", cliFlag: "--width", control: "number", label: "Width", min: 256, max: 2048, step: 64, default: 640, section: "Generation" },
    { key: "height", cliFlag: "--height", control: "number", label: "Height", min: 256, max: 2048, step: 64, default: 960, section: "Generation" },
    { key: "count", cliFlag: "--count", control: "number", label: "Count", min: 1, max: 10, default: 1, section: "Generation" },
    { key: "lora_scale", cliFlag: "--lora-scale", control: "range", label: "LoRA Scale", min: 0, max: 2, step: 0.05, default: 1.0, section: "LoRA & Style" },
    { key: "draft", cliFlag: "--draft", control: "toggle", label: "Draft mode (fewer steps, smaller resolution)", section: "Options" },
    { key: "upscale", cliFlag: "--upscale", control: "toggle", label: "ESRGAN 4× Upscale", section: "Options" },
    // Backend-only fields (no section → not shown in form)
    { key: "lora_path", cliFlag: "--lora-path", control: "text", label: "LoRA Path" },
    { key: "vae_path", cliFlag: "--vae-path", control: "text", label: "VAE Path" },
    { key: "variant", cliFlag: "--variant", control: "select", label: "Variant", choices: [{ value: "4b", label: "4B" }, { value: "9b", label: "9B" }] },
    { key: "upscale_method", cliFlag: "--upscale-method", control: "select", label: "Upscale Method", choices: [{ value: "esrgan", label: "ESRGAN" }, { value: "seedvr2", label: "SeedVR2" }] },
    { key: "seed_start", cliFlag: "--seed-start", control: "number", label: "Seed Start" },
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
