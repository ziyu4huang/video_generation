import type { UnifiedCommand } from "./types";

export const qualityCommand: UnifiedCommand = {
  action: "quality",
  submitLabel: "Analyze Quality",
  runningLabel: "Analyzing...",
  isDisabled: (s) => !s.quality_inputs?.length,
  fields: [
    { key: "quality_inputs", cliFlag: "--quality-inputs", control: "images", label: "Add images for quality analysis", required: true, section: "Images to Analyze" },
  ],
  buildParams: (s) => ({
    quality_inputs: s.quality_inputs,
  }),
};
