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

// Redraw backend. SeedVR2 = the original 1-step upscale redraw (prompt-free).
// transformer = flux2-klein I2I redraw (prompt-guided, multi-step) — delegates
// to `run.py image i2i --pipeline flux2-klein`; output lands in the output dir.
const BACKEND_CHOICES = [
  { value: "seedvr2", label: "SeedVR2 — 1-step upscale redraw (default)" },
  { value: "transformer", label: "Transformer — flux2-klein I2I redraw (prompt-guided)" },
];

// Compute purify output dims for a given input + resolution string. Mirrors
// app/commands/image-purify.py:_parse_resolution + SeedVR2's sizing: "same" →
// unchanged, "<N>x" → scale by N, "<pixels>" → shortest-side target.
function purifyOutputDims(w: number, h: number, resolution: string): { w: number; h: number } | null {
  const r = (resolution || "same").toLowerCase();
  if (r === "same") return { w, h };
  if (r.endsWith("x")) {
    const s = parseFloat(r.slice(0, -1));
    if (isFinite(s) && s > 0) return { w: Math.round(w * s), h: Math.round(h * s) };
    return null;
  }
  const px = parseInt(r, 10);
  if (isFinite(px) && px > 0) {
    const scale = px / Math.min(w, h);
    return { w: Math.round(w * scale), h: Math.round(h * scale) };
  }
  return null;
}

export const purifyCommand: UnifiedCommand = {
  action: "purify",
  submitLabel: "Purify",
  runningLabel: "Purifying...",
  isDisabled: (s) => !s.input_image,
  fields: [
    { key: "input_image", cliFlag: "--input-image", control: "image", label: "Image to Purify", required: true, section: "Input" },
    { key: "purify_mode", cliFlag: "--purify-mode", control: "select", label: "Mode", choices: PURIFY_MODE_CHOICES, default: "enhance", section: "Purification" },
    { key: "backend", cliFlag: "--backend", control: "select", label: "Backend", choices: BACKEND_CHOICES, default: "seedvr2", section: "Purification" },
    // Prompt is transformer-backend-only (SeedVR2 is prompt-free). Visible only
    // when backend=transformer; omitted from CLI when empty (run.py then uses a
    // neutral quality prompt).
    { key: "prompt", cliFlag: "--prompt", control: "text", label: "Prompt", placeholder: "Guides the transformer redraw (default: quality prompt)", visible: (s) => s.backend === "transformer", section: "Purification" },
    { key: "resolution", cliFlag: "--resolution", control: "select", label: "Resolution", choices: RESOLUTION_CHOICES, default: "same", hint: (s, { inputDims }) => { if (!inputDims) return ""; const out = purifyOutputDims(inputDims.w, inputDims.h, (s.resolution as string) ?? "same"); return out ? `→ ${out.w}×${out.h}` : ""; }, section: "Purification" },
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
    backend: s.backend ?? "seedvr2",
    // Prompt only meaningful for the transformer backend; omit otherwise so
    // seedvr2 runs unaffected.
    prompt: s.backend === "transformer" ? s.prompt : undefined,
    resolution: s.resolution ?? "same",
    film_grain: s.film_grain,
    sharpening: s.sharpening,
    seed: s.seed,
  }),
};
