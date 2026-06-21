import type { UnifiedCommand } from "./types";
import { RESOLUTION_CHOICES } from "./shared";

// Angle-preset dropdown options. These names MUST match `ANGLE_PRESETS` in
// python/mlx-movie-director/app/commands/image-angle.py — the server resolves
// --angle <name> to (azimuth, elevation) and errors clearly on unknown names.
// "custom" is a GUI-only sentinel: buildParams intercepts it and sends
// --azimuth/--elevation instead of --angle, so it never reaches run.py.
const ANGLE_PRESET_CHOICES = [
  { value: "front", label: "Front", group: "Eye-Level" },
  { value: "front-right", label: "Front-Right (3/4)", group: "Eye-Level" },
  { value: "right", label: "Right (profile)", group: "Eye-Level" },
  { value: "rear-right", label: "Rear-Right (3/4)", group: "Eye-Level" },
  { value: "back", label: "Back", group: "Eye-Level" },
  { value: "rear-left", label: "Rear-Left (3/4)", group: "Eye-Level" },
  { value: "left", label: "Left (profile)", group: "Eye-Level" },
  { value: "front-left", label: "Front-Left (3/4)", group: "Eye-Level" },
  { value: "front-high", label: "Front · High", group: "Tilted" },
  { value: "right-high", label: "Right · High", group: "Tilted" },
  { value: "back-high", label: "Back · High", group: "Tilted" },
  { value: "front-low", label: "Front · Low", group: "Tilted" },
  { value: "right-low", label: "Right · Low", group: "Tilted" },
  { value: "birds-eye", label: "Bird's-Eye (steep down)", group: "Extreme" },
  { value: "worms-eye", label: "Worm's-Eye (steep up)", group: "Extreme" },
  { value: "custom", label: "Custom…", group: "Custom" },
];

export const angleCommand: UnifiedCommand = {
  action: "angle",
  submitLabel: "Reframe",
  runningLabel: "Reframing...",
  isDisabled: (s) => !s.input_image,
  fields: [
    // ── Input ──
    { key: "input_image", cliFlag: "--input", control: "image", label: "Source Image", required: true, section: "Input" },

    // ── Camera Angle (preset-primary UX) ──
    // The named preset is the clear, primary input. "custom" reveals the raw
    // azimuth/elevation number fields below (Advanced) for fine manual control.
    { key: "angle", cliFlag: "--angle", control: "select", label: "Camera Angle", choices: ANGLE_PRESET_CHOICES, default: "front-right", section: "Camera Angle" },
    { key: "prompt", cliFlag: "--prompt", control: "text", label: "Prompt (optional)", placeholder: "Describe any changes to the scene...", multiline: true, section: "Camera Angle" },

    // ── Generation (identity + model) ──
    // pipeline is a UI-only constant (angle always uses Flux2KleinEdit). It is
    // hidden but kept in state so the Transformer dropdown's pipeline filter
    // (CommandForm reads state.pipeline) shows flux2-klein-family models only.
    // buildParams never sends it (no cliFlag, not in the returned params).
    { key: "pipeline", control: "select", default: "flux2-klein", choices: [{ value: "flux2-klein", label: "Flux2 Klein" }], section: "Generation", visible: () => false },
    { key: "transformer", cliFlag: "--transformer", control: "select", choicesFrom: "transformers", label: "Transformer", default: "klein-9b", section: "Generation" },
    // ref-count is the validated identity-fidelity lever for Flux2KleinEdit
    // (multi-reference conditioning). 1-3; the server clamps >3 with a warning.
    { key: "ref_count", cliFlag: "--ref-count", control: "number", label: "Reference Count (identity fidelity)", min: 1, max: 3, default: 3, compact: true, section: "Generation" },
    // resolution picker is UI-only (no cliFlag). Picking a preset writes width/
    // height via the useDefaultState hook (RESOLUTION_MAP); "custom" reveals the
    // width/height fields. buildParams sends width/height (never --resolution),
    // matching the t2i pattern.
    { key: "resolution", control: "select", label: "Resolution", choices: RESOLUTION_CHOICES, default: "640x960", section: "Generation" },
    { key: "width", cliFlag: "--width", control: "number", label: "Width", min: 256, max: 2560, step: 16, default: 640, section: "Generation", visible: (s) => s.resolution === "custom" },
    { key: "height", cliFlag: "--height", control: "number", label: "Height", min: 256, max: 2560, step: 16, default: 960, section: "Generation", visible: (s) => s.resolution === "custom" },
    { key: "steps", cliFlag: "--steps", control: "number", label: "Steps", min: 1, max: 30, default: 6, compact: true, section: "Generation" },
    // CFG off by default (distilled Klein). Empty → undefined → server treats as off.
    { key: "cfg_scale", cliFlag: "--cfg-scale", control: "number", label: "CFG Scale", min: 1, max: 8, step: 0.5, placeholder: "off (default)", compact: true, section: "Generation" },

    // ── Advanced (raw degree override — shown only for "custom" angle) ──
    { key: "azimuth", cliFlag: "--azimuth", control: "number", label: "Azimuth (horizontal: 0=front 90=right 180=back 270=left)", min: -180, max: 180, default: 90, section: "Advanced", visible: (s) => s.angle === "custom" },
    { key: "elevation", cliFlag: "--elevation", control: "number", label: "Elevation (vertical: +high / -low)", min: -90, max: 90, default: 0, section: "Advanced", visible: (s) => s.angle === "custom" },
    { key: "rich_angle_text", cliFlag: "--rich-angle-text", control: "toggle", label: "Rich angle text (finer elevation phrasing)", section: "Advanced" },
  ],
  buildParams: (s) => {
    const isCustom = s.angle === "custom";
    return {
      input_image: s.input_image,
      // Preset vs custom: only the effective one reaches run.py.
      ...(isCustom ? { azimuth: s.azimuth, elevation: s.elevation } : { angle: s.angle }),
      transformer: s.transformer || undefined,
      ref_count: s.ref_count,
      // width/height are always populated (resolution picker writes them via the
      // hook); sending both covers preset and custom-resolution cases uniformly.
      width: s.width,
      height: s.height,
      steps: s.steps,
      cfg_scale: s.cfg_scale != null && s.cfg_scale !== "" ? s.cfg_scale : undefined,
      prompt: s.prompt?.trim() || undefined,
      rich_angle_text: s.rich_angle_text || undefined,
    };
  },
};
