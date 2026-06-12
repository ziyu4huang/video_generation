import type { UnifiedCommand } from "./types";
import { PIPELINE_OPTIONS } from "./shared";

export const workflowCommand: UnifiedCommand = {
  action: "workflow",
  submitLabel: "Run Workflow",
  runningLabel: "Running workflow...",
  isDisabled: (s) => !s.prompt?.trim(),
  fields: [
    { key: "prompt", cliFlag: "--prompt", control: "prompt", required: true, placeholder: "Describe the image...", section: "Prompt" },
    { key: "pipeline", cliFlag: "--pipeline", control: "select", label: "Pipeline", choices: PIPELINE_OPTIONS, default: "zimage", section: "Generation" },
    { key: "seed", cliFlag: "--seed", control: "number", label: "Seed", default: 42, section: "Generation" },
    { key: "width", cliFlag: "--width", control: "number", label: "Width", min: 256, max: 2048, step: 64, default: 640, section: "Generation" },
    { key: "height", cliFlag: "--height", control: "number", label: "Height", min: 256, max: 2048, step: 64, default: 960, section: "Generation" },
    { key: "face_detail", cliFlag: "--face-detail", control: "toggle", label: "Face Detailer", default: true, section: "Post-Processing" },
    { key: "film_grain", cliFlag: "--film-grain", control: "range", label: "Film Grain", min: 0, max: 1, step: 0.05, default: 0.3, section: "Post-Processing" },
    { key: "sharpening", cliFlag: "--sharpening", control: "range", label: "Sharpening", min: 0, max: 1, step: 0.05, default: 0.5, section: "Post-Processing" },
    { key: "upscale", cliFlag: "--upscale", control: "toggle", label: "ESRGAN 4× Upscale", default: true, section: "Post-Processing" },
    // Backend-only
    { key: "face_detail_denoise", cliFlag: "--face-detail-denoise", control: "number", label: "Face Detail Denoise" },
    { key: "face_detail_steps", cliFlag: "--face-detail-steps", control: "number", label: "Face Detail Steps" },
    { key: "lut", cliFlag: "--lut", control: "text", label: "LUT" },
    { key: "lut_strength", cliFlag: "--lut-strength", control: "number", label: "LUT Strength" },
    { key: "skin_contrast", cliFlag: "--skin-contrast", control: "number", label: "Skin Contrast" },
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
