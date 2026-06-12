import type { UnifiedCommand } from "./types";

export const swapCommand: UnifiedCommand = {
  action: "swap",
  submitLabel: "Swap Region",
  runningLabel: "Swapping...",
  isDisabled: (s) => !s.input_image || !s.reference || !s.sam_prompt?.trim(),
  fields: [
    { key: "input_image", cliFlag: "--input", control: "image", label: "Source Image", required: true, section: "Images" },
    { key: "reference", cliFlag: "--reference", control: "image", label: "Reference Image", required: true, section: "Images" },
    { key: "sam_prompt", cliFlag: "--sam-prompt", control: "text", label: "SAM Prompt (what to swap in source) *", placeholder: "e.g. shirt, car, background", required: true, section: "SAM Segmentation" },
    { key: "ref_sam_prompt", cliFlag: "--ref-sam-prompt", control: "text", label: "Reference SAM Prompt (what to extract from reference)", placeholder: "Defaults to same as SAM Prompt", section: "SAM Segmentation" },
    { key: "sam_threshold", cliFlag: "--sam-threshold", control: "range", label: "SAM Threshold", min: 0, max: 1, step: 0.05, default: 0.3, section: "Settings" },
    { key: "feather", cliFlag: "--feather", control: "number", label: "Feather", min: 0, max: 100, default: 10, section: "Settings" },
    { key: "blend", cliFlag: "--blend", control: "toggle", label: "Blend (smooth composite)", section: "Settings" },
  ],
  buildParams: (s) => ({
    input_image: s.input_image,
    reference: s.reference,
    sam_prompt: s.sam_prompt?.trim(),
    ref_sam_prompt: s.ref_sam_prompt?.trim() || undefined,
    sam_threshold: s.sam_threshold !== 0.3 ? s.sam_threshold : undefined,
    feather: s.feather !== 10 ? s.feather : undefined,
    blend: s.blend || undefined,
  }),
};
