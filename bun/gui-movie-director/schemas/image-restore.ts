import type { UnifiedCommand } from "./types";
import { PIPELINE_OPTIONS } from "./shared";

export const imageRestoreCommand: UnifiedCommand = {
  action: "restore",
  submitLabel: "Restore",
  runningLabel: "Restoring...",
  isDisabled: (s) => !s.input_image,
  fields: [
    { key: "input_image", cliFlag: "--input", control: "image", label: "Image to Restore", required: true, section: "Input Image" },
    { key: "prompt", cliFlag: "--prompt", control: "text", label: "Detail Prompt", placeholder: "Describe what to restore (e.g. sharp eyes, clear face, natural skin texture)...", multiline: true, section: "Restoration" },
    { key: "denoise_strength", cliFlag: "--denoise-strength", control: "range", label: "Denoise Strength", min: 0, max: 1, step: 0.05, default: 0.35, section: "Restoration" },
    { key: "pipeline", cliFlag: "--pipeline", control: "select", label: "Pipeline", choices: PIPELINE_OPTIONS, default: "zimage", section: "Restoration" },
    { key: "steps", cliFlag: "--steps", control: "number", label: "Steps", min: 1, max: 50, section: "Restoration" },
    { key: "seed", cliFlag: "--seed", control: "number", label: "Seed", default: 42, section: "Restoration" },
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
