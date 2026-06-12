import type { CommandSchema } from "./types";

export const CONTROLNET_SCHEMA: CommandSchema = {
  action: "controlnet",
  submitLabel: "Generate",
  runningLabel: "Generating...",
  isDisabled: (s) => !s.prompt?.trim(),
  sections: [
    {
      title: "Input",
      fields: [
        { type: "image", key: "input_image", label: "Reference Image (optional)" },
      ],
    },
    {
      title: "ControlNet",
      fields: [
        { type: "prompt", key: "prompt", required: true, placeholder: "Describe the image..." },
        { type: "select", key: "controlnet_type", label: "Type", options: [
          { value: "canny", label: "Canny Edges" },
          { value: "pose", label: "OpenPose" },
          { value: "depth", label: "Depth" },
          { value: "hed", label: "HED" },
          { value: "scribble", label: "Scribble" },
          { value: "gray", label: "Gray" },
        ], default: "canny" },
        { type: "range", key: "controlnet_strength", label: "Strength", min: 0, max: 1, step: 0.05, default: 1.0 },
        { type: "toggle", key: "blur_ref", label: "Blur Reference" },
        { type: "toggle", key: "remove_outlines", label: "Remove Outlines" },
        { type: "number", key: "steps", label: "Steps", min: 1, max: 50 },
        { type: "number", key: "seed", label: "Seed", default: 42 },
      ],
    },
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
