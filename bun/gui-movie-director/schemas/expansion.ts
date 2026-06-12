import type { UnifiedCommand } from "./types";

export const expansionCommand: UnifiedCommand = {
  action: "expansion",
  submitLabel: "Expand",
  runningLabel: "Expanding...",
  isDisabled: (s) => !s.input_image,
  fields: [
    { key: "input_image", cliFlag: "--input", control: "image", label: "Source Image", required: true, section: "Input" },
    // UI-only state: no cliFlag, transformed by buildParams
    { key: "mode", control: "select", label: "Mode", choices: [
      { value: "direction", label: "Direction" },
      { value: "aspect", label: "Aspect Ratio" },
    ], default: "direction", section: "Expansion Mode" },
    { key: "expand_left", control: "toggle", label: "Left", visible: (s) => s.mode === "direction", section: "Expansion Mode" },
    { key: "expand_right", control: "toggle", label: "Right", default: true, visible: (s) => s.mode === "direction", section: "Expansion Mode" },
    { key: "expand_up", control: "toggle", label: "Up", visible: (s) => s.mode === "direction", section: "Expansion Mode" },
    { key: "expand_down", control: "toggle", label: "Down", default: true, visible: (s) => s.mode === "direction", section: "Expansion Mode" },
    { key: "pixels", cliFlag: "--pixels", control: "number", label: "Pixels per Direction", min: 256, max: 2048, step: 64, default: 1024, visible: (s) => s.mode === "direction", section: "Expansion Mode" },
    { key: "aspect", cliFlag: "--aspect", control: "text", label: "Target Aspect Ratio (W:H)", placeholder: "16:9", visible: (s) => s.mode === "aspect", section: "Expansion Mode" },
    // UI key `feather` maps to CLI param `expansion_feather` via buildParams
    { key: "feather", control: "number", label: "Feather", min: 0, max: 512, default: 96, section: "Settings" },
    { key: "overlap", cliFlag: "--overlap", control: "number", label: "Overlap", min: 0, max: 512, default: 128, section: "Settings" },
    { key: "longest", cliFlag: "--longest", control: "number", label: "Longest Side", min: 256, max: 4096, default: 1024, section: "Settings" },
    { key: "expansion_ref_strength", cliFlag: "--expansion-ref-strength", control: "range", label: "Reference Strength", min: 0, max: 1, step: 0.05, default: 1.0, section: "Settings" },
    { key: "prompt", cliFlag: "--prompt", control: "text", label: "Prompt (optional)", placeholder: "Guide the expanded content...", multiline: true, section: "Settings" },
    { key: "seed", cliFlag: "--seed", control: "number", label: "Seed", default: 42, section: "Settings" },
    // Backend-only: computed from UI state
    { key: "expand", cliFlag: "--expand", control: "text", label: "Expand Directions" },
    { key: "expansion_feather", cliFlag: "--expansion-feather", control: "number", label: "Expansion Feather", default: 96 },
    { key: "upscale", cliFlag: "--upscale", control: "toggle", label: "Upscale" },
    { key: "upscale_method", cliFlag: "--upscale-method", control: "select", label: "Upscale Method", choices: [{ value: "esrgan", label: "ESRGAN" }, { value: "seedvr2", label: "SeedVR2" }] },
    { key: "steps", cliFlag: "--steps", control: "number", label: "Steps" },
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
