import type { CommandSchema } from "./types";

export const EXPANSION_SCHEMA: CommandSchema = {
  action: "expansion",
  submitLabel: "Expand",
  runningLabel: "Expanding...",
  isDisabled: (s) => !s.input_image,
  sections: [
    {
      title: "Input",
      fields: [
        { type: "image", key: "input_image", label: "Source Image", required: true },
      ],
    },
    {
      title: "Expansion Mode",
      fields: [
        { type: "select", key: "mode", label: "Mode", options: [
          { value: "direction", label: "Direction" },
          { value: "aspect", label: "Aspect Ratio" },
        ], default: "direction" },
        { type: "toggle", key: "expand_left", label: "Left", visible: (s) => s.mode === "direction" },
        { type: "toggle", key: "expand_right", label: "Right", default: true, visible: (s) => s.mode === "direction" },
        { type: "toggle", key: "expand_up", label: "Up", visible: (s) => s.mode === "direction" },
        { type: "toggle", key: "expand_down", label: "Down", default: true, visible: (s) => s.mode === "direction" },
        { type: "number", key: "pixels", label: "Pixels per Direction", min: 256, max: 2048, step: 64, default: 1024, visible: (s) => s.mode === "direction" },
        { type: "text", key: "aspect", label: "Target Aspect Ratio (W:H)", placeholder: "16:9", visible: (s) => s.mode === "aspect" },
      ],
    },
    {
      title: "Settings",
      fields: [
        { type: "number", key: "feather", label: "Feather", min: 0, max: 512, default: 96 },
        { type: "number", key: "overlap", label: "Overlap", min: 0, max: 512, default: 128 },
        { type: "number", key: "longest", label: "Longest Side", min: 256, max: 4096, default: 1024 },
        { type: "range", key: "expansion_ref_strength", label: "Reference Strength", min: 0, max: 1, step: 0.05, default: 1.0 },
        { type: "text", key: "prompt", label: "Prompt (optional)", placeholder: "Guide the expanded content...", multiline: true },
        { type: "number", key: "seed", label: "Seed", default: 42 },
      ],
    },
  ],
  buildParams: (s) => {
    const expandDirs = [s.expand_left && "left", s.expand_right && "right", s.expand_up && "up", s.expand_down && "down"].filter(Boolean).join(",");
    return {
      input_image: s.input_image,
      expand: s.mode === "direction" ? expandDirs : undefined,
      aspect: s.mode === "aspect" ? s.aspect : undefined,
      pixels: s.mode === "direction" ? s.pixels : undefined,
      expansion_feather: s.feather !== 96 ? s.feather : undefined,
      overlap: s.overlap !== 128 ? s.overlap : undefined,
      longest: s.longest,
      expansion_ref_strength: s.expansion_ref_strength !== 1.0 ? s.expansion_ref_strength : undefined,
      prompt: s.prompt?.trim() || undefined,
      seed: s.seed,
    };
  },
};
