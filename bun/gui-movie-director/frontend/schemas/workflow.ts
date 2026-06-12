import type { CommandSchema } from "./types";
import { PIPELINE_OPTIONS } from "./shared";

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
