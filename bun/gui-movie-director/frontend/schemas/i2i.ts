import type { CommandSchema } from "./types";
import { PIPELINE_OPTIONS } from "./shared";

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
