import type { CommandSchema } from "./types";

export const QUALITY_SCHEMA: CommandSchema = {
  action: "quality",
  submitLabel: "Analyze Quality",
  runningLabel: "Analyzing...",
  isDisabled: (s) => !s.quality_inputs?.length,
  sections: [
    {
      title: "Images to Analyze",
      fields: [
        { type: "images", key: "quality_inputs", label: "Add images for quality analysis" },
      ],
    },
  ],
  buildParams: (s) => ({
    quality_inputs: s.quality_inputs,
  }),
};
