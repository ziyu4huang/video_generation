import type { CommandSchema } from "./types";
import { PIPELINE_OPTIONS } from "./shared";

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
