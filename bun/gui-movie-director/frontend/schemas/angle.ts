import type { CommandSchema } from "./types";

export const ANGLE_SCHEMA: CommandSchema = {
  action: "angle",
  submitLabel: "Reframe",
  runningLabel: "Reframing...",
  isDisabled: (s) => !s.input_image,
  sections: [
    {
      title: "Input",
      fields: [
        { type: "image", key: "input_image", label: "Source Image", required: true },
      ],
    },
    {
      title: "Camera Angle",
      fields: [
        { type: "number", key: "azimuth", label: "Azimuth (horizontal rotation)", min: -180, max: 180, default: 90 },
        { type: "number", key: "elevation", label: "Elevation (vertical angle)", min: -90, max: 90, default: 0 },
        { type: "text", key: "prompt", label: "Prompt (optional)", placeholder: "Describe any changes to the scene...", multiline: true },
      ],
    },
  ],
  buildParams: (s) => ({
    input_image: s.input_image,
    azimuth: s.azimuth,
    elevation: s.elevation,
    prompt: s.prompt?.trim() || undefined,
  }),
};
