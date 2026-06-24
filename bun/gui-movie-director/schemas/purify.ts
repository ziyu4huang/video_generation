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
  { value: "deartifact", label: "Deartifact — stronger redraw + noise clean (0.65)" },
  { value: "redraw", label: "Redraw — reinterpret content (0.8)" },
];

// Targeted text removal (--remove). When set, this IS the operation: SAM3 detects
// the text region and surgically inpaints it away (original pixels kept outside a
// feathered mask). The seedvr2/transformer redraw below is skipped, so those
// controls are hidden while a removal target is selected (see field `visible`).
const REMOVE_CHOICES = [
  { value: "none", label: "None" },
  { value: "subtitle", label: "Subtitle / caption" },
  { value: "watermark", label: "Watermark / logo" },
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
    // Targeted text removal (--remove). When set, this IS the operation: SAM3
    // detects the text region and surgically inpaints it (original kept outside a
    // feathered mask). The redraw controls below are hidden while active, since
    // the cleaned image is the output and they'd be ignored by run.py.
    { key: "remove", cliFlag: "--remove", control: "select", label: "Remove", choices: REMOVE_CHOICES, default: "none", section: "Targeted Removal" },
    // Removal tuning (PR #94): the --remove inpaint path's real levers. Mask
    // dilation grows the detected region before inpaint (catch text edges SAM3
    // missed); detect threshold lowers to catch fainter text (0.3→0.15 in A/B);
    // inpaint denoise is how freely flux2-klein synthesizes replacement texture
    // (higher = stronger fill); inpaint steps add detail to the fill. Visible
    // only while a removal target is selected — meaningless otherwise. run.py
    // applies these same defaults when --remove is set but the flags are absent,
    // so omitting them keeps bare-`--remove` behavior byte-identical.
    { key: "remove_dilate", cliFlag: "--remove-dilate", control: "range", label: "Mask Dilation", min: 0, max: 20, step: 1, default: 5, compact: true, visible: (s) => (s.remove ?? "none") !== "none", section: "Removal Tuning" },
    { key: "remove_score_threshold", cliFlag: "--remove-score-threshold", control: "range", label: "Detect Threshold", min: 0.1, max: 0.7, step: 0.05, default: 0.3, compact: true, visible: (s) => (s.remove ?? "none") !== "none", section: "Removal Tuning" },
    { key: "remove_denoise", cliFlag: "--remove-denoise", control: "range", label: "Inpaint Denoise", min: 0.3, max: 1, step: 0.05, default: 0.8, compact: true, visible: (s) => (s.remove ?? "none") !== "none", section: "Removal Tuning" },
    { key: "remove_steps", cliFlag: "--remove-steps", control: "range", label: "Inpaint Steps", min: 1, max: 12, step: 1, default: 4, compact: true, visible: (s) => (s.remove ?? "none") !== "none", section: "Removal Tuning" },
    { key: "purify_mode", cliFlag: "--purify-mode", control: "select", label: "Mode", choices: PURIFY_MODE_CHOICES, default: "enhance", visible: (s) => (s.remove ?? "none") === "none", section: "Purification" },
    { key: "backend", cliFlag: "--backend", control: "select", label: "Backend", choices: BACKEND_CHOICES, default: "seedvr2", visible: (s) => (s.remove ?? "none") === "none", section: "Purification" },
    // Transformer instance for the transformer backend AND the --remove inpaint
    // (both go through Flux2KleinT2IPipeline). Options come from the server-side
    // purify.transformers list (flux2-klein-9b variants only).
    { key: "transformer", cliFlag: "--transformer", control: "select", label: "Transformer", choicesFrom: "transformers", default: "klein-9b", visible: (s) => (s.remove ?? "none") !== "none" || s.backend === "transformer", section: "Purification" },
    // Prompt is transformer-backend-only (SeedVR2 is prompt-free). Visible only
    // when not removing and backend=transformer; omitted from CLI when empty
    // (run.py then uses a neutral quality prompt).
    { key: "prompt", cliFlag: "--prompt", control: "text", label: "Prompt", placeholder: "Guides the transformer redraw (default: quality prompt)", visible: (s) => (s.remove ?? "none") === "none" && s.backend === "transformer", section: "Purification" },
    { key: "resolution", cliFlag: "--resolution", control: "select", label: "Resolution", choices: RESOLUTION_CHOICES, default: "same", visible: (s) => (s.remove ?? "none") === "none", hint: (s, { inputDims }) => {
        if (!inputDims) return "";
        const out = purifyOutputDims(inputDims.w, inputDims.h, (s.resolution as string) ?? "same");
        if (!out) return "";
        const base = `→ ${out.w}×${out.h}`;
        // seedvr2 is a full-image restoration model whose VRAM scales with output
        // pixels: 2x / 2160 can exceed Metal memory and page-fault (hard GPU
        // crash, exit 134) on larger inputs. Surface it so users don't hit a
        // crash expecting a quality gain — and note resolution does NOT fix the
        // plasticky-skin base artifact (that needs a higher-res SOURCE render).
        const res = (s.resolution as string) ?? "same";
        const warn = (res === "2x" || res === "2160") ? "  ⚠ may exceed Metal memory" : "";
        return base + warn;
      }, section: "Purification" },
    { key: "film_grain", cliFlag: "--film-grain", control: "range", label: "Film Grain", min: 0, max: 0.03, step: 0.005, default: 0, compact: true, visible: (s) => (s.remove ?? "none") === "none", section: "Post-Processing" },
    { key: "sharpening", cliFlag: "--sharpening", control: "range", label: "Sharpening", min: 0, max: 0.3, step: 0.01, default: 0, compact: true, visible: (s) => (s.remove ?? "none") === "none", section: "Post-Processing" },
    { key: "seed", cliFlag: "--seed", control: "number", label: "Seed", default: 42, compact: true, section: "Post-Processing" },
    // NOTE: --softness-override (advanced; overrides the mode preset) is
    // intentionally omitted — a default 0 would silently override the chosen
    // mode's softness. Power users can pass it via CLI.
  ],
  buildParams: (s) => {
    const removing = (s.remove ?? "none") !== "none";
    return {
      input_image: s.input_image,
      remove: s.remove ?? "none",
      // Mode/backend/resolution/film_grain/sharpening are no-ops when removing
      // (run.py short-circuits to the inpaint path), but we still emit them so a
      // user who toggles Remove off gets their prior redraw settings back.
      purify_mode: s.purify_mode ?? "enhance",
      backend: s.backend ?? "seedvr2",
      // Transformer drives both the transformer redraw and the remove inpaint;
      // only emit it when one of those paths is active.
      transformer: removing || s.backend === "transformer" ? (s.transformer ?? "klein-9b") : undefined,
      // Prompt only meaningful for the transformer backend (not remove); omit
      // otherwise so seedvr2 / remove runs are unaffected.
      prompt: !removing && s.backend === "transformer" ? s.prompt : undefined,
      resolution: s.resolution ?? "same",
      film_grain: s.film_grain,
      sharpening: s.sharpening,
      seed: s.seed,
      // Removal-path tunables (PR #94): only meaningful during the --remove
      // inpaint; emit them solely then so seedvr2/redraw runs stay byte-identical
      // to a bare invocation (run.py ignores them when remove=="none" anyway).
      // The ?? guards against an ever-unset form value (String(undefined) would
      // otherwise inject a literal "undefined" arg), falling back to run.py's
      // effective default.
      remove_dilate: removing ? (s.remove_dilate ?? 5) : undefined,
      remove_score_threshold: removing ? (s.remove_score_threshold ?? 0.3) : undefined,
      remove_denoise: removing ? (s.remove_denoise ?? 0.8) : undefined,
      remove_steps: removing ? (s.remove_steps ?? 4) : undefined,
    };
  },
};
