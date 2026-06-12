import type { UnifiedCommand } from "./types";
import { PIPELINE_OPTIONS } from "./shared";

export const controlnetCommand: UnifiedCommand = {
  action: "controlnet",
  submitLabel: "Generate",
  runningLabel: "Generating...",
  isDisabled: (s) => !s.prompt?.trim(),
  fields: [
    { key: "input_image", cliFlag: "--input", control: "image", label: "Reference Image (optional)", section: "Input" },
    { key: "prompt", cliFlag: "--prompt", control: "prompt", required: true, placeholder: "Describe the image...", section: "ControlNet" },
    { key: "controlnet_type", cliFlag: "--controlnet-type", control: "select", label: "Type", choices: [
      { value: "canny", label: "Canny Edges" },
      { value: "pose", label: "OpenPose" },
      { value: "depth", label: "Depth" },
      { value: "hed", label: "HED" },
      { value: "scribble", label: "Scribble" },
      { value: "gray", label: "Gray" },
    ], default: "canny", section: "ControlNet" },
    { key: "controlnet_strength", cliFlag: "--controlnet-strength", control: "range", label: "Strength", min: 0, max: 1, step: 0.05, default: 1.0, section: "ControlNet" },
    { key: "blur_ref", cliFlag: "--blur-ref", control: "toggle", label: "Blur Reference", section: "ControlNet" },
    { key: "remove_outlines", cliFlag: "--remove-outlines", control: "toggle", label: "Remove Outlines", section: "ControlNet" },
    { key: "steps", cliFlag: "--steps", control: "number", label: "Steps", min: 1, max: 50, section: "ControlNet" },
    { key: "seed", cliFlag: "--seed", control: "number", label: "Seed", default: 42, section: "ControlNet" },
    { key: "pipeline", cliFlag: "--pipeline", control: "select", label: "Pipeline", choices: PIPELINE_OPTIONS, default: "zimage" },
  ],
  buildParams: (s) => ({
    prompt: s.prompt?.trim(),
    input_image: s.input_image || undefined,
    controlnet_type: s.controlnet_type,
    controlnet_strength: s.controlnet_strength !== 1.0 ? s.controlnet_strength : undefined,
    blur_ref: s.blur_ref || undefined,
    remove_outlines: s.remove_outlines || undefined,
    steps: s.steps ?? undefined,
    seed: s.seed,
  }),
};
