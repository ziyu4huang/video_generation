import type { UnifiedCommand } from "./types";

// image purify — SeedVR2 AI redraw + upscale. Three modes control creative
// freedom via pre-downsampling softness (see app/commands/image-purify.py
// MODE_PRESETS): purify (0.3, light artifact cleanup, preserve detail),
// enhance (0.5, balanced), redraw (0.8, reinterpret). Optionally upscales.
// This is the artifact-removal / quality tool — distinct from restore
// (detail-preserving I2I redraw for video frames) and upscale (ESRGAN-only).

const PURIFY_MODE_CHOICES = [
  { value: "purify", label: "Purify — light cleanup, preserve detail (0.3)" },
  { value: "enhance", label: "Enhance — balanced (0.5)" },
  { value: "redraw", label: "Redraw — reinterpret content (0.8)" },
];

const RESOLUTION_CHOICES = [
  { value: "same", label: "Same (no upscale)" },
  { value: "2x", label: "2x" },
  { value: "2160", label: "2160px" },
];

export const purifyCommand: UnifiedCommand = {
  action: "purify",
  submitLabel: "Purify",
  runningLabel: "Purifying...",
  isDisabled: (s) => !s.input_image,
  fields: [
    { key: "input_image", cliFlag: "--input-image", control: "image", label: "Image to Purify", required: true, section: "Input" },
    { key: "purify_mode", cliFlag: "--purify-mode", control: "select", label: "Mode", choices: PURIFY_MODE_CHOICES, default: "enhance", section: "Purification" },
    { key: "resolution", cliFlag: "--resolution", control: "select", label: "Resolution", choices: RESOLUTION_CHOICES, default: "same", section: "Purification" },
    { key: "film_grain", cliFlag: "--film-grain", control: "range", label: "Film Grain", min: 0, max: 0.03, step: 0.005, default: 0, compact: true, section: "Post-Processing" },
    { key: "sharpening", cliFlag: "--sharpening", control: "range", label: "Sharpening", min: 0, max: 0.3, step: 0.01, default: 0, compact: true, section: "Post-Processing" },
    { key: "seed", cliFlag: "--seed", control: "number", label: "Seed", default: 42, compact: true, section: "Post-Processing" },
    // NOTE: --softness-override (advanced; overrides the mode preset) is
    // intentionally omitted — a default 0 would silently override the chosen
    // mode's softness. Power users can pass it via CLI.
  ],
  buildParams: (s) => ({
    input_image: s.input_image,
    purify_mode: s.purify_mode ?? "enhance",
    resolution: s.resolution ?? "same",
    film_grain: s.film_grain,
    sharpening: s.sharpening,
    seed: s.seed,
  }),
};
