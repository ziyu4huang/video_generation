import type { UnifiedCommand } from "./types";

export const angleCommand: UnifiedCommand = {
  action: "angle",
  submitLabel: "Reframe",
  runningLabel: "Reframing...",
  isDisabled: (s) => !s.input_image,
  fields: [
    { key: "input_image", cliFlag: "--input", control: "image", label: "Source Image", required: true, section: "Input" },
    { key: "azimuth", cliFlag: "--azimuth", control: "number", label: "Azimuth (horizontal rotation)", min: -180, max: 180, default: 90, section: "Camera Angle" },
    { key: "elevation", cliFlag: "--elevation", control: "number", label: "Elevation (vertical angle)", min: -90, max: 90, default: 0, section: "Camera Angle" },
    { key: "prompt", cliFlag: "--prompt", control: "text", label: "Prompt (optional)", placeholder: "Describe any changes to the scene...", multiline: true, section: "Camera Angle" },
  ],
  buildParams: (s) => ({
    input_image: s.input_image,
    azimuth: s.azimuth,
    elevation: s.elevation,
    prompt: s.prompt?.trim() || undefined,
  }),
};
