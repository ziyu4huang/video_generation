import type { CommandSchema } from "./types";
import { PIPELINE_OPTIONS } from "./shared";

export const IMAGE_RESTORE_SCHEMA: CommandSchema = {
  action: "restore",
  submitLabel: "Restore",
  runningLabel: "Restoring...",
  isDisabled: (s) => !s.input_image,
  sections: [
    {
      title: "Input Image",
      fields: [
        { type: "image", key: "input_image", label: "Image to Restore", required: true },
      ],
    },
    {
      title: "Restoration",
      fields: [
        {
          type: "text",
          key: "prompt",
          label: "Detail Prompt",
          placeholder: "Describe what to restore (e.g. sharp eyes, clear face, natural skin texture)...",
          multiline: true,
        },
        { type: "range", key: "denoise_strength", label: "Denoise Strength", min: 0, max: 1, step: 0.05, default: 0.35 },
        { type: "select", key: "pipeline", label: "Pipeline", options: PIPELINE_OPTIONS, default: "zimage" },
        { type: "number", key: "steps", label: "Steps", min: 1, max: 50 },
        { type: "number", key: "seed", label: "Seed", default: 42 },
      ],
    },
  ],
  buildParams: (s) => ({
    input_image: s.input_image,
    prompt: s.prompt?.trim() || undefined,
    denoise_strength: s.denoise_strength,
    pipeline: s.pipeline,
    steps: s.steps ?? undefined,
    seed: s.seed,
  }),
};
